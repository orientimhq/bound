/**
 * The world the Guard tests run in: the chain of chain.ts (the owner W, three tokens, the
 * malicious swap program and its pools) plus the Guard program, an agent, Orientim's verifier key, the
 * owner's policy and grant, and the owner's approval of the Guard's authority over the input.
 *
 * The malicious program stands in for the swap program the owner allows. It receives exactly what an
 * agent-built Jupiter instruction would: the agent as the signing user, the agent's hopper as the
 * source and the owner's output account as the destination.
 */
import { AccountRole, generateKeyPairSigner, getAddressEncoder, getProgramDerivedAddress, lamports } from '@solana/kit';
import type { Address, Instruction, KeyPairSigner } from '@solana/kit';
import { getCreateAssociatedTokenIdempotentInstruction } from '@solana-program/token';
import { existsSync } from 'node:fs';
import { initPolicy, pull, setGrant, settle, updatePolicy } from '@orientimhq/guard';
import type { GrantRules, SwapAccounts } from '@orientimhq/guard';
import { approve, ataOf, attackerData, deliver, SOL, SYSTEM_PROGRAM, sendOrThrow, setup, sign, takeFrom, tokensOf, u64 } from './chain.ts';
import type { Inner, IssuerDelegate, World } from './chain.ts';

/** The built program; GUARD_SO picks another build (the workflow's deliberately broken copies). */
export const GUARD_SO = process.env.GUARD_SO ?? 'programs/guard/target/deploy/orientim_guard.so';
export { COMPUTE_BUDGET, ERR, FEE_BPS, feeOf, STATUS, SYSVAR_INSTRUCTIONS, TREASURY } from '@orientimhq/guard';
import { feeOf, TREASURY } from '@orientimhq/guard';
export const DAY = 86_400n;
export const START = 1_800_000_000n; // a fixed clock, so that "today" is the same on every run

export function requireGuard() {
  if (!existsSync(GUARD_SO)) {
    console.error(`Missing ${GUARD_SO}. Build it first:\n  (in programs/guard) cargo build-sbf`);
    process.exit(2);
  }
}

const enc = getAddressEncoder();
const key = (a: Address) => Uint8Array.from(enc.encode(a));
const ZERO = new Uint8Array(32);
const bytes = (...parts: (Uint8Array | number[])[]) => Uint8Array.from(parts.flatMap(p => [...p]));

export type { Feed, GrantRules, Limit } from '@orientimhq/guard';

export type GuardWorld = World & {
  guard: Address;
  agent: KeyPairSigner;
  verifier: KeyPairSigner;
  /** The owner's own co-signing key, for a policy with threshold 2 (not in the policy by default). */
  ownerVerifier: KeyPairSigner;
  /** Pyth price updates every Settle passes (input, output), once a case sets them. */
  prices?: Address[];
  /** Whether every Settle passes the grant (a loss budget is set). */
  lossBudget?: boolean;
  policy: Address;
  grant: Address;
  authority: Address;
  hopper: Address;
  /** The agent's own account for the output mint: where a dishonest agent would want the output. */
  agentOut: Address;
  treasuryIn: Address;
};

const r = (address: Address): { address: Address; role: AccountRole } => ({ address, role: AccountRole.READONLY });
const wr = (address: Address) => ({ address, role: AccountRole.WRITABLE });
const sr = (address: Address) => ({ address, role: AccountRole.READONLY_SIGNER });

/** The SDK's builders (sdk/src/instructions.ts), with the accounts of this world filled in. */
export const ix = {
  initPolicy: (g: GuardWorld, owner: Address, verifiers: Address[], programs: Address[], threshold = 1): Instruction =>
    initPolicy({ program: g.guard, owner, policy: g.policy, verifiers, programs, threshold }),
  updatePolicy: (g: GuardWorld, owner: Address, paused: boolean, verifiers: Address[], programs: Address[], threshold = 1): Instruction =>
    updatePolicy({ program: g.guard, owner, policy: g.policy, verifiers, programs, threshold, paused }),
  setGrant: (g: GuardWorld, owner: Address, grant: Address, agent: Address, rules: GrantRules): Instruction =>
    setGrant({ program: g.guard, owner, policy: g.policy, grant, agent, rules }),
  pull: (g: GuardWorld, amount: bigint, minOut: bigint, o: Partial<PullAccounts> = {}): Instruction =>
    pull({ ...pullAccounts(g), ...o }, amount, minOut),
  settle: (g: GuardWorld, o: Partial<PullAccounts> = {}): Instruction => settle({ ...pullAccounts(g), ...o }),
};

export type PullAccounts = SwapAccounts;

export const pullAccounts = (g: GuardWorld): PullAccounts => ({
  program: g.guard, agent: g.agent.address, verifier: g.verifier.address, verifierSigns: true, policy: g.policy, grant: g.grant,
  authority: g.authority, ownerIn: g.wIn, mintIn: g.mintIn, hopper: g.hopper, treasuryIn: g.treasuryIn,
  ownerOut: g.wOut, mintOut: g.mintOut, tokenIn: g.tokenProgram, tokenOut: g.tokenProgram, prices: g.prices, lossBudget: g.lossBudget,
});

/**
 * The swap: the malicious program with the accounts an agent-built route gets. Indexes match chain.ts's
 * `IX`: token 0, system 1, the agent (signing user) 2, the hopper 3, the owner's output 4, the
 * attacker's own input account 5, its pool 6 and the pool's authority 7.
 */
export function route(g: GuardWorld, inners: Inner[], extra: (Address | { address: Address; role: AccountRole })[] = []): Instruction {
  return {
    programAddress: g.attackerProgram,
    accounts: [
      r(g.tokenProgram), r(SYSTEM_PROGRAM), sr(g.agent.address), wr(g.hopper), wr(g.wOut), wr(g.attackerIn),
      wr(g.vaultOut), r(g.vaultAuthority), ...extra.map(e => (typeof e === 'string' ? wr(e) : e)),
    ],
    data: attackerData(inners),
  };
}

/** An honest route: takes `take` from the hopper and delivers `out` to the owner. */
export const honest = (g: GuardWorld, take: bigint, out: bigint) => route(g, [takeFrom(take), deliver(out)]);

/** Pyth's Solana receiver, owner of every `PriceUpdateV2` account. */
export const PYTH_RECEIVER = 'rec5EKMGg6MxZYaMdyBfgwp4d5rB9T1VQH5pJv5LtFJ' as Address;
const PRICE_UPDATE = [34, 241, 35, 99, 157, 126, 244, 205];

export type PriceOptions = { conf?: bigint; expo?: number; publishTime?: bigint; owner?: Address; partial?: boolean; address?: Address };

/** Writes a Pyth `PriceUpdateV2` for `feed` into a fresh account and returns its address. */
export async function setPrice(g: GuardWorld, feed: Address, price: bigint, o: PriceOptions = {}): Promise<Address> {
  const address = o.address ?? (await generateKeyPairSigner()).address;
  const n64 = (v: bigint) => {
    const b = new Uint8Array(8);
    new DataView(b.buffer).setBigInt64(0, v, true);
    return b;
  };
  const i32 = new Uint8Array(4);
  new DataView(i32.buffer).setInt32(0, o.expo ?? -8, true);
  const time = o.publishTime ?? g.svm.getClock().unixTimestamp;
  const data = new Uint8Array(134);
  data.set(bytes(
    PRICE_UPDATE, ZERO, o.partial ? [0, 5] : [1], key(feed), n64(price), u64(o.conf ?? 0n), i32, n64(time), n64(time),
    n64(price), u64(0n), u64(0n),
  ));
  g.svm.setAccount({ address, data, executable: false, lamports: lamports(SOL), programAddress: o.owner ?? PYTH_RECEIVER, space: 134n });
  return address;
}


export type GuardOptions = {
  tokenProgram?: Address;
  issuer?: IssuerDelegate;
  /** The owner's approval of the Guard's authority over the input (default: 1,000 tokens). */
  budget?: bigint;
  /** As chain.ts's `setup`: the mints' decimals, and funds for many swaps of any size. */
  decimals?: [number, number];
  large?: boolean;
  rules?: (g: GuardWorld) => GrantRules;
};

/** The chain, the Guard deployed, the owner's policy, grant and approval in place. */
export async function guardSetup(opts: GuardOptions = {}): Promise<GuardWorld> {
  const w = await setup(opts.tokenProgram, opts.issuer, { decimals: opts.decimals, large: opts.large });
  const guardKey = await generateKeyPairSigner();
  w.svm.addProgramFromFile(guardKey.address, GUARD_SO);
  const clock = w.svm.getClock();
  clock.unixTimestamp = START;
  w.svm.setClock(clock);

  const [agent, verifier, ownerVerifier] = await Promise.all([generateKeyPairSigner(), generateKeyPairSigner(), generateKeyPairSigner()]);
  w.svm.airdrop(agent.address, lamports(10n * SOL));
  const owner = w.W.address;
  const text = (s: string) => new TextEncoder().encode(s);
  const pda = async (...seeds: Uint8Array[]) => (await getProgramDerivedAddress({ programAddress: guardKey.address, seeds }))[0];
  const g: GuardWorld = {
    ...w,
    guard: guardKey.address,
    agent, verifier, ownerVerifier,
    policy: await pda(text('policy'), key(owner)),
    grant: await pda(text('grant'), key(owner), key(agent.address)),
    authority: await pda(text('auth'), key(owner)),
    hopper: await ataOf(agent.address, w.mintIn, w.tokenProgram),
    agentOut: await ataOf(agent.address, w.mintOut, w.tokenProgram),
    treasuryIn: await ataOf(TREASURY, w.mintIn, w.tokenProgram),
  };

  sendOrThrow(w.svm, await sign(w.svm, [
    getCreateAssociatedTokenIdempotentInstruction({ payer: w.payer, ata: g.hopper, owner: agent.address, mint: w.mintIn, tokenProgram: w.tokenProgram }),
    getCreateAssociatedTokenIdempotentInstruction({ payer: w.payer, ata: g.agentOut, owner: agent.address, mint: w.mintOut, tokenProgram: w.tokenProgram }),
    getCreateAssociatedTokenIdempotentInstruction({ payer: w.payer, ata: g.treasuryIn, owner: TREASURY, mint: w.mintIn, tokenProgram: w.tokenProgram }),
  ], w.payer), 'creating the hopper and the treasury account');

  const rules = opts.rules?.(g) ?? {
    limits: [{ mint: w.mintIn, perSwap: 200n * 1_000_000n, perDay: 500n * 1_000_000n }],
    outputs: [w.mintOut],
  };
  sendOrThrow(w.svm, await sign(w.svm, [
    ix.initPolicy(g, owner, [verifier.address], [w.attackerProgram]),
    ix.setGrant(g, owner, g.grant, agent.address, rules),
    { programAddress: w.tokenProgram, accounts: [wr(w.wIn), r(g.authority), sr(owner)], data: approve(opts.budget ?? 1000n * 1_000_000n) },
  ], w.W), 'the owner\'s set-up');
  return g;
}

/** The balances every case checks, before and after. */
export type GuardBalances = { ownerIn: bigint; ownerOut: bigint; ownerOther: bigint; hopper: bigint; treasury: bigint };
export const guardBalances = (g: GuardWorld): GuardBalances => ({
  ownerIn: tokensOf(g.svm, g.wIn),
  ownerOut: tokensOf(g.svm, g.wOut),
  ownerOther: tokensOf(g.svm, g.wOther),
  hopper: tokensOf(g.svm, g.hopper),
  treasury: tokensOf(g.svm, g.treasuryIn),
});

/**
 * The promise, checked from the balances alone (the oracle does not ask the program): a refused
 * transaction moves nothing; a passed one takes from the owner at most the amount and the fee, pays
 * exactly the fee to the treasury, delivers at least the minimum, leaves the hopper where it was and
 * never touches the owner's other tokens.
 */
export function guardInvariants(before: GuardBalances, after: GuardBalances, ok: boolean, amount: bigint, minOut: bigint): string[] {
  const broken: string[] = [];
  if (after.ownerOther !== before.ownerOther) broken.push('another token of the owner moved');
  if (!ok) {
    for (const k of Object.keys(before) as (keyof GuardBalances)[]) {
      if (after[k] !== before[k]) broken.push(`refused, but ${k} changed`);
    }
    return broken;
  }
  const fee = feeOf(amount);
  const spent = before.ownerIn - after.ownerIn;
  if (spent > amount + fee) broken.push(`the owner paid ${spent}, above amount + fee ${amount + fee}`);
  if (after.treasury - before.treasury !== fee) broken.push(`the treasury received ${after.treasury - before.treasury}, not ${fee}`);
  if (after.ownerOut - before.ownerOut < minOut) broken.push(`${after.ownerOut - before.ownerOut} arrived, below ${minOut}`);
  if (after.hopper !== before.hopper) broken.push('the hopper did not end where it started');
  return broken;
}
