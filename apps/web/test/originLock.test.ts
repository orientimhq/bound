/**
 * Behind Cloudflare (ORIENTIM_ORIGIN_SECRET), the server answers only requests that carry the secret
 * the edge adds; a request straight to the host gets 404, pages and API alike. The host's liveness
 * check is the one path answered without it. Pages keep their CSP; API answers carry none.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { NextRequest } from 'next/server';
import { ORIGIN_HEADER, proxy } from '../proxy.ts';

const SECRET = 'a-long-random-origin-secret-for-tests-0001';
const at = (path: string, headers: Record<string, string> = {}) => proxy(new NextRequest(`https://orientim.com${path}`, { headers }));

describe('the origin lock', () => {
  afterEach(() => { delete process.env.ORIENTIM_ORIGIN_SECRET; });

  it('is off without ORIENTIM_ORIGIN_SECRET: every request is served, pages with their CSP', () => {
    const page = at('/');
    expect(page.status).toBe(200);
    expect(page.headers.get('content-security-policy')).toContain("script-src 'self' 'nonce-");
    expect(at('/api/status').headers.get('content-security-policy')).toBeNull();
  });

  it('with it, a request without the secret or with another one is 404, page or API', () => {
    process.env.ORIENTIM_ORIGIN_SECRET = SECRET;
    for (const path of ['/', '/developers', '/api/status', '/api/health', '/api/v1/prepare']) {
      expect(at(path).status).toBe(404);
      expect(at(path, { [ORIGIN_HEADER]: `${SECRET}x` }).status).toBe(404);
      expect(at(path, { [ORIGIN_HEADER]: '' }).status).toBe(404);
    }
  });

  it('with the secret, the request is served as without the lock', () => {
    process.env.ORIENTIM_ORIGIN_SECRET = SECRET;
    const page = at('/', { [ORIGIN_HEADER]: SECRET });
    expect(page.status).toBe(200);
    expect(page.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
    expect(at('/api/v1/prepare', { [ORIGIN_HEADER]: SECRET }).status).toBe(200);
  });

  it('the liveness path answers without the secret; /api/health does not', () => {
    process.env.ORIENTIM_ORIGIN_SECRET = SECRET;
    expect(at('/api/live').status).toBe(200);
    expect(at('/api/health').status).toBe(404);
  });

  it('a prefetch is served without a CSP, as before', () => {
    expect(at('/developers', { 'next-router-prefetch': '1' }).headers.get('content-security-policy')).toBeNull();
  });
});
