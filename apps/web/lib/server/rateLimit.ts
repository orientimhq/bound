import { redisFromEnv, type Shared } from './shared';

/**
 * Fixed-window rate limits. `limit` counts in Redis when the deployment has it, so that a limit holds
 * across instances (shared.ts), and in this instance's memory otherwise. Nothing about the request
 * body is recorded: only a counter per client key for the current window.
 *
 * The hosting firewall's own rules (e.g. Vercel's) stay in front: they hold under a flood, which no
 * counter behind the function can.
 */
type Window = { count: number; resetAt: number };
/**
 * One map per limiter, the key's prefix up to its first colon (`agent`, `health`, `keys-challenge`,
 * `keys-wallet`...): a flood of new keys in one limiter makes room only in its own, so addresses
 * rented by the thousand for key challenges cannot touch an agent's per-key count or the health
 * check's. Each map is in the order its windows began.
 */
const limiters = new Map<string, Map<string, Window>>();
/** Windows kept per limiter. */
const MAX_KEYS = 50_000;
let nextSweep = 0;

const limiterOf = (key: string) => {
  const colon = key.indexOf(':');
  return colon === -1 ? key : key.slice(0, colon);
};

/**
 * Room for one more window in a full limiter: the windows that have ended, else the oldest. A limiter
 * gives all its windows one length, so those that ended are the first in its order (one cut short to
 * Redis's window, in `limit`, may wait for the sweep). The oldest
 * client's count starts again, which a flood in its own limiter can do; a single window shared by
 * every newcomer (what this replaced) let one flood lock out everyone, across limiters, for the
 * longest window any of them had.
 */
function makeRoom(windows: Map<string, Window>, now: number) {
  for (const [k, w] of windows) {
    if (w.resetAt > now) break;
    windows.delete(k);
  }
  if (windows.size >= MAX_KEYS) windows.delete(windows.keys().next().value!);
}

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
    for (const windows of limiters.values()) for (const [k, w] of windows) if (w.resetAt <= now) windows.delete(k);
    nextSweep = now + 60_000;
  }
  const name = limiterOf(key);
  let windows = limiters.get(name);
  if (!windows) limiters.set(name, (windows = new Map()));
  const w = windows.get(key);
  if (!w || w.resetAt <= now) {
    if (!w && windows.size >= MAX_KEYS) makeRoom(windows, now);
    // Taken out and put back, so that the map stays in the order the windows began.
    windows.delete(key);
    windows.set(key, { count: 1, resetAt: now + windowMs });
    return false;
  }
  w.count++;
  return w.count > limit;
}

/**
 * Is `key` over `limit` requests in its window of `windowMs`? The whole seconds a Retry-After should
 * say when it is, else null. Counted in Redis when the deployment has it: every instance then counts
 * the same window. This instance's own count comes first, so that a client already over the limit
 * here is refused without asking Redis. That holds because it is never more than the shared one: each
 * request it counts, Redis counts too, and its window is ended when Redis's ends, never later (the
 * shared window may have begun on another instance, before this one's). When Redis does not answer,
 * the instance's count alone decides, as it did before Redis.
 */
export async function limit(key: string, limit: number, windowMs = 60_000, shared: Shared | null = redisFromEnv()): Promise<number | null> {
  const here = rateLimited(key, limit, windowMs);
  if (here || !shared) return here ? secondsUntilReset(key) : null;
  try {
    const { count, ms } = await shared.count(`orientim:rl:${key}`, windowMs);
    const w = limiters.get(limiterOf(key))?.get(key);
    if (w) w.resetAt = Math.min(w.resetAt, Date.now() + ms);
    return count > limit ? Math.max(1, Math.ceil(ms / 1000)) : null;
  } catch {
    return null;
  }
}

/** Whole seconds until `key`'s window ends: what a Retry-After should say once it is limited. */
export function secondsUntilReset(key: string): number {
  const w = limiters.get(limiterOf(key))?.get(key);
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
