import { createHash, timingSafeEqual } from 'node:crypto';
import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { isProduction, singleInstance } from './lib/server/env';

/** The header Cloudflare adds to every request it forwards (a request header rule), with ORIENTIM_ORIGIN_SECRET. */
export const ORIGIN_HEADER = 'x-orientim-origin';
/** Answered without the header: the host's own liveness check, which does nothing but say the process is up. */
const LIVE_PATH = '/api/live';

const digest = (s: string) => createHash('sha256').update(s).digest();

/** The shortest secret taken: docs/FLY.md makes one of 32 random bytes (43 characters). */
const MIN_SECRET_LENGTH = 32;

/**
 * Must this server sit behind Cloudflare? In production on one machine (Fly), or wherever the rate
 * limits count a client address from a header the edge sets (ORIENTIM_CLIENT_IP_HEADER): reached
 * directly, anyone could set that header. Not on Vercel, whose own header no client can set.
 */
export const edgeRequired = () => isProduction() && (singleInstance() || Boolean(process.env.ORIENTIM_CLIENT_IP_HEADER?.trim()));

let said = false;

/**
 * Behind Cloudflare, the server answers only what Cloudflare forwards: a request that reaches the host
 * directly (its own *.fly.dev name or its address) has no secret, so it never gets past the rate limits
 * and the firewall at the edge. Off when ORIENTIM_ORIGIN_SECRET is not set (Vercel, development).
 * Where the edge is required (edgeRequired), a missing or short secret answers nothing (originUnlocked).
 */
export function fromEdge(request: Request): boolean {
  const secret = process.env.ORIENTIM_ORIGIN_SECRET?.trim();
  if (!secret) return true;
  const given = request.headers.get(ORIGIN_HEADER);
  return given !== null && timingSafeEqual(digest(given), digest(secret));
}

/** Required behind the edge, and no secret of the length taken: the server answers nothing at all. */
export function originUnlocked(): boolean {
  if (!edgeRequired()) return false;
  const unlocked = (process.env.ORIENTIM_ORIGIN_SECRET?.trim().length ?? 0) < MIN_SECRET_LENGTH;
  if (unlocked && !said) {
    said = true;
    console.error(`ORIENTIM_ORIGIN_SECRET is not set, or shorter than ${MIN_SECRET_LENGTH} characters: in production behind Cloudflare every request, /api/live included, is answered 503 until it is.`);
  }
  return unlocked;
}

/**
 * Nonce-based CSP for every page. The developer page asks a wallet to sign Orientim's key message, so
 * injected script must not run: only scripts carrying this request's nonce, and what they load
 * ('strict-dynamic'). Images are limited to Orientim's origin and data: URIs, which also closes images
 * as a channel for sending data out. Styles keep 'unsafe-inline': CSS cannot run code, and with img-src
 * and connect-src closed it has no way to send anything out.
 */
export function proxy(request: NextRequest) {
  const path = request.nextUrl.pathname;
  // The liveness path too: the host's check fails, so a deploy without the secret never takes traffic.
  if (originUnlocked()) {
    return new NextResponse('Not configured', { status: 503, headers: { 'cache-control': 'no-store' } });
  }
  if (path !== LIVE_PATH && !fromEdge(request)) {
    return new NextResponse('Not found', { status: 404, headers: { 'cache-control': 'no-store' } });
  }
  // API answers and prefetches carry no page, so no CSP.
  const prefetch = request.headers.has('next-router-prefetch') || request.headers.get('purpose') === 'prefetch';
  if (path.startsWith('/api/') || path === '/api' || prefetch) return NextResponse.next();

  const nonce = Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString('base64');
  const dev = process.env.NODE_ENV === 'development';
  const csp = [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${dev ? " 'unsafe-eval'" : ''}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    `connect-src 'self'${dev ? ' ws: wss:' : ''}`,
    "font-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join('; ');

  const requestHeaders = new Headers(request.headers);
  requestHeaders.set('x-nonce', nonce);
  requestHeaders.set('Content-Security-Policy', csp);
  const response = NextResponse.next({ request: { headers: requestHeaders } });
  response.headers.set('Content-Security-Policy', csp);
  return response;
}

// Every request but Next's own static files and the icon, which are public and the same for everyone.
export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};
