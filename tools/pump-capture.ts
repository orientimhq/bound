/**
 * Jupiter's own routes through Pump.fun bonding curves, recorded with the chain state they were built
 * on: the reference a route built without Jupiter (for a token still on its curve) must reproduce.
 *
 * For each of the newest tokens still on their curve: buys of three sizes in SOL, and a sale of what
 * the middle buy gives. Each record holds the request, Jupiter's answer, and every account of its swap
 * instruction read right after, with the slot. Nothing is signed or sent; the taker is a fresh key.
 *
 *   node tools/pump-capture.ts [out-dir]     (RPC_URL, JUPITER_API_KEY)
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { address, generateKeyPairSigner } from '@solana/kit';
import type { Address } from '@solana/kit';
import { PUMP_CURVE_PROGRAM, WSOL_MINT } from '@orientimhq/swap/core';
import { bondingCurveOf } from '@orientim/builder';
import { createRetryingRpc } from '@orientimhq/swap/solana';
import { createJupiterClient, isCurveRoute } from '@orientim/jupiter';
import type { BuildParams } from '@orientim/jupiter';

const OUT = process.argv[2] ?? 'pump-capture';
const TOKENS = Number(process.env.CAPTURE_TOKENS ?? 6);
const rpc = createRetryingRpc(process.env.RPC_URL || 'https://api.mainnet-beta.solana.com', 8);
const key = process.env.JUPITER_API_KEY || undefined;
const jupiter = createJupiterClient({
  buildUrl: 'https://api.jup.ag/swap/v2/build',
  tokensUrl: 'https://api.jup.ag/tokens/v2/search',
  labelsUrl: 'https://api.jup.ag/swap/v2/program-id-to-label',
  apiKey: key,
  minIntervalMs: key ? 300 : 2_100,
});

const accountsAt = async (list: string[]) => {
  const unique = [...new Set(list)];
  const r = await rpc.getMultipleAccounts(unique.map(a => address(a)), { encoding: 'base64', commitment: 'confirmed' }).send();
  return {
    slot: r.context.slot.toString(),
    accounts: Object.fromEntries(unique.map((a, i) => {
      const v = r.value[i];
      return [a, v ? { owner: v.owner, lamports: v.lamports.toString(), data: v.data[0] } : null];
    })),
  };
};

const listed = await fetch('https://api.jup.ag/tokens/v2/recent', { headers: key ? { 'x-api-key': key } : {} }).then(r => r.json()) as { id: string; symbol: string }[];
mkdirSync(OUT, { recursive: true });
let kept = 0;
for (const t of listed.filter(x => x.id.endsWith('pump'))) {
  if (kept >= TOKENS) break;
  const mint = address(t.id);
  const curve = await bondingCurveOf(mint);
  const state = (await rpc.getAccountInfo(curve, { encoding: 'base64' }).send()).value;
  const data = state ? Buffer.from(state.data[0], 'base64') : null;
  if (!state || state.owner !== PUMP_CURVE_PROGRAM || !data || data.length <= 48 || data[48] !== 0) continue;
  const records: unknown[] = [];
  const taker = (await generateKeyPairSigner()).address;
  const ask = async (inputMint: Address, outputMint: Address, amount: bigint) => {
    const params: BuildParams = { inputMint, outputMint, amount, taker, slippageBps: 300, maxAccounts: 64 };
    const before = await accountsAt([curve]);
    const response = await jupiter.build(params);
    const after = await accountsAt([...response.swapInstruction.accounts.map(a => a.pubkey), curve]);
    records.push({
      params: { ...params, amount: amount.toString() }, curveRoute: isCurveRoute(response), before, response, after,
    });
    return response;
  };
  try {
    for (const lamports of [10_000_000n, 100_000_000n, 1_000_000_000n]) await ask(WSOL_MINT, mint, lamports);
    const middle = records[1] as { response: { outAmount: string } };
    await ask(mint, WSOL_MINT, BigInt(middle.response.outAmount));
  } catch (e) {
    console.log(`${t.symbol}: ${e instanceof Error ? e.message : String(e)}`);
    continue;
  }
  writeFileSync(join(OUT, `${t.id}.json`), `${JSON.stringify({ mint: t.id, symbol: t.symbol, curve, records }, null, 2)}\n`);
  console.log(`${t.symbol} (${t.id}): ${records.length} routes, curve routes ${records.filter(r => (r as { curveRoute: boolean }).curveRoute).length}`);
  kept++;
}
console.log(`${kept} tokens recorded in ${OUT}`);
