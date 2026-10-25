/**
 * Orientim Guard with real Jupiter routes (S5): for each pair, a route built by Jupiter's Swap API
 * for the agent, run inside a copy of mainnet in litesvm (every account and program the route names,
 * fetched from the RPC, the clock set to mainnet's) between the Guard's Pull and Settle.
 *
 * For each case it measures the transaction's wire size against Solana's 1,232 bytes, its compute,
 * the Guard's own share, and whether the owner received at least the route's minimum. The same route
 * also runs alone, from the agent's own account, as the baseline. When Pyth's sponsored price account
 * of both mints exists, the case also turns on the price floor (I10) and the loss budget (I11) with
 * mainnet's real price updates.
 *
 * Nothing is signed for mainnet or sent to it: every key is fresh, every balance is written into the
 * local copy, no funds exist anywhere.
 *
 *   RPC_URL=… JUPITER_API_KEY=… node tests/guard/jupiter.ts
 *   GUARD_JUP_PAIRS   pairs as IN>OUT:amount in whole tokens (default below)
 *   GUARD_JUP_MAX_ACCOUNTS   Jupiter's maxAccounts (default 64)
 *   GUARD_JUP_OUT     the report's file name in tests/guard/results (default jupiter.md)
 */
import {
  address, appendTransactionMessageInstructions, compileTransaction, compressTransactionMessageUsingAddressLookupTables,
  createTransactionMessage, generateKeyPairSigner, getAddressEncoder, getBase64EncodedWireTransaction,
  getProgramDerivedAddress, lamports, pipe, setTransactionMessageFeePayer, setTransactionMessageLifetimeUsingBlockhash,
  signTransaction,
} from '@solana/kit';
import type { Address, Instruction, KeyPairSigner, Transaction } from '@solana/kit';
import { getSetComputeUnitLimitInstruction } from '@solana-program/compute-budget';
import { LiteSVM } from 'litesvm';
import { mkdirSync, writeFileSync } from 'node:fs';
import { JUPITER_PROGRAM, TOKEN_PROGRAM } from '@orientimhq/swap/core';
import { createRetryingRpc, fetchAccounts } from '@orientimhq/swap/solana';
import { ataOf } from '@orientim/builder';
import { createJupiterClient, toKitInstruction } from '@orientim/jupiter';
import type { BuildResponse } from '@orientim/jupiter';
import { send } from '../cpi/world.ts';
import { feeOf, GUARD_SO, ix, requireGuard, TREASURY } from './world.ts';
import type { GuardWorld } from './world.ts';

requireGuard();

const RPC_URL = process.env.RPC_URL || 'https://api.mainnet-beta.solana.com';
const JUPITER_API_KEY = process.env.JUPITER_API_KEY || undefined;
const MAX_ACCOUNTS = Number(process.env.GUARD_JUP_MAX_ACCOUNTS || 64);
const OUT_FILE = process.env.GUARD_JUP_OUT || 'jupiter.md';
const PAIRS = (process.env.GUARD_JUP_PAIRS || 'USDC>SOL:100,SOL>USDC:1,USDC>JUP:100,JUP>USDC:200,USDC>BONK:50,SOL>JUP:2')
  .split(',').map(s => s.trim()).filter(Boolean);
const SOL = 1_000_000_000n;
const PACKET = 1232;

const MINTS: Record<string, { mint: Address; feed?: string }> = {
  SOL: { mint: address('So11111111111111111111111111111111111111112'), feed: 'ef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d' },
  USDC: { mint: address('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'), feed: 'eaa020c61cc479712813461ce153894a96a6c00b21ed0cfc2798d1f9a9e9c94a' },
  JUP: { mint: address('JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN'), feed: '0a0408d619e9380abad35060f9192039ed5042fa6f82301d0e48bb52be830996' },
  BONK: { mint: address('DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263'), feed: '72b021217ca3fe68922a19aaf990109cb9d84e9ad004b4d2025ad6f529314419' },
};
/** Pyth's push oracle: sponsored feeds live at PDA [shard 0 as u16, feed id]. */
const PYTH_PUSH_ORACLE = address('pythWSnswVUd12oZpeFP8e9CVaEqJg25g1Vtc2biRsT');
const PYTH_RECEIVER = address('rec5EKMGg6MxZYaMdyBfgwp4d5rB9T1VQH5pJv5LtFJ');

const UPGRADEABLE = 'BPFLoaderUpgradeab1e11111111111111111111111';
const LOADERS = new Set([UPGRADEABLE, 'BPFLoader2111111111111111111111111111111111', 'BPFLoader1111111111111111111111111111111111', 'LoaderV411111111111111111111111111111111111']);
/** litesvm's own copies of these stay: builtins, sysvars and the SPL programs it ships. */
const KEEP = new Set([
  '11111111111111111111111111111111', 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb',
  'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL', 'ComputeBudget111111111111111111111111111111', 'Sysvar1nstructions1111111111111111111111111',
  'SysvarC1ock11111111111111111111111111111111', 'SysvarRent111111111111111111111111111111111', 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr',
  'Memo1UhkJRfHyvLMcVucJwxXeuD728EqVDDwQDxFMNo', ...LOADERS,
]);

const rpc = createRetryingRpc(RPC_URL, 8);
const jupiter = createJupiterClient({
  buildUrl: 'https://api.jup.ag/swap/v2/build', tokensUrl: 'https://api.jup.ag/tokens/v2/search',
  labelsUrl: 'https://api.jup.ag/swap/v2/program-id-to-label', apiKey: JUPITER_API_KEY, minIntervalMs: 1100, timeoutMs: 20_000,
});

const enc = getAddressEncoder();
const u64le = (v: bigint) => {
  const b = new Uint8Array(8);
  new DataView(b.buffer).setBigUint64(0, v, true);
  return b;
};
const TOKEN_ACCOUNT_RENT = 2_039_280n;

/** An initialized SPL Token account, written straight into the copy. */
function tokenAccount(mint: Address, owner: Address, amount: bigint, o: { delegate?: Address; delegated?: bigint; native?: boolean } = {}) {
  const d = new Uint8Array(165);
  d.set(enc.encode(mint), 0);
  d.set(enc.encode(owner), 32);
  d.set(u64le(amount), 64);
  if (o.delegate) {
    d.set([1, 0, 0, 0], 72);
    d.set(enc.encode(o.delegate), 76);
  }
  d[108] = 1;
  if (o.native) {
    d.set([1, 0, 0, 0], 109);
    d.set(u64le(TOKEN_ACCOUNT_RENT), 113);
  }
  d.set(u64le(o.delegated ?? 0n), 121);
  return { data: d, lamports: TOKEN_ACCOUNT_RENT + (o.native ? amount : 0n) };
}

const ixAddresses = (r: BuildResponse) => [
  ...r.setupInstructions, r.swapInstruction, ...(r.cleanupInstruction ? [r.cleanupInstruction] : []), ...r.otherInstructions,
].flatMap(i => [i.programId, ...i.accounts.map(a => a.pubkey)]);

type Case = {
  pair: string; amount: string; labels: string; ok: boolean; baseline: string; result: string;
  bytes: number | null; tableBytes: number | null; tableResult: string; baseBytes: number | null; cu: number | null; baseCu: number | null; guardCu: number | null;
  minOut: bigint; arrived: bigint | null; oracle: string; logs: string[]; baseLogs: string[];
};

/**
 * Mainnet's accounts the route names (and the programs' data), read once; each call of the result is
 * a fresh copy of that one snapshot at mainnet's clock, so that the baseline and the Guard start equal.
 */
async function mainnetCopy(r: BuildResponse, extra: Address[]): Promise<() => LiteSVM> {
  const want = [...new Set([...ixAddresses(r), ...Object.keys(r.addressesByLookupTableAddress ?? {}), ...extra])]
    .filter(a => !KEEP.has(a)).map(a => address(a));
  const got = await fetchAccounts(rpc, want);
  const programData: Address[] = [];
  for (const [a, acc] of got) {
    if (acc && acc.owner === UPGRADEABLE && acc.data[0] === 2) programData.push(address(base58(acc.data.slice(4, 36))));
    void a;
  }
  const pd = programData.length ? await fetchAccounts(rpc, programData) : new Map();
  // A finalized slot has its block time; a fresh one may not yet. The wall clock is close enough then.
  const slot = await rpc.getSlot({ commitment: 'finalized' }).send();
  const time = await rpc.getBlockTime(slot).send().catch(() => null);
  return () => {
    const svm = new LiteSVM().withSigverify(true).withNativeMints();
    // Program data first, so that each program finds its code when it is set.
    for (const [a, acc] of [...pd, ...got]) {
      if (!acc) continue;
      const executable = LOADERS.has(acc.owner) && (acc.owner !== UPGRADEABLE || acc.data[0] === 2);
      svm.setAccount({ address: address(a), data: acc.data, executable, lamports: lamports(acc.lamports), programAddress: acc.owner, space: BigInt(acc.data.length) });
    }
    const clock = svm.getClock();
    clock.slot = slot;
    clock.unixTimestamp = BigInt(time ?? Math.floor(Date.now() / 1000));
    svm.setClock(clock);
    return svm;
  };
}

const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function base58(bytes: Uint8Array): string {
  let n = 0n;
  for (const b of bytes) n = n * 256n + BigInt(b);
  let s = '';
  while (n > 0n) {
    s = ALPHABET[Number(n % 58n)] + s;
    n /= 58n;
  }
  for (const b of bytes) {
    if (b !== 0) break;
    s = `1${s}`;
  }
  return s;
}

const hexBytes = (h: string) => Uint8Array.from(h.match(/../g)!.map(x => Number.parseInt(x, 16)));
const pythAccount = async (feed: string) => (await getProgramDerivedAddress({ programAddress: PYTH_PUSH_ORACLE, seeds: [Uint8Array.of(0, 0), hexBytes(feed)] }))[0];

type Tables = Record<Address, Address[]>;
function compile(svm: LiteSVM, payer: KeyPairSigner, ixs: Instruction[], r: BuildResponse, own: Tables = {}) {
  const tables = {
    ...Object.fromEntries(Object.entries(r.addressesByLookupTableAddress ?? {}).map(([k, v]) => [address(k), v.map(x => address(x))])),
    ...own,
  };
  return pipe(
    createTransactionMessage({ version: 0 }),
    m => setTransactionMessageFeePayer(payer.address, m),
    m => setTransactionMessageLifetimeUsingBlockhash({ blockhash: svm.latestBlockhash(), lastValidBlockHeight: 10_000n }, m),
    m => appendTransactionMessageInstructions(ixs, m),
    m => compressTransactionMessageUsingAddressLookupTables(m, tables),
  );
}
const LOOKUP_TABLE_PROGRAM = 'AddressLookupTab1e1111111111111111111111111';
/**
 * The owner's own lookup table, written straight into the copy: the accounts every one of its swaps
 * names (its policy, grant, authority and token accounts, the treasury's, the mints, the prices). In
 * production the owner creates it once, next to the policy. Header: kind 1, never deactivated, last
 * extended at slot 0, an authority, then the addresses.
 */
function lookupTable(svm: LiteSVM, at: Address, owner: Address, list: Address[]) {
  const d = new Uint8Array(56 + 32 * list.length);
  const v = new DataView(d.buffer);
  v.setUint32(0, 1, true);
  v.setBigUint64(4, 0xffff_ffff_ffff_ffffn, true);
  d[20] = list.length;
  d[21] = 1;
  d.set(enc.encode(owner), 22);
  list.forEach((a, i) => d.set(enc.encode(a), 56 + 32 * i));
  svm.setAccount({ address: at, data: d, executable: false, lamports: lamports(SOL), programAddress: address(LOOKUP_TABLE_PROGRAM), space: BigInt(d.length) });
}
const wireBytes = (tx: Transaction) => Buffer.from(getBase64EncodedWireTransaction(tx), 'base64').length;

/** Compute from the logs: the whole transaction's, and the named program's own top-level share. */
function computeOf(logs: string[], program?: Address) {
  let total = 0;
  let own = 0;
  for (const l of logs) {
    const m = /^Program (\S+) consumed (\d+) of \d+ compute units/.exec(l);
    if (!m) continue;
    total += Number(m[2]);
    if (program && m[1] === program) own += Number(m[2]);
  }
  return { total, own };
}

const amountOf = (svm: LiteSVM, a: Address) => {
  const acc = svm.getAccount(a);
  if (!acc.exists) return 0n;
  return new DataView(Uint8Array.from(acc.data).buffer).getBigUint64(64, true);
};

async function runCase(spec: string): Promise<Case> {
  const [names, ui] = spec.split(':');
  const [inName, outName] = names.split('>');
  const IN = MINTS[inName];
  const OUT = MINTS[outName];
  if (!IN || !OUT) throw new Error(`unknown pair ${spec}`);
  const mints = await fetchAccounts(rpc, [IN.mint, OUT.mint]);
  const mi = mints.get(IN.mint);
  const mo = mints.get(OUT.mint);
  if (!mi || !mo) throw new Error(`mint missing for ${spec}`);
  if (mi.owner !== TOKEN_PROGRAM || mo.owner !== TOKEN_PROGRAM) throw new Error(`${spec}: only SPL Token mints in this run`);
  const amount = BigInt(Math.round(Number(ui) * 10 ** mi.data[44]));

  const [W, agent, verifier, guardKey] = await Promise.all(Array.from({ length: 4 }, () => generateKeyPairSigner()));
  const text = (s: string) => new TextEncoder().encode(s);
  const pda = async (...seeds: Uint8Array[]) => (await getProgramDerivedAddress({ programAddress: guardKey.address, seeds }))[0];
  const g = {
    guard: guardKey.address, agent, verifier, W,
    policy: await pda(text('policy'), enc.encode(W.address) as Uint8Array),
    grant: await pda(text('grant'), enc.encode(W.address) as Uint8Array, enc.encode(agent.address) as Uint8Array),
    authority: await pda(text('auth'), enc.encode(W.address) as Uint8Array),
    hopper: await ataOf(agent.address, IN.mint, TOKEN_PROGRAM),
    wIn: await ataOf(W.address, IN.mint, TOKEN_PROGRAM),
    wOut: await ataOf(W.address, OUT.mint, TOKEN_PROGRAM),
    treasuryIn: await ataOf(TREASURY, IN.mint, TOKEN_PROGRAM),
    mintIn: IN.mint, mintOut: OUT.mint, tokenProgram: TOKEN_PROGRAM,
  } as unknown as GuardWorld;

  const r = await jupiter.build({
    inputMint: IN.mint, outputMint: OUT.mint, amount, taker: agent.address, slippageBps: 100, maxAccounts: MAX_ACCOUNTS,
    destinationTokenAccount: g.wOut,
  });
  const minOut = BigInt(r.otherAmountThreshold);
  const labels = r.routePlan.map(p => p.swapInfo.label).join(' + ');
  const prices = IN.feed && OUT.feed ? [await pythAccount(IN.feed), await pythAccount(OUT.feed)] : [];
  const route = [...r.setupInstructions, r.swapInstruction, ...r.otherInstructions].map(toKitInstruction);
  const cleanup = r.cleanupInstruction ? [toKitInstruction(r.cleanupInstruction)] : [];
  const cuLimit = getSetComputeUnitLimitInstruction({ units: 1_400_000 });

  const fill = (svm: LiteSVM, withGuard: boolean) => {
    svm.airdrop(agent.address, lamports(10n * SOL));
    svm.airdrop(W.address, lamports(10n * SOL));
    const native = IN.mint === MINTS.SOL.mint;
    const put = (a: Address, t: ReturnType<typeof tokenAccount>) =>
      svm.setAccount({ address: a, data: t.data, executable: false, lamports: lamports(t.lamports), programAddress: TOKEN_PROGRAM, space: 165n });
    put(g.wOut, tokenAccount(OUT.mint, W.address, 0n, { native: OUT.mint === MINTS.SOL.mint }));
    if (withGuard) {
      put(g.wIn, tokenAccount(IN.mint, W.address, amount * 4n, { delegate: g.authority, delegated: amount * 2n, native }));
      put(g.hopper, tokenAccount(IN.mint, agent.address, 0n, { native }));
      put(g.treasuryIn, tokenAccount(IN.mint, TREASURY, 0n, { native }));
    } else {
      put(g.hopper, tokenAccount(IN.mint, agent.address, amount, { native }));
    }
  };

  // The baseline: the same route alone, from the agent's own account.
  const copy = await mainnetCopy(r, prices);
  const base = copy();
  fill(base, false);
  const baseTx = await signTransaction([agent.keyPair], compileTransaction(compile(base, agent, [cuLimit, ...route, ...cleanup], r)));
  const baseResult = send(base, baseTx);
  const baseOut = amountOf(base, g.wOut);

  // The Guard: Pull, the route, Settle.
  const svm = copy();
  svm.addProgramFromFile(guardKey.address, GUARD_SO);
  fill(svm, true);
  const pyth = prices.length === 2 && prices.every(p => {
    const a = svm.getAccount(p);
    return a.exists && a.programAddress === PYTH_RECEIVER;
  });
  const setupTx = compileTransaction(compile(svm, W, [
    ix.initPolicy(g, W.address, [verifier.address], [JUPITER_PROGRAM]),
    ix.setGrant(g, W.address, g.grant, agent.address, {
      limits: [{ mint: IN.mint, perSwap: amount * 2n, perDay: amount * 4n }], outputs: [OUT.mint],
      ...(pyth ? {
        maxSlippageBps: 300, feeds: [{ mint: IN.mint, feed: address(base58(hexBytes(IN.feed!))) }, { mint: OUT.mint, feed: address(base58(hexBytes(OUT.feed!))) }],
        maxLossPerDay: 1_000_000_000n, maxLossTotal: 1_000_000_000n,
      } : {}),
    }),
  ], r));
  const setup = send(svm, await signTransaction([W.keyPair], setupTx));
  if (!setup.ok) throw new Error(`the owner's set-up failed: ${setup.error}\n${setup.logs.join('\n')}`);
  svm.expireBlockhash();
  if (pyth) Object.assign(g, { prices, lossBudget: true });
  const guardIxs = [cuLimit, ix.pull(g, amount, minOut), ...route, ...cleanup, ix.settle(g)];
  const tx = await signTransaction([agent.keyPair, verifier.keyPair], compileTransaction(compile(svm, agent, guardIxs, r)));
  // The same transaction with the owner's lookup table: simulated first, so that the state stays as it was.
  const table = (await generateKeyPairSigner()).address;
  const owned = [
    g.policy, g.grant, g.authority, g.wIn, g.wOut, g.hopper, g.treasuryIn, IN.mint, OUT.mint, TOKEN_PROGRAM,
    address('Sysvar1nstructions1111111111111111111111111'), ...(pyth ? prices : []),
  ];
  lookupTable(svm, table, W.address, owned);
  const tableTx = await signTransaction([agent.keyPair, verifier.keyPair], compileTransaction(compile(svm, agent, guardIxs, r, { [table]: owned })));
  const sim = svm.simulateTransaction(tableTx) as { err?: () => unknown; meta: () => { logs: () => string[] } };
  const tableResult = typeof sim.err === 'function'
    ? String([...sim.meta().logs()].reverse().find(l => /failed|error/i.test(l)) ?? sim.err()).slice(0, 120)
    : 'ok';
  const result = send(svm, tx);
  const arrived = result.ok ? amountOf(svm, g.wOut) : null;
  const paid = result.ok ? amount * 4n - amountOf(svm, g.wIn) : null;

  const c = computeOf(result.logs, guardKey.address);
  const b = computeOf(baseResult.logs);
  const good = result.ok && arrived !== null && arrived >= minOut && paid !== null && paid <= amount + feeOf(amount);
  return {
    pair: `${inName} → ${outName}`, amount: `${ui} ${inName}`, labels, ok: good || (!baseResult.ok && !result.ok),
    baseline: baseResult.ok ? `ok, ${baseOut}` : baseResult.error,
    result: result.ok ? (good ? 'ok' : `promise broken: paid ${paid}, arrived ${arrived}`) : result.error,
    bytes: wireBytes(tx), tableBytes: wireBytes(tableTx), tableResult, baseBytes: wireBytes(baseTx), cu: c.total || null, baseCu: b.total || null, guardCu: c.own || null,
    logs: result.logs, baseLogs: baseResult.logs, minOut, arrived, oracle: pyth ? 'Pyth, 3% and loss budget' : 'none (no sponsored feed found)',
  };
}

const rows: Case[] = [];
const failed: string[] = [];
for (const spec of PAIRS) {
  try {
    const c = await runCase(spec);
    rows.push(c);
    const tag = !c.ok ? 'FAIL' : c.result === 'ok' ? 'OK  ' : 'BOTH';
    console.log(`${tag} ${c.pair} ${c.amount} [${c.labels}] ${c.bytes} B (with the owner's table ${c.tableBytes}: ${c.tableResult}; alone ${c.baseBytes}), CU ${c.cu} (Guard ${c.guardCu}, alone ${c.baseCu}): ${c.result}`);
    if (!c.ok) {
      failed.push(spec);
      // Where the route works alone and not inside the Guard, both runs' logs say where they part.
      console.log(`  baseline: ${c.baseline}, minimum ${c.minOut}\n  --- the Guard's logs\n  ${c.logs.slice(-40).join('\n  ')}\n  --- alone\n  ${c.baseLogs.slice(-40).join('\n  ')}`);
    }
  } catch (e) {
    console.log(`SKIP ${spec}: ${(e as Error).message.split('\n')[0]}`);
    failed.push(`${spec} (${(e as Error).message.split('\n')[0].slice(0, 120)})`);
  }
}

const cell = (v: unknown) => (v === null || v === undefined ? '—' : String(v));
const summary = [
  `# Orientim Guard with real Jupiter routes (maxAccounts ${MAX_ACCOUNTS})`,
  '',
  `${rows.filter(r => r.ok && r.result === 'ok').length} of ${PAIRS.length} cases swapped through the Guard and kept the promise; ${rows.filter(r => r.ok && r.result !== 'ok').length} failed the same way alone too (the route went stale in the copy). Too large for ${PACKET} bytes: ${rows.filter(r => (r.bytes ?? 0) > PACKET).length} as is, ${rows.filter(r => (r.tableBytes ?? 0) > PACKET).length} with the owner's lookup table.`,
  '',
  '| Pair | Amount | Route | Bytes (alone) | With the owner\'s table | CU total (alone) | CU Guard | Oracle | Result |',
  '| --- | --- | --- | --- | --- | --- | --- | --- | --- |',
  ...rows.map(r => `| ${r.pair} | ${r.amount} | ${r.labels} | ${cell(r.bytes)}${(r.bytes ?? 0) > PACKET ? ' (too large)' : ''} (${cell(r.baseBytes)}) | ${cell(r.tableBytes)}${(r.tableBytes ?? 0) > PACKET ? ' (too large)' : ''}, ${r.tableResult.replace(/\|/g, '/')} | ${cell(r.cu)} (${cell(r.baseCu)}) | ${cell(r.guardCu)} | ${r.oracle} | ${r.result.replace(/\|/g, '/')} |`),
  '',
  failed.length ? `Did not pass: ${failed.join('; ')}` : 'Every case passed.',
  '',
].join('\n');
mkdirSync('tests/guard/results', { recursive: true });
writeFileSync(`tests/guard/results/${OUT_FILE}`, summary);
console.log(summary);
process.exit(failed.length ? 1 : 0);
