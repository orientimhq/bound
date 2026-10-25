/**
 * Orientim Guard, fuzzed (GRD-13): random swaps through the Guard with T6's malicious program as the
 * route, in a real Solana VM, for random amounts, minimums, decimals and token programs.
 *
 * A plan is the transaction's shape (normal, no settle, something after settle, two pulls, an
 * unknown or absent verifier, the output or the hopper swapped for someone else's) and what the route
 * does inside it: take from the hopper (the amount, more, or less), deliver (the minimum, more, or
 * less), sign as the Guard's authority to spend or burn the owner's input, spend the owner's other
 * token or output with the agent's signature. For every case the promise is checked on the chain's
 * own balances (tests/guard/world.ts `guardInvariants`), and an honest plan must go through.
 *
 *   node tests/guard/fuzz.ts      (GUARD_FUZZ_RUNS cases, 1,000 by default; GUARD_FUZZ_SEED)
 *
 * The Guard workflow also builds two deliberately broken copies of the program and requires this
 * fuzzer to catch each of them.
 */
import { generateKeyPairSigner } from '@solana/kit';
import type { Instruction } from '@solana/kit';
import { mkdirSync, writeFileSync } from 'node:fs';
import { TOKEN_2022_PROGRAM, TOKEN_PROGRAM } from '@orientimhq/swap/core';
import { deliver, IX, requireProgram, send, sign, takeFrom, transfer, u64 } from '../cpi/world.ts';
import type { Inner } from '../cpi/world.ts';
import { guardBalances, guardInvariants, guardSetup, ix, requireGuard, route } from './world.ts';
import type { GuardWorld } from './world.ts';

requireProgram();
requireGuard();

const RUNS = Number(process.env.GUARD_FUZZ_RUNS ?? 1_000);
const SEED = Number(process.env.GUARD_FUZZ_SEED ?? Date.now() % 1_000_000);
const PER_WORLD = 40;
const OUT_DIR = 'tests/guard/results';
const OUT_FILE = process.env.GUARD_FUZZ_OUT ?? 'guard-fuzz.md';

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
const pick = <T>(xs: readonly T[]): T => xs[Math.floor(random() * xs.length)];
const amount = (digits: number) => {
  const e = int(0, digits - 1);
  return 10n ** BigInt(e) + BigInt(Math.floor(random() * 9 * 10 ** Math.min(e, 15))) * 10n ** BigInt(Math.max(0, e - 15));
};
const near = (x: bigint, digits: number) => {
  const r = random();
  return r < 0.4 ? x : r < 0.55 ? x + 1n : r < 0.7 && x > 1n ? x - 1n : amount(digits);
};

const SHAPES = ['normal', 'normal', 'normal', 'no settle', 'after settle', 'two pulls', 'unknown verifier', 'no verifier', 'output elsewhere', 'hopper elsewhere'] as const;
type Shape = (typeof SHAPES)[number];

type Step = { what: string; inner: (g: GuardWorld) => Inner; extra?: (g: GuardWorld) => string[] };

const counts = { succeeded: 0, refused: 0 };
const failures: string[] = [];
let g: GuardWorld | null = null;
const started = Date.now();

for (let i = 0; i < RUNS; i++) {
  if (i % PER_WORLD === 0) {
    g = await guardSetup({
      tokenProgram: pick([TOKEN_PROGRAM, TOKEN_2022_PROGRAM]),
      budget: 10n ** 17n,
      large: true,
      decimals: [int(0, 12), int(0, 12)],
      rules: x => ({ limits: [{ mint: x.mintIn, perSwap: 10n ** 16n, perDay: 10n ** 17n }], outputs: [x.mintOut] }),
    });
  }
  const w = g!;
  w.svm.expireBlockhash();
  const amountIn = 1n + amount(12);
  const minOut = 1n + amount(14);
  const shape: Shape = random() < 0.4 ? 'normal' : pick(SHAPES);
  const menu: Step[] = [
    { what: 'take', inner: () => takeFrom(near(amountIn, 13)) },
    { what: 'deliver', inner: () => deliver(near(minOut, 15)) },
    {
      what: 'deliver to the agent',
      inner: x => ({ program: IX.token, signed: true, metas: [{ key: IX.pool, w: true }, { key: x.agentOut, w: true }, { key: IX.poolAuthority, s: true }], data: transfer(near(minOut, 15)) }),
      extra: x => [x.agentOut],
    },
    {
      what: 'spend owner input as authority',
      inner: x => ({ program: IX.token, metas: [{ key: x.wIn, w: true }, { key: IX.attackerIn, w: true }, { key: x.authority, s: true }], data: transfer(near(1n, 9)) }),
      extra: x => [x.wIn, x.authority],
    },
    {
      what: 'burn owner input as authority',
      inner: x => ({ program: IX.token, metas: [{ key: x.wIn, w: true }, { key: x.mintIn, w: true }, { key: x.authority, s: true }], data: Uint8Array.from([8, ...u64(near(1n, 9))]) }),
      extra: x => [x.wIn, x.mintIn, x.authority],
    },
    {
      what: 'spend owner other',
      inner: x => ({ program: IX.token, metas: [{ key: x.wOther, w: true }, { key: IX.attackerIn, w: true }, { key: IX.E, s: true }], data: transfer(near(1n, 9)) }),
      extra: x => [x.wOther],
    },
    {
      what: 'spend owner output',
      inner: () => ({ program: IX.token, metas: [{ key: IX.output, w: true }, { key: IX.pool, w: true }, { key: IX.E, s: true }], data: transfer(near(1n, 9)) }),
    },
  ];
  const honest = shape === 'normal' && random() < 0.4;
  const steps: Step[] = honest
    ? [{ what: 'take', inner: () => takeFrom(random() < 0.5 ? amountIn : amountIn / 2n) }, { what: 'deliver', inner: () => deliver(minOut + BigInt(int(0, 3))) }]
    : shape === 'output elsewhere' && random() < 0.5
      ? [menu[0], menu[2]] // a swap that would be honest, but paid to the agent
      : Array.from({ length: int(1, 4) }, () => pick(menu));
  const inners = steps.map(s => s.inner(w));
  const extra = [...new Set(steps.flatMap(s => s.extra?.(w) ?? []))] as Parameters<typeof route>[2];

  const signers = [w.verifier];
  let pull: Instruction = ix.pull(w, amountIn, minOut);
  let settle = ix.settle(w);
  if (shape === 'unknown verifier') {
    const stranger = await generateKeyPairSigner();
    signers[0] = stranger;
    pull = ix.pull(w, amountIn, minOut, { verifier: stranger.address });
  }
  if (shape === 'no verifier') {
    signers.length = 0;
    pull = ix.pull(w, amountIn, minOut, { verifierSigns: false });
  }
  if (shape === 'output elsewhere') {
    pull = ix.pull(w, amountIn, minOut, { ownerOut: w.agentOut });
    settle = ix.settle(w, { ownerOut: w.agentOut });
  }
  if (shape === 'hopper elsewhere') {
    pull = ix.pull(w, amountIn, minOut, { hopper: w.attackerIn });
    settle = ix.settle(w, { hopper: w.attackerIn });
  }
  const swapIx = route(w, inners, extra);
  const ixs: Instruction[] =
    shape === 'no settle' ? [pull, swapIx]
      : shape === 'after settle' ? [pull, swapIx, settle, route(w, [takeFrom(1n)])]
        : shape === 'two pulls' ? [pull, pull, swapIx, settle]
          : [pull, swapIx, settle];

  const describe = () => JSON.stringify({
    seed: SEED, case: i, tokenProgram: w.tokenProgram, decimals: [w.inDecimals, w.outDecimals], shape,
    amountIn: String(amountIn), minOut: String(minOut), steps: steps.map(s => s.what), honest,
  });
  const before = guardBalances(w);
  let result;
  try {
    result = send(w.svm, await sign(w.svm, ixs, w.agent, signers));
  } catch {
    counts.refused++; // too large to compile into one transaction: nothing is sent
    continue;
  }
  const after = guardBalances(w);
  counts[result.ok ? 'succeeded' : 'refused']++;
  const broken = guardInvariants(before, after, result.ok, amountIn, minOut);
  if (broken.length) failures.push(`${broken.join('; ')} ${describe()}`);
  if (honest && !result.ok) failures.push(`an honest swap was refused: ${result.error} ${describe()}`);
  if (failures.length >= 5) break;
}

const took = Math.round((Date.now() - started) / 1000);
const summary = [
  '# Orientim Guard fuzz',
  '',
  `Seed ${SEED}, ${RUNS} cases in ${took} s: ${counts.succeeded} went through, ${counts.refused} refused by the chain.`,
  '',
  failures.length ? `**${failures.length} broke the promise:**\n\n${failures.map(f => `- ${f}`).join('\n')}` : 'The promise held on the chain in every case.',
  '',
].join('\n');
mkdirSync(OUT_DIR, { recursive: true });
writeFileSync(`${OUT_DIR}/${OUT_FILE}`, summary);
console.log(summary);
process.exit(failures.length ? 1 : 0);
