/**
 * Orientim Guard, the owner's rules fuzzed: random policies and grants, random owner actions between
 * swaps (pause, a new grant, a new approval, a revocation, an expiry) and the clock moving across
 * days, with Pyth prices that move, go stale or grow uncertain. Every swap is honest in shape (Pull,
 * a route that takes at most the amount and delivers something, Settle); what varies is whether the
 * rules allow it.
 *
 * An independent model of the rules (written from docs/GUARD.md, not from the program) says for each
 * swap whether the owner's rules allow it, and keeps its own counters: the approval left, each day's
 * use, the loss budget. The chain must agree with the model on every swap, both ways: a swap the
 * chain accepts and the model refuses is a rule the program failed to enforce; a swap the model allows
 * and the chain refuses is an owner's rule enforced wrongly. The balances must also keep the promise
 * of tests/guard/world.ts `guardInvariants`.
 *
 *   node tests/guard/rules.ts   (GUARD_RULES_RUNS cases, 1,000 by default; GUARD_RULES_SEED; GUARD_RULES_OUT)
 *
 * The Guard workflow builds broken copies of the program (the daily limit, the loss budget, the
 * oracle floor) and requires this fuzzer to catch each.
 */
import { AccountRole, generateKeyPairSigner } from '@solana/kit';
import type { Address, KeyPairSigner } from '@solana/kit';
import { mkdirSync, writeFileSync } from 'node:fs';
import { approve, deliver, requireProgram, send, sign, takeFrom, TOKEN_2022_PROGRAM, TOKEN_PROGRAM } from './chain.ts';
import { DAY, feeOf, guardBalances, guardInvariants, guardSetup, ix, requireGuard, route, setPrice, STATUS } from './world.ts';
import type { GrantRules, GuardWorld } from './world.ts';

requireProgram();
requireGuard();

const RUNS = Number(process.env.GUARD_RULES_RUNS ?? 1_000);
const SEED = Number(process.env.GUARD_RULES_SEED ?? Date.now() % 1_000_000);
const PER_WORLD = 60;
const DAY_S = Number(DAY);
const OUT_DIR = 'tests/guard/results';
const OUT_FILE = process.env.GUARD_RULES_OUT ?? 'guard-rules.md';

// mulberry32, so that any failing case can be replayed from its seed.
let state = SEED >>> 0;
const random = () => {
  state = (state + 0x6d2b79f5) >>> 0;
  let t = state;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
};
const int = (min: number, max: number) => min + Math.floor(random() * (max - min + 1));
const chance = (p: number) => random() < p;
const pick = <T>(xs: readonly T[]): T => xs[Math.floor(random() * xs.length)];
/** A random bigint in [lo, hi]. */
const between = (lo: bigint, hi: bigint) => lo + (BigInt(Math.floor(random() * 2 ** 52)) * (hi - lo + 1n)) / 2n ** 52n;

// ---------------------------------------------------------------- the model, from docs/GUARD.md

const U128 = 2n ** 128n;
const checked = (v: bigint) => {
  if (v >= U128) throw new Error('overflow');
  return v;
};
type Price = { price: bigint; conf: bigint; expo: number; time: bigint };
/** What `amount` base units are worth in micro-USD: amount × price × 10^(expo + 6 − decimals), rounded down. */
const usd = (amount: bigint, decimals: number, p: Price) => {
  const k = p.expo + 6 - decimals;
  const v = checked(amount * p.price);
  return k >= 0 ? checked(v * 10n ** BigInt(k)) : v / 10n ** BigInt(-k);
};
/** The least output the input is worth by the two prices, less the slippage, rounded down. */
const floorOf = (amount: bigint, dIn: number, dOut: number, pIn: Price, pOut: Price, bps: number) => {
  const k = pIn.expo - pOut.expo + dOut - dIn;
  const num = checked(amount * pIn.price);
  const expected = k >= 0 ? checked(num * 10n ** BigInt(k)) / pOut.price : num / checked(pOut.price * 10n ** BigInt(-k));
  return checked(expected * BigInt(10_000 - bps)) / 10_000n;
};
const priceUsable = (p: Price, now: bigint) => now - p.time <= 60n && p.conf * 50n <= p.price;

type Model = {
  paused: boolean; threshold: number; status: number; expiresAt: bigint;
  perSwap: bigint; perDay: bigint; usedDay: bigint; used: bigint;
  slippage: number; priced: boolean; allowUnpriced: boolean;
  lossPerDay: bigint; lossTotal: bigint; lossDay: bigint; lossToday: bigint; lossAll: bigint;
  delegated: bigint;
};

type Swap = {
  amount: bigint; minOut: bigint; take: bigint; out: bigint;
  primary: 'orientim' | 'owner' | 'stranger' | 'none'; second: 'none' | 'other' | 'same' | 'stranger';
  pIn: Price; pOut: Price;
};

/** Whether the owner's rules allow this swap, and the model's counters after it if they do. */
function judge(m: Model, s: Swap, now: bigint, dIn: number, dOut: number): { ok: boolean; why: string; next?: Model } {
  const day = now / DAY;
  const no = (why: string) => ({ ok: false, why });
  if (m.paused) return no('paused');
  if (s.primary === 'stranger' || s.primary === 'none') return no('no verifier of the policy signed');
  if (m.threshold === 2 && s.second !== 'other') return no('threshold 2 without a second, different verifier');
  if (m.status !== STATUS.active || (m.expiresAt !== 0n && now >= m.expiresAt)) return no('grant not active');
  const fee = feeOf(s.amount);
  const total = s.amount + fee;
  if (s.amount > m.perSwap) return no('above the limit per swap');
  const usedToday = m.usedDay === day ? m.used : 0n;
  if (usedToday + total > m.perDay) return no('above the daily limit');
  const tracks = m.lossPerDay > 0n || m.lossTotal > 0n;
  const needsPrice = m.slippage > 0 || tracks;
  if (needsPrice && !m.priced && !(m.allowUnpriced && !tracks)) return no('unpriced');
  const lossToday = m.lossDay === day ? m.lossToday : 0n;
  if (tracks && ((m.lossPerDay > 0n && lossToday >= m.lossPerDay) || (m.lossTotal > 0n && m.lossAll >= m.lossTotal))) return no('loss budget spent');
  if (m.delegated < total) return no('approval spent');
  const arrived = s.out;
  if (arrived < s.minOut) return no('below the minimum');
  const pricesUsed = needsPrice && m.priced;
  if (pricesUsed && !(priceUsable(s.pIn, now) && priceUsable(s.pOut, now))) return no('price stale or uncertain');
  let lossTodayNext = lossToday;
  let lossAllNext = m.lossAll;
  try {
    if (pricesUsed && m.slippage > 0 && arrived < floorOf(s.amount, dIn, dOut, s.pIn, s.pOut, m.slippage)) return no('below the oracle floor');
    if (tracks) {
      const paid = s.take + fee;
      const lost = usd(paid, dIn, s.pIn) - usd(arrived, dOut, s.pOut);
      if (lost > 0n) {
        lossTodayNext += lost;
        lossAllNext += lost;
      }
      if ((m.lossPerDay > 0n && lossTodayNext > m.lossPerDay) || (m.lossTotal > 0n && lossAllNext > m.lossTotal)) return no('crosses the loss budget');
    }
  } catch {
    return no('arithmetic overflow');
  }
  return {
    ok: true, why: 'allowed',
    next: {
      ...m, usedDay: day, used: usedToday + total, delegated: m.delegated - total,
      ...(tracks ? { lossDay: day, lossToday: lossTodayNext, lossAll: lossAllNext } : {}),
    },
  };
}

// ---------------------------------------------------------------- the run

const counts = { allowed: 0, refused: 0, ownerActions: 0, days: 0 };
const reasons = new Map<string, number>();
const failures: string[] = [];
let ran = 0;
const started = Date.now();

type Run = { g: GuardWorld; m: Model; feedIn: Address; feedOut: Address; priceIn: Address; priceOut: Address; stranger: KeyPairSigner; pIn: Price; pOut: Price };
let run: Run | null = null;

const randomPrice = (now: bigint): Price => ({ price: between(1n, 10n ** 12n), conf: 0n, expo: pick([-8, -8, -6, -10]), time: now });

/** A grant's rules, random, and the matching model fields. */
function randomRules(g: GuardWorld, feedIn: Address, feedOut: Address, scale: bigint) {
  const priced = chance(0.85);
  const slippage = chance(0.7) ? int(1, 5_000) : 0;
  const tracks = chance(0.6);
  const rules: GrantRules = {
    status: chance(0.9) ? STATUS.active : pick([STATUS.paused, STATUS.revoked]),
    expiresAt: chance(0.8) ? 0n : g.svm.getClock().unixTimestamp + BigInt(int(-DAY_S, 3 * DAY_S)),
    limits: [{ mint: g.mintIn, perSwap: between(1n, scale), perDay: between(1n, scale * 4n) }],
    outputs: [g.mintOut],
    maxSlippageBps: slippage, allowUnpriced: chance(0.3),
    feeds: priced ? [{ mint: g.mintIn, feed: feedIn }, { mint: g.mintOut, feed: feedOut }] : [{ mint: g.mintIn, feed: feedIn }],
    maxLossPerDay: tracks && chance(0.8) ? between(1n, 10n ** 9n) : 0n,
    maxLossTotal: tracks && chance(0.6) ? between(1n, 10n ** 10n) : 0n,
  };
  return { rules, priced };
}

async function owner(r: Run, ixs: Parameters<typeof sign>[1], what: string) {
  const out = send(r.g.svm, await sign(r.g.svm, ixs, r.g.W));
  if (!out.ok) throw new Error(`the owner's ${what} failed: ${out.error}`);
  r.g.svm.expireBlockhash();
}

async function newGrant(r: Run) {
  const { rules, priced } = randomRules(r.g, r.feedIn, r.feedOut, 10n ** BigInt(int(2, 12)));
  await owner(r, [ix.setGrant(r.g, r.g.W.address, r.g.grant, r.g.agent.address, rules)], 'grant');
  const l = rules.limits[0];
  // Changing the rules never resets the counters: today's use of the same mint and the losses so far stay.
  r.m = {
    ...r.m, status: rules.status ?? STATUS.active, expiresAt: rules.expiresAt ?? 0n, perSwap: l.perSwap, perDay: l.perDay,
    slippage: rules.maxSlippageBps ?? 0, priced, allowUnpriced: rules.allowUnpriced ?? false,
    lossPerDay: rules.maxLossPerDay ?? 0n, lossTotal: rules.maxLossTotal ?? 0n,
  };
}

for (let i = 0; i < RUNS; i++) {
  if (i % PER_WORLD === 0) {
    const g = await guardSetup({
      tokenProgram: pick([TOKEN_PROGRAM, TOKEN_2022_PROGRAM]), budget: 1n, large: true, decimals: [int(0, 12), int(0, 12)],
      rules: x => ({ limits: [{ mint: x.mintIn, perSwap: 1n, perDay: 1n }], outputs: [x.mintOut] }),
    });
    const [feedIn, feedOut, priceIn, priceOut, stranger] = await Promise.all(Array.from({ length: 5 }, () => generateKeyPairSigner()));
    const now = g.svm.getClock().unixTimestamp;
    run = {
      g, feedIn: feedIn.address, feedOut: feedOut.address, priceIn: priceIn.address, priceOut: priceOut.address, stranger,
      pIn: randomPrice(now), pOut: randomPrice(now),
      m: {
        paused: false, threshold: 1, status: STATUS.active, expiresAt: 0n, perSwap: 0n, perDay: 0n, usedDay: 0n, used: 0n,
        slippage: 0, priced: true, allowUnpriced: false, lossPerDay: 0n, lossTotal: 0n, lossDay: 0n, lossToday: 0n, lossAll: 0n, delegated: 0n,
      },
    };
    const threshold = chance(0.35) ? 2 : 1;
    await owner(run, [ix.updatePolicy(g, g.W.address, false, [g.verifier.address, g.ownerVerifier.address], [g.attackerProgram], threshold)], 'policy');
    run.m.threshold = threshold;
    await newGrant(run);
    const budget = 10n ** BigInt(int(3, 14));
    await owner(run, [{ programAddress: g.tokenProgram, accounts: [{ address: g.wIn, role: AccountRole.WRITABLE }, { address: g.authority, role: AccountRole.READONLY }, { address: g.W.address, role: AccountRole.READONLY_SIGNER }], data: approve(budget) }], 'approval');
    run.m.delegated = budget;
  }
  const r = run!;
  const { g } = r;
  ran++;

  // Now and then the owner acts, or time passes.
  if (chance(0.08)) {
    counts.ownerActions++;
    const act = pick(['pause', 'grant', 'approve', 'revoke'] as const);
    if (act === 'pause') {
      const paused = !r.m.paused;
      await owner(r, [ix.updatePolicy(g, g.W.address, paused, [g.verifier.address, g.ownerVerifier.address], [g.attackerProgram], r.m.threshold)], 'pause');
      r.m.paused = paused;
    } else if (act === 'grant') {
      await newGrant(r);
    } else {
      const budget = act === 'revoke' ? 0n : 10n ** BigInt(int(3, 14));
      await owner(r, [{
        programAddress: g.tokenProgram,
        accounts: act === 'revoke'
          ? [{ address: g.wIn, role: AccountRole.WRITABLE }, { address: g.W.address, role: AccountRole.READONLY_SIGNER }]
          : [{ address: g.wIn, role: AccountRole.WRITABLE }, { address: g.authority, role: AccountRole.READONLY }, { address: g.W.address, role: AccountRole.READONLY_SIGNER }],
        data: act === 'revoke' ? Uint8Array.of(5) : approve(budget),
      }], act);
      r.m.delegated = budget;
    }
  }
  if (chance(0.1)) {
    counts.days++;
    const clock = g.svm.getClock();
    clock.unixTimestamp += BigInt(pick([int(1, 3_600), int(1, DAY_S), int(DAY_S, 3 * DAY_S)]));
    g.svm.setClock(clock);
  }
  const now = g.svm.getClock().unixTimestamp;

  // Prices move, and now and then go stale or uncertain.
  const drift = (p: Price): Price => {
    const moved = chance(0.3) ? randomPrice(now) : { ...p, price: p.price + (p.price * BigInt(int(-500, 500))) / 10_000n || 1n };
    return {
      ...moved,
      time: chance(0.05) ? now - BigInt(int(61, 600)) : now - BigInt(int(0, 30)),
      conf: chance(0.05) ? moved.price / 50n + 1n : moved.price / BigInt(int(100, 10_000)),
    };
  };
  r.pIn = drift(r.pIn);
  r.pOut = drift(r.pOut);
  await setPrice(g, r.feedIn, r.pIn.price, { address: r.priceIn, conf: r.pIn.conf, expo: r.pIn.expo, publishTime: r.pIn.time });
  await setPrice(g, r.feedOut, r.pOut.price, { address: r.priceOut, conf: r.pOut.conf, expo: r.pOut.expo, publishTime: r.pOut.time });

  // The swap: an amount near the limits, a route that pays near the oracle's value.
  const amount = chance(0.5) ? between(1n, r.m.perSwap > 1n ? r.m.perSwap : 2n) : between(1n, 10n ** BigInt(int(1, 13)));
  let fair = 1n;
  try {
    fair = floorOf(amount, g.inDecimals, g.outDecimals, r.pIn, r.pOut, 0);
  } catch {
    fair = 10n ** 15n;
  }
  const out = fair === 0n ? BigInt(int(0, 3)) : (fair * BigInt(int(9_000, 10_200))) / 10_000n;
  const swap: Swap = {
    amount, take: chance(0.8) ? amount : between(0n, amount), out: out > 10n ** 15n ? 10n ** 15n : out,
    minOut: chance(0.85) ? between(1n, out > 1n ? out : 1n) : out + BigInt(int(1, 5)),
    primary: chance(0.9) ? 'orientim' : pick(['owner', 'stranger', 'none'] as const),
    second: r.m.threshold === 2 ? (chance(0.85) ? 'other' : pick(['none', 'same', 'stranger'] as const)) : 'none',
    pIn: r.pIn, pOut: r.pOut,
  };

  // The model's verdict, then the chain's.
  const verdict = judge(r.m, swap, now, g.inDecimals, g.outDecimals);
  const primary = swap.primary === 'owner' ? g.ownerVerifier : swap.primary === 'stranger' ? r.stranger : g.verifier;
  const secondKey = swap.second === 'other' ? (primary === g.ownerVerifier ? g.verifier : g.ownerVerifier)
    : swap.second === 'same' ? primary : swap.second === 'stranger' ? r.stranger : null;
  const usesPrices = (r.m.slippage > 0 || r.m.lossPerDay > 0n || r.m.lossTotal > 0n) && r.m.priced;
  g.prices = usesPrices ? [r.priceIn, r.priceOut] : undefined;
  g.lossBudget = r.m.lossPerDay > 0n || r.m.lossTotal > 0n;
  const pull = ix.pull(g, swap.amount, swap.minOut, {
    verifier: primary.address, verifierSigns: swap.primary !== 'none', ...(secondKey ? { second: secondKey.address } : {}),
  });
  const ixs = [pull, route(g, [takeFrom(swap.take), deliver(swap.out)]), ix.settle(g)];
  const signers = [...(swap.primary === 'none' ? [] : [primary]), ...(secondKey && secondKey !== primary ? [secondKey] : [])];
  const describe = () => JSON.stringify({
    seed: SEED, case: i, model: verdict.why, decimals: [g.inDecimals, g.outDecimals], m: r.m, swap,
  }, (_, v) => (typeof v === 'bigint' ? String(v) : v));

  g.svm.expireBlockhash();
  const before = guardBalances(g);
  const result = send(g.svm, await sign(g.svm, ixs, g.agent, signers));
  const after = guardBalances(g);
  counts[result.ok ? 'allowed' : 'refused']++;
  reasons.set(verdict.why, (reasons.get(verdict.why) ?? 0) + 1);

  const broken = guardInvariants(before, after, result.ok, swap.amount, swap.minOut);
  if (broken.length) failures.push(`${broken.join('; ')} ${describe()}`);
  if (result.ok && !verdict.ok) failures.push(`the chain allowed a swap the rules forbid (${verdict.why}) ${describe()}`);
  if (!result.ok && verdict.ok) failures.push(`the chain refused a swap the rules allow: ${result.error} ${describe()}`);
  if (verdict.ok && verdict.next) r.m = verdict.next;
  if (failures.length >= 5) break;
}

const took = Math.round((Date.now() - started) / 1000);
const summary = [
  '# Orientim Guard: the owner\'s rules, fuzzed',
  '',
  `Seed ${SEED}, ${ran} of ${RUNS} swaps in ${took} s: ${counts.allowed} allowed, ${counts.refused} refused; ${counts.ownerActions} owner actions, the clock moved ${counts.days} times.`,
  '',
  '| The model\'s verdict | Swaps |',
  '| --- | --- |',
  ...[...reasons].sort((a, b) => b[1] - a[1]).map(([why, n]) => `| ${why} | ${n} |`),
  '',
  failures.length ? `**${failures.length} disagreed with the rules or broke the promise:**\n\n${failures.map(f => `- ${f}`).join('\n')}` : 'The chain agreed with the rules on every swap, and the promise held.',
  '',
].join('\n');
mkdirSync(OUT_DIR, { recursive: true });
writeFileSync(`${OUT_DIR}/${OUT_FILE}`, summary);
console.log(summary);
process.exit(failures.length ? 1 : 0);
