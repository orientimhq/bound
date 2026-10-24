import { monitorEventLoopDelay } from 'node:perf_hooks';
import { getHeapStatistics } from 'node:v8';

/**
 * What this instance measures of itself, for the operator (/api/metrics): how long prepare and
 * finalize take, how busy the event loop is, how much of the heap is used, how many sent swaps land,
 * and how much of the RPC's and Jupiter's plans it spends. Durations and counts only: never a wallet,
 * a token, a key or a transaction. Kept in this process's memory, so a restart starts them again;
 * on one machine (Fly) that is the whole deployment, on Vercel one instance of many.
 *
 *   ORIENTIM_RPC_CREDITS_PER_MONTH   the RPC plan's credits a month: 10,000,000 (Helius Developer) by default
 */

const DAY_MS = 24 * 60 * 60_000;
const MONTH_MS = 30 * DAY_MS;
/** Durations kept per name: the latest, enough for a p99 that moves with the traffic. */
const SAMPLES = 2_000;
/** Above this share of the month's credits, at the rate of the last day, the operator is told. */
const NEAR_SHARE = 0.8;

type Samples = { values: number[]; next: number; count: number };
const durations = new Map<string, Samples>();

/** One duration, in ms, under `name` (`prepare`, `finalize`, `send`, ...). */
export function recordDuration(name: string, ms: number): void {
  if (!Number.isFinite(ms) || ms < 0) return;
  let s = durations.get(name);
  if (!s) durations.set(name, (s = { values: [], next: 0, count: 0 }));
  if (s.values.length < SAMPLES) s.values.push(ms);
  else s.values[s.next] = ms;
  s.next = (s.next + 1) % SAMPLES;
  s.count++;
}

export type Percentiles = { count: number; p50: number; p95: number; p99: number; max: number };

export function percentilesOf(values: readonly number[], count = values.length): Percentiles {
  const sorted = [...values].sort((a, b) => a - b);
  const at = (q: number) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.ceil(q * sorted.length) - 1)] : 0);
  return { count, p50: at(0.5), p95: at(0.95), p99: at(0.99), max: sorted.length ? sorted[sorted.length - 1] : 0 };
}

// --- the event loop: the delay a timer sees, which every request waits through on one thread.
let loop: ReturnType<typeof monitorEventLoopDelay> | null = null;
let loopSince = Date.now();
const LOOP_WINDOW_MS = 10 * 60_000;
function eventLoop() {
  if (!loop) {
    loop = monitorEventLoopDelay({ resolution: 20 });
    loop.enable();
    loopSince = Date.now();
  }
  const ms = (ns: number) => Math.round(ns / 1e5) / 10;
  const read = { sinceMs: Date.now() - loopSince, p50: ms(loop.percentile(50)), p99: ms(loop.percentile(99)), max: ms(loop.max) };
  // A window of ten minutes or more, then a fresh one: an old spike does not hide today's.
  if (read.sinceMs >= LOOP_WINDOW_MS) {
    loop.reset();
    loopSince = Date.now();
  }
  return read;
}
/** Starts measuring the event loop now, rather than at the first read. */
export function startEventLoopMonitor(): void {
  if (!loop) eventLoop();
}

// --- sent swaps: landed, failed on chain, or expired. Checked later against the chain.
type Sent = { signature: string; lvbh: bigint; at: number };
export type Landing = 'landed' | 'failed' | 'expired';
const pending = new Map<string, Sent>();
const landings: { at: number; kind: Landing }[] = [];
const MAX_PENDING = 10_000;
const LANDINGS_KEPT = 50_000;

/** A swap the server sent (or may have): its fate is read from the chain later (`checkLandings`). */
export function trackSent(signature: string, lastValidBlockHeight: bigint, now = Date.now()): void {
  if (pending.size >= MAX_PENDING) pending.delete(pending.keys().next().value!);
  pending.set(signature, { signature, lvbh: lastValidBlockHeight, at: now });
}

type StatusRpc = {
  getSignatureStatuses(signatures: never[], config?: { searchTransactionHistory?: boolean }): { send(): Promise<{ value: readonly ({ err: unknown; confirmationStatus?: string | null } | null)[] }> };
  getBlockHeight(config?: { commitment?: 'confirmed' }): { send(): Promise<bigint> };
};

let checking: Promise<void> | null = null;
let nextCheck = 0;
const CHECK_EVERY_MS = 30_000;

/**
 * Reads the sent swaps' statuses, at most every 30 seconds and 256 at a time: two RPC calls while any
 * is waiting, none otherwise. A swap with no status past its last valid block height has expired.
 */
export function checkLandings(rpc: StatusRpc, now = Date.now()): Promise<void> {
  if (checking || pending.size === 0 || now < nextCheck) return checking ?? Promise.resolve();
  nextCheck = now + CHECK_EVERY_MS;
  const batch = [...pending.values()].slice(0, 256);
  checking = (async () => {
    const [statuses, height] = await Promise.all([
      rpc.getSignatureStatuses(batch.map(s => s.signature) as never[], { searchTransactionHistory: false }).send(),
      rpc.getBlockHeight({ commitment: 'confirmed' }).send(),
    ]);
    batch.forEach((s, i) => {
      const status = statuses.value[i];
      const kind: Landing | null = status && (status.confirmationStatus === 'confirmed' || status.confirmationStatus === 'finalized')
        ? (status.err ? 'failed' : 'landed')
        : !status && height > s.lvbh ? 'expired' : null;
      if (!kind) return;
      pending.delete(s.signature);
      landings.push({ at: now, kind });
    });
    while (landings.length > LANDINGS_KEPT || (landings.length && landings[0].at < now - DAY_MS)) landings.shift();
  })().catch(() => undefined).finally(() => { checking = null; });
  return checking;
}

// --- what the plans allow: RPC credits a month, and Jupiter's requests a minute.
/** RPC calls per minute, by the minute they began in: a day of them is at most 1,440 entries. */
const rpcCalls = new Map<number, number>();
let rpcCallsTotal = 0;
const startedAt = Date.now();
const MINUTE_MS = 60_000;

/** One request to the main RPC (Helius counts one credit for each of the calls Orientim makes). */
export function countRpcCall(now = Date.now()): void {
  rpcCallsTotal++;
  const minute = Math.floor(now / MINUTE_MS);
  rpcCalls.set(minute, (rpcCalls.get(minute) ?? 0) + 1);
  if (rpcCalls.size > 1_440) for (const m of rpcCalls.keys()) if (m <= minute - 1_440) rpcCalls.delete(m);
}

const rpcCallsLastDay = (now: number) => {
  let n = 0;
  for (const [m, c] of rpcCalls) if (m > Math.floor(now / MINUTE_MS) - 1_440) n += c;
  return n;
};

/**
 * `rpc`, counting each request it sends (`countRpcCall`). Every method of a Kit RPC returns a pending
 * request whose `send` makes the call; nothing else is changed.
 */
export function countedRpc<T extends object>(rpc: T): T {
  return new Proxy(rpc, {
    get(target, prop, receiver) {
      const method = Reflect.get(target, prop, receiver);
      if (typeof method !== 'function') return method;
      return (...args: unknown[]) => {
        const request = method.apply(target, args);
        if (!request || typeof request.send !== 'function') return request;
        return new Proxy(request, {
          get(r, p, rr) {
            const v = Reflect.get(r, p, rr);
            if (p !== 'send' || typeof v !== 'function') return v;
            return (...a: unknown[]) => {
              countRpcCall();
              return v.apply(r, a);
            };
          },
        });
      };
    },
  });
}

let jupiterRefusals: number[] = [];
/** A Jupiter request refused because the plan's minute was full and too many were waiting. */
export function countJupiterBusy(now = Date.now()): void {
  jupiterRefusals.push(now);
  // Kept for a day, and at most 10,000: past that the hour's count is already an alarm.
  if (jupiterRefusals.length > 10_000 || jupiterRefusals[0] < now - DAY_MS) jupiterRefusals = jupiterRefusals.filter(t => t >= now - DAY_MS).slice(-10_000);
}

const creditsPerMonth = () => {
  const n = Number(process.env.ORIENTIM_RPC_CREDITS_PER_MONTH);
  return Number.isFinite(n) && n > 0 ? n : 10_000_000;
};

/**
 * The plans this instance is close to using up, for /api/health's `near` (a monitor alarms on any):
 * the RPC's credits, at the last day's rate, past 80% of the month's; Jupiter's minute full, with
 * requests turned away, within the last hour.
 */
export function nearLimits(now = Date.now()): string[] {
  const near: string[] = [];
  // At least an hour of counts before projecting a month from them.
  const span = Math.min(DAY_MS, now - startedAt);
  if (span >= 60 * 60_000) {
    const projected = (rpcCallsLastDay(now) / span) * MONTH_MS;
    if (projected > NEAR_SHARE * creditsPerMonth()) near.push(`rpc credits ${Math.round((100 * projected) / creditsPerMonth())}% of the month`);
  }
  const lastHour = jupiterRefusals.filter(t => t >= now - 60 * 60_000).length;
  if (lastHour > 0) near.push(`jupiter plan full ${lastHour}× in the last hour`);
  return near;
}

export type Metrics = {
  uptimeMs: number;
  durations: Record<string, Percentiles>;
  eventLoopMs: { sinceMs: number; p50: number; p99: number; max: number };
  heap: { usedMb: number; totalMb: number; limitMb: number; rssMb: number };
  /** Sent swaps over the last day, as the chain decided them; `waiting` are not decided yet. */
  landing: { landed: number; failed: number; expired: number; waiting: number; rate: number | null };
  rpc: { callsLastDay: number; callsTotal: number; creditsPerMonth: number; projectedMonth: number | null };
  jupiter: { refusedLastDay: number };
  near: string[];
};

export function metrics(now = Date.now()): Metrics {
  const mb = (b: number) => Math.round(b / 1048576);
  const mem = process.memoryUsage();
  const counts = { landed: 0, failed: 0, expired: 0 };
  for (const l of landings) if (l.at >= now - DAY_MS) counts[l.kind]++;
  const decided = counts.landed + counts.failed + counts.expired;
  const span = Math.min(DAY_MS, now - startedAt);
  const lastDay = rpcCallsLastDay(now);
  return {
    uptimeMs: now - startedAt,
    durations: Object.fromEntries([...durations].map(([name, s]) => [name, percentilesOf(s.values, s.count)])),
    eventLoopMs: eventLoop(),
    heap: { usedMb: mb(mem.heapUsed), totalMb: mb(mem.heapTotal), limitMb: mb(getHeapStatistics().heap_size_limit), rssMb: mb(mem.rss) },
    landing: { ...counts, waiting: pending.size, rate: decided ? Math.round((1000 * counts.landed) / decided) / 1000 : null },
    rpc: { callsLastDay: lastDay, callsTotal: rpcCallsTotal, creditsPerMonth: creditsPerMonth(), projectedMonth: span >= 60 * 60_000 ? Math.round((lastDay / span) * MONTH_MS) : null },
    jupiter: { refusedLastDay: jupiterRefusals.filter(t => t >= now - DAY_MS).length },
    near: nearLimits(now),
  };
}

/** For tests: forgets everything measured. */
export function resetMetrics(): void {
  durations.clear();
  pending.clear();
  landings.length = 0;
  rpcCalls.clear();
  rpcCallsTotal = 0;
  jupiterRefusals = [];
  checking = null;
  nextCheck = 0;
}
