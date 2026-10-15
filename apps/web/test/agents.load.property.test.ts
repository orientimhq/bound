/**
 * Many clients at once through one API key, fuzzed end to end: the skill's `protectedSwap` (agents)
 * and `orientim-verify` (bots) against Orientim's real API handlers and one fake chain, no money.
 *
 * 1. One API key in a burst (60 swaps in the same second, and more): exactly the key's limit per
 *    minute is served, every other request is told to wait (429 with Retry-After), and nothing a
 *    refused request asked for is ever sent.
 * 2. Several clients swapping at the same time through one key, each with rules of its own (tokens
 *    allowed, a limit per swap and per day, or none), agents one swap at a time and bots several at
 *    once on the same wallet, retries of the same order included: no order is swapped twice, no
 *    owner's limit is crossed, every answer is one the docs name, every transaction sent is one a
 *    client was told swapped, and afterwards `recover` finds nothing left to settle.
 *
 * `npm run test:fuzz` runs 2,000 cases of the second and a twentieth as many bursts (each up to 150
 * requests); ORIENTIM_FUZZ_RUNS and ORIENTIM_FUZZ_SEED set a shard.
 */
import { createHash } from 'node:crypto';
import { mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import {
  address, generateKeyPairSigner, getBase58Decoder, getCompiledTransactionMessageDecoder, getTransactionDecoder, signBytes,
} from '@solana/kit';
import type { KeyPairSigner, Rpc, SolanaRpcApi } from '@solana/kit';
import { ataOf, WSOL_MINT } from '@orientimhq/swap/core';
import { BONK, DEX, fakeJupiter, fakeRpc, fundedAccounts, mint, POOL, tokenAccount, USDC } from '../../../packages/jupiter/test/fakes.ts';
import type { Account } from '../../../packages/jupiter/test/fakes.ts';
import { agentFinalize, agentPrepare } from '../lib/server/agent/api.ts';
import type { AgentDeps } from '../lib/server/agent/api.ts';
import { acquireLock, createFileStore, LockBusyError, OrientimOrderError, PendingSwapError, PolicyError, protectedSwap } from '@orientimhq/swap';
import type { OwnerPolicy } from '@orientimhq/swap';
import { runCli } from '@orientimhq/swap';

const MODE = (import.meta as { env?: { MODE?: string } }).env?.MODE;
const RUNS = Number(process.env.ORIENTIM_FUZZ_RUNS ?? (MODE === 'fuzz' ? 2_000 : 8));
const SEED = process.env.ORIENTIM_FUZZ_SEED ? Number(process.env.ORIENTIM_FUZZ_SEED) : undefined;
const PARAMS = { numRuns: RUNS, ...(SEED !== undefined ? { seed: SEED } : {}) };
/** A burst is up to 150 swaps prepared: a twentieth as many cases. */
const BURSTS = { ...PARAMS, numRuns: Math.max(4, Math.floor(RUNS / 20)) };
const TIMEOUT = 60_000 + RUNS * 5_000;

const TREASURY = address('9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM');
const API = 'http://orientim.test';
/** Each case has a key of its own, so that its rate limit is its own. */
let cases = 0;

/** Orientim with one API key, one chain and Jupiter, and a wallet funded in USDC and BONK for each client. */
async function server(clients: number, perMinute: number, own = false) {
  const label = `load-${++cases}`;
  const key = `ori_load_${label}_${'0'.repeat(16)}`;
  const wallets = await Promise.all(Array.from({ length: clients }, () => generateKeyPairSigner()));
  const accounts = new Map<string, Account>([
    [USDC, mint(6)], [WSOL_MINT, mint(9)], [BONK, mint(5)],
    [DEX, { owner: address('BPFLoaderUpgradeab1e11111111111111111111111'), data: new Uint8Array(36) }],
    [POOL, { owner: DEX, data: new Uint8Array(300) }],
    [await ataOf(TREASURY, USDC), tokenAccount(TREASURY, USDC)],
  ]);
  for (const w of wallets) for (const m of [USDC, BONK]) for (const [k, a] of await fundedAccounts(w.address, m)) accounts.set(k, a);
  const sent: string[] = [];
  const rpc = fakeRpc(accounts, { sent });
  const jupiter = fakeJupiter({ out: 1_000_000_000n });
  const deps: AgentDeps = {
    rpc, jupiter, secrets: [new Uint8Array(32).fill(5)],
    keys: new Map([[createHash('sha256').update(key).digest('hex'), label]]),
    feeBps: 25n, treasury: TREASURY, excludeDexes: [], maxNetworkFeeLamports: 200_000n, disabled: false, v1: false, perMinute,
    ownRoutes: own,
  };
  const fetchImpl = (async (url: string, init: RequestInit) => {
    if (url.startsWith('https://api.jup.ag/')) {
      const q = new URL(url).searchParams;
      const r = await jupiter.build({
        inputMint: address(q.get('inputMint')!), outputMint: address(q.get('outputMint')!), amount: BigInt(q.get('amount')!),
        taker: address(q.get('taker')!), slippageBps: Number(q.get('slippageBps')), maxAccounts: Number(q.get('maxAccounts')),
        ...(q.get('destinationTokenAccount') ? { destinationTokenAccount: address(q.get('destinationTokenAccount')!) } : {}),
        ...(q.get('excludeDexes') ? { excludeDexes: q.get('excludeDexes')!.split(',') } : {}),
      });
      return Response.json({ ...r, priceImpactPct: 0 });
    }
    if (url.endsWith('/api/v1/finalize')) return agentFinalize(new Request(url, init), deps);
    return agentPrepare(new Request(url, init), deps);
  }) as unknown as typeof fetch;
  const agentRpc = {
    ...rpc,
    getBlockHeight: () => ({ send: async () => 850n }),
    getSignatureStatuses: () => ({ send: async () => ({ value: [{ confirmationStatus: 'confirmed', err: null }] }) }),
  } as unknown as Rpc<SolanaRpcApi>;
  return { key, wallets, sent, fetchImpl, agentRpc, jupiter: own ? { jupiterApiKey: 'agent-key' } : {} };
}

/** The wallet that signed and paid for a transaction sent. */
const payerOf = (wire: string) =>
  getCompiledTransactionMessageDecoder().decode(getTransactionDecoder().decode(Buffer.from(wire, 'base64')).messageBytes).staticAccounts[0];

describe('many clients through one API key', () => {
  it('serves exactly the limit of a key in a burst, tells the rest to wait, and sends nothing it refused', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom(60, 120, 600, 3_600), fc.integer({ min: 1, max: 150 }), fc.integer({ min: 1, max: 4 }),
        fc.array(fc.bigInt({ min: 1_000_000n, max: 50_000_000_000n }), { minLength: 1, maxLength: 8 }),
        async (perMinute, burst, clients, amounts) => {
          const s = await server(clients, perMinute);
          // All at once: a bot firing `burst` swaps in the same second from one key.
          const answers = await Promise.all(Array.from({ length: burst }, (_, i) => s.fetchImpl(`${API}/api/v1/prepare`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', authorization: `Bearer ${s.key}` },
            body: JSON.stringify({
              owner: s.wallets[i % clients].address, inputMint: USDC, outputMint: WSOL_MINT, amountIn: amounts[i % amounts.length].toString(), minOut: '1',
            }),
          } as RequestInit)));
          const waited = answers.filter(r => r.status === 429);
          expect(waited.length).toBe(Math.max(0, burst - perMinute));
          for (const r of waited) {
            expect(Number(r.headers.get('retry-after'))).toBeGreaterThan(0);
            expect(((await r.json()) as { error: { code: string } }).error.code).toBe('rate-limited');
          }
          for (const r of answers.filter(a => a.status !== 429)) expect(r.status).toBe(200);
          // Prepare never sends: only a finalize the wallet signed can.
          expect(s.sent).toEqual([]);
        },
      ),
      BURSTS,
    );
  }, TIMEOUT);

  it("swaps for several clients at once, each within its own rules: no order twice, no limit crossed, nothing left to settle", async () => {
    const swap = fc.record({
      mint: fc.constantFrom(USDC, BONK),
      amount: fc.bigInt({ min: 1_000_000n, max: 5_000_000n }),
      // A few ids for many swaps: the same order asked again, at the same time or later, is a retry.
      order: fc.integer({ min: 0, max: 3 }),
    });
    const rules = fc.option(fc.record({
      usdc: fc.option(fc.bigInt({ min: 1_000_000n, max: 6_000_000n }), { nil: undefined }),
      bonk: fc.option(fc.bigInt({ min: 1_000_000n, max: 6_000_000n }), { nil: undefined }),
      daily: fc.option(fc.bigInt({ min: 1_000_000n, max: 12_000_000n }), { nil: undefined }),
    }), { nil: undefined });
    const client = fc.record({ channel: fc.constantFrom('agent', 'bot'), rules, swaps: fc.array(swap, { minLength: 1, maxLength: 5 }) });

    await fc.assert(
      fc.asyncProperty(fc.array(client, { minLength: 1, maxLength: 4 }), async plan => {
        // Every other plan, the clients bring their own routes (several rounds of prepare each).
        const s = await server(plan.length, 1_000_000, cases % 2 === 0);
        type Done = { order: string; mint: string; amount: bigint };
        const swapped: Done[][] = plan.map(() => []);

        await Promise.all(plan.map(async (c, n) => {
          const wallet = s.wallets[n];
          const stateDir = mkdtempSync(join(tmpdir(), 'orientim-load-'));
          const policy: OwnerPolicy | undefined = c.rules && {
            maxAmountIn: {
              ...(c.rules.usdc !== undefined ? { [USDC]: c.rules.usdc.toString() } : {}),
              ...(c.rules.bonk !== undefined ? { [BONK]: c.rules.bonk.toString() } : {}),
            },
            ...(c.rules.daily !== undefined ? { maxAmountInPerDay: { [USDC]: c.rules.daily.toString(), [BONK]: c.rules.daily.toString() } } : {}),
          };
          const intentOf = (x: { mint: string; amount: bigint; order: number }) =>
            ({ inputMint: x.mint, outputMint: x.mint === USDC ? WSOL_MINT : USDC, amountIn: x.amount.toString(), treasury: TREASURY, id: `order-${x.order}` });

          if (c.channel === 'agent') {
            // The example holds the wallet's lock for its whole run: one swap at a time per wallet.
            const store = createFileStore(stateDir);
            for (const x of c.swaps) {
              const release = acquireLock(stateDir, wallet.address);
              try {
                const r = await protectedSwap({
                  apiUrl: API, apiKey: s.key, rpc: s.agentRpc, wallet: wallet as KeyPairSigner, fetchImpl: s.fetchImpl, pollMs: 1,
                  intent: intentOf(x), orders: store, pending: store, spends: store, ...(policy ? { policy } : {}), ...s.jupiter,
                });
                if (r.outcome === 'confirmed') swapped[n].push({ order: `order-${x.order}`, mint: x.mint, amount: x.amount });
                else expect(['failed', 'rejected', 'expired']).toContain(r.outcome);
              } catch (e) {
                // Refusals the skill names; anything else is a bug.
                expect(e instanceof PolicyError || e instanceof OrientimOrderError || e instanceof PendingSwapError, String(e)).toBe(true);
              } finally {
                release();
              }
            }
            return;
          }

          // A bot: several processes of the same wallet at once, sharing one state directory.
          const deps = {
            rpc: s.agentRpc, apiUrl: API, apiKey: s.key, fetchImpl: s.fetchImpl, pollMs: 1, maxWaitMs: 60, stateDir, treasury: TREASURY,
            ...(policy ? { policy } : {}), ...s.jupiter,
          };
          await Promise.all(c.swaps.map(async x => {
            const ready = await runCli('prepare', { intent: { owner: wallet.address, ...intentOf(x) } }, deps);
            expect([0, 1, 3, 5], JSON.stringify(ready.output)).toContain(ready.code);
            const out = JSON.parse(JSON.stringify(ready.output)) as { checked?: unknown; message?: string };
            if (ready.code !== 0 || !out.message) return;
            const signature = getBase58Decoder().decode(await signBytes(wallet.keyPair.privateKey, Buffer.from(out.message, 'base64')));
            const done = await runCli('finalize', { checked: out.checked, signature }, deps);
            expect([0, 1, 3, 5], JSON.stringify(done.output)).toContain(done.code);
            if (done.code === 0) swapped[n].push({ order: `order-${x.order}`, mint: x.mint, amount: x.amount });
          }));
          // Whatever raced, nothing is left that could still land.
          const recovered = await runCli('recover', {}, deps);
          expect(recovered.code, JSON.stringify(recovered.output)).toBe(0);
          expect(readdirSync(stateDir).filter(f => f.startsWith('pending-'))).toEqual([]);
        }));

        for (const [n, c] of plan.entries()) {
          const done = swapped[n];
          // No order swapped twice.
          const orders = done.map(d => d.order);
          expect(new Set(orders).size).toBe(orders.length);
          // The owner's rules, whatever ran at the same time.
          if (c.rules) {
            const cap = { [USDC]: c.rules.usdc, [BONK]: c.rules.bonk };
            for (const d of done) {
              expect(cap[d.mint]).toBeDefined();
              expect(d.amount <= cap[d.mint]!).toBe(true);
            }
            if (c.rules.daily !== undefined) {
              for (const m of [USDC, BONK]) {
                const total = done.filter(d => d.mint === m).reduce((a, d) => a + d.amount, 0n);
                expect(total <= c.rules.daily).toBe(true);
              }
            }
          }
          // Every transaction sent from this wallet is one its client was told swapped, and no other.
          expect(s.sent.filter(w => payerOf(w) === s.wallets[n].address).length).toBe(done.length);
        }
      }),
      PARAMS,
    );
  }, TIMEOUT);
});
