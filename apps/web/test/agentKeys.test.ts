/**
 * Self-serve API keys (AGENT-API.md, "API access"): a wallet signs a challenge and gets a key bound to
 * it. Every way around it must fail: a message Orientim did not write, a stale one, another wallet's
 * signature, a changed or expired or revoked key, an empty wallet, and a key used for another wallet.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { generateKeyPairSigner, getBase58Decoder, getBase58Encoder, getPublicKeyFromAddress, signBytes, verifySignature } from '@solana/kit';
import type { SignatureBytes } from '@solana/kit';
import type { KeyPairSigner } from '@solana/kit';
import { acceptChallenge, challengeMessage, isRevoked, issueKey, KEY_LIFETIME_S, newChallenge, openKey } from '../lib/server/agent/keys.ts';
import { accessDeps, agentDeps, keySecrets } from '../lib/server/agent/config.ts';
import { kidOf, newNonce, openTicket, sealTicket } from '../lib/server/agent/ticket.ts';
import { keyChallenge, keyIssue, MIN_KEY_SKILL_VERSION } from '../lib/server/agent/access.ts';
import type { AccessDeps } from '../lib/server/agent/access.ts';
import type { Acceptance } from '../lib/server/agent/termsRecord.ts';
import { LEGAL } from '../lib/legal.ts';
import { agentPrepare } from '../lib/server/agent/api.ts';
import type { AgentDeps } from '../lib/server/agent/api.ts';
import { address } from '@solana/kit';
import { SYSTEM_PROGRAM, WSOL_MINT } from '@orientimhq/swap/core';
import { DEX, fakeJupiter, fakeRpc, fundedAccounts, mint, POOL, USDC } from '../../../packages/jupiter/test/fakes.ts';
import type { Account } from '../../../packages/jupiter/test/fakes.ts';
import type { BuildParams } from '../../../packages/jupiter/src/client.ts';

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

  it('issue a wallet at most five keys a day, and every wallet together at most the hourly cap', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      // Ahead of every window the other tests opened.
      vi.setSystemTime(Date.now() + 3 * 86_400_000);
      const issue = async (W: Awaited<ReturnType<typeof generateKeyPairSigner>>, d: AccessDeps) => {
        const c = await newChallenge(secret(5), { domain: 'orientim.com', uri: 'u', wallet: W.address, now: NOW });
        return keyIssue(new Request('https://orientim.com/api/v1/keys', {
          method: 'POST', headers: from(), body: JSON.stringify({ ...c, signature: await sign(W, c.message) }),
        }), d);
      };
      const W = await generateKeyPairSigner();
      for (let i = 0; i < 5; i++) expect((await issue(W, deps(20_000_000n))).status).toBe(200);
      const sixth = await issue(W, deps(20_000_000n));
      expect(sixth.status).toBe(429);
      expect(sixth.headers.get('retry-after')).toBeTruthy();
      // An empty wallet spends nothing of the hourly cap.
      vi.setSystemTime(Date.now() + 2 * 3_600_000);
      const capped = { ...deps(20_000_000n), maxKeysPerHour: 2 };
      expect((await issue(await generateKeyPairSigner(), { ...capped, rpc: balance(0n) })).status).toBe(403);
      expect((await issue(await generateKeyPairSigner(), capped)).status).toBe(200);
      expect((await issue(await generateKeyPairSigner(), capped)).status).toBe(200);
      expect((await issue(await generateKeyPairSigner(), capped)).status).toBe(429);
    } finally {
      vi.useRealTimers();
    }
  });

  it("a record of the Terms that fails spends none of the wallet's keys, nor the hourly cap", async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      // Ahead of every window the other tests opened.
      vi.setSystemTime(Date.now() + 6 * 86_400_000);
      const W = await generateKeyPairSigner();
      let failing = true;
      const d: AccessDeps = { ...deps(20_000_000n), maxKeysPerHour: 5, recordAcceptance: async () => { if (failing) throw new Error('blob down'); } };
      const issue = async () => {
        const c = await newChallenge(secret(5), { domain: 'orientim.com', uri: 'u', wallet: W.address, now: NOW });
        return keyIssue(new Request('https://orientim.com/api/v1/keys', {
          method: 'POST', headers: from(), body: JSON.stringify({ ...c, signature: await sign(W, c.message) }),
        }), d);
      };
      for (let i = 0; i < 5; i++) expect((await issue()).status).toBe(503);
      failing = false;
      for (let i = 0; i < 5; i++) expect((await issue()).status).toBe(200);
      const sixth = await issue();
      expect(sixth.status).toBe(429);
      expect(Number(sixth.headers.get('retry-after'))).toBeGreaterThan(80_000);
    } finally {
      vi.useRealTimers();
    }
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

  it('answer a copy of the skill too old for the key message with 426, before any limit counts it', async () => {
    const W = await generateKeyPairSigner();
    const headers = (skill: string | null) => ({ ...from(), ...(skill ? { 'x-orientim-skill': skill } : {}) });
    const challenge = (skill: string | null, d = deps(20_000_000n)) =>
      keyChallenge(new Request(`https://orientim.com/api/v1/keys/challenge?wallet=${W.address}`, { headers: headers(skill) }), d);
    const old = await challenge('1.12.2');
    expect(old.status).toBe(426);
    const body = await old.json() as { error: { code: string; minimum: string; message: string } };
    expect(body.error.code).toBe('skill-outdated');
    expect(body.error.minimum).toBe(MIN_KEY_SKILL_VERSION);
    expect(body.error.message).toMatch(/npx -y @orientimhq\/swap@\d+\.\d+\.\d+ mcp/);
    expect(body.error.message).toMatch(/orientim\.mcpb/);
    expect(body.error.message).toMatch(/skill folder/);
    const c = await newChallenge(secret(5), { domain: 'orientim.com', uri: 'u', wallet: W.address, now: NOW });
    const issued = await keyIssue(new Request('https://orientim.com/api/v1/keys', {
      method: 'POST', headers: headers('1.10.8'), body: JSON.stringify({ ...c, signature: await sign(W, c.message) }),
    }), deps(20_000_000n));
    expect(issued.status).toBe(426);
    // Served: the current skill, a request naming none (the site), and what is not a version.
    for (const skill of [MIN_KEY_SKILL_VERSION, '2.0.0', null, 'dev']) expect((await challenge(skill)).status, String(skill)).toBe(200);
    // A higher ORIENTIM_MIN_SKILL_VERSION raises the bar here too; a lower one does not lower it.
    expect((await challenge(MIN_KEY_SKILL_VERSION, { ...deps(20_000_000n), minSkillVersion: '9.0.0' })).status).toBe(426);
    expect((await challenge('1.12.2', { ...deps(20_000_000n), minSkillVersion: '1.0.0' })).status).toBe(426);
    // Refused before the address's limit counts: an old copy retrying never locks its address out.
    const ipHeaders = { 'x-vercel-forwarded-for': '10.0.9.9', 'x-orientim-skill': '1.12.2' };
    for (let i = 0; i < 40; i++) {
      await keyChallenge(new Request(`https://orientim.com/api/v1/keys/challenge?wallet=${W.address}`, { headers: ipHeaders }), deps(0n));
    }
    const fresh = await keyChallenge(new Request(`https://orientim.com/api/v1/keys/challenge?wallet=${W.address}`, { headers: { 'x-vercel-forwarded-for': '10.0.9.9' } }), deps(0n));
    expect(fresh.status).toBe(200);
  });

  it('keep the signed message as the record that the wallet accepted the Terms, and give no key without it', async () => {
    const W = await generateKeyPairSigner();
    const kept: Acceptance[] = [];
    const recording = (lamports: bigint, record: AccessDeps['recordAcceptance']): AccessDeps => ({ ...deps(lamports), recordAcceptance: record });
    const ask = async (d: AccessDeps, skill?: string) => {
      const c = await newChallenge(secret(5), { domain: 'orientim.com', uri: 'u', wallet: W.address, now: NOW });
      return keyIssue(new Request('https://orientim.com/api/v1/keys', {
        method: 'POST', headers: { ...from(), ...(skill ? { 'x-orientim-skill': skill } : {}) }, body: JSON.stringify({ ...c, signature: await sign(W, c.message) }),
      }), d);
    };
    const res = await ask(recording(20_000_000n, async a => { kept.push(a); }), '1.12.4');
    expect(res.status).toBe(200);
    const { expiresAt } = await res.json() as { expiresAt: string };
    expect(kept).toHaveLength(1);
    const [a] = kept;
    expect(a).toMatchObject({ wallet: W.address, terms: 'https://orientim.com/terms', termsUpdated: LEGAL.lastUpdated, keyExpiresAt: expiresAt, skill: '1.12.4' });
    expect(a.acceptedAt).toBe(new Date(NOW * 1000).toISOString());
    expect(a.message).toContain('accept the Terms of Use at https://orientim.com/terms');
    // The record proves itself: the wallet's own signature of the message kept.
    const ok = await verifySignature(await getPublicKeyFromAddress(W.address), getBase58Encoder().encode(a.signature) as SignatureBytes, new TextEncoder().encode(a.message));
    expect(ok).toBe(true);
    // Nothing about the person beyond it: no IP address, no balance.
    expect(Object.keys(a).sort()).toEqual(['acceptedAt', 'keyExpiresAt', 'message', 'signature', 'skill', 'terms', 'termsUpdated', 'wallet']);
    // Refused before a key: nothing is recorded.
    expect((await ask(recording(0n, async x => { kept.push(x); }))).status).toBe(403);
    expect(kept).toHaveLength(1);
    // The record could not be kept: no key.
    const failed = await ask(recording(20_000_000n, async () => { throw new Error('store down'); }));
    expect(failed.status).toBe(503);
    const body = await failed.json() as { key?: string; error: { code: string } };
    expect(body.key).toBeUndefined();
    expect(body.error.code).toBe('unavailable');
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
    body: JSON.stringify({ owner, inputMint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', outputMint: 'So11111111111111111111111111111111111111112', amountIn: '1000000', minOut: '1' }),
  });

  it('prepares for its own wallet only: another wallet is refused before anything is built', async () => {
    const W = await generateKeyPairSigner();
    const other = await generateKeyPairSigner();
    const { key } = await issueKey(secret(6), W.address, Math.floor(Date.now() / 1000));
    const res = await agentPrepare(prepare(key, other.address), api([secret(6)]));
    expect(res.status).toBe(403);
    expect((await res.json() as { error: { code: string } }).error.code).toBe('wrong-wallet');
  });

  it('prepares nothing, and asks Jupiter nothing, for a wallet emptied after it got its key', async () => {
    const W = await generateKeyPairSigner();
    const { key } = await issueKey(secret(6), W.address, Math.floor(Date.now() / 1000));
    const accounts = new Map<string, Account>([[USDC, mint(6)], [WSOL_MINT, mint(9)], [DEX, { owner: address('BPFLoaderUpgradeab1e11111111111111111111111'), data: new Uint8Array(36) }], [POOL, { owner: DEX, data: new Uint8Array(300) }]]);
    const asked: BuildParams[] = [];
    const deps = (held: Map<string, Account>) => ({ ...api([secret(6)]), rpc: fakeRpc(held), jupiter: fakeJupiter({ asked }) });
    // Its USDC moved on, and so did its SOL: a key made by the thousand costs Orientim nothing.
    for (const held of [accounts, new Map([...accounts, ...await fundedAccounts(W.address, USDC, { amount: 999_999n }), [W.address, { owner: SYSTEM_PROGRAM, data: new Uint8Array(0) }] as [string, Account]])]) {
      const res = await agentPrepare(prepare(key, W.address), deps(held));
      expect(res.status).toBe(422);
      expect((await res.json() as { error: { code: string } }).error.code).toBe('insufficient-balance');
    }
    expect(asked).toHaveLength(0);
    // Holding the amount and SOL for the network fee, it prepares.
    const funded = new Map([...accounts, ...await fundedAccounts(W.address, USDC), [W.address, { owner: SYSTEM_PROGRAM, data: new Uint8Array(0) }] as [string, Account]]);
    const res = await agentPrepare(prepare(key, W.address), deps(funded));
    expect(res.status).toBe(200);
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

  it('without a site set, a message Orientim wrote for another host is refused at this one', async () => {
    const W = await generateKeyPairSigner();
    const got = await keyChallenge(new Request(`https://phishing.example/api/v1/keys/challenge?wallet=${W.address}`, { headers: from() }), site(null));
    const c = await got.json() as { message: string; challenge: string };
    const signed = JSON.stringify({ ...c, signature: await sign(W, c.message) });
    const issue = (host: string) => keyIssue(new Request(`https://${host}/api/v1/keys`, { method: 'POST', headers: from(), body: signed }), site(null));
    const res = await issue('preview-abc.vercel.app');
    expect(res.status).toBe(400);
    expect((await res.json() as { error: { message: string } }).error.message).toMatch(/another site/);
    // The host the challenge was written for, as on a machine of one's own.
    expect((await issue('phishing.example')).status).toBe(200);
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

    it('acceptances of the Terms are recorded once a Blob store is connected', () => {
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      vi.spyOn(console, 'error').mockImplementation(() => {});
      Object.assign(process.env, {
        ORIENTIM_API_SECRET: good, ORIENTIM_KEY_SECRET: Buffer.alloc(32, 8).toString('base64'),
        ORIENTIM_PUBLIC_ORIGIN: 'https://orientim.com', RPC_URL: 'http://127.0.0.1:1',
      });
      delete process.env.BLOB_READ_WRITE_TOKEN;
      expect(accessDeps()?.recordAcceptance).toBeNull();
      process.env.BLOB_READ_WRITE_TOKEN = 'vercel_blob_rw_test_token';
      expect(typeof accessDeps()?.recordAcceptance).toBe('function');
    });

    it('in production, keys stay off without ORIENTIM_PUBLIC_ORIGIN, and the API without a treasury or a fee', () => {
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
      Object.assign(process.env, {
        ORIENTIM_API_SECRET: good, ORIENTIM_KEY_SECRET: Buffer.alloc(32, 8).toString('base64'), RPC_URL: 'http://127.0.0.1:1',
        VERCEL_ENV: 'production', NEXT_PUBLIC_ORIENTIM_TREASURY: 'ARzSA3sZGhf5t4UnYrmB3TWyZ5m3Wo1nA9zWBcoiTqLE',
      });
      delete process.env.ORIENTIM_PUBLIC_ORIGIN;
      expect(accessDeps()).toBeNull();
      process.env.ORIENTIM_PUBLIC_ORIGIN = 'https://orientim.com';
      expect(accessDeps()).not.toBeNull();
      delete process.env.NEXT_PUBLIC_ORIENTIM_TREASURY;
      expect(agentDeps()).toBeNull();
      expect(errors.mock.calls.flat().join()).toContain('production without a treasury');
      process.env.ORIENTIM_TEST_MODE = '1';
      expect(agentDeps()).not.toBeNull();
      // Outside production, as on a machine of one's own, it runs without a fee, and says so.
      delete process.env.ORIENTIM_TEST_MODE;
      delete process.env.VERCEL_ENV;
      expect(agentDeps()).not.toBeNull();
    });

    it("on a Vercel preview without ORIENTIM_PUBLIC_ORIGIN, the message names the deployment's own address, or keys stay off", () => {
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      vi.spyOn(console, 'error').mockImplementation(() => {});
      Object.assign(process.env, {
        ORIENTIM_API_SECRET: good, ORIENTIM_KEY_SECRET: Buffer.alloc(32, 8).toString('base64'), RPC_URL: 'http://127.0.0.1:1',
        VERCEL_ENV: 'preview', VERCEL_URL: 'bound-web-git-x-team.vercel.app',
      });
      delete process.env.ORIENTIM_PUBLIC_ORIGIN;
      expect(accessDeps()?.origin).toBe('https://bound-web-git-x-team.vercel.app');
      delete process.env.VERCEL_URL;
      expect(accessDeps()).toBeNull();
      // Off Vercel, as on a machine of one's own, the request's host is the site.
      delete process.env.VERCEL_ENV;
      expect(accessDeps()?.origin).toBeNull();
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

describe('the Terms record on a disk of its own (ORIENTIM_TERMS_DIR, a Fly volume)', () => {
  it('writes each acceptance as its own file by day, and two at the same second never overwrite one another', async () => {
    const { mkdtemp, readdir, readFile, rm } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const { fileRecorder } = await import('../lib/server/agent/termsRecord.ts');
    const dir = await mkdtemp(join(tmpdir(), 'orientim-terms-'));
    try {
      const a: Acceptance = {
        wallet: '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM', terms: 'https://orientim.com/terms', termsUpdated: '2026-10-01',
        message: 'm', signature: 's', acceptedAt: '2026-10-21T09:15:42.000Z', keyExpiresAt: '2027-01-19T09:15:42.000Z', skill: null,
      };
      const record = fileRecorder(dir);
      await record(a);
      await record({ ...a, signature: 't' });
      const files = await readdir(join(dir, 'terms-acceptances', '2026-10-21'));
      expect(files).toHaveLength(2);
      for (const f of files) expect(f).toMatch(/^9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM-091542-[0-9a-f]{12}\.json$/);
      const saved = await Promise.all(files.map(async f => JSON.parse(await readFile(join(dir, 'terms-acceptances', '2026-10-21', f), 'utf8'))));
      expect(saved.map(x => x.signature).sort()).toEqual(['s', 't']);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
