import { connection } from 'next/server';
import { SiteFooter, SiteHeader } from '@/components/site/Brand';
import { MobileNav } from '@/components/site/MobileNav';
import { DevNav, type DevNavGroup } from '@/components/site/DevNav';
import { GetApiKey } from '@/components/site/GetApiKey';
import { KeyAccess } from '@/components/site/KeyAccess';
import { FEE_BPS, TREASURY } from '@/lib/client/config';
import { signPageChunks } from '@/lib/server/scriptIntegrity';
import { SKILL_EXTENSION, SKILL_FOLDER, SKILL_RELEASE, SKILL_VERSION } from '@/lib/server/skill';

/** The package's public source, and the workflow that publishes it to npm with provenance. */
const SKILL_SOURCE = 'https://github.com/orientimhq/orientim-protected-swap';

export const metadata = {
  title: 'Developers — Orientim',
  description: 'Protected Solana swaps for AI agents and bots: the agent skill, the command line and the API.',
};

/** The fee this build charges, as the other pages state it. */
const feeText = TREASURY ? `${(Number(FEE_BPS) / 100).toLocaleString('en-US', { maximumFractionDigits: 2 })}%` : 'No fee (test deployment)';

/** Why an agent needs this, before the docs: what a developer gets, in their words. */
const PITCH: [string, string][] = [
  ['Signs only what it asked for', 'An extra instruction, another token, a worse price: the agent sees it in the transaction and does not sign.'],
  ['Your limits, not ours', 'An amount per swap, a daily budget and the tokens it may buy, in the owner’s policy, and a price floor per swap.'],
  ['Safe after a crash', 'The skill records each order and settles it after a restart.'],
  ['No sign-up', 'Your agent’s wallet signs a message and gets a key. Then ask it: “swap 5 USDC to SOL with Orientim”.'],
];

/** The sidebar's contents: every entry is a section of this page. */
const NAV: DevNavGroup[] = [
  { title: 'Getting started', items: [['overview', 'Overview'], ['start', 'Quickstart'], ['access', 'API keys']] },
  {
    title: 'Guides',
    items: [['skill', 'AI agents: the skill'], ['cli', 'Bots: the command line'], ['mcp', 'Assistants: the MCP server'], ['how', 'How a protected swap works'], ['verify', 'Verify before you sign'], ['own-routes', 'Your own Jupiter key'], ['recovery', 'Results and recovery']],
  },
  { title: 'API reference', items: [['api', 'Authentication'], ['prepare', 'Prepare'], ['finalize', 'Finalize'], ['keys', 'Key endpoints'], ['errors', 'Errors'], ['limits', 'Rate limits']] },
  { title: 'Reference', items: [['fees', 'Fees and limits'], ['supported', 'Tokens and wallets'], ['downloads', 'Downloads']] },
];

/** Every error the API answers with, and what the caller does about it (AGENT-API.md, "Errors"). */
const ERRORS: [string, string, string][] = [
  ['400', 'bad-request', 'Fix the request; message says which field.'],
  ['400', 'invalid-ticket', 'The ticket was not issued to this API key, or was altered.'],
  ['400', 'transaction-changed', 'The message is not the one Orientim built. Sign the transaction exactly as returned.'],
  ['400', 'bad-signature', 'Key endpoints: the signature does not match, or the challenge expired or was not Orientim’s. Ask for a new challenge.'],
  ['400', 'wallet-changed-transaction', 'Your wallet’s signature is missing or does not match.'],
  ['400', 'bad-session', 'With ownRoutes: the session expired (two minutes after its first round) or was opened for another swap or key. Prepare again without it.'],
  ['401', 'unauthorized', 'Missing, unknown, expired or revoked API key. Get a new one with the wallet.'],
  ['403', 'wrong-wallet', 'The key belongs to another wallet; a self-serve key prepares swaps for its own wallet only.'],
  ['403', 'wallet-empty', 'Key endpoints: the wallet holds less than 0.01 SOL. Fund it, then ask again.'],
  ['404', 'not-enabled', 'The agent API is not available.'],
  ['409', 'price-moved', 'The market cannot meet your minOut. newMinOut is what it supports now: prepare again with it only with the user’s approval.'],
  ['409', 'costs-more', 'The protected route is gapBps below the open market. With the user’s approval, prepare again with acceptCostBps.'],
  ['409', 'routes-needed', 'With ownRoutes: fetch requests from Jupiter with your own key and prepare again with session and every route you have (Your own Jupiter key). The skill does this itself.'],
  ['409', 'session-used', 'With ownRoutes: Orientim already signed another transaction from this session (one per session). Check that one’s signature, then prepare again without the session.'],
  ['409', 'output-balance-changed', 'Your balance of the output token moved since prepare. Check the signature, then prepare again.'],
  ['409', 'output-in-flight', 'Another swap into the same output account (inFlight) is signed and has not landed or expired. Wait Retry-After seconds and finalize again.'],
  ['410', 'expired', 'The transaction’s lifetime passed before finalize. Check the signature, then prepare again.'],
  ['422', 'amount-too-small', 'The amount is below the smallest swap Orientim takes, about 0.004 SOL, or $1 of USDC or USDT (for a swap between two other tokens, its value in SOL). Selling the whole balance of a token (not SOL) is allowed at any size.'],
  ['422', 'unsupported-token, no-route, insufficient-sol, insufficient-balance, simulation-failed, …', 'This swap cannot be built safely right now; message says why.'],
  ['426', 'skill-outdated', 'This copy of the skill is older than Orientim serves. Download the current one; a swap already signed still finalizes.'],
  ['429', 'rate-limited', 'Too many requests for this key (per wallet for a self-serve key). Wait Retry-After seconds.'],
  ['500', 'internal', 'Something unexpected failed; nothing was signed by Orientim or sent. Retry later.'],
  ['503', 'busy, unavailable', 'The market data or the network is overloaded. Wait Retry-After seconds and retry.'],
  ['503', 'fee-unavailable', 'This swap cannot be built right now; nothing was built. Wait and retry.'],
  ['503', 'paused', 'Orientim has paused protected swaps, and issues no API keys meanwhile. Your funds are not affected.'],
  ['503', 'route-format', 'Swaps are briefly unavailable. Wait at least Retry-After (300 seconds).'],
];

const PREPARE_FIELDS: [string, string, string][] = [
  ['owner', 'required', 'The wallet that pays and receives. It signs first.'],
  ['inputMint, outputMint', 'required', 'Mint addresses. SOL is So11111111111111111111111111111111111111112.'],
  ['amountIn', 'required', 'Base units, as a string ("5000000" is 5 USDC). It includes the fee when the fee is taken in the input token.'],
  ['minOut', 'required', 'Your own positive floor, as an integer string in output base units: what your wallet must keep. Get a price independently. This field alone does not replace checking the transaction before signing.'],
  ['slippageBps', 'optional', 'How far below the quote the swap may fill: 10 to 1500 (0.1% to 15%). Default 50, or 300 on a Pump.fun launch curve. The skill’s "auto" asks Jupiter for the trade’s own tolerance (0.5% to 3%) and sends that number; the owner’s policy may cap it (maxSlippageBps).'],
  ['acceptCostBps', 'optional', 'Accept a protected route this many bps below the open market (see costs-more): a whole number, as a number or a string. A route up to 50 bps past it is also taken, so that a market drifting by a few bps does not ask again; minOut still holds.'],
  ['ownRoutes, session, routes', 'optional', 'Routes your agent brings from Jupiter with its own key, in rounds: see Your own Jupiter key. The skill and the command line do it whenever JUPITER_API_KEY is set.'],
];

const PREPARE_ANSWER: [string, string][] = [
  ['ticket', 'Pass it to finalize, with the signed transaction.'],
  ['transaction', 'The unsigned transaction, base64. Verify it, then sign it as your wallet.'],
  ['messageSha256', 'The hash of the transaction message.'],
  ['temporaryAuthority', 'The one-time key of this swap.'],
  ['lastValidBlockHeight, blocksLeft', 'The transaction’s lifetime: 150 blocks, about 40 seconds.'],
  ['amounts', 'amountIn, fee, feeMint, feeBps, quotedOut, minOut and priceImpactPct (null when Jupiter did not state it: unknown, not none).'],
  ['costs', 'The network fee, rent returned and kept, Orientim’s fee in SOL (orientimFeeSolLamports, from whichever side), keptSolLamports: all the SOL the swap costs and does not return, and breakdown: the amount swapped, the fee in its own token and each SOL cost apart.'],
  ['notices, tokens', 'A busy network, and what each token’s issuer can do: freeze balances, mint more, or move and burn them (permanentDelegate).'],
  ['certificate, policy', 'What this exact transaction does, and the rules it was verified against.'],
];

/** What `orientim` exits with (src/cli.ts in @orientimhq/swap). */
const EXIT_CODES: [string, string][] = [
  ['0', 'Done. prepare: sign message. finalize: confirmed, with received. recover: all settled. check: safe to sign.'],
  ['1', 'Refused, or not swapped (failed, expired or rejected), including error.code floor-too-low, price-impact-high, unavailable (a service did not answer: try again after retryAfter) and the owner’s limits (mint-not-allowed, output-not-allowed, amount-over-limit, daily-limit). Nothing is left to settle.'],
  ['2', 'A usage or configuration error, such as a prepare without an order id: the answer says what is missing.'],
  ['3', 'Settle first: an earlier swap may still land, another finalize from this wallet is still running (busy), or the state directory cannot be made or read (a finalize then answers outcome unknown). Run recover; start nothing new.'],
  ['4', 'Orientim said no: error.code is one of the Errors below.'],
  ['5', 'This order id already swapped, or its transaction may still land (prepare, or a finalize of a second transaction for it). It is never swapped twice.'],
];

/** For developers: everything an agent or a bot needs, one section per entry of the sidebar. */
export default async function Page() {
  signPageChunks('developers/page');
  // Rendered per request so that every response carries a fresh CSP nonce (proxy.ts).
  await connection();
  return (
    <div className="site">
      <SiteHeader menu={<MobileNav />} right={<a className="ghost connect" href="#access">Get an API key</a>} />
      <main className="dev-page">
        <div className="container devdocs-grid">
          <aside className="dev-aside">
            <DevNav groups={NAV} />
          </aside>
          <article className="dev-main prose">
            <header className="dev-head">
              <p className="eyebrow">For AI agents and bots</p>
              <h1>Give your agent a wallet, not a blank cheque.</h1>
              <p className="lead">
                An agent that trades needs a wallet. The skill checks each transaction against your limits, on your own RPC,
                before it signs.
              </p>
              <ul className="agent-points dev-pitch">
                {PITCH.map(([title, text]) => <li key={title}><b>{title}</b><span>{text}</span></li>)}
              </ul>
              <div className="cta-actions">
                <a className="button primary-link" href="#access">Get an API key</a>
                <a className="button ghost-link" href="#start">Quickstart</a>
              </div>
            </header>

            <section id="overview">
              <h2>Overview</h2>
              <h3>Your strategy, Orientim&apos;s execution</h3>
              <p>
                Your agent or bot decides when and what to trade, with any strategy: DCA, stop-loss or your own. Each swap it
                decides on goes through Orientim, and your wallet signs it.
              </p>
              <p>The swap route only ever gets the amount you approve, under a one-time key, and if less than your minimum would arrive, the whole transaction reverts. Four ways in:</p>
              <div className="table-wrap">
                <table>
                  <thead><tr><th>Use</th><th>For</th></tr></thead>
                  <tbody>
                    <tr><td><a href="#skill">Agent skill</a></td><td>Coding agents: instructions, a working TypeScript example and the verifier.</td></tr>
                    <tr><td><a href="#cli">Command line</a></td><td>Bots in Python, Rust, Go or any language that can start a process.</td></tr>
                    <tr><td><a href="#mcp">MCP server</a></td><td>Claude Desktop, Cursor and other assistants that work through tools.</td></tr>
                    <tr><td><a href="#api">API</a></td><td>Your own integration: two calls, with <a href="#verify">the check</a> run before you sign.</td></tr>
                  </tbody>
                </table>
              </div>
              <p>These are ways to connect, not different products:</p>
              <ul>
                <li><strong>The skill, the command line or the MCP server</strong> bring the check before signing, the record of each order and the recovery after an interruption.</li>
                <li><strong>The API directly</strong>: your client runs <a href="#verify">the check</a> before signing, keeps a record of each order, and confirms the result (<a href="#recovery">Results and recovery</a>).</li>
              </ul>
              <p>You need:</p>
              <ul>
                <li>An <a href="#access">API key</a> for the wallet that swaps (not for the MCP server: it gets one itself).</li>
                <li>An RPC of your own.</li>
                <li>A Jupiter API key of your own (free at developers.jup.ag), for the agent&apos;s own price. It never leaves your machine.</li>
                <li>A wallet that signs first and hands the transaction back: a local key or a signing service.</li>
                <li>Node 20.18 or later (Claude Desktop brings its own).</li>
              </ul>
            </section>

            <section id="start">
              <h2>Quickstart</h2>
              <p>
                <strong>Using Claude Desktop?</strong> Download <a href={SKILL_EXTENSION}>orientim.mcpb</a>, open it and
                answer its questions: no API key and nothing else to install (<a href="#mcp">MCP server</a>). For a bot or a coding
                agent, follow these steps.
              </p>
              <ol>
                <li><strong>Get an API key</strong> with the wallet your agent swaps from, in <a href="#access">API keys</a>.</li>
                <li>
                  <strong>Install the package</strong>, <code>@orientimhq/swap</code> (v{SKILL_VERSION}), in a folder of its own. It
                  holds the instructions for your agent, the <code>orientim</code> command, the MCP server and the verifier. Its source
                  is open, under Apache-2.0, at <a href={SKILL_SOURCE}>github.com/orientimhq/orientim-protected-swap</a>.
                  <pre tabIndex={0}><code>{`npm install --save-exact @orientimhq/swap@${SKILL_VERSION}`}</code></pre>
                </li>
                <li>
                  <strong>Check it</strong> against GitHub rather than this site: npm&apos;s provenance names the repository, the
                  workflow and the commit it was built from.
                  <pre tabIndex={0}><code>{`npm audit signatures`}</code></pre>
                </li>
                <li>
                  <strong>Set it up</strong>: every setting is in the <a href="https://github.com/orientimhq/orientim-protected-swap/blob/main/skills/orientim-protected-swap/reference/GUIDE.md#setup">guide</a>.
                  <pre tabIndex={0}><code>{`export ORIENTIM_API_URL=https://orientim.com
export ORIENTIM_API_KEY=ori_...
export SOLANA_RPC_URL=<your own RPC>
export JUPITER_API_KEY=<your Jupiter key>
export ORIENTIM_POLICY=/home/agent/orientim-policy.json`}</code></pre>
                </li>
                <li>
                  <strong>Write the owner&apos;s limits</strong> in that policy file, where the agent cannot edit it: here 50 USDC a
                  swap, 200 USDC a day, and only SOL to buy. A daily limit needs its own <code>stateDir</code>, an absolute path.
                  <pre tabIndex={0}><code>{`{
  "maxAmountIn": { "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v": "50000000" },
  "maxAmountInPerDay": { "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v": "200000000" },
  "allowedOutputMints": ["So11111111111111111111111111111111111111112"],
  "stateDir": "/home/agent/.orientim-state"
}`}</code></pre>
                </li>
                <li>
                  <strong>Try it without signing</strong>: 5 USDC to SOL, prepared and verified on your RPC, with what it would cost.
                  <pre tabIndex={0}><code>{`npx orientim swap --in EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v \\
  --out So11111111111111111111111111111111111111112 --amount 5000000 \\
  --owner <wallet> --dry-run`}</code></pre>
                </li>
                <li>
                  <strong>Swap</strong>, with one order id, the same on every retry. It signs with the wallet&apos;s key file;
                  for a signing service, see <a href="#skill">AI agents</a> or <a href="#cli">Bots</a>.
                  <pre tabIndex={0}><code>{`export ORIENTIM_WALLET_KEYPAIR=/path/to/wallet.json
npx orientim swap --in EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v \\
  --out So11111111111111111111111111111111111111112 --amount 5000000 --id order-1`}</code></pre>
                </li>
                <li>
                  <strong>Make restarts safe</strong>, before the first real swap: one order id per trading decision, the same on every
                  retry; the state directory on a disk that outlives the bot; on every start, <code>recover</code> first (exit 3 means
                  start nothing new); and only <code>confirmed</code> counts as done. See <a href="#recovery">Results and recovery</a>.
                </li>
              </ol>
            </section>

            <section id="access">
              <h2>API keys</h2>
              <p>
                Get a key at once, with no form: the wallet your agent swaps from signs a message, and the key is bound to that
                wallet. Signing moves nothing. The wallet needs at least 0.01 SOL. A key lasts 90 days; sign again for a new one.
              </p>
              <KeyAccess
                ways={[
                  {
                    id: 'agent',
                    label: 'Agent or bot wallet',
                    content: (
                      <>
                        <p>
                          For a wallet in a key file or a signing service (Turnkey, Privy and others). The agent signs with its
                          own key; the key file never leaves the machine. With <code>@orientimhq/swap</code> installed:
                        </p>
                        <pre tabIndex={0}><code>{`export ORIENTIM_API_URL=https://orientim.com
echo '{"wallet": "<the agent wallet address>"}' | npx orientim key-challenge
# sign the bytes of "message" (the same bytes as "messageBase64", decoded) with the agent's key, then
# send "message" as it came, in plain text, not base64:
echo '{"message": "...", "challenge": "...", "signature": "<base58>"}' | npx orientim key`}</code></pre>
                        <p>
                          In code, <code>requestApiKey</code> from <code>@orientimhq/swap</code> does both steps. It signs only Orientim&apos;s key message
                          for that wallet, and refuses anything else. The HTTP calls are in <a href="#keys">Keys</a>.
                        </p>
                      </>
                    ),
                  },
                  {
                    id: 'browser',
                    label: 'Wallet in the browser',
                    content: (
                      <>
                        <p>For a wallet in a browser extension (Phantom, Solflare, Backpack): connect it and sign.</p>
                        <GetApiKey skill={{ href: '#start', version: SKILL_VERSION }} />
                      </>
                    ),
                  },
                ]}
              />
            </section>

            <section id="skill">
              <h2>AI agents: the skill</h2>
              <p>
                For coding agents: instructions for the agent (<code>SKILL.md</code>), the <code>orientim</code> command and the
                library, both from <code>@orientimhq/swap</code>, and the check they run before every signature. The agent gets its settings from you, in its environment, never in chat.
              </p>
              <h3>1. Install it</h3>
              <ul>
                <li>Install and check <code>@orientimhq/swap</code> (see <a href="#start">Quickstart</a>). The skill is in it.</li>
                <li>
                  <strong>Claude Code</strong>: copy the skill into <code>.claude/skills/</code> in your project, or into{' '}
                  <code>~/.claude/skills/</code> for every project. The agent picks it up when a task needs a swap.
                  <pre tabIndex={0}><code>{`cp -r node_modules/@orientimhq/swap/skills/orientim-protected-swap .claude/skills/`}</code></pre>
                </li>
                <li><strong>Any other agent</strong>: point it to that folder&apos;s <code>SKILL.md</code> (also <a href={SKILL_FOLDER}>on GitHub</a>).</li>
              </ul>
              <h3>2. Try it without signing</h3>
              <pre tabIndex={0}><code>{`npx orientim swap --in <mint> --out <mint> --amount 5000000 \\
  --owner <wallet> --dry-run`}</code></pre>
              <p>This prepares and verifies a swap on your RPC and prints what it would cost. Nothing is signed.</p>
              <h3>3. Swap</h3>
              <pre tabIndex={0}><code>{`npx orientim swap --in <mint> --out <mint> --amount 5000000 --id order-42`}</code></pre>
              <p>
                The same order id on every retry: the skill&apos;s order book stops an order that swapped or may still land from being swapped again. Or ask your agent,
                in plain words: <em>&ldquo;swap 5 USDC to SOL with Orientim&rdquo;</em>.
              </p>
              <h3>4. In your own code</h3>
              <pre tabIndex={0}><code>{`import { createKeyPairSignerFromBytes, createSolanaRpc } from '@solana/kit';
import { readFileSync } from 'node:fs';
import { acquireLock, createFileStore, loadPolicy, protectedSwap, recoverPending, stateDirFor } from '@orientimhq/swap';

const rpc = createSolanaRpc(process.env.SOLANA_RPC_URL!);
const wallet = await createKeyPairSignerFromBytes(
  new Uint8Array(JSON.parse(readFileSync(process.env.ORIENTIM_WALLET_KEYPAIR!, 'utf8'))));
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const SOL = 'So11111111111111111111111111111111111111112';

// The owner's limits, if set: they hold only when passed to protectedSwap below.
const policy = process.env.ORIENTIM_POLICY ? loadPolicy(process.env.ORIENTIM_POLICY) : undefined;
// One state directory for every run of this wallet (the policy's own stateDir with a daily limit).
const { dir } = stateDirFor(policy, process.env.ORIENTIM_STATE_DIR);
const store = createFileStore(dir);

// One swap at a time per wallet: a second run waits, and retries with the same order id.
const release = acquireLock(dir, wallet.address);
try {
  // Settle what a stopped run left before anything new.
  const { unknown, bookkeepingErrors } = await recoverPending(store, rpc, { orders: store, spends: store });
  if (unknown.length || bookkeepingErrors.length) throw new Error('An earlier swap may still land');

  const result = await protectedSwap({
    apiUrl: process.env.ORIENTIM_API_URL!,
    apiKey: process.env.ORIENTIM_API_KEY!,
    jupiterApiKey: process.env.JUPITER_API_KEY,
    rpc, wallet, pending: store, orders: store,
    policy, spends: store,
    intent: { id: 'order-42', inputMint: USDC, outputMint: SOL, amountIn: '5000000' },
  });
  // result.outcome: 'confirmed' | 'failed' | 'expired' | 'unknown' | 'rejected'
} finally {
  release();
}`}</code></pre>
              <p>
                <code>protectedSwap</code> asks Jupiter for its own price on every swap and takes your minimum from it when{' '}
                <code>minOut</code> is not set (a <code>minOut</code> more than 20% below that price is refused), verifies the
                transaction on your RPC, signs as the wallet, keeps the swap before finalize and reads the outcome on chain. The
                owner&apos;s limits hold only when <code>policy</code> and <code>spends</code> are passed, as above: setting{' '}
                <code>ORIENTIM_POLICY</code> alone does nothing in your own code. The lock serializes the swaps of one wallet on one
                machine; workers on several machines or containers need a shared store that reserves the day&apos;s budget
                atomically, or a signing service that holds the limits itself.
              </p>
              <h3>A wallet in a signing service</h3>
              <p>
                Pass <code>signerFromSignBytes(address, sign)</code> (a KMS, an HSM, raw-message signing) or{' '}
                <code>signerFromSignTransaction(address, sign)</code> (a service that signs and hands the transaction back) as{' '}
                <code>wallet</code>. A service that can only sign and send cannot be used: Orientim signs last. With a service that
                reads the transaction and applies its own policies (Turnkey or Privy, for example), prefer{' '}
                <code>signerFromSignTransaction</code>.
              </p>
              <h3>Safe setup against a misled agent</h3>
              <p>
                A prompt injection, a poisoned page or a token named to deceive can steer an agent. Set up this way, the most it can
                do is swap within the owner&apos;s limits, and every swap delivers to the wallet itself: nothing leaves it for anyone
                else.
              </p>
              <ul>
                <li>The key out of the agent&apos;s reach: a signing service with its own policies, a KMS or an HSM, or a signer of your own.</li>
                <li>
                  The owner&apos;s policy at <code>/etc/orientim/policy.json</code> (<code>C:\ProgramData\Orientim\policy.json</code> on
                  Windows), written by an administrator and read-only to the agent, so that unsetting <code>ORIENTIM_POLICY</code> does
                  not turn it off, with <code>maxAmountIn</code>,{' '}
                  <code>maxAmountInPerDay</code>, <code>allowedOutputMints</code> (the tokens it may buy) and <code>stateDir</code>.
                </li>
                <li>The skill as the agent&apos;s only way to move funds: no transfer tool, and no direct way to the signer.</li>
                <li>A wallet of its own, holding only what the agent may swap.</li>
              </ul>
            </section>

            <section id="cli">
              <h2>Bots: the command line</h2>
              <p>
                The <code>orientim</code> command of <code>@orientimhq/swap</code> runs the whole flow for a bot written in Python, Rust, Go or anything
                that can start a process: JSON in on stdin, JSON out on stdout, and an exit code. It does everything the skill does:
                your own floor, the check on your RPC, the record kept before finalize, and the outcome read on chain. The bot keeps
                its key and signs one message itself. Install the package in the bot&apos;s folder first:{' '}
                <code>npm install --save-exact @orientimhq/swap@{SKILL_VERSION}</code>.
              </p>
              <h3>The flow</h3>
              <ol>
                <li><strong>recover</strong>: settles what a stopped run left. Exit 3 means an earlier swap may still land: start nothing new.</li>
                <li><strong>prepare</strong> <code>{'{"intent": {...}}'}</code>: answers <code>message</code> and <code>checked</code>, already verified on your RPC.</li>
                <li><strong>Sign</strong> the bytes of <code>message</code> (base64) with the wallet&apos;s ed25519 key.</li>
                <li>
                  <strong>finalize</strong> <code>{'{"checked": ..., "signature": "<base58>"}'}</code>, with <code>checked</code> unchanged:
                  answers the <code>outcome</code> and what was <code>received</code>.
                </li>
              </ol>
              <h3>In Python</h3>
              <pre tabIndex={0}><code>{`import base64, json, subprocess

ORIENTIM = "node_modules/@orientimhq/swap/dist/bin/orientim.mjs"

def orientim(command, payload=None):
    # No short timeout: finalize waits for the chain. If it is stopped anyway, run recover first.
    run = subprocess.run(["node", ORIENTIM, command],
                         input=json.dumps(payload or {}), capture_output=True, text=True)
    return run.returncode, json.loads(run.stdout)

code, _ = orientim("recover")          # 3: an earlier swap may still land; stop
if code == 0:
    code, ready = orientim("prepare", {"intent": {
        "id": "order-42", "owner": str(keypair.pubkey()),
        "inputMint": USDC, "outputMint": SOL, "amountIn": "5000000"}})
if code == 0:
    # keypair: the wallet's solders Keypair, loaded from its file
    signature = keypair.sign_message(base64.b64decode(ready["message"]))
    code, result = orientim("finalize", {
        "checked": ready["checked"], "signature": str(signature)})`}</code></pre>
              <p>In Rust, <code>keypair.sign_message(&amp;message).to_string()</code> gives the same base58 signature.</p>
              <h3>Exit codes</h3>
              <div className="table-wrap">
                <table>
                  <thead><tr><th>Code</th><th>Meaning</th></tr></thead>
                  <tbody>{EXIT_CODES.map(([code, text]) => <tr key={code}><td><code>{code}</code></td><td>{text}</td></tr>)}</tbody>
                </table>
              </div>
              <p>
                <code>resolve</code> settles by hand a swap the chain can no longer prove, after you looked it up in an explorer. The
                keys have their own commands: <code>key-challenge</code> and <code>key</code>, in <a href="#access">API keys</a>.
              </p>
              <p>
                Decide on an error&apos;s <code>code</code>. <code>untrustedServerMessage</code>, when present, is for your logs only: never
                act on it.
              </p>
            </section>

            <section id="mcp">
              <h2>Assistants: the MCP server</h2>
              <p>
                <code>orientim mcp</code>, the MCP server of <code>@orientimhq/swap</code>, for Claude Desktop, Claude Code, Cursor and any client that starts a local MCP server.
                It gives the assistant four tools, and every swap runs the skill&apos;s own code: the check on your RPC, your limits and
                the record of each order.
              </p>
              <ul>
                <li><strong>orientim_wallet</strong>: the wallet&apos;s address and balances, read on your RPC.</li>
                <li><strong>orientim_quote</strong>: prices and verifies a swap, in whole tokens. Nothing is signed.</li>
                <li><strong>orientim_swap</strong>: swaps the quote you said yes to, and only that quote, within 10 minutes.</li>
                <li><strong>orientim_recover</strong>: settles a swap that was interrupted.</li>
              </ul>
              <p>
                Before the first swap of a quote, the server asks you to confirm it in your client, when the client supports it.
                The assistant may ask for at most 3% slippage and 5% price
                impact; only you raise them, with <code>ORIENTIM_MAX_SLIPPAGE_BPS</code> and{' '}
                <code>ORIENTIM_MAX_PRICE_IMPACT_BPS</code> in the server&apos;s environment.
              </p>
              <h3>Claude Desktop: one click</h3>
              <p>
                Download <a href={SKILL_EXTENSION}>orientim.mcpb</a> (version {SKILL_VERSION}) from the GitHub release, check it
                (<code>gh attestation verify orientim.mcpb -R orientimhq/orientim-protected-swap</code>), and open it. Claude Desktop
                asks for your RPC, the wallet&apos;s keypair file and, if you like, your Jupiter key and your limits, and keeps the
                secrets itself. Nothing else to install: Claude Desktop brings its own Node.
              </p>
              <h3>Cursor, Claude Code and other clients: one line</h3>
              <pre tabIndex={0}><code>{`{
  "mcpServers": {
    "orientim": {
      "command": "npx",
      "args": ["-y", "@orientimhq/swap@${SKILL_VERSION}", "mcp"],
      "env": {
        "SOLANA_RPC_URL": "https://your-own-rpc.example/...",
        "ORIENTIM_WALLET_KEYPAIR": "/path/to/agent-wallet.json",
        "JUPITER_API_KEY": "..."
      }
    }
  }
}`}</code></pre>
              <p>
                In Claude Code: <code>{`claude mcp add --transport stdio orientim --env SOLANA_RPC_URL=... --env ORIENTIM_WALLET_KEYPAIR=... -- npx -y @orientimhq/swap@${SKILL_VERSION} mcp`}</code>.
              </p>
              <h3>Agent frameworks</h3>
              <p>
                Your own agent starts the same server and gets the same four tools, with your yes before each swap: a working example
                for <a href="/developers/vercel-ai-sdk">the Vercel AI SDK</a> and for <a href="/developers/langchain">LangChain</a>.
              </p>
              <p>
                You need no <a href="#access">API key</a> of your own: the server gets the wallet&apos;s key once (the wallet needs
                0.01 SOL) and keeps it on your machine. The assistant sees the wallet&apos;s address and what each swap did, never the
                key. The server runs where the key is, on your machine: assistants that only reach remote servers, such as ChatGPT,
                cannot start it.
              </p>
            </section>

            <section id="how">
              <h2>How a protected swap works</h2>
              <ol>
                <li><strong>Prepare</strong>: Orientim builds and verifies the transaction and returns it unsigned, with a ticket.</li>
                <li><strong>Verify</strong>: your agent runs Orientim&apos;s verifier on the exact bytes, with chain state from its own RPC.</li>
                <li><strong>Sign</strong>: your wallet signs first. Orientim never holds your key.</li>
                <li><strong>Finalize</strong>: Orientim adds the last signature, with the one-time key, and sends it once.</li>
              </ol>
              <p>
                The transaction lives 150 blocks, about 40 seconds. Verify, sign and finalize promptly; with fewer than 30 blocks
                left, prepare again instead.
              </p>
            </section>

            <section id="verify">
              <h2>Verify before you sign</h2>
              <p>
                With the check, a compromised server or an impostor URL can refuse or delay a swap, but cannot make your wallet
                sign one that moves more than the approved amount, or one priced below a floor you got yourself.{' '}
                <strong>Without it, you are trusting Orientim&apos;s server with your whole wallet.</strong>
              </p>
              <p>
                <code>checkPrepared(prepared, intent, yourRpc)</code>, in <code>@orientimhq/swap</code>, does all of it and returns the problems it found;
                sign only when there are none. The skill and the command line run it for you.
              </p>
              <ul>
                <li>Holds the transaction to your limits: the fee, the network fee and your own minimum.</li>
                <li>Checks the exact bytes against chain state from your own RPC, and simulates them there.</li>
                <li>Accepts rent the route keeps only up to 0.001 SOL, or less with <code>maxRouteCostLamports</code>.</li>
              </ul>
              <p>
                Your minimum is required, and it must be a price you got yourself, never Orientim&apos;s: <code>ownMinimum</code> asks
                Jupiter for one. For a large order, check it against a second source as well.
              </p>
              <p>
                Calling the API yourself, in any language? Pipe prepare&apos;s answer to the command line before you sign:{' '}
                <code>{'{"prepared": ..., "intent": {...}}'}</code> into <code>npx orientim check</code> exits 0 only when it is safe
                to sign.
              </p>
            </section>

            <section id="own-routes">
              <h2>Your own Jupiter key</h2>
              <p>
                With <code>JUPITER_API_KEY</code> set, the skill and the command line fetch the swap&apos;s routes from Jupiter with your
                key, which never leaves your process, and Orientim builds and checks the swap around them.{' '}
                <code>ORIENTIM_OWN_ROUTES=0</code> (or <code>ownRoutes: false</code> in code) lets Orientim&apos;s key fetch them instead.
              </p>
              <ul>
                <li>Every round is one prepare request toward the API&apos;s <a href="#limits">rate limit</a>.</li>
              </ul>
              <p>
                For a direct API client, the rounds (<code>409 routes-needed</code>, sessions and time budgets) are in{' '}
                <code>reference/AGENT-API.md</code>.
              </p>
            </section>

            <section id="recovery">
              <h2>Results and recovery</h2>
              <p>
                The skill and the command line keep the record and read the result on chain for you. They answer an <code>outcome</code>:{' '}
                <code>confirmed</code>, <code>failed</code>, <code>expired</code>, <code>unknown</code> (check again before anything new),
                or <code>rejected</code> (finalize refused, and the transaction can no longer land).
              </p>
              <h3>For a direct API client</h3>
              <p>
                The transaction&apos;s id on chain is your wallet&apos;s signature, known before finalize. Keep it, with the ticket, before
                you call finalize: whatever finalize answers, or if no answer arrives, that signature is how you find out what
                happened.
              </p>
              <div className="table-wrap">
                <table>
                  <thead><tr><th>status</th><th>Meaning</th></tr></thead>
                  <tbody>
                    <tr><td><code>sent</code></td><td>Accepted, or already on chain. Confirm it on chain; re-broadcast <code>signedTransaction</code> until it confirms or its lifetime passes. It can land only once.</td></tr>
                    <tr><td><code>unknown</code></td><td>The connection failed after the request left. Check the signature before anything else.</td></tr>
                    <tr><td><code>signed</code></td><td>Asked with <code>{'"send": false'}</code>: signed, not sent by Orientim. Send it yourself; until it confirms, this says nothing about the swap.</td></tr>
                    <tr><td><code>rejected</code></td><td>This request never sent it, usually because the price moved.</td></tr>
                  </tbody>
                </table>
              </div>
              <p>
                <strong>Only a swap confirmed on chain is done.</strong> <code>sent</code> says the transaction was accepted for
                broadcast, and <code>unknown</code> that the answer was lost: neither says that the swap happened, and neither that
                it did not. Until the chain answers, the swap may still land.
              </p>
              <p>
                <strong>Orientim keeps no order database.</strong> It does not track or deduplicate your orders: your own store and
                the chain are the record. The skill
                and the command line keep that store for you; a direct API client keeps its own and runs{' '}
                <a href="#verify">the check</a> before every signature.
              </p>
              <ul>
                <li>Finalizing the same ticket again is safe: it answers for the same transaction, which can land only once.</li>
                <li>Two prepares for one trading decision are two different transactions. A direct bot must assign a stable order id, store the signed transaction and signature durably before finalize, and serialize work per wallet across all workers.</li>
                <li>
                  Before preparing the same swap again, make sure the one you signed can no longer land: no record of its signature,
                  and the network past its last valid block.
                </li>
                <li>
                  Run one swap per wallet at a time. The skill does all of this for you (<code>protectedSwap</code>,{' '}
                  <code>recoverPending</code>), and <code>npx orientim resolve</code> settles a swap by hand.
                </li>
              </ul>
              <h3>On every start, for a direct API client</h3>
              <ol>
                <li>Load every swap you stored as signed and not yet settled: its order id, signature, signed bytes and last valid block height.</li>
                <li>Look each signature up on your RPC. Confirmed or failed: record that outcome on its order.</li>
                <li>
                  No record: re-send the same signed bytes until its lifetime passes, and record it expired only when the network
                  is past its last valid block, read as one view (the full rule is in <code>reference/AGENT-API.md</code>, under
                  Finalize).
                </li>
                <li>Only then prepare anything new for that order, or for that wallet. An outcome you cannot prove stays unknown: settle it by hand.</li>
              </ol>
            </section>

            <section id="api">
              <h2>Authentication</h2>
              <p>Base URL <code>https://orientim.com</code>. Every request carries an API key:</p>
              <pre tabIndex={0}><code>Authorization: Bearer ori_...</code></pre>
              <p>
                A key prepares swaps for its own wallet only; another <code>owner</code> is refused with{' '}
                <code>403 wrong-wallet</code>. Calls may carry <code>x-orientim-skill: &lt;version&gt;</code>, as the skill does.
              </p>
            </section>

            <section id="prepare">
              <h2>Prepare</h2>
              <pre tabIndex={0}><code>{`POST /api/v1/prepare
Authorization: Bearer ori_...
Content-Type: application/json

{
  "owner": "<your wallet address>",
  "inputMint": "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  "outputMint": "So11111111111111111111111111111111111111112",
  "amountIn": "5000000",
  "minOut": "42400000",
  "slippageBps": 100
}`}</code></pre>
              <div className="table-wrap">
                <table>
                  <thead><tr><th>Field</th><th>Meaning</th></tr></thead>
                  <tbody>{PREPARE_FIELDS.map(([f, need, text]) => <tr key={f}><td><code>{f}</code><span className="dev-need">{need}</span></td><td>{text}</td></tr>)}</tbody>
                </table>
              </div>
              <h3>Answer</h3>
              <p>All amounts are strings in base units.</p>
              <div className="table-wrap">
                <table>
                  <thead><tr><th>Field</th><th>Meaning</th></tr></thead>
                  <tbody>{PREPARE_ANSWER.map(([f, text]) => <tr key={f}><td><code>{f}</code></td><td>{text}</td></tr>)}</tbody>
                </table>
              </div>
              <p>
                A prepare answers within 45 seconds. One that takes longer, because Jupiter or the Solana RPC is slow, ends in{' '}
                <code>503 unavailable</code> with nothing built; prepare again in a moment. The skill waits up to 60 seconds for it. A
                request body may be up to 1 MiB, enough for the routes an agent brings.
              </p>
            </section>

            <section id="finalize">
              <h2>Finalize</h2>
              <pre tabIndex={0}><code>{`POST /api/v1/finalize
Authorization: Bearer ori_...
Content-Type: application/json

{ "ticket": "eyJ2Ijox....", "signedTransaction": "<base64, signed by your wallet>" }`}</code></pre>
              <p>
                Orientim adds its signature and sends the transaction. Finalizing the same ticket again answers with that same
                transaction and sends nothing new.
              </p>
              <pre tabIndex={0}><code>{`{
  "signature": "5h...",
  "status": "sent",
  "signedTransaction": "<base64, fully signed>",
  "lastValidBlockHeight": "312345678"
}`}</code></pre>
              <p>What each <code>status</code> means is in <a href="#recovery">Results and recovery</a>.</p>
              <p>
                To send it your own way (a staked RPC, a sender service, a bundle), add <code>{'"send": false'}</code>: Orientim signs
                and sends nothing, and answers <code>status</code> <code>signed</code> with the fully signed transaction. Send it at
                once and again every few seconds until it confirms or its lifetime passes; the same bytes land only once.
              </p>
            </section>

            <section id="keys">
              <h2>Keys</h2>
              <pre tabIndex={0}><code>{`GET /api/v1/keys/challenge?wallet=<address>
→ { "message": "...", "challenge": "...", "expiresAt": "..." }

POST /api/v1/keys
{ "message": "<the message, unchanged>", "challenge": "...", "signature": "<base58 or base64>" }
→ { "key": "ori_...", "wallet": "<address>", "expiresAt": "..." }`}</code></pre>
              <ul>
                <li>Sign the challenge within 10 minutes.</li>
                <li>
                  Sign only Orientim&apos;s key message for your own wallet: a signature over bytes someone else chose could be a
                  signature for a transaction. The skill checks the message before anything is signed.
                </li>
                <li>
                  <code>400 bad-signature</code>: the signature does not match, or the challenge expired, was not Orientim&apos;s, or
                  names another site. <code>403 wallet-empty</code>: the wallet holds less than 0.01 SOL.
                </li>
                <li>
                  From one IP address, 30 challenges and 10 keys an hour; one wallet gets 5 keys a day. Keep the key you have
                  rather than ask again on every start. A <code>429</code> carries <code>Retry-After</code>.
                </li>
                <li>Getting a key needs skill 1.12.3 or later; an older copy is answered <code>426 skill-outdated</code>.</li>
              </ul>
            </section>

            <section id="errors">
              <h2>Errors</h2>
              <p>
                Every error is <code>{'{ "error": { "code": "...", "message": "..." } }'}</code>, and the request that received it signed
                and sent nothing. <code>price-moved</code> and <code>costs-more</code> carry <code>requiresApproval: true</code>: a worse
                price is the user&apos;s decision, not a retry.
              </p>
              <div className="table-wrap">
                <table>
                  <thead><tr><th>HTTP</th><th>code</th><th>What to do</th></tr></thead>
                  <tbody>{ERRORS.map(([http, code, text]) => <tr key={code}><td>{http}</td><td><code>{code}</code></td><td>{text}</td></tr>)}</tbody>
                </table>
              </div>
            </section>

            <section id="limits">
              <h2>Rate limits</h2>
              <ul>
                <li>
                  60 prepare and 30 finalize requests a minute, counted per wallet for a self-serve key, and 120 prepare a minute from one address; each round of{' '}
                  <a href="#own-routes">your own routes</a> is one prepare request. A <code>429</code> carries{' '}
                  <code>Retry-After</code>: the seconds until the count starts again.
                </li>
                <li>
                  120 prepare and finalize requests a minute from one IP address, answered <code>429</code> above it.
                </li>
                <li>API keys: 30 challenges and 10 keys an hour from one IP address, and 5 keys a day for one wallet.</li>
                <li>One swap per output token at a time, and one per wallet in the skill.</li>
                <li>A key used to overload or attack the service is revoked.</li>
                <li>For uptime monitors, <code>GET /api/health</code> needs no key: 200 when a swap could go through now, 503 when it could not.</li>
              </ul>
            </section>

            <section id="fees">
              <h2>Fees and limits</h2>
              <ul>
                <li>
                  {feeText}, inside the transaction you sign, on one side of the swap: in SOL, USDC or USDT when the swap has one of
                  them, otherwise in the input token, otherwise in SOL from the wallet. <code>amounts.feeMint</code> says which.
                  <ul>
                    <li>On the input: that share of <code>amountIn</code>.</li>
                    <li>
                      On the output: that share of the enforced minimum, the minimum the transaction holds to, paid after it is
                      checked; <code>amounts.minOut</code> is what the wallet keeps after it. With <a href="#own-routes">your own
                      routes</a>, that minimum must be within 1% of Orientim&apos;s own price.
                    </li>
                    <li>
                      In SOL from the wallet, for a pair neither token of which can carry it: that share of the swap&apos;s value in
                      SOL; the wallet then needs that SOL besides the token.
                    </li>
                  </ul>
                  A swap whose fee cannot be collected is refused with <code>503 fee-unavailable</code>.
                </li>
                <li>With the skill, your agent never pays an Orientim fee above 0.25% (up to 0.3% only when you set <code>maxFeeBps</code>), whatever the server says, nor a network fee above 0.001 SOL.</li>
                <li>
                  A slippage tolerance of your choice (<code>slippageBps</code>, 0.1% to 15%); 0.5% by default, 3% on a Pump.fun launch
                  curve.
                </li>
                <li>
                  Your agent takes no swap with a price impact above 5%, and stops before anything is prepared (<code>maxPriceImpactBps</code>{' '}
                  raises it, to 20% at most).
                </li>
                <li>
                  A limit no flag can loosen: in the skill, a minimum never more than 20% below Jupiter&apos;s own price
                  (<code>floor-too-low</code>).
                </li>
                <li>
                  The owner&apos;s own limits, per swap and per day for each input mint, and the tokens the wallet may buy, in a file (<code>ORIENTIM_POLICY</code>):
                  your policy enforces them before anything is signed.
                </li>
                <li>
                  Swaps smaller than about 0.004 SOL, or $1 of USDC or USDT, are not taken, except the sale of a token&apos;s
                  whole balance.
                </li>
              </ul>
            </section>

            <section id="supported">
              <h2>Tokens and wallets</h2>
              <p>
                See <a href="/security#supported">supported tokens</a>. Wallets must be able to sign first
                and hand the transaction back: local keys and signing services work; sign-and-send-only wallets and multisig vaults
                do not.
              </p>
            </section>

            <section id="downloads">
              <h2>Downloads</h2>
              <ul>
                <li>
                  <a href={`https://www.npmjs.com/package/@orientimhq/swap/v/${SKILL_VERSION}`}>@orientimhq/swap</a> on npm, version{' '}
                  {SKILL_VERSION}: the library, the <code>orientim</code> command, the MCP server and the skill. Check it with{' '}
                  <code>npm audit signatures</code>.
                </li>
                <li><a href={SKILL_EXTENSION}>orientim.mcpb</a>: the MCP server for Claude Desktop, the same version (<a href="#mcp">how to use it</a>).</li>
                <li>
                  Check a download against GitHub, not this site: <code>gh attestation verify &lt;file&gt; -R
                  orientimhq/orientim-protected-swap</code>, or its sha256 against <code>RELEASE-SHA256SUMS</code> on the{' '}
                  <a href={SKILL_RELEASE}>GitHub release</a>. In PowerShell:{' '}
                  <code>(Get-FileHash orientim.mcpb -Algorithm SHA256).Hash</code>.
                </li>
                <li><a href={SKILL_SOURCE}>Source on GitHub</a>: the package and its verifier, Apache-2.0, with a build that gives the same files, byte for byte.</li>
                <li>The full API reference, every field and recovery step, is <code>reference/AGENT-API.md</code> in the skill folder.</li>
              </ul>
            </section>
          </article>
        </div>
      </main>
      <SiteFooter />
    </div>
  );
}
