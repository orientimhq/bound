/**
 * T13 and T14: Pump.fun's two markets.
 *
 *   --market amm    T13, PumpSwap, where Pump.fun tokens trade once they leave the bonding curve.
 *   --market curve  T14, the bonding curve itself, where a new Pump.fun token trades first.
 *
 * Both open an account for every buyer and make the buyer pay its rent; the bonding curve may also
 * charge a buyer for growing the curve's own account. In a Orientim swap the buyer is the one-time key
 * E, which holds nothing on purpose, so every such route used to fail. Orientim now measures that rent
 * in simulation and sends E exactly it. On the bonding curve Pump.fun takes the purchase in native
 * SOL, which it first unwraps itself from E's temporary WSOL account, so the approved amount
 * reaches it the same way as on any other market.
 *
 * This runs the real pipeline on mainnet state and checks what matters:
 *
 *   - the route goes through the market and is built, verified and certified;
 *   - the rent sent to E is above zero and under the ceiling;
 *   - the final transaction executes, at least the minimum arrives, and E ends with nothing — no SOL
 *     left under a key that is about to be discarded.
 *
 * Buys from SOL use a public wallet as fee payer; sells use a real holder of the token, found by
 * listing the token program's accounts for that mint. When none is found the sell is reported as
 * skipped, not as passed. Nothing is signed or sent.
 *
 *   node tests/integration/pump.ts [--market amm|curve] [--tokens 5]
 */
import { address, getAddressDecoder, getBase64EncodedWireTransaction } from '@solana/kit';
import type { Address } from '@solana/kit';
import { mkdirSync, writeFileSync } from 'node:fs';
import { ataOf, JUPITER_PROGRAM, MAX_TAKER_RENT_LAMPORTS, SYSTEM_PROGRAM, tokenAmountOf, WSOL_MINT } from '@orientimhq/swap/core';
import { createEphemeral, createRetryingRpc, fetchAccounts, fetchMints } from '@orientimhq/swap/solana';
import { OrientimError, createJupiterClient, DEFAULT_SETTINGS, prepareProtectedSwap } from '@orientim/jupiter';

const arg = (name: string, fallback: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : fallback;
};
const WANTED = Number(arg('tokens', '5'));
const CURVE = arg('market', 'amm') === 'curve';
const MARKET = CURVE
  ? { test: 'T14', label: 'Pump.fun', name: 'the bonding curve', title: 'Pump.fun, bonding curve', results: 'bonding-curve' }
  : { test: 'T13', label: 'Pump.fun Amm', name: 'PumpSwap', title: 'PumpSwap', results: 'pumpswap' };
const RPC_URL = process.env.RPC_URL ?? 'https://api.mainnet-beta.solana.com';
const rpc = createRetryingRpc(RPC_URL, 8);
const jupiter = createJupiterClient({
  buildUrl: 'https://api.jup.ag/swap/v2/build',
  tokensUrl: 'https://api.jup.ag/tokens/v2/search',
  labelsUrl: 'https://api.jup.ag/swap/v2/program-id-to-label',
  apiKey: process.env.JUPITER_API_KEY,
  // Keyless Jupiter allows one request every two seconds; a key allows more.
  minIntervalMs: process.env.JUPITER_API_KEY ? 1100 : 2_100,
});
const log = (...a: unknown[]) => console.log(...a);
// Jupiter's refusals during a sale, so that "no route" in a report says what Jupiter answered.
let jupiterSaid: string[] = [];
const build = jupiter.build.bind(jupiter);
jupiter.build = p => build(p).catch((e: Error) => { jupiterSaid.push(e.message.slice(0, 80)); throw e; });
const json = (v: unknown) => JSON.stringify(v, (_, x) => (typeof x === 'bigint' ? Number(x) : x));
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const BUYER = address('GJRs4FwHtemZ5ZE9x3FNvJ8TMwitKTh21yxdRPqn7npE');
const settings = { ...DEFAULT_SETTINGS, treasury: null, jupiterProgram: JUPITER_PROGRAM };

type Row = { token: string; name: string; ok: boolean | null; detail: string };
const rows: Row[] = [];
const check = (token: string, name: string, ok: boolean | null, detail = '') => {
  rows.push({ token, name, ok, detail });
  log(`${ok === null ? 'SKIP' : ok ? 'OK  ' : 'FAIL'} ${token.padEnd(10)} ${name}${detail ? ` — ${detail}` : ''}`);
};

/** Execute the final transaction in simulation and read the accounts that must end empty or full. */
async function execute(transaction: Parameters<typeof getBase64EncodedWireTransaction>[0], watch: Address[]) {
  const { value } = await rpc.simulateTransaction(getBase64EncodedWireTransaction(transaction), {
    encoding: 'base64', sigVerify: false, replaceRecentBlockhash: true, commitment: 'confirmed',
    accounts: { addresses: watch, encoding: 'base64' },
  }).send();
  const after = (value.accounts ?? []).map(a => (a ? {
    lamports: BigInt(a.lamports), data: Uint8Array.from(Buffer.from(a.data[0], 'base64')),
  } : null));
  const failure = value.err
    ? `${json(value.err)} — ${(value.logs ?? []).filter(l => /Error|error|failed|insufficient/.test(l)).slice(-2).join(' | ')}`
    : '';
  return { ok: value.err === null, failure, after };
}
/**
 * Did a minimum stop the swap: Jupiter's own (6001), or Orientim's check after it, which the token
 * program refuses for insufficient funds? Either way the price moved and the swap reverted.
 */
const priceMoved = (failure: string) => failure.includes('0x1771') || failure.includes('insufficient funds');
/** A closed account comes back from a simulation as an empty entry with no lamports. */
const gone = (a: { lamports: bigint; data: Uint8Array } | null) => a === null || (a.lamports === 0n && a.data.length === 0);

/**
 * A plain wallet that holds this token in its associated account. `getTokenLargestAccounts` is
 * rate-limited to nothing on the public RPC, but the token program's own accounts can be listed by
 * mint, reading only owner and amount.
 */
async function holderOf(mint: Address, program: Address): Promise<{ owner: Address; account: Address; balance: bigint } | null> {
  const res = await fetch(RPC_URL, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0', id: 1, method: 'getProgramAccounts',
      params: [program, { encoding: 'base64', dataSlice: { offset: 32, length: 40 }, filters: [{ memcmp: { offset: 0, bytes: mint } }] }],
    }),
  }).then(r => r.json() as Promise<{ result?: { pubkey: string; account: { data: [string, string] } }[] }>).catch(() => null);
  const decoder = getAddressDecoder();
  const rows = (res?.result ?? []).map(r => {
    const d = Uint8Array.from(Buffer.from(r.account.data[0], 'base64'));
    return { account: address(r.pubkey), owner: decoder.decode(d.subarray(0, 32)), balance: new DataView(d.buffer, d.byteOffset).getBigUint64(32, true) };
  }).sort((a, b) => (a.balance > b.balance ? -1 : 1)).slice(0, 40);
  // The public RPC sometimes closes the connection on a large read; that is no holder, not a failure.
  const wallets = await fetchAccounts(rpc, rows.map(r => r.owner)).catch(() => null);
  if (!wallets) return null;
  for (const r of rows) {
    const wallet = wallets.get(r.owner);
    if (!wallet || wallet.owner !== SYSTEM_PROGRAM || wallet.lamports < 50_000_000n || r.balance === 0n) continue;
    if ((await ataOf(r.owner, mint, program)) !== r.account) continue;
    return { owner: r.owner, account: r.account, balance: r.balance };
  }
  return null;
}

type Listed = { id: string; symbol: string; liquidity?: number };
const list = async (url: string) => fetch(url).then(r => r.json() as Promise<Listed[]>).catch(() => [] as Listed[]);
const trending = await list('https://api.jup.ag/tokens/v2/toptrending/1h?limit=100');
// Most tokens still on a bonding curve are new, and the newest are listed separately.
const listed = CURVE ? [...await list('https://api.jup.ag/tokens/v2/recent'), ...trending] : trending;
const candidates = listed.filter((t, i) =>
  t.id.endsWith('pump') && (CURVE || (t.liquidity ?? 0) > 5_000) && listed.findIndex(x => x.id === t.id) === i);
log(`${candidates.length} Pump.fun tokens listed; looking for ${WANTED} that route through ${MARKET.name}\n`);

let found = 0;
for (const t of candidates) {
  if (found >= WANTED) break;
  const mint = address(t.id);
  const info = (await fetchMints(rpc, [mint])).get(mint);
  if (!info) continue;
  const buyOnce = async () => prepareProtectedSwap({ rpc, jupiter, settings }, {
    owner: BUYER, ephemeral: await createEphemeral(), inputMint: WSOL_MINT, outputMint: mint, amountIn: 20_000_000n,
    inputDecimals: 9, outputDecimals: info.decimals, version: 0, acceptedCostBps: 5_000n,
  });
  let prepared;
  try {
    prepared = await buyOnce();
  } catch (e) {
    log(`     ${t.symbol.padEnd(10)} not built: ${e instanceof OrientimError ? e.code : 'error'} ${(e as Error).message.slice(0, 80)}`);
    continue;
  }
  const route = prepared.quote.route.join(' → ');
  if (!prepared.quote.route.includes(MARKET.label)) { log(`     ${t.symbol.padEnd(10)} routes elsewhere (${route})`); continue; }
  found++;
  const rent = prepared.policy.takerRent;
  check(t.symbol, `buy: built, verified and certified through ${MARKET.name}`, true, `${route}, ${prepared.size} bajt`);
  check(t.symbol, "buy: the rent sent to the temporary key is the market's, under the ceiling",
    rent > 0n && rent <= MAX_TAKER_RENT_LAMPORTS && prepared.oneTimeCosts.routeRent === rent && prepared.certificate.routeRentLamports === rent,
    `${rent} lamports`);
  const E = prepared.policy.ephemeral;
  const wOut = prepared.policy.accounts.wOut!;
  const before = tokenAmountOf((await fetchAccounts(rpc, [wOut])).get(wOut)?.data);
  // E, E_in, W_out, and the account the market opens for E when Orientim closes it.
  const watchBuy = (p: Awaited<ReturnType<typeof prepareProtectedSwap>>) => [p.policy.ephemeral, p.policy.accounts.eIn, wOut, ...(p.policy.accounts.routeAccount ? [p.policy.accounts.routeAccount] : [])];
  let run = await execute(prepared.transaction, watchBuy(prepared));
  if (!run.ok && priceMoved(run.failure)) {
    // The price moved between building and executing, and a minimum reverted the swap as it should.
    // Build once more on the current price.
    log(`     ${t.symbol.padEnd(10)} the price moved past the tolerance; building again`);
    try {
      prepared = await buyOnce();
    } catch (e) {
      // Moving past the tolerance again in the seconds a build takes: Orientim refused, as it should.
      if (!(e instanceof OrientimError && /price moved/i.test(e.message))) throw e;
      check(t.symbol, 'buy: the final transaction executes', null, 'çmimi lëvizi përtej tolerancës edhe në ndërtimin e dytë');
      continue;
    }
    run = await execute(prepared.transaction, watchBuy(prepared));
  }
  if (!run.ok && priceMoved(run.failure)) {
    // The market outran the tolerance twice in a row; the minimum reverted the swap both times.
    check(t.symbol, 'buy: the final transaction executes', null, `çmimi lëvizi përtej tolerancës dy herë: ${run.failure.slice(0, 80)}`);
    continue;
  }
  check(t.symbol, 'buy: the final transaction executes', run.ok, run.failure);
  if (run.ok) {
    check(t.symbol, 'buy: the temporary key ends with nothing', gone(run.after[0]), run.after[0] ? `${run.after[0].lamports} lamports left` : '');
    check(t.symbol, 'buy: the temporary account is gone', gone(run.after[1]));
    // The account the market opened for E is closed in the same swap and its rent goes back to the
    // wallet; what the market keeps is the rest (the curve's own growth, when any).
    const refund = prepared.policy.routeRefund;
    check(
      t.symbol, "buy: the market's account under the temporary key is closed and its rent returned",
      refund > 0n && refund <= rent && prepared.oneTimeCosts.routeRefund === refund && prepared.certificate.routeRefundLamports === refund
        && !!prepared.policy.accounts.routeAccount && gone(run.after[3] ?? null),
      `${refund} of ${rent} lamports back; the market keeps ${rent - refund}`,
    );
    const arrived = run.after[2] ? tokenAmountOf(run.after[2].data) - before : 0n;
    check(t.symbol, 'buy: at least the minimum arrived', arrived >= prepared.policy.minOut, `arritën ${arrived}, minimumi ${prepared.policy.minOut}`);
  }

  // ------------------------------------------------------------ the same token sold back for SOL
  await sleep(2_000);
  const holder = await holderOf(mint, info.program as Address);
  if (!holder) { check(t.symbol, 'sell: needs a holder the public RPC would name', null, 'mbajtësi nuk u gjet'); continue; }
  // A small sale: 1% of the holder's balance, and no more than the purchase above got. Some holders
  // own nearly the whole supply, and 1% of that is more than a bonding curve can buy back.
  const bought = prepared.quote.outAmount;
  const amountIn = holder.balance / 100n < bought ? holder.balance / 100n : bought;
  jupiterSaid = [];
  const sellOnce = async () => {
    const sell = await prepareProtectedSwap({ rpc, jupiter, settings }, {
      owner: holder.owner, ephemeral: await createEphemeral(), inputMint: mint, outputMint: WSOL_MINT,
      amountIn, inputDecimals: info.decimals, outputDecimals: 9, version: 0, acceptedCostBps: 5_000n,
    });
    return { sell, done: await execute(sell.transaction, [sell.policy.ephemeral, sell.policy.accounts.eIn, sell.policy.accounts.eOut!]) };
  };
  try {
    let { sell, done } = await sellOnce();
    if (!done.ok && priceMoved(done.failure)) {
      log(`     ${t.symbol.padEnd(10)} the price moved past the tolerance; building the sell again`);
      ({ sell, done } = await sellOnce());
    }
    check(t.symbol, 'sell: built, verified and certified', true, `${sell.quote.route.join(' → ')}, rent ${sell.policy.takerRent}, ${sell.policy.routeRefund} back`);
    if (!done.ok && priceMoved(done.failure)) {
      check(t.symbol, 'sell: the final transaction executes', null, `çmimi lëvizi përtej tolerancës dy herë: ${done.failure.slice(0, 80)}`);
      continue;
    }
    check(t.symbol, 'sell: the final transaction executes', done.ok, done.failure);
    if (done.ok) check(t.symbol, 'sell: the key and both temporary accounts end empty', done.after.every(gone));
  } catch (e) {
    // The holder is someone else's wallet, and it keeps trading. When it no longer holds the
    // amount, the refusal is about the holder, not about Orientim.
    const now = tokenAmountOf((await fetchAccounts(rpc, [holder.account])).get(holder.account)?.data);
    if (now < amountIn) { check(t.symbol, 'sell: needs a holder that still holds the amount', null, `mbajtësi shiti ndërkohë (${now} < ${amountIn})`); continue; }
    const code = e instanceof OrientimError ? e.code : 'error';
    // The unrestricted quote, asked for before anything of Orientim's applies, had no route either:
    // Jupiter had nothing to offer for this sale at that moment, which says nothing about Orientim.
    if (code === 'no-route' && (e as Error).message.startsWith('Jupiter could not quote')) {
      check(t.symbol, 'sell: needs a route Jupiter itself offers', null, `Jupiter nuk dha rrugë: ${[...new Set(jupiterSaid)].join(' | ')}`);
      continue;
    }
    check(t.symbol, 'sell: built, verified and certified', false,
      `${code}: ${(e as Error).message.slice(0, 200)}${jupiterSaid.length ? ` Jupiter: ${[...new Set(jupiterSaid)].join(' | ')}` : ''}`);
  }
}

mkdirSync('tests/integration/results', { recursive: true });
const failed = rows.filter(r => r.ok === false).length;
const skipped = rows.filter(r => r.ok === null).length;
const passed = rows.length - failed - skipped;
writeFileSync(`tests/integration/results/${MARKET.results}.md`, [
  `# ${MARKET.test} — ${MARKET.title}`,
  '',
  `${passed}/${rows.length - skipped} kontrolle kaluan${skipped ? `, ${skipped} u anashkaluan` : ''}, në ${found} tokenë që kalojnë nëpër ${CURVE ? 'bonding curve' : 'PumpSwap'}. Asgjë nuk u nënshkrua e nuk u dërgua.`,
  '',
  '| Tokeni | Kontrolli | Rezultati | Detaji |',
  '| --- | --- | --- | --- |',
  ...rows.map(r => `| ${r.token} | ${r.name} | ${r.ok === null ? 'anashkaluar' : r.ok ? 'kaloi' : 'DËSHTOI'} | ${r.detail || '—'} |`),
  '',
].join('\n'));
log(`\n${MARKET.test} ${passed}/${rows.length - skipped}${skipped ? ` (${skipped} skipped)` : ''} on ${found} tokens through ${MARKET.name}  →  tests/integration/results/${MARKET.results}.md`);
process.exit(failed || found === 0 ? 1 : 0);
