/**
 * The verifier's decision: whether to co-sign an agent's guarded swap. The Guard program enforces the
 * owner's rules on chain whatever the verifier does; the verifier adds what a program cannot see
 * before the transaction lands (a simulation of the whole swap, a rate per agent) and refuses early,
 * with a reason, anything the program would refuse.
 *
 * It signs only a transaction of the Guard's shape (rule I3), in which its key appears nowhere but as
 * a verifier of the one Pull, never as the fee payer and never writable, so its signature cannot
 * authorise anything else; and only with a blockhash lifetime, so a co-signed transaction expires
 * within about a minute and a half.
 *
 * It only looks at a transaction the agent has already signed (M04): without the agent's key no one can
 * spend the agent's rate or make it simulate, and at most `maxConcurrent` simulations run at once, each
 * for at most `simulateMs`.
 */
import {
  AccountRole, decompileTransactionMessage, getCompiledTransactionMessageDecoder, getPublicKeyFromAddress, getTransactionDecoder,
  getTransactionEncoder, isTransactionMessageWithBlockhashLifetime, partiallySignTransaction, verifySignature,
} from '@solana/kit';
import type { Address, AddressesByLookupTableAddress, SignatureBytes, Transaction } from '@solana/kit';
import { COMPUTE_BUDGET } from '../../sdk/src/instructions.ts';

const MAX_TRANSACTION_SIZE = 1232;
const PULL = 3;
const SETTLE = 4;
/** Pull's verifier accounts: the first (always) and the second (a policy with threshold 2). */
const VERIFIER_SLOTS = [1, 14];

export type Simulation = { ok: boolean; error?: string; logs?: string[] };

export type CosignConfig = {
  /** The Guard program. */
  program: Address;
  /** The verifier's key pair (Ed25519). */
  key: CryptoKeyPair;
  /** The verifier's address, the public half of `key`. */
  address: Address;
  /** The addresses each lookup table the transaction names holds. */
  loadTables: (tables: Address[]) => Promise<AddressesByLookupTableAddress>;
  /** Runs the transaction (without checking signatures) against the chain as it is now. */
  simulate: (tx: Transaction) => Promise<Simulation>;
  /** Co-signed swaps one agent may have per minute (30 by default). */
  perMinute?: number;
  /** Simulations at once, over all agents (16 by default); more are refused with 503. */
  maxConcurrent?: number;
  /** How long a simulation may take, in milliseconds (10,000 by default). */
  simulateMs?: number;
  now?: () => number;
};

export type Verdict =
  | { ok: true; transaction: Transaction; agent: Address }
  | { ok: false; status: number; reason: string; logs?: string[] };

const refuse = (reason: string, status = 400, logs?: string[]): Verdict => ({ ok: false, status, reason, logs });

export function createCosigner(c: CosignConfig) {
  const perMinute = c.perMinute ?? 30;
  const maxConcurrent = c.maxConcurrent ?? 16;
  const simulateMs = c.simulateMs ?? 10_000;
  const now = c.now ?? Date.now;
  let running = 0;
  const recent = new Map<Address, number[]>();

  /** Whether `agent` may have another co-signed swap now; counts it if so. */
  const withinRate = (agent: Address) => {
    const t = now();
    const times = (recent.get(agent) ?? []).filter(x => t - x < 60_000);
    if (times.length >= perMinute) return false;
    times.push(t);
    recent.set(agent, times);
    if (recent.size > 100_000) recent.clear(); // a bound on memory; the chain's limits still hold
    return true;
  };

  return async function cosign(wire: Uint8Array): Promise<Verdict> {
    if (wire.length > MAX_TRANSACTION_SIZE) return refuse('the transaction is larger than 1232 bytes');
    let tx: Transaction;
    let compiled;
    try {
      tx = getTransactionDecoder().decode(wire);
      compiled = getCompiledTransactionMessageDecoder().decode(tx.messageBytes);
    } catch {
      return refuse('not a Solana transaction');
    }
    const lookups = 'addressTableLookups' in compiled ? (compiled.addressTableLookups ?? []) : [];
    let message;
    try {
      const tables = lookups.length ? await c.loadTables(lookups.map(l => l.lookupTableAddress)) : {};
      message = decompileTransactionMessage(compiled, { addressesByLookupTableAddress: tables });
    } catch {
      return refuse('a lookup table of the transaction could not be read');
    }
    if (!isTransactionMessageWithBlockhashLifetime(message)) return refuse('only a transaction with a recent blockhash is co-signed');

    // The shape: [ComputeBudget*] Pull (anything but this program) * Settle, Settle last.
    const ixs = message.instructions;
    const pullAt = ixs.findIndex(i => i.programAddress !== COMPUTE_BUDGET);
    const pull = ixs[pullAt];
    const settle = ixs.at(-1);
    if (!pull || pull.programAddress !== c.program || pull.data?.[0] !== PULL) return refuse('the first instruction after the compute budget must be the Guard\'s Pull');
    if (!settle || settle === pull || settle.programAddress !== c.program || settle.data?.length !== 1 || settle.data[0] !== SETTLE) {
      return refuse('the last instruction must be the Guard\'s Settle');
    }
    for (const i of ixs.slice(pullAt + 1, -1)) {
      if (i.programAddress === c.program) return refuse('the Guard appears between Pull and Settle');
    }

    // Our key: a verifier of this Pull and nothing else.
    const agent = pull.accounts?.[0]?.address;
    if (!agent || message.feePayer.address !== agent) return refuse('the agent named in Pull must pay for the transaction');
    if (message.feePayer.address === c.address) return refuse('the verifier never pays for a transaction');
    let slots = 0;
    for (const [n, i] of ixs.entries()) {
      for (const [k, a] of (i.accounts ?? []).entries()) {
        if (a.address !== c.address) continue;
        if (n !== pullAt || !VERIFIER_SLOTS.includes(k) || a.role !== AccountRole.READONLY_SIGNER) return refuse('the verifier\'s key appears outside Pull\'s verifier accounts');
        slots++;
      }
    }
    if (!slots) return refuse('this verifier is not named in the transaction');

    // Only the agent can ask for its own swaps: its signature first, then the rate.
    const agentSignature = tx.signatures[agent];
    let signedByAgent = false;
    try {
      signedByAgent = !!agentSignature && (await verifySignature(await getPublicKeyFromAddress(agent), agentSignature as SignatureBytes, tx.messageBytes));
    } catch {
      signedByAgent = false;
    }
    if (!signedByAgent) return refuse('the agent named in Pull must sign the transaction first', 401);
    if (running >= maxConcurrent) return refuse('the verifier is busy; try again', 503);
    if (!withinRate(agent)) return refuse('too many swaps from this agent in the last minute', 429);

    running++;
    let simulation: Simulation;
    try {
      simulation = await Promise.race([
        c.simulate(tx),
        new Promise<Simulation>(resolve => setTimeout(() => resolve({ ok: false, error: 'the simulation timed out' }), simulateMs).unref?.()),
      ]);
    } finally {
      running--;
    }
    if (!simulation.ok) return refuse(`the swap fails on chain: ${simulation.error ?? 'unknown error'}`, 422, simulation.logs);

    try {
      return { ok: true, transaction: await partiallySignTransaction([c.key], tx), agent };
    } catch {
      return refuse('the verifier is not a signer of this transaction');
    }
  };
}

export const encodeTransaction = (tx: Transaction) => new Uint8Array(getTransactionEncoder().encode(tx));
