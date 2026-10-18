/**
 * The reads every swap shares (the blockhash, the rent): one call for the requests that ask at the
 * same time, never a failure kept, and a caller's own deadline ending only its own wait.
 */
import { describe, expect, it } from 'vitest';
import type { SolanaRpc } from '@orientimhq/swap/solana';
import { SHARED_READS_MS, withSharedFee, withSharedReads } from '../lib/server/sharedReads.ts';

/** An RPC whose answers the test releases by hand; counts the calls that reach it. */
function fakeRpc() {
  const calls: string[] = [];
  const waiting: Array<{ resolve: (v: unknown) => void; reject: (e: unknown) => void }> = [];
  const method = (name: string) => (...args: unknown[]) => ({
    send: () => {
      calls.push(`${name}:${args.map(String).join(',')}`);
      return new Promise((resolve, reject) => waiting.push({ resolve, reject }));
    },
  });
  const rpc = {
    getLatestBlockhash: method('getLatestBlockhash'),
    getMinimumBalanceForRentExemption: method('getMinimumBalanceForRentExemption'),
    getAccountInfo: method('getAccountInfo'),
  } as unknown as SolanaRpc;
  return { rpc, calls, waiting };
}

const TTL = { getLatestBlockhash: 500, getMinimumBalanceForRentExemption: 600_000 };

describe('shared reads', () => {
  it('answers requests that ask at the same time with one call', async () => {
    const { rpc, calls, waiting } = fakeRpc();
    const shared = withSharedReads(rpc, TTL, () => 0);
    const a = shared.getLatestBlockhash({ commitment: 'confirmed' }).send();
    const b = shared.getLatestBlockhash({ commitment: 'confirmed' }).send();
    expect(calls).toHaveLength(1);
    waiting[0].resolve('h1');
    expect(await Promise.all([a, b])).toEqual(['h1', 'h1']);
  });

  it('asks again once the answer is older than its time', async () => {
    const { rpc, calls, waiting } = fakeRpc();
    let t = 0;
    const shared = withSharedReads(rpc, TTL, () => t);
    const a = shared.getLatestBlockhash({ commitment: 'confirmed' }).send();
    waiting[0].resolve('h1');
    await a;
    t = 499;
    await expect(shared.getLatestBlockhash({ commitment: 'confirmed' }).send()).resolves.toBe('h1');
    t = 500;
    const c = shared.getLatestBlockhash({ commitment: 'confirmed' }).send();
    expect(calls).toHaveLength(2);
    waiting[1].resolve('h2');
    await expect(c).resolves.toBe('h2');
  });

  it('keeps the rent per account size', async () => {
    const { rpc, calls, waiting } = fakeRpc();
    const shared = withSharedReads(rpc, TTL, () => 0);
    const small = shared.getMinimumBalanceForRentExemption(165n).send();
    const large = shared.getMinimumBalanceForRentExemption(170n).send();
    expect(calls).toEqual(['getMinimumBalanceForRentExemption:165', 'getMinimumBalanceForRentExemption:170']);
    waiting[0].resolve(2_039_280n);
    waiting[1].resolve(2_074_080n);
    expect(await Promise.all([small, large])).toEqual([2_039_280n, 2_074_080n]);
    await expect(shared.getMinimumBalanceForRentExemption(165n).send()).resolves.toBe(2_039_280n);
    expect(calls).toHaveLength(2);
  });

  it('never keeps a failure', async () => {
    const { rpc, calls, waiting } = fakeRpc();
    const shared = withSharedReads(rpc, TTL, () => 0);
    const a = shared.getLatestBlockhash({ commitment: 'confirmed' }).send();
    waiting[0].reject(new Error('down'));
    await expect(a).rejects.toThrow('down');
    const b = shared.getLatestBlockhash({ commitment: 'confirmed' }).send();
    expect(calls).toHaveLength(2);
    waiting[1].resolve('h2');
    await expect(b).resolves.toBe('h2');
  });

  it("ends only the caller's own wait when its deadline passes", async () => {
    const { rpc, calls, waiting } = fakeRpc();
    const shared = withSharedReads(rpc, TTL, () => 0);
    const late = new AbortController();
    const a = shared.getLatestBlockhash({ commitment: 'confirmed' }).send({ abortSignal: late.signal });
    const b = shared.getLatestBlockhash({ commitment: 'confirmed' }).send();
    late.abort(new Error('late'));
    await expect(a).rejects.toThrow('late');
    waiting[0].resolve('h1');
    await expect(b).resolves.toBe('h1');
    expect(calls).toHaveLength(1);
  });

  it('leaves every other read alone', async () => {
    const { rpc, calls, waiting } = fakeRpc();
    const shared = withSharedReads(rpc, TTL, () => 0);
    const a = shared.getAccountInfo('x' as never).send();
    const b = shared.getAccountInfo('x' as never).send();
    expect(calls).toHaveLength(2);
    waiting.forEach(w => w.resolve(null));
    await Promise.all([a, b]);
  });
});

describe('shared priority fee', () => {
  const counted = (answers: Array<bigint | null | Error>) => {
    const asked: string[][] = [];
    const level = async (writable: readonly string[]) => {
      asked.push([...writable]);
      const a = answers.shift();
      if (a instanceof Error) throw a;
      return a ?? null;
    };
    return { asked, level };
  };

  it('asks once for the swaps that write the same accounts, in any order, within its time', async () => {
    const { asked, level } = counted([7n, 9n]);
    let t = 0;
    const fee = withSharedFee(level, 2_000, () => t);
    expect(await fee(['A', 'B'])).toBe(7n);
    t = 1_999;
    expect(await fee(['B', 'A'])).toBe(7n);
    expect(asked).toHaveLength(1);
    t = 2_000;
    expect(await fee(['A', 'B'])).toBe(9n);
    expect(asked).toHaveLength(2);
  });

  it('keeps each set of accounts apart', async () => {
    const { asked, level } = counted([1n, 2n]);
    const fee = withSharedFee(level, 2_000, () => 0);
    expect(await fee(['A'])).toBe(1n);
    expect(await fee(['C'])).toBe(2n);
    expect(asked).toEqual([['A'], ['C']]);
  });

  it('never keeps no estimate or a failure', async () => {
    const { asked, level } = counted([null, new Error('down'), 5n]);
    const fee = withSharedFee(level, 2_000, () => 0);
    expect(await fee(['A'])).toBeNull();
    await expect(fee(['A'])).rejects.toThrow('down');
    expect(await fee(['A'])).toBe(5n);
    expect(asked).toHaveLength(3);
  });
});

it('shares the blockhash for two seconds, about five blocks of its ~150', () => {
  expect(SHARED_READS_MS.getLatestBlockhash).toBe(2_000);
});
