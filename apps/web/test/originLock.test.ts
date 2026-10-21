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
  afterEach(() => {
    for (const k of ['ORIENTIM_ORIGIN_SECRET', 'ORIENTIM_ENV', 'ORIENTIM_SINGLE_INSTANCE', 'ORIENTIM_CLIENT_IP_HEADER', 'VERCEL_ENV']) delete process.env[k];
  });

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

  it('in production behind the edge, no secret or a short one answers 503 everywhere, /api/live included', () => {
    for (const setup of [{ ORIENTIM_SINGLE_INSTANCE: '1' }, { ORIENTIM_CLIENT_IP_HEADER: 'cf-connecting-ip' }]) {
      Object.assign(process.env, { ORIENTIM_ENV: 'production' }, setup);
      for (const secret of [undefined, '', 'short-secret']) {
        if (secret === undefined) delete process.env.ORIENTIM_ORIGIN_SECRET;
        else process.env.ORIENTIM_ORIGIN_SECRET = secret;
        for (const path of ['/', '/api/live', '/api/health', '/api/v1/prepare']) {
          expect(at(path).status).toBe(503);
          expect(at(path, { [ORIGIN_HEADER]: secret ?? '' }).status).toBe(503);
        }
      }
      process.env.ORIENTIM_ORIGIN_SECRET = SECRET;
      expect(at('/api/live').status).toBe(200);
      expect(at('/api/v1/prepare').status).toBe(404);
      expect(at('/api/v1/prepare', { [ORIGIN_HEADER]: SECRET }).status).toBe(200);
      for (const k of ['ORIENTIM_ENV', 'ORIENTIM_SINGLE_INSTANCE', 'ORIENTIM_CLIENT_IP_HEADER']) delete process.env[k];
    }
  });

  it("Vercel's production, development and a single instance outside production keep serving without a secret", () => {
    for (const setup of [{ VERCEL_ENV: 'production' }, {}, { ORIENTIM_SINGLE_INSTANCE: '1' }]) {
      Object.assign(process.env, setup);
      expect(at('/').status).toBe(200);
      expect(at('/api/live').status).toBe(200);
      for (const k of Object.keys(setup)) delete process.env[k];
    }
  });
});
