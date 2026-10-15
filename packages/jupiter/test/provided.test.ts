/**
 * Routes an agent brings from Jupiter with its own key: the same pipeline builds the same swap
 * around them, asks for what it lacks, refuses what does not answer the swap, and never prices
 * Orientim's fee from them.
 */
import { describe, expect, it } from 'vitest';
import { address, generateKeyPairSigner } from '@solana/kit';
import type { Address, KeyPairSigner } from '@solana/kit';
import { ataOf, JUPITER_PROGRAM, SYSTEM_PROGRAM, WSOL_MINT } from '@orientimhq/swap/core';
import { DEFAULT_SETTINGS, OrientimError, prepareProtectedSwap } from '../src/swap.ts';
import { MAX_PROVIDED_ROUTES, parseProvidedRoutes, providedRoutes, routeKey, RoutesNeeded, RoutesUntrusted } from '../src/provided.ts';
import type { ProvidedRoute, RouteRequest } from '../src/provided.ts';
import type { BuildParams, JupiterClient } from '../src/client.ts';
import { BONK, DECIMALS, DEX, fakeJupiter, fakeRpc, fundedAccounts, mint, POOL, tokenAccount, USDC } from './fakes.ts';
import type { Account } from './fakes.ts';

const TREASURY = address('9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM');

const paramsOf = (r: RouteRequest): BuildParams => ({
  inputMint: address(r.inputMint), outputMint: address(r.outputMint), amount: BigInt(r.amount), taker: address(r.taker),
  slippageBps: r.slippageBps, maxAccounts: r.maxAccounts,
  ...(r.mode ? { mode: r.mode } : {}),
  ...(r.destinationTokenAccount ? { destinationTokenAccount: address(r.destinationTokenAccount) } : {}),
  ...(r.excludeDexes ? { excludeDexes: r.excludeDexes } : {}),
});

async function world(opts: { input?: Address; treasuryWallet?: boolean } = {}) {
  const W = (await generateKeyPairSigner()).address;
  const input = opts.input ?? USDC;
  const accounts = new Map<string, Account>([
    [USDC, mint(6)], [WSOL_MINT, mint(9)], [BONK, mint(5)],
    [DEX, { owner: address('BPFLoaderUpgradeab1e11111111111111111111111'), data: new Uint8Array(36) }],
    [POOL, { owner: DEX, data: new Uint8Array(300) }],
    ...await fundedAccounts(W, input),
    ...(opts.treasuryWallet ? [[TREASURY, { owner: SYSTEM_PROGRAM, data: new Uint8Array(0) }] as [string, Account]] : []),
  ]);
  return { W, input, accounts, E: await generateKeyPairSigner() };
}

/** One prepare, with `jupiter` as the source of routes and `pricing` for the fee in SOL. */
const prepareWith = (w: Awaited<ReturnType<typeof world>>, jupiter: JupiterClient, opts: { pricing?: JupiterClient; output?: Address; treasury?: Address; E?: KeyPairSigner } = {}) =>
  prepareProtectedSwap({
    rpc: fakeRpc(w.accounts, {}), jupiter, ...(opts.pricing ? { pricing: opts.pricing } : {}),
    settings: { ...DEFAULT_SETTINGS, treasury: opts.treasury ?? null, jupiterProgram: JUPITER_PROGRAM },
  }, {
    owner: w.W, ephemeral: opts.E ?? w.E, inputMint: w.input, outputMint: opts.output ?? WSOL_MINT, amountIn: 1_000_000n,
    inputDecimals: DECIMALS[w.input], outputDecimals: DECIMALS[opts.output ?? WSOL_MINT], version: 1,
  });

/** As an agent does: prepare, fetch what is asked with its own market, prepare again. */
async function inRounds(w: Awaited<ReturnType<typeof world>>, agentMarket: JupiterClient, own: JupiterClient, opts: { pricing?: JupiterClient; output?: Address; treasury?: Address } = {}) {
  const routes: ProvidedRoute[] = [];
  const asked: RouteRequest[][] = [];
  for (let round = 0; round < 10; round++) {
    try {
      return { prepared: await prepareWith(w, providedRoutes(routes, own), opts), rounds: round + 1, routes, asked };
    } catch (e) {
      if (!(e instanceof RoutesNeeded)) throw e;
      asked.push(e.requests);
      for (const r of e.requests) routes.push({ params: r, response: await agentMarket.build(paramsOf(r)) });
    }
  }
  throw new Error('too many rounds');
}

describe('routes an agent brings from Jupiter', () => {
  it('build the same protected swap as a route Orientim asks for, in a round or two, asking nothing of Orientim\'s key', async () => {
    const w = await world();
    const ownAsked: BuildParams[] = [];
    const own = fakeJupiter({ asked: ownAsked });
    const { prepared, rounds, asked } = await inRounds(w, fakeJupiter(), own);
    const direct = await prepareWith(w, fakeJupiter());
    expect(prepared.quote.outAmount).toBe(direct.quote.outAmount);
    expect(prepared.policy.minOut).toBe(direct.policy.minOut);
    expect(rounds).toBeLessThanOrEqual(3);
    expect(ownAsked).toHaveLength(0);
    // Every request names the one-time key the swap is built around, and this swap's mints.
    for (const r of asked.flat()) {
      expect(r.taker).toBe(w.E.address);
      expect([r.inputMint, r.outputMint]).toEqual([w.input, WSOL_MINT]);
    }
  });

  it("Orientim's fee in SOL is priced with Orientim's own key, never from the agent's routes", async () => {
    // BONK → USDC with a treasury wallet and no BONK or USDC account: neither token carries the fee.
    const w = await world({ input: BONK, treasuryWallet: true });
    const pricingAsked: BuildParams[] = [];
    const pricing = fakeJupiter({ asked: pricingAsked });
    const { prepared, asked } = await inRounds(w, fakeJupiter(), fakeJupiter(), { pricing, output: USDC, treasury: TREASURY });
    expect(prepared.policy.feeSide).toBe('sol');
    expect(pricingAsked.some(p => p.outputMint === WSOL_MINT)).toBe(true);
    expect(asked.flat().every(r => r.outputMint === USDC)).toBe(true);
  });

  it("a SOL value an earlier round got is used for the same amount, not asked of Orientim's key again", async () => {
    const w = await world({ input: BONK, treasuryWallet: true });
    const asked: BuildParams[] = [];
    const heard: { amount: bigint; value: bigint }[] = [];
    const run = (solValue?: { amount: bigint; value: bigint }) => prepareProtectedSwap({
      rpc: fakeRpc(w.accounts, {}), jupiter: fakeJupiter(), pricing: fakeJupiter({ asked }),
      ...(solValue ? { solValue } : {}), onSolValue: v => heard.push(v),
      settings: { ...DEFAULT_SETTINGS, treasury: TREASURY, jupiterProgram: JUPITER_PROGRAM },
    }, {
      owner: w.W, ephemeral: w.E, inputMint: BONK, outputMint: USDC, amountIn: 1_000_000n,
      inputDecimals: DECIMALS[BONK], outputDecimals: DECIMALS[USDC], version: 1,
    });
    const first = await run();
    expect(first.policy.feeSide).toBe('sol');
    expect(asked.filter(p => p.outputMint === WSOL_MINT)).toHaveLength(1);
    expect(heard).toHaveLength(1);
    // The next round brings it: nothing is asked, and the fee is the same.
    const again = await run(heard[0]);
    expect(asked.filter(p => p.outputMint === WSOL_MINT)).toHaveLength(1);
    expect(again.policy.fee).toBe(first.policy.fee);
    // A value for another amount is not this swap's: asked again.
    await run({ amount: heard[0].amount + 1n, value: heard[0].value });
    expect(asked.filter(p => p.outputMint === WSOL_MINT)).toHaveLength(2);
  });

  it('a route that answers another amount is refused as a bad quote', async () => {
    const w = await world();
    await expect(inRounds(w, fakeJupiter({ inAmountFactor: 2n }), fakeJupiter())).rejects.toMatchObject({ code: 'bad-quote' });
  });

  it('a route through a DEX the build excludes is refused, by the programs it names, whatever its plan says', async () => {
    const w = await world();
    // Orientim's own labels name the route's program; the agent's route plan calls it something else.
    const own: JupiterClient = { ...fakeJupiter(), programLabels: async () => ({ [DEX]: 'HumidiFi' }) };
    const failure = await inRounds(w, fakeJupiter({ label: 'Whirlpool' }), own).catch((e: OrientimError) => e);
    expect(failure).toBeInstanceOf(OrientimError);
    expect((failure as OrientimError).code).toBe('no-route');
  });

  it('without labels that name an excluded DEX, a route is not taken on trust: RoutesUntrusted, never "nothing excluded"', async () => {
    for (const labels of ['down', {}, { [DEX]: 'Whirlpool' }] as const) {
      const w = await world();
      const failure = await inRounds(w, fakeJupiter(), fakeJupiter({ labels })).catch(e => e);
      expect(failure, JSON.stringify(labels)).toBeInstanceOf(RoutesUntrusted);
    }
  });

  it('the widest route is asked for alone; once it does not fit, every narrower one in the same round', async () => {
    const taker = (await generateKeyPairSigner()).address;
    const params = (maxAccounts: number): BuildParams => ({ inputMint: USDC, outputMint: WSOL_MINT, amount: 1_000_000n, taker, slippageBps: 50, maxAccounts });
    const widest = await providedRoutes([], fakeJupiter()).build(params(64)).catch(e => e);
    expect((widest as RoutesNeeded).requests.map(r => r.maxAccounts)).toEqual([64]);
    const narrower = await providedRoutes([], fakeJupiter()).build(params(56)).catch(e => e);
    expect((narrower as RoutesNeeded).requests.map(r => r.maxAccounts)).toEqual([56, 48, 40, 32, 24, 16]);
  });

  it('a route Jupiter refused is sent back as noRoute, and the build goes on as with no route', async () => {
    const w = await world();
    const routes: ProvidedRoute[] = [];
    let e: unknown;
    // Each answer is "no route"; the build asks for the narrower routes it tries, then gives up.
    for (let round = 0; round < 10; round++) {
      e = await prepareWith(w, providedRoutes(routes, fakeJupiter())).catch(x => x);
      if (!(e instanceof RoutesNeeded)) break;
      for (const r of e.requests) if (!routes.some(x => routeKey(x.params) === routeKey(r))) routes.push({ params: r, noRoute: true });
    }
    expect(e).toBeInstanceOf(OrientimError);
    expect((e as OrientimError).code).toBe('no-route');
  }, 30_000);

  it('only routes Orientim could have asked for are read: bounded, well formed, and found by their exact request', async () => {
    const w = await world();
    const request: RouteRequest = { inputMint: USDC, outputMint: WSOL_MINT, amount: '1000000', taker: w.E.address, slippageBps: 50, maxAccounts: 64 };
    const response = await fakeJupiter().build(paramsOf(request));
    expect(parseProvidedRoutes([{ params: request, response }])).toMatchObject({ routes: [{ params: request }] });
    expect(parseProvidedRoutes(Array.from({ length: MAX_PROVIDED_ROUTES + 1 }, () => ({ params: request, noRoute: true })))).toHaveProperty('error');
    expect(parseProvidedRoutes([{ params: { ...request, amount: '-1' }, response }])).toHaveProperty('error');
    expect(parseProvidedRoutes([{ params: { ...request, taker: 'not-an-address' }, response }])).toHaveProperty('error');
    expect(parseProvidedRoutes([{ params: request, response: { ...response, inAmount: 'abc' } }])).toHaveProperty('error');
    expect(parseProvidedRoutes('nope')).toHaveProperty('error');
    // The same build, whatever the order of its excluded DEXes; another taker is another build.
    expect(routeKey({ ...request, excludeDexes: ['A', 'B'] })).toBe(routeKey({ ...request, excludeDexes: ['B', 'A'] }));
    expect(routeKey({ ...request, taker: await ataOf(w.W, USDC) })).not.toBe(routeKey(request));
  });
});
