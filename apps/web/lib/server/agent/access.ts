import { address, isAddress } from '@solana/kit';
import type { SolanaRpc } from '@orientim/solana';
import { readBodyLimited } from '../body';
import { clientKey, rateLimited, secondsUntilReset } from '../rateLimit';
import { SKILL_VERSION } from '../skillSums';
import { olderThan } from './api';
import { acceptChallenge, issueKey, newChallenge } from './keys';

/**
 * Self-serve API access (AGENT-API.md, "API access"): a wallet signs a challenge and gets a key bound
 * to it, with no form, no email and no database.
 *
 *   GET  /api/v1/keys/challenge?wallet=<address>   the message to sign
 *   POST /api/v1/keys                               { message, challenge, signature } → { key }
 */
export type AccessDeps = {
  rpc: SolanaRpc;
  /** The secrets that seal keys and challenges, the current one first. */
  keySecrets: readonly Uint8Array[];
  /** What the wallet must hold to get a key, so that wallets made by the thousand cost something. */
  minLamports: bigint;
  /**
   * The site the message names (ORIENTIM_PUBLIC_ORIGIN, e.g. https://orientim.com, or on a Vercel
   * preview its own VERCEL_URL), whatever host a request claims; the request's own when unset, as on
   * a machine of one's own.
   */
  origin?: string | null;
  /** ORIENTIM_DISABLED: while protected swaps are paused, no key is issued either. */
  disabled?: boolean;
  /**
   * How many keys this instance issues in an hour, to every address together
   * (ORIENTIM_KEY_MAX_PER_HOUR, default 300): the per-address limit alone does not stop addresses
   * rented by the thousand. One wallet gets at most WALLET_KEYS_PER_DAY a day.
   */
  maxKeysPerHour?: number;
  /** ORIENTIM_MIN_SKILL_VERSION, when set: a key is not issued to a skill prepare would not serve. */
  minSkillVersion?: string | null;
  now?: () => number;
};

export const DEFAULT_KEYS_PER_HOUR = 300;
const WALLET_KEYS_PER_DAY = 5;

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  Response.json(body, { status, headers: { 'cache-control': 'no-store', ...headers } });
const fail = (status: number, code: string, message: string, headers: Record<string, string> = {}) =>
  json(status, { error: { code, message } }, headers);
const seconds = (deps: AccessDeps) => Math.floor((deps.now?.() ?? Date.now()) / 1000);

const PAUSED_MESSAGE = 'Protected swaps are paused, and no API keys are issued meanwhile. Nothing was signed.';

/**
 * The oldest skill that can get a key: the key message names the Terms of Use since 1.12.3 (keys.ts),
 * and 1.12.2 and older refuse that text as a message that is not Orientim's, which reads as
 * tampering and never says "update". Those copies send x-orientim-skill on both key requests and
 * show a 426 as "too old", so they are told so here. Fixed, apart from ORIENTIM_MIN_SKILL_VERSION:
 * that setting may be unset, and raising it would also stop 1.12.x agents that already hold a key.
 */
export const MIN_KEY_SKILL_VERSION = '1.12.3';

/**
 * 426 for a copy of the skill too old to get a key, or null. A request without the header (the site,
 * a bot of one's own) is not judged. Asked before any rate limit, so that an old copy retrying does
 * not use up its address's challenges.
 */
function outdated(req: Request, deps: AccessDeps): Response | null {
  const skill = req.headers.get('x-orientim-skill') ?? '';
  const minimum = deps.minSkillVersion && olderThan(MIN_KEY_SKILL_VERSION, deps.minSkillVersion) ? deps.minSkillVersion : MIN_KEY_SKILL_VERSION;
  if (!skill || !olderThan(skill, minimum)) return null;
  return json(426, {
    error: {
      code: 'skill-outdated',
      message: `This copy of the Orientim skill (${skill}) is older than ${minimum}, the oldest that can get an API key. `
        + `Update it, then ask again: in an MCP config, run npx -y orientim-mcp@${SKILL_VERSION}; in Claude Desktop, install the current orientim.mcpb again; `
        + 'otherwise replace the skill folder or the orientim-verify CLI with the current one from https://orientim.com/developers. Nothing was signed.',
      minimum,
    },
  });
}

export async function keyChallenge(req: Request, deps: AccessDeps): Promise<Response> {
  if (deps.disabled) return fail(503, 'paused', PAUSED_MESSAGE);
  const old = outdated(req, deps);
  if (old) return old;
  const bucket = `keys-challenge:${clientKey(req)}`;
  if (rateLimited(bucket, 30, 3_600_000)) {
    return fail(429, 'rate-limited', 'Too many key challenges from this address. Wait Retry-After seconds and try again.', { 'retry-after': String(secondsUntilReset(bucket)) });
  }
  const url = new URL(req.url);
  const wallet = url.searchParams.get('wallet') ?? '';
  if (!isAddress(wallet)) return fail(400, 'bad-request', 'wallet must be a Solana address.');
  const site = new URL(deps.origin ?? url.origin);
  const c = await newChallenge(deps.keySecrets[0], { domain: site.host, uri: `${site.origin}/developers#access`, wallet, now: seconds(deps) });
  return json(200, c);
}

export async function keyIssue(req: Request, deps: AccessDeps): Promise<Response> {
  if (deps.disabled) return fail(503, 'paused', PAUSED_MESSAGE);
  const old = outdated(req, deps);
  if (old) return old;
  const bucket = `keys-issue:${clientKey(req)}`;
  if (rateLimited(bucket, 10, 3_600_000)) {
    return fail(429, 'rate-limited', 'Too many keys requested from this address. Wait Retry-After seconds and try again.', { 'retry-after': String(secondsUntilReset(bucket)) });
  }
  const text = await readBodyLimited(req, 4_096);
  let body: Record<string, unknown> | null = null;
  try {
    body = text === null ? null : JSON.parse(text);
  } catch {
    body = null;
  }
  if (!body || typeof body !== 'object') return fail(400, 'bad-request', 'Send { "message", "challenge", "signature" }.');
  // The message must name this site: the one set, or else, as on a machine of one's own, the host
  // this request reached, the same rule the challenge was written by. Never no check at all.
  const accepted = await acceptChallenge(deps.keySecrets, {
    message: body.message, challenge: body.challenge, signature: body.signature, now: seconds(deps),
    domain: new URL(deps.origin ?? req.url).host,
  });
  if ('error' in accepted) return fail(400, accepted.malformed ? 'bad-request' : 'bad-signature', accepted.error);
  let lamports: bigint;
  try {
    lamports = BigInt((await deps.rpc.getBalance(address(accepted.wallet), { commitment: 'confirmed' }).send()).value);
  } catch {
    return fail(503, 'unavailable', "The wallet's balance couldn't be read. Try again in a moment.", { 'retry-after': '5' });
  }
  if (lamports < deps.minLamports) {
    const sol = (Number(deps.minLamports) / 1e9).toLocaleString('en-US', { maximumFractionDigits: 9 });
    return fail(403, 'wallet-empty', `A key is issued to a wallet holding at least ${sol} SOL. Fund the wallet, then ask again.`);
  }
  // Counted only for funded wallets that signed, so nobody spends another wallet's or everyone's issuance.
  const perWallet = `keys-wallet:${accepted.wallet}`;
  if (rateLimited(perWallet, WALLET_KEYS_PER_DAY, 86_400_000)) {
    return fail(429, 'rate-limited', 'Too many keys issued to this wallet today. Use the key you have, or wait Retry-After seconds.', { 'retry-after': String(secondsUntilReset(perWallet)) });
  }
  const all = 'keys-issue:all';
  if (rateLimited(all, deps.maxKeysPerHour ?? DEFAULT_KEYS_PER_HOUR, 3_600_000)) {
    return fail(429, 'rate-limited', 'Orientim is issuing too many keys right now. Wait Retry-After seconds and try again.', { 'retry-after': String(secondsUntilReset(all)) });
  }
  const issued = await issueKey(deps.keySecrets[0], accepted.wallet, seconds(deps));
  return json(200, { key: issued.key, wallet: accepted.wallet, expiresAt: issued.expiresAt });
}
