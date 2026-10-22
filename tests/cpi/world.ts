/**
 * The world T6 runs in, shared by the fixed cases (run.ts) and the fuzzer (fuzz.ts): a Solana VM
 * (litesvm) with the wallet, three tokens, the malicious swap program (tests/cpi/attacker) and its
 * pools; Orientim's protected transaction around that program; and the promise checked on the
 * chain after every case.
 */
import {
  AccountRole, appendTransactionMessageInstructions, compileTransaction, createTransactionMessage,
  generateKeyPairSigner, getAddressEncoder, getCompiledTransactionMessageDecoder, getProgramDerivedAddress,
  lamports, pipe, setTransactionMessageFeePayer, setTransactionMessageLifetimeUsingBlockhash, signTransaction,
} from '@solana/kit';
import type { Address, Instruction, KeyPairSigner, Transaction } from '@solana/kit';
import { getCreateAccountInstruction, getTransferSolInstruction } from '@solana-program/system';
import {
  getCreateAssociatedTokenIdempotentInstruction, getInitializeMint2Instruction, getMintToInstruction,
} from '@solana-program/token';
import { LiteSVM } from 'litesvm';
import { existsSync } from 'node:fs';
import { MINT_SIZE, SYSTEM_PROGRAM, TOKEN_2022_PROGRAM, TOKEN_PROGRAM, WSOL_MINT } from '@orientimhq/swap/core';
import { ataOf, tokenAmountOf } from '@orientim/builder';
import { buildPolicy, compileProtectedSwap, withTakerRent } from '@orientim/builder';
import type { AccountState, ChainSnapshot, Policy } from '@orientimhq/swap/core';
import { verify } from '@orientimhq/swap/verifier';

export const SO = 'tests/cpi/attacker/target/deploy/orientim_attacker.so';

export const SOL = 1_000_000_000n;

// The swap under test: 100 IN (6 decimals) for at least 10 OUT (9 decimals), Orientim fee 0.25%.
export const AMOUNT_IN = 100_000_000n;
export const FEE_BPS = 25n; // Orientim's fee; the verifier refuses one above 30
export const FEE = (AMOUNT_IN * FEE_BPS) / 10_000n;
export const SWAP_AMOUNT = AMOUNT_IN - FEE;
export const MIN_OUT = 10_000_000_000n;
export const MIN_OUT_SOL = SOL;
export const IN_DECIMALS = 6;
export const OUT_DECIMALS = 9;
export const MAX_NETWORK_FEE = 20_000n; // two signatures at 5000 lamports, with room to spare

/** Stops with the command that builds the program when it is missing. */
export function requireProgram() {
  if (!existsSync(SO)) {
    console.error(`Missing ${SO}. Build it first:\n  (in tests/cpi/attacker) cargo build-sbf`);
    process.exit(2);
  }
}

export const encoder = getAddressEncoder();

// ---------------------------------------------------------------- instruction data

export const u64 = (v: bigint) => {
  const b = new Uint8Array(8);
  new DataView(b.buffer).setBigUint64(0, v, true);
  return b;
};
/** SPL Token Transfer: [source, destination, authority]. */
export const transfer = (amount: bigint) => Uint8Array.from([3, ...u64(amount)]);
/** SPL Token TransferChecked: [source, mint, destination, authority, ...multisig signers]. */
export const transferChecked = (amount: bigint, decimals: number) => Uint8Array.from([12, ...u64(amount), decimals]);
/** SPL Token Approve: [source, delegate, owner]. */
export const approve = (amount: bigint) => Uint8Array.from([4, ...u64(amount)]);
/** SPL Token SetAuthority: [account, current authority]. Type 2 = AccountOwner, 3 = CloseAccount. */
export const setAuthority = (type: number, newAuthority: Address) =>
  Uint8Array.from([6, type, 1, ...encoder.encode(newAuthority)]);
/** SPL Token CloseAccount: [account, destination, owner]. */
export const CLOSE_ACCOUNT = Uint8Array.from([9]);
/** System Transfer: [from, to]. */
export const transferSol = (amount: bigint) => Uint8Array.from([2, 0, 0, 0, ...u64(amount)]);

// ---------------------------------------------------------------- what the attacker will attempt

/** An account of the external instruction, by index, or any address at all, by value. */
export type Key = number | Address;
export type Meta = { key: Key; w?: boolean; s?: boolean };
/** One cross-program invocation the malicious swap program will attempt. */
export type Inner = { program: Key; signed?: boolean; metas: Meta[]; data: Uint8Array };

export function encodeKey(k: Key, out: number[]) {
  if (typeof k === 'number') out.push(k);
  else out.push(0xff, ...encoder.encode(k));
}

export function attackerData(inners: Inner[]): Uint8Array {
  const out: number[] = [inners.length];
  for (const inner of inners) {
    encodeKey(inner.program, out);
    out.push(inner.signed ? 1 : 0, inner.metas.length);
    for (const m of inner.metas) {
      encodeKey(m.key, out);
      out.push((m.w ? 1 : 0) | (m.s ? 2 : 0));
    }
    out.push(inner.data.length & 0xff, (inner.data.length >> 8) & 0xff, ...inner.data);
  }
  return Uint8Array.from(out);
}

/** Index of an account in the external instruction (see `externalInstruction`). */
export const IX = { token: 0, system: 1, E: 2, eIn: 3, output: 4, attackerIn: 5, pool: 6, poolAuthority: 7 } as const;

/** E_in → the attacker's own account, authority E: the one move Orientim's design allows. */
export const takeFrom = (amount: bigint): Inner => ({
  program: IX.token,
  metas: [{ key: IX.eIn, w: true }, { key: IX.attackerIn, w: true }, { key: IX.E, s: true }],
  data: transfer(amount),
});
/** Delivers from the attacker's own pool, signed by the pool's program-derived authority. */
export const deliver = (amount: bigint): Inner => ({
  program: IX.token, signed: true,
  metas: [{ key: IX.pool, w: true }, { key: IX.output, w: true }, { key: IX.poolAuthority, s: true }],
  data: transfer(amount),
});

// ---------------------------------------------------------------- the world

export type World = {
  svm: LiteSVM;
  attackerProgram: Address;
  tokenProgram: Address;
  payer: KeyPairSigner;
  W: KeyPairSigner;
  E: KeyPairSigner;
  attacker: Address;
  vaultAuthority: Address;
  mintIn: Address;
  mintOut: Address;
  mintOther: Address;
  wIn: Address;
  wOut: Address;
  wOther: Address;
  eIn: Address;
  eOut: Address;
  attackerIn: Address;
  vaultOut: Address;
  vaultWsol: Address;
  treasury: Address;
  treasuryIn: Address;
  /** The issuer multisig, when the case sets one (see `IssuerDelegate`). */
  multisig: Address | null;
  inDecimals: number;
  outDecimals: number;
};

export const accountOf = (svm: LiteSVM, a: Address): AccountState | null => {
  const account = svm.getAccount(a);
  if (!account || !account.exists) return null;
  return { owner: account.programAddress, lamports: BigInt(account.lamports), data: Uint8Array.from(account.data) };
};
export const tokensOf = (svm: LiteSVM, a: Address) => tokenAmountOf(accountOf(svm, a)?.data);
export const solOf = (svm: LiteSVM, a: Address) => BigInt(svm.getBalance(a) ?? 0n);
export const lifetimeOf = (svm: LiteSVM) => ({ blockhash: svm.latestBlockhash(), lastValidBlockHeight: 10_000n });

export async function sign(svm: LiteSVM, ixs: Instruction[], payer: KeyPairSigner, extra: KeyPairSigner[] = []) {
  const message = pipe(
    createTransactionMessage({ version: 0 }),
    m => setTransactionMessageFeePayer(payer.address, m),
    m => setTransactionMessageLifetimeUsingBlockhash(lifetimeOf(svm), m),
    m => appendTransactionMessageInstructions(ixs, m),
  );
  return signTransaction([payer.keyPair, ...extra.map(s => s.keyPair)], compileTransaction(message));
}

/** A transaction's result, whichever way litesvm reports it. */
export type Outcome = { ok: boolean; error: string; index: number | null; logs: string[] };

export function send(svm: LiteSVM, tx: Transaction): Outcome {
  const result = svm.sendTransaction(tx) as {
    err?: () => unknown; meta?: () => { logs: () => string[] }; logs?: () => string[];
  };
  if (typeof result.err !== 'function') return { ok: true, error: '', index: null, logs: result.logs?.() ?? [] };
  const err = result.err() as { index?: number } | string;
  const index = typeof err === 'object' && err !== null && err.index !== undefined ? Number(err.index) : null;
  const logs = result.meta?.().logs() ?? [];
  const blamed = [...logs].reverse().find(l => /failed|error|insufficient|privilege|unauthorized|missing/i.test(l));
  return { ok: false, error: (blamed ?? String(err)).slice(0, 160), index, logs };
}

export function sendOrThrow(svm: LiteSVM, tx: Transaction, what: string) {
  const r = send(svm, tx);
  if (!r.ok) throw new Error(`${what} failed: ${r.error}\n${r.logs.join('\n')}`);
}

/**
 * Who holds the permanent delegate of the swap's two Token-2022 mints, when one is set: an ordinary
 * key (the attacker's own wallet, which never signs the swap), an address the attacker's program can
 * sign for itself (its pool authority), or a Token multisig at an ordinary address whose one signer
 * is that program address: R7 sees an ordinary key, and the program can still act as the delegate.
 */
export type IssuerDelegate = 'key' | 'program' | 'multisig';
/** A Token multisig account: m, n, initialized, then eleven signer slots. */
export const MULTISIG_SIZE = 355n;

/** InitializePermanentDelegate (Token-2022 instruction 35); it must run before the mint is initialized. */
export const initializePermanentDelegate = (mint: Address, delegate: Address): Instruction => ({
  programAddress: TOKEN_2022_PROGRAM,
  accounts: [{ address: mint, role: AccountRole.WRITABLE }],
  data: Uint8Array.from([35, ...encoder.encode(delegate)]),
});
/** A mint with one 32-byte extension: padded to an account's size, a type byte, then the entry. */
export const MINT_WITH_DELEGATE_SIZE = 165 + 1 + 4 + 32;

/** A fresh chain with the wallet, the attacker's pool and three tokens. */
/**
 * `decimals` of the input and output mints (6 and 9 unless given); `large` funds the wallet and the
 * attacker's pools for many swaps of any size, as the fuzzer runs one world for many cases.
 */
export async function setup(
  tokenProgram: Address = TOKEN_PROGRAM, issuer?: IssuerDelegate, opts: { decimals?: [number, number]; large?: boolean } = {},
): Promise<World> {
  const [inDecimals, outDecimals] = opts.decimals ?? [IN_DECIMALS, OUT_DECIMALS];
  const big = opts.large ?? false;
  const svm = new LiteSVM().withNativeMints();
  const program = await generateKeyPairSigner(); // only its address matters: the program id
  svm.addProgramFromFile(program.address, SO);

  const [payer, W, E, attackerWallet, treasuryWallet, mintInKey, mintOutKey, mintOtherKey] = await Promise.all(
    Array.from({ length: 8 }, () => generateKeyPairSigner()),
  );
  svm.airdrop(payer.address, lamports(1000n * SOL));
  svm.airdrop(W.address, lamports(10n * SOL));
  svm.airdrop(attackerWallet.address, lamports((big ? 10_000n : 100n) * SOL));
  // E is deliberately left non-existent: rule R3 requires it.

  const [vaultAuthority] = await getProgramDerivedAddress({
    programAddress: program.address,
    seeds: [new TextEncoder().encode('attacker')],
  });

  // A multisig whose single signer is the attacker program's own address (InitializeMultisig2).
  const multisig = issuer === 'multisig' ? await generateKeyPairSigner() : null;
  if (multisig) {
    sendOrThrow(svm, await sign(svm, [
      getCreateAccountInstruction({
        payer, newAccount: multisig, lamports: lamports(svm.minimumBalanceForRentExemption(MULTISIG_SIZE)),
        space: MULTISIG_SIZE, programAddress: tokenProgram,
      }),
      {
        programAddress: tokenProgram,
        accounts: [{ address: multisig.address, role: AccountRole.WRITABLE }, { address: vaultAuthority, role: AccountRole.READONLY }],
        data: Uint8Array.from([19, 1]),
      },
    ], payer, [multisig]), 'creating the issuer multisig');
  }
  const delegate = issuer === 'key' ? attackerWallet.address : issuer === 'program' ? vaultAuthority : multisig?.address ?? null;
  const mints: [KeyPairSigner, number, boolean][] = [
    [mintInKey, inDecimals, !!delegate], [mintOutKey, outDecimals, !!delegate], [mintOtherKey, 6, false],
  ];
  sendOrThrow(svm, await sign(svm, mints.flatMap(([mint, decimals, withDelegate]) => {
    const space = withDelegate ? MINT_WITH_DELEGATE_SIZE : MINT_SIZE;
    return [
      getCreateAccountInstruction({
        payer, newAccount: mint, lamports: lamports(svm.minimumBalanceForRentExemption(BigInt(space))),
        space: BigInt(space), programAddress: tokenProgram,
      }),
      ...(withDelegate ? [initializePermanentDelegate(mint.address, delegate!)] : []),
      getInitializeMint2Instruction(
        { mint: mint.address, decimals, mintAuthority: payer.address, freezeAuthority: null },
        { programAddress: tokenProgram },
      ),
    ];
  }), payer, mints.map(([m]) => m)), 'creating the mints');

  const mintIn = mintInKey.address, mintOut = mintOutKey.address, mintOther = mintOtherKey.address;
  const world: World = {
    svm, attackerProgram: program.address, tokenProgram, payer, W, E,
    attacker: attackerWallet.address, vaultAuthority, mintIn, mintOut, mintOther,
    wIn: await ataOf(W.address, mintIn, tokenProgram),
    wOut: await ataOf(W.address, mintOut, tokenProgram),
    wOther: await ataOf(W.address, mintOther, tokenProgram),
    eIn: await ataOf(E.address, mintIn, tokenProgram),
    eOut: await ataOf(E.address, WSOL_MINT),
    attackerIn: await ataOf(attackerWallet.address, mintIn, tokenProgram),
    vaultOut: await ataOf(vaultAuthority, mintOut, tokenProgram),
    vaultWsol: await ataOf(vaultAuthority, WSOL_MINT),
    treasury: treasuryWallet.address,
    treasuryIn: await ataOf(treasuryWallet.address, mintIn, tokenProgram),
    multisig: multisig?.address ?? null,
    inDecimals, outDecimals,
  };

  const ata = (owner: Address, mint: Address, account: Address, programAddress: Address = tokenProgram) =>
    getCreateAssociatedTokenIdempotentInstruction({ payer, ata: account, owner, mint, tokenProgram: programAddress });
  sendOrThrow(svm, await sign(svm, [
    ata(W.address, mintIn, world.wIn),
    ata(W.address, mintOut, world.wOut),
    ata(W.address, mintOther, world.wOther),
    ata(world.attacker, mintIn, world.attackerIn),
    ata(vaultAuthority, mintOut, world.vaultOut),
    ata(vaultAuthority, WSOL_MINT, world.vaultWsol, TOKEN_PROGRAM),
    ata(world.treasury, mintIn, world.treasuryIn),
  ], payer), 'creating the token accounts');

  sendOrThrow(svm, await sign(svm, [
    getMintToInstruction({ mint: mintIn, token: world.wIn, mintAuthority: payer, amount: big ? 10n ** 17n : 1000n * 1_000_000n }, { programAddress: tokenProgram }),
    getMintToInstruction({ mint: mintOut, token: world.wOut, mintAuthority: payer, amount: 500n * SOL }, { programAddress: tokenProgram }),
    getMintToInstruction({ mint: mintOther, token: world.wOther, mintAuthority: payer, amount: 777n * 1_000_000n }, { programAddress: tokenProgram }),
    getMintToInstruction({ mint: mintOut, token: world.vaultOut, mintAuthority: payer, amount: big ? 10n ** 18n : 1_000_000n * SOL }, { programAddress: tokenProgram }),
  ], payer), 'minting');

  // The attacker's wrapped-SOL pool: lamports plus SyncNative, the way any wrapper funds one.
  sendOrThrow(svm, await sign(svm, [
    getTransferSolInstruction({ source: attackerWallet, destination: world.vaultWsol, amount: (big ? 9_000n : 50n) * SOL }),
    { programAddress: TOKEN_PROGRAM, accounts: [{ address: world.vaultWsol, role: AccountRole.WRITABLE }], data: Uint8Array.from([17]) },
  ], attackerWallet), 'funding the wrapped-SOL pool');

  return world;
}

/** A new one-time key for the next swap in the same world, as every protected swap has its own. */
export async function freshKey(w: World): Promise<void> {
  w.E = await generateKeyPairSigner();
  w.eIn = await ataOf(w.E.address, w.mintIn, w.tokenProgram);
  w.eOut = await ataOf(w.E.address, WSOL_MINT);
  w.svm.expireBlockhash();
}

// ---------------------------------------------------------------- the protected transaction

export type Variant = 'C' | 'A';

/**
 * The external instruction exactly as Orientim hands it over: the attacker's program, and only the
 * accounts the design allows it to see. `extra` is for the case where the route also demands an
 * account it must never get.
 */
export function externalInstruction(w: World, variant: Variant, inners: Inner[], extra: Address[] = [], takerPays = false): Instruction {
  return {
    programAddress: w.attackerProgram,
    accounts: [
      { address: w.tokenProgram, role: AccountRole.READONLY },
      { address: SYSTEM_PROGRAM, role: AccountRole.READONLY },
      // A route that makes the taker pay rent (PumpSwap) needs E writable, as Jupiter lists it then.
      { address: w.E.address, role: takerPays ? AccountRole.WRITABLE_SIGNER : AccountRole.READONLY_SIGNER },
      { address: w.eIn, role: AccountRole.WRITABLE },
      { address: variant === 'A' ? w.eOut : w.wOut, role: AccountRole.WRITABLE },
      { address: w.attackerIn, role: AccountRole.WRITABLE },
      { address: variant === 'A' ? w.vaultWsol : w.vaultOut, role: AccountRole.WRITABLE },
      { address: w.vaultAuthority, role: AccountRole.READONLY },
      { address: w.mintIn, role: AccountRole.READONLY },
      { address: variant === 'A' ? WSOL_MINT : w.mintOut, role: AccountRole.READONLY },
      ...extra.map(address => ({ address, role: AccountRole.WRITABLE })),
    ],
    data: attackerData(inners),
  };
}

/** `swap`: the amount and the minimum, when not the fixed cases' own (100 IN for 10 OUT, or 1 SOL). */
export async function protectedSwap(
  w: World, variant: Variant, inners: Inner[], extra: Address[] = [], takerRent = 0n, swap?: { amountIn: bigint; minOut: bigint },
) {
  const built = await buildPolicy({
    intent: { owner: w.W.address, inputMint: w.mintIn, outputMint: variant === 'A' ? WSOL_MINT : w.mintOut, amountIn: swap?.amountIn ?? AMOUNT_IN },
    ephemeral: w.E.address,
    inputDecimals: w.inDecimals,
    outputDecimals: variant === 'A' ? 9 : w.outDecimals,
    inputTokenProgram: w.tokenProgram,
    outputTokenProgram: variant === 'A' ? TOKEN_PROGRAM : w.tokenProgram,
    minOut: swap?.minOut ?? (variant === 'A' ? MIN_OUT_SOL : MIN_OUT),
    config: { feeBps: FEE_BPS, treasury: w.treasury, maxNetworkFeeLamports: 200_000n, jupiterProgram: w.attackerProgram },
    feeAccountExists: true,
    // T6 measures the fee in the input token's account, which is what it isolates; the treasury
    // wallet is not funded in this VM, so a fee on a SOL output is covered by the unit tests instead.
    treasuryWalletReady: false,
  });
  const policy = withTakerRent(built, takerRent);
  if (!swap && policy.swapAmount !== SWAP_AMOUNT) throw new Error(`swap amount ${policy.swapAmount}, expected ${SWAP_AMOUNT}`);
  const swapInstruction = externalInstruction(w, variant, inners, extra, takerRent > 0n);
  const outputBalanceBefore = policy.accounts.wOut ? tokensOf(w.svm, policy.accounts.wOut) : 0n;
  const { transaction } = compileProtectedSwap({
    policy, swapInstruction, intermediates: [], version: 0, lifetime: lifetimeOf(w.svm),
    computeUnitLimit: 400_000, microLamportsPerComputeUnit: 0n, outputBalanceBefore,
  });
  const addresses = [
    w.W.address, w.E.address, w.mintIn, w.mintOut, WSOL_MINT, policy.accounts.eIn, policy.accounts.feeDestination!,
    ...(policy.accounts.eOut ? [policy.accounts.eOut] : []),
    ...(policy.accounts.wIn ? [policy.accounts.wIn] : []),
    ...(policy.accounts.wOut ? [policy.accounts.wOut] : []),
    ...swapInstruction.accounts!.map(a => a.address),
  ];
  const snapshot: ChainSnapshot = { accounts: new Map(addresses.map(a => [a, accountOf(w.svm, a)])), lookupTables: {} };
  // Where the untrusted instruction sits, so the report can say what stopped an attack.
  const compiled = getCompiledTransactionMessageDecoder().decode(transaction.messageBytes) as unknown as {
    staticAccounts: Address[];
    instructions: readonly { programAddressIndex: number }[];
  };
  const swapIndex = compiled.instructions.findIndex(
    i => compiled.staticAccounts[i.programAddressIndex] === w.attackerProgram,
  );
  // The verifier accepts only Jupiter's own program, so it refuses this one for that alone. T6 asks
  // what the chain allows a hostile program that gets past that rule, so the verdict is every other.
  const verdict = await verify(transaction, policy, snapshot);
  const violations = verdict.violations.filter(v => !(v.rule === 'R2' && v.detail === `external program ${w.attackerProgram} is not Jupiter`));
  return { policy, transaction, swapIndex, verdict: { ...verdict, ok: violations.length === 0, violations } };
}

// ---------------------------------------------------------------- what must never change

export type Balances = { wIn: bigint; wOut: bigint; wOther: bigint; wSol: bigint; attackerIn: bigint; treasury: bigint };

export const balancesOf = (w: World): Balances => ({
  wIn: tokensOf(w.svm, w.wIn),
  wOut: tokensOf(w.svm, w.wOut),
  wOther: tokensOf(w.svm, w.wOther),
  wSol: solOf(w.svm, w.W.address),
  attackerIn: tokensOf(w.svm, w.attackerIn),
  treasury: tokensOf(w.svm, w.treasuryIn),
});

/** Orientim's promise, checked against the chain after every case. */
export function invariants(w: World, policy: Policy, before: Balances, after: Balances, succeeded: boolean): string[] {
  const bad: string[] = [];
  const same = (what: string, a: bigint, b: bigint) => {
    if (a !== b) bad.push(`${what} changed by ${b - a}`);
  };
  const variantA = policy.outputMint === WSOL_MINT;
  same("the wallet's other token", before.wOther, after.wOther);

  if (!succeeded) {
    same("the wallet's input", before.wIn, after.wIn);
    same("the wallet's output", before.wOut, after.wOut);
    same("the attacker's account", before.attackerIn, after.attackerIn);
    same("Orientim's fee account", before.treasury, after.treasury);
    if (before.wSol - after.wSol > MAX_NETWORK_FEE) bad.push(`the wallet lost ${before.wSol - after.wSol} lamports`);
    return bad;
  }

  if (before.wIn - after.wIn !== policy.amountIn) bad.push(`the wallet paid ${before.wIn - after.wIn}, approved ${policy.amountIn}`);
  if (after.treasury - before.treasury !== policy.fee) bad.push(`the fee was ${after.treasury - before.treasury}, expected ${policy.fee}`);
  if (after.attackerIn - before.attackerIn > policy.swapAmount) {
    bad.push(`the attacker took ${after.attackerIn - before.attackerIn}, above the approved ${policy.swapAmount}`);
  }
  if (variantA) {
    if (after.wSol - before.wSol < policy.minOut - MAX_NETWORK_FEE - policy.takerRent) bad.push(`the wallet received ${after.wSol - before.wSol} lamports, below the minimum`);
    same("the wallet's token output account", before.wOut, after.wOut);
  } else {
    if (after.wOut - before.wOut < policy.minOut) bad.push(`the wallet received ${after.wOut - before.wOut}, below the minimum ${policy.minOut}`);
    // The rent Orientim sends E for the route's account is the one SOL the route may take besides the
    // network fee; it is stated in the certificate before the wallet signs.
    if (before.wSol - after.wSol > MAX_NETWORK_FEE + policy.takerRent) {
      bad.push(`the wallet lost ${before.wSol - after.wSol} lamports beyond the network fee and the stated route rent`);
    }
  }
  // No temporary account and no permission may outlive the transaction.
  for (const [what, a] of [['E_in', policy.accounts.eIn], ['E_out', policy.accounts.eOut], ['E', w.E.address]] as const) {
    if (a && accountOf(w.svm, a)) bad.push(`${what} still exists after the swap`);
  }
  const out = accountOf(w.svm, w.wOut);
  if (out && out.data.length >= 76 && new DataView(out.data.buffer, out.data.byteOffset, out.data.byteLength).getUint32(72, true) === 1) {
    bad.push('a delegate is set on the output account after the swap');
  }
  return bad;
}

