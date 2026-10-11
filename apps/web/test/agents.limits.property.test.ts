/**
 * Agents and bots at the limits, fuzzed end to end: the skill's `protectedSwap` (agents) and
 * `orientim-verify` (bots) against Orientim's real API handlers and a fake chain.
 *
 * 1. Any price and amount, the same case through both: the agent and the bot decide alike, and a
 *    swap that goes out enforces at least the floor asked of Jupiter.
 * 2. The agent's own floor: one more than 20% below Jupiter's price is refused before anything is
 *    prepared; any other is never enforced below what was asked.
 * 3. The owner's limits (ORIENTIM_POLICY): a mint not listed, one swap above its limit, or the last
 *    24 hours above the daily limit, including earlier swaps already on record; through either
 *    channel, over several swaps. Bots prepare several swaps before finalizing any, so the daily
 *    limit must hold at finalize as well as at prepare.
 *    Every swap of the wallet counts against a daily limit, those made before the owner set any
 *    policy included, at millions of USDC a swap.
 * 4. A bot that edits prepare's answer before finalize (a smaller amount, another token, the figures
 *    changed to match) sends nothing, whatever it changed.
 *
 * `npm run test:fuzz` runs 5,000 cases per property; ORIENTIM_FUZZ_RUNS and ORIENTIM_FUZZ_SEED set a shard.
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
import type { KeyPairSigner, Rpc, SolanaRpcApi } from '@solana/kit';
import { ataOf, JUPITER_PROGRAM, WSOL_MINT } from '@orientim/core';
import { jupiterFloor, jupiterRouteArgs } from '@orientim/verifier';
import { BONK, DEX, fakeJupiter, fakeRpc, fundedAccounts, mint, POOL, tokenAccount, USDC } from '../../../packages/jupiter/test/fakes.ts';
import type { Account } from '../../../packages/jupiter/test/fakes.ts';
import { agentFinalize, agentPrepare } from '../lib/server/agent/api.ts';
import type { AgentDeps } from '../lib/server/agent/api.ts';
import { createFileStore, FloorError, PolicyError, protectedSwap } from '../../../skills/orientim-protected-swap/examples/swap.ts';
import type { Intent, OwnerPolicy } from '../../../skills/orientim-protected-swap/examples/swap.ts';
import { runCli } from '../../../skills/orientim-protected-swap/src/cli.ts';

const MODE = (import.meta as { env?: { MODE?: string } }).env?.MODE;
const RUNS = Number(process.env.ORIENTIM_FUZZ_RUNS ?? (MODE === 'fuzz' ? 5_000 : 25));
const SEED = process.env.ORIENTIM_FUZZ_SEED ? Number(process.env.ORIENTIM_FUZZ_SEED) : undefined;
const PARAMS = { numRuns: RUNS, ...(SEED !== undefined ? { seed: SEED } : {}) };
const TIMEOUT = 60_000 + RUNS * 3_000;

const KEY = 'ori_fuzz_agent_key_0000000000001';
const TREASURY = address('9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM');
const DAY_MS = 24 * 60 * 60_000;

/** Orientim, the chain and Jupiter, whose market gives `market` for any amount. */
/** Every other world has the agent bring its own routes (routes-needed rounds); the rest, Orientim's. */
let worlds = 0;

async function world(market: bigint) {
  const own = worlds++ % 2 === 1;
  const wallet = await generateKeyPairSigner();
  const accounts = new Map<string, Account>([
    [USDC, mint(6)], [WSOL_MINT, mint(9)], [BONK, mint(5)],
    [DEX, { owner: address('BPFLoaderUpgradeab1e11111111111111111111111'), data: new Uint8Array(36) }],
    [POOL, { owner: DEX, data: new Uint8Array(300) }],
    [await ataOf(TREASURY, USDC), tokenAccount(TREASURY, USDC)],
    ...await fundedAccounts(wallet.address, USDC),
    ...await fundedAccounts(wallet.address, BONK),
  ]);
  const sent: string[] = [];
  const rpc = fakeRpc(accounts, { sent });
  const jupiter = fakeJupiter({ out: market });
  const deps: AgentDeps = {
    rpc, jupiter, secrets: [new Uint8Array(32).fill(3)],
    keys: new Map([[createHash('sha256').update(KEY).digest('hex'), 'fuzz']]),
    feeBps: 25n, treasury: TREASURY, excludeDexes: [], maxNetworkFeeLamports: 200_000n, disabled: false, v1: false, perMinute: 1_000_000,
    ownRoutes: own,
  };
  const fetchImpl = (async (url: string, init: RequestInit) => {
    if (url.startsWith('https://api.jup.ag/')) {
      // Jupiter as the agent asks it, for its own price and for routes: the same market, no price impact.
      const q = new URL(url).searchParams;
      const r = await jupiter.build({
        inputMint: address(q.get('inputMint')!), outputMint: address(q.get('outputMint')!), amount: BigInt(q.get('amount')!),
        taker: address(q.get('taker')!), slippageBps: Number(q.get('slippageBps')), maxAccounts: Number(q.get('maxAccounts')),
        // A route Orientim asks for names where it delivers, and the DEXes it leaves out.
        ...(q.get('destinationTokenAccount') ? { destinationTokenAccount: address(q.get('destinationTokenAccount')!) } : {}),
        ...(q.get('excludeDexes') ? { excludeDexes: q.get('excludeDexes')!.split(',') } : {}),
      });
      return Response.json({ ...r, priceImpactPct: 0 });
    }
    if (url.endsWith('/api/v1/finalize')) return agentFinalize(new Request(url, init), deps);
    return agentPrepare(new Request(url, init), deps);
  }) as unknown as typeof fetch;
  // It keeps up with the RPC the blockhash came from (valid to block 1000, so handed out at 850).
  const agentRpc = {
    ...rpc,
    getBlockHeight: () => ({ send: async () => 850n }),
    getSignatureStatuses: () => ({ send: async () => ({ value: [{ confirmationStatus: 'confirmed', err: null }] }) }),
  } as unknown as Rpc<SolanaRpcApi>;
  return { wallet, sent, fetchImpl, agentRpc, jupiterApiKey: own ? 'agent-key' : undefined };
}

type World = Awaited<ReturnType<typeof world>>;

/** The floor a sent transaction's route enforces, read from its bytes. */
const enforcedFloor = (wire: string) => {
  const compiled = getCompiledTransactionMessageDecoder().decode(getTransactionDecoder().decode(Buffer.from(wire, 'base64')).messageBytes) as unknown as {
    staticAccounts: string[]; instructions: { programAddressIndex: number; data?: Uint8Array }[];
  };
  const ix = compiled.instructions.find(i => compiled.staticAccounts[i.programAddressIndex] === JUPITER_PROGRAM);
  return jupiterFloor(jupiterRouteArgs(ix!.data!)!);
};

const botDeps = (w: World, extra: Record<string, unknown> = {}) => ({
  rpc: w.agentRpc, apiUrl: 'http://orientim.test', apiKey: KEY, fetchImpl: w.fetchImpl, pollMs: 1, maxWaitMs: 60,
  stateDir: mkdtempSync(join(tmpdir(), 'orientim-limits-')), treasury: TREASURY,
  ...(w.jupiterApiKey ? { jupiterApiKey: w.jupiterApiKey } : {}), ...extra,
});

type BotReady = { refused: string } | { checked: Record<string, unknown>; signature: string };

/** A bot's prepare, then its own signature over the message; the refusal's code when prepare refused. */
async function botPrepare(w: World, intent: Omit<Intent, 'owner'> & { id: string }, deps: ReturnType<typeof botDeps>): Promise<BotReady> {
  const ready = await runCli('prepare', { intent: { owner: w.wallet.address, ...intent } }, deps);
  const out = JSON.parse(JSON.stringify(ready.output)) as { checked?: Record<string, unknown>; message?: string; error?: { code?: string } };
  if (ready.code !== 0 || !out.message) return { refused: out.error?.code ?? 'refused' };
  const signature = getBase58Decoder().decode(await signBytes(w.wallet.keyPair.privateKey, Buffer.from(out.message, 'base64')));
  return { checked: out.checked!, signature };
}

async function botFinalize(checked: unknown, signature: string, deps: ReturnType<typeof botDeps>) {
  const done = await runCli('finalize', { checked, signature }, deps);
  return { swapped: done.code === 0 && done.output.outcome === 'confirmed', code: (done.output.error as { code?: string } | undefined)?.code };
}

async function agentSwap(w: World, intent: Omit<Intent, 'owner'>, extra: Partial<Parameters<typeof protectedSwap>[0]> = {}) {
  return protectedSwap({
    apiUrl: 'http://orientim.test', apiKey: KEY, rpc: w.agentRpc, wallet: w.wallet as KeyPairSigner, fetchImpl: w.fetchImpl, pollMs: 1, intent,
    ...(w.jupiterApiKey ? { jupiterApiKey: w.jupiterApiKey } : {}), ...extra,
  }).then(r => ({ swapped: r.outcome === 'confirmed', error: undefined as unknown }), (error: unknown) => ({ swapped: false, error }));
}

const PAIRS = [[USDC, WSOL_MINT], [USDC, BONK], [BONK, USDC]] as const;
const magnitude = (min: bigint, max: bigint) =>
  fc.oneof(
    fc.constantFrom(min, max),
    fc.integer({ min: 0, max: 17 }).chain(e => fc.bigInt({ min: 10n ** BigInt(e), max: 10n ** BigInt(e + 1) })).filter(x => x >= min && x <= max),
  );

describe('agents and bots at the limits', () => {
  it('decide alike at any price and amount, and never enforce less than the floor asked of Jupiter', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom(...PAIRS), magnitude(1n, 10n ** 18n), magnitude(1n, 10n ** 12n),
        fc.option(fc.integer({ min: 10, max: 1_500 }), { nil: undefined }),
        async ([inputMint, outputMint], market, amount, slippageBps) => {
          const intent = { inputMint, outputMint, amountIn: amount.toString(), treasury: TREASURY, ...(slippageBps !== undefined ? { slippageBps } : {}) };
          const a = await world(market);
          const agent = await agentSwap(a, intent);
          const b = await world(market);
          const ready = await botPrepare(b, { ...intent, id: 'order-1' }, botDeps(b));
          const bot = 'refused' in ready ? { swapped: false } : await botFinalize(ready.checked, ready.signature, botDeps(b));
          expect(bot.swapped, `agent ${String(agent.error)}`).toBe(agent.swapped);
          for (const w of [a, b]) {
            expect(w.sent.length).toBe(agent.swapped ? 1 : 0);
            // The floor the skill asks of Jupiter by default: its price less the tolerance in force.
            if (w.sent.length) expect(enforcedFloor(w.sent[0]) > 0n).toBe(true);
          }
        },
      ),
      PARAMS,
    );
  }, TIMEOUT);

  it("refuses an agent's floor more than 20% below Jupiter's price, and never enforces less than one it accepts", async () => {
    await fc.assert(
      fc.asyncProperty(fc.boolean(), fc.integer({ min: 0, max: 3_000 }), fc.integer({ min: -2, max: 2 }), async (asBot, belowBps, nudge) => {
        const market = 1_000_000_000n;
        // Jupiter's price for the amount is `market`; the lowest floor accepted is 20% below it.
        const lowest = (market * 8_000n) / 10_000n;
        const minOut = (market * BigInt(10_000 - belowBps)) / 10_000n + BigInt(nudge);
        const w = await world(market);
        const intent = { inputMint: USDC, outputMint: WSOL_MINT, amountIn: '1000000', treasury: TREASURY, minOut: minOut.toString() };
        let refusedAsFloor: boolean;
        let swapped: boolean;
        if (asBot) {
          const ready = await botPrepare(w, { ...intent, id: 'order-1' }, botDeps(w));
          refusedAsFloor = 'refused' in ready && ready.refused === 'floor-too-low';
          swapped = 'refused' in ready ? false : (await botFinalize(ready.checked, ready.signature, botDeps(w))).swapped;
        } else {
          const r = await agentSwap(w, intent);
          refusedAsFloor = r.error instanceof FloorError;
          swapped = r.swapped;
        }
        expect(refusedAsFloor).toBe(minOut < lowest);
        if (minOut < lowest) expect(w.sent).toEqual([]);
        if (swapped) expect(enforcedFloor(w.sent[0]) >= minOut).toBe(true);
      }),
      PARAMS,
    );
  }, TIMEOUT);

  it("holds every swap to the owner's limits, per swap and per day, at prepare and again at finalize", async () => {
    // From 1 USDC up: Orientim's smallest swap is about $1, a rule of its own tested elsewhere.
    const swap = fc.record({ mint: fc.constantFrom(USDC, BONK), amount: fc.bigInt({ min: 1_000_000n, max: 5_000_000n }) });
    const earlier = fc.record({ mint: fc.constantFrom(USDC, BONK), amount: fc.bigInt({ min: 1n, max: 5_000_000n }), hoursAgo: fc.integer({ min: 0, max: 48 }), otherWallet: fc.boolean() });
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom('agent', 'bot-in-turn', 'bot-prepare-all-first'),
        fc.record({ usdcListed: fc.boolean(), usdcCap: fc.bigInt({ min: 1n, max: 20_000_000n }), bonkListed: fc.boolean(), bonkCap: fc.bigInt({ min: 1n, max: 20_000_000n }) }),
        fc.option(fc.bigInt({ min: 1n, max: 15_000_000n }), { nil: undefined }),
        fc.array(earlier, { maxLength: 3 }),
        fc.array(swap, { minLength: 1, maxLength: 4 }),
        async (channel, caps, daily, history, swaps) => {
          const policy: OwnerPolicy = {
            maxAmountIn: {
              ...(caps.usdcListed ? { [USDC]: caps.usdcCap.toString() } : {}),
              ...(caps.bonkListed ? { [BONK]: caps.bonkCap.toString() } : {}),
            },
            ...(daily !== undefined ? { maxAmountInPerDay: { [USDC]: daily.toString(), [BONK]: daily.toString() } } : {}),
          };
          const w = await world(1_000_000_000n);
          const deps = botDeps(w, { policy });
          const store = createFileStore(deps.stateDir);
          // Swaps already on record: counted when they are this wallet's, in this token, within 24 hours.
          const spent = new Map<string, bigint>([[USDC, 0n], [BONK, 0n]]);
          const now = Date.now();
          for (const [i, e] of history.entries()) {
            const at = now - e.hoursAgo * 60 * 60_000 + (e.hoursAgo === 24 ? -1 : 0);
            await store.recordSpend({ signature: `earlier-${i}`, owner: e.otherWallet ? TREASURY : w.wallet.address, mint: e.mint, amountIn: e.amount.toString(), at });
            if (!e.otherWallet && at >= now - DAY_MS + 60_000) spent.set(e.mint, spent.get(e.mint)! + e.amount);
          }
          const cap = (m: string) => policy.maxAmountIn[m] === undefined ? null : BigInt(policy.maxAmountIn[m]);
          // What the owner's policy lets through, swap by swap, in order.
          const expected = swaps.map(s => {
            const most = cap(s.mint);
            if (most === null) return 'mint-not-allowed';
            if (s.amount > most) return 'amount-over-limit';
            if (daily !== undefined && spent.get(s.mint)! + s.amount > daily) return 'daily-limit';
            spent.set(s.mint, spent.get(s.mint)! + s.amount);
            return 'swapped';
          });
          const intentOf = (s: { mint: string; amount: bigint }, i: number) =>
            ({ inputMint: s.mint, outputMint: s.mint === USDC ? WSOL_MINT : USDC, amountIn: s.amount.toString(), treasury: TREASURY, id: `order-${i}` });

          const got: string[] = [];
          if (channel === 'agent') {
            for (const [i, s] of swaps.entries()) {
              const r = await agentSwap(w, intentOf(s, i), { policy, spends: store, pending: store });
              got.push(r.swapped ? 'swapped' : r.error instanceof PolicyError ? r.error.code : `other: ${String(r.error)}`);
            }
          } else if (channel === 'bot-in-turn') {
            for (const [i, s] of swaps.entries()) {
              const ready = await botPrepare(w, intentOf(s, i), deps);
              if ('refused' in ready) { got.push(ready.refused); continue; }
              const done = await botFinalize(ready.checked, ready.signature, deps);
              got.push(done.swapped ? 'swapped' : done.code ?? 'other');
            }
          } else {
            // Every swap prepared before any is finalized: prepare sees nothing spent by the others yet,
            // so the daily limit must be held again at finalize.
            const ready = [];
            for (const [i, s] of swaps.entries()) ready.push(await botPrepare(w, intentOf(s, i), deps));
            for (const r of ready) {
              if ('refused' in r) { got.push(r.refused); continue; }
              const done = await botFinalize(r.checked, r.signature, deps);
              got.push(done.swapped ? 'swapped' : done.code ?? 'other');
            }
          }
          expect(got).toEqual(expected);
          expect(w.sent.length).toBe(expected.filter(x => x === 'swapped').length);
        },
      ),
      { ...PARAMS, numRuns: Math.max(1, Math.floor(RUNS / 2)) },
    );
  }, TIMEOUT);

  it('counts every swap of the wallet against a daily limit, those made with no policy included, at millions of USDC', async () => {
    // 2 to 9 million USDC a swap: no money moves, the chain is fake, and the amounts are where a
    // limit that forgets a swap would cost the most.
    const millions = fc.bigInt({ min: 2_000_000_000_000n, max: 9_000_000_000_000n });
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom('agent', 'bot'),
        fc.array(millions, { minLength: 1, maxLength: 3 }),
        millions,
        fc.bigInt({ min: 2_000_000_000_000n, max: 40_000_000_000_000n }),
        async (channel, before, next, daily) => {
          const w = await world(1_000_000_000n);
          const deps = botDeps(w);
          const store = createFileStore(deps.stateDir);
          const intentOf = (amount: bigint, i: number) =>
            ({ inputMint: USDC, outputMint: WSOL_MINT, amountIn: amount.toString(), treasury: TREASURY, id: `order-${i}` });
          const swapOnce = async (amount: bigint, i: number, policy?: OwnerPolicy) => {
            if (channel === 'agent') {
              const r = await agentSwap(w, intentOf(amount, i), { ...(policy ? { policy } : {}), spends: store, pending: store, orders: store });
              return r.swapped ? 'swapped' : r.error instanceof PolicyError ? r.error.code : `other: ${String(r.error)}`;
            }
            const withPolicy = { ...deps, ...(policy ? { policy } : {}) };
            const ready = await botPrepare(w, intentOf(amount, i), withPolicy);
            if ('refused' in ready) return ready.refused;
            const done = await botFinalize(ready.checked, ready.signature, withPolicy);
            return done.swapped ? 'swapped' : done.code ?? 'other';
          };
          // Before the owner sets any policy: every swap goes through, and each is recorded.
          for (const [i, amount] of before.entries()) expect(await swapOnce(amount, i)).toBe('swapped');
          // Then a daily limit: the swaps already made in the last 24 hours count against it.
          const spent = before.reduce((a, b) => a + b, 0n);
          const policy: OwnerPolicy = { maxAmountIn: { [USDC]: '10000000000000' }, maxAmountInPerDay: { [USDC]: daily.toString() } };
          const expected = spent + next > daily ? 'daily-limit' : 'swapped';
          expect(await swapOnce(next, before.length, policy)).toBe(expected);
          expect(w.sent.length).toBe(before.length + (expected === 'swapped' ? 1 : 0));
        },
      ),
      { ...PARAMS, numRuns: Math.max(1, Math.floor(RUNS / 2)) },
    );
  }, TIMEOUT);

  it("sends nothing when a bot changes prepare's answer before finalize, whatever it changed", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom('amount', 'amount-and-figures', 'input-token', 'output-token', 'minimum', 'fee', 'treasury'),
        fc.bigInt({ min: 1n, max: 999_999n }),
        async (edit, smaller) => {
          const w = await world(1_000_000_000n);
          const policy: OwnerPolicy = { maxAmountIn: { [USDC]: '1000000' }, maxAmountInPerDay: { [USDC]: '1000000' } };
          const deps = botDeps(w, { policy });
          const ready = await botPrepare(w, { inputMint: USDC, outputMint: WSOL_MINT, amountIn: '1000000', treasury: TREASURY, id: 'order-1' }, deps);
          expect('refused' in ready).toBe(false);
          if ('refused' in ready) return;
          const c = structuredClone(ready.checked) as {
            intent: Record<string, string>; prepared: { amounts: Record<string, string>; certificate: { input: Record<string, string>; output: Record<string, string> }; policy: Record<string, unknown> };
          };
          const less = String(smaller);
          if (edit === 'amount') c.intent.amountIn = less;
          if (edit === 'amount-and-figures') {
            c.intent.amountIn = less;
            c.prepared.amounts.amountIn = less;
            c.prepared.certificate.input.totalDebit = less;
          }
          if (edit === 'input-token') c.intent.inputMint = BONK;
          if (edit === 'output-token') c.intent.outputMint = BONK;
          if (edit === 'minimum') c.prepared.amounts.minOut = String(BigInt(c.prepared.amounts.minOut) / 2n);
          if (edit === 'fee') c.prepared.amounts.fee = String(BigInt(c.prepared.amounts.fee) + 1n);
          if (edit === 'treasury') c.prepared.policy.treasury = (await generateKeyPairSigner()).address;
          const done = await botFinalize(c, ready.signature, deps);
          expect(done.swapped).toBe(false);
          expect(w.sent).toEqual([]);
        },
      ),
      PARAMS,
    );
  }, TIMEOUT);
});
