/**
 * The page's swap, fuzzed: the real pipeline (prepare → compile → verify → certify) against a fake chain
 * and a fake Jupiter, for any tolerance a person chooses (or Auto), any pair, amount and version, on a
 * Pump.fun curve or not. Every build must certify, with its route built at exactly the tolerance in
 * force, the minimum the quote less that tolerance, the whole amount debited and a fee within 0.3%.
 *
 * `npm run test:fuzz` runs 50,000 cases; ORIENTIM_FUZZ_RUNS and ORIENTIM_FUZZ_SEED set a shard.
 */
import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { address, generateKeyPairSigner, getCompiledTransactionMessageDecoder } from '@solana/kit';
import type { Address } from '@solana/kit';
import { JUPITER_PROGRAM, WSOL_MINT } from '@orientimhq/swap/core';
import { jupiterRouteArgs } from '@orientimhq/swap/verifier';
import { DEFAULT_SETTINGS, prepareProtectedSwap } from '../src/swap.ts';
import type { BuildParams } from '../src/client.ts';
import { BONK, DECIMALS, DEX, fakeJupiter, fakeRpc, fundedAccounts, mint, OUT, POOL, PUMP, USDC } from './fakes.ts';
import type { Account } from './fakes.ts';

const MODE = (import.meta as { env?: { MODE?: string } }).env?.MODE;
const RUNS = Number(process.env.ORIENTIM_FUZZ_RUNS ?? (MODE === 'fuzz' ? 50_000 : 60));
const SEED = process.env.ORIENTIM_FUZZ_SEED ? Number(process.env.ORIENTIM_FUZZ_SEED) : undefined;
const PARAMS = { numRuns: RUNS, ...(SEED !== undefined ? { seed: SEED } : {}) };
const TIMEOUT = 60_000 + RUNS * 200;

const PAIRS: [Address, Address][] = [[USDC, WSOL_MINT], [USDC, BONK], [WSOL_MINT, USDC], [WSOL_MINT, BONK]];

describe("the page's swap, fuzzed across tolerances", () => {
  it('certifies every build, at exactly the tolerance in force, with the minimum and the fee it states', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom(...PAIRS),
        fc.option(fc.integer({ min: 10, max: 1_500 }), { nil: undefined }),
        fc.boolean(),
        fc.bigInt({ min: 1_000_000n, max: 50_000_000n }),
        fc.constantFrom<0 | 1>(0, 1),
        async ([input, output], chosen, curve, amountIn, version) => {
          const W = (await generateKeyPairSigner()).address;
          const accounts = new Map<string, Account>([
            [USDC, mint(6)], [WSOL_MINT, mint(9)], [BONK, mint(5)],
            [DEX, { owner: address('BPFLoaderUpgradeab1e11111111111111111111111'), data: new Uint8Array(36) }],
            [POOL, { owner: DEX, data: new Uint8Array(300) }],
            ...(curve ? [[PUMP, { owner: address('BPFLoaderUpgradeab1e11111111111111111111111'), data: new Uint8Array(36) }] as [string, Account]] : []),
          ]);
          if (input !== WSOL_MINT) for (const [k, a] of await fundedAccounts(W, input)) accounts.set(k, a);
          const asked: BuildParams[] = [];
          const prepared = await prepareProtectedSwap(
            {
              rpc: fakeRpc(accounts),
              jupiter: fakeJupiter({ asked, ...(curve ? { label: 'Pump.fun', curveProgram: true } : {}) }),
              settings: { ...DEFAULT_SETTINGS, treasury: null, jupiterProgram: JUPITER_PROGRAM, ...(chosen !== undefined ? { chosenSlippageBps: chosen } : {}) },
            },
            {
              owner: W, ephemeral: await generateKeyPairSigner(), inputMint: input, outputMint: output, amountIn,
              inputDecimals: DECIMALS[input], outputDecimals: DECIMALS[output], version,
            },
          );
          // The tolerance in force: the person's, or Orientim's own (3% on a curve).
          const tolerance = chosen ?? (curve ? DEFAULT_SETTINGS.curveSlippageBps : DEFAULT_SETTINGS.slippageBps);
          // The tolerance Jupiter's program will enforce, read from the route instruction of a v0 message
          // (a v1 message lays its instructions out differently; the verifier read it the same way).
          if (version === 0) {
            const compiled = getCompiledTransactionMessageDecoder().decode(prepared.transaction.messageBytes) as unknown as {
              staticAccounts: string[]; instructions: { programAddressIndex: number; data?: Uint8Array }[];
            };
            const route = compiled.instructions.find(i => compiled.staticAccounts[i.programAddressIndex] === JUPITER_PROGRAM);
            expect(jupiterRouteArgs(route!.data!)!.slippageBps).toBe(tolerance);
          }
          expect(prepared.policy.minOut).toBe((OUT * BigInt(10_000 - tolerance)) / 10_000n);
          expect(prepared.certificate.input.totalDebit).toBe(amountIn);
          expect(prepared.policy.feeBps).toBeLessThanOrEqual(30n);
          if (chosen !== undefined) expect(asked.every(p => p.slippageBps === chosen)).toBe(true);
        },
      ),
      PARAMS,
    );
  }, TIMEOUT);
});
