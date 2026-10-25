/**
 * The verifier's decision: whether to co-sign an agent's guarded swap. The Guard program enforces the
 * owner's rules on chain whatever the verifier does; the verifier only checks, at once, that the
 * transaction has the Guard's shape, and keeps a rate per agent; it asks an RPC node only for the lookup
 * tables a transaction names, and only once the fee payer has signed and is within its rate (U03). It does
 * not simulate the swap: a simulation protects nothing the program does not, adds a round trip to an
 * RPC node (latency, in which a fast-moving price can turn a good swap into a refused one, and one more
 * service to be down) and is work a stranger could make it do.
 *
 * It signs only a transaction of the Guard's shape (rule I3), in which its key appears nowhere but as
 * a verifier of the one Pull, never as the fee payer and never writable, so its signature cannot
 * authorise anything else; and only with a blockhash lifetime, so a co-signed transaction expires
 * within about a minute and a half.
 *
 * It only looks at a transaction the agent has already signed (M04): without the agent's key no one can
 * spend the agent's rate. The rate is kept in this process: with several machines, each keeps its own.
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

export type CosignConfig = {
  /** The Guard program. */
  program: Address;
  /** The verifier's key pair (Ed25519). */
  key: CryptoKeyPair;
  /** The verifier's address, the public half of `key`. */
  address: Address;
  /** The addresses each lookup table the transaction names holds. */
  loadTables: (tables: Address[]) => Promise<AddressesByLookupTableAddress>;
  /** Co-signed swaps one agent may have per minute (30 by default). */
  perMinute?: number;
  /** Lookup table reads at once (16 by default) and how long one may take (3 s); beyond either, 503. */
  maxTableLoads?: number;
  tableTimeoutMs?: number;
  now?: () => number;
};

export type Verdict =
  | { ok: true; transaction: Transaction; agent: Address }
  | { ok: false; status: number; reason: string };

const refuse = (reason: string, status = 400): Verdict => ({ ok: false, status, reason });

export function createCosigner(c: CosignConfig) {
  const perMinute = c.perMinute ?? 30;
  const now = c.now ?? Date.now;
  const recent = new Map<Address, number[]>();

  const maxTableLoads = c.maxTableLoads ?? 16;
  const tableTimeoutMs = c.tableTimeoutMs ?? 3_000;
  let tableLoads = 0;

  /** `agent`'s co-signed swaps in the last minute. */
  const recentOf = (agent: Address) => (recent.get(agent) ?? []).filter(x => now() - x < 60_000);
  /** Counts a co-signed swap of `agent`. */
  const count = (agent: Address) => {
    recent.set(agent, [...recentOf(agent), now()]);
    if (recent.size > 100_000) recent.clear(); // a bound on memory; the chain's limits still hold
  };
  /** The lookup tables, read at most `maxTableLoads` at once and each within `tableTimeoutMs`. */
  const tablesOf = async (tables: Address[]) => {
    if (tableLoads >= maxTableLoads) throw new Error('busy');
    tableLoads++;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        c.loadTables(tables),
        new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('timeout')), tableTimeoutMs); }),
      ]);
    } finally {
      clearTimeout(timer);
      tableLoads--;
    }
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
    // Only the agent can ask for its own swaps: the fee payer (the first account, never from a lookup
    // table) must have signed, and be within its rate, before anything is read for it. That it is the
    // agent of Pull is checked below.
    const payer = compiled.staticAccounts[0];
    const payerSignature = payer ? tx.signatures[payer] : null;
    let signedByPayer = false;
    try {
      signedByPayer = !!payerSignature && (await verifySignature(await getPublicKeyFromAddress(payer), payerSignature as SignatureBytes, tx.messageBytes));
    } catch {
      signedByPayer = false;
    }
    if (!signedByPayer) return refuse('the agent named in Pull must sign the transaction first', 401);
    if (recentOf(payer).length >= perMinute) return refuse('too many swaps from this agent in the last minute', 429);

    const lookups = 'addressTableLookups' in compiled ? (compiled.addressTableLookups ?? []) : [];
    let tables: AddressesByLookupTableAddress = {};
    if (lookups.length) {
      try {
        tables = await tablesOf(lookups.map(l => l.lookupTableAddress));
      } catch {
        return refuse('the lookup tables of the transaction could not be read now', 503);
      }
    }
    let message;
    try {
      message = decompileTransactionMessage(compiled, { addressesByLookupTableAddress: tables });
    } catch {
      return refuse('a lookup table of the transaction does not hold the addresses it names');
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

    // Again, now that it counts: other requests of this agent may have been co-signed meanwhile.
    if (recentOf(agent).length >= perMinute) return refuse('too many swaps from this agent in the last minute', 429);
    count(agent);
    try {
      return { ok: true, transaction: await partiallySignTransaction([c.key], tx), agent };
    } catch {
      return refuse('the verifier is not a signer of this transaction');
    }
  };
}

export const encodeTransaction = (tx: Transaction) => new Uint8Array(getTransactionEncoder().encode(tx));
