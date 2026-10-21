/**
 * The local Pump.fun curve route on any curve, fuzzed: any reserves (a curve just created, one nearly
 * complete, one with almost no SOL in it), any fees Pump's config may hold, any amount and tolerance,
 * buys with or without a destination account, and sells.
 *
 * Every case ends one of two ways:
 * - left to Jupiter, exactly when the route could not execute as quoted (a buy past what is left on
 *   the curve, a sell past the SOL it holds) or there is nothing to swap;
 * - a route the verifier reads back as built: the amount in, the quote and the tolerance in its data,
 *   Jupiter's floor (rounded up, as Jupiter's own) never above the quote, the quote never above what
 *   the curve would pay without fees, more in never less out, the taker the only signer, and the
 *   destination, when there is one, where route_v2 delivers.
 *
 * `npm run test:fuzz` runs 20,000 cases; ORIENTIM_FUZZ_RUNS and ORIENTIM_FUZZ_SEED set a shard.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { address, getAddressDecoder, getAddressEncoder, getProgramDerivedAddress } from '@solana/kit';
import type { Address } from '@solana/kit';
import { JUPITER_PROGRAM, PUMP_CURVE_PROGRAM, TOKEN_2022_PROGRAM, WSOL_MINT } from '@orientimhq/swap/core';
import { jupiterDestination, jupiterFloor, jupiterRouteArgs } from '@orientimhq/swap/verifier';
import { bondingCurveOf } from '@orientim/builder';
import { CURVE_LOOKUP_TABLE, quoteBuy, quoteSell, withLocalCurveRoutes } from '../src/curveRoute.ts';
import { isCurveRoute } from '../src/swap.ts';
import type { BuildParams, BuildResponse, JupiterClient } from '../src/client.ts';

const MODE = (import.meta as { env?: { MODE?: string } }).env?.MODE;
const RUNS = Number(process.env.ORIENTIM_FUZZ_RUNS ?? (MODE === 'fuzz' ? 20_000 : 300));
const SEED = process.env.ORIENTIM_FUZZ_SEED ? Number(process.env.ORIENTIM_FUZZ_SEED) : undefined;
const PARAMS = { numRuns: RUNS, ...(SEED !== undefined ? { seed: SEED } : {}) };
const TIMEOUT = 60_000 + RUNS * 20;

const fixture = JSON.parse(readFileSync(new URL('./fixtures/curve-routes.json', import.meta.url), 'utf8'));
const FEES_PROGRAM = address('pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ');
const pda = async (program: Address, ...seeds: Uint8Array[]) => (await getProgramDerivedAddress({ programAddress: program, seeds }))[0];
const GLOBAL = await pda(PUMP_CURVE_PROGRAM, new TextEncoder().encode('global'));
const FEE_CONFIG = await pda(FEES_PROGRAM, new TextEncoder().encode('fee_config'), getAddressEncoder().encode(PUMP_CURVE_PROGRAM) as Uint8Array);
const MINT = address(fixture.cases[0].mint);
const CURVE = await bondingCurveOf(MINT);
const B64 = (s: string) => new Uint8Array(Buffer.from(s, 'base64'));
const key = fc.uint8Array({ minLength: 32, maxLength: 32 }).map(b => getAddressDecoder().decode(b));
const u64 = (min: bigint, max: bigint) =>
  fc.oneof(fc.constantFrom(min, max), fc.integer({ min: 0, max: 19 }).chain(e => fc.bigInt({ min: 10n ** BigInt(e), max: 10n ** BigInt(e + 1) })).filter(x => x >= min && x <= max));

function chain(curve: { vt: bigint; vq: bigint; rt: bigint; rq: bigint }, fees: { protocol: bigint; creator: bigint }) {
  const c = B64(fixture.cases[0].curve);
  const v = new DataView(c.buffer);
  v.setBigUint64(8, curve.vt, true);
  v.setBigUint64(16, curve.vq, true);
  v.setBigUint64(24, curve.rt, true);
  v.setBigUint64(32, curve.rq, true);
  const config = new Uint8Array(fixture.feeConfigLength);
  config.set(B64(fixture.feeConfigHead));
  new DataView(config.buffer).setBigUint64(69 + 24, fees.protocol, true);
  new DataView(config.buffer).setBigUint64(69 + 32, fees.creator, true);
  const table = new Uint8Array(56 + 32);
  new DataView(table.buffer).setUint32(0, 1, true);
  new DataView(table.buffer).setBigUint64(4, 2n ** 64n - 1n, true);
  table.set(getAddressEncoder().encode(WSOL_MINT), 56);
  const accounts = new Map<string, { owner: Address; data: Uint8Array }>([
    [CURVE, { owner: PUMP_CURVE_PROGRAM, data: c }],
    [MINT, { owner: TOKEN_2022_PROGRAM, data: new Uint8Array(82) }],
    [GLOBAL, { owner: PUMP_CURVE_PROGRAM, data: B64(fixture.global) }],
    [FEE_CONFIG, { owner: FEES_PROGRAM, data: config }],
    [CURVE_LOOKUP_TABLE, { owner: address('AddressLookupTab1e1111111111111111111111111'), data: table }],
  ]);
  return {
    getMultipleAccounts: (list: string[]) => ({
      send: async () => ({
        context: { slot: 1n },
        value: list.map(a => {
          const x = accounts.get(a);
          return x ? { owner: x.owner, lamports: 1n, data: [Buffer.from(x.data).toString('base64'), 'base64'], executable: false, space: BigInt(x.data.length) } : null;
        }),
      }),
    }),
  } as never;
}

const LEFT = { left: true } as unknown as BuildResponse;
const jupiter: JupiterClient = { build: async () => LEFT, searchTokens: async () => [], programLabels: async () => ({}) };

describe('the local Pump.fun curve route on any curve', () => {
  it('is left to Jupiter exactly when it could not execute, and is otherwise read back as built', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.record({
          vt: u64(1n, 2n ** 63n), vq: u64(1n, 2n ** 50n), rtShare: fc.integer({ min: 0, max: 1000 }), rq: u64(0n, 2n ** 50n),
          protocol: fc.bigInt({ min: 0n, max: 1000n }), creator: fc.bigInt({ min: 0n, max: 1000n }),
          amount: u64(1n, 2n ** 60n), slippageBps: fc.integer({ min: 0, max: 10_000 }), isBuy: fc.boolean(),
          taker: key, destination: fc.option(key, { nil: undefined }), pick: fc.double({ min: 0, max: 0.999_999, noNaN: true }),
        }),
        async x => {
          const curve = { vt: x.vt, vq: x.vq, rt: (x.vt * BigInt(x.rtShare)) / 1000n, rq: x.rq };
          const fees = { protocolBps: x.protocol, creatorBps: x.creator };
          const params: BuildParams = {
            inputMint: x.isBuy ? WSOL_MINT : MINT, outputMint: x.isBuy ? MINT : WSOL_MINT, amount: x.amount, taker: x.taker,
            slippageBps: x.slippageBps, maxAccounts: 64, pumpCurve: CURVE,
            ...(x.isBuy && x.destination ? { destinationTokenAccount: x.destination } : {}),
          };
          const r = await withLocalCurveRoutes(jupiter, chain(curve, { protocol: x.protocol, creator: x.creator }), {
            random: () => x.pick, onFallback: () => {},
          }).build(params);
          const reserves = { virtualToken: curve.vt, virtualQuote: curve.vq, realToken: curve.rt, realQuote: curve.rq };
          const expected = x.isBuy ? quoteBuy(reserves, x.amount, fees) : quoteSell(reserves, x.amount, fees).out;
          const executable = x.isBuy ? expected < curve.rt : quoteSell(reserves, x.amount, fees).gross <= curve.rq;
          if (!executable || expected <= 0n) {
            expect(r).toBe(LEFT);
            return;
          }
          expect(r).not.toBe(LEFT);
          const out = BigInt(r.outAmount);
          expect(out).toBe(expected);
          const args = jupiterRouteArgs(Buffer.from(r.swapInstruction.data, 'base64'))!;
          expect(args).toMatchObject({ inAmount: x.amount, quotedOutAmount: out, slippageBps: x.slippageBps, platformFeeBps: 0, positiveSlippageBps: 0 });
          // Jupiter's own floor rounds up; the one the verifier holds a route to rounds down, so the
          // route's never lets through less than the verifier's.
          const threshold = BigInt(r.otherAmountThreshold);
          expect(threshold).toBe((out * BigInt(10_000 - x.slippageBps) + 9_999n) / 10_000n);
          expect(threshold >= jupiterFloor(args) && threshold <= out).toBe(true);
          // Never more than the curve pays without fees.
          const feeless = x.isBuy ? (curve.vt * x.amount) / (curve.vq + x.amount) : (curve.vq * x.amount) / (curve.vt + x.amount);
          expect(out <= feeless).toBe(true);
          // More in never gets less out.
          const more = x.isBuy ? quoteBuy(reserves, x.amount + 1n, fees) : quoteSell(reserves, x.amount + 1n, fees).out;
          expect(more >= out).toBe(true);
          // The taker alone signs, as the route's authority and as Pump's buyer.
          const accounts = r.swapInstruction.accounts;
          expect(r.swapInstruction.programId).toBe(JUPITER_PROGRAM);
          expect(accounts.flatMap((a, i) => (a.isSigner ? [[i, a.pubkey]] : []))).toEqual([[0, x.taker], [28, x.taker]]);
          expect(jupiterDestination(Buffer.from(r.swapInstruction.data, 'base64'), accounts.map(a => a.pubkey as Address)))
            .toBe(params.destinationTokenAccount ?? accounts[2]!.pubkey);
          expect(isCurveRoute(r)).toBe(true);
          expect(r.inAmount).toBe(x.amount.toString());
        },
      ),
      PARAMS,
    );
  }, TIMEOUT);
});
