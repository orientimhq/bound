import { AccountRole, address, isAddress } from '@solana/kit';
import type { Address, Instruction } from '@solana/kit';

export type ApiAccount = { pubkey: string; isSigner: boolean; isWritable: boolean };
export type ApiInstruction = { programId: string; accounts: ApiAccount[]; data: string };

export type BuildResponse = {
  inputMint: string;
  outputMint: string;
  inAmount: string;
  outAmount: string;
  otherAmountThreshold: string;
  priceImpactPct?: string;
  routePlan: { percent: number; swapInfo: { label: string; ammKey: string } }[];
  computeBudgetInstructions: ApiInstruction[];
  setupInstructions: ApiInstruction[];
  swapInstruction: ApiInstruction;
  cleanupInstruction: ApiInstruction | null;
  otherInstructions: ApiInstruction[];
  addressesByLookupTableAddress: Record<string, string[]> | null;
};

export type BuildParams = {
  inputMint: Address;
  outputMint: Address;
  amount: bigint;
  taker: Address;
  slippageBps: number;
  maxAccounts: number;
  /** Opt-in Jupiter beta router. Omitted for the standard route. */
  mode?: 'fast';
  destinationTokenAccount?: Address;
  excludeDexes?: readonly string[];
};

export type TokenInfo = {
  id: string;
  name: string;
  symbol: string;
  icon?: string;
  decimals: number;
  tokenProgram: string;
  isVerified?: boolean;
  usdPrice?: number;
  audit?: { mintAuthorityDisabled?: boolean; freezeAuthorityDisabled?: boolean };
  /** When the token was created (ISO 8601), as Jupiter lists it. */
  createdAt?: string;
};

export type JupiterClient = {
  build(params: BuildParams): Promise<BuildResponse>;
  searchTokens(query: string): Promise<TokenInfo[]>;
  programLabels(): Promise<Record<string, string>>;
};

export class JupiterError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
/** How long a page waits after Jupiter kept refusing with 429 before it asks again. */
const COOL_DOWN_MS = 5_000;

const UINT = /^\d{1,20}$/;

/**
 * How long Jupiter asks us to wait, or null. Its 429s carry `x-ratelimit-reset`, the Unix time in
 * seconds when the oldest request leaves its sliding window (developers.jup.ag/docs/portal/rate-limit);
 * a `Retry-After` in seconds is read too.
 */
export function serverWaitMs(headers: Headers, now = Date.now()): number | null {
  const after = Number(headers.get('retry-after'));
  if (after > 0) return after * 1000;
  const reset = Number(headers.get('x-ratelimit-reset'));
  if (!(reset > 0)) return null;
  const wait = reset * 1000 - now;
  return wait > 0 ? wait : null;
}

/**
 * Jupiter is untrusted: a malformed answer becomes a JupiterError here instead of a confusing
 * crash further down (for example `BigInt` on a non-numeric amount).
 */
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

export function checkBuildResponse(r: unknown): BuildResponse {
  const b = r as Partial<BuildResponse> | null;
  const ix = b?.swapInstruction;
  // Values too, not only shapes: a route an agent brings goes through here, and an address or data
  // that cannot be decoded must be a refusal, not a crash when the instruction is compiled.
  const isKey = (v: unknown): v is string => typeof v === 'string' && isAddress(v);
  const isAccount = (a: unknown) => {
    const x = a as Partial<ApiAccount> | null;
    return !!x && isKey(x.pubkey) && typeof x.isSigner === 'boolean' && typeof x.isWritable === 'boolean';
  };
  const isInstruction = (i: unknown) => {
    const x = i as Partial<ApiInstruction> | null;
    return !!x && isKey(x.programId) && Array.isArray(x.accounts) && x.accounts.every(isAccount) && typeof x.data === 'string' && BASE64.test(x.data);
  };
  const tables = b?.addressesByLookupTableAddress;
  // Every part the pipeline reads, down to the labels and the lookup tables, so that a malformed
  // answer is a refusal here and never a crash in the middle of a build (TypeError on a missing label).
  const ok =
    !!b && typeof b === 'object' &&
    isKey(b.inputMint) && isKey(b.outputMint) &&
    UINT.test(String(b.inAmount)) && UINT.test(String(b.outAmount)) && UINT.test(String(b.otherAmountThreshold)) &&
    Array.isArray(b.routePlan) && b.routePlan.every(p => typeof p?.swapInfo?.label === 'string') &&
    Array.isArray(b.setupInstructions) && b.setupInstructions.every(isInstruction) &&
    isInstruction(ix) &&
    (tables === null || tables === undefined || (typeof tables === 'object' && !Array.isArray(tables)
      && Object.entries(tables).every(([table, list]) => isKey(table) && Array.isArray(list) && list.every(isKey))));
  if (!ok) throw new JupiterError('Jupiter returned a malformed quote', 502);
  return b as BuildResponse;
}

/**
 * Jupiter Swap API V2. In the browser the URLs point at Orientim's stateless proxy, which adds
 * the API key; on the server they point at api.jup.ag directly.
 */
export function createJupiterClient(opts: {
  buildUrl: string;
  tokensUrl: string;
  labelsUrl: string;
  apiKey?: string;
  fetchImpl?: typeof fetch;
  /** Minimum gap between calls (keyless access is rate limited). */
  minIntervalMs?: number;
  /** The first retry's wait; each later one doubles it. */
  retryBaseMs?: number;
  /**
   * Gives up on a request after this long: a server calling Jupiter directly needs one, or a silent
   * Jupiter holds the request to its limit.
   */
  timeoutMs?: number;
}): JupiterClient {
  const doFetch = opts.fetchImpl ?? fetch.bind(globalThis);
  const retryBaseMs = opts.retryBaseMs ?? 600;
  let lastCall = 0;
  // Once Jupiter has refused every retry with 429, this page stops asking for a few seconds. The
  // key is shared by every user of the site: asking again at once only prolongs the overload.
  let coolUntil = 0;
  const headers: Record<string, string> = opts.apiKey ? { 'x-api-key': opts.apiKey } : {};
  let labels: Record<string, string> | null = null;

  async function get<T>(url: string): Promise<T> {
    if (Date.now() < coolUntil) throw new JupiterError('Jupiter 429: still cooling down after too many requests', 429);
    for (let attempt = 0; ; attempt++) {
      const wait = lastCall + (opts.minIntervalMs ?? 0) - Date.now();
      if (wait > 0) await sleep(wait);
      lastCall = Date.now();
      let res: Response;
      try {
        res = await doFetch(url, { headers, ...(opts.timeoutMs ? { signal: AbortSignal.timeout(opts.timeoutMs) } : {}) });
      } catch (e) {
        if ((e as Error)?.name === 'TimeoutError') throw new JupiterError('Jupiter did not answer in time', 504);
        throw e;
      }
      const body = await res.text();
      // Jupiter wraps transient upstream failures ("Pool has not been updated in a while") in a 400.
      // Also a market whose oracle is behind for a moment ("Oracle is stale", "price out of date"),
      // which Jupiter wraps in a 400 as well; never a refusal of the trade itself.
      const retryable = res.status === 429 || res.status >= 500 || (res.status === 400
        && /quote failed|not been updated|oracle|stale|expired|temporarily unavailable|no matching liquidity|"500: /i.test(body)
        && (!/no routes? found|could not find any route|missing token program|cannot be same as/i.test(body)
          // A token program Jupiter's own service could not find, inside its 500: its index lagging.
          || (/"500: /.test(body) && /missing token program/i.test(body))));
      if (retryable && attempt < 3) {
        // Jittered, so pages refused together do not all retry at the same moment; Jupiter's own
        // wait is honoured up to a few seconds.
        const told = serverWaitMs(res.headers);
        await sleep(told !== null ? Math.min(told, COOL_DOWN_MS) : retryBaseMs * 2 ** attempt * (0.5 + Math.random()));
        continue;
      }
      if (res.status === 429) coolUntil = Date.now() + COOL_DOWN_MS;
      if (!res.ok) throw new JupiterError(`Jupiter ${res.status}: ${body.slice(0, 240)}`, res.status);
      return JSON.parse(body) as T;
    }
  }

  return {
    build(p) {
      const qs = new URLSearchParams({
        inputMint: p.inputMint,
        outputMint: p.outputMint,
        amount: p.amount.toString(),
        taker: p.taker,
        slippageBps: String(p.slippageBps),
        maxAccounts: String(p.maxAccounts),
        // SOL is wrapped and unwrapped by Orientim's own trusted instructions, never by Jupiter.
        wrapAndUnwrapSol: 'false',
      });
      // Never `payer`: with payer = W, W appeared inside the swap instruction.
      if (p.destinationTokenAccount) qs.set('destinationTokenAccount', p.destinationTokenAccount);
      if (p.excludeDexes?.length) qs.set('excludeDexes', p.excludeDexes.join(','));
      if (p.mode) qs.set('mode', p.mode);
      return get<unknown>(`${opts.buildUrl}?${qs}`).then(checkBuildResponse);
    },
    async searchTokens(query) {
      return get<TokenInfo[]>(`${opts.tokensUrl}?${new URLSearchParams({ query })}`);
    },
    async programLabels() {
      labels ??= await get<Record<string, string>>(opts.labelsUrl);
      return labels;
    },
  };
}

const decodeBase64 = (s: string) => Uint8Array.from(atob(s), c => c.charCodeAt(0));

export function toKitInstruction(ix: ApiInstruction): Instruction {
  return {
    programAddress: address(ix.programId),
    accounts: ix.accounts.map(a => ({
      address: address(a.pubkey),
      role: a.isSigner
        ? (a.isWritable ? AccountRole.WRITABLE_SIGNER : AccountRole.READONLY_SIGNER)
        : (a.isWritable ? AccountRole.WRITABLE : AccountRole.READONLY),
    })),
    data: decodeBase64(ix.data),
  };
}
