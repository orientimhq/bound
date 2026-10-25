/**
 * The agent's guarded swap: a route from any source (a `GuardRoute`: instructions, the least output,
 * lookup tables; Jupiter's answer converts with `fromJupiter`), wrapped as
 * `[ComputeBudget] Pull, the route, Settle`, compiled as a v0 transaction with the route's lookup
 * tables (and the owner's, when given). The agent signs it, the verifiers co-sign it
 * (`cosignPrepared` checks they changed nothing), and the agent sends it through its own RPC.
 */
import {
  AccountRole, address, appendTransactionMessageInstructions, compileTransaction, compressTransactionMessageUsingAddressLookupTables,
  createTransactionMessage, getAddressDecoder, getProgramDerivedAddress, getPublicKeyFromAddress, getTransactionDecoder, getTransactionEncoder,
  partiallySignTransaction, pipe, setTransactionMessageFeePayer, setTransactionMessageLifetimeUsingBlockhash, verifySignature,
} from '@solana/kit';
import type { Address, Blockhash, Instruction, KeyPairSigner, SignatureBytes, Transaction } from '@solana/kit';
import { COMPUTE_BUDGET, pull, settle } from './instructions.ts';
import type { SwapAccounts } from './instructions.ts';

export type ApiInstruction = { programId: string; accounts: { pubkey: string; isSigner: boolean; isWritable: boolean }[]; data: string };
/** The part of Jupiter's `/swap/v2/build` answer a guarded swap uses. */
export type JupiterRoute = {
  inAmount: string;
  outAmount: string;
  otherAmountThreshold: string;
  routePlan: { swapInfo: { label: string } }[];
  setupInstructions: ApiInstruction[];
  swapInstruction: ApiInstruction;
  cleanupInstruction: ApiInstruction | null;
  otherInstructions: ApiInstruction[];
  addressesByLookupTableAddress: Record<string, string[]> | null;
};

export const JUPITER_BUILD_URL = 'https://api.jup.ag/swap/v2/build';

/**
 * Jupiter's route for `taker` (the agent), delivering straight to `destination` (the owner's output
 * account). SOL is never wrapped by Jupiter: the Guard moves wrapped SOL like any token.
 */
export async function jupiterRoute(p: {
  inputMint: Address; outputMint: Address; amount: bigint; taker: Address; destination: Address;
  slippageBps: number; maxAccounts?: number; apiKey?: string; url?: string; fetchImpl?: typeof fetch;
}): Promise<JupiterRoute> {
  const qs = new URLSearchParams({
    inputMint: p.inputMint, outputMint: p.outputMint, amount: p.amount.toString(), taker: p.taker,
    destinationTokenAccount: p.destination, slippageBps: String(p.slippageBps), maxAccounts: String(p.maxAccounts ?? 40),
    wrapAndUnwrapSol: 'false',
  });
  const res = await (p.fetchImpl ?? fetch)(`${p.url ?? JUPITER_BUILD_URL}?${qs}`, {
    headers: p.apiKey ? { 'x-api-key': p.apiKey } : {}, signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(`Jupiter answered ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return (await res.json()) as JupiterRoute;
}

const fromBase64 = (s: string) => Uint8Array.from(atob(s), c => c.charCodeAt(0));

/** One of Jupiter's instructions as a Kit instruction. */
export const toInstruction = (i: ApiInstruction): Instruction => ({
  programAddress: address(i.programId),
  accounts: i.accounts.map(a => ({
    address: address(a.pubkey),
    role: a.isSigner
      ? (a.isWritable ? AccountRole.WRITABLE_SIGNER : AccountRole.READONLY_SIGNER)
      : (a.isWritable ? AccountRole.WRITABLE : AccountRole.READONLY),
  })),
  data: fromBase64(i.data),
});

/** SetComputeUnitLimit: the transaction's compute budget. */
export const computeUnitLimit = (units: number): Instruction => {
  const data = new Uint8Array(5);
  data[0] = 2;
  new DataView(data.buffer).setUint32(1, units, true);
  return { programAddress: COMPUTE_BUDGET, data };
};

/** SetComputeUnitPrice: the priority fee, in micro-lamports per compute unit. */
export const computeUnitPrice = (microLamports: bigint): Instruction => {
  const data = new Uint8Array(9);
  data[0] = 3;
  new DataView(data.buffer).setBigUint64(1, microLamports, true);
  return { programAddress: COMPUTE_BUDGET, data };
};

export type GuardedSwap = { instructions: Instruction[]; tables: Record<Address, Address[]>; minOut: bigint };

/**
 * A route from any source, for the guarded swap: the instructions that run between Pull and Settle
 * (taking at most the amount from the agent's hopper and delivering to the owner's output account),
 * the least output they promise (Pull's minimum), and the lookup tables they use.
 */
export type GuardRoute = { instructions: Instruction[]; minOut: bigint; lookupTables?: Record<Address, Address[]> };

/** Jupiter's `/swap/v2/build` answer as a `GuardRoute`. */
export const fromJupiter = (r: JupiterRoute): GuardRoute => ({
  instructions: [...r.setupInstructions, r.swapInstruction, ...(r.cleanupInstruction ? [r.cleanupInstruction] : []), ...r.otherInstructions].map(toInstruction),
  minOut: BigInt(r.otherAmountThreshold),
  lookupTables: Object.fromEntries(Object.entries(r.addressesByLookupTableAddress ?? {}).map(([k, v]) => [address(k), v.map(x => address(x))])),
});

const asGuardRoute = (r: GuardRoute | JupiterRoute): GuardRoute => ('swapInstruction' in r ? fromJupiter(r) : r);

/**
 * The guarded swap's instructions: the compute budget, Pull for `amount` with the route's own
 * minimum (or a higher one), the route's instructions, Settle last. The compute budget is the agent's
 * alone: the route's own compute budget instructions are dropped, so a route cannot set a priority
 * fee above the agent's cap (M05).
 */
export function guardedSwap(a: {
  accounts: SwapAccounts; amount: bigint; route: GuardRoute | JupiterRoute; minOut?: bigint;
  computeUnits?: number; microLamportsPerUnit?: bigint; ownerTable?: { address: Address; addresses: Address[] };
}): GuardedSwap {
  const r = asGuardRoute(a.route);
  const minOut = a.minOut && a.minOut > r.minOut ? a.minOut : r.minOut;
  const instructions = [
    computeUnitLimit(a.computeUnits ?? 600_000),
    ...(a.microLamportsPerUnit ? [computeUnitPrice(a.microLamportsPerUnit)] : []),
    pull(a.accounts, a.amount, minOut),
    ...r.instructions.filter(i => i.programAddress !== COMPUTE_BUDGET),
    settle(a.accounts),
  ];
  const tables: Record<Address, Address[]> = { ...r.lookupTables };
  if (a.ownerTable) tables[a.ownerTable.address] = a.ownerTable.addresses;
  return { instructions, tables, minOut };
}

/** The guarded swap as an unsigned v0 transaction, paid by the agent. */
export function compileGuardedSwap(s: GuardedSwap, agent: Address, lifetime: { blockhash: Blockhash; lastValidBlockHeight: bigint }): Transaction {
  return compileTransaction(pipe(
    createTransactionMessage({ version: 0 }),
    m => setTransactionMessageFeePayer(agent, m),
    m => setTransactionMessageLifetimeUsingBlockhash(lifetime, m),
    m => appendTransactionMessageInstructions(s.instructions, m),
    m => compressTransactionMessageUsingAddressLookupTables(m, s.tables),
  ));
}

/** Pyth's sponsored price account of a feed (push oracle, shard 0). `feedId` is the feed's 32 bytes in hex. */
export async function pythPriceAccount(feedId: string): Promise<Address> {
  const PUSH_ORACLE = address('pythWSnswVUd12oZpeFP8e9CVaEqJg25g1Vtc2biRsT');
  return (await getProgramDerivedAddress({ programAddress: PUSH_ORACLE, seeds: [Uint8Array.of(0, 0), hexBytes(feedId)] }))[0];
}

/** A Pyth feed id (hex) as the address-shaped 32 bytes a grant stores. */
export const feedAddress = (feedId: string): Address => getAddressDecoder().decode(hexBytes(feedId));

const hexBytes = (hex: string) => {
  const id = Uint8Array.from((hex.replace(/^0x/, '').match(/../g) ?? []).map(x => Number.parseInt(x, 16)));
  if (id.length !== 32) throw new Error('a Pyth feed id is 32 bytes');
  return id;
};

/**
 * The verifier's HTTP call alone, with no check of what comes back: it returns whatever the verifier
 * answered, changed or not, signed or not. Integrators use `cosignPrepared`, which signs as the agent
 * first and refuses an answer that differs from what was sent or lacks a valid signature.
 */
export async function requestCosign(url: string, tx: Transaction, fetchImpl: typeof fetch = fetch): Promise<Transaction> {
  const body = JSON.stringify({ transaction: toBase64(new Uint8Array(getTransactionEncoder().encode(tx))) });
  const res = await fetchImpl(`${url.replace(/\/$/, '')}/v1/cosign`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body, signal: AbortSignal.timeout(30_000),
  });
  const answer = (await res.json().catch(() => ({}))) as { transaction?: string; error?: string };
  if (!res.ok || !answer.transaction) throw new Error(`the verifier refused (${res.status}): ${answer.error ?? 'no answer'}`);
  return getTransactionDecoder().decode(fromBase64(answer.transaction));
}

const toBase64 = (b: Uint8Array) => btoa(String.fromCharCode(...b));

/** A verifier of the owner's policy and how to ask it: its URL (`POST /v1/cosign`) or a function. */
export type Cosigner = { address: Address; cosign: string | ((tx: Transaction) => Promise<Transaction>) };

/**
 * A guarded swap built anywhere (by `guardedSwap` or by hand), co-signed safely: signed by `agent` when
 * given (a verifier co-signs only what the agent signed), then sent to each verifier in turn. Each
 * answer must carry the same message bytes and a valid signature of that verifier, or the swap is
 * refused: a verifier can neither change the swap nor raise the fee the agent pays. On success the
 * transaction is ready to send (with the agent's signature, when `agent` was given).
 */
export async function cosignPrepared(
  tx: Transaction, verifiers: Cosigner[], o: { agent?: KeyPairSigner; fetchImpl?: typeof fetch } = {},
): Promise<{ ok: true; transaction: Transaction } | { ok: false; reason: string }> {
  let signed = o.agent ? await partiallySignTransaction([o.agent.keyPair], tx) : tx;
  const built = new Uint8Array(signed.messageBytes);
  if (!verifiers.length) return { ok: false, reason: 'no verifier to co-sign' };
  for (const v of verifiers) {
    let answer: Transaction;
    try {
      answer = typeof v.cosign === 'string' ? await requestCosign(v.cosign, signed, o.fetchImpl) : await v.cosign(signed);
    } catch (e) {
      return { ok: false, reason: (e as Error).message };
    }
    const got = new Uint8Array(answer.messageBytes);
    if (got.length !== built.length || got.some((x, i) => x !== built[i])) return { ok: false, reason: `the verifier ${v.address} returned a different transaction` };
    const signature = answer.signatures[v.address];
    let valid = false;
    try {
      valid = !!signature && (await verifySignature(await getPublicKeyFromAddress(v.address), signature as SignatureBytes, built));
    } catch {
      valid = false;
    }
    if (!valid) return { ok: false, reason: `the verifier ${v.address} did not sign the transaction` };
    signed = { ...signed, signatures: { ...signed.signatures, [v.address]: signature } };
  }
  return { ok: true, transaction: signed };
}
