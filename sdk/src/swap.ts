/**
 * The agent's guarded swap: Jupiter's route for the agent, wrapped as
 * `[ComputeBudget] Pull, the route, Settle`, compiled as a v0 transaction with the route's lookup
 * tables (and the owner's, when given). The verifier co-signs it first, then the agent signs and sends
 * it through its own RPC.
 */
import {
  AccountRole, address, appendTransactionMessageInstructions, compileTransaction, compressTransactionMessageUsingAddressLookupTables,
  createTransactionMessage, getAddressDecoder, getProgramDerivedAddress, pipe, setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
} from '@solana/kit';
import type { Address, Blockhash, Instruction, Transaction } from '@solana/kit';
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
 * The guarded swap's instructions: the compute budget, Pull for `amount` with the route's own
 * minimum (or a higher one), Jupiter's instructions, Settle last.
 */
export function guardedSwap(a: {
  accounts: SwapAccounts; amount: bigint; route: JupiterRoute; minOut?: bigint;
  computeUnits?: number; microLamportsPerUnit?: bigint; ownerTable?: { address: Address; addresses: Address[] };
}): GuardedSwap {
  const quoted = BigInt(a.route.otherAmountThreshold);
  const minOut = a.minOut && a.minOut > quoted ? a.minOut : quoted;
  const r = a.route;
  const instructions = [
    computeUnitLimit(a.computeUnits ?? 600_000),
    ...(a.microLamportsPerUnit ? [computeUnitPrice(a.microLamportsPerUnit)] : []),
    pull(a.accounts, a.amount, minOut),
    ...[...r.setupInstructions, r.swapInstruction, ...(r.cleanupInstruction ? [r.cleanupInstruction] : []), ...r.otherInstructions].map(toInstruction),
    settle(a.accounts),
  ];
  const tables: Record<Address, Address[]> = Object.fromEntries(
    Object.entries(r.addressesByLookupTableAddress ?? {}).map(([k, v]) => [address(k), v.map(x => address(x))]),
  );
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
