/**
 * The server-side controls (rate limits, client key, public status): they must hold for direct API calls.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { addressBucket, clientKey, limit, rateLimited, secondsUntilReset } from '../lib/server/rateLimit.ts';
import { memoryShared } from '../lib/server/shared.ts';
import type { Shared } from '../lib/server/shared.ts';

let n = 0;
const uniqueIp = () => `203.0.113.${++n % 250}-${n}`;

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.ORIENTIM_DISABLED;
  delete process.env.ORIENTIM_CLIENT_IP_HEADER;
});

describe('the client key comes only from the header the ingress overwrites', () => {
  const key = (headers: Record<string, string>) => clientKey(new Request('http://orientim.test/', { headers }));

  it('on Vercel (default) it reads x-vercel-forwarded-for and ignores every other header', () => {
    expect(key({ 'x-vercel-forwarded-for': '198.51.100.7', 'cf-connecting-ip': '1.1.1.1', 'x-forwarded-for': '2.2.2.2' })).toBe('198.51.100.7');
  });

  it('behind Cloudflare, a client-sent x-vercel-forwarded-for cannot mint a new identity', () => {
    process.env.ORIENTIM_CLIENT_IP_HEADER = 'cf-connecting-ip';
    expect(key({ 'cf-connecting-ip': '198.51.100.8', 'x-vercel-forwarded-for': 'spoofed-1' })).toBe('198.51.100.8');
    expect(key({ 'cf-connecting-ip': '198.51.100.8', 'x-vercel-forwarded-for': 'spoofed-2' })).toBe('198.51.100.8');
  });

  it('X-Forwarded-For, written by the client, is never used', () => {
    expect(key({ 'x-forwarded-for': 'spoofed, 198.51.100.9' })).toBe('unidentified');
  });

  it('requests without the configured header share one bucket (limited, not unlimited)', () => {
    expect(key({})).toBe('unidentified');
  });

  it('a window counts every request of the same key', () => {
    const k = `test:${uniqueIp()}`;
    for (let i = 0; i < 5; i++) expect(rateLimited(k, 5)).toBe(false);
    expect(rateLimited(k, 5)).toBe(true);
  });

  it('with Redis, a limit counts the requests every instance served, and says Retry-After from its window', async () => {
    const shared = memoryShared();
    const k = `keys-challenge:${uniqueIp()}`;
    // Another instance already served 30 challenges to this address within the hour.
    for (let i = 0; i < 30; i++) await shared.count(`orientim:rl:${k}`, 3_600_000);
    const wait = await limit(k, 30, 3_600_000, shared);
    expect(wait).toBeGreaterThan(3_500);
    expect(wait).toBeLessThanOrEqual(3_600);
    // Without Redis this instance's own count decides: one request is not over 30.
    expect(await limit(`keys-challenge:${uniqueIp()}`, 30, 3_600_000, null)).toBeNull();
  });

  it('when Redis does not answer, the instance limits on its own count, and a client over it is refused without asking Redis', async () => {
    let asked = 0;
    const broken = { kind: 'redis', count: async () => { asked++; throw new Error('redis down'); } } as unknown as Shared;
    const k = `agent:/api/v1/prepare:${uniqueIp()}`;
    for (let i = 0; i < 3; i++) expect(await limit(k, 3, 60_000, broken)).toBeNull();
    expect(asked).toBe(3);
    expect(await limit(k, 3, 60_000, broken)).toBeGreaterThan(0);
    expect(asked).toBe(3);
  });

  it('says how long until a window ends, for Retry-After', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      const t0 = Date.now() + 5 * 60_000;
      vi.setSystemTime(t0);
      const k = `test:retry:${uniqueIp()}`;
      rateLimited(k, 1);
      vi.setSystemTime(t0 + 45_500);
      expect(secondsUntilReset(k)).toBe(15);
    } finally {
      vi.useRealTimers();
    }
  });

  it("a flood of new keys in one limiter never limits another's clients, nor shares a window among newcomers", () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      // Far enough ahead that every earlier window has ended and the next call sweeps.
      const t0 = Date.now() + 10 * 60_000;
      vi.setSystemTime(t0);
      const agent = `agent:/api/v1/prepare:${uniqueIp()}`;
      rateLimited(agent, 60);
      const limited = `agent:/api/v1/prepare:${uniqueIp()}`;
      rateLimited(limited, 1);
      expect(rateLimited(limited, 1)).toBe(true);
      // Key challenges from 60,000 addresses, with hour-long windows.
      for (let i = 0; i < 60_000; i++) rateLimited(`flood:${t0}:${i}`, 30, 3_600_000);
      // Another limiter's windows are untouched, the limited one still limited.
      expect(rateLimited(agent, 60)).toBe(false);
      expect(rateLimited(limited, 1)).toBe(true);
      // Once an agent's window ends, its next one is its own again, not an hour-long shared one.
      vi.setSystemTime(t0 + 61_000);
      expect(rateLimited(agent, 60)).toBe(false);
      expect(rateLimited(`health:${uniqueIp()}`, 30)).toBe(false);
      expect(secondsUntilReset(agent)).toBe(60);
      // Within the flooded limiter, a newcomer gets a window of its own (the oldest makes room).
      const late = `flood:late:${uniqueIp()}`;
      expect(rateLimited(late, 1, 3_600_000)).toBe(false);
      expect(rateLimited(late, 1, 3_600_000)).toBe(true);
      expect(rateLimited(`flood:later:${uniqueIp()}`, 1, 3_600_000)).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('an IPv6 client is keyed by its /64, and an IPv4-mapped address by its IPv4 address', () => {
    expect(addressBucket('2001:db8:1:2:aaaa:bbbb:cccc:dddd')).toBe('2001:db8:1:2::/64');
    expect(addressBucket('2001:0db8:0001:0002::1')).toBe('2001:db8:1:2::/64');
    expect(addressBucket('[2001:db8:1:2::ffff]')).toBe('2001:db8:1:2::/64');
    expect(addressBucket('2001:db8::1')).toBe('2001:db8:0:0::/64');
    expect(addressBucket('::ffff:198.51.100.9')).toBe('198.51.100.9');
    expect(addressBucket('198.51.100.9')).toBe('198.51.100.9');
    expect(addressBucket('not-an-address')).toBe('not-an-address');
    const key = (h: Record<string, string>) => clientKey(new Request('https://x.test', { headers: h }));
    expect(key({ 'x-vercel-forwarded-for': '2001:db8:1:2::7' })).toBe(key({ 'x-vercel-forwarded-for': '2001:db8:1:2:ffff::9' }));
  });
});

describe('the public status and the settings behind it', () => {
  it('/api/status does not say whether the deployment has a Jupiter key: the operator reads it in the logs', async () => {
    const { publicStatus } = await import('../lib/server/config.ts');
    process.env.JUPITER_API_KEY = 'test-key';
    try {
      expect(Object.keys(publicStatus())).not.toContain('jupiterKey');
      // No per-swap USD cap: nothing enforced it, so nothing publishes one.
      expect(Object.keys(publicStatus()).sort()).toEqual(['build', 'enabled', 'excludeDexes', 'maxNetworkFeeLamports', 'skillVersion']);
      expect(JSON.stringify(publicStatus())).not.toContain('test-key');
    } finally {
      delete process.env.JUPITER_API_KEY;
    }
  });
});

describe('the package the site points agents to', () => {
  it('is the version installed and pinned here, so the site names only what it was tested with', async () => {
    const { SKILL_VERSION, SKILL_EXTENSION } = await import('../lib/server/skill.ts');
    const { readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const root = join(import.meta.dirname, '../../..');
    const installed = JSON.parse(readFileSync(join(root, 'node_modules/@orientimhq/swap/package.json'), 'utf8')).version;
    expect(SKILL_VERSION).toBe(installed);
    expect(JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).dependencies['@orientimhq/swap']).toBe(SKILL_VERSION);
    expect(JSON.parse(readFileSync(join(root, 'apps/web/package.json'), 'utf8')).dependencies['@orientimhq/swap']).toBe(SKILL_VERSION);
    const { SKILL_VERSION: packaged } = await import('@orientimhq/swap');
    expect(packaged).toBe(SKILL_VERSION);
    expect(SKILL_EXTENSION).toContain(`/v${SKILL_VERSION}/orientim.mcpb`);
  });

  it('AGENT-API.md is the reference the package ships', async () => {
    const { readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const root = join(import.meta.dirname, '../../..');
    expect(readFileSync(join(root, 'AGENT-API.md'), 'utf8'))
      .toBe(readFileSync(join(root, 'node_modules/@orientimhq/swap/skills/orientim-protected-swap/reference/AGENT-API.md'), 'utf8'));
  });
});
