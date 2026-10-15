/**
 * Getting an API key from the skill (AGENT-API.md, "API access"): the agent signs Orientim's key
 * message for its own wallet and nothing else, then gets a key bound to that wallet. The server here is
 * the real one (agent/access.ts), called in process.
 */
import { describe, expect, it, vi } from 'vitest';
import { generateKeyPairSigner, getBase58Decoder, signBytes } from '@solana/kit';
import { isApiKeyMessage, requestApiKey } from '@orientimhq/swap';
import { runCli } from '@orientimhq/swap';
import { keyChallenge, keyIssue } from '../lib/server/agent/access.ts';
import type { AccessDeps } from '../lib/server/agent/access.ts';
import { openKey } from '../lib/server/agent/keys.ts';

const SECRET = new Uint8Array(32).fill(11);
const API = 'https://orientim.com';
const deps: AccessDeps = {
  rpc: { getBalance: () => ({ send: async () => ({ value: 50_000_000n }) }) } as unknown as AccessDeps['rpc'],
  keySecrets: [SECRET],
  minLamports: 10_000_000n,
};
let ip = 0;
/** Orientim's key endpoints, in process. */
const orientim: typeof fetch = async (input, init) => {
  const req = new Request(String(input), { ...init, headers: { ...(init?.headers as Record<string, string>), 'x-vercel-forwarded-for': `10.1.0.${++ip}` } });
  return String(input).includes('/challenge') ? keyChallenge(req, deps) : keyIssue(req, deps);
};

describe("the skill's key request", () => {
  it('signs the checked message and gets a key bound to its wallet', async () => {
    const W = await generateKeyPairSigner();
    const signMessage = vi.fn((m: Uint8Array) => signBytes(W.keyPair.privateKey, m));
    const got = await requestApiKey({ apiUrl: API, address: W.address, signMessage, fetchImpl: orientim });
    expect(signMessage).toHaveBeenCalledTimes(1);
    expect(got.wallet).toBe(W.address);
    expect(await openKey([SECRET], got.key, Math.floor(Date.now() / 1000))).toEqual({ id: `w:${W.address}`, wallet: W.address });
  });

  it('signs nothing when the server asks it to sign something else', async () => {
    const W = await generateKeyPairSigner();
    const other = await generateKeyPairSigner();
    const answering = (message: string): typeof fetch => async () => Response.json({ message, challenge: 'x' });
    const genuine = (await (await orientim(`${API}/api/v1/keys/challenge?wallet=${W.address}`)).json()) as { message: string };
    const tries = [
      genuine.message.replace(W.address, other.address), // another wallet's key
      genuine.message.replace('orientim.com wants', 'evil.example wants'), // another site
      `${genuine.message}\nResources: - https://evil.example`, // anything added
      Buffer.from([1, 0, 1, 3, ...new Array(96).fill(7)]).toString('latin1'), // bytes shaped like a transaction
    ];
    for (const message of tries) {
      const signMessage = vi.fn((m: Uint8Array) => signBytes(W.keyPair.privateKey, m));
      await expect(requestApiKey({ apiUrl: API, address: W.address, signMessage, fetchImpl: answering(message) })).rejects.toThrow(/Nothing was signed/);
      expect(signMessage).not.toHaveBeenCalled();
    }
  });

  it('knows its message: this wallet, this host, plain text only', async () => {
    const W = await generateKeyPairSigner();
    const { message } = (await (await orientim(`${API}/api/v1/keys/challenge?wallet=${W.address}`)).json()) as { message: string };
    expect(isApiKeyMessage(message, API, W.address)).toBe(true);
    expect(isApiKeyMessage(message, 'https://other.example', W.address)).toBe(false);
    expect(isApiKeyMessage(`${message}\u0000`, API, W.address)).toBe(false);
  });
});

describe('orientim-verify key-challenge and key', () => {
  const cli = { rpc: {} as never, apiUrl: API, fetchImpl: orientim, stateDir: '.unused' };

  it('give the bot the message to sign, then its key; the bot signs itself', async () => {
    const W = await generateKeyPairSigner();
    const c = await runCli('key-challenge', { wallet: W.address }, cli);
    expect(c.code).toBe(0);
    const { message, challenge, messageBase64 } = c.output as { message: string; challenge: string; messageBase64: string };
    expect(Buffer.from(messageBase64, 'base64').toString()).toBe(message);
    const signature = getBase58Decoder().decode(await signBytes(W.keyPair.privateKey, Buffer.from(messageBase64, 'base64')));
    const k = await runCli('key', { message, challenge, signature }, cli);
    expect(k.code).toBe(0);
    expect((k.output as { wallet: string }).wallet).toBe(W.address);
  });

  it("refuse to send anything but Orientim's message, and say when Orientim refuses", async () => {
    const W = await generateKeyPairSigner();
    expect((await runCli('key', { message: 'hello', challenge: 'x', signature: 'y' }, cli)).code).toBe(2);
    const c = await runCli('key-challenge', { wallet: W.address }, cli);
    const { message, challenge } = c.output as { message: string; challenge: string };
    const other = await generateKeyPairSigner();
    const wrong = getBase58Decoder().decode(await signBytes(other.keyPair.privateKey, new TextEncoder().encode(message)));
    const refused = await runCli('key', { message, challenge, signature: wrong }, cli);
    expect(refused.code).toBe(4);
    expect((refused.output as { code: string }).code).toBe('bad-signature');
  });
});
