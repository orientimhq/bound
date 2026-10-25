/** `swap()`'s view of the chain through an RPC node (Helius or any other). */
import { createSolanaRpc, getBase64EncodedWireTransaction, getSignatureFromTransaction } from '@solana/kit';
import type { Address, Transaction } from '@solana/kit';
import type { AccountData, Chain } from './client.ts';

const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
/** A blockhash lives about 150 blocks. */
const BLOCKHASH_LIFE = 151n;

/** A failed transaction's error as the logs would say it: "instruction 1: custom program error: 0xc". */
export function describeTransactionError(err: unknown): string {
  const ie = (err as { InstructionError?: [number, unknown] } | null)?.InstructionError;
  if (ie) {
    const [index, inner] = ie;
    const custom = (inner as { Custom?: number | bigint } | null)?.Custom;
    return `instruction ${index}: ${custom === undefined ? JSON.stringify(inner) : `custom program error: 0x${Number(custom).toString(16)}`}`;
  }
  return typeof err === 'string' ? err : JSON.stringify(err, (_, v) => (typeof v === 'bigint' ? String(v) : v));
}

/**
 * Sends without the node's own simulation (preflight) by default: nothing is simulated anywhere. The
 * program enforces the owner's rules when the swap lands, and a simulation only adds a round trip in
 * which a fast-moving price can refuse a good swap. A swap that fails on chain costs the agent its
 * network fee; `skipPreflight: false` asks the node to simulate first, to save that fee.
 *
 * Once sent, `send` answers confirmed, failed (with the program's error), expired (never seen and its
 * blockhash past its life), or `unknown`: the node could not say within `confirmTimeoutMs` (3 minutes).
 * An unknown swap may have landed: look its signature up, never rebuild it.
 */
export function rpcChain(
  url: string,
  o: { commitment?: 'confirmed' | 'finalized'; pollMs?: number; skipPreflight?: boolean; confirmTimeoutMs?: number } = {},
): Chain {
  const rpc = createSolanaRpc(url);
  const commitment = o.commitment ?? 'confirmed';
  return {
    async getAccounts(addresses: Address[]): Promise<AccountData[]> {
      const out: AccountData[] = [];
      for (let i = 0; i < addresses.length; i += 100) {
        const { value } = await rpc.getMultipleAccounts(addresses.slice(i, i + 100), { encoding: 'base64', commitment }).send();
        for (const a of value) out.push(a ? { owner: a.owner, data: Uint8Array.from(Buffer.from(a.data[0], 'base64')) } : null);
      }
      return out;
    },
    async latestBlockhash() {
      const { value } = await rpc.getLatestBlockhash({ commitment }).send();
      return value;
    },
    async now() {
      const slot = await rpc.getSlot({ commitment: 'finalized' }).send();
      const time = await rpc.getBlockTime(slot).send().catch(() => null);
      return time === null ? BigInt(Math.floor(Date.now() / 1000)) : BigInt(time);
    },
    async send(tx: Transaction) {
      const signature = getSignatureFromTransaction(tx);
      const height = () => rpc.getBlockHeight({ commitment }).send();
      const statusOf = async (history: boolean) => (await rpc.getSignatureStatuses([signature], { searchTransactionHistory: history }).send()).value[0];
      const settled = (s: Awaited<ReturnType<typeof statusOf>>) =>
        s?.err ? { ok: false, error: describeTransactionError(s.err) }
          : s && (s.confirmationStatus === commitment || s.confirmationStatus === 'finalized') ? { ok: true } : null;
      // This transaction's own lifetime: until its blockhash expires it may still land.
      // Without it (or with 0), about 150 blocks from now, the longest any blockhash lives.
      const lifetime = 'lifetimeConstraint' in tx ? (tx.lifetimeConstraint as { lastValidBlockHeight?: bigint }) : {};
      let validUntil: bigint;
      try {
        validUntil = lifetime.lastValidBlockHeight || (await height()) + BLOCKHASH_LIFE;
      } catch (e) {
        return { ok: false, error: `the RPC node could not be read, nothing was sent: ${(e as Error).message}` };
      }
      try {
        await rpc.sendTransaction(getBase64EncodedWireTransaction(tx), { encoding: 'base64', preflightCommitment: commitment, skipPreflight: o.skipPreflight ?? true }).send();
      } catch (e) {
        // The node answered with an error (JSON-RPC -32xxx: a preflight that failed, a malformed or
        // unverifiable transaction): it never reached the chain. Any other error (a timeout, a dropped
        // connection) says nothing: the node may have taken it, so the signature is watched below.
        const err = e as Error & { context?: { __code?: number; logs?: string[] } };
        const code = err.context?.__code;
        if (typeof code === 'number' && code <= -32_000 && code >= -32_768) {
          const logs = err.context?.logs ?? [];
          return { ok: false, error: [...logs].reverse().find(l => /failed|error/i.test(l)) ?? err.message };
        }
      }
      // From here the transaction may be on the chain. An answer that cannot be settled is `unknown`,
      // never a failure: rebuilding the swap with a new blockhash could make a second one (U01). The
      // node going away for a while is waited out, up to the deadline.
      const deadline = Date.now() + (o.confirmTimeoutMs ?? 180_000);
      let seen = false;
      let failures = 0;
      for (;;) {
        try {
          const status = await statusOf(false);
          const done = settled(status);
          if (done) return done;
          if (status) seen = true;
          else if ((await height()) > validUntil) {
            // Past its blockhash's life: one more look, the whole history, after reading the height.
            const last = await statusOf(true);
            const late = settled(last);
            if (late) return late;
            // Seen processed and still there (or gone again): it may yet confirm, or has left with a
            // dropped fork. Only a transaction never seen is known not to have landed (U02).
            if (!(last || seen)) return { ok: false, error: 'the transaction expired before it landed' };
          }
          failures = 0;
        } catch {
          failures++;
        }
        if (Date.now() > deadline) {
          return { ok: false, unknown: true, error: `could not tell whether transaction ${signature} landed: look it up before trying again` };
        }
        await pause((o.pollMs ?? 800) * 2 ** Math.min(failures, 3));
      }
    },
    async received(signature: string, account: Address) {
      const tx = await rpc
        .getTransaction(signature as Parameters<typeof rpc.getTransaction>[0], { commitment, encoding: 'json', maxSupportedTransactionVersion: 0 })
        .send()
        .catch(() => null);
      if (!tx?.meta) return null;
      const keys = [...tx.transaction.message.accountKeys, ...(tx.meta.loadedAddresses?.writable ?? []), ...(tx.meta.loadedAddresses?.readonly ?? [])];
      const at = keys.indexOf(account);
      if (at < 0) return null;
      const of = (list: readonly { accountIndex: number; uiTokenAmount: { amount: string } }[] | undefined) =>
        BigInt(list?.find(b => b.accountIndex === at)?.uiTokenAmount.amount ?? '0');
      return of(tx.meta.postTokenBalances) - of(tx.meta.preTokenBalances);
    },
  };
}
