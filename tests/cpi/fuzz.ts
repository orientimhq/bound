/**
 * T6, fuzzed: the malicious swap program (tests/cpi/attacker) runs a random plan of up to four
 * cross-program invocations inside Orientim's protected transaction, in a real Solana VM, for
 * random amounts, minimums, decimals and token programs, with or without an issuer's delegate on
 * the mints and rent sent to the temporary key.
 *
 * Every plan is drawn from what a hostile route can try: take from the temporary account (the
 * approved amount, more, or less), deliver (the minimum, more, or less), spend the wallet's input,
 * its other token, its SOL (signed or forged) or its output balance, leave a delegate, take
 * ownership, close accounts to the attacker, take the temporary key's lamports, and act as the
 * issuer's delegate. For every case:
 *
 * - the verifier refuses it, and nothing is signed; or
 * - it is signed and sent, and whatever the chain did, the promise holds on the chain's own balances:
 *   nothing beyond the approved amount leaves, the fee is exact, the minimum arrives or everything is
 *   undone, no temporary account or permission survives, and nothing else of the wallet's moves;
 * - a plan that only takes at most the approved amount and delivers at least the minimum succeeds.
 *
 *   node tests/cpi/fuzz.ts            (ORIENTIM_FUZZ_RUNS cases, 2,000 by default; ORIENTIM_FUZZ_SEED)
 *
 * Needs the program built (cargo build-sbf in tests/cpi/attacker); .github/workflows/cpi.yml runs it.
 */
import { signTransaction } from '@solana/kit';
import type { Address } from '@solana/kit';
import { mkdirSync, writeFileSync } from 'node:fs';
import { MAX_ROUTE_KEPT_LAMPORTS, TOKEN_2022_PROGRAM, TOKEN_PROGRAM } from '@orientim/core';
import {
  approve, balancesOf, CLOSE_ACCOUNT, deliver, freshKey, invariants, IX, protectedSwap, requireProgram, send, setAuthority, setup,
  takeFrom, transfer, transferChecked, transferSol,
} from './world.ts';
import type { Inner, IssuerDelegate, Variant, World } from './world.ts';

requireProgram();

const RUNS = Number(process.env.ORIENTIM_FUZZ_RUNS ?? 2_000);
const SEED = Number(process.env.ORIENTIM_FUZZ_SEED ?? Date.now() % 1_000_000);
/** A world serves this many cases before a new one, with other decimals, is made. */
const PER_WORLD = 40;
const OUT_DIR = 'tests/cpi/results';

// A small seeded generator (mulberry32), so that any failing case can be replayed from its seed.
let state = SEED >>> 0;
const random = () => {
  state = (state + 0x6d2b79f5) >>> 0;
  let t = state;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
};
const int = (min: number, max: number) => min + Math.floor(random() * (max - min + 1));
const pick = <T>(xs: readonly T[]): T => xs[Math.floor(random() * xs.length)];
/** Any order of magnitude up to 10^digits. */
const amount = (digits: number) => {
  const e = int(0, digits - 1);
  return 10n ** BigInt(e) + BigInt(Math.floor(random() * 9 * 10 ** Math.min(e, 15))) * 10n ** BigInt(Math.max(0, e - 15));
};
/** Near a figure: exactly it, a unit either side, or anything. */
const near = (x: bigint, digits: number) => {
  const r = random();
  return r < 0.4 ? x : r < 0.55 ? x + 1n : r < 0.7 && x > 1n ? x - 1n : amount(digits);
};

type Step = { what: string; inner: (w: World) => Inner };
type Plan = {
  variant: Variant; tokenProgram: Address; issuer: IssuerDelegate | undefined; amountIn: bigint; minOut: bigint;
  takerRent: bigint; steps: Step[]; extra: 'none' | 'attacker' | 'multisig' | 'walletInput'; honest: boolean;
};

function plan(w: World): Plan {
  // SOL out needs the classic token program in the route, which a Token-2022 world does not hand over.
  const variant: Variant = w.tokenProgram === TOKEN_PROGRAM && random() < 0.3 ? 'A' : 'C';
  const amountIn = 1_000n + amount(12);
  const minOut = variant === 'A' ? 1n + amount(11) : 1n + amount(14);
  // Orientim's fee is 0.5% of the amount in these worlds; the rest is what the route may take.
  const swapAmount = amountIn - (amountIn * 50n) / 10_000n;
  const takerRent = random() < 0.2 ? MAX_ROUTE_KEPT_LAMPORTS : 0n;
  const menu: Step[] = [
    { what: 'take', inner: () => takeFrom(near(swapAmount, 13)) },
    { what: 'deliver', inner: () => deliver(near(minOut, 15)) },
    { what: 'spend wallet input', inner: x => ({ program: IX.token, metas: [{ key: x.wIn, w: true }, { key: IX.attackerIn, w: true }, { key: x.W.address, s: true }], data: transfer(near(1n, 9)) }) },
    { what: 'spend wallet other', inner: x => ({ program: IX.token, metas: [{ key: x.wOther, w: true }, { key: IX.attackerIn, w: true }, { key: x.W.address, s: true }], data: transfer(near(1n, 9)) }) },
    { what: 'take wallet SOL', inner: x => ({ program: IX.system, signed: random() < 0.5, metas: [{ key: x.W.address, w: true, s: true }, { key: x.attacker, w: true }], data: transferSol(near(1n, 10)) }) },
    { what: 'spend output balance', inner: x => ({ program: IX.token, metas: [{ key: IX.output, w: true }, { key: IX.pool, w: true }, { key: x.W.address, s: true }], data: transfer(near(1n, 9)) }) },
    { what: 'delegate on output', inner: x => ({ program: IX.token, metas: [{ key: IX.output, w: true }, { key: IX.poolAuthority }, { key: x.W.address, s: true }], data: approve(2n ** 63n) }) },
    { what: 'own the output', inner: x => ({ program: IX.token, metas: [{ key: IX.output, w: true }, { key: x.W.address, s: true }], data: setAuthority(2, x.attacker) }) },
    { what: 'close output to attacker', inner: x => ({ program: IX.token, metas: [{ key: IX.output, w: true }, { key: x.attacker, w: true }, { key: random() < 0.5 ? x.W.address : IX.E, s: true }], data: CLOSE_ACCOUNT }) },
    { what: 'delegate on temporary', inner: () => ({ program: IX.token, metas: [{ key: IX.eIn, w: true }, { key: IX.poolAuthority }, { key: IX.E, s: true }], data: approve(2n ** 63n) }) },
    { what: 'close temporary', inner: () => ({ program: IX.token, metas: [{ key: IX.eIn, w: true }, { key: pick([IX.attackerIn, IX.poolAuthority]), w: true }, { key: IX.E, s: true }], data: CLOSE_ACCOUNT }) },
    { what: 'take key lamports', inner: x => ({ program: IX.system, metas: [{ key: IX.E, w: true, s: true }, { key: x.attacker, w: true }], data: transferSol(near(takerRent || 1n, 7)) }) },
    ...(w.multisig ? [{
      what: 'act as issuer', inner: (x: World) => ({
        program: IX.token, signed: true,
        metas: [{ key: IX.output, w: true }, { key: 9 }, { key: IX.pool, w: true }, { key: x.multisig! }, { key: IX.poolAuthority, s: true }],
        data: transferChecked(near(1n, 9), variant === 'A' ? 9 : x.outDecimals),
      }),
    }] : []),
  ];
  // A third of the plans are a route that swaps honestly: all of the approved amount, at least the
  // minimum. The rest are anything from the menu.
  const honest = random() < 0.35;
  const steps: Step[] = honest
    ? [{ what: 'take', inner: () => takeFrom(swapAmount) }, { what: 'deliver', inner: () => deliver(minOut + BigInt(int(0, 3))) }]
    : Array.from({ length: int(1, 4) }, () => pick(menu));
  // A market that charges the key rent spends all of it, as a real route does: rent left
  // in the key would keep it alive, which the promise does not allow.
  if (takerRent > 0n) steps.unshift({ what: 'spend key rent', inner: () => ({ program: IX.system, metas: [{ key: IX.E, w: true, s: true }, { key: IX.attackerIn, w: true }], data: transferSol(takerRent) }) });
  const extra = w.multisig && random() < 0.7 ? 'multisig' : pick(['none', 'none', 'attacker', 'walletInput'] as const);
  return { variant, tokenProgram: w.tokenProgram, issuer: w.multisig ? 'multisig' : undefined, amountIn, minOut, takerRent, steps, extra, honest };
}

const worlds = [
  { tokenProgram: TOKEN_PROGRAM, issuer: undefined },
  { tokenProgram: TOKEN_2022_PROGRAM, issuer: undefined },
  { tokenProgram: TOKEN_2022_PROGRAM, issuer: 'key' as const },
  { tokenProgram: TOKEN_2022_PROGRAM, issuer: 'multisig' as const },
];

const counts = { refused: 0, succeeded: 0, reverted: 0 };
const failures: string[] = [];
let w: World | null = null;
const started = Date.now();
for (let i = 0; i < RUNS; i++) {
  if (i % PER_WORLD === 0) {
    const kind = pick(worlds);
    w = await setup(kind.tokenProgram, kind.issuer, { decimals: [int(0, 12), int(0, 12)], large: true });
  }
  const world = w!;
  await freshKey(world);
  const p = plan(world);
  const inners = p.steps.map(s => s.inner(world));
  const extra = p.extra === 'attacker' ? [world.attacker] : p.extra === 'multisig' && world.multisig ? [world.multisig] : p.extra === 'walletInput' ? [world.wIn] : [];
  const describe = () => JSON.stringify({
    seed: SEED, case: i, variant: p.variant, tokenProgram: p.tokenProgram, issuer: p.issuer, decimals: [world.inDecimals, world.outDecimals],
    amountIn: String(p.amountIn), minOut: String(p.minOut), takerRent: String(p.takerRent), extra: p.extra, steps: p.steps.map(s => s.what),
  });
  let built;
  try {
    built = await protectedSwap(world, p.variant, inners, extra, p.takerRent, { amountIn: p.amountIn, minOut: p.minOut });
  } catch {
    // Orientim refused to build it at all (an amount too small for the fee, say): nothing to sign.
    counts.refused++;
    continue;
  }
  const { policy, transaction, verdict } = built;
  if (!verdict.ok) {
    counts.refused++;
    if (p.honest && p.extra === 'none') failures.push(`an honest route was refused before signing: ${verdict.violations.map(v => v.detail).join('; ')} ${describe()}`);
    continue;
  }
  const before = balancesOf(world);
  const result = send(world.svm, await signTransaction([world.W.keyPair, world.E.keyPair], transaction));
  const after = balancesOf(world);
  const broken = invariants(world, policy, before, after, result.ok);
  counts[result.ok ? 'succeeded' : 'reverted']++;
  if (broken.length) failures.push(`${broken.join('; ')} ${describe()}`);
  // An honest route, with nothing added that takes, must go through.
  if (p.honest && !result.ok) failures.push(`an honest route reverted: ${result.error} ${describe()}`);
  if (failures.length >= 5) break;
}

const took = Math.round((Date.now() - started) / 1000);
const summary = [
  '# T6 fuzz: a hostile swap program with random plans',
  '',
  `Seed ${SEED}, ${RUNS} cases in ${took} s: ${counts.refused} refused before signing, ${counts.succeeded} went through, ${counts.reverted} undone by the chain.`,
  '',
  failures.length ? `**${failures.length} broke the promise:**\n\n${failures.map(f => `- ${f}`).join('\n')}` : 'The promise held on the chain in every case.',
  '',
].join('\n');
mkdirSync(OUT_DIR, { recursive: true });
writeFileSync(`${OUT_DIR}/cpi-fuzz.md`, summary);
console.log(summary);
process.exit(failures.length ? 1 : 0);
