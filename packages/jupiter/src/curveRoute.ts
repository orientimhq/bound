import { address, getAddressDecoder, getAddressEncoder, getProgramDerivedAddress } from '@solana/kit';
import type { Address } from '@solana/kit';
import { ATA_PROGRAM, JUPITER_PROGRAM, PUMP_CURVE_PROGRAM, SYSTEM_PROGRAM, TOKEN_2022_PROGRAM, TOKEN_PROGRAM, WSOL_MINT, ataOf } from '@orientimhq/swap/core';
import { bondingCurveOf, eventAuthorityOf, routeAccountOf } from '@orientim/builder';
import { fetchAccounts } from '@orientimhq/swap/solana';
import type { AccountState } from '@orientimhq/swap/core';
import type { SolanaRpc } from '@orientimhq/swap/solana';
import { checkBuildResponse } from './client.ts';
import type { ApiAccount, BuildParams, BuildResponse, JupiterClient } from './client.ts';

/**
 * A swap on an active Pump.fun bonding curve, built here from the chain instead of asked of Jupiter.
 *
 * A token still on its curve trades in one place only, so Jupiter's answer for it is always the same
 * single `route_v2` step through the curve, computed from the curve's reserves and Pump's fees. This
 * builds that answer itself, byte for byte as Jupiter does (tools/canary.ts compares the two on every
 * run), and saves the round trip to Jupiter on the swaps where the price moves fastest.
 *
 * Nothing is trusted more for being built here: the answer goes through `checkBuildResponse` and then
 * through the same pipeline as Jupiter's, the verifier and the final simulation included. Anything this
 * does not know to be built the way Jupiter builds it is left to Jupiter: another market or quote
 * token, a cashback or holder-reward coin, a creator fee of the curve's own, a fee schedule with more than one tier, a
 * classic SPL mint, a sell paid to an account of its own, a buy the curve cannot fill, Jupiter's fast
 * mode, a narrower account budget, and every error.
 */

/** Jupiter's label for the curve, which the pipeline reads (`isCurveRoute`). */
const LABEL = 'Pump.fun';
/** Pump's fee program, whose `fee_config` for the curve program holds the trading fees. */
const PUMP_FEES_PROGRAM = address('pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ');
const LOOKUP_TABLE_PROGRAM = address('AddressLookupTab1e1111111111111111111111111');
/** The lookup table Jupiter gives every curve route. */
export const CURVE_LOOKUP_TABLE = address('3oy9ojnsDzqmMNi87Gs7Hn5v3MPVqnWjG9k8BmzKR7yW');
/** The account budget Jupiter's curve route was compared at; a narrower one is asked of Jupiter. */
export const LOCAL_CURVE_MIN_ACCOUNTS = 64;
/** How long Pump's global account, its fee config and the lookup table are reused. */
const SHARED_MS = 60_000;

// Anchor account discriminators: sha256("account:<Name>")[0..8].
const CURVE_DISCRIMINATOR = '17b7f83760d8ac60';
const GLOBAL_DISCRIMINATOR = 'a7e8e8b1c86c727f';
const FEE_CONFIG_DISCRIMINATOR = '8f3492bbdb7b4c9b';
/** Jupiter's `route_v2` instruction. */
const ROUTE_V2 = 'bb64facc31c4af14';
/** Jupiter's swap variants for the curve's buy_v3 and sell_v3: PumpWrappedBuyV7, PumpWrappedSellV6. */
const BUY_STEP = [191, 1, 0]; // allow_partial_fill = true, close_user_volume_accumulator = false
const SELL_STEP = [192, 0]; //   close_user_volume_accumulator = false
const BPS = 10_000n;
const U64_MAX = 2n ** 64n - 1n;

const hex = (b: Uint8Array, from: number, to: number) => Buffer.from(b.subarray(from, to)).toString('hex');
const u64 = (b: Uint8Array, at: number) => Buffer.from(b.buffer, b.byteOffset, b.byteLength).readBigUInt64LE(at);
const key = (b: Uint8Array, at: number) => getAddressDecoder().decode(b.subarray(at, at + 32));
const ceilDiv = (a: bigint, b: bigint) => (a + b - 1n) / b;
const seed = (s: string) => new TextEncoder().encode(s);

export type Curve = { virtualToken: bigint; virtualQuote: bigint; realToken: bigint; realQuote: bigint };
export type CurveFees = { protocolBps: bigint; creatorBps: bigint };

/**
 * The bonding curve, or why this does not build on it. Offsets per Pump's IDL: the reserves, then
 * `complete` at 48, `is_mayhem_mode` at 81, `is_cashback_coin` at 82, `quote_mint` at 83,
 * `creator_fee_bps` at 115 and `is_holder_reward` at 124. A mayhem coin trades through the same
 * accounts and fees; a holder-reward coin has not been compared with Jupiter's route.
 */
export function readCurve(state: AccountState | null | undefined): Curve | string {
  if (!state || state.owner !== PUMP_CURVE_PROGRAM) return 'no curve';
  const d = state.data;
  if (d.length < 125 || hex(d, 0, 8) !== CURVE_DISCRIMINATOR) return 'unknown curve layout';
  if (d[48] !== 0) return 'curve complete';
  if (d[82] !== 0) return 'cashback coin';
  if (d[124] !== 0) return 'holder-reward coin';
  if (d.subarray(83, 115).some(x => x !== 0)) return 'quoted in another token';
  if (u64(d, 115) !== 0n) return "the curve's own creator fee";
  const curve = { virtualToken: u64(d, 8), virtualQuote: u64(d, 16), realToken: u64(d, 24), realQuote: u64(d, 32) };
  if (!curve.virtualToken || !curve.virtualQuote) return 'empty curve';
  return curve;
}

/**
 * The fees of a curve trade, or why not: `fee_config` holds flat fees and market-cap tiers. Only the
 * schedule seen so far is built here, a single tier from zero, with no LP fee; a schedule with more
 * tiers is Jupiter's to price until it has been compared.
 */
export function readFees(state: AccountState | null | undefined): CurveFees | string {
  if (!state || state.owner !== PUMP_FEES_PROGRAM) return 'no fee config';
  const d = state.data;
  // discriminator 8, bump 1, admin 32, flat fees 3 × u64, then the tiers: u32 count, each u128 + 3 × u64.
  const tiersAt = 8 + 1 + 32 + 24;
  if (d.length < tiersAt + 4 + 40 || hex(d, 0, 8) !== FEE_CONFIG_DISCRIMINATOR) return 'unknown fee config layout';
  if (Buffer.from(d.buffer, d.byteOffset, d.byteLength).readUInt32LE(tiersAt) !== 1) return 'fee tiers changed';
  const tier = tiersAt + 4;
  if (u64(d, tier) !== 0n || u64(d, tier + 8) !== 0n || u64(d, tier + 16) !== 0n) return 'fee tiers changed';
  const fees = { protocolBps: u64(d, tier + 24), creatorBps: u64(d, tier + 32) };
  if (fees.protocolBps > 1_000n || fees.creatorBps > 1_000n) return 'fees out of range';
  return fees;
}

/** The eight accounts a curve trade may pay Pump's buyback share to (`global.buyback_fee_recipients`). */
export function readBuybackRecipients(state: AccountState | null | undefined): Address[] | string {
  if (!state || state.owner !== PUMP_CURVE_PROGRAM) return 'no global account';
  const d = state.data;
  if (d.length < 741 + 8 * 32 || hex(d, 0, 8) !== GLOBAL_DISCRIMINATOR) return 'unknown global layout';
  const recipients = Array.from({ length: 8 }, (_, i) => key(d, 741 + 32 * i));
  return recipients.some(r => r === SYSTEM_PROGRAM) ? 'buyback recipients missing' : recipients;
}

/** An address lookup table's addresses, or why not: it must still be active. */
export function readLookupTable(state: AccountState | null | undefined): Address[] | string {
  if (!state || state.owner !== LOOKUP_TABLE_PROGRAM) return 'no lookup table';
  const d = state.data;
  if (d.length < 56 || (d.length - 56) % 32 !== 0) return 'unknown lookup table layout';
  if (u64(d, 4) !== U64_MAX) return 'lookup table deactivated';
  return Array.from({ length: (d.length - 56) / 32 }, (_, i) => key(d, 56 + 32 * i));
}

/**
 * Tokens out for `lamports` in, as Jupiter quotes the curve's buy_v3: the fees come off the input
 * first, rounded up, and the curve then pays out at its virtual reserves for one lamport less.
 */
export function quoteBuy(c: Curve, lamports: bigint, f: CurveFees): bigint {
  let net = (lamports * BPS) / (BPS + f.protocolBps + f.creatorBps);
  const total = net + ceilDiv(net * f.protocolBps, BPS) + ceilDiv(net * f.creatorBps, BPS);
  if (total > lamports) net -= total - lamports;
  const k = net - 1n;
  return k > 0n ? (c.virtualToken * k) / (c.virtualQuote + k) : 0n;
}

/** Lamports out for `tokens` in, as Jupiter quotes the curve's sell_v3: the fees come off the proceeds. */
export function quoteSell(c: Curve, tokens: bigint, f: CurveFees): { gross: bigint; out: bigint } {
  const gross = (tokens * c.virtualQuote) / (c.virtualToken + tokens);
  return { gross, out: gross - ceilDiv(gross * f.protocolBps, BPS) - ceilDiv(gross * f.creatorBps, BPS) };
}

type Shared = { at: number; fees: CurveFees; buyback: Address[]; table: Address[] };

export type LocalCurveOptions = {
  now?: () => number;
  /** Picks which buyback recipient a trade pays: Pump accepts any of the eight. */
  random?: () => number;
  /** Told why a curve swap was left to Jupiter when that was not expected. */
  onFallback?: (reason: string) => void;
  /** Told of each route built here. */
  onLocal?: (r: BuildResponse) => void;
};

/**
 * `jupiter`, with the swaps on an active Pump.fun curve built locally from `rpc`. Only a request
 * carrying `pumpCurve` (the curve the pipeline read as active for this pair) is considered; any other
 * goes to `jupiter` unchanged, and so does every curve swap this cannot build exactly as Jupiter does.
 */
export function withLocalCurveRoutes(jupiter: JupiterClient, rpc: SolanaRpc, opts: LocalCurveOptions = {}): JupiterClient {
  return localCurveRoutes(opts)(jupiter, rpc);
}

/**
 * `withLocalCurveRoutes` for many clients, with one cache of Pump's global account, its fee config
 * and the lookup table between them: the clients of each request (Orientim's, or the routes an agent
 * brought) and the RPC under that request's deadline.
 */
export function localCurveRoutes(opts: LocalCurveOptions = {}): (jupiter: JupiterClient, rpc: SolanaRpc) => JupiterClient {
  const now = opts.now ?? Date.now;
  const random = opts.random ?? Math.random;
  let shared: Shared | null = null;
  const said = new Set<string>();
  const fallback = (reason: string) => {
    if (!said.has(reason)) {
      said.add(reason);
      (opts.onFallback ?? (r => console.warn(`Pump.fun curve route left to Jupiter: ${r}`)))(reason);
    }
  };

  async function local(p: BuildParams, rpc: SolanaRpc): Promise<BuildResponse | string> {
    const isBuy = p.inputMint === WSOL_MINT && p.outputMint !== WSOL_MINT;
    const isSell = p.outputMint === WSOL_MINT && p.inputMint !== WSOL_MINT;
    if (!isBuy && !isSell) return 'not a SOL pair';
    if (p.mode) return 'fast mode';
    if (p.maxAccounts < LOCAL_CURVE_MIN_ACCOUNTS) return 'narrower account budget';
    if (p.excludeDexes?.includes(LABEL)) return 'curve excluded';
    if (isSell && p.destinationTokenAccount) return 'sell to an account of its own';
    if (p.amount <= 0n || p.amount > U64_MAX) return 'amount out of range';
    if (!Number.isInteger(p.slippageBps) || p.slippageBps < 0 || p.slippageBps > 10_000) return 'slippage out of range';
    const mint = isBuy ? p.outputMint : p.inputMint;
    const curveAddress = await bondingCurveOf(mint);
    if (curveAddress !== p.pumpCurve) return 'not this pair\'s curve';

    const feeConfig = (await getProgramDerivedAddress({ programAddress: PUMP_FEES_PROGRAM, seeds: [seed('fee_config'), getAddressEncoder().encode(PUMP_CURVE_PROGRAM)] }))[0];
    const global = (await getProgramDerivedAddress({ programAddress: PUMP_CURVE_PROGRAM, seeds: [seed('global')] }))[0];
    const fresh = shared && now() - shared.at < SHARED_MS ? shared : null;
    // The curve and the mint on every build, in the same request as the rest when that is due again.
    const reads = await fetchAccounts(rpc, [curveAddress, mint, ...(fresh ? [] : [global, feeConfig, CURVE_LOOKUP_TABLE])]);
    let use = fresh;
    if (!use) {
      const fees = readFees(reads.get(feeConfig));
      const buyback = readBuybackRecipients(reads.get(global));
      const table = readLookupTable(reads.get(CURVE_LOOKUP_TABLE));
      if (typeof fees === 'string') return fees;
      if (typeof buyback === 'string') return buyback;
      if (typeof table === 'string') return table;
      shared = { at: now(), fees, buyback, table };
      use = shared;
    }
    const curve = readCurve(reads.get(curveAddress));
    if (typeof curve === 'string') return curve;
    const mintProgram = reads.get(mint)?.owner;
    // Every curve compared so far is a Token-2022 mint; a classic one is Jupiter's until compared.
    if (mintProgram !== TOKEN_2022_PROGRAM) return 'not a Token-2022 mint';

    let out: bigint;
    if (isBuy) {
      out = quoteBuy(curve, p.amount, use.fees);
      // Jupiter does not cap a buy at what is left on the curve: a quote at or past it cannot be met.
      if (out >= curve.realToken) return 'buy past what is left on the curve';
    } else {
      const sell = quoteSell(curve, p.amount, use.fees);
      if (sell.gross > curve.realQuote) return 'sell past what the curve holds';
      out = sell.out;
    }
    if (out <= 0n) return 'nothing out';
    const threshold = ceilDiv(out * (BPS - BigInt(p.slippageBps)), BPS);

    const meta = (pubkey: Address, isSigner: boolean, isWritable: boolean): ApiAccount => ({ pubkey, isSigner, isWritable });
    const taker = p.taker;
    const takerWsol = await ataOf(taker, WSOL_MINT, TOKEN_PROGRAM);
    const takerToken = await ataOf(taker, mint, mintProgram);
    const curveToken = await ataOf(curveAddress, mint, mintProgram);
    const curveWsol = await ataOf(curveAddress, WSOL_MINT, TOKEN_PROGRAM);
    const [jupiterEvents, pumpEvents, volume] = await Promise.all([
      eventAuthorityOf(JUPITER_PROGRAM), eventAuthorityOf(PUMP_CURVE_PROGRAM), routeAccountOf(PUMP_CURVE_PROGRAM, taker),
    ]);
    // Jupiter's own accounts: the source and destination sides, then the destination account (its
    // program's address when none is given), its event authority and the program.
    const destination = p.destinationTokenAccount ?? JUPITER_PROGRAM;
    const head = isBuy
      ? [meta(taker, true, false), meta(takerWsol, false, true), meta(takerToken, false, true), meta(WSOL_MINT, false, false), meta(mint, false, false), meta(TOKEN_PROGRAM, false, false), meta(mintProgram, false, false)]
      : [meta(taker, true, false), meta(takerToken, false, true), meta(takerWsol, false, true), meta(mint, false, false), meta(WSOL_MINT, false, false), meta(mintProgram, false, false), meta(TOKEN_PROGRAM, false, false)];
    head.push(meta(destination, false, !!p.destinationTokenAccount), meta(jupiterEvents, false, false), meta(JUPITER_PROGRAM, false, false));
    // The curve's buy_v3 / sell_v3 accounts, the same list for both, then the taker and Jupiter.
    const step = [
      meta(PUMP_CURVE_PROGRAM, false, false), meta(global, false, false), meta(mint, false, false), meta(WSOL_MINT, false, false),
      meta(mintProgram, false, false), meta(TOKEN_PROGRAM, false, false),
      meta(curveAddress, false, true), meta(curveToken, false, true), meta(curveWsol, false, true),
      meta(taker, false, true), meta(takerToken, false, true), meta(takerWsol, false, true),
      meta(volume, false, true), meta(feeConfig, false, false),
      meta(use.buyback[Math.min(7, Math.floor(random() * 8))]!, false, true),
      meta(SYSTEM_PROGRAM, false, false), meta(pumpEvents, false, false), meta(PUMP_CURVE_PROGRAM, false, false),
      meta(taker, true, true), meta(JUPITER_PROGRAM, false, false),
    ];

    // route_v2: in, quoted out, slippage, platform fee 0, positive slippage 0, then one step at 100%
    // from input 0 to output 1.
    const data = Buffer.alloc(34);
    Buffer.from(ROUTE_V2, 'hex').copy(data, 0);
    data.writeBigUInt64LE(p.amount, 8);
    data.writeBigUInt64LE(out, 16);
    data.writeUInt16LE(p.slippageBps, 24);
    data.writeUInt32LE(1, 30);
    const swapData = Buffer.concat([data, Buffer.from(isBuy ? BUY_STEP : SELL_STEP), Buffer.from([0x10, 0x27, 0, 1])]);

    // The taker's accounts, opened if missing: its wrapped SOL, and on a buy the token account.
    const open = (account: Address, tokenMint: Address, program: Address) => ({
      programId: ATA_PROGRAM,
      accounts: [meta(taker, true, true), meta(account, false, true), meta(taker, false, false), meta(tokenMint, false, false), meta(SYSTEM_PROGRAM, false, false), meta(program, false, false)],
      data: 'AQ==',
    });
    const setupInstructions = isBuy ? [open(takerWsol, WSOL_MINT, TOKEN_PROGRAM), open(takerToken, mint, mintProgram)] : [open(takerWsol, WSOL_MINT, TOKEN_PROGRAM)];

    // Jupiter's price impact counts the fee; this one is against the curve's price before the trade.
    const spotOut = isBuy ? (p.amount * curve.virtualToken) / curve.virtualQuote : (p.amount * curve.virtualQuote) / curve.virtualToken;
    const impact = spotOut > 0n ? Number(((spotOut - out) * 1_000_000_000_000n) / spotOut) / 1e12 : 0;

    return checkBuildResponse({
      inputMint: p.inputMint,
      outputMint: p.outputMint,
      inAmount: p.amount.toString(),
      outAmount: out.toString(),
      otherAmountThreshold: threshold.toString(),
      swapMode: 'ExactIn',
      slippageBps: p.slippageBps,
      priceImpactPct: String(impact),
      routePlan: [{
        percent: 100, bps: 10_000,
        swapInfo: { ammKey: curveAddress, label: LABEL, inputMint: p.inputMint, outputMint: p.outputMint, inAmount: p.amount.toString(), outAmount: out.toString() },
      }],
      computeBudgetInstructions: [],
      setupInstructions,
      swapInstruction: { programId: JUPITER_PROGRAM, accounts: [...head, ...step], data: swapData.toString('base64') },
      cleanupInstruction: null,
      otherInstructions: [],
      addressesByLookupTableAddress: { [CURVE_LOOKUP_TABLE]: use.table },
    });
  }

  // Left to Jupiter as expected: nothing to say.
  const EXPECTED = new Set(['not a SOL pair', 'fast mode', 'narrower account budget', 'curve excluded', 'sell to an account of its own', 'curve complete', 'no curve', 'cashback coin', 'holder-reward coin', 'quoted in another token', 'buy past what is left on the curve', 'sell past what the curve holds']);

  return (jupiter, rpc) => ({
    ...jupiter,
    async build(p) {
      if (!p.pumpCurve) return jupiter.build(p);
      let built: BuildResponse | string;
      try {
        built = await local(p, rpc);
      } catch (e) {
        built = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
      }
      if (typeof built !== 'string') {
        opts.onLocal?.(built);
        return built;
      }
      if (!EXPECTED.has(built)) fallback(built);
      return jupiter.build(p);
    },
  });
}
