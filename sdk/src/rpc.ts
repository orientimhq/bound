/** `swap()`'s view of the chain through an RPC node (Helius or any other). */
import { createSolanaRpc, getBase64EncodedWireTransaction, getSignatureFromTransaction } from '@solana/kit';
import type { Address, Transaction } from '@solana/kit';
import type { AccountData, Chain } from './client.ts';

const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

export function rpcChain(url: string, o: { commitment?: 'confirmed' | 'finalized'; pollMs?: number } = {}): Chain {
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
      // This transaction's own lifetime: until its blockhash expires it may still land.
      const lifetime = 'lifetimeConstraint' in tx ? (tx.lifetimeConstraint as { lastValidBlockHeight?: bigint }) : {};
      const validUntil = lifetime.lastValidBlockHeight ?? 0n;
      try {
        await rpc.sendTransaction(getBase64EncodedWireTransaction(tx), { encoding: 'base64', preflightCommitment: commitment }).send();
      } catch (e) {
        // Refused in the node's own simulation (preflight, with its logs): it never reached the chain.
        // Any other error (a timeout, a dropped connection) says nothing: the node may have taken it, so
        // the signature is watched until the blockhash expires, and a retry never makes a second swap.
        const err = e as Error & { context?: { logs?: string[] } };
        const logs = err.context?.logs ?? [];
        if (logs.length) return { ok: false, error: [...logs].reverse().find(l => /failed|error/i.test(l)) ?? err.message };
        if (!validUntil) return { ok: false, error: `unknown whether the transaction reached the chain: ${err.message}` };
      }
      for (;;) {
        const { value } = await rpc.getSignatureStatuses([signature]).send();
        const status = value[0];
        if (status?.err) return { ok: false, error: JSON.stringify(status.err, (_, v) => (typeof v === 'bigint' ? String(v) : v)) };
        if (status && (status.confirmationStatus === commitment || status.confirmationStatus === 'finalized')) return { ok: true };
        if (validUntil && (await rpc.getBlockHeight({ commitment }).send()) > validUntil) return { ok: false, error: 'the transaction expired before it landed' };
        await pause(o.pollMs ?? 800);
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
