/**
 * The SDK's one call, `swap()` (sdk/src/client.ts), against the Guard in litesvm: honest swaps land
 * and report what arrived; a swap the owner's rules forbid is refused before anything is sent, for the
 * same reason the chain would give; a verifier that changes the transaction or does not sign it is
 * caught before the agent signs; a route too large for one transaction is asked for again, smaller;
 * and the owner's one set-up transaction (`ownerSetup`) gives a new agent everything it needs.
 *
 *   node tests/guard/swap.ts
 */
import { AccountRole, generateKeyPairSigner, getAddressDecoder, getTransactionEncoder, signBytes } from '@solana/kit';
import type { Transaction } from '@solana/kit';
import { ataOf, createGuardClient, ownerSetup } from '@orientimhq/guard';
import type { Chain, GuardClient, JupiterRoute, RouteRequest, SwapRequest } from '@orientimhq/guard';
import { createCosigner } from '../../verifier/src/cosign.ts';
import { accountOf, deliver, lifetimeOf, requireProgram, send, sendOrThrow, sign, SOL, takeFrom } from './chain.ts';
import { guardBalances, guardInvariants, guardSetup, honest, ix, requireGuard, route } from './world.ts';
import type { GuardWorld } from './world.ts';

requireProgram();
requireGuard();

const g = await guardSetup();
const owner = g.W.address;
const AMOUNT = 100_000_000n;
const OUT = 10_000_000_000n;

let sends = 0;
const chain: Chain = {
  getAccounts: async list => list.map(a => {
    const acc = accountOf(g.svm, a);
    return acc ? { owner: acc.owner, data: acc.data } : null;
  }),
  latestBlockhash: async () => {
    g.svm.expireBlockhash();
    return lifetimeOf(g.svm);
  },
  now: async () => g.svm.getClock().unixTimestamp,
  send: async tx => {
    sends++;
    const r = send(g.svm, tx);
    return { ok: r.ok, error: r.error };
  },
};

/** A route as Jupiter's API would give it: the malicious program, behaving honestly, plus `extra` accounts. */
const routeOf = (w: GuardWorld, amount: bigint, out: bigint, extra = 0): JupiterRoute => {
  const decoder = getAddressDecoder();
  const padding = Array.from({ length: extra }, (_, i) => ({ address: decoder.decode(Uint8Array.from({ length: 32 }, (_, j) => (i * 7 + j * 13 + 1) % 251)), role: AccountRole.READONLY }));
  const r = route(w, [takeFrom(amount), deliver(out)], padding);
  return {
    inAmount: String(amount), outAmount: String(out), otherAmountThreshold: String(out), routePlan: [],
    setupInstructions: [], cleanupInstruction: null, otherInstructions: [], addressesByLookupTableAddress: null,
    swapInstruction: {
      programId: r.programAddress,
      accounts: (r.accounts ?? []).map(a => ({ pubkey: a.address, isSigner: a.role >= 2, isWritable: a.role % 2 === 1 })),
      data: Buffer.from(r.data ?? []).toString('base64'),
    },
  };
};

const verifier = createCosigner({
  program: g.guard, key: g.verifier.keyPair, address: g.verifier.address, loadTables: async () => ({}), perMinute: 1_000,
  simulate: async tx => {
    g.svm.withSigverify(false);
    try {
      const r = g.svm.simulateTransaction(tx) as { err?: () => unknown };
      return typeof r.err === 'function' ? { ok: false, error: String(r.err()) } : { ok: true };
    } finally {
      g.svm.withSigverify(true);
    }
  },
});
const honestVerifier = async (tx: Transaction) => {
  const v = await verifier(new Uint8Array(getTransactionEncoder().encode(tx)));
  if (!v.ok) throw new Error(v.reason);
  return v.transaction;
};

const routes: number[] = [];
const client = (o: Partial<GuardClient> = {}, w: GuardWorld = g) => createGuardClient({
  program: g.guard, owner, agent: w.agent, chain,
  verifiers: [{ address: g.verifier.address, cosign: honestVerifier }],
  route: async (r: RouteRequest) => {
    routes.push(r.maxAccounts);
    return routeOf(w, r.amount, OUT);
  },
  ...o,
});

const results: string[] = [];
let failed = 0;
const check = (id: string, what: string, ok: boolean, detail: string) => {
  results.push(`${ok ? 'OK  ' : 'FAIL'} ${id} ${what}: ${detail}`);
  if (!ok) failed++;
};
const refusedBefore = async (id: string, what: string, c: ReturnType<typeof client>, stage: string, expect: RegExp, o: Partial<SwapRequest> = {}) => {
  const n = sends;
  const r = await c.swap({ mintIn: g.mintIn, mintOut: g.mintOut, amount: AMOUNT, ...o });
  check(id, what, !r.ok && r.stage === stage && expect.test(r.reason) && sends === n, r.ok ? 'it swapped' : `${r.stage}: ${r.reason}${sends === n ? '' : ' (and sent)'}`);
};

// S01: one call swaps, the promise holds, and the result says what arrived.
{
  const before = guardBalances(g);
  const r = await client().swap({ mintIn: g.mintIn, mintOut: g.mintOut, amount: AMOUNT });
  const broken = guardInvariants(before, guardBalances(g), r.ok, AMOUNT, OUT);
  check('S01', 'swap() in one call: route, Pull/Settle, the verifier, the agent\'s signature, the chain', r.ok && r.arrived === OUT && r.fee === AMOUNT / 400n && !broken.length,
    r.ok ? `arrived ${r.arrived}, fee ${r.fee} ${broken.join('; ')}` : `${r.stage}: ${r.reason}`);
}

// S02–S04: the owner's rules, read before anything is sent.
await refusedBefore('S02', 'above the limit per swap', client(), 'rules', /limit per swap/, { amount: 201_000_000n });
await refusedBefore('S03', 'an output mint the owner did not allow', client(), 'rules', /output mint/, { mintOut: g.mintOther });
sendOrThrow(g.svm, await sign(g.svm, [ix.updatePolicy(g, owner, true, [g.verifier.address], [g.attackerProgram])], g.W), 'pause');
await refusedBefore('S04', 'the owner paused the policy', client(), 'rules', /paused/);
sendOrThrow(g.svm, await sign(g.svm, [ix.updatePolicy(g, owner, false, [g.verifier.address], [g.attackerProgram])], g.W), 'resume');

// S05–S07: a verifier that changes the swap, does not sign, or forges a signature; the agent never signs.
await refusedBefore('S05', 'a verifier that returns a changed transaction (signed by it)', client({
  verifiers: [{
    address: g.verifier.address,
    cosign: async tx => {
      const bytes = new Uint8Array(tx.messageBytes);
      bytes[bytes.length - 2] ^= 1;
      const signature = await signBytes(g.verifier.keyPair.privateKey, bytes);
      return { messageBytes: bytes as unknown as Transaction['messageBytes'], signatures: { ...tx.signatures, [g.verifier.address]: signature } } as Transaction;
    },
  }],
}), 'verifier', /different transaction/);
await refusedBefore('S06', 'a verifier that returns the transaction unsigned', client({ verifiers: [{ address: g.verifier.address, cosign: async tx => tx }] }), 'verifier', /did not sign/);
await refusedBefore('S07', 'a verifier with a forged signature', client({
  verifiers: [{ address: g.verifier.address, cosign: async tx => ({ ...tx, signatures: { ...tx.signatures, [g.verifier.address]: new Uint8Array(64).fill(7) } }) as Transaction }],
}), 'verifier', /did not sign/);
await refusedBefore('S08', 'a priority fee above the agent\'s cap', client({ microLamportsPerUnit: 5_000_000n }), 'rules', /priority fee/);
await refusedBefore('S09', 'a verifier the owner never named', client({ verifiers: [{ address: (await generateKeyPairSigner()).address, cosign: honestVerifier }] }), 'rules', /not in the owner's policy/);

// S10: a route too large for one transaction is asked for again with fewer accounts.
{
  routes.length = 0;
  let calls = 0;
  const r = await client({
    route: async q => {
      routes.push(q.maxAccounts);
      return routeOf(g, q.amount, OUT, calls++ === 0 ? 40 : 0);
    },
  }).swap({ mintIn: g.mintIn, mintOut: g.mintOut, amount: AMOUNT });
  check('S10', 'a route above 1232 bytes is asked for again, smaller', r.ok && routes.join(',') === '40,28', `asked ${routes.join(', ')}; ${r.ok ? 'swapped' : r.reason}`);
}

// S11: the daily limit (500 a day, the fee included): swaps until swap() says no, and the chain agrees.
{
  let n = 0;
  let last: Awaited<ReturnType<ReturnType<typeof client>['swap']>> | null = null;
  while (n < 10) {
    last = await client().swap({ mintIn: g.mintIn, mintOut: g.mintOut, amount: AMOUNT });
    if (!last.ok) break;
    n++;
  }
  // So far 2 swaps (S01, S10) of 100.25 each; 4 in all fit in 500, the fifth does not.
  const chainSays = send(g.svm, await sign(g.svm, [ix.pull(g, AMOUNT, OUT), honest(g, AMOUNT, OUT), ix.settle(g)], g.agent, [g.verifier]));
  check('S11', 'the daily limit: swap() refuses the fifth swap of the day before sending, as the chain does',
    n === 2 && last !== null && !last.ok && last.stage === 'rules' && /daily limit/.test(last.reason) && !chainSays.ok && /0xc$/.test(chainSays.error),
    `${n} more swaps, then ${last && !last.ok ? last.reason : 'no refusal'}; the chain: ${chainSays.ok ? 'allowed' : chainSays.error}`);
}

// S12: a new agent, set up by the owner's one transaction from ownerSetup(), swaps at once.
{
  const agent2 = await generateKeyPairSigner();
  const ixs = await ownerSetup({
    program: g.guard, owner, agent: agent2.address, verifiers: [g.verifier.address], programs: [g.attackerProgram], policyExists: true,
    rules: { limits: [{ mint: g.mintIn, perSwap: 200_000_000n, perDay: 500_000_000n }], outputs: [g.mintOut] },
    budgets: [{ mint: g.mintIn, amount: 300_000_000n, tokenProgram: g.tokenProgram }],
    outputTokenPrograms: { [g.mintOut]: g.tokenProgram }, agentLamports: SOL / 100n,
  });
  const setupResult = send(g.svm, await sign(g.svm, ixs, g.W));
  const w2: GuardWorld = { ...g, agent: agent2, hopper: await ataOf(agent2.address, g.mintIn, g.tokenProgram) };
  const r = setupResult.ok ? await client({}, w2).swap({ mintIn: g.mintIn, mintOut: g.mintOut, amount: AMOUNT }) : null;
  const funded = BigInt(g.svm.getBalance(agent2.address) ?? 0n);
  check('S12', 'ownerSetup(): one owner transaction, then the new agent swaps (paying its own fees)', setupResult.ok && !!r?.ok && funded > 0n && funded < SOL / 100n,
    !setupResult.ok ? `set-up failed: ${setupResult.error}` : r?.ok ? `swapped; the agent has ${funded} lamports left of 0.01 SOL` : `${r?.stage}: ${r?.reason}`);
}

console.log(results.join('\n'));
console.log(failed ? `${failed} of ${results.length} swap() cases failed` : `all ${results.length} swap() cases passed`);
process.exit(failed ? 1 : 0);
