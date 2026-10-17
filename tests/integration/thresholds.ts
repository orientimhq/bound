/**
 * T9: what the protection actually costs, measured rather than guessed.
 *
 * Orientim asks the user when a protected route sits more than `askAboveBps` below the unrestricted
 * one, warns harder past `warnAboveBps`, and refuses past `badQuoteBps`. Those three numbers were
 * set by judgement. This walks the same route selection the pipeline walks — the same account
 * levels, the same exclusions, the same "does it fit in one transaction" test — across liquid and
 * thin pairs at growing sizes, and reports the distribution of the gap it finds, plus what each
 * candidate threshold would do to those swaps.
 *
 * Nothing is signed, sent or simulated, so no wallet needs to hold anything.
 *
 *   node tests/integration/thresholds.ts [--sizes 100,1000,10000,100000] [--tokens 12]
 */
import { getTransactionSize } from '@solana/kit';
import type { Address } from '@solana/kit';
import { mkdirSync, writeFileSync } from 'node:fs';
import {
  buildPolicy, compileProtectedSwap, JUPITER_PROGRAM, LEGACY_SIZE_LIMIT, TOKEN_2022_PROGRAM, TOKEN_PROGRAM, withMinOut,
} from '@orientimhq/swap/core';
import type { IntermediateAta } from '@orientimhq/swap/core';
import { createEphemeral, createRetryingRpc, fetchMints } from '@orientimhq/swap/solana';
import {
  compileIfFits, createJupiterClient, DEFAULT_SETTINGS, intermediatesFromSetup, routeFloor, toKitInstruction,
} from '@orientim/jupiter';
import type { BuildResponse } from '@orientim/jupiter';

const arg = (name: string, fallback: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : fallback;
};
const SIZES = arg('sizes', '100,1000,10000,100000').split(',').map(Number);
const TOKEN_COUNT = Number(arg('tokens', '12'));
/** The account levels the pipeline walks, widest first. */
const LEVELS = [64, 56, 48, 40, 32, 24, 16];

const rpc = createRetryingRpc(process.env.RPC_URL ?? 'https://api.mainnet-beta.solana.com', 8);
const jupiter = createJupiterClient({
  buildUrl: 'https://api.jup.ag/swap/v2/build',
  tokensUrl: 'https://api.jup.ag/tokens/v2/search',
  labelsUrl: 'https://api.jup.ag/swap/v2/program-id-to-label',
  apiKey: process.env.JUPITER_API_KEY,
  // Keyless Jupiter allows one request every two seconds; a key allows more.
  minIntervalMs: process.env.JUPITER_API_KEY ? 1100 : 2_100,
});

const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const W = 'GJRs4FwHtemZ5ZE9x3FNvJ8TMwitKTh21yxdRPqn7npE' as Address;
const log = (...a: unknown[]) => console.log(...a);

type Listed = { id: string; symbol: string; decimals: number; tokenProgram: string; usdPrice?: number };
const listed = (await (await fetch('https://api.jup.ag/tokens/v2/toptraded/24h?limit=100')).json()) as Listed[];
// Liquid first, then down the volume list: the thin end is where the cost of protection shows up.
const outputs = listed.filter(t => t.id !== USDC && t.usdPrice && t.usdPrice > 0).slice(0, TOKEN_COUNT);

const decimalsOf = new Map<string, number>();
for (const [m, info] of await fetchMints(rpc, [...new Set([USDC, ...outputs.map(t => t.id)])] as Address[])) {
  decimalsOf.set(m, info.decimals);
}

type Row = { pair: string; usd: number; gapBps: number | null; fits: boolean; note: string };
const rows: Row[] = [];

/** The best route that fits in one protected transaction, and how far below the market it sits. */
async function measure(output: Listed, usd: number): Promise<Row> {
  const pair = `USDC→${output.symbol}`;
  const inDecimals = decimalsOf.get(USDC) ?? 6;
  const outDecimals = decimalsOf.get(output.id) ?? output.decimals;
  const amountIn = BigInt(Math.round(usd * 10 ** inDecimals));
  const E = await createEphemeral();
  const base = await buildPolicy({
    intent: { owner: W, inputMint: USDC as Address, outputMint: output.id as Address, amountIn },
    ephemeral: E.address,
    inputDecimals: inDecimals,
    outputDecimals: outDecimals,
    inputTokenProgram: TOKEN_PROGRAM,
    outputTokenProgram: output.tokenProgram === TOKEN_2022_PROGRAM ? TOKEN_2022_PROGRAM : TOKEN_PROGRAM,
    config: { ...DEFAULT_SETTINGS, treasury: null, jupiterProgram: JUPITER_PROGRAM },
    feeAccountExists: true,
  });
  // Why a quote is missing matters: an upstream rate limit is not the same finding as a pair with
  // no route, and lumping them together would overstate how often Orientim cannot build.
  let lastError = '';
  const ask = (maxAccounts: number, exclude?: readonly string[]) => jupiter.build({
    inputMint: USDC as Address, outputMint: output.id as Address, amount: base.swapAmount, taker: E.address,
    slippageBps: DEFAULT_SETTINGS.slippageBps, maxAccounts, excludeDexes: exclude,
    destinationTokenAccount: base.accounts.wOut ?? undefined,
  }).catch((e: unknown) => {
    lastError = (e as Error).message.slice(0, 60);
    return null;
  });

  const baseline = await ask(LEVELS[0]);
  if (!baseline) return { pair, usd, gapBps: null, fits: false, note: `pa kuotë bazë: ${lastError || 'pa arsye'}` };
  const baselineOut = BigInt(baseline.outAmount);
  if (baselineOut <= 0n) return { pair, usd, gapBps: null, fits: false, note: 'kuota bazë zero' };

  const lifetime = { blockhash: '11111111111111111111111111111111' as never, lastValidBlockHeight: 10_000n };
  const compiles = (r: BuildResponse, intermediates: IntermediateAta[]) => compileProtectedSwap({
    policy: withMinOut(base, routeFloor(r, DEFAULT_SETTINGS.slippageBps)),
    swapInstruction: toKitInstruction(r.swapInstruction),
    intermediates, version: 0, lifetime, computeUnitLimit: 400_000, microLamportsPerComputeUnit: 50_000n,
    lookupTables: (r.addressesByLookupTableAddress ?? undefined) as never,
  });

  let firstGap: number | null = null;
  for (const level of LEVELS) {
    const r = await ask(level, DEFAULT_SETTINGS.excludeDexes);
    if (!r || BigInt(r.inAmount) !== base.swapAmount || BigInt(r.otherAmountThreshold) <= 0n) continue;
    const gap = Number(((baselineOut - BigInt(r.outAmount)) * 10_000n) / baselineOut);
    firstGap ??= gap;
    const intermediates = intermediatesFromSetup(r.setupInstructions, base);
    const compiled = compileIfFits(() => compiles(r, intermediates));
    if (compiled && getTransactionSize(compiled.transaction) <= LEGACY_SIZE_LIMIT) {
      return { pair, usd, gapBps: gap, fits: true, note: `${level} llogari, ${r.routePlan.length} hop` };
    }
  }
  return { pair, usd, gapBps: firstGap, fits: false, note: 'asnjë route nuk nxë në një transaksion' };
}

for (const output of outputs) {
  for (const usd of SIZES) {
    const row = await measure(output, usd);
    rows.push(row);
    const gap = row.gapBps === null ? '—' : `${(row.gapBps / 100).toFixed(2)}%`;
    log(`${row.pair.padEnd(18)} $${String(row.usd).padStart(7)}  ${row.fits ? 'nxë ' : 'NUK NXË'}  vs treg ${gap.padStart(8)}  ${row.note}`);
  }
}

// ---------------------------------------------------------------- the distribution
const measured = rows.filter(r => r.fits && r.gapBps !== null).map(r => r.gapBps!) as number[];
const sorted = [...measured].sort((a, b) => a - b);
const at = (p: number) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * p))] : 0);
const share = (bps: number) => (sorted.length ? (sorted.filter(g => g > bps).length / sorted.length) * 100 : 0);
const pct = (bps: number) => `${(bps / 100).toFixed(2)}%`;

const summary = [
  '',
  `Route që nxinin: ${measured.length} nga ${rows.length}.`,
  `Mediana ${pct(at(0.5))}, p75 ${pct(at(0.75))}, p90 ${pct(at(0.9))}, p95 ${pct(at(0.95))}, p99 ${pct(at(0.99))}, maksimumi ${pct(at(1))}.`,
  '',
  '| Pragu | Çfarë do të ndodhte | Sa nga swap-et e matura |',
  '| --- | --- | --- |',
  ...[50, 100, 200, 500, 1_000, 5_000].map(bps =>
    `| ${pct(bps)} | do të pyetej klienti | ${share(bps).toFixed(1)}% |`),
].join('\n');
log(summary);

mkdirSync('tests/integration/results', { recursive: true });
writeFileSync('tests/integration/results/thresholds.md', [
  '# T9 — sa kushton mbrojtja, e matur',
  '',
  'Sa poshtë tregut të pakufizuar bie route-i më i mirë që nxë në një transaksion të mbrojtur.',
  'Kjo nuk është ndikimi i madhësisë në çmim: ai prek njësoj të dyja anët dhe anulohet.',
  summary,
  '',
  '| Çifti | Shuma | A nxë | Diferenca | Shënim |',
  '| --- | --- | --- | --- | --- |',
  ...rows.map(r => `| ${r.pair} | $${r.usd} | ${r.fits ? 'po' : 'jo'} | ${r.gapBps === null ? '—' : pct(r.gapBps)} | ${r.note} |`),
  '',
].join('\n'));
log(`\nT9 → tests/integration/results/thresholds.md`);
