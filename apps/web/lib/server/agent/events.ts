/**
 * What the operator counts: one line of JSON per event in the deployment's logs, under a name that
 * starts with `orientim.` (on Vercel: Logs, search `orientim.prepare`, say). It says what happened
 * and how long it took; never an API key, a secret, a signature's bytes or a transaction. An agent is
 * named by its key's id (`w:<wallet>` for a self-serve key), as the other log lines name it.
 */
export type EventFields = Record<string, string | number | boolean | null>;

export function logEvent(name: string, fields: EventFields): void {
  try {
    console.info(JSON.stringify({ event: `orientim.${name}`, ...fields }));
  } catch {
    // A log line never fails a request.
  }
}

/** Base58 runs as long as an address or a signature: never written to a log line. */
const ADDRESSES = /[1-9A-HJ-NP-Za-km-z]{32,88}/g;

/** A reason in its own words, for a log line: every address and signature replaced by "…", at most `max` characters. */
export function maskedReason(text: string, max = 160): string {
  return text.replace(ADDRESSES, '…').slice(0, max);
}

/**
 * An unexpected error as one log entry: its stack or message, with every URL cut to its host (an RPC
 * URL may carry the provider's key in its path or query) and every address masked.
 */
export function loggableError(e: unknown): string {
  const text = e instanceof Error ? `${e.stack ?? `${e.name}: ${e.message}`}${e.cause ? `\ncause: ${loggableCause(e.cause)}` : ''}` : String(e);
  return maskedReason(text.replace(/\b(https?|wss?):\/\/([^\s/'"?#]+)[^\s'"]*/g, '$1://$2/…'), 4_000);
}
const loggableCause = (c: unknown) => (c instanceof Error ? `${c.name}: ${c.message}` : String(c));

/**
 * Why a refusal was refused, for the log: the rules the check named (R1–R7), and the first reason
 * in its own words, with every address and signature in it replaced by "…". Nothing else.
 */
export function refusalOf(violations: unknown): EventFields {
  if (!Array.isArray(violations) || !violations.length) return {};
  const rules = [...new Set(violations.map(v => (v as { rule?: unknown })?.rule).filter((r): r is string => typeof r === 'string' && /^R\d$/.test(r)))];
  const detail = (violations[0] as { detail?: unknown })?.detail;
  return {
    ...(rules.length ? { rules: rules.join(',') } : {}),
    ...(typeof detail === 'string' ? { reason: maskedReason(detail) } : {}),
  };
}

/**
 * An endpoint's answer, observed: its HTTP status, its error code when it is an error (with the
 * rules and the first reason, when the check refused: `refusalOf`), finalize's `status` (sent,
 * unknown or rejected) when it answered, and the time it took. The answer itself is returned unchanged.
 */
export async function observed(name: 'prepare' | 'finalize', run: () => Promise<Response>): Promise<Response> {
  const started = performance.now();
  const res = await run();
  const fields: EventFields = { http: res.status, ms: Math.round(performance.now() - started) };
  if (res.status >= 400 || name === 'finalize') {
    try {
      const body = (await res.clone().json()) as { error?: { code?: unknown; violations?: unknown }; status?: unknown };
      if (typeof body?.error?.code === 'string') fields.code = body.error.code;
      Object.assign(fields, refusalOf(body?.error?.violations));
      if (name === 'finalize' && typeof body?.status === 'string') fields.status = body.status;
    } catch {
      // An answer that is not JSON is counted by its status alone.
    }
  }
  logEvent(name, fields);
  return res;
}
