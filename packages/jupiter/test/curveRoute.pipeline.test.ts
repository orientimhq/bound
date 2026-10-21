/**
 * The local Pump.fun curve route through the whole pipeline: prepare, compile, the verifier, the
 * simulation and the certificate, on a fake chain holding a real curve, Pump's real global account and
 * fee config, and a Token-2022 mint, as captured on mainnet. Jupiter is asked for no route.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { address, generateKeyPairSigner, getAddressEncoder, getProgramDerivedAddress } from '@solana/kit';
import type { Address } from '@solana/kit';
import { JUPITER_PROGRAM, PUMP_CURVE_PROGRAM, TOKEN_2022_PROGRAM, WSOL_MINT } from '@orientimhq/swap/core';
import { bondingCurveOf } from '@orientim/builder';
import { CURVE_LOOKUP_TABLE, withLocalCurveRoutes } from '../src/curveRoute.ts';
import { DEFAULT_SETTINGS, minimumOutput, prepareProtectedSwap } from '../src/swap.ts';
import type { BuildParams, JupiterClient } from '../src/client.ts';
import { clearPumpCurves, fakeRpc, mint, plain2022Mint } from './fakes.ts';
import type { Account } from './fakes.ts';

afterEach(clearPumpCurves);

const fixture = JSON.parse(readFileSync(new URL('./fixtures/curve-routes.json', import.meta.url), 'utf8'));
const FEES_PROGRAM = address('pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ');
const pda = async (program: Address, ...seeds: Uint8Array[]) => (await getProgramDerivedAddress({ programAddress: program, seeds }))[0];
const B64 = (s: string) => new Uint8Array(Buffer.from(s, 'base64'));

async function chain(c: { mint: string; curve: string }) {
  const config = new Uint8Array(fixture.feeConfigLength);
  config.set(B64(fixture.feeConfigHead));
  // The fake chain's simulation reads no lookup table: this one holds an address no swap uses.
  const table = new Uint8Array(56 + 32);
  new DataView(table.buffer).setUint32(0, 1, true);
  new DataView(table.buffer).setBigUint64(4, 2n ** 64n - 1n, true);
  table.set(getAddressEncoder().encode(address('SysvarRent111111111111111111111111111111111')), 56);
  const curve = B64(c.curve);
  // SOL in the curve, for the sells: the captured curves hold almost none yet.
  new DataView(curve.buffer).setBigUint64(32, 10n ** 12n, true);
  return new Map<string, Account>([
    [WSOL_MINT, mint(9)],
    [c.mint, plain2022Mint(6)],
    [await bondingCurveOf(address(c.mint)), { owner: PUMP_CURVE_PROGRAM, data: curve }],
    [await pda(PUMP_CURVE_PROGRAM, new TextEncoder().encode('global')), { owner: PUMP_CURVE_PROGRAM, data: B64(fixture.global) }],
    [await pda(FEES_PROGRAM, new TextEncoder().encode('fee_config'), getAddressEncoder().encode(PUMP_CURVE_PROGRAM) as Uint8Array), { owner: FEES_PROGRAM, data: config }],
    [CURVE_LOOKUP_TABLE, { owner: address('AddressLookupTab1e1111111111111111111111111'), data: table }],
  ]);
}

/** Jupiter, standing by: asked for no route, only for its DEX labels. */
function standIn() {
  const asked: BuildParams[] = [];
  const jupiter: JupiterClient = {
    build: async p => { asked.push(p); throw new Error('Jupiter was asked for a route'); },
    searchTokens: async () => [],
    programLabels: async () => ({}),
  };
  return { jupiter, asked };
}

describe('the local curve route through the whole pipeline', () => {
  const buy = fixture.cases.find((c: { params: { inputMint: string } }) => c.params.inputMint === WSOL_MINT);

  // Version 1 carries no lookup table, which the fake chain cannot serve; v0 with Pump's table is
  // built and simulated on mainnet by the canary.
  for (const version of [1] as const) {
    it(`a buy is built, verified, simulated and certified without asking Jupiter (v${version})`, async () => {
      const accounts = await chain(buy);
      const rpc = fakeRpc(accounts, { takerRent: 1_346_200n });
      const { jupiter, asked } = standIn();
      const local: string[] = [];
      const W = (await generateKeyPairSigner()).address;
      const prepared = await prepareProtectedSwap(
        { rpc, jupiter: withLocalCurveRoutes(jupiter, rpc, { onLocal: r => local.push(r.outAmount), onFallback: r => { throw new Error(r); } }), settings: { ...DEFAULT_SETTINGS, treasury: null, jupiterProgram: JUPITER_PROGRAM } },
        {
          owner: W, ephemeral: await generateKeyPairSigner(), inputMint: WSOL_MINT, outputMint: address(buy.mint), amountIn: 50_000_000n,
          inputDecimals: 9, outputDecimals: 6, version,
        },
      );
      expect(asked).toEqual([]);
      expect(local.length).toBeGreaterThan(0);
      expect(prepared.quote.route).toEqual(['Pump.fun']);
      // The curve's tolerance, enforced by Orientim on the quote the route was built at: the route's
      // own floor, which rounds up as Jupiter's does, is the stricter by a unit at most.
      const quoted = BigInt(local.at(-1)!);
      expect(prepared.quote.outAmount).toBe(quoted);
      const floor = minimumOutput(quoted, DEFAULT_SETTINGS.curveSlippageBps);
      expect(prepared.quote.minOut - floor >= 0n && prepared.quote.minOut - floor <= 1n).toBe(true);
      // Pump's per-buyer account under the one-time key is closed and its rent returned to the wallet.
      expect(prepared.policy.routeRefund).toBe(1_346_200n);
    });
  }

  it('a sell is built, verified and certified without asking Jupiter', async () => {
    const sell = fixture.cases.find((c: { params: { outputMint: string } }) => c.params.outputMint === WSOL_MINT);
    const accounts = await chain(sell);
    const W = (await generateKeyPairSigner()).address;
    // The wallet holds the tokens it sells.
    const { tokenAccount } = await import('./fakes.ts');
    const { ataOf } = await import('@orientimhq/swap/core');
    accounts.set(await ataOf(W, address(sell.mint), TOKEN_2022_PROGRAM), tokenAccount(W, address(sell.mint), { amount: BigInt(sell.params.amount) }));
    accounts.get(await ataOf(W, address(sell.mint), TOKEN_2022_PROGRAM))!.owner = TOKEN_2022_PROGRAM;
    const rpc = fakeRpc(accounts, { takerRent: 1_346_200n });
    const { jupiter, asked } = standIn();
    const prepared = await prepareProtectedSwap(
      { rpc, jupiter: withLocalCurveRoutes(jupiter, rpc, { onFallback: r => { throw new Error(r); } }), settings: { ...DEFAULT_SETTINGS, treasury: null, jupiterProgram: JUPITER_PROGRAM } },
      {
        owner: W, ephemeral: await generateKeyPairSigner(), inputMint: address(sell.mint), outputMint: WSOL_MINT, amountIn: BigInt(sell.params.amount),
        inputDecimals: 6, outputDecimals: 9, version: 1,
      },
    );
    expect(asked).toEqual([]);
    expect(prepared.quote.route).toEqual(['Pump.fun']);
  });
});
