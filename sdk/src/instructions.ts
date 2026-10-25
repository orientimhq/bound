/**
 * The Guard's five instructions, byte for byte as programs/guard/src/lib.rs reads them, and the
 * addresses they derive. Every builder takes its accounts explicitly; `accountsFor` fills the usual
 * ones from the owner, the agent and the two mints.
 */
import { AccountRole, getAddressEncoder, getProgramDerivedAddress } from '@solana/kit';
import type { AccountMeta, Address, Instruction } from '@solana/kit';

export const SYSTEM_PROGRAM = '11111111111111111111111111111111' as Address;
export const TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA' as Address;
export const TOKEN_2022_PROGRAM = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb' as Address;
export const ATA_PROGRAM = 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL' as Address;
export const SYSVAR_INSTRUCTIONS = 'Sysvar1nstructions1111111111111111111111111' as Address;
export const COMPUTE_BUDGET = 'ComputeBudget111111111111111111111111111111' as Address;
export const JUPITER_PROGRAM = 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4' as Address;
/** The treasury compiled into the program (a placeholder until deployment). */
export const TREASURY = 'syQjBykbfYCGSSeLZSyEb2vJ2XMbHDfXoKsrVwCsDDq' as Address;
/** Orientim's fee on the input, fixed in the program. */
export const FEE_BPS = 25n;
export const feeOf = (amount: bigint) => (amount * FEE_BPS) / 10_000n;

/** The program's custom error codes (`GuardError`); the numbers are part of the interface. */
export const ERR = {
  NotOwner: 1, BadPolicy: 2, BadGrant: 3, Paused: 4, AgentNotActive: 5, UnknownVerifier: 6, MustBeTopLevel: 7,
  BadShape: 8, ProgramNotAllowed: 9, MintNotAllowed: 10, OverSwapLimit: 11, OverDailyLimit: 12, BadTokenAccount: 13,
  NotDelegated: 14, BadTreasury: 15, UnsafeMint: 16, SwapInProgress: 17, NoSwapInProgress: 18, MismatchedSettle: 19,
  BelowMinimum: 20, HopperShort: 21, BadAmount: 22, Math: 23, SecondVerifierMissing: 24,
  BadOracle: 25, StalePrice: 26, PriceUncertain: 27, BelowOracle: 28, Unpriced: 29, LossBudgetSpent: 30,
} as const;

export const STATUS = { active: 0, paused: 1, revoked: 2 } as const;
export const MAX_VERIFIERS = 2;
export const MAX_PROGRAMS = 4;
export const MAX_LIMITS = 4;
export const MAX_OUTPUTS = 4;
export const MAX_FEEDS = 8;

const enc = getAddressEncoder();
const key = (a: Address) => Uint8Array.from(enc.encode(a));
const ZERO = new Uint8Array(32);
const u16 = (v: number) => Uint8Array.of(v & 0xff, (v >> 8) & 0xff);
const u64 = (v: bigint) => {
  const b = new Uint8Array(8);
  new DataView(b.buffer).setBigUint64(0, v, true);
  return b;
};
const i64 = (v: bigint) => {
  const b = new Uint8Array(8);
  new DataView(b.buffer).setBigInt64(0, v, true);
  return b;
};
const bytes = (...parts: (Uint8Array | number[])[]) => Uint8Array.from(parts.flatMap(p => [...p]));
const keys = (list: Address[], n: number) => {
  if (list.length > n) throw new Error(`at most ${n} addresses`);
  return bytes(...Array.from({ length: n }, (_, i) => (list[i] ? key(list[i]) : ZERO)));
};

const r = (address: Address): AccountMeta => ({ address, role: AccountRole.READONLY });
const wr = (address: Address): AccountMeta => ({ address, role: AccountRole.WRITABLE });
const sr = (address: Address): AccountMeta => ({ address, role: AccountRole.READONLY_SIGNER });
const ws = (address: Address): AccountMeta => ({ address, role: AccountRole.WRITABLE_SIGNER });

// ---------------------------------------------------------------- addresses

const pda = async (program: Address, ...seeds: Uint8Array[]) => (await getProgramDerivedAddress({ programAddress: program, seeds }))[0];
const text = (s: string) => new TextEncoder().encode(s);
/** The owner's policy: `["policy", owner]`. */
export const policyOf = (program: Address, owner: Address) => pda(program, text('policy'), key(owner));
/** The owner's grant to one agent: `["grant", owner, agent]`. */
export const grantOf = (program: Address, owner: Address, agent: Address) => pda(program, text('grant'), key(owner), key(agent));
/** The authority the owner approves over each input account: `["auth", owner]`. */
export const authorityOf = (program: Address, owner: Address) => pda(program, text('auth'), key(owner));
/** The associated token account of `owner` for `mint`. */
export const ataOf = (owner: Address, mint: Address, tokenProgram: Address = TOKEN_PROGRAM) =>
  pda(ATA_PROGRAM, key(owner), key(tokenProgram), key(mint));

// ---------------------------------------------------------------- the owner's instructions

export type Limit = { mint: Address; perSwap: bigint; perDay: bigint };
export type Feed = { mint: Address; feed: Address };
/** What the owner allows one agent. Every amount is in the mint's base units. */
export type GrantRules = {
  status?: number;
  /** Unix time after which the grant stops; 0 for none. */
  expiresAt?: bigint;
  /** Input mints the agent may sell, each with a limit per swap and per day (fee included). */
  limits: Limit[];
  /** Output mints the agent may buy. */
  outputs: Address[];
  /** The least the output may be worth below the input by Pyth's prices, in bps (0 = no check, at most 5000). */
  maxSlippageBps?: number;
  /** With a slippage set and no loss budget: whether a pair without a feed may still swap. */
  allowUnpriced?: boolean;
  /** Each priced mint's Pyth feed id (the feed's 32 bytes, as an address). */
  feeds?: Feed[];
  /** The most the agent may lose by Pyth's prices, in micro-USD, per day and in all (0 = no cap). */
  maxLossPerDay?: bigint;
  maxLossTotal?: bigint;
};

export type PolicyArgs = { program: Address; owner: Address; policy: Address; verifiers: Address[]; programs: Address[]; threshold?: number };

/** Creates the owner's policy: who co-signs (1 or 2 of them) and which swap programs are allowed. */
export const initPolicy = (a: PolicyArgs): Instruction => ({
  programAddress: a.program,
  accounts: [ws(a.owner), wr(a.policy), r(SYSTEM_PROGRAM)],
  data: bytes([0], keys(a.verifiers, MAX_VERIFIERS), keys(a.programs, MAX_PROGRAMS), [a.threshold ?? 1]),
});

/** Changes the policy, or pauses every agent of the owner at once. */
export const updatePolicy = (a: PolicyArgs & { paused: boolean }): Instruction => ({
  programAddress: a.program,
  accounts: [sr(a.owner), wr(a.policy)],
  data: bytes([1, a.paused ? 1 : 0], keys(a.verifiers, MAX_VERIFIERS), keys(a.programs, MAX_PROGRAMS), [a.threshold ?? 1]),
});

/** Creates or replaces the grant of one agent. Today's use and the losses so far are kept. */
export const setGrant = (a: { program: Address; owner: Address; policy: Address; grant: Address; agent: Address; rules: GrantRules }): Instruction => {
  const { rules } = a;
  if ((rules.feeds?.length ?? 0) > MAX_FEEDS || rules.limits.length > MAX_LIMITS) throw new Error('too many limits or feeds');
  return {
    programAddress: a.program,
    accounts: [ws(a.owner), r(a.policy), wr(a.grant), r(SYSTEM_PROGRAM)],
    data: bytes(
      [2], key(a.agent), [rules.status ?? STATUS.active], i64(rules.expiresAt ?? 0n),
      ...Array.from({ length: MAX_LIMITS }, (_, i) => {
        const l = rules.limits[i];
        return l ? bytes(key(l.mint), u64(l.perSwap), u64(l.perDay)) : new Uint8Array(48);
      }),
      keys(rules.outputs, MAX_OUTPUTS),
      u16(rules.maxSlippageBps ?? 0), [rules.allowUnpriced ? 1 : 0],
      ...Array.from({ length: MAX_FEEDS }, (_, i) => {
        const f = rules.feeds?.[i];
        return f ? bytes(key(f.mint), key(f.feed)) : new Uint8Array(64);
      }),
      u64(rules.maxLossPerDay ?? 0n), u64(rules.maxLossTotal ?? 0n),
    ),
  };
};

// ---------------------------------------------------------------- the agent's instructions

/** Every account Pull and Settle name. */
export type SwapAccounts = {
  program: Address;
  agent: Address;
  verifier: Address;
  /** Whether the verifier signs (always, except in tests of a missing signature). */
  verifierSigns?: boolean;
  policy: Address;
  grant: Address;
  authority: Address;
  ownerIn: Address;
  mintIn: Address;
  hopper: Address;
  treasuryIn: Address;
  ownerOut: Address;
  mintOut: Address;
  tokenIn: Address;
  tokenOut: Address;
  /** A second, different verifier of the policy, for a policy with threshold 2. */
  second?: Address;
  /** Pyth price updates of the input and the output mint, when the grant prices this pair. */
  prices?: Address[];
  /** Settle also takes the grant, whose loss budget it charges (when the grant sets one). */
  lossBudget?: boolean;
};

/** The usual accounts of a swap from the owner's associated accounts, through the agent's hopper. */
export async function accountsFor(a: {
  program: Address; owner: Address; agent: Address; verifier: Address; mintIn: Address; mintOut: Address;
  tokenIn?: Address; tokenOut?: Address; second?: Address; prices?: Address[]; lossBudget?: boolean;
}): Promise<SwapAccounts> {
  const tokenIn = a.tokenIn ?? TOKEN_PROGRAM;
  const tokenOut = a.tokenOut ?? TOKEN_PROGRAM;
  return {
    program: a.program, agent: a.agent, verifier: a.verifier, second: a.second, prices: a.prices, lossBudget: a.lossBudget,
    policy: await policyOf(a.program, a.owner),
    grant: await grantOf(a.program, a.owner, a.agent),
    authority: await authorityOf(a.program, a.owner),
    ownerIn: await ataOf(a.owner, a.mintIn, tokenIn),
    hopper: await ataOf(a.agent, a.mintIn, tokenIn),
    treasuryIn: await ataOf(TREASURY, a.mintIn, tokenIn),
    ownerOut: await ataOf(a.owner, a.mintOut, tokenOut),
    mintIn: a.mintIn, mintOut: a.mintOut, tokenIn, tokenOut,
  };
}

/** Moves exactly `amount` to the agent's hopper and the fee to the treasury; records `minOut`. */
export const pull = (a: SwapAccounts, amount: bigint, minOut: bigint): Instruction => ({
  programAddress: a.program,
  accounts: [
    ws(a.agent), a.verifierSigns === false ? r(a.verifier) : sr(a.verifier), wr(a.policy), wr(a.grant), r(a.authority),
    wr(a.ownerIn), r(a.mintIn), wr(a.hopper), wr(a.treasuryIn), r(a.ownerOut), r(a.mintOut),
    r(a.tokenIn), r(a.tokenOut), r(SYSVAR_INSTRUCTIONS), ...(a.second ? [sr(a.second)] : []),
  ],
  data: bytes([3], u64(amount), u64(minOut)),
});

/** The last instruction: checks what arrived, returns what the route left, charges the loss budget. */
export const settle = (a: SwapAccounts): Instruction => ({
  programAddress: a.program,
  accounts: [
    sr(a.agent), wr(a.policy), wr(a.hopper), wr(a.ownerIn), r(a.mintIn), r(a.tokenIn), r(a.ownerOut),
    ...(a.prices ?? []).map(r), ...(a.lossBudget ? [wr(a.grant)] : []),
  ],
  data: Uint8Array.of(4),
});
