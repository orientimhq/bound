/**
 * Orientim Guard end to end on a real chain (a local solana-test-validator in CI, by
 * .github/workflows/guard-local-chain.yml, or devnet by hand with a funded key): the program and a test
 * swap program deployed, test tokens, the owner's one set-up transaction from the
 * SDK, Orientim's verifier serving over HTTP and simulating against devnet, and the agent's swaps
 * through `swap()` and an RPC node, with real confirmations and blockhashes. Then the refusals, each
 * both ways: `swap()` refuses before sending, and the chain refuses the same swap sent anyway.
 *
 * Jupiter is not on devnet, so the route is the test swap program (tests/guard/attacker), honest: it
 * takes the amount from the agent's hopper and pays from its own pool at a fixed rate.
 *
 *   RPC_URL=… GUARD_PROGRAM=… SWAP_PROGRAM=… PAYER_KEYPAIR=path/to/keypair.json node tests/guard/devnet.ts
 *
 * No real funds: every key is made for the run, the tokens are worthless test mints.
 */
import {
  AccountRole, appendTransactionMessageInstructions, compileTransaction, createKeyPairSignerFromBytes, createSolanaRpc,
  createTransactionMessage, fetchAddressesForLookupTables, generateKeyPairSigner, getProgramDerivedAddress, pipe,
  setTransactionMessageFeePayer, setTransactionMessageLifetimeUsingBlockhash, signTransaction,
} from '@solana/kit';
import type { Address, Instruction, KeyPairSigner } from '@solana/kit';
import { getCreateAccountInstruction } from '@solana-program/system';
import { getInitializeMint2Instruction, getMintToInstruction } from '@solana-program/token';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  accountsFor, ataOf, createAtaIdempotent, createGuardClient, decodeTokenAccount, ownerSetup, ownerSetupTransactions, policyOf, pull, revoke, rpcChain, settle,
  TOKEN_PROGRAM, updatePolicy,
} from '@orientimhq/guard';
import type { JupiterRoute, RouteRequest, SwapResult } from '@orientimhq/guard';
import { createCosigner } from '../../verifier/src/cosign.ts';
import { handler, rpcSimulator } from '../../verifier/src/server.ts';
import { attackerData, deliver, takeFrom } from './chain.ts';

const need = (name: string) => {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is not set`);
  return v as Address;
};
const RPC_URL = need('RPC_URL');
const GUARD = need('GUARD_PROGRAM');
const SWAP = need('SWAP_PROGRAM');
const rpc = createSolanaRpc(RPC_URL);
const chain = rpcChain(RPC_URL);
const NET = process.env.CHAIN_NAME ?? 'devnet';
const explorer = (sig: string) => (NET === 'devnet' ? `https://explorer.solana.com/tx/${sig}?cluster=devnet` : sig);

const payer = await createKeyPairSignerFromBytes(Uint8Array.from(JSON.parse(readFileSync(need('PAYER_KEYPAIR'), 'utf8'))));
const [owner, agent, verifier, pool, mintInKey, mintOutKey] = await Promise.all(Array.from({ length: 6 }, () => generateKeyPairSigner()));
const DEC_IN = 6;
const DEC_OUT = 9;
const UNIT_IN = 10n ** BigInt(DEC_IN);
/** The test pool's fixed rate: 1 input token buys 0.006 of the output (about 160 USDC a SOL). */
const rate = (amountIn: bigint) => (amountIn * 6n * 10n ** BigInt(DEC_OUT)) / (1000n * UNIT_IN);

async function send(ixs: Instruction[], feePayer: KeyPairSigner, others: KeyPairSigner[] = [], what = '') {
  const tx = await signTransaction([feePayer.keyPair, ...others.map(s => s.keyPair)], compileTransaction(pipe(
    createTransactionMessage({ version: 0 }),
    m => setTransactionMessageFeePayer(feePayer.address, m),
    m => setTransactionMessageLifetimeUsingBlockhash(lifetime, m),
    m => appendTransactionMessageInstructions(ixs, m),
  )));
  const r = await chain.send(tx);
  if (what && !r.ok) throw new Error(`${what} failed: ${r.error}`);
  return r;
}
let lifetime = await chain.latestBlockhash();
const fresh = async () => {
  lifetime = await chain.latestBlockhash();
};

const lines: string[] = [];
let failed = 0;
const check = (id: string, what: string, ok: boolean, detail: string) => {
  lines.push(`| ${id} | ${what} | ${ok ? 'OK' : '**FAIL**'} | ${detail.replaceAll('|', '/')} |`);
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${id} ${what}: ${detail}`);
  if (!ok) failed++;
};

// ---------------------------------------------------------------- the world: test mints and the pool

const mintIn = mintInKey.address;
const mintOut = mintOutKey.address;
const [vaultAuthority] = await getProgramDerivedAddress({ programAddress: SWAP, seeds: [new TextEncoder().encode('attacker')] });
const poolIn = await ataOf(pool.address, mintIn);
const vaultOut = await ataOf(vaultAuthority, mintOut);
const ownerIn = await ataOf(owner.address, mintIn);
const rent = await rpc.getMinimumBalanceForRentExemption(82n).send();

await send([
  getCreateAccountInstruction({ payer, newAccount: mintInKey, lamports: rent, space: 82n, programAddress: TOKEN_PROGRAM }),
  getInitializeMint2Instruction({ mint: mintIn, decimals: DEC_IN, mintAuthority: payer.address, freezeAuthority: null }),
  getCreateAccountInstruction({ payer, newAccount: mintOutKey, lamports: rent, space: 82n, programAddress: TOKEN_PROGRAM }),
  getInitializeMint2Instruction({ mint: mintOut, decimals: DEC_OUT, mintAuthority: payer.address, freezeAuthority: null }),
  createAtaIdempotent(payer.address, ownerIn, owner.address, mintIn, TOKEN_PROGRAM),
  createAtaIdempotent(payer.address, poolIn, pool.address, mintIn, TOKEN_PROGRAM),
  createAtaIdempotent(payer.address, vaultOut, vaultAuthority, mintOut, TOKEN_PROGRAM),
  getMintToInstruction({ mint: mintIn, token: ownerIn, mintAuthority: payer, amount: 1_000n * UNIT_IN }),
  getMintToInstruction({ mint: mintOut, token: vaultOut, mintAuthority: payer, amount: 1_000_000n * 10n ** BigInt(DEC_OUT) }),
  { programAddress: '11111111111111111111111111111111' as Address, accounts: [{ address: payer.address, role: AccountRole.WRITABLE_SIGNER }, { address: owner.address, role: AccountRole.WRITABLE }], data: Uint8Array.from([2, 0, 0, 0, ...new Uint8Array(new BigUint64Array([200_000_000n]).buffer)]) },
], payer, [mintInKey, mintOutKey], 'the test mints and the pool');

// ---------------------------------------------------------------- the owner's one set-up transaction

const PER_SWAP = 100n * UNIT_IN;
const PER_DAY = 250n * UNIT_IN;
await fresh();
const setupTxs = ownerSetupTransactions(await ownerSetup({
  program: GUARD, owner: owner.address, agent: agent.address, verifiers: [verifier.address], programs: [SWAP],
  rules: { limits: [{ mint: mintIn, perSwap: PER_SWAP, perDay: PER_DAY }], outputs: [mintOut] },
  budgets: [{ mint: mintIn, amount: 1_000n * UNIT_IN }], agentLamports: 20_000_000n,
}), owner.address, lifetime);
// One wallet approval signs them all (signAllTransactions); they are sent in order.
let setup: { ok: boolean; error?: string } = { ok: true };
for (const tx of await Promise.all(setupTxs.map(tx => signTransaction([owner.keyPair], tx)))) if (setup.ok) setup = await chain.send(tx);
check('D01', 'the owner\'s set-up (ownerSetup), signed at once: policy, grant, accounts, approval, SOL for the agent', setup.ok, setup.ok ? `${setupTxs.length} transactions confirmed` : setup.error ?? '');

// ---------------------------------------------------------------- the verifier, serving over HTTP

const cosign = createCosigner({
  program: GUARD, key: verifier.keyPair, address: verifier.address,
  loadTables: tables => fetchAddressesForLookupTables(tables, rpc, { commitment: 'confirmed' }),
  simulate: rpcSimulator(rpc),
});
const server = createServer(handler(cosign));
await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
const verifierUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

// ---------------------------------------------------------------- the agent

const accounts = await accountsFor({ program: GUARD, owner: owner.address, agent: agent.address, verifier: verifier.address, mintIn, mintOut });
const routeIx = (amount: bigint): Instruction => ({
  programAddress: SWAP,
  accounts: [
    { address: TOKEN_PROGRAM, role: AccountRole.READONLY }, { address: '11111111111111111111111111111111' as Address, role: AccountRole.READONLY },
    { address: agent.address, role: AccountRole.READONLY_SIGNER }, { address: accounts.hopper, role: AccountRole.WRITABLE },
    { address: accounts.ownerOut, role: AccountRole.WRITABLE }, { address: poolIn, role: AccountRole.WRITABLE },
    { address: vaultOut, role: AccountRole.WRITABLE }, { address: vaultAuthority, role: AccountRole.READONLY },
  ],
  data: attackerData([takeFrom(amount), deliver(rate(amount))]),
});
const route = async (r: RouteRequest): Promise<JupiterRoute> => {
  const ix = routeIx(r.amount);
  return {
    inAmount: String(r.amount), outAmount: String(rate(r.amount)), otherAmountThreshold: String(rate(r.amount)), routePlan: [],
    setupInstructions: [], cleanupInstruction: null, otherInstructions: [], addressesByLookupTableAddress: null,
    swapInstruction: {
      programId: ix.programAddress,
      accounts: (ix.accounts ?? []).map(a => ({ pubkey: a.address, isSigner: a.role >= 2, isWritable: a.role % 2 === 1 })),
      data: Buffer.from(ix.data ?? []).toString('base64'),
    },
  };
};
const guard = createGuardClient({ program: GUARD, owner: owner.address, agent, chain, verifiers: [{ address: verifier.address, cosign: verifierUrl }], route });
const swap = (amount: bigint) => guard.swap({ mintIn, mintOut, amount });
const describe = (r: SwapResult) => (r.ok ? `arrived ${r.arrived} (min ${r.minOut}), fee ${r.fee}, ${explorer(r.signature)}` : `${r.stage}: ${r.reason}`);
const balance = async (a: Address) => {
  const [acc] = await chain.getAccounts([a]);
  return acc ? decodeTokenAccount(acc.data).amount : 0n;
};

/** The same swap sent straight to the chain, signed by the verifier's key too: the chain must refuse it. */
const chainRefuses = async (amount: bigint, code: string) => {
  await fresh();
  const r = await send([pull(accounts, amount, rate(amount)), routeIx(amount), settle(accounts)], agent, [verifier]);
  return { ok: !r.ok && (r.error ?? '').includes(code), detail: r.ok ? 'the chain allowed it' : (r.error ?? '') };
};

{
  const before = await balance(ownerIn);
  const r = await swap(PER_SWAP);
  const after = await balance(ownerIn);
  check('D02', `swap() on ${NET}: route, Pull/Settle, the verifier over HTTP, the agent's signature, confirmed`, r.ok && r.arrived === rate(PER_SWAP) && before - after === PER_SWAP + r.fee,
    `${describe(r)}; the owner paid ${before - after}`);
}
{
  const r = await swap(PER_SWAP);
  check('D03', 'a second swap the same day', r.ok, describe(r));
}
{
  const r = await swap(PER_SWAP);
  const onChain = await chainRefuses(PER_SWAP, '0xc');
  check('D04', 'the daily limit (250): swap() refuses the third before sending; the chain refuses it too', !r.ok && r.stage === 'rules' && /daily limit/.test(r.reason) && onChain.ok,
    `${describe(r)}; the chain: ${onChain.detail}`);
}
{
  await fresh();
  const policy = await policyOf(GUARD, owner.address);
  await send([updatePolicy({ program: GUARD, owner: owner.address, policy, verifiers: [verifier.address], programs: [SWAP], threshold: 1, paused: true })], owner, [], 'pause');
  const r = await swap(10n * UNIT_IN);
  const onChain = await chainRefuses(10n * UNIT_IN, '0x4');
  check('D05', 'the owner pauses: swap() refuses; the chain refuses too', !r.ok && /paused/.test(r.reason) && onChain.ok, `${describe(r)}; the chain: ${onChain.detail}`);
  await fresh();
  await send([updatePolicy({ program: GUARD, owner: owner.address, policy, verifiers: [verifier.address], programs: [SWAP], threshold: 1, paused: false })], owner, [], 'resume');
}
{
  await fresh();
  await send([revoke(ownerIn, owner.address, TOKEN_PROGRAM)], owner, [], 'revoke');
  const r = await swap(10n * UNIT_IN);
  const onChain = await chainRefuses(10n * UNIT_IN, '0xe');
  check('D06', 'the owner revokes the approval in their wallet: swap() refuses; the chain refuses too', !r.ok && /approved/.test(r.reason) && onChain.ok, `${describe(r)}; the chain: ${onChain.detail}`);
}
server.close();

const summary = [
  `# Orientim Guard on ${NET}`,
  '',
  `The Guard \`${GUARD}\`, the test swap program \`${SWAP}\`, the owner \`${owner.address}\`, the agent \`${agent.address}\`.`,
  '',
  '| | Case | | Detail |',
  '| --- | --- | --- | --- |',
  ...lines,
  '',
  failed ? `**${failed} of ${lines.length} cases failed.**` : `All ${lines.length} cases passed on ${NET}.`,
  '',
].join('\n');
mkdirSync('tests/guard/results', { recursive: true });
writeFileSync('tests/guard/results/devnet.md', summary);
console.log(summary);
process.exit(failed ? 1 : 0);
