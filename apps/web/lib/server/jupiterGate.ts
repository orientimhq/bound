import { AsyncLocalStorage } from 'node:async_hooks';
import { JupiterError } from '@orientim/jupiter';

/**
 * Orientim's own Jupiter requests, paced to its plan. Jupiter counts every request of the
 * organisation in one 60-second sliding window (developers.jup.ag/docs/portal/rate-limits): past
 * it, a 429 and a cool-down for every swap. On one machine every request goes through here, so none
 * is sent past the plan's limit: a request waits for room instead, milliseconds rather than the
 * 5 s cool-down. Waiting requests are served one client at a time (`jupiterLane`): the client served
 * longest ago goes first, so one sending many swaps waits behind its own and never ahead of another's.
 *
 *   ORIENTIM_JUPITER_PER_MINUTE    the plan's requests a minute: 60 Free (the default), 600 Developer,
 *                                  3000 Launch. Within a second, at most a sixtieth of it.
 */

/** Whose request this is: the API key's id for an agent's swap, `site` otherwise. */
export const jupiterLane = new AsyncLocalStorage<string>();

const WINDOW_MS = 60_000;
const SECOND_MS = 1_000;
/**
 * The longest a request may wait for room: the client's own timeout for a Jupiter request
 * (agent/config.ts). Past as many waiting as the plan serves in that time, a new request is refused at
 * once as busy rather than left to time out.
 */
const MAX_WAIT_MS = 15_000;

type Job = { go: () => void; stop: (reason: unknown) => void; signal?: AbortSignal; off?: () => void };

export type JupiterGate = {
  /** `fetchImpl`, sending each request only once the plan has room for it. */
  wrap(fetchImpl: typeof fetch): typeof fetch;
  /**
   * `fetchImpl`, sending at once and counting each request in the window, so that the requests that
   * wait leave room for it: for a check that must answer now (health), never to send a swap's.
   */
  counted(fetchImpl: typeof fetch): typeof fetch;
  /** Requests waiting for room now. */
  waiting(): number;
};

export function createJupiterGate(perMinute: number, now: () => number = Date.now): JupiterGate {
  const perSecond = Math.max(1, Math.floor(perMinute / 60));
  const maxWaiting = perSecond * (MAX_WAIT_MS / SECOND_MS);
  // When each request in the last minute was sent, oldest first.
  const sent: number[] = [];
  // Waiting requests per client, in the order the clients came.
  const lanes = new Map<string, Job[]>();
  let count = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const room = (t: number): number => {
    while (sent.length && sent[0] <= t - WINDOW_MS) sent.shift();
    let lastSecond = 0;
    for (let i = sent.length - 1; i >= 0 && sent[i] > t - SECOND_MS; i--) lastSecond++;
    if (sent.length < perMinute && lastSecond < perSecond) return 0;
    // The first moment either window has room again.
    const minuteFree = sent.length < perMinute ? t : sent[sent.length - perMinute] + WINDOW_MS;
    const secondFree = lastSecond < perSecond ? t : sent[sent.length - perSecond] + SECOND_MS;
    return Math.max(1, Math.max(minuteFree, secondFree) - t);
  };

  // When each client was last served: the one served longest ago (or never, in this minute) is next.
  const served = new Map<string, number>();

  const next = (t: number): Job | null => {
    for (const [lane, at] of served) if (at <= t - WINDOW_MS) served.delete(lane);
    let pick: string | null = null;
    let oldest = Infinity;
    for (const lane of lanes.keys()) {
      const at = served.get(lane) ?? -Infinity;
      if (at < oldest) [pick, oldest] = [lane, at];
    }
    if (pick === null) return null;
    const jobs = lanes.get(pick)!;
    const job = jobs.shift()!;
    if (!jobs.length) lanes.delete(pick);
    served.set(pick, t);
    count--;
    return job;
  };

  const pump = () => {
    timer = null;
    while (count > 0) {
      const t = now();
      const wait = room(t);
      if (wait > 0) {
        timer = setTimeout(pump, wait);
        return;
      }
      const job = next(t);
      if (!job) return;
      job.off?.();
      sent.push(t);
      job.go();
    }
  };

  const enter = (lane: string, signal?: AbortSignal) => new Promise<void>((go, stop) => {
    if (signal?.aborted) return stop(signal.reason);
    if (count >= maxWaiting) return stop(new JupiterError('Jupiter 429: too many requests waiting for room in the plan', 429));
    const job: Job = { go, stop, signal };
    if (signal) {
      const abort = () => {
        const jobs = lanes.get(lane);
        const at = jobs?.indexOf(job) ?? -1;
        if (at >= 0) {
          jobs!.splice(at, 1);
          if (!jobs!.length) lanes.delete(lane);
          count--;
        }
        stop(signal.reason);
      };
      signal.addEventListener('abort', abort, { once: true });
      job.off = () => signal.removeEventListener('abort', abort);
    }
    const jobs = lanes.get(lane);
    if (jobs) jobs.push(job);
    else lanes.set(lane, [job]);
    count++;
    if (!timer) pump();
  });

  return {
    wrap: fetchImpl => async (input, init) => {
      await enter(jupiterLane.getStore() ?? 'site', init?.signal ?? undefined);
      return fetchImpl(input, init);
    },
    counted: fetchImpl => async (input, init) => {
      const t = now();
      while (sent.length && sent[0] <= t - WINDOW_MS) sent.shift();
      sent.push(t);
      return fetchImpl(input, init);
    },
    waiting: () => count,
  };
}

let shared: { perMinute: number; gate: JupiterGate } | null = null;

/** The plan's requests a minute (ORIENTIM_JUPITER_PER_MINUTE), 60 when unset: the Free plan's. */
export function jupiterPerMinute(): number {
  const n = Number(process.env.ORIENTIM_JUPITER_PER_MINUTE);
  return Number.isInteger(n) && n > 0 ? n : 60;
}

/** The one gate every Jupiter request of this process goes through. */
export function sharedJupiterGate(): JupiterGate {
  const perMinute = jupiterPerMinute();
  if (shared?.perMinute !== perMinute) shared = { perMinute, gate: createJupiterGate(perMinute) };
  return shared.gate;
}
