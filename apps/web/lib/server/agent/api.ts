import {
  getBase64EncodedWireTransaction, getSignatureFromTransaction, getTransactionDecoder, isAddress, isSolanaError,
  SOLANA_ERROR__JSON_RPC__INTERNAL_ERROR, SOLANA_ERROR__JSON_RPC__METHOD_NOT_FOUND, SOLANA_ERROR__JSON_RPC__SERVER_ERROR_NODE_UNHEALTHY,
  SOLANA_ERROR__JSON_RPC__SERVER_ERROR_MIN_CONTEXT_SLOT_NOT_REACHED,
} from '@solana/kit';
import type { Address, Transaction } from '@solana/kit';
import { JUPITER_PROGRAM, tokenAmountOf, WSOL_MINT } from '@orientim/core';
import { TOKEN_2022_PROGRAM } from '@orientim/core/constants';
import { MAX_CHOSEN_SLIPPAGE_BPS } from '@orientim/core/constants';
import type { TxVersion } from '@orientim/core';
import { OrientimError, countersignProtectedSwap, DEFAULT_SETTINGS, parseProvidedRoutes, prepareProtectedSwap, providedRoutes, RoutesNeeded, RoutesUntrusted } from '@orientim/jupiter';
import type { JupiterClient, PriorityFeeLevel, ReferencePrice, SolValue } from '@orientim/jupiter';
import { fetchAccounts, httpStatusOf, mintInfoOf, sendOnce } from '@orientim/solana';
import { hasPermanentDelegate } from '@orientim/verifier';
import type { SolanaRpc } from '@orientim/solana';
import { readBodyLimited } from '../body';
import { loggableError, logEvent, maskedReason } from './events';
import { rateLimited, secondsUntilReset } from '../rateLimit';
import { openKey } from './keys';
import { ephemeralFor, kidOf, newNonce, openSession, openTicket, REFERENCE_FRESH_MS, sealSession, sealTicket, SESSION_TTL_SECONDS } from './ticket';
import type { SessionReference, SessionSolValue } from './ticket';

/**
 * The agent API (AGENT-API.md): the protected swap (packages/jupiter), with E held by the
 * server. Orientim signs as E last, and only the exact message it built and
 * verified, which is what makes the fee hold for bots and agents without a program on chain.
 *
 *   POST /api/v1/prepare   build and verify → the unsigned transaction and a ticket
 *   POST /api/v1/finalize  the ticket and the transaction W signed → E signs, one send
 */
export type AgentDeps = {
  rpc: SolanaRpc;
  jupiter: JupiterClient;
  /** The RPC provider's priority estimate; without it, recent fees on the swap's accounts. */
  priorityFee?: PriorityFeeLevel;
  /** Server secrets, the current one first; older ones still open their tickets while they rotate out. */
  secrets: readonly Uint8Array[];
  /** SHA-256 of each API key (hex) → the key's id. The keys themselves are never stored. */
  keys: ReadonlyMap<string, string>;
  /**
   * The secrets that seal self-serve keys (ORIENTIM_KEY_SECRET, then its predecessor), none when
   * self-serve keys are off; and the wallets whose keys are revoked (ORIENTIM_API_REVOKED).
   */
  keySecrets?: readonly Uint8Array[];
  revokedWallets?: ReadonlySet<string>;
  feeBps: bigint;
  treasury: Address | null;
  excludeDexes: readonly string[];
  maxNetworkFeeLamports: bigint;
  /** The kill switch, read on every request. */
  disabled: boolean;
  /** v1 transactions, only when the deployment enables them. */
  v1: boolean;
  /** Jupiter beta fast routing, opt-in per request and off unless enabled by the operator. */
  fastRouting?: boolean;
  /** Requests per minute per API key, for each endpoint. */
  perMinute: number;
  /** The smallest fee a swap may carry (about $1 of swap); none when unset. */
  minFee?: { lamports: bigint; stableUnits: bigint } | null;
  /**
   * The oldest skill version prepare serves (ORIENTIM_MIN_SKILL_VERSION), or none. Only prepare asks:
   * a swap already signed is always finalized, whatever the copy of the skill that signed it.
   */
  minSkillVersion?: string | null;
  /** How long a prepare may take in all (PREPARE_DEADLINE_MS); shorter in tests. */
  prepareDeadlineMs?: number;
  /** How long a finalize may take in all (FINALIZE_DEADLINE_MS); shorter in tests. */
  finalizeDeadlineMs?: number;
  /** How long Orientim's own price stays good for the next round (REFERENCE_FRESH_MS); other in tests. */
  referenceFreshMs?: number;
  /**
   * Routes an agent brings with its own Jupiter key (AGENT-API.md, "Your own Jupiter key"). Off,
   * prepare builds with Orientim's key and ignores ownRoutes, routes and session, as a deployment
   * from before them did.
   */
  ownRoutes?: boolean;
};

/** Is `version` (major.minor.patch) older than `minimum`? A version that is not one is not judged. */
export function olderThan(version: string, minimum: string): boolean {
  const parts = (v: string) => (/^\d{1,6}\.\d{1,6}\.\d{1,6}$/.test(v) ? v.split('.').map(Number) : null);
  const [a, b] = [parts(version), parts(minimum)];
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] < b[i];
  return false;
}

const MAX_U64 = 2n ** 64n - 1n;
const MAX_BODY_BYTES = 16 * 1024;
/** A prepare may carry the routes an agent brought from Jupiter: up to 24 answers, with their lookup tables. */
const MAX_PREPARE_BODY_BYTES = 1024 * 1024;
const UINT = /^\d{1,20}$/;

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body, (_, v) => (typeof v === 'bigint' ? v.toString() : v)), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store', ...headers },
  });
const fail = (status: number, code: string, message: string, extra: Record<string, unknown> = {}, headers: Record<string, string> = {}) =>
  json(status, { error: { code, message, ...extra } }, headers);

const sha256Hex = async (bytes: ArrayLike<number>) =>
  Buffer.from(await globalThis.crypto.subtle.digest('SHA-256', new Uint8Array(bytes))).toString('hex');

/**
 * The key's id, and the wallet it is bound to (a self-serve key) or none (a key issued by hand), or
 * the response that refuses the request.
 */
async function authenticate(req: Request, deps: AgentDeps): Promise<{ id: string; wallet: string | null } | Response> {
  const header = req.headers.get('authorization') ?? '';
  const key = /^Bearer\s+(\S{16,400})$/i.exec(header)?.[1];
  const manual = key ? deps.keys.get(await sha256Hex(new TextEncoder().encode(key))) : undefined;
  const own = !manual && key && deps.keySecrets?.length
    ? await openKey(deps.keySecrets, key, Math.floor(Date.now() / 1000), deps.revokedWallets)
    : null;
  const auth = manual ? { id: manual, wallet: null } : own;
  if (!auth) return fail(401, 'unauthorized', 'A valid API key is required: Authorization: Bearer <key>. This one is missing, unknown, expired or revoked; a wallet gets a new key by signing a new key challenge.');
  const bucket = `agent:${new URL(req.url).pathname}:${auth.id}`;
  if (rateLimited(bucket, deps.perMinute)) {
    return fail(429, 'rate-limited', 'Too many requests for this API key. Wait Retry-After seconds and try again.', {}, { 'retry-after': String(secondsUntilReset(bucket)) });
  }
  return auth;
}

async function readJson(req: Request, limit = MAX_BODY_BYTES): Promise<Record<string, unknown> | null> {
  const text = await readBodyLimited(req, limit);
  if (text === null) return null;
  try {
    const body = JSON.parse(text);
    return body && typeof body === 'object' && !Array.isArray(body) ? body : null;
  } catch {
    return null;
  }
}

/** An amount in base units, as a decimal string: the only form that survives JSON exactly. */
function amount(v: unknown): bigint | null {
  if (typeof v !== 'string' || !UINT.test(v)) return null;
  const n = BigInt(v);
  return n > 0n && n <= MAX_U64 ? n : null;
}

/** A request that ended without an answer: timed out, aborted, or the connection failed. */
const unanswered = (e: unknown) => e instanceof Error
  && (e.name === 'TimeoutError' || e.name === 'AbortError' || (e instanceof TypeError && /fetch failed/i.test(e.message)));

/**
 * A prepare answers within this, in all: the mints read, the swap built and the block height read,
 * before the function's own limit (maxDuration, 60 s) and within the skill's wait for it (60 s), so
 * that retries to a slow Jupiter or RPC end in an answer the agent still reads, never a transaction
 * built for no one.
 */
export const PREPARE_DEADLINE_MS = 45_000;
/**
 * The most a finalize spends on the network: its reads, the signing, and the one send, within the
 * route's 30 seconds (finalize/route.ts), so it always answers in words. A send cut short by it is
 * answered `unknown`, never "nothing was sent".
 */
export const FINALIZE_DEADLINE_MS = 24_000;

const LATE_MESSAGE = 'Building this swap took too long: Jupiter or the Solana RPC is slow right now. Nothing was signed; prepare again in a moment.';

/** `work`, or `unavailable` once `ms` have passed. */
export async function withinDeadline<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new OrientimError('unavailable', LATE_MESSAGE)), ms);
  });
  try {
    return await Promise.race([work, late]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * One deadline for a whole request, and the clients it may use: every RPC request is sent with the
 * deadline's signal, so one in flight is aborted when it passes, and no RPC or Jupiter request starts
 * after it. A Jupiter request already in flight ends at its own timeout, and its answer is dropped.
 */
export function deadlineFor(ms: number, rpc: SolanaRpc, jupiter: JupiterClient) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new OrientimError('unavailable', LATE_MESSAGE)), ms);
  const { signal } = controller;
  const late = new Promise<never>((_, reject) => {
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  });
  late.catch(() => undefined);
  const notLate = () => {
    if (signal.aborted) throw signal.reason;
  };
  const boundedRpc = new Proxy(rpc as object, {
    get(target, method) {
      const call = (target as Record<string | symbol, unknown>)[method];
      if (typeof call !== 'function') return call;
      return (...args: unknown[]) => {
        const request = (call as (...a: unknown[]) => { send(o?: { abortSignal?: AbortSignal }): Promise<unknown> }).apply(target, args);
        return {
          ...request,
          send: (o?: { abortSignal?: AbortSignal }) => {
            notLate();
            const abortSignal = o?.abortSignal && typeof AbortSignal.any === 'function' ? AbortSignal.any([o.abortSignal, signal]) : signal;
            return request.send({ ...o, abortSignal });
          },
        };
      };
    },
  }) as SolanaRpc;
  const bounded = <A extends unknown[], R>(f: (...a: A) => Promise<R>) => async (...a: A): Promise<R> => {
    notLate();
    return Promise.race([f(...a), late]);
  };
  const bind = (j: JupiterClient): JupiterClient => ({
    build: bounded(p => j.build(p)),
    searchTokens: bounded(q => j.searchTokens(q)),
    programLabels: bounded(() => j.programLabels()),
  });
  return {
    rpc: boundedRpc, jupiter: bind(jupiter), signal,
    /** Another Jupiter client under the same deadline. */
    bind,
    /** `work`, or `unavailable` as soon as the deadline passes. */
    within: <T>(work: Promise<T>): Promise<T> => Promise.race([work, late]),
    done: () => clearTimeout(timer),
  };
}

/** Every refusal in plain words, with what an agent needs to act on it. */
function explain(e: unknown): Response {
  if (e instanceof OrientimError) {
    const violations = e.violations.length ? { violations: e.violations } : {};
    switch (e.code) {
      // Both need the user's yes before the agent asks again: a worse price is a new authorization,
      // not a retry, and says so in a field a program can read.
      case 'price-moved':
        return fail(409, e.code, e.message, {
          // What the wallet would keep, after a fee taken from the output: the same unit as minOut.
          newMinOut: e.priceMoved?.newMinReceived, newOutAmount: e.priceMoved?.newOutAmount,
          requiresApproval: true,
          retry: 'Only with the user\'s approval: send prepare again with minOut set to newMinOut.',
        });
      case 'costs-more':
        return fail(409, e.code, e.message, {
          gapBps: e.costsMore?.gapBps, outAmount: e.costsMore?.outAmount, baselineOut: e.costsMore?.baselineOut,
          requiresApproval: true,
          retry: 'Only with the user\'s approval: send prepare again with acceptCostBps set to gapBps.',
        });
      case 'busy':
      case 'unavailable':
        return fail(503, e.code, e.message, {}, { 'retry-after': '5' });
      // Orientim cannot collect its fee on this swap (its treasury wallet is not ready, or the pair
      // cannot be priced in SOL): nothing is built for free.
      case 'fee-unavailable':
        return fail(503, e.code, e.message, {}, { 'retry-after': '60' });
      // Jupiter's format changed: nothing builds until Orientim is updated, so do not retry soon.
      case 'route-format':
        return fail(503, e.code, e.message, {}, { 'retry-after': '300' });
      case 'expired':
        return fail(410, e.code, e.message);
      case 'wallet-changed-transaction':
        return fail(400, e.code, e.message, violations);
      default:
        return fail(422, e.code, e.message, violations);
    }
  }
  const http = httpStatusOf(e);
  if (http === 429) return fail(503, 'busy', "Orientim's Solana RPC is rate limited right now. Wait a few seconds and try again. Nothing was sent.", {}, { 'retry-after': '5' });
  if ((http !== null && http >= 500) || unanswered(e)) {
    return fail(503, 'unavailable', "Orientim's Solana RPC didn't answer. Nothing was sent; try again in a moment.", {}, { 'retry-after': '5' });
  }
  // The RPC answered but could not serve the request: its own fault or its plan's, not the swap's.
  if (isSolanaError(e, SOLANA_ERROR__JSON_RPC__METHOD_NOT_FOUND) || isSolanaError(e, SOLANA_ERROR__JSON_RPC__INTERNAL_ERROR) || isSolanaError(e, SOLANA_ERROR__JSON_RPC__SERVER_ERROR_NODE_UNHEALTHY)
    // A node still behind the slot of an earlier read, after the reads asked it again for a few seconds.
    || isSolanaError(e, SOLANA_ERROR__JSON_RPC__SERVER_ERROR_MIN_CONTEXT_SLOT_NOT_REACHED)) {
    console.error("Orientim's Solana RPC could not serve a request:", loggableError(e));
    return fail(503, 'unavailable', "Orientim's Solana RPC couldn't serve this request. Nothing was sent; try again in a moment.", {}, { 'retry-after': '5' });
  }
  console.error(loggableError(e));
  return fail(500, 'internal', 'Something went wrong. Nothing was signed by Orientim or sent.');
}

const authoritiesOf = (m: { freezeAuthority: boolean; mintAuthority: boolean }) => ({ freezeAuthority: m.freezeAuthority, mintAuthority: m.mintAuthority });

export async function agentPrepare(req: Request, deps: AgentDeps): Promise<Response> {
  if (deps.disabled) return fail(503, 'paused', 'Protected swaps are paused. Nothing was built.');
  const auth = await authenticate(req, deps);
  if (auth instanceof Response) return auth;
  const key = auth.id;
  // A copy of the skill older than this deployment serves: say so, rather than fail some other way.
  const skill = req.headers.get('x-orientim-skill') ?? '';
  if (deps.minSkillVersion && skill && olderThan(skill, deps.minSkillVersion)) {
    return fail(426, 'skill-outdated', `This copy of the Orientim skill (${skill}) is older than ${deps.minSkillVersion}, the oldest this deployment serves. Get the current skill and prepare again. Nothing was built.`, {
      minimum: deps.minSkillVersion,
    });
  }
  const body = await readJson(req, MAX_PREPARE_BODY_BYTES);
  if (!body) return fail(400, 'bad-request', 'Send a JSON object of at most 1 MiB.');

  const { owner, inputMint, outputMint } = body;
  for (const [name, v] of [['owner', owner], ['inputMint', inputMint], ['outputMint', outputMint]] as const) {
    if (typeof v !== 'string' || !isAddress(v)) return fail(400, 'bad-request', `${name} must be a Solana address.`);
  }
  if (inputMint === outputMint) return fail(400, 'bad-request', 'inputMint and outputMint must differ.');
  // A self-serve key prepares swaps for the wallet that got it, and for no other.
  if (auth.wallet && owner !== auth.wallet) {
    return fail(403, 'wrong-wallet', `This API key belongs to ${auth.wallet}; it prepares swaps for that wallet only. Nothing was built.`);
  }
  const amountIn = amount(body.amountIn);
  if (amountIn === null) return fail(400, 'bad-request', 'amountIn must be a positive integer in base units, as a string.');
  // Every client, including one calling the API without the skill, must supply its own
  // minimum. This does not prove that the client priced or verified the transaction.
  // Every client, including one calling the API without the skill, must supply its own minimum
  // before a swap is built. The first round of an agent's own routes builds nothing (it only says
  // which routes to bring), so there it may come later, while the agent asks for its own price.
  const minOut = body.minOut === undefined ? undefined : amount(body.minOut);
  if (minOut === null) return fail(400, 'bad-request', 'minOut, when given, must be a positive integer in base units, as a string.');
  // A whole number of bps, as a number (like slippageBps) or as an integer string (like the amounts).
  const cost = body.acceptCostBps;
  const acceptCostBps = cost === undefined ? undefined
    : typeof cost === 'string' && /^\d{1,5}$/.test(cost) ? BigInt(cost)
      : typeof cost === 'number' && Number.isInteger(cost) && cost >= 0 && cost <= 99_999 ? BigInt(cost) : null;
  if (acceptCostBps === null) return fail(400, 'bad-request', 'acceptCostBps, when given, must be a whole number of bps, as a number or an integer string.');
  const version: TxVersion = body.version === 1 ? 1 : 0;
  if (body.version !== undefined && body.version !== 0 && body.version !== 1) return fail(400, 'bad-request', 'version must be 0 or 1.');
  if (body.routingMode !== undefined && body.routingMode !== 'standard' && body.routingMode !== 'fast') {
    return fail(400, 'bad-request', 'routingMode must be standard or fast.');
  }
  if (body.routingMode === 'fast' && !deps.fastRouting) {
    return fail(400, 'bad-request', 'Fast routing is not enabled on this deployment; use standard.');
  }
  // The route's slippage tolerance, as the agent chooses it: 0.1% to 15%. The agent's own
  // check holds the route to the same number, from its own intent.
  const slippageBps = body.slippageBps;
  if (slippageBps !== undefined && !(typeof slippageBps === 'number' && Number.isInteger(slippageBps) && slippageBps >= 10 && slippageBps <= MAX_CHOSEN_SLIPPAGE_BPS)) {
    return fail(400, 'bad-request', `slippageBps, when given, must be a whole number of bps from 10 to ${MAX_CHOSEN_SLIPPAGE_BPS}.`);
  }
  if (version === 1 && !deps.v1) return fail(400, 'bad-request', 'v1 transactions are not enabled on this deployment; use version 0.');
  // Routes the agent brings from Jupiter with its own key (AGENT-API.md, "Your own Jupiter key").
  if (body.ownRoutes !== undefined && typeof body.ownRoutes !== 'boolean') return fail(400, 'bad-request', 'ownRoutes, when given, must be true or false.');
  if (body.ownRoutes !== true && (body.routes !== undefined || body.session !== undefined)) {
    return fail(400, 'bad-request', 'routes and session come with ownRoutes: true.');
  }
  // Where they are off, Orientim builds with its own key, as a deployment from before them did.
  const ownRoutes = body.ownRoutes === true && deps.ownRoutes === true;
  const firstRound = ownRoutes && body.session === undefined && (body.routes === undefined || (Array.isArray(body.routes) && body.routes.length === 0));
  if (minOut === undefined && !firstRound) {
    return fail(400, 'bad-request', 'minOut is required and must be a positive integer in base units, as a string. Get a price independently before preparing.');
  }
  let routes: ReturnType<typeof providedRoutes> | null = null;
  let sessionNonce: string | null = null;
  // A session ends two minutes after the first round, however many rounds follow.
  let sessionExp: number | null = null;
  // Orientim's own price an earlier round sealed into the session (see `reference` below).
  let sessionRef: SessionReference | null = null;
  // What the input was worth in SOL, for a fee in SOL from the wallet, as an earlier round sealed it.
  let sessionSol: SessionSolValue | null = null;
  // How many routes the agent brought this round (for the operator's count).
  let providedCount = 0;
  if (ownRoutes) {
    const parsed = parseProvidedRoutes(body.routes ?? []);
    if ('error' in parsed) return fail(400, 'bad-request', parsed.error);
    providedCount = parsed.routes.length;
    // Labels come from Orientim's own client, never from the agent's routes.
    routes = providedRoutes(parsed.routes, deps.jupiter);
    if (body.session !== undefined) {
      const opened = await openSession(deps.secrets, body.session);
      const s = opened?.session;
      // A session opens only for the swap, the key and the secret it was sealed for.
      if (!s || opened.secret !== deps.secrets[0] || s.key !== key || s.owner !== owner || s.inputMint !== inputMint
        || s.outputMint !== outputMint || s.amountIn !== amountIn.toString() || s.version !== version) {
        return fail(400, 'bad-session', 'This session is expired, or was opened for another swap or key: prepare again without it. Nothing was built.');
      }
      sessionNonce = s.nonce;
      sessionExp = s.exp;
      sessionRef = s.ref ?? null;
      sessionSol = s.sol ?? null;
    }
  }

  // One deadline for the whole prepare: the mints read, the build, and the block height read.
  const deadline = deadlineFor(deps.prepareDeadlineMs ?? PREPARE_DEADLINE_MS, deps.rpc, deps.jupiter);
  try {
    const [inMint, outMint] = [inputMint as Address, outputMint as Address];
    const mintStates = await deadline.within(fetchAccounts(deadline.rpc, [inMint, outMint]));
    const mints = new Map([inMint, outMint].map(m => [m as string, mintInfoOf(mintStates.get(m))]));
    // A Token-2022 permanent delegate: its issuer can move or burn any holder's balance.
    const permanentDelegate = (m: Address) => {
      const s = mintStates.get(m);
      return !!s && s.owner === TOKEN_2022_PROGRAM && hasPermanentDelegate(s.data);
    };
    for (const m of [inMint, outMint]) {
      if (!mints.get(m)?.exists) return fail(422, 'unsupported-token', `${m} is not a token Orientim can swap.`);
    }
    const nonce = sessionNonce ?? newNonce();
    const [secret] = deps.secrets;
    const E = await ephemeralFor(secret, nonce);
    // The session the agent's next round carries, when its routes are its own.
    // Orientim's own price for a fee on the output, asked once and kept for the rounds that follow
    // while it is fresh and asked for the same tolerance and fee; otherwise asked again.
    const slip = typeof slippageBps === 'number' ? slippageBps : null;
    const treasuryText = deps.treasury ? String(deps.treasury) : null;
    const freshMs = deps.referenceFreshMs ?? REFERENCE_FRESH_MS;
    const reuse = sessionRef && Date.now() - sessionRef.at <= freshMs && sessionRef.slip === slip
      && sessionRef.feeBps === deps.feeBps.toString() && sessionRef.treasury === treasuryText ? sessionRef : null;
    let price: { value: ReferencePrice; at: number } | null = reuse ? { value: { out: BigInt(reuse.out), minimum: BigInt(reuse.min) }, at: reuse.at } : null;
    const asked = (value: ReferencePrice) => {
      price = { value, at: Date.now() };
      // Why it was asked of Orientim's key, for its own count of requests.
      const why = !sessionRef ? 'none' : Date.now() - sessionRef.at > freshMs ? 'expired' : 'parameters';
      logEvent('reference_price', { key, why });
    };
    // The same for a fee in SOL from the wallet: what the input is worth in SOL, asked once of
    // Orientim's key and kept for the rounds that follow while it is fresh, for the same amount and
    // tolerance; otherwise asked again.
    const solSlip = DEFAULT_SETTINGS.slippageBps;
    const solReuse = sessionSol && Date.now() - sessionSol.at <= freshMs && sessionSol.slip === solSlip ? sessionSol : null;
    let solValue: { value: SolValue; at: number } | null = solReuse
      ? { value: { amount: BigInt(solReuse.amount), value: BigInt(solReuse.value) }, at: solReuse.at } : null;
    const solAsked = (value: SolValue) => {
      solValue = { value, at: Date.now() };
      logEvent('sol_fee_price', { key, why: !sessionSol ? 'none' : Date.now() - sessionSol.at > freshMs ? 'expired' : 'parameters' });
    };
    const session = () => kidOf(secret).then(kid => sealSession(secret, {
      v: 1, kid, nonce, key, owner: owner as string, inputMint: inMint, outputMint: outMint, amountIn: amountIn.toString(), version,
      exp: sessionExp ?? Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS,
      ...(price ? { ref: { out: price.value.out.toString(), min: price.value.minimum.toString(), at: price.at, slip, feeBps: deps.feeBps.toString(), treasury: treasuryText } } : {}),
      ...(solValue ? { sol: { amount: solValue.value.amount.toString(), value: solValue.value.value.toString(), at: solValue.at, slip: solSlip } } : {}),
    }));
    // From an agent's own routes, or Orientim's client; Orientim's fee in SOL is always priced by its
    // own, and with an agent's routes a fee on the output is held to its own price (`reference`).
    const build = (jupiter: JupiterClient, reference?: JupiterClient) => deadline.within(prepareProtectedSwap(
      {
        rpc: deadline.rpc,
        jupiter,
        pricing: deadline.jupiter,
        ...(solValue ? { solValue: solValue.value } : {}),
        onSolValue: solAsked,
        ...(reference ? { reference, onReferencePrice: asked, ...(price ? { referencePrice: price.value } : {}) } : {}),
        ...(deps.priorityFee ? { priorityFee: deps.priorityFee } : {}),
        settings: {
          ...DEFAULT_SETTINGS,
          feeBps: deps.feeBps,
          treasury: deps.treasury,
          excludeDexes: deps.excludeDexes,
          maxNetworkFeeLamports: deps.maxNetworkFeeLamports,
          jupiterProgram: JUPITER_PROGRAM,
          ...(deps.minFee ? { minFee: deps.minFee } : {}),
          ...(slippageBps !== undefined ? { chosenSlippageBps: slippageBps as number } : {}),
        },
      },
      {
        owner: owner as Address, ephemeral: E, inputMint: inMint, outputMint: outMint, amountIn,
        inputDecimals: mints.get(inMint)!.decimals, outputDecimals: mints.get(outMint)!.decimals,
        // The agent's floor is what its wallet keeps; with a fee on the output, Orientim enforces more.
        // A first round without a minimum builds nothing: it ends asking for routes (below).
        acceptedMinReceived: minOut ?? 1n, acceptedCostBps: acceptCostBps, version,
        ...(body.routingMode === 'fast' ? { routingMode: 'fast' as const } : {}),
      },
    ));
    let prepared: Awaited<ReturnType<typeof prepareProtectedSwap>>;
    // Where the swap's routes came from, for the operator's count: the agent's, or Orientim's.
    let routesFrom: 'agent' | 'orientim' | 'orientim-fallback' = routes ? 'agent' : 'orientim';
    try {
      prepared = routes ? await build(deadline.bind(routes), deadline.jupiter) : await build(deadline.jupiter);
    } catch (e) {
      // The routes the build needs next, for the one-time key it builds around: the agent fetches
      // them from Jupiter with its own key and prepares again with the session.
      if (e instanceof RoutesNeeded && routes) {
        logEvent('routes_needed', { key, asked: routes.missing.length, brought: providedCount });
        return fail(409, 'routes-needed', `Fetch these ${routes.missing.length} route(s) from Jupiter's /swap/v2/build with your own key, then prepare again with the session and every route you have.`, {
          session: await session(), taker: E.address, requests: routes.missing,
        });
      }
      // Routes Orientim cannot hold to its own price or exclusions, or that built a transaction its
      // own verifier refused (a route delivering elsewhere, say): it builds the swap with its own
      // key, around the same one-time key, within the same deadline, and verifies that one alike.
      const unusable = e instanceof RoutesUntrusted || (e instanceof OrientimError && e.code === 'verification-failed' && providedCount > 0);
      if (!(unusable && routes)) throw e;
      logEvent('routes_not_used', { key, reason: maskedReason(e.message, 200) });
      routesFrom = 'orientim-fallback';
      prepared = await build(deadline.jupiter);
    }
    // The hash finalize will hold the agent to, computed here from the bytes rather than taken from
    // the certificate: it is the one value the fee depends on.
    const messageSha256 = await sha256Hex(prepared.transaction.messageBytes);
    const wOut = prepared.policy.accounts.wOut;
    const ticket = await sealTicket(secret, {
      v: 1, kid: await kidOf(secret), nonce, key, owner: owner as string, msg: messageSha256,
      lvbh: prepared.lifetime.lastValidBlockHeight.toString(),
      ...(wOut ? { wOut, b0: prepared.outputBalanceBefore.toString() } : {}),
    });
    // Never a swap without the agent's own minimum: a first round can only ask for routes.
    if (minOut === undefined) return fail(400, 'bad-request', 'minOut is required to build the swap. Prepare again with it.');
    const p = prepared.policy;
    logEvent('prepared', { key, routes: routesFrom, brought: providedCount, feeSide: p.feeSide, version });
    const feeMint = p.feeSide === 'output' ? p.outputMint : p.feeSide === 'sol' ? WSOL_MINT : p.inputMint;
    const solFee = feeMint === WSOL_MINT ? p.fee : 0n;
    // What the transaction has left to live, in blocks: 150 at most, about 40 s.
    // Read in the time left: past the deadline it is left out, and the swap is still answered.
    const height = await deadline.within(deadline.rpc.getBlockHeight({ commitment: 'confirmed' }).send()).catch(() => null);
    return json(200, {
      ticket,
      transaction: getBase64EncodedWireTransaction(prepared.transaction),
      messageSha256,
      wallet: owner,
      temporaryAuthority: E.address,
      version,
      lastValidBlockHeight: prepared.lifetime.lastValidBlockHeight,
      ...(height === null ? {} : { blocksLeft: prepared.lifetime.lastValidBlockHeight - BigInt(height) }),
      amounts: {
        // Like Jupiter's fee: in SOL first, then USDC or USDT, on whichever side; otherwise the input;
        // and SOL from the wallet for a pair neither token of which can carry it (`policy.feeSide` sol).
        amountIn: p.amountIn, fee: p.fee,
        feeMint,
        feeBps: p.fee === 0n ? 0n : p.feeBps, swapAmount: p.swapAmount,
        // What the wallet keeps at least, after a fee taken from the output.
        quotedOut: prepared.quote.outAmount, minOut: prepared.quote.minReceived, priceImpactPct: prepared.quote.priceImpactPct,
      },
      costs: {
        networkFeeLamports: prepared.networkFeeLamports,
        outputAccountRentLamports: prepared.oneTimeCosts.outputAccountRent,
        routeRentLamports: prepared.oneTimeCosts.routeRent,
        // Returned to the wallet in the same transaction when Orientim closes the market's account.
        routeRefundLamports: prepared.oneTimeCosts.routeRefund,
        // Rent the route keeps: routeRentLamports less what comes back.
        routeKeptLamports: prepared.oneTimeCosts.routeRent - prepared.oneTimeCosts.routeRefund,
        // Orientim's fee when it is in SOL, whichever side it is taken from (SOL sold, SOL bought,
        // or the wallet's own SOL); 0 when it is in another token.
        orientimFeeSolLamports: solFee,
        // All the SOL the swap costs and does not return, in one number: the network fee, rent the
        // route keeps, and Orientim's fee when it is in SOL. The SOL the swap itself sells is not a
        // cost, and a new output account's rent is apart: it stays the wallet's own.
        keptSolLamports: prepared.networkFeeLamports + prepared.oneTimeCosts.routeRent - prepared.oneTimeCosts.routeRefund + solFee,
        // What the swap spends, apart: the amount swapped, Orientim's fee in its own token, and the SOL costs above.
        breakdown: {
          principal: { mint: p.inputMint, amount: p.swapAmount },
          orientimFee: { mint: feeMint, amount: p.fee },
          networkFeeLamports: prepared.networkFeeLamports,
          rentReturnedLamports: prepared.oneTimeCosts.routeRefund,
          rentKeptLamports: prepared.oneTimeCosts.routeRent - prepared.oneTimeCosts.routeRefund,
        },
        tokenTax: prepared.tokenTax,
      },
      // networkBusy: the priority fee is at its limit, so the swap may land late or expire.
      notices: { ...prepared.notices, networkBusy: prepared.priorityFeeCapped },
      // What the mint accounts say about the tokens themselves: an issuer that can freeze balances,
      // mint more, or move and burn anyone's balance (a permanent delegate). Orientim's word; the skill
      // reads the same on the agent's own RPC (tokenRisk).
      tokens: {
        input: { ...authoritiesOf(mints.get(inMint)!), permanentDelegate: permanentDelegate(inMint) },
        output: { ...authoritiesOf(mints.get(outMint)!), permanentDelegate: permanentDelegate(outMint) },
      },
      ...(slippageBps !== undefined ? { slippageBps } : {}),
      route: prepared.quote.route,
      certificate: prepared.certificate,
      policy: p,
    }, {
      // Durations only: no wallet, token, route, or transaction data in telemetry.
      'server-timing': [
        `prepare;dur=${prepared.timings.totalMs}`,
        `initial;dur=${prepared.timings.initialMs}`,
        `jupiter-build;dur=${prepared.timings.jupiterBuildMs}`,
        `simulation;dur=${prepared.timings.simulationMs}`,
        `verification;dur=${prepared.timings.verificationMs}`,
        `local;dur=${prepared.timings.localMs}`,
      ].join(', '),
    });
  } catch (e) {
    return explain(e);
  } finally {
    deadline.done();
  }
}

/**
 * Said with every refusal once the transaction is known. An earlier finalize of the same ticket may
 * have sent it and lost its answer on the way back, so "prepare again" is safe only once that
 * transaction can no longer land.
 */
const EARLIER =
  'If an earlier finalize of this ticket went out, that transaction may have landed, or may still land until lastValidBlockHeight: check its signature on your own RPC before preparing again.';

export async function agentFinalize(req: Request, deps: AgentDeps): Promise<Response> {
  const auth = await authenticate(req, deps);
  if (auth instanceof Response) return auth;
  const key = auth.id;
  const body = await readJson(req);
  if (!body || typeof body.ticket !== 'string' || typeof body.signedTransaction !== 'string') {
    return fail(400, 'bad-request', 'Send { "ticket": "...", "signedTransaction": "<base64>" }.');
  }
  // send: false asks for the fully signed transaction without Orientim sending it: the agent sends
  // it its own way (its own RPC, a staked connection, a bundle). The same bytes land only once.
  if (body.send !== undefined && typeof body.send !== 'boolean') return fail(400, 'bad-request', 'send, when given, must be true or false.');
  const sendIt = body.send !== false;
  const opened = await openTicket(deps.secrets, body.ticket);
  // A ticket issued to another key is refused in the same words as a forged one.
  if (!opened || opened.ticket.key !== key) return fail(400, 'invalid-ticket', 'This ticket was not issued by Orientim to this API key. Nothing was signed or sent.');
  const { ticket, secret } = opened;

  let returned: Transaction;
  const bytes = Buffer.from(body.signedTransaction, 'base64');
  try {
    if (bytes.length === 0 || bytes.length > 4_096) throw new Error('size');
    returned = getTransactionDecoder().decode(bytes);
  } catch {
    return fail(400, 'bad-request', 'signedTransaction must be a base64 Solana transaction.');
  }
  // The fee holds here: Orientim signs as E only the message whose hash it sealed into the ticket after
  // building and verifying it. A message with the fee removed, or any byte changed, is another hash.
  if ((await sha256Hex(returned.messageBytes)) !== ticket.msg) {
    return fail(400, 'transaction-changed', 'This is not the transaction Orientim built. Orientim signs only the exact message it built and verified; nothing was signed or sent.');
  }
  // The transaction's id is the wallet's signature (W pays, so it signs first), already in these
  // bytes: without it nothing could have been sent, by this request or an earlier one.
  let signature: string;
  try {
    signature = getSignatureFromTransaction(returned);
  } catch {
    return fail(400, 'wallet-changed-transaction', 'The transaction carries no signature from your wallet. Sign exactly what prepare returned; nothing was signed or sent.');
  }
  const known = { signature, lastValidBlockHeight: ticket.lvbh };
  const refuse = (status: number, code: string, message: string, extra: Record<string, unknown> = {}, headers: Record<string, string> = {}) =>
    fail(status, code, `${message} ${EARLIER}`, { ...extra, ...known }, headers);

  // What the chain knows of this transaction comes before any condition for a first send: a repeated
  // finalize must describe the transaction it repeats, never invite a second swap.
  // One deadline for the whole finalize: every read, the signing and the send.
  const deadline = deadlineFor(deps.finalizeDeadlineMs ?? FINALIZE_DEADLINE_MS, deps.rpc, deps.jupiter);
  const rpc = deadline.rpc;
  let onChain: unknown;
  try {
    onChain = (await rpc.getSignatureStatuses([signature as never], { searchTransactionHistory: true }).send()).value[0];
  } catch {
    deadline.done();
    return refuse(503, 'unavailable', 'Orientim could not read from the network whether this transaction was already sent, so this request sent nothing. Try finalize again in a few seconds.', {}, { 'retry-after': '5' });
  }

  try {
    const E = await ephemeralFor(secret, ticket.nonce);
    const original: Transaction = { messageBytes: returned.messageBytes, signatures: {} } as Transaction;
    const countersign = (landed: boolean) => countersignProtectedSwap({
      rpc,
      prepared: { transaction: original, lifetime: { lastValidBlockHeight: BigInt(ticket.lvbh) }, policy: { owner: ticket.owner as Address } },
      walletSignedBytes: new Uint8Array(bytes),
      ephemeral: E,
      landed,
    });
    // Already on chain: the answer of the finalize that sent it, the same bytes, and no second send.
    // Even while paused, since it reads and sends nothing.
    if (onChain) {
      const signed = await countersign(true);
      return json(200, { signature, status: 'sent', signedTransaction: getBase64EncodedWireTransaction(signed), lastValidBlockHeight: ticket.lvbh });
    }
    if (deps.disabled) return refuse(503, 'paused', 'Protected swaps are paused. This request signed and sent nothing.');
    // The minimum-output check is the output account's balance at prepare plus the minimum. If the
    // balance moved since (another swap into this token, a transfer), the check could count those
    // tokens: sign nothing. Run one swap per output token until it is confirmed.
    if (ticket.wOut) {
      const now = tokenAmountOf((await fetchAccounts(rpc, [ticket.wOut as Address])).get(ticket.wOut)?.data);
      if (now !== BigInt(ticket.b0!)) {
        return refuse(409, 'output-balance-changed', 'The balance of your output account changed since prepare (a transfer in or out, another swap, or the account was closed), so this request signed and sent nothing.', {
          balanceAtPrepare: ticket.b0, balanceNow: now,
        });
      }
    }
    const signed = await countersign(false);
    // Signed, not sent: the agent sends these bytes itself.
    if (!sendIt) {
      return json(200, { signature, status: 'signed', signedTransaction: getBase64EncodedWireTransaction(signed), lastValidBlockHeight: ticket.lvbh });
    }
    // Too late to send and still answer in time: nothing goes out. Once it starts, a send the deadline
    // cuts short is answered `unknown` (sendOnce), with the bytes to confirm on the agent's own RPC.
    if (deadline.signal.aborted) {
      return refuse(503, 'unavailable', "Orientim's Solana RPC was too slow to finish this finalize, so this request sent nothing. Try finalize again in a few seconds.", {}, { 'retry-after': '5' });
    }
    const sent = await sendOnce(rpc, signed);
    return json(200, {
      signature: sent.signature,
      status: sent.status,
      ...(sent.refusal ? { refusal: sent.refusal } : {}),
      // Why the network's own check refused it (a preflight refusal only): the simulation's error, as JSON.
      ...(sent.transactionError ? { transactionError: sent.transactionError } : {}),
      // Fully signed, so the agent can re-broadcast it and confirm it with its own RPC until it
      // expires. Not when it was refused: an agent that prepares again must not land both.
      ...(sent.status === 'rejected' ? {} : { signedTransaction: getBase64EncodedWireTransaction(signed) }),
      lastValidBlockHeight: ticket.lvbh,
    });
  } catch (e) {
    // Every path here ends before a send: say what this request did, and name the transaction.
    if (e instanceof OrientimError && e.code === 'expired') {
      return refuse(410, 'expired', 'The transaction reached the end of its lifetime before Orientim signed it now.');
    }
    if (e instanceof OrientimError && e.code === 'unavailable') {
      return refuse(503, 'unavailable', "Orientim's Solana RPC was too slow to finish this finalize, so this request sent nothing. Try finalize again in a few seconds.", {}, { 'retry-after': '5' });
    }
    if (e instanceof OrientimError && e.code === 'wallet-changed-transaction') {
      return refuse(400, e.code, 'Your wallet\'s signature does not match the transaction Orientim built; this request signed and sent nothing.', e.violations.length ? { violations: e.violations } : {});
    }
    const http = httpStatusOf(e);
    if (http === 429) return refuse(503, 'busy', "Orientim's Solana RPC is rate limited right now, so this request sent nothing. Wait a few seconds and try finalize again.", {}, { 'retry-after': '5' });
    if ((http !== null && http >= 500) || unanswered(e) || isSolanaError(e, SOLANA_ERROR__JSON_RPC__SERVER_ERROR_MIN_CONTEXT_SLOT_NOT_REACHED)) {
      return refuse(503, 'unavailable', "Orientim's Solana RPC didn't answer, so this request sent nothing. Try finalize again in a moment.", {}, { 'retry-after': '5' });
    }
    console.error(loggableError(e));
    return refuse(500, 'internal', 'Something went wrong, and this request sent nothing.');
  } finally {
    deadline.done();
  }
}
