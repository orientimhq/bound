/**
 * The upstream canary. Jupiter, Pump.fun and the token programs are upgraded
 * while Orientim runs: on 23 September 2026 Pump's curve program had been redeployed hours before and
 * Jupiter's two days before (each run prints the dates again). Orientim's verifier refuses a Jupiter
 * instruction it cannot read, so a format change stops every swap; this finds it before a user does.
 *
 * It builds protected swaps on mainnet state exactly as the page does, each with the fee where it
 * belongs, and executes each final transaction in simulation:
 *
 *   USDC → SOL        the fee in SOL, from the output
 *   SOL → USDC        the fee in SOL, from the input
 *   USDT → USDC       the fee in USDC, from the output account
 *   USDC → SOL (v1)   the same as the first, as a v1 transaction
 *   USDC → BONK       the fee in SOL from the wallet, at the swap's value (a treasury with no account
 *                     for either token: a validator's identity wallet stands in)
 *   a Pump.fun buy    on a bonding curve, and on PumpSwap: the market's account closed and refunded
 *
 * Nothing is signed or sent. A public wallet holding SOL, USDC and USDT stands in for the treasury,
 * so that every fee path runs (CANARY_TREASURY overrides it).
 *
 *   node tools/canary.ts          RPC_URL and JUPITER_API_KEY are used when set
 *   node tools/canary.ts --record-deploys   after a review, record the programs' deploys as reviewed
 *   node tools/canary.ts --swaps-only       the review itself: the swaps, with the deploys only said
 *
 * Exit 1 when a swap cannot be built or executed for a reason that is not load: Jupiter's format
 * changed, a rule no longer holds, a major pair has no route, the fee is not where it belongs, or
 * the final transaction fails. A busy or silent service, or a price that keeps moving, warns; a run
 * with any warning exits 2, incomplete: a market Orientim promises (a Pump.fun curve, PumpSwap, a fee
 * path) that could not be proven this run is not a pass, even when every other swap went through.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { address, getAddressDecoder, getBase64EncodedWireTransaction } from '@solana/kit';
import type { Address } from '@solana/kit';
import { ataOf, JUPITER_PROGRAM, SYSTEM_PROGRAM, WSOL_MINT } from '@orientim/core';
import type { FeeSide, TxVersion } from '@orientim/core';
import { createEphemeral, createRetryingRpc, fetchAccounts, fetchMints, httpStatusOf } from '@orientim/solana';
import { OrientimError, createJupiterClient, DEFAULT_SETTINGS, JupiterError, prepareProtectedSwap } from '@orientim/jupiter';
import type { PreparedSwap } from '@orientim/jupiter';

const RPC_URL = process.env.RPC_URL || 'https://api.mainnet-beta.solana.com';
const rpc = createRetryingRpc(RPC_URL, 8);
const jupiter = createJupiterClient({
  buildUrl: 'https://api.jup.ag/swap/v2/build',
  tokensUrl: 'https://api.jup.ag/tokens/v2/search',
  labelsUrl: 'https://api.jup.ag/swap/v2/program-id-to-label',
  apiKey: process.env.JUPITER_API_KEY || undefined,
  minIntervalMs: process.env.JUPITER_API_KEY ? 300 : 2_100,
});
// A public exchange wallet with SOL and USDC and USDT accounts stands in for the treasury.
const TREASURY = address(process.env.CANARY_TREASURY || '5tzFkiKscXHK5ZXCGbXZxdw7gTjjD1mBwuoFbhUvuAi9');
const settings = { ...DEFAULT_SETTINGS, treasury: TREASURY, jupiterProgram: JUPITER_PROGRAM };
// A public exchange wallet holding SOL, USDC and USDT: simulation only, nothing is signed.
const OWNER = address('GJRs4FwHtemZ5ZE9x3FNvJ8TMwitKTh21yxdRPqn7npE');
const USDC = address('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');
const USDT = address('Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB');
const BONK = address('DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263');
const PROGRAMS: [string, Address][] = [
  ['Jupiter', JUPITER_PROGRAM],
  ['Pump.fun curve', address('6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P')],
  ['PumpSwap', address('pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA')],
  ['Token-2022', address('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb')],
];

type Verdict = 'ok' | 'warn' | 'fail';
const verdicts: Verdict[] = [];
const report = (v: Verdict, name: string, detail: string) => {
  verdicts.push(v);
  console.log(`${v === 'ok' ? 'OK  ' : v === 'warn' ? 'WARN' : 'FAIL'} ${name} — ${detail}`);
  // On GitHub, each failure and warning is also an annotation of the run, readable without its log.
  if (process.env.GITHUB_ACTIONS && v !== 'ok') {
    const one = (t: string) => t.replace(/[\r\n%]/g, ' ');
    console.log(`::${v === 'fail' ? 'error' : 'warning'} title=${one(name).replace(/[:,]/g, ' ')}::${one(detail)}`);
  }
};

/** Load and moving prices say nothing about Orientim or Jupiter's format; everything else does. */
const LOAD = new Set(['busy', 'unavailable', 'price-moved', 'costs-more']);
const isLoad = (e: unknown) => {
  if (e instanceof OrientimError) return LOAD.has(e.code);
  const status = e instanceof JupiterError ? e.status : httpStatusOf(e);
  return status === 429 || (status !== null && status !== undefined && status >= 500);
};

async function executes(prepared: PreparedSwap): Promise<{ ok: boolean; error: string }> {
  const { value } = await rpc.simulateTransaction(getBase64EncodedWireTransaction(prepared.transaction), {
    encoding: 'base64', sigVerify: false, replaceRecentBlockhash: true, commitment: 'confirmed',
  }).send();
  return { ok: value.err === null, error: JSON.stringify(value.err, (_, x) => (typeof x === 'bigint' ? x.toString() : x)) };
}

/**
 * Builds and executes one swap, once more if the price moved in between. `feeSide`: where the fee
 * must be taken, so a fee path that stopped working fails the run rather than going fee-free.
 */
/** The listed tokens whose every route failed in simulation, this run. */
const unbuildable: string[] = [];

async function swap(
  name: string, inputMint: Address, outputMint: Address, amountIn: bigint,
  opts: { want?: string; feeSide?: FeeSide; version?: TxVersion; treasury?: Address } = {},
): Promise<'done' | 'elsewhere' | 'failed' | 'unbuildable'> {
  const { want } = opts;
  const mints = await fetchMints(rpc, [inputMint, outputMint]);
  for (let round = 0; round < 2; round++) {
    let prepared: PreparedSwap;
    try {
      prepared = await prepareProtectedSwap({ rpc, jupiter, settings: { ...settings, treasury: opts.treasury ?? TREASURY } }, {
        owner: OWNER, ephemeral: await createEphemeral(), inputMint, outputMint, amountIn,
        inputDecimals: mints.get(inputMint)!.decimals, outputDecimals: mints.get(outputMint)!.decimals,
        version: opts.version ?? 0, acceptedCostBps: 5_000n,
      });
    } catch (e) {
      const code = e instanceof OrientimError ? e.code : 'error';
      if (want && code === 'no-route') return 'elsewhere';
      // A token picked from a list (the newest on a curve, say) whose every route fails in simulation,
      // through other markets too: the token's, said by the caller unless every token tried fails so.
      if (want && code === 'simulation-failed') {
        unbuildable.push(`${name}: ${(e as Error).message.slice(0, 160)}`);
        return 'unbuildable';
      }
      if (isLoad(e) && round === 0) continue;
      report(isLoad(e) ? 'warn' : 'fail', name, `not built: ${code}: ${(e as Error).message.slice(0, 200)}`);
      return 'failed';
    }
    const route = prepared.quote.route.join(' > ');
    if (want && !prepared.quote.route.includes(want)) return 'elsewhere';
    if (opts.feeSide && prepared.policy.feeSide !== opts.feeSide) {
      report('fail', name, `the fee is taken ${prepared.policy.feeSide ?? 'nowhere'}, not from the ${opts.feeSide}`);
      return 'failed';
    }
    const run = await executes(prepared);
    if (!run.ok && /6001|"Custom":1\b/.test(run.error) && round === 0) continue; // the price moved: once more
    const refund = prepared.policy.routeRefund > 0n ? `, the market's account closed and ${prepared.policy.routeRefund} lamports returned` : '';
    // A Pump market's account holding only its rent is closed and refunded; a buy without that refund
    // is worth a look (a cashback coin, or no room for the close), though it still executed.
    if (run.ok && (want === 'Pump.fun' || want === 'Pump.fun Amm') && prepared.policy.routeRefund === 0n) {
      report('warn', name, "executed, but the market's account under the one-time key was not closed and refunded");
    }
    const side = prepared.policy.feeSide;
    const fee = side ? `, fee ${prepared.policy.fee} ${side === 'sol' ? 'lamports in SOL, from the wallet' : `from the ${side}`}` : '';
    report(run.ok ? 'ok' : 'fail', name, run.ok ? `built, verified and executed: ${route}${fee}${refund}` : `the final transaction fails: ${run.error}`);
    return run.ok ? 'done' : 'failed';
  }
  report('warn', name, 'the price kept moving past the tolerance');
  return 'failed';
}

// When each program was last deployed: a recent date is where to look first if something fails.
const [slot, perf] = await Promise.all([
  rpc.getSlot({ commitment: 'confirmed' }).send(),
  rpc.getRecentPerformanceSamples(10).send(),
]);
const msPerSlot = (1000 * perf.reduce((s, p) => s + p.samplePeriodSecs, 0)) / Math.max(1, perf.reduce((s, p) => s + Number(p.numSlots), 0));
console.log(`Slots: ${msPerSlot.toFixed(0)} ms; a transaction lives 150 blocks, about ${Math.round((150 * msPerSlot) / 1000)} s.`);
// A program Orientim depends on, deployed again since its slot was last recorded, fails the run:
// Orientim treats Jupiter as untrusted, so its safety does not rest on the program's behaviour, but
// whether swaps still work and still pay their fee does. A maintainer re-runs the checks, then records
// the new slot: node tools/canary.ts --record-deploys.
const KNOWN = 'tools/known-deploys.json';
const known: Record<string, string> = existsSync(KNOWN) ? JSON.parse(readFileSync(KNOWN, 'utf8')) : {};
const seen: Record<string, string> = {};
for (const [name, program] of PROGRAMS) {
  const account = await rpc.getAccountInfo(program, { encoding: 'base64' }).send();
  const data = Buffer.from(account.value!.data[0], 'base64');
  if (data.readUInt32LE(0) !== 2) continue;
  const programData = getAddressDecoder().decode(data.subarray(4, 36));
  const header = await rpc.getAccountInfo(programData, { encoding: 'base64', dataSlice: { offset: 4, length: 8 } }).send();
  const deployed = Buffer.from(header.value!.data[0], 'base64').readBigUInt64LE(0);
  seen[name] = deployed.toString();
  console.log(`${name}: last deployed ${((Number(slot - deployed) * msPerSlot) / 86_400_000).toFixed(1)} days ago (slot ${deployed})`);
  // Recording them, or reviewing them by the swaps: the deploys are said, not judged.
  if (process.argv.includes('--record-deploys') || process.argv.includes('--swaps-only')) continue;
  if (known[name] === undefined) report('warn', `${name} program`, `no reviewed deploy on record (${KNOWN})`);
  else if (deployed !== BigInt(known[name])) {
    report('fail', `${name} program`, `deployed again at slot ${deployed}, after the one reviewed (${known[name]}): re-run the canary's swaps and tests/integration/jupiter-floor.ts, then record it with --record-deploys`);
  }
}
if (process.argv.includes('--record-deploys')) {
  writeFileSync(KNOWN, `${JSON.stringify(seen, null, 2)}
`);
  console.log(`Recorded in ${KNOWN}.`);
  process.exit(0);
}
console.log('');

await swap('USDC → SOL', USDC, WSOL_MINT, 10_000_000n, { feeSide: 'output' });
await swap('SOL → USDC', WSOL_MINT, USDC, 50_000_000n, { feeSide: 'input' });
await swap('USDT → USDC', USDT, USDC, 10_000_000n, { feeSide: 'output' });
await swap('USDC → SOL (v1)', USDC, WSOL_MINT, 10_000_000n, { feeSide: 'output', version: 1 });

/**
 * A wallet that holds SOL and no account for any of `mints`: a validator's identity, which pays its
 * votes in SOL and trades nothing. It stands in for a treasury that can take the fee in no token.
 */
async function walletWithout(mints: Address[]): Promise<Address | null> {
  const { current } = await rpc.getVoteAccounts().send();
  for (const v of current.slice(0, 40)) {
    const id = address(v.nodePubkey);
    const accounts = await Promise.all(mints.map(m => ataOf(id, m)));
    const reads = await fetchAccounts(rpc, [id, ...accounts]);
    if (reads.get(id)?.owner === SYSTEM_PROGRAM && accounts.every(a => !reads.get(a))) return id;
  }
  return null;
}
const solOnly = await walletWithout([USDC, BONK]);
if (solOnly) await swap('USDC → BONK (fee in SOL)', USDC, BONK, 10_000_000n, { feeSide: 'sol', treasury: solOnly });
else report('warn', 'USDC → BONK (fee in SOL)', 'no wallet found to stand in for a treasury without token accounts');

// Pump.fun tokens: the newest still on their bonding curve, the trending ones mostly on PumpSwap.
type Listed = { id: string; symbol: string };
// A list that cannot be read (no key, rate limit, an error body) is a warning with its cause, not a crash.
const list = async (url: string): Promise<Listed[] | string> => {
  try {
    let r = await fetch(url, { headers: process.env.JUPITER_API_KEY ? { 'x-api-key': process.env.JUPITER_API_KEY } : {} });
    // A key shared with other runs (the matrix, say) may be at its limit for a moment: asked again,
    // as long as Jupiter says, up to three times.
    for (let attempt = 0; r.status === 429 && attempt < 3; attempt++) {
      const after = Number(r.headers.get('retry-after'));
      await new Promise(done => setTimeout(done, Number.isFinite(after) && after > 0 && after <= 30 ? after * 1000 : 5_000 * (attempt + 1)));
      r = await fetch(url, { headers: process.env.JUPITER_API_KEY ? { 'x-api-key': process.env.JUPITER_API_KEY } : {} });
    }
    if (!r.ok) return `HTTP ${r.status}${r.status === 401 || r.status === 403 ? ', JUPITER_API_KEY missing or refused' : ''}`;
    const body: unknown = await r.json();
    return Array.isArray(body) ? body.filter((x): x is Listed => typeof x?.id === 'string' && typeof x?.symbol === 'string') : 'the answer is not a list';
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
};
for (const [market, want, url] of [
  ['Pump.fun curve', 'Pump.fun', 'https://api.jup.ag/tokens/v2/recent'],
  ['PumpSwap', 'Pump.fun Amm', 'https://api.jup.ag/tokens/v2/toptrending/1h?limit=100'],
] as const) {
  const listed = await list(url);
  if (typeof listed === 'string') {
    report('warn', market, `the Jupiter token list could not be read (${listed})`);
    continue;
  }
  let outcome: 'done' | 'elsewhere' | 'failed' | 'unbuildable' = 'elsewhere';
  const before = unbuildable.length;
  let tried = 0;
  for (const t of listed.filter(x => x.id.endsWith('pump')).slice(0, 8)) {
    tried++;
    outcome = await swap(`SOL → ${t.symbol} (${market})`, WSOL_MINT, address(t.id), 20_000_000n, { want, feeSide: 'input' });
    if (outcome === 'done' || outcome === 'failed') break;
  }
  const failedInSimulation = unbuildable.slice(before);
  if (outcome !== 'done' && outcome !== 'failed') {
    // One new token with a broken pool says nothing about Orientim; every token tried failing so does.
    if (failedInSimulation.length >= 3 && failedInSimulation.length === tried) {
      report('fail', market, `every token tried failed in simulation (${tried}): ${failedInSimulation[0]}`);
    } else {
      report('warn', market, `no listed token routed through ${market}${failedInSimulation.length ? `; ${failedInSimulation.length} failed in simulation on every route, first ${failedInSimulation[0]}` : ''}`);
    }
  }
}

const ok = verdicts.filter(v => v === 'ok').length;
const failed = verdicts.filter(v => v === 'fail').length;
const warned = verdicts.filter(v => v === 'warn').length;
console.log(`\n${ok} ok, ${warned} warnings, ${failed} failures.`);
if (!failed && !ok) console.log('Nothing could be checked this run (load or silence): that is not a pass.');
else if (!failed && warned) console.log(`Incomplete: ${warned} check(s) above (WARN) could not be proven this run. What Orientim promises and this run did not prove is not a pass; run it again, with CANARY_JUPITER_API_KEY set if Jupiter answered 429.`);
process.exitCode = failed ? 1 : ok && !warned ? 0 : 2;
