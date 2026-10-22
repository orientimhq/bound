/**
 * The current system, fuzzed end to end: the skill's `protectedSwap` (agents) and `orientim-verify`
 * (bots) against Orientim's real API handlers, a fake chain and a fake Jupiter. The cases vary:
 * - whose routes: the agent's own Jupiter key (rounds of `routes-needed`), no key (Orientim's), or a
 *   key against a deployment with own routes off;
 * - the side of the fee: on the output (a sale into SOL, the treasury wallet exists) or the input;
 * - how far below the market the agent's Jupiter answers for the one-time key: honest, within the
 *   1% Orientim allows, or far below it (understated 100 times, say);
 * - routes too wide for the transaction, so the build takes more rounds at narrower levels;
 * - who sends: the agent's own sender (finalize with `send: false`) or Orientim;
 * - the tolerance and the amount.
 *
 * What must hold in every case:
 * - an honest swap confirms; nothing is sent for one that does not;
 * - the fee on the input is exactly feeBps of the amount; on the output it is feeBps of the minimum
 *   the transaction enforces, and that minimum is never more than 1% below Orientim's own price
 *   less the tolerance, however low the agent's routes are;
 * - with own routes, Orientim's key builds nothing unless the agent's routes were not usable;
 * - with the agent's sender, Orientim's RPC sends nothing; with Orientim's, it sends once;
 * - at most 10 rounds of prepare, and at most 24 routes fetched.
 *
 * `npm run test:fuzz` runs 3,000 cases; ORIENTIM_FUZZ_RUNS and ORIENTIM_FUZZ_SEED set a shard.
 */
import { createHash } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { address, generateKeyPairSigner, getBase58Decoder, signBytes } from '@solana/kit';
import type { Rpc, SolanaRpcApi } from '@solana/kit';
import { SYSTEM_PROGRAM, WSOL_MINT } from '@orientimhq/swap/core';
import { ataOf } from '@orientim/builder';
import { DEX, fakeJupiter, fakeRpc, fundedAccounts, mint, OUT, POOL, tokenAccount, USDC, BONK } from '../../../packages/jupiter/test/fakes.ts';
import type { Account } from '../../../packages/jupiter/test/fakes.ts';
import type { BuildParams, JupiterClient } from '../../../packages/jupiter/src/client.ts';
import { agentFinalize, agentPrepare } from '../lib/server/agent/api.ts';
import type { AgentDeps } from '../lib/server/agent/api.ts';
import { protectedSwap } from '@orientimhq/swap';
import type { Intent } from '@orientimhq/swap';
import { runCli } from '@orientimhq/swap';

const MODE = (import.meta as { env?: { MODE?: string } }).env?.MODE;
const RUNS = Number(process.env.ORIENTIM_FUZZ_RUNS ?? (MODE === 'fuzz' ? 3_000 : 40));
const SEED = process.env.ORIENTIM_FUZZ_SEED ? Number(process.env.ORIENTIM_FUZZ_SEED) : undefined;
const PARAMS = { numRuns: RUNS, ...(SEED !== undefined ? { seed: SEED } : {}) };
const TIMEOUT = 60_000 + RUNS * 1_500;

const KEY = 'ori_fuzz_routes_key_000000000001';
const TREASURY = address('9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM');
const FEE_BPS = 25n;
type Routes = 'own' | 'orientim' | 'own-off';
type Side = 'output' | 'input';

/** Jupiter over HTTP, answering from `market`. */
async function answer(url: string, market: JupiterClient) {
  const q = new URL(url).searchParams;
  const r = await market.build({
    inputMint: address(q.get('inputMint')!), outputMint: address(q.get('outputMint')!), amount: BigInt(q.get('amount')!),
    taker: address(q.get('taker')!), slippageBps: Number(q.get('slippageBps')), maxAccounts: Number(q.get('maxAccounts')),
    ...(q.get('destinationTokenAccount') ? { destinationTokenAccount: address(q.get('destinationTokenAccount')!) } : {}),
    ...(q.get('excludeDexes') ? { excludeDexes: q.get('excludeDexes')!.split(',') } : {}),
  });
  return Response.json(r);
}

async function world(c: { routes: Routes; side: Side; belowBps: bigint; narrow: boolean }) {
  const wallet = await generateKeyPairSigner();
  const accounts = new Map<string, Account>([
    [USDC, mint(6)], [WSOL_MINT, mint(9)], [BONK, mint(5)],
    [DEX, { owner: address('BPFLoaderUpgradeab1e11111111111111111111111'), data: new Uint8Array(36) }],
    [POOL, { owner: DEX, data: new Uint8Array(300) }],
    [await ataOf(TREASURY, USDC), tokenAccount(TREASURY, USDC)],
    ...await fundedAccounts(wallet.address, USDC),
    // The treasury's wallet exists: a sale into SOL pays its fee in SOL, out of the output.
    ...(c.side === 'output' ? [[TREASURY, { owner: SYSTEM_PROGRAM, data: new Uint8Array(0) }] as [string, Account]] : []),
  ]);
  const sent: string[] = [];
  const rpc = fakeRpc(accounts, { sent });
  // Orientim's own key: every ask counted; the protected ones carry the exclusion.
  const orientimAsked: BuildParams[] = [];
  const deps: AgentDeps = {
    rpc, jupiter: fakeJupiter({ asked: orientimAsked }), secrets: [new Uint8Array(32).fill(3)],
    keys: new Map([[createHash('sha256').update(KEY).digest('hex'), 'fuzz-routes']]),
    feeBps: FEE_BPS, treasury: TREASURY, excludeDexes: ['HumidiFi'], maxNetworkFeeLamports: 200_000n,
    disabled: false, v1: false, perMinute: 1_000_000, ownRoutes: c.routes === 'own',
  };
  // The agent's Jupiter: honest for its own price (the wallet as taker); for the one-time key's routes,
  // `belowBps` below the market, and too wide for the transaction above 48 accounts when `narrow`.
  const extra = c.narrow ? await Promise.all(Array.from({ length: 60 }, async () => (await generateKeyPairSigner()).address)) : [];
  const honest = fakeJupiter();
  const low = fakeJupiter({ out: OUT - (OUT * c.belowBps) / 10_000n });
  const lowWide = fakeJupiter({ out: OUT - (OUT * c.belowBps) / 10_000n, extraAccounts: extra });
  const routesFetched: string[] = [];
  const prepared: Record<string, unknown>[] = [];
  let rounds = 0;
  const fetchImpl = (async (url: string, init: RequestInit) => {
    if (url.includes('jup.ag/')) {
      const q = new URL(url).searchParams;
      if (q.get('taker') === wallet.address) return answer(url, honest);
      routesFetched.push(url);
      return answer(url, c.narrow && Number(q.get('maxAccounts')) > 48 ? lowWide : low);
    }
    if (url.endsWith('/api/v1/finalize')) return agentFinalize(new Request(url, init), deps);
    rounds++;
    const res = await agentPrepare(new Request(url, init), deps);
    if (res.ok) prepared.push(await res.clone().json() as Record<string, unknown>);
    return res;
  }) as unknown as typeof fetch;
  // The agent's own RPC reads the same chain, but what it sends is kept apart from Orientim's.
  const agentSent: string[] = [];
  const agentRpc = {
    ...rpc,
    getBlockHeight: () => ({ send: async () => 850n }),
    getSignatureStatuses: () => ({ send: async () => ({ value: [{ confirmationStatus: 'confirmed', err: null }] }) }),
    sendTransaction: (wire: string) => ({ send: async () => { agentSent.push(wire); return 'sig'; } }),
  } as unknown as Rpc<SolanaRpcApi>;
  return { wallet, sent, agentSent, fetchImpl, agentRpc, orientimAsked, routesFetched, prepared, rounds: () => rounds };
}

describe('the current system, fuzzed end to end: own routes, fee sides, fall back, who sends', () => {
  it('an honest swap confirms with the fee its side says, never below Orientim\'s price, sent by whoever was named', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom('agent', 'bot'),
        fc.oneof({ weight: 3, arbitrary: fc.constant<Routes>('own') }, { weight: 1, arbitrary: fc.constantFrom<Routes>('orientim', 'own-off') }),
        fc.constantFrom<Side>('output', 'input'),
        fc.oneof(
          { weight: 2, arbitrary: fc.constant(0n) },
          { weight: 2, arbitrary: fc.bigInt({ min: 1n, max: 100n }) },
          { weight: 1, arbitrary: fc.bigInt({ min: 101n, max: 9_900n }) },
        ),
        fc.boolean(),
        fc.constantFrom('own', 'orientim'),
        fc.option(fc.integer({ min: 10, max: 300 }), { nil: undefined }),
        fc.integer({ min: 1, max: 1_000 }),
        async (channel, routes, side, belowBps, narrow, sender, slippageBps, dollars) => {
          const w = await world({ routes, side, belowBps, narrow });
          const amountIn = String(BigInt(dollars) * 1_000_000n);
          const intent: Omit<Intent, 'owner'> = {
            inputMint: USDC, outputMint: WSOL_MINT, amountIn, treasury: TREASURY,
            ...(slippageBps !== undefined ? { slippageBps } : {}),
          };
          const jupiterApiKey = routes === 'orientim' ? undefined : 'agent-key';
          const ownSent: string[] = [];
          const sendTransaction = sender === 'own' ? async (wire: string) => { ownSent.push(wire); } : undefined;
          let outcome: string;
          if (channel === 'agent') {
            outcome = await protectedSwap({
              apiUrl: 'http://orientim.test', apiKey: KEY, rpc: w.agentRpc, wallet: w.wallet, fetchImpl: w.fetchImpl, pollMs: 1, intent,
              ...(jupiterApiKey ? { jupiterApiKey } : {}), ...(sendTransaction ? { sendTransaction } : {}),
            }).then(r => r.outcome, e => `threw: ${(e as Error).message}`);
          } else {
            const deps = {
              rpc: w.agentRpc, apiUrl: 'http://orientim.test', apiKey: KEY, fetchImpl: w.fetchImpl, pollMs: 1, maxWaitMs: 60,
              stateDir: mkdtempSync(join(tmpdir(), 'orientim-fuzz-routes-')), treasury: TREASURY,
              ...(jupiterApiKey ? { jupiterApiKey } : {}), ...(sendTransaction ? { sendTransaction } : {}),
            };
            const ready = await runCli('prepare', { intent: { owner: w.wallet.address, ...intent, id: 'fuzz-order' } }, deps);
            const out = JSON.parse(JSON.stringify(ready.output)) as { checked?: unknown; message?: string; error?: { code?: string } };
            if (ready.code !== 0 || !out.message) {
              outcome = `prepare exit ${ready.code}: ${out.error?.code ?? ''}`;
            } else {
              const signature = getBase58Decoder().decode(await signBytes(w.wallet.keyPair.privateKey, Buffer.from(out.message, 'base64')));
              const done = await runCli('finalize', { checked: out.checked, signature }, deps);
              outcome = String(done.output.outcome ?? `finalize exit ${done.code}`);
            }
          }
          const label = JSON.stringify({ channel, routes, side, belowBps: String(belowBps), narrow, sender, slippageBps, dollars, outcome });

          // 1. An honest swap confirms, whoever's routes. Routes of the agent's from 0.5% to 1% below the
          // market are its to use, and cost more than the open market: put to the user (costs-more),
          // nothing sent. Further below, Orientim builds with its own key.
          const askUser = routes === 'own' && side === 'output' && belowBps > 50n && belowBps <= 100n;
          if (askUser) {
            expect(outcome, label).toMatch(/costs-more/);
            expect(w.sent, label).toEqual([]);
            expect(ownSent, label).toEqual([]);
            return;
          }
          // On the input side the fee does not follow the route, and Orientim does not replace the agent's
          // routes: ones more than 1% below the agent's own price may miss its minimum, refused as a
          // price move, nothing sent.
          if (routes === 'own' && side === 'input' && belowBps > 100n && outcome !== 'confirmed') {
            expect(outcome, label).toMatch(/price-moved/);
            expect(w.sent, label).toEqual([]);
            expect(ownSent, label).toEqual([]);
            return;
          }
          expect(outcome, label).toBe('confirmed');
          const p = w.prepared.at(-1) as { amounts: { fee: string; minOut: string; feeMint: string } };

          // 2. The fee by its side.
          const fee = BigInt(p.amounts.fee);
          const tolerance = BigInt(slippageBps ?? 50);
          if (side === 'input') {
            expect(fee, label).toBe((BigInt(amountIn) * FEE_BPS) / 10_000n);
          } else {
            expect(p.amounts.feeMint, label).toBe(WSOL_MINT);
            const enforced = BigInt(p.amounts.minOut) + fee;
            expect(fee, label).toBe((enforced * FEE_BPS) / 10_000n);
            // Never more than 1% below Orientim's own price less the tolerance.
            const orientimMinimum = (OUT * (10_000n - tolerance)) / 10_000n;
            expect(enforced * 10_000n, label).toBeGreaterThanOrEqual(orientimMinimum * 9_900n);
          }

          // 3. Whose key built the protected routes.
          const orientimBuilt = w.orientimAsked.some(a => a.excludeDexes?.length);
          if (routes !== 'own') expect(orientimBuilt, label).toBe(true);
          else if (side === 'input' || belowBps <= 100n) expect(orientimBuilt, label).toBe(false);
          if (routes !== 'own') expect(w.routesFetched, label).toEqual([]);

          // 4. Who sent it: one transaction, by whoever was named.
          if (sender === 'own') {
            expect(w.sent, label).toEqual([]);
            expect(ownSent.length, label).toBeGreaterThanOrEqual(1);
            expect(new Set(ownSent).size, label).toBe(1);
          } else {
            expect(new Set(w.sent).size, label).toBe(1);
          }

          // 5. Bounded: rounds of prepare and routes fetched.
          expect(w.rounds(), label).toBeLessThanOrEqual(11);
          expect(w.routesFetched.length, label).toBeLessThanOrEqual(24);
        },
      ),
      PARAMS,
    );
  }, TIMEOUT);
});
