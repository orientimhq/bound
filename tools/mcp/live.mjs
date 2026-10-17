// The MCP server on mainnet, driven as a client drives it: one server, many calls, against
// orientim.com, the owner's RPC and Jupiter. .github/workflows/mcp-live.yml runs it on Linux, macOS and
// Windows, by hand.
//
//   node tools/mcp/live.mjs npx -y @orientimhq/swap@2.0.1 mcp
//   node tools/mcp/live.mjs node node_modules/@orientimhq/swap/dist/bin/orientim.mjs mcp
//
//   SOLANA_RPC_URL, JUPITER_API_KEY   the owner's RPC and Jupiter key
//   LIVE_WALLET_KEYPAIR               optional: a test wallet's keypair file, holding 0.02 SOL or more
//   LIVE_SWAPS=1                      optional: also swap for real, 0.002 SOL to USDC and back
//   LIVE_SWAPS=full                   optional: and every kind of token, each bought and sold back
//
// Without a wallet, a new empty one is made: the protocol, its balances on the RPC, Orientim's key
// message signed and answered by the real server (wallet-empty), and refused input. With one, every
// quote below is priced and verified on the RPC, nothing signed; the owner's limits are tried with a
// policy file. Only LIVE_SWAPS signs anything. Exit 1 when a case failed, 2 when one could not be
// proven for load (a 429, a busy RPC): incomplete is not a pass.
import { spawn } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import { appendFileSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

const [command, ...commandArgs] = process.argv.slice(2);
if (!command) {
  console.error('usage: node tools/mcp/live.mjs <the server\'s command...>');
  process.exit(2);
}
const SOL = 'So11111111111111111111111111111111111111112';
const MINTS = {
  USDC: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
  USDT: 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB',
  JUP: 'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN',
  BONK: 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263',
  WIF: 'EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm',
  JitoSOL: 'J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn',
  PYUSD: '2b1kV6DkPAnxd5ixfnxCpjxmKwqjjaYmCZfHsFu24GXo',
};
const nameOf = mint => mint === SOL ? 'SOL' : Object.keys(MINTS).find(k => MINTS[k] === mint) ?? mint.slice(0, 6);
const LOAD = /^(rate-limited|unavailable|busy|timeout|rpc-|too-many)/;
const sleep = ms => new Promise(r => setTimeout(r, ms));

const rows = [];
function report(group, name, status, detail = '') {
  rows.push({ group, name, status, detail });
  console.log(`${{ ok: 'ok  ', warn: 'WARN', skip: 'SKIP' }[status] ?? 'FAIL'} [${group}] ${name}${detail ? `: ${detail}` : ''}`);
  // The run's annotations name what failed, beside the summary.
  if (process.env.GITHUB_ACTIONS && (status === 'fail' || status === 'warn')) {
    const one = s => String(s).replace(/[\r\n%]/g, ' ');
    console.log(`::${status === 'fail' ? 'error' : 'warning'} title=${one(`${group}: ${name}`).replace(/[:,]/g, ' ')}::${one(detail)}`);
  }
}

// One MCP client session over the server's stdio.
class Client {
  constructor(env) {
    // npx is npx.cmd on Windows: only a shell finds it, as a client's does.
    this.child = spawn(command, commandArgs, { env, stdio: ['pipe', 'pipe', 'pipe'], shell: process.platform === 'win32' && !/node(\.exe)?$/i.test(command) });
    this.next = 1;
    this.waiting = new Map();
    this.stderr = '';
    this.child.stderr.setEncoding('utf8').on('data', d => { this.stderr += d; });
    createInterface({ input: this.child.stdout }).on('line', line => {
      let m;
      try { m = JSON.parse(line); } catch { return; }
      const w = this.waiting.get(m.id);
      if (w) { this.waiting.delete(m.id); w(m); }
    });
    this.closed = new Promise(r => this.child.on('close', r));
  }
  request(method, params, timeoutMs = 60_000) {
    const id = this.next++;
    return new Promise((done, fail) => {
      const timer = setTimeout(() => { this.waiting.delete(id); fail(new Error(`${method}: no answer in ${timeoutMs / 1000}s`)); }, timeoutMs);
      this.waiting.set(id, m => { clearTimeout(timer); done(m); });
      this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });
  }
  notify(method) { this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method })}\n`); }
  async call(name, args = {}, timeoutMs = 180_000) {
    const m = await this.request('tools/call', { name, arguments: args }, timeoutMs);
    if (m.error) return { rpcError: m.error };
    return { isError: m.result?.isError === true, ...(m.result?.structuredContent ?? {}) };
  }
  async close() { this.child.stdin.end(); await this.closed; }
}

async function start(env, group) {
  const client = new Client(env);
  const init = await client.request('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'orientim-live', version: '1' } }, 180_000);
  client.notify('notifications/initialized');
  report(group, 'initialize', init.result?.serverInfo?.version ? 'ok' : 'fail', `${init.result?.serverInfo?.name} ${init.result?.serverInfo?.version}, protocol ${init.result?.protocolVersion}`);
  return client;
}

const units = (whole, decimals) => {
  const [i, f = ''] = String(whole).split('.');
  return BigInt(i + f.padEnd(decimals, '0').slice(0, decimals));
};
const errorLine = a => a.rpcError ? `JSON-RPC ${a.rpcError.code}: ${a.rpcError.message}` : `${a.error?.code ?? `exit ${a.exitCode}`}: ${(a.error?.line ?? a.meaning ?? '').slice(0, 220)}`;

/** A quote that should price: checked as the model is told to read it. */
async function quoteCase(client, group, name, args) {
  const a = await client.call('orientim_quote', args);
  if (!a.ok) {
    report(group, name, LOAD.test(a.error?.code ?? '') ? 'warn' : 'fail', errorLine(a));
    return a;
  }
  const s = a.summary;
  const problems = [];
  if (typeof a.quoteId !== 'string') problems.push('no quoteId');
  if (s.pay.amount !== a.request.amount) problems.push(`pays ${s.pay.amount}, asked ${a.request.amount}`);
  if (units(s.receiveAtLeast.amount, a.request.outputDecimals) > units(s.expected.amount, a.request.outputDecimals)) problems.push('the minimum is above the expected');
  if (units(s.receiveAtLeast.amount, a.request.outputDecimals) <= 0n) problems.push('a minimum of nothing');
  if (s.orientimFee.mint === args.inputMint) {
    const bps = Number(units(s.orientimFee.amount, a.request.inputDecimals) * 10_000n / units(s.pay.amount, a.request.inputDecimals));
    if (bps > 30) problems.push(`fee ${bps} bps`);
  }
  if (!a.summary.approvedUntil) problems.push('no approvedUntil');
  report(group, name, problems.length ? 'fail' : 'ok', problems.length ? problems.join('; ')
    : `${s.pay.amount} ${nameOf(args.inputMint)} → at least ${s.receiveAtLeast.amount} ${nameOf(args.outputMint)} (expected ${s.expected.amount}), fee ${s.orientimFee.amount} ${nameOf(s.orientimFee.mint)}, impact ${s.priceImpactBps} bps, slippage ${s.slippageBps} bps`);
  return a;
}

/** A call that should be refused with `code`, nothing signed. */
async function refusedCase(client, group, name, tool, args, codes, exitCodes) {
  const a = await client.call(tool, args);
  const code = a.rpcError ? `rpc${a.rpcError.code}` : a.error?.code;
  if (!a.ok && LOAD.test(code ?? '')) return report(group, name, 'warn', errorLine(a));
  const right = !a.ok && codes.includes(code) && (!exitCodes || exitCodes.includes(a.exitCode));
  report(group, name, right ? 'ok' : 'fail', `${a.ok ? 'accepted' : errorLine(a)}`);
  return a;
}

const home = mkdtempSync(join(tmpdir(), 'orientim-live-'));
const env = { ...process.env, HOME: home, USERPROFILE: home };
for (const name of ['ORIENTIM_API_KEY', 'ORIENTIM_POLICY', 'ORIENTIM_STATE_DIR']) delete env[name];
if (!env.SOLANA_RPC_URL) {
  console.error('Set SOLANA_RPC_URL.');
  process.exit(2);
}

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function base58(bytes) {
  let n = BigInt(`0x${Buffer.from(bytes).toString('hex')}`);
  let out = '';
  while (n > 0n) { out = B58[Number(n % 58n)] + out; n /= 58n; }
  for (const b of bytes) { if (b) break; out = `1${out}`; }
  return out;
}

// ── An empty wallet: everything that needs no funds ───────────────────────────────────────────────
{
  const group = 'empty wallet';
  const keypair = join(home, 'empty-wallet.json');
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const pub = publicKey.export({ format: 'der', type: 'spki' }).subarray(12);
  writeFileSync(keypair, JSON.stringify([...privateKey.export({ format: 'der', type: 'pkcs8' }).subarray(16), ...pub]));
  const client = await start({ ...env, ORIENTIM_WALLET_KEYPAIR: keypair, ORIENTIM_STATE_DIR: join(home, 'empty-state') }, group);
  const tools = await client.request('tools/list', {});
  const names = tools.result?.tools?.map(t => t.name) ?? [];
  report(group, 'tools/list', names.join() === 'orientim_wallet,orientim_quote,orientim_swap,orientim_recover' ? 'ok' : 'fail', names.join(', '));
  const w = await client.call('orientim_wallet', { mints: [MINTS.USDC, MINTS.PYUSD] });
  report(group, 'balances on the RPC', w.ok && w.wallet === base58(pub) && w.sol?.baseUnits === '0' && w.tokens?.length === 2 ? 'ok' : 'fail', w.ok ? `${w.wallet}: ${w.sol.amount} SOL, ${w.tokens.map(t => `${t.amount} ${nameOf(t.mint)} (${t.decimals} dp)`).join(', ')}` : errorLine(w));
  await refusedCase(client, group, 'Orientim\'s key: signed, then refused to an empty wallet', 'orientim_quote', { inputMint: SOL, outputMint: MINTS.USDC, amount: '0.001' }, ['wallet-empty']);
  await refusedCase(client, group, 'a name instead of a mint', 'orientim_quote', { inputMint: 'USDC', outputMint: SOL, amount: '1' }, ['input']);
  await refusedCase(client, group, 'the same token both sides', 'orientim_quote', { inputMint: SOL, outputMint: SOL, amount: '1' }, ['input']);
  await refusedCase(client, group, 'more decimals than the token has', 'orientim_quote', { inputMint: MINTS.USDC, outputMint: SOL, amount: '1.1234567' }, ['input']);
  await refusedCase(client, group, 'a quote that was never made', 'orientim_swap', { quoteId: 'deadbeefdeadbeef' }, ['input']);
  const r = await client.call('orientim_recover');
  report(group, 'recover with nothing kept', r.ok ? 'ok' : 'fail', r.ok ? r.meaning : errorLine(r));
  await client.close();
}

// ── The test wallet: quotes on mainnet, nothing signed ────────────────────────────────────────────
const keypair = process.env.LIVE_WALLET_KEYPAIR;
let funded = false;
if (!keypair) {
  report('test wallet', 'quotes and swaps', 'skip', 'no LIVE_WALLET_KEYPAIR: add the secret TEST_WALLET_KEYPAIR to quote and swap');
} else {
  const group = 'quotes';
  const client = await start({ ...env, ORIENTIM_WALLET_KEYPAIR: keypair, ORIENTIM_STATE_DIR: join(home, 'state') }, group);
  const w = await client.call('orientim_wallet', { mints: [MINTS.USDC] });
  const lamports = w.ok ? BigInt(w.sol.baseUnits) : 0n;
  funded = lamports >= 15_000_000n;
  report(group, 'the test wallet', funded ? 'ok' : 'fail', w.ok ? `${w.wallet}: ${w.sol.amount} SOL, ${w.tokens[0].amount} USDC${funded ? '' : ': fund it with 0.02 SOL or more'}` : errorLine(w));
  if (funded) {
    const pairs = [
      ['SOL → USDC', { inputMint: SOL, outputMint: MINTS.USDC, amount: '0.002' }],
      ['SOL → USDT', { inputMint: SOL, outputMint: MINTS.USDT, amount: '0.002' }],
      ['SOL → JUP', { inputMint: SOL, outputMint: MINTS.JUP, amount: '0.002' }],
      ['SOL → BONK (memecoin)', { inputMint: SOL, outputMint: MINTS.BONK, amount: '0.002' }],
      ['SOL → WIF (memecoin)', { inputMint: SOL, outputMint: MINTS.WIF, amount: '0.002' }],
      ['SOL → JitoSOL (LST)', { inputMint: SOL, outputMint: MINTS.JitoSOL, amount: '0.002' }],
      ['SOL → PYUSD (Token-2022)', { inputMint: SOL, outputMint: MINTS.PYUSD, amount: '0.002' }],
      ['SOL → USDC, slippage auto', { inputMint: SOL, outputMint: MINTS.USDC, amount: '0.002', slippageBps: 'auto' }],
      ['SOL → USDC, slippage 1%', { inputMint: SOL, outputMint: MINTS.USDC, amount: '0.002', slippageBps: 100 }],
      ['SOL → USDC, 0.0005 SOL', { inputMint: SOL, outputMint: MINTS.USDC, amount: '0.0005' }],
    ];
    for (const [name, args] of pairs) {
      await quoteCase(client, group, name, args);
      await sleep(1500);
    }
    await refusedCase(client, group, 'more SOL than the wallet holds', 'orientim_quote', { inputMint: SOL, outputMint: MINTS.USDC, amount: '1000' }, ['insufficient-sol', 'insufficient-balance', 'simulation-failed', 'other'], [1]);
    await refusedCase(client, group, 'USDC the wallet does not hold', 'orientim_quote', { inputMint: MINTS.USDC, outputMint: SOL, amount: '1000000' }, ['insufficient-balance', 'simulation-failed', 'other'], [1]);
  }
  await client.close();

  if (funded) {
    // The owner's limits: refused before anything is prepared.
    const group = 'owner\'s limits';
    const policy = join(home, 'policy.json');
    writeFileSync(policy, JSON.stringify({ maxAmountIn: { [SOL]: '1000000' }, allowedOutputMints: [MINTS.USDC], maxSlippageBps: 50 }));
    const limited = await start({ ...env, ORIENTIM_WALLET_KEYPAIR: keypair, ORIENTIM_STATE_DIR: join(home, 'state'), ORIENTIM_POLICY: policy }, group);
    await quoteCase(limited, group, 'within the limits: 0.0005 SOL → USDC', { inputMint: SOL, outputMint: MINTS.USDC, amount: '0.0005' });
    await refusedCase(limited, group, 'over the per-swap limit', 'orientim_quote', { inputMint: SOL, outputMint: MINTS.USDC, amount: '0.002' }, ['amount-over-limit'], [1]);
    await refusedCase(limited, group, 'a token the wallet may not buy', 'orientim_quote', { inputMint: SOL, outputMint: MINTS.BONK, amount: '0.0005' }, ['output-not-allowed'], [1]);
    await refusedCase(limited, group, 'a token the wallet may not sell', 'orientim_quote', { inputMint: MINTS.USDC, outputMint: SOL, amount: '0.01' }, ['mint-not-allowed', 'output-not-allowed'], [1]);
    await refusedCase(limited, group, 'a tolerance over the owner\'s', 'orientim_quote', { inputMint: SOL, outputMint: MINTS.USDC, amount: '0.0005', slippageBps: 100 }, ['slippage-over-limit'], [1]);
    await limited.close();
  }
}

// ── Real swaps, only when asked ───────────────────────────────────────────────────────────────────
// LIVE_SWAPS=1: 0.002 SOL to USDC and back. LIVE_SWAPS=full: also every kind of token the skill
// takes, each bought and sold back: a stablecoin, a DeFi token, two memecoins, an LST and a
// Token-2022 token, one token for another with no SOL on either side, a tolerance chosen by Jupiter
// and one set by hand, and a small amount.
const solscan = [];
const TOKEN_PAIRS = [
  ['USDT (stablecoin)', MINTS.USDT, {}],
  ['JUP (DeFi), slippage auto', MINTS.JUP, { slippageBps: 'auto' }],
  ['BONK (memecoin, 5 decimals)', MINTS.BONK, {}],
  ['WIF (memecoin), slippage 1%', MINTS.WIF, { slippageBps: 100 }],
  ['JitoSOL (LST)', MINTS.JitoSOL, {}],
  ['PYUSD (Token-2022)', MINTS.PYUSD, {}],
];

/** One real swap from a fresh quote, checked against that quote and the wallet. */
async function swapCase(client, group, inputMint, outputMint, amount, extra = {}) {
  const pair = `${nameOf(inputMint)} → ${nameOf(outputMint)}`;
  const holding = mint => mint === SOL ? undefined : client.call('orientim_wallet', { mints: [mint] });
  const before = await holding(outputMint);
  const q = await quoteCase(client, group, `quote ${amount} ${pair}`, { inputMint, outputMint, amount, ...extra });
  if (!q.ok) return undefined;
  const dp = q.request.outputDecimals;
  const s = await client.call('orientim_swap', { quoteId: q.quoteId }, 420_000);
  if (s.signature) solscan.push(`${pair}: ${s.explorer}`);
  const good = s.ok && s.outcome === 'confirmed' && typeof s.signature === 'string'
    && units(s.received?.amount ?? '0', dp) >= units(q.summary.receiveAtLeast.amount, dp);
  report(group, `swap ${pair}`, good ? 'ok' : s.ok === false && LOAD.test(s.error?.code ?? '') ? 'warn' : 'fail',
    good ? `received ${s.received.amount} ${nameOf(outputMint)} (at least ${q.summary.receiveAtLeast.amount}), fee ${q.summary.orientimFee.amount} ${nameOf(q.summary.orientimFee.mint)}, ${s.explorer}` : errorLine(s));
  if (!good) return undefined;
  if (before?.ok) {
    await sleep(2000);
    const after = await holding(outputMint);
    const gained = after?.ok ? units(after.tokens[0].amount, dp) - units(before.tokens[0].amount, dp) : -1n;
    report(group, `the ${nameOf(outputMint)} arrived in the wallet`, gained >= units(s.received.amount, dp) ? 'ok' : 'fail', `${after?.tokens?.[0]?.amount} now, ${before.tokens[0].amount} before`);
  }
  return { quote: q, swap: s };
}

/** Bought with SOL, then all of it sold back. */
async function roundTrip(client, group, mint, amount, extra) {
  const there = await swapCase(client, group, SOL, mint, amount, extra);
  if (there) await swapCase(client, group, mint, SOL, there.swap.received.amount, extra);
  await sleep(1500);
}

const mode = process.env.LIVE_SWAPS;
if ((mode === '1' || mode === 'full') && funded) {
  const group = 'swaps';
  const client = await start({ ...env, ORIENTIM_WALLET_KEYPAIR: keypair, ORIENTIM_STATE_DIR: join(home, 'state') }, group);
  const before = await client.call('orientim_wallet', { mints: [MINTS.USDC] });
  const first = await client.call('orientim_quote', { inputMint: SOL, outputMint: MINTS.USDC, amount: '0.002' });
  const q = await quoteCase(client, group, 'quote 0.002 SOL → USDC', { inputMint: SOL, outputMint: MINTS.USDC, amount: '0.002' });
  if (first.ok && q.ok) {
    await refusedCase(client, group, 'the older quote of the same swap is gone', 'orientim_swap', { quoteId: first.quoteId }, ['input']);
    const s = await client.call('orientim_swap', { quoteId: q.quoteId }, 420_000);
    const good = s.ok && s.outcome === 'confirmed' && typeof s.signature === 'string'
      && units(s.received?.amount ?? '0', 6) >= units(q.summary.receiveAtLeast.amount, 6);
    report(group, 'swap SOL → USDC', good ? 'ok' : 'fail', good ? `received ${s.received.amount} USDC (at least ${q.summary.receiveAtLeast.amount}), ${s.explorer}` : errorLine(s));
    if (s.signature) solscan.push(`SOL → USDC: ${s.explorer}`);
    const again = await client.call('orientim_swap', { quoteId: q.quoteId }, 420_000);
    const once = again.exitCode === 5 || (again.ok && again.signature === s.signature);
    report(group, 'the same quote again never swaps twice', once ? 'ok' : 'fail', once ? again.meaning : errorLine(again));
    if (good) {
      await sleep(2000);
      const after = await client.call('orientim_wallet', { mints: [MINTS.USDC] });
      const gained = after.ok && before.ok ? units(after.tokens[0].amount, 6) - units(before.tokens[0].amount, 6) : -1n;
      report(group, 'the USDC arrived in the wallet', gained >= units(s.received.amount, 6) ? 'ok' : 'fail', `${after.tokens?.[0]?.amount} USDC now, ${before.tokens?.[0]?.amount} before`);
      if (mode === 'full') {
        // One token for another, the fee in neither: USDC to BONK and back, then the USDC to SOL.
        const bonk = await swapCase(client, group, MINTS.USDC, MINTS.BONK, s.received.amount);
        if (bonk) await swapCase(client, group, MINTS.BONK, MINTS.USDC, bonk.swap.received.amount);
        await sleep(1500);
        const w = await client.call('orientim_wallet', { mints: [MINTS.USDC] });
        if (w.ok && units(w.tokens[0].amount, 6) > 0n) await swapCase(client, group, MINTS.USDC, SOL, w.tokens[0].amount);
      } else {
        await swapCase(client, group, MINTS.USDC, SOL, s.received.amount);
      }
    }
  }
  if (mode === 'full') {
    for (const [, mint, extra] of TOKEN_PAIRS) await roundTrip(client, group, mint, '0.002', extra);
    await roundTrip(client, group, MINTS.USDC, '0.0005', {}); // a small amount
  }
  const r = await client.call('orientim_recover');
  report(group, 'recover: everything settled', r.ok ? 'ok' : 'fail', r.ok ? r.meaning : errorLine(r));
  await client.close();
} else if (mode === '1' || mode === 'full') {
  report('swaps', 'real swaps', 'warn', 'not run: no funded test wallet');
}

const failed = rows.filter(r => r.status === 'fail').length;
const warned = rows.filter(r => r.status === 'warn').length;
const verdict = failed ? `${failed} failed` : warned ? `incomplete: ${warned} could not be proven` : 'all passed';
const where = `${process.platform}, Node ${process.version}, ${[command, ...commandArgs].join(' ')}`;
console.log(`\n${verdict} (${where})`);
if (process.env.GITHUB_ACTIONS) console.log(`::notice title=MCP live::${verdict}: ${rows.filter(r => r.status === 'ok').length} passed of ${rows.length}`);
if (process.env.GITHUB_STEP_SUMMARY) {
  const cell = s => String(s).replaceAll('|', '\\|').replaceAll('\n', ' ');
  appendFileSync(process.env.GITHUB_STEP_SUMMARY, [
    `### MCP live: ${verdict}`, '', `${where}`, '',
    '| | Group | Case | Detail |', '| --- | --- | --- | --- |',
    ...rows.map(r => `| ${{ ok: '✅', warn: '⚠️', skip: '⏭️' }[r.status] ?? '❌'} | ${cell(r.group)} | ${cell(r.name)} | ${cell(r.detail)} |`),
    '', ...solscan.map(u => `- ${u}`), '',
  ].join('\n'));
}
process.exit(failed ? 1 : warned ? 2 : 0);
