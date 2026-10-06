import { address } from '@solana/kit';
import { createJupiterClient, heliusPriorityFee, MIN_FEE } from '@orientim/jupiter';
import type { JupiterClient, PriorityFeeLevel } from '@orientim/jupiter';
import { createServerRpc } from '../rpcFailover';
import type { SolanaRpc } from '@orientim/solana';
import { serverConfig } from '../config';
import { treasurySetting } from '../../settings';
import type { AccessDeps } from './access';
import type { AgentDeps } from './api';

/**
 * The agent API is off unless the deployment sets both of these (tools/agent-key.ts makes them).
 * They are read when a deployment starts: on Vercel a change needs a redeploy, so
 * revoking a key or pausing follows the runbook in docs/OPERATORS.md, not an edit in the dashboard.
 *
 *   ORIENTIM_API_SECRET           32 random bytes, base64: seals tickets and derives each E
 *   ORIENTIM_API_SECRET_PREVIOUS  optional, the one before it, while its tickets expire (a minute)
 *   ORIENTIM_API_KEYS             id:sha256-of-key, comma-separated; only the hashes are stored
 *   ORIENTIM_API_FEE_BPS          optional, the fee for API swaps; NEXT_PUBLIC_ORIENTIM_FEE_BPS otherwise
 *   ORIENTIM_API_PER_MINUTE       optional, requests per minute per key and endpoint (60)
 *   ORIENTIM_MIN_SKILL_VERSION    optional, the oldest skill prepare serves; older copies are asked to update
 *   ORIENTIM_KEY_SECRET           optional, 32 random bytes, base64: turns on self-serve keys (agent/keys.ts)
 *   ORIENTIM_KEY_SECRET_PREVIOUS  optional, the one before it, whose keys still open while it rotates out
 *   ORIENTIM_API_REVOKED          optional, comma-separated: `wallet` refuses all its self-serve keys,
 *                                 `wallet@seconds` those issued at or before that time (keys.ts, isRevoked)
 *   ORIENTIM_KEY_MIN_LAMPORTS     optional, what a wallet must hold to get a key (10,000,000: 0.01 SOL;
 *                                 never less than 1,000,000)
 *   ORIENTIM_PUBLIC_ORIGIN        the site's own address (https://orientim.com): the only one a key
 *                                 message names; set it wherever self-serve keys are on
 */
const said = new Set<string>();
/** Said once per instance: the settings are read on every request. */
function sayOnce(message: string, level: 'error' | 'warn' = 'error') {
  if (said.has(message)) return;
  said.add(message);
  console[level](message);
}

/**
 * A secret: canonical base64 of at least 32 bytes, as `node tools/agent-key.ts --secret` prints it.
 * Anything else (a passphrase, a hex string, base64 with a typo) leaves its feature off rather than
 * run on a secret weaker than it looks.
 */
function secretOf(value: string | undefined, name = 'A secret'): Uint8Array | null {
  const text = value?.trim();
  if (!text) return null;
  const bytes = Buffer.from(text, 'base64');
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(text) || bytes.toString('base64') !== text || bytes.length < 32) {
    sayOnce(`${name} is not 32 random bytes in base64 (node tools/agent-key.ts makes one): what it guards stays off.`);
    return null;
  }
  return new Uint8Array(bytes);
}

/** ORIENTIM_PUBLIC_ORIGIN as an origin, or null when unset; a value that is not one is said and ignored. */
function publicOrigin(): string | null | undefined {
  const text = process.env.ORIENTIM_PUBLIC_ORIGIN?.trim();
  if (!text) return null;
  try {
    const u = new URL(text);
    if (u.protocol === 'https:' || u.hostname === 'localhost' || u.hostname === '127.0.0.1') return u.origin;
  } catch {
    // Said below.
  }
  sayOnce(`ORIENTIM_PUBLIC_ORIGIN is not an https address (${text}): self-serve keys stay off.`);
  return undefined;
}

export function keysOf(value: string | undefined): Map<string, string> {
  const keys = new Map<string, string>();
  const ids = new Set<string>();
  for (const entry of (value ?? '').split(',').map(s => s.trim()).filter(Boolean)) {
    const [id, hash] = entry.split(':');
    // A malformed entry is skipped before its id is taken, so a typo cannot shut out a valid key.
    if (!/^[\w-]{1,40}$/.test(id ?? '') || !/^[0-9a-f]{64}$/.test(hash ?? '')) continue;
    // Two keys with one id would share tickets and limits: the first one wins.
    if (ids.has(id)) continue;
    ids.add(id);
    keys.set(hash, id);
  }
  return keys;
}

// The clients are kept per instance. The settings are read on every request, but a host may fix the
// environment per deployment (Vercel does): see the runbook in docs/OPERATORS.md for pausing and revoking.
let clients: { rpc: SolanaRpc; jupiter: JupiterClient; priorityFee: PriorityFeeLevel; for: string } | null = null;

/** The self-serve key secrets, the current one first; none when self-serve keys are off. */
export function keySecrets(): Uint8Array[] {
  const current = secretOf(process.env.ORIENTIM_KEY_SECRET, 'ORIENTIM_KEY_SECRET');
  const previous = secretOf(process.env.ORIENTIM_KEY_SECRET_PREVIOUS, 'ORIENTIM_KEY_SECRET_PREVIOUS');
  return current ? (previous ? [current, previous] : [current]) : [];
}

export function agentDeps(): AgentDeps | null {
  const current = secretOf(process.env.ORIENTIM_API_SECRET, 'ORIENTIM_API_SECRET');
  const keys = keysOf(process.env.ORIENTIM_API_KEYS);
  const ownKeys = keySecrets();
  // On with the ticket secret and a way in: keys issued by hand, self-serve keys, or both.
  if (!current || (keys.size === 0 && ownKeys.length === 0)) return null;
  const previous = secretOf(process.env.ORIENTIM_API_SECRET_PREVIOUS, 'ORIENTIM_API_SECRET_PREVIOUS');
  const server = serverConfig();
  // The API may run on keys of its own, apart from the rest of the site's.
  // Jupiter counts its limits per organisation, not per key: only a key from
  // a separate Jupiter account gives the API a quota of its own.
  const rpcUrl = process.env.RPC_URL_AGENTS || server.rpcUrl;
  const jupiterApiKey = process.env.JUPITER_API_KEY_AGENTS || server.jupiterApiKey;
  const feeBps = BigInt(/^\d{1,3}$/.test(process.env.ORIENTIM_API_FEE_BPS ?? '') ? process.env.ORIENTIM_API_FEE_BPS!
    : /^\d{1,3}$/.test(process.env.NEXT_PUBLIC_ORIENTIM_FEE_BPS ?? '') ? process.env.NEXT_PUBLIC_ORIENTIM_FEE_BPS! : '25');
  // The shipped skill and the public offer both cap Orientim's fee at 0.3%. A
  // deployment configured above that must fail closed, including for direct API clients.
  if (feeBps > 30n) {
    console.error(`The agent API is off: its fee is ${feeBps} bps, above the shipped skill's ceiling of 30.`);
    return null;
  }
  const siteFee = /^\d{1,3}$/.test(process.env.NEXT_PUBLIC_ORIENTIM_FEE_BPS ?? '') ? BigInt(process.env.NEXT_PUBLIC_ORIENTIM_FEE_BPS!) : 25n;
  if (feeBps > siteFee) {
    console.error(`The agent API is off: its fee is ${feeBps} bps, above the site's ${siteFee} (NEXT_PUBLIC_ORIENTIM_FEE_BPS).`);
    return null;
  }
  // A treasury that is set but cannot be read would make every API swap fee-free: the API stays off.
  let treasury: string | null;
  try {
    treasury = treasurySetting(process.env.NEXT_PUBLIC_ORIENTIM_TREASURY);
  } catch (e) {
    console.error(`The agent API is off: ${(e as Error).message}`);
    return null;
  }
  const identity = `${rpcUrl}|${server.rpcFallbackUrl ?? ''}|${jupiterApiKey ?? ''}`;
  if (clients?.for !== identity) {
    clients = {
      for: identity,
      rpc: createServerRpc(rpcUrl, server.rpcFallbackUrl),
      priorityFee: heliusPriorityFee(rpcUrl),
      jupiter: createJupiterClient({
        buildUrl: 'https://api.jup.ag/swap/v2/build',
        tokensUrl: 'https://api.jup.ag/tokens/v2/search',
        labelsUrl: 'https://api.jup.ag/swap/v2/program-id-to-label',
        apiKey: jupiterApiKey ?? undefined,
        timeoutMs: 15_000,
      }),
    };
  }
  const perMinute = Number(process.env.ORIENTIM_API_PER_MINUTE);
  const minSkillVersion = process.env.ORIENTIM_MIN_SKILL_VERSION?.trim() ?? '';
  return {
    rpc: clients.rpc,
    jupiter: clients.jupiter,
    priorityFee: clients.priorityFee,
    secrets: previous ? [current, previous] : [current],
    keys,
    keySecrets: ownKeys,
    revokedWallets: new Set((process.env.ORIENTIM_API_REVOKED ?? '').split(',').map(s => s.trim()).filter(Boolean)),
    // The API rejects fees above the shipped skill's 30 bps cap before reaching here.
    feeBps,
    treasury: treasury ? address(treasury) : null,
    excludeDexes: server.excludeDexes,
    maxNetworkFeeLamports: server.maxNetworkFeeLamports,
    disabled: server.disabled,
    v1: process.env.NEXT_PUBLIC_ORIENTIM_ENABLE_V1 === '1',
    fastRouting: process.env.ORIENTIM_ENABLE_FAST_ROUTING === '1',
    // Routes an agent brings with its own Jupiter key; ORIENTIM_OWN_ROUTES=0 turns them off.
    ownRoutes: process.env.ORIENTIM_OWN_ROUTES !== '0',
    perMinute: Number.isInteger(perMinute) && perMinute > 0 ? perMinute : 60,
    minSkillVersion: /^\d{1,6}\.\d{1,6}\.\d{1,6}$/.test(minSkillVersion) ? minSkillVersion : null,
    // The smallest swap, about $1, so that no swap costs more to build than it brings.
    minFee: MIN_FEE,
  };
}

/**
 * Where the agent API reads the chain and asks Jupiter (RPC_URL_AGENTS, JUPITER_API_KEY_AGENTS, or
 * the site's own), or null while the API is off: what /api/health checks for it.
 */
export function agentEndpoints(): { rpcUrl: string; jupiterApiKey: string | null } | null {
  if (!agentDeps()) return null;
  const server = serverConfig();
  return { rpcUrl: process.env.RPC_URL_AGENTS || server.rpcUrl, jupiterApiKey: process.env.JUPITER_API_KEY_AGENTS || server.jupiterApiKey };
}

/** The least ORIENTIM_KEY_MIN_LAMPORTS may ask: 0.001 SOL. */
const KEY_MIN_LAMPORTS_FLOOR = 1_000_000n;

/** Self-serve access, when the agent API is on and ORIENTIM_KEY_SECRET is set. */
export function accessDeps(): AccessDeps | null {
  const deps = agentDeps();
  const secrets = keySecrets();
  if (!deps || secrets.length === 0) return null;
  const origin = publicOrigin();
  if (origin === undefined) return null;
  const min = process.env.ORIENTIM_KEY_MIN_LAMPORTS?.trim() ?? '';
  let minLamports = /^\d{1,12}$/.test(min) ? BigInt(min) : 10_000_000n;
  if (minLamports < KEY_MIN_LAMPORTS_FLOOR) {
    sayOnce(`ORIENTIM_KEY_MIN_LAMPORTS is ${min}: raised to ${KEY_MIN_LAMPORTS_FLOOR}, so that wallets made by the thousand still cost something.`, 'warn');
    minLamports = KEY_MIN_LAMPORTS_FLOOR;
  }
  return { rpc: deps.rpc, keySecrets: secrets, minLamports, origin, disabled: deps.disabled };
}

export const notEnabled = () =>
  Response.json({ error: { code: 'not-enabled', message: 'The agent API is not enabled on this deployment.' } }, { status: 404 });
