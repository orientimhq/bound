/**
 * The backup RPC (RPC_URL_FALLBACK): asked only when the main one is down, rate-limited or failing,
 * and for a send, trusted only when it answers with a success.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { refusedBeforeBroadcast } from '@orientim/solana';
import { createServerRpc } from '../lib/server/rpcFailover.ts';

const MAIN = 'https://main.rpc.test/';
const BACKUP = 'https://backup.rpc.test/';
const ok = (result: unknown) => Response.json({ jsonrpc: '2.0', id: 1, result });
const refused = () => Response.json({ jsonrpc: '2.0', id: 1, error: { code: -32002, message: 'Blockhash not found' } });
const down = () => { throw new TypeError('fetch failed'); };
/** A preflight refusal: the simulation failed, so the node broadcast nothing. */
const simulationFailed = () => Response.json({
  jsonrpc: '2.0', id: 1,
  error: { code: -32002, message: 'Transaction simulation failed', data: { err: { InstructionError: [0, { Custom: 6001 }] }, logs: [], accounts: null, unitsConsumed: 0 } },
});

/** An RPC that never answers: the request ends only when its signal does. */
const hangs = (init?: RequestInit) => new Promise<Response>((_, reject) => {
  init?.signal?.addEventListener('abort', () => reject(init.signal!.reason), { once: true });
});

type Answer = (init?: RequestInit) => Response | Promise<Response>;

/** fetch, answered per host; returns the list of hosts asked, in order. */
function network(main: Answer, backup: Answer) {
  const asked: string[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url instanceof Request ? url.url : url);
    asked.push(u.startsWith(MAIN) ? 'main' : 'backup');
    return u.startsWith(MAIN) ? main(init) : backup(init);
  }));
  return asked;
}

/** Milliseconds a call took. */
async function timed<T>(f: () => Promise<T>): Promise<[T, number]> {
  const start = Date.now();
  const out = await f();
  return [out, Date.now() - start];
}

afterEach(() => vi.unstubAllGlobals());

describe('the agent API RPC with a backup', () => {
  it('reads go to the backup when the main RPC is down', async () => {
    const asked = network(down, () => ok({ context: { slot: 1 }, value: 42 }));
    const rpc = createServerRpc(MAIN, BACKUP);
    const { value } = await rpc.getBalance('11111111111111111111111111111111' as never).send();
    expect(value).toBe(42n);
    expect(asked).toEqual(['main', 'backup']);
  });

  it('a send takes the backup only when it succeeds', async () => {
    network(down, () => ok('5igSignature'));
    expect(await createServerRpc(MAIN, BACKUP).sendTransaction('AA==' as never, { encoding: 'base64' }).send()).toBe('5igSignature');

    network(down, () => refused());
    await expect(createServerRpc(MAIN, BACKUP).sendTransaction('AA==' as never, { encoding: 'base64' }).send()).rejects.toThrow(/fetch failed/);
  });

  const QUICK = { totalMs: 300, attemptMs: 200, minSendMs: 150, downMs: 30_000 };
  const balance = () => ok({ context: { slot: 1 }, value: 42 });

  it('the main RPC and the backup share one deadline', async () => {
    // Long enough apart that a loaded machine cannot blur them: two deadlines in a row would take
    // attemptMs + totalMs (1 s), one shared deadline totalMs (0.6 s).
    const SHARED = { totalMs: 600, attemptMs: 400, minSendMs: 150, downMs: 30_000 };
    const asked = network(hangs, balance);
    const [{ value }, ms] = await timed(() => createServerRpc(MAIN, BACKUP, SHARED).getBalance('11111111111111111111111111111111' as never).send());
    expect(value).toBe(42n);
    expect(asked).toEqual(['main', 'backup']);
    expect(ms).toBeGreaterThanOrEqual(390);

    network(hangs, hangs);
    const start = Date.now();
    await expect(createServerRpc(MAIN, BACKUP, SHARED).getBalance('11111111111111111111111111111111' as never).send()).rejects.toThrow();
    expect(Date.now() - start).toBeLessThan(SHARED.attemptMs + SHARED.totalMs - 100);
  });

  it('a send is not started on the backup with too little time left', async () => {
    const asked = network(hangs, () => ok('5igSignature'));
    await expect(createServerRpc(MAIN, BACKUP, QUICK).sendTransaction('AA==' as never, { encoding: 'base64' }).send()).rejects.toThrow();
    expect(asked).toEqual(['main']);
  });

  it('a rate-limited backup stops retrying at the deadline', async () => {
    network(down, () => new Response('busy', { status: 429 }));
    const start = Date.now();
    await expect(createServerRpc(MAIN, BACKUP, { totalMs: 400, attemptMs: 200, minSendMs: 150, downMs: 30_000 })
      .getBalance('11111111111111111111111111111111' as never).send()).rejects.toThrow();
    // Its retries alone would wait at least 1.75 s (250, 500 and 1,000 ms at the least jitter).
    expect(Date.now() - start).toBeLessThan(1_000);
  });

  it('once the main RPC hangs, the next calls go straight to the backup, until it is tried again', async () => {
    const TIMES = { totalMs: 600, attemptMs: 300, minSendMs: 150, downMs: 1_000 };
    const asked = network(hangs, balance);
    const rpc = createServerRpc(MAIN, BACKUP, TIMES);
    const read = () => timed(() => rpc.getBalance('11111111111111111111111111111111' as never).send());
    const [, first] = await read();
    expect(first).toBeGreaterThanOrEqual(290);
    // A swap's dozen calls after it: none waits on the main RPC again.
    for (let i = 0; i < 5; i++) {
      const [{ value }, ms] = await read();
      expect(value).toBe(42n);
      expect(ms).toBeLessThan(200);
    }
    expect(asked).toEqual(['main', 'backup', 'backup', 'backup', 'backup', 'backup', 'backup']);
    // Once the time is up, the main RPC is asked first again, and kept when it answers.
    await new Promise(r => setTimeout(r, TIMES.downMs + 50));
    const again = network(balance, balance);
    await read();
    await read();
    expect(again).toEqual(['main', 'main']);
  });

  it('while the main RPC is down, a send is taken from the backup only as a success', async () => {
    const TIMES = { totalMs: 600, attemptMs: 300, minSendMs: 150, downMs: 10_000 };
    network(down, balance);
    const rpc = createServerRpc(MAIN, BACKUP, TIMES);
    // Two quick failures judge it down.
    await rpc.getBalance('11111111111111111111111111111111' as never).send();
    await rpc.getBalance('11111111111111111111111111111111' as never).send();
    const asked = network(down, () => refused());
    await expect(rpc.sendTransaction('AA==' as never, { encoding: 'base64' }).send()).rejects.toThrow();
    expect(asked).toEqual(['backup']);
    network(down, () => ok('5igSignature'));
    expect(await rpc.sendTransaction('AA==' as never, { encoding: 'base64' }).send()).toBe('5igSignature');
  });

  it('a 4xx from the main RPC is its answer, not an outage', async () => {
    const asked = network(() => new Response('bad', { status: 400 }), () => ok({ context: { slot: 1 }, value: 1 }));
    await expect(createServerRpc(MAIN, BACKUP).getBalance('11111111111111111111111111111111' as never).send()).rejects.toThrow();
    expect(asked).toEqual(['main']);
  });

  const ADDRESS = '11111111111111111111111111111111' as never;
  /** A main RPC whose calls are answered in turn by `answers`, the last one for every call after. */
  const inTurn = (...answers: Answer[]): Answer => {
    let i = 0;
    return init => answers[Math.min(i++, answers.length - 1)](init);
  };
  const outcome = (p: Promise<unknown>) => p.then(() => 'ok', (e: Error) => `fail: ${e.message}`);

  it('one quick failure of the main RPC is a blip: the next calls ask it first, even with the backup failing', async () => {
    const asked = network(inTurn(() => new Response('bad gateway', { status: 502 }), balance), () => new Response('expired key', { status: 401 }));
    const rpc = createServerRpc(MAIN, BACKUP, { ...QUICK, downMs: 30_000 });
    const results = [];
    for (let i = 0; i < 5; i++) results.push(await outcome(rpc.getBalance(ADDRESS).send()));
    expect(results.slice(1)).toEqual(['ok', 'ok', 'ok', 'ok']);
    expect(asked).toEqual(['main', 'backup', 'main', 'main', 'main', 'main']);
  });

  it('a backup that fails while the main RPC is passed over ends the wait: the main RPC is asked with the time left', async () => {
    const TIMES = { totalMs: 600, attemptMs: 300, minSendMs: 150, downMs: 30_000 };
    network(down, balance);
    const rpc = createServerRpc(MAIN, BACKUP, TIMES);
    await rpc.getBalance(ADDRESS).send();
    await rpc.getBalance(ADDRESS).send();
    // Judged down; now the main RPC is back and the backup's key has expired.
    const asked = network(balance, () => new Response('expired key', { status: 401 }));
    expect((await rpc.getBalance(ADDRESS).send()).value).toBe(42n);
    expect((await rpc.getBalance(ADDRESS).send()).value).toBe(42n);
    expect(asked).toEqual(['backup', 'main', 'main']);
  });

  it('while the main RPC is passed over, a read now and then also asks it, and its answer ends the wait', async () => {
    const TIMES = { totalMs: 600, attemptMs: 300, minSendMs: 150, downMs: 30_000, probeMs: 100 };
    network(down, balance);
    const rpc = createServerRpc(MAIN, BACKUP, TIMES);
    await rpc.getBalance(ADDRESS).send();
    await rpc.getBalance(ADDRESS).send();
    const asked = network(balance, balance);
    await rpc.getBalance(ADDRESS).send();
    expect(asked).toEqual(['backup']);
    await new Promise(r => setTimeout(r, TIMES.probeMs + 20));
    // This read is answered by the backup at once; the main RPC is asked beside it.
    await rpc.getBalance(ADDRESS).send();
    await new Promise(r => setTimeout(r, 20));
    expect(asked.slice(1).sort()).toEqual(['backup', 'main']);
    await rpc.getBalance(ADDRESS).send();
    expect(asked.at(-1)).toBe('main');
  });

  it('a slow success that began before the main RPC was judged down does not end the wait', async () => {
    const TIMES = { totalMs: 1_500, attemptMs: 1_000, minSendMs: 150, downMs: 30_000 };
    const slow = () => new Promise<Response>(r => setTimeout(() => r(balance()), 250));
    const asked = network(inTurn(slow, down, down, slow), balance);
    const rpc = createServerRpc(MAIN, BACKUP, TIMES);
    const first = rpc.getBalance(ADDRESS).send();
    await new Promise(r => setTimeout(r, 20));
    await rpc.getBalance(ADDRESS).send();
    await rpc.getBalance(ADDRESS).send();
    await first;
    const [, ms] = await timed(() => rpc.getBalance(ADDRESS).send());
    expect(ms).toBeLessThan(200);
    expect(asked).toEqual(['main', 'main', 'backup', 'main', 'backup', 'backup']);
  });

  it("while the main RPC is passed over, the backup's refusal of a send it alone was given is a refusal before broadcast", async () => {
    const TIMES = { totalMs: 600, attemptMs: 300, minSendMs: 150, downMs: 30_000 };
    network(down, balance);
    const rpc = createServerRpc(MAIN, BACKUP, TIMES);
    await rpc.getBalance(ADDRESS).send();
    await rpc.getBalance(ADDRESS).send();
    const asked = network(down, simulationFailed);
    const caught = await rpc.sendTransaction('AA==' as never, { encoding: 'base64' }).send().catch((e: unknown) => e);
    expect(asked).toEqual(['backup']);
    expect(refusedBeforeBroadcast(caught)).toBe(true);
  });

  it('but not of a send the main RPC was given before: that one stays unknown', async () => {
    const TIMES = { totalMs: 600, attemptMs: 300, minSendMs: 150, downMs: 30_000 };
    network(down, simulationFailed);
    const rpc = createServerRpc(MAIN, BACKUP, TIMES);
    // The main RPC fails the first send after taking it, maybe; the backup refuses it.
    const first = await rpc.sendTransaction('BB==' as never, { encoding: 'base64' }).send().catch((e: unknown) => e);
    expect(refusedBeforeBroadcast(first)).toBe(false);
    network(down, balance);
    await rpc.getBalance(ADDRESS).send();
    const asked = network(down, simulationFailed);
    const again = await rpc.sendTransaction('BB==' as never, { encoding: 'base64' }).send().catch((e: unknown) => e);
    expect(asked).toEqual(['backup']);
    expect(refusedBeforeBroadcast(again)).toBe(false);
  });

  it('a backup that refuses outright (401) is reported as the main RPC being down, not as the caller\'s error', async () => {
    network(down, () => new Response('expired key', { status: 401 }));
    await expect(createServerRpc(MAIN, BACKUP, QUICK).getBalance(ADDRESS).send()).rejects.toThrow(/fetch failed/);
  });
});
