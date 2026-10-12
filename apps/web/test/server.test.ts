/**
 * The server-side controls (rate limits, client key, public status): they must hold for direct API calls.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { addressBucket, clientKey, rateLimited, secondsUntilReset } from '../lib/server/rateLimit.ts';

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

  it('a flood of new keys resets no window: while the map is full, new clients share one window', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      // Far enough ahead that every earlier window has ended and the next call sweeps.
      const t0 = Date.now() + 10 * 60_000;
      vi.setSystemTime(t0);
      rateLimited(`test:sweep:${uniqueIp()}`, 5);
      const a = `test:limited:${uniqueIp()}`;
      rateLimited(a, 1);
      expect(rateLimited(a, 1)).toBe(true);
      // The oldest window of all, and still limited after the map fills behind it.
      for (let i = 0; i < 60_000; i++) rateLimited(`test:flood:${t0}:${i}`, 1_000_000);
      expect(rateLimited(a, 1)).toBe(true);
      // A new client meets the shared window the flood already spent.
      expect(rateLimited(`test:late:${uniqueIp()}`, 5)).toBe(true);
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

describe('the skill hashes the site publishes', () => {
  it('/skill/SHA256SUMS lists every shipped file, with the version, and matches the skill folder', async () => {
    const { GET } = await import('../app/skill/SHA256SUMS/route.ts');
    const res = GET();
    const text = await res.text();
    const { readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const onDisk = readFileSync(join(import.meta.dirname, '../../../skills/orientim-protected-swap/SHA256SUMS'), 'utf8').replace(/\r\n/g, '\n');
    expect(text).toBe(onDisk);
    expect(text).toMatch(/^[0-9a-f]{64} {2}lib\/orientim-verify\.mjs$/m);
    expect(res.headers.get('x-orientim-skill-version')).toBe(JSON.parse(readFileSync(join(import.meta.dirname, '../../../skills/orientim-protected-swap/package.json'), 'utf8')).version);
  });
});
