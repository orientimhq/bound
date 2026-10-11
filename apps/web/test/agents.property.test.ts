/**
 * Agents and bots, fuzzed end to end: the skill's `protectedSwap` (agents) and `orientim-verify`
 * (bots in any language) against Orientim's real API handlers and a fake chain. The cases vary:
 * - the tolerance the agent chooses (none, any valid one, or one that is not valid);
 * - the price impact of its own quote, and its limit;
 * - whether the server answers honestly or lies in one of five ways;
 * - whose routes: the agent's own Jupiter key (rounds of routes-needed), or Orientim's.
 *
 * The outcome must follow from those alone:
 * - honest, valid, within the limit: confirmed, sent once, the route at exactly the tolerance in force;
 * - anything else: refused before the wallet signs, and nothing sent.
 *
 * `npm run test:fuzz` runs 20,000 cases; ORIENTIM_FUZZ_RUNS and ORIENTIM_FUZZ_SEED set a shard.
 */
import { createHash } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import {
  address, generateKeyPairSigner, getBase58Decoder, getCompiledTransactionMessageDecoder, getTransactionDecoder, signBytes,
} from '@solana/kit';
import type { Rpc, SolanaRpcApi } from '@solana/kit';
import { ataOf, JUPITER_PROGRAM, WSOL_MINT } from '@orientim/core';
import { jupiterRouteArgs } from '@orientim/verifier';
import { BONK, DEX, fakeJupiter, fakeRpc, fundedAccounts, mint, POOL, tokenAccount, USDC } from '../../../packages/jupiter/test/fakes.ts';
import type { Account } from '../../../packages/jupiter/test/fakes.ts';
import { agentFinalize, agentPrepare } from '../lib/server/agent/api.ts';
import type { AgentDeps } from '../lib/server/agent/api.ts';
import { protectedSwap } from '../../../skills/orientim-protected-swap/examples/swap.ts';
import type { Intent } from '../../../skills/orientim-protected-swap/examples/swap.ts';
import { runCli } from '../../../skills/orientim-protected-swap/src/cli.ts';

const MODE = (import.meta as { env?: { MODE?: string } }).env?.MODE;
const RUNS = Number(process.env.ORIENTIM_FUZZ_RUNS ?? (MODE === 'fuzz' ? 20_000 : 40));
const SEED = process.env.ORIENTIM_FUZZ_SEED ? Number(process.env.ORIENTIM_FUZZ_SEED) : undefined;
const PARAMS = { numRuns: RUNS, ...(SEED !== undefined ? { seed: SEED } : {}) };
const TIMEOUT = 60_000 + RUNS * 600;

const KEY = 'ori_fuzz_agent_key_0000000000001';
const TREASURY = address('9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM');
type Lie = 'none' | 'widen' | 'fee-claim' | 'treasury' | 'minimum' | 'malformed';

/** Orientim, the chain and Jupiter; `lie` is what a compromised server or relay does to the answer. */
async function world(lie: Lie, widenTo: number, impact: number, ownRoutes: boolean) {
  const wallet = await generateKeyPairSigner();
  const accounts = new Map<string, Account>([
    [USDC, mint(6)], [WSOL_MINT, mint(9)], [BONK, mint(5)],
    [DEX, { owner: address('BPFLoaderUpgradeab1e11111111111111111111111'), data: new Uint8Array(36) }],
    [POOL, { owner: DEX, data: new Uint8Array(300) }],
    [await ataOf(TREASURY, USDC), tokenAccount(TREASURY, USDC)],
    ...await fundedAccounts(wallet.address, USDC),
  ]);
  const sent: string[] = [];
  const rpc = fakeRpc(accounts, { sent });
  const deps: AgentDeps = {
    rpc, jupiter: fakeJupiter(), secrets: [new Uint8Array(32).fill(3)],
    keys: new Map([[createHash('sha256').update(KEY).digest('hex'), 'fuzz']]),
    feeBps: 25n, treasury: TREASURY, excludeDexes: [], maxNetworkFeeLamports: 200_000n, disabled: false, v1: false, perMinute: 1_000_000,
    ownRoutes,
  };
  const fetchImpl = (async (url: string, init: RequestInit) => {
    if (url.startsWith('https://api.jup.ag/')) {
      // Jupiter as the agent asks it, for its own price and for routes, with the price impact this case gives it.
      const q = new URL(url).searchParams;
      const r = await fakeJupiter().build({
        inputMint: address(q.get('inputMint')!), outputMint: address(q.get('outputMint')!), amount: BigInt(q.get('amount')!),
        taker: address(q.get('taker')!), slippageBps: Number(q.get('slippageBps')), maxAccounts: Number(q.get('maxAccounts')),
      });
      return Response.json({ ...r, priceImpactPct: impact });
    }
    if (url.endsWith('/api/v1/finalize')) return agentFinalize(new Request(url, init), deps);
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    const res = await agentPrepare(new Request(url, { ...init, body: JSON.stringify(lie === 'widen' ? { ...body, slippageBps: widenTo } : body) }), deps);
    if (!res.ok || lie === 'none' || lie === 'widen') return res;
    const p = await res.json() as { amounts: Record<string, string>; policy: Record<string, unknown>; certificate: Record<string, unknown> };
    const told = {
      'fee-claim': { ...p, amounts: { ...p.amounts, fee: String(BigInt(p.amounts.fee) + 1n) } },
      treasury: { ...p, policy: { ...p.policy, treasury: (await generateKeyPairSigner()).address } },
      minimum: { ...p, amounts: { ...p.amounts, minOut: String(BigInt(p.amounts.minOut) / 2n) } },
      malformed: { ...p, amounts: { ...p.amounts, quotedOut: 'not-a-number' } },
    }[lie];
    return Response.json(told);
  }) as unknown as typeof fetch;
  // It keeps up with the RPC the blockhash came from (valid to block 1000, so handed out at 850).
  const agentRpc = {
    ...rpc,
    getBlockHeight: () => ({ send: async () => 850n }),
    getSignatureStatuses: () => ({ send: async () => ({ value: [{ confirmationStatus: 'confirmed', err: null }] }) }),
  } as unknown as Rpc<SolanaRpcApi>;
  return { wallet, sent, fetchImpl, agentRpc };
}

const routeTolerance = (wire: string) => {
  const compiled = getCompiledTransactionMessageDecoder().decode(getTransactionDecoder().decode(Buffer.from(wire, 'base64')).messageBytes) as unknown as {
    staticAccounts: string[]; instructions: { programAddressIndex: number; data?: Uint8Array }[];
  };
  const ix = compiled.instructions.find(i => compiled.staticAccounts[i.programAddressIndex] === JUPITER_PROGRAM);
  return jupiterRouteArgs(ix!.data!)!.slippageBps;
};

describe('agents and bots, fuzzed end to end', () => {
  it('swap exactly when the answer is honest, the tolerance valid and the impact within the limit; else send nothing', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom('agent', 'bot'),
        fc.oneof({ weight: 3, arbitrary: fc.option(fc.integer({ min: 10, max: 1_500 }), { nil: undefined }) }, { weight: 1, arbitrary: fc.constantFrom(0, 5, 1_501, 2.5) }),
        fc.oneof({ weight: 4, arbitrary: fc.constant<Lie>('none') }, { weight: 1, arbitrary: fc.constantFrom<Lie>('widen', 'fee-claim', 'treasury', 'minimum', 'malformed') }),
        fc.integer({ min: 1, max: 700 }),
        fc.oneof(fc.constant(0), fc.double({ min: 0, max: 0.2, noNaN: true })),
        fc.option(fc.integer({ min: 100, max: 2_000 }), { nil: undefined }),
        fc.boolean(),
        async (channel, slippageBps, lie, widenBy, impact, maxPriceImpactBps, ownRoutes) => {
          const validTolerance = slippageBps === undefined || (Number.isInteger(slippageBps) && slippageBps >= 10 && slippageBps <= 1_500);
          const tolerance = validTolerance ? (slippageBps ?? 50) : 50;
          // A server that widens the route beyond the tolerance: a lie only when there is room above it.
          const widenTo = Math.min(tolerance + widenBy, 1_500);
          const lies = lie !== 'none' && !(lie === 'widen' && widenTo <= tolerance);
          const impactBps = impact > 0 ? Math.round(impact * 10_000) : 0;
          const tooThin = impactBps > (maxPriceImpactBps ?? 500);
          const w = await world(lie, widenTo, impact, ownRoutes);
          const jupiter = ownRoutes ? { jupiterApiKey: 'agent-key' } : {};
          const intent: Omit<Intent, 'owner'> = {
            inputMint: USDC, outputMint: WSOL_MINT, amountIn: '1000000', treasury: TREASURY,
            ...(slippageBps !== undefined ? { slippageBps } : {}), ...(maxPriceImpactBps !== undefined ? { maxPriceImpactBps } : {}),
          };
          let swapped: boolean;
          if (channel === 'agent') {
            swapped = await protectedSwap({
              apiUrl: 'http://orientim.test', apiKey: KEY, rpc: w.agentRpc, wallet: w.wallet, fetchImpl: w.fetchImpl, pollMs: 1, intent, ...jupiter,
            }).then(r => r.outcome === 'confirmed', () => false);
          } else {
            const deps = {
              rpc: w.agentRpc, apiUrl: 'http://orientim.test', apiKey: KEY, fetchImpl: w.fetchImpl, pollMs: 1, maxWaitMs: 60,
              stateDir: mkdtempSync(join(tmpdir(), 'orientim-fuzz-')), treasury: TREASURY, ...jupiter,
            };
            const ready = await runCli('prepare', { intent: { owner: w.wallet.address, ...intent, id: 'fuzz-order' } }, deps);
            const out = JSON.parse(JSON.stringify(ready.output)) as { checked?: unknown; message?: string };
            if (ready.code !== 0 || !out.message) {
              swapped = false;
            } else {
              const signature = getBase58Decoder().decode(await signBytes(w.wallet.keyPair.privateKey, Buffer.from(out.message, 'base64')));
              const done = await runCli('finalize', { checked: out.checked, signature }, deps);
              swapped = done.code === 0 && done.output.outcome === 'confirmed';
            }
          }
          const expected = validTolerance && !tooThin && !lies;
          expect(swapped).toBe(expected);
          if (expected) {
            expect(new Set(w.sent).size).toBe(1);
            expect(routeTolerance(w.sent[0])).toBe(tolerance);
          } else {
            expect(w.sent).toEqual([]);
          }
        },
      ),
      PARAMS,
    );
  }, TIMEOUT);
});
