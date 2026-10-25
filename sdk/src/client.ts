/**
 * `swap()`: the agent's guarded swap in one call. It reads the owner's rules on chain and says
 * before anything is sent why a swap would be refused; gets the route; builds `Pull, the route,
 * Settle`; asks the verifier to co-sign; checks that the verifier signed exactly the transaction it
 * built (the same message bytes, a valid signature) so a verifier can neither change the swap nor raise
 * the fee the agent pays; then signs with the agent's key, sends it and reports what arrived.
 *
 * The chain, the route and the verifier are passed in, so the same code runs against mainnet, devnet
 * or a local VM.
 */
import {
  getPublicKeyFromAddress, getSignatureFromTransaction, getTransactionEncoder, partiallySignTransaction,
  verifySignature,
} from '@solana/kit';
import type { Address, Blockhash, KeyPairSigner, SignatureBytes, Transaction } from '@solana/kit';
import { decodeGrant, decodePolicy, decodeTokenAccount } from './accounts.ts';
import type { GrantState, PolicyState } from './accounts.ts';
import { accountsFor, feeOf, grantOf, policyOf } from './instructions.ts';
import { compileGuardedSwap, guardedSwap, jupiterRoute, pythPriceAccount, requestCosign } from './swap.ts';
import type { JupiterRoute } from './swap.ts';

const DAY = 86_400n;
const MAX_TRANSACTION_SIZE = 1232;

export type AccountData = { data: Uint8Array; owner: Address } | null;

/** What `swap()` needs from the chain. `rpcChain` (sdk/src/rpc.ts) gives one over an RPC node. */
export type Chain = {
  getAccounts: (addresses: Address[]) => Promise<AccountData[]>;
  latestBlockhash: () => Promise<{ blockhash: Blockhash; lastValidBlockHeight: bigint }>;
  /** The cluster's clock, in unix seconds. */
  now: () => Promise<bigint>;
  /** Sends the signed transaction and waits until it is confirmed or has failed. */
  send: (tx: Transaction) => Promise<{ ok: boolean; error?: string }>;
};

export type RouteRequest = { inputMint: Address; outputMint: Address; amount: bigint; taker: Address; destination: Address; slippageBps: number; maxAccounts: number };

export type GuardClient = {
  program: Address;
  owner: Address;
  agent: KeyPairSigner;
  chain: Chain;
  /** Each verifier of the policy that co-signs, with how to ask it (a URL or a function). */
  verifiers: { address: Address; cosign: string | ((tx: Transaction) => Promise<Transaction>) }[];
  /** The route's source: Jupiter's `/swap/v2/build` by default (with `jupiterApiKey`). */
  route?: (r: RouteRequest) => Promise<JupiterRoute>;
  jupiterApiKey?: string;
  /** The priority fee the agent is willing to pay, in micro-lamports per compute unit (default 0). */
  microLamportsPerUnit?: bigint;
  /** The most the agent ever pays as priority fee, in micro-lamports per unit (default 1,000,000). */
  maxMicroLamportsPerUnit?: bigint;
  computeUnits?: number;
};

export type SwapRequest = {
  mintIn: Address;
  mintOut: Address;
  /** In the input mint's base units. The Guard's fee comes on top of it, from the owner's approval. */
  amount: bigint;
  /** The route's slippage (default 50 bps). The owner's Pyth floor, when set, applies regardless. */
  slippageBps?: number;
  /** A minimum to receive, if higher than the route's own. */
  minOut?: bigint;
};

export type SwapResult =
  | { ok: true; signature: string; amount: bigint; fee: bigint; minOut: bigint; arrived: bigint }
  | { ok: false; stage: 'rules' | 'route' | 'verifier' | 'chain'; reason: string };

/** Why the Guard would refuse this swap, from the owner's rules as they are on chain now; null if it would not. */
export function wouldRefuse(
  p: { policy: PolicyState; grant: GrantState; now: bigint; agent: Address; verifiers: Address[] },
  s: { mintIn: Address; mintOut: Address; amount: bigint },
  ownerIn: { delegate: Address | null; delegatedAmount: bigint; amount: bigint } | null,
  authority: Address,
): string | null {
  const { policy, grant, now } = p;
  if (policy.paused) return 'the owner has paused the policy';
  const known = p.verifiers.filter(v => policy.verifiers.includes(v));
  if (!known.length) return 'none of the verifiers given is in the owner\'s policy';
  if (policy.threshold >= 2 && new Set(known).size < 2) return 'the owner\'s policy needs two verifiers to co-sign';
  if (grant.agent !== p.agent) return 'this grant is not the agent\'s';
  if (grant.status !== 0) return grant.status === 1 ? 'the owner has paused this agent' : 'the owner has revoked this agent';
  if (grant.expiresAt !== 0n && now >= grant.expiresAt) return 'the agent\'s grant has expired';
  if (s.mintIn === s.mintOut) return 'the input and output mints are the same';
  if (!grant.outputs.includes(s.mintOut)) return 'the owner does not allow this output mint';
  if (s.amount <= 0n) return 'nothing to swap';
  const limit = grant.limits.find(l => l.mint === s.mintIn);
  if (!limit) return 'the owner does not allow this input mint';
  if (s.amount > limit.perSwap) return `above the owner's limit per swap (${limit.perSwap})`;
  const total = s.amount + feeOf(s.amount);
  const day = now >= 0n ? now / DAY : -((-now + DAY - 1n) / DAY);
  const used = (limit.day === day ? limit.usedToday : 0n) + total;
  if (used > limit.perDay) return `above the owner's daily limit (${limit.perDay}, ${limit.day === day ? limit.usedToday : 0n} used today, the fee included)`;
  const tracksLoss = grant.maxLossPerDay > 0n || grant.maxLossTotal > 0n;
  const priced = grant.feeds.some(f => f.mint === s.mintIn) && grant.feeds.some(f => f.mint === s.mintOut);
  if ((grant.maxSlippageBps > 0 || tracksLoss) && !priced && (tracksLoss || !grant.allowUnpriced)) return 'the owner requires a Pyth price for both mints, and one has none';
  if (tracksLoss) {
    const today = grant.lossDay === day ? grant.lossToday : 0n;
    if ((grant.maxLossPerDay > 0n && today >= grant.maxLossPerDay) || (grant.maxLossTotal > 0n && grant.lossTotal >= grant.maxLossTotal)) return 'the agent has spent its loss budget';
  }
  if (!ownerIn) return 'the owner has no account for the input mint';
  if (ownerIn.delegate !== authority) return 'the owner has not approved the Guard for the input (or has revoked it)';
  if (ownerIn.delegatedAmount < total) return `the owner's approval is spent (${ownerIn.delegatedAmount} left, ${total} needed with the fee)`;
  if (ownerIn.amount < total) return 'the owner\'s balance is too low';
  return null;
}

const wireOf = (tx: Transaction) => new Uint8Array(getTransactionEncoder().encode(tx));
const same = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((x, i) => x === b[i]);
const hex = (b: Uint8Array) => Array.from(b, x => x.toString(16).padStart(2, '0')).join('');

/** The guarded-swap client; `swap()` is the one call an agent or a bot needs. */
export function createGuardClient(c: GuardClient) {
  const maxPrice = c.maxMicroLamportsPerUnit ?? 1_000_000n;
  const route = c.route ?? ((r: RouteRequest) => jupiterRoute({ ...r, apiKey: c.jupiterApiKey }));

  /** The owner's rules for this agent as they are on chain now. */
  async function rules() {
    const policyAt = await policyOf(c.program, c.owner);
    const grantAt = await grantOf(c.program, c.owner, c.agent.address);
    const [policy, grant] = await c.chain.getAccounts([policyAt, grantAt]);
    if (!policy || policy.owner !== c.program) return null;
    if (!grant || grant.owner !== c.program) return { policy: decodePolicy(policy.data), grant: null };
    return { policy: decodePolicy(policy.data), grant: decodeGrant(grant.data) };
  }

  async function cosign(tx: Transaction): Promise<Transaction | string> {
    const built = tx.messageBytes;
    let signed = tx;
    for (const v of c.verifiers) {
      let answer: Transaction;
      try {
        answer = typeof v.cosign === 'string' ? await requestCosign(v.cosign, signed) : await v.cosign(signed);
      } catch (e) {
        return (e as Error).message;
      }
      // The verifier may only add its signature: the message must be the one this client built.
      if (!same(new Uint8Array(answer.messageBytes), new Uint8Array(built))) return `the verifier ${v.address} returned a different transaction`;
      const signature = answer.signatures[v.address];
      if (!signature || !(await verifySignature(await getPublicKeyFromAddress(v.address), signature as SignatureBytes, built))) {
        return `the verifier ${v.address} did not sign the transaction`;
      }
      signed = { ...signed, signatures: { ...signed.signatures, [v.address]: signature } };
    }
    return signed;
  }

  async function swap(s: SwapRequest): Promise<SwapResult> {
    const price = c.microLamportsPerUnit ?? 0n;
    if (price > maxPrice) return { ok: false, stage: 'rules', reason: `a priority fee of ${price} µlamports per unit is above the cap of ${maxPrice}` };

    // The owner's rules, and the accounts the swap names.
    const state = await rules();
    if (!state) return { ok: false, stage: 'rules', reason: 'the owner has no Guard policy' };
    if (!state.grant) return { ok: false, stage: 'rules', reason: 'the owner has not granted this agent' };
    const [mintIn, mintOut] = await c.chain.getAccounts([s.mintIn, s.mintOut]);
    if (!mintIn || !mintOut) return { ok: false, stage: 'rules', reason: 'a mint does not exist' };
    const grant = state.grant;
    const tracksLoss = grant.maxLossPerDay > 0n || grant.maxLossTotal > 0n;
    const feedOf = (m: Address) => grant.feeds.find(f => f.mint === m)?.feed;
    const fIn = feedOf(s.mintIn);
    const fOut = feedOf(s.mintOut);
    const prices = (grant.maxSlippageBps > 0 || tracksLoss) && fIn && fOut ? [await pythPriceAccount(hex(fIn)), await pythPriceAccount(hex(fOut))] : undefined;
    const accounts = await accountsFor({
      program: c.program, owner: c.owner, agent: c.agent.address, verifier: c.verifiers[0].address, second: c.verifiers[1]?.address,
      mintIn: s.mintIn, mintOut: s.mintOut, tokenIn: mintIn.owner, tokenOut: mintOut.owner, prices, lossBudget: tracksLoss,
    });
    const [ownerIn, ownerOut, hopper, treasury] = await c.chain.getAccounts([accounts.ownerIn, accounts.ownerOut, accounts.hopper, accounts.treasuryIn]);
    const refusal = wouldRefuse(
      { ...state, grant, now: await c.chain.now(), agent: c.agent.address, verifiers: c.verifiers.map(v => v.address) },
      s, ownerIn ? decodeTokenAccount(ownerIn.data) : null, accounts.authority,
    );
    if (refusal) return { ok: false, stage: 'rules', reason: refusal };
    if (!ownerOut) return { ok: false, stage: 'rules', reason: 'the owner has no account for the output mint (the owner\'s set-up creates it)' };
    if (!hopper || !treasury) return { ok: false, stage: 'rules', reason: 'the agent\'s or the treasury\'s account for the input mint is missing (the owner\'s set-up creates them)' };
    const before = decodeTokenAccount(ownerOut.data).amount;

    // The route, smaller until the transaction fits.
    let tx: Transaction | null = null;
    let minOut = 0n;
    let why = '';
    for (const maxAccounts of [40, 28, 20]) {
      let r: JupiterRoute;
      try {
        r = await route({
          inputMint: s.mintIn, outputMint: s.mintOut, amount: s.amount, taker: c.agent.address, destination: accounts.ownerOut,
          slippageBps: s.slippageBps ?? 50, maxAccounts,
        });
      } catch (e) {
        return { ok: false, stage: 'route', reason: (e as Error).message };
      }
      const built = guardedSwap({ accounts, amount: s.amount, route: r, minOut: s.minOut, computeUnits: c.computeUnits, microLamportsPerUnit: price || undefined });
      try {
        const candidate = compileGuardedSwap(built, c.agent.address, await c.chain.latestBlockhash());
        if (wireOf(candidate).length <= MAX_TRANSACTION_SIZE) {
          tx = candidate;
          minOut = built.minOut;
          break;
        }
        why = `the transaction is ${wireOf(candidate).length} bytes, above 1232`;
      } catch (e) {
        why = (e as Error).message;
      }
    }
    if (!tx) return { ok: false, stage: 'route', reason: `no route fits in one transaction: ${why}` };

    const cosigned = await cosign(tx);
    if (typeof cosigned === 'string') return { ok: false, stage: 'verifier', reason: cosigned };
    const signed = await partiallySignTransaction([c.agent.keyPair], cosigned);
    const sent = await c.chain.send(signed);
    if (!sent.ok) return { ok: false, stage: 'chain', reason: sent.error ?? 'the transaction failed' };
    const [after] = await c.chain.getAccounts([accounts.ownerOut]);
    return {
      ok: true, signature: getSignatureFromTransaction(signed), amount: s.amount, fee: feeOf(s.amount), minOut,
      arrived: (after ? decodeTokenAccount(after.data).amount : before) - before,
    };
  }

  return { swap, rules };
}
