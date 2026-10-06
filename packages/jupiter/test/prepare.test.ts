/**
 * Attack scenarios as regression tests: the real pipeline (prepare → compile → verify) runs against
 * a fake RPC and a fake Jupiter that answer the way an attacker would.
 */
import { describe, expect, it } from 'vitest';
import {
  address, decompileTransactionMessage, generateKeyPairSigner, getAddressEncoder, getCompiledTransactionMessageDecoder,
  getTransactionDecoder,
} from '@solana/kit';
import type { Address, Transaction } from '@solana/kit';
import {
  ataOf, ATA_PROGRAM, JUPITER_PROGRAM, MAX_TAKER_RENT_LAMPORTS, SYSTEM_PROGRAM, TOKEN_2022_PROGRAM, TOKEN_PROGRAM, WSOL_MINT,
} from '@orientim/core';
import type { SolanaRpc } from '@orientim/solana';
import { OrientimError, DEFAULT_SETTINGS, LEFT_UNDER_KEY_MESSAGE, MIN_FEE, prepareProtectedSwap, revertedOnPrice, withFloorAtLeast } from '../src/swap.ts';
import type { SwapSettings } from '../src/swap.ts';
import { jupiterFloor, jupiterRouteArgs } from '@orientim/verifier';
import type { JupiterRouteArgs } from '@orientim/verifier';
import { JupiterError } from '../src/client.ts';
import type { BuildParams, BuildResponse, JupiterClient } from '../src/client.ts';

import {
  b64, BONK, DECIMALS, DEX, fakeJupiter, fakeRpc, feeMint, fundedAccounts, hookMint, lamportsSentToTaker, mint, OUT, plain2022Mint, POOL, PUMP,
  tokenAccount, USDC,
} from './fakes.ts';
import type { Account } from './fakes.ts';

async function setup(output: Address, opts: { delegate?: boolean; wOutExists?: boolean; memo?: boolean; frozenWOut?: boolean } = {}) {
  const W = (await generateKeyPairSigner()).address;
  const accounts = new Map<string, Account>([
    [USDC, mint(6)], [WSOL_MINT, mint(9)], [BONK, mint(5)],
    [DEX, { owner: address('BPFLoaderUpgradeab1e11111111111111111111111'), data: new Uint8Array(36) }],
    [POOL, { owner: DEX, data: new Uint8Array(300) }],
  ]);
  if (output !== WSOL_MINT && (opts.wOutExists || opts.delegate || opts.memo || opts.frozenWOut)) {
    accounts.set(await ataOf(W, output), tokenAccount(W, output, { delegate: opts.delegate, memo: opts.memo, frozen: opts.frozenWOut }));
  }
  return { W, accounts };
}

const settings = { ...DEFAULT_SETTINGS, treasury: null, jupiterProgram: JUPITER_PROGRAM };

async function prepare(output: Address, opts: {
  jupiter?: JupiterClient; inputDecimals?: number; feeFails?: boolean; delegate?: boolean; wOutExists?: boolean;
  acceptedMinOut?: bigint; memo?: boolean; inputFeeBps?: number; epochFails?: boolean; acceptedCostBps?: bigint;
  chain?: Iterable<[string, Account]>; takerRent?: bigint; priceMoves?: number; walletShort?: boolean;
  input?: Address; treasury?: Address; amountIn?: bigint; feeLevels?: bigint[] | 'fails'; simulations?: { count: number };
  expectCurve?: boolean; version?: 0 | 1; routingMode?: 'fast'; frozenWOut?: boolean; cashback?: bigint; pumpSlippage?: number;
  wIn?: { amount?: bigint; frozen?: boolean }; failBeforeSwap?: boolean; acceptedMinReceived?: bigint;
  minFee?: SwapSettings['minFee']; leavesOpen?: readonly string[]; chosenSlippageBps?: number;
  noPostBalances?: boolean; takerKeepsAfter?: bigint; rentMoves?: number; rentDeadBand?: boolean;
  priorityFee?: (writable: readonly Address[]) => Promise<bigint | null>;
} = {}) {
  const { W, accounts } = await setup(output, opts);
  // The wallet holds the input token, unless a test says otherwise through `chain`.
  if ((opts.input ?? USDC) !== WSOL_MINT) for (const [key, account] of await fundedAccounts(W, opts.input ?? USDC, opts.wIn)) accounts.set(key, account);
  if (opts.inputFeeBps) accounts.set(USDC, feeMint(DECIMALS[USDC], opts.inputFeeBps));
  for (const [key, account] of opts.chain ?? []) accounts.set(key, account);
  return prepareProtectedSwap(
    {
      rpc: fakeRpc(accounts, {
        feeFails: opts.feeFails, epochFails: opts.epochFails, takerRent: opts.takerRent, priceMoves: opts.priceMoves,
        walletShort: opts.walletShort, feeLevels: opts.feeLevels, simulations: opts.simulations, cashback: opts.cashback,
        pumpSlippage: opts.pumpSlippage, failBeforeSwap: opts.failBeforeSwap, leavesOpen: opts.leavesOpen,
        noPostBalances: opts.noPostBalances, takerKeepsAfter: opts.takerKeepsAfter, rentMoves: opts.rentMoves, rentDeadBand: opts.rentDeadBand,
      }),
      ...(opts.priorityFee ? { priorityFee: opts.priorityFee } : {}),
      jupiter: opts.jupiter ?? fakeJupiter(), settings: {
        ...settings, treasury: opts.treasury ?? null, ...(opts.minFee ? { minFee: opts.minFee } : {}),
        ...(opts.chosenSlippageBps !== undefined ? { chosenSlippageBps: opts.chosenSlippageBps } : {}),
      },
    },
    {
      owner: W, ephemeral: await generateKeyPairSigner(), inputMint: opts.input ?? USDC, outputMint: output,
      amountIn: opts.amountIn ?? 1_000_000n,
      inputDecimals: opts.inputDecimals ?? DECIMALS[opts.input ?? USDC], outputDecimals: DECIMALS[output], version: opts.version ?? 1,
      acceptedMinOut: opts.acceptedMinOut, acceptedMinReceived: opts.acceptedMinReceived, acceptedCostBps: opts.acceptedCostBps, expectCurve: opts.expectCurve,
      ...(opts.routingMode ? { routingMode: opts.routingMode } : {}),
    },
  );
}

const codeOf = async (p: Promise<unknown>) => p.then(() => 'ok', (e: unknown) => (e instanceof OrientimError ? e.code : String(e)));

describe('the amount the user typed is converted with on-chain decimals', () => {
  it('an interface that used metadata decimals (9 for USDC) is refused before anything is built', async () => {
    expect(await codeOf(prepare(WSOL_MINT, { inputDecimals: 9 }))).toBe('token-data-mismatch');
  });

  it('matching decimals build normally', async () => {
    expect((await prepare(WSOL_MINT)).policy.inputDecimals).toBe(6);
  });
});

describe('the prepared swap carries its certificate and timings (ideas 35, 20)', () => {
  it('keeps the market baseline standard when the protected route opts into fast mode', async () => {
    const asked: BuildParams[] = [];
    await prepare(WSOL_MINT, { jupiter: fakeJupiter({ asked }), routingMode: 'fast' });
    expect(asked.some(p => p.mode === undefined && !p.excludeDexes?.length)).toBe(true);
    expect(asked.some(p => p.mode === 'fast' && !!p.excludeDexes?.length)).toBe(true);
  });
  it('the certificate states the approved debit and the enforced minimum of this exact transaction', async () => {
    const prepared = await prepare(WSOL_MINT);
    const c = prepared.certificate;
    expect(c.input.totalDebit).toBe(prepared.policy.amountIn);
    expect(c.output.minimumOutput).toBe(prepared.policy.minOut);
    expect(c.messageSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(prepared.timings.localMs).toBeLessThanOrEqual(prepared.timings.totalMs);
    expect(prepared.timings.jupiterBuildCalls).toBeGreaterThan(0);
    expect(prepared.timings.simulationCalls).toBeGreaterThan(0);
    expect(prepared.timings.verificationMs).toBeGreaterThanOrEqual(0);
  });
});

describe('Orientim computes the minimum itself', () => {
  it('a Jupiter floor of 1 is replaced by the quote less the accepted slippage', async () => {
    const prepared = await prepare(WSOL_MINT, { jupiter: fakeJupiter({ threshold: 1n }) });
    expect(prepared.policy.minOut).toBe((OUT * BigInt(10_000 - settings.slippageBps)) / 10_000n);
    expect(prepared.quote.minOut).toBe(prepared.policy.minOut);
  });

  it('a stricter Jupiter floor is kept', async () => {
    const prepared = await prepare(WSOL_MINT, { jupiter: fakeJupiter({ threshold: OUT - 1n }) });
    expect(prepared.policy.minOut).toBe(OUT - 1n);
  });

  it('the minimum the user accepted is enforced when it is stricter than the route floor', async () => {
    const accepted = OUT - 1_000n; // between the route floor and the quoted output
    expect((await prepare(WSOL_MINT, { acceptedMinOut: accepted })).policy.minOut).toBe(accepted);
  });

  it("Jupiter's own floor is raised to that minimum as well, no further than it needs", async () => {
    const accepted = OUT - 1_000n;
    const route = jupiterArgsOf(await prepare(WSOL_MINT, { acceptedMinOut: accepted }));
    // Its floor counts only what the route delivered: a deposit arriving with the swap cannot fill a gap.
    expect(jupiterFloor(route)).toBeGreaterThanOrEqual(accepted);
    expect(route.slippageBps).toBeLessThan(settings.slippageBps);
    expect(jupiterFloor({ ...route, slippageBps: route.slippageBps + 1 })).toBeLessThan(accepted);
  });

  it('without a stricter accepted minimum, Jupiter keeps the tolerance it was asked for', async () => {
    const route = jupiterArgsOf(await prepare(WSOL_MINT));
    expect(route.slippageBps).toBe(settings.slippageBps);
  });

  it('when the route can no longer deliver the accepted minimum, the user is asked again', async () => {
    const error = await prepare(WSOL_MINT, { acceptedMinOut: OUT + 1n }).then(() => null, (e: unknown) => e as OrientimError);
    expect(error?.code).toBe('price-moved');
    expect(error?.priceMoved?.newMinOut).toBe((OUT * BigInt(10_000 - settings.slippageBps)) / 10_000n);
  });

  it('an answer for a different amount is not a quote for this swap', async () => {
    expect(await codeOf(prepare(WSOL_MINT, { jupiter: fakeJupiter({ inAmountFactor: 1_000n }) }))).toBe('bad-quote');
  });

  it('a route priced right but too big is reported as not fitting, not as a bad quote', async () => {
    const extra = await Promise.all(Array.from({ length: 60 }, () => generateKeyPairSigner()));
    const error = await prepare(WSOL_MINT, { jupiter: fakeJupiter({ extraAccounts: extra.map(s => s.address) }) })
      .then(() => null, (e: unknown) => e as OrientimError);
    expect(error?.code).toBe('no-route');
    expect(error?.message).toMatch(/does not fit in a single protected transaction/);
  });

  it('when only a route too big to fit meets the minimum, the size is the reason named, not the price', async () => {
    const extra = await Promise.all(Array.from({ length: 60 }, async () => (await generateKeyPairSigner()).address));
    const wide = fakeJupiter({ extraAccounts: extra });
    const narrow = fakeJupiter({ out: OUT - OUT / 1_000n });
    const jupiter: JupiterClient = { ...wide, build: (q: BuildParams) => ((q.maxAccounts ?? 64) >= 64 ? wide.build(q) : narrow.build(q)) };
    const error = await prepare(WSOL_MINT, { jupiter, acceptedMinOut: OUT }).then(() => null, (e: unknown) => e as OrientimError);
    expect(error?.code).toBe('price-moved');
    expect(error?.message).toMatch(/does not fit in one protected transaction/);
    expect(error?.message).not.toMatch(/price moved/);
  });
});

describe('a protected route that costs more than the open market', () => {
  it('is put to the user, never refused on their behalf', async () => {
    const error = await prepare(WSOL_MINT, { jupiter: fakeJupiter({ worseByBps: 1_000n }) })
      .then(() => null, (e: unknown) => e as OrientimError);
    expect(error?.code).toBe('costs-more');
    expect(Number(error?.costsMore?.gapBps)).toBeGreaterThanOrEqual(1_000);
  });

  it('is built once the user has accepted that cost', async () => {
    const prepared = await prepare(WSOL_MINT, { jupiter: fakeJupiter({ worseByBps: 1_000n }), acceptedCostBps: 1_000n });
    expect(prepared.quote.gapBps).toBe(1_000n);
  });

  it('is still put to the user well past the warning threshold', async () => {
    expect(await codeOf(prepare(WSOL_MINT, { jupiter: fakeJupiter({ worseByBps: 3_000n }) }))).toBe('costs-more');
  });

  it('is asked about from 0.5% below the market, and goes through silently below that', async () => {
    expect(settings.askAboveBps).toBe(50n);
    expect(await codeOf(prepare(WSOL_MINT, { jupiter: fakeJupiter({ worseByBps: 70n }) }))).toBe('costs-more');
    expect(await codeOf(prepare(WSOL_MINT, { jupiter: fakeJupiter({ worseByBps: 30n }) }))).toBe('ok');
  });

  it('is refused only when the answer is no longer a price at all', async () => {
    expect(await codeOf(prepare(WSOL_MINT, { jupiter: fakeJupiter({ worseByBps: 6_000n }) }))).toBe('bad-quote');
  });
});

describe('a token that taxes its own transfers', () => {
  it('is swappable: the route is quoted for what arrives, and the withheld fees are harvested', async () => {
    const prepared = await prepare(WSOL_MINT, { inputFeeBps: 300 });
    // These tests run without a treasury, so Orientim takes no fee; the token keeps 3% on the way in.
    const swapAmount = 1_000_000n;
    const tax = (swapAmount * 300n + 9_999n) / 10_000n;
    expect(prepared.policy.swapAmount).toBe(swapAmount);
    expect(prepared.policy.inputTransferFee).toBe(true);
    expect(prepared.quote.inAmount).toBe(swapAmount - tax);
    expect(prepared.tokenTax).toEqual({ inputBps: 300, extraOnInput: tax });
  });

  it('its transaction harvests the withheld amount before closing the temporary account', async () => {
    const prepared = await prepare(WSOL_MINT, { inputFeeBps: 300 });
    const compiled = getCompiledTransactionMessageDecoder().decode(prepared.transaction.messageBytes);
    const message = decompileTransactionMessage(compiled as never, { addressesByLookupTableAddress: {} });
    const ixs = message.instructions as readonly { data?: ArrayLike<number> }[];
    const harvest = ixs.findIndex(i => i.data?.[0] === 26 && i.data?.[1] === 4);
    const close = ixs.findIndex(i => i.data?.length === 1 && i.data?.[0] === 9);
    expect(harvest).toBeGreaterThan(-1);
    expect(harvest).toBeLessThan(close);
  });

  it('without the epoch the tax cannot be priced, so nothing is built', async () => {
    expect(await codeOf(prepare(WSOL_MINT, { inputFeeBps: 300, epochFails: true }))).toBe('unavailable');
  });

  it('a token that charges nothing needs no epoch at all', async () => {
    const prepared = await prepare(WSOL_MINT, { epochFails: true });
    expect(prepared.tokenTax).toBe(null);
  });

  it('a token with no tax neither harvests nor reports one', async () => {
    const prepared = await prepare(WSOL_MINT);
    expect(prepared.tokenTax).toBe(null);
    expect(prepared.policy.inputTransferFee).toBe(false);
  });
});

describe('Token-2022 accounts', () => {
  it('an output account that requires a memo on every transfer is refused before anything is built', async () => {
    expect(await codeOf(prepare(BONK, { memo: true }))).toBe('output-account-restricted');
  });
});

describe('transient Jupiter refusals', () => {
  it('"No matching liquidity" on the first quotes does not end the swap', async () => {
    const prepared = await prepare(WSOL_MINT, { jupiter: fakeJupiter({ failFirst: 2 }) });
    expect(prepared.quote.outAmount).toBe(OUT);
  });
});

describe('the network fee check fails closed', () => {
  it('without a price from the cluster, nothing goes to the wallet', async () => {
    expect(await codeOf(prepare(WSOL_MINT, { feeFails: true }))).toBe('unavailable');
  });

  it('the exact fee is returned for display', async () => {
    expect((await prepare(WSOL_MINT)).networkFeeLamports).toBe(15_000n);
  });
});

describe('costs and side effects, Revoke included, are reported from the chain', () => {
  it('a new output account costs the rent the cluster quotes today', async () => {
    expect((await prepare(BONK)).oneTimeCosts.outputAccountRent).toBe(1_488_440n);
    expect((await prepare(BONK, { wOutExists: true })).oneTimeCosts.outputAccountRent).toBe(0n);
  });

  it('removing an existing delegate on the output account is disclosed', async () => {
    expect((await prepare(BONK, { delegate: true })).notices.removesDelegate).toBe(true);
    expect((await prepare(BONK, { wOutExists: true })).notices.removesDelegate).toBe(false);
  });
});

describe('the mints a route passes through are screened like its own two', () => {
  const HOP = address('HoPP1ng1111111111111111111111111111111111111');
  const HOOK = address('Hook1111111111111111111111111111111111111111');

  it('a hop through a token that runs a transfer hook is refused, and nothing is built', async () => {
    const code = await codeOf(prepare(BONK, {
      jupiter: fakeJupiter({ hop: { mint: HOP, tokenProgram: TOKEN_2022_PROGRAM } }),
      chain: [[HOP, hookMint(6, HOOK)]],
    }));
    expect(code).toBe('unsupported-token');
  });

  it('says which extension it was, so the refusal is not a shrug', async () => {
    await expect(prepare(BONK, {
      jupiter: fakeJupiter({ hop: { mint: HOP, tokenProgram: TOKEN_2022_PROGRAM } }),
      chain: [[HOP, hookMint(6, HOOK)]],
    })).rejects.toThrow(/transfer hook/);
  });

  it('a hop through a Token-2022 mint with no extensions builds normally', async () => {
    const prepared = await prepare(BONK, {
      jupiter: fakeJupiter({ hop: { mint: HOP, tokenProgram: TOKEN_2022_PROGRAM } }),
      chain: [[HOP, plain2022Mint(6)]],
    });
    expect(prepared.intermediates.map(x => x.mint)).toEqual([HOP]);
    expect(prepared.certificate.otherTokenDebit).toBe(0);
  });

  it('a hop that charges a transfer fee is still allowed, because the compiler harvests it', async () => {
    const prepared = await prepare(BONK, {
      jupiter: fakeJupiter({ hop: { mint: HOP, tokenProgram: TOKEN_2022_PROGRAM } }),
      chain: [[HOP, feeMint(6, 50)]],
    });
    expect(prepared.intermediates).toEqual([expect.objectContaining({ mint: HOP, transferFee: true })]);
  });
});

describe('a price that moves between the quote and the simulation', () => {
  it('is quoted again, and the market is not left out for it', async () => {
    const prepared = await prepare(BONK, { priceMoves: 1 });
    expect(prepared.attempts[0].simulation).toBe('output below the minimum');
    expect(prepared.attempts.at(-1)!.excluded).not.toContain('Whirlpool');
  });

  it("so is a refusal on price by a Pump.fun market inside the route: the curve is not left out", async () => {
    const prepared = await prepare(BONK, { pumpSlippage: 1, jupiter: fakeJupiter({ label: 'Pump.fun', curveProgram: true }), expectCurve: true });
    expect(prepared.attempts[0].simulation).toBe('output below the minimum');
    expect(prepared.attempts.at(-1)!.excluded).not.toContain('Pump.fun');
  });

  it('that keeps moving is reported as a price move, not as a broken market', async () => {
    const failure = await prepare(BONK, { priceMoves: 10 }).catch((e: OrientimError) => e);
    expect(failure).toBeInstanceOf(OrientimError);
    expect((failure as OrientimError).code).toBe('simulation-failed');
    expect((failure as OrientimError).message).toContain('price moved');
  });
});

describe("a route that opens an account in the taker's name (PumpSwap, the Pump.fun bonding curve)", () => {
  // Rent the route keeps, with no account of its own to close: what a bonding curve takes for growing
  // its own account, within MAX_ROUTE_KEPT_LAMPORTS.
  const RENT = 132_080n;

  it('the temporary key is sent exactly the rent the route spends, and nothing more', async () => {
    const prepared = await prepare(BONK, { takerRent: RENT });
    expect(prepared.policy.takerRent).toBe(RENT);
    expect(prepared.oneTimeCosts.routeRent).toBe(RENT);
    expect(prepared.certificate.routeRentLamports).toBe(RENT);
  });

  it('the same for a swap into SOL and a swap from SOL', async () => {
    expect((await prepare(WSOL_MINT, { takerRent: RENT })).policy.takerRent).toBe(RENT);
  });

  it('a route that needs no rent sends the temporary key none', async () => {
    const prepared = await prepare(BONK);
    expect(prepared.policy.takerRent).toBe(0n);
    expect(prepared.oneTimeCosts.routeRent).toBe(0n);
  });

  it('a route that wants more than the ceiling is not paying rent but spending, and is not funded', async () => {
    const code = await codeOf(prepare(BONK, { takerRent: MAX_TAKER_RENT_LAMPORTS + 1n }));
    expect(code).not.toBe('ok');
  });

  it('when the funded route fails because the price moved, that is what is acted on: quote again, keep the market', async () => {
    const prepared = await prepare(BONK, { takerRent: RENT, priceMoves: 1 });
    expect(prepared.policy.takerRent).toBe(RENT);
    expect(prepared.attempts[0].simulation).toBe('output below the minimum');
    expect(prepared.attempts.at(-1)!.excluded).not.toContain('Whirlpool');
  });
});

describe('slippage on a Pump.fun bonding curve', () => {
  const floor = (bps: number) => (OUT * BigInt(10_000 - bps)) / 10_000n;
  const curve = (extra: Parameters<typeof fakeJupiter>[0] = {}) =>
    fakeJupiter({ label: 'Pump.fun', curveProgram: true, ...extra });
  const onChain: [string, Account][] = [[PUMP, { owner: address('BPFLoaderUpgradeab1e11111111111111111111111'), data: new Uint8Array(36) }]];

  it('a route through the bonding curve is enforced at 3% below the quote, by Orientim and by Jupiter', async () => {
    const asked: BuildParams[] = [];
    const prepared = await prepare(BONK, { jupiter: curve({ asked }), chain: onChain });
    expect(settings.curveSlippageBps).toBe(300);
    expect(prepared.policy.minOut).toBe(floor(300));
    expect(prepared.certificate.output.minimumOutput).toBe(floor(300));
    // Asked at the usual tolerance first, then again at the curve's once it was seen to be one.
    expect(asked.some(p => p.slippageBps === 300 && p.excludeDexes?.length)).toBe(true);
  });

  it('every other route, PumpSwap included, is built at 0.5%, so Jupiter enforces 0.5% on chain too', async () => {
    for (const label of ['Whirlpool', 'Pump.fun Amm']) {
      const asked: BuildParams[] = [];
      const prepared = await prepare(BONK, { jupiter: fakeJupiter({ label, asked }) });
      expect(prepared.policy.minOut).toBe(floor(50));
      expect(asked.every(p => p.slippageBps === 50)).toBe(true);
    }
  });

  it('the label alone does not widen the tolerance: the curve program must be in the route', async () => {
    const asked: BuildParams[] = [];
    const prepared = await prepare(BONK, { jupiter: fakeJupiter({ label: 'Pump.fun', asked }) });
    expect(prepared.policy.minOut).toBe(floor(50));
    expect(asked.every(p => p.slippageBps === 50)).toBe(true);
  });

  it('a tolerance the person chose is the one every route is built and enforced at, curve or not', async () => {
    const asked: BuildParams[] = [];
    const wider = await prepare(BONK, { jupiter: fakeJupiter({ label: 'Whirlpool', asked }), chosenSlippageBps: 300 });
    expect(wider.policy.minOut).toBe(floor(300));
    expect(asked.every(p => p.slippageBps === 300)).toBe(true);
    const onCurve: BuildParams[] = [];
    const tighter = await prepare(BONK, { jupiter: curve({ asked: onCurve }), chain: onChain, chosenSlippageBps: 100 });
    expect(tighter.policy.minOut).toBe(floor(100));
    expect(onCurve.every(p => p.slippageBps === 100)).toBe(true);
    const most = await prepare(BONK, { jupiter: fakeJupiter({ label: 'Whirlpool' }), chosenSlippageBps: 1_500 });
    expect(most.policy.minOut).toBe(floor(1_500));
  });

  it('a minimum the user accepted still wins on the bonding curve when it is stricter', async () => {
    const accepted = floor(100);
    const prepared = await prepare(BONK, { jupiter: curve(), chain: onChain, acceptedMinOut: accepted });
    expect(prepared.policy.minOut).toBe(accepted);
  });
});

describe('a wallet short of SOL', () => {
  it('is told how much SOL the swap needs, and no market is blamed for it', async () => {
    const failure = await prepare(BONK, { walletShort: true }).catch((e: OrientimError) => e);
    expect(failure).toBeInstanceOf(OrientimError);
    expect((failure as OrientimError).code).toBe('insufficient-sol');
    expect((failure as OrientimError).message).toMatch(/needs about \d+\.\d{4} SOL/);
    expect((failure as OrientimError).message).toContain('Your wallet has 0.0004 SOL');
  });

  it("a route short of the taker's rent is still measured and funded, not reported as the wallet's", async () => {
    const prepared = await prepare(BONK, { takerRent: 132_080n });
    expect(prepared.policy.takerRent).toBe(132_080n);
  });
});

describe('a SOL fee into a treasury wallet that does not exist yet', () => {
  const TREASURY = address('9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM');

  it('is refused, not built fee-free and not left to revert, until the treasury wallet exists', async () => {
    const refused = await prepare(BONK, { input: WSOL_MINT, treasury: TREASURY, amountIn: 100_000_000n }).catch((e: OrientimError) => e);
    expect((refused as OrientimError).code).toBe('fee-unavailable');
    expect((refused as OrientimError).message).toContain("Orientim's fee can't be collected");
  });

  it('charges the fee once the treasury wallet exists', async () => {
    const funded: [string, Account] = [TREASURY, { owner: SYSTEM_PROGRAM, data: new Uint8Array(0) }];
    const prepared = await prepare(BONK, { input: WSOL_MINT, treasury: TREASURY, amountIn: 100_000_000n, chain: [funded] });
    expect(prepared.policy.fee).toBe((100_000_000n * settings.feeBps) / 10_000n);
    expect(prepared.policy.treasury).toBe(TREASURY);
  });
});

describe('latency without weaker protection', () => {
  const floor = (bps: number) => (OUT * BigInt(10_000 - bps)) / 10_000n;
  const onChain: [string, Account][] = [[PUMP, { owner: address('BPFLoaderUpgradeab1e11111111111111111111111'), data: new Uint8Array(36) }]];

  it('a page that already saw a curve route asks Jupiter at 3% once, not twice', async () => {
    const asked: BuildParams[] = [];
    const prepared = await prepare(BONK, {
      jupiter: fakeJupiter({ label: 'Pump.fun', curveProgram: true, asked }), chain: onChain, expectCurve: true,
    });
    expect(prepared.policy.minOut).toBe(floor(300));
    expect(asked.every(p => p.slippageBps === 300)).toBe(true);
  });

  it('a wrong curve hint still builds an ordinary route at 0.5%', async () => {
    const asked: BuildParams[] = [];
    const prepared = await prepare(BONK, { jupiter: fakeJupiter({ asked }), expectCurve: true });
    expect(prepared.policy.minOut).toBe(floor(50));
    expect(asked.some(p => p.slippageBps === 50 && p.excludeDexes?.length)).toBe(true);
  });

  it('a Pump.fun route goes straight to measuring its rent: two simulations, not three, then the final one', async () => {
    const simulations = { count: 0 };
    const prepared = await prepare(BONK, {
      jupiter: fakeJupiter({ label: 'Pump.fun', curveProgram: true }), chain: onChain, takerRent: 132_080n, simulations,
    });
    expect(prepared.policy.takerRent).toBe(132_080n);
    // Measuring the rent takes two; the exact final transaction is simulated once more.
    expect(simulations.count).toBe(3);
  });

  it("the provider's estimate, when there is one, sets the priority fee; recent fees only when it has none", async () => {
    let asked: readonly Address[] = [];
    const estimated = await prepare(BONK, { feeLevels: [1n, 2n], priorityFee: async w => { asked = w; return 300_000n; } });
    const recent = await prepare(BONK, { feeLevels: [300_000n] });
    const quiet = await prepare(BONK, { feeLevels: [1n, 2n] });
    expect(asked.length).toBeGreaterThan(0);
    expect(estimated.priorityFeeLamports).toBe(recent.priorityFeeLamports);
    expect(estimated.priorityFeeLamports).toBeGreaterThan(quiet.priorityFeeLamports);
    // No estimate (another provider, a timeout): the recent fees, exactly as without one.
    for (const priorityFee of [async () => null, async () => { throw new Error('down'); }]) {
      expect((await prepare(BONK, { feeLevels: [300_000n], priorityFee })).priorityFeeLamports).toBe(recent.priorityFeeLamports);
    }
    // An estimate is capped like any level.
    expect((await prepare(BONK, { priorityFee: async () => 10n ** 15n })).priorityFeeCapped).toBe(true);
  });

  it('the priority fee follows recent fees on the pools, never below the default', async () => {
    const busy = await prepare(BONK, { feeLevels: [1_000n, 2_000n, 300_000n, 400_000n] });
    const quiet = await prepare(BONK, { feeLevels: [1n, 2n] });
    const unknown = await prepare(BONK, { feeLevels: 'fails' });
    expect(busy.priorityFeeLamports).toBeGreaterThan(quiet.priorityFeeLamports);
    expect(quiet.priorityFeeLamports).toBe(unknown.priorityFeeLamports);
  });

  it('a runaway fee level is capped so the whole fee stays within R4', async () => {
    const prepared = await prepare(BONK, { feeLevels: [10n ** 15n] });
    expect(prepared.priorityFeeLamports + 10_000n).toBeLessThanOrEqual(settings.maxNetworkFeeLamports);
    // Said before signing: the swap may land late or expire.
    expect(prepared.priorityFeeCapped).toBe(true);
    expect((await prepare(BONK, { feeLevels: [60_000n] })).priorityFeeCapped).toBe(false);
  });
});

describe('a Jupiter that is overloaded or silent', () => {
  /** Jupiter answers the unrestricted baseline, and `status` for every protected route (or for all). */
  const refusing = (status: number, message: string, baselineToo = true): JupiterClient => {
    const honest = fakeJupiter();
    return {
      ...honest,
      async build(p) {
        if (baselineToo || p.excludeDexes?.length) throw new JupiterError(`Jupiter ${status}: ${message}`, status);
        return honest.build(p);
      },
    };
  };

  it('a 429 is reported as busy, never as "no route fits, try another token"', async () => {
    expect(await codeOf(prepare(WSOL_MINT, { jupiter: refusing(429, 'Too many requests') }))).toBe('busy');
  });

  it('the same when only the protected routes are refused', async () => {
    expect(await codeOf(prepare(WSOL_MINT, { jupiter: refusing(429, 'Too many requests', false) }))).toBe('busy');
  });

  it('a Jupiter that does not answer is unavailable, not a broken market', async () => {
    expect(await codeOf(prepare(WSOL_MINT, { jupiter: refusing(504, '{"error":"Jupiter did not answer"}') }))).toBe('unavailable');
  });

  it("a refused key or a path that is gone is Orientim's to fix, not a missing route", async () => {
    for (const status of [401, 403, 404, 410]) {
      expect(await codeOf(prepare(WSOL_MINT, { jupiter: refusing(status, 'Unauthorized') }))).toBe('unavailable');
    }
    expect(await codeOf(prepare(WSOL_MINT, { jupiter: refusing(400, '{"error":"No routes found"}') }))).toBe('no-route');
  });

  it('a Jupiter that answers 503 is unavailable, whatever its words', async () => {
    expect(await codeOf(prepare(WSOL_MINT, { jupiter: refusing(503, '{"error":"Protected swaps are paused"}') }))).toBe('unavailable');
  });
});

describe('a swap that landed and reverted: was it the price?', () => {
  for (const version of [0, 1] as const) it(`v${version}: Jupiter's own threshold (6001) and Orientim's minimum check are the price; anything else is not`, async () => {
    const prepared = await prepare(BONK, { version });
    const message = decompileTransactionMessage(getCompiledTransactionMessageDecoder().decode(prepared.transaction.messageBytes) as never);
    const instructions = message.instructions as unknown as { programAddress: string; accounts?: { address: string }[]; data?: Uint8Array }[];
    const swap = instructions.findIndex(ix => ix.programAddress === JUPITER_PROGRAM);
    const floor = instructions.findIndex(ix =>
      ix.programAddress === TOKEN_PROGRAM && ix.data?.[0] === 12 && ix.accounts?.[0].address === ix.accounts?.[2].address);
    expect(swap).toBeGreaterThanOrEqual(0);
    expect(floor).toBeGreaterThan(swap);
    const tx = prepared.transaction;
    const onPrice = (err: unknown) => revertedOnPrice(tx, err, JUPITER_PROGRAM);
    expect(onPrice({ InstructionError: [swap, { Custom: 6001 }] })).toBe(true);
    // As the send path records it: JSON, with the chain's integers as strings.
    expect(onPrice(JSON.stringify({ InstructionError: [String(swap), { Custom: '6001' }] }))).toBe(true);
    expect(onPrice({ InstructionError: [floor, { Custom: 1 }] })).toBe(true);
    expect(onPrice({ InstructionError: [swap, { Custom: 6000 }] })).toBe(false);
    expect(onPrice({ InstructionError: [floor, { Custom: 17 }] })).toBe(false); // a frozen account
    expect(onPrice({ InstructionError: [0, { Custom: 6001 }] })).toBe(false);
    expect(onPrice('InsufficientFundsForFee')).toBe(false);
  });
});

describe('accounts frozen by the token issuer', () => {
  const TREASURY = address('9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM');

  it("a frozen fee account cannot receive the fee, so that swap is refused rather than built free (a stablecoin's blacklist, say)", async () => {
    const feeAccount = await ataOf(TREASURY, USDC);
    const frozen = await prepare(WSOL_MINT, { treasury: TREASURY, chain: [[feeAccount, tokenAccount(TREASURY, USDC, { frozen: true })]] })
      .catch((e: OrientimError) => e);
    expect((frozen as OrientimError).code).toBe('fee-unavailable');
    const open = await prepare(WSOL_MINT, { treasury: TREASURY, chain: [[feeAccount, tokenAccount(TREASURY, USDC)]] });
    expect(open.policy.fee).toBeGreaterThan(0n);
  });

  it('a frozen output account is refused with its real reason, not as a failed route', async () => {
    const error = await prepare(BONK, { frozenWOut: true }).then(() => null, (e: unknown) => e as OrientimError);
    expect(error?.code).toBe('output-account-restricted');
    expect(error?.message).toContain('frozen');
  });
});

describe("Pump's per-buyer account under E is closed after the swap and its rent returned", () => {
  const curve = () => fakeJupiter({ label: 'Pump.fun', curveProgram: true, routeAccount: true });

  it('the rent the market takes comes back to the wallet in the same transaction', async () => {
    const prepared = await prepare(BONK, { input: WSOL_MINT, amountIn: 100_000_000n, jupiter: curve(), takerRent: 1_346_200n, expectCurve: true });
    expect(prepared.policy.takerRent).toBe(1_346_200n);
    expect(prepared.policy.routeRefund).toBe(1_346_200n);
    expect(prepared.oneTimeCosts.routeRefund).toBe(1_346_200n);
    // The close and the transfer to W are the last two instructions, and the verifier passed them.
    const message = decompileTransactionMessage(getCompiledTransactionMessageDecoder().decode(prepared.transaction.messageBytes) as never);
    const [close, refund] = message.instructions.slice(-2);
    expect(close.programAddress).toBe(PUMP);
    expect(refund.programAddress).toBe(SYSTEM_PROGRAM);
    expect(refund.accounts?.[1].address).toBe(prepared.policy.owner);
    expect(prepared.certificate.routeRefundLamports).toBe(1_346_200n);
  });

  it('one more simulation than before, to check E ends with nothing, and the final one', async () => {
    const simulations = { count: 0 };
    await prepare(BONK, { input: WSOL_MINT, amountIn: 100_000_000n, jupiter: curve(), takerRent: 1_346_200n, expectCurve: true, simulations });
    expect(simulations.count).toBe(4);
  });

  it('a route that opens no such account returns nothing and adds nothing', async () => {
    const prepared = await prepare(BONK, { input: WSOL_MINT, amountIn: 100_000_000n, takerRent: 132_080n, jupiter: fakeJupiter({ label: 'Pump.fun Amm' }) });
    expect(prepared.policy.routeRefund).toBe(0n);
    expect(prepared.oneTimeCosts.routeRefund).toBe(0n);
  });

  it('rent that moves once while it is measured is measured again, and the swap is built', async () => {
    const prepared = await prepare(BONK, { input: WSOL_MINT, amountIn: 100_000_000n, jupiter: curve(), takerRent: 1_346_200n, expectCurve: true, rentMoves: 1 });
    expect(prepared.policy.takerRent).toBe(1_346_200n);
    expect(prepared.policy.routeRefund).toBe(1_346_200n);
  });

  it('rent that moves twice is measured afresh on a new quote, and no market is blamed for it', async () => {
    const prepared = await prepare(BONK, { input: WSOL_MINT, amountIn: 100_000_000n, jupiter: curve(), takerRent: 1_346_200n, expectCurve: true, rentMoves: 2 });
    expect(prepared.policy.routeRefund).toBe(1_346_200n);
    expect(prepared.attempts[0].simulation).toBe('the rent the market charges moved while it was measured');
    expect(prepared.attempts[0].blamed).toBeNull();
  });

  it('a route that spends nearly all of the rent ceiling is said as such, not blamed on the market', async () => {
    const failure = await prepare(BONK, { input: WSOL_MINT, amountIn: 100_000_000n, jupiter: curve(), takerRent: 1_346_200n, expectCurve: true, rentDeadBand: true }).catch(e => e);
    expect((failure as OrientimError).code).toBe('simulation-failed');
    expect((failure as OrientimError).message).toContain('could not be measured exactly');
  });

  it('rent that keeps moving is said as such, and no market is blamed for it', async () => {
    const failure = await prepare(BONK, { input: WSOL_MINT, amountIn: 100_000_000n, jupiter: curve(), takerRent: 1_346_200n, expectCurve: true, rentMoves: 99 }).catch(e => e);
    expect(failure).toBeInstanceOf(OrientimError);
    expect((failure as OrientimError).code).toBe('simulation-failed');
    expect((failure as OrientimError).message).toContain('could not be measured exactly');
  });

  it('a route that would keep more rent than MAX_ROUTE_KEPT_LAMPORTS, with nothing to close, is not built', async () => {
    const failure = await prepare(BONK, { input: WSOL_MINT, amountIn: 100_000_000n, takerRent: 1_346_200n, jupiter: fakeJupiter({ label: 'Pump.fun Amm' }) }).catch(e => e);
    expect(failure).toBeInstanceOf(OrientimError);
    expect((failure as OrientimError).code).toBe('no-route');
    expect((failure as OrientimError).message).toContain('keep more than 0.001 SOL of rent');
  });

  it("a cashback coin's account holds more than its rent, which no exact refund can return: refused, never left under E", async () => {
    const simulations = { count: 0 };
    const refused = await prepare(BONK, {
      input: WSOL_MINT, amountIn: 100_000_000n, jupiter: curve(), takerRent: 1_346_200n, expectCurve: true, cashback: 1_234n, simulations,
    }).catch((e: OrientimError) => e);
    expect((refused as OrientimError).code).toBe('no-route');
    expect((refused as OrientimError).message).toContain('one-time key');
    // No simulation with the close either: nothing was tried that could fail.
    expect(simulations.count).toBe(2);
  });

  it('a route that fits only without the close is never built without it: a narrower route, or a clean refusal', async () => {
    // Pad a curve route until the close no longer fits in v0: no swap is offered that leaves the
    // market's account open under E, and none is sent to the RPC oversized.
    let refusedForLeftover = 0;
    for (let n = 0; n <= 20; n++) {
      const extraAccounts = await Promise.all(Array.from({ length: n }, async () => (await generateKeyPairSigner()).address));
      const jupiter = fakeJupiter({ label: 'Pump.fun', curveProgram: true, routeAccount: true, extraAccounts });
      const outcome = await prepare(BONK, { input: WSOL_MINT, amountIn: 100_000_000n, jupiter, takerRent: 1_346_200n, expectCurve: true, version: 0 })
        .then(p => ({ p, code: 'ok' }), (e: unknown) => ({ p: null, code: e instanceof OrientimError ? e.code : String(e) }));
      // Never the RPC's raw refusal of an oversized transaction: a route that no longer fits with
      // its rent is a route that does not fit, and the pipeline says so in its own words.
      expect(['ok', 'no-route', 'simulation-failed'], `${n} extra accounts: ${outcome.code}`).toContain(outcome.code);
      if (outcome.p) expect(outcome.p.policy.routeRefund, `${n} extra accounts`).toBe(outcome.p.policy.takerRent > 0n ? 1_346_200n : 0n);
      if (outcome.code === 'no-route') refusedForLeftover++;
    }
    expect(refusedForLeftover).toBeGreaterThan(0);
    // Twenty-one full builds: about 1.6 s alone, several times that beside the whole suite.
  }, 20_000);

  it("a route too big to close the market's account is traded for a narrower one that closes it (SOL → dap)", async () => {
    // The widest padding at which the close no longer fits, found as the route that is refused.
    let pad: Address[] = [];
    for (let n = 0; n <= 20 && !pad.length; n++) {
      const extraAccounts = await Promise.all(Array.from({ length: n }, async () => (await generateKeyPairSigner()).address));
      const wide = fakeJupiter({ label: 'Pump.fun', curveProgram: true, routeAccount: true, extraAccounts });
      const outcome = await prepare(BONK, { input: WSOL_MINT, amountIn: 100_000_000n, jupiter: wide, takerRent: 1_346_200n, expectCurve: true, version: 0 })
        .then(() => 'ok', (e: OrientimError) => e.code);
      if (outcome === 'no-route') pad = extraAccounts;
    }
    expect(pad.length).toBeGreaterThan(0);
    // Asked for at most 64 accounts Jupiter offers the padded route; narrower, a route that fits with the close.
    const wide = fakeJupiter({ label: 'Pump.fun', curveProgram: true, routeAccount: true, extraAccounts: pad });
    const narrow = fakeJupiter({ label: 'Pump.fun', curveProgram: true, routeAccount: true });
    const asked: number[] = [];
    const jupiter: JupiterClient = { ...wide, build: (q: BuildParams) => { asked.push(q.maxAccounts ?? 64); return (q.maxAccounts ?? 64) >= 64 ? wide.build(q) : narrow.build(q); } };
    const prepared = await prepare(BONK, { input: WSOL_MINT, amountIn: 100_000_000n, jupiter, takerRent: 1_346_200n, expectCurve: true, version: 0 });
    expect(prepared.policy.routeRefund).toBe(1_346_200n);
    expect(asked.some(m => m < 64)).toBe(true);
  }, 30_000);

  it('without rent to pay there is no account to close', async () => {
    const prepared = await prepare(BONK, { input: WSOL_MINT, amountIn: 100_000_000n, jupiter: curve(), expectCurve: true });
    expect(prepared.policy.routeRefund).toBe(0n);
  });
});

describe('the reason is named, not blamed on the market', () => {
  it('a Jupiter instruction of a new format is a format change, not a bad price', async () => {
    const failure = await prepare(BONK, { jupiter: fakeJupiter({ unknownFormat: true }) }).catch((e: OrientimError) => e);
    expect((failure as OrientimError).code).toBe('route-format');
    expect((failure as OrientimError).message).toContain("can't read yet");
  });

  it("an input account frozen by the token's issuer is refused before anything is quoted", async () => {
    const failure = await prepare(BONK, { wIn: { frozen: true } }).catch((e: OrientimError) => e);
    expect((failure as OrientimError).code).toBe('input-account-restricted');
  });

  it('an input balance short of the amount is named, with the numbers the user typed', async () => {
    const failure = await prepare(BONK, { wIn: { amount: 250_000n }, amountIn: 1_000_000n }).catch((e: OrientimError) => e);
    expect((failure as OrientimError).code).toBe('insufficient-balance');
    expect((failure as OrientimError).message).toContain('holds 0.25 of the input token, less than the 1 this swap needs');
  });

  it("a failure in Orientim's own steps before the swap stops at once, without blaming a market", async () => {
    const simulations = { count: 0 };
    const failure = await prepare(BONK, { failBeforeSwap: true, simulations }).catch((e: OrientimError) => e);
    expect((failure as OrientimError).code).toBe('simulation-failed');
    expect((failure as OrientimError).message).toContain('before it reaches the market');
    expect(simulations.count).toBe(1);
  });
});

describe("the fee, taken like Jupiter's: SOL first, then USDC and USDT, otherwise the input token", () => {
  const TREASURY = address('9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM');
  const wallet: [string, Account] = [TREASURY, { owner: SYSTEM_PROGRAM, data: new Uint8Array(0) }];
  const lastInstruction = (prepared: Awaited<ReturnType<typeof prepare>>) =>
    (decompileTransactionMessage(getCompiledTransactionMessageDecoder().decode(prepared.transaction.messageBytes) as never)
      .instructions as unknown as { programAddress: string; accounts?: { address: string }[] }[]).at(-1)!;

  it('a sale into SOL pays in SOL, out of the output, last; the minimum shown is what the wallet keeps', async () => {
    const prepared = await prepare(WSOL_MINT, { input: BONK, treasury: TREASURY, chain: [wallet] });
    const p = prepared.policy;
    expect(p.feeSide).toBe('output');
    expect(p.swapAmount).toBe(p.amountIn);
    expect(p.fee).toBe((p.minOut * settings.feeBps) / 10_000n);
    expect(prepared.quote.minReceived).toBe(p.minOut - p.fee);
    expect(prepared.certificate.output.orientimFee).toBe(p.fee);
    expect(prepared.certificate.output.minimumOutput).toBe(p.minOut - p.fee);
    expect(prepared.certificate.input.orientimFee).toBe(0n);
    const last = lastInstruction(prepared);
    expect(last.programAddress).toBe(SYSTEM_PROGRAM);
    expect(last.accounts?.map(a => a.address)).toEqual([p.owner, TREASURY]);
  });

  it('a sale into USDC pays in USDC out of the output, when the treasury has a USDC account', async () => {
    const usdcAccount: [string, Account] = [await ataOf(TREASURY, USDC), tokenAccount(TREASURY, USDC)];
    const prepared = await prepare(USDC, { input: BONK, treasury: TREASURY, chain: [usdcAccount] });
    expect(prepared.policy.feeSide).toBe('output');
    expect(prepared.policy.accounts.feeDestination).toBe(usdcAccount[0]);
    expect(prepared.quote.minReceived).toBe(prepared.policy.minOut - prepared.policy.fee);
  });

  it("without an account for either token and no wallet, the swap is refused: the user never pays rent for the treasury's, and never swaps free", async () => {
    // USDC is on the input side here, and the treasury has no USDC account and no wallet in this chain.
    const refused = await prepare(BONK, { input: USDC, treasury: TREASURY }).catch((e: OrientimError) => e);
    expect((refused as OrientimError).code).toBe('fee-unavailable');
  });

  it("an agent's floor is what the wallet keeps: the enforced minimum covers the fee on top", async () => {
    const plain = await prepare(WSOL_MINT, { input: BONK, treasury: TREASURY, chain: [wallet] });
    const floor = plain.quote.minReceived;
    const prepared = await prepare(WSOL_MINT, { input: BONK, treasury: TREASURY, chain: [wallet], acceptedMinReceived: floor });
    expect(prepared.quote.minReceived).toBeGreaterThanOrEqual(floor);
    const failure = await prepare(WSOL_MINT, { input: BONK, treasury: TREASURY, chain: [wallet], acceptedMinReceived: floor * 2n })
      .catch((e: OrientimError) => e);
    expect((failure as OrientimError).code).toBe('price-moved');
    const moved = (failure as OrientimError).priceMoved!;
    expect(moved.newMinReceived).toBe(moved.newMinOut - (moved.newMinOut * settings.feeBps) / 10_000n);
  });

  it('a pair neither token of which can carry the fee pays it in SOL, at its value priced for the one-time key', async () => {
    const asked: BuildParams[] = [];
    const prepared = await prepare(USDC, { input: BONK, treasury: TREASURY, chain: [wallet], jupiter: fakeJupiter({ asked }) });
    expect(prepared.policy.feeSide).toBe('sol');
    const pricing = asked.find(p => p.outputMint === WSOL_MINT)!;
    // Jupiter never learns the wallet: the value is asked for the one-time key, for the whole amount.
    expect(pricing.taker).toBe(prepared.policy.ephemeral);
    expect(pricing.amount).toBe(prepared.policy.amountIn);
    expect(prepared.policy.fee).toBe((OUT * settings.feeBps) / 10_000n);
    expect(prepared.policy.swapAmount).toBe(prepared.policy.amountIn);
    expect(prepared.certificate.solFee.lamports).toBe(prepared.policy.fee);
  });

  it('without a treasury wallet, or a price in SOL, such a pair is refused, not built free; a busy Jupiter is busy', async () => {
    const noWallet = await prepare(USDC, { input: BONK, treasury: TREASURY }).catch((e: OrientimError) => e);
    expect((noWallet as OrientimError).code).toBe('fee-unavailable');
    const base = fakeJupiter();
    const pricedWith = (error: JupiterError): JupiterClient => ({
      ...base,
      build: async (p: BuildParams) => {
        if (p.outputMint === WSOL_MINT) throw error;
        return base.build(p);
      },
    });
    const unpriced = await prepare(USDC, { input: BONK, treasury: TREASURY, chain: [wallet], jupiter: pricedWith(new JupiterError('Jupiter 400: No routes found', 400)) })
      .catch((e: OrientimError) => e);
    expect((unpriced as OrientimError).code).toBe('fee-unavailable');
    expect((unpriced as OrientimError).message).toContain("can't be priced");
    const busy = await prepare(USDC, { input: BONK, treasury: TREASURY, chain: [wallet], jupiter: pricedWith(new JupiterError('Jupiter 429', 429)) })
      .catch((e: OrientimError) => e);
    expect((busy as OrientimError).code).toBe('busy');
    // A Jupiter that answered 5xx, timed out or could not be reached while pricing the fee is
    // unavailable, as for the route: try again in a moment, not a pair that cannot pay.
    for (const silent of [new JupiterError('Jupiter 502', 502), new JupiterError('Jupiter timed out', 504)]) {
      const e = await prepare(USDC, { input: BONK, treasury: TREASURY, chain: [wallet], jupiter: pricedWith(silent) }).catch((x: OrientimError) => x);
      expect((e as OrientimError).code).toBe('unavailable');
    }
    const unreachable: JupiterClient = { ...base, build: async (p: BuildParams) => { if (p.outputMint === WSOL_MINT) throw new TypeError('fetch failed'); return base.build(p); } };
    const e = await prepare(USDC, { input: BONK, treasury: TREASURY, chain: [wallet], jupiter: unreachable }).catch((x: OrientimError) => x);
    expect((e as OrientimError).code).toBe('unavailable');
  });

  it('a fee side that changes between the quote and the build keeps the minimum the page showed', async () => {
    // Quoted while the treasury had no wallet but a BONK account: the fee on the input, and the
    // page showed this minimum.
    const bonkAccount: [Address, Account] = [await ataOf(TREASURY, BONK), tokenAccount(TREASURY, BONK)];
    const quoted = await prepare(WSOL_MINT, { input: BONK, treasury: TREASURY, chain: [bonkAccount] });
    expect(quoted.policy.feeSide).toBe('input');
    const shown = quoted.quote.minReceived;
    // The treasury's wallet appears before the click: the build now takes the fee from the SOL out,
    // and still keeps what the page showed, with the market unchanged.
    const built = await prepare(WSOL_MINT, { input: BONK, treasury: TREASURY, chain: [bonkAccount, wallet], acceptedMinReceived: shown });
    expect(built.policy.feeSide).toBe('output');
    expect(built.quote.minReceived).toBeGreaterThanOrEqual(shown);
    // Handed over gross, as the page used to, the same build kept less than it showed, unasked.
    const gross = await prepare(WSOL_MINT, { input: BONK, treasury: TREASURY, chain: [bonkAccount, wallet], acceptedMinOut: shown });
    expect(gross.quote.minReceived).toBeLessThan(shown);
  });
});

/** The arguments of the Jupiter route inside a prepared transaction, as its program will read them. */
function jupiterArgsOf(prepared: { transaction: Transaction }): JupiterRouteArgs {
  const message = decompileTransactionMessage(getCompiledTransactionMessageDecoder().decode(prepared.transaction.messageBytes) as never);
  const instructions = message.instructions as unknown as { programAddress: string; data?: Uint8Array }[];
  return jupiterRouteArgs(instructions.find(ix => ix.programAddress === JUPITER_PROGRAM)?.data ?? [])!;
}

describe("Jupiter's floor, tightened to Orientim's minimum", () => {
  const ix = (quote: bigint, slippageBps: number) => {
    const d = new Uint8Array(8 + 22 + 4);
    d.set([0xbb, 0x64, 0xfa, 0xcc, 0x31, 0xc4, 0xaf, 0x14], 0);
    const v = new DataView(d.buffer);
    v.setBigUint64(8, 1_000n, true);
    v.setBigUint64(16, quote, true);
    v.setUint16(24, slippageBps, true);
    return { programAddress: JUPITER_PROGRAM, data: d };
  };
  const argsOf = (i: { data?: ArrayLike<number> }) => jupiterRouteArgs(i.data ?? [])!;

  it('lowers the tolerance just enough for the floor to reach the minimum', () => {
    const args = argsOf(withFloorAtLeast(ix(1_000_000n, 50), 999_000n));
    expect(args.slippageBps).toBe(10);
    expect(jupiterFloor(args)).toBe(999_000n);
  });

  it('a minimum equal to the quote leaves no tolerance', () => {
    expect(argsOf(withFloorAtLeast(ix(1_000_000n, 50), 1_000_000n)).slippageBps).toBe(0);
  });

  it('leaves the route alone when its floor already covers the minimum, or when nothing could', () => {
    const covered = ix(1_000_000n, 50);
    expect(withFloorAtLeast(covered, 995_000n)).toBe(covered);
    const short = ix(1_000_000n, 50);
    expect(withFloorAtLeast(short, 1_000_001n)).toBe(short);
    const unreadable = { programAddress: JUPITER_PROGRAM, data: new Uint8Array([1, 2, 3]) };
    expect(withFloorAtLeast(unreadable, 1n)).toBe(unreadable);
  });

  it('only the tolerance changes', () => {
    const before = ix(1_000_000n, 50);
    const after = withFloorAtLeast(before, 999_000n);
    const changed = [...before.data].flatMap((b, i) => (b !== after.data![i] ? [i] : []));
    expect(changed).toEqual([24]);
  });
});

describe('the smallest swap, about $1, so that none costs more to build than it brings', () => {
  const TREASURY = address('9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM');
  it('a fee in USDC below 2,500 base units (about $0.83 of swap) is refused; at $1 and more the swap is built', async () => {
    const feeAccount: [Address, Account] = [await ataOf(TREASURY, USDC), tokenAccount(TREASURY, USDC)];
    const small = await prepare(BONK, { treasury: TREASURY, chain: [feeAccount], amountIn: 500_000n, minFee: MIN_FEE }).catch((e: OrientimError) => e);
    expect((small as OrientimError).code).toBe('amount-too-small');
    expect((small as OrientimError).message).toContain('about 0.004 SOL, or $1 of USDC or USDT');
    // settings.feeBps is the test default (20): $1.5 carries 3,000 units, above the floor.
    const enough = await prepare(BONK, { treasury: TREASURY, chain: [feeAccount], amountIn: 1_500_000n, minFee: MIN_FEE });
    expect(enough.policy.fee).toBeGreaterThanOrEqual(MIN_FEE.stableUnits);
  });

  it('the whole balance of a token can always be sold, however little it is worth; a part of it below the minimum cannot', async () => {
    const feeAccount: [Address, Account] = [await ataOf(TREASURY, USDC), tokenAccount(TREASURY, USDC)];
    // 500,000 base units (about $0.50) is the wallet's whole balance: the sale is built.
    const all = await prepare(BONK, { treasury: TREASURY, chain: [feeAccount], amountIn: 500_000n, minFee: MIN_FEE, wIn: { amount: 500_000n } });
    expect(all.policy.fee).toBeGreaterThan(0n);
    // The same amount out of a larger balance is a small swap like any other.
    const part = await prepare(BONK, { treasury: TREASURY, chain: [feeAccount], amountIn: 500_000n, minFee: MIN_FEE, wIn: { amount: 900_000n } }).catch((e: OrientimError) => e);
    expect((part as OrientimError).code).toBe('amount-too-small');
    expect((part as OrientimError).message).toContain('whole balance');
  });

  it('a swap of $1 into SOL is built: its fee in SOL comes off the minimum, below the fee of exactly $1 (debugging pass)', async () => {
    // 1 USDC for 6,666,666 lamports (SOL at $150). The fee is taken from the minimum, after the 0.5%
    // tolerance, so it is a little under the fee of $1: a floor of exactly that refused this swap.
    const wallet: [Address, Account] = [TREASURY, { owner: address('11111111111111111111111111111111'), data: new Uint8Array(0) }];
    const built = await prepare(WSOL_MINT, {
      treasury: TREASURY, chain: [wallet], amountIn: 1_000_000n, minFee: MIN_FEE, jupiter: fakeJupiter({ out: 6_666_666n }),
    });
    expect(built.policy.feeSide).toBe('output');
    expect(built.policy.fee).toBeGreaterThanOrEqual(MIN_FEE.lamports);
    expect(built.policy.fee).toBeLessThan(20_000n);
  });

  it('without the setting (test mode, a deployment that wants none) nothing is refused for its size', async () => {
    const feeAccount: [Address, Account] = [await ataOf(TREASURY, USDC), tokenAccount(TREASURY, USDC)];
    const small = await prepare(BONK, { treasury: TREASURY, chain: [feeAccount], amountIn: 500_000n });
    expect(small.policy.fee).toBeGreaterThan(0n);
  });
});

describe('an account the route opens and leaves open is refused, whatever market it is', () => {
  it('the route is not offered, a route without its markets is looked for, and none left means no route', async () => {
    const opened = (await generateKeyPairSigner()).address;
    const asked: BuildParams[] = [];
    const refused = await prepare(WSOL_MINT, { jupiter: fakeJupiter({ extraAccounts: [opened], asked }), leavesOpen: [opened] }).catch((e: OrientimError) => e);
    expect((refused as OrientimError).code).toBe('no-route');
    expect((refused as OrientimError).message).toBe(LEFT_UNDER_KEY_MESSAGE);
    expect(asked.some(p => p.excludeDexes?.includes('Whirlpool'))).toBe(true);
  });

  it('the final check reads every balance from postBalances, never more than two watched accounts', async () => {
    // The fake RPC refuses more than two `accounts.addresses`, as some providers do; a Pump route
    // with its per-buyer account under E still builds.
    const jupiter = fakeJupiter({ label: 'Pump.fun', curveProgram: true, routeAccount: true });
    const prepared = await prepare(BONK, { input: WSOL_MINT, amountIn: 100_000_000n, jupiter, takerRent: 1_346_200n, expectCurve: true, version: 0 });
    expect(prepared.policy.routeRefund).toBe(1_346_200n);
  });

  it('lamports left under E in the final simulation are refused', async () => {
    const refused = await prepare(WSOL_MINT, { takerKeepsAfter: 5_000n }).catch((e: OrientimError) => e);
    expect((refused as OrientimError).code).toBe('no-route');
    expect((refused as OrientimError).message).toBe(LEFT_UNDER_KEY_MESSAGE);
  });

  it('a final simulation without balances proves nothing: nothing is built', async () => {
    const refused = await prepare(WSOL_MINT, { noPostBalances: true }).catch((e: OrientimError) => e);
    expect(refused).toBeInstanceOf(OrientimError);
    expect((refused as OrientimError).message).toContain('the RPC did not report the balances after the transaction');
  });

  it('an account the route names that is new but ends empty, or one that already existed, is no obstacle', async () => {
    const fresh = (await generateKeyPairSigner()).address;
    const built = await prepare(WSOL_MINT, { jupiter: fakeJupiter({ extraAccounts: [fresh, POOL] }) });
    expect(built.policy.minOut).toBeGreaterThan(0n);
  });
});
