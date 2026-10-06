import { serverConfig } from './config';
import { agentEndpoints } from './agent/config';

export type Check = { ok: boolean; ms: number };
export type Health = {
  ok: boolean;
  /** The kill switch is on: swaps are paused on purpose, which is not an outage. */
  paused: boolean;
  rpc: Check;
  /** The backup RPC (RPC_URL_FALLBACK), null when none is set. */
  rpcFallback: Check | null;
  jupiter: Check;
  /**
   * The agent API as it runs: its own RPC (RPC_URL_AGENTS, or the site's) and a swap Jupiter builds
   * with its own key (JUPITER_API_KEY_AGENTS, or the site's), not only an answer to a search. Null
   * while the API is off.
   */
  agents: { rpc: Check; build: Check } | null;
  /**
   * The agent API: `on`, or `off` when this deployment's settings leave it off (no API secret or
   * keys, or a setting it refuses, such as a fee above 30 bps). Off is down: agents are the product.
   * A pause by the kill switch is `paused` above, not this.
   */
  agentApi: 'on' | 'off';
};

/** A small swap Jupiter is asked to build: 0.01 SOL to USDC, for a public wallet. Nothing is signed. */
const BUILD_CHECK = new URLSearchParams({
  inputMint: 'So11111111111111111111111111111111111111112', outputMint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
  amount: '10000000', taker: '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM', slippageBps: '50', maxAccounts: '64', wrapAndUnwrapSol: 'false',
});

const TIMEOUT_MS = 5_000;

async function timed(request: () => Promise<Response>, answered: (r: Response) => Promise<boolean>): Promise<Check> {
  const started = Date.now();
  try {
    const res = await request();
    return { ok: res.ok && (await answered(res)), ms: Date.now() - started };
  } catch {
    return { ok: false, ms: Date.now() - started };
  }
}

const rpcCheck = (url: string, fetchImpl: typeof fetch) =>
  timed(
    () => fetchImpl(url, {
      method: 'POST', headers: { 'content-type': 'application/json' }, cache: 'no-store',
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getBlockHeight' }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    }),
    async r => typeof ((await r.json()) as { result?: unknown })?.result === 'number',
  );

/**
 * Whether a swap could go through right now: the RPC answers, Jupiter answers with Orientim's key,
 * the agent API is on, its own RPC answers and Jupiter builds a swap with its own key. For an
 * uptime monitor (every few minutes); it names no URL and no key. Swaps paused by the kill switch
 * are reported, not counted as down.
 */
export async function checkHealth(fetchImpl: typeof fetch = (...a) => fetch(...a)): Promise<Health> {
  const { rpcUrl, rpcFallbackUrl, jupiterApiKey, disabled } = serverConfig();
  const [rpc, rpcFallback, jupiter] = await Promise.all([
    rpcCheck(rpcUrl, fetchImpl),
    rpcFallbackUrl ? rpcCheck(rpcFallbackUrl, fetchImpl) : Promise.resolve(null),
    timed(
      () => fetchImpl('https://api.jup.ag/tokens/v2/search?query=So11111111111111111111111111111111111111112', {
        headers: jupiterApiKey ? { 'x-api-key': jupiterApiKey } : {}, cache: 'no-store',
        signal: AbortSignal.timeout(TIMEOUT_MS),
      }),
      async r => Array.isArray(await r.json()),
    ),
  ]);
  // With a backup, the RPC side is up while either of them answers.
  const rpcUp = rpc.ok || rpcFallback?.ok === true;
  const agents = await agentsCheck(fetchImpl, rpcUrl, rpc);
  const agentsUp = !!agents && (agents.rpc.ok || rpcFallback?.ok === true) && agents.build.ok;
  return { ok: rpcUp && jupiter.ok && agentsUp, paused: disabled, rpc, rpcFallback, jupiter, agents, agentApi: agents ? 'on' : 'off' };
}

/** The agent API's own RPC and a swap built with its own Jupiter key; null while the API is off. */
async function agentsCheck(fetchImpl: typeof fetch, siteRpcUrl: string, siteRpc: Check): Promise<Health['agents']> {
  const endpoints = agentEndpoints();
  if (!endpoints) return null;
  // The same RPC as the site's is asked once; the backup serves the agent API too.
  const [rpc, build] = await Promise.all([
    endpoints.rpcUrl === siteRpcUrl ? Promise.resolve(siteRpc) : rpcCheck(endpoints.rpcUrl, fetchImpl),
    timed(
      () => fetchImpl(`https://api.jup.ag/swap/v2/build?${BUILD_CHECK}`, {
        headers: endpoints.jupiterApiKey ? { 'x-api-key': endpoints.jupiterApiKey } : {}, cache: 'no-store',
        signal: AbortSignal.timeout(TIMEOUT_MS),
      }),
      async r => {
        const body = (await r.json()) as { outAmount?: unknown; swapInstruction?: unknown };
        return typeof body?.outAmount === 'string' && !!body.swapInstruction;
      },
    ),
  ]);
  return { rpc, build };
}

export type SwapState = 'running' | 'degraded' | 'paused';

/** What the status page shows: paused by the kill switch, running, or degraded when a check fails. */
export function swapStateOf(health: Pick<Health, 'ok' | 'paused'>): SwapState {
  return health.paused ? 'paused' : health.ok ? 'running' : 'degraded';
}

const STATE_FRESH_MS = 60_000;
let lastState: { at: number; state: Promise<SwapState> } | null = null;

/**
 * The status page's state, from the same checks as /api/health, asked at most once a minute by each
 * server instance, so that visits to the page do not each ask the RPC and Jupiter.
 */
export function swapState(now = Date.now(), fetchImpl?: typeof fetch): Promise<SwapState> {
  if (lastState && now - lastState.at < STATE_FRESH_MS) return lastState.state;
  const state = checkHealth(fetchImpl).then(swapStateOf, () => 'degraded' as const);
  lastState = { at: now, state };
  return state;
}

/**
 * What /api/health answers: checkHealth at most once every 15 seconds per instance. Each check builds a
 * swap on Jupiter and reads the RPC, so callers that poll it cannot spend the quota real swaps need.
 */
const HEALTH_FRESH_MS = 15_000;
let lastHealth: { at: number; health: Promise<Health> } | null = null;
export function recentHealth(now = Date.now(), fetchImpl?: typeof fetch): Promise<Health> {
  if (lastHealth && now - lastHealth.at < HEALTH_FRESH_MS) return lastHealth.health;
  const health = checkHealth(fetchImpl);
  lastHealth = { at: now, health };
  // A check that threw is not kept: the next caller asks again.
  health.catch(() => { if (lastHealth?.health === health) lastHealth = null; });
  return health;
}
