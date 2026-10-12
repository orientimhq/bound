/**
 * Fixed-window rate limit kept in memory, per instance. Nothing is persisted and nothing about the
 * request body is recorded: only a counter per client key for the current window.
 *
 * This is a local layer only. A limit that holds across instances belongs to the hosting
 * platform's own rate-limit rules (e.g. the Vercel firewall), not to a database of ours.
 */
const windows = new Map<string, { count: number; resetAt: number }>();
const MAX_KEYS = 50_000;
/** The one window clients share while the map is full. */
const OVERFLOW = 'overflow:';
let nextSweep = 0;

/**
 * A request another website's page made from its visitor's browser (Sec-Fetch-Site: cross-site). The
 * proxies exist for Orientim's own page: refusing these stops other sites from spending Orientim's RPC and
 * Jupiter quota through their users. A script that is not a browser sends no such header and meets
 * the per-client limits and the host's firewall instead (README, "Deploy").
 */
export const fromAnotherSite = (req: Request) => req.headers.get('sec-fetch-site') === 'cross-site';

export function rateLimited(key: string, limit: number, windowMs = 60_000): boolean {
  const now = Date.now();
  // Sweep expired windows at most once a minute instead of scanning inside every request.
  if (now >= nextSweep) {
    for (const [k, w] of windows) if (w.resetAt <= now) windows.delete(k);
    nextSweep = now + 60_000;
  }
  // Under a flood of new keys, every client without a window yet shares one, and no window that
  // already counts is dropped: a flood cannot reset its own or anyone else's count.
  if (windows.size >= MAX_KEYS && !windows.has(key)) key = OVERFLOW;
  const w = windows.get(key);
  if (!w || w.resetAt <= now) {
    windows.set(key, { count: 1, resetAt: now + windowMs });
    return false;
  }
  w.count++;
  return w.count > limit;
}

/** Whole seconds until `key`'s window ends: what a Retry-After should say once it is limited. */
export function secondsUntilReset(key: string): number {
  const w = windows.get(key) ?? windows.get(OVERFLOW);
  return w ? Math.max(1, Math.ceil((w.resetAt - Date.now()) / 1000)) : 1;
}

/**
 * The client address, from the one header the deployment's ingress overwrites.
 * Which header that is depends on where Orientim runs, so it is configuration, never a guess:
 * `ORIENTIM_CLIENT_IP_HEADER` (default `x-vercel-forwarded-for`, which Vercel sets itself; behind
 * Cloudflare use `cf-connecting-ip`). Any other client-supplied header is ignored. Without the
 * configured header every request shares one bucket, which fails towards limiting, not bypass.
 */
export function clientKey(req: Request): string {
  const header = (process.env.ORIENTIM_CLIENT_IP_HEADER || 'x-vercel-forwarded-for').toLowerCase();
  const value = req.headers.get(header)?.split(',')[0].trim();
  return value ? addressBucket(value) : 'unidentified';
}

/**
 * One bucket per IPv4 address, and per /64 for IPv6: a single subscriber usually holds a whole /64,
 * so keying each IPv6 address apart would give one client 2^64 buckets. An IPv4-mapped IPv6
 * address is its IPv4 address. Anything that is not an address is kept as it is.
 */
export function addressBucket(value: string): string {
  let a = value.trim().toLowerCase();
  if (a.startsWith('[')) a = a.slice(1, a.indexOf(']') === -1 ? undefined : a.indexOf(']'));
  a = a.split('%')[0];
  if (!a.includes(':')) return a;
  const mapped = /^[0:]*:ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(a);
  if (mapped) return mapped[1];
  const halves = a.split('::');
  if (halves.length > 2) return a;
  const part = (h: string) => (h === '' ? [] : h.split(':'));
  const head = part(halves[0]);
  const tail = halves.length === 2 ? part(halves[1]) : [];
  if (tail.some(x => x.includes('.')) || head.some(x => x.includes('.'))) return a;
  const groups = halves.length === 2 ? [...head, ...Array(Math.max(0, 8 - head.length - tail.length)).fill('0'), ...tail] : head;
  if (groups.length !== 8 || groups.some(g => !/^[0-9a-f]{1,4}$/.test(g))) return a;
  return `${groups.slice(0, 4).map(g => parseInt(g, 16).toString(16)).join(':')}::/64`;
}
