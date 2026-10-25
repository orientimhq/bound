/**
 * The chain the Guard's tests run in, shared by the fixed cases (run.ts), the fuzzer (fuzz.ts) and the
 * Jupiter run (jupiter.ts): a Solana VM (litesvm) with the owner's wallet, three tokens, and a
 * malicious swap program (tests/guard/attacker) with its pools, which plays the route between Pull
 * and Settle and attempts whatever a case tells it to.
 */
import {
  AccountRole, address, appendTransactionMessageInstructions, compileTransaction, createTransactionMessage,
  generateKeyPairSigner, getAddressEncoder, getProgramDerivedAddress, getTransactionEncoder, lamports, pipe, setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash, signTransaction,
} from '@solana/kit';
import type { Address, Instruction, KeyPairSigner, Transaction } from '@solana/kit';
import { getCreateAccountInstruction, getTransferSolInstruction } from '@solana-program/system';
import {
  getCreateAssociatedTokenIdempotentInstruction, getInitializeMint2Instruction, getMintToInstruction,
} from '@solana-program/token';
import { LiteSVM } from 'litesvm';
import { existsSync } from 'node:fs';

export const SO = 'tests/guard/attacker/target/deploy/orientim_attacker.so';

export const SYSTEM_PROGRAM = address('11111111111111111111111111111111');
export const TOKEN_PROGRAM = address('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
export const TOKEN_2022_PROGRAM = address('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb');
export const ATA_PROGRAM = address('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');
export const JUPITER_PROGRAM = address('JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4');
export const WSOL_MINT = address('So11111111111111111111111111111111111111112');
export const MINT_SIZE = 82;

/** The associated token account of `owner` for `mint`. */
export async function ataOf(owner: Address, mint: Address, tokenProgram: Address = TOKEN_PROGRAM): Promise<Address> {
  const e = getAddressEncoder();
  const [ata] = await getProgramDerivedAddress({ programAddress: ATA_PROGRAM, seeds: [e.encode(owner), e.encode(tokenProgram), e.encode(mint)] });
  return ata;
}

/** A token account's amount, or 0 when there is no account. */
export const tokenAmountOf = (data: Uint8Array | undefined): bigint =>
  data && data.length >= 72 ? new DataView(data.buffer, data.byteOffset, data.byteLength).getBigUint64(64, true) : 0n;

/** An account as the chain holds it. */
export type AccountState = { owner: Address; lamports: bigint; data: Uint8Array };

export const SOL = 1_000_000_000n;

// The fixed cases' swap: 100 IN (6 decimals) for at least 10 OUT (9 decimals).
export const MIN_OUT = 10_000_000_000n;
export const IN_DECIMALS = 6;
export const OUT_DECIMALS = 9;

/** Stops with the command that builds the program when it is missing. */
export function requireProgram() {
  if (!existsSync(SO)) {
    console.error(`Missing ${SO}. Build it first:\n  (in tests/guard/attacker) cargo build-sbf`);
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

/** Index of an account in the route's instruction: the Guard's tests place the agent at E and its hopper at eIn. */
export const IX = { token: 0, system: 1, E: 2, eIn: 3, output: 4, attackerIn: 5, pool: 6, poolAuthority: 7 } as const;

/** The hopper → the attacker's own account, signed by the agent: what an honest route does with the input. */
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

/** litesvm takes any size; the network refuses a transaction above 1232 bytes, and so does this. */
export function send(svm: LiteSVM, tx: Transaction): Outcome {
  const bytes = getTransactionEncoder().encode(tx).length;
  if (bytes > 1232) return { ok: false, error: `transaction too large: ${bytes} bytes (max 1232)`, index: null, logs: [] };
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
 * is that program address: an ordinary key at first sight, while the program can still act as the delegate.
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
