/** /api/health for uptime monitors. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { checkHealth, recentHealth, swapState, swapStateOf } from '../lib/server/health.ts';

afterEach(() => {
  delete process.env.RPC_URL;
  delete process.env.RPC_URL_FALLBACK;
  delete process.env.ORIENTIM_DISABLED;
  for (const k of ['ORIENTIM_API_SECRET', 'ORIENTIM_API_KEYS', 'RPC_URL_AGENTS', 'JUPITER_API_KEY_AGENTS']) delete process.env[k];
});

const height = () => Response.json({ jsonrpc: '2.0', id: 1, result: 312_000_000 });
const tokens = () => Response.json([{ id: 'So11111111111111111111111111111111111111112' }]);
const built = () => Response.json({ outAmount: '1500000', swapInstruction: { programId: 'x', accounts: [], data: '' } });
const down = () => { throw new TypeError('fetch failed'); };

/** The agent API on, with the site's RPC and Jupiter key. */
const apiOn = () => {
  process.env.ORIENTIM_API_SECRET = Buffer.alloc(32, 1).toString('base64');
  process.env.ORIENTIM_API_KEYS = `a:${'0'.repeat(64)}`;
};

/** fetch by host: the main RPC, the backup, Jupiter (its search, and a swap it builds when it answers). */
function hosts(main: () => Response, backup: () => Response, jupiter: () => Response) {
  process.env.RPC_URL = 'https://main.rpc.test/';
  process.env.RPC_URL_FALLBACK = 'https://backup.rpc.test/';
  return vi.fn(async (url: string | URL | Request) => {
    const u = String(url);
    if (u.startsWith('https://main.')) return main();
    if (u.startsWith('https://backup.')) return backup();
    const answer = jupiter();
    return u.includes('/swap/v2/build') && answer.ok ? built() : answer;
  }) as unknown as typeof fetch;
}

describe('health', () => {
  beforeEach(apiOn);

  it('up when an RPC and Jupiter answer', async () => {
    const h = await checkHealth(hosts(height, height, tokens));
    expect(h).toMatchObject({ ok: true, paused: false, rpc: { ok: true }, rpcFallback: { ok: true }, jupiter: { ok: true }, agentApi: 'on' });
  });

  it('the backup keeps it up while the main RPC is down; both down, or Jupiter down, is down', async () => {
    expect((await checkHealth(hosts(down, height, tokens))).ok).toBe(true);
    expect((await checkHealth(hosts(down, down, tokens))).ok).toBe(false);
    expect((await checkHealth(hosts(height, height, () => new Response('no', { status: 401 })))).ok).toBe(false);
    expect((await checkHealth(hosts(() => Response.json({ jsonrpc: '2.0', id: 1, error: { code: -1 } }), down, tokens))).ok).toBe(false);
  });

  it('the kill switch pauses for 1, true, yes or on, and for nothing else', async () => {
    for (const value of ['1', 'true', 'TRUE', 'yes', 'on', ' 1 ']) {
      process.env.ORIENTIM_DISABLED = value;
      expect((await checkHealth(hosts(height, height, tokens))).paused, value).toBe(true);
    }
    for (const value of ['', '0', 'false', 'no', 'off']) {
      process.env.ORIENTIM_DISABLED = value;
      expect((await checkHealth(hosts(height, height, tokens))).paused, value).toBe(false);
    }
  });

  it('/api/health asks the RPC and Jupiter at most every 15 seconds, whoever calls', async () => {
    const f = hosts(height, height, tokens);
    const t = 20_000_000;
    expect((await recentHealth(t, f)).ok).toBe(true);
    const asked = vi.mocked(f).mock.calls.length;
    expect((await recentHealth(t + 14_000, f)).ok).toBe(true);
    expect(vi.mocked(f).mock.calls.length).toBe(asked);
    expect((await recentHealth(t + 16_000, hosts(down, down, tokens))).ok).toBe(false);
  });

  it('paused by the kill switch is said, not counted as down; no URL or key in the answer', async () => {
    process.env.ORIENTIM_DISABLED = '1';
    const h = await checkHealth(hosts(height, height, tokens));
    expect(h.ok).toBe(true);
    expect(h.paused).toBe(true);
    expect(JSON.stringify(h)).not.toMatch(/rpc\.test|https?:/);
  });
});

describe('health of the agent API, as it runs', () => {
  const on = () => {
    apiOn();
    process.env.RPC_URL_AGENTS = 'https://agents.rpc.test/';
    process.env.JUPITER_API_KEY_AGENTS = 'agents-key';
  };
  /** fetch by host and path: the site's RPCs, the agent API's RPC, Jupiter's search and its build. */
  function world(agentsRpc: () => Response, build: () => Response, seen: string[] = []) {
    process.env.RPC_URL = 'https://main.rpc.test/';
    return vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const u = String(url);
      seen.push(`${u.split('?')[0]} ${JSON.stringify((init?.headers ?? {}) as Record<string, string>)}`);
      if (u.startsWith('https://main.')) return height();
      if (u.startsWith('https://agents.')) return agentsRpc();
      return u.includes('/swap/v2/build') ? build() : tokens();
    }) as unknown as typeof fetch;
  }

  it('with the API off, it is down and says so, while the site\'s services answer', async () => {
    const h = await checkHealth(world(down, down));
    expect(h).toMatchObject({ ok: false, agentApi: 'off', agents: null, rpc: { ok: true }, jupiter: { ok: true } });
  });

  it('with a setting the API refuses (a fee above 30 bps), it is off, so down', async () => {
    on();
    process.env.NEXT_PUBLIC_ORIENTIM_FEE_BPS = '31';
    try {
      const h = await checkHealth(world(height, built));
      expect(h).toMatchObject({ ok: false, agentApi: 'off' });
    } finally {
      delete process.env.NEXT_PUBLIC_ORIENTIM_FEE_BPS;
    }
  });

  it("checks the API's own RPC and a swap Jupiter builds with the API's own key", async () => {
    on();
    const seen: string[] = [];
    const h = await checkHealth(world(height, built, seen));
    expect(h).toMatchObject({ ok: true, agents: { rpc: { ok: true }, build: { ok: true } } });
    expect(seen.some(s => s.startsWith('https://agents.rpc.test/'))).toBe(true);
    expect(seen.find(s => s.startsWith('https://api.jup.ag/swap/v2/build'))).toContain('agents-key');
    expect(JSON.stringify(h)).not.toMatch(/rpc\.test|agents-key|https?:/);
  });

  it("is down when the site's services answer but the API's RPC does not, or Jupiter answers without a swap", async () => {
    on();
    const down503 = () => new Response('no', { status: 503 });
    expect((await checkHealth(world(down, built))).ok).toBe(false);
    expect((await checkHealth(world(height, down503))).ok).toBe(false);
    expect((await checkHealth(world(height, () => Response.json({ error: 'no route' })))).ok).toBe(false);
    // The site's own checks still pass in each case: only the API's are down.
    const h = await checkHealth(world(down, built));
    expect(h).toMatchObject({ rpc: { ok: true }, jupiter: { ok: true }, agents: { rpc: { ok: false } } });
  });
});

describe('the status page', () => {
  beforeEach(apiOn);

  it('says paused when the kill switch is on, degraded when a check fails, running otherwise', () => {
    expect(swapStateOf({ ok: true, paused: true })).toBe('paused');
    expect(swapStateOf({ ok: false, paused: true })).toBe('paused');
    expect(swapStateOf({ ok: false, paused: false })).toBe('degraded');
    expect(swapStateOf({ ok: true, paused: false })).toBe('running');
  });

  it('asks the RPC and Jupiter at most once a minute, then again', async () => {
    const f = hosts(height, height, tokens);
    const t = 10_000_000;
    expect(await swapState(t, f)).toBe('running');
    const asked = vi.mocked(f).mock.calls.length;
    expect(await swapState(t + 59_000, f)).toBe('running');
    expect(vi.mocked(f).mock.calls.length).toBe(asked);
    expect(await swapState(t + 61_000, hosts(down, down, tokens))).toBe('degraded');
  });
});
