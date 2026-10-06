import {
  address, assertIsFullySignedTransaction, decompileTransactionMessage, fetchAddressesForLookupTables, getBase64Decoder,
  getCompiledTransactionMessageDecoder, getTransactionDecoder, isSolanaError, partiallySignTransaction,
  SOLANA_ERROR__TRANSACTION__TOO_MANY_ACCOUNT_ADDRESSES,
} from '@solana/kit';
import type { Address, FullySignedTransaction, Instruction, KeyPairSigner, Transaction } from '@solana/kit';
import {
  ABSOLUTE_MAX_NETWORK_FEE_LAMPORTS, ATA_PROGRAM, buildPolicy, compileProtectedSwap, LEGACY_SIZE_LIMIT,
  MAX_COMPUTE_UNITS, TOKEN_2022_ACCOUNT_SIZE, TOKEN_2022_PROGRAM, TOKEN_ACCOUNT_RENT_UPPER_ORIENTIM_LAMPORTS,
  LAMPORTS_PER_SIGNATURE, MAX_ROUTE_KEPT_LAMPORTS, MAX_TAKER_RENT_LAMPORTS, TOKEN_ACCOUNT_SIZE, TOKEN_PROGRAM, tokenAccountSizeFor, tokenAmountOf, withTakerRent,
  V1_MAX_ACCOUNTS, V1_SIZE_LIMIT, variantOf, withMinOut, WSOL_MINT, USDC_MINT, USDT_MINT, ataOf, PUMP_CURVE_PROGRAM as CURVE_PROGRAM,
  PUMP_AMM_PROGRAM, eventAuthorityOf, routeAccountOf, withRouteRefund, FEE_TOKENS, feeSideFor, minimumForReceived, minimumReceived, outputFeeFor,
} from '@orientim/core';
import type { OrientimConfig, IntermediateAta, Lifetime, Policy, RouteRefund, TxVersion, Violation } from '@orientim/core';
import { fetchAccounts, fetchSnapshot, isInfrastructureProgram, mintInfoOf, simulate } from '@orientim/solana';
import {
  certify, hasTransferFee, jupiterFloor, jupiterRouteArgs, MAX_ADDED_COMPUTE_UNITS, memoRequired, transferFeeOf, transferFeeOn, unsupportedExtension,
  verifyWalletReturn,
} from '@orientim/verifier';
import type { Certificate } from '@orientim/verifier';
import type { SendResult, SendStatus, Simulation, SolanaRpc } from '@orientim/solana';
import { JupiterError, toKitInstruction } from './client.ts';
import { PROVIDED_ROUTE_TOLERANCE_BPS, ROUTE_LEVELS, RoutesNeeded, RoutesUntrusted } from './provided.ts';
import type { ApiInstruction, BuildResponse, JupiterClient } from './client.ts';
import type { PriorityFeeLevel } from './priorityFee.ts';

export type SwapSettings = OrientimConfig & {
  /** DEXes that charge the taker persistent rent. */
  excludeDexes: readonly string[];
  slippageBps: number;
  /**
   * The slippage on a route that trades on a Pump.fun bonding curve. A token there trades in one
   * place only and moves fast: T14 saw it move past 0.5% in the seconds between building a swap and
   * executing it, which reverts the swap and costs the user the network fee for nothing.
   */
  curveSlippageBps: number;
  /**
   * A tolerance the agent chose in `slippageBps` (its own, Jupiter's estimate on "auto", or its owner's
   * ceiling), for every route, curve or not: the route is built at it and the verifier holds it to it,
   * never above 15% (MAX_CHOSEN_SLIPPAGE_BPS). Unset: `slippageBps`, or `curveSlippageBps` on a curve.
   */
  chosenSlippageBps?: number;
  /**
   * How far below the unrestricted route a protected one may sit. Under `askAboveBps` the
   * swap proceeds; above it the user is told the difference and decides, with a stronger warning
   * past `warnAboveBps`. Orientim refuses on its own only past `badQuoteBps`, where the number is no
   * longer a price but a broken or manipulated answer.
   *
   * Orientim does not block a trade it merely dislikes: a user who understands the difference and
   * still wants the guarantee is entitled to it.
   */
  askAboveBps: bigint;
  warnAboveBps: bigint;
  badQuoteBps: bigint;
  maxRepairAttempts: number;
  /** v0 priority price; v1 uses `priorityFeeLamports`. */
  microLamportsPerComputeUnit: bigint;
  priorityFeeLamports: bigint;
  /**
   * The smallest fee a swap may carry, so that every swap pays for what building it costs (about $1
   * of swap at 0.25%): in lamports when it is paid in SOL, in base units when in USDC or USDT. A fee
   * in another token has no price here and is not held to it. None when unset (tests, test mode).
   */
  minFee?: { lamports: bigint; stableUnits: bigint };
};

/**
 * The smallest fee Orientim takes, and so the smallest swap it builds: 2,500 base
 * units of USDC or USDT (the fee of about $0.83), 10,000 lamports of SOL (the fee of $0.50 to $1 while
 * SOL is worth $150 to $300). It sits below the fee of $1 on purpose: a fee on the output is taken
 * from the minimum, after the tolerance, and a fee in SOL follows SOL's price, so a floor at exactly
 * $1 refused swaps of about $1 (debugging pass, 25 September 2026).
 */
export const MIN_FEE = { lamports: 10_000n, stableUnits: 2_500n } as const;
export const MIN_SWAP_MESSAGE = "This amount is below the smallest swap Orientim takes: about 0.004 SOL, or $1 of USDC or USDT (for two other tokens, their value in SOL). Swap a larger amount. Selling the whole balance of a token (not SOL) is allowed at any size.";

/** Is a fee of `fee` in `feeMint` below the smallest one `minFee` allows? */
function belowMinFee(fee: bigint, feeMint: Address, minFee: SwapSettings['minFee']): boolean {
  if (!minFee) return false;
  if (feeMint === WSOL_MINT) return fee < minFee.lamports;
  if (feeMint === USDC_MINT || feeMint === USDT_MINT) return fee < minFee.stableUnits;
  return false;
}
const feeMintOf = (p: Pick<Policy, 'feeSide' | 'inputMint' | 'outputMint'>): Address =>
  p.feeSide === 'output' ? p.outputMint : p.feeSide === 'input' ? p.inputMint : WSOL_MINT;

export const DEFAULT_SETTINGS: Omit<SwapSettings, 'treasury' | 'jupiterProgram'> = {
  feeBps: 25n,
  // 0.0005 SOL. Under congestion 0.0002 SOL clipped the priority fee and swaps expired more often
  // than elsewhere; the verifier's own ceiling stays 0.001 SOL.
  maxNetworkFeeLamports: 500_000n,
  // HumidiFi opens a per-taker account whose rent (about 0.013 SOL) would be lost on every swap.
  // Pump.fun's two markets, PumpSwap and the bonding curve, do the same for about 0.0013–0.0015
  // SOL, which Orientim pays through `takerRent` and shows.
  excludeDexes: ['HumidiFi'],
  slippageBps: 50,
  curveSlippageBps: 300,
  // 0.5%: a silent cost of 1% would be five times Orientim's own fee. T9 measured 90% of protected
  // routes within 0.26% of the market, so most swaps still go through without a question.
  askAboveBps: 50n,
  warnAboveBps: 500n,
  badQuoteBps: 5_000n,
  maxRepairAttempts: 4,
  microLamportsPerComputeUnit: 50_000n,
  priorityFeeLamports: 10_000n,
};

const MAX_ACCOUNTS_LEVELS: readonly number[] = ROUTE_LEVELS;

export type SwapRequest = {
  owner: Address;
  ephemeral: KeyPairSigner;
  inputMint: Address;
  outputMint: Address;
  /** Base units of the input token, as the user accepted them. */
  amountIn: bigint;
  /**
   * The decimals the interface used to turn what the user typed into `amountIn` and to show
   * amounts. They must equal the mints' on-chain decimals, or nothing is built.
   */
  inputDecimals: number;
  outputDecimals: number;
  /**
   * The minimum the user saw and accepted before clicking. Orientim enforces at least
   * this on chain. When the market no longer supports it, nothing is built: prepare stops with
   * `price-moved` and the new minimum, and the user decides.
   */
  acceptedMinOut?: bigint;
  /**
   * The same floor stated as what the wallet keeps, after a fee taken from the output (the agent
   * API's `minOut`). Converted to the minimum the swap must enforce once the fee's side is known.
   */
  acceptedMinReceived?: bigint;
  /**
   * A quote already showed a route through a Pump.fun bonding curve. Jupiter is then asked
   * at the curve tolerance first, which saves the second request (latency). Only a hint: a route
   * that turns out not to be a curve route is asked for again at the usual tolerance.
   */
  expectCurve?: boolean;
  /**
   * How much worse than the unrestricted market price the user has agreed the protected route may
   * be, in bps. Without it, a route more than `askAboveBps` below the market stops with
   * `costs-more`, and the agent asks its user.
   */
  acceptedCostBps?: bigint;
  version: TxVersion;
  /** Opt-in beta route search; the market-price baseline stays on standard routing. */
  routingMode?: 'fast';
};

export type Attempt = { excluded: string[]; route: string[]; simulation: 'ok' | string; blamed: string | null };

export type PreparedSwap = {
  policy: Policy;
  version: TxVersion;
  transaction: Transaction;
  /** The slot the blockhash was read at; a wallet's own simulation should not use older state. */
  contextSlot: bigint;
  lifetime: Lifetime;
  size: number;
  computeUnits: number;
  /** `minOut` is enforced by Orientim's own check after the swap, not only by Jupiter. */
  quote: {
    inAmount: bigint; outAmount: bigint; minOut: bigint; route: string[]; priceImpactPct: number | null; baselineOut: bigint;
    /** What the wallet keeps at least: `minOut`, less a fee taken from the output. What to show. */
    minReceived: bigint;
    /** How far below the unrestricted route this one sits, in bps: the cost of the protection. */
    gapBps: bigint;
  };
  /** Rent this transaction moves out of W beyond the network fee, to show before signing. */
  /**
   * `routeRent`: SOL the route keeps as rent for an account it opens in the temporary key's name
   * (Pump.fun's per-buyer account). It does not come back, and it is shown before signing.
   */
  /**
   * `routeRefund`: what closing that account after the swap returns to the wallet in the same
   * transaction; `routeRent` less `routeRefund` is what the market keeps.
   */
  oneTimeCosts: { outputAccountRent: bigint; routeRent: bigint; routeRefund: bigint };
  /** W_out's balance the minimum-output check was built on (B and C), to spot a stale build. */
  outputBalanceBefore: bigint;
  /** The priority fee this message pays, in lamports, chosen from recent fees (within R4). */
  priorityFeeLamports: bigint;
  /**
   * The network asked for a higher priority fee than the limit allows, so this one was capped: the
   * swap may take longer to land, or expire without executing.
   */
  priorityFeeCapped: boolean;
  /** The network fee of this exact message, as the cluster prices it. */
  networkFeeLamports: bigint;
  /** Side effects the user should be told about before signing. */
  notices: { removesDelegate: boolean };
  /**
   * A tax the input token itself charges on every transfer, and what Orientim's extra hop costs
   * because of it. The money goes to whoever the mint's fee authority is, never to Orientim.
   */
  tokenTax: { inputBps: number; extraOnInput: bigint } | null;
  /** Temporary ATA(E, m) accounts the route uses; each is created and closed in the transaction. */
  intermediates: IntermediateAta[];
  /** What the verified transaction does, bound to its exact bytes (idea 35). */
  certificate: Certificate;
  /** Diagnostic durations; Jupiter calls may overlap, so their sum is not wall-clock time. */
  timings: {
    totalMs: number; localMs: number; initialMs: number;
    jupiterBuildMs: number; jupiterBuildCalls: number;
    simulationMs: number; simulationCalls: number; verificationMs: number;
  };
  attempts: Attempt[];
};

export type OrientimErrorCode =
  | 'unsupported-token' | 'token-data-mismatch' | 'output-account-restricted' | 'no-route' | 'bad-quote' | 'price-moved'
  | 'insufficient-sol'
  | 'costs-more' | 'simulation-failed'
  | 'verification-failed' | 'wallet-changed-transaction' | 'expired'
  // The wallet's own account for the input token cannot send the amount.
  | 'insufficient-balance' | 'input-account-restricted'
  // Jupiter refused with 429 or did not answer: says nothing about the route or the token.
  | 'busy' | 'unavailable'
  // Jupiter answered with an instruction Orientim cannot read: its format changed.
  | 'route-format'
  // Orientim's fee cannot be collected on this swap, so it is not built.
  | 'fee-unavailable' | 'amount-too-small';

/** The treasury wallet does not exist yet (or cannot receive): Orientim's to fix, not the user's. */
export const FEE_UNAVAILABLE_MESSAGE = "Orientim's fee can't be collected right now, so nothing was built. Your funds are not affected; try again later.";
/** No token of the pair can carry the fee and Jupiter could not price it in SOL. */
export const FEE_UNPRICED_MESSAGE = "Orientim's fee for this pair can't be priced right now, so nothing was built. Try again in a moment.";
export const AMOUNT_TOO_SMALL_MESSAGE = "This amount is too small to carry Orientim's fee. Swap a larger amount.";
/** A route that would leave lamports or tokens under the one-time key, which is discarded after the swap. */
export const LEFT_UNDER_KEY_MESSAGE = "This swap's route would leave a market's deposit under the swap's one-time key, where it would be lost, so nothing was built. Another amount or pair may route differently.";

export const RENT_MOVED_MESSAGE = "The rent this market asks of a new buyer could not be measured exactly: it moved while Orientim measured it, or it is close to the 0.005 SOL Orientim allows. No funds were moved; try again in a moment.";
export const ROUTE_KEEPS_RENT_MESSAGE = "This swap's route would keep more than 0.001 SOL of rent for accounts it opens and does not close, so nothing was built. Another amount or pair may route differently.";

/** What the user reads when Jupiter is overloaded or silent; the swap itself was never at fault. */
export const BUSY_MESSAGE = 'Too many swaps are being priced right now. Wait a few seconds and try again. Nothing was signed.';
export const UNAVAILABLE_MESSAGE = "The price service didn't answer. Nothing was signed; try again in a moment.";
/** What the user reads when Jupiter's swap instruction changed: every route stops until Orientim reads it. */
export const ROUTE_FORMAT_MESSAGE = "Jupiter answered with a swap instruction Orientim can't read yet, so nothing was built and nothing was signed. Protected swaps resume once Orientim is updated for it.";

/** For `price-moved`: what the market supports now, to show the user before asking again. */
export type PriceMoved = {
  newMinOut: bigint;
  newOutAmount: bigint;
  /** `newMinOut` less a fee taken from the output: what the wallet would keep, to show and to accept. */
  newMinReceived: bigint;
};

/** For `costs-more`: how far the best protected route sits below the unrestricted one. */
/** Orientim's own price for a swap: the unrestricted output, and the minimum at its tolerance. */
export type ReferencePrice = { out: bigint; minimum: bigint };

/** What `amount` of a swap's input is worth in SOL, for a fee paid in SOL from the wallet. */
export type SolValue = { amount: bigint; value: bigint };

export type CostsMore = { gapBps: bigint; outAmount: bigint; baselineOut: bigint };

export class OrientimError extends Error {
  readonly code: OrientimErrorCode;
  readonly violations: Violation[];
  readonly priceMoved: PriceMoved | null;
  readonly costsMore: CostsMore | null;
  constructor(
    code: OrientimErrorCode,
    message: string,
    violations: Violation[] = [],
    priceMoved: PriceMoved | null = null,
    costsMore: CostsMore | null = null,
  ) {
    super(message);
    this.code = code;
    this.violations = violations;
    this.priceMoved = priceMoved;
    this.costsMore = costsMore;
  }
}

/**
 * Jupiter's setup instructions show which ATA(E, m) the route expects to exist. We never run
 * Jupiter's setup (its payer is E, who holds no SOL); we recreate these ATAs ourselves.
 */
export function intermediatesFromSetup(setup: readonly ApiInstruction[], policy: Policy): IntermediateAta[] {
  const ours = new Set<string>([policy.accounts.eIn, policy.accounts.eOut ?? '']);
  const out: IntermediateAta[] = [];
  for (const ix of setup) {
    if (ix.programId !== ATA_PROGRAM || ix.accounts.length < 6) continue;
    const [, ata, owner, mint, , tokenProgram] = ix.accounts.map(a => a.pubkey);
    if (owner !== policy.ephemeral || ours.has(ata) || out.some(x => x.ata === ata)) continue;
    out.push({ ata: address(ata), mint: address(mint), tokenProgram: address(tokenProgram) });
  }
  return out;
}

/**
 * Programs that open an account in the taker's name and charge it the rent: both Pump.fun markets.
 * A route through one goes straight to measuring that rent, skipping a simulation known to fail.
 * Only a shortcut: any other route that needs rent is still found by its failed simulation.
 */
const RENT_CHARGING_PROGRAMS = new Set(['6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P', 'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA']);

/** The 75th percentile of recent priority fees, in micro-lamports per compute unit; null if none. */
export function recentFeeLevel(fees: readonly { prioritizationFee: bigint | number }[]): bigint | null {
  if (!fees.length) return null;
  const sorted = fees.map(f => BigInt(f.prioritizationFee)).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.75))];
}

/**
 * The account a Pump market opens for E in this route, when Jupiter passes it to the swap: its
 * program, the account (PDA["user_volume_accumulator", E]) and the program's event authority.
 */
async function routeAccountIn(r: BuildResponse, E: Address): Promise<Omit<RouteRefund, 'lamports'> | null> {
  for (const program of [CURVE_PROGRAM, PUMP_AMM_PROGRAM]) {
    if (!r.swapInstruction.accounts.some(a => a.pubkey === program)) continue;
    const account = await routeAccountOf(program, E);
    if (r.swapInstruction.accounts.some(a => a.pubkey === account)) return { program, account, eventAuthority: await eventAuthorityOf(program) };
  }
  return null;
}

/** Jupiter's label for the Pump.fun bonding curve; PumpSwap, after it, is `Pump.fun Amm`. */
export const BONDING_CURVE_LABEL = 'Pump.fun';
/** The Pump.fun bonding-curve program, which a route through the curve invokes. */
export { PUMP_CURVE_PROGRAM } from '@orientim/core';

type Slippages = Pick<SwapSettings, 'slippageBps' | 'curveSlippageBps' | 'chosenSlippageBps'>;

/**
 * Does this route trade on a Pump.fun bonding curve? Jupiter's label says so, and the curve program
 * must also be among the swap instruction's accounts: a label alone is Jupiter's word, unchecked,
 * and it would widen the tolerance of any route it was put on.
 */
/**
 * Jupiter's price impact as a fraction (negative when the route beats the reference price), or null
 * when it is missing or not a number: unknown, never read as none.
 */
export function priceImpactOf(v: unknown): number | null {
  if (typeof v === 'number' ? !Number.isFinite(v) : typeof v !== 'string' || v.trim() === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

export function isCurveRoute(r: Pick<BuildResponse, 'routePlan' | 'swapInstruction'>): boolean {
  return r.routePlan.some(p => p.swapInfo.label === BONDING_CURVE_LABEL)
    && r.swapInstruction.accounts.some(a => a.pubkey === CURVE_PROGRAM);
}

/**
 * The slippage Orientim accepts on a route: the bonding-curve one when the route trades on a Pump.fun
 * bonding curve, the usual one otherwise. Either way Orientim computes the floor itself and enforces it
 * on chain.
 */
export function slippageFor(r: Pick<BuildResponse, 'routePlan' | 'swapInstruction'>, settings: Slippages): number {
  if (settings.chosenSlippageBps !== undefined) return settings.chosenSlippageBps;
  return isCurveRoute(r) ? settings.curveSlippageBps : settings.slippageBps;
}

/**
 * The minimum to show for a quote Jupiter gave at the usual tolerance. A curve route is built at the
 * curve tolerance, so its minimum is computed at that tolerance here, and the stricter threshold of
 * this quote is not the one that will be enforced.
 */
export function quotedMinimum(
  r: Pick<BuildResponse, 'routePlan' | 'swapInstruction' | 'outAmount' | 'otherAmountThreshold'>,
  settings: Slippages,
): bigint {
  // A chosen tolerance is the one the quote was asked at, for any route.
  if (settings.chosenSlippageBps !== undefined) return routeFloor(r, settings.chosenSlippageBps);
  return isCurveRoute(r) ? minimumOutput(BigInt(r.outAmount), settings.curveSlippageBps) : routeFloor(r, settings.slippageBps);
}

/**
 * The minimum Orientim enforces for a route: the quoted output less the slippage the user
 * accepted, computed here and rounded down. Jupiter's own threshold can only make it stricter, never
 * weaker, so an answer with a tiny `otherAmountThreshold` cannot lower the floor.
 */
export function minimumOutput(outAmount: bigint, slippageBps: number): bigint {
  return (outAmount * BigInt(10_000 - slippageBps)) / 10_000n;
}

export function routeFloor(r: Pick<BuildResponse, 'outAmount' | 'otherAmountThreshold'>, slippageBps: number): bigint {
  const local = minimumOutput(BigInt(r.outAmount), slippageBps);
  const quoted = BigInt(r.otherAmountThreshold);
  return quoted > local ? quoted : local;
}

/**
 * Orientim has one minimum-output model, regardless of what a router calls its own threshold: an exact
 * token amount that Orientim puts into the transaction and the verifier checks on the exact bytes.
 * A router threshold may make it stricter but never weaker, and a previously accepted user floor
 * may make it stricter again. Router-only or off-chain guarantees are not accepted as substitutes.
 */
export function strictMinimumOutput(
  r: Pick<BuildResponse, 'outAmount' | 'otherAmountThreshold'>,
  slippageBps: number,
  acceptedMinOut = 0n,
): bigint {
  const route = routeFloor(r, slippageBps);
  return acceptedMinOut > route ? acceptedMinOut : route;
}

/**
 * The fee in lamports for a swap no token of which can carry it: `feeBps` of what `amount` of the
 * input is worth in SOL, as Jupiter prices it for the one-time key (never the wallet). Undefined when
 * Jupiter cannot price it, or answers for another trade: with a treasury, the swap is then refused
 * (`fee-unavailable`), never built for free. A busy Jupiter is busy, and a silent one unavailable,
 * as for the route itself.
 */
export async function feeInSol(
  jupiter: JupiterClient,
  args: { inputMint: Address; amount: bigint; taker: Address; slippageBps: number; feeBps: bigint },
): Promise<bigint | undefined> {
  const value = await solValueOf(jupiter, args);
  return value === undefined ? undefined : (value * args.feeBps) / 10_000n;
}

/** What `amount` of the input is worth in SOL, as Jupiter prices it for the one-time key (see `feeInSol`). */
export async function solValueOf(
  jupiter: JupiterClient,
  args: { inputMint: Address; amount: bigint; taker: Address; slippageBps: number },
): Promise<bigint | undefined> {
  try {
    const r = await jupiter.build({
      inputMint: args.inputMint, outputMint: WSOL_MINT, amount: args.amount, taker: args.taker, slippageBps: args.slippageBps, maxAccounts: 64,
    });
    if (r.inputMint !== args.inputMint || r.outputMint !== WSOL_MINT || BigInt(r.inAmount) !== args.amount || !/^\d{1,20}$/.test(r.outAmount)) {
      return undefined;
    }
    return BigInt(r.outAmount);
  } catch (e) {
    if (e instanceof JupiterError && e.status === 429) throw new OrientimError('busy', BUSY_MESSAGE);
    // Only Jupiter's refusal of the trade (a 4xx) means the pair cannot be priced. A Jupiter that did
    // not answer, answered 5xx or refused Orientim's key is unavailable, as for the route itself:
    // try again in a moment, not a pair that cannot pay the fee.
    if (!(e instanceof JupiterError) || e.status >= 500 || [401, 403, 404, 410].includes(e.status)) {
      throw new OrientimError('unavailable', UNAVAILABLE_MESSAGE);
    }
    return undefined;
  }
}

/**
 * Jupiter's instruction with its own floor raised to Orientim's minimum, when the minimum the user
 * accepted is above the route's. Jupiter's floor counts only what its
 * route delivered to the output account, so it holds when other tokens reach that account at the
 * same moment, where Orientim's balance check alone would count them. Only the tolerance changes, and
 * only as far as the minimum needs; a route whose quote is below the minimum is left for the
 * verifier to refuse.
 */
export function withFloorAtLeast(ix: Instruction, minOut: bigint): Instruction {
  const data = ix.data ?? new Uint8Array();
  const args = jupiterRouteArgs(data);
  if (!args || args.quotedOutAmount < minOut || jupiterFloor(args) >= minOut) return ix;
  // floor(quote × (10,000 − s) / 10,000) ≥ minOut exactly when s ≤ 10,000 − ceil(minOut × 10,000 / quote).
  const kept = (minOut * 10_000n + args.quotedOutAmount - 1n) / args.quotedOutAmount;
  const tightened = Uint8Array.from(data);
  new DataView(tightened.buffer).setUint16(args.slippageOffset, Number(10_000n - kept), true);
  return { ...ix, data: tightened };
}

/**
 * Is this Orientim's minimum-output check: a TransferChecked from an account to itself, under either
 * token program? TransferChecked always names source, mint and destination, so an instruction with
 * fewer accounts is not one, whatever its first data byte says.
 */
export function isMinimumOutputCheckInstruction(ix: {
  programAddress?: string;
  data?: ArrayLike<number>;
  accounts?: { address: string }[];
} | undefined): boolean {
  return (ix?.programAddress === TOKEN_PROGRAM || ix?.programAddress === TOKEN_2022_PROGRAM)
    && ix.data?.[0] === 12
    && !!ix.accounts
    && ix.accounts.length >= 3
    && ix.accounts[0].address === ix.accounts[2].address;
}

/** The program the instruction at `index` invokes, or null when it cannot be told. */
function programAt(tx: Transaction, index: number | null, lookups: Record<string, string[]> | null): string | null {
  if (index === null) return null;
  try {
    const compiled = getCompiledTransactionMessageDecoder().decode(tx.messageBytes);
    const msg = decompileTransactionMessage(compiled as never, { addressesByLookupTableAddress: (lookups ?? {}) as never });
    return (msg.instructions[index] as { programAddress?: string } | undefined)?.programAddress ?? null;
  } catch {
    return null;
  }
}

/** Lamports as SOL for a message a person reads, to four decimals. */
const solText = (lamports: bigint) => (Number(lamports) / 1e9).toFixed(4);
/** An amount in base units as the decimal number the user typed, exactly. */
const tokenText = (amount: bigint, decimals: number) => {
  const digits = amount.toString().padStart(decimals + 1, '0');
  const whole = digits.slice(0, digits.length - decimals);
  const fraction = digits.slice(digits.length - decimals).replace(/0+$/, '');
  return fraction ? `${whole}.${fraction}` : whole;
};

/** Did the simulation fail at Orientim's own minimum-output check (a self-TransferChecked)? */
function failedAtFloorCheck(tx: Transaction, index: number | null, lookups: Record<string, string[]> | null): boolean {
  if (index === null) return false;
  try {
    const compiled = getCompiledTransactionMessageDecoder().decode(tx.messageBytes);
    const msg = decompileTransactionMessage(compiled as never, { addressesByLookupTableAddress: (lookups ?? {}) as never });
    const ix = msg.instructions[index] as { programAddress: string; data?: ArrayLike<number>; accounts?: { address: string }[] };
    return isMinimumOutputCheckInstruction(ix);
  } catch {
    return false;
  }
}

/**
 * Pump.fun's own slippage errors, from both IDLs: the curve's TooMuchSolRequired (6002),
 * TooLittleSolReceived (6003) and BuySlippageBelowMinTokensOut (6042); PumpSwap's ExceededSlippage
 * (6004) and BuySlippageBelowMinBaseAmountOut (6040). Logged in hex.
 */
const PUMP_SLIPPAGE_ERRORS: readonly (readonly [string, readonly string[]])[] = [
  [CURVE_PROGRAM, ['0x1772', '0x1773', '0x179a']],
  [PUMP_AMM_PROGRAM, ['0x1774', '0x1798']],
];

/**
 * Did the route stop itself because it would deliver less than its own threshold? That is
 * Jupiter's error 6001, SlippageToleranceExceeded, or the same check inside a Pump.fun market
 * the price moved between the quote and the simulation. The market is working and
 * the quote is stale, so like a miss at Orientim's own minimum it calls for a fresh quote, not for
 * leaving the market out. On a token that trades in one place only, a Pump.fun bonding curve,
 * leaving it out means no route at all.
 */
export function routeMissedItsThreshold(logs: readonly string[], jupiterProgram: string): boolean {
  return logs.includes(`Program ${jupiterProgram} failed: custom program error: 0x1771`)
    || PUMP_SLIPPAGE_ERRORS.some(([program, codes]) =>
      codes.some(code => logs.includes(`Program ${program} failed: custom program error: ${code}`)));
}

/** Each instruction's program and account indices, from a compiled v0 or v1 message. */
function compiledInstructions(tx: Transaction): { program: string | undefined; accounts: number[]; data?: ArrayLike<number> }[] {
  const m = getCompiledTransactionMessageDecoder().decode(tx.messageBytes) as unknown as {
    staticAccounts: string[];
    instructions?: { programAddressIndex: number; accountIndices?: number[]; data?: ArrayLike<number> }[];
    instructionHeaders?: { programAccountIndex: number }[];
    instructionPayloads?: { instructionAccountIndices: number[]; instructionData: ArrayLike<number> }[];
  };
  if (m.instructions) {
    return m.instructions.map(ix => ({ program: m.staticAccounts[ix.programAddressIndex], accounts: ix.accountIndices ?? [], data: ix.data }));
  }
  return (m.instructionHeaders ?? []).map((h, i) => ({
    program: m.staticAccounts[h.programAccountIndex],
    accounts: m.instructionPayloads?.[i]?.instructionAccountIndices ?? [],
    data: m.instructionPayloads?.[i]?.instructionData,
  }));
}

/**
 * Did a transaction that landed and reverted revert on the price? Either Orientim's minimum-output
 * check refused what arrived, or Jupiter's own threshold did (6001, SlippageToleranceExceeded).
 * Read from the compiled message alone: a program is always a static key, and R5 keeps every
 * address unique, so two equal account indices are the same account. `err` is the status error as
 * the chain reports it, or its JSON.
 */
export function revertedOnPrice(tx: Transaction, err: unknown, jupiterProgram: string): boolean {
  try {
    const parsed = typeof err === 'string' ? JSON.parse(err) : err;
    const ie = (parsed as { InstructionError?: [unknown, unknown] } | null)?.InstructionError;
    if (!ie) return false;
    const index = Number(ie[0]);
    const custom = Number((ie[1] as { Custom?: unknown } | null)?.Custom ?? NaN);
    const ix = compiledInstructions(tx)[index];
    if (!ix) return false;
    if (ix.program === jupiterProgram) return custom === 6001;
    const floorCheck = (ix.program === TOKEN_PROGRAM || ix.program === TOKEN_2022_PROGRAM) && ix.data?.[0] === 12
      && ix.accounts.length >= 3 && ix.accounts[0] === ix.accounts[2];
    return floorCheck && custom === 1; // the token program's InsufficientFunds
  } catch {
    return false;
  }
}

/**
 * A route whose accounts together with Orientim's exceed the 64-account limit cannot be compiled at
 * all; like a route that is too large, it simply does not fit, and a smaller one is requested.
 */
export function compileIfFits<T>(build: () => T): T | null {
  try {
    return build();
  } catch (e) {
    if (isSolanaError(e, SOLANA_ERROR__TRANSACTION__TOO_MANY_ACCOUNT_ADDRESSES)) return null;
    throw e;
  }
}

/**
 * Why the routes failed, in the words the simulation used. Without this a failure says only that
 * something went wrong, which helps neither the user nor whoever reads the report afterwards.
 */
const why = (attempts: readonly Attempt[]) =>
  attempts.length
    ? `Tried: ${attempts.slice(-3).map(a => `${a.route.join(' + ') || 'no route'} (${a.simulation})`).join('; ')}.`
    : '';

/**
 * The failing program's own words from a simulation's logs: the last log line before a program
 * failed, or the reason on the failure line itself. A custom error number alone ("Custom: 1") means
 * something different in every program; the line beside it says which.
 */
export function failureReason(logs: readonly string[]): string | null {
  for (let i = logs.length - 1; i >= 0; i--) {
    const failed = logs[i].match(/^Program \w+ failed: (.+)$/);
    if (!failed) continue;
    const said = logs.slice(0, i).reverse().find(l => /^Program log: |^Transfer: /.test(l));
    const reason = said ? said.replace(/^Program log: /, '') : failed[1];
    return reason.length > 160 ? `${reason.slice(0, 157)}...` : reason;
  }
  return null;
}

/** A failed simulation as an attempt's reason: the error and, when the logs say it, why. */
const simulationReason = (sim: { error: string | null; logs: readonly string[] }) => {
  const reason = failureReason(sim.logs);
  return `${sim.error ?? 'failed'}${reason ? `: ${reason}` : ''}`;
};

/** A bps gap as a percentage, for a message a person reads: 137n → "1.37%". */
const percent = (bps: bigint | null) => (bps === null ? 'far' : `${(Number(bps) / 100).toFixed(2)}%`);

const fits = (size: number, staticAccounts: number, version: TxVersion) =>
  version === 1 ? size <= V1_SIZE_LIMIT && staticAccounts <= V1_MAX_ACCOUNTS : size <= LEGACY_SIZE_LIMIT;

async function latestLifetime(rpc: SolanaRpc): Promise<Lifetime> {
  return (await latestLifetimeAt(rpc)).lifetime;
}

/** A fresh blockhash, and the slot the RPC read it at (for the wallet's own simulation). */
async function latestLifetimeAt(rpc: SolanaRpc): Promise<{ lifetime: Lifetime; contextSlot: bigint }> {
  const { context, value } = await rpc.getLatestBlockhash({ commitment: 'confirmed' }).send();
  return {
    lifetime: { blockhash: value.blockhash, lastValidBlockHeight: value.lastValidBlockHeight },
    contextSlot: BigInt((context as { slot?: bigint | number } | undefined)?.slot ?? 0),
  };
}

/**
 * Builds, simulates and verifies a protected swap (plan, sections 4–6). The returned transaction
 * has passed all 7 rules and is ready for the wallet to sign first.
 */
export async function prepareProtectedSwap(deps: {
  rpc: SolanaRpc;
  /** Where routes come from: Orientim's own Jupiter client, or the routes an agent brought (providedRoutes). */
  jupiter: JupiterClient;
  /**
   * What prices Orientim's fee in SOL, for a pair neither token of which can carry it: always
   * Orientim's own Jupiter client, never an agent's routes. Defaults to `jupiter`.
   */
  pricing?: JupiterClient;
  /**
   * Orientim's own Jupiter client, when `jupiter` answers from an agent's routes. With a fee on the
   * output, a share of the minimum a route sets, the unrestricted baseline is asked of it, and a
   * route whose minimum is more than PROVIDED_ROUTE_TOLERANCE_BPS below the baseline's stops the
   * build with `RoutesUntrusted`: within it, the fee follows the route's minimum.
   */
  reference?: JupiterClient;
  /**
   * Orientim's own price from an earlier round of this swap, still fresh (the API decides): used
   * instead of asking `reference` again. `onReferencePrice` hears each price `reference` gave.
   */
  referencePrice?: ReferencePrice;
  onReferencePrice?: (price: ReferencePrice) => void;
  /**
   * For a fee in SOL from the wallet: what the swap's input was worth in SOL in an earlier round of
   * this swap, still fresh (the API decides), used instead of asking `pricing` again when it is for
   * the same amount. `onSolValue` hears each value `pricing` gave.
   */
  solValue?: SolValue;
  onSolValue?: (value: SolValue) => void;
  settings: SwapSettings;
  /** The RPC provider's own priority estimate (heliusPriorityFee); without one, or when it fails, recent fees. */
  priorityFee?: PriorityFeeLevel;
}, req: SwapRequest): Promise<PreparedSwap> {
  const { rpc, jupiter, settings } = deps;
  const E = req.ephemeral.address;
  const started = performance.now();
  let localMs = 0;
  let jupiterBuildMs = 0;
  let jupiterBuildCalls = 0;
  let simulationMs = 0;
  let simulationCalls = 0;
  let verificationMs = 0;
  const measuredSimulation: typeof simulate = async (...args) => {
    const at = performance.now();
    simulationCalls++;
    try { return await simulate(...args); }
    finally { simulationMs += performance.now() - at; }
  };
  const timed = <T>(work: () => T): T => {
    const t = performance.now();
    try {
      return work();
    } finally {
      localMs += performance.now() - t;
    }
  };

  // Everything the first decisions need, in one round trip (idea 21): both mints, the treasury's
  // account for the input token and W_out, with the rent for a new W_out asked at the same time.
  // Which token program owns a mint decides its associated-account address, and that is only known
  // once the mint is read, so both candidates are asked for together.
  const variant = variantOf(req.inputMint, req.outputMint);
  const bothPrograms = [TOKEN_PROGRAM, TOKEN_2022_PROGRAM];
  const feeCandidates = settings.treasury && req.inputMint !== WSOL_MINT
    ? await Promise.all(bothPrograms.map(tp => ataOf(settings.treasury!, req.inputMint, tp)))
    : [];
  const wOutCandidates = variant === 'A' ? [] : await Promise.all(bothPrograms.map(tp => ataOf(req.owner, req.outputMint, tp)));
  const wInCandidates = variant === 'B' ? [] : await Promise.all(bothPrograms.map(tp => ataOf(req.owner, req.inputMint, tp)));
  // From the cluster, since it changed in 2026. If the RPC cannot answer, the
  // pre-2026 value is shown, which is an upper bound.
  const rentFor = (size: number) => rpc.getMinimumBalanceForRentExemption(BigInt(size)).send()
    .then(BigInt)
    .catch(() => TOKEN_ACCOUNT_RENT_UPPER_ORIENTIM_LAMPORTS);
  // A fee in SOL goes to the treasury wallet itself, so it is read whenever there is a treasury: SOL
  // on either side pays there (see below), and so does a pair no token of which can carry the fee.
  // A fee on a USDC or USDT output goes to the treasury's account for it.
  const treasuryWallet = settings.treasury ? [settings.treasury] : [];
  const outputFeeCandidates = settings.treasury && req.outputMint !== WSOL_MINT && FEE_TOKENS.includes(req.outputMint)
    ? await Promise.all(bothPrograms.map(tp => ataOf(settings.treasury!, req.outputMint, tp)))
    : [];
  const [firstReads, classicRent, extendedRent] = await Promise.all([
    fetchAccounts(rpc, [
      req.inputMint, req.outputMint, ...feeCandidates, ...outputFeeCandidates, ...wOutCandidates, ...wInCandidates, ...treasuryWallet,
    ]),
    wOutCandidates.length ? rentFor(TOKEN_ACCOUNT_SIZE) : Promise.resolve(0n),
    wOutCandidates.length ? rentFor(TOKEN_2022_ACCOUNT_SIZE) : Promise.resolve(0n),
  ]);
  const mints = new Map([req.inputMint, req.outputMint].map(m => [m, mintInfoOf(firstReads.get(m))]));

  // R7 up front, so a token we cannot isolate is refused before anything is quoted or built.
  for (const m of [req.inputMint, req.outputMint]) {
    const info = mints.get(m)!;
    if (!info.exists || (info.program !== TOKEN_PROGRAM && info.program !== TOKEN_2022_PROGRAM)) {
      throw new OrientimError('unsupported-token', `${m} is not a token Orientim can swap.`);
    }
    if (info.program === TOKEN_2022_PROGRAM) {
      // The same rule the verifier applies, with the same exception: the swap's own mints may
      // charge a transfer fee, because their temporary account is harvested before it is closed.
      const bad = unsupportedExtension(firstReads.get(m)!.data, { allowTransferFee: true });
      if (bad) throw new OrientimError('unsupported-token', `This token uses ${bad}, which a protected swap cannot isolate.`);
    }
  }
  // A mint with the transfer-fee extension keeps a cut of every transfer, and which of its two fee
  // settings applies depends on the epoch. The epoch is read only for such a mint, and a swap is
  // never built on a guess: without it the tax cannot be priced.
  const inputTaxes = mints.get(req.inputMint)!.program === TOKEN_2022_PROGRAM
    && hasTransferFee(firstReads.get(req.inputMint)!.data);
  const epoch = inputTaxes
    ? await rpc.getEpochInfo({ commitment: 'confirmed' }).send().then(e => BigInt(e.epoch)).catch(() => null)
    : 0n;
  if (epoch === null) {
    throw new OrientimError(
      'unavailable',
      "Orientim could not read the epoch that decides this token's transfer fee, so the amount could not be priced. Nothing was built; try again in a moment.",
    );
  }
  const inputFee = inputTaxes ? transferFeeOf(firstReads.get(req.inputMint)!.data, epoch) : null;
  const inputTokenProgram = mints.get(req.inputMint)!.program!;
  const outputTokenProgram = mints.get(req.outputMint)!.program!;
  const feeAccount = feeCandidates.length ? await ataOf(settings.treasury!, req.inputMint, inputTokenProgram) : null;
  const wOutAddress = wOutCandidates.length ? await ataOf(req.owner, req.outputMint, outputTokenProgram) : null;
  // A Token-2022 account is larger when its mint needs account-side extensions, so its rent is
  // asked for at that size; the two common sizes were fetched above, in parallel.
  const outputAccountSize = tokenAccountSizeFor(outputTokenProgram, firstReads.get(req.outputMint)?.data);
  const newAccountRent = !wOutAddress ? 0n
    : outputAccountSize === TOKEN_ACCOUNT_SIZE ? classicRent
      : outputAccountSize === TOKEN_2022_ACCOUNT_SIZE ? extendedRent
        : await rentFor(outputAccountSize);
  // The amount the user typed was converted with `inputDecimals`; if the chain disagrees, the
  // wallet would be asked for a different amount than the one shown.
  for (const [m, shown] of [[req.inputMint, req.inputDecimals], [req.outputMint, req.outputDecimals]] as const) {
    if (mints.get(m)!.decimals !== shown) {
      throw new OrientimError('token-data-mismatch', `Two reads of the chain disagree on the decimals of ${m}. Nothing was built; try again in a moment.`);
    }
  }

  // A token account frozen by its issuer (a stablecoin's blacklist, say) cannot receive: a frozen fee
  // account is treated like a missing one, and the fee goes to the next side in line.
  const frozen = (s: { data: Uint8Array } | null | undefined) => !!s && s.data.length >= TOKEN_ACCOUNT_SIZE && s.data[108] === 2;
  const feeAccountExists = feeAccount ? !!firstReads.get(feeAccount) && !frozen(firstReads.get(feeAccount)) : true;
  const outputFeeAccount = outputFeeCandidates.length ? await ataOf(settings.treasury!, req.outputMint, outputTokenProgram) : null;
  const outputFeeAccountExists = !!outputFeeAccount && !!firstReads.get(outputFeeAccount) && !frozen(firstReads.get(outputFeeAccount));
  // A SOL fee into a treasury wallet that does not exist yet would open it below the rent minimum,
  // which the runtime refuses, and every small swap would revert. Until the wallet exists the fee
  // is taken in the next token in line, or the swap is refused.
  const treasuryWalletReady = treasuryWallet.length > 0 && !!firstReads.get(settings.treasury!);
  // A pair that neither token can carry the fee for pays it in SOL from the wallet: feeBps of what the
  // swap is worth in SOL, asked of Jupiter now, like the route itself. A pair Jupiter cannot price in
  // SOL cannot pay it, and is refused below (`fee-unavailable`).
  const tokenCarries = feeSideFor(req.inputMint, req.outputMint, {
    input: req.inputMint === WSOL_MINT ? treasuryWalletReady : feeAccountExists,
    output: req.outputMint === WSOL_MINT ? treasuryWalletReady : outputFeeAccountExists,
  });
  // A value an earlier round of the same swap got is used while fresh, for the same amount only.
  let solFee: bigint | undefined;
  if (settings.treasury && treasuryWalletReady && tokenCarries === null) {
    const amount = req.amountIn - (inputFee ? transferFeeOn(req.amountIn, inputFee) : 0n);
    const known = deps.solValue && deps.solValue.amount === amount ? deps.solValue.value : undefined;
    const value = known ?? await solValueOf(deps.pricing ?? jupiter, { inputMint: req.inputMint, amount, taker: E, slippageBps: settings.slippageBps });
    if (value !== undefined && known === undefined) deps.onSolValue?.({ amount, value });
    solFee = value === undefined ? undefined : (value * settings.feeBps) / 10_000n;
  }
  const policy = await buildPolicy({
    intent: { owner: req.owner, inputMint: req.inputMint, outputMint: req.outputMint, amountIn: req.amountIn },
    ephemeral: E,
    inputDecimals: mints.get(req.inputMint)!.decimals,
    outputDecimals: mints.get(req.outputMint)!.decimals,
    inputTokenProgram,
    outputTokenProgram,
    // The extension itself, not this epoch's rate: an account that has ever received the token
    // may hold withheld fees, and the cleanup must harvest them whatever the rate is today.
    inputTransferFee: inputTaxes,
    config: settings,
    // Like Jupiter's fee: SOL first, then USDC and USDT, on whichever side; otherwise the input token.
    feeAccountExists,
    outputFeeAccountExists,
    treasuryWalletReady,
    solFee,
  });
  // Every swap a deployment with a treasury builds pays Orientim's fee. Test mode, without a
  // treasury, is the only fee-free mode: a swap whose fee cannot be collected is refused, never
  // built for free.
  if (settings.treasury && policy.feeSide === null) {
    throw new OrientimError('fee-unavailable', treasuryWalletReady ? FEE_UNPRICED_MESSAGE : FEE_UNAVAILABLE_MESSAGE);
  }
  if (settings.treasury && policy.feeSide !== 'output' && policy.fee <= 0n) throw new OrientimError('amount-too-small', AMOUNT_TOO_SMALL_MESSAGE);
  // The whole balance of a token, sold: however little it is now worth, the holder must be able to leave it.
  // Only a token account counts (never SOL), and a fee that cannot be collected at all is still refused.
  const sellsWholeBalance = !!policy.accounts.wIn && req.amountIn > 0n && tokenAmountOf(firstReads.get(policy.accounts.wIn)?.data) === req.amountIn;
  // The smallest swap, so that none costs more to build than its fee brings.
  if (settings.treasury && !sellsWholeBalance && policy.feeSide !== 'output' && belowMinFee(policy.fee, feeMintOf(policy), settings.minFee)) {
    throw new OrientimError('amount-too-small', MIN_SWAP_MESSAGE);
  }

  // The token keeps a cut of every transfer, including ours into the temporary account, so the
  // route must be quoted for what actually lands there.
  const taxOnInput = inputFee ? transferFeeOn(policy.swapAmount, inputFee) : 0n;
  const arriving = policy.swapAmount - taxOnInput;
  if (arriving <= 0n) throw new OrientimError('unsupported-token', 'The token keeps the whole amount as a transfer fee at this size.');

  // W_in is the one account of W that Orientim's own transfer draws on. Frozen or short, that transfer
  // fails before the swap, which would read as a broken route and exclude every market on it; say
  // what it is instead.
  if (policy.accounts.wIn) {
    const state = firstReads.get(policy.accounts.wIn);
    if (frozen(state)) {
      throw new OrientimError(
        'input-account-restricted',
        "Your account for the input token is frozen by the token's issuer, so it cannot send anything.",
      );
    }
    const held = tokenAmountOf(state?.data);
    if (held < req.amountIn) {
      throw new OrientimError(
        'insufficient-balance',
        `Your wallet holds ${tokenText(held, req.inputDecimals)} of the input token, less than the ${tokenText(req.amountIn, req.inputDecimals)} this swap needs.`,
      );
    }
  }

  // W_out is the only account of W the swap sees. A delegate is revoked in the transaction, but a
  // close authority cannot be, so such an account is refused up front.
  let wOutBefore: { exists: boolean; balance: bigint } = { exists: false, balance: 0n };
  let removesDelegate = false;
  if (policy.accounts.wOut) {
    const state = firstReads.get(policy.accounts.wOut);
    const view = state && state.data.length >= TOKEN_ACCOUNT_SIZE ? new DataView(state.data.buffer, state.data.byteOffset) : null;
    if (view && view.getUint32(129, true) === 1) {
      throw new OrientimError(
        'output-account-restricted',
        'Your account for the output token has a close authority set, so Orientim will not send the output there.',
      );
    }
    if (frozen(state)) {
      throw new OrientimError(
        'output-account-restricted',
        "Your account for the output token is frozen by the token's issuer, so nothing can be sent to it.",
      );
    }
    if (state && memoRequired(state.data)) {
      throw new OrientimError(
        'output-account-restricted',
        'Your account for the output token requires a memo on every incoming transfer, which a swap cannot provide.',
      );
    }
    // The trusted Revoke also removes a delegate the user set up on purpose: say so.
    removesDelegate = !!view && view.getUint32(72, true) === 1;
    wOutBefore = { exists: !!state, balance: tokenAmountOf(state?.data) };
  }

  const initialMs = performance.now() - started;
  const buildBase = {
    inputMint: req.inputMint,
    outputMint: req.outputMint,
    amount: arriving,
    taker: E,
    // Each route is built at its own tolerance, so that Jupiter's program enforces a second floor on
    // chain that does not depend on the balance Orientim read from the RPC. A curve route
    // is asked for again at the curve tolerance once it is known to be one.
    slippageBps: settings.chosenSlippageBps ?? (req.expectCurve ? settings.curveSlippageBps : settings.slippageBps),
    destinationTokenAccount: policy.accounts.wOut ?? undefined,
  };
  // Individual quotes fail transiently ("pool has not been updated", "zero tradable amount"):
  // retry the baseline once and skip a failing maxAccounts level instead of giving up.
  // A 429 or a Jupiter that does not answer is not a missing route: it ends the attempt with that
  // reason, instead of reading as "no route fits, try another token".
  const buildOrNull = async (
    maxAccounts: number, excludeDexes?: readonly string[], slippageBps = buildBase.slippageBps,
    mode: 'standard' | 'fast' = req.routingMode ?? 'standard', client: JupiterClient = jupiter,
  ) => {
    const at = performance.now();
    jupiterBuildCalls++;
    try {
      return await client.build({ ...buildBase, maxAccounts, excludeDexes, slippageBps, ...(mode === 'fast' ? { mode } : {}) });
    } catch (e) {
      // A route the agent has not brought yet: the API asks the agent for it. One that cannot be
      // checked: the API builds the swap with Orientim's key.
      if (e instanceof RoutesNeeded || e instanceof RoutesUntrusted) throw e;
      if (e instanceof JupiterError) {
        if (e.status === 429) throw new OrientimError('busy', BUSY_MESSAGE);
        // Jupiter answers "No routes found" with 400. A refused key or an endpoint that is gone is
        // Orientim's to fix, not the pair's, so it is not reported as a missing route.
        if ([401, 403, 404, 410].includes(e.status)) {
          console.error(`Jupiter refused Orientim's request with HTTP ${e.status}: ${e.message}`);
          throw new OrientimError('unavailable', UNAVAILABLE_MESSAGE);
        }
        if (e.status < 500) return null;
      } else {
        console.error('Jupiter could not be reached:', e);
      }
      throw new OrientimError('unavailable', UNAVAILABLE_MESSAGE);
    } finally {
      jupiterBuildMs += performance.now() - at;
    }
  };
  // Jupiter is untrusted: an answer for another pair or another amount is not a quote for this swap.
  const answersThisRequest = (r: BuildResponse) =>
    r.inputMint === req.inputMint && r.outputMint === req.outputMint && BigInt(r.inAmount) === arriving;
  // The unrestricted baseline, the first protected route, the blockhash and the DEX labels do not
  // depend on each other: ask for them at the same time (idea 21).
  // Jupiter sometimes answers "No matching liquidity" for a pair it quotes a second later: retry
  // once after a pause, then accept a smaller route as the baseline before giving up.
  // With an agent's routes and a fee on the output, the baseline is Orientim's own price, which every
  // route's minimum is held to (`deps.reference`); asked once the agent has brought the first route,
  // so that a round that only learns which routes to bring costs Orientim's key nothing.
  const reference = deps.reference && policy.feeSide === 'output' ? deps.reference : null;
  const known = reference ? deps.referencePrice : undefined;
  const firstRouteTask = buildOrNull(MAX_ACCOUNTS_LEVELS[0], settings.excludeDexes);
  const baselineTask = known ? Promise.resolve(null) : (async () => {
    if (reference) await firstRouteTask.catch(e => { if (e instanceof RoutesNeeded || e instanceof RoutesUntrusted) throw e; });
    for (const [i, maxAccounts] of [64, 64, 48, 32].entries()) {
      if (i > 0) await new Promise(r => setTimeout(r, 700));
      // The baseline must remain standard even when the protected route uses fast mode:
      // otherwise a worse fast quote could make the protected-route price check look good.
      const r = await buildOrNull(maxAccounts, undefined, buildBase.slippageBps, 'standard', reference ?? jupiter);
      if (r) return r;
    }
    return null;
  })();
  const firstLifetimeTask = latestLifetime(rpc);
  const labelsTask = jupiter.programLabels().catch(() => ({} as Record<string, string>));
  // Settled early so that a failure the loop never waits for is not an unhandled rejection.
  firstRouteTask.catch(() => undefined);
  firstLifetimeTask.catch(() => undefined);
  const baseline = await baselineTask;
  if (!known && !baseline) throw new OrientimError('no-route', 'Jupiter found no route for this pair and amount, asked four times. The token may have no liquidity left, or too little for this amount: try a smaller amount or once more later, and stop if it is refused again.');
  if (baseline && !answersThisRequest(baseline)) throw new OrientimError('bad-quote', 'Jupiter answered for a different trade. Nothing was built.');
  const baselineOut = known ? known.out : BigInt(baseline!.outAmount);
  /** What Orientim's own price guarantees at its own tolerance (used with `reference`). */
  const referenceMinimum = known ? known.minimum : minimumOutput(baselineOut, slippageFor(baseline!, settings));
  if (reference && !known) deps.onReferencePrice?.({ out: baselineOut, minimum: referenceMinimum });
  const labels = await labelsTask;

  const learned: string[] = [];
  const attempts: Attempt[] = [];
  let floorMisses = 0;
  let rentMisses = 0;
  // The narrowest route level still worth trying: raised when a route fits only without closing the
  // account a market opened under E, so that the next attempt looks for one that fits with it.
  let minLevel = 0;
  // What is left under E after the swap, watched in the final simulation: E, the
  // account each Pump market opens in E's name, and the token accounts those hold cashback in. The
  // agent's check watches the same (skill, leftUnderKey); the API holds to it too.
  const underKey: Address[] = await (async () => {
    const markets = await Promise.all([CURVE_PROGRAM, PUMP_AMM_PROGRAM].map(program => routeAccountOf(program, E)));
    const cashback = await Promise.all(markets.flatMap(m => [WSOL_MINT, USDC_MINT].map(mint => ataOf(m, mint))));
    return [E, ...markets, ...cashback];
  })();
  // Orientim computes each route's floor itself and enforces it on chain, never below what the
  // user accepted.
  const accepted = req.acceptedMinReceived !== undefined
    ? (policy.feeSide === 'output' ? minimumForReceived(req.acceptedMinReceived, policy.feeBps) : req.acceptedMinReceived)
    : req.acceptedMinOut ?? 0n;
  /** What the wallet keeps of a minimum: less a fee taken from the output. */
  const keeps = (minOut: bigint) => (policy.feeSide === 'output' ? minOut - outputFeeFor(minOut, policy.feeBps) : minOut);
  const floorOf = (r: BuildResponse) => strictMinimumOutput(r, slippageFor(r, settings), accepted);
  // Rent the chosen route needs E to pay, measured in simulation (see `measureTakerRent`).
  let takerRent = 0n;
  // Pump's per-buyer account under E, closed after the swap and returned to W.
  let routeRefund: RouteRefund | null = null;
  const policyFor = (r: BuildResponse) => withRouteRefund(withTakerRent(withMinOut(policy, floorOf(r)), takerRent), routeRefund);
  const priceMoved = (r: BuildResponse, message = 'The best route now gives less than your minOut: the price moved beyond the slippage tolerance. Nothing was signed.') =>
    new OrientimError('price-moved', message, [], {
      newMinOut: routeFloor(r, slippageFor(r, settings)),
      newOutAmount: BigInt(r.outAmount),
      newMinReceived: keeps(routeFloor(r, slippageFor(r, settings))),
    });
  /**
   * Finds the rent a route needs E to pay. E is funded with the ceiling once, and what it holds
   * afterwards says how much the route spent; E is then funded with exactly that, and the
   * simulation must show it ending empty. A route that wants more than the ceiling is not paying
   * rent but spending, and is left to fail as before. Every number comes from the chain, so Orientim
   * needs no knowledge of the program that opens the account.
   */
  const measureTakerRent = async (
    build: () => ReturnType<typeof compileProtectedSwap>,
    set: (rent: bigint) => void,
    /** Also read after the swap, behind E: the account the route opens, to learn what it holds. */
    watch: Address[] = [],
  ) => {
    const attempt = (rent: bigint) => {
      set(rent);
      try {
        // The funding instruction can push the route over a transaction limit: past 64 accounts
        // compiling throws, past the size limit the RPC refuses even to simulate it.
        const built = build();
        return fits(built.size, built.staticAccounts, req.version) ? built : null;
      } catch {
        return null;
      }
    };
    // A bonding curve's price moves with every buy, and what its market takes from E moves with it:
    // a second measurement that disagrees with the first is measured once more, from the start.
    let last: { trial: ReturnType<typeof compileProtectedSwap>; sim: Simulation } | null = null;
    for (let round = 0; round < 2; round++) {
      const probe = attempt(MAX_TAKER_RENT_LAMPORTS);
      if (!probe) { set(0n); return null; }
      const probed = await measuredSimulation(rpc, probe.transaction, [E, ...watch]);
      // With the lamports it lacked, the route failed for another reason, usually a price that moved.
      // That reason is the one to act on; nothing is built on this probe, so it carries no rent.
      if (!probed.ok) { set(0n); return { trial: probe, sim: probed }; }
      const spent = MAX_TAKER_RENT_LAMPORTS - (probed.lamportsAfter[0] ?? MAX_TAKER_RENT_LAMPORTS);
      if (spent <= 0n) { set(0n); return null; }
      const exact = attempt(spent);
      if (!exact) { set(0n); return null; }
      const sim = await measuredSimulation(rpc, exact.transaction, [E, ...watch]);
      // Funded with exactly what it spends, E must end with nothing: no SOL stays behind under a key
      // that is about to be discarded.
      if (sim.ok && sim.lamportsAfter[0] === 0n) return { trial: exact, sim };
      last = { trial: exact, sim };
    }
    set(0n);
    // Still left rent-paying: that is the reason to act on, not a route short of lamports.
    return last && rentOnE(last.sim) ? last : null;
  };

  /** E (account 1, the only signer besides W) left with less than an empty account's rent. */
  const rentOnE = (s: Simulation) => !s.ok && /InsufficientFundsForRent/.test(s.error ?? '') && /"account_index":"?1"?[,}]/.test(s.error ?? '');
  const failedInSwap = (s: Simulation, tx: Transaction, lookups: Record<string, string[]> | null) =>
    programAt(tx, s.failedInstruction, lookups) === settings.jupiterProgram;
  /**
   * Did the simulation fail because the wallet itself is short of SOL? The network
   * fee, a new account's rent and the SOL being swapped all leave W before the swap runs. Blaming the
   * route for that would exclude every DEX on it and tell the user that no route works.
   */
  const walletShortOfSol = (s: Simulation, tx: Transaction, lookups: Record<string, string[]> | null) => {
    if (s.ok) return false;
    const error = s.error ?? '';
    if (/InsufficientFundsForFee|AccountNotFound/.test(error)) return true;
    if (/InsufficientFundsForRent/.test(error) && /"account_index":"?0"?[,}]/.test(error)) return true;
    return s.failedInstruction !== null && !failedInSwap(s, tx, lookups) && s.logs.some(l => l.includes('insufficient lamports'));
  };
  /** What the swap needs from W in SOL, as an upper estimate, and what W holds. */
  const insufficientSol = async (intermediateCount: number, routeRent: bigint) => {
    const [balance, reserve, temporaryRent] = await Promise.all([
      rpc.getBalance(req.owner, { commitment: 'confirmed' }).send().then(r => BigInt(r.value)).catch(() => null),
      rentFor(0),
      rentFor(TOKEN_2022_ACCOUNT_SIZE),
    ]);
    const temporaryAccounts = BigInt(1 + (variant === 'A' ? 1 : 0) + intermediateCount);
    const need = (variant === 'B' ? req.amountIn : 0n) + temporaryAccounts * temporaryRent
      + (policy.accounts.wOut && !wOutBefore.exists ? newAccountRent : 0n) + routeRent + settings.maxNetworkFeeLamports + reserve
      // A fee in SOL is paid from the wallet up front.
      + (policy.feeSide === 'sol' ? policy.fee : 0n);
    return new OrientimError(
      'insufficient-sol',
      `This swap needs about ${solText(need)} SOL in your wallet: ${variant === 'B' ? 'the SOL you swap, ' : ''}the network fee and account deposits, most of which come back in the same transaction.`
      + `${balance !== null ? ` Your wallet has ${solText(balance)} SOL.` : ''} Add SOL or swap a smaller amount.`,
    );
  };

  const compile = (
    r: BuildResponse, lifetime: Lifetime, intermediates: IntermediateAta[], computeUnitLimit: number,
    outputBalanceBefore = wOutBefore.balance,
    priority: { microLamportsPerComputeUnit: bigint; priorityFeeLamports: bigint } = settings,
  ) =>
    compileProtectedSwap({
      policy: policyFor(r),
      outputBalanceBefore,
      // Jupiter's own floor covers the whole minimum, also when the user accepted more than the
      // route's floor.
      swapInstruction: withFloorAtLeast(toKitInstruction(r.swapInstruction), policyFor(r).minOut),
      intermediates,
      version: req.version,
      lifetime,
      computeUnitLimit,
      microLamportsPerComputeUnit: priority.microLamportsPerComputeUnit,
      priorityFeeLamports: priority.priorityFeeLamports,
      lookupTables: req.version === 0 ? (r.addressesByLookupTableAddress ?? undefined) as never : undefined,
    });

  // A hop through a mint that taxes transfers leaves withheld fees in the temporary account, which
  // then cannot be closed; the compiler harvests those, so it has to know which mints tax.
  const taxing = new Map<string, boolean>([[req.inputMint, inputTaxes]]);
  /**
   * The same rule the swap's own two mints pass, applied to every mint a route passes through.
   * Orientim creates and closes a temporary account for each hop, so a hop is not a detail of
   * Jupiter's route: it is an account Orientim owns for the length of one transaction, and a mint it
   * cannot isolate has no business being one. Screening only the endpoints let a hop through a
   * mint with a transfer hook, a permanent delegate or a frozen default state build and get
   * signed, only to revert on chain.
   */
  const cannotIsolate = new Map<string, string | null>();
  const withTransferFees = async (list: IntermediateAta[]): Promise<IntermediateAta[]> => {
    const unknown = [...new Set(list.map(x => x.mint).filter(m => !taxing.has(m)))];
    if (unknown.length) {
      const states = await fetchAccounts(rpc, unknown);
      for (const m of unknown) {
        const state = states.get(m);
        const token2022 = !!state && state.owner === TOKEN_2022_PROGRAM;
        taxing.set(m, token2022 && hasTransferFee(state!.data));
        // A hop that charges a transfer fee is allowed for the same reason the endpoints are: the
        // compiler harvests what the mint withheld before it closes the account.
        cannotIsolate.set(m, token2022 ? unsupportedExtension(state!.data, { allowTransferFee: true }) : null);
      }
    }
    return list.map(x => ({ ...x, transferFee: taxing.get(x.mint) ?? false }));
  };

  for (let attempt = 0; attempt < settings.maxRepairAttempts; attempt++) {
    takerRent = 0n; // every route is measured afresh
    routeRefund = null;
    const excluded = [...settings.excludeDexes, ...learned];
    const lifetime = await (attempt === 0 ? firstLifetimeTask : latestLifetime(rpc));

    let chosen: { r: BuildResponse; intermediates: IntermediateAta[]; level: number } | null = null;
    let chosenGapBps = 0n;
    /** Jupiter answered for another trade, or its instruction disagreed with its own answer. */
    let sawBadQuote = false;
    /** A route was priced so far below the unrestricted one that it cannot be a real price. */
    let sawFarBelow = false;
    /** Jupiter answered with an instruction Orientim cannot read: its format changed. */
    let sawUnknownFormat = false;
    // A route priced right but too big for one transaction is the usual outcome for a large
    // amount: Solana allows 64 accounts per transaction, and Orientim's own instructions need a
    // dozen of them. That is a different failure from a broken quote, and it is reported as such.
    let sawTooBig = false;
    /** A route too big for one transaction would have met the user's minimum. */
    let tooBigMetMinimum = false;
    /** A route was priced and fitted, but one of its hops is a mint Orientim cannot isolate. */
    let sawUnsupportedHop: string | null = null;
    /** How far the best route offered was below the unrestricted price, in bps. */
    let bestGapBps: bigint | null = null;
    for (const [level, maxAccounts] of MAX_ACCOUNTS_LEVELS.entries()) {
      if (level < minLevel) continue;
      let r = attempt === 0 && level === 0 && minLevel === 0 ? await firstRouteTask : await buildOrNull(maxAccounts, excluded);
      if (!r) continue;
      // Every route is built at its own tolerance, so Jupiter's threshold matches Orientim's floor.
      // A route asked for at the other one is asked for again; if the answer changes kind on the
      // way, this level is skipped rather than built at a mismatched tolerance.
      const own = slippageFor(r, settings);
      if (own !== buildBase.slippageBps) {
        const again = await buildOrNull(maxAccounts, excluded, own);
        if (!again || slippageFor(again, settings) !== own) continue;
        r = again;
      }
      if (!answersThisRequest(r)) { sawBadQuote = true; continue; }
      // What Jupiter's program will enforce must be what its answer says: the amount
      // in, the quote and the tolerance this route was asked for. The verifier checks the ceilings.
      const args = jupiterRouteArgs(toKitInstruction(r.swapInstruction).data ?? new Uint8Array());
      if (!args) { sawUnknownFormat = true; continue; }
      if (args.inAmount !== BigInt(r.inAmount) || args.quotedOutAmount !== BigInt(r.outAmount) || args.slippageBps !== own) {
        sawBadQuote = true;
        continue;
      }
      const out = BigInt(r.outAmount);
      // An agent's route sets the minimum Orientim's fee on the output is a share of: never more than
      // PROVIDED_ROUTE_TOLERANCE_BPS below Orientim's own price, at each one's own tolerance.
      if (reference && minimumOutput(out, own) * 10_000n < referenceMinimum * (10_000n - PROVIDED_ROUTE_TOLERANCE_BPS)) {
        throw new RoutesUntrusted(`the route's minimum is more than ${PROVIDED_ROUTE_TOLERANCE_BPS} bps below Orientim's own price`);
      }
      const gap = baselineOut > 0n ? ((baselineOut - out) * 10_000n) / baselineOut : 0n;
      if (bestGapBps === null || gap < bestGapBps) bestGapBps = gap;
      if (gap > settings.badQuoteBps) { sawFarBelow = true; continue; }
      if (BigInt(r.otherAmountThreshold) <= 0n) continue; // no floor to enforce
      const intermediates = await withTransferFees(intermediatesFromSetup(r.setupInstructions, policy));
      const badHop = intermediates.map(x => cannotIsolate.get(x.mint)).find(Boolean);
      if (badHop) { sawUnsupportedHop = badHop; continue; }
      const c = timed(() => compileIfFits(() => compile(r, lifetime, intermediates, MAX_COMPUTE_UNITS)));
      if (c && fits(c.size, c.staticAccounts, req.version)) { chosen = { r, intermediates, level }; chosenGapBps = gap; break; }
      sawTooBig = true;
      if (out >= accepted) tooBigMetMinimum = true;
    }
    // The levels run from the widest route to the narrowest, so the first one that fits is the best
    // price available to a protected swap. When it costs noticeably more than the unrestricted
    // market, that is the price of the guarantee, and the user decides rather than Orientim.
    if (chosen && chosenGapBps > settings.askAboveBps) {
      const accepted = req.acceptedCostBps;
      // A little slack, or a market that drifts by a few bps would ask again and again.
      if (accepted === undefined || chosenGapBps > accepted + 50n) {
        throw new OrientimError(
          'costs-more',
          `This route gives ${percent(chosenGapBps)} less than the best unprotected route Jupiter found.`
          + (chosenGapBps > settings.warnAboveBps ? ' A smaller amount often gets a better price.' : ''),
          [], null,
          { gapBps: chosenGapBps, outAmount: BigInt(chosen.r.outAmount), baselineOut },
        );
      }
    }
    // The best route that fits cannot deliver what the user accepted: ask, never lower it silently.
    // When a wider route would have met it but does not fit, that is the reason, not the price.
    if (chosen && BigInt(chosen.r.outAmount) < accepted) {
      throw priceMoved(chosen.r, tooBigMetMinimum
        ? 'The route that meets your minOut does not fit in one protected transaction, and the best route that fits gives less. A smaller amount, or the swap split in parts, may meet it. Nothing was signed.'
        : undefined);
    }
    if (!chosen) {
      // After a repair, the routes we could still use are the ones nothing has blamed yet. If none
      // of them works, the honest reason is the simulations that got us here, not the price.
      if (learned.length) {
        throw new OrientimError(
          'simulation-failed',
          `Every route that fits failed in simulation, and no other route could be used. No funds were moved. ${why(attempts)}`,
        );
      }
      if (sawUnknownFormat) {
        console.error('Jupiter answered with a swap instruction the verifier cannot read: its format changed.');
        throw new OrientimError('route-format', ROUTE_FORMAT_MESSAGE);
      }
      throw sawUnsupportedHop
        ? new OrientimError(
          'unsupported-token',
          `Every route for this swap passes through a token that uses ${sawUnsupportedHop}, which a protected swap cannot isolate. Nothing was built.`,
        )
        : sawTooBig
        ? new OrientimError('no-route', 'The best route for this amount does not fit in a single protected transaction. Try a smaller amount, or split the swap.')
        : sawFarBelow && bestGapBps !== null
          ? new OrientimError('bad-quote', `Every route offered is at least ${percent(bestGapBps)} below the best unprotected route Jupiter found, more than a real price can differ. Nothing was built. Try again in a moment.`)
          : sawBadQuote
            ? new OrientimError('bad-quote', "Jupiter's answers did not match this swap: another trade, or an instruction that disagreed with its own quote. Nothing was built. Try again in a moment.")
            : new OrientimError('no-route', 'Jupiter found no usable route for this pair and amount. Try a different amount or token.');
    }

    const route = chosen.r.routePlan.map(p => p.swapInfo.label);
    const buildTrial = () => compile(chosen.r, lifetime, chosen.intermediates, MAX_COMPUTE_UNITS);
    // A route through a market known to charge the taker rent is measured at once (latency).
    const knownRent = chosen.r.swapInstruction.accounts.some(a => RENT_CHARGING_PROGRAMS.has(a.pubkey));
    const opened = await routeAccountIn(chosen.r, E);
    const watchOpened = opened ? [opened.account] : [];
    const early = knownRent ? await measureTakerRent(buildTrial, rent => { takerRent = rent; }, watchOpened) : null;
    let trial = early ? early.trial : timed(buildTrial);
    let sim = early ? early.sim : await measuredSimulation(rpc, trial.transaction);
    // Some routes open an account in the taker's name and make the taker pay its rent — both of
    // Pump.fun's markets do, once per buyer. E holds no SOL on purpose, so such a route fails for
    // want of lamports.
    // Measure exactly what it needs and send E that and no more; see `measureTakerRent`. Only a
    // failure inside the swap is the route's: one before it is the wallet's own.
    const lookups = chosen.r.addressesByLookupTableAddress;
    let probedForRent = !!early;
    if (!early && !sim.ok && failedInSwap(sim, trial.transaction, lookups) && sim.logs.some(l => l.includes('insufficient lamports'))) {
      probedForRent = true;
      const measured = await measureTakerRent(() => compile(chosen.r, lifetime, chosen.intermediates, MAX_COMPUTE_UNITS), rent => { takerRent = rent; }, watchOpened);
      if (measured) {
        trial = measured.trial;
        sim = measured.sim;
      }
    }
    if (walletShortOfSol(sim, trial.transaction, lookups)) {
      throw await insufficientSol(chosen.intermediates.length, probedForRent && takerRent === 0n ? MAX_TAKER_RENT_LAMPORTS : takerRent);
    }
    // E (account 1, the only signer besides W) left with less than an empty account's rent: the rent
    // the market charges moved while Orientim measured it, a fault of neither the route nor the wallet.
    // Asked once more; no DEX is blamed for it.
    if (rentOnE(sim)) {
      attempts.push({ excluded, route, simulation: 'the rent the market charges moved while it was measured', blamed: null });
      if (++rentMisses >= 2) throw new OrientimError('simulation-failed', RENT_MOVED_MESSAGE);
      continue;
    }
    // The account the market opened in E's name holds most of that rent. It is closed after the swap,
    // once E owns no token account, and its lamports go on to W. What it holds comes
    // from the simulation that measured the rent; the swap with the close is simulated once more and
    // must leave E with nothing. If any of that fails, this route is not offered, and a narrower one
    // is tried. Only an account that holds exactly its rent can be closed: one that also holds
    // cashback (Pump's cashback coins) would make the exact refund depend on the price at landing,
    // so such a route is refused, never left with value under E. Rent a route takes for an account
    // of any other market is caught by the final simulation, which refuses every account the route
    // opens and leaves open.
    if (sim.ok && takerRent > 0n && opened) {
      const held = sim.lamportsAfter[1] ?? 0n;
      const rentOnly = held > 0n && held === await rentFor(sim.sizesAfter[1] ?? 0);
      // Holding more than its rent (a cashback coin's account), what it holds depends on the price at
      // landing, so no exact refund can be written: that route would leave value under E.
      if (!rentOnly || held > MAX_TAKER_RENT_LAMPORTS) throw new OrientimError('no-route', LEFT_UNDER_KEY_MESSAGE);
      {
        routeRefund = { ...opened, lamports: held };
        let withClose: ReturnType<typeof compileProtectedSwap> | null = null;
        let closeSize = '';
        try {
          withClose = timed(buildTrial);
          closeSize = `${withClose.size} bytes, ${withClose.staticAccounts} accounts`;
          // Past the size limit the RPC refuses even to simulate it.
          if (!fits(withClose.size, withClose.staticAccounts, req.version)) withClose = null;
        } catch {
          withClose = null; // the two instructions pushed it over the 64 accounts a transaction may name
          closeSize = 'over 64 accounts';
        }
        const closed = withClose ? await measuredSimulation(rpc, withClose.transaction, [E]) : null;
        if (withClose && closed?.ok && closed.lamportsAfter[0] === 0n) {
          trial = withClose;
          sim = closed;
        } else {
          // The close does not fit, or does not return everything: this route is not offered. A
          // narrower one may leave room for it; the next attempt looks there.
          routeRefund = null;
          const why = !withClose ? `the close does not fit: ${closeSize}`
            : !closed?.ok ? `the close fails: ${closed?.error ?? 'no answer'}` : `E keeps ${closed.lamportsAfter[0]} lamports`;
          attempts.push({ excluded, route, simulation: `the market's account under the one-time key cannot be closed in this route (${why})`, blamed: null });
          if (chosen.level + 1 >= MAX_ACCOUNTS_LEVELS.length) throw new OrientimError('no-route', LEFT_UNDER_KEY_MESSAGE);
          minLevel = chosen.level + 1;
          continue;
        }
      }
    }
    // Rent the route would keep beyond what the verifier allows (MAX_ROUTE_KEPT_LAMPORTS): this route
    // cannot be offered; a narrower one may open less.
    if (sim.ok && takerRent - (routeRefund?.lamports ?? 0n) > MAX_ROUTE_KEPT_LAMPORTS) {
      attempts.push({ excluded, route, simulation: `the route keeps ${takerRent - (routeRefund?.lamports ?? 0n)} lamports of rent`, blamed: null });
      if (chosen.level + 1 >= MAX_ACCOUNTS_LEVELS.length) throw new OrientimError('no-route', ROUTE_KEEPS_RENT_MESSAGE);
      minLevel = chosen.level + 1;
      continue;
    }
    attempts.push({ excluded, route, simulation: sim.ok ? 'ok' : simulationReason(sim), blamed: sim.blame ? labels[sim.blame] ?? sim.blame : null });

    if (sim.ok) {
      const chosenPolicy = policyFor(chosen.r);
      // A fee on the output is a share of the minimum, known only now: a swap too small to carry it
      // is refused like any other swap whose fee cannot be collected.
      if (settings.treasury && chosenPolicy.fee <= 0n) throw new OrientimError('amount-too-small', AMOUNT_TOO_SMALL_MESSAGE);
      if (settings.treasury && !sellsWholeBalance && belowMinFee(chosenPolicy.fee, feeMintOf(chosenPolicy), settings.minFee)) {
        throw new OrientimError('amount-too-small', MIN_SWAP_MESSAGE);
      }
      const swapAccounts = chosen.r.swapInstruction.accounts.map(a => address(a.pubkey));
      // The snapshot for the verifier and the fresh blockhash, together (idea 21).
      const writable = chosen.r.swapInstruction.accounts.filter(a => a.isWritable).map(a => address(a.pubkey)).slice(0, 128);
      const [snapshot, { lifetime: finalLifetime, contextSlot }, feeLevel] = await Promise.all([
        fetchSnapshot({
          rpc,
          addresses: [
            ...swapAccounts, E, policy.accounts.eIn, ...(policy.accounts.eOut ? [policy.accounts.eOut] : []),
            // W_out explicitly, not only when Jupiter happens to list it.
            ...(policy.accounts.wOut ? [policy.accounts.wOut] : []),
            ...chosen.intermediates.flatMap(x => [x.ata, x.mint]), req.inputMint, req.outputMint,
            // What is under E before the swap: an account the transaction does not name keeps it after.
            ...underKey,
          ],
          lookupTableAddresses: req.version === 0 ? Object.keys(chosen.r.addressesByLookupTableAddress ?? {}).map(a => address(a)) : [],
          // Not older than the simulation that accepted this route: what the verifier reads (W_out's
          // balance and delegate, the mints, the lookup tables) is at least as recent (item 6).
          ...(sim.slot > 0n ? { minContextSlot: sim.slot } : {}),
        }),
        latestLifetimeAt(rpc),
        // What the pools this swap writes to are paying for priority now: the provider's estimate, else
        // the recent fees on them; the default when neither is known.
        (deps.priorityFee ? deps.priorityFee(writable).catch(() => null) : Promise.resolve(null))
          .then(level => level ?? rpc.getRecentPrioritizationFees(writable).send().then(recentFeeLevel).catch(() => null)),
      ]);

      // Final build with a tight compute budget, a fresh blockhash, and W_out's balance as the
      // verifier will read it from the same snapshot.
      const units = Math.min(MAX_COMPUTE_UNITS, Math.ceil(sim.units * 1.3) + 20_000);
      const outputBalanceBefore = policy.accounts.wOut ? tokenAmountOf(snapshot.accounts.get(policy.accounts.wOut)?.data) : 0n;
      // The priority fee follows the network's load, so a swap is not left behind when it is busy:
      // the recent level on the swap's own pools, never below the default, and always capped so the
      // whole fee stays within R4's limit (two signatures plus priority).
      const feeRoom = (chosenPolicy.maxNetworkFeeLamports < ABSOLUTE_MAX_NETWORK_FEE_LAMPORTS
        ? chosenPolicy.maxNetworkFeeLamports : ABSOLUTE_MAX_NETWORK_FEE_LAMPORTS) - 2n * LAMPORTS_PER_SIGNATURE;
      const wantedPrice = feeLevel !== null && feeLevel > settings.microLamportsPerComputeUnit ? feeLevel : settings.microLamportsPerComputeUnit;
      // A v0 price at the cap leaves room for the compute a wallet may add for its assertions
      // (verifyWalletReturn), so that raise still fits within the limit.
      const maxPrice = (feeRoom * 1_000_000n) / BigInt(units + (req.version === 0 ? MAX_ADDED_COMPUTE_UNITS : 0));
      const microLamports = wantedPrice < maxPrice ? wantedPrice : maxPrice;
      const v1Wanted = (microLamports * BigInt(units) + 999_999n) / 1_000_000n;
      const v1Priority = v1Wanted > settings.priorityFeeLamports ? v1Wanted : settings.priorityFeeLamports;
      const priorityFeeLamports = req.version === 1 ? (v1Priority < feeRoom ? v1Priority : feeRoom) : v1Wanted;
      const priorityFeeCapped = wantedPrice > maxPrice || (req.version === 1 && v1Priority > feeRoom);
      const final = timed(() => compile(chosen.r, finalLifetime, chosen.intermediates, units, outputBalanceBefore, {
        microLamportsPerComputeUnit: microLamports, priorityFeeLamports,
      }));

      // Verified and certified in one step: the certificate exists only if every rule held.
      const verifyStarted = performance.now();
      // A tolerance the person chose is the only one the route may carry; unset, the verifier's own.
      const certification = await certify(final.transaction, chosenPolicy, snapshot, { maxSlippageBps: settings.chosenSlippageBps });
      localMs += performance.now() - verifyStarted;
      verificationMs += performance.now() - verifyStarted;
      const verdict = certification.ok ? { ok: true, violations: [] as Violation[] } : { ok: false, violations: certification.violations };
      // A route through a Token-2022 hop with a transfer hook or permanent delegate is not
      // an error of the pair: exclude that route's DEXes and look for another one.
      if (!verdict.ok && verdict.violations.every(v => v.rule === 'R7' && v.detail.startsWith('intermediate mint'))) {
        attempts[attempts.length - 1].simulation = 'refused hop mint';
        const before = learned.length;
        for (const label of route) if (!excluded.includes(label)) learned.push(label);
        if (learned.length === before) break;
        continue;
      }
      if (!verdict.ok) {
        throw new OrientimError('verification-failed', 'A protected transaction cannot be produced.', verdict.violations);
      }

      // The cluster prices the exact message. Fail closed: without a price there is
      // no proof that the fee stays under the limit, so nothing goes to the wallet.
      const feeLimit = chosenPolicy.maxNetworkFeeLamports < ABSOLUTE_MAX_NETWORK_FEE_LAMPORTS
        ? chosenPolicy.maxNetworkFeeLamports
        : ABSOLUTE_MAX_NETWORK_FEE_LAMPORTS;
      const priceMessage = () => rpc
        .getFeeForMessage(getBase64Decoder().decode(final.transaction.messageBytes) as never, { commitment: 'confirmed' })
        .send()
        .then(r => r.value)
        .catch(() => null);
      const clusterFee = (await priceMessage()) ?? (await priceMessage());
      if (clusterFee === null) {
        throw new OrientimError('unavailable', "Orientim's RPC did not price the transaction's network fee, so nothing was signed. Try again in a moment.");
      }
      if (BigInt(clusterFee) > feeLimit) {
        throw new OrientimError('verification-failed', 'The network fee would be above the limit.', [
          { rule: 'R4', detail: `the cluster prices this transaction at ${clusterFee} lamports, above ${feeLimit}` },
        ]);
      }

      const createsOutputAccount = !!policy.accounts.wOut && !snapshot.accounts.get(policy.accounts.wOut);
      if (!certification.ok) throw new OrientimError('verification-failed', 'A protected transaction cannot be produced.', certification.violations);

      // The exact transaction the wallet will sign, simulated once more: it must execute, and leave
      // nothing under E. A simulation whose balances cannot be matched to the transaction's accounts
      // reads as failed, never as empty. Checked with them: every account the route is given that
      // did not exist before the swap, besides the wallet's own output account and the treasury.
      // What a market opens and leaves open may hold a claim tied to E, whichever market it is, so
      // none may stay open. The balances come from `postBalances`, not from `accounts.addresses`,
      // which some providers limit to two; an account the transaction does not name holds after it
      // what the snapshot read before it.
      const existed = (a: Address) => {
        const state = snapshot.accounts.get(a);
        return !!state && (state.lamports > 0n || state.data.length > 0);
      };
      const kept = new Set<string>([policy.accounts.wOut, settings.treasury].filter((a): a is Address => !!a));
      const opened = [...new Set(swapAccounts)].filter(a => !existed(a) && !kept.has(a) && !underKey.includes(a));
      // On state no older than the snapshot the verifier just read (and the simulation before it).
      const seenAt = (snapshot.slot ?? 0n) > sim.slot ? snapshot.slot! : sim.slot;
      const last = await measuredSimulation(rpc, final.transaction, [], {
        ...(seenAt > 0n ? { minContextSlot: seenAt } : {}),
        balances: { lookupTables: snapshot.lookupTables },
      });
      if (!last.ok) {
        attempts.push({ excluded, route, simulation: `final transaction: ${simulationReason(last)}`, blamed: null });
        continue;
      }
      // Null when neither the simulation nor the snapshot says what the account holds.
      const heldAfter = (a: Address): bigint | null => {
        const after = last.balancesAfter.get(a);
        if (after !== undefined) return after;
        if (!snapshot.accounts.has(a)) return null;
        return snapshot.accounts.get(a)?.lamports ?? 0n;
      };
      if (underKey.some(a => heldAfter(a) !== 0n)) throw new OrientimError('no-route', LEFT_UNDER_KEY_MESSAGE);
      const leftOpen = opened.filter(a => heldAfter(a) !== 0n);
      if (leftOpen.length) {
        // Another route, without the markets on this one, may open nothing it leaves behind.
        attempts[attempts.length - 1].simulation = `the route leaves open ${leftOpen.length} account(s) it creates: ${leftOpen.join(', ')}`;
        const before = learned.length;
        for (const label of route) if (!excluded.includes(label) && !learned.includes(label)) learned.push(label);
        if (learned.length === before) throw new OrientimError('no-route', LEFT_UNDER_KEY_MESSAGE);
        continue;
      }

      return {
        oneTimeCosts: {
          outputAccountRent: createsOutputAccount ? newAccountRent : 0n, routeRent: chosenPolicy.takerRent, routeRefund: chosenPolicy.routeRefund,
        },
        certificate: certification.certificate,
        timings: {
          totalMs: Math.round(performance.now() - started), localMs: Math.round(localMs), initialMs: Math.round(initialMs),
          jupiterBuildMs: Math.round(jupiterBuildMs), jupiterBuildCalls,
          simulationMs: Math.round(simulationMs), simulationCalls, verificationMs: Math.round(verificationMs),
        },
        networkFeeLamports: BigInt(clusterFee),
        outputBalanceBefore,
        priorityFeeLamports,
        priorityFeeCapped,
        notices: { removesDelegate },
        tokenTax: inputFee ? { inputBps: inputFee.bps, extraOnInput: taxOnInput } : null,
        intermediates: chosen.intermediates,
        policy: chosenPolicy,
        version: req.version,
        transaction: final.transaction,
        lifetime: finalLifetime,
        contextSlot,
        size: final.size,
        computeUnits: units,
        quote: {
          inAmount: BigInt(chosen.r.inAmount),
          outAmount: BigInt(chosen.r.outAmount),
          minOut: chosenPolicy.minOut,
          minReceived: minimumReceived(chosenPolicy),
          route,
          priceImpactPct: priceImpactOf(chosen.r.priceImpactPct),
          baselineOut,
          gapBps: chosenGapBps,
        },
        attempts,
      };
    }

    // The swap delivered less than the floor, or W_out's balance moved since it was read (the
    // check is b0 + minOut), or the route itself saw the price move past its threshold. All are
    // transient: re-read W_out and requote, without blaming DEXes.
    if (
      failedAtFloorCheck(trial.transaction, sim.failedInstruction, chosen.r.addressesByLookupTableAddress)
      || routeMissedItsThreshold(sim.logs, settings.jupiterProgram)
    ) {
      attempts[attempts.length - 1].simulation = 'output below the minimum';
      if (++floorMisses >= 2) {
        // A lower minimum is worth the user's approval only when this route would still be built
        // at one; otherwise the market or the output account moved while Orientim checked.
        if (accepted > 0n && routeFloor(chosen.r, slippageFor(chosen.r, settings)) < accepted) {
          throw priceMoved(chosen.r, 'In simulation the route delivered less than your minOut twice: the price moved beyond the slippage tolerance. Nothing was signed.');
        }
        throw new OrientimError('simulation-failed', "In simulation the route delivered less than its minimum twice: the price moved, or the output account's balance changed while Orientim checked. No funds were moved; try again.");
      }
      if (policy.accounts.wOut) {
        const state = (await fetchAccounts(rpc, [policy.accounts.wOut])).get(policy.accounts.wOut);
        wOutBefore = { exists: !!state, balance: tokenAmountOf(state?.data) };
      }
      continue;
    }

    // A failure before the swap is in Orientim's own instructions, which draw only on the wallet: no
    // route is to blame and no other route would fare better.
    const swapAt = compiledInstructions(trial.transaction).findIndex(ix => ix.program === settings.jupiterProgram);
    if (sim.failedInstruction !== null && swapAt >= 0 && sim.failedInstruction < swapAt) {
      throw new OrientimError(
        'simulation-failed',
        `The swap would fail in its first steps, before it reaches the market, so no other route would help (${sim.error}). Check your balance of the input token and try again.`,
      );
    }

    // Route repair: exclude the DEX to blame; if our own cleanup failed, the route left
    // funds behind, so exclude every DEX on it.
    const before = learned.length;
    const blamedLabel = sim.blame && !isInfrastructureProgram(sim.blame) ? labels[sim.blame] : null;
    for (const label of blamedLabel ? [blamedLabel] : route) {
      if (!excluded.includes(label)) learned.push(label);
    }
    if (learned.length === before) break;
  }
  // Every route tried could not return the deposit its market kept under E: that is the reason, not
  // a failed simulation.
  if (attempts.length && attempts.every(a => a.simulation.startsWith("the market's account under the one-time key"))) {
    throw new OrientimError('no-route', LEFT_UNDER_KEY_MESSAGE);
  }
  // Every route tried would keep more rent than the rules allow: that is the reason.
  if (attempts.length && attempts.every(a => a.simulation.startsWith('the route keeps'))) {
    throw new OrientimError('no-route', ROUTE_KEEPS_RENT_MESSAGE);
  }
  throw new OrientimError('simulation-failed', `Every route failed in simulation. No funds were moved. ${why(attempts)}`);
}

/** What signing last needs from a prepared swap: the verified message, whose it is, and how long it lives. */
export type Countersignable = {
  transaction: Transaction;
  lifetime: { lastValidBlockHeight: bigint };
  /** F_max: what a compute limit a wallet raised must stay within (acceptAssertions). */
  policy: { owner: Address; maxNetworkFeeLamports?: bigint };
};

/**
 * The lookup tables named by the verified message and by the one the wallet returned, read on chain,
 * whenever either names any and the two messages differ: Phantom recompiles the message when it adds
 * assertions, with tables or entries of its own and its own order, so its accounts are compared by
 * address (verifyWalletReturn). Undefined when neither names a table, the messages are the same or
 * the returned bytes cannot be read; empty when the tables cannot be fetched, which the check refuses.
 */
async function lookupTablesOf(rpc: SolanaRpc, original: Transaction, returnedBytes: Uint8Array): Promise<Map<string, string[]> | undefined> {
  try {
    const decode = getCompiledTransactionMessageDecoder();
    type Lookups = { addressTableLookups?: { lookupTableAddress: Address }[] };
    const returned = getTransactionDecoder().decode(returnedBytes).messageBytes;
    if (returned.length === original.messageBytes.length && returned.every((b, i) => b === original.messageBytes[i])) return undefined;
    const keysOf = (bytes: Transaction['messageBytes']) => ((decode.decode(bytes) as unknown as Lookups).addressTableLookups ?? []).map(l => l.lookupTableAddress);
    const keys = [...new Set([...keysOf(original.messageBytes), ...keysOf(returned)])];
    if (!keys.length) return undefined;
    // A table that cannot be read is said as such (an empty map), not as "the tables changed".
    const found = await fetchAddressesForLookupTables(keys, rpc as never).catch(() => ({}));
    return new Map(Object.entries(found).map(([k, v]) => [k, (v as string[]).map(x => x as string)]));
  } catch {
    return undefined;
  }
}

/**
 * The wallet has signed first. Check that it signed exactly the verified message, still in its
 * lifetime, then E signs last. Without E's signature the transaction can never execute, so
 * this is the only place a Orientim transaction becomes sendable.
 */
export async function countersignProtectedSwap(args: {
  rpc: SolanaRpc;
  prepared: Countersignable;
  walletSignedBytes: Uint8Array;
  ephemeral: KeyPairSigner;
  /**
   * The chain already has this transaction, so its lifetime no longer matters: the agent API answers
   * a repeated finalize with the same signed bytes and sends nothing.
   */
  landed?: boolean;
  /**
   * Accept Lighthouse assertions the wallet added (verifyWalletReturn), as a browser wallet such as
   * Phantom may. The agent API signs only exactly what it built.
   */
  acceptAssertions?: boolean;
}): Promise<FullySignedTransaction & Transaction> {
  const { rpc, prepared, ephemeral } = args;
  const check = await verifyWalletReturn(
    prepared.transaction, args.walletSignedBytes, prepared.policy.owner, ephemeral.address,
    {
      acceptAssertions: args.acceptAssertions, maxNetworkFeeLamports: prepared.policy.maxNetworkFeeLamports,
      ...(args.acceptAssertions ? { lookupTables: await lookupTablesOf(rpc, prepared.transaction, args.walletSignedBytes) } : {}),
    },
  );
  if (!check.ok || !check.transaction) {
    throw new OrientimError('wallet-changed-transaction', 'The wallet changed the transaction, so it was stopped for your safety.', check.violations);
  }
  const height = args.landed ? null : await rpc.getBlockHeight({ commitment: 'confirmed' }).send();
  if (height !== null && height > prepared.lifetime.lastValidBlockHeight) {
    throw new OrientimError('expired', 'The transaction expired before it was signed. Build it again.');
  }
  const signed = await partiallySignTransaction([ephemeral.keyPair], check.transaction);
  assertIsFullySignedTransaction(signed);
  return signed;
}
