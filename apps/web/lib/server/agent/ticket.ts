import { timingSafeEqual } from 'node:crypto';
import { createKeyPairSignerFromPrivateKeyBytes } from '@solana/kit';
import type { KeyPairSigner } from '@solana/kit';

/**
 * The agent API is stateless (no database, and prepare and finalize may run on different
 * instances), so what finalize needs from prepare travels with the agent as a ticket, sealed with
 * a MAC only the server can make: the server keeps no state (AGENT-API.md).
 *
 * The one-time key E is not stored anywhere: it is derived from the server secret and the ticket's
 * nonce, so any instance holding the secret derives the same E. A leaked secret lets its holder
 * sign as E for Orientim's own messages, which could drop the fee from them, and collect whatever is
 * left under an E it derives. The skill's check refuses to sign a swap that would leave anything
 * there: every lamport W sends E must be spent by the route or returned in the same transaction, and
 * the account a Pump.fun market opens in E's name must end closed. Removing an old secret stops
 * its tickets; it cannot unlearn an E already derived.
 */
export type Ticket = {
  v: 1;
  /** Which server secret sealed it, so the secret can be rotated. */
  kid: string;
  /** Random, 16 bytes, base64url: the only input besides the secret that E is derived from. */
  nonce: string;
  /** The API key the ticket was issued to; another key cannot finalize it. */
  key: string;
  /** W, the wallet that must sign first. */
  owner: string;
  /** SHA-256 of the exact message Orientim built and verified, hex. Finalize signs nothing else. */
  msg: string;
  /** After this block height the message can no longer land. */
  lvbh: string;
  /**
   * The output account and the balance its minimum-output check was built on (B and C): finalize
   * reads it again and signs nothing if it moved. Absent for SOL output.
   */
  wOut?: string;
  b0?: string;
};

const enc = new TextEncoder();
const subtle = () => globalThis.crypto.subtle;

async function hmac(key: Uint8Array, data: string): Promise<Uint8Array> {
  const k = await subtle().importKey('raw', key as BufferSource, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await subtle().sign('HMAC', k, enc.encode(data)));
}

const toB64url = (b: Uint8Array) => Buffer.from(b).toString('base64url');
/**
 * A MAC as Orientim writes it, and only so: 32 bytes in their one base64url spelling. The last of 43
 * characters carries two unused bits, so three other spellings decode to the same bytes; each would
 * be a second text for one seal (found by fuzzing, 26 September 2026).
 */
export function macOf(text: string): Uint8Array | null {
  const bytes = Buffer.from(text, 'base64url');
  return bytes.length === 32 && bytes.toString('base64url') === text ? new Uint8Array(bytes) : null;
}
const hex = (b: Uint8Array) => Buffer.from(b).toString('hex');

/** Identifies a secret without revealing it (a MAC of a fixed label, not a hash of the secret). */
export const kidOf = async (secret: Uint8Array) => hex(await hmac(secret, 'orientim/agent/kid')).slice(0, 16);

/** A fresh nonce for a new ticket. */
export const newNonce = () => toB64url(globalThis.crypto.getRandomValues(new Uint8Array(16)));

/**
 * E for a ticket: an Ed25519 key whose 32-byte seed is HMAC-SHA256(secret, label + nonce). The same
 * secret and nonce give the same E on every instance; any other nonce gives an unrelated one.
 */
export async function ephemeralFor(secret: Uint8Array, nonce: string): Promise<KeyPairSigner> {
  return createKeyPairSignerFromPrivateKeyBytes(await hmac(secret, `orientim/agent/ephemeral/${nonce}`));
}

/**
 * A prepare whose routes the agent brings from Jupiter takes rounds: Orientim says which routes it
 * needs, for the one-time key E it will use, and the agent fetches them with its own key. What
 * holds E across the rounds travels with the agent as a session, sealed like a ticket (its own MAC
 * label, so neither can stand for the other) and bound to the swap it was opened for. It authorizes
 * nothing: E signs only in finalize, and only the message a ticket names.
 */
export type Session = {
  v: 1;
  kid: string;
  nonce: string;
  /** The API key, the wallet, the two mints, the amount and the version the session was opened for. */
  key: string;
  owner: string;
  inputMint: string;
  outputMint: string;
  amountIn: string;
  version: 0 | 1;
  /** Unix time in seconds after which the session no longer opens. */
  exp: number;
  /**
   * Orientim's own price for this swap, when a fee on the output is held to it (`reference` in
   * prepareProtectedSwap): the unrestricted output and the minimum at its tolerance, when it was
   * asked (ms), and what it was asked for besides the swap above (the tolerance and the fee).
   */
  ref?: SessionReference;
  /**
   * What the swap's input was worth in SOL, when the fee is paid in SOL from the wallet: priced by
   * Orientim's own key, for the amount, when (ms) and at the tolerance it was asked for.
   */
  sol?: SessionSolValue;
  /**
   * What the agent asked of the swap besides its parties: its tolerance, the cost it accepts, the
   * routing and, once given, its minimum. E is one per session, so every round must ask the same,
   * and a session cannot carry E into a swap built to other terms.
   */
  terms?: SessionTerms;
};

export type SessionTerms = { slip: number | null; cost: string | null; mode: 'standard' | 'fast'; min: string | null };

const termsOk = (r: unknown): r is SessionTerms => {
  const x = r as SessionTerms;
  return !!x && typeof x === 'object' && (x.slip === null || Number.isInteger(x.slip)) && (x.cost === null || (typeof x.cost === 'string' && /^\d{1,5}$/.test(x.cost)))
    && (x.mode === 'standard' || x.mode === 'fast') && (x.min === null || (typeof x.min === 'string' && /^\d{1,20}$/.test(x.min)));
};

export type SessionSolValue = { amount: string; value: string; at: number; slip: number };

export type SessionReference = { out: string; min: string; at: number; slip: number | null; feeBps: string; treasury: string | null };

/** How long Orientim's own price stays good for the next round: a few seconds of the market. */
export const REFERENCE_FRESH_MS = 15_000;

const referenceOk = (r: unknown): r is SessionReference => {
  const x = r as SessionReference;
  return !!x && typeof x === 'object' && typeof x.out === 'string' && /^\d{1,20}$/.test(x.out) && typeof x.min === 'string' && /^\d{1,20}$/.test(x.min)
    && Number.isSafeInteger(x.at) && (x.slip === null || Number.isInteger(x.slip)) && typeof x.feeBps === 'string' && /^\d{1,5}$/.test(x.feeBps)
    && (x.treasury === null || typeof x.treasury === 'string');
};

const solValueOk = (r: unknown): r is SessionSolValue => {
  const x = r as SessionSolValue;
  return !!x && typeof x === 'object' && typeof x.amount === 'string' && /^\d{1,20}$/.test(x.amount)
    && typeof x.value === 'string' && /^\d{1,20}$/.test(x.value) && Number.isSafeInteger(x.at) && Number.isInteger(x.slip);
};

/** How long a session lives: rounds take seconds; a swap built from an older one is not worth it. */
export const SESSION_TTL_SECONDS = 120;

export async function sealSession(secret: Uint8Array, s: Session): Promise<string> {
  const payload = toB64url(enc.encode(JSON.stringify(s)));
  return `${payload}.${toB64url(await hmac(secret, `orientim/agent/session/${payload}`))}`;
}

/** The session, if one of `secrets` sealed it, it is well formed and it has not expired; otherwise null. */
export async function openSession(secrets: readonly Uint8Array[], token: unknown, now = Math.floor(Date.now() / 1000)): Promise<{ session: Session; secret: Uint8Array } | null> {
  if (typeof token !== 'string' || token.length > 2_000) return null;
  const [payload, mac, extra] = token.split('.');
  if (!payload || !mac || extra !== undefined) return null;
  let s: Session;
  try {
    s = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as Session;
  } catch {
    return null;
  }
  if (s?.v !== 1 || typeof s.kid !== 'string') return null;
  for (const secret of secrets) {
    if ((await kidOf(secret)) !== s.kid) continue;
    const given = macOf(mac);
    if (!given || !sameBytes(await hmac(secret, `orientim/agent/session/${payload}`), given)) return null;
    const fields = [s.nonce, s.key, s.owner, s.inputMint, s.outputMint, s.amountIn];
    if (fields.some(f => typeof f !== 'string') || !/^\d{1,20}$/.test(s.amountIn)) return null;
    if ((s.version !== 0 && s.version !== 1) || !Number.isInteger(s.exp) || s.exp < now) return null;
    if (s.ref !== undefined && !referenceOk(s.ref)) return null;
    if (s.sol !== undefined && !solValueOk(s.sol)) return null;
    if (s.terms !== undefined && !termsOk(s.terms)) return null;
    return { session: s, secret };
  }
  return null;
}

/** `<payload>.<mac>`, both base64url. The payload is readable JSON; only the MAC is secret-bound. */
export async function sealTicket(secret: Uint8Array, t: Ticket): Promise<string> {
  const payload = toB64url(enc.encode(JSON.stringify(t)));
  return `${payload}.${toB64url(await hmac(secret, `orientim/agent/ticket/${payload}`))}`;
}

/** Constant time, so a MAC cannot be guessed byte by byte from response times (Node's own primitive). */
const sameBytes = (a: Uint8Array, b: Uint8Array) => a.length === b.length && timingSafeEqual(a, b);

/**
 * The ticket, if one of `secrets` sealed it and it is well formed; otherwise null. Returns the
 * secret that sealed it too, since E is derived from that one.
 */
export async function openTicket(secrets: readonly Uint8Array[], token: string): Promise<{ ticket: Ticket; secret: Uint8Array } | null> {
  if (typeof token !== 'string' || token.length > 2_000) return null;
  const [payload, mac, extra] = token.split('.');
  if (!payload || !mac || extra !== undefined) return null;
  let t: Ticket;
  try {
    t = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as Ticket;
  } catch {
    return null;
  }
  if (t?.v !== 1 || typeof t.kid !== 'string') return null;
  for (const secret of secrets) {
    if ((await kidOf(secret)) !== t.kid) continue;
    const expected = await hmac(secret, `orientim/agent/ticket/${payload}`);
    const given = macOf(mac);
    if (!given || !sameBytes(expected, given)) return null;
    const fields = [t.nonce, t.key, t.owner, t.msg, t.lvbh];
    if (fields.some(f => typeof f !== 'string') || !/^[0-9a-f]{64}$/.test(t.msg) || !/^\d{1,20}$/.test(t.lvbh)) return null;
    if ((t.wOut === undefined) !== (t.b0 === undefined)) return null;
    if (t.wOut !== undefined && (typeof t.wOut !== 'string' || typeof t.b0 !== 'string' || !/^\d{1,20}$/.test(t.b0))) return null;
    return { ticket: t, secret };
  }
  return null;
}
