import { address, isAddress } from '@solana/kit';
import type { SolanaRpc } from '@orientim/solana';
import { readBodyLimited } from '../body';
import { clientKey, rateLimited, secondsUntilReset } from '../rateLimit';
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
   * The site the message names (ORIENTIM_PUBLIC_ORIGIN, e.g. https://orientim.com), whatever host a
   * request claims; the request's own when unset, as on a machine of one's own.
   */
  origin?: string | null;
  /** ORIENTIM_DISABLED: while protected swaps are paused, no key is issued either. */
  disabled?: boolean;
  now?: () => number;
};

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  Response.json(body, { status, headers: { 'cache-control': 'no-store', ...headers } });
const fail = (status: number, code: string, message: string, headers: Record<string, string> = {}) =>
  json(status, { error: { code, message } }, headers);
const seconds = (deps: AccessDeps) => Math.floor((deps.now?.() ?? Date.now()) / 1000);

const PAUSED_MESSAGE = 'Protected swaps are paused, and no API keys are issued meanwhile. Nothing was signed.';

export async function keyChallenge(req: Request, deps: AccessDeps): Promise<Response> {
  if (deps.disabled) return fail(503, 'paused', PAUSED_MESSAGE);
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
  const accepted = await acceptChallenge(deps.keySecrets, {
    message: body.message, challenge: body.challenge, signature: body.signature, now: seconds(deps),
    ...(deps.origin ? { domain: new URL(deps.origin).host } : {}),
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
  const issued = await issueKey(deps.keySecrets[0], accepted.wallet, seconds(deps));
  return json(200, { key: issued.key, wallet: accepted.wallet, expiresAt: issued.expiresAt });
}
