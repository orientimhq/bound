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
 * The curve buy uses the route Orientim builds itself (curveRoute.ts), and that route is then compared
 * with Jupiter's on a few new curves, buys and sells, byte for byte but for the buyback recipient.
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
import { address, getAddressDecoder, getBase64EncodedWireTransaction, getProgramDerivedAddress } from '@solana/kit';
import type { Address } from '@solana/kit';
import { ataOf, JUPITER_PROGRAM, SYSTEM_PROGRAM, WSOL_MINT } from '@orientimhq/swap/core';
import { bondingCurveOf } from '@orientim/builder';
import type { FeeSide, TxVersion } from '@orientimhq/swap/core';
import { createEphemeral, createRetryingRpc, fetchAccounts, fetchMints, httpStatusOf } from '@orientimhq/swap/solana';
import { OrientimError, createJupiterClient, DEFAULT_SETTINGS, JupiterError, prepareProtectedSwap, readBuybackRecipients, withLocalCurveRoutes } from '@orientim/jupiter';
import type { BuildParams, BuildResponse, JupiterClient, PreparedSwap } from '@orientim/jupiter';

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
  opts: { want?: string; feeSide?: FeeSide; version?: TxVersion; treasury?: Address; client?: JupiterClient } = {},
): Promise<'done' | 'elsewhere' | 'failed' | 'unbuildable'> {
  const { want } = opts;
  const mints = await fetchMints(rpc, [inputMint, outputMint]);
  for (let round = 0; round < 2; round++) {
    let prepared: PreparedSwap;
    try {
      prepared = await prepareProtectedSwap({ rpc, jupiter: opts.client ?? jupiter, settings: { ...settings, treasury: opts.treasury ?? TREASURY } }, {
        owner: OWNER, ephemeral: await createEphemeral(), inputMint, outputMint, amountIn,
        inputDecimals: mints.get(inputMint)!.decimals, outputDecimals: mints.get(outputMint)!.decimals,
        version: opts.version ?? 0, acceptedCostBps: 5_000n,
      });
    } catch (e) {
      const code = e instanceof OrientimError ? e.code : 'error';
      if (want && code === 'no-route') return 'elsewhere';
      // A picked token Orientim refuses by design (a route through a permanent delegate, say): the
      // refusal is the promise kept, and the market is proven by the next token.
      if (want && code === 'unsupported-token') return 'elsewhere';
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
// A token on its curve is swapped with the route Orientim builds itself where it runs with
// ORIENTIM_LOCAL_CURVE=1 (curveRoute.ts), Jupiter answering for the rest of the swap; the route is
// compared with Jupiter's own further down.
let builtLocally = 0;
const localCurve = withLocalCurveRoutes(jupiter, rpc, {
  onLocal: () => { builtLocally++; },
  onFallback: reason => report('warn', 'Local curve route', `left to Jupiter: ${reason}`),
});
const curveTokens: Listed[] = [];
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
  const onCurve = market === 'Pump.fun curve';
  if (onCurve) curveTokens.push(...listed.filter(x => x.id.endsWith('pump')));
  for (const t of listed.filter(x => x.id.endsWith('pump')).slice(0, 8)) {
    tried++;
    const local = builtLocally;
    outcome = await swap(`SOL → ${t.symbol} (${market})`, WSOL_MINT, address(t.id), 20_000_000n, { want, feeSide: 'input', ...(onCurve ? { client: localCurve } : {}) });
    if (onCurve && outcome === 'done' && builtLocally === local) report('warn', market, `${t.symbol} executed with Jupiter's route: the local curve route was not built`);
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

/**
 * The route Orientim builds on a curve, against Jupiter's for the same swap: equal byte for byte but
 * for the buyback recipient, which each picks among Pump's eight. Jupiter is asked first and the curve
 * read right after, so that both price the same state; a curve that traded in between is asked again.
 */
const LEFT_TO_JUPITER = new Error('left to Jupiter');
const localOnly = withLocalCurveRoutes({ ...jupiter, build: async () => { throw LEFT_TO_JUPITER; } }, rpc, {
  onFallback: reason => report('warn', 'Local curve route', `left to Jupiter: ${reason}`),
});
const masked = (r: BuildResponse) => {
  const ix = structuredClone(r.swapInstruction);
  ix.accounts[24] = { ...ix.accounts[24]!, pubkey: 'buyback' };
  return JSON.stringify({
    inputMint: r.inputMint, outputMint: r.outputMint, inAmount: r.inAmount, outAmount: r.outAmount, otherAmountThreshold: r.otherAmountThreshold,
    routePlan: r.routePlan, setupInstructions: r.setupInstructions, swapInstruction: ix, cleanup: r.cleanupInstruction, other: r.otherInstructions,
    tables: r.addressesByLookupTableAddress,
  });
};
const firstDifference = (a: BuildResponse, b: BuildResponse) => {
  const i = a.swapInstruction.accounts.findIndex((x, k) => k !== 24 && JSON.stringify(x) !== JSON.stringify(b.swapInstruction.accounts[k]));
  if (a.swapInstruction.accounts.length !== b.swapInstruction.accounts.length) return `${a.swapInstruction.accounts.length} accounts, Jupiter ${b.swapInstruction.accounts.length}`;
  if (i >= 0) return `account ${i}: ${a.swapInstruction.accounts[i]!.pubkey}, Jupiter ${b.swapInstruction.accounts[i]!.pubkey}`;
  if (a.swapInstruction.data !== b.swapInstruction.data) return 'instruction data';
  return 'setup, route plan or lookup tables';
};
const pumpGlobal = (await getProgramDerivedAddress({ programAddress: PROGRAMS[1]![1], seeds: [new TextEncoder().encode('global')] }))[0];
const [globalState] = (await fetchAccounts(rpc, [pumpGlobal])).values();
const buyback = readBuybackRecipients(globalState);
async function compareCurveRoute(name: string, params: BuildParams): Promise<'same' | 'differs' | 'moved' | 'left' | 'no-route'> {
  const pumpCurve = await bondingCurveOf(params.inputMint === WSOL_MINT ? params.outputMint : params.inputMint);
  for (let round = 0; round < 3; round++) {
    let theirs: BuildResponse;
    try {
      theirs = await jupiter.build(params);
    } catch (e) {
      if (isLoad(e)) continue;
      return 'no-route';
    }
    let mine: BuildResponse;
    try {
      mine = await localOnly.build({ ...params, pumpCurve });
    } catch (e) {
      if (e === LEFT_TO_JUPITER) return 'left';
      throw e;
    }
    if (masked(mine) === masked(theirs)) {
      const pick = theirs.swapInstruction.accounts[24]?.pubkey;
      if (typeof buyback === 'string' || !buyback.includes(pick as Address)) {
        report('fail', name, `Jupiter pays the buyback share to ${pick}, not one of Pump's recipients (${typeof buyback === 'string' ? buyback : buyback.length})`);
        return 'differs';
      }
      return 'same';
    }
    if (mine.outAmount !== theirs.outAmount) continue; // the curve traded in between
    report('fail', name, `the local curve route differs from Jupiter's: ${firstDifference(mine, theirs)}`);
    return 'differs';
  }
  return 'moved';
}
{
  const owner = OWNER;
  let buys = 0, sells = 0, moved = 0;
  for (const t of curveTokens.slice(0, 12)) {
    if (buys >= 3 && sells >= 2) break;
    const mint = address(t.id);
    const program = (await fetchMints(rpc, [mint])).get(mint)?.program;
    if (!program) continue;
    const taker = (await createEphemeral()).address;
    const buy: BuildParams = {
      inputMint: WSOL_MINT, outputMint: mint, amount: 20_000_000n, taker, slippageBps: DEFAULT_SETTINGS.curveSlippageBps, maxAccounts: 64,
      destinationTokenAccount: await ataOf(owner, mint, program),
    };
    const bought = await compareCurveRoute(`SOL → ${t.symbol} (local curve route)`, buy);
    if (bought === 'differs') break;
    if (bought === 'moved') moved++;
    if (bought !== 'same') continue;
    buys++;
    // A sell of what half the SOL the curve holds buys back: a curve this new may hold only a few
    // lamports, and a sell of more cannot execute.
    const [curve] = (await fetchAccounts(rpc, [await bondingCurveOf(mint)])).values();
    if (!curve || curve.data.length < 40) continue;
    const view = new DataView(curve.data.buffer, curve.data.byteOffset, curve.data.byteLength);
    const [virtualToken, virtualQuote, realQuote] = [view.getBigUint64(8, true), view.getBigUint64(16, true), view.getBigUint64(32, true)];
    const half = (realQuote < 20_000_000n ? realQuote : 20_000_000n) / 2n;
    if (half < 100_000n) continue;
    const sold = await compareCurveRoute(`${t.symbol} → SOL (local curve route)`, {
      inputMint: mint, outputMint: WSOL_MINT, amount: (half * virtualToken) / (virtualQuote - half), taker, slippageBps: DEFAULT_SETTINGS.curveSlippageBps, maxAccounts: 64,
    });
    if (sold === 'differs') break;
    if (sold === 'moved') moved++;
    if (sold === 'same') sells++;
  }
  if (buys && sells) report('ok', 'Local curve route', `Jupiter's own, byte for byte but for the buyback recipient: ${buys} buys, ${sells} sells`);
  else if (verdicts.at(-1) !== 'fail') {
    report('warn', 'Local curve route', `not compared with Jupiter on both sides this run (${buys} buys, ${sells} sells${moved ? `, ${moved} curves kept trading` : ''})`);
  }
}

const ok = verdicts.filter(v => v === 'ok').length;
const failed = verdicts.filter(v => v === 'fail').length;
const warned = verdicts.filter(v => v === 'warn').length;
console.log(`\n${ok} ok, ${warned} warnings, ${failed} failures.`);
if (!failed && !ok) console.log('Nothing could be checked this run (load or silence): that is not a pass.');
else if (!failed && warned) console.log(`Incomplete: ${warned} check(s) above (WARN) could not be proven this run. What Orientim promises and this run did not prove is not a pass; run it again, with CANARY_JUPITER_API_KEY set if Jupiter answered 429.`);
process.exitCode = failed ? 1 : ok && !warned ? 0 : 2;
