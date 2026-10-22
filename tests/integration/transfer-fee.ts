/**
 * T8: a real token that taxes its own transfers, on both sides of a swap.
 *
 * The audit found that the transfer-fee path, although written and unit-tested, was never reached
 * in production: the pipeline's own pre-check refused the mint before anything else ran. This test
 * exercises the path end to end against mainnet state, so the same mistake cannot pass again:
 *
 *   in   the token as input: the route must be quoted for what arrives in the temporary account,
 *        the withheld amount must be harvested, and the temporary account must close
 *   out   the token as output: does Jupiter's `outAmount` mean what the wallet actually receives,
 *        or the amount before the token's tax? Orientim's minimum is enforced on the balance, so the
 *        answer decides whether an honest swap executes or reverts
 *
 * Nothing is signed or sent; the simulation uses a real holder as fee payer.
 *
 *   node tests/integration/transfer-fee.ts [--symbol FEELSGOOD] [--holder <wallet>]
 *
 * The holder is looked up from the chain; pass one when the public RPC rate-limits that call.
 */
import { address, getAddressDecoder, getBase64EncodedWireTransaction } from '@solana/kit';
import type { Address } from '@solana/kit';
import { mkdirSync, writeFileSync } from 'node:fs';
import { JUPITER_PROGRAM, SYSTEM_PROGRAM, TOKEN_2022_PROGRAM, WSOL_MINT } from '@orientimhq/swap/core';
import { ataOf, tokenAmountOf } from '@orientim/builder';
import { createEphemeral, createRetryingRpc, fetchAccounts } from '@orientimhq/swap/solana';
import { transferFeeOf, transferFeeOn } from '@orientimhq/swap/verifier';
import { OrientimError, createJupiterClient, DEFAULT_SETTINGS, prepareProtectedSwap } from '@orientim/jupiter';

const arg = (name: string, fallback: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : fallback;
};
const SYMBOL = arg('symbol', 'FEELSGOOD');

const rpc = createRetryingRpc(process.env.RPC_URL ?? 'https://api.mainnet-beta.solana.com', 8);
const jupiter = createJupiterClient({
  buildUrl: 'https://api.jup.ag/swap/v2/build',
  tokensUrl: 'https://api.jup.ag/tokens/v2/search',
  labelsUrl: 'https://api.jup.ag/swap/v2/program-id-to-label',
  apiKey: process.env.JUPITER_API_KEY,
  // Keyless Jupiter allows one request every two seconds; a key allows more.
  minIntervalMs: process.env.JUPITER_API_KEY ? 1100 : 2_100,
});

const TREASURY = address('ASTyfSima4LLAdDgoFGkgqoKowG1LZFDr9fAQrg7iaJZ');
const log = (...a: unknown[]) => console.log(...a);
const json = (v: unknown) => JSON.stringify(v, (_, x) => (typeof x === 'bigint' ? Number(x) : x));

type Row = { name: string; ok: boolean; detail: string };
const rows: Row[] = [];
const check = (name: string, ok: boolean, detail = '') => {
  rows.push({ name, ok, detail });
  log(`${ok ? 'OK  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
};

// --- the token and its tax, from the chain
const listed = (await (await fetch('https://api.jup.ag/tokens/v2/toptraded/24h?limit=100')).json()) as
  { id: string; symbol: string; decimals: number; tokenProgram: string }[];
const token = listed.find(t => t.symbol === SYMBOL);
if (!token) {
  console.error(`${SYMBOL} is not in the 100 most traded tokens today; pass --symbol with one that is.`);
  process.exit(2);
}
const mint = address(token.id);
const { epoch } = await rpc.getEpochInfo({ commitment: 'confirmed' }).send();
const mintState = (await fetchAccounts(rpc, [mint])).get(mint)!;
const fee = transferFeeOf(mintState.data, BigInt(epoch));
if (!fee) {
  console.error(`${SYMBOL} charges no transfer fee this epoch; nothing to test.`);
  process.exit(2);
}
log(`${SYMBOL} (${mint})  tarifa ${fee.bps} bps, kufiri ${fee.maximum}, epoka ${epoch}\n`);

/** A wallet whose own associated account holds this token, so a simulation means something. */
async function holder(): Promise<{ owner: Address; balance: bigint } | null> {
  // The public RPC rate-limits this call hard; a few patient tries are usually enough.
  const given = arg('holder', '');
  if (given) {
    const account = await ataOf(address(given), mint, TOKEN_2022_PROGRAM);
    const state = (await fetchAccounts(rpc, [account])).get(account);
    return state ? { owner: address(given), balance: tokenAmountOf(state.data) } : null;
  }
  let largest: readonly { address: string }[] | null = null;
  for (let i = 0; i < 4 && !largest; i++) {
    if (i) await new Promise(r => setTimeout(r, 4_000));
    largest = await rpc.getTokenLargestAccounts(mint, { commitment: 'confirmed' }).send()
      .then(r => r.value as readonly { address: string }[])
      .catch(() => null);
  }
  if (!largest) {
    log('    (lista e mbajtësve nuk u lexua dot: kufizim i shpejtësisë te RPC publik)');
    return null;
  }
  const addresses = largest.map(a => address(a.address));
  const infos = await fetchAccounts(rpc, addresses);
  const decoder = getAddressDecoder();
  const owners: { owner: Address; account: Address; balance: bigint }[] = [];
  for (const a of addresses) {
    const state = infos.get(a);
    if (!state || state.data.length < 165) continue;
    owners.push({ owner: decoder.decode(state.data.subarray(32, 64)), account: a, balance: tokenAmountOf(state.data) });
  }
  const wallets = await fetchAccounts(rpc, owners.map(o => o.owner));
  for (const o of owners.sort((a, b) => (a.balance > b.balance ? -1 : 1))) {
    const w = wallets.get(o.owner);
    if (!w || w.owner !== SYSTEM_PROGRAM || w.lamports < 100_000_000n) continue;
    if ((await ataOf(o.owner, mint, TOKEN_2022_PROGRAM)) !== o.account) continue;
    return { owner: o.owner, balance: o.balance };
  }
  return null;
}

const simulate = async (transaction: Parameters<typeof getBase64EncodedWireTransaction>[0], accounts: Address[]) => {
  const { value } = await rpc.simulateTransaction(getBase64EncodedWireTransaction(transaction), {
    encoding: 'base64', sigVerify: false, replaceRecentBlockhash: true, commitment: 'confirmed',
    accounts: { addresses: accounts, encoding: 'base64' },
  }).send();
  return {
    err: value.err,
    logs: value.logs ?? [],
    after: (value.accounts ?? []).map(a => (a ? tokenAmountOf(Uint8Array.from(Buffer.from(a.data[0], 'base64'))) : null)),
    exists: (value.accounts ?? []).map(a => !!a),
  };
};

const settings = { ...DEFAULT_SETTINGS, treasury: TREASURY, jupiterProgram: JUPITER_PROGRAM };

// ---------------------------------------------------------------- the token as input
const who = await holder();
if (!who) {
  // Without a holder the swap cannot be simulated, but the audit's finding can still be checked:
  // the pipeline must get past its own pre-check instead of refusing the mint outright.
  const reached = await prepareProtectedSwap({ rpc, jupiter, settings }, {
    owner: address('GJRs4FwHtemZ5ZE9x3FNvJ8TMwitKTh21yxdRPqn7npE'), ephemeral: await createEphemeral(),
    inputMint: mint, outputMint: WSOL_MINT, amountIn: 1_000_000n,
    inputDecimals: token.decimals, outputDecimals: 9, version: 0, acceptedCostBps: 500n,
  }).then(() => 'built', (e: unknown) => (e instanceof OrientimError ? e.code : 'error'));
  check(
    'the token is no longer refused as unsupported (the audit finding)',
    reached !== 'unsupported-token',
    `pipeline-i shkoi deri te "${reached}"; simulimi nuk u provua dot, asnjë wallet publik nuk e mban këtë token`,
  );
} else {
  const amountIn = who.balance / 1000n > 0n ? who.balance / 1000n : who.balance;
  log(`mbajtësi ${who.owner.slice(0, 8)} me ${who.balance}, shuma e provës ${amountIn}\n`);
  try {
    const E = await createEphemeral();
    const prepared = await prepareProtectedSwap({ rpc, jupiter, settings }, {
      owner: who.owner, ephemeral: E, inputMint: mint, outputMint: WSOL_MINT, amountIn,
      inputDecimals: token.decimals, outputDecimals: 9, version: 0,
      // A thin token often routes worse than the open market; this test is about the tax, not the
      // price, so it accepts what a user would be asked about.
      acceptedCostBps: 500n,
    });
    check('the token is accepted as input (the audit found this refused)', true, `${prepared.size} bajt`);
    const tax = transferFeeOn(prepared.policy.swapAmount, fee);
    check(
      'the route is quoted for what arrives, not for what leaves the wallet',
      prepared.quote.inAmount === prepared.policy.swapAmount - tax,
      `u kuotua ${prepared.quote.inAmount}, arrin ${prepared.policy.swapAmount - tax}`,
    );
    check(
      'the tax is reported for the page to show',
      prepared.tokenTax?.inputBps === fee.bps && prepared.tokenTax?.extraOnInput === tax,
      json(prepared.tokenTax),
    );
    const sim = await simulate(prepared.transaction, [prepared.policy.accounts.eIn]);
    check(
      'the whole transaction executes, harvest and close included',
      sim.err === null,
      sim.err ? `${json(sim.err)} — ${sim.logs.filter(l => /Error|error|failed/.test(l)).slice(-2).join(' | ')}` : '',
    );
    check('the temporary account is gone afterwards', !sim.exists[0], sim.exists[0] ? 'it still exists' : '');
  } catch (e) {
    const code = e instanceof OrientimError ? e.code : 'error';
    check('the token is accepted as input (the audit found this refused)', false, `${code}: ${(e as Error).message.slice(0, 320)}`);
  }
}

// ---------------------------------------------------------------- the token as output
try {
  const E = await createEphemeral();
  const payer = who?.owner ?? address('GJRs4FwHtemZ5ZE9x3FNvJ8TMwitKTh21yxdRPqn7npE');
  const prepared = await prepareProtectedSwap({ rpc, jupiter, settings }, {
    owner: payer, ephemeral: E, inputMint: WSOL_MINT, outputMint: mint, amountIn: 50_000_000n,
    inputDecimals: 9, outputDecimals: token.decimals, version: 0, acceptedCostBps: 500n,
  });
  check('the token is accepted as output', true, `${prepared.size} bajt`);
  const wOut = prepared.policy.accounts.wOut!;
  const before = tokenAmountOf((await fetchAccounts(rpc, [wOut])).get(wOut)?.data);
  const sim = await simulate(prepared.transaction, [wOut]);
  const arrived = sim.after[0] === null ? null : sim.after[0] - before;
  check(
    'an honest swap of it executes, so Orientim\'s minimum is not above what really arrives',
    sim.err === null,
    sim.err ? `${json(sim.err)} — ${sim.logs.filter(l => /Error|error|failed/.test(l)).slice(-2).join(' | ')}` : '',
  );
  if (arrived !== null) {
    const quoted = prepared.quote.outAmount;
    const taxOnOutput = transferFeeOn(quoted, fee);
    const net = quoted - taxOnOutput;
    const meaning = arrived >= net && arrived < quoted ? 'bruto (tarifa zbritet pas tij)'
      : arrived >= quoted ? 'neto (ajo që arrin vërtet)'
        : 'as njëra as tjetra';
    log(`    Jupiter kuotoi ${quoted}, arritën ${arrived} (neto do të ishte ${net}) → outAmount duket ${meaning}`);
    rows.push({ name: `Jupiter outAmount për një token me taksë: ${meaning}`, ok: true, detail: `kuotoi ${quoted}, arritën ${arrived}` });
  }
} catch (e) {
  const code = e instanceof OrientimError ? e.code : 'error';
  check('the token is accepted as output', false, `${code}: ${(e as Error).message.slice(0, 320)}`);
}

mkdirSync('tests/integration/results', { recursive: true });
const failed = rows.filter(r => !r.ok).length;
writeFileSync('tests/integration/results/transfer-fee.md', [
  `# T8 — ${SYMBOL}, një token që taksin transfertat e veta`,
  '',
  `${rows.length - failed}/${rows.length} kontrolle kaluan. Tarifa aktive: ${fee.bps} bps. Asgjë nuk u nënshkrua e nuk u dërgua.`,
  '',
  '| Kontrolli | Rezultati | Detaji |',
  '| --- | --- | --- |',
  ...rows.map(r => `| ${r.name} | ${r.ok ? 'kaloi' : 'DËSHTOI'} | ${r.detail || '—'} |`),
  '',
].join('\n'));
log(`\nT8 ${rows.length - failed}/${rows.length}  →  tests/integration/results/transfer-fee.md`);
process.exit(failed ? 1 : 0);
