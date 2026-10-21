import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { address, getAddressEncoder, getProgramDerivedAddress } from '@solana/kit';
import type { Address } from '@solana/kit';
import { PUMP_CURVE_PROGRAM, TOKEN_PROGRAM, WSOL_MINT } from '@orientimhq/swap/core';
import { bondingCurveOf } from '@orientim/builder';
import { CURVE_LOOKUP_TABLE, withLocalCurveRoutes } from '../src/curveRoute.ts';
import type { BuildParams, BuildResponse, JupiterClient } from '../src/client.ts';

/**
 * Captured on mainnet: for each swap the curve and mint, read before and after Jupiter answered and
 * kept only where they did not change, and that answer as a digest, its buyback recipient masked
 * (Jupiter picks one of eight, as this builder does). Pump's global account and its fee config are the
 * ones read at the same time. Buys carry a destination account, as Orientim asks; sells do not.
 */
type Fixture = {
  captured: string;
  global: string;
  feeConfigHead: string;
  feeConfigLength: number;
  cases: {
    mint: string; mintProgram: string; curve: string;
    params: { inputMint: string; outputMint: string; amount: string; taker: string; slippageBps: number; maxAccounts: number; destinationTokenAccount?: string };
    jupiter: { outAmount: string; otherAmountThreshold: string; priceImpactPct: string; digest: string };
  }[];
};
const fixture: Fixture = JSON.parse(readFileSync(new URL('./fixtures/curve-routes.json', import.meta.url), 'utf8'));

const FEES_PROGRAM = address('pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ');
const pda = async (program: Address, ...seeds: Uint8Array[]) => (await getProgramDerivedAddress({ programAddress: program, seeds }))[0];
const GLOBAL = await pda(PUMP_CURVE_PROGRAM, new TextEncoder().encode('global'));
const FEE_CONFIG = await pda(FEES_PROGRAM, new TextEncoder().encode('fee_config'), getAddressEncoder().encode(PUMP_CURVE_PROGRAM) as Uint8Array);
const B64 = (s: string) => new Uint8Array(Buffer.from(s, 'base64'));

/** What the build reads, as the fixture holds it; the lookup table is a small one of this test's own. */
function chain(): Map<string, { owner: Address; data: Uint8Array }> {
  const feeConfig = new Uint8Array(fixture.feeConfigLength);
  feeConfig.set(B64(fixture.feeConfigHead));
  const tableAddresses = [WSOL_MINT, PUMP_CURVE_PROGRAM];
  const table = new Uint8Array(56 + 32 * tableAddresses.length);
  new DataView(table.buffer).setUint32(0, 1, true);
  new DataView(table.buffer).setBigUint64(4, 2n ** 64n - 1n, true);
  tableAddresses.forEach((a, i) => table.set(getAddressEncoder().encode(a), 56 + 32 * i));
  return new Map<string, { owner: Address; data: Uint8Array }>([
    [GLOBAL, { owner: PUMP_CURVE_PROGRAM, data: B64(fixture.global) }],
    [FEE_CONFIG, { owner: FEES_PROGRAM, data: feeConfig }],
    [CURVE_LOOKUP_TABLE, { owner: address('AddressLookupTab1e1111111111111111111111111'), data: table }],
  ]);
}

function fakeRpc(accounts: Map<string, { owner: Address; data: Uint8Array }>, opts: { fail?: boolean } = {}) {
  const reads: string[][] = [];
  const rpc = {
    getMultipleAccounts: (list: string[]) => ({
      send: async () => {
        reads.push(list);
        if (opts.fail) throw new Error('RPC down');
        return {
          context: { slot: 1n },
          value: list.map(a => {
            const acc = accounts.get(a);
            return acc ? { owner: acc.owner, lamports: 1_000_000n, data: [Buffer.from(acc.data).toString('base64'), 'base64'], executable: false, space: BigInt(acc.data.length) } : null;
          }),
        };
      },
    }),
  };
  return { rpc: rpc as never, reads };
}

/** Jupiter, standing by: the answer it would give is not needed, only whether it was asked. */
function standIn() {
  const asked: BuildParams[] = [];
  const jupiter: JupiterClient = {
    build: async p => { asked.push(p); return { jupiter: true } as unknown as BuildResponse; },
    searchTokens: async () => [],
    programLabels: async () => ({}),
  };
  return { jupiter, asked };
}

const digest = (r: BuildResponse) => {
  const s = structuredClone(r.swapInstruction);
  s.accounts[24] = { ...s.accounts[24]!, pubkey: 'BUYBACK' };
  return createHash('sha256').update(JSON.stringify({
    inputMint: r.inputMint, outputMint: r.outputMint, inAmount: r.inAmount, outAmount: r.outAmount, otherAmountThreshold: r.otherAmountThreshold,
    routePlan: r.routePlan, setupInstructions: r.setupInstructions, swapInstruction: s,
  })).digest('hex');
};

async function setUp(c: Fixture['cases'][number], edit: (curve: Uint8Array) => void = () => {}) {
  const accounts = chain();
  const curveAddress = await bondingCurveOf(address(c.mint));
  const curve = B64(c.curve);
  edit(curve);
  accounts.set(curveAddress, { owner: PUMP_CURVE_PROGRAM, data: curve });
  accounts.set(c.mint, { owner: address(c.mintProgram), data: new Uint8Array(82) });
  const params: BuildParams = {
    inputMint: address(c.params.inputMint), outputMint: address(c.params.outputMint), amount: BigInt(c.params.amount),
    taker: address(c.params.taker), slippageBps: c.params.slippageBps, maxAccounts: c.params.maxAccounts,
    ...(c.params.destinationTokenAccount ? { destinationTokenAccount: address(c.params.destinationTokenAccount) } : {}),
    pumpCurve: curveAddress,
  };
  return { accounts, params, curveAddress };
}

const buy = fixture.cases.find(c => c.params.inputMint === WSOL_MINT)!;
const sell = fixture.cases.find(c => c.params.outputMint === WSOL_MINT)!;

describe('the local Pump.fun curve route', () => {
  it('has both sides to compare against', () => {
    expect(fixture.cases.filter(c => c.params.inputMint === WSOL_MINT).length).toBeGreaterThanOrEqual(4);
    expect(fixture.cases.filter(c => c.params.outputMint === WSOL_MINT).length).toBeGreaterThanOrEqual(4);
  });

  for (const c of fixture.cases) {
    const side = c.params.inputMint === WSOL_MINT ? 'buy' : 'sell';
    it(`is Jupiter's answer, byte for byte: ${side} ${c.mint.slice(0, 6)} (${fixture.captured})`, async () => {
      // A sell here is of tokens the capture never bought, from curves that hold almost no SOL yet:
      // Jupiter quotes it all the same (its quote does not read the SOL the curve holds), and this
      // builder would leave it to Jupiter, since it cannot execute. The curve is given SOL to sell
      // against; the quote does not change.
      const { accounts, params } = await setUp(c, side === 'sell' ? d => { new DataView(d.buffer).setBigUint64(32, 10n ** 15n, true); } : undefined);
      const { rpc } = fakeRpc(accounts);
      const { jupiter, asked } = standIn();
      for (const pick of [0, 0.99]) {
        const r = await withLocalCurveRoutes(jupiter, rpc, { random: () => pick, onFallback: r => { throw new Error(r); } }).build(params);
        expect(asked).toEqual([]);
        expect(r.outAmount).toBe(c.jupiter.outAmount);
        expect(r.otherAmountThreshold).toBe(c.jupiter.otherAmountThreshold);
        expect(digest(r)).toBe(c.jupiter.digest);
        // The buyback share goes to one of Pump's eight recipients, the one picked.
        const global = B64(fixture.global);
        const recipient = (i: number) => getAddressEncoder().encode(r.swapInstruction.accounts[24]!.pubkey as Address).every((b, k) => b === global[741 + 32 * i + k]);
        expect(recipient(pick === 0 ? 0 : 7)).toBe(true);
        expect(r.swapInstruction.accounts[24]!.isWritable).toBe(true);
        // Jupiter prices the impact from its own feed (0.99% to 1.56% for the same curve and buy in
        // this capture); this one is against the curve's own price, and stays within a point of it.
        expect(Math.abs(Number(r.priceImpactPct) - Number(c.jupiter.priceImpactPct))).toBeLessThan(0.01);
        expect(r.addressesByLookupTableAddress).toEqual({ [CURVE_LOOKUP_TABLE]: [WSOL_MINT, PUMP_CURVE_PROGRAM] });
      }
    });
  }

  it('reads only the curve and the mint again within a minute', async () => {
    const { accounts, params } = await setUp(buy);
    const { rpc, reads } = fakeRpc(accounts);
    let now = 1_000;
    const client = withLocalCurveRoutes(standIn().jupiter, rpc, { now: () => now });
    await client.build(params);
    await client.build(params);
    now += 61_000;
    await client.build(params);
    expect(reads.map(r => r.length)).toEqual([5, 2, 5]);
  });

  it('leaves a request without a curve to Jupiter, reading nothing', async () => {
    const { accounts, params } = await setUp(buy);
    const { rpc, reads } = fakeRpc(accounts);
    const { jupiter, asked } = standIn();
    const { pumpCurve: _, ...plain } = params;
    await withLocalCurveRoutes(jupiter, rpc).build(plain);
    expect(asked).toHaveLength(1);
    expect(reads).toEqual([]);
  });

  // Each: what is changed, and whether the fallback is one to say (unexpected) or not.
  const curveCases: [string, (curve: Uint8Array) => void, boolean][] = [
    ['a complete curve', d => { d[48] = 1; }, false],
    ['a cashback coin', d => { d[82] = 1; }, false],
    ['a curve quoted in another token', d => { d[83] = 7; }, false],
    ["a curve's own creator fee", d => { new DataView(d.buffer).setBigUint64(115, 100n, true); }, true],
    ['an unknown layout', d => { d[0] ^= 0xff; }, true],
    ['a buy past what is left on the curve', d => { new DataView(d.buffer).setBigUint64(24, 1_000n, true); }, false],
  ];
  for (const [what, edit, said] of curveCases) {
    it(`leaves ${what} to Jupiter`, async () => {
      const { accounts, params } = await setUp(buy, edit);
      const { jupiter, asked } = standIn();
      const told: string[] = [];
      const r = await withLocalCurveRoutes(jupiter, fakeRpc(accounts).rpc, { onFallback: x => told.push(x) }).build(params);
      expect(r).toEqual({ jupiter: true });
      expect(asked).toEqual([params]);
      expect(told.length > 0).toBe(said);
    });
  }

  it('leaves a sell past what the curve holds to Jupiter', async () => {
    const { accounts, params } = await setUp(sell, d => { new DataView(d.buffer).setBigUint64(32, 1n, true); });
    const { jupiter, asked } = standIn();
    await withLocalCurveRoutes(jupiter, fakeRpc(accounts).rpc, { onFallback: () => {} }).build(params);
    expect(asked).toHaveLength(1);
  });

  const requestCases: [string, (p: BuildParams) => BuildParams][] = [
    ["Jupiter's fast mode", p => ({ ...p, mode: 'fast' })],
    ['a narrower account budget', p => ({ ...p, maxAccounts: 56 })],
    ['the curve excluded', p => ({ ...p, excludeDexes: ['HumidiFi', 'Pump.fun'] })],
    ['a curve that is not the pair\'s', p => ({ ...p, pumpCurve: WSOL_MINT })],
    ['a pair without SOL', p => ({ ...p, inputMint: address('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v') })],
  ];
  for (const [what, edit] of requestCases) {
    it(`leaves ${what} to Jupiter`, async () => {
      const { accounts, params } = await setUp(buy);
      const { jupiter, asked } = standIn();
      const request = edit(params);
      await withLocalCurveRoutes(jupiter, fakeRpc(accounts).rpc, { onFallback: () => {} }).build(request);
      expect(asked).toEqual([request]);
    });
  }

  it('leaves a sell paid to an account of its own to Jupiter', async () => {
    const { accounts, params } = await setUp(sell);
    const { jupiter, asked } = standIn();
    await withLocalCurveRoutes(jupiter, fakeRpc(accounts).rpc).build({ ...params, destinationTokenAccount: params.taker });
    expect(asked).toHaveLength(1);
  });

  const chainCases: [string, (a: Map<string, { owner: Address; data: Uint8Array }>, mint: string) => void][] = [
    ['a classic SPL mint', (a, mint) => { a.set(mint, { owner: TOKEN_PROGRAM, data: new Uint8Array(82) }); }],
    ['a second fee tier', a => { const d = a.get(FEE_CONFIG)!.data; new DataView(d.buffer).setUint32(65, 2, true); }],
    ['a fee tier from a market cap', a => { const d = a.get(FEE_CONFIG)!.data; d[69] = 1; }],
    ['a deactivated lookup table', a => { const d = a.get(CURVE_LOOKUP_TABLE)!.data; new DataView(d.buffer).setBigUint64(4, 5n, true); }],
    ['a missing global account', a => { a.delete(GLOBAL); }],
  ];
  for (const [what, edit] of chainCases) {
    it(`leaves ${what} to Jupiter, and says so`, async () => {
      const { accounts, params } = await setUp(buy);
      edit(accounts, buy.mint);
      const { jupiter, asked } = standIn();
      const told: string[] = [];
      await withLocalCurveRoutes(jupiter, fakeRpc(accounts).rpc, { onFallback: x => told.push(x) }).build(params);
      expect(asked).toHaveLength(1);
      expect(told).toHaveLength(1);
    });
  }

  it('leaves the swap to Jupiter when the RPC fails, and says it once', async () => {
    const { accounts, params } = await setUp(buy);
    const { jupiter, asked } = standIn();
    const told: string[] = [];
    const client = withLocalCurveRoutes(jupiter, fakeRpc(accounts, { fail: true }).rpc, { onFallback: x => told.push(x) });
    await client.build(params);
    await client.build(params);
    expect(asked).toHaveLength(2);
    expect(told).toHaveLength(1);
  });
});
