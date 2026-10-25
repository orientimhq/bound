/**
 * Orientim Guard's hard cases on a real validator (solana-test-validator in CI): many kinds of token,
 * amounts at every edge, races between swaps, the network failing, and a long run of swaps. Each swap
 * goes through `swap()`, the verifier over HTTP and the RPC node, and every one is checked against what
 * the owner's and the pool's accounts show afterwards.
 *
 *   RPC_URL=… GUARD_PROGRAM=… SWAP_PROGRAM=… PAYER_KEYPAIR=path/to/keypair.json [HARD_SWAPS=300] node tests/guard/hard.ts
 *
 * The route is the test swap program (tests/guard/attacker), honest: TransferChecked of what reached the
 * agent's hopper to the pool, then TransferChecked from the pool to the owner, at a fixed rate.
 * No real funds: every key and mint is made for the run.
 */
import {
  AccountRole, address, appendTransactionMessageInstructions, compileTransaction, createKeyPairSignerFromBytes, createSolanaRpc,
  createTransactionMessage, fetchAddressesForLookupTables, generateKeyPairSigner, getAddressEncoder, getProgramDerivedAddress, pipe,
  setTransactionMessageFeePayer, setTransactionMessageLifetimeUsingBlockhash, signTransaction,
} from '@solana/kit';
import type { Address, Blockhash, Instruction, KeyPairSigner } from '@solana/kit';
import { getCreateAccountInstruction, getTransferSolInstruction } from '@solana-program/system';
import { getInitializeMint2Instruction, getMintToInstruction } from '@solana-program/token';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  accountsFor, ataOf, createAtaIdempotent, createGuardClient, decodeGrant, decodeTokenAccount, feeOf, grantOf, ownerSetup,
  ownerSetupTransactions, pull, rpcChain, settle, TOKEN_PROGRAM,
} from '@orientimhq/guard';
import type { GuardClient, JupiterRoute, RouteRequest, SwapResult } from '@orientimhq/guard';
import { createCosigner } from '../../verifier/src/cosign.ts';
import { handler, rpcSimulator } from '../../verifier/src/server.ts';
import { attackerData, transferChecked, TOKEN_2022_PROGRAM, u64 } from './chain.ts';
import type { Inner } from './chain.ts';

const need = (name: string) => {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is not set`);
  return v as Address;
};
const RPC_URL = need('RPC_URL');
const GUARD = need('GUARD_PROGRAM');
const SWAP = need('SWAP_PROGRAM');
const LONG_RUN = Number(process.env.HARD_SWAPS ?? 300);
const rpc = createSolanaRpc(RPC_URL);
const chain = rpcChain(RPC_URL);
const SYSTEM = address('11111111111111111111111111111111');
const encoder = getAddressEncoder();

const payer = await createKeyPairSignerFromBytes(Uint8Array.from(JSON.parse(readFileSync(need('PAYER_KEYPAIR'), 'utf8'))));
const [vaultAuthority] = await getProgramDerivedAddress({ programAddress: SWAP, seeds: [new TextEncoder().encode('attacker')] });

let latest = await chain.latestBlockhash();
const fresh = async () => {
  latest = await chain.latestBlockhash();
};
async function send(ixs: Instruction[], feePayer: KeyPairSigner, others: KeyPairSigner[] = [], what = '', lifetime = latest) {
  const tx = await signTransaction([feePayer.keyPair, ...others.map(s => s.keyPair)], compileTransaction(pipe(
    createTransactionMessage({ version: 0 }),
    m => setTransactionMessageFeePayer(feePayer.address, m),
    m => setTransactionMessageLifetimeUsingBlockhash(lifetime, m),
    m => appendTransactionMessageInstructions(ixs, m),
  )));
  const r = await chain.send(tx);
  if (what && !r.ok) throw new Error(`${what} failed: ${r.error}`);
  return { ...r, tx };
}

const lines: string[] = [];
let failed = 0;
const check = (id: string, what: string, ok: boolean, detail: string) => {
  lines.push(`| ${id} | ${what} | ${ok ? 'OK' : '**FAIL**'} | ${detail.replaceAll('|', '/').slice(0, 400)} |`);
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${id} ${what}: ${detail}`);
  if (!ok) failed++;
};
const balance = async (a: Address) => {
  const [acc] = await chain.getAccounts([a]);
  return acc ? decodeTokenAccount(acc.data).amount : 0n;
};
const describe = (r: SwapResult) => (r.ok ? `arrived ${r.arrived}, fee ${r.fee}` : `${r.stage}: ${r.reason}`);

// ---------------------------------------------------------------- the verifier, over HTTP

const verifier = await generateKeyPairSigner();
const cosign = createCosigner({
  program: GUARD, key: verifier.keyPair, address: verifier.address, perMinute: 100_000,
  loadTables: tables => fetchAddressesForLookupTables(tables, rpc, { commitment: 'confirmed' }),
  simulate: rpcSimulator(rpc),
});
const server = createServer(handler(cosign));
await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
const verifierUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

// ---------------------------------------------------------------- mints of every kind

/**
 * The kinds of mint: classic SPL Token at 0, 5 (like BONK), 6 (like USDC) and 9 (like SOL) decimals;
 * Token-2022 plain; Token-2022 with a metadata pointer and its metadata, as pump.fun's newer tokens are;
 * Token-2022 with a 1% transfer fee; and the two the Guard must refuse: a transfer hook with a program,
 * and a permanent delegate.
 */
type Kind = 'spl0' | 'spl5' | 'spl6' | 'spl9' | 't22' | 'pump' | 'fee' | 'hook' | 'delegate';
const DECIMALS: Record<Kind, number> = { spl0: 0, spl5: 5, spl6: 6, spl9: 9, t22: 6, pump: 6, fee: 6, hook: 6, delegate: 6 };
const programOf = (k: Kind) => (k.startsWith('spl') ? TOKEN_PROGRAM : TOKEN_2022_PROGRAM);
const TRANSFER_FEE_BPS = 100n;
/** Token-2022 rounds a transfer fee up. */
const transferFee = (k: Kind, amount: bigint) => (k === 'fee' ? (amount * TRANSFER_FEE_BPS + 9_999n) / 10_000n : 0n);

const t22 = (data: number[], mint: Address, extra: { address: Address; role: AccountRole }[] = []): Instruction => ({
  programAddress: TOKEN_2022_PROGRAM, accounts: [{ address: mint, role: AccountRole.WRITABLE }, ...extra], data: Uint8Array.from(data),
});
const key = (a: Address) => [...encoder.encode(a)];
const borshString = (s: string) => {
  const b = new TextEncoder().encode(s);
  return [...u64(BigInt(b.length)).slice(0, 4), ...b];
};

async function createMint(k: Kind): Promise<Address> {
  const mint = await generateKeyPairSigner();
  const program = programOf(k);
  // Base mint (82 bytes) padded to 165, the account type, then one TLV entry of `len` bytes.
  const ext: Record<string, number> = { pump: 64, fee: 108, hook: 64, delegate: 32 };
  const space = k in ext ? 165 + 1 + 4 + ext[k] : 82;
  const funded = k === 'pump' ? 600 : space; // the metadata grows the mint after it is made
  const rent = await rpc.getMinimumBalanceForRentExemption(BigInt(funded)).send();
  const before: Instruction[] = [];
  if (k === 'pump') before.push(t22([39, 0, ...key(payer.address), ...key(mint.address)], mint.address)); // MetadataPointer: the mint itself
  if (k === 'fee') before.push(t22([26, 0, 1, ...key(payer.address), 1, ...key(payer.address), ...[Number(TRANSFER_FEE_BPS) & 0xff, Number(TRANSFER_FEE_BPS) >> 8], ...u64(10n ** 18n)], mint.address));
  if (k === 'hook') before.push(t22([36, 0, ...key(payer.address), ...key(SWAP)], mint.address));
  if (k === 'delegate') before.push(t22([35, ...key(payer.address)], mint.address));
  const after: Instruction[] = [];
  if (k === 'pump') {
    const discriminator = createHash('sha256').update('spl_token_metadata_interface:initialize_account').digest().subarray(0, 8);
    after.push({
      programAddress: TOKEN_2022_PROGRAM,
      accounts: [
        { address: mint.address, role: AccountRole.WRITABLE }, { address: payer.address, role: AccountRole.READONLY },
        { address: mint.address, role: AccountRole.READONLY }, { address: payer.address, role: AccountRole.READONLY_SIGNER },
      ],
      data: Uint8Array.from([...discriminator, ...borshString('Pump Test'), ...borshString('PUMP'), ...borshString('https://example.com/pump.json')]),
    });
  }
  await fresh();
  await send([
    getCreateAccountInstruction({ payer, newAccount: mint, lamports: rent, space: BigInt(space), programAddress: program }),
    ...before,
    getInitializeMint2Instruction({ mint: mint.address, decimals: DECIMALS[k], mintAuthority: payer.address, freezeAuthority: null }, { programAddress: program }),
    ...after,
  ], payer, [mint], `creating a ${k} mint`);
  return mint.address;
}

// ---------------------------------------------------------------- a market: an owner, an agent, a pool

async function market(kIn: Kind, kOut: Kind, o: { perSwap?: bigint; perDay?: bigint; budget?: bigint; ownerHas?: bigint; poolHas?: bigint; agents?: number } = {}) {
  const [mintIn, mintOut] = [await createMint(kIn), await createMint(kOut)];
  const [owner, agent, pool] = [await generateKeyPairSigner(), await generateKeyPairSigner(), await generateKeyPairSigner()];
  const [pIn, pOut] = [programOf(kIn), programOf(kOut)];
  const unitIn = 10n ** BigInt(DECIMALS[kIn]);
  const ownerIn = await ataOf(owner.address, mintIn, pIn);
  const ownerOut = await ataOf(owner.address, mintOut, pOut);
  const poolIn = await ataOf(pool.address, mintIn, pIn);
  const vaultOut = await ataOf(vaultAuthority, mintOut, pOut);
  await fresh();
  await send([
    getTransferSolInstruction({ source: payer, destination: owner.address, amount: 1_000_000_000n }),
    createAtaIdempotent(payer.address, ownerIn, owner.address, mintIn, pIn),
    createAtaIdempotent(payer.address, poolIn, pool.address, mintIn, pIn),
    createAtaIdempotent(payer.address, vaultOut, vaultAuthority, mintOut, pOut),
    getMintToInstruction({ mint: mintIn, token: ownerIn, mintAuthority: payer, amount: o.ownerHas ?? 1_000_000n * unitIn }, { programAddress: pIn }),
    getMintToInstruction({ mint: mintOut, token: vaultOut, mintAuthority: payer, amount: o.poolHas ?? 10n ** 18n }, { programAddress: pOut }),
  ], payer, [], `the ${kIn} → ${kOut} market`);

  const perSwap = o.perSwap ?? 1_000n * unitIn;
  const perDay = o.perDay ?? 10n ** 18n;
  const agents = [agent, ...await Promise.all(Array.from({ length: (o.agents ?? 1) - 1 }, () => generateKeyPairSigner()))];
  for (const [i, a] of agents.entries()) {
    await fresh();
    const txs = ownerSetupTransactions(await ownerSetup({
      program: GUARD, owner: owner.address, agent: a.address, verifiers: [verifier.address], programs: [SWAP], policyExists: i > 0,
      rules: { limits: [{ mint: mintIn, perSwap, perDay }], outputs: [mintOut] },
      budgets: [{ mint: mintIn, amount: o.budget ?? 10n ** 18n, tokenProgram: pIn }],
      outputTokenPrograms: { [mintOut]: pOut }, agentLamports: 50_000_000n,
    }), owner.address, latest);
    for (const tx of await Promise.all(txs.map(tx => signTransaction([owner.keyPair], tx)))) {
      const r = await chain.send(tx);
      if (!r.ok) throw new Error(`the owner's set-up of ${kIn} → ${kOut} failed: ${r.error}`);
    }
  }

  // Half a unit of the output for each unit of the input, in whole tokens, whatever the decimals.
  const rate = (amount: bigint) => (amount * 10n ** BigInt(DECIMALS[kOut])) / (2n * unitIn);
  const routeFor = (a: KeyPairSigner) => async (amount: bigint): Promise<Instruction> => {
    const hopper = await ataOf(a.address, mintIn, pIn);
    const reached = amount - transferFee(kIn, amount); // what the Guard's TransferChecked leaves in the hopper
    const take: Inner = { program: 0, metas: [{ key: 3, w: true }, { key: 8 }, { key: 5, w: true }, { key: 2, s: true }], data: transferChecked(reached, DECIMALS[kIn]) };
    const give: Inner = { program: 10, signed: true, metas: [{ key: 6, w: true }, { key: 9 }, { key: 4, w: true }, { key: 7, s: true }], data: transferChecked(rate(reached), DECIMALS[kOut]) };
    return {
      programAddress: SWAP,
      accounts: [
        { address: pIn, role: AccountRole.READONLY }, { address: SYSTEM, role: AccountRole.READONLY },
        { address: a.address, role: AccountRole.READONLY_SIGNER }, { address: hopper, role: AccountRole.WRITABLE },
        { address: ownerOut, role: AccountRole.WRITABLE }, { address: poolIn, role: AccountRole.WRITABLE },
        { address: vaultOut, role: AccountRole.WRITABLE }, { address: vaultAuthority, role: AccountRole.READONLY },
        { address: mintIn, role: AccountRole.READONLY }, { address: mintOut, role: AccountRole.READONLY },
        { address: pOut, role: AccountRole.READONLY },
      ],
      data: attackerData([take, give]),
    };
  };
  const arrives = (amount: bigint) => {
    const out = rate(amount - transferFee(kIn, amount));
    return out - transferFee(kOut, out);
  };
  const routeOf = (a: KeyPairSigner) => async (r: RouteRequest): Promise<JupiterRoute> => {
    const ix = await routeFor(a)(r.amount);
    return {
      inAmount: String(r.amount), outAmount: String(arrives(r.amount)), otherAmountThreshold: String(arrives(r.amount)), routePlan: [],
      setupInstructions: [], cleanupInstruction: null, otherInstructions: [], addressesByLookupTableAddress: null,
      swapInstruction: {
        programId: ix.programAddress,
        accounts: (ix.accounts ?? []).map(x => ({ pubkey: x.address, isSigner: x.role >= 2, isWritable: x.role % 2 === 1 })),
        data: Buffer.from(ix.data ?? []).toString('base64'),
      },
    };
  };
  const clientOf = (a: KeyPairSigner, url = verifierUrl, extra: Partial<GuardClient> = {}) =>
    createGuardClient({ program: GUARD, owner: owner.address, agent: a, chain, verifiers: [{ address: verifier.address, cosign: url }], route: routeOf(a), ...extra });
  const guard = clientOf(agent);
  return {
    name: `${kIn} → ${kOut}`, kIn, kOut, mintIn, mintOut, owner, agent, agents, ownerIn, ownerOut, rate, arrives, routeFor, clientOf,
    swap: (amount: bigint) => guard.swap({ mintIn, mintOut, amount }),
  };
}
type Market = Awaited<ReturnType<typeof market>>;

/** One swap through `swap()`, checked against the accounts: the owner paid amount + fee, the output arrived. */
async function honestSwap(m: Market, amount: bigint) {
  const [inBefore, outBefore] = [await balance(m.ownerIn), await balance(m.ownerOut)];
  const r = await m.swap(amount);
  const [inAfter, outAfter] = [await balance(m.ownerIn), await balance(m.ownerOut)];
  const paid = inBefore - inAfter;
  const got = outAfter - outBefore;
  const ok = r.ok && paid === amount + feeOf(amount) && got === m.arrives(amount) && r.arrived === got;
  return { ok, r, detail: `${describe(r)}; the owner paid ${paid} (expected ${amount + feeOf(amount)}), received ${got} (expected ${m.arrives(amount)})` };
}

/** The same swap sent straight to the chain, signed by the verifier's key: for what `swap()` would never send. */
async function direct(m: Market, amount: bigint, agent = m.agent, lifetime?: { blockhash: Blockhash; lastValidBlockHeight: bigint }) {
  const accounts = await accountsFor({
    program: GUARD, owner: m.owner.address, agent: agent.address, verifier: verifier.address,
    mintIn: m.mintIn, mintOut: m.mintOut, tokenIn: programOf(m.kIn), tokenOut: programOf(m.kOut),
  });
  if (!lifetime) await fresh();
  return send([pull(accounts, amount, m.arrives(amount)), await m.routeFor(agent)(amount), settle(accounts)], agent, [verifier], '', lifetime);
}

// ---------------------------------------------------------------- H1: every kind of token

const UNIT = (k: Kind) => 10n ** BigInt(DECIMALS[k]);
const pairs: [Kind, Kind][] = [
  ['spl6', 'spl9'], ['spl9', 'spl6'], ['spl5', 'pump'], ['pump', 'spl5'], ['spl0', 'spl6'], ['spl6', 'spl0'],
  ['t22', 'pump'], ['pump', 't22'], ['spl6', 'fee'], ['fee', 'spl6'],
];
for (const [i, [kIn, kOut]] of pairs.entries()) {
  const id = `H1-${String(i + 1).padStart(2, '0')}`;
  try {
    const m = await market(kIn, kOut);
    const s = await honestSwap(m, 100n * UNIT(kIn));
    check(id, `a swap ${m.name}`, s.ok && s.r.ok && s.r.fee > 0n, s.detail);
  } catch (e) {
    check(id, `a swap ${kIn} → ${kOut}`, false, (e as Error).message);
  }
}
for (const [i, [kIn, kOut]] of ([['spl6', 'hook'], ['hook', 'spl6'], ['spl6', 'delegate'], ['delegate', 'spl6']] as [Kind, Kind][]).entries()) {
  const id = `H1-R${i + 1}`;
  try {
    const m = await market(kIn, kOut);
    const before = await balance(m.ownerIn);
    const r = await m.swap(10n * UNIT(kIn));
    const onChain = await direct(m, 10n * UNIT(kIn));
    const after = await balance(m.ownerIn);
    check(id, `a mint the Guard refuses (${kIn} → ${kOut}): swap() and the chain both refuse, nothing moves`,
      !r.ok && !onChain.ok && before === after, `${describe(r)}; the chain: ${onChain.ok ? 'allowed it' : onChain.error}`);
  } catch (e) {
    check(id, `a mint the Guard refuses (${kIn} → ${kOut})`, false, (e as Error).message);
  }
}

// ---------------------------------------------------------------- H2: amounts at every edge

{
  const m = await market('spl6', 'spl9', { perSwap: 10n ** 15n, perDay: 250n * 1_000_000n });
  const s1 = await honestSwap(m, 1n);
  check('H2-01', 'one base unit: the fee rounds up to 1, never 0', s1.ok && s1.r.ok && s1.r.fee === 1n, s1.detail);
  const s2 = await honestSwap(m, 400n);
  check('H2-02', '400 base units: the fee is exactly 1', s2.ok && s2.r.ok && s2.r.fee === 1n, s2.detail);
  const s3 = await honestSwap(m, 401n);
  check('H2-03', '401 base units: the fee rounds up to 2', s3.ok && s3.r.ok && s3.r.fee === 2n, s3.detail);
  // What is left of the day, exactly, the fee included.
  const grant = decodeGrant((await chain.getAccounts([await grantOf(GUARD, m.owner.address, m.agent.address)]))[0]!.data);
  const used = grant.limits[0].usedToday;
  const left = 250n * 1_000_000n - used;
  let exact = (left * 10_000n) / 10_025n;
  while (exact + 1n + feeOf(exact + 1n) <= left) exact++;
  while (exact + feeOf(exact) > left) exact--;
  const s4 = await honestSwap(m, exact);
  check('H2-04', `exactly what is left of the daily limit, the fee included (${exact} + ${feeOf(exact)} = ${left})`, s4.ok, s4.detail);
  const r5 = await m.swap(1n);
  const c5 = await direct(m, 1n);
  check('H2-05', 'one base unit more: swap() and the chain both refuse (0xc)', !r5.ok && !c5.ok && (c5.error ?? '').includes('0xc'),
    `${describe(r5)}; the chain: ${c5.ok ? 'allowed it' : c5.error}`);
}
{
  const big = 10n ** 18n;
  const m = await market('spl9', 'spl9', { perSwap: big + feeOf(big), perDay: 4n * big, budget: 4n * big, ownerHas: 4n * big, poolHas: 10n ** 19n });
  const s = await honestSwap(m, big);
  check('H2-06', 'a billion whole tokens in one swap (10^18 base units)', s.ok, s.detail);
  const r = await m.swap(big + 1n);
  check('H2-07', 'one base unit above the per-swap limit (the fee included): refused before sending', !r.ok && r.stage === 'rules', describe(r));
}
{
  const m = await market('spl6', 'spl9', { budget: 150n * 1_000_000n });
  const s = await honestSwap(m, 100n * 1_000_000n);
  const r = await m.swap(50n * 1_000_000n);
  const c = await direct(m, 50n * 1_000_000n);
  check('H2-08', 'the approved budget runs out: the second swap is refused by swap() and the chain', s.ok && !r.ok && !c.ok,
    `${s.detail}; then ${describe(r)}; the chain: ${c.ok ? 'allowed it' : c.error}`);
}

// ---------------------------------------------------------------- H3: races

{
  const unit = 1_000_000n;
  const m = await market('spl6', 'spl9', { perSwap: 101n * unit, perDay: 150n * unit });
  const before = await balance(m.ownerIn);
  const rs = await Promise.all([m.swap(100n * unit), m.swap(99n * unit)]); // two different transactions
  const paid = before - (await balance(m.ownerIn));
  const landed = rs.filter(r => r.ok).length;
  check('H3-01', 'two swaps of one agent at once, the daily limit fits one: exactly one lands', landed === 1 && (paid === 100n * unit + feeOf(100n * unit) || paid === 99n * unit + feeOf(99n * unit)),
    `${rs.map(describe).join(' / ')}; the owner paid ${paid}`);
}
{
  const unit = 1_000_000n;
  const m = await market('spl6', 'spl9', { perSwap: 101n * unit, perDay: 10n ** 15n, budget: 150n * unit, agents: 4 });
  const before = await balance(m.ownerIn);
  const rs = await Promise.all(m.agents.map(a => m.clientOf(a).swap({ mintIn: m.mintIn, mintOut: m.mintOut, amount: 100n * unit })));
  const paid = before - (await balance(m.ownerIn));
  const landed = rs.filter(r => r.ok).length;
  check('H3-02', 'four agents of one owner at once, the approved budget fits one: exactly one lands', landed === 1 && paid === 100n * unit + feeOf(100n * unit),
    `${landed} landed; the owner paid ${paid}`);
}

// ---------------------------------------------------------------- H4: the network failing

{
  const unit = 1_000_000n;
  const m = await market('spl6', 'spl9');
  const down = m.clientOf(m.agent, 'http://127.0.0.1:9');
  const before = await balance(m.ownerIn);
  const r1 = await down.swap({ mintIn: m.mintIn, mintOut: m.mintOut, amount: 10n * unit });
  check('H4-01', 'the verifier is down: refused, nothing moves', !r1.ok && r1.stage === 'verifier' && before === await balance(m.ownerIn), describe(r1));

  const r2 = await m.clientOf(m.agent, verifierUrl, { microLamportsPerUnit: 5_000_000n }).swap({ mintIn: m.mintIn, mintOut: m.mintOut, amount: 10n * unit });
  check('H4-02', 'a priority fee above the cap: refused before sending', !r2.ok && r2.stage === 'rules' && /priority fee/.test(r2.reason), describe(r2));

  const first = await direct(m, 10n * unit);
  const again = await chain.send(first.tx);
  const paid = before - await balance(m.ownerIn);
  check('H4-03', 'the same signed swap sent twice: it lands once', first.ok && paid === 10n * unit + feeOf(10n * unit),
    `first ${first.ok ? 'landed' : first.error}; again ${again.ok ? 'reported landed (the same signature)' : again.error}; the owner paid ${paid}`);

  const stale = { blockhash: address('11111111111111111111111111111111') as unknown as Blockhash, lastValidBlockHeight: 0n };
  const before2 = await balance(m.ownerIn);
  const r4 = await direct(m, 10n * unit, m.agent, stale);
  check('H4-04', 'a blockhash the chain does not know: refused, nothing moves', !r4.ok && before2 === await balance(m.ownerIn), r4.ok ? 'landed' : (r4.error ?? ''));
}

// ---------------------------------------------------------------- H5: a long run

{
  const unit = 1_000_000n;
  const m = await market('spl6', 'pump');
  let seed = 7;
  const next = () => {
    seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
    return seed;
  };
  let bad = 0;
  let firstBad = '';
  const started = Date.now();
  for (let i = 0; i < LONG_RUN; i++) {
    const amount = BigInt(1 + (next() % 1000)) * unit / BigInt(1 + (next() % 4));
    const s = await honestSwap(m, amount);
    if (!s.ok) {
      bad++;
      firstBad ||= `swap ${i + 1} of ${amount}: ${s.detail}`;
    }
  }
  const seconds = (Date.now() - started) / 1000;
  check('H5-01', `${LONG_RUN} swaps in a row (spl6 → pump), each checked against the accounts`, bad === 0,
    bad ? `${bad} wrong; the first: ${firstBad}` : `all exact, ${(seconds / LONG_RUN).toFixed(2)} s a swap`);
}

server.close();

const summary = [
  '# Orientim Guard: the hard cases on a real validator',
  '',
  `The Guard \`${GUARD}\`, the test swap program \`${SWAP}\`.`,
  '',
  '| | Case | | Detail |',
  '| --- | --- | --- | --- |',
  ...lines,
  '',
  failed ? `**${failed} of ${lines.length} cases failed.**` : `All ${lines.length} cases passed.`,
  '',
].join('\n');
mkdirSync('tests/guard/results', { recursive: true });
writeFileSync('tests/guard/results/hard.md', summary);
console.log(summary);
process.exit(failed ? 1 : 0);
