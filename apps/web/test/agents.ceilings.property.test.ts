/**
 * The owner's ceilings and the automatic tolerance, fuzzed end to end for agents (`protectedSwap`)
 * and bots (`orientim-verify`) against Orientim's real API handlers and a fake chain.
 *
 * 1. Any policy (maxSlippageBps, maxBelowBps, maxPriceImpactBps, each set or not), any intent
 *    (slippageBps unset, "auto" or a number; maxBelowBps; maxPriceImpactBps), any estimate Jupiter
 *    gives for "auto", any price impact, with the agent's own quote and Orientim's final route each on
 *    a Pump.fun curve or not, independently (an ordinary quote may still end in a curve route): the
 *    agent and the bot decide alike, a choice beyond a ceiling is refused with its code before anything is prepared, and a
 *    swap that goes out is built at a tolerance never above the owner's ceiling, at Jupiter's
 *    estimate held from 0.5% to 3% on "auto", with a floor never further below the market than the
 *    owner allows.
 * 2. A minimum of the agent's own further below the market than the owner's maxBelowBps is refused.
 * 3. The second proof of expiry, from the owner's archive: a swap the archive shows landed, or whose
 *    one-time key lists it, or seen while it could still land, or behind a list that may be cut, is
 *    never called expired; expired only when every part of the proof holds.
 * 4. The pure parts: Jupiter's estimate always within 0.5% to 3% and never smaller for a lower
 *    threshold; the policy file takes each ceiling exactly when it is a whole number in range; a dry
 *    run's approval is found for the same amount however it is written, and for no other.
 *
 * `npm run test:fuzz` runs 2,000 cases per end-to-end property and 50,000 per pure one;
 * ORIENTIM_FUZZ_RUNS and ORIENTIM_FUZZ_SEED set a shard.
 */
import { createHash } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import {
  address, generateKeyPairSigner, getBase58Decoder, getCompiledTransactionMessageDecoder, getTransactionDecoder, signBytes,
} from '@solana/kit';
import type { KeyPairSigner, Rpc, SolanaRpcApi } from '@solana/kit';
import { ataOf, JUPITER_PROGRAM, WSOL_MINT } from '@orientimhq/swap/core';
import { jupiterFloor, jupiterRouteArgs } from '@orientimhq/swap/verifier';
import { BONK, DEX, fakeJupiter, fakeRpc, fundedAccounts, mint, POOL, tokenAccount, USDC } from '../../../packages/jupiter/test/fakes.ts';
import type { Account } from '../../../packages/jupiter/test/fakes.ts';
import { agentFinalize, agentPrepare } from '../lib/server/agent/api.ts';
import type { AgentDeps } from '../lib/server/agent/api.ts';
import {
  approvalFor, confirm, FloorError, loadPolicy, PolicyError, PriceImpactError, protectedSwap, recordApproval,
} from '@orientimhq/swap';
import type { Intent, OwnerPolicy } from '@orientimhq/swap';
import { runCli } from '@orientimhq/swap';
import { autoSlippageBps } from '@orientimhq/swap';

const MODE = (import.meta as { env?: { MODE?: string } }).env?.MODE;
const RUNS = Number(process.env.ORIENTIM_FUZZ_RUNS ?? (MODE === 'fuzz' ? 2_000 : 25));
const PURE_RUNS = Number(process.env.ORIENTIM_FUZZ_RUNS ?? (MODE === 'fuzz' ? 50_000 : 300));
const SEED = process.env.ORIENTIM_FUZZ_SEED ? Number(process.env.ORIENTIM_FUZZ_SEED) : undefined;
const PARAMS = { numRuns: RUNS, ...(SEED !== undefined ? { seed: SEED } : {}) };
const PURE = { numRuns: PURE_RUNS, ...(SEED !== undefined ? { seed: SEED } : {}) };
const TIMEOUT = 60_000 + RUNS * 3_000;

const KEY = 'ori_fuzz_ceiling_key_000000000001';
const TREASURY = address('9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM');

/**
 * What Jupiter tells the agent when it asks for its own price (`curve`: on a Pump.fun curve), its
 * estimate on "auto" and the price impact; `finalCurve`: whether the route Orientim builds trades on
 * the curve, which the agent's quote need not match. Orientim's server takes a route for a curve
 * only when it names the curve program and Jupiter labels it "Pump.fun", as Jupiter does.
 */
type Market = { out: bigint; curve: boolean; finalCurve?: boolean; estimateBps: number; impactBps: number };
const curveMarket = (out: bigint, curve: boolean) => fakeJupiter({ out, curveProgram: curve, ...(curve ? { label: 'Pump.fun' } : {}) });

/** Every other world has the agent bring its own routes (routes-needed rounds); the rest, Orientim's. */
let worlds = 0;

async function world(m: Market) {
  const own = worlds++ % 2 === 1;
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
  // Orientim's market and the one the agent asks itself: the same price, each curve or not.
  const jupiter = curveMarket(m.out, m.finalCurve ?? m.curve);
  const ownJupiter = curveMarket(m.out, m.curve);
  const deps: AgentDeps = {
    rpc, jupiter, secrets: [new Uint8Array(32).fill(5)],
    keys: new Map([[createHash('sha256').update(KEY).digest('hex'), 'fuzz']]),
    feeBps: 25n, treasury: TREASURY, excludeDexes: [], maxNetworkFeeLamports: 200_000n, disabled: false, v1: false, perMinute: 1_000_000,
    ownRoutes: own,
  };
  const asked: string[] = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    if (url.startsWith('https://api.jup.ag/')) {
      const q = new URL(url).searchParams;
      // A route for the one-time key, which the agent fetches with its own key: Orientim's final market.
      const forRoute = q.get('taker') !== wallet.address;
      if (!forRoute) asked.push(q.get('slippageBps')!);
      // On "auto" Jupiter answers with its estimate in the threshold (RTSE).
      const slippage = q.get('slippageBps') === 'rtse' ? m.estimateBps : Number(q.get('slippageBps'));
      const r = await (forRoute ? jupiter : ownJupiter).build({
        inputMint: address(q.get('inputMint')!), outputMint: address(q.get('outputMint')!), amount: BigInt(q.get('amount')!),
        taker: address(q.get('taker')!), slippageBps: slippage, maxAccounts: Number(q.get('maxAccounts')),
        // A route Orientim asks for names where it delivers, and the DEXes it leaves out.
        ...(q.get('destinationTokenAccount') ? { destinationTokenAccount: address(q.get('destinationTokenAccount')!) } : {}),
        ...(q.get('excludeDexes') ? { excludeDexes: q.get('excludeDexes')!.split(',') } : {}),
      });
      return Response.json({ ...r, priceImpactPct: m.impactBps / 10_000 });
    }
    if (url.endsWith('/api/v1/finalize')) return agentFinalize(new Request(url, init), deps);
    return agentPrepare(new Request(url, init), deps);
  }) as unknown as typeof fetch;
  const agentRpc = {
    ...rpc,
    getBlockHeight: () => ({ send: async () => 850n }),
    getSignatureStatuses: () => ({ send: async () => ({ value: [{ confirmationStatus: 'confirmed', err: null }] }) }),
  } as unknown as Rpc<SolanaRpcApi>;
  return { wallet, sent, fetchImpl, agentRpc, asked, jupiterApiKey: own ? 'agent-key' : undefined };
}
type World = Awaited<ReturnType<typeof world>>;

/** The tolerance and floor a sent transaction's route carries, read from its bytes. */
const routeOf = (wire: string) => {
  const compiled = getCompiledTransactionMessageDecoder().decode(getTransactionDecoder().decode(Buffer.from(wire, 'base64')).messageBytes) as unknown as {
    staticAccounts: string[]; instructions: { programAddressIndex: number; data?: Uint8Array }[];
  };
  const ix = compiled.instructions.find(i => compiled.staticAccounts[i.programAddressIndex] === JUPITER_PROGRAM);
  const args = jupiterRouteArgs(ix!.data!)!;
  return { slippageBps: args.slippageBps, floor: jupiterFloor(args) };
};

/** The check refused a route above the owner's slippage ceiling, on the signed bytes. */
const ABOVE_CEILING = /above the owner's limit of \d+ \(maxSlippageBps\)/;

/** What happened, in one word both channels share: sent, or the refusal's code. */
async function asAgent(w: World, intent: Omit<Intent, 'owner'>, policy: OwnerPolicy): Promise<string> {
  try {
    const r = await protectedSwap({
      apiUrl: 'http://orientim.test', apiKey: KEY, rpc: w.agentRpc, wallet: w.wallet as KeyPairSigner, fetchImpl: w.fetchImpl, pollMs: 1, intent, policy,
      ...(w.jupiterApiKey ? { jupiterApiKey: w.jupiterApiKey } : {}),
    });
    return r.outcome === 'confirmed' ? 'sent' : r.outcome;
  } catch (e) {
    if (e instanceof PolicyError) return e.code;
    if (e instanceof PriceImpactError) return 'price-impact-high';
    if (e instanceof FloorError) return 'floor-too-low';
    if (ABOVE_CEILING.test((e as Error).message)) return 'route-above-ceiling';
    return `error: ${(e as Error).message}`;
  }
}

async function asBot(w: World, intent: Omit<Intent, 'owner'>, policy: OwnerPolicy): Promise<string> {
  const deps = {
    rpc: w.agentRpc, apiUrl: 'http://orientim.test', apiKey: KEY, fetchImpl: w.fetchImpl, pollMs: 1, maxWaitMs: 60,
    stateDir: mkdtempSync(join(tmpdir(), 'orientim-ceil-')), treasury: TREASURY, policy,
    ...(w.jupiterApiKey ? { jupiterApiKey: w.jupiterApiKey } : {}),
  };
  const ready = await runCli('prepare', { intent: { owner: w.wallet.address, id: 'order-1', ...intent } }, deps);
  const out = JSON.parse(JSON.stringify(ready.output)) as { checked?: unknown; message?: string; error?: { code?: string } | string; problems?: string[] };
  if (ready.code === 1 && out.problems?.some(x => ABOVE_CEILING.test(x))) return 'route-above-ceiling';
  if (ready.code !== 0 || !out.message) return typeof out.error === 'object' && out.error?.code ? out.error.code : `error: ${JSON.stringify(out.error)}`;
  const signature = getBase58Decoder().decode(await signBytes(w.wallet.keyPair.privateKey, Buffer.from(out.message, 'base64')));
  const done = await runCli('finalize', { checked: out.checked, signature }, deps);
  return done.code === 0 && done.output.outcome === 'confirmed' ? 'sent' : `error: finalize ${done.code}`;
}

const ceiling = (least: number, most: number) => fc.option(fc.integer({ min: least, max: most }), { nil: undefined });

describe("the owner's ceilings and the automatic tolerance, for agents and bots", () => {
  it('decide alike; a choice beyond a ceiling is refused with its code; a swap sent stays within every ceiling', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.record({ maxSlippageBps: ceiling(10, 1_500), maxBelowBps: ceiling(0, 2_000), maxPriceImpactBps: ceiling(0, 2_000) }),
        fc.record({
          slippageBps: fc.oneof(fc.constant(undefined), fc.constant('auto' as const), fc.integer({ min: 10, max: 1_500 })),
          maxBelowBps: fc.option(fc.integer({ min: 0, max: 2_000 }), { nil: undefined }),
          maxPriceImpactBps: fc.option(fc.integer({ min: 0, max: 2_000 }), { nil: undefined }),
        }),
        fc.record({
          out: fc.bigInt({ min: 10_000_000n, max: 10n ** 13n }), curve: fc.boolean(), finalCurve: fc.boolean(),
          estimateBps: fc.integer({ min: 0, max: 1_500 }), impactBps: fc.integer({ min: 0, max: 2_500 }),
        }),
        async (ceilings, asked, market) => {
          const policy: OwnerPolicy = {
            maxAmountIn: { [USDC]: '1000000000' },
            ...Object.fromEntries(Object.entries(ceilings).filter(([, v]) => v !== undefined)),
          };
          const intent: Omit<Intent, 'owner'> = {
            inputMint: USDC, outputMint: WSOL_MINT, amountIn: '1000000', treasury: TREASURY,
            ...Object.fromEntries(Object.entries(asked).filter(([, v]) => v !== undefined)),
          };
          const a = await world(market);
          const agent = await asAgent(a, intent, policy);
          const b = await world(market);
          const bot = await asBot(b, intent, policy);
          expect(bot, `agent: ${agent}`).toBe(agent);

          // What must be refused, in the order the skill checks it, before anything is prepared.
          const chosen = typeof asked.slippageBps === 'number' ? asked.slippageBps : undefined;
          const impactLimit = asked.maxPriceImpactBps ?? Math.min(500, ceilings.maxPriceImpactBps ?? 500);
          const expected =
            chosen !== undefined && ceilings.maxSlippageBps !== undefined && chosen > ceilings.maxSlippageBps ? 'slippage-over-limit'
              : asked.maxBelowBps !== undefined && ceilings.maxBelowBps !== undefined && asked.maxBelowBps > ceilings.maxBelowBps ? 'floor-over-limit'
                : ceilings.maxPriceImpactBps !== undefined && impactLimit > ceilings.maxPriceImpactBps ? 'impact-over-limit'
                  : market.impactBps > impactLimit ? 'price-impact-high'
                    : null;
          if (expected) {
            expect(agent).toBe(expected);
            expect(a.sent).toEqual([]);
            expect(b.sent).toEqual([]);
            return;
          }
          // The one other refusal: the agent's own quote was an ordinary route, left the tolerance to
          // Orientim's default, and the route built trades on a curve (3% by default) above the owner's
          // ceiling. It is refused on the signed bytes, before the wallet signs.
          if (agent === 'route-above-ceiling') {
            expect(ceilings.maxSlippageBps).toBeDefined();
            expect(market.finalCurve && !market.curve && asked.slippageBps === undefined).toBe(true);
            expect(a.sent).toEqual([]);
            expect(b.sent).toEqual([]);
            return;
          }
          expect(agent).toBe('sent');
          for (const w of [a, b]) {
            expect(w.sent).toHaveLength(1);
            const route = routeOf(w.sent[0]);
            // Never above the owner's ceiling, whatever the default or the estimate.
            if (ceilings.maxSlippageBps !== undefined) expect(route.slippageBps).toBeLessThanOrEqual(ceilings.maxSlippageBps);
            // "auto": Jupiter's estimate held from 0.5% to 3% (3% on a curve), then to the ceiling. The
            // route is built at it and never looser; a floor of the agent's own above it tightens it.
            if (asked.slippageBps === 'auto') {
              expect(w.asked[0]).toBe('rtse');
              const estimate = market.curve ? 300 : Math.min(300, Math.max(50, market.estimateBps));
              expect(route.slippageBps).toBeLessThanOrEqual(Math.min(estimate, ceilings.maxSlippageBps ?? 1_500));
            }
            if (chosen !== undefined) expect(route.slippageBps).toBeLessThanOrEqual(chosen);
            // The floor is never further below the market than the owner allows (the market gives
            // `out` for the amount routed, after Orientim's fee).
            const most = ceilings.maxBelowBps ?? 2_000;
            expect(route.floor * 10_000n >= market.out * BigInt(10_000 - most) - 10_000n).toBe(true);
          }
        },
      ),
      PARAMS,
    );
  }, TIMEOUT);

  it("refuses a minimum of the agent's own further below the market than the owner allows", async () => {
    await fc.assert(
      fc.asyncProperty(fc.boolean(), fc.integer({ min: 0, max: 2_000 }), fc.integer({ min: 0, max: 2_500 }), async (bot, ownerBelow, belowBps) => {
        const market: Market = { out: 1_000_000_000n, curve: false, estimateBps: 50, impactBps: 0 };
        const w = await world(market);
        const minOut = (market.out * BigInt(10_000 - belowBps)) / 10_000n;
        const intent = { inputMint: USDC, outputMint: WSOL_MINT, amountIn: '1000000', treasury: TREASURY, minOut: minOut.toString() };
        const policy: OwnerPolicy = { maxAmountIn: { [USDC]: '1000000000' }, maxBelowBps: ownerBelow };
        const result = bot ? await asBot(w, intent, policy) : await asAgent(w, intent, policy);
        const lowest = (market.out * BigInt(10_000 - ownerBelow)) / 10_000n;
        if (minOut < lowest) {
          expect(result).toBe(ownerBelow < 2_000 ? 'floor-over-limit' : 'floor-too-low');
          expect(w.sent).toEqual([]);
        } else if (result === 'sent') {
          expect(routeOf(w.sent[0]).floor >= minOut).toBe(true);
        }
      }),
      PARAMS,
    );
  }, TIMEOUT);

  it("the archive's proof: never expired for a swap that landed or could still land; expired only when every part holds", async () => {
    const E = 'E1111111111111111111111111111111111111111';
    const down = () => {
      const fail = () => ({ send: async () => { throw new Error('rpc down'); } });
      return { getSignatureStatuses: fail, getBlockHeight: fail, getEpochInfo: fail, sendTransaction: fail } as unknown as Rpc<SolanaRpcApi>;
    };
    await fc.assert(
      fc.asyncProperty(
        fc.record({
          heightAhead: fc.integer({ min: -50, max: 50 }),
          status: fc.constantFrom(null, 'processed', 'confirmed', 'finalized'),
          statusErr: fc.boolean(),
          listed: fc.boolean(),
          others: fc.integer({ min: 0, max: 1_000 }),
          flaky: fc.boolean(),
        }),
        async (a) => {
          const lastValid = 1_075n;
          let calls = 0;
          const flake = () => { if (a.flaky && ++calls % 3 === 0) throw new Error('archive busy'); };
          const listed = [...Array.from({ length: a.others }, (_, i) => `other-${i}`), ...(a.listed ? ['sig-1'] : [])];
          const archive = {
            getSignatureStatuses: () => ({ send: async () => { flake(); return { context: { slot: 9_000n }, value: [a.status ? { confirmationStatus: a.status, err: a.statusErr ? { InstructionError: [3, { Custom: 1 }] } : null } : null] }; } }),
            getEpochInfo: () => ({ send: async () => { flake(); return { absoluteSlot: 9_000n, blockHeight: lastValid + BigInt(a.heightAhead), epoch: 1n }; } }),
            getSignaturesForAddress: () => ({ send: async () => { flake(); return listed.slice(0, 1_000).map(signature => ({ signature })); } }),
          } as unknown as Rpc<SolanaRpcApi>;
          const outcome = await confirm(down(), 'sig-1', lastValid, { pollMs: 1, maxWaitMs: 150, earliestHeight: 900n, archive, temporaryAuthority: E });
          const settled = a.status === 'confirmed' || a.status === 'finalized';
          if (settled) expect(['confirmed', 'failed', 'unknown']).toContain(outcome);
          if (settled && outcome !== 'unknown') expect(outcome).toBe(a.statusErr ? 'failed' : 'confirmed');
          if (outcome === 'expired') {
            expect(a.status).toBeNull();
            expect(a.heightAhead).toBeGreaterThan(0);
            expect(a.listed).toBe(false);
            expect(listed.length).toBeLessThan(1_000);
          }
          if (a.listed || a.heightAhead <= 0 || a.status !== null || listed.length >= 1_000) expect(outcome).not.toBe('expired');
        },
      ),
      { ...PARAMS, numRuns: Math.max(RUNS, Math.min(PURE_RUNS, 5_000)) },
    );
  }, TIMEOUT + 600_000);

  it("Jupiter's estimate is always 0.5% to 3%, never smaller for a lower threshold", () => {
    fc.assert(
      fc.property(fc.bigInt({ min: 1n, max: 10n ** 19n }), fc.bigInt({ min: 0n, max: 10n ** 19n }), fc.bigInt({ min: 0n, max: 10n ** 19n }), (out, t1, t2) => {
        const [high, low] = t1 >= t2 ? [t1, t2] : [t2, t1];
        const a = autoSlippageBps({ outAmount: out.toString(), otherAmountThreshold: high.toString() });
        const b = autoSlippageBps({ outAmount: out.toString(), otherAmountThreshold: low.toString() });
        for (const v of [a, b]) expect(v >= 50 && v <= 300 && Number.isInteger(v)).toBe(true);
        // A lower threshold means more room asked for, unless it is no threshold at all (0).
        if (low > 0n && high < out) expect(b).toBeGreaterThanOrEqual(a);
      }),
      PURE,
    );
  });

  it('the policy file takes each ceiling exactly when it is a whole number in range', () => {
    const dir = mkdtempSync(join(tmpdir(), 'orientim-ceil-policy-'));
    const file = join(dir, 'policy.json');
    const value = fc.oneof(fc.integer({ min: -100, max: 2_600 }), fc.double({ min: -10, max: 3_000, noNaN: true }), fc.string({ maxLength: 4 }), fc.constant(null), fc.boolean());
    fc.assert(
      fc.property(fc.constantFrom(['maxSlippageBps', 10, 1_500], ['maxBelowBps', 0, 2_000], ['maxPriceImpactBps', 0, 2_000]), value, ([name, least, most], v) => {
        writeFileSync(file, JSON.stringify({ maxAmountIn: { [USDC]: '1' }, [name as string]: v }));
        const ok = typeof v === 'number' && Number.isInteger(v) && v >= (least as number) && v <= (most as number);
        // As the file holds it: JSON writes -0 as 0.
        if (ok) expect((loadPolicy(file) as Record<string, unknown>)[name as string]).toBe(JSON.parse(JSON.stringify(v)));
        else expect(() => loadPolicy(file)).toThrow(name as string);
      }),
      { ...PURE, numRuns: Math.min(PURE_RUNS, 5_000) },
    );
  });

  it("a dry run's approval is found for the same amount however it is written, and for no other", () => {
    const dir = mkdtempSync(join(tmpdir(), 'orientim-ceil-appr-'));
    fc.assert(
      fc.property(fc.bigInt({ min: 0n, max: 10n ** 18n }), fc.integer({ min: 0, max: 3 }), fc.bigInt({ min: -5n, max: 5n }), (amount, zeros, delta) => {
        const key = { owner: 'W', inputMint: USDC, outputMint: WSOL_MINT, amountIn: amount.toString() };
        recordApproval(dir, { ...key, minOut: '7', expiresAt: Date.now() + 60_000 });
        expect(approvalFor(dir, { ...key, amountIn: '0'.repeat(zeros) + amount.toString() })?.minOut).toBe('7');
        const other = amount + delta;
        if (delta !== 0n && other >= 0n) {
          const found = approvalFor(dir, { ...key, amountIn: other.toString() });
          // Another amount finds only its own approval, if one was kept for it earlier.
          if (found) expect(BigInt(found.amountIn)).toBe(other);
        }
      }),
      { ...PURE, numRuns: Math.min(PURE_RUNS, 5_000) },
    );
  });
});
