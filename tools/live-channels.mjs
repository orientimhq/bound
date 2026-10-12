// Real swaps from the test wallet through the skill's two other ways in, against orientim.com: the
// agent's command line (examples/swap.ts, as an agent runs it) and orientim-verify (as a bot in
// another language runs it, signing the message itself). .github/workflows/mcp-live.yml runs it after
// the MCP server's own swaps, when swaps is 1.
//
//   node tools/live-channels.mjs
//
//   SOLANA_RPC_URL, JUPITER_API_KEY   the owner's RPC and Jupiter key
//   LIVE_WALLET_KEYPAIR               the test wallet's keypair file (0.02 SOL or more)
//   LIVE_OUT                          optional: where the bot's log and the state directory go
//
// Each way pays the fee its own way: SOL to USDC (from the input), USDC back to SOL (from the output),
// and through BONK to JUP (neither can carry it: paid in SOL from the wallet). An order run again is
// refused (exit 5). Then recover settles everything, and tools/pilot-report.ts reads the bot's swaps on
// the chain: the fee reached the treasury, the wallet kept at least its minimum, no order landed twice.
// A few cents of fees in all. Exit 1 when a case failed, 2 when one could not be proven for load.
import { spawnSync } from 'node:child_process';
import { createPrivateKey, sign } from 'node:crypto';
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const SKILL = resolve('skills/orientim-protected-swap');
const SOL = 'So11111111111111111111111111111111111111112';
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const BONK = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263';
const JUP = 'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN';
const LOAD = /^(rate-limited|unavailable|busy|timeout)/;

for (const name of ['SOLANA_RPC_URL', 'LIVE_WALLET_KEYPAIR']) {
  if (!process.env[name]) {
    console.error(`Set ${name}.`);
    process.exit(2);
  }
}
const out = process.env.LIVE_OUT || mkdtempSync(join(tmpdir(), 'orientim-channels-'));
mkdirSync(out, { recursive: true });
const stateDir = join(out, 'state');
const botLog = join(out, 'bot.jsonl');
writeFileSync(botLog, '');
const run = `live-${process.env.GITHUB_RUN_ID ?? Date.now()}`;

const rows = [];
function report(group, name, status, detail = '') {
  rows.push({ group, name, status, detail });
  console.log(`${{ ok: 'ok  ', warn: 'WARN' }[status] ?? 'FAIL'} [${group}] ${name}${detail ? `: ${detail}` : ''}`);
  if (process.env.GITHUB_ACTIONS && status !== 'ok') {
    const one = s => String(s).replace(/[\r\n%]/g, ' ');
    console.log(`::${status === 'fail' ? 'error' : 'warning'} title=${one(`${group}: ${name}`).replace(/[:,]/g, ' ')}::${one(detail)}`);
  }
}

// The test wallet: its key signs here, as a bot's own code would; it is never printed.
const bytes = JSON.parse(readFileSync(process.env.LIVE_WALLET_KEYPAIR, 'utf8'));
const privateKey = createPrivateKey({ key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), Buffer.from(bytes.slice(0, 32))]), format: 'der', type: 'pkcs8' });
const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function base58(b) {
  let n = BigInt(`0x${Buffer.from(b).toString('hex') || '0'}`);
  let s = '';
  while (n > 0n) { s = B58[Number(n % 58n)] + s; n /= 58n; }
  for (const x of b) { if (x) break; s = `1${s}`; }
  return s;
}
const wallet = base58(bytes.slice(32, 64));

const env = { ...process.env, ORIENTIM_WALLET_KEYPAIR: process.env.LIVE_WALLET_KEYPAIR, ORIENTIM_STATE_DIR: stateDir };
for (const name of ['ORIENTIM_POLICY', 'ORIENTIM_API_KEY']) delete env[name];

function verify(command, input) {
  const r = spawnSync(process.execPath, ['bin/orientim-verify.mjs', command], { cwd: SKILL, env, input: JSON.stringify(input ?? {}), encoding: 'utf8', timeout: 600_000 });
  let answer;
  try { answer = JSON.parse(r.stdout); } catch { answer = undefined; }
  return { code: r.status, answer, stderr: r.stderr };
}
function agent(args) {
  const r = spawnSync(process.execPath, ['examples/swap.ts', ...args], { cwd: SKILL, env, encoding: 'utf8', timeout: 600_000 });
  let answer;
  try { answer = JSON.parse(r.stdout); } catch { answer = undefined; }
  const last = r.stderr.trim().split('\n').at(-1) ?? '';
  return { code: r.status, answer, line: last.slice(0, 240) };
}
const codeOf = line => /^([a-z][a-z0-9-]{1,40}): /.exec(line)?.[1] ?? '';

// ── The wallet's own API key, as a bot gets it ────────────────────────────────────────────────────
{
  const challenge = verify('key-challenge', { wallet });
  if (challenge.code !== 0) {
    report('key', 'key challenge', 'fail', JSON.stringify(challenge.answer ?? challenge.stderr).slice(0, 240));
  } else {
    const signature = sign(null, Buffer.from(challenge.answer.message), privateKey).toString('base64');
    const key = verify('key', { message: challenge.answer.message, challenge: challenge.answer.challenge, signature });
    if (key.code === 0 && typeof key.answer?.key === 'string') {
      env.ORIENTIM_API_KEY = key.answer.key;
      if (process.env.GITHUB_ACTIONS) console.log(`::add-mask::${key.answer.key}`);
      report('key', 'the wallet\'s own API key', 'ok', `for ${wallet}, until ${key.answer.expiresAt}`);
    } else {
      report('key', 'the wallet\'s own API key', 'fail', JSON.stringify(key.answer?.error ?? key.stderr).slice(0, 240));
    }
  }
}
if (!env.ORIENTIM_API_KEY) finish();

const recovered = verify('recover');
report('start', 'recover before anything', recovered.code === 0 ? 'ok' : 'fail', `exit ${recovered.code}`);

/** One swap by the agent's command line; a refusal for load or a moving price is tried once more. */
function agentSwap(name, input, output, amount, id) {
  let r = agent(['--in', input, '--out', output, '--amount', amount, '--id', id]);
  if (r.code === 1 && (LOAD.test(codeOf(r.line)) || r.answer?.outcome === 'failed')) {
    spawnSync(process.execPath, ['-e', 'setTimeout(()=>{},8000)']);
    r = agent(['--in', input, '--out', output, '--amount', amount, '--id', id]);
  }
  const ok = r.code === 0 && r.answer?.outcome === 'confirmed' && BigInt(r.answer.received ?? '0') >= BigInt(r.answer.amounts?.minOut ?? '1');
  const load = !ok && LOAD.test(codeOf(r.line));
  report('agent', name, ok ? 'ok' : load ? 'warn' : 'fail', ok
    ? `received ${r.answer.received} (at least ${r.answer.amounts.minOut}), fee ${r.answer.amounts.fee} of ${r.answer.amounts.feeMint ?? input}, https://solscan.io/tx/${r.answer.signature}`
    : `exit ${r.code}, ${r.answer?.outcome ?? ''} ${r.answer?.meaning ?? r.line}`);
  return ok ? r.answer : undefined;
}

// ── The agent: examples/swap.ts ───────────────────────────────────────────────────────────────────
{
  const first = agentSwap('SOL → USDC (fee from the input)', SOL, USDC, '3000000', `${run}-agent-1`);
  if (first) {
    const again = agent(['--in', SOL, '--out', USDC, '--amount', '3000000', '--id', `${run}-agent-1`]);
    report('agent', 'the same order again is never swapped', again.code === 5 ? 'ok' : 'fail', `exit ${again.code}`);
    agentSwap('USDC → SOL (fee from the output)', USDC, SOL, first.received, `${run}-agent-2`);
  }
  const bonk = agentSwap('SOL → BONK', SOL, BONK, '2000000', `${run}-agent-3`);
  if (bonk) {
    const jup = agentSwap('BONK → JUP (fee in SOL from the wallet)', BONK, JUP, bonk.received, `${run}-agent-4`);
    if (jup) agentSwap('JUP → SOL', JUP, SOL, jup.received, `${run}-agent-5`);
  }
}

// ── The bot: orientim-verify prepare, its own signature, finalize ─────────────────────────────────
function botSwap(name, inputMint, outputMint, amountIn, id) {
  const intent = { owner: wallet, inputMint, outputMint, amountIn, id };
  let p = verify('prepare', { intent });
  if (p.code === 1 && LOAD.test(p.answer?.error?.code ?? '')) {
    spawnSync(process.execPath, ['-e', 'setTimeout(()=>{},8000)']);
    p = verify('prepare', { intent });
  }
  if (p.code !== 0) {
    report('bot', name, LOAD.test(p.answer?.error?.code ?? '') ? 'warn' : 'fail', `prepare exit ${p.code}: ${JSON.stringify(p.answer?.error ?? p.answer?.problems ?? '').slice(0, 200)}`);
    return undefined;
  }
  const signature = base58(sign(null, Buffer.from(p.answer.message, 'base64'), privateKey));
  const f = verify('finalize', { checked: p.answer.checked, signature });
  if (f.answer) appendFileSync(botLog, `${JSON.stringify({ checked: p.answer.checked, ...f.answer })}\n`);
  const ok = f.code === 0 && f.answer?.outcome === 'confirmed';
  report('bot', name, ok ? 'ok' : 'fail', ok ? `received ${f.answer.received}, https://solscan.io/tx/${f.answer.signature}` : `finalize exit ${f.code}: ${f.answer?.meaning ?? JSON.stringify(f.answer?.error ?? '').slice(0, 200)}`);
  return ok ? f.answer : undefined;
}
{
  const first = botSwap('SOL → USDC', SOL, USDC, '3000000', `${run}-bot-1`);
  if (first) {
    const again = verify('prepare', { intent: { owner: wallet, inputMint: SOL, outputMint: USDC, amountIn: '3000000', id: `${run}-bot-1` } });
    report('bot', 'the same order again is refused before prepare', again.code === 5 ? 'ok' : 'fail', `exit ${again.code}`);
    botSwap('USDC → SOL', USDC, SOL, first.received, `${run}-bot-2`);
  }
}

// ── Settled, and read on the chain ────────────────────────────────────────────────────────────────
{
  const r = verify('recover');
  report('end', 'recover: everything settled', r.code === 0 ? 'ok' : 'fail', `exit ${r.code}`);
  const pilot = spawnSync(process.execPath, ['tools/pilot-report.ts', '--log', botLog, '--state', stateDir], { env, encoding: 'utf8', timeout: 300_000 });
  const tail = (pilot.stdout + pilot.stderr).trim().split('\n').slice(-3).join(' / ');
  report('end', 'pilot report: fee to the treasury, minimum kept, no order twice', pilot.status === 0 ? 'ok' : 'fail', tail.slice(0, 300));
}
finish();

function finish() {
  const failed = rows.filter(r => r.status === 'fail').length;
  const warned = rows.filter(r => r.status === 'warn').length;
  const verdict = failed ? `${failed} failed` : warned ? `incomplete: ${warned} could not be proven` : 'all passed';
  console.log(`\n${verdict}`);
  if (process.env.GITHUB_ACTIONS) console.log(`::notice title=Live channels::${verdict}: ${rows.filter(r => r.status === 'ok').length} passed of ${rows.length}`);
  if (process.env.GITHUB_STEP_SUMMARY) {
    const cell = s => String(s).replaceAll('|', '\\|').replaceAll('\n', ' ');
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, [
      `### Live channels: ${verdict}`, '', `Wallet ${wallet}`, '',
      '| | Group | Case | Detail |', '| --- | --- | --- | --- |',
      ...rows.map(r => `| ${{ ok: '✅', warn: '⚠️' }[r.status] ?? '❌'} | ${cell(r.group)} | ${cell(r.name)} | ${cell(r.detail)} |`), '',
    ].join('\n'));
  }
  process.exit(failed ? 1 : warned ? 2 : 0);
}
