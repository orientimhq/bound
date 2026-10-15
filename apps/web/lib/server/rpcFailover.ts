import { createDefaultRpcTransport, createSolanaRpcFromTransport } from '@solana/kit';
import { createRetryingRpc, httpStatusOf, retryingTransport } from '@orientimhq/swap/solana';
import type { SolanaRpc } from '@orientimhq/swap/solana';

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
  /**
   * Once the main RPC is judged down, how long calls go straight to the backup. Without it, a main
   * RPC that hangs makes each of a swap's dozen calls wait `attemptMs` first, and no swap fits in
   * its deadline although the backup answers (the capacity simulation, phase 4).
   */
  downMs: number;
  /**
   * Two quick failures of the main RPC this close together judge it down (default 10 s). A slow
   * failure, an attempt that ran for half of `attemptMs` or more, judges it down at once.
   */
  strikeMs?: number;
  /**
   * While the main RPC is passed over, a read at most this often also asks it, in the background,
   * and a success ends the wait early (default 5 s).
   */
  probeMs?: number;
};
export const FAILOVER_TIMES: FailoverTimes = { totalMs: 25_000, attemptMs: 15_000, minSendMs: 5_000, downMs: 30_000, strikeMs: 10_000, probeMs: 5_000 };

/**
 * How long a send the main RPC may have taken stays "possibly broadcast" here: past a blockhash's
 * life (150 blocks, a minute or so), with room to spare.
 */
const MAIN_MAY_HAVE_MS = 180_000;
const MAIN_MAY_HAVE_MAX = 10_000;

/** The caller's own signal, if any, and the call's deadline: whichever ends first ends the request. */
function until(own: AbortSignal | undefined, ms: number): AbortSignal {
  const limit = AbortSignal.timeout(Math.max(0, ms));
  return own && typeof AbortSignal.any === 'function' ? AbortSignal.any([own, limit]) : own ?? limit;
}

/**
 * The agent API's RPC, with the operator's backup (RPC_URL_FALLBACK) behind the main one. The backup
 * is asked when the main RPC does not answer, is still rate-limited after its retries, or fails
 * (5xx). A read takes the backup's answer; a send takes it only when it is a success, since a
 * refusal from the backup says nothing about what the main RPC may already have broadcast.
 *
 * Both share one deadline (`times.totalMs`): the backup gets only what the main RPC left, so a main
 * RPC that hangs cannot make the call outlast the function it runs in.
 *
 * When the main RPC is judged down, calls go to the backup first for `downMs`. It is judged down by
 * a slow failure (what the wait saves is exactly that slowness), or by two quick ones within
 * `strikeMs`: one 502 or one dropped connection is a blip that costs a single quick fallback, and
 * pinning a whole instance to the backup over it would make the backup's health everyone's. The wait
 * ends early when the backup fails a call (the main RPC is then asked with the time left), or when a
 * read sent to the main RPC in the background answers (one every `probeMs`).
 */
export function createServerRpc(primary: string, fallback: string | null, times: FailoverTimes = FAILOVER_TIMES): SolanaRpc {
  if (!fallback || fallback === primary) return createRetryingRpc(primary);
  // A rate-limited main RPC is retried twice, not five times: the backup is there to take the call.
  const main = retryingTransport(createDefaultRpcTransport({ url: primary as `https://${string}` }), 2, 500, times.attemptMs);
  const backup = retryingTransport(createDefaultRpcTransport({ url: fallback as `https://${string}` }), 3, 500, times.totalMs);
  const strikeMs = times.strikeMs ?? 10_000;
  const probeMs = times.probeMs ?? 5_000;
  // Until when the main RPC is passed over. `pins` counts the times it was judged down, so that a
  // call that began before a later judgement cannot undo it when it ends.
  let mainDownUntil = 0;
  let pins = 0;
  let lastQuickFailure = 0;
  let nextProbe = 0;
  // Every transaction this instance gave the main RPC, until it can no longer land: whatever the main
  // RPC answered then, it may have it (a success, an answer lost on the way back, or an earlier
  // send), so a refusal from the backup alone never says it was not broadcast. Per instance, like
  // all of this: another instance's sends are the chain's to tell (finalize reads it first).
  const mainMayHave = new Map<string, number>();

  const judgeDown = () => {
    pins++;
    mainDownUntil = Date.now() + times.downMs;
    nextProbe = Date.now() + probeMs;
    lastQuickFailure = 0;
  };
  /** The main RPC failed a call that took `ms`: judged down now, or on a second quick failure. */
  const mainFailed = (ms: number) => {
    const now = Date.now();
    if (ms >= times.attemptMs / 2 || (lastQuickFailure !== 0 && now - lastQuickFailure <= strikeMs)) judgeDown();
    else lastQuickFailure = now;
  };
  /** The main RPC answered a call that began while `pinsAtStart` judgements had been made. */
  const mainAnswered = (pinsAtStart: number) => {
    if (pins !== pinsAtStart) return;
    mainDownUntil = 0;
    lastQuickFailure = 0;
  };
  /** The backup failed while the main RPC was passed over: stop passing it over, unless judged anew. */
  const backupFailed = (pinsAtStart: number) => {
    if (pins === pinsAtStart) mainDownUntil = 0;
  };
  const wireOf = (config: Config) => {
    const first = (config as { payload?: { params?: unknown[] } }).payload?.params?.[0];
    return typeof first === 'string' ? first : null;
  };
  const mainMayHaveSent = (wire: string | null) => {
    if (wire === null) return;
    const now = Date.now();
    if (mainMayHave.size >= MAIN_MAY_HAVE_MAX) {
      for (const [w, until] of mainMayHave) if (until <= now) mainMayHave.delete(w);
      // Still full: the oldest goes. Its transaction is past the time it could land in most cases.
      if (mainMayHave.size >= MAIN_MAY_HAVE_MAX) mainMayHave.delete(mainMayHave.keys().next().value!);
    }
    mainMayHave.set(wire, now + MAIN_MAY_HAVE_MS);
  };
  const mainMayHaveIt = (wire: string | null) => wire !== null && (mainMayHave.get(wire) ?? 0) > Date.now();
  const succeeded = (answer: unknown) => answer !== null && typeof answer === 'object' && 'result' in answer && !('error' in answer);
  /** An HTTP refusal (not 429): the RPC did not take the request at all. */
  const refusedOutright = (e: unknown) => {
    const status = httpStatusOf(e);
    return status !== null && status !== 429 && status < 500;
  };

  /** A read the main RPC is also asked in the background, while passed over: its answer may end the wait. */
  const probe = (config: Config) => {
    if (Date.now() < nextProbe) return;
    nextProbe = Date.now() + probeMs;
    const at = pins;
    // Not the caller's signal: the caller has its answer from the backup and may be gone.
    main({ ...config, signal: AbortSignal.timeout(times.attemptMs) } as Config).then(() => mainAnswered(at), () => undefined);
  };

  const transport = (async (config: Config) => {
    const deadline = Date.now() + times.totalMs;
    const own = (config as { signal?: AbortSignal }).signal;
    const method = (config as { payload?: { method?: unknown } }).payload?.method;
    const send = method === 'sendTransaction';
    const wire = send ? wireOf(config) : null;

    if (Date.now() < mainDownUntil) {
      // The main RPC is passed over: the backup first, for one attempt's time, so that the main RPC
      // still has the rest if the backup fails too.
      const at = pins;
      if (!send) probe(config);
      let answer: unknown;
      try {
        answer = await backup({ ...config, signal: until(own, times.attemptMs) } as Config);
      } catch (e) {
        if (own?.aborted) throw e;
        backupFailed(at);
        const left = deadline - Date.now();
        if (left <= 0 || (send && left < times.minSendMs)) throw e;
        const started = Date.now();
        const pinsNow = pins;
        if (send) mainMayHaveSent(wire);
        let fromMain: unknown;
        try {
          fromMain = await main({ ...config, signal: until(own, left) } as Config);
        } catch (m) {
          if (!own?.aborted && !refusedOutright(m)) mainFailed(Date.now() - started);
          throw m;
        }
        mainAnswered(pinsNow);
        // A backup that refused the request outright (an HTTP 4xx) never had the transaction: the
        // main RPC's answer stands, as when it is asked first. One that failed otherwise may have
        // broadcast it, so only a success is taken from the main RPC.
        if (!send || succeeded(fromMain) || refusedOutright(e)) return fromMain;
        throw e;
      }
      // The main RPC was not asked for this send, so the backup's refusal (a preflight
      // failure, or "already processed") is the answer, as the main RPC's is when it is asked first:
      // the sender reads it as refused, or as sent. Unless the main RPC was given this very
      // transaction earlier and never said what it did with it: then a refusal here proves nothing,
      // and the send stays unknown.
      if (!send || succeeded(answer) || !mainMayHaveIt(wire)) return answer;
      throw new Error('The backup RPC did not accept the transaction while the main RPC is down.');
    }

    const at = pins;
    const started = Date.now();
    if (send) mainMayHaveSent(wire);
    let e: unknown;
    try {
      const answer = await main({ ...config, signal: until(own, times.totalMs) } as Config);
      mainAnswered(at);
      return answer;
    } catch (caught) {
      e = caught;
    }
    // The caller's own cancel is not an outage; neither is an HTTP error that is not one (4xx).
    if (own?.aborted || refusedOutright(e)) throw e;
    mainFailed(Date.now() - started);
    const left = deadline - Date.now();
    if (!send) {
      if (left <= 0) throw e;
      try {
        return await backup({ ...config, signal: until(own, left) } as Config);
      } catch (b) {
        // A backup that refuses the request (an expired key's 401, say) is not the
        // caller's error: the main RPC's failure is what is said, an outage.
        throw own?.aborted || !refusedOutright(b) ? b : e;
      }
    }
    if (left < times.minSendMs) throw e;
    let answer: unknown;
    try {
      answer = await backup({ ...config, signal: until(own, left) } as Config);
    } catch {
      throw e;
    }
    if (succeeded(answer)) return answer;
    throw e;
  }) as Transport;
  return createSolanaRpcFromTransport(transport) as unknown as SolanaRpc;
}
