import { timingSafeEqual } from 'node:crypto';
import { address, getBase58Encoder, getPublicKeyFromAddress, isAddress, verifySignature } from '@solana/kit';
import { macOf } from './ticket';
import type { SignatureBytes } from '@solana/kit';

/**
 * Self-serve API keys (AGENT-API.md, "API access"). An agent or a developer proves it holds a wallet by
 * signing a Sign In With Solana message, and gets a key at once, bound to that wallet. Nothing is
 * stored: the key carries its wallet and its expiry, sealed with a MAC only the server can make, the
 * way tickets are. A key prepares swaps for its own wallet only, so a leaked key is worth nothing to
 * anyone else's wallet, and the rate limit counts per wallet, so more keys do not buy more requests.
 *
 * The secret is its own (ORIENTIM_KEY_SECRET), not the tickets': rotating the ticket secret, which
 * happens in minutes, must not end keys meant to last months.
 */
export const KEY_PREFIX = 'ori_w1.';
/** A key lives this long; the wallet signs again for a new one (90 days). */
export const KEY_LIFETIME_S = 90 * 24 * 3600;
/** A challenge must be signed within this long. */
export const CHALLENGE_LIFETIME_S = 10 * 60;

type Claims = { v: 1; w: string; iat: number; exp: number };

const enc = new TextEncoder();
const toB64url = (b: Uint8Array) => Buffer.from(b).toString('base64url');
const sameBytes = (a: Uint8Array, b: Uint8Array) => a.length === b.length && timingSafeEqual(a, b);

async function hmac(key: Uint8Array, data: string): Promise<Uint8Array> {
  const k = await globalThis.crypto.subtle.importKey('raw', key as BufferSource, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await globalThis.crypto.subtle.sign('HMAC', k, enc.encode(data)));
}

const iso = (s: number) => new Date(s * 1000).toISOString();

/**
 * The message the wallet signs, in the Sign In With Solana format wallets recognize: who asks, which
 * wallet, what it is for, and when it stops being valid.
 */
export function challengeMessage(o: { domain: string; uri: string; wallet: string; nonce: string; issuedAt: number }): string {
  return [
    `${o.domain} wants you to sign in with your Solana account:`,
    o.wallet,
    '',
    'Get an Orientim API key for this wallet, and accept the Terms of Use at https://orientim.com/terms. Signing costs nothing and gives no access to your funds.',
    '',
    `URI: ${o.uri}`,
    'Version: 1',
    'Chain ID: mainnet',
    `Nonce: ${o.nonce}`,
    `Issued At: ${iso(o.issuedAt)}`,
    `Expiration Time: ${iso(o.issuedAt + CHALLENGE_LIFETIME_S)}`,
  ].join('\n');
}

/** A challenge for `wallet`: the message to sign, and a MAC that lets any instance accept it later. */
export async function newChallenge(secret: Uint8Array, o: { domain: string; uri: string; wallet: string; now: number }) {
  const nonce = toB64url(globalThis.crypto.getRandomValues(new Uint8Array(12)));
  const message = challengeMessage({ ...o, nonce, issuedAt: o.now });
  return { message, challenge: toB64url(await hmac(secret, `orientim/agent/challenge/${message}`)), expiresAt: iso(o.now + CHALLENGE_LIFETIME_S) };
}

const line = (message: string, label: string) => message.split('\n').find(l => l.startsWith(`${label}: `))?.slice(label.length + 2);

/** A 64-byte ed25519 signature, sent as base58 (a wallet's usual text) or base64. */
function signatureBytes(text: string): Uint8Array | null {
  try {
    const b58 = getBase58Encoder().encode(text);
    if (b58.length === 64) return new Uint8Array(b58);
  } catch {
    // Not base58: try base64.
  }
  const b64 = Buffer.from(text, 'base64');
  return b64.length === 64 ? new Uint8Array(b64) : null;
}

/**
 * The wallet that signed a challenge Orientim issued, or why it is refused. The MAC proves Orientim
 * wrote the message (so its wallet, domain and times are Orientim's); the signature proves the
 * wallet holder signed it; the expiry keeps a signed message from being kept for later. With
 * `domain`, the deployment's own (ORIENTIM_PUBLIC_ORIGIN), a message naming any other site is refused.
 *
 * A signed challenge is not spent: within its ten minutes it can be exchanged again, for another key
 * of the same wallet. Nothing is stored, and a second key of one's own wallet gives nothing more.
 */
export async function acceptChallenge(
  secrets: readonly Uint8Array[],
  o: { message: unknown; challenge: unknown; signature: unknown; now: number; domain?: string },
): Promise<{ wallet: string } | { error: string; malformed?: true }> {
  if (typeof o.message !== 'string' || typeof o.challenge !== 'string' || typeof o.signature !== 'string' || o.message.length > 2_000) {
    return { error: 'Send the message, the challenge and the signature, as strings.', malformed: true };
  }
  const mac = macOf(o.challenge);
  let issued = false;
  if (mac) for (const secret of secrets) if (sameBytes(await hmac(secret, `orientim/agent/challenge/${o.message}`), mac)) issued = true;
  if (!issued) return { error: 'This message was not issued by Orientim. Ask for a new challenge.' };
  if (o.domain !== undefined && o.message.split('\n')[0] !== `${o.domain} wants you to sign in with your Solana account:`) {
    return { error: 'This message names another site. Ask for a new challenge.' };
  }
  const expires = Date.parse(line(o.message, 'Expiration Time') ?? '');
  if (!Number.isFinite(expires) || o.now * 1000 > expires) return { error: 'This challenge has expired. Ask for a new one.' };
  const wallet = o.message.split('\n')[1] ?? '';
  if (!isAddress(wallet)) return { error: 'The message names no wallet.' };
  const signature = signatureBytes(o.signature);
  if (!signature) return { error: 'The signature must be 64 bytes, in base58 or base64.', malformed: true };
  if (!await verifySignature(await getPublicKeyFromAddress(address(wallet)), signature as SignatureBytes, enc.encode(o.message))) {
    return { error: 'The signature is not this wallet’s signature of this message.' };
  }
  return { wallet };
}

/** A key for `wallet`, valid for KEY_LIFETIME_S. */
export async function issueKey(secret: Uint8Array, wallet: string, now: number): Promise<{ key: string; expiresAt: string }> {
  const claims: Claims = { v: 1, w: wallet, iat: now, exp: now + KEY_LIFETIME_S };
  const payload = toB64url(enc.encode(JSON.stringify(claims)));
  const mac = toB64url(await hmac(secret, `orientim/agent/apikey/${payload}`));
  return { key: `${KEY_PREFIX}${payload}.${mac}`, expiresAt: iso(claims.exp) };
}

/**
 * Is a key of `wallet` issued at `iat` revoked? ORIENTIM_API_REVOKED lists `wallet` (all its keys) or
 * `wallet@seconds` (its keys issued at or before that time, so that its owner can sign again for a
 * new one).
 */
export function isRevoked(revoked: ReadonlySet<string>, wallet: string, iat: number): boolean {
  if (revoked.has(wallet)) return true;
  for (const entry of revoked) {
    const [w, before] = entry.split('@');
    if (w === wallet && before !== undefined && /^\d{1,12}$/.test(before) && iat <= Number(before)) return true;
  }
  return false;
}

/**
 * The wallet a self-serve key belongs to, or null when it is not one Orientim sealed, has expired or
 * was revoked (`isRevoked`). Its id is the wallet's, so every key of one wallet shares one rate
 * limit and one set of tickets.
 */
export async function openKey(
  secrets: readonly Uint8Array[], key: string, now: number, revoked: ReadonlySet<string> = new Set(),
): Promise<{ id: string; wallet: string } | null> {
  if (!key.startsWith(KEY_PREFIX) || key.length > 400) return null;
  const [payload, mac, extra] = key.slice(KEY_PREFIX.length).split('.');
  if (!payload || !mac || extra !== undefined) return null;
  const given = macOf(mac);
  let sealed = false;
  if (given) for (const secret of secrets) if (sameBytes(await hmac(secret, `orientim/agent/apikey/${payload}`), given)) sealed = true;
  if (!sealed) return null;
  let c: Claims;
  try {
    c = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as Claims;
  } catch {
    return null;
  }
  if (c?.v !== 1 || typeof c.w !== 'string' || !isAddress(c.w) || !Number.isInteger(c.exp) || c.exp <= now || !Number.isInteger(c.iat)) return null;
  if (isRevoked(revoked, c.w, c.iat)) return null;
  return { id: `w:${c.w}`, wallet: c.w };
}
