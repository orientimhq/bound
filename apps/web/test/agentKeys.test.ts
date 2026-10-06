/**
 * Self-serve API keys (AGENT-API.md, "API access"): a wallet signs a challenge and gets a key bound to
 * it. Every way around it must fail: a message Orientim did not write, a stale one, another wallet's
 * signature, a changed or expired or revoked key, an empty wallet, and a key used for another wallet.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { generateKeyPairSigner, getBase58Decoder, signBytes } from '@solana/kit';
import type { KeyPairSigner } from '@solana/kit';
import { acceptChallenge, challengeMessage, isRevoked, issueKey, KEY_LIFETIME_S, newChallenge, openKey } from '../lib/server/agent/keys.ts';
import { accessDeps, keySecrets } from '../lib/server/agent/config.ts';
import { kidOf, newNonce, openTicket, sealTicket } from '../lib/server/agent/ticket.ts';
import { keyChallenge, keyIssue } from '../lib/server/agent/access.ts';
import type { AccessDeps } from '../lib/server/agent/access.ts';
import { agentPrepare } from '../lib/server/agent/api.ts';
import type { AgentDeps } from '../lib/server/agent/api.ts';

const secret = (fill: number) => new Uint8Array(32).fill(fill);
const NOW = 1_790_000_000;
const sign = async (signer: KeyPairSigner, message: string) =>
  getBase58Decoder().decode(await signBytes(signer.keyPair.privateKey, new TextEncoder().encode(message)));

async function signedChallenge(signer: KeyPairSigner, s = secret(1), now = NOW) {
  const c = await newChallenge(s, { domain: 'orientim.com', uri: 'https://orientim.com/docs#access', wallet: signer.address, now });
  return { ...c, signature: await sign(signer, c.message) };
}

describe('the challenge', () => {
  it('is a Sign In With Solana message naming the wallet, and accepted once signed by it', async () => {
    const W = await generateKeyPairSigner();
    const c = await signedChallenge(W);
    expect(c.message.split('\n')[0]).toBe('orientim.com wants you to sign in with your Solana account:');
    expect(c.message.split('\n')[1]).toBe(W.address);
    expect(c.message).toContain('gives no access to your funds');
    expect(await acceptChallenge([secret(1)], { ...c, now: NOW + 60 })).toEqual({ wallet: W.address });
  });

  it('accepts the signature in base64 as well', async () => {
    const W = await generateKeyPairSigner();
    const c = await newChallenge(secret(1), { domain: 'orientim.com', uri: 'u', wallet: W.address, now: NOW });
    const raw = await signBytes(W.keyPair.privateKey, new TextEncoder().encode(c.message));
    expect(await acceptChallenge([secret(1)], { ...c, signature: Buffer.from(raw).toString('base64'), now: NOW })).toEqual({ wallet: W.address });
  });

  it('refuses a message Orientim did not write, even one signed correctly', async () => {
    const W = await generateKeyPairSigner();
    const message = challengeMessage({ domain: 'orientim.com', uri: 'u', wallet: W.address, nonce: 'n0nce123', issuedAt: NOW });
    const forged = { message, challenge: 'AAAA', signature: await sign(W, message), now: NOW };
    expect(await acceptChallenge([secret(1)], forged)).toHaveProperty('error');
    // Nor a real challenge whose message was edited to name another wallet.
    const other = await generateKeyPairSigner();
    const c = await signedChallenge(W);
    const edited = c.message.replace(W.address, other.address);
    expect(await acceptChallenge([secret(1)], { ...c, message: edited, signature: await sign(other, edited), now: NOW })).toHaveProperty('error');
  });

  it('refuses a challenge signed by another wallet, and one signed too late', async () => {
    const W = await generateKeyPairSigner();
    const other = await generateKeyPairSigner();
    const c = await signedChallenge(W);
    expect(await acceptChallenge([secret(1)], { ...c, signature: await sign(other, c.message), now: NOW })).toHaveProperty('error');
    expect(await acceptChallenge([secret(1)], { ...c, now: NOW + 11 * 60 })).toEqual({ error: 'This challenge has expired. Ask for a new one.' });
  });

  it("refuses one sealed with another deployment's secret, and accepts the previous secret while it rotates", async () => {
    const W = await generateKeyPairSigner();
    const c = await signedChallenge(W, secret(2));
    expect(await acceptChallenge([secret(1)], { ...c, now: NOW })).toHaveProperty('error');
    expect(await acceptChallenge([secret(1), secret(2)], { ...c, now: NOW })).toEqual({ wallet: W.address });
  });
});

describe('the key', () => {
  it("opens to its wallet, with the wallet's id, until it expires", async () => {
    const W = await generateKeyPairSigner();
    const { key } = await issueKey(secret(3), W.address, NOW);
    expect(key.startsWith('ori_w1.')).toBe(true);
    expect(key.length).toBeLessThanOrEqual(400);
    expect(await openKey([secret(3)], key, NOW + 1)).toEqual({ id: `w:${W.address}`, wallet: W.address });
    expect(await openKey([secret(3)], key, NOW + KEY_LIFETIME_S)).toBeNull();
  });

  it('is refused when changed, sealed by another secret, or revoked', async () => {
    const W = await generateKeyPairSigner();
    const other = await generateKeyPairSigner();
    const { key } = await issueKey(secret(3), W.address, NOW);
    const [payload, mac] = key.slice('ori_w1.'.length).split('.');
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString());
    const swapped = Buffer.from(JSON.stringify({ ...claims, w: other.address })).toString('base64url');
    expect(await openKey([secret(3)], `ori_w1.${swapped}.${mac}`, NOW)).toBeNull();
    expect(await openKey([secret(4)], key, NOW)).toBeNull();
    expect(await openKey([secret(3)], key, NOW, new Set([W.address]))).toBeNull();
  });
});

describe('the endpoints', () => {
  const balance = (lamports: bigint) => ({ getBalance: () => ({ send: async () => ({ value: lamports }) }) }) as unknown as AccessDeps['rpc'];
  const deps = (lamports: bigint): AccessDeps => ({ rpc: balance(lamports), keySecrets: [secret(5)], minLamports: 10_000_000n, now: () => NOW * 1000 });
  let ip = 0;
  const from = () => ({ 'x-vercel-forwarded-for': `10.0.0.${++ip}` });

  it('issue a working key to a funded wallet that signed its challenge', async () => {
    const W = await generateKeyPairSigner();
    const got = await keyChallenge(new Request(`https://orientim.com/api/v1/keys/challenge?wallet=${W.address}`, { headers: from() }), deps(20_000_000n));
    expect(got.status).toBe(200);
    const c = await got.json() as { message: string; challenge: string };
    expect(c.message).toContain('URI: https://orientim.com/developers#access');
    const res = await keyIssue(new Request('https://orientim.com/api/v1/keys', {
      method: 'POST', headers: from(), body: JSON.stringify({ ...c, signature: await sign(W, c.message) }),
    }), deps(20_000_000n));
    expect(res.status).toBe(200);
    const body = await res.json() as { key: string; wallet: string };
    expect(body.wallet).toBe(W.address);
    expect(await openKey([secret(5)], body.key, NOW)).toEqual({ id: `w:${W.address}`, wallet: W.address });
  });

  it('refuse a wallet holding less than the minimum, and a signature that does not match', async () => {
    const W = await generateKeyPairSigner();
    const c = await newChallenge(secret(5), { domain: 'orientim.com', uri: 'u', wallet: W.address, now: NOW });
    const ask = async (signature: string, d: AccessDeps) => keyIssue(new Request('https://orientim.com/api/v1/keys', {
      method: 'POST', headers: from(), body: JSON.stringify({ ...c, signature }),
    }), d);
    const empty = await ask(await sign(W, c.message), deps(5_000_000n));
    expect(empty.status).toBe(403);
    expect((await empty.json() as { error: { code: string } }).error.code).toBe('wallet-empty');
    const other = await generateKeyPairSigner();
    expect((await ask(await sign(other, c.message), deps(20_000_000n))).status).toBe(400);
  });

  it('issue nothing while protected swaps are paused', async () => {
    const W = await generateKeyPairSigner();
    const paused = { ...deps(20_000_000n), disabled: true };
    const got = await keyChallenge(new Request(`https://orientim.com/api/v1/keys/challenge?wallet=${W.address}`, { headers: from() }), paused);
    expect(got.status).toBe(503);
    expect((await got.json() as { error: { code: string } }).error.code).toBe('paused');
    const c = await newChallenge(secret(5), { domain: 'orientim.com', uri: 'u', wallet: W.address, now: NOW });
    const res = await keyIssue(new Request('https://orientim.com/api/v1/keys', {
      method: 'POST', headers: from(), body: JSON.stringify({ ...c, signature: await sign(W, c.message) }),
    }), paused);
    expect(res.status).toBe(503);
  });

  it('refuse a challenge for something that is not a wallet', async () => {
    const res = await keyChallenge(new Request('https://orientim.com/api/v1/keys/challenge?wallet=nope', { headers: from() }), deps(0n));
    expect(res.status).toBe(400);
  });
});

describe('a self-serve key in the agent API', () => {
  const api = (keySecrets: Uint8Array[], revoked: string[] = []): AgentDeps => ({
    rpc: {} as AgentDeps['rpc'], jupiter: {} as AgentDeps['jupiter'], secrets: [secret(7)], keys: new Map(), keySecrets,
    revokedWallets: new Set(revoked), feeBps: 30n, treasury: null, excludeDexes: [], maxNetworkFeeLamports: 200_000n,
    disabled: false, v1: false, perMinute: 1_000,
  });
  const prepare = (key: string, owner: string) => new Request('https://orientim.com/api/v1/prepare', {
    method: 'POST',
    headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    body: JSON.stringify({ owner, inputMint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', outputMint: 'So11111111111111111111111111111111111111112', amountIn: '1000000' }),
  });

  it('prepares for its own wallet only: another wallet is refused before anything is built', async () => {
    const W = await generateKeyPairSigner();
    const other = await generateKeyPairSigner();
    const { key } = await issueKey(secret(6), W.address, Math.floor(Date.now() / 1000));
    const res = await agentPrepare(prepare(key, other.address), api([secret(6)]));
    expect(res.status).toBe(403);
    expect((await res.json() as { error: { code: string } }).error.code).toBe('wrong-wallet');
  });

  it('is refused like a missing key when revoked, or when self-serve keys are off', async () => {
    const W = await generateKeyPairSigner();
    const { key } = await issueKey(secret(6), W.address, Math.floor(Date.now() / 1000));
    expect((await agentPrepare(prepare(key, W.address), api([secret(6)], [W.address]))).status).toBe(401);
    expect((await agentPrepare(prepare(key, W.address), api([]))).status).toBe(401);
  });
});

describe('self-serve keys: the site, revocation and secrets', () => {
  const balance = { getBalance: () => ({ send: async () => ({ value: 20_000_000n }) }) } as unknown as AccessDeps['rpc'];
  const site = (origin: string | null): AccessDeps => ({ rpc: balance, keySecrets: [secret(8)], minLamports: 10_000_000n, origin, now: () => NOW * 1000 });
  let ip = 0;
  const from = () => ({ 'x-vercel-forwarded-for': `10.2.0.${++ip}` });

  it("the message names the deployment's own site, whatever host the request claims", async () => {
    const W = await generateKeyPairSigner();
    const res = await keyChallenge(new Request(`https://phishing.example/api/v1/keys/challenge?wallet=${W.address}`, { headers: from() }), site('https://orientim.com'));
    const { message } = await res.json() as { message: string };
    expect(message.split('\n')[0]).toBe('orientim.com wants you to sign in with your Solana account:');
    expect(message).toContain('URI: https://orientim.com/developers#access');
  });

  it('a message Orientim wrote for another host is refused where the site is set', async () => {
    const W = await generateKeyPairSigner();
    const got = await keyChallenge(new Request(`https://phishing.example/api/v1/keys/challenge?wallet=${W.address}`, { headers: from() }), site(null));
    const c = await got.json() as { message: string; challenge: string };
    expect(c.message.startsWith('phishing.example wants you')).toBe(true);
    const res = await keyIssue(new Request('https://orientim.com/api/v1/keys', {
      method: 'POST', headers: from(), body: JSON.stringify({ ...c, signature: await sign(W, c.message) }),
    }), site('https://orientim.com'));
    expect(res.status).toBe(400);
    expect((await res.json() as { error: { message: string } }).error.message).toMatch(/another site/);
  });

  it('wallet@time revokes the keys issued until then, and its owner signs again for a new one', async () => {
    const W = await generateKeyPairSigner();
    const { key: leaked } = await issueKey(secret(9), W.address, NOW);
    const { key: fresh } = await issueKey(secret(9), W.address, NOW + 60);
    const revoked = new Set([`${W.address}@${NOW}`]);
    expect(await openKey([secret(9)], leaked, NOW + 120, revoked)).toBeNull();
    expect(await openKey([secret(9)], fresh, NOW + 120, revoked)).toEqual({ id: `w:${W.address}`, wallet: W.address });
    expect(isRevoked(new Set([W.address]), W.address, NOW + 60)).toBe(true);
    expect(isRevoked(new Set([`${W.address}@soon`]), W.address, NOW)).toBe(false);
    expect(KEY_LIFETIME_S).toBe(90 * 24 * 3600);
  });

  describe('settings', () => {
    const saved = { ...process.env };
    afterEach(() => {
      process.env = { ...saved };
      vi.restoreAllMocks();
    });
    const good = Buffer.alloc(32, 7).toString('base64');

    it('a secret that is not 32 random bytes in base64 leaves self-serve keys off', () => {
      vi.spyOn(console, 'error').mockImplementation(() => {});
      for (const weak of ['correct horse battery staple and more words to fill', Buffer.alloc(32, 5).toString('base64url'), `${good.slice(0, -2)}!=`, Buffer.alloc(16, 1).toString('base64')]) {
        process.env.ORIENTIM_KEY_SECRET = weak;
        expect(keySecrets(), weak).toEqual([]);
      }
      process.env.ORIENTIM_KEY_SECRET = good;
      expect(keySecrets()).toHaveLength(1);
    });

    it('the minimum balance is never below 0.001 SOL, and a site that is not https keeps keys off', () => {
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      vi.spyOn(console, 'error').mockImplementation(() => {});
      Object.assign(process.env, {
        ORIENTIM_API_SECRET: good, ORIENTIM_KEY_SECRET: Buffer.alloc(32, 8).toString('base64'), ORIENTIM_KEY_MIN_LAMPORTS: '0',
        ORIENTIM_PUBLIC_ORIGIN: 'https://orientim.com/', RPC_URL: 'http://127.0.0.1:1',
      });
      delete process.env.NEXT_PUBLIC_ORIENTIM_TREASURY;
      const deps = accessDeps();
      expect(deps?.minLamports).toBe(1_000_000n);
      expect(deps?.origin).toBe('https://orientim.com');
      process.env.ORIENTIM_PUBLIC_ORIGIN = 'http://orientim.com';
      expect(accessDeps()).toBeNull();
    });
  });
});

describe('a seal has one spelling (found by fuzzing)', () => {
  // The last of 43 base64url characters carries two unused bits: three other letters decode alike.
  const variants = (text: string) => {
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
    return [...alphabet].map(c => text.slice(0, -1) + c).filter(v => v !== text);
  };

  it('a key, a challenge and a ticket open only as Orientim wrote them', async () => {
    const W = await generateKeyPairSigner();
    const { key } = await issueKey(secret(3), W.address, NOW);
    for (const v of variants(key)) expect(await openKey([secret(3)], v, NOW)).toBeNull();
    const c = await signedChallenge(W);
    for (const v of variants(c.challenge)) expect(await acceptChallenge([secret(1)], { ...c, challenge: v, now: NOW })).toHaveProperty('error');
    expect(await acceptChallenge([secret(1)], { ...c, now: NOW })).toEqual({ wallet: W.address });
    const ticketSecret = secret(9);
    const ticket = await sealTicket(ticketSecret, { v: 1, kid: await kidOf(ticketSecret), nonce: newNonce(), key: 'agent', owner: W.address, msg: '0'.repeat(64), lvbh: '100' });
    expect(await openTicket([ticketSecret], ticket)).not.toBeNull();
    for (const v of variants(ticket)) expect(await openTicket([ticketSecret], v)).toBeNull();
  });
});
