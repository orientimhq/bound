/**
 * The page's swap at any price, fuzzed: the real pipeline (prepare → compile → verify → certify)
 * against a fake chain and a fake Jupiter whose market gives anything from one unit to 10^18 for
 * the amount, for amounts from one unit to 10^15, any tolerance, and a protected route that may sit
 * below the open market by any gap, with or without the person having accepted it.
 *
 * Every case ends one of two ways, and which one follows from the case alone:
 * - certified: the minimum is the quote less the tolerance in force, never above the quote and
 *   never zero; the whole amount is debited; the fee is at most 0.3%;
 * - refused with one of Orientim's own reasons (never a crash), and `costs-more` exactly when the
 *   route sits more than 0.5% below the market and the person accepted less than that.
 *
 * `npm run test:fuzz` runs 50,000 cases; ORIENTIM_FUZZ_RUNS and ORIENTIM_FUZZ_SEED set a shard.
 */
import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { address, generateKeyPairSigner } from '@solana/kit';
import type { Address } from '@solana/kit';
import { JUPITER_PROGRAM, WSOL_MINT } from '@orientimhq/swap/core';
import { DEFAULT_SETTINGS, OrientimError, prepareProtectedSwap } from '../src/swap.ts';
import { BONK, DECIMALS, DEX, fakeJupiter, fakeRpc, fundedAccounts, mint, POOL, USDC } from './fakes.ts';
import type { Account } from './fakes.ts';

const MODE = (import.meta as { env?: { MODE?: string } }).env?.MODE;
const RUNS = Number(process.env.ORIENTIM_FUZZ_RUNS ?? (MODE === 'fuzz' ? 50_000 : 60));
const SEED = process.env.ORIENTIM_FUZZ_SEED ? Number(process.env.ORIENTIM_FUZZ_SEED) : undefined;
const PARAMS = { numRuns: RUNS, ...(SEED !== undefined ? { seed: SEED } : {}) };
const TIMEOUT = 60_000 + RUNS * 200;

const PAIRS: [Address, Address][] = [[USDC, WSOL_MINT], [USDC, BONK], [WSOL_MINT, USDC], [WSOL_MINT, BONK], [BONK, USDC]];
/** Any order of magnitude, the ends included. */
const magnitude = (min: bigint, max: bigint) =>
  fc.oneof(
    fc.constantFrom(min, min + 1n, max),
    fc.integer({ min: 0, max: 18 }).chain(e => fc.bigInt({ min: 10n ** BigInt(e), max: 10n ** BigInt(e + 1) })).filter(x => x >= min && x <= max),
  );

describe("the page's swap at any price", () => {
  it('certifies with the right minimum and fee, or refuses for a reason of its own', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom(...PAIRS),
        magnitude(1n, 10n ** 18n),
        magnitude(1n, 10n ** 15n),
        fc.option(fc.integer({ min: 10, max: 1_500 }), { nil: undefined }),
        fc.oneof(fc.constant(0n), fc.bigInt({ min: 1n, max: 6_000n })),
        fc.option(fc.bigInt({ min: 0n, max: 6_000n }), { nil: undefined }),
        fc.constantFrom<0 | 1>(0, 1),
        async ([input, output], market, amountIn, chosen, worseByBps, acceptedCostBps, version) => {
          const W = (await generateKeyPairSigner()).address;
          const accounts = new Map<string, Account>([
            [USDC, mint(6)], [WSOL_MINT, mint(9)], [BONK, mint(5)],
            [DEX, { owner: address('BPFLoaderUpgradeab1e11111111111111111111111'), data: new Uint8Array(36) }],
            [POOL, { owner: DEX, data: new Uint8Array(300) }],
          ]);
          if (input !== WSOL_MINT) for (const [k, a] of await fundedAccounts(W, input)) accounts.set(k, a);
          const outcome = await prepareProtectedSwap(
            {
              rpc: fakeRpc(accounts),
              jupiter: fakeJupiter({ out: market, worseByBps }),
              settings: { ...DEFAULT_SETTINGS, treasury: null, jupiterProgram: JUPITER_PROGRAM, ...(chosen !== undefined ? { chosenSlippageBps: chosen } : {}) },
            },
            {
              owner: W, ephemeral: await generateKeyPairSigner(), inputMint: input, outputMint: output, amountIn,
              inputDecimals: DECIMALS[input], outputDecimals: DECIMALS[output], version,
              ...(acceptedCostBps !== undefined ? { acceptedCostBps } : {}),
            },
          ).then(prepared => ({ prepared }), (error: unknown) => ({ error }));

          const tolerance = BigInt(chosen ?? DEFAULT_SETTINGS.slippageBps);
          // What the protected route gives: the market less the gap, when Orientim excludes a market.
          const protectedOut = DEFAULT_SETTINGS.excludeDexes.length ? (market * (10_000n - worseByBps)) / 10_000n : market;
          const gap = DEFAULT_SETTINGS.excludeDexes.length ? ((market - protectedOut) * 10_000n) / market : 0n;
          const floor = (protectedOut * (10_000n - tolerance)) / 10_000n;

          if ('error' in outcome) {
            // Refused: always one of Orientim's own reasons, said in words, never a crash.
            expect(outcome.error, String(outcome.error)).toBeInstanceOf(OrientimError);
            const code = (outcome.error as OrientimError).code;
            if (code === 'costs-more') {
              expect(gap > DEFAULT_SETTINGS.askAboveBps).toBe(true);
              expect(acceptedCostBps === undefined || gap > acceptedCostBps + 50n).toBe(true);
            }
            // A route with a floor, within the gap Orientim tolerates and the one the person accepted,
            // is refused only for a reason unrelated to price: an amount too small to swap at all.
            if (floor > 0n && gap <= DEFAULT_SETTINGS.askAboveBps) expect(['amount-too-small', 'no-route']).toContain(code);
            return;
          }
          const { prepared } = outcome;
          expect(gap <= DEFAULT_SETTINGS.badQuoteBps).toBe(true);
          if (gap > DEFAULT_SETTINGS.askAboveBps) expect(acceptedCostBps !== undefined && gap <= acceptedCostBps + 50n).toBe(true);
          expect(prepared.policy.minOut).toBe(floor);
          expect(prepared.policy.minOut > 0n).toBe(true);
          expect(prepared.policy.minOut <= protectedOut).toBe(true);
          expect(prepared.certificate.input.totalDebit).toBe(amountIn);
          expect(prepared.policy.feeBps <= 30n).toBe(true);
          expect(prepared.policy.fee * 10_000n <= amountIn * 30n || prepared.policy.feeSide !== 'input').toBe(true);
        },
      ),
      PARAMS,
    );
  }, TIMEOUT);
});
