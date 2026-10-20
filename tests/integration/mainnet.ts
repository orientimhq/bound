/**
 * T4 + T1 on mainnet, with nothing signed or sent:
 *
 *  T4  For each pair, the real pipeline (Jupiter → compiler → simulation → verifier) must produce
 *      a protected transaction that passes all 7 rules, and whose simulation closes every
 *      temporary account.
 *  T1  Runtime attacks: the Jupiter instruction is replaced by attacker instructions against the
 *      real SPL Token and System programs. Nothing beyond q is reachable, and since the output
 *      floor is enforced a route that does not deliver reverts entirely.
 *  T5  The output floor in the real runtime: a verified swap whose floor is raised to twice the
 *      quote must fail exactly at Orientim's minimum-output check.
 *
 * Simulations use a public exchange wallet as fee payer with sigVerify: false.
 *
 *   node tests/integration/mainnet.ts [--pairs 30] [--versions 0,1] [--skip-attacks] [--only USDC-HNT,...]
 */
import {
  address, appendTransactionMessageInstructions, compileTransaction, compressTransactionMessageUsingAddressLookupTables,
  createNoopSigner, createTransactionMessage, decompileTransactionMessage, fetchAddressesForLookupTables,
  getBase64EncodedWireTransaction, getCompiledTransactionMessageDecoder, pipe, setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
} from '@solana/kit';
import type { Address, Instruction, Transaction } from '@solana/kit';
import { getSetComputeUnitLimitInstruction, getSetComputeUnitPriceInstruction } from '@solana-program/compute-budget';
import { AuthorityType, getCloseAccountInstruction, getSetAuthorityInstruction, getTransferInstruction } from '@solana-program/token';
import { getTransferSolInstruction } from '@solana-program/system';
import { mkdirSync, writeFileSync } from 'node:fs';
import { ataOf, JUPITER_PROGRAM, TOKEN_PROGRAM, tokenAmountOf, WSOL_MINT } from '@orientimhq/swap/core';
import { buildPolicy, protectedInstructions } from '@orientim/builder';
import { verify } from '@orientimhq/swap/verifier';
import type { TxVersion } from '@orientimhq/swap/core';
import { createEphemeral, createRetryingRpc, fetchMints, fetchSnapshot } from '@orientimhq/swap/solana';
import { OrientimError, createJupiterClient, DEFAULT_SETTINGS, prepareProtectedSwap } from '@orientim/jupiter';

const arg = (name: string, fallback: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : fallback;
};
const PAIR_LIMIT = Number(arg('pairs', '30'));
const VERSIONS = arg('versions', '0,1').split(',').map(Number) as TxVersion[];
const SKIP_ATTACKS = process.argv.includes('--skip-attacks');
// --only USDC-HNT,SOL-POPCAT reruns just those pairs.
const ONLY = arg('only', '').split(',').filter(Boolean);

const rpc = createRetryingRpc(process.env.RPC_URL ?? 'https://api.mainnet-beta.solana.com', 8);
const jupiter = createJupiterClient({
  buildUrl: 'https://api.jup.ag/swap/v2/build',
  tokensUrl: 'https://api.jup.ag/tokens/v2/search',
  labelsUrl: 'https://api.jup.ag/swap/v2/program-id-to-label',
  apiKey: process.env.JUPITER_API_KEY,
  // Keyless Jupiter allows one request every two seconds; a key allows more.
  minIntervalMs: process.env.JUPITER_API_KEY ? 1100 : 2_100,
});

// Public exchange wallets holding the input tokens (simulation only; see spikes/phase1).
const SIM_WALLET = address('GJRs4FwHtemZ5ZE9x3FNvJ8TMwitKTh21yxdRPqn7npE');
const TREASURY = address('ASTyfSima4LLAdDgoFGkgqoKowG1LZFDr9fAQrg7iaJZ');

const M = {
  SOL: WSOL_MINT,
  USDC: address('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'),
  USDT: address('Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB'),
  BONK: address('DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263'),
  JUP: address('JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN'),
  WIF: address('EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm'),
  JTO: address('jtojtomepa8beP8AuQc6eXt5FriJwfFMwQx2v2f9mCL'),
  PYTH: address('HZ1JovNiVvGrGNiiYvEozEVgZ58xaU3RKwX8eACQBCt3'),
  RAY: address('4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R'),
  mSOL: address('mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So'),
  JitoSOL: address('J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn'),
  ORCA: address('orcaEKTdK7LKz57vaAYr9QeNsVEPfiu6QeMU1kektZE'),
  W: address('85VBFQZC9TZkfaptBWjvUw7YbZjy52A6mjtPGjstQAmQ'),
  POPCAT: address('7GCihgDB8fe6KNjn2MYtkzZcRjQy3t9GHdC8uHYmW2hr'),
  TRUMP: address('6p6xgHyF7AeE6TZkSmFsko444wqoP15icUSqi2jfGiPN'),
  RENDER: address('rndrizKT3MK1iimdxRdWabcF7Zg7AR5T4nud4EkHBof'),
  HNT: address('hntyVP6YFm1Hg25TN9WGLqM12b8TQmcknKrdu1oxWux'),
  PENGU: address('2zMMhcVQEXDtdE6vsFS7S7D5oUodfJHE8vd1gnBouauv'),
  JLP: address('27G8MtK7VtTcCHkpASjSDdkWWYfoqT6ggEuKidVJidD4'),
  // Token-2022, with extensions a protected swap can live with (phase 3).
  PUMP: address('pumpCmXqMfrsAkQ5r49WcJnRayYRqmXz6ae8H7H9Dfn'),
  CATE: address('Ai66LHZG9MCzg1WKdawwqduVAXpNDUuV8M3uyq5ppump'),
  PAID: address('98kfF7rmsg1QDUEoCqNE7g7M1FdrTt92TEp2CLzypump'),
  TIPPED: address('tipp4C4Jnpft26HC9VXNjUPidojZqxXf8nzKvrKf5BS'),
};
type Sym = keyof typeof M;

const PAIRS: [Sym, Sym][] = [
  ['USDC', 'SOL'], ['SOL', 'USDC'], ['USDC', 'USDT'], ['SOL', 'USDT'], ['USDC', 'BONK'], ['BONK', 'USDC'],
  ['SOL', 'BONK'], ['USDC', 'JUP'], ['JUP', 'USDC'], ['SOL', 'JUP'], ['USDC', 'WIF'], ['WIF', 'SOL'],
  ['USDC', 'JTO'], ['SOL', 'JTO'], ['USDC', 'PYTH'], ['SOL', 'PYTH'], ['USDC', 'RAY'], ['SOL', 'RAY'],
  ['SOL', 'mSOL'], ['SOL', 'JitoSOL'], ['JitoSOL', 'SOL'], ['USDC', 'ORCA'], ['SOL', 'W'], ['USDC', 'POPCAT'],
  ['SOL', 'POPCAT'], ['USDC', 'TRUMP'], ['SOL', 'RENDER'], ['USDC', 'HNT'], ['SOL', 'PENGU'], ['USDC', 'JLP'],
  ['SOL', 'PUMP'], ['PUMP', 'SOL'], ['USDC', 'PUMP'], ['SOL', 'CATE'], ['USDC', 'PAID'], ['SOL', 'TIPPED'],
];

const log = (...a: unknown[]) => console.log(...a);

// Public exchange wallets used as simulated owners. For SPL outputs the floor check is
// b0 + minOut on W_out, so a wallet whose W_out balance keeps moving (busy hot wallet) makes the
// check race; prefer a wallet whose output account is absent or empty for that pair.
const SIM_CANDIDATES = [
  'GJRs4FwHtemZ5ZE9x3FNvJ8TMwitKTh21yxdRPqn7npE', 'H8sMJSCQxfKiFTCfDR3DUMLPwcRbM61LGFJ8N4dK3WjS',
  '2AQdpHJ2JpcEgPiATUXjQxA8QmafFegfQwSLWSprPicm', '5tzFkiKscXHK5ZXCGbXZxdw7gTjjD1mBwuoFbhUvuAi9',
  'AC5RDfQFmDS1deWZos921JfqscXdByf8BKHs5ACWjtW2', '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM',
  'is6MTRHEgyFLNTfYcuV4QBWLjrZBfmhVNYR6ccgr8KV',
].map(a => address(a));

/** The token program that owns a mint, read once and remembered. */
const programCache = new Map<string, Address>();
async function programOf(mint: Address): Promise<Address> {
  const known = programCache.get(mint);
  if (known) return known;
  const info = (await fetchMints(rpc, [mint])).get(mint);
  const program = info?.program ?? TOKEN_PROGRAM;
  programCache.set(mint, program);
  if (info) decimalsCache.set(mint, info.decimals);
  return program;
}

const tokenBalance = async (owner: Address, mint: Address) => {
  const { value } = await rpc.getAccountInfo(await ataOf(owner, mint, await programOf(mint)), { encoding: 'base64' }).send();
  return value ? tokenAmountOf(Uint8Array.from(Buffer.from(value.data[0], 'base64'))) : null;
};

async function pickSimWallet(a: Sym, b: Sym, amount: bigint): Promise<Address> {
  const needLamports = (a === 'SOL' ? amount : 0n) + 100_000_000n;
  const { value: wallets } = await rpc.getMultipleAccounts(SIM_CANDIDATES, { encoding: 'base64' }).send();
  let fallback: Address | null = null;
  for (const [i, w] of SIM_CANDIDATES.entries()) {
    if (!wallets[i] || wallets[i]!.lamports < needLamports) continue;
    if (a !== 'SOL' && ((await tokenBalance(w, M[a])) ?? 0n) < amount) continue;
    if (b === 'SOL') return w; // variant A: the floor is checked on the fresh E_out
    const out = await tokenBalance(w, M[b]);
    if (out === null || out === 0n) return w;
    fallback ??= w;
  }
  return fallback ?? SIM_WALLET;
}

// A token-input swap is fee-free when the treasury has no account for that token.
// To exercise the fee path, simulations send the fee to another exchange wallet that holds the
// input token (nothing is sent, so the recipient only has to exist).
async function pickTreasury(owner: Address, a: Sym): Promise<Address> {
  if (a === 'SOL') return TREASURY; // variant B pays the fee in SOL to the wallet itself
  for (const w of SIM_CANDIDATES) if (w !== owner && (await tokenBalance(w, M[a])) !== null) return w;
  return TREASURY;
}

/** About $100 of `sym`, priced with a Jupiter quote (retried: quotes fail transiently). */
/** On-chain decimals, as the dApp reads them before converting what the user typed. */
const decimalsCache = new Map<string, number>();
async function decimalsOf(a: Sym, b: Sym) {
  const missing = [M[a], M[b]].filter(m => !decimalsCache.has(m));
  if (missing.length) {
    for (const [m, info] of await fetchMints(rpc, missing)) {
      decimalsCache.set(m, info.decimals);
      if (info.program) programCache.set(m, info.program);
    }
  }
  return { inputDecimals: decimalsCache.get(M[a])!, outputDecimals: decimalsCache.get(M[b])! };
}

async function amountFor(sym: Sym): Promise<bigint> {
  if (sym === 'USDC') return 100_000_000n;
  if (sym === 'SOL') return 900_000_000n;
  for (let attempt = 0; ; attempt++) {
    try {
      const r = await jupiter.build({
        inputMint: M.USDC, outputMint: M[sym], amount: 100_000_000n, taker: SIM_WALLET, slippageBps: 50, maxAccounts: 64,
      });
      return BigInt(r.outAmount);
    } catch (e) {
      if (attempt >= 3) throw e;
      await new Promise(r => setTimeout(r, 3_000));
    }
  }
}

async function simulateWithAccounts(tx: Transaction, addresses: Address[]) {
  const { value } = await rpc.simulateTransaction(getBase64EncodedWireTransaction(tx), {
    encoding: 'base64', sigVerify: false, replaceRecentBlockhash: true, commitment: 'confirmed',
    accounts: { addresses, encoding: 'base64' },
  }).send();
  return { ok: value.err === null, err: value.err, accounts: value.accounts ?? [], logs: value.logs ?? [] };
}

const json = (v: unknown) => JSON.stringify(v, (_, x) => (typeof x === 'bigint' ? x.toString() : x));
const failedInstruction = (err: unknown) => {
  const i = (err as { InstructionError?: [number | bigint, unknown] } | null)?.InstructionError?.[0];
  return i === undefined ? null : Number(i);
};

/** Index of Orientim's minimum-output check (a Token self-TransferChecked) in a transaction. */
async function floorCheckIndex(tx: Transaction): Promise<number> {
  const compiled = getCompiledTransactionMessageDecoder().decode(tx.messageBytes);
  const tables = (compiled as { addressTableLookups?: { lookupTableAddress: Address }[] }).addressTableLookups ?? [];
  const lookups = tables.length ? await fetchAddressesForLookupTables(tables.map(t => t.lookupTableAddress), rpc) : {};
  const msg = decompileTransactionMessage(compiled as never, { addressesByLookupTableAddress: lookups });
  return (msg.instructions as Instruction[]).findIndex(ix => ix.data?.[0] === 12 && ix.accounts?.[0].address === ix.accounts?.[2].address);
}

// ---------------------------------------------------------------- T4

type Row = { pair: string; version: TxVersion; ok: boolean; detail: string; size?: number; units?: number; repairs?: number; lossBps?: number; fee?: boolean; totalMs?: number; localMs?: number; gapBps?: number };

async function runT4(): Promise<Row[]> {
  const rows: Row[] = [];
  const amounts = new Map<Sym, bigint>();
  for (const [a, b] of PAIRS.slice(0, PAIR_LIMIT).filter(([x, y]) => !ONLY.length || ONLY.includes(`${x}-${y}`))) {
    if (!amounts.has(a)) {
      try {
        amounts.set(a, await amountFor(a));
      } catch (e) {
        for (const version of VERSIONS) rows.push({ pair: `${a}→${b}`, version, ok: false, detail: `pricing the test amount failed: ${(e as Error).message}` });
        continue;
      }
    }
    for (const version of VERSIONS) {
      const pair = `${a}→${b}`;
      let row: Row | null = null;
      // The execution check re-simulates seconds after prepare. If the price moved below the floor
      // or a pool changed in between, the swap reverts (nothing is lost but the fee): prepare once
      // more, as a user would. A pair must pass on its own second prepare, so a systematic failure
      // still fails.
      let firstFailure = '';
      for (let tryNo = 1; !row; tryNo++) {
        const E = await createEphemeral();
        try {
          const owner = await pickSimWallet(a, b, amounts.get(a)!);
          const treasury = await pickTreasury(owner, a);
          const prepared = await prepareProtectedSwap(
            { rpc, jupiter, settings: { ...DEFAULT_SETTINGS, treasury, jupiterProgram: JUPITER_PROGRAM } },
            {
              owner, ephemeral: E, inputMint: M[a], outputMint: M[b], amountIn: amounts.get(a)!, version,
              // A thin pair often routes worse than the open market, and the page asks the user
              // about that. This test answers as a user who accepts, so that what is measured is
              // whether the pipeline builds a verified transaction, not what the market costs.
              acceptedCostBps: 500n,
              ...(await decimalsOf(a, b)),
            },
          );
          // Execution check: every temporary account is closed at the end of the transaction.
          // Every temporary account, intermediates included.
          const temp = [
            E.address, prepared.policy.accounts.eIn, ...(prepared.policy.accounts.eOut ? [prepared.policy.accounts.eOut] : []),
            ...prepared.intermediates.map(x => x.ata),
          ];
          const sim = await simulateWithAccounts(prepared.transaction, temp);
          if (!sim.ok && tryNo === 1) {
            const failedAt = failedInstruction(sim.err);
            const atFloor = failedAt !== null && failedAt === (await floorCheckIndex(prepared.transaction));
            firstFailure = atFloor ? 'output below the minimum' : `instruction ${failedAt ?? '?'} ${json(sim.err)}`;
            log(`     v${version} ${pair}: reverted in the execution check (${firstFailure}); preparing again`);
            continue;
          }
          const leftovers = sim.accounts.filter(x => x && x.lamports > 0n).length;
          const q = prepared.quote;
          const lossBps = q.baselineOut > 0n ? Number(((q.baselineOut - q.outAmount) * 10_000n) / q.baselineOut) : 0;
          const ok = sim.ok && leftovers === 0;
          row = {
            pair, version, ok, size: prepared.size, units: prepared.computeUnits, repairs: prepared.attempts.length - 1, lossBps: Math.max(0, lossBps),
            fee: prepared.policy.fee > 0n,
            totalMs: prepared.timings.totalMs, localMs: prepared.timings.localMs,
            gapBps: Number(prepared.quote.gapBps),
            detail: (ok ? q.route.join(' → ') : sim.ok ? `${leftovers} temporary account(s) left open` : `simulation: ${json(sim.err)}`) +
              (tryNo > 1 ? ` (2nd prepare; 1st reverted: ${firstFailure})` : ''),
          };
        } catch (e) {
          const err = e as OrientimError;
          row = { pair, version, ok: false, detail: `${err.code ?? 'error'}: ${err.message}${err.violations?.length ? ' ' + json(err.violations) : ''}` };
        }
      }
      rows.push(row);
      const r = row;
      log(`${r.ok ? 'OK ' : 'FAIL'} v${version} ${pair.padEnd(14)} ${r.size ?? ''}B ${r.units ?? ''}CU repairs=${r.repairs ?? '-'} fee=${r.fee === undefined ? '-' : r.fee ? 'yes' : 'waived'} prepare=${r.totalMs ?? '-'}ms local=${r.localMs ?? '-'}ms vs_treg=${r.gapBps === undefined ? '-' : `${(r.gapBps / 100).toFixed(2)}%`} ${r.detail}`);
    }
  }
  return rows;
}

// ---------------------------------------------------------------- T1

type AttackRow = { attack: string; expected: string; outcome: string; verifier: string; pass: boolean };
type Outcome = { attack: 'succeeds' | 'fails'; tx: 'succeeds' | 'reverted' };

async function runT1(): Promise<AttackRow[]> {
  const W = SIM_WALLET;
  const E = await createEphemeral();
  const attacker = TREASURY; // any wallet other than W
  const attackerUsdc = await ataOf(attacker, M.USDC);
  const wBonk = await ataOf(W, M.BONK);
  const policy = await buildPolicy({
    intent: { owner: W, inputMint: M.USDC, outputMint: M.SOL, amountIn: 100_000_000n },
    ephemeral: E.address, inputDecimals: 6, outputDecimals: 9, minOut: 1n,
    config: { feeBps: 30n, treasury: null, maxNetworkFeeLamports: 200_000n, jupiterProgram: JUPITER_PROGRAM },
    feeAccountExists: true,
  });
  const a = policy.accounts;
  const ES = createNoopSigner(E.address);
  const WS = createNoopSigner(W);
  const { value: lifetime } = await rpc.getLatestBlockhash({ commitment: 'confirmed' }).send();
  const drainQ = getTransferInstruction({ source: a.eIn, destination: attackerUsdc, authority: ES, amount: policy.swapAmount });

  /** The attack instructions stand exactly where Jupiter's swap would be. */
  const compile = (attackIxs: Instruction[]) => {
    const placeholder = attackIxs[0];
    const ixs = protectedInstructions({ policy, swapInstruction: placeholder, intermediates: [] });
    const at = ixs.indexOf(placeholder);
    ixs.splice(at, 1, ...attackIxs);
    const budget = [getSetComputeUnitLimitInstruction({ units: 400_000 }), getSetComputeUnitPriceInstruction({ microLamports: 1n })];
    const tx = compileTransaction(pipe(
      createTransactionMessage({ version: 0 }),
      m => setTransactionMessageFeePayer(W, m),
      m => setTransactionMessageLifetimeUsingBlockhash(lifetime, m),
      m => appendTransactionMessageInstructions([...budget, ...ixs], m),
    ));
    return { tx, first: budget.length + at, last: budget.length + at + attackIxs.length - 1 };
  };

  const attacks: { name: string; expected: Outcome; ixs: Instruction[] }[] = [
    { name: 'A1: take the approved q from E_in (authority E)', expected: { attack: 'succeeds', tx: 'reverted' }, ixs: [drainQ] },
    { name: 'A1b: take more than q from E_in', expected: { attack: 'fails', tx: 'reverted' },
      ixs: [getTransferInstruction({ source: a.eIn, destination: attackerUsdc, authority: ES, amount: policy.swapAmount + 1n })] },
    { name: "A2: take W's other USDC (authority E)", expected: { attack: 'fails', tx: 'reverted' },
      ixs: [drainQ, getTransferInstruction({ source: a.wIn!, destination: attackerUsdc, authority: ES, amount: 1_000_000n })] },
    { name: "A3: take W's BONK (authority E)", expected: { attack: 'fails', tx: 'reverted' },
      ixs: [drainQ, getTransferInstruction({ source: wBonk, destination: await ataOf(attacker, M.BONK), authority: ES, amount: 1n })] },
    { name: 'A4: take SOL from E', expected: { attack: 'fails', tx: 'reverted' },
      ixs: [drainQ, getTransferSolInstruction({ source: ES, destination: attacker, amount: 1_000_000n })] },
    { name: 'A5: give E_in to the attacker (SetAuthority by E)', expected: { attack: 'succeeds', tx: 'reverted' },
      ixs: [getSetAuthorityInstruction({ owned: a.eIn, owner: ES, authorityType: AuthorityType.AccountOwner, newAuthority: attacker })] },
    { name: 'A6: close E_out to the attacker', expected: { attack: 'succeeds', tx: 'reverted' },
      ixs: [drainQ, getCloseAccountInstruction({ account: a.eOut!, destination: attacker, owner: ES })] },
    { name: 'A7: if W were given to the external program: take SOL from W', expected: { attack: 'succeeds', tx: 'reverted' },
      ixs: [drainQ, getTransferSolInstruction({ source: WS, destination: attacker, amount: 1_000_000n })] },
  ];

  const rows: AttackRow[] = [];
  for (const atk of attacks) {
    const { tx, first, last } = compile(atk.ixs);
    const sim = await simulateWithAccounts(tx, []);
    const failedAt = (sim.err as { InstructionError?: [number | bigint, unknown] } | null)?.InstructionError?.[0];
    const attackFailed = failedAt !== undefined && Number(failedAt) >= first && Number(failedAt) <= last;
    const outcome: Outcome = { attack: attackFailed ? 'fails' : 'succeeds', tx: sim.ok ? 'succeeds' : 'reverted' };
    const snapshot = await fetchSnapshot({
      rpc, lookupTableAddresses: [],
      addresses: [E.address, a.eIn, a.eOut!, M.USDC, M.SOL, ...atk.ixs.flatMap(ix => (ix.accounts ?? []).map(x => x.address))],
    });
    const verdict = await verify(tx, policy, snapshot);
    const pass = outcome.attack === atk.expected.attack && outcome.tx === atk.expected.tx && !verdict.ok;
    const fmt = (o: Outcome) => `sulmi ${o.attack === 'fails' ? 'dështon' : 'kalon'}, tx ${o.tx === 'reverted' ? 'anulohet' : 'kalon'}`;
    rows.push({
      attack: atk.name, expected: fmt(atk.expected), outcome: fmt(outcome),
      verifier: verdict.ok ? 'e pranoi (!)' : `e refuzoi (${[...new Set(verdict.violations.map(v => v.rule))].join(', ')})`,
      pass,
    });
    log(`${pass ? 'OK ' : 'FAIL'} ${atk.name}: ${fmt(outcome)} (pritej: ${fmt(atk.expected)}), verifier ${rows.at(-1)!.verifier}`);
  }
  return rows;
}

// ---------------------------------------------------------------- T5

type FloorRow = { pair: string; honest: string; raised: string; pass: boolean };

async function runT5(): Promise<FloorRow[]> {
  const rows: FloorRow[] = [];
  for (const [a, b] of [['USDC', 'SOL'], ['SOL', 'USDC'], ['USDC', 'BONK']] as [Sym, Sym][]) {
    const pair = `${a}→${b}`;
    try {
      const amountIn = await amountFor(a);
      const prepared = await prepareProtectedSwap(
        { rpc, jupiter, settings: { ...DEFAULT_SETTINGS, treasury: TREASURY, jupiterProgram: JUPITER_PROGRAM } },
        {
          owner: await pickSimWallet(a, b, amountIn), ephemeral: await createEphemeral(), inputMint: M[a], outputMint: M[b], amountIn, version: 0,
          ...(await decimalsOf(a, b)),
        },
      );
      const honest = await simulateWithAccounts(prepared.transaction, []);

      // Rebuild the same message with the floor raised to twice the quoted output.
      const compiled = getCompiledTransactionMessageDecoder().decode(prepared.transaction.messageBytes);
      const tables = (compiled as { addressTableLookups?: { lookupTableAddress: Address }[] }).addressTableLookups ?? [];
      const lookups = await fetchAddressesForLookupTables(tables.map(t => t.lookupTableAddress), rpc);
      const msg = decompileTransactionMessage(compiled as never, { addressesByLookupTableAddress: lookups });
      const ixs = [...msg.instructions] as Instruction[];
      const at = ixs.findIndex(ix => ix.data?.[0] === 12 && ix.accounts?.[0].address === ix.accounts?.[2].address);
      const data = Uint8Array.from(ixs[at].data!);
      const view = new DataView(data.buffer);
      // The check is b0 + minOut (b0 = 0 on the fresh E_out): keep b0, raise the floor to 2× the quote.
      const b0 = view.getBigUint64(1, true) - prepared.policy.minOut;
      view.setBigUint64(1, b0 + prepared.quote.outAmount * 2n, true);
      ixs[at] = { ...ixs[at], data };
      const raisedTx = compileTransaction(compressTransactionMessageUsingAddressLookupTables(
        { ...msg, instructions: ixs } as never,
        lookups,
      ));
      const raised = await simulateWithAccounts(raisedTx, []);
      const failedAt = (raised.err as { InstructionError?: [number | bigint, unknown] } | null)?.InstructionError?.[0];
      const pass = honest.ok && !raised.ok && Number(failedAt) === at;
      rows.push({
        pair, pass,
        honest: honest.ok ? 'kaloi' : `dështoi ${JSON.stringify(honest.err, (_, v) => (typeof v === 'bigint' ? Number(v) : v))}`,
        raised: raised.ok ? 'kaloi (!)' : `u rrëzua te instruction-i ${Number(failedAt)} (kontrolli është te ${at})`,
      });
    } catch (e) {
      rows.push({ pair, pass: false, honest: `gabim: ${(e as Error).message}`, raised: '' });
    }
    const r = rows.at(-1)!;
    log(`${r.pass ? 'OK ' : 'FAIL'} T5 ${pair}: i ndershëm ${r.honest}; minimumi ×2 ${r.raised}`);
  }
  return rows;
}

// ---------------------------------------------------------------- report

const started = new Date();
log(`Orientim integration on mainnet — ${started.toISOString()}`);
const t4 = await runT4();
const t1 = SKIP_ATTACKS ? [] : await runT1();
const t5 = SKIP_ATTACKS ? [] : await runT5();

const okT4 = t4.filter(r => r.ok).length;
const median = (xs: number[]) => (xs.length ? [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] : 0);
const totals = t4.flatMap(r => (r.totalMs === undefined ? [] : [r.totalMs]));
const locals = t4.flatMap(r => (r.localMs === undefined ? [] : [r.localMs]));
const okT1 = t1.filter(r => r.pass).length;
const md = [
  `# Orientim — testet e integrimit në mainnet`,
  ``,
  `Ekzekutuar më ${started.toISOString()}, pa nënshkruar dhe pa dërguar asgjë.`,
  ``,
  `## T4: rrjedha e plotë (Jupiter → compiler → simulim → verifier)`,
  ``,
  `${okT4}/${t4.length} raste kaluan: transaksioni kaloi 7 rregullat, u ekzekutua në simulim dhe mbylli çdo llogari të përkohshme.`,
  ``,
  `Koha e përgatitjes (quote, lexime, simulim, verifikim): mediana ${median(totals)} ms, maksimumi ${Math.max(0, ...totals)} ms. Puna lokale (ndërtim dhe verifikim): mediana ${median(locals)} ms, maksimumi ${Math.max(0, ...locals)} ms. Klienti i testit pret 1.1 s mes thirrjeve te Jupiter pa key, prandaj koha totale këtu është më e gjatë se në faqe.`,
  ``,
  `| Çifti | Versioni | Rezultati | Byte | CU | Riparime | Kosto në çmim (bps) | Fee Orientim | Route ose arsyeja |`,
  `| --- | --- | --- | --- | --- | --- | --- | --- | --- |`,
  ...t4.map(r => `| ${r.pair} | v${r.version} | ${r.ok ? 'kaloi' : 'dështoi'} | ${r.size ?? ''} | ${r.units ?? ''} | ${r.repairs ?? ''} | ${r.lossBps ?? ''} | ${r.fee === undefined ? '' : r.fee ? 'po' : 'falur'} | ${r.detail.replace(/\|/g, '/')} |`),
  ``,
  ...(t1.length ? [
    `## T1: sulme në runtime (SPL Token dhe System Program realë)`,
    ``,
    `${okT1}/${t1.length} sulme u sollën siç pritej në runtime, dhe verifier-i i refuzoi të gjitha para nënshkrimit.`,
    `A1 tregon efektin e kontrollit të minimumit: edhe marrja e q-së anulohet kur output-i nuk mbërrin. A5 dhe A6 tregojnë anulimin automatik. A7 tregon pse ekziston R1: instruction-i që vjedh SOL nga W kalon në runtime nëse W i jepet kodit të jashtëm.`,
    ``,
    `| Sulmi | Pritej | Ndodhi | Verifier-i |`,
    `| --- | --- | --- | --- |`,
    ...t1.map(r => `| ${r.attack} | ${r.expected} | ${r.outcome} | ${r.verifier} |`),
  ] : []),
  ...(t5.length ? [
    ``,
    `## T5: minimumi i output-it në runtime-in real`,
    ``,
    `${t5.filter(r => r.pass).length}/${t5.length}: swap-i i verifikuar kalon, dhe i njëjti swap me minimumin ×2 rrëzohet pikërisht te kontrolli i Orientim-it.`,
    ``,
    `| Çifti | Swap-i i ndershëm | Minimumi ×2 |`,
    `| --- | --- | --- |`,
    ...t5.map(r => `| ${r.pair} | ${r.honest} | ${r.raised} |`),
  ] : []),
].join('\n') + '\n';
mkdirSync('tests/integration/results', { recursive: true });
const file = `tests/integration/results/mainnet-${started.toISOString().replace(/[:.]/g, '-')}.md`;
writeFileSync(file, md);
const okT5 = t5.filter(r => r.pass).length;
log(`\nT4 ${okT4}/${t4.length}  T1 ${okT1}/${t1.length}  T5 ${okT5}/${t5.length}  prepare median ${median(totals)} ms, local median ${median(locals)} ms (max ${Math.max(0, ...locals)} ms)  →  ${file}`);
process.exit(okT4 === t4.length && okT1 === t1.length && okT5 === t5.length ? 0 : 1);
