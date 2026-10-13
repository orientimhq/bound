/**
 * Signing services for the simulation: Turnkey and Privy, each called the way an unattended agent
 * calls it (Turnkey with an API key of the agent's own user, Privy with the app's secret and the
 * wallet's authorization key), never with a person's login. Each one signs a whole transaction and
 * hands it back unsent: the skill's `signerFromSignTransaction` takes it from there.
 *
 * Nothing here sends a transaction. The keys come from the environment and are never printed.
 *
 *   Turnkey  TURNKEY_ORGANIZATION_ID, TURNKEY_API_PUBLIC_KEY, TURNKEY_API_PRIVATE_KEY (the API key
 *            pair, hex), TURNKEY_WALLET (the Solana address that signs), TURNKEY_WALLETS (optional,
 *            ten more addresses for signing at once), TURNKEY_DENY_WALLET (optional, an address
 *            whose policy refuses these swaps)
 *   Privy    PRIVY_APP_ID, PRIVY_APP_SECRET, PRIVY_AUTHORIZATION_KEY (`wallet-auth:...`, the key
 *            that owns the wallets), PRIVY_WALLET_ID, PRIVY_WALLET_IDS (optional, ten more),
 *            PRIVY_DENY_WALLET_ID (optional, a wallet whose policy refuses these swaps)
 */
import { createECDH, createPrivateKey, sign as signWith } from 'node:crypto';
import type { KeyObject } from 'node:crypto';

/** Why a service did not sign: its own policy said no, or it could not be reached or answered late. */
export class SignerRefusedError extends Error {
  readonly provider: string;
  readonly status: number;
  readonly answer: string;
  constructor(provider: string, status: number, answer: string) {
    super(`${provider} refused to sign (${status}): ${answer.slice(0, 300)}`);
    this.provider = provider;
    this.status = status;
    this.answer = answer;
  }
}
export class SignerUnavailableError extends Error {
  readonly provider: string;
  readonly status: number | null;
  constructor(provider: string, status: number | null, detail: string) {
    super(`${provider} did not answer (${status ?? 'no answer'}): ${detail.slice(0, 300)}`);
    this.provider = provider;
    this.status = status;
  }
}

export type Provider = {
  name: 'turnkey' | 'privy';
  /** The address that signs, and more of them for signing at once (may be empty). */
  wallet: string;
  wallets: string[];
  /** A wallet whose policy refuses these swaps, when one is set up. */
  denyWallet?: string;
  /** Signs `transaction` (base64) as `address` and returns it (base64), unsent. */
  sign(address: string, transaction: string, opts?: { timeoutMs?: number }): Promise<string>;
  /** Who the credentials are, as the service says it: for the report, never a key. */
  whoAmI(): Promise<string>;
  /**
   * The same request without the agent's own authorization (Privy: no authorization signature):
   * it must be refused, which shows the wallet answers to the agent's key and not to the app alone.
   * Null where the service has no such second way in.
   */
  signWithoutAuthorization?(address: string, transaction: string): Promise<string>;
};

const list = (v: string | undefined) => (v ?? '').split(',').map(s => s.trim()).filter(Boolean);
const b64url = (b: Buffer) => b.toString('base64url');

/** A refusal is the service's own word against this request; anything else is not knowing. */
function refusedOrUnavailable(provider: string, status: number, text: string): Error {
  if (status === 429 || status >= 500) return new SignerUnavailableError(provider, status, text);
  return new SignerRefusedError(provider, status, text);
}

async function timed(url: string, init: RequestInit, provider: string, timeoutMs: number): Promise<{ status: number; text: string }> {
  try {
    const res = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
    return { status: res.status, text: await res.text() };
  } catch (e) {
    throw new SignerUnavailableError(provider, null, e instanceof Error ? `${e.name}: ${e.message}` : String(e));
  }
}

// --- Turnkey: an API key's stamp (X-Stamp) over the exact body, P-256 and SHA-256.
function turnkeyKey(privateHex: string): KeyObject {
  const d = Buffer.from(privateHex, 'hex');
  const ecdh = createECDH('prime256v1');
  ecdh.setPrivateKey(d);
  const pub = ecdh.getPublicKey();
  return createPrivateKey({ key: { kty: 'EC', crv: 'P-256', d: b64url(d), x: b64url(pub.subarray(1, 33)), y: b64url(pub.subarray(33, 65)) }, format: 'jwk' });
}

export function turnkeyFromEnv(env = process.env): Provider | null {
  const org = env.TURNKEY_ORGANIZATION_ID;
  const publicKey = env.TURNKEY_API_PUBLIC_KEY;
  const privateKey = env.TURNKEY_API_PRIVATE_KEY;
  const wallet = env.TURNKEY_WALLET;
  if (!org || !publicKey || !privateKey || !wallet) return null;
  const key = turnkeyKey(privateKey);
  const base = env.TURNKEY_API_URL || 'https://api.turnkey.com';
  const post = async (path: string, body: unknown, timeoutMs = 30_000) => {
    const text = JSON.stringify(body);
    const signature = signWith('sha256', Buffer.from(text), key).toString('hex');
    const stamp = b64url(Buffer.from(JSON.stringify({ publicKey, scheme: 'SIGNATURE_SCHEME_TK_API_P256', signature })));
    return timed(`${base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-stamp': stamp }, body: text }, 'turnkey', timeoutMs);
  };
  const json = (text: string) => { try { return JSON.parse(text) as Record<string, unknown>; } catch { return {}; } };
  type Activity = { id?: string; status?: string; result?: { signTransactionResult?: { signedTransaction?: string } }; failure?: unknown };
  return {
    name: 'turnkey', wallet, wallets: list(env.TURNKEY_WALLETS), ...(env.TURNKEY_DENY_WALLET ? { denyWallet: env.TURNKEY_DENY_WALLET } : {}),
    async sign(address, transaction, opts = {}) {
      const deadline = Date.now() + (opts.timeoutMs ?? 30_000);
      let r = await post('/public/v1/submit/sign_transaction', {
        type: 'ACTIVITY_TYPE_SIGN_TRANSACTION_V2', timestampMs: String(Date.now()), organizationId: org,
        parameters: { signWith: address, unsignedTransaction: Buffer.from(transaction, 'base64').toString('hex'), type: 'TRANSACTION_TYPE_SOLANA' },
      }, opts.timeoutMs);
      for (;;) {
        if (r.status !== 200) throw refusedOrUnavailable('turnkey', r.status, r.text);
        const activity = (json(r.text).activity ?? {}) as Activity;
        const signed = activity.result?.signTransactionResult?.signedTransaction;
        if (activity.status === 'ACTIVITY_STATUS_COMPLETED' && signed) return Buffer.from(signed, 'hex').toString('base64');
        // Waiting on the organisation's approvals: the policy did not let it through on its own.
        if (activity.status === 'ACTIVITY_STATUS_CONSENSUS_NEEDED' || activity.status === 'ACTIVITY_STATUS_REJECTED' || activity.status === 'ACTIVITY_STATUS_FAILED') {
          throw new SignerRefusedError('turnkey', r.status, `${activity.status} ${JSON.stringify(activity.failure ?? '')}`);
        }
        if (Date.now() > deadline || !activity.id) throw new SignerUnavailableError('turnkey', r.status, `activity ${activity.status ?? 'without a status'}`);
        await new Promise(res => setTimeout(res, 500));
        r = await post('/public/v1/query/get_activity', { organizationId: org, activityId: activity.id });
      }
    },
    async whoAmI() {
      const r = await post('/public/v1/query/whoami', { organizationId: org });
      if (r.status !== 200) throw refusedOrUnavailable('turnkey', r.status, r.text);
      const me = json(r.text);
      return `user ${String(me.username ?? '?')} (${String(me.userId ?? '?')}) in organization ${String(me.organizationName ?? me.organizationId ?? '?')}, by API key`;
    },
  };
}

// --- Privy: the app's secret, and the wallet's authorization key over the canonical request.
/** RFC 8785 for what these requests carry: objects with sorted keys, strings, integers, arrays. */
export function canonicalJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`;
  if (v && typeof v === 'object') {
    return `{${Object.keys(v).sort().filter(k => (v as Record<string, unknown>)[k] !== undefined)
      .map(k => `${JSON.stringify(k)}:${canonicalJson((v as Record<string, unknown>)[k])}`).join(',')}}`;
  }
  return JSON.stringify(v);
}

export function privyFromEnv(env = process.env): Provider | null {
  const appId = env.PRIVY_APP_ID;
  const secret = env.PRIVY_APP_SECRET;
  const authorization = env.PRIVY_AUTHORIZATION_KEY;
  const walletId = env.PRIVY_WALLET_ID;
  if (!appId || !secret || !authorization || !walletId) return null;
  const base = env.PRIVY_API_URL || 'https://api.privy.io';
  const pem = `-----BEGIN PRIVATE KEY-----\n${authorization.replace(/^wallet-auth:/, '')}\n-----END PRIVATE KEY-----`;
  const key = createPrivateKey(pem);
  const headers = { 'content-type': 'application/json', 'privy-app-id': appId, authorization: `Basic ${Buffer.from(`${appId}:${secret}`).toString('base64')}` };
  const ids = new Map<string, string>();
  /** A wallet's address, by its id: the tests speak in addresses, Privy in ids. */
  const addressOf = async (id: string) => {
    const r = await timed(`${base}/v1/wallets/${id}`, { headers }, 'privy', 15_000);
    if (r.status !== 200) throw refusedOrUnavailable('privy', r.status, r.text);
    const w = JSON.parse(r.text) as { address: string; owner_id?: string | null; policy_ids?: string[] };
    ids.set(w.address, id);
    return w;
  };
  const rpc = async (address: string, transaction: string, signed: boolean, timeoutMs = 30_000) => {
    const id = ids.get(address) ?? address;
    const url = `${base}/v1/wallets/${id}/rpc`;
    const body = { method: 'signTransaction', params: { transaction, encoding: 'base64' } };
    const auth: Record<string, string> = signed
      ? { 'privy-authorization-signature': signWith('sha256', Buffer.from(canonicalJson({ version: 1, method: 'POST', url, body, headers: { 'privy-app-id': appId } })), key).toString('base64') }
      : {};
    const r = await timed(url, { method: 'POST', headers: { ...headers, ...auth }, body: JSON.stringify(body) }, 'privy', timeoutMs);
    if (r.status !== 200) throw refusedOrUnavailable('privy', r.status, r.text);
    const out = (JSON.parse(r.text) as { data?: { signed_transaction?: string } }).data?.signed_transaction;
    if (!out) throw new SignerUnavailableError('privy', r.status, 'no signed_transaction in the answer');
    return out;
  };
  const provider: Provider & { ready(): Promise<void> } = {
    name: 'privy', wallet: '', wallets: [],
    async ready() {
      provider.wallet = (await addressOf(walletId)).address;
      provider.wallets = await Promise.all(list(env.PRIVY_WALLET_IDS).map(async id => (await addressOf(id)).address));
      if (env.PRIVY_DENY_WALLET_ID) provider.denyWallet = (await addressOf(env.PRIVY_DENY_WALLET_ID)).address;
    },
    sign: (address, transaction, opts = {}) => rpc(address, transaction, true, opts.timeoutMs),
    signWithoutAuthorization: (address, transaction) => rpc(address, transaction, false),
    async whoAmI() {
      const w = await addressOf(walletId);
      return `app ${appId}, wallet ${w.address} owned by ${w.owner_id ?? 'no key (the app alone)'}${w.policy_ids?.length ? `, policies ${w.policy_ids.join(', ')}` : ', no policy'}`;
    },
  };
  return provider;
}

/** The providers whose credentials are set, ready to sign. */
export async function providersFromEnv(env = process.env): Promise<Provider[]> {
  const found: Provider[] = [];
  const turnkey = turnkeyFromEnv(env);
  if (turnkey) found.push(turnkey);
  const privy = privyFromEnv(env) as (Provider & { ready(): Promise<void> }) | null;
  if (privy) {
    await privy.ready();
    found.push(privy);
  }
  return found;
}
