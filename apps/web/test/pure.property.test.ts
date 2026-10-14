/**
 * The small functions every channel leans on, fuzzed by the million:
 * - the API key's message and seal: any change refuses it;
 * - what arrived, as the skill reads it from the wallet's balances.
 *
 * `npm run test:fuzz` runs 500,000 cases per property; ORIENTIM_FUZZ_RUNS and ORIENTIM_FUZZ_SEED set a shard.
 */
import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { generateKeyPairSigner } from '@solana/kit';
import type { Rpc, SolanaRpcApi } from '@solana/kit';
import { issueKey, newChallenge, openKey } from '../lib/server/agent/keys.ts';
import { isApiKeyMessage, receivedFor } from '../../../skills/orientim-protected-swap/examples/swap.ts';

const MODE = (import.meta as { env?: { MODE?: string } }).env?.MODE;
const RUNS = Number(process.env.ORIENTIM_FUZZ_RUNS ?? (MODE === 'fuzz' ? 500_000 : 2_000));
const SEED = process.env.ORIENTIM_FUZZ_SEED ? Number(process.env.ORIENTIM_FUZZ_SEED) : undefined;
const PARAMS = { numRuns: RUNS, ...(SEED !== undefined ? { seed: SEED } : {}) };
const TIMEOUT = 60_000 + RUNS * 2;

describe('the API key', () => {
  it("refuses any change to the first four lines of Orientim's key message", async () => {
    const W = (await generateKeyPairSigner()).address;
    const { message } = await newChallenge(new Uint8Array(32).fill(1), { domain: 'orientim.com', uri: 'https://orientim.com/developers#access', wallet: W, now: 1_790_000_000 });
    expect(isApiKeyMessage(message, 'https://orientim.com', W, 1_790_000_000_000)).toBe(true);
    const head = message.split('\n').slice(0, 4).join('\n').length;
    fc.assert(fc.property(fc.nat({ max: head - 1 }), fc.string({ minLength: 1, maxLength: 3 }), fc.constantFrom('replace', 'insert', 'delete'), (at, text, how) => {
      const changed = how === 'replace' ? message.slice(0, at) + text + message.slice(at + 1)
        : how === 'insert' ? message.slice(0, at) + text + message.slice(at)
          : message.slice(0, at) + message.slice(at + 1);
      if (changed === message) return;
      expect(isApiKeyMessage(changed, 'https://orientim.com', W, 1_790_000_000_000)).toBe(false);
    }), PARAMS);
  }, TIMEOUT);

  it('opens a key only as Orientim sealed it: any changed character closes it', async () => {
    const W = (await generateKeyPairSigner()).address;
    const secret = new Uint8Array(32).fill(7);
    const { key } = await issueKey(secret, W, 1_790_000_000);
    expect(await openKey([secret], key, 1_790_000_001)).toEqual({ id: `w:${W}`, wallet: W });
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_.';
    await fc.assert(fc.asyncProperty(fc.nat({ max: key.length - 1 }), fc.nat({ max: alphabet.length - 1 }), async (at, pick) => {
      const changed = key.slice(0, at) + alphabet[pick] + key.slice(at + 1);
      if (changed === key) return;
      expect(await openKey([secret], changed, 1_790_000_001)).toBeNull();
    }), { ...PARAMS, numRuns: Math.max(1, Math.floor(RUNS / 5)) });
  }, TIMEOUT);
});

describe('what arrived', () => {
  it('reads a token received as what the wallet gained, from any balances before and after', async () => {
    const W = (await generateKeyPairSigner()).address;
    const mintOut = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
    await fc.assert(fc.asyncProperty(fc.option(fc.bigInt({ min: 0n, max: 10n ** 15n }), { nil: undefined }), fc.bigInt({ min: 0n, max: 10n ** 15n }), async (before, gained) => {
      const after = (before ?? 0n) + gained;
      const meta = {
        fee: 5_000, preBalances: [], postBalances: [],
        preTokenBalances: before === undefined ? [] : [{ accountIndex: 2, mint: mintOut, owner: W, uiTokenAmount: { amount: before.toString() } }],
        postTokenBalances: [{ accountIndex: 2, mint: mintOut, owner: W, uiTokenAmount: { amount: after.toString() } }],
      };
      const rpc = { getTransaction: () => ({ send: async () => ({ meta }) }) } as unknown as Rpc<SolanaRpcApi>;
      const got = await receivedFor(rpc, 'sig', { wallet: W, certificate: { output: { mint: mintOut } } as never, policy: { takerRent: '0', routeRefund: '0' } });
      expect(got).toBe(gained);
    }), { ...PARAMS, numRuns: Math.max(1, Math.floor(RUNS / 5)) });
  }, TIMEOUT);
});
