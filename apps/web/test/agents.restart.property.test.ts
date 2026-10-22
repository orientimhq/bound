/**
 * One instance (Fly, ORIENTIM_SINGLE_INSTANCE=1), fuzzed: swaps prepared and finalized in any order,
 * finalized again, and the server restarted at any point, which forgets everything it held in memory.
 *
 * - A ticket prepared before the last restart never gets a signature: 409 server-restarted, nothing sent.
 * - One prepared since is signed and sent once; finalized again, the same transaction, nothing more.
 * - A transaction already on chain is answered as sent after any number of restarts, never sent again.
 * - No transaction is ever sent twice, and every one sent was prepared in the start that sent it.
 *
 * `npm run test:fuzz` runs 2,000 sequences; ORIENTIM_FUZZ_RUNS and ORIENTIM_FUZZ_SEED set a shard.
 */
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { address, generateKeyPairSigner, getSignatureFromTransaction, getTransactionDecoder, getTransactionEncoder, partiallySignTransaction } from '@solana/kit';
import type { KeyPairSigner } from '@solana/kit';
import { WSOL_MINT } from '@orientimhq/swap/core';
import { ataOf } from '@orientim/builder';
import { DEX, fakeJupiter, fakeRpc, fundedAccounts, mint, POOL, tokenAccount, USDC, BONK } from '../../../packages/jupiter/test/fakes.ts';
import type { Account } from '../../../packages/jupiter/test/fakes.ts';
import { agentFinalize, agentPrepare } from '../lib/server/agent/api.ts';
import type { AgentDeps } from '../lib/server/agent/api.ts';
import { memoryShared } from '../lib/server/shared.ts';

const MODE = (import.meta as { env?: { MODE?: string } }).env?.MODE;
const RUNS = Number(process.env.ORIENTIM_FUZZ_RUNS ?? (MODE === 'fuzz' ? 2_000 : 10));
const SEED = process.env.ORIENTIM_FUZZ_SEED ? Number(process.env.ORIENTIM_FUZZ_SEED) : undefined;
const PARAMS = { numRuns: RUNS, ...(SEED !== undefined ? { seed: SEED } : {}) };
const TIMEOUT = 60_000 + RUNS * 3_000;

const KEY = 'ori_restart_property_key_000000001';
const TREASURY = address('9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM');
let n = 0;

const post = (path: string, body: unknown) => new Request(`http://orientim.test/api/v1/${path}?n=${++n}`, {
  method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${KEY}` }, body: JSON.stringify(body),
});

async function signAsWallet(W: KeyPairSigner, wire: string): Promise<string> {
  const signed = await partiallySignTransaction([W.keyPair], getTransactionDecoder().decode(Buffer.from(wire, 'base64')));
  return Buffer.from(getTransactionEncoder().encode(signed)).toString('base64');
}

type Step = { kind: 'prepare' } | { kind: 'finalize'; pick: number } | { kind: 'restart' };
const step: fc.Arbitrary<Step> = fc.oneof(
  { weight: 3, arbitrary: fc.constant({ kind: 'prepare' as const }) },
  { weight: 4, arbitrary: fc.record({ kind: fc.constant('finalize' as const), pick: fc.nat() }) },
  { weight: 1, arbitrary: fc.constant({ kind: 'restart' as const }) },
);

describe('one instance, restarted at any point', () => {
  it('signs only what this start prepared, sends each transaction once, and answers what landed', async () => {
    await fc.assert(fc.asyncProperty(fc.array(step, { minLength: 1, maxLength: 24 }), fc.boolean(), async (steps, lands) => {
      const accounts = new Map<string, Account>([
        [USDC, mint(6)], [WSOL_MINT, mint(9)], [BONK, mint(5)],
        [DEX, { owner: address('BPFLoaderUpgradeab1e11111111111111111111111'), data: new Uint8Array(36) }],
        [POOL, { owner: DEX, data: new Uint8Array(300) }],
        [await ataOf(TREASURY, USDC), tokenAccount(TREASURY, USDC)],
      ]);
      const sent: string[] = [];
      const statuses: NonNullable<NonNullable<Parameters<typeof fakeRpc>[1]>['statuses']> = new Map();
      const base: AgentDeps = {
        rpc: fakeRpc(accounts, { sent, statuses, landOnSend: lands }),
        jupiter: fakeJupiter(),
        secrets: [new Uint8Array(32).fill(5)],
        keys: new Map([[createHash('sha256').update(KEY).digest('hex'), 'restart']]),
        feeBps: 25n, treasury: TREASURY, excludeDexes: ['HumidiFi'], maxNetworkFeeLamports: 200_000n,
        disabled: false, v1: false, perMinute: 100_000, finalizePerMinute: 100_000, ipPerMinute: 100_000, totalPerMinute: 100_000, ownRoutes: true,
      };
      let start = 0;
      const startOf = () => ({ ...base, boot: `start-${String(start).padStart(4, '0')}`, shared: memoryShared() });
      let deps = startOf();
      const swaps: { ticket: string; signed: string; signature: string; start: number }[] = [];
      /** Signature → the start whose finalize sent it. */
      const sentIn = new Map<string, number>();
      for (const s of steps) {
        if (s.kind === 'restart') {
          start++;
          deps = startOf();
        } else if (s.kind === 'prepare') {
          // A wallet of its own: one wallet has one swap in flight at a time, which is another rule.
          const W = await generateKeyPairSigner();
          for (const [k, a] of await fundedAccounts(W.address, USDC)) accounts.set(k, a);
          const res = await agentPrepare(post('prepare', { owner: W.address, inputMint: USDC, outputMint: WSOL_MINT, amountIn: '1000000', minOut: '1' }), deps);
          expect(res.status).toBe(200);
          const p = await res.json() as { ticket: string; transaction: string };
          const signed = await signAsWallet(W, p.transaction);
          swaps.push({ ticket: p.ticket, signed, signature: getSignatureFromTransaction(getTransactionDecoder().decode(Buffer.from(signed, 'base64'))), start });
        } else if (swaps.length) {
          const swap = swaps[s.pick % swaps.length];
          const before = sent.length;
          const landed = statuses.get(swap.signature)?.err === null;
          const res = await agentFinalize(post('finalize', { ticket: swap.ticket, signedTransaction: swap.signed }), deps);
          const body = await res.json() as { status?: string; signature?: string; error?: { code: string } };
          if (landed) {
            // On chain: the same answer, whatever start it is, and nothing sent again.
            expect(res.status).toBe(200);
            expect(body).toMatchObject({ status: 'sent', signature: swap.signature });
            expect(sent.length).toBe(before);
          } else if (swap.start !== start) {
            expect(res.status).toBe(409);
            expect(body.error?.code).toBe('server-restarted');
            expect(sent.length).toBe(before);
          } else {
            expect(res.status).toBe(200);
            expect(body.signature).toBe(swap.signature);
            if (sent.length > before) sentIn.set(swap.signature, start);
          }
        }
      }
      const signatures = sent.map(w => getSignatureFromTransaction(getTransactionDecoder().decode(Buffer.from(w, 'base64'))));
      // A transaction that did not land may be sent again by a later finalize of the same start, never by another.
      if (lands) expect(new Set(signatures).size).toBe(signatures.length);
      for (const sig of signatures) {
        const swap = swaps.find(x => x.signature === sig)!;
        expect(sentIn.get(sig) ?? swap.start).toBe(swap.start);
      }
    }), PARAMS);
  }, TIMEOUT);
});
