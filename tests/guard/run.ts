/**
 * Orientim Guard: the fixed cases (GRD-01 … GRD-11 of /docs/GUARD.md).
 *
 * Each case builds a fresh world (tests/guard/world.ts), sends one transaction to a real Solana VM
 * (litesvm) and checks two things: the outcome the case expects, with the program's reason when it
 * refuses; and the promise, from the balances alone, that a refused transaction moves nothing and a
 * passed one takes from the owner at most the amount and the fee.
 *
 *   (in programs/guard) cargo build-sbf
 *   (in tests/cpi/attacker) cargo build-sbf
 *   node tests/guard/run.ts
 *
 * CI: .github/workflows/guard.yml.
 */
import { AccountRole, generateKeyPairSigner } from '@solana/kit';
import type { Instruction, KeyPairSigner } from '@solana/kit';
import { mkdirSync, writeFileSync } from 'node:fs';
import { TOKEN_2022_PROGRAM } from '@orientimhq/swap/core';
import { deliver, IX, MIN_OUT, requireProgram, send, sign, takeFrom, transfer, transferChecked, u64 } from '../cpi/world.ts';
import {
  DAY, ERR, feeOf, guardBalances, guardInvariants, guardSetup, honest, ix, requireGuard, route, setPrice, START, STATUS,
} from './world.ts';
import type { GuardOptions, GuardWorld, PriceOptions } from './world.ts';

const OUT_DIR = 'tests/guard/results';
const log = (...a: unknown[]) => console.log(...a);
requireProgram();
requireGuard();

const AMOUNT = 100_000_000n; // 100 of the input (6 decimals)
const MIN = MIN_OUT;          // 10 of the output (9 decimals)

type Plan = {
  /** The instructions, in order. */
  ixs: Instruction[];
  /** Who signs besides the agent (the fee payer). The verifier unless a case says otherwise. */
  signers?: KeyPairSigner[];
  /** The amount and minimum the invariant holds the transaction to. */
  amount?: bigint;
  minOut?: bigint;
};

type Case = {
  id: string;
  name: string;
  opts?: GuardOptions;
  /** Anything the case changes before its transaction (a second swap, a pause, a revoke, the clock). */
  before?: (g: GuardWorld) => Promise<void>;
  plan: (g: GuardWorld) => Promise<Plan> | Plan;
  expect: 'succeeds' | 'fails';
  /** The program's error code, or a log line, the refusal must show. */
  because?: number | string;
  /** For a success: what the owner's input must lose exactly (default: amount + fee). */
  ownerPays?: bigint;
};

const swap = (g: GuardWorld, routeIx: Instruction, amount = AMOUNT, minOut = MIN): Plan => ({
  ixs: [ix.pull(g, amount, minOut), routeIx, ix.settle(g)],
  amount, minOut,
});

/** The owner names their own verifier beside Orientim's and requires both. */
const twoOfTwo = async (g: GuardWorld) => {
  const r = send(g.svm, await sign(g.svm, [ix.updatePolicy(g, g.W.address, false, [g.verifier.address, g.ownerVerifier.address], [g.attackerProgram], 2)], g.W));
  if (!r.ok) throw new Error(r.error);
};

/**
 * Pyth: the input is worth $1 and the output $10 (so 100 IN are worth 10 OUT, the minimum), the owner
 * allows 1% below that. `input`/`output` change one price update; `noOutputFeed` leaves the output
 * mint without a feed, refused unless `allowUnpriced`.
 */
type Priced = { input?: PriceOptions; output?: PriceOptions; noOutputFeed?: boolean; allowUnpriced?: boolean; swapFeeds?: boolean };
const priced = (o: Priced = {}) => async (g: GuardWorld) => {
  const [feedIn, feedOut] = await Promise.all([generateKeyPairSigner(), generateKeyPairSigner()]).then(k => k.map(x => x.address));
  const feeds = [{ mint: g.mintIn, feed: feedIn }, ...(o.noOutputFeed ? [] : [{ mint: g.mintOut, feed: feedOut }])];
  const r = send(g.svm, await sign(g.svm, [ix.setGrant(g, g.W.address, g.grant, g.agent.address, {
    limits: [{ mint: g.mintIn, perSwap: 200n * 1_000_000n, perDay: 500n * 1_000_000n }], outputs: [g.mintOut],
    maxSlippageBps: 100, allowUnpriced: o.allowUnpriced, feeds,
  })], g.W));
  if (!r.ok) throw new Error(r.error);
  const prices = [await setPrice(g, feedIn, 1_00000000n, o.input), await setPrice(g, feedOut, 10_00000000n, o.output)];
  g.prices = o.swapFeeds ? [prices[1], prices[0]] : prices;
};
const OUT_9 = 9_000_000_000n; // 9 OUT: above a minimum of 1, below the oracle's floor of 9.9

/** Sends one complete honest swap of `amount` first, so that the case's own transaction is the second. */
const oneSwapFirst = (amount: bigint) => async (g: GuardWorld) => {
  const r = send(g.svm, await sign(g.svm, swap(g, honest(g, amount, MIN), amount).ixs, g.agent, [g.verifier]));
  if (!r.ok) throw new Error(`the first swap failed: ${r.error}\n${r.logs.join('\n')}`);
  g.svm.expireBlockhash();
};

const CASES: Case[] = [
  // ---- GRD-03 / GRD-04 / GRD-06: the honest path and the minimum
  {
    id: 'G-T03', name: 'an honest swap: amount and fee leave, the minimum arrives',
    plan: g => swap(g, honest(g, AMOUNT, MIN)), expect: 'succeeds',
  },
  {
    id: 'G-T06a', name: 'the route uses less than the amount: the rest goes back to the owner',
    plan: g => swap(g, honest(g, AMOUNT - 1_000n, MIN)), expect: 'succeeds', ownerPays: AMOUNT - 1_000n + feeOf(AMOUNT),
  },
  {
    id: 'G-T04a', name: 'one unit below the minimum: everything reverts',
    plan: g => swap(g, honest(g, AMOUNT, MIN - 1n)), expect: 'fails', because: ERR.BelowMinimum,
  },
  {
    id: 'G-T04b', name: 'the route keeps the input and delivers nothing',
    plan: g => swap(g, route(g, [takeFrom(AMOUNT)])), expect: 'fails', because: ERR.BelowMinimum,
  },
  {
    id: 'G-T06b', name: 'the route takes more from the hopper than was pulled (the agent\'s own tokens)',
    before: async g => {
      // The agent holds some of the input itself; the route takes those too.
      const r = send(g.svm, await sign(g.svm, [{
        programAddress: g.tokenProgram,
        accounts: [
          { address: g.wIn, role: 1 }, { address: g.mintIn, role: 0 }, { address: g.hopper, role: 1 }, { address: g.W.address, role: 2 },
        ],
        data: transferChecked(5_000_000n, g.inDecimals),
      }], g.W));
      if (!r.ok) throw new Error(r.error);
    },
    plan: g => swap(g, honest(g, AMOUNT + 5_000_000n, MIN)), expect: 'fails', because: ERR.HopperShort,
  },

  // ---- GRD-01: the verifier
  {
    id: 'G-T01a', name: 'no verifier signature',
    plan: g => ({ ixs: [ix.pull(g, AMOUNT, MIN, { verifierSigns: false }), honest(g, AMOUNT, MIN), ix.settle(g)], signers: [] }),
    expect: 'fails', because: 'missing required signature',
  },
  {
    id: 'G-T01b', name: 'a verifier the owner never named signs',
    plan: async g => {
      const stranger = await generateKeyPairSigner();
      return { ixs: [ix.pull(g, AMOUNT, MIN, { verifier: stranger.address }), honest(g, AMOUNT, MIN), ix.settle(g)], signers: [stranger] };
    },
    expect: 'fails', because: ERR.UnknownVerifier,
  },

  // ---- GRD-02 / GRD-07: the agent and the route without the Guard's permission
  {
    id: 'G-T02', name: 'the agent transfers from the owner\'s account directly',
    plan: g => ({
      ixs: [{
        programAddress: g.tokenProgram,
        accounts: [{ address: g.wIn, role: 1 }, { address: g.hopper, role: 1 }, { address: g.agent.address, role: 2 }],
        data: transfer(AMOUNT),
      }],
      signers: [],
    }),
    expect: 'fails',
  },
  {
    id: 'G-T07a', name: 'the route signs as the Guard\'s authority to drain the owner\'s input',
    plan: g => swap(g, route(g, [
      { program: IX.token, metas: [{ key: g.wIn, w: true }, { key: IX.attackerIn, w: true }, { key: g.authority, s: true }], data: transfer(AMOUNT) },
      takeFrom(AMOUNT), deliver(MIN),
    ], [g.wIn, g.authority])),
    expect: 'fails',
  },
  {
    id: 'G-T07b', name: 'the route burns the owner\'s input as the Guard\'s authority',
    plan: g => swap(g, route(g, [
      { program: IX.token, metas: [{ key: g.wIn, w: true }, { key: g.mintIn, w: true }, { key: g.authority, s: true }], data: Uint8Array.from([8, ...u64(AMOUNT)]) },
      takeFrom(AMOUNT), deliver(MIN),
    ], [g.wIn, g.mintIn, g.authority])),
    expect: 'fails',
  },
  {
    id: 'G-T07c', name: 'the route takes another token of the owner with the agent\'s signature',
    plan: g => swap(g, route(g, [
      { program: IX.token, metas: [{ key: g.wOther, w: true }, { key: IX.attackerIn, w: true }, { key: IX.E, s: true }], data: transfer(1n) },
      takeFrom(AMOUNT), deliver(MIN),
    ], [g.wOther])),
    expect: 'fails',
  },

  // ---- GRD-05: the shape of the transaction
  {
    id: 'G-T05a', name: 'pull without settle',
    plan: g => ({ ixs: [ix.pull(g, AMOUNT, MIN), honest(g, AMOUNT, MIN)] }), expect: 'fails', because: ERR.BadShape,
  },
  {
    id: 'G-T05b', name: 'an instruction after settle (the hopper emptied afterwards)',
    plan: g => ({
      ixs: [ix.pull(g, AMOUNT, MIN), honest(g, AMOUNT - 1_000n, MIN), ix.settle(g), route(g, [takeFrom(1n)])],
    }),
    expect: 'fails', because: ERR.BadShape,
  },
  {
    id: 'G-T05c', name: 'two pulls in one transaction',
    plan: g => ({ ixs: [ix.pull(g, AMOUNT, MIN), ix.pull(g, AMOUNT, MIN), honest(g, AMOUNT, MIN), ix.settle(g)] }),
    expect: 'fails', because: ERR.ProgramNotAllowed,
  },
  {
    id: 'G-T05d', name: 'a token transfer between pull and settle (not an allowed program)',
    plan: g => ({
      ixs: [
        ix.pull(g, AMOUNT, MIN),
        { programAddress: g.tokenProgram, accounts: [{ address: g.hopper, role: 1 }, { address: g.attackerIn, role: 1 }, { address: g.agent.address, role: 2 }], data: transfer(1_000n) },
        honest(g, AMOUNT - 1_000n, MIN), ix.settle(g),
      ],
    }),
    expect: 'fails', because: ERR.ProgramNotAllowed,
  },
  {
    id: 'G-T05e', name: 'pull called by another program, not top-level',
    plan: g => {
      const p = ix.pull(g, AMOUNT, MIN);
      const inner = {
        program: g.guard,
        metas: p.accounts!.map(a => ({ key: a.address, w: (a.role & 1) === 1, s: (a.role & 2) === 2 })),
        data: Uint8Array.from(p.data!),
      };
      // The route gets every account pull needs, with the same roles, and the Guard program itself.
      return { ixs: [route(g, [inner], [{ address: g.guard, role: AccountRole.READONLY }, ...p.accounts!]), ix.settle(g)], amount: AMOUNT, minOut: MIN };
    },
    expect: 'fails', because: 'top-level',
  },
  {
    id: 'G-T05f', name: 'settle alone, with no pull before it',
    plan: g => ({ ixs: [ix.settle(g)], signers: [] }), expect: 'fails', because: ERR.NoSwapInProgress,
  },

  // ---- GRD-03 / GRD-08: limits
  {
    id: 'G-T03b', name: 'above the owner\'s limit per swap',
    plan: g => swap(g, honest(g, 201_000_000n, MIN), 201_000_000n), expect: 'fails', because: ERR.OverSwapLimit,
  },
  {
    id: 'G-T08a', name: 'daily limit: the second swap of the day crosses it',
    opts: { rules: g => ({ limits: [{ mint: g.mintIn, perSwap: AMOUNT, perDay: 120_000_000n }], outputs: [g.mintOut] }) },
    before: oneSwapFirst(60_000_000n),
    plan: g => swap(g, honest(g, 60_000_000n, MIN), 60_000_000n), expect: 'fails', because: ERR.OverDailyLimit,
  },
  {
    id: 'G-T08b', name: 'daily limit: the next day starts again',
    opts: { rules: g => ({ limits: [{ mint: g.mintIn, perSwap: AMOUNT, perDay: 120_000_000n }], outputs: [g.mintOut] }) },
    before: async g => {
      await oneSwapFirst(60_000_000n)(g);
      const clock = g.svm.getClock();
      clock.unixTimestamp = START + DAY;
      g.svm.setClock(clock);
    },
    plan: g => swap(g, honest(g, 60_000_000n, MIN), 60_000_000n), expect: 'succeeds',
  },
  {
    id: 'G-T03c', name: 'an input mint the owner did not allow',
    opts: { rules: g => ({ limits: [{ mint: g.mintOther, perSwap: AMOUNT, perDay: AMOUNT * 2n }], outputs: [g.mintOut] }) },
    plan: g => swap(g, honest(g, AMOUNT, MIN)), expect: 'fails', because: ERR.MintNotAllowed,
  },
  {
    id: 'G-T03d', name: 'an output mint the owner did not allow',
    opts: { rules: g => ({ limits: [{ mint: g.mintIn, perSwap: AMOUNT, perDay: AMOUNT * 2n }], outputs: [g.mintOther] }) },
    plan: g => swap(g, honest(g, AMOUNT, MIN)), expect: 'fails', because: ERR.MintNotAllowed,
  },
  {
    id: 'G-T03e', name: 'the output goes to an account that is not the owner\'s',
    plan: g => ({
      ixs: [ix.pull(g, AMOUNT, MIN, { ownerOut: g.vaultOut }), honest(g, AMOUNT, MIN), ix.settle(g, { ownerOut: g.vaultOut })],
    }),
    expect: 'fails', because: ERR.BadTokenAccount,
  },
  {
    id: 'G-T03f', name: 'the fee to an account that is not the treasury\'s',
    plan: g => ({ ixs: [ix.pull(g, AMOUNT, MIN, { treasuryIn: g.attackerIn }), honest(g, AMOUNT, MIN), ix.settle(g)] }),
    expect: 'fails', because: ERR.BadTreasury,
  },
  {
    id: 'G-T03g', name: 'a hopper that is not the agent\'s',
    plan: g => ({
      ixs: [ix.pull(g, AMOUNT, MIN, { hopper: g.attackerIn }), honest(g, AMOUNT, MIN), ix.settle(g, { hopper: g.attackerIn })],
    }),
    expect: 'fails', because: ERR.BadTokenAccount,
  },

  // ---- GRD-09: stopping the agent
  {
    id: 'G-T09a', name: 'the owner paused the policy',
    before: async g => {
      const r = send(g.svm, await sign(g.svm, [ix.updatePolicy(g, g.W.address, true, [g.verifier.address], [g.attackerProgram])], g.W));
      if (!r.ok) throw new Error(r.error);
    },
    plan: g => swap(g, honest(g, AMOUNT, MIN)), expect: 'fails', because: ERR.Paused,
  },
  {
    id: 'G-T09b', name: 'the owner revoked the agent\'s grant',
    opts: { rules: g => ({ status: STATUS.revoked, limits: [{ mint: g.mintIn, perSwap: AMOUNT, perDay: AMOUNT * 2n }], outputs: [g.mintOut] }) },
    plan: g => swap(g, honest(g, AMOUNT, MIN)), expect: 'fails', because: ERR.AgentNotActive,
  },
  {
    id: 'G-T09c', name: 'the agent\'s grant expired',
    opts: { rules: g => ({ expiresAt: START - 1n, limits: [{ mint: g.mintIn, perSwap: AMOUNT, perDay: AMOUNT * 2n }], outputs: [g.mintOut] }) },
    plan: g => swap(g, honest(g, AMOUNT, MIN)), expect: 'fails', because: ERR.AgentNotActive,
  },
  {
    id: 'G-T09d', name: 'the owner revoked the approval in their wallet (SPL Revoke)',
    before: async g => {
      const r = send(g.svm, await sign(g.svm, [{
        programAddress: g.tokenProgram, accounts: [{ address: g.wIn, role: 1 }, { address: g.W.address, role: 2 }], data: Uint8Array.from([5]),
      }], g.W));
      if (!r.ok) throw new Error(r.error);
    },
    plan: g => swap(g, honest(g, AMOUNT, MIN)), expect: 'fails', because: ERR.NotDelegated,
  },
  {
    id: 'G-T09e', name: 'the budget is spent: the approval ran out after the first swap',
    opts: { budget: AMOUNT + feeOf(AMOUNT) },
    before: oneSwapFirst(AMOUNT),
    plan: g => swap(g, honest(g, AMOUNT, MIN)), expect: 'fails', because: ERR.NotDelegated,
  },

  // ---- GRD-11: only the owner changes the rules
  {
    id: 'G-T11a', name: 'the agent tries to change the policy',
    plan: g => ({ ixs: [ix.updatePolicy(g, g.agent.address, false, [g.agent.address], [g.attackerProgram])], signers: [] }),
    expect: 'fails', because: ERR.NotOwner,
  },
  {
    id: 'G-T11b', name: 'the agent tries to raise its own limits',
    plan: g => ({
      ixs: [ix.setGrant(g, g.agent.address, g.grant, g.agent.address, { limits: [{ mint: g.mintIn, perSwap: 10n ** 15n, perDay: 10n ** 15n }], outputs: [g.mintOut] })],
      signers: [],
    }),
    expect: 'fails', because: ERR.NotOwner,
  },

  // ---- 2 of 2: the owner's own verifier beside Orientim's
  {
    id: 'G-T12a', name: 'threshold 2: Orientim and the owner\'s own verifier both sign',
    before: twoOfTwo,
    plan: g => ({
      ixs: [ix.pull(g, AMOUNT, MIN, { second: g.ownerVerifier.address }), honest(g, AMOUNT, MIN), ix.settle(g)],
      signers: [g.verifier, g.ownerVerifier],
    }),
    expect: 'succeeds',
  },
  {
    id: 'G-T12b', name: 'threshold 2: only Orientim signs',
    before: twoOfTwo,
    plan: g => swap(g, honest(g, AMOUNT, MIN)), expect: 'fails', because: ERR.SecondVerifierMissing,
  },
  {
    id: 'G-T12c', name: 'threshold 2: Orientim\'s verifier passed twice',
    before: twoOfTwo,
    plan: g => ({ ixs: [ix.pull(g, AMOUNT, MIN, { second: g.verifier.address }), honest(g, AMOUNT, MIN), ix.settle(g)] }),
    expect: 'fails', because: ERR.SecondVerifierMissing,
  },
  {
    id: 'G-T12d', name: 'threshold 2: the second key signs but is not in the policy',
    before: twoOfTwo,
    plan: g => ({
      ixs: [ix.pull(g, AMOUNT, MIN, { second: g.agent.address }), honest(g, AMOUNT, MIN), ix.settle(g)],
    }),
    expect: 'fails', because: ERR.SecondVerifierMissing,
  },
  {
    id: 'G-T12e', name: 'the owner sets threshold 2 with only one verifier named',
    plan: g => ({ ixs: [ix.updatePolicy(g, g.W.address, false, [g.verifier.address], [g.attackerProgram], 2)], signers: [g.W] }),
    expect: 'fails', because: ERR.BadPolicy,
  },

  // ---- I10: Pyth prices
  {
    id: 'G-T13a', name: 'Pyth: the output is worth the input, within the owner\'s 1%',
    before: priced(), plan: g => swap(g, honest(g, AMOUNT, MIN)), expect: 'succeeds',
  },
  {
    id: 'G-T13b', name: 'Pyth: the agent and the verifier set a minimum of 1, the route pays 10% less than the price',
    before: priced(), plan: g => swap(g, honest(g, AMOUNT, OUT_9), AMOUNT, 1n), expect: 'fails', because: ERR.BelowOracle,
  },
  {
    id: 'G-T13c', name: 'Pyth: a price older than a minute',
    before: priced({ output: { publishTime: START - 61n } }), plan: g => swap(g, honest(g, AMOUNT, MIN)), expect: 'fails', because: ERR.StalePrice,
  },
  {
    id: 'G-T13d', name: 'Pyth: a price account Pyth\'s receiver does not own',
    before: priced({ input: { owner: TOKEN_2022_PROGRAM } }), plan: g => swap(g, honest(g, AMOUNT, MIN)), expect: 'fails', because: ERR.BadOracle,
  },
  {
    id: 'G-T13e', name: 'Pyth: the two price updates swapped (another feed)',
    before: priced({ swapFeeds: true }), plan: g => swap(g, honest(g, AMOUNT, MIN)), expect: 'fails', because: ERR.BadOracle,
  },
  {
    id: 'G-T13f', name: 'Pyth: a partially verified price update',
    before: priced({ input: { partial: true } }), plan: g => swap(g, honest(g, AMOUNT, MIN)), expect: 'fails', because: ERR.BadOracle,
  },
  {
    id: 'G-T13g', name: 'Pyth: a price with a confidence interval of 5%',
    before: priced({ output: { conf: 50_000000n } }), plan: g => swap(g, honest(g, AMOUNT, MIN)), expect: 'fails', because: ERR.PriceUncertain,
  },
  {
    id: 'G-T13h', name: 'Pyth: no price updates passed to settle',
    before: async g => {
      await priced()(g);
      g.prices = undefined;
    },
    plan: g => swap(g, honest(g, AMOUNT, MIN)), expect: 'fails', because: 'insufficient account keys',
  },
  {
    id: 'G-T13i', name: 'Pyth: the output mint has no feed and the owner refuses unpriced pairs',
    before: priced({ noOutputFeed: true }), plan: g => swap(g, honest(g, AMOUNT, MIN)), expect: 'fails', because: ERR.Unpriced,
  },
  {
    id: 'G-T13j', name: 'Pyth: the output mint has no feed and the owner allows unpriced pairs',
    before: async g => {
      await priced({ noOutputFeed: true, allowUnpriced: true })(g);
      g.prices = undefined;
    },
    plan: g => swap(g, honest(g, AMOUNT, OUT_9), AMOUNT, 1n), expect: 'succeeds',
  },

  // ---- GRD-10: Token-2022
  {
    id: 'G-T10a', name: 'Token-2022 without extensions: an honest swap',
    opts: { tokenProgram: TOKEN_2022_PROGRAM },
    plan: g => swap(g, honest(g, AMOUNT, MIN)), expect: 'succeeds',
  },
  {
    id: 'G-T10b', name: 'Token-2022 mints with a permanent delegate',
    opts: { tokenProgram: TOKEN_2022_PROGRAM, issuer: 'key' },
    plan: g => swap(g, honest(g, AMOUNT, MIN)), expect: 'fails', because: ERR.UnsafeMint,
  },
];

// ---------------------------------------------------------------- run

type Row = { id: string; name: string; expected: string; outcome: string; broken: string[]; cu: string; pass: boolean };

const shows = (logs: string[], because: number | string | undefined) => {
  if (because === undefined) return true;
  if (typeof because === 'number') return logs.some(l => l.includes(`custom program error: 0x${because.toString(16)}`));
  return logs.some(l => l.toLowerCase().includes(because.toLowerCase()));
};

const rows: Row[] = [];
for (const c of CASES) {
  const g = await guardSetup(c.opts);
  await c.before?.(g);
  const plan = await c.plan(g);
  const amount = plan.amount ?? AMOUNT;
  const minOut = plan.minOut ?? MIN;
  const before = guardBalances(g);
  const result = send(g.svm, await sign(g.svm, plan.ixs, g.agent, plan.signers ?? [g.verifier]));
  const after = guardBalances(g);
  const broken = guardInvariants(before, after, result.ok, amount, minOut);
  if (result.ok && c.expect === 'succeeds') {
    const paid = before.ownerIn - after.ownerIn;
    const want = c.ownerPays ?? amount + feeOf(amount);
    if (paid !== want) broken.push(`the owner paid ${paid}, expected ${want}`);
  }
  const reasonShown = result.ok || shows(result.logs, c.because);
  const pass = result.ok === (c.expect === 'succeeds') && broken.length === 0 && reasonShown;
  const cu = result.logs.map(l => /consumed (\d+) of/.exec(l)?.[1]).filter(Boolean).join(' / ');
  rows.push({
    id: c.id, name: c.name, cu,
    expected: c.expect === 'succeeds' ? 'kalon' : `refuzohet${c.because === undefined ? '' : ` (${typeof c.because === 'number' ? `gabimi ${c.because}` : c.because})`}`,
    outcome: result.ok ? 'kaloi' : `u refuzua${result.index === null ? '' : ` te instruksioni ${result.index}`}: ${result.error}${reasonShown ? '' : ' — ARSYE TJETËR'}`,
    broken, pass,
  });
  log(`${pass ? 'OK  ' : 'FAIL'} ${c.id} ${c.name}: ${rows.at(-1)!.outcome}${broken.length ? ` — SHKELJE: ${broken.join('; ')}` : ''}`);
  if (!pass && process.env.GUARD_VERBOSE) log(result.logs.join('\n'));
}

mkdirSync(OUT_DIR, { recursive: true });
const failed = rows.filter(r => !r.pass).length;
writeFileSync(`${OUT_DIR}/guard.md`, [
  '# Orientim Guard: rastet fikse',
  '',
  `${rows.length - failed}/${rows.length} raste kaluan. Programi: \`programs/guard\`; rruga: programi sulmues i T6 (\`tests/cpi/attacker\`), në litesvm.`,
  '',
  '| ID | Rasti | Pritej | Ndodhi | Shkelje | CU (Guard) |',
  '| --- | --- | --- | --- | --- | --- |',
  ...rows.map(r => `| ${r.id} | ${r.name} | ${r.expected} | ${r.outcome.replaceAll('|', '/')} | ${r.broken.join('; ') || '—'} | ${r.cu || '—'} |`),
  '',
].join('\n'));
log(`\nGuard ${rows.length - failed}/${rows.length}  →  ${OUT_DIR}/guard.md`);
process.exit(failed ? 1 : 0);
