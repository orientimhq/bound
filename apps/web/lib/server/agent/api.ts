import {
  getBase64EncodedWireTransaction, getPublicKeyFromAddress, getSignatureFromTransaction, getTransactionDecoder, isAddress, isSolanaError,
  SOLANA_ERROR__JSON_RPC__INTERNAL_ERROR, SOLANA_ERROR__JSON_RPC__METHOD_NOT_FOUND, SOLANA_ERROR__JSON_RPC__SERVER_ERROR_NODE_UNHEALTHY,
  SOLANA_ERROR__JSON_RPC__SERVER_ERROR_MIN_CONTEXT_SLOT_NOT_REACHED, verifySignature,
} from '@solana/kit';
import type { Address, Transaction } from '@solana/kit';
import { JUPITER_PROGRAM, tokenAmountOf, WSOL_MINT } from '@orientimhq/swap/core';
import { TOKEN_2022_PROGRAM } from '@orientimhq/swap/core';
import { MAX_CHOSEN_SLIPPAGE_BPS } from '@orientimhq/swap/core';
import type { AccountState, TxVersion } from '@orientimhq/swap/core';
import { OrientimError, countersignProtectedSwap, DEFAULT_SETTINGS, parseProvidedRoutes, prepareProtectedSwap, providedRoutes, RoutesNeeded, RoutesUntrusted } from '@orientim/jupiter';
import type { FeeTier, JupiterClient, PriorityFeeLevel, ReferencePrice, SolValue } from '@orientim/jupiter';
import { BLOCKHASH_LIFE_BLOCKS, httpStatusOf, mintInfoOf, provesNeverLanded, readAccounts, sendOnce } from '@orientimhq/swap/solana';
import { hasPermanentDelegate } from '@orientimhq/swap/verifier';
import type { SolanaRpc } from '@orientimhq/swap/solana';
import { readBodyLimited } from '../body';
import { loggableError, logEvent, maskedReason } from './events';
import { clientKey, limit } from '../rateLimit';
import { memoryShared, type Shared } from '../shared';
import { openKey } from './keys';
import { ephemeralFor, kidOf, newNonce, openSession, openTicket, REFERENCE_FRESH_MS, sealSession, sealTicket, SESSION_TTL_SECONDS } from './ticket';
import type { SessionReference, SessionSolValue, SessionTerms } from './ticket';

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
  /**
   * Swaps on an active Pump.fun curve built from the chain rather than asked of Jupiter or of the
   * agent (ORIENTIM_LOCAL_CURVE, curveRoute.ts): wraps each request's clients, with its RPC.
   */
  curveRoutes?: (client: JupiterClient, rpc: SolanaRpc) => JupiterClient;
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
  /** A lower fee for a large swap (NEXT_PUBLIC_ORIENTIM_FEE_TIER_BPS); none: `feeBps` at every size. */
  feeTiers?: readonly FeeTier[];
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
  /** Finalize requests per minute per API key; `perMinute` when unset. */
  finalizePerMinute?: number;
  /** Prepare requests per minute from one client address, over all its keys; none when unset. */
  ipPerMinute?: number;
  /** Prepare requests per minute over all keys and addresses, the share of Jupiter's and the RPC's quota the plan allows; none when unset. */
  totalPerMinute?: number;
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
  /**
   * State every instance sees (shared.ts): Redis when the deployment has it. Without it, this
   * instance's memory: one message per E and one swap in flight per output account then hold per
   * instance only, and the rate limit is the instance's own.
   */
  shared?: Shared;
  /**
   * Finalize signs only with `shared` in Redis (shared.ts, sharedRequired): set in production, where
   * instances share no memory. Prepare signs nothing, and runs either way.
   */
  sharedRequired?: boolean;
  /**
   * With one instance (env.ts, ORIENTIM_SINGLE_INSTANCE): this start's id. Tickets and sessions carry
   * it, and one from an earlier start is refused, since what that start noted in memory is gone.
   */
  boot?: string;
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
/**
 * The output balance may grow by the minimum over this much between prepare and finalize (dust
 * anyone can send it) and the swap is still signed: 100,000, a thousandth of a percent.
 */
export const DUST_DIVISOR = 100_000n;

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
async function authenticate(req: Request, deps: AgentDeps, endpoint: 'prepare' | 'finalize'): Promise<{ id: string; wallet: string | null } | Response> {
  const header = req.headers.get('authorization') ?? '';
  const key = /^Bearer\s+(\S{16,400})$/i.exec(header)?.[1];
  const manual = key ? deps.keys.get(await sha256Hex(new TextEncoder().encode(key))) : undefined;
  const own = !manual && key && deps.keySecrets?.length
    ? await openKey(deps.keySecrets, key, Math.floor(Date.now() / 1000), deps.revokedWallets)
    : null;
  const auth = manual ? { id: manual, wallet: null } : own;
  if (!auth) return fail(401, 'unauthorized', 'A valid API key is required: Authorization: Bearer <key>. This one is missing, unknown, expired or revoked; a wallet gets a new key by signing a new key challenge.');
  const bucket = `agent:${new URL(req.url).pathname}:${auth.id}`;
  const shared = deps.shared?.kind === 'redis' ? deps.shared : null;
  const perKey = endpoint === 'finalize' ? (deps.finalizePerMinute ?? deps.perMinute) : deps.perMinute;
  const wait = await limit(bucket, perKey, 60_000, shared);
  if (wait !== null) {
    return fail(429, 'rate-limited', 'Too many requests for this API key. Wait Retry-After seconds and try again.', {}, { 'retry-after': String(wait) });
  }
  // Only prepare spends Jupiter's and the RPC's quota before a swap is signed; a swap already signed
  // is always finalized. A request this key's own limit refused counts in neither.
  if (endpoint === 'prepare' && deps.ipPerMinute) {
    const waitIp = await limit(`agent-ip:${clientKey(req)}`, deps.ipPerMinute, 60_000, shared);
    if (waitIp !== null) {
      return fail(429, 'rate-limited', 'Too many requests from this address over all its keys. Wait Retry-After seconds and try again.', {}, { 'retry-after': String(waitIp) });
    }
  }
  if (endpoint === 'prepare' && deps.totalPerMinute) {
    const waitAll = await limit('agent-all:prepare', deps.totalPerMinute, 60_000, shared);
    if (waitAll !== null) {
      return fail(503, 'busy', 'Orientim is at its capacity for new swaps right now. Nothing was built or signed. Wait Retry-After seconds and try again.', {}, { 'retry-after': String(waitAll) });
    }
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
  // Any other HTTP error from the RPC is the RPC's, not the swap's: a 5xx, or a backup whose key has
  // expired or whose plan ran out (401, 402, 403).
  if (http !== null || unanswered(e)) {
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

/**
 * What a mint's issuer can do: freeze or mint, and, with a Token-2022 permanent delegate, move or burn
 * any holder's balance.
 */
/**
 * 0.001 SOL: about what a swap's network fee and a new token account need, so that a wallet emptied
 * after getting its key prepares nothing.
 */
const MIN_WALLET_LAMPORTS = 1_000_000n;

const issuerPowers = (s: AccountState) => {
  const m = mintInfoOf(s);
  return { freezeAuthority: m.freezeAuthority, mintAuthority: m.mintAuthority, permanentDelegate: s.owner === TOKEN_2022_PROGRAM && hasPermanentDelegate(s.data) };
};

export async function agentPrepare(req: Request, deps: AgentDeps): Promise<Response> {
  if (deps.disabled) return fail(503, 'paused', 'Protected swaps are paused. Nothing was built.');
  const auth = await authenticate(req, deps, 'prepare');
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
  // The terms a session holds the rounds to (see `SessionTerms`).
  const terms: SessionTerms = {
    slip: typeof slippageBps === 'number' ? slippageBps : null,
    cost: acceptCostBps === undefined ? null : acceptCostBps.toString(),
    mode: body.routingMode === 'fast' ? 'fast' : 'standard',
    min: minOut === undefined ? null : minOut.toString(),
  };
  let routes: ReturnType<typeof providedRoutes> | null = null;
  let sessionNonce: string | null = null;
  // A session ends two minutes after the first round, however many rounds follow.
  let sessionExp: number | null = null;
  // Orientim's own price an earlier round sealed into the session (see `reference` below).
  let sessionRef: SessionReference | null = null;
  // What the input was worth in SOL, for a fee in SOL from the wallet, as an earlier round sealed it.
  let sessionSol: SessionSolValue | null = null;
  // How many routes the agent brought this round (for the operator's count).
  let sessionSecret: Uint8Array | null = null;
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
      // A session opens only for the swap and the key it was sealed for, under any secret still
      // accepted: a rotation does not end the sessions open at that moment (two minutes at most).
      if (!s || s.key !== key || s.owner !== owner || s.inputMint !== inputMint
        || s.outputMint !== outputMint || s.amountIn !== amountIn.toString() || s.version !== version || s.boot !== deps.boot) {
        return fail(400, 'bad-session', 'This session is expired, or was opened for another swap or key: prepare again without it. Nothing was built.');
      }
      // E is one per session: a term, once a round has sent it, stays what it was. A first round may
      // leave some for later (its own minimum and tolerance, while the agent asks Jupiter its price).
      const t = s.terms;
      const kept = (was: string | number | null, now: string | number | null) => was === null || was === now;
      if (!t || t.mode !== terms.mode || !kept(t.slip, terms.slip) || !kept(t.cost, terms.cost) || !kept(t.min, terms.min)) {
        return fail(400, 'bad-session', 'This session was opened for other terms (slippageBps, acceptCostBps, routingMode or minOut): prepare again without it, with the terms you want. Nothing was built.');
      }
      sessionNonce = s.nonce;
      // E comes from the secret that opened the session, as finalize derives it from the ticket's.
      sessionSecret = opened.secret;
      sessionExp = s.exp;
      sessionRef = s.ref ?? null;
      sessionSol = s.sol ?? null;
    }
  }

  // One deadline for the whole prepare: the mints read, the build, and the block height read.
  const deadline = deadlineFor(deps.prepareDeadlineMs ?? PREPARE_DEADLINE_MS, deps.rpc, deps.jupiter);
  try {
    const [inMint, outMint] = [inputMint as Address, outputMint as Address];
    // The mints are read once, by the build itself, which refuses a token Orientim cannot swap.
    const nonce = sessionNonce ?? newNonce();
    const secret = sessionSecret ?? deps.secrets[0];
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
      ...(deps.boot ? { boot: deps.boot } : {}),
      ...(price ? { ref: { out: price.value.out.toString(), min: price.value.minimum.toString(), at: price.at, slip, feeBps: deps.feeBps.toString(), treasury: treasuryText } } : {}),
      ...(solValue ? { sol: { amount: solValue.value.amount.toString(), value: solValue.value.value.toString(), at: solValue.at, slip: solSlip } } : {}),
      terms,
    }));
    // From an agent's own routes, or Orientim's client; Orientim's fee in SOL is always priced by its
    // own, and with an agent's routes a fee on the output is held to its own price (`reference`).
    // A curve route built here asks neither Jupiter nor the agent (curveRoutes).
    const curve = (client: JupiterClient) => (deps.curveRoutes ? deps.curveRoutes(client, deadline.rpc) : client);
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
          ...(deps.feeTiers?.length ? { feeTiers: deps.feeTiers } : {}),
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
        // The agent's floor is what its wallet keeps; with a fee on the output, Orientim enforces more.
        // A first round without a minimum builds nothing: it ends asking for routes (below).
        acceptedMinReceived: minOut ?? 1n, acceptedCostBps: acceptCostBps, version,
        // A self-serve key is free to make: its wallet must hold what the swap needs before Jupiter is asked.
        ...(auth.wallet ? { minWalletLamports: MIN_WALLET_LAMPORTS } : {}),
        ...(body.routingMode === 'fast' ? { routingMode: 'fast' as const } : {}),
      },
    ));
    let prepared: Awaited<ReturnType<typeof prepareProtectedSwap>>;
    // Where the swap's routes came from, for the operator's count: the agent's, or Orientim's.
    let routesFrom: 'agent' | 'orientim' | 'orientim-fallback' = routes ? 'agent' : 'orientim';
    try {
      prepared = routes ? await build(curve(deadline.bind(routes)), curve(deadline.jupiter)) : await build(curve(deadline.jupiter));
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
      prepared = await build(curve(deadline.jupiter));
    }
    // The hash finalize will hold the agent to, computed here from the bytes rather than taken from
    // the certificate: it is the one value the fee depends on.
    const messageSha256 = await sha256Hex(prepared.transaction.messageBytes);
    const wOut = prepared.policy.accounts.wOut;
    const ticket = await sealTicket(secret, {
      v: 1, kid: await kidOf(secret), nonce, key, owner: owner as string, msg: messageSha256,
      lvbh: prepared.lifetime.lastValidBlockHeight.toString(),
      ...(wOut ? { wOut, b0: prepared.outputBalanceBefore.toString(), dust: (prepared.policy.minOut / DUST_DIVISOR).toString() } : {}),
      ...(wOut && prepared.contextSlot > 0n ? { slot: prepared.contextSlot.toString() } : {}),
      ...(deps.boot ? { boot: deps.boot } : {}),
    });
    // Never a swap without the agent's own minimum: a first round can only ask for routes.
    if (minOut === undefined) return fail(400, 'bad-request', 'minOut is required to build the swap. Prepare again with it.');
    const p = prepared.policy;
    logEvent('prepared', { key, routes: routesFrom, brought: providedCount, feeSide: p.feeSide, version });
    const feeMint = p.feeSide === 'output' ? p.outputMint : p.feeSide === 'sol' ? WSOL_MINT : p.inputMint;
    const solFee = feeMint === WSOL_MINT ? p.fee : 0n;
    // What the transaction has left to live, in blocks: 150 at most, about 40 s, from the height read
    // with the last simulation; left out when it could not be read, and the swap is still answered.
    const height = prepared.blockHeight;
    return json(200, {
      ticket,
      transaction: getBase64EncodedWireTransaction(prepared.transaction),
      messageSha256,
      wallet: owner,
      temporaryAuthority: E.address,
      version,
      lastValidBlockHeight: prepared.lifetime.lastValidBlockHeight,
      ...(height === null ? {} : { blocksLeft: prepared.lifetime.lastValidBlockHeight - BigInt(height) }),
      // The slot the swap was built and verified on: the agent's own check reads its RPC no older.
      ...(prepared.contextSlot > 0n ? { contextSlot: prepared.contextSlot } : {}),
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
        input: issuerPowers(prepared.mintAccounts.input),
        output: issuerPowers(prepared.mintAccounts.output),
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

/**
 * The one message E has signed, per E's nonce: E is a one-time key, and a session (whose rounds
 * share one E, since the routes the agent fetched are built around it) could otherwise be replayed
 * into several swaps of different terms, each signed by the same E. A first round may leave the
 * minimum and the tolerance open, so prepare cannot tell a replay from the round that fills them in;
 * finalize can: it signs one message per E, and the same one again as often as asked. Kept past any
 * ticket's life (a session's two minutes, then a blockhash's), in the deployment's shared state, so
 * that two instances cannot each sign another message with the same E.
 */
const SIGNED_BY_E_MS = 10 * 60_000;
/** This instance's memory, for deployments (and tests) without shared state. */
const localShared = memoryShared();

const eKey = (nonce: string) => `orientim:e:${nonce}`;

/**
 * May E (of `nonce`) sign `msg`? `first` when this request noted it, in one step; `again` for the
 * message E already has; null for another. A request that signs it again marks the note first
 * (AGAIN), as with the output hold: the request that noted it then never gives it back, since the
 * bytes may be out through this one. Unmarked, it is given back whenever E's signature never left.
 */
async function oneMessagePerE(shared: Shared, nonce: string, msg: string): Promise<'first' | 'again' | null> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const had = await shared.claim(eKey(nonce), msg, SIGNED_BY_E_MS);
    if (had === null) return 'first';
    if (had === `${msg}${AGAIN}`) return 'again';
    if (had !== msg) return null;
    if (await shared.replace(eKey(nonce), msg, `${msg}${AGAIN}`, SIGNED_BY_E_MS)) return 'again';
    // Given back between the two steps: look again.
  }
  throw new Error('The one-time key\'s note kept changing.');
}

/**
 * One swap in flight per output account. The minimum-output check is the account's balance at
 * prepare plus the minimum: two swaps into one account, both signed before either lands, would each
 * see the other's tokens count towards its own minimum. So finalize holds the account for the
 * transaction it signs (its message hash and its signature) until that transaction can no longer
 * land, and signs another swap into the account only once the first has landed or failed on chain,
 * with the account's balance read again after it (the second swap's prepare must have seen it).
 */
const outputKey = (ticket: { wOut?: string; owner: string }) => `orientim:out:${ticket.wOut ?? `${ticket.owner}:sol`}`;
/**
 * Held for as long as any transaction lives and then some: the hold ends by the chain, not the
 * clock. Another swap takes the account over once the holder landed, or once the finalized chain
 * proves it never will (holdOver); the time is only a backstop.
 */
const HOLD_MS = 10 * 60_000;
/**
 * What a hold says: the message, the signature, the last block height it can land at, and, once a
 * repeated finalize of the same transaction has signed it too, `:again`. A hold so marked is never
 * given back by the finalize that took it: the bytes may be out through the other request.
 */
const holdOf = (msg: string, signature: string, lvbh: string) => `${msg}:${signature}:${lvbh}`;
const AGAIN = ':again';

/**
 * May a swap take over the account `holder` holds? Yes once the holder's transaction landed (or
 * failed) on chain at confirmed, or provably never landed and never will. The slot to read the
 * account's balance at, no older than the answer that said so.
 */
async function holdOver(rpc: SolanaRpc, holder: string): Promise<{ over: boolean; slot?: bigint }> {
  const [, signature, lvbh] = holder.split(':');
  // As statusesCovering reads it, keeping the slot the statuses were answered at.
  const finalized = await rpc.getEpochInfo({ commitment: 'finalized' }).send();
  const { context, value } = await rpc.getSignatureStatuses([signature as never], { searchTransactionHistory: true }).send();
  const at = context?.slot !== undefined ? BigInt(context.slot) : undefined;
  const status = value[0] as { confirmationStatus?: string } | null;
  if (status) return { over: status.confirmationStatus === 'confirmed' || status.confirmationStatus === 'finalized', slot: at };
  if (!lvbh || !/^\d+$/.test(lvbh) || at === undefined || finalized.blockHeight === undefined) return { over: false };
  const ahead = at - BigInt(finalized.absoluteSlot);
  if (ahead < 0n) return { over: false };
  const height = BigInt(finalized.blockHeight);
  const last = BigInt(lvbh);
  return { over: provesNeverLanded({ coveredHeight: height, reachHeight: height + ahead }, last, last - BLOCKHASH_LIFE_BLOCKS + 1n), slot: at };
}

export async function agentFinalize(req: Request, deps: AgentDeps): Promise<Response> {
  const auth = await authenticate(req, deps, 'finalize');
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
  // The wallet's signature is checked before anything is noted in the shared state: a request with
  // a made-up one must not hold the output account, or be taken for the transaction it names.
  const walletSignature = returned.signatures[ticket.owner as Address];
  let walletSigned = false;
  try {
    walletSigned = !!walletSignature && await verifySignature(await getPublicKeyFromAddress(ticket.owner as Address), walletSignature, returned.messageBytes);
  } catch {
    walletSigned = false;
  }
  if (!walletSigned) {
    return fail(400, 'wallet-changed-transaction', "Your wallet's signature does not match the transaction Orientim built; this request signed and sent nothing.");
  }
  const known = { signature, lastValidBlockHeight: ticket.lvbh };
  const refuse = (status: number, code: string, message: string, extra: Record<string, unknown> = {}, headers: Record<string, string> = {}) =>
    fail(status, code, `${message} ${EARLIER}`, { ...extra, ...known }, headers);

  // What the chain knows of this transaction comes before any condition for a first send: a repeated
  // finalize must describe the transaction it repeats, never invite a second swap.
  // One deadline for the whole finalize: every read, the signing and the send.
  const deadline = deadlineFor(deps.finalizeDeadlineMs ?? FINALIZE_DEADLINE_MS, deps.rpc, deps.jupiter);
  const rpc = deadline.rpc;
  // The output account's balance and the block height a first send needs are read with it, all at
  // once; each is still judged in turn, the chain's record of this transaction first.
  // Each failure is met where its value is awaited, never as an unhandled rejection.
  const quiet = <T>(p: Promise<T>) => { p.catch(() => undefined); return p; };
  // No older than the slot the swap was built on, when the ticket says it: never the balance from before.
  const outputNow = ticket.wOut
    ? quiet(readAccounts(rpc, [ticket.wOut as Address], ticket.slot ? { minContextSlot: BigInt(ticket.slot) } : {}).then(r => tokenAmountOf(r.accounts.get(ticket.wOut!)?.data)))
    : null;
  const blockHeight = quiet(rpc.getBlockHeight({ commitment: 'confirmed' }).send());
  let onChain: unknown;
  try {
    onChain = (await rpc.getSignatureStatuses([signature as never], { searchTransactionHistory: true }).send()).value[0];
  } catch {
    deadline.done();
    return refuse(503, 'unavailable', 'Orientim could not read from the network whether this transaction was already sent, so this request sent nothing. Try finalize again in a few seconds.', {}, { 'retry-after': '5' });
  }

  // The output account this request holds, and E's message it noted first, once it does: both given
  // back whenever E's signature never left this request (`out` stays false).
  let holding: { shared: Shared; account: string; mine: string } | null = null;
  let noted: { shared: Shared; key: string; msg: string } | null = null;
  let out = false;
  const release = async () => {
    const [hold, note] = [holding, noted];
    holding = null;
    noted = null;
    if (hold) await hold.shared.drop(hold.account, hold.mine).catch(() => undefined);
    if (note) await note.shared.drop(note.key, note.msg).catch(() => undefined);
  };
  try {
    const E = await ephemeralFor(secret, ticket.nonce);
    const original: Transaction = { messageBytes: returned.messageBytes, signatures: {} } as Transaction;
    const countersign = (landed: boolean) => countersignProtectedSwap({
      rpc,
      prepared: { transaction: original, lifetime: { lastValidBlockHeight: BigInt(ticket.lvbh) }, policy: { owner: ticket.owner as Address } },
      walletSignedBytes: new Uint8Array(bytes),
      ephemeral: E,
      landed,
      blockHeight,
    });
    // Already on chain: the answer of the finalize that sent it, the same bytes, and no second send.
    // Even while paused, since it reads and sends nothing.
    if (onChain) {
      const signed = await countersign(true);
      return json(200, { signature, status: 'sent', signedTransaction: getBase64EncodedWireTransaction(signed), lastValidBlockHeight: ticket.lvbh });
    }
    if (deps.disabled) return refuse(503, 'paused', 'Protected swaps are paused. This request signed and sent nothing.');
    // Prepared before this process started (one instance): one message per E and the output accounts
    // held were noted in a memory that is gone, so nothing new is signed for it. A transaction already
    // on chain is answered above, the same bytes again.
    if (ticket.boot !== deps.boot) {
      return refuse(409, 'server-restarted', 'Orientim restarted after this swap was prepared, and signs only swaps prepared since. Prepare it again; this request signed and sent nothing.');
    }
    const shared = deps.shared ?? localShared;
    // Held per instance, one message per E and one swap per output account would not hold: nothing is signed.
    if (deps.sharedRequired && shared.kind !== 'redis') {
      return refuse(503, 'unavailable', 'This deployment has no state its instances share (Redis is not configured), so Orientim signs no swap here and this request signed and sent nothing. The operator has to connect it; retrying will not help until then.');
    }
    // The minimum-output check is the output account's balance at prepare plus the minimum. If the
    // balance moved since (another swap into this token, a transfer), the check could count those
    // tokens: sign nothing. Run one swap per output token until it is confirmed.
    if (outputNow) {
      const now = await outputNow;
      const grew = now - BigInt(ticket.b0!);
      if (grew < 0n || grew > BigInt(ticket.dust ?? '0')) {
        return refuse(409, 'output-balance-changed', 'The balance of your output account changed since prepare (a transfer in or out, another swap, or the account was closed), so this request signed and sent nothing.', {
          balanceAtPrepare: ticket.b0, balanceNow: now,
        });
      }
    }
    const stateDown = () => refuse(503, 'unavailable', 'Orientim could not reach the state its instances share, so this request signed and sent nothing. Try finalize again in a few seconds.', {}, { 'retry-after': '5' });
    // Checked and noted in one step, for every instance at once: two finalizes cannot both pass.
    let forE: 'first' | 'again' | null;
    try {
      forE = await oneMessagePerE(shared, ticket.nonce, ticket.msg);
    } catch {
      return stateDown();
    }
    if (forE === 'first') noted = { shared, key: eKey(ticket.nonce), msg: ticket.msg };
    if (forE === null) {
      return refuse(409, 'session-used', 'Orientim already signed another transaction with this one-time key (an earlier round of the same session), and signs one per key. Prepare again without the session; this request signed and sent nothing.');
    }
    // The output account, held for this transaction until it can no longer land (outputKey).
    const account = outputKey(ticket);
    const mine = holdOf(ticket.msg, signature, ticket.lvbh);
    const inFlight = (theirs: string) => refuse(409, 'output-in-flight', "Another swap into this output account is signed and has not landed or expired yet: its tokens would count towards this swap's minimum, so this request signed and sent nothing. Finalize again once it confirms or expires.", { inFlight: theirs }, { 'retry-after': '5' });
    // A repeated finalize of the transaction the account is held for signs the same bytes again,
    // and marks the hold first: the request that took it then never gives it back.
    let repeat = false;
    for (let attempt = 0; ; attempt++) {
      let holder: string | null;
      try {
        holder = await shared.claim(account, mine, HOLD_MS);
      } catch {
        return stateDown();
      }
      if (holder === null) break;
      const theirs = holder.split(':')[1] ?? '';
      if (holder.startsWith(`${ticket.msg}:`)) {
        let marked: boolean;
        try {
          marked = holder.endsWith(AGAIN) || await shared.replace(account, holder, `${mine}${AGAIN}`, HOLD_MS);
        } catch {
          return stateDown();
        }
        if (marked) {
          repeat = true;
          break;
        }
      } else {
        const { over, slot } = await holdOver(rpc, holder);
        if (!over) return inFlight(theirs);
        // It landed (or failed) on chain, or never will: read the balance again, no older than the
        // answer that said so. A swap prepared before it landed was built on a balance without its
        // tokens, and is refused as any moved balance is.
        if (ticket.wOut) {
          const now = tokenAmountOf((await readAccounts(rpc, [ticket.wOut as Address], slot !== undefined ? { minContextSlot: slot } : {})).accounts.get(ticket.wOut)?.data);
          const grew = now - BigInt(ticket.b0!);
          if (grew < 0n || grew > BigInt(ticket.dust ?? '0')) {
            return refuse(409, 'output-balance-changed', 'The balance of your output account changed since prepare (a transfer in or out, another swap, or the account was closed), so this request signed and sent nothing.', {
              balanceAtPrepare: ticket.b0, balanceNow: now,
            });
          }
        }
        let took: boolean;
        try {
          took = await shared.replace(account, holder, mine, HOLD_MS);
        } catch {
          return stateDown();
        }
        if (took) break;
      }
      // The hold changed under this request (given back, taken over, marked): look again, a few times.
      if (attempt >= 2) return inFlight(theirs);
    }
    if (!repeat) holding = { shared, account, mine };
    const signed = await countersign(false);
    // Signed, not sent: the agent sends these bytes itself.
    if (!sendIt) {
      out = true;
      return json(200, { signature, status: 'signed', signedTransaction: getBase64EncodedWireTransaction(signed), lastValidBlockHeight: ticket.lvbh });
    }
    // Too late to send and still answer in time: nothing goes out. Once it starts, a send the deadline
    // cuts short is answered `unknown` (sendOnce), with the bytes to confirm on the agent's own RPC.
    if (deadline.signal.aborted) {
      return refuse(503, 'unavailable', "Orientim's Solana RPC was too slow to finish this finalize, so this request sent nothing. Try finalize again in a few seconds.", {}, { 'retry-after': '5' });
    }
    // From here the bytes may be out, until the network says it refused them.
    out = true;
    const sent = await sendOnce(rpc, signed);
    // Refused by the network: it cannot land, and the account and E are free for the next swap. Not
    // when this repeats a finalize that may have sent the same bytes: they may still land.
    if (sent.status === 'rejected' && repeat) sent.status = 'unknown';
    out = sent.status !== 'rejected';
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
    if (http !== null || unanswered(e) || isSolanaError(e, SOLANA_ERROR__JSON_RPC__SERVER_ERROR_MIN_CONTEXT_SLOT_NOT_REACHED)) {
      return refuse(503, 'unavailable', "Orientim's Solana RPC didn't answer, so this request sent nothing. Try finalize again in a moment.", {}, { 'retry-after': '5' });
    }
    console.error(loggableError(e));
    return refuse(500, 'internal', 'Something went wrong, and this request sent nothing.');
  } finally {
    // Before the answer leaves: a refusal, or a send the network refused, holds nothing.
    if (!out) await release();
    deadline.done();
  }
}
