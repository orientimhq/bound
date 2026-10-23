/**
 * Orientim's Jupiter requests stay within the plan: a request waits for room rather than draw a 429,
 * and waiting requests are served one client at a time.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createJupiterGate, jupiterLane, jupiterPerMinute } from '../lib/server/jupiterGate.ts';

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
});
afterEach(() => {
  vi.useRealTimers();
  delete process.env.ORIENTIM_JUPITER_PER_MINUTE;
});

/** A fetch that notes which request went out when, and answers at once. */
function recorder() {
  const out: { url: string; at: number }[] = [];
  const fetchImpl = (async (input: RequestInfo | URL) => {
    out.push({ url: String(input), at: Date.now() });
    return new Response('{}');
  }) as typeof fetch;
  return { out, fetchImpl };
}

const settle = () => vi.advanceTimersByTimeAsync(0);

describe('the Jupiter gate', () => {
  it('sends at once while the plan has room', async () => {
    const { out, fetchImpl } = recorder();
    const f = createJupiterGate(600).wrap(fetchImpl);
    await Promise.all(Array.from({ length: 10 }, (_, i) => f(`https://jup/${i}`)));
    expect(out).toHaveLength(10);
    expect(out.every(o => o.at === 0)).toBe(true);
  });

  it('holds a second to a sixtieth of the minute, and the rest waits for the next second', async () => {
    const { out, fetchImpl } = recorder();
    const gate = createJupiterGate(120);
    const f = gate.wrap(fetchImpl);
    const all = Promise.all([f('a'), f('b'), f('c')]);
    await settle();
    expect(out.map(o => o.url)).toEqual(['a', 'b']);
    expect(gate.waiting()).toBe(1);
    await vi.advanceTimersByTimeAsync(999);
    expect(out).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);
    await all;
    expect(out[2]).toEqual({ url: 'c', at: 1_000 });
  });

  it('never sends more in any 60 seconds than the plan allows', async () => {
    const { out, fetchImpl } = recorder();
    const f = createJupiterGate(3).wrap(fetchImpl);
    const all = Promise.all(['a', 'b', 'c', 'd'].map(u => f(u)));
    await vi.advanceTimersByTimeAsync(5_000);
    expect(out.map(o => [o.url, o.at])).toEqual([['a', 0], ['b', 1_000], ['c', 2_000]]);
    await vi.advanceTimersByTimeAsync(55_000);
    await all;
    expect(out[3]).toEqual({ url: 'd', at: 60_000 });
  });

  it("serves waiting clients in turn: one client's many swaps never go ahead of another's", async () => {
    const { out, fetchImpl } = recorder();
    const f = createJupiterGate(60).wrap(fetchImpl);
    const busy = Array.from({ length: 5 }, (_, i) => jupiterLane.run('busy', () => f(`busy-${i}`)));
    await settle();
    const quiet = jupiterLane.run('quiet', () => f('quiet'));
    await vi.advanceTimersByTimeAsync(10_000);
    await Promise.all([...busy, quiet]);
    expect(out.map(o => o.url)).toEqual(['busy-0', 'quiet', 'busy-1', 'busy-2', 'busy-3', 'busy-4']);
  });

  it('a request given up while it waits is never sent, and leaves its place to the next', async () => {
    const { out, fetchImpl } = recorder();
    const gate = createJupiterGate(60);
    const f = gate.wrap(fetchImpl);
    await f('first');
    const controller = new AbortController();
    const dropped = f('dropped', { signal: controller.signal });
    const kept = f('kept');
    await settle();
    controller.abort(new Error('deadline'));
    await expect(dropped).rejects.toThrow('deadline');
    expect(gate.waiting()).toBe(1);
    await vi.advanceTimersByTimeAsync(1_000);
    await kept;
    expect(out.map(o => o.url)).toEqual(['first', 'kept']);
  });

  it('a request already given up is refused before it waits', async () => {
    const { out, fetchImpl } = recorder();
    const f = createJupiterGate(60).wrap(fetchImpl);
    await expect(f('late', { signal: AbortSignal.abort(new Error('too late')) })).rejects.toThrow('too late');
    expect(out).toHaveLength(0);
  });

  it('a check that must answer now goes at once, and the requests that wait leave room for it', async () => {
    const { out, fetchImpl } = recorder();
    const gate = createJupiterGate(60);
    await gate.counted(fetchImpl)('health');
    await gate.counted(fetchImpl)('health-again');
    const swap = gate.wrap(fetchImpl)('swap');
    await vi.advanceTimersByTimeAsync(999);
    expect(out.map(o => o.url)).toEqual(['health', 'health-again']);
    await vi.advanceTimersByTimeAsync(1);
    await swap;
    expect(out[2]).toEqual({ url: 'swap', at: 1_000 });
  });

  it('past what the plan serves in 15 seconds, a new request is refused at once as busy rather than left to time out', async () => {
    const { out, fetchImpl } = recorder();
    const gate = createJupiterGate(600);
    const f = gate.wrap(fetchImpl);
    // 10 a second: 10 go now, and 150 wait (15 seconds of the plan).
    const sent = Array.from({ length: 160 }, (_, i) => f(`r${i}`));
    await settle();
    expect(out).toHaveLength(10);
    expect(gate.waiting()).toBe(150);
    await expect(f('one-too-many')).rejects.toMatchObject({ status: 429 });
    await vi.advanceTimersByTimeAsync(15_000);
    await Promise.all(sent);
    expect(out).toHaveLength(160);
  });

  it('a full line still takes a new client: the client with the most waiting gives up its newest place', async () => {
    const { out, fetchImpl } = recorder();
    const gate = createJupiterGate(60);
    const f = gate.wrap(fetchImpl);
    // One a second: a0 goes now, and three clients keep the line full with five each.
    const flood = ['a', 'b', 'c'].flatMap(k => Array.from({ length: k === 'a' ? 6 : 5 }, (_, i) => jupiterLane.run(k, () => f(`${k}${i}`))));
    const outcomes = flood.map(p => p.then(() => 'sent', (e: { status?: number }) => e.status));
    await settle();
    expect(gate.waiting()).toBe(15);
    // A client already holding as many as any other is refused at the door, as before.
    await expect(jupiterLane.run('a', () => f('a-more'))).rejects.toMatchObject({ status: 429 });
    // A new client is let in, in place of the newest request of a client with the most waiting.
    const fresh = jupiterLane.run('d', () => f('d0'));
    await settle();
    expect(gate.waiting()).toBe(15);
    expect(await outcomes[5]).toBe(429);
    // And it is served in the clients' turn, not behind the whole line.
    await vi.advanceTimersByTimeAsync(3_000);
    await fresh;
    expect(out.map(o => o.url)).toEqual(['a0', 'b0', 'c0', 'd0']);
    await vi.advanceTimersByTimeAsync(15_000);
    expect((await Promise.all(outcomes)).filter(o => o === 429)).toHaveLength(1);
  });

  it('reads the plan from ORIENTIM_JUPITER_PER_MINUTE, and the Free plan without it', () => {
    expect(jupiterPerMinute()).toBe(60);
    process.env.ORIENTIM_JUPITER_PER_MINUTE = '600';
    expect(jupiterPerMinute()).toBe(600);
    process.env.ORIENTIM_JUPITER_PER_MINUTE = 'lots';
    expect(jupiterPerMinute()).toBe(60);
  });
});
