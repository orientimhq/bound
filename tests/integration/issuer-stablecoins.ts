/**
 * T12: stablecoins whose issuer holds a permanent delegate — PYUSD, USDG, AUSD, CASH.
 *
 * Orientim used to refuse every Token-2022 mint with a permanent delegate. It now accepts one whose
 * delegate is an ordinary key, because such a key can act only by signing and R6 admits no signer
 * but W and E. These tokens also carry extensions Orientim had never executed through: a confidential
 * transfer fee, a transfer fee set to zero, a hook with no program, a default account state. Unit
 * tests say the rule reads them correctly; only the real programs can say that a protected swap
 * through them executes and leaves nothing behind. This asks them, on mainnet state:
 *
 *   in    the token → SOL, from a real holder: the swap executes, and both temporary accounts are
 *         gone afterwards (the one question the unit tests cannot answer)
 *   out   SOL → the token, for a wallet that has no account of it yet: the swap executes, and the
 *         account the token program creates is exactly the size Orientim priced its rent at
 *
 * Nothing is signed or sent; simulations run with sigVerify off and a real holder as fee payer.
 *
 *   node tests/integration/issuer-stablecoins.ts
 */
import { address, getBase64EncodedWireTransaction } from '@solana/kit';
import type { Address } from '@solana/kit';
import { mkdirSync, writeFileSync } from 'node:fs';
import { JUPITER_PROGRAM, TOKEN_2022_PROGRAM, WSOL_MINT } from '@orientimhq/swap/core';
import { ataOf, tokenAccountSizeFor, tokenAmountOf } from '@orientim/builder';
import { createEphemeral, createRetryingRpc, fetchAccounts } from '@orientimhq/swap/solana';
import { unsupportedExtension } from '@orientimhq/swap/verifier';
import { OrientimError, createJupiterClient, DEFAULT_SETTINGS, prepareProtectedSwap } from '@orientim/jupiter';

const rpc = createRetryingRpc(process.env.RPC_URL ?? 'https://api.mainnet-beta.solana.com', 8);
const jupiter = createJupiterClient({
  buildUrl: 'https://api.jup.ag/swap/v2/build',
  tokensUrl: 'https://api.jup.ag/tokens/v2/search',
  labelsUrl: 'https://api.jup.ag/swap/v2/program-id-to-label',
  apiKey: process.env.JUPITER_API_KEY,
  // Keyless Jupiter allows one request every two seconds; a key allows more.
  minIntervalMs: process.env.JUPITER_API_KEY ? 1100 : 2_100,
});
const log = (...a: unknown[]) => console.log(...a);
const json = (v: unknown) => JSON.stringify(v, (_, x) => (typeof x === 'bigint' ? Number(x) : x));

const TREASURY = address('ASTyfSima4LLAdDgoFGkgqoKowG1LZFDr9fAQrg7iaJZ');
/** Holds SOL and none of these tokens, so the output side opens a new account. */
const NEW_HOLDER = address('9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM');

/** Mints and a public wallet known to hold each (read from mainnet on 2026-09-22); AUSD has none. */
const TOKENS: { symbol: string; mint: Address; holder: Address | null }[] = [
  { symbol: 'PYUSD', mint: address('2b1kV6DkPAnxd5ixfnxCpjxmKwqjjaYmCZfHsFu24GXo'), holder: address('GJRs4FwHtemZ5ZE9x3FNvJ8TMwitKTh21yxdRPqn7npE') },
  { symbol: 'USDG', mint: address('2u1tszSeqZ3qBWF3uNGPFc8TzMk2tdiwknnRMWGWjGWH'), holder: address('u6PJ8DtQuPFnfmwHbGFULQ4u4EgjDiyYKjVEsynXq2w') },
  { symbol: 'CASH', mint: address('CASHx9KJUStyftLFWGvEVf59SGeG9sh5FfcnZMVPCASH'), holder: address('GJRs4FwHtemZ5ZE9x3FNvJ8TMwitKTh21yxdRPqn7npE') },
  { symbol: 'AUSD', mint: address('AUSD1jCcCyPLybk1YnvPWsHQSrZ46dxwoMniN4N2UEB9'), holder: null },
];

type Row = { token: string; name: string; ok: boolean; detail: string };
const rows: Row[] = [];
const check = (token: string, name: string, ok: boolean, detail = '') => {
  rows.push({ token, name, ok, detail });
  log(`${ok ? 'OK  ' : 'FAIL'} ${token.padEnd(6)} ${name}${detail ? ` — ${detail}` : ''}`);
};

const simulate = async (transaction: Parameters<typeof getBase64EncodedWireTransaction>[0], accounts: Address[]) => {
  const { value } = await rpc.simulateTransaction(getBase64EncodedWireTransaction(transaction), {
    encoding: 'base64', sigVerify: false, replaceRecentBlockhash: true, commitment: 'confirmed',
    accounts: { addresses: accounts, encoding: 'base64' },
  }).send();
  return {
    err: value.err,
    logs: value.logs ?? [],
    after: (value.accounts ?? []).map(a => (a ? {
      data: Uint8Array.from(Buffer.from(a.data[0], 'base64')), lamports: BigInt(a.lamports), owner: String(a.owner),
    } : null)),
  };
};
/**
 * An account the transaction closed comes back from the simulation as an empty, lamport-less entry
 * owned by the System program rather than as null. With no lamports the runtime deletes it at the
 * end of the transaction, which is exactly what a closed account is.
 */
const gone = (a: { data: Uint8Array; lamports: bigint } | null) => a === null || (a.lamports === 0n && a.data.length === 0);
const failure = (sim: Awaited<ReturnType<typeof simulate>>) =>
  sim.err ? `${json(sim.err)} — ${sim.logs.filter(l => /Error|error|failed/.test(l)).slice(-2).join(' | ')}` : '';

const settings = { ...DEFAULT_SETTINGS, treasury: TREASURY, jupiterProgram: JUPITER_PROGRAM };

for (const token of TOKENS) {
  const mintState = (await fetchAccounts(rpc, [token.mint])).get(token.mint);
  if (!mintState) { check(token.symbol, 'the mint exists', false); continue; }
  const decimals = mintState.data[44];
  const refused = unsupportedExtension(mintState.data, { allowTransferFee: true });
  check(token.symbol, 'the extension rule accepts it', refused === null, refused ?? '');
  if (refused) continue;

  // ------------------------------------------------------------ the token as input
  if (token.holder) {
    const account = await ataOf(token.holder, token.mint, TOKEN_2022_PROGRAM);
    const balance = tokenAmountOf((await fetchAccounts(rpc, [account])).get(account)?.data);
    const amountIn = 5n * 10n ** BigInt(decimals) < balance ? 5n * 10n ** BigInt(decimals) : balance / 2n;
    try {
      const prepared = await prepareProtectedSwap({ rpc, jupiter, settings }, {
        owner: token.holder, ephemeral: await createEphemeral(), inputMint: token.mint, outputMint: WSOL_MINT,
        amountIn, inputDecimals: decimals, outputDecimals: 9, version: 0, acceptedCostBps: 500n,
      });
      check(token.symbol, 'as input: built, verified and certified', true, `${prepared.size} bajt, route ${prepared.quote.route.join(' → ')}`);
      const temporary = [prepared.policy.accounts.eIn, prepared.policy.accounts.eOut!];
      const sim = await simulate(prepared.transaction, temporary);
      check(token.symbol, 'as input: the whole transaction executes', sim.err === null, failure(sim));
      check(
        token.symbol, 'as input: both temporary accounts are gone afterwards',
        sim.err === null && sim.after.every(gone),
        sim.after.map((a, i) => (gone(a) ? '' : `${i ? 'E_out' : 'E_in'} still holds ${a!.lamports} lamports and ${a!.data.length} bytes`)).filter(Boolean).join(', '),
      );
    } catch (e) {
      check(token.symbol, 'as input: built, verified and certified', false,
        `${e instanceof OrientimError ? e.code : 'error'}: ${(e as Error).message.slice(0, 260)}`);
    }
  }

  // ------------------------------------------------------------ the token as output, new account
  try {
    const prepared = await prepareProtectedSwap({ rpc, jupiter, settings }, {
      owner: NEW_HOLDER, ephemeral: await createEphemeral(), inputMint: WSOL_MINT, outputMint: token.mint,
      amountIn: 50_000_000n, inputDecimals: 9, outputDecimals: decimals, version: 0, acceptedCostBps: 500n,
    });
    check(token.symbol, 'as output: built, verified and certified', true, `${prepared.size} bajt`);
    const wOut = prepared.policy.accounts.wOut!;
    const sim = await simulate(prepared.transaction, [wOut]);
    check(token.symbol, 'as output: the whole transaction executes', sim.err === null, failure(sim));
    const created = sim.after[0];
    if (created) {
      const expected = tokenAccountSizeFor(TOKEN_2022_PROGRAM, mintState.data);
      check(token.symbol, 'as output: the new account is the size Orientim priced', created.data.length === expected,
        `krijuar ${created.data.length} bajt, parashikuar ${expected}`);
      check(token.symbol, 'as output: the rent shown is the rent charged', created.lamports === prepared.oneTimeCosts.outputAccountRent,
        `ngarkuar ${created.lamports}, shfaqur ${prepared.oneTimeCosts.outputAccountRent}`);
      check(token.symbol, 'as output: at least the minimum arrived', tokenAmountOf(created.data) >= prepared.policy.minOut,
        `arritën ${tokenAmountOf(created.data)}, minimumi ${prepared.policy.minOut}`);
    }
  } catch (e) {
    check(token.symbol, 'as output: built, verified and certified', false,
      `${e instanceof OrientimError ? e.code : 'error'}: ${(e as Error).message.slice(0, 260)}`);
  }
}

mkdirSync('tests/integration/results', { recursive: true });
const failed = rows.filter(r => !r.ok).length;
writeFileSync('tests/integration/results/issuer-stablecoins.md', [
  '# T12 — stablecoin-ët me delegat të lëshuesit',
  '',
  `${rows.length - failed}/${rows.length} kontrolle kaluan. Asgjë nuk u nënshkrua e nuk u dërgua.`,
  '',
  '| Tokeni | Kontrolli | Rezultati | Detaji |',
  '| --- | --- | --- | --- |',
  ...rows.map(r => `| ${r.token} | ${r.name} | ${r.ok ? 'kaloi' : 'DËSHTOI'} | ${r.detail || '—'} |`),
  '',
].join('\n'));
log(`\nT12 ${rows.length - failed}/${rows.length}  →  tests/integration/results/issuer-stablecoins.md`);
process.exit(failed ? 1 : 0);
