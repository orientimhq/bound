import { createHash, timingSafeEqual } from 'node:crypto';
import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

/** The header Cloudflare adds to every request it forwards (a request header rule), with ORIENTIM_ORIGIN_SECRET. */
export const ORIGIN_HEADER = 'x-orientim-origin';
/** Answered without the header: the host's own liveness check, which does nothing but say the process is up. */
const LIVE_PATH = '/api/live';

const digest = (s: string) => createHash('sha256').update(s).digest();

/**
 * Behind Cloudflare, the server answers only what Cloudflare forwards: a request that reaches the host
 * directly (its own *.fly.dev name or its address) has no secret, so it never gets past the rate limits
 * and the firewall at the edge. Off when ORIENTIM_ORIGIN_SECRET is not set (Vercel, development).
 */
export function fromEdge(request: Request): boolean {
  const secret = process.env.ORIENTIM_ORIGIN_SECRET?.trim();
  if (!secret) return true;
  const given = request.headers.get(ORIGIN_HEADER);
  return given !== null && timingSafeEqual(digest(given), digest(secret));
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
