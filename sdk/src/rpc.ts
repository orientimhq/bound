/** `swap()`'s view of the chain through an RPC node (Helius or any other). */
import { createSolanaRpc, getBase64EncodedWireTransaction, getSignatureFromTransaction } from '@solana/kit';
import type { Address, Transaction } from '@solana/kit';
import type { AccountData, Chain } from './client.ts';

const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

export function rpcChain(url: string, o: { commitment?: 'confirmed' | 'finalized'; pollMs?: number } = {}): Chain {
  const rpc = createSolanaRpc(url);
  const commitment = o.commitment ?? 'confirmed';
  let validUntil = 0n;
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
      validUntil = value.lastValidBlockHeight;
      return value;
    },
    async now() {
      const slot = await rpc.getSlot({ commitment: 'finalized' }).send();
      const time = await rpc.getBlockTime(slot).send().catch(() => null);
      return time === null ? BigInt(Math.floor(Date.now() / 1000)) : BigInt(time);
    },
    async send(tx: Transaction) {
      const signature = getSignatureFromTransaction(tx);
      await rpc.sendTransaction(getBase64EncodedWireTransaction(tx), { encoding: 'base64', preflightCommitment: commitment }).send();
      for (;;) {
        const { value } = await rpc.getSignatureStatuses([signature]).send();
        const status = value[0];
        if (status?.err) return { ok: false, error: JSON.stringify(status.err, (_, v) => (typeof v === 'bigint' ? String(v) : v)) };
        if (status && (status.confirmationStatus === commitment || status.confirmationStatus === 'finalized')) return { ok: true };
        if (validUntil && (await rpc.getBlockHeight({ commitment }).send()) > validUntil) return { ok: false, error: 'the transaction expired before it landed' };
        await pause(o.pollMs ?? 800);
      }
    },
  };
}
