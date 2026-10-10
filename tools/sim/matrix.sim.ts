/**
 * The mainnet simulation matrix: the whole path an agent or a bot takes, on mainnet's real prices,
 * pools and balances, stopped before anything is signed. For each case:
 *
 *   the agent's own quote from Jupiter → the owner's policy → Orientim's agent API (its real code,
 *   run in this process, not orientim.com) → the skill's full check on the exact bytes, which
 *   simulates the final transaction on mainnet state.
 *
 * The wallet of each case is a public wallet that holds the input token (an exchange's, found on
 * chain): no key is used, nothing is signed or sent, no funds move. Amounts run from $1 to $1M;
 * tokens are majors, LSTs, stablecoins, memecoins, Token-2022, Pump.fun tokens on the curve and on
 * PumpSwap, and pairs where neither side is SOL or USDC; tolerances, owner ceilings and limits vary.
 *
 * Each case ends as one of:
 *   PASS      the swap was built, passed every check and executes in simulation
 *   REFUSED   refused before signing, for a reason of Orientim's or the owner's (the code says which)
 *   UNTESTED  a service was busy (429), silent, or the price moved during the check: not a verdict
 *   BUG       anything else: Orientim's own honest answer refused by the skill's check, an internal
 *             error, an expectation not met, the agent and the bot deciding differently
 * Beyond each verdict: every pass is read again apart from the skill (nine rules, from the bytes);
 * passed swaps are changed in eight ways a dishonest server could (hash restated), and the check
 * must refuse each; costlier routes and moved prices are approved as the owner would; fourteen
 * swaps run at the same moment; six run at the start, middle and end. The analysis (impact, floor,
 * cost and time by size, markets, the largest passes) closes the report.
 *
 * The run fails on any BUG. The report goes to the job summary and to $SIM_OUT (report.md, report.json).
 *
 *   RPC_URL=<mainnet RPC> JUPITER_API_KEY=<key> npx vitest run --config tools/sim/vitest.config.ts
 *   SIM_GROUPS=sizes,pairs   only those groups (repeat, sizes, pairs, majors, whales, personas, pump, tolerance, rules,
 *                            parity, hard, giants, more-tokens, tamper, approve, burst, v1-compare, modes, fallback,
 *                            routes, grid)
 *   SIM_LIMIT=20             at most this many cases
 *   SIM_JUPITER_INTERVAL_MS  the least time between two Jupiter requests (default 1100: a free key)
 *   SIM_VERSION=1            every case that names no version as a v1 transaction (default v0)
 *   SIM_OWN_ROUTES=0         Orientim's key fetches the routes (default: the agent's own key, as the skill does)
 *   SIM_OFFLINE=1            a few cases against the test fakes, to check the matrix itself without a network
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import {
  address, getAddressDecoder, getCompiledTransactionMessageDecoder, getCompiledTransactionMessageEncoder, getTransactionDecoder, getTransactionEncoder,
} from '@solana/kit';
import type { Address, Rpc, SolanaRpcApi } from '@solana/kit';
import { ataOf, JUPITER_PROGRAM, WSOL_MINT } from '@orientim/core';
import { jupiterDestination, jupiterRouteArgs } from '@orientim/verifier';
import { createJupiterClient, heliusPriorityFee, MIN_FEE } from '@orientim/jupiter';
import { createRetryingRpc } from '@orientim/solana';
import { agentPrepare } from '../../apps/web/lib/server/agent/api.ts';
import type { AgentDeps } from '../../apps/web/lib/server/agent/api.ts';
import {
  checkPolicy, checkPrepared, FloorError, IntentError, OrientimApiError, PolicyError, prepareChecked, PriceImpactError,
} from '../../skills/orientim-protected-swap/examples/swap.ts';
import type { Checked, Intent, OwnerPolicy, Prepared } from '../../skills/orientim-protected-swap/examples/swap.ts';
import { runCli } from '../../skills/orientim-protected-swap/src/cli.ts';
import { ORIENTIM_TREASURY } from '../../skills/orientim-protected-swap/lib/orientim-verify.mjs';

const OFFLINE = process.env.SIM_OFFLINE === '1';
const RPC_URL = process.env.RPC_URL || 'https://api.mainnet-beta.solana.com';
const JUPITER_API_KEY = process.env.JUPITER_API_KEY || undefined;
/** Routes fetched by the agent with its own key (the default with a key); SIM_OWN_ROUTES=0: Orientim's key builds them. */
const OWN_ROUTES = process.env.SIM_OWN_ROUTES !== '0';
const JUPITER_INTERVAL_MS = Number(process.env.SIM_JUPITER_INTERVAL_MS ?? (JUPITER_API_KEY ? 1_100 : 2_200));
const GROUPS = (process.env.SIM_GROUPS ?? '').split(',').map(s => s.trim()).filter(Boolean);
const LIMIT = Number(process.env.SIM_LIMIT ?? 0) || Infinity;
const OUT = process.env.SIM_OUT ?? join(tmpdir(), 'orientim-sim');
/** The transaction version of every case that does not name its own: SIM_VERSION=1 runs the matrix as v1. */
const DEFAULT_VERSION: 0 | 1 = process.env.SIM_VERSION === '1' ? 1 : 0;
const API_KEY = `ori_sim_${randomBytes(12).toString('hex')}`;
const API_URL = 'http://orientim.sim';

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

// --- tokens
const T = {
  SOL: WSOL_MINT,
  USDC: address('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'),
  USDT: address('Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB'),
  JUP: address('JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN'),
  BONK: address('DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263'),
  WIF: address('EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm'),
  RAY: address('4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R'),
  POPCAT: address('7GCihgDB8fe6KNjn2MYtkzZcRjQy3t9GHdC8uHYmW2hr'),
  TRUMP: address('6p6xgHyF7AeE6TZkSmFsko444wqoP15icUSqi2jfGiPN'),
  JitoSOL: address('J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn'),
  mSOL: address('mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So'),
  PYUSD: address('2b1kV6DkPAnxd5ixfnxCpjxmKwqjjaYmCZfHsFu24GXo'),
  bSOL: address('bSo13r4TkiE4KumL71LsHTPpL2euBYLFx6h9HP3piy1'),
  JTO: address('jtojtomepa8beP8AuQc6eXt5FriJwfFMwQx2v2f9mCL'),
  PYTH: address('HZ1JovNiVvGrGNiiYvEozEVgZ58xaU3RKwX8eACQBCt3'),
  W: address('85VBFQZC9TZkfaptBWjvUw7YbZjy52A6mjtPGjstQAmQ'),
  RENDER: address('rndrizKT3MK1iimdxRdWabcF7Zg7AR5T4nud4EkHBof'),
  HNT: address('hntyVP6YFm1Hg25TN9WGLqM12b8TQmcknKrdu1oxWux'),
  PENGU: address('2zMMhcVQEXDtdE6vsFS7S7D5oUodfJHE8vd1gnBouauv'),
  FARTCOIN: address('9BB6NFEcjBCtnNLFko2FqVQBq8HHM13kCyYcdQbgpump'),
  MEW: address('MEW1gQWJ3nEXg2qgERiKu7FAFj79PHvQVREQUzScPP5'),
  JupSOL: address('jupSoLaHXQiZZTSfEWMTRRgpnyFm8f6sZdosWBjx93v'),
  INF: address('5oVNBeEEQvYi1cX3ir8Dx5n1P7pdxydbGF2X4TxVusJm'),
  ORCA: address('orcaEKTdK7LKz57vaAYr9QeNsVEPfiu6QeMU1kektZE'),
} as const;
type Sym = keyof typeof T | string;
const symbols = new Map<string, string>(Object.entries(T).map(([s, m]) => [m, s]));
const nameOf = (mint: string) => symbols.get(mint) ?? `${mint.slice(0, 4)}…`;

/** Public exchange wallets, tried first as holders; holders found on chain come after them. */
const KNOWN_HOLDERS = [
  'GJRs4FwHtemZ5ZE9x3FNvJ8TMwitKTh21yxdRPqn7npE', '5tzFkiKscXHK5ZXCGbXZxdw7gTjjD1mBwuoFbhUvuAi9',
  'H8sMJSCQxfKiFTCfDR3DUMLPwcRbM61LGFJ8N4dK3WjS', '2AQdpHJ2JpcEgPiATUXjQxA8QmafFegfQwSLWSprPicm',
  'FWznbcNXWQuHTawe9RxvQ2LdCENssh12dsznf4RiouN5', 'AC5RDfQFmDS1deWZos921JfqscXdByf8BKHs5ACWjtW2',
  'ASTyfSima4LLAdDgoFGkgqoKowG1LZFDr9fAQrg7iaJZ', '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM',
];

// --- cases
type Rule = { label: string; policy?: Omit<OwnerPolicy, 'maxAmountIn'> & { maxAmountIn?: Record<string, string> }; intent?: Partial<Omit<Intent, 'owner'>> };
type Case = {
  group: string; input: Sym; output: Sym; usd: number;
  /** A fraction of what the holder has, instead of `usd` (a Pump.fun token without a price). */
  share?: number;
  slippage?: number | 'auto';
  rule?: Rule;
  /** Outcomes accepted for this case: PASS, or refusal codes. Unset: any honest outcome. */
  expect?: string[];
  /** Also through orientim-verify, as a bot: both must decide alike. */
  bot?: boolean;
  /** Run this many copies of the case at once (a busy agent, several workers). */
  parallel?: number;
  /** An explicit minimum for the agent, as a fraction of Jupiter's quote (1.05 = 5% above it). */
  minOutOfQuote?: number;
  version?: 0 | 1;
  fast?: boolean;
  /** After a pass, change the built transaction in each way a dishonest server could, and expect the check to refuse every one. */
  tamper?: boolean;
  /** Refused as costing more or as a moved price: approve it as the owner would (acceptCostBps, or the new minimum), once. */
  approve?: boolean;
  /** Cases with the same wave run all at once: many agents, different swaps, the same moment. */
  wave?: string;
  /** The same swap as a v0 and as a v1 transaction, one after the other: their outputs compared. */
  compare?: string;
  /**
   * The agent understates the output of every route it brings this many times (the audit's proof):
   * with a fee on the output, Orientim must not use them and builds with its own key; with a fee on
   * the input, the agent's own minimum still holds.
   */
  understate?: bigint;
  /** This case without the agent's own routes: Orientim's key builds them, as without a key. */
  orientimRoutes?: boolean;
  /** The same swap with the agent's routes and with Orientim's, a moment apart: their minimum and fee compared. */
  routesCompare?: string;
};

function buildCases(pump: { curve: string[]; amm: string[] }): Case[] {
  const cases: Case[] = [];
  const r = (label: string, policy: Rule['policy'], intent: Rule['intent'] = {}): Rule => ({ label, policy, intent });
  // The same six swaps at the start, in the middle and at the end of the run, some 25 minutes apart:
  // the same answer each time, on a market that moved in between.
  const repeat = (round: number) => {
    for (const c of [
      { input: 'SOL', output: 'USDC', usd: 10_000 }, { input: 'USDC', output: 'BONK', usd: 5_000 }, { input: 'JitoSOL', output: 'SOL', usd: 50_000 },
      { input: 'SOL', output: 'WIF', usd: 20_000 }, { input: 'PYUSD', output: 'USDC', usd: 10_000 }, { input: 'USDT', output: 'SOL', usd: 100_000, slippage: 'auto' as const },
    ] as Omit<Case, 'group'>[]) cases.push({ group: 'repeat', rule: { label: `round ${round} of 3` }, ...c });
  };
  repeat(1);
  // Amounts from $1 to $1M: where the price impact grows, where the route costs more, where it stops.
  for (const [input, output] of [['USDC', 'SOL'], ['SOL', 'USDC'], ['USDC', 'JUP'], ['USDT', 'BONK']] as const) {
    for (const usd of [1, 10, 100, 1_000, 10_000, 100_000, 1_000_000]) cases.push({ group: 'sizes', input, output, usd });
  }
  // Neither side is SOL or USDC: the fee comes from USDT, the input, or in SOL from the wallet.
  for (const [input, output] of [
    ['BONK', 'WIF'], ['WIF', 'JUP'], ['JUP', 'BONK'], ['RAY', 'JUP'], ['POPCAT', 'WIF'], ['JitoSOL', 'mSOL'],
    ['mSOL', 'JUP'], ['PYUSD', 'USDT'], ['USDT', 'BONK'], ['TRUMP', 'JUP'], ['BONK', 'POPCAT'], ['JUP', 'PYUSD'],
  ] as const) {
    for (const usd of [20, 500, 5_000]) cases.push({ group: 'pairs', input, output, usd });
  }
  // Each token against SOL and USDC, both ways.
  for (const token of ['JUP', 'BONK', 'WIF', 'POPCAT', 'TRUMP', 'RAY', 'JitoSOL', 'PYUSD', 'USDT'] as const) {
    for (const usd of [50, 2_000]) {
      cases.push({ group: 'majors', input: 'SOL', output: token, usd }, { group: 'majors', input: token, output: 'USDC', usd });
    }
  }
  // Large swaps against SOL, both ways, token by token: $5k to $200k, where each token's liquidity ends.
  const whaleTokens = ['JUP', 'BONK', 'WIF', 'POPCAT', 'TRUMP', 'RAY', 'JitoSOL', 'mSOL', 'bSOL', 'JTO', 'PYTH', 'W', 'RENDER', 'HNT', 'PENGU', 'FARTCOIN', 'MEW', 'PYUSD', 'USDT'];
  for (const token of whaleTokens) {
    for (const usd of [5_000, 8_000, 20_000, 50_000, 100_000, 200_000]) {
      cases.push({ group: 'whales', input: 'SOL', output: token, usd }, { group: 'whales', input: token, output: 'SOL', usd });
    }
  }
  // Large swaps where neither side is SOL.
  for (const [input, output] of [['BONK', 'WIF'], ['JUP', 'USDT'], ['WIF', 'POPCAT'], ['JitoSOL', 'mSOL'], ['PENGU', 'JUP']] as const) {
    for (const usd of [20_000, 100_000, 200_000]) cases.push({ group: 'whales', input, output, usd });
  }
  repeat(2);
  // Kinds of users: each owner sets their own rules and tolerance, on the same tokens.
  const personas: { label: string; policy?: Rule['policy']; slippage?: number | 'auto'; intent?: Rule['intent'] }[] = [
    { label: 'careful: ceiling 0.5%, auto', policy: { maxSlippageBps: 50 }, slippage: 'auto' },
    { label: 'meme trader: ceiling 3%, impact 5%, auto', policy: { maxSlippageBps: 300, maxPriceImpactBps: 500 }, slippage: 'auto' },
    { label: 'whale: impact at most 1%, 0.3%', policy: { maxPriceImpactBps: 100 }, slippage: 30 },
    { label: 'bot with defaults' },
    { label: 'tight: floor 1%, ceiling 1%', policy: { maxBelowBps: 100, maxSlippageBps: 100 } },
  ];
  for (const token of ['JUP', 'BONK', 'WIF', 'POPCAT', 'TRUMP', 'JTO', 'PYTH', 'PENGU', 'FARTCOIN', 'RENDER']) {
    for (const p of personas) {
      const rule: Rule = { label: p.label, ...(p.policy ? { policy: p.policy } : {}), ...(p.intent ? { intent: p.intent } : {}) };
      cases.push({ group: 'personas', input: 'SOL', output: token, usd: 5_000, rule, ...(p.slippage !== undefined ? { slippage: p.slippage } : {}) });
      cases.push({ group: 'personas', input: token, output: 'SOL', usd: 50_000, rule, ...(p.slippage !== undefined ? { slippage: p.slippage } : {}) });
    }
  }
  // Pump.fun: tokens still on the bonding curve, and graduated ones trading on PumpSwap.
  for (const mint of pump.curve) {
    cases.push({ group: 'pump', input: 'SOL', output: mint, usd: 5 }, { group: 'pump', input: 'SOL', output: mint, usd: 50 });
    cases.push({ group: 'pump', input: mint, output: 'SOL', usd: 0, share: 0.01 });
  }
  for (const mint of pump.amm) {
    cases.push({ group: 'pump', input: 'SOL', output: mint, usd: 20 }, { group: 'pump', input: 'SOL', output: mint, usd: 500 });
    cases.push({ group: 'pump', input: mint, output: 'USDC', usd: 0, share: 0.01 });
  }
  // The tolerance an agent chooses: none (Orientim's default), "auto" (Jupiter's estimate), or a number.
  const toleranceOn: [Sym, Sym, number][] = [['SOL', 'USDC', 500], ['USDC', 'BONK', 500], ['WIF', 'JUP', 500], ['POPCAT', 'SOL', 300]];
  if (pump.curve[0]) toleranceOn.push(['SOL', pump.curve[0], 20]);
  if (pump.amm[0]) toleranceOn.push(['SOL', pump.amm[0], 50]);
  for (const [input, output, usd] of toleranceOn) {
    for (const slippage of [undefined, 'auto', 10, 50, 100, 300, 1_000] as const) cases.push({ group: 'tolerance', input, output, usd, slippage });
  }
  // The owner's rules, as an unattended agent's owner would set them.
  cases.push(
    { group: 'rules', input: 'SOL', output: 'USDC', usd: 500, slippage: 100, rule: r('ceiling 0.5%, asks 1%', { maxSlippageBps: 50 }), expect: ['slippage-over-limit'] },
    { group: 'rules', input: 'SOL', output: 'USDC', usd: 500, slippage: 'auto', rule: r('ceiling 0.5%, auto', { maxSlippageBps: 50 }), expect: ['PASS'] },
    { group: 'rules', input: 'USDC', output: 'BONK', usd: 500, rule: r('ceiling 1%, default', { maxSlippageBps: 100 }) },
    { group: 'rules', input: 'WIF', output: 'JUP', usd: 500, slippage: 'auto', rule: r('ceiling 1%, auto', { maxSlippageBps: 100 }) },
    { group: 'rules', input: 'USDC', output: 'JUP', usd: 1_000, rule: r('floor at most 1% below', { maxBelowBps: 100 }) },
    { group: 'rules', input: 'USDC', output: 'JUP', usd: 1_000, rule: r('floor 5% asked, owner allows 1%', { maxBelowBps: 100 }, { maxBelowBps: 500 }), expect: ['floor-over-limit'] },
    { group: 'rules', input: 'USDC', output: 'JUP', usd: 100_000, rule: r('price impact at most 0.5%', { maxPriceImpactBps: 50 }) },
    { group: 'rules', input: 'USDC', output: 'JUP', usd: 1_000, rule: r('impact 10% asked, owner allows 3%', { maxPriceImpactBps: 300 }, { maxPriceImpactBps: 1_000 }), expect: ['impact-over-limit'] },
    { group: 'rules', input: 'USDC', output: 'SOL', usd: 1_000, rule: r('per swap $100', { maxAmountIn: { [T.USDC]: '100000000' } }), expect: ['amount-over-limit'] },
    { group: 'rules', input: 'BONK', output: 'SOL', usd: 100, rule: r('BONK not allowed', { maxAmountIn: { [T.USDC]: '100000000' } }), expect: ['mint-not-allowed'] },
    { group: 'rules', input: 'USDC', output: 'BONK', usd: 100, rule: r('buying BONK not allowed (misled agent)', { allowedOutputMints: [T.SOL] }), expect: ['output-not-allowed'] },
    { group: 'rules', input: 'USDC', output: 'SOL', usd: 100, rule: r('minimum of 1 (misled agent)', {}, { minOut: '1' }), expect: ['floor-too-low'] },
    { group: 'rules', input: 'USDC', output: 'WIF', usd: 50_000, rule: r('agent raises impact to 20%', {}, { maxPriceImpactBps: 2_000 }) },
    { group: 'rules', input: 'SOL', output: 'USDC', usd: 200, rule: r('everything set, within', { maxSlippageBps: 300, maxBelowBps: 500, maxPriceImpactBps: 300, maxAmountIn: { [T.SOL]: '100000000000' } }), slippage: 'auto', expect: ['PASS'] },
  );
  for (const mint of pump.curve.slice(0, 2)) {
    cases.push({ group: 'rules', input: 'SOL', output: mint, usd: 20, rule: r('ceiling 1% on a curve token', { maxSlippageBps: 100 }) });
    cases.push({ group: 'rules', input: 'SOL', output: mint, usd: 20, slippage: 'auto', rule: r('ceiling 1%, auto, curve', { maxSlippageBps: 100 }) });
  }
  // The same cases as an agent (the skill) and as a bot (orientim-verify): they must decide alike.
  for (const c of [
    { input: 'USDC', output: 'SOL', usd: 100 }, { input: 'SOL', output: 'BONK', usd: 300 }, { input: 'BONK', output: 'WIF', usd: 200 },
    { input: 'USDC', output: 'JUP', usd: 100_000 }, { input: 'PYUSD', output: 'USDC', usd: 100 }, { input: 'JitoSOL', output: 'mSOL', usd: 1_000 },
    { input: 'SOL', output: 'USDC', usd: 500, slippage: 'auto' as const }, { input: 'SOL', output: 'USDC', usd: 500, slippage: 100, rule: r('ceiling 0.5%', { maxSlippageBps: 50 }) },
    ...(pump.curve[0] ? [{ input: 'SOL', output: pump.curve[0], usd: 20 }] : []),
    ...(pump.amm[0] ? [{ input: 'SOL', output: pump.amm[0], usd: 50, slippage: 'auto' as const }] : []),
  ] as Omit<Case, 'group'>[]) cases.push({ group: 'parity', bot: true, ...c });
  // Hard cases: boundaries, nonsense a misled agent may send, extremes, several at once.
  const RANDOM_MINT = 'Hq7dYVVc2S3mtDuLyYy6oF4rUUqzmVZqQ8dvKq1WgN6A';
  cases.push(
    // Near the smallest swap: the fee has a floor in SOL (about $0.40), so $0.25 is refused and $1 goes.
    { group: 'hard', input: 'USDC', output: 'SOL', usd: 0.25, expect: ['amount-too-small'] },
    { group: 'hard', input: 'USDC', output: 'SOL', usd: 1.05 },
    { group: 'hard', input: 'SOL', output: 'USDC', usd: 0.25, expect: ['amount-too-small'] },
    { group: 'hard', input: 'SOL', output: 'USDC', usd: 1.1 },
    // Nonsense: the same token on both sides, a mint that is no token at all.
    { group: 'hard', input: 'USDC', output: 'USDC', usd: 100, expect: ['any-refusal'] },
    { group: 'hard', input: 'SOL', output: 'SOL', usd: 100, expect: ['any-refusal'] },
    { group: 'hard', input: 'SOL', output: RANDOM_MINT, usd: 100, expect: ['any-refusal'] },
    // A minimum above the market (the agent asks for more than exists), and exactly at it.
    { group: 'hard', input: 'SOL', output: 'USDC', usd: 1_000, minOutOfQuote: 1.05, expect: ['any-refusal'] },
    { group: 'hard', input: 'SOL', output: 'USDC', usd: 1_000, minOutOfQuote: 1.0 },
    { group: 'hard', input: 'USDC', output: 'BONK', usd: 1_000, minOutOfQuote: 0.995 },
    // The floor at the quote itself, set by the owner.
    { group: 'hard', input: 'USDC', output: 'SOL', usd: 500, rule: r('floor at the quote (maxBelowBps 0)', { maxBelowBps: 0 }) },
    // The extremes of tolerance on thin and deep markets.
    { group: 'hard', input: 'USDC', output: 'WIF', usd: 20_000, slippage: 10 },
    // A wide tolerance on a thin route, three times: a failure in the check must repeat to count.
    ...[1, 2, 3].map(n => ({ group: 'hard', input: 'USDC', output: 'WIF', usd: 20_000, slippage: 1_500, rule: r(`wide tolerance, try ${n} of 3`, undefined) }) as Case),
    { group: 'hard', input: 'SOL', output: 'HNT', usd: 10_000, slippage: 'auto', rule: r('thin market, owner allows 20% impact', { maxPriceImpactBps: 2_000 }, { maxPriceImpactBps: 2_000 }) },
    { group: 'hard', input: 'SOL', output: 'W', usd: 50_000, rule: r('owner allows 20% impact', { maxPriceImpactBps: 2_000 }, { maxPriceImpactBps: 2_000 }) },
    // Stablecoin to stablecoin, deep.
    { group: 'hard', input: 'USDC', output: 'USDT', usd: 1_000_000 },
    { group: 'hard', input: 'USDT', output: 'USDC', usd: 500_000 },
    { group: 'hard', input: 'PYUSD', output: 'USDC', usd: 100_000 },
    // Token-2022 and LSTs at size, as a bot too.
    { group: 'hard', input: 'SOL', output: 'JitoSOL', usd: 500_000, bot: true },
    { group: 'hard', input: 'mSOL', output: 'SOL', usd: 200_000, bot: true },
    // v1 and fast routing together, on a memecoin.
    { group: 'hard', input: 'SOL', output: 'BONK', usd: 2_000, version: 1, fast: true, slippage: 'auto' },
    // A busy agent: the same swap ten times at once, and five different swaps at once.
    { group: 'hard', input: 'USDC', output: 'SOL', usd: 250, parallel: 10 },
    { group: 'hard', input: 'SOL', output: 'JUP', usd: 3_000, parallel: 5, slippage: 'auto' },
  );
  if (pump.curve[0]) cases.push({ group: 'hard', input: 'SOL', output: pump.curve[0], usd: 1_000, slippage: 'auto', rule: r('curve token at size, ceiling 5%', { maxSlippageBps: 500 }) });

  // Giants: $250k to $5M on the deepest markets, as far as each goes before its price impact limit.
  for (const [input, output] of [
    ['SOL', 'USDC'], ['USDC', 'SOL'], ['USDT', 'USDC'], ['USDC', 'USDT'], ['SOL', 'USDT'], ['USDT', 'SOL'],
    ['JitoSOL', 'SOL'], ['SOL', 'JitoSOL'], ['mSOL', 'SOL'], ['SOL', 'JupSOL'], ['USDC', 'JUP'],
  ] as const) {
    for (const usd of [250_000, 500_000, 1_000_000, 2_000_000, 5_000_000]) cases.push({ group: 'giants', input, output, usd, ...(usd === 1_000_000 ? { bot: true } : {}) });
  }
  cases.push(
    { group: 'giants', input: 'USDC', output: 'JUP', usd: 1_000_000, rule: r('owner and agent allow 10% impact', { maxPriceImpactBps: 1_000 }, { maxPriceImpactBps: 1_000 }) },
    { group: 'giants', input: 'SOL', output: 'USDC', usd: 2_000_000, slippage: 'auto', rule: r('ceiling 0.3%, auto', { maxSlippageBps: 30 }) },
    { group: 'giants', input: 'USDC', output: 'SOL', usd: 1_000_000, slippage: 10, rule: r('whale: impact at most 0.5%', { maxPriceImpactBps: 50 }) },
  );
  // LSTs and more tokens, against SOL and each other.
  for (const [input, output] of [
    ['SOL', 'INF'], ['INF', 'SOL'], ['JupSOL', 'SOL'], ['bSOL', 'JitoSOL'], ['mSOL', 'JupSOL'], ['SOL', 'ORCA'], ['ORCA', 'USDC'], ['JupSOL', 'USDC'],
  ] as const) {
    for (const usd of [1_000, 50_000]) cases.push({ group: 'more-tokens', input, output, usd });
  }
  // A dishonest server, on real mainnet transactions: each passed swap is changed in seven ways
  // (tolerance, quote, amount in, fee payer, a transfer added, the network fee, where the output
  // goes, the program), and the check must refuse every change.
  cases.push(
    { group: 'tamper', input: 'USDC', output: 'SOL', usd: 100, tamper: true },
    { group: 'tamper', input: 'SOL', output: 'USDC', usd: 10_000, tamper: true },
    { group: 'tamper', input: 'SOL', output: 'BONK', usd: 2_000, tamper: true, slippage: 'auto' },
    { group: 'tamper', input: 'BONK', output: 'WIF', usd: 500, tamper: true },
    { group: 'tamper', input: 'PYUSD', output: 'USDC', usd: 1_000, tamper: true },
    { group: 'tamper', input: 'JitoSOL', output: 'mSOL', usd: 5_000, tamper: true },
    { group: 'tamper', input: 'SOL', output: 'JUP', usd: 50_000, tamper: true },
    { group: 'tamper', input: 'USDT', output: 'BONK', usd: 1_000, tamper: true },
    { group: 'tamper', input: 'WIF', output: 'SOL', usd: 20_000, tamper: true },
    { group: 'tamper', input: 'SOL', output: 'USDC', usd: 1_000_000, tamper: true },
    { group: 'tamper', input: 'SOL', output: 'TRUMP', usd: 5_000, tamper: true, rule: r('ceiling 1%', { maxSlippageBps: 100 }) },
    { group: 'tamper', input: 'USDC', output: 'SOL', usd: 100, tamper: true, fast: true },
    ...(pump.curve[0] ? [{ group: 'tamper', input: 'SOL', output: pump.curve[0], usd: 20, tamper: true }] : []),
    ...(pump.amm[0] ? [{ group: 'tamper', input: 'SOL', output: pump.amm[0], usd: 50, tamper: true }] : []),
  );
  // The owner's approval: a costlier protected route, or a moved price, accepted as the skill says
  // (acceptCostBps set to the gap, or the new minimum), and the swap then goes through the full check.
  for (const [input, output, usd] of [
    ['SOL', 'BONK', 50_000], ['JTO', 'SOL', 100_000], ['SOL', 'W', 8_000], ['SOL', 'RENDER', 100_000],
    ['TRUMP', 'SOL', 200_000], ['BONK', 'SOL', 50_000], ['SOL', 'JTO', 50_000], ['RENDER', 'SOL', 100_000],
  ] as const) cases.push({ group: 'approve', input, output, usd, approve: true });
  cases.push({ group: 'approve', input: 'SOL', output: 'USDC', usd: 1_000, minOutOfQuote: 1.0, approve: true });
  // A burst: fourteen different agents and bots, different swaps, all at the same moment.
  for (const c of [
    { input: 'USDC', output: 'SOL', usd: 500 }, { input: 'SOL', output: 'USDC', usd: 20_000 }, { input: 'SOL', output: 'BONK', usd: 1_000 },
    { input: 'WIF', output: 'JUP', usd: 800 }, { input: 'JitoSOL', output: 'SOL', usd: 30_000 }, { input: 'USDT', output: 'USDC', usd: 250_000 },
    { input: 'PYUSD', output: 'USDC', usd: 2_000 }, { input: 'SOL', output: 'TRUMP', usd: 3_000, slippage: 'auto' as const },
    { input: 'POPCAT', output: 'SOL', usd: 1_500 }, { input: 'SOL', output: 'PENGU', usd: 4_000 }, { input: 'USDC', output: 'JUP', usd: 10_000, bot: true },
    { input: 'mSOL', output: 'JitoSOL', usd: 5_000, bot: true }, { input: 'SOL', output: 'JTO', usd: 2_500 }, { input: 'RAY', output: 'USDC', usd: 700 },
  ] as Omit<Case, 'group'>[]) cases.push({ group: 'burst', wave: 'burst', ...c });
  repeat(3);
  // v0 against v1: the swaps where a protected route cost more than the open market, each built as
  // a v0 transaction (1232 bytes) and then as v1 (4096 bytes), a moment apart. A v1 route need not
  // shrink to fit, so the difference is what the larger transaction is worth.
  for (const [input, output, usd] of [
    ['SOL', 'BONK', 50_000], ['SOL', 'BONK', 100_000], ['BONK', 'SOL', 100_000], ['JTO', 'SOL', 50_000], ['JTO', 'SOL', 100_000],
    ['SOL', 'JTO', 100_000], ['USDC', 'JUP', 100_000], ['JUP', 'SOL', 200_000], ['SOL', 'W', 8_000], ['RENDER', 'SOL', 100_000],
    ['TRUMP', 'SOL', 200_000], ['USDT', 'BONK', 100_000], ['SOL', 'WIF', 100_000], ['SOL', 'USDC', 1_000_000], ['USDC', 'SOL', 500_000],
  ] as const) {
    const key = `${input}-${output}-${usd}`;
    cases.push({ group: 'v1-compare', input, output, usd, compare: key, version: 0 }, { group: 'v1-compare', input, output, usd, compare: key, version: 1 });
  }

  // v1 transactions and Jupiter's fast routing, where the deployment offers them.
  cases.push(
    { group: 'modes', input: 'USDC', output: 'SOL', usd: 100, version: 1 },
    { group: 'modes', input: 'SOL', output: 'BONK', usd: 100, version: 1 },
    { group: 'modes', input: 'USDC', output: 'SOL', usd: 100, fast: true },
    { group: 'modes', input: 'WIF', output: 'JUP', usd: 300, fast: true },
  );
  // An agent that brings routes understating their output a hundred times: a sale into SOL or USDC
  // (the fee on the output) is built with Orientim's key; a purchase with SOL (on the input) is not
  // the fee's business, and the agent's own minimum holds it.
  if (OWN_ROUTES && JUPITER_API_KEY) {
    cases.push(
      { group: 'fallback', input: 'USDC', output: 'SOL', usd: 100, understate: 100n },
      { group: 'fallback', input: 'BONK', output: 'SOL', usd: 200, understate: 100n },
      { group: 'fallback', input: 'JUP', output: 'USDC', usd: 500, understate: 100n },
      { group: 'fallback', input: 'SOL', output: 'USDC', usd: 100, understate: 100n },
    );
  }
  // The same swap with the agent's own routes and with Orientim's, a moment apart: the fee on every
  // side and the minimum must be alike (within the market's move and the 1% Orientim allows).
  if (OWN_ROUTES && JUPITER_API_KEY) {
    for (const [input, output, usd] of [
      ['SOL', 'USDC', 1_000], ['USDC', 'SOL', 10_000], ['BONK', 'SOL', 5_000], ['SOL', 'BONK', 5_000], ['JUP', 'USDC', 2_000],
      ['USDC', 'WIF', 1_000], ['WIF', 'JUP', 800], ['JitoSOL', 'SOL', 50_000], ['USDT', 'USDC', 100_000], ['SOL', 'JUP', 20_000],
    ] as const) {
      const key = `${input}-${output}-${usd}`;
      cases.push({ group: 'routes', input, output, usd, routesCompare: key }, { group: 'routes', input, output, usd, routesCompare: key, orientimRoutes: true });
    }
  }
  // Tolerance against size: a major pair, a memecoin bought and sold, from $10 to $50,000, at each
  // tolerance an agent may choose, "auto" included.
  for (const [input, output] of [['SOL', 'USDC'], ['USDC', 'BONK'], ['BONK', 'SOL']] as const) {
    for (const usd of [10, 1_000, 50_000]) {
      for (const slippage of [10, 50, 300, 1_000, 'auto'] as const) cases.push({ group: 'grid', input, output, usd, slippage });
    }
  }
  return cases.filter(c => !GROUPS.length || GROUPS.includes(c.group)).slice(0, LIMIT);
}

// --- the world: mainnet (or the test fakes offline), Jupiter throttled, Orientim's API in this process
type World = {
  rpc: Rpc<SolanaRpcApi>;
  fetchImpl: typeof fetch;
  deps: AgentDeps;
  holderOf(mint: string, need: bigint, needLamports: bigint): Promise<{ owner: string; balance: bigint } | null>;
  priceOf(mint: string): Promise<{ usd: number; decimals: number } | null>;
  pumpTokens(): Promise<{ curve: string[]; amm: string[] }>;
};

let nextJupiterAt = 0;
/** Every request to Jupiter, the agent's and Orientim's, spaced as the key allows; a 429 is asked again twice. */
/** The case each request belongs to, so that Jupiter's answers are kept with it even when cases run at once. */
const caseOf = new AsyncLocalStorage<number>();
/**
 * The server's own events (lib/server/agent/events.ts), by case: whose routes built each swap, the
 * fee's side, and how often Orientim's key was asked for its own price. The server runs in this
 * process, in each case's async context, so its log lines are read here rather than printed.
 */
const serverEvents = new Map<number, { routesFrom?: string; feeSide?: string; referenceAsks: number }>();
{
  const info = console.info.bind(console);
  console.info = (...args: unknown[]) => {
    const line = args[0];
    if (args.length === 1 && typeof line === 'string' && line.startsWith('{"event":"orientim.')) {
      const n = caseOf.getStore() ?? 0;
      const seen = serverEvents.get(n) ?? { referenceAsks: 0 };
      try {
        const e = JSON.parse(line) as { event: string; routes?: string; feeSide?: string };
        // The agent's swap comes first; the same case run as a bot after it does not replace it.
        if (e.event === 'orientim.prepared' && !seen.routesFrom) Object.assign(seen, { routesFrom: e.routes, feeSide: e.feeSide });
        if (e.event === 'orientim.reference_price') seen.referenceAsks++;
      } catch {
        // Not an event after all: printed below.
      }
      serverEvents.set(n, seen);
      return;
    }
    info(...args);
  };
}
/** Every answer from Jupiter that was not a success, by case: status, endpoint and body, for the report. */
const jupiterAnswers = new Map<number, string[]>();

async function jupiterFetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
  for (let attempt = 0; ; attempt++) {
    const now = Date.now();
    const at = Math.max(now, nextJupiterAt);
    nextJupiterAt = at + JUPITER_INTERVAL_MS;
    if (at > now) await sleep(at - now);
    const res = await fetch(input, init);
    if (!res.ok) {
      const n = caseOf.getStore() ?? 0;
      const url = new URL(String(input instanceof Request ? input.url : input));
      const body = await res.clone().text().catch(() => '(unreadable)');
      const note = `${res.status} ${url.pathname} slippage=${url.searchParams.get('slippageBps') ?? '-'} amount=${url.searchParams.get('amount') ?? '-'}: ${body.replace(/\s+/g, ' ').slice(0, 300)}`;
      jupiterAnswers.set(n, [...(jupiterAnswers.get(n) ?? []), note]);
      console.log(`    jupiter #${n}: ${note}`);
    }
    if (res.status !== 429 || attempt >= 2) return res;
    await sleep(2_000 * 2 ** attempt);
  }
}

async function mainnet(): Promise<World> {
  const serverRpc = createRetryingRpc(RPC_URL, 8);
  const rpc = createRetryingRpc(RPC_URL, 8) as unknown as Rpc<SolanaRpcApi>;
  const jupiter = createJupiterClient({
    buildUrl: 'https://api.jup.ag/swap/v2/build', tokensUrl: 'https://api.jup.ag/tokens/v2/search',
    labelsUrl: 'https://api.jup.ag/swap/v2/program-id-to-label', apiKey: JUPITER_API_KEY, fetchImpl: jupiterFetch, timeoutMs: 20_000,
  });
  const deps: AgentDeps = {
    rpc: serverRpc, jupiter, ...(/helius/i.test(RPC_URL) ? { priorityFee: heliusPriorityFee(RPC_URL) } : {}),
    secrets: [randomBytes(32)], keys: new Map([[createHash('sha256').update(API_KEY).digest('hex'), 'sim']]),
    // As production: 0.25% to Orientim's own treasury, HumidiFi excluded, the default network fee cap.
    feeBps: 25n, treasury: address(ORIENTIM_TREASURY), excludeDexes: ['HumidiFi'], maxNetworkFeeLamports: 500_000n,
    disabled: false, v1: true, fastRouting: true, perMinute: 1_000_000, minFee: MIN_FEE, ownRoutes: OWN_ROUTES,
  };
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    if (String(url).startsWith('https://api.jup.ag/')) return jupiterFetch(url, init);
    if (String(url).startsWith(`${API_URL}/api/v1/prepare`)) return agentPrepare(new Request(url, init), deps);
    return fetch(url, init);
  }) as unknown as typeof fetch;

  const holders = new Map<string, { owner: string; balance: bigint; lamports: bigint }[]>();
  const programOf = new Map<string, Address>();
  const tokenProgram = async (mint: string) => {
    if (!programOf.has(mint)) programOf.set(mint, (await rpc.getAccountInfo(address(mint), { encoding: 'base64' }).send()).value!.owner as Address);
    return programOf.get(mint)!;
  };
  /** Wallets holding `mint` in their own associated account, with SOL to pay for the swap. */
  async function holdersOf(mint: string) {
    if (holders.has(mint)) return holders.get(mint)!;
    const candidates = new Set<string>(KNOWN_HOLDERS);
    if (mint !== WSOL_MINT) {
      try {
        const largest = await rpc.getTokenLargestAccounts(address(mint)).send();
        const infos = await rpc.getMultipleAccounts(largest.value.slice(0, 20).map(a => a.address), { encoding: 'jsonParsed' }).send();
        for (const info of infos.value) {
          const owner = (info?.data as { parsed?: { info?: { owner?: string } } } | undefined)?.parsed?.info?.owner;
          if (owner) candidates.add(owner);
        }
      } catch { /* the known wallets only */ }
    }
    const program = mint === WSOL_MINT ? null : await tokenProgram(mint);
    const found: { owner: string; balance: bigint; lamports: bigint }[] = [];
    for (const owner of candidates) {
      try {
        const wallet = await rpc.getAccountInfo(address(owner), { encoding: 'base64' }).send();
        // A wallet pays the network fee: a system account, not a program's.
        if (!wallet.value || wallet.value.owner !== '11111111111111111111111111111111') continue;
        const lamports = BigInt(wallet.value.lamports);
        let balance = lamports;
        if (program) {
          const ata = await ataOf(address(owner), address(mint), program);
          const acc = await rpc.getTokenAccountBalance(ata).send().catch(() => null);
          balance = acc ? BigInt(acc.value.amount) : 0n;
        }
        if (balance > 0n) found.push({ owner, balance, lamports });
      } catch { /* not a wallet */ }
    }
    found.sort((a, b) => (b.balance > a.balance ? 1 : -1));
    holders.set(mint, found);
    return found;
  }
  const prices = new Map<string, { usd: number; decimals: number } | null>();
  return {
    rpc, fetchImpl, deps,
    async holderOf(mint, need, needLamports) {
      return (await holdersOf(mint)).find(h => h.balance >= need && h.lamports >= needLamports + (mint === WSOL_MINT ? need : 0n)) ?? null;
    },
    async priceOf(mint) {
      if (!prices.has(mint)) {
        const r = await jupiterFetch(`https://api.jup.ag/tokens/v2/search?query=${mint}`, { headers: JUPITER_API_KEY ? { 'x-api-key': JUPITER_API_KEY } : {} });
        const list = r.ok ? await r.json() as { id: string; usdPrice?: number; decimals: number }[] : [];
        const t = Array.isArray(list) ? list.find(x => x.id === mint) : undefined;
        prices.set(mint, t && typeof t.usdPrice === 'number' && t.usdPrice > 0 ? { usd: t.usdPrice, decimals: t.decimals } : null);
      }
      return prices.get(mint)!;
    },
    async pumpTokens() {
      const list = async (url: string) => {
        const r = await jupiterFetch(url, { headers: JUPITER_API_KEY ? { 'x-api-key': JUPITER_API_KEY } : {} });
        const body = r.ok ? await r.json() as unknown : [];
        return Array.isArray(body) ? body.map(x => (x as { id?: string }).id).filter((id): id is string => typeof id === 'string' && id.endsWith('pump')) : [];
      };
      return {
        curve: (await list('https://api.jup.ag/tokens/v2/recent')).slice(0, 3),
        amm: (await list('https://api.jup.ag/tokens/v2/toptrending/1h?limit=100')).slice(0, 3),
      };
    },
  };
}

/** The test fakes: a funded wallet, an honest market, no network. Checks the matrix itself. */
async function offline(): Promise<World> {
  const { generateKeyPairSigner } = await import('@solana/kit');
  const fakes = await import('../../packages/jupiter/test/fakes.ts');
  const wallet = await generateKeyPairSigner();
  const accounts = new Map<string, import('../../packages/jupiter/test/fakes.ts').Account>([
    [fakes.USDC, fakes.mint(6)], [WSOL_MINT, fakes.mint(9)], [fakes.BONK, fakes.mint(5)],
    [fakes.DEX, { owner: address('BPFLoaderUpgradeab1e11111111111111111111111'), data: new Uint8Array(36) }],
    [fakes.POOL, { owner: fakes.DEX, data: new Uint8Array(300) }],
    [await ataOf(address(ORIENTIM_TREASURY), fakes.USDC), fakes.tokenAccount(address(ORIENTIM_TREASURY), fakes.USDC)],
    ...await fakes.fundedAccounts(wallet.address, fakes.USDC),
  ]);
  const rpc = fakes.fakeRpc(accounts, {});
  const jupiter = fakes.fakeJupiter();
  const deps: AgentDeps = {
    rpc, jupiter, secrets: [randomBytes(32)], keys: new Map([[createHash('sha256').update(API_KEY).digest('hex'), 'sim']]),
    feeBps: 25n, treasury: address(ORIENTIM_TREASURY), excludeDexes: [], maxNetworkFeeLamports: 200_000n, disabled: false, v1: true, perMinute: 1_000_000, ownRoutes: true,
  };
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    if (String(url).startsWith('https://api.jup.ag/')) {
      const q = new URL(url).searchParams;
      // As Jupiter does, for the agent's own price and for the routes it fetches for Orientim.
      const r = await jupiter.build({
        inputMint: address(q.get('inputMint')!), outputMint: address(q.get('outputMint')!), amount: BigInt(q.get('amount')!),
        taker: address(q.get('taker')!), slippageBps: Number(q.get('slippageBps')) || 50, maxAccounts: Number(q.get('maxAccounts')) || 64,
        ...(q.get('destinationTokenAccount') ? { destinationTokenAccount: address(q.get('destinationTokenAccount')!) } : {}),
        ...(q.get('excludeDexes') ? { excludeDexes: q.get('excludeDexes')!.split(',') } : {}),
      });
      return Response.json({ ...r, priceImpactPct: 0 });
    }
    return agentPrepare(new Request(url, init), deps);
  }) as unknown as typeof fetch;
  const agentRpc = { ...rpc, getBlockHeight: () => ({ send: async () => 850n }) } as unknown as Rpc<SolanaRpcApi>;
  symbols.set(fakes.BONK, 'BONK');
  (T as Record<string, string>).BONK = fakes.BONK;
  return {
    rpc: agentRpc, fetchImpl, deps,
    async holderOf(mint) { return mint === fakes.USDC ? { owner: wallet.address, balance: 1_000_000_000n } : null; },
    async priceOf(mint) { return mint === fakes.USDC ? { usd: 1, decimals: 6 } : mint === WSOL_MINT ? { usd: 150, decimals: 9 } : { usd: 0.00002, decimals: 5 }; },
    async pumpTokens() { return { curve: [], amm: [] }; },
  };
}

// --- one case
type Result = {
  n: number; group: string; pair: string; usd: string; rule: string; asked: string; built: string;
  kind: 'PASS' | 'REFUSED' | 'UNTESTED' | 'BUG'; code: string; detail: string;
  route: string; impact: string; fee: string; floor: string; ms: number; bot?: string;
  /** Jupiter's answers that were not a success during this case. */
  jupiter?: string[];
  /** For the analysis: the amount in USD, the price impact and the floor in bps, a costlier route's gap. */
  usdValue?: number; impactBps?: number | null; floorBps?: number; gapBps?: number;
  /** Rules held on a pass, checked here apart from the skill (fee payer, signers, size, fee, impact, tolerance). */
  invariants?: number;
  /** Each change made to a passed transaction, and whether the check refused it. */
  tampered?: { name: string; verdict: 'caught' | 'missed' | 'untested'; why: string }[];
  /** What the owner approved before the swap passed: a gap, or a new minimum. */
  approved?: string;
  /** The protected route's quoted output (passed, or refused as costing more), and the v0/v1 pair it belongs to. */
  outAmount?: string; compare?: string; version?: number;
  /** The own-routes pair it belongs to, which routes it used, and the minimum and fee it was built with. */
  routesCompare?: string; orientimRoutes?: boolean; minOutRaw?: string; feeRaw?: string;
  /** From the server's own events: whose routes built the swap, the fee's side, and the asks of its key for its own price. */
  routesFrom?: string; feeSide?: string; referenceAsks?: number;
};

const ABOVE_CEILING = /above the owner's limit of \d+ \(maxSlippageBps\)/;
const UNAVAILABLE = /Jupiter answered (429|5\d\d)|fetch failed|timed out|TimeoutError|AbortError|ECONNRESET|socket hang up|did not answer|could not be read from your RPC|could not be simulated on your RPC/i;

/** An error, as one outcome: an honest refusal, a service that was not there, or something to look at. */
function classify(e: unknown): Pick<Result, 'kind' | 'code' | 'detail'> {
  const message = e instanceof Error ? e.message : String(e);
  if (e instanceof PolicyError) return { kind: 'REFUSED', code: e.code, detail: message.slice(0, 160) };
  if (e instanceof PriceImpactError) return { kind: 'REFUSED', code: 'price-impact-high', detail: `impact ${(e.impactBps / 100).toFixed(2)}%, limit ${(e.limitBps / 100).toFixed(2)}%` };
  if (e instanceof FloorError) return { kind: 'REFUSED', code: 'floor-too-low', detail: `lowest accepted ${e.lowest}` };
  if (e instanceof IntentError) return { kind: 'BUG', code: 'intent', detail: `the matrix built an intent the skill refuses: ${message.slice(0, 200)}` };
  if (e instanceof OrientimApiError) {
    if (['busy', 'unavailable', 'rate-limited'].includes(e.code)) return { kind: 'UNTESTED', code: e.code, detail: e.serverMessage };
    if (['internal', 'verification-failed', 'route-format', 'wallet-changed-transaction', 'bad-request', 'invalid-ticket', 'unauthorized'].includes(e.code)) {
      return { kind: 'BUG', code: e.code, detail: e.serverMessage };
    }
    const extra = e.code === 'costs-more' ? ` (gap ${String(e.body.gapBps)} bps)` : e.code === 'price-moved' ? ` (new minimum ${String(e.body.newMinOut)})` : '';
    return { kind: 'REFUSED', code: e.code, detail: `${e.serverMessage}${extra}`.slice(0, 200) };
  }
  if (message.startsWith('Not signing: ')) {
    if (ABOVE_CEILING.test(message)) return { kind: 'REFUSED', code: 'route-above-ceiling', detail: message.slice(13, 200) };
    // The price moved between Orientim's build and the check's own simulation (Jupiter's 6001).
    if (/fails in simulation/.test(message) && /6001|"Custom":6001/.test(message)) return { kind: 'UNTESTED', code: 'price-moved-in-check', detail: message.slice(13, 200) };
    // Orientim's own simulation passed, and the check's failed twice, 1.2 s apart: the market changed
    // between them (a market whose maker sets its price each slot). The route would fail on chain
    // too; the program and its code are kept, so that a program failing in every run shows.
    if (/fails in simulation on your RPC, twice/.test(message)) return { kind: 'UNTESTED', code: 'route-failed-in-check', detail: message.slice(13, 300) };
    if (UNAVAILABLE.test(message)) return { kind: 'UNTESTED', code: 'rpc', detail: message.slice(13, 200) };
    // Orientim's own honest answer, refused by the skill's check: the two disagree.
    return { kind: 'BUG', code: 'check-refused-honest-answer', detail: message.slice(13, 400) };
  }
  // The preparation spent its time or its asks of Jupiter (the test key is shared by every case):
  // nothing was signed, and nothing was proven.
  if (e instanceof Error && e.name === 'BudgetSpentError') return { kind: 'UNTESTED', code: 'budget-spent', detail: message.slice(0, 200) };
  // Jupiter still busy after the skill asked it again, or a refusal of its own with its code.
  if (/^Jupiter answered 400 \(busy\)/.test(message)) return { kind: 'UNTESTED', code: 'jupiter-busy', detail: message.slice(0, 200) };
  const jupiterCode = /^Jupiter answered 4\d\d \(([A-Za-z0-9_]+)\)/.exec(message)?.[1];
  if (jupiterCode) return { kind: 'REFUSED', code: `jupiter-${jupiterCode.toLowerCase()}`, detail: message.slice(0, 200) };
  if (UNAVAILABLE.test(message) || /\b429\b/.test(message)) return { kind: 'UNTESTED', code: 'service', detail: message.slice(0, 200) };
  if (/without a price impact/.test(message)) return { kind: 'REFUSED', code: 'impact-unknown', detail: message.slice(0, 160) };
  return { kind: 'BUG', code: 'error', detail: message.slice(0, 400) };
}

/**
 * A compiled message of either version, with its instructions in one shape: v0 lists them as
 * instructions; v1 as headers and payloads, with the compute budget in its config instead of
 * ComputeBudget instructions.
 */
type Ix = { programAddressIndex: number; accountIndices?: number[]; data?: Uint8Array };
type Compiled = {
  version: number | 'legacy'; header: { numSignerAccounts: number; numReadonlySignerAccounts: number; numReadonlyNonSignerAccounts: number };
  staticAccounts: string[]; lifetimeToken: string;
  instructions: Ix[];
  addressTableLookups?: unknown[];
  configValues?: { kind: string; value: number | bigint }[];
};
type RawV1 = {
  instructionHeaders: { programAccountIndex: number; numInstructionAccounts: number; numInstructionDataBytes: number }[];
  instructionPayloads: { instructionAccountIndices: number[]; instructionData: Uint8Array }[];
};

function decodeMessage(messageBytes: Uint8Array): Compiled {
  const raw = getCompiledTransactionMessageDecoder().decode(messageBytes as never) as unknown as Compiled & Partial<RawV1>;
  if (raw.version !== 1) return raw;
  const instructions = (raw.instructionHeaders ?? []).map((h, i) => ({
    programAddressIndex: h.programAccountIndex,
    accountIndices: [...(raw.instructionPayloads?.[i]?.instructionAccountIndices ?? [])],
    data: Uint8Array.from(raw.instructionPayloads?.[i]?.instructionData ?? []),
  }));
  return { ...raw, instructions };
}

function encodeMessage(m: Compiled): Uint8Array {
  if (m.version !== 1) return getCompiledTransactionMessageEncoder().encode(m as never) as Uint8Array;
  const { instructions, ...rest } = m;
  const v1 = {
    ...rest,
    numStaticAccounts: m.staticAccounts.length,
    numInstructions: instructions.length,
    instructionHeaders: instructions.map(i => ({ programAccountIndex: i.programAddressIndex, numInstructionAccounts: i.accountIndices?.length ?? 0, numInstructionDataBytes: i.data?.length ?? 0 })),
    instructionPayloads: instructions.map(i => ({ instructionAccountIndices: i.accountIndices ?? [], instructionData: i.data ?? new Uint8Array() })),
  };
  return getCompiledTransactionMessageEncoder().encode(v1 as never) as Uint8Array;
}

/** The tolerance the Jupiter route in the built transaction carries, in bps (v0 or v1). */
function builtTolerance(wire: string): number | null {
  try {
    const compiled = decodeMessage(getTransactionDecoder().decode(Buffer.from(wire, 'base64')).messageBytes as unknown as Uint8Array);
    const ix = compiled.instructions.find(i => compiled.staticAccounts[i.programAddressIndex] === JUPITER_PROGRAM);
    return ix?.data ? jupiterRouteArgs(ix.data)?.slippageBps ?? null : null;
  } catch {
    return null;
  }
}

// --- a dishonest server, on real transactions
const SYSTEM = '11111111111111111111111111111111';
const COMPUTE_BUDGET = 'ComputeBudget111111111111111111111111111111';
const randomAddress = () => getAddressDecoder().decode(randomBytes(32));

/**
 * The changes a dishonest server could make to a transaction it built, v0 or v1, each as a new wire
 * transaction, or null where it does not apply (no such instruction).
 */
function tamperings(wire: string, owner: string): { name: string; wire: string | null }[] {
  const tx = getTransactionDecoder().decode(Buffer.from(wire, 'base64'));
  let base: Compiled;
  try {
    base = decodeMessage(tx.messageBytes as unknown as Uint8Array);
  } catch {
    return [];
  }
  const clone = (): Compiled => ({
    ...base, header: { ...base.header }, staticAccounts: [...base.staticAccounts],
    instructions: base.instructions.map(i => ({ ...i, accountIndices: i.accountIndices ? [...i.accountIndices] : undefined, data: i.data ? Uint8Array.from(i.data) : undefined })),
    ...(base.configValues ? { configValues: base.configValues.map(v => ({ ...v })) } : {}),
  });
  const encode = (m: Compiled): string => {
    const messageBytes = encodeMessage(m);
    const signatures = Object.fromEntries(m.staticAccounts.slice(0, m.header.numSignerAccounts).map(a => [a, null]));
    return Buffer.from(getTransactionEncoder().encode({ messageBytes, signatures } as never)).toString('base64');
  };
  const jupiterIx = (m: Compiled) => m.instructions.find(i => m.staticAccounts[i.programAddressIndex] === JUPITER_PROGRAM && i.data && jupiterRouteArgs(i.data));
  const out: { name: string; wire: string | null }[] = [];
  const change = (name: string, f: (m: Compiled) => boolean) => {
    const m = clone();
    out.push({ name, wire: f(m) ? encode(m) : null });
  };
  change('route tolerance raised to 90%', m => {
    const ix = jupiterIx(m);
    const args = ix?.data && jupiterRouteArgs(ix.data);
    if (!ix?.data || !args) return false;
    new DataView(ix.data.buffer, ix.data.byteOffset).setUint16(args.slippageOffset, 9_000, true);
    return true;
  });
  change('quote halved (a lower floor)', m => {
    const ix = jupiterIx(m);
    const args = ix?.data && jupiterRouteArgs(ix.data);
    if (!ix?.data || !args) return false;
    new DataView(ix.data.buffer, ix.data.byteOffset).setBigUint64(args.slippageOffset - 8, args.quotedOutAmount / 2n, true);
    return true;
  });
  change('amount in doubled', m => {
    const ix = jupiterIx(m);
    const args = ix?.data && jupiterRouteArgs(ix.data);
    if (!ix?.data || !args) return false;
    new DataView(ix.data.buffer, ix.data.byteOffset).setBigUint64(args.slippageOffset - 16, args.inAmount * 2n, true);
    return true;
  });
  change('fee payer replaced', m => {
    if (m.staticAccounts[0] !== owner) return false;
    m.staticAccounts[0] = randomAddress();
    return true;
  });
  change('0.01 SOL from the wallet to the one-time key', m => {
    const system = m.staticAccounts.indexOf(SYSTEM);
    if (system < 0 || m.header.numSignerAccounts < 2) return false;
    const data = new Uint8Array(12);
    new DataView(data.buffer).setUint32(0, 2, true);
    new DataView(data.buffer).setBigUint64(4, 10_000_000n, true);
    m.instructions.push({ programAddressIndex: system, accountIndices: [0, 1], data });
    return true;
  });
  change('network fee raised a million times', m => {
    // v1: the priority fee is the message's config value in lamports (its only u64).
    const fee = m.configValues?.find(v => v.kind === 'u64');
    if (m.version === 1) {
      if (!fee) return false;
      fee.value = (BigInt(fee.value) + 1n) * 1_000_000n;
      return true;
    }
    const ix = m.instructions.find(i => m.staticAccounts[i.programAddressIndex] === COMPUTE_BUDGET && i.data?.[0] === 3);
    if (!ix?.data) return false;
    const v = new DataView(ix.data.buffer, ix.data.byteOffset);
    v.setBigUint64(1, (v.getBigUint64(1, true) + 1n) * 1_000_000n, true);
    return true;
  });
  change('output sent to another account', m => {
    const ix = jupiterIx(m);
    if (!ix?.data || !ix.accountIndices) return false;
    const accounts = ix.accountIndices.map(k => m.staticAccounts[k] ?? '');
    const dest = jupiterDestination(ix.data, accounts as never);
    const at = dest ? m.staticAccounts.indexOf(dest) : -1;
    if (at < m.header.numSignerAccounts) return false;
    m.staticAccounts[at] = randomAddress();
    return true;
  });
  change('the route handed to another program', m => {
    const ix = jupiterIx(m);
    const system = m.staticAccounts.indexOf(SYSTEM);
    if (!ix || system < 0) return false;
    ix.programAddressIndex = system;
    return true;
  });
  return out;
}

/** Each tampering of a passed swap, put to the skill's check: every one must be refused. */
async function tamperWith(w: World, checked: Checked, owner: string, ceiling: number | undefined): Promise<NonNullable<Result['tampered']>> {
  const results: NonNullable<Result['tampered']> = [];
  for (const t of tamperings(checked.prepared.transaction, owner)) {
    if (!t.wire) continue;
    // A dishonest server states the hash of what it changed: the check must find the change itself.
    const digest = createHash('sha256').update(getTransactionDecoder().decode(Buffer.from(t.wire, 'base64')).messageBytes as unknown as Uint8Array).digest('hex');
    const prepared: Prepared = {
      ...checked.prepared, transaction: t.wire, messageSha256: digest,
      certificate: { ...checked.prepared.certificate, messageSha256: digest },
    };
    try {
      const problems = await checkPrepared(prepared, checked.intent, w.rpc, { requestTimeoutMs: 30_000, ...(ceiling !== undefined ? { slippageCeilingBps: ceiling } : {}) });
      results.push(problems.length
        ? { name: t.name, verdict: 'caught', why: problems.join('; ').slice(0, 200) }
        : { name: t.name, verdict: 'missed', why: 'the check found nothing to refuse' });
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      results.push({ name: t.name, verdict: UNAVAILABLE.test(message) ? 'untested' : 'caught', why: message.slice(0, 140) });
    }
  }
  return results;
}

/** How many rules `invariantsBroken` checks on each pass. */
const INVARIANTS = 9;

/**
 * The rules a passed swap must hold, read here from the answer and its bytes apart from the skill's
 * check: a second reading, so that a pass is not only the check's word. Returns those broken.
 */
function invariantsBroken(p: Prepared, owner: string, intent: Omit<Intent, 'owner'>, policy: OwnerPolicy | undefined): string[] {
  const broken: string[] = [];
  const wire = Buffer.from(p.transaction, 'base64');
  const tx = getTransactionDecoder().decode(wire);
  const signers = Object.keys(tx.signatures);
  // 1-2: the wallet pays and signs, and the one-time key is the only other signer.
  if (signers[0] !== owner) broken.push(`fee payer ${signers[0]}, not the wallet`);
  if (signers.length !== 2 || signers[1] !== p.temporaryAuthority || p.temporaryAuthority === owner) broken.push(`signers ${signers.join(', ')}`);
  // 3: the transaction fits its version's limit: 1232 bytes for v0, 4096 for v1.
  let version: number | 'legacy' | null = null;
  try { version = decodeMessage(tx.messageBytes as unknown as Uint8Array).version; } catch { /* unreadable: checked below */ }
  const sizeLimit = version === 1 ? 4_096 : 1_232;
  if (version === null) broken.push('a message this matrix cannot read');
  else if (wire.length > sizeLimit) broken.push(`${wire.length} bytes, over ${sizeLimit} (v${version})`);
  // 4: Orientim's fee is its pinned 0.25% at most.
  if (Number(p.amounts.feeBps) > 25) broken.push(`fee ${p.amounts.feeBps} bps`);
  // 5: the price impact within the limit asked (5% unless the owner or agent set another).
  const limit = intent.maxPriceImpactBps ?? Math.min(500, policy?.maxPriceImpactBps ?? 500);
  if (typeof p.amounts.priceImpactPct === 'number' && p.amounts.priceImpactPct * 10_000 > limit + 0.5) broken.push(`impact ${(p.amounts.priceImpactPct * 100).toFixed(2)}% over ${limit / 100}%`);
  // 6: a minimum above zero and under the quote.
  if (!(BigInt(p.amounts.minOut) > 0n && BigInt(p.amounts.minOut) <= BigInt(p.amounts.quotedOut))) broken.push(`minOut ${p.amounts.minOut} against quote ${p.amounts.quotedOut}`);
  // 7: the amount asked, exactly.
  if (p.amounts.amountIn !== intent.amountIn) broken.push(`amount in ${p.amounts.amountIn}, asked ${intent.amountIn}`);
  // 8: the answer names this wallet, in the answer and in its certificate.
  if (p.wallet !== owner || p.certificate.wallet !== owner) broken.push('another wallet named');
  // 9: a lifetime of at most 150 blocks (and one for the height read a moment apart), not yet over.
  // The test fakes' chain has no such bound.
  if (p.blocksLeft !== undefined && !(Number(p.blocksLeft) > 0 && (OFFLINE || Number(p.blocksLeft) <= 151))) broken.push(`${p.blocksLeft} blocks left`);
  return broken;
}

async function runCase(w: World, c: Case, n: number): Promise<Result> {
  serverEvents.delete(n);
  const withEvents = (r: Result): Result => {
    const ev = serverEvents.get(n);
    const seen: Result = { ...r, ...(ev?.routesFrom ? { routesFrom: ev.routesFrom } : {}), ...(ev?.feeSide ? { feeSide: ev.feeSide } : {}), referenceAsks: ev?.referenceAsks ?? 0 };
    // Understated routes behind a fee on the output must never be used.
    if (c.understate && seen.kind === 'PASS' && seen.feeSide === 'output' && seen.routesFrom !== 'orientim-fallback') {
      return { ...seen, kind: 'BUG', code: 'understated-routes-used', detail: `routes ${String(c.understate)} times below the market built the swap (${seen.routesFrom ?? 'unknown'})` };
    }
    return seen;
  };
  const input = (T as Record<string, string>)[c.input] ?? c.input;
  const output = (T as Record<string, string>)[c.output] ?? c.output;
  const base: Result = {
    n, group: c.group, pair: `${nameOf(input)} → ${nameOf(output)}`, usd: c.share ? `${c.share * 100}% of a holder` : `$${c.usd.toLocaleString('en-US')}`,
    rule: c.rule?.label ?? '', asked: c.slippage === undefined ? 'default' : String(c.slippage), built: '',
    kind: 'UNTESTED', code: '', detail: '', route: '', impact: '', fee: '', floor: '', ms: 0,
    ...(c.compare ? { compare: c.compare, version: c.version ?? DEFAULT_VERSION } : {}),
    ...(c.routesCompare ? { routesCompare: c.routesCompare, orientimRoutes: !!c.orientimRoutes } : {}),
  };
  const started = Date.now();
  try {
    // The amount, in the input's base units, and a public wallet that holds it.
    const price = await w.priceOf(input);
    let amount: bigint;
    let holder: { owner: string; balance: bigint } | null;
    if (c.share) {
      holder = await w.holderOf(input, 1n, 20_000_000n);
      amount = holder ? BigInt(Math.floor(Number(holder.balance) * c.share)) : 0n;
    } else {
      if (!price) return { ...base, kind: 'UNTESTED', code: 'no-price', detail: 'Jupiter gives no USD price for the input', ms: Date.now() - started };
      amount = BigInt(Math.round((c.usd / price.usd) * 10 ** price.decimals));
      // An exchange's wallet: SOL for the network fee, new accounts' rent and a fee paid in SOL.
      holder = await w.holderOf(input, amount, 1_000_000_000n);
    }
    if (!holder || amount <= 0n) return { ...base, kind: 'UNTESTED', code: 'no-holder', detail: 'no public wallet found holding enough of the input, with SOL for fees', ms: Date.now() - started };
    const owner = holder.owner;
    const policy: OwnerPolicy | undefined = c.rule?.policy
      ? { maxAmountIn: c.rule.policy.maxAmountIn ?? { [input]: '100000000000000000000' }, ...c.rule.policy } as OwnerPolicy
      : undefined;
    let minOut: string | undefined;
    if (c.minOutOfQuote !== undefined) {
      // Jupiter's own quote for the amount, then the minimum the agent asks relative to it.
      const q = await w.fetchImpl(`https://api.jup.ag/swap/v2/build?${new URLSearchParams({
        inputMint: input, outputMint: output, amount: amount.toString(), taker: owner, slippageBps: '50', maxAccounts: '64',
      })}`, { headers: JUPITER_API_KEY ? { 'x-api-key': JUPITER_API_KEY } : {} });
      const out = q.ok ? (await q.json() as { outAmount?: string }).outAmount : undefined;
      if (!out) return { ...base, kind: 'UNTESTED', code: 'no-quote', detail: 'Jupiter gave no quote to set the minimum from', ms: Date.now() - started };
      minOut = BigInt(Math.floor(Number(out) * c.minOutOfQuote)).toString();
    }
    const intent: Omit<Intent, 'owner'> = {
      inputMint: input, outputMint: output, amountIn: amount.toString(), ...(minOut ? { minOut } : {}),
      ...(c.slippage !== undefined ? { slippageBps: c.slippage } : {}),
      ...((c.version ?? DEFAULT_VERSION) === 1 ? { version: 1 as const } : {}), ...(c.fast ? { routingMode: 'fast' as const } : {}),
      ...(c.rule?.intent ?? {}),
    };
    // As protectedSwap does: the owner's per-swap limits first, then prepare and the full check.
    let outcome: Result;
    try {
      if (policy) await checkPolicy(policy, { owner, inputMint: input, outputMint: output, amountIn: intent.amountIn });
      const fetchImpl = c.understate ? understating(w.fetchImpl, owner, c.understate) : w.fetchImpl;
      const prepare = (asked: Omit<Intent, 'owner'>) => prepareChecked({
        apiUrl: API_URL, apiKey: API_KEY, rpc: w.rpc, owner, intent: asked, fetchImpl, jupiterApiKey: JUPITER_API_KEY,
        requestTimeoutMs: 30_000, ownRoutes: OWN_ROUTES && !c.orientimRoutes, ...(policy ? { policy } : {}),
      });
      let approved: string | undefined;
      let checked: Checked;
      try {
        checked = await prepare(intent);
      } catch (e) {
        // The owner approves, as the skill tells the agent to ask: the gap, or the new minimum.
        if (!c.approve || !(e instanceof OrientimApiError) || !['costs-more', 'price-moved'].includes(e.code)) throw e;
        if (e.code === 'costs-more') {
          approved = `a route ${String(e.body.gapBps)} bps costlier`;
          checked = await prepare({ ...intent, acceptCostBps: String(e.body.gapBps) });
        } else {
          approved = `a new minimum ${String(e.body.newMinOut)}`;
          checked = await prepare({ ...intent, minOut: String(e.body.newMinOut) });
        }
      }
      const p = checked.prepared;
      // A v1 message is not read by the v0 decoder here: the answer states it then (the check held it).
      const built = builtTolerance(p.transaction) ?? (typeof p.slippageBps === 'number' ? p.slippageBps : null);
      const quoted = BigInt(p.amounts.quotedOut);
      const floorBps = quoted > 0n ? Number(((quoted - BigInt(p.amounts.minOut)) * 10_000n) / quoted) : 0;
      outcome = {
        ...base, kind: 'PASS', code: 'ok', built: built === null ? '?' : String(built),
        route: Array.isArray((p as { route?: unknown }).route) ? ((p as { route?: string[] }).route ?? []).join(' > ') : '',
        impact: typeof p.amounts.priceImpactPct === 'number' ? `${(p.amounts.priceImpactPct * 100).toFixed(2)}%` : 'unknown',
        fee: `${p.amounts.fee} ${p.amounts.feeMint ? nameOf(p.amounts.feeMint) : ''}`.trim(),
        floor: `${(floorBps / 100).toFixed(2)}% under quote`,
        detail: (checked.notices ?? []).join(' ').slice(0, 160),
      };
      outcome.usdValue = c.usd || undefined;
      outcome.outAmount = p.amounts.quotedOut;
      outcome.minOutRaw = p.amounts.minOut;
      outcome.feeRaw = p.amounts.fee;
      outcome.impactBps = typeof p.amounts.priceImpactPct === 'number' ? Math.round(p.amounts.priceImpactPct * 10_000) : null;
      outcome.floorBps = floorBps;
      if (approved) outcome.approved = approved;
      // Rules every pass must hold, checked here from the bytes apart from the skill's own check.
      const broken = invariantsBroken(p, owner, intent, policy);
      outcome.invariants = INVARIANTS;
      if (broken.length) outcome = { ...outcome, kind: 'BUG', code: 'invariant', detail: broken.join('; ') };
      // What a pass must hold: never looser than the owner's ceiling or the tolerance asked.
      const ceiling = policy?.maxSlippageBps;
      if (built !== null && ceiling !== undefined && built > ceiling) outcome = { ...outcome, kind: 'BUG', code: 'above-ceiling', detail: `built at ${built} bps, owner's ceiling ${ceiling}` };
      if (built !== null && typeof c.slippage === 'number' && built > c.slippage) outcome = { ...outcome, kind: 'BUG', code: 'above-asked', detail: `built at ${built} bps, asked ${c.slippage}` };
      if (c.tamper && outcome.kind === 'PASS') {
        const tampered = await tamperWith(w, checked, owner, ceiling);
        outcome.tampered = tampered;
        const missed = tampered.filter(t => t.verdict === 'missed');
        const untried = tampered.filter(t => t.verdict === 'untested');
        if (missed.length) outcome = { ...outcome, kind: 'BUG', code: 'tamper-missed', detail: missed.map(t => t.name).join('; ') };
        // A change the check could not be asked about proves nothing: the case is not a pass.
        else if (untried.length) outcome = { ...outcome, kind: 'UNTESTED', code: 'tamper-incomplete', detail: `not tested: ${untried.map(t => t.name).join('; ')}` };
        else outcome.detail = `${tampered.filter(t => t.verdict === 'caught').length} of ${tampered.length} changes refused ${outcome.detail}`.trim();
      }
    } catch (e) {
      outcome = { ...base, ...classify(e) };
      if (e instanceof OrientimApiError && e.code === 'costs-more') {
        outcome.gapBps = Number(e.body.gapBps);
        outcome.outAmount = String(e.body.outAmount);
      }
      if (c.usd) outcome.usdValue = c.usd;
    }
    // The same case as a bot: orientim-verify prepare, with the same policy.
    if (c.bot) {
      const deps = {
        rpc: w.rpc, apiUrl: API_URL, apiKey: API_KEY, fetchImpl: w.fetchImpl, jupiterApiKey: JUPITER_API_KEY,
        stateDir: mkdtempSync(join(tmpdir(), 'orientim-sim-bot-')), requestTimeoutMs: 30_000, ownRoutes: OWN_ROUTES, ...(policy ? { policy } : {}),
      };
      const r = await runCli('prepare', { intent: { owner, id: `sim-${n}`, ...intent } }, deps);
      const out = JSON.parse(JSON.stringify(r.output)) as { error?: { code?: string; message?: string }; problems?: string[] };
      const jupiterCode = out.problems?.map(x => /^Jupiter answered 4\d\d \(([A-Za-z0-9_]+)\)/.exec(x)?.[1]).find(Boolean);
      const bot = r.code === 0 ? 'PASS'
        : out.problems?.some(x => ABOVE_CEILING.test(x)) ? 'route-above-ceiling'
          : jupiterCode && out.error?.code !== 'unavailable' ? `jupiter-${jupiterCode.toLowerCase()}`
            : out.error?.code ?? (out.problems ? `problems: ${out.problems.join('; ').slice(0, 120)}` : `exit ${r.code}`);
      const agent = outcome.kind === 'PASS' ? 'PASS' : outcome.code;
      outcome.bot = bot;
      const eitherUnavailable = outcome.kind === 'UNTESTED' || ['unavailable', 'busy', 'rate-limited'].includes(bot);
      if (!eitherUnavailable && bot !== agent && !(agent === 'price-moved' || bot === 'price-moved')) {
        outcome = { ...outcome, kind: 'BUG', code: 'agent-bot-differ', detail: `agent ${agent}, bot ${bot}` };
      }
    }
    // An expectation the case carries. "any-refusal": any honest refusal, Jupiter's own included;
    // a refusal the case names is honest there, whatever it would mean elsewhere.
    if (c.expect && outcome.kind !== 'UNTESTED') {
      const got = outcome.kind === 'PASS' ? 'PASS' : outcome.code;
      const jupiterRefused = /^Jupiter answered 4\d\d/.test(outcome.detail);
      const accepted = c.expect.includes(got)
        || (c.expect.includes('any-refusal') && (outcome.kind === 'REFUSED' || (outcome.kind === 'BUG' && (jupiterRefused || got === 'bad-request' || got === 'intent'))));
      if (accepted && outcome.kind === 'BUG') outcome = { ...outcome, kind: 'REFUSED' };
      else if (!accepted && outcome.kind !== 'BUG') outcome = { ...outcome, kind: 'BUG', code: 'unexpected', detail: `expected ${c.expect.join(' or ')}, got ${got}: ${outcome.detail}` };
    }
    return withEvents({ ...outcome, ms: Date.now() - started });
  } catch (e) {
    return withEvents({ ...base, ...classify(e), ms: Date.now() - started });
  }
}

/**
 * The agent's fetch, understating `factor` times the output of every route it brings Orientim: its
 * `outAmount`, its threshold, and the quote in the route's instruction, so that the route still
 * agrees with itself. The agent's own price (asked with its own wallet as taker) is left as Jupiter
 * gave it.
 */
function understating(fetchImpl: typeof fetch, owner: string, factor: bigint): typeof fetch {
  return (async (url: string, init?: RequestInit) => {
    const res = await fetchImpl(url, init);
    const u = new URL(String(url));
    if (!u.href.startsWith('https://api.jup.ag/swap/v2/build') || u.searchParams.get('taker') === owner || !res.ok) return res;
    const r = (await res.json()) as { outAmount: string; otherAmountThreshold: string; swapInstruction: { data: string } };
    const data = Buffer.from(r.swapInstruction.data, 'base64');
    const args = jupiterRouteArgs(data);
    if (!args) return Response.json(r);
    const lower = BigInt(r.outAmount) / factor;
    new DataView(data.buffer, data.byteOffset, data.byteLength).setBigUint64(args.slippageOffset - 8, lower, true);
    return Response.json({
      ...r, outAmount: lower.toString(), otherAmountThreshold: (BigInt(r.otherAmountThreshold) / factor).toString(),
      swapInstruction: { ...r.swapInstruction, data: data.toString('base64') },
    });
  }) as unknown as typeof fetch;
}

/** The markets Orientim promises by name (the canary's too), as Jupiter labels them in a route. */
const PROMISED_MARKETS: [string, string][] = [['Pump.fun curve', 'Pump.fun'], ['PumpSwap', 'Pump.fun Amm']];

/** Outcomes that depend on the market of the moment, not on the code that checks it. */
// The output account's balance moved between the two checks (a borrowed holder's wallet is live):
// the minimum-output check names the balance it was built on, and the later check reads another.
// Every problem the check named is the minimum-output check built on another balance of the output account.
const BALANCE_MOVED = /^R2: instruction \d+: minimum-output check for \d+, expected \d+(; R2: expected 1 × minOutCheck, found 0)?$/;
const MARKET_DECIDES = /costs-more|price-moved|simulation-failed|price-impact-high|route-failed-in-check|check-refused-honest-answer|problems: .*fails in simulation|problems: .*minimum-output check for \d+, expected \d+/;

// --- the analysis: what the passes and refusals show, beyond each verdict
const median = (xs: number[]) => (xs.length ? [...xs].sort((a, b) => a - b)[Math.floor((xs.length - 1) / 2)] : NaN);
const pct = (xs: number[], q: number) => (xs.length ? [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(q * xs.length))] : NaN);
const bps = (x: number) => (Number.isFinite(x) ? `${(x / 100).toFixed(2)}%` : '-');

function analysis(results: Result[]): string[] {
  const lines: string[] = ['', '## Analysis', ''];
  const passes = results.filter(r => r.kind === 'PASS');
  // Invariants, read apart from the check.
  const checked = passes.filter(r => r.invariants);
  lines.push(`- **Rules read apart from the check**: ${checked.length} passes × ${INVARIANTS} rules (the wallet pays and signs, one one-time key besides, fits its version's size, fee at most 0.25%, impact within its limit, a minimum above zero and under the quote, the amount asked, this wallet named, at most 150 blocks): ${results.filter(r => r.code === 'invariant').length} broken.`);
  // Tampering.
  const tampered = results.flatMap(r => r.tampered ?? []);
  if (tampered.length) {
    const by = new Map<string, { caught: number; missed: number; untested: number; why: string }>();
    for (const t of tampered) {
      const e = by.get(t.name) ?? { caught: 0, missed: 0, untested: 0, why: '' };
      e[t.verdict]++;
      if (t.verdict === 'caught' && !e.why) e.why = t.why;
      by.set(t.name, e);
    }
    lines.push(`- **A dishonest server, on ${results.filter(r => r.tampered).length} real mainnet transactions**: ${tampered.length} changes, ${tampered.filter(t => t.verdict === 'caught').length} refused by the check, ${tampered.filter(t => t.verdict === 'missed').length} missed, ${tampered.filter(t => t.verdict === 'untested').length} not tested (the RPC did not answer).`);
    for (const [name, e] of by) lines.push(`  - ${name}: ${e.caught} refused, ${e.missed} missed${e.untested ? `, ${e.untested} not tested` : ''}${e.why ? `. For example: "${e.why.replace(/\|/g, '/').slice(0, 160)}"` : ''}`);
  }
  // Approvals.
  const approved = results.filter(r => r.approved);
  if (approved.length) lines.push(`- **The owner's approval**: ${approved.length} swaps passed after the owner approved ${approved.map(r => `${r.pair} ${r.usd} (${r.approved})`).join('; ')}.`);
  // By size.
  const buckets: [string, number, number][] = [['under $1k', 0, 1_000], ['$1k–$10k', 1_000, 10_000], ['$10k–$100k', 10_000, 100_000], ['$100k–$1M', 100_000, 1_000_000], ['$1M and more', 1_000_000, Infinity]];
  lines.push('', '| size | cases | passed | refused: impact | refused: costs more | median impact of passes | 95th pct impact | median floor under quote | median gap refused | median time (s) |', '|---|---|---|---|---|---|---|---|---|---|');
  for (const [label, lo, hi] of buckets) {
    const rs = results.filter(r => r.usdValue !== undefined && r.usdValue >= lo && r.usdValue < hi);
    if (!rs.length) continue;
    const ps = rs.filter(r => r.kind === 'PASS');
    const impacts = ps.map(r => r.impactBps).filter((x): x is number => typeof x === 'number');
    const gaps = rs.map(r => r.gapBps).filter((x): x is number => typeof x === 'number' && Number.isFinite(x));
    lines.push(`| ${label} | ${rs.length} | ${ps.length} | ${rs.filter(r => r.code === 'price-impact-high').length} | ${rs.filter(r => r.code === 'costs-more').length} | ${bps(median(impacts))} | ${bps(pct(impacts, 0.95))} | ${bps(median(ps.map(r => r.floorBps ?? NaN).filter(Number.isFinite)))} | ${gaps.length ? bps(median(gaps)) : '-'} | ${(median(ps.map(r => r.ms)) / 1000).toFixed(1)} |`);
  }
  // The largest swaps that passed.
  const largest = passes.filter(r => r.usdValue).sort((a, b) => (b.usdValue ?? 0) - (a.usdValue ?? 0)).slice(0, 8);
  if (largest.length) lines.push('', `- **Largest swaps that passed the full check**: ${largest.map(r => `${r.pair} ${r.usd} (impact ${r.impact})`).join('; ')}.`);
  // Time.
  const ms = passes.map(r => r.ms);
  if (ms.length) lines.push(`- **Time per passed case**, own quote to the end of the check (Jupiter spaced ${JUPITER_INTERVAL_MS} ms apart for the test key): median ${(median(ms) / 1000).toFixed(1)} s, 95th percentile ${(pct(ms, 0.95) / 1000).toFixed(1)} s, longest ${(Math.max(...ms) / 1000).toFixed(1)} s.`);
  // Markets.
  const dexes = new Map<string, number>();
  for (const r of passes) for (const d of r.route.split(' > ').map(x => x.trim()).filter(Boolean)) dexes.set(d, (dexes.get(d) ?? 0) + 1);
  if (dexes.size) lines.push(`- **Markets in the passed routes** (${dexes.size}): ${[...dexes].sort((a, b) => b[1] - a[1]).map(([d, k]) => `${d} ${k}`).join(', ')}.`);
  // What the release promises, proven or not by this run: the markets named, the fee's three sides,
  // and whose routes built the swaps (the server's own events).
  const proven = (k: number) => (k ? `${k} passes` : '**NOT PROVEN this run**');
  lines.push(`- **Markets Orientim promises**: ${PROMISED_MARKETS.map(([name, label]) => `${name} ${proven(dexes.get(label) ?? 0)}`).join('; ')}.`);
  const side = (name: string) => passes.filter(r => r.feeSide === name).length;
  lines.push(`- **The fee's side in the passes**: on the input ${proven(side('input'))}; on the output ${proven(side('output'))}; in SOL from the wallet ${proven(side('sol'))}.`);
  const from = (name: string) => passes.filter(r => r.routesFrom === name).length;
  const asks = results.reduce((t, r) => t + (r.referenceAsks ?? 0), 0);
  lines.push(`- **Whose routes built the passes**: the agent's ${from('agent')}, Orientim's ${from('orientim')}, Orientim's after the agent's were not used ${from('orientim-fallback')}. Orientim's key was asked for its own price ${asks} times in ${results.length} cases.`);
  // The same swaps, again and again.
  const rounds = results.filter(r => r.group === 'repeat');
  if (rounds.length) {
    const byCase = new Map<string, string[]>();
    for (const r of rounds) byCase.set(`${r.pair} ${r.usd}`, [...(byCase.get(`${r.pair} ${r.usd}`) ?? []), r.kind === 'PASS' ? 'PASS' : r.code]);
    lines.push(`- **The same swaps at the start, middle and end of the run**: ${[...byCase].map(([k, v]) => `${k}: ${v.join(' / ')}`).join('; ')}.`);
  }
  // v0 against v1.
  const pairs = new Map<string, { v0?: Result; v1?: Result }>();
  for (const r of results.filter(x => x.compare)) {
    const e = pairs.get(r.compare!) ?? {};
    if (r.version === 1) e.v1 = r; else e.v0 = r;
    pairs.set(r.compare!, e);
  }
  if (pairs.size) {
    const verdict = (r?: Result) => (!r ? '-' : r.kind === 'PASS' ? 'PASS' : r.code === 'costs-more' ? `costs ${bps(r.gapBps ?? NaN)} more` : r.code);
    const gains: number[] = [];
    lines.push('', '### v0 (1232 bytes) against v1 (4096 bytes), the same swap a moment apart', '', '| pair | amount | v0 | v1 | v1 output against v0 |', '|---|---|---|---|---|');
    for (const { v0, v1 } of pairs.values()) {
      const a = v0?.outAmount ? Number(v0.outAmount) : NaN;
      const b = v1?.outAmount ? Number(v1.outAmount) : NaN;
      const gain = a > 0 && b > 0 ? ((b - a) / a) * 10_000 : NaN;
      if (Number.isFinite(gain)) gains.push(gain);
      const any = v0 ?? v1!;
      lines.push(`| ${any.pair} | ${any.usd} | ${verdict(v0)} | ${verdict(v1)} | ${Number.isFinite(gain) ? `${gain >= 0 ? '+' : ''}${(gain / 100).toFixed(2)}%` : '-'} |`);
    }
    if (gains.length) lines.push('', `- **v1 against v0**: ${gains.length} pairs compared, median ${bps(median(gains))} more output with v1, best ${bps(Math.max(...gains))}, worst ${bps(Math.min(...gains))}; ${[...pairs.values()].filter(p => p.v0?.code === 'costs-more' && p.v1?.kind === 'PASS').length} swaps refused as costlier with v0 passed with v1.`);
  }
  // The agent's routes against Orientim's.
  const byRoutes = new Map<string, { own?: Result; orientim?: Result }>();
  for (const r of results.filter(x => x.routesCompare)) {
    const e = byRoutes.get(r.routesCompare!) ?? {};
    if (r.orientimRoutes) e.orientim = r; else e.own = r;
    byRoutes.set(r.routesCompare!, e);
  }
  if (byRoutes.size) {
    const gap = (a?: string, b?: string) => (a && b && BigInt(b) > 0n ? Number(((BigInt(a) - BigInt(b)) * 10_000n) / BigInt(b)) : NaN);
    const pct = (x: number) => (Number.isFinite(x) ? `${x >= 0 ? '+' : ''}${(x / 100).toFixed(2)}%` : '-');
    const verdict = (r?: Result) => (!r ? '-' : r.kind === 'PASS' ? 'PASS' : r.code);
    lines.push('', "### The agent's routes against Orientim's, the same swap a moment apart", '', '| pair | amount | own routes | Orientim\'s | minimum, own against Orientim\'s | fee, own against Orientim\'s |', '|---|---|---|---|---|---|');
    for (const { own, orientim } of byRoutes.values()) {
      const any = own ?? orientim!;
      lines.push(`| ${any.pair} | ${any.usd} | ${verdict(own)} | ${verdict(orientim)} | ${pct(gap(own?.minOutRaw, orientim?.minOutRaw))} | ${pct(gap(own?.feeRaw, orientim?.feeRaw))} |`);
    }
  }
  // Agents against bots.
  const both = results.filter(r => r.bot !== undefined);
  if (both.length) lines.push(`- **Agent and bot (orientim-verify) on the same swap**: ${both.length} cases, ${both.filter(r => r.code !== 'agent-bot-differ').length} decided alike.`);
  return lines;
}

// --- the report
function report(results: Result[], started: number, summaryOnly = false): string {
  const count = (k: Result['kind']) => results.filter(r => r.kind === k).length;
  const lines: string[] = [];
  lines.push(`# Orientim mainnet simulation matrix (v${DEFAULT_VERSION} transactions unless a case names its own; routes from ${OWN_ROUTES && JUPITER_API_KEY ? "the agent's own Jupiter key" : "Orientim's key"})`, '');
  lines.push(`${results.length} cases in ${Math.round((Date.now() - started) / 60_000)} min: **${count('PASS')} passed**, ${count('REFUSED')} refused, ${count('UNTESTED')} untested, **${count('BUG')} to look at**.`, '');
  lines.push('Nothing was signed or sent: each swap stops before the wallet signs, after the full check simulated it on mainnet state.', '');
  const groups = [...new Set(results.map(r => r.group))];
  lines.push('| group | cases | passed | refused | untested | to look at |', '|---|---|---|---|---|---|');
  for (const g of groups) {
    const rs = results.filter(r => r.group === g);
    lines.push(`| ${g} | ${rs.length} | ${rs.filter(r => r.kind === 'PASS').length} | ${rs.filter(r => r.kind === 'REFUSED').length} | ${rs.filter(r => r.kind === 'UNTESTED').length} | ${rs.filter(r => r.kind === 'BUG').length} |`);
  }
  const refusals = new Map<string, number>();
  for (const r of results.filter(x => x.kind === 'REFUSED')) refusals.set(r.code, (refusals.get(r.code) ?? 0) + 1);
  if (refusals.size) lines.push('', `Refusals by reason: ${[...refusals].map(([k, v]) => `${k} ${v}`).join(', ')}.`);
  const bugs = results.filter(r => r.kind === 'BUG');
  if (bugs.length) {
    lines.push('', '## To look at', '');
    for (const b of bugs) lines.push(`- #${b.n} ${b.group}: ${b.pair}, ${b.usd}${b.rule ? `, ${b.rule}` : ''}, slippage ${b.asked}: **${b.code}**: ${b.detail.replace(/\|/g, '/')}`);
  }
  lines.push(...analysis(results));
  const esc = (s: string) => s.replace(/\|/g, '/').replace(/\n/g, ' ');
  const failed = results.filter(r => r.code === 'route-failed-in-check');
  if (failed.length) {
    const programs = new Map<string, number>();
    for (const r of failed) {
      const program = /\(program ([1-9A-HJ-NP-Za-km-z]{32,44}), error (\d+)\)/.exec(r.detail);
      const key = program ? `${program[1]} error ${program[2]}` : 'no program in the logs';
      programs.set(key, (programs.get(key) ?? 0) + 1);
    }
    lines.push('', '## Routes that failed in the check twice', '', ...[...programs].map(([k, v]) => `- ${k}: ${v}`));
  }
  const details = results.filter(r => r.kind !== 'PASS' && r.detail);
  if (details.length) {
    lines.push('', '## Why each case was not a pass', '');
    for (const r of details) lines.push(`- #${r.n} ${r.group} ${esc(r.pair)} ${esc(r.usd)}${r.rule ? ` ${esc(r.rule)}` : ''} slippage ${r.asked}: ${r.kind} ${esc(r.code)}: ${esc(r.detail)}${r.bot ? ` (bot ${esc(r.bot)})` : ''}`);
  }
  const answered = results.filter(r => r.jupiter?.length);
  if (answered.length) {
    lines.push('', "## Jupiter's answers that were not a success", '');
    for (const r of answered) for (const a of r.jupiter!) lines.push(`- #${r.n} ${esc(r.pair)} ${esc(r.usd)} (${r.kind} ${esc(r.code)}): ${esc(a).slice(0, 240)}`);
  }
  if (summaryOnly) return `${lines.join('\n')}\n`;
  lines.push('', '## Every case', '', '| # | group | pair | amount | owner\'s rule | slippage asked | built at (bps) | result | code | route | impact | fee | floor | ms | bot |', '|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|');
  for (const r of results) {
    lines.push(`| ${r.n} | ${r.group} | ${esc(r.pair)} | ${esc(r.usd)} | ${esc(r.rule)} | ${r.asked} | ${r.built} | ${r.kind} | ${esc(r.code)} | ${esc(r.route)} | ${r.impact} | ${esc(r.fee)} | ${esc(r.floor)} | ${r.ms} | ${r.bot ?? ''} |`);
  }
  return `${lines.join('\n')}\n`;
}

it('the mainnet simulation matrix', async () => {
  const started = Date.now();
  const w = OFFLINE ? await offline() : await mainnet();
  const pump = OFFLINE ? { curve: [], amm: [] } : await w.pumpTokens().catch(() => ({ curve: [], amm: [] }));
  const cases = OFFLINE
    ? [
      { group: 'offline', input: 'USDC', output: 'SOL', usd: 100 },
      { group: 'offline', input: 'USDC', output: 'SOL', usd: 100, slippage: 'auto' as const },
      { group: 'offline', input: 'USDC', output: 'SOL', usd: 100, slippage: 100, rule: { label: 'ceiling 0.5%', policy: { maxSlippageBps: 50 } }, expect: ['slippage-over-limit'] },
      { group: 'offline', input: 'USDC', output: 'SOL', usd: 100, rule: { label: 'per swap $10', policy: { maxAmountIn: { [T.USDC]: '10000000' } } }, expect: ['amount-over-limit'] },
      { group: 'offline', input: 'USDC', output: 'SOL', usd: 100, bot: true },
      { group: 'offline', input: 'SOL', output: 'USDC', usd: 100 },
      { group: 'offline', input: 'USDC', output: 'SOL', usd: 100, parallel: 3 },
      { group: 'offline', input: 'USDC', output: 'USDC', usd: 100, expect: ['any-refusal'] },
      { group: 'offline', input: 'USDC', output: 'SOL', usd: 100, minOutOfQuote: 1.05, expect: ['any-refusal'] },
      { group: 'offline', input: 'USDC', output: 'SOL', usd: 100, tamper: true },
      { group: 'offline', input: 'USDC', output: 'SOL', usd: 100, tamper: true, version: 1 },
      { group: 'offline', input: 'USDC', output: 'SOL', usd: 100, minOutOfQuote: 1.05, approve: true },
      { group: 'offline', input: 'USDC', output: 'SOL', usd: 100, wave: 'w' },
      { group: 'offline', input: 'USDC', output: 'SOL', usd: 200, wave: 'w' },
      { group: 'offline', input: 'USDC', output: 'SOL', usd: 300, wave: 'w', slippage: 'auto' },
      { group: 'offline', input: 'USDC', output: 'SOL', usd: 100, routesCompare: 'o' },
      { group: 'offline', input: 'USDC', output: 'SOL', usd: 100, routesCompare: 'o', orientimRoutes: true },
    ] as Case[]
    : buildCases(pump);
  console.log(`${cases.length} cases, as v${DEFAULT_VERSION} unless a case names its own${pump.curve.length || pump.amm.length ? `; Pump.fun curve ${pump.curve.map(nameOf).join(', ')}; PumpSwap ${pump.amm.map(nameOf).join(', ')}` : ''}`);
  const results: Result[] = [];
  let n = 0;
  const say = (r: Result) => console.log(`${String(r.n).padStart(3)} ${r.kind.padEnd(8)} ${r.group.padEnd(9)} ${r.pair} ${r.usd} ${r.rule} slippage ${r.asked}${r.built ? ` built ${r.built}` : ''}: ${r.code} ${r.route} ${r.detail.slice(0, 120)}`);
  const withAnswers = (r: Result) => (jupiterAnswers.has(r.n) ? { ...r, jupiter: jupiterAnswers.get(r.n) } : r);
  // A step: one case (with its copies), or every case of one wave, all started together.
  const steps: Case[][] = [];
  for (const c of cases) {
    const last = steps[steps.length - 1];
    if (c.wave && last?.[0]?.wave === c.wave) last.push(c);
    else steps.push([c]);
  }
  for (const step of steps) {
    const runs = step.flatMap(c => Array.from({ length: c.parallel ?? 1 }, () => ({ c, k: ++n })));
    let rs = await Promise.all(runs.map(({ c, k }) => caseOf.run(k, () => runCase(w, c, k))));
    // Agent and bot run seconds apart: when they differ on an answer the market decides (a cost, a
    // price, a route that fails in simulation), the case runs once more, and only a second
    // difference counts.
    rs = await Promise.all(rs.map(async (r, i) => {
      // The agent's own check refusing only the minimum-output check: the borrowed holder's output
      // balance moved between Orientim's build and the check. Run once more; a second time is a bug.
      const balanceMoved = r.code === 'check-refused-honest-answer' && BALANCE_MOVED.test(r.detail);
      if (!balanceMoved && (r.code !== 'agent-bot-differ' || !MARKET_DECIDES.test(r.detail))) return r;
      const again = await caseOf.run(r.n, () => runCase(w, runs[i].c, r.n));
      const detail = `${again.detail} (first try: ${r.detail})`.slice(0, 400);
      // The market's answer on the other side the second time (the agent's route failed once and the
      // bot's the next): neither copy decides differently, the market does. Not a pass, not a bug.
      const side = (d: string) => /^agent PASS/.test(d) ? 'bot' : /, bot PASS$/.test(d) ? 'agent' : null;
      if (again.code === 'agent-bot-differ' && MARKET_DECIDES.test(again.detail) && side(r.detail) && side(again.detail) && side(r.detail) !== side(again.detail)) {
        return { ...again, kind: 'UNTESTED' as const, code: 'market-decided-twice', detail };
      }
      return { ...again, detail };
    }));
    rs.forEach((r, i) => {
      const c = runs[i].c;
      const kept = withAnswers(c.parallel ? { ...r, group: `${r.group} (×${c.parallel})` } : c.wave ? { ...r, group: `${r.group} (×${step.length})` } : r);
      results.push(kept);
      say(kept);
    });
  }
  // The agent's routes may not lower the fee: with both passed, a fee more than 1.5% below the one
  // Orientim's own routes gave a moment later (1% allowed, and the market's move) is a bug.
  for (const own of results.filter(r => r.routesCompare && !r.orientimRoutes && r.kind === 'PASS')) {
    const theirs = results.find(r => r.routesCompare === own.routesCompare && r.orientimRoutes && r.kind === 'PASS');
    if (!theirs?.feeRaw || !own.feeRaw || BigInt(theirs.feeRaw) === 0n) continue;
    const below = Number(((BigInt(theirs.feeRaw) - BigInt(own.feeRaw)) * 10_000n) / BigInt(theirs.feeRaw));
    if (below > 150) Object.assign(own, { kind: 'BUG', code: 'own-routes-fee-low', detail: `fee ${own.feeRaw} against ${theirs.feeRaw} with Orientim's routes (${below} bps below)` });
  }
  const md = report(results, started);
  mkdirSync(OUT, { recursive: true });
  writeFileSync(join(OUT, 'report.md'), md);
  writeFileSync(join(OUT, 'report.json'), JSON.stringify(results, null, 2));
  if (process.env.GITHUB_STEP_SUMMARY) writeFileSync(process.env.GITHUB_STEP_SUMMARY, md, { flag: 'a' });
  console.log(`\nReport: ${join(OUT, 'report.md')}`);
  // The summary again, last in the log: counts, every case that was not a pass and why, and
  // Jupiter's refusals, where a reader of the log's tail finds them without the artifact.
  console.log(`\n===== SUMMARY =====\n${report(results, started, true)}===== END OF SUMMARY =====`);
  const bugs = results.filter(r => r.kind === 'BUG');
  expect(bugs.map(b => `#${b.n} ${b.pair} ${b.usd}: ${b.code}: ${b.detail}`)).toEqual([]);
  // A dishonest server's change that could not be tried leaves the run incomplete, not a pass: every
  // one must be refused by the check.
  const incomplete = results.filter(r => r.code === 'tamper-incomplete');
  expect(incomplete.map(r => `#${r.n} ${r.pair} ${r.usd}: ${r.detail}`), 'incomplete: a dishonest server\'s changes were not all tested').toEqual([]);
  // A run that could test little (a wrong key, a busy RPC) is not a pass either.
  const tested = results.filter(r => r.kind !== 'UNTESTED').length;
  expect(tested, `only ${tested} of ${results.length} cases could be tested: see UNTESTED in the report`).toBeGreaterThanOrEqual(Math.ceil(results.length / 2));
}, 4 * 60 * 60_000);
