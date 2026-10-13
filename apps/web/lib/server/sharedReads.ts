import type { SolanaRpc } from '@orientim/solana';

/**
 * Reads whose answer is the same for every swap, shared by the requests an instance serves: one call
 * answers all those that ask within its time, and a call still running is joined rather than repeated.
 * Nothing here depends on a wallet, a token or a route, so no swap can see another's state.
 *
 * - getLatestBlockhash, for half a second: a blockhash that old leaves a transaction about one block
 *   of its ~150 less to live. What a swap is checked against (its snapshot, its simulations) is read
 *   on its own, as before.
 * - getMinimumBalanceForRentExemption, for ten minutes: the cluster's rent, per account size.
 *
 * A failed call is never kept: the next request asks again.
 */
export const SHARED_READS_MS: Readonly<Record<string, number>> = {
  getLatestBlockhash: 500,
  getMinimumBalanceForRentExemption: 600_000,
};

type Pending = { answer: Promise<unknown>; until: number };
type Request = { send(o?: { abortSignal?: AbortSignal }): Promise<unknown> };

const keyOf = (method: string, args: unknown[]) =>
  `${method}:${JSON.stringify(args, (_, v) => (typeof v === 'bigint' ? `${v}n` : v))}`;

/** The caller's own signal still ends its own wait, never the shared call others wait on. */
function waitFor(answer: Promise<unknown>, signal: AbortSignal | undefined): Promise<unknown> {
  if (!signal) return answer;
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const stop = () => reject(signal.reason);
    signal.addEventListener('abort', stop, { once: true });
    answer.then(resolve, reject).finally(() => signal.removeEventListener('abort', stop));
  });
}

export function withSharedReads(rpc: SolanaRpc, ttl: Readonly<Record<string, number>> = SHARED_READS_MS, now = () => Date.now()): SolanaRpc {
  const kept = new Map<string, Pending>();
  return new Proxy(rpc as object, {
    get(target, method) {
      const call = (target as Record<string | symbol, unknown>)[method];
      if (typeof call !== 'function' || typeof method !== 'string' || !(method in ttl)) return call;
      return (...args: unknown[]): Request => {
        const request = (call as (...a: unknown[]) => Request).apply(target, args);
        return {
          ...request,
          send: (o?: { abortSignal?: AbortSignal }) => {
            const key = keyOf(method, args);
            const at = now();
            for (const [k, p] of kept) if (p.until <= at) kept.delete(k);
            let pending = kept.get(key);
            if (!pending) {
              const answer = request.send();
              pending = { answer, until: at + ttl[method] };
              kept.set(key, pending);
              const mine = pending;
              answer.catch(() => { if (kept.get(key) === mine) kept.delete(key); });
            }
            return waitFor(pending.answer, o?.abortSignal);
          },
        };
      };
    },
  }) as SolanaRpc;
}
