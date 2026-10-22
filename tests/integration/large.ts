/**
 * T7: does the protection behave the same for a large swap as for a small one?
 *
 * The guarantee itself does not depend on the amount — the same instructions, the same rules, the
 * same temporary account. What does depend on it is the route: Jupiter splits a large amount over
 * more pools, and a v0 transaction holds at most 64 accounts and 1232 bytes. This test prepares
 * real swaps at growing sizes and reports, for each one, whether Orientim could build a protected
 * transaction, how big it got, and what the market charges for the size (price impact).
 *
 * Nothing is signed or sent. The simulation uses a public exchange wallet as fee payer.
 *
 *   node tests/integration/large.ts [--pairs USDC-SOL,SOL-USDC]
 */
import { address, getAddressDecoder, getBase64EncodedWireTransaction } from '@solana/kit';
import type { Address } from '@solana/kit';
import { mkdirSync, writeFileSync } from 'node:fs';
import { JUPITER_PROGRAM, SYSTEM_PROGRAM, WSOL_MINT } from '@orientimhq/swap/core';
import { ataOf, tokenAmountOf } from '@orientim/builder';
import { createEphemeral, createRetryingRpc, fetchMints } from '@orientimhq/swap/solana';
import { OrientimError, createJupiterClient, DEFAULT_SETTINGS, prepareProtectedSwap } from '@orientim/jupiter';

const arg = (name: string, fallback: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : fallback;
};

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
const M = {
  SOL: WSOL_MINT,
  USDC: address('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'),
  USDT: address('Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB'),
  BONK: address('DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263'),
};
type Sym = keyof typeof M;

// Public exchange wallets, used only as a plausible fee payer for the simulation.
const WALLETS = [
  'GJRs4FwHtemZ5ZE9x3FNvJ8TMwitKTh21yxdRPqn7npE', '5tzFkiKscXHK5ZXCGbXZxdw7gTjjD1mBwuoFbhUvuAi9',
  '2AQdpHJ2JpcEgPiATUXjQxA8QmafFegfQwSLWSprPicm', '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM',
].map(a => address(a));

/** Sizes to try, in whole units of the input token: roughly $1k, $10k, $100k, $1M and $10M. */
const SIZES: Record<Sym, number[]> = {
  USDC: [1_000, 10_000, 100_000, 1_000_000, 10_000_000],
  SOL: [5, 50, 500, 5_000, 50_000],
  USDT: [1_000, 10_000, 100_000, 1_000_000, 10_000_000],
  BONK: [50_000_000, 500_000_000, 5_000_000_000, 50_000_000_000, 500_000_000_000],
};

const PAIRS = arg('pairs', 'USDC-SOL,SOL-USDC,USDC-BONK').split(',').map(p => p.split('-') as [Sym, Sym]);
const log = (...a: unknown[]) => console.log(...a);
const json = (v: unknown) => JSON.stringify(v, (_, x) => (typeof x === 'bigint' ? Number(x) : x));

const decimals = new Map<string, number>();
for (const [m, info] of await fetchMints(rpc, [...new Set(PAIRS.flat().map(s => M[s]))])) decimals.set(m, info.decimals);

const balanceOf = async (owner: Address, mint: Address) => {
  const { value } = await rpc.getAccountInfo(await ataOf(owner, mint), { encoding: 'base64' }).send();
  return value ? tokenAmountOf(Uint8Array.from(Buffer.from(value.data[0], 'base64'))) : 0n;
};

/**
 * Wallets whose own associated account holds a lot of this token. Without one, a large size cannot
 * be simulated at all: the pipeline simulates before it verifies, and a simulation from a wallet
 * that cannot pay fails for lack of funds, which says nothing about the protection.
 */
const holders = new Map<string, Address[]>();
async function richHolders(mint: Address): Promise<Address[]> {
  const cached = holders.get(mint);
  if (cached) return cached;
  holders.set(mint, []); // a rate-limited lookup is not retried for every size
  try {
    return await findHolders(mint);
  } catch (e) {
    log(`  (nuk u lexuan mbajtësit e mëdhenj: ${(e as Error).message.slice(0, 60)})`);
    return [];
  }
}

async function findHolders(mint: Address): Promise<Address[]> {
  const { value: largest } = await rpc.getTokenLargestAccounts(mint, { commitment: 'confirmed' }).send();
  const addresses = largest.map(a => a.address);
  const { value: infos } = await rpc.getMultipleAccounts(addresses, { encoding: 'base64' }).send();
  const candidates: { owner: Address; amount: bigint }[] = [];
  for (const [i, info] of infos.entries()) {
    if (!info) continue;
    const data = Uint8Array.from(Buffer.from(info.data[0], 'base64'));
    const owner = getAddressDecoder().decode(data.subarray(32, 64));
    // Only a plain wallet's associated account: that is how the pipeline derives W_in.
    if ((await ataOf(owner, mint)) === addresses[i]) candidates.push({ owner, amount: tokenAmountOf(data) });
  }
  // The fee payer of a simulation must be a plain account with lamports of its own.
  const { value: wallets } = await rpc.getMultipleAccounts(candidates.map(c => c.owner), { encoding: 'base64' }).send();
  const usable = candidates
    .filter((_, i) => wallets[i]?.owner === SYSTEM_PROGRAM && BigInt(wallets[i]!.lamports) > 100_000_000n)
    .sort((a, b) => (a.amount > b.amount ? -1 : 1))
    .map(c => c.owner);
  holders.set(mint, usable);
  return usable;
}

/** A wallet that can actually pay for this size, so the simulation means something. */
async function payerFor(sym: Sym, amount: bigint): Promise<{ owner: Address; funded: boolean }> {
  if (sym === 'SOL') {
    for (const w of WALLETS) {
      const { value } = await rpc.getBalance(w, { commitment: 'confirmed' }).send();
      if (BigInt(value) > amount + 100_000_000n) return { owner: w, funded: true };
    }
    return { owner: WALLETS[0], funded: false };
  }
  for (const w of [...WALLETS, ...(await richHolders(M[sym]))]) {
    if ((await balanceOf(w, M[sym])) >= amount) return { owner: w, funded: true };
  }
  return { owner: WALLETS[0], funded: false };
}

type Row = {
  pair: string; size: string; ok: boolean; skipped?: boolean; detail: string;
  bytes?: number; legs?: number; hops?: number; impactPct?: number; unitPrice?: number; lossVsSmallestPct?: number;
  simulated?: string; ms?: number;
};

const rows: Row[] = [];
for (const [a, b] of PAIRS) {
  const inDecimals = decimals.get(M[a])!;
  const outDecimals = decimals.get(M[b])!;
  let smallestUnitPrice: number | null = null;

  for (const whole of SIZES[a]) {
    const amountIn = BigInt(Math.round(whole * 10 ** inDecimals));
    const size = `${whole.toLocaleString('en-US')} ${a}`;
    const { owner, funded } = await payerFor(a, amountIn);
    const started = Date.now();
    if (!funded) {
      // Not a pass: nothing was built or simulated, and counting it as one would flatter the report.
      rows.push({ pair: `${a}→${b}`, size, ok: false, skipped: true, detail: 'asnjë wallet publik nuk e mban këtë shumë', ms: 0 });
      log(`--   ${a}→${b} ${size}: u anashkalua (asnjë wallet publik nuk e mban këtë shumë)`);
      continue;
    }
    try {
      const prepared = await prepareProtectedSwap(
        { rpc, jupiter, settings: { ...DEFAULT_SETTINGS, treasury: TREASURY, jupiterProgram: JUPITER_PROGRAM } },
        { owner, ephemeral: await createEphemeral(), inputMint: M[a], outputMint: M[b], amountIn, version: 0, inputDecimals: inDecimals, outputDecimals: outDecimals },
      );
      // Price per unit of input, to see what the size itself costs against the smallest trade.
      const unitPrice = (Number(prepared.quote.outAmount) / 10 ** outDecimals) / (Number(amountIn) / 10 ** inDecimals);
      smallestUnitPrice ??= unitPrice;
      const { value } = await rpc.simulateTransaction(getBase64EncodedWireTransaction(prepared.transaction), {
        encoding: 'base64', sigVerify: false, replaceRecentBlockhash: true, commitment: 'confirmed',
      }).send();
      const simulated = value.err === null ? 'kaloi' : `dështoi ${json(value.err)}`;
      rows.push({
        pair: `${a}→${b}`, size, ok: true, detail: prepared.quote.route.join(' + ').slice(0, 60),
        bytes: prepared.size, legs: prepared.quote.route.length, hops: prepared.intermediates.length,
        impactPct: prepared.quote.priceImpactPct ?? undefined, unitPrice,
        lossVsSmallestPct: smallestUnitPrice ? (1 - unitPrice / smallestUnitPrice) * 100 : 0,
        simulated, ms: Date.now() - started,
      });
    } catch (e) {
      const code = e instanceof OrientimError ? e.code : 'error';
      rows.push({ pair: `${a}→${b}`, size, ok: false, detail: `${code}: ${(e as Error).message.slice(0, 80)}`, ms: Date.now() - started });
    }
    const r = rows.at(-1)!;
    log(
      `${r.ok ? 'OK  ' : 'FAIL'} ${r.pair.padEnd(10)} ${size.padEnd(22)}` +
      (r.ok
        ? `${r.bytes}B  ${r.legs} hop  impact ${r.impactPct?.toFixed(3)}%  humbje vs më e vogla ${r.lossVsSmallestPct?.toFixed(2)}%  simulimi ${r.simulated}`
        : r.detail),
    );
  }
}

mkdirSync('tests/integration/results', { recursive: true });
const skipped = rows.filter(r => r.skipped).length;
const passed = rows.filter(r => r.ok).length;
const refused = rows.length - passed - skipped;
writeFileSync('tests/integration/results/large.md', [
  '# T7 — shuma të mëdha',
  '',
  `${passed} madhësi u ndërtuan, u verifikuan dhe u simuluan; ${refused} u refuzuan; ${skipped} nuk u provuan dot`
  + ' (asnjë wallet publik nuk i mban ato shuma). Asgjë nuk u nënshkrua e nuk u dërgua.',
  '',
  '| Çifti | Shuma | Transaksioni | Hop-e | Ndikimi në çmim | Humbja kundrejt shumës më të vogël | Simulimi | Detaji |',
  '| --- | --- | --- | --- | --- | --- | --- | --- |',
  ...rows.map(r => r.ok
    ? `| ${r.pair} | ${r.size} | ${r.bytes} bajt | ${r.legs} | ${r.impactPct?.toFixed(3)}% | ${r.lossVsSmallestPct?.toFixed(2)}% | ${r.simulated} | ${r.detail} |`
    : `| ${r.pair} | ${r.size} | — | — | — | — | ${r.skipped ? 'nuk u provua' : 'u refuzua'} | ${r.detail} |`),
  '',
  'Ndërtimi dhe verifikimi janë të njëjtë për çdo shumë: ndryshon vetëm route-i, prandaj shumat shumë të mëdha',
  'mund të mos nxënë në një transaksion. Në atë rast Orientim refuzon ta ndërtojë swap-in; nuk e ndan kurrë në disa transaksione.',
  '',
].join('\n'));
log(`\nT7 ${passed} kaluan, ${refused} u refuzuan, ${skipped} nuk u provuan dot (nga ${rows.length})  →  tests/integration/results/large.md`);
