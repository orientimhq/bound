/**
 * What the server measures of itself (metrics.ts) and what it alarms on: the operator's numbers must
 * be right, and an alarm must come before a plan runs out, not after.
 */
import { afterEach, describe, expect, it } from 'vitest';
import {
  checkLandings, countedRpc, countJupiterBusy, countRpcCall, metrics, nearLimits, percentilesOf, recordDuration, resetMetrics, trackSent,
} from '../lib/server/metrics.ts';
import { GET as metricsRoute } from '../app/api/metrics/route.ts';

const HOUR = 60 * 60_000;

afterEach(() => {
  resetMetrics();
  delete process.env.ORIENTIM_METRICS_TOKEN;
  delete process.env.ORIENTIM_RPC_CREDITS_PER_MONTH;
});

describe('durations', () => {
  it('p50, p95 and p99 are the samples at those ranks', () => {
    const values = Array.from({ length: 100 }, (_, i) => i + 1);
    expect(percentilesOf(values)).toEqual({ count: 100, p50: 50, p95: 95, p99: 99, max: 100 });
    expect(percentilesOf([])).toEqual({ count: 0, p50: 0, p95: 0, p99: 0, max: 0 });
  });

  it('keeps the latest 2,000 of each name, and counts them all', () => {
    for (let i = 0; i < 2_000; i++) recordDuration('prepare', 10_000);
    for (let i = 0; i < 2_000; i++) recordDuration('prepare', 5);
    recordDuration('prepare', Number.NaN);
    recordDuration('prepare', -1);
    const d = metrics().durations.prepare;
    expect(d.count).toBe(4_000);
    expect(d.p99).toBe(5);
  });
});

describe('RPC credits', () => {
  it('every request a Kit RPC sends is counted, and nothing else changes', async () => {
    const rpc = countedRpc({
      getBlockHeight: () => ({ send: async () => 7n }),
      name: 'not a method',
    });
    expect(await rpc.getBlockHeight().send()).toBe(7n);
    await rpc.getBlockHeight().send();
    expect(rpc.name).toBe('not a method');
    expect(metrics().rpc.callsTotal).toBe(2);
  });

  it('alarms when the last day, kept up for a month, passes 80% of the plan', () => {
    process.env.ORIENTIM_RPC_CREDITS_PER_MONTH = '3000';
    const later = Date.now() + 2 * HOUR;
    // 10 calls in 2 hours is 3,600 a month: 120%.
    for (let i = 0; i < 10; i++) countRpcCall(later);
    expect(nearLimits(later)).toEqual(['rpc credits 120% of the month']);
    process.env.ORIENTIM_RPC_CREDITS_PER_MONTH = '10000';
    expect(nearLimits(later)).toEqual([]);
  });

  it('projects nothing from less than an hour of counts', () => {
    process.env.ORIENTIM_RPC_CREDITS_PER_MONTH = '1';
    for (let i = 0; i < 100; i++) countRpcCall();
    expect(nearLimits()).toEqual([]);
    expect(metrics().rpc.projectedMonth).toBeNull();
  });
});

describe("Jupiter's plan", () => {
  it('a request turned away in the last hour is an alarm; one a day ago is not', () => {
    const now = Date.now();
    countJupiterBusy(now - 2 * HOUR);
    expect(nearLimits(now)).toEqual([]);
    countJupiterBusy(now);
    countJupiterBusy(now);
    expect(nearLimits(now)).toEqual(['jupiter plan full 2× in the last hour']);
    expect(metrics(now).jupiter.refusedLastDay).toBe(3);
  });
});

describe('the landing rate', () => {
  const chain = (statuses: Record<string, { err: unknown; confirmationStatus: string } | null>, height: bigint) => {
    const asked: string[][] = [];
    return {
      asked,
      rpc: {
        getSignatureStatuses: (signatures: string[]) => ({ send: async () => { asked.push(signatures); return { value: signatures.map(s => statuses[s] ?? null) }; } }),
        getBlockHeight: () => ({ send: async () => height }),
      },
    };
  };

  it('landed, failed on chain, expired past its height, or still waiting', async () => {
    const now = Date.now();
    trackSent('landed', 100n, now);
    trackSent('failed', 100n, now);
    trackSent('expired', 100n, now);
    trackSent('waiting', 200n, now);
    const { rpc } = chain({ landed: { err: null, confirmationStatus: 'confirmed' }, failed: { err: { InstructionError: [3, { Custom: 1 }] }, confirmationStatus: 'finalized' } }, 150n);
    await checkLandings(rpc as never, now);
    expect(metrics(now).landing).toEqual({ landed: 1, failed: 1, expired: 1, waiting: 1, rate: 0.333 });
  });

  it('asks the chain at most every 30 seconds, and not at all with nothing waiting', async () => {
    const now = Date.now();
    const { rpc, asked } = chain({}, 0n);
    await checkLandings(rpc as never, now);
    expect(asked).toHaveLength(0);
    trackSent('a', 100n, now);
    await checkLandings(rpc as never, now);
    await checkLandings(rpc as never, now + 10_000);
    expect(asked).toHaveLength(1);
    await checkLandings(rpc as never, now + 31_000);
    expect(asked).toHaveLength(2);
  });

  it('forgets a signature after 10 minutes, whether or not the chain was asked', () => {
    const now = Date.now();
    trackSent('old', 100n, now - 11 * 60_000);
    trackSent('new', 100n, now);
    expect(metrics(now).landing.waiting).toBe(1);
  });

  it('an RPC that fails leaves the swaps waiting, and throws nothing', async () => {
    trackSent('a', 100n);
    const rpc = { getSignatureStatuses: () => ({ send: async () => { throw new Error('down'); } }), getBlockHeight: () => ({ send: async () => 1n }) };
    await expect(checkLandings(rpc as never)).resolves.toBeUndefined();
    expect(metrics().landing.waiting).toBe(1);
  });
});

describe('/api/metrics', () => {
  const ask = (authorization?: string) => metricsRoute(new Request('http://orientim.test/api/metrics', { headers: authorization ? { authorization } : {} }));

  it('does not exist without a token of 32 characters or more', async () => {
    expect((await ask()).status).toBe(404);
    process.env.ORIENTIM_METRICS_TOKEN = 'short';
    expect((await ask('Bearer short')).status).toBe(404);
  });

  it('answers only the token, and then names no wallet, key or transaction', async () => {
    process.env.ORIENTIM_METRICS_TOKEN = 'x'.repeat(40);
    expect((await ask()).status).toBe(404);
    expect((await ask(`Bearer ${'y'.repeat(40)}`)).status).toBe(404);
    trackSent('5j7s1QkV9n2ZgWb6hT3eXrCqYpD8uF4mLzA0', 10n);
    recordDuration('prepare', 120);
    const res = await ask(`Bearer ${'x'.repeat(40)}`);
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).not.toContain('5j7s1QkV9n2ZgWb6hT3eXrCqYpD8uF4mLzA0');
    const m = JSON.parse(body);
    expect(m.durations.prepare.p50).toBe(120);
    expect(m.heap.limitMb).toBeGreaterThan(0);
    expect(m.eventLoopMs).toHaveProperty('p99');
    expect(m.landing.waiting).toBe(1);
  });
});
