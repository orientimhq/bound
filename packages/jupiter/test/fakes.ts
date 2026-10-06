/**
 * A fake RPC and a fake Jupiter that answer the way the chain and Jupiter do (or the way an attacker
 * would), shared by the pipeline's tests and the agent API's.
 */
import {
  address, decompileTransactionMessage, getAddressEncoder, getCompiledTransactionMessageDecoder, getSignatureFromTransaction,
  getTransactionDecoder,
} from '@solana/kit';
import type { Address } from '@solana/kit';
import {
  ataOf, ATA_PROGRAM, CLOSE_USER_VOLUME_ACCUMULATOR, JUPITER_PROGRAM, MAX_TAKER_RENT_LAMPORTS, routeAccountOf, SYSTEM_PROGRAM, TOKEN_2022_PROGRAM,
  TOKEN_PROGRAM, WSOL_MINT,
} from '@orientim/core';
import type { SolanaRpc } from '@orientim/solana';
import { JupiterError } from '../src/client.ts';
import type { BuildParams, BuildResponse, JupiterClient } from '../src/client.ts';

export const USDC = address('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');
export const BONK = address('DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263');
export const DECIMALS: Record<string, number> = { [USDC]: 6, [WSOL_MINT]: 9, [BONK]: 5 };
export const DEX = address('whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc');
export const POOL = address('HJPjoWUrhoZzkNfRpHuieeFk9WcZWjwy6PBjZ81ngndJ');
export const OUT = 1_000_000_000n;
export const PUMP = address('6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P');
/** Pump's per-buyer account on the curve: 137 bytes, 1,346,200 lamports of rent today. */
const ROUTE_ACCOUNT_SIZE = 137;
const JUPITER_EVENT_AUTHORITY = address('D8cy77BBepLMngZx6ZukaTff5hCt1HrWyKk3Hnd9oitf');
export const b64 = (d: Uint8Array) => Buffer.from(d).toString('base64');

export type Account = { owner: Address; data: Uint8Array };

export function mint(decimals: number): Account {
  const data = new Uint8Array(82);
  data[44] = decimals;
  return { owner: TOKEN_PROGRAM, data };
}

/** A Token-2022 mint that charges `bps` on every transfer, with no cap. */
export function feeMint(decimals: number, bps: number): Account {
  const data = new Uint8Array(166 + 4 + 108);
  data[44] = decimals;
  data[165] = 1; // AccountType::Mint
  const view = new DataView(data.buffer);
  view.setUint16(166, 1, true); // TransferFeeConfig
  view.setUint16(168, 108, true);
  const newer = 170 + 90; // two authorities, the withheld amount, then older and newer
  view.setBigUint64(newer, 0n, true); // from epoch 0
  view.setBigUint64(newer + 8, 2n ** 63n, true); // no practical cap
  view.setUint16(newer + 16, bps, true);
  return { owner: TOKEN_2022_PROGRAM, data };
}

/** A Token-2022 mint that runs a transfer hook: arbitrary code on every transfer of it. */
export function hookMint(decimals: number, program: Address): Account {
  const data = new Uint8Array(166 + 4 + 64);
  data[44] = decimals;
  data[165] = 1; // AccountType::Mint
  const view = new DataView(data.buffer);
  view.setUint16(166, 14, true); // TransferHook
  view.setUint16(168, 64, true);
  data.set(getAddressEncoder().encode(program), 170 + 32); // authority, then the program it calls
  return { owner: TOKEN_2022_PROGRAM, data };
}

/** A plain Token-2022 mint with no extensions at all. */
export function plain2022Mint(decimals: number): Account {
  const data = new Uint8Array(166);
  data[44] = decimals;
  data[165] = 1;
  return { owner: TOKEN_2022_PROGRAM, data };
}

export function tokenAccount(
  owner: Address, mintAddress: Address, opts: { delegate?: boolean; memo?: boolean; frozen?: boolean; amount?: bigint } = {},
): Account {
  // A Token-2022 account that requires a memo carries extension 8 after the account-type byte.
  const data = new Uint8Array(opts.memo ? 171 : 165);
  data.set(getAddressEncoder().encode(mintAddress), 0);
  data.set(getAddressEncoder().encode(owner), 32);
  new DataView(data.buffer).setBigUint64(64, opts.amount ?? 0n, true);
  if (opts.delegate) data[72] = 1;
  data[108] = opts.frozen ? 2 : 1; // initialized, or frozen by the mint's freeze authority
  if (opts.memo) {
    data[165] = 2; // AccountType::Account
    new DataView(data.buffer).setUint16(166, 8, true); // MemoTransfer
    new DataView(data.buffer).setUint16(168, 1, true);
    data[170] = 1; // requireIncomingTransferMemos = true
  }
  return { owner: TOKEN_PROGRAM, data };
}

/** The wallet's accounts for a token under both token programs, holding plenty of it. */
export async function fundedAccounts(
  owner: Address, mintAddress: Address, opts: { amount?: bigint; frozen?: boolean } = {},
): Promise<[string, Account][]> {
  return Promise.all([TOKEN_PROGRAM, TOKEN_2022_PROGRAM].map(async tp =>
    [await ataOf(owner, mintAddress, tp), tokenAccount(owner, mintAddress, { amount: opts.amount ?? 10n ** 15n, frozen: opts.frozen })] as [string, Account]));
}

/**
 * The SOL a transaction sends the temporary key: the signer that is not the fee payer, credited by
 * a System transfer (instruction 2).
 */
export function lamportsSentToTaker(wire: string): {
  taker: string; lamports: bigint; swapIndex: number;
  /** The transaction closes the account a Pump market opened for the taker. */
  closesRouteAccount: boolean;
  /** What the taker sends on, to the wallet, after the close. */
  sentByTaker: bigint;
  /** The accounts the swap instruction passes: only an account passed there can be opened under E. */
  swapAccounts: string[];
} {
  const tx = getTransactionDecoder().decode(Uint8Array.from(Buffer.from(wire, 'base64')));
  const compiled = getCompiledTransactionMessageDecoder().decode(tx.messageBytes);
  const message = decompileTransactionMessage(compiled as never);
  const taker = compiled.staticAccounts.slice(1, compiled.header.numSignerAccounts)[0];
  let lamports = 0n;
  let sentByTaker = 0n;
  let closesRouteAccount = false;
  for (const ix of message.instructions) {
    const data = ix.data ?? new Uint8Array();
    if (ix.programAddress === SYSTEM_PROGRAM && data[0] === 2) {
      const amount = new DataView(data.buffer, data.byteOffset, data.byteLength).getBigUint64(4, true);
      if (ix.accounts?.[1]?.address === taker) lamports += amount;
      if (ix.accounts?.[0]?.address === taker) sentByTaker += amount;
    }
    if (ix.programAddress === PUMP && data.length === 8 && CLOSE_USER_VOLUME_ACCUMULATOR.every((b, i) => data[i] === b)) closesRouteAccount = true;
  }
  const swap = message.instructions.find(ix => ix.programAddress === JUPITER_PROGRAM);
  return {
    taker, lamports, swapIndex: message.instructions.findIndex(ix => ix.programAddress === JUPITER_PROGRAM), closesRouteAccount, sentByTaker,
    swapAccounts: (swap?.accounts ?? []).map(a => a.address as string),
  };
}

export function fakeRpc(
  accounts: Map<string, Account>,
  opts: {
    feeFails?: boolean; epochFails?: boolean; takerRent?: bigint; priceMoves?: number; walletShort?: boolean;
    feeLevels?: bigint[] | 'fails'; simulations?: { count: number };
    /**
     * The market's rent moves between simulations: this many times, E funded with its measured rent
     * is left with less than an empty account's rent, and the network refuses the transaction.
     */
    rentMoves?: number;
    /** The route spends so nearly all of the ceiling that E, probed with it, is left rent-paying. */
    rentDeadBand?: boolean;
    /** The block height the chain reports (the fake blockhash lives until 1,000). */
    height?: bigint;
    /** Every transaction sent, as the wire string. */
    sent?: string[];
    /** What sendTransaction throws instead of accepting (a preflight refusal, say). */
    sendError?: unknown;
    /** Lamports a Pump cashback coin leaves in the buyer's account on top of its rent. */
    cashback?: bigint;
    /** How many simulations the Pump curve itself refuses on price (6003), inside Jupiter. */
    pumpSlippage?: number;
    /** Orientim's own transfer from the wallet fails, before the swap (a balance that changed, say). */
    failBeforeSwap?: boolean;
    /** What the chain knows of each signature; unknown ones have no status. */
    statuses?: Map<string, { confirmationStatus: 'processed' | 'confirmed' | 'finalized'; err: unknown }>;
    /** A transaction lands, confirmed, when it is sent (into `statuses`). */
    landOnSend?: boolean;
    /** Reading a status fails. */
    statusFails?: boolean;
    /** Accounts the route opens and leaves open, holding their rent after the swap. */
    leavesOpen?: readonly string[];
    /** The RPC reports no `postBalances` (an older node). */
    noPostBalances?: boolean;
    /** Lamports the taker holds after the swap, in the balances a simulation reports for every account. */
    takerKeepsAfter?: bigint;
  } = {},
): SolanaRpc {
  const call = (fn: (...a: never[]) => unknown) => (...a: never[]) => ({ send: async () => fn(...a) });
  let moved = 0;
  let pumpMoved = 0;
  let rentMoved = 0;
  return {
    getMultipleAccounts: call((addresses: string[]) => ({
      context: { slot: 300_000_000n },
      value: addresses.map(a => {
        const acc = accounts.get(a);
        return acc ? { owner: acc.owner, lamports: 2_000_000n, data: [b64(acc.data), 'base64'], executable: false, space: BigInt(acc.data.length) } : null;
      }),
    })),
    getLatestBlockhash: call(() => ({ value: { blockhash: '11111111111111111111111111111111', lastValidBlockHeight: 1_000n } })),
    getBlockHeight: call(() => opts.height ?? 1n),
    sendTransaction: call((wire: string) => {
      if (opts.sendError) throw opts.sendError;
      opts.sent?.push(wire);
      if (opts.landOnSend) {
        const signature = getSignatureFromTransaction(getTransactionDecoder().decode(Buffer.from(wire, 'base64')));
        opts.statuses?.set(signature, { confirmationStatus: 'confirmed', err: null });
      }
      return 'sig';
    }),
    getSignatureStatuses: call((signatures: string[]) => {
      if (opts.statusFails) throw new Error('RPC unavailable');
      return { value: signatures.map(s => opts.statuses?.get(s) ?? null) };
    }),
    // A route that opens an account in the taker's name fails, as PumpSwap does, until the taker
    // holds its rent; with it, the taker ends holding whatever it was sent beyond the rent.
    simulateTransaction: call(async (wire: string, config: { accounts?: { addresses: string[] } }) => {
      // Like the real RPC: a transaction over the size limit is not even simulated.
      const raw = Buffer.from(wire, 'base64');
      // A v1 transaction starts with its version byte (129); v0 starts with its signature count.
      const v1 = raw[0] === 129 || raw[1 + 64 * raw[0]] === 129;
      if (raw.length > (v1 ? 4096 : 1232)) {
        throw new Error(`Invalid method parameter(s) (base64 encoded transaction too large: ${raw.length} bytes)`);
      }
      // Like a provider that limits `accounts.addresses` to two.
      if ((config.accounts?.addresses.length ?? 0) > 2) {
        throw new Error('Invalid params: too many accounts provided; max 2');
      }
      const need = opts.takerRent ?? 0n;
      if (opts.simulations) opts.simulations.count++;
      const { taker, lamports, swapIndex, closesRouteAccount, sentByTaker, swapAccounts } = lamportsSentToTaker(wire);
      // The wallet cannot pay for its own part: the first instruction, a rent payment, fails.
      if (opts.walletShort) {
        return { value: { err: { InstructionError: [0, { Custom: 1 }] }, logs: ['Transfer: insufficient lamports 400000, need 2039280'], unitsConsumed: 5_000n } };
      }
      if (lamports < need) {
        return { value: { err: { InstructionError: [swapIndex, { Custom: 1 }] }, logs: [`Transfer: insufficient lamports ${lamports}, need ${need}`], unitsConsumed: 90_000n } };
      }
      // E (account 1) left rent-paying: a transaction error, with no failing instruction. The rent
      // moves after the probe (funded with the ceiling), or the route spends nearly all of the ceiling.
      if ((opts.rentDeadBand && lamports === MAX_TAKER_RENT_LAMPORTS) || (lamports > 0n && lamports < MAX_TAKER_RENT_LAMPORTS && rentMoved < (opts.rentMoves ?? 0))) {
        rentMoved++;
        return { value: { err: { InsufficientFundsForRent: { account_index: 1 } }, logs: [], unitsConsumed: 90_000n } };
      }
      if (opts.failBeforeSwap) {
        return {
          value: {
            err: { InstructionError: [swapIndex - 1, { Custom: 1 }] }, unitsConsumed: 20_000n,
            logs: [`Program ${TOKEN_PROGRAM} invoke [1]`, 'Program log: Error: insufficient funds', `Program ${TOKEN_PROGRAM} failed: custom program error: 0x1`],
          },
        };
      }
      // The price moves between the quote and the simulation, and the curve stops it inside Jupiter.
      if (pumpMoved < (opts.pumpSlippage ?? 0)) {
        pumpMoved++;
        return {
          value: {
            err: { InstructionError: [swapIndex, { Custom: 6003 }] }, unitsConsumed: 150_000n,
            logs: [
              `Program ${JUPITER_PROGRAM} invoke [1]`, `Program ${PUMP} invoke [2]`,
              `Program ${PUMP} failed: custom program error: 0x1773`, `Program ${JUPITER_PROGRAM} failed: custom program error: 0x1773`,
            ],
          },
        };
      }
      // The price moves between the quote and the simulation, and Jupiter stops the route itself.
      if (moved < (opts.priceMoves ?? 0)) {
        moved++;
        return {
          value: {
            err: { InstructionError: [swapIndex, { Custom: 6001 }] }, unitsConsumed: 150_000n,
            logs: [`Program ${JUPITER_PROGRAM} invoke [1]`, `Program ${JUPITER_PROGRAM} failed: custom program error: 0x1771`],
          },
        };
      }
      // E keeps what it was sent beyond the rent; the account the market opened for E (Pump's
      // per-buyer account) holds the rent.
      // A cashback coin's account also holds the cashback the trade earned.
      // Closed, the market's account hands everything it held to E, and E sends on what the
      // transaction says; whatever is left stays with E.
      const after = async (a: string): Promise<{ lamports: bigint; data?: [string, 'base64'] } | null> => {
        const held = need > 0n ? need + (opts.cashback ?? 0n) : 0n;
        if (a === taker) {
          const left = lamports - need + (closesRouteAccount ? held : 0n) - sentByTaker;
          return left > 0n ? { lamports: left } : null;
        }
        // The market opens its account under E only when the route passes it; otherwise the rent
        // went to an account of the market's own.
        if (a === (await routeAccountOf(PUMP, taker as Address)) && need > 0n && !closesRouteAccount && swapAccounts.includes(a)) {
          return { lamports: held, data: [b64(new Uint8Array(ROUTE_ACCOUNT_SIZE)), 'base64'] };
        }
        if (opts.leavesOpen?.includes(a) && swapAccounts.includes(a)) return { lamports: 2_039_280n, data: [b64(new Uint8Array(165)), 'base64'] };
        // Every other account holds what getMultipleAccounts says it holds.
        return accounts.has(a) ? { lamports: 2_000_000n } : null;
      };
      const keys = getCompiledTransactionMessageDecoder().decode(getTransactionDecoder().decode(raw).messageBytes).staticAccounts;
      return {
        value: {
          err: null, logs: [], unitsConsumed: 200_000n,
          accounts: await Promise.all((config.accounts?.addresses ?? []).map(after)),
          // Balances after the transaction, in the order of its accounts, as a real RPC reports them.
          postBalances: opts.noPostBalances ? null : await Promise.all(keys.map(async a =>
            ((await after(a))?.lamports ?? 0n) + (a === taker ? opts.takerKeepsAfter ?? 0n : 0n))),
          loadedAddresses: { writable: [], readonly: [] },
        },
      };
    }),
    getFeeForMessage: call(() => {
      if (opts.feeFails) throw new Error('RPC unavailable');
      return { value: 15_000n };
    }),
    getMinimumBalanceForRentExemption: call((size: bigint) => (
      BigInt(size) === 0n ? 650_240n : BigInt(size) === BigInt(ROUTE_ACCOUNT_SIZE) ? 1_346_200n : 1_488_440n)),
    getBalance: call(() => ({ value: 400_000n })),
    getRecentPrioritizationFees: call(() => {
      if (opts.feeLevels === 'fails') throw new Error('RPC unavailable');
      return (opts.feeLevels ?? []).map((prioritizationFee, i) => ({ slot: BigInt(i), prioritizationFee }));
    }),
    getEpochInfo: call(() => {
      if (opts.epochFails) throw new Error('RPC unavailable');
      return { epoch: 900n };
    }),
  } as unknown as SolanaRpc;
}

/** Answers like Jupiter for whatever is asked, with the floor and amounts an attacker chooses. */
export function fakeJupiter(answer: {
  threshold?: bigint; inAmountFactor?: bigint; failFirst?: number; extraAccounts?: readonly Address[];
  worseByBps?: bigint; hop?: { mint: Address; tokenProgram: Address }; label?: string; asked?: BuildParams[];
  /** What the whole market gives for the amount, instead of OUT: a pool a compromised server chose, say. */
  out?: bigint;
  /** The route's swap instruction names the Pump.fun curve program, as a real curve route does. */
  curveProgram?: boolean;
  /** The route passes the account the curve opens for the buyer, as a real Pump route does. */
  routeAccount?: boolean;
  /** Jupiter answers with a swap instruction of a format nobody has seen yet. */
  unknownFormat?: boolean;
  /** Jupiter's program labels; by default one for HumidiFi, at a program no route here passes. */
  labels?: Record<string, string> | 'down';
} = {}): JupiterClient {
  let calls = 0;
  return {
    async build(p: BuildParams): Promise<BuildResponse> {
      answer.asked?.push(p);
      if (calls++ < (answer.failFirst ?? 0)) throw new JupiterError('Jupiter 400: No matching liquidity', 400);
      const E = p.taker;
      const eIn = await ataOf(E, p.inputMint);
      const destination = p.destinationTokenAccount ?? (await ataOf(E, WSOL_MINT));
      const meta = (pubkey: string, isSigner = false, isWritable = false) => ({ pubkey, isSigner, isWritable });
      // The baseline is asked for without exclusions and a protected route with them, so this is how
      // a route that costs more than the open market is simulated.
      const market = answer.out ?? OUT;
      const outAmount = p.excludeDexes?.length ? (market * (10_000n - (answer.worseByBps ?? 0n))) / 10_000n : market;
      return {
        inputMint: p.inputMint,
        outputMint: p.outputMint,
        inAmount: (p.amount * (answer.inAmountFactor ?? 1n)).toString(),
        outAmount: outAmount.toString(),
        // Like Jupiter, every answer states the route's price impact.
        priceImpactPct: '0',
        // Like Jupiter, the threshold is this route's quote less the slippage it was asked for.
        otherAmountThreshold: (answer.threshold ?? (outAmount * BigInt(10_000 - p.slippageBps)) / 10_000n).toString(),
        routePlan: [{ percent: 100, swapInfo: { label: answer.label ?? 'Whirlpool', ammKey: POOL } }],
        computeBudgetInstructions: [],
        // Jupiter asks for an ATA of the taker for every token the route passes through. Orientim
        // does not run these; it recreates the accounts itself and closes them again.
        setupInstructions: answer.hop
          ? [{
            programId: ATA_PROGRAM,
            accounts: [
              meta(E, true, true), meta(await ataOf(E, answer.hop.mint, answer.hop.tokenProgram), false, true),
              meta(E), meta(answer.hop.mint), meta(SYSTEM_PROGRAM), meta(answer.hop.tokenProgram),
            ],
            data: b64(new Uint8Array([1])),
          }]
          : [],
        // Laid out like route_v2 (Jupiter's IDL on chain): a requested destination is the optional
        // account at index 7, and the taker's own account for the output is passed at index 2 anyway.
        swapInstruction: {
          programId: JUPITER_PROGRAM,
          accounts: [
            meta(E, true), meta(eIn, false, true),
            meta(p.destinationTokenAccount ? await ataOf(E, p.outputMint) : destination, false, true),
            meta(p.inputMint), meta(p.outputMint), meta(TOKEN_PROGRAM), meta(TOKEN_PROGRAM),
            p.destinationTokenAccount ? meta(p.destinationTokenAccount, false, true) : meta(JUPITER_PROGRAM),
            meta(JUPITER_EVENT_AUTHORITY), meta(JUPITER_PROGRAM),
            meta(DEX), meta(POOL, false, true),
            // A large swap splits over many pools; enough of them and nothing fits in one transaction.
            ...(answer.extraAccounts ?? []).map(a => meta(a, false, true)),
            ...(answer.curveProgram ? [meta(PUMP)] : []),
            ...(answer.routeAccount ? [meta(await routeAccountOf(PUMP, E), false, true)] : []),
          ],
          data: b64(answer.unknownFormat
            ? new Uint8Array([229, 23, 203, 151, 122, 227, 173, 42, 1, 2, 3, 4])
            : routeV2Data(p.amount * (answer.inAmountFactor ?? 1n), outAmount, p.slippageBps)),
        },
        cleanupInstruction: null,
        otherInstructions: [],
        addressesByLookupTableAddress: null,
      };
    },
    async searchTokens() {
      return [];
    },
    async programLabels() {
      if (answer.labels === 'down') throw new JupiterError('Jupiter 503: unavailable', 503);
      return answer.labels ?? { [HUMIDIFI_PROGRAM]: 'HumidiFi' };
    },
  };
}

/** A program labeled HumidiFi in the fake's labels, which no fake route passes. */
export const HUMIDIFI_PROGRAM = address('9H6tua7jkLhdm3w8BvgpTn5LZNU7g4ZynDhCiNN3q6Rp');

/**
 * Jupiter's route_v2 data as /swap/v2/build returns it: discriminator, amount in, quoted amount out,
 * tolerance, platform fee and positive slippage (both 0), then a one-step route plan.
 */
export function routeV2Data(inAmount: bigint, quotedOut: bigint, slippageBps = 50): Uint8Array {
  const d = new Uint8Array(8 + 22 + 4 + 6);
  d.set([0xbb, 0x64, 0xfa, 0xcc, 0x31, 0xc4, 0xaf, 0x14], 0);
  const v = new DataView(d.buffer);
  v.setBigUint64(8, inAmount, true);
  v.setBigUint64(16, quotedOut, true);
  v.setUint16(24, slippageBps, true);
  v.setUint32(30, 1, true);
  d.set([0x97, 0x01, 0x10, 0x27, 0x00, 0x01], 34);
  return d;
}
