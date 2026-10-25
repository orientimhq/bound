/**
 * Orientim's verifier (verifier/src), against the Guard in litesvm: what it co-signs, what it refuses
 * and why, and the whole path an agent takes through the SDK (route, Pull and Settle around it, the
 * verifier over HTTP, the agent's signature, the chain).
 *
 *   node tests/guard/verifier.ts
 */
import { compileTransaction, createTransactionMessage, appendTransactionMessageInstructions, generateKeyPairSigner, getTransactionEncoder, partiallySignTransaction, pipe, setTransactionMessageFeePayer, setTransactionMessageLifetimeUsingBlockhash } from '@solana/kit';
import type { Address, Instruction, Transaction } from '@solana/kit';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { compileGuardedSwap, guardedSwap, requestCosign } from '../../sdk/src/index.ts';
import type { ApiInstruction, JupiterRoute } from '../../sdk/src/index.ts';
import { createCosigner } from '../../verifier/src/cosign.ts';
import { handler } from '../../verifier/src/server.ts';
import { deliver, lifetimeOf, requireProgram, send, takeFrom } from './chain.ts';
import { guardBalances, guardInvariants, guardSetup, honest, ix, pullAccounts, requireGuard, route } from './world.ts';
import type { GuardWorld } from './world.ts';

requireProgram();
requireGuard();

const AMOUNT = 100_000_000n;
const MIN_OUT = 10_000_000_000n;

const g = await guardSetup();
const stranger = await generateKeyPairSigner();

const simulate = (w: GuardWorld) => async (tx: Transaction) => {
  w.svm.withSigverify(false);
  try {
    const r = w.svm.simulateTransaction(tx) as { err?: () => unknown; meta?: () => { logs: () => string[] } };
    if (typeof r.err !== 'function') return { ok: true };
    return { ok: false, error: String(r.err()), logs: r.meta?.().logs() ?? [] };
  } finally {
    w.svm.withSigverify(true);
  }
};
let clock = 0;
const cosigner = (perMinute = 1_000) => createCosigner({
  program: g.guard, key: g.verifier.keyPair, address: g.verifier.address,
  loadTables: async () => ({}), simulate: simulate(g), perMinute, now: () => clock,
});
const cosign = cosigner();

const unsigned = (ixs: Instruction[], payer: Address = g.agent.address): Transaction => compileTransaction(pipe(
  createTransactionMessage({ version: 0 }),
  m => setTransactionMessageFeePayer(payer, m),
  m => setTransactionMessageLifetimeUsingBlockhash(lifetimeOf(g.svm), m),
  m => appendTransactionMessageInstructions(ixs, m),
));
/** As the agent sends it to the verifier: signed by the agent. */
const byAgent = (ixs: Instruction[], payer?: Address) => partiallySignTransaction([g.agent.keyPair], unsigned(ixs, payer));
const wire = async (tx: Transaction | Promise<Transaction>) => new Uint8Array(getTransactionEncoder().encode(await tx));
const swap = (r = honest(g, AMOUNT, MIN_OUT)) => [ix.pull(g, AMOUNT, MIN_OUT), r, ix.settle(g)];

const results: string[] = [];
let failed = 0;
const check = (id: string, what: string, ok: boolean, detail: string) => {
  results.push(`${ok ? 'OK  ' : 'FAIL'} ${id} ${what}: ${detail}`);
  if (!ok) failed++;
};
const refused = async (id: string, what: string, tx: Uint8Array | Promise<Uint8Array>, expect: RegExp, status = 400) => {
  const v = await cosign(await tx);
  check(id, what, !v.ok && v.status === status && expect.test(v.reason), v.ok ? 'co-signed' : `${v.status} ${v.reason}`);
};

// V01: an honest swap is co-signed; with the agent's signature added, the chain takes it.
{
  g.svm.expireBlockhash();
  const v = await cosign(await wire(byAgent(swap())));
  if (!v.ok) check('V01', 'an honest swap is co-signed and lands', false, v.reason);
  else {
    const before = guardBalances(g);
    const r = send(g.svm, await partiallySignTransaction([g.agent.keyPair], v.transaction));
    const broken = guardInvariants(before, guardBalances(g), r.ok, AMOUNT, MIN_OUT);
    check('V01', 'an honest swap is co-signed and lands', r.ok && !broken.length, r.ok ? broken.join('; ') || 'landed' : r.error);
  }
}

g.svm.expireBlockhash();
await refused('V02', 'the route delivers less than the minimum: the simulation fails', wire(byAgent(swap(honest(g, AMOUNT, MIN_OUT - 1n)))), /fails on chain/, 422);
await refused('V03', 'pull without settle', wire(byAgent([ix.pull(g, AMOUNT, MIN_OUT), honest(g, AMOUNT, MIN_OUT)])), /Settle/);
await refused('V04', 'something after settle', wire(byAgent([...swap(), route(g, [takeFrom(1n)])])), /Settle/);
await refused('V05', 'something before pull', wire(byAgent([route(g, [deliver(1n)]), ...swap()])), /Pull/);
await refused('V06', 'two pulls', wire(byAgent([ix.pull(g, AMOUNT, MIN_OUT), ...swap()])), /between Pull and Settle/);
await refused('V07', 'the verifier\'s key also signs inside the route',
  wire(byAgent(swap(route(g, [takeFrom(AMOUNT), deliver(MIN_OUT)], [{ address: g.verifier.address, role: 2 }])))), /outside Pull/);
await refused('V08', 'the verifier\'s key as a writable account of the route',
  wire(byAgent(swap(route(g, [takeFrom(AMOUNT), deliver(MIN_OUT)], [g.verifier.address])))), /outside Pull/);
await refused('V09', 'the verifier pays for the transaction', wire(byAgent(swap(), g.verifier.address)), /agent named in Pull must pay/);
await refused('V10', 'another verifier named in Pull', wire(byAgent([ix.pull(g, AMOUNT, MIN_OUT, { verifier: stranger.address }), honest(g, AMOUNT, MIN_OUT), ix.settle(g)])), /not named/);
await refused('V11', 'not a transaction', Uint8Array.of(1, 2, 3), /not a Solana transaction/);
await refused('V12', 'larger than 1232 bytes', new Uint8Array(1300), /1232/);

// V13: a rate per agent.
{
  const limited = cosigner(2);
  const tx = await wire(byAgent(swap()));
  const verdicts = [await limited(tx), await limited(tx), await limited(tx)];
  clock += 61_000;
  const later = await limited(tx);
  const third = verdicts[2];
  check('V13', 'a third swap in a minute is refused, and allowed again a minute later',
    verdicts[0].ok && verdicts[1].ok && !third.ok && third.status === 429 && later.ok, verdicts.map(v => (v.ok ? 'signed' : v.status)).join(', ') + `, later ${later.ok ? 'signed' : 'refused'}`);
}

// V17 and V18 (M04): a transaction the agent has not signed is refused before the rate, so a stranger
// who knows the agent's address can neither spend its rate nor make the verifier simulate.
{
  const limited = cosigner(1);
  const notSigned = await wire(unsigned(swap()));
  const strangers = [await limited(notSigned), await limited(notSigned), await limited(notSigned)];
  const forged = await wire(partiallySignTransaction([stranger.keyPair], unsigned([ix.pull(g, AMOUNT, MIN_OUT), honest(g, AMOUNT, MIN_OUT), ix.settle(g)], stranger.address)));
  const forgedVerdict = await limited(forged);
  check('V17', 'a transaction without the agent\'s signature is refused (401)', strangers.every(v => !v.ok && v.status === 401),
    strangers.map(v => (v.ok ? 'signed' : `${v.status} ${v.reason}`)).join('; '));
  clock += 61_000;
  const own = await limited(await wire(byAgent(swap())));
  check('V18', 'after strangers\' requests, the agent\'s own swap still has its rate', own.ok && !forgedVerdict.ok, own.ok ? 'co-signed' : `${own.status} ${own.reason}`);
}

// V14: the agent's whole path through the SDK: a route shaped as Jupiter's answer, the guarded swap,
// the verifier over HTTP, the agent's signature, the chain.
{
  const server = createServer(handler(cosign));
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const r = honest(g, AMOUNT, MIN_OUT);
    const api: ApiInstruction = {
      programId: r.programAddress,
      accounts: (r.accounts ?? []).map(a => ({ pubkey: a.address, isSigner: a.role >= 2, isWritable: a.role % 2 === 1 })),
      data: Buffer.from(r.data ?? []).toString('base64'),
    };
    const jupiter: JupiterRoute = {
      inAmount: String(AMOUNT), outAmount: String(MIN_OUT), otherAmountThreshold: String(MIN_OUT), routePlan: [],
      setupInstructions: [], swapInstruction: api, cleanupInstruction: null, otherInstructions: [], addressesByLookupTableAddress: null,
    };
    g.svm.expireBlockhash();
    const built = guardedSwap({ accounts: pullAccounts(g), amount: AMOUNT, route: jupiter, computeUnits: 400_000 });
    const tx = compileGuardedSwap(built, g.agent.address, lifetimeOf(g.svm));
    const before = guardBalances(g);
    const cosigned = await requestCosign(url, await partiallySignTransaction([g.agent.keyPair], tx));
    const landed = send(g.svm, await partiallySignTransaction([g.agent.keyPair], cosigned));
    const broken = guardInvariants(before, guardBalances(g), landed.ok, AMOUNT, MIN_OUT);
    check('V14', 'SDK route → guarded swap → verifier over HTTP → agent signs → chain', landed.ok && !broken.length, landed.ok ? broken.join('; ') || 'landed' : landed.error);

    const bad = await fetch(`${url}/v1/cosign`, { method: 'POST', body: '{"transaction": 5}' });
    check('V15', 'the HTTP service refuses a malformed request', bad.status === 400, String(bad.status));
    const refusedOverHttp = await requestCosign(url, compileTransaction(pipe(
      createTransactionMessage({ version: 0 }), m => setTransactionMessageFeePayer(g.agent.address, m),
      m => setTransactionMessageLifetimeUsingBlockhash(lifetimeOf(g.svm), m),
      m => appendTransactionMessageInstructions([ix.pull(g, AMOUNT, MIN_OUT), honest(g, AMOUNT, MIN_OUT)], m),
    ))).then(() => 'co-signed', (e: Error) => e.message);
    check('V16', 'the SDK reports the verifier\'s reason', /Settle/.test(refusedOverHttp), refusedOverHttp);
  } finally {
    server.close();
  }
}

console.log(results.join('\n'));
console.log(failed ? `${failed} of ${results.length} verifier cases failed` : `all ${results.length} verifier cases passed`);
process.exit(failed ? 1 : 0);
