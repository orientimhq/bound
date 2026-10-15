import { Redis } from '@upstash/redis';

/**
 * State every instance of the deployment sees at once: Redis (Upstash, over REST), when the
 * deployment has one. Serverless instances share no memory, so whatever must hold across them (one
 * message per one-time key, one swap in flight per output account, the rate limits, the RPC's
 * health) is kept here. Without Redis, `memoryShared` keeps the same state per instance, as before.
 *
 * Every key starts with `orientim:` and expires on its own; nothing about a request's body is kept.
 */
export interface Shared {
  /** Which kind: "redis" holds across instances, "memory" within this one. */
  readonly kind: 'redis' | 'memory';
  /** Sets `key` to `value` for `ttlMs` unless it is set: the value it already had, or null when set now. */
  claim(key: string, value: string, ttlMs: number): Promise<string | null>;
  /** Sets `key` to `value` for `ttlMs` only while it is `was`: did it? */
  replace(key: string, was: string, value: string, ttlMs: number): Promise<boolean>;
  /** Removes `key` only while it is `was`. */
  drop(key: string, was: string): Promise<void>;
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ttlMs: number): Promise<void>;
  /** One more in `key`'s window of `windowMs` (begun by the first): the count, and the window's ms left. */
  count(key: string, windowMs: number): Promise<{ count: number; ms: number }>;
}

/** How long one call to Redis may take before the caller treats it as down. */
export const SHARED_TIMEOUT_MS = 1_500;

const CLAIM = `local v = redis.call('GET', KEYS[1])
if v then return v end
redis.call('SET', KEYS[1], ARGV[1], 'PX', ARGV[2])
return false`;
const REPLACE = `if redis.call('GET', KEYS[1]) == ARGV[1] then
  redis.call('SET', KEYS[1], ARGV[2], 'PX', ARGV[3])
  return 1
end
return 0`;
const DROP = `if redis.call('GET', KEYS[1]) == ARGV[1] then redis.call('DEL', KEYS[1]) end
return 0`;
// A window begins with its first request and ends windowMs later, for every instance alike. A key
// left without an expiry (it cannot happen through this script) is given one rather than kept forever.
const COUNT = `local n = redis.call('INCR', KEYS[1])
if n == 1 then redis.call('PEXPIRE', KEYS[1], ARGV[1]) end
local t = redis.call('PTTL', KEYS[1])
if t < 0 then
  redis.call('PEXPIRE', KEYS[1], ARGV[1])
  t = tonumber(ARGV[1])
end
return {n, t}`;

const ttl = (ms: number) => String(Math.max(1, Math.ceil(ms)));

export function redisShared(url: string, token: string): Shared {
  const redis = new Redis({
    url,
    token,
    // One quick retry at most: a caller waiting on Redis is a request waiting, and each has a fallback.
    retry: { retries: 1, backoff: () => 50 },
    signal: () => AbortSignal.timeout(SHARED_TIMEOUT_MS),
    automaticDeserialization: false,
    enableTelemetry: false,
  });
  const text = (v: unknown) => (v === null || v === undefined || v === false ? null : String(v));
  return {
    kind: 'redis',
    async claim(key, value, ms) {
      return text(await redis.eval(CLAIM, [key], [value, ttl(ms)]));
    },
    async replace(key, was, value, ms) {
      return Number(await redis.eval(REPLACE, [key], [was, value, ttl(ms)])) === 1;
    },
    async drop(key, was) {
      await redis.eval(DROP, [key], [was]);
    },
    async get(key) {
      return text(await redis.get(key));
    },
    async set(key, value, ms) {
      await redis.set(key, value, { px: Math.max(1, Math.ceil(ms)) });
    },
    async count(key, windowMs) {
      const [n, t] = (await redis.eval(COUNT, [key], [ttl(windowMs)])) as [number, number];
      return { count: Number(n), ms: Number(t) };
    },
  };
}

/** The same state in this instance's memory, at most `max` keys (the soonest to expire go first). */
export function memoryShared(max = 50_000, now: () => number = Date.now): Shared {
  const kept = new Map<string, { value: string; until: number }>();
  const live = (key: string) => {
    const k = kept.get(key);
    if (!k) return null;
    if (k.until > now()) return k;
    kept.delete(key);
    return null;
  };
  const put = (key: string, value: string, ms: number) => {
    if (!kept.has(key) && kept.size >= max) {
      const t = now();
      for (const [k, v] of kept) if (v.until <= t) kept.delete(k);
      if (kept.size >= max) {
        let first: string | null = null;
        let soonest = Infinity;
        for (const [k, v] of kept) if (v.until < soonest) [first, soonest] = [k, v.until];
        if (first !== null) kept.delete(first);
      }
    }
    kept.set(key, { value, until: now() + Math.max(1, ms) });
  };
  return {
    kind: 'memory',
    async claim(key, value, ms) {
      const had = live(key);
      if (had) return had.value;
      put(key, value, ms);
      return null;
    },
    async replace(key, was, value, ms) {
      if (live(key)?.value !== was) return false;
      put(key, value, ms);
      return true;
    },
    async drop(key, was) {
      if (live(key)?.value === was) kept.delete(key);
    },
    async get(key) {
      return live(key)?.value ?? null;
    },
    async set(key, value, ms) {
      put(key, value, ms);
    },
    async count(key, windowMs) {
      const had = live(key);
      if (!had) {
        put(key, '1', windowMs);
        return { count: 1, ms: windowMs };
      }
      had.value = String(Number(had.value) + 1);
      return { count: Number(had.value), ms: had.until - now() };
    },
  };
}

let fromEnv: { for: string; shared: Shared | null } | null = null;
let local: Shared | null = null;

/**
 * The deployment's Redis: UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN, or the KV_REST_API_URL
 * and KV_REST_API_TOKEN that Vercel's Upstash integration sets. Null without them.
 */
export function redisFromEnv(): Shared | null {
  const url = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL || '';
  const token = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN || '';
  const identity = `${url}|${token}`;
  if (fromEnv?.for !== identity) {
    fromEnv = { for: identity, shared: url && token ? redisShared(url, token) : null };
    if (!fromEnv.shared && process.env.VERCEL_ENV === 'production') {
      console.warn('No Redis (UPSTASH_REDIS_REST_URL / KV_REST_API_URL): one message per one-time key, one swap in flight per output account, the rate limits and the RPC failover hold per instance only.');
    }
  }
  return fromEnv.shared;
}

/** Redis when the deployment has it, else this instance's memory. */
export function sharedState(): Shared {
  return redisFromEnv() ?? (local ??= memoryShared());
}
