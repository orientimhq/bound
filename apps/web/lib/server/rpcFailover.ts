import { createDefaultRpcTransport, createSolanaRpcFromTransport } from '@solana/kit';
import { createRetryingRpc, httpStatusOf, retryingTransport } from '@orientim/solana';
import type { SolanaRpc } from '@orientim/solana';

type Transport = ReturnType<typeof createDefaultRpcTransport>;
type Config = Parameters<Transport>[0];

/**
 * How long one call may take, the main RPC and the backup together. The agent API's shortest route
 * (finalize) may run 30 s: 25 s leaves it time to answer after the RPC gave up.
 */
export type FailoverTimes = {
  /** The main RPC and the backup together, from the moment the call starts. */
  totalMs: number;
  /** One attempt at the main RPC: the backup is left at least the rest of the total. */
  attemptMs: number;
  /** A send is not started on the backup with less time than this left: it would be cut off mid-way. */
  minSendMs: number;
};
export const FAILOVER_TIMES: FailoverTimes = { totalMs: 25_000, attemptMs: 15_000, minSendMs: 5_000 };

/** The caller's own signal, if any, and the call's deadline: whichever ends first ends the request. */
function until(own: AbortSignal | undefined, ms: number): AbortSignal {
  const limit = AbortSignal.timeout(Math.max(0, ms));
  return own && typeof AbortSignal.any === 'function' ? AbortSignal.any([own, limit]) : own ?? limit;
}

/**
 * The agent API's RPC, with the operator's backup (RPC_URL_FALLBACK) behind the main one. The backup is asked when the main RPC does not answer, is
 * still rate-limited after its retries, or fails (5xx). A read takes the backup's answer; a send
 * takes it only when it is a success, since a refusal from the backup says nothing about what the
 * main RPC may already have broadcast.
 *
 * Both share one deadline (`times.totalMs`): the backup gets only what the main RPC left, so a main
 * RPC that hangs cannot make the call outlast the function it runs in.
 */
export function createServerRpc(primary: string, fallback: string | null, times: FailoverTimes = FAILOVER_TIMES): SolanaRpc {
  if (!fallback || fallback === primary) return createRetryingRpc(primary);
  // A rate-limited main RPC is retried twice, not five times: the backup is there to take the call.
  const main = retryingTransport(createDefaultRpcTransport({ url: primary as `https://${string}` }), 2, 500, times.attemptMs);
  const backup = retryingTransport(createDefaultRpcTransport({ url: fallback as `https://${string}` }), 3, 500, times.totalMs);
  const transport = (async (config: Config) => {
    const deadline = Date.now() + times.totalMs;
    const own = (config as { signal?: AbortSignal }).signal;
    try {
      return await main({ ...config, signal: until(own, times.totalMs) } as Config);
    } catch (e) {
      // The caller's own cancel is not an outage; neither is an HTTP error that is not one (4xx).
      if (own?.aborted) throw e;
      const status = httpStatusOf(e);
      if (status !== null && status !== 429 && status < 500) throw e;
      const left = deadline - Date.now();
      const method = (config as { payload?: { method?: unknown } }).payload?.method;
      if (method !== 'sendTransaction') {
        if (left <= 0) throw e;
        return backup({ ...config, signal: until(own, left) } as Config);
      }
      if (left < times.minSendMs) throw e;
      let answer: unknown;
      try {
        answer = await backup({ ...config, signal: until(own, left) } as Config);
      } catch {
        throw e;
      }
      if (answer !== null && typeof answer === 'object' && 'result' in answer && !('error' in answer)) return answer;
      throw e;
    }
  }) as Transport;
  return createSolanaRpcFromTransport(transport) as unknown as SolanaRpc;
}
