/**
 * How Orientim's agent API holds up under many agents, on mainnet. Prepare signs and sends nothing,
 * so it is loaded freely; finalize is asked only with send: false, for a wallet whose key the run
 * holds (SIM_WALLET_KEYPAIR, a small test wallet), and nothing is ever sent.
 *
 *   1 baseline     one swap, with and without the agent's own routes: Server-Timing by phase, and
 *                  the RPC and Jupiter calls of one swap, the server's and the agent's
 *   2 load         10, 50, then 200 agents at once (SIM_CAP_LOAD), each with its own API key and
 *                  one of the public wallets: p50 and p95, and every error by code
 *   3 soak         moderate load for SIM_CAP_SOAK_MINUTES (60): memory over time, RPC calls by method,
 *                  and the per-key limit, pushed past on one key (across instances on a deployment)
 *   4 failures     the main RPC answering 503, then hanging, then both RPCs down; Jupiter limited:
 *                  does the backup take over, and is every refusal busy or unavailable, never unclear
 *   5 abuse        many prepares never finalized, from several wallets, on one key and on a key each:
 *                  what each burns of the RPC and Jupiter, and what stops it
 *   6 kill switch  ORIENTIM_DISABLED=1 in the middle of a load: everything in flight ends with a clear
 *                  answer (built, signed, or paused with nothing sent), and nothing new starts
 *
 * Orientim runs in this process by default, configured from the environment as a deployment is
 * (RPC_URL, RPC_URL_FALLBACK, JUPITER_API_KEY): phases 4 and 6 change that configuration, so they
 * run only here, never against a deployment. SIM_API_URL and SIM_API_KEYS aim phases 1, 2, 3 and 5 at a
 * deployment instead, such as a preview: there the limit is seen across its instances.
 *
 *   SIM_CAPACITY_PHASES=1,2,4   the phases to run (none: this file does nothing)
 *   SIM_CAP_USD=5               each swap, in USD of SOL (Orientim's least is about $1)
 *   SIM_OFFLINE=1               the test fakes: checks this file without a network
 *
 * Red when something needs a look: an error that is not one of Orientim's clear answers, a request
 * that never ended, memory that kept growing, a limit that did not hold, or a swap built after the
 * switch was off.
 */
import { expect, it } from 'vitest';
import { address, createKeyPairSignerFromBytes } from '@solana/kit';
import type { KeyPairSigner, Rpc, SolanaRpcApi } from '@solana/kit';
import { ataOf } from '@orientimhq/swap/core';
import { prepareChecked, signAsWallet } from '@orientimhq/swap';
import {
  agentRpc, balanceMoved, buildVerdict, codeOf, counts, esc, injected, JUP, JUPITER_API_KEY, ms, newTally, OFFLINE, offlineWorld, orientim, percentile, publicWallets,
  RPC_URL, runTally, sleep, SOL, solPrice, sum, tallyOf, USDC, writeReport,
} from './common.ts';
import type { Tally, Target } from './common.ts';

const PHASES = (process.env.SIM_CAPACITY_PHASES ?? '').split(',').map(s => s.trim()).filter(Boolean);
const USD = Number(process.env.SIM_CAP_USD ?? 5);
const LOAD = (process.env.SIM_CAP_LOAD ?? '10,50,200').split(',').map(Number).filter(n => n > 0);
const SOAK_MINUTES = Number(process.env.SIM_CAP_SOAK_MINUTES ?? 60);
const SOAK_AGENTS = Number(process.env.SIM_CAP_SOAK_AGENTS ?? 5);
const SOAK_PAUSE_MS = Number(process.env.SIM_CAP_SOAK_PAUSE_MS ?? 10_000);
const PER_MINUTE = Number(process.env.SIM_CAP_PER_MINUTE ?? process.env.ORIENTIM_API_PER_MINUTE ?? 60);
const ABUSE_WALLETS = Number(process.env.SIM_CAP_ABUSE_WALLETS ?? 3);
const ABUSE_PREPARES = Number(process.env.SIM_CAP_ABUSE_PREPARES ?? 25);
const KILL_AGENTS = Number(process.env.SIM_CAP_KILL_AGENTS ?? 20);
/** No request may outlast this: prepare's own deadline is 45 s, finalize's 24 s. */
const HANG_MS = 75_000;
/** Orientim's clear answers under load and failure: anything else needs a look. */
const CLEAR = new Set([
  'rate-limited', 'busy', 'unavailable', 'price-moved', 'paused', 'jupiter-429', 'costs-more', 'no-route', 'expired', 'fee-unavailable', 'bad-request',
  'simulation-failed',
  // The agent's own budget of Jupiter asks, spent on 429s from the shared test key: the skill's clear stop.
  'BudgetSpentError',
  // A public wallet's output balance moved between Orientim's build and the agent's check (the matrix
  // runs such a case again): the borrowed wallet's doing, not an unclear answer (`balanceMoved`).
  'balance-moved',
]);
/**
 * Where swaps must be built (load, and the RPC failures with a backup up), a simulation that failed,
 * a request Orientim called bad or a swap that expired is not a clear answer: under load each is a
 * sign of the server, or of a backup behind the main RPC, not of the market.
 */
const CLEAR_WHEN_BUILDING = new Set([...CLEAR].filter(c => c !== 'simulation-failed' && c !== 'bad-request' && c !== 'expired'));
/** The share of swaps a phase that must build has to build: the load phase, and failover with a backup up. */
const LOAD_SHARE = 0.95;
const FAILOVER_SHARE = 0.8;

type Verdict = 'PASS' | 'LOOK' | 'UNTESTED';
type Finding = { phase: string; verdict: Verdict; detail: string };
type Sample = {
  agent: number; ok: boolean; code: string; ms: number; startedAt: number; endedAt: number;
  finalize?: { ok: boolean; code: string; ms: number };
  tally: Tally;
};

type World = {
  target: Target; rpc: Rpc<SolanaRpcApi>;
  /** The wallets agents use, in turn, and what each swaps. */
  wallets: string[]; swapOf(i: number): { inputMint: string; outputMint: string; amountIn: string };
  /** A wallet whose key this run holds, for finalize with send: false. */
  signer?: KeyPairSigner;
  signerSwap?: { inputMint: string; outputMint: string; amountIn: string };
};

/** One agent's swap: prepare and the full check, and finalize with send: false when it holds the key. */
async function agentSwap(w: World, agent: number, opts: { key?: string; owner?: string; ownRoutes?: boolean; finalize?: boolean; skipCheck?: boolean } = {}): Promise<Sample> {
  const tally = newTally();
  const startedAt = Date.now();
  // The last key is kept apart, for pushing the limit (phase 3).
  const key = opts.key ?? w.target.keys[agent % Math.max(1, w.target.keys.length - 1)];
  const signing = opts.finalize && w.signer;
  const owner = signing ? w.signer!.address : opts.owner ?? w.wallets[agent % w.wallets.length];
  const intent = signing ? w.signerSwap! : w.swapOf(agent);
  // The output balance before and after, read outside the swap's own count of calls: a refusal is
  // a moved balance only when the change was seen.
  const before = await outputBalance(w, owner, intent.outputMint);
  return tallyOf.run(tally, async () => {
    const t = performance.now();
    try {
      const checked = await prepareChecked({
        apiUrl: w.target.apiUrl, apiKey: key, rpc: w.rpc, owner, intent, fetchImpl: w.target.fetchImpl, jupiterApiKey: JUPITER_API_KEY,
        ...(opts.ownRoutes !== undefined ? { ownRoutes: opts.ownRoutes } : {}),
      });
      const sample: Sample = { agent, ok: true, code: 'built', ms: performance.now() - t, startedAt, endedAt: Date.now(), tally };
      if (signing) sample.finalize = await finalizeUnsent(w, key, checked.prepared.ticket, await signAsWallet(w.signer!, checked.prepared.transaction));
      sample.endedAt = Date.now();
      return sample;
    } catch (e) {
      const message = (e as Error)?.message ?? '';
      const elapsed = performance.now() - t;
      let code = codeOf(e);
      if (before !== null && message.startsWith('Not signing: R2:')) {
        const after = await tallyOf.exit(() => outputBalance(w, owner, intent.outputMint));
        if (after !== null && balanceMoved(message, after - before)) code = 'balance-moved';
      }
      return { agent, ok: false, code, ms: elapsed, startedAt, endedAt: Date.now(), tally };
    }
  });
}

/** Each mint's token program, read once. */
const mintPrograms = new Map<string, Promise<string>>();

/** `owner`'s balance of `mint` in its associated account (0 without one), or null when SOL or unread. */
async function outputBalance(w: World, owner: string, mint: string): Promise<bigint | null> {
  if (mint === SOL) return null;
  try {
    let program = mintPrograms.get(mint);
    if (!program) {
      program = w.rpc.getAccountInfo(address(mint), { encoding: 'base64' }).send().then(r => {
        if (!r.value) throw new Error('no such mint');
        return String(r.value.owner);
      });
      mintPrograms.set(mint, program);
      program.catch(() => mintPrograms.delete(mint));
    }
    const account = await ataOf(address(owner), address(mint), address(await program));
    const { value } = await w.rpc.getAccountInfo(account, { encoding: 'jsonParsed', commitment: 'confirmed' }).send();
    if (!value) return 0n;
    const amount = (value.data as { parsed?: { info?: { tokenAmount?: { amount?: string } } } }).parsed?.info?.tokenAmount?.amount;
    return typeof amount === 'string' && /^\d+$/.test(amount) ? BigInt(amount) : null;
  } catch {
    return null;
  }
}

/** finalize with send: false: Orientim signs as E and sends nothing. */
async function finalizeUnsent(w: World, key: string, ticket: string, signedTransaction: string): Promise<{ ok: boolean; code: string; ms: number }> {
  const t = performance.now();
  try {
    const res = await w.target.fetchImpl(`${w.target.apiUrl}/api/v1/finalize`, {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
      body: JSON.stringify({ ticket, signedTransaction, send: false }),
    });
    const body = await res.json() as { status?: string; error?: { code?: string } };
    return { ok: res.ok && body.status === 'signed', code: body.error?.code ?? body.status ?? String(res.status), ms: performance.now() - t };
  } catch (e) {
    return { ok: false, code: codeOf(e), ms: performance.now() - t };
  }
}

const unclear = (samples: Sample[], clear: ReadonlySet<string> = CLEAR) => samples.filter(s => !s.ok && !clear.has(s.code)).map(s => s.code);
const byCode = (samples: Sample[]) => counts(samples.reduce<Record<string, number>>((m, s) => ({ ...m, [s.code]: (m[s.code] ?? 0) + 1 }), {}));
const latency = (samples: Sample[]) => {
  const ok = samples.filter(s => s.ok).map(s => s.ms);
  return `p50 ${ms(percentile(ok, 50))}, p95 ${ms(percentile(ok, 95))}, max ${ms(ok.length ? Math.max(...ok) : NaN)}`;
};
const merge = (samples: Sample[], pick: (t: Tally) => Record<string, number>) => samples.reduce<Record<string, number>>((m, s) => {
  for (const [k, v] of Object.entries(pick(s.tally))) m[k] = (m[k] ?? 0) + v;
  return m;
}, {});

// --- the phases
async function baseline(w: World, say: (f: Finding) => void) {
  for (const ownRoutes of [true, false]) {
    const s = await agentSwap(w, 0, { ownRoutes, finalize: !!w.signer });
    const timing = s.tally.serverTiming ? Object.entries(s.tally.serverTiming).map(([k, v]) => `${k} ${ms(v)}`).join(', ') : 'no Server-Timing';
    say({
      phase: `1 baseline, ${ownRoutes ? "the agent's own routes" : "Orientim's key"}`, verdict: s.ok ? 'PASS' : CLEAR.has(s.code) ? 'UNTESTED' : 'LOOK',
      detail: `${s.code} in ${ms(s.ms)}; server: ${timing}; `
        + `server RPC ${sum(s.tally.serverRpc)} (${counts(s.tally.serverRpc)}); agent RPC ${sum(s.tally.agentRpc)} (${counts(s.tally.agentRpc)}); `
        + `Jupiter: server ${sum(s.tally.serverJupiter)} (${counts(s.tally.serverJupiter)}), agent ${sum(s.tally.agentJupiter)} (${counts(s.tally.agentJupiter)})`
        + `${w.target.local ? '' : ' (a deployment: its own calls are not seen here)'}`
        + `${s.finalize ? `; finalize (send: false) ${s.finalize.code} in ${ms(s.finalize.ms)}` : '; finalize not asked (no SIM_WALLET_KEYPAIR)'}`,
    });
    await sleep(OFFLINE ? 0 : 5_000);
  }
}

async function load(w: World, say: (f: Finding) => void) {
  for (const n of LOAD) {
    const started = performance.now();
    const samples = await Promise.all(Array.from({ length: n }, (_, i) => agentSwap(w, i)));
    const wall = performance.now() - started;
    const bad = unclear(samples, CLEAR_WHEN_BUILDING);
    const built = samples.filter(s => s.ok).length;
    const timings = samples.map(s => s.tally.serverTiming?.prepare).filter((x): x is number => Number.isFinite(x));
    say({
      phase: `2 load, ${n} agents`, verdict: buildVerdict(built, n, bad.length, LOAD_SHARE),
      detail: `${built}/${n} built in ${ms(wall)}${built < Math.ceil(LOAD_SHARE * n) ? ` (fewer than ${LOAD_SHARE * 100}%)` : ''}; agent's whole prepare ${latency(samples)}; server's prepare p50 ${ms(percentile(timings, 50))}, p95 ${ms(percentile(timings, 95))}; `
        + `answers: ${byCode(samples)}; 429s seen: ${counts(merge(samples, t => t.limited))}${bad.length ? `; UNCLEAR: ${[...new Set(bad)].join(', ')}` : ''}`
        + `; ${new Set(samples.map(s => s.agent % w.wallets.length)).size} wallets, ${Math.min(n, w.target.keys.length)} keys`,
    });
    await sleep(OFFLINE ? 0 : 30_000);
  }
}

/** Pushes one key past the limit with requests that build nothing: how many got in within a minute. */
async function limitHolds(w: World, key: string): Promise<{ admitted: number; limited: number; asked: number }> {
  const asked = PER_MINUTE * 2;
  const answers = await Promise.all(Array.from({ length: asked }, async () => {
    const res = await w.target.fetchImpl(`${w.target.apiUrl}/api/v1/prepare`, {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` }, body: '{}',
    }).catch(() => null);
    return res?.status ?? 0;
  }));
  return { admitted: answers.filter(s => s !== 429 && s !== 0).length, limited: answers.filter(s => s === 429).length, asked };
}

async function soak(w: World, say: (f: Finding) => void) {
  const end = Date.now() + SOAK_MINUTES * 60_000;
  const memory: { at: number; heapMb: number; rssMb: number; rpc: number; jupiter: number }[] = [];
  const gc = (globalThis as { gc?: () => void }).gc;
  const sample = () => {
    gc?.();
    const m = process.memoryUsage();
    memory.push({ at: Date.now(), heapMb: m.heapUsed / 2 ** 20, rssMb: m.rss / 2 ** 20, rpc: sum(runTally.serverRpc) + sum(runTally.agentRpc), jupiter: sum(runTally.serverJupiter) + sum(runTally.agentJupiter) });
  };
  sample();
  const timer = setInterval(sample, OFFLINE ? 50 : 60_000);
  const before = { server: { ...runTally.serverRpc }, jupiter: sum(runTally.serverJupiter) + sum(runTally.agentJupiter) };
  const samples: Sample[] = [];
  await Promise.all(Array.from({ length: SOAK_AGENTS }, async (_, a) => {
    for (let k = 0; Date.now() < end; k++) {
      samples.push(await agentSwap(w, a + k * SOAK_AGENTS));
      await sleep(SOAK_PAUSE_MS);
    }
  }));
  clearInterval(timer);
  sample();
  const rpcDelta = Object.fromEntries(Object.entries(runTally.serverRpc).map(([k, v]) => [k, v - (before.server[k] ?? 0)]).filter(([, v]) => (v as number) > 0));
  const quarter = Math.max(1, Math.floor(memory.length / 4));
  const early = Math.max(...memory.slice(0, quarter).map(m => m.heapMb));
  const late = Math.min(...memory.slice(-quarter).map(m => m.heapMb));
  const grew = w.target.local && late > early * 1.5 && late - early > 50;
  say({
    phase: `3 soak, ${SOAK_AGENTS} agents for ${SOAK_MINUTES} min`, verdict: unclear(samples).length || grew ? 'LOOK' : samples.some(s => s.ok) ? 'PASS' : 'UNTESTED',
    detail: `${samples.filter(s => s.ok).length}/${samples.length} built, ${latency(samples)}; answers: ${byCode(samples)}; `
      + `${w.target.local ? `heap after GC${gc ? '' : ' (no --expose-gc: without a forced GC)'} ${Math.round(memory[0].heapMb)} → ${Math.round(memory[memory.length - 1].heapMb)} MB (first quarter's highest ${Math.round(early)}, last quarter's lowest ${Math.round(late)})${grew ? ': KEPT GROWING' : ''}, rss ${Math.round(memory[memory.length - 1].rssMb)} MB; ` : ''}`
      + `server RPC calls ${sum(rpcDelta)} (${counts(rpcDelta)}), ${samples.length ? (sum(rpcDelta) / samples.length).toFixed(1) : '-'} a swap; Jupiter calls ${sum(runTally.serverJupiter) + sum(runTally.agentJupiter) - before.jupiter}`,
  });
  // The per-key limit, on a key of its own: once here, across the instances of a deployment there.
  const key = w.target.keys[w.target.keys.length - 1];
  const l = await limitHolds(w, key);
  const holds = l.admitted <= PER_MINUTE * (w.target.local ? 1 : 1.5);
  say({
    phase: '3 soak, the per-key limit', verdict: holds ? 'PASS' : 'LOOK',
    detail: `${l.asked} requests at once on one key, the limit ${PER_MINUTE} a minute: ${l.admitted} let in, ${l.limited} refused 429${w.target.local ? ' (one instance)' : holds ? '' : ': the limit is per instance, and this deployment ran several (the platform\'s firewall must hold it)'}`,
  });
  writeReport('capacity-memory', `| minute | heap MB | rss MB | RPC calls | Jupiter calls |\n|---|---|---|---|---|\n${memory.map(m => `| ${((m.at - memory[0].at) / 60_000).toFixed(1)} | ${Math.round(m.heapMb)} | ${Math.round(m.rssMb)} | ${m.rpc} | ${m.jupiter} |`).join('\n')}\n`, memory);
}

async function failures(w: World, say: (f: Finding) => void) {
  if (!w.target.local || OFFLINE) {
    return say({ phase: '4 failures', verdict: 'UNTESTED', detail: OFFLINE ? 'the fakes have no RPC to cut' : 'only against Orientim in this process: a deployment\'s RPC is not changed from here' });
  }
  const real = { url: process.env.RPC_URL, fallback: process.env.RPC_URL_FALLBACK };
  const backup = process.env.SIM_RPC_FALLBACK_URL || RPC_URL;
  const MAIN = 'https://main-rpc.sim.invalid/';
  const hang = (init?: RequestInit) => new Promise<Response>((_, reject) => {
    const signal = init?.signal;
    if (signal) signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  });
  const run = async (label: string, setup: () => void, expectBuilt: boolean, n = 5) => {
    setup();
    const samples = await Promise.all(Array.from({ length: n }, (_, i) => agentSwap(w, i)));
    const bad = unclear(samples, CLEAR_WHEN_BUILDING);
    const built = samples.filter(s => s.ok).length;
    const verdict: Verdict = expectBuilt ? buildVerdict(built, n, bad.length, FAILOVER_SHARE) : bad.length ? 'LOOK' : 'PASS';
    const few = expectBuilt && built < Math.ceil(FAILOVER_SHARE * n);
    say({
      phase: `4 failures, ${label}`, verdict,
      detail: `${built}/${n} built, ${latency(samples)}; answers: ${byCode(samples)}${bad.length ? `; UNCLEAR: ${[...new Set(bad)].join(', ')}` : ''}${few ? `; fewer than ${FAILOVER_SHARE * 100}% built: the backup did not carry the swaps within their deadline` : ''}`,
    });
    injected.rpc = undefined;
    injected.jupiter = undefined;
    await sleep(10_000);
  };
  try {
    await run('main RPC answers 503, backup up', () => {
      Object.assign(process.env, { RPC_URL: MAIN, RPC_URL_FALLBACK: backup });
      injected.rpc = url => (url.startsWith(MAIN) ? new Response('down', { status: 503 }) : null);
    }, true);
    await run('main RPC hangs, backup up', () => {
      Object.assign(process.env, { RPC_URL: MAIN, RPC_URL_FALLBACK: backup });
      injected.rpc = (url, init) => (url.startsWith(MAIN) ? hang(init) : null);
    }, true, 3);
    await run('both RPCs down', () => {
      Object.assign(process.env, { RPC_URL: MAIN, RPC_URL_FALLBACK: 'https://backup-rpc.sim.invalid/' });
      injected.rpc = url => (url.includes('rpc.sim.invalid') ? new Response('down', { status: 503 }) : null);
    }, false);
    Object.assign(process.env, { RPC_URL: real.url ?? RPC_URL });
    if (real.fallback === undefined) delete process.env.RPC_URL_FALLBACK;
    else process.env.RPC_URL_FALLBACK = real.fallback;
    let n = 0;
    await run("Jupiter refuses two requests in three (429), Orientim's and the agent's", () => {
      injected.jupiter = () => (n++ % 3 !== 0 ? new Response('{"error":"Rate limit exceeded"}', { status: 429 }) : null);
    }, false);
    await run('Jupiter refuses every request (429)', () => {
      injected.jupiter = () => new Response('{"error":"Rate limit exceeded"}', { status: 429 });
    }, false, 3);
  } finally {
    injected.rpc = undefined;
    injected.jupiter = undefined;
    process.env.RPC_URL = real.url ?? RPC_URL;
    if (real.fallback === undefined) delete process.env.RPC_URL_FALLBACK;
    else process.env.RPC_URL_FALLBACK = real.fallback;
  }
}

async function abuse(w: World, say: (f: Finding) => void) {
  const wallets = w.wallets.slice(0, ABUSE_WALLETS);
  for (const [label, keyOf] of [
    ['one key', () => w.target.keys[0]],
    ['a key per wallet', (i: number) => w.target.keys[(i + 1) % w.target.keys.length]],
  ] as const) {
    const started = Date.now();
    const samples = (await Promise.all(wallets.map(async (owner, i) => {
      const out: Sample[] = [];
      // Five at a time from each wallet, none finalized.
      for (let k = 0; k < ABUSE_PREPARES; k += 5) {
        out.push(...await Promise.all(Array.from({ length: Math.min(5, ABUSE_PREPARES - k) }, (_, j) => agentSwap(w, i * 1000 + k + j, { key: keyOf(i), owner }))));
      }
      return out;
    }))).flat();
    const built = samples.filter(s => s.ok);
    const rpc = merge(samples, t => t.serverRpc);
    const jup = merge(samples, t => t.serverJupiter);
    const agentJup = merge(samples, t => t.agentJupiter);
    const minutes = Math.max(1, (Date.now() - started) / 60_000);
    const keys = label === 'one key' ? 1 : wallets.length;
    const stopped = samples.some(s => s.code === 'rate-limited');
    const overLimit = built.length > PER_MINUTE * keys * Math.ceil(minutes) * (w.target.local ? 1 : 1.5);
    say({
      phase: `5 abuse, ${wallets.length} wallets, ${label}`, verdict: unclear(samples).length || overLimit ? 'LOOK' : 'PASS',
      detail: `${samples.length} prepares never finalized in ${minutes.toFixed(1)} min: ${built.length} built; answers ${byCode(samples)}; `
        + `${stopped ? `the per-key limit stopped ${samples.filter(s => s.code === 'rate-limited').length}` : 'nothing stopped them'}${overLimit ? ' and MORE got in than the limit allows' : ''}; `
        + `burnt: server RPC ${sum(rpc)} (${built.length ? (sum(rpc) / built.length).toFixed(1) : '-'} a built swap; ${counts(rpc)}), `
        + `Orientim's Jupiter key ${sum(jup)}, the agent's own ${sum(agentJup)}${w.target.local ? '' : ' (a deployment: its own calls are not seen here)'}`,
    });
    await sleep(OFFLINE ? 0 : 61_000);
  }
}

async function killSwitch(w: World, say: (f: Finding) => void) {
  if (!w.target.local) return say({ phase: '6 kill switch', verdict: 'UNTESTED', detail: 'only against Orientim in this process: a deployment reads ORIENTIM_DISABLED when it starts' });
  const was = process.env.ORIENTIM_DISABLED;
  const runFor = OFFLINE ? 400 : 60_000;
  const flipAt = Date.now() + runFor / 3;
  const end = Date.now() + runFor;
  const samples: Sample[] = [];
  const flip = setTimeout(() => { process.env.ORIENTIM_DISABLED = '1'; }, flipAt - Date.now());
  try {
    await Promise.all(Array.from({ length: KILL_AGENTS }, async (_, a) => {
      for (let k = 0; Date.now() < end; k++) {
        // A quarter of the agents sign and finalize (send: false) with the run's own wallet.
        samples.push(await agentSwap(w, a + k * KILL_AGENTS, { finalize: a % 4 === 0 && !!w.signer }));
        await sleep(OFFLINE ? 5 : 1_000);
      }
    }));
  } finally {
    clearTimeout(flip);
    if (was === undefined) delete process.env.ORIENTIM_DISABLED;
    else process.env.ORIENTIM_DISABLED = was;
  }
  const before = samples.filter(s => s.endedAt < flipAt);
  const inFlight = samples.filter(s => s.startedAt < flipAt && s.endedAt >= flipAt);
  const after = samples.filter(s => s.startedAt >= flipAt);
  const hung = samples.filter(s => s.endedAt - s.startedAt > HANG_MS);
  const builtAfter = after.filter(s => s.ok);
  const finals = inFlight.filter(s => s.finalize);
  const finalsClear = finals.every(s => s.finalize!.ok || s.finalize!.code === 'paused');
  const back = await agentSwap(w, 0);
  const verdict: Verdict = hung.length || builtAfter.length || unclear(inFlight).length || !finalsClear ? 'LOOK' : 'PASS';
  say({
    phase: `6 kill switch, ${KILL_AGENTS} agents`, verdict,
    detail: `before: ${before.length} (${byCode(before)}); in flight at the switch: ${inFlight.length} (${byCode(inFlight)}${finals.length ? `; their finalize: ${finals.map(s => s.finalize!.code).join(', ')}` : ''}); `
      + `started after: ${after.length} (${byCode(after)})${builtAfter.length ? `: ${builtAfter.length} BUILT WITH THE SWITCH OFF` : ''}; `
      + `${hung.length ? `${hung.length} NEVER ENDED within ${HANG_MS / 1000} s; ` : 'every request ended; '}`
      + `${w.signer ? '' : 'no SIM_WALLET_KEYPAIR: finalize was not tried; '}switched back on: ${back.code}. Nothing was sent: finalize asks with send: false.`,
  });
}

function report(findings: Finding[], started: number, where: string): string {
  const lines = [
    '# Capacity of the agent API', '',
    `${new Date().toISOString()}, ${Math.round((Date.now() - started) / 60_000)} min. ${where} Phases ${PHASES.join(', ')}; each swap $${USD} of SOL. Nothing was sent.`, '',
    `- PASS ${findings.filter(f => f.verdict === 'PASS').length}, LOOK ${findings.filter(f => f.verdict === 'LOOK').length}, UNTESTED ${findings.filter(f => f.verdict === 'UNTESTED').length}`, '',
    '| phase | result | what was seen |', '|---|---|---|',
    ...findings.map(f => `| ${esc(f.phase)} | ${f.verdict} | ${esc(f.detail)} |`),
  ];
  return `${lines.join('\n')}\n`;
}

async function world(): Promise<{ w: World; where: string }> {
  const keyCount = Math.max(...LOAD, KILL_AGENTS, ABUSE_WALLETS + 2, SOAK_AGENTS) + 1;
  if (OFFLINE) {
    const o = await offlineWorld(keyCount);
    const swap = { inputMint: o.inputMint, outputMint: o.outputMint, amountIn: o.amountIn };
    return { w: { target: o.target, rpc: o.rpc, wallets: [o.wallet.address], swapOf: () => swap, signer: o.wallet, signerSwap: swap }, where: 'Offline (the test fakes).' };
  }
  const target = orientim(keyCount);
  const rpc = agentRpc();
  const lamports = BigInt(Math.round((USD / await solPrice()) * 1e9));
  const wallets = await publicWallets(rpc, lamports + 100_000_000n);
  if (!wallets.length) throw new Error('No public wallet holds enough SOL for these swaps.');
  // Mostly SOL into USDC, every third into JUP: more than one market.
  const swapOf = (i: number) => ({ inputMint: SOL, outputMint: i % 3 === 2 ? JUP : USDC, amountIn: String(lamports) });
  const keypair = process.env.SIM_WALLET_KEYPAIR;
  const signer = keypair ? await createKeyPairSignerFromBytes(new Uint8Array(JSON.parse(keypair) as number[])) : undefined;
  return {
    w: { target, rpc, wallets, swapOf, ...(signer ? { signer, signerSwap: swapOf(0) } : {}) },
    where: `${target.local ? 'Orientim in this process' : `Orientim at ${process.env.SIM_API_URL}`}, RPC ${new URL(RPC_URL).host}, ${wallets.length} public wallets.`,
  };
}

it.skipIf(!PHASES.length)('capacity of the agent API', async () => {
  const started = Date.now();
  const { w, where } = await world();
  const findings: Finding[] = [];
  const say = (f: Finding) => {
    findings.push(f);
    console.log(`${f.verdict.padEnd(8)} ${f.phase}: ${f.detail}`);
  };
  const phases: Record<string, (w: World, say: (f: Finding) => void) => Promise<unknown>> = { 1: baseline, 2: load, 3: soak, 4: failures, 5: abuse, 6: killSwitch };
  for (const p of PHASES) {
    if (!phases[p]) throw new Error(`No phase ${p}: 1 to 6.`);
    await phases[p](w, say);
  }
  writeReport('capacity', report(findings, started, where), findings);
  expect(findings.filter(f => f.verdict === 'LOOK').map(f => `${f.phase}: ${f.detail}`)).toEqual([]);
}, 6 * 60 * 60_000);
