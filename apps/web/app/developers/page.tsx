import { connection } from 'next/server';
import { SiteFooter, SiteHeader } from '@/components/site/Brand';
import { MobileNav } from '@/components/site/MobileNav';
import { DevNav, type DevNavGroup } from '@/components/site/DevNav';
import { GetApiKey } from '@/components/site/GetApiKey';
import { KeyAccess } from '@/components/site/KeyAccess';
import { FEE_BPS, TREASURY } from '@/lib/client/config';
import { signPageChunks } from '@/lib/server/scriptIntegrity';
import { SKILL_ARCHIVE, SKILL_VERSION } from '@/lib/server/skillSums';

/** The skill's public source: the same files, and a build that gives the same zip (tools/build-skill.ts). */
const SKILL_SOURCE = 'https://github.com/orientimhq/orientim-protected-swap';

export const metadata = {
  title: 'Developers — Orientim',
  description: 'Protected Solana swaps for AI agents and bots: the agent skill, the command line and the API.',
};

/** The fee this build charges, as the other pages state it. */
const feeText = TREASURY ? `${(Number(FEE_BPS) / 100).toLocaleString('en-US', { maximumFractionDigits: 2 })}%` : 'No fee (test deployment)';

/** Why an agent needs this, before the docs: what a developer gets, in their words. */
const PITCH: [string, string][] = [
  ['Refuses what it didn’t ask for', 'An extra instruction, another token, a worse price: the agent sees it in the transaction and does not sign.'],
  ['Your limits, not ours', 'Set an amount per swap and a daily budget in the owner’s policy, and a price floor and fee ceiling per swap. Enforce unattended limits at a separate signer.'],
  ['Safe after a crash', 'The skill records each order and settles it after a restart. Direct API bots must provide their own durable order book.'],
  ['No sign-up', 'Your agent’s wallet signs a message and gets a key. Then ask it: “swap 5 USDC to SOL with Orientim”.'],
];

/** The sidebar's contents: every entry is a section of this page. */
const NAV: DevNavGroup[] = [
  { title: 'Getting started', items: [['overview', 'Overview'], ['start', 'Quickstart'], ['access', 'API keys']] },
  {
    title: 'Guides',
    items: [['skill', 'AI agents: the skill'], ['cli', 'Bots: the command line'], ['how', 'How a protected swap works'], ['verify', 'Verify before you sign'], ['own-routes', 'Your own Jupiter key'], ['recovery', 'Results and recovery']],
  },
  { title: 'API reference', items: [['api', 'Authentication'], ['prepare', 'Prepare'], ['finalize', 'Finalize'], ['keys', 'Key endpoints'], ['errors', 'Errors'], ['limits', 'Rate limits']] },
  { title: 'Reference', items: [['env', 'Environment variables'], ['fees', 'Fees and limits'], ['supported', 'Tokens and wallets'], ['downloads', 'Downloads']] },
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
  ['409', 'output-balance-changed', 'Your balance of the output token moved since prepare. Check the signature, then prepare again.'],
  ['410', 'expired', 'The transaction’s lifetime passed before finalize. Check the signature, then prepare again.'],
  ['422', 'amount-too-small', 'The amount is below the smallest swap Orientim takes, about 0.004 SOL, or $1 of USDC or USDT (for a swap between two other tokens, its value in SOL). Selling the whole balance of a token (not SOL) is allowed at any size.'],
  ['422', 'unsupported-token, no-route, insufficient-sol, insufficient-balance, simulation-failed, …', 'This swap cannot be built safely right now; message says why.'],
  ['426', 'skill-outdated', 'This copy of the skill is older than Orientim serves. Download the current one; a swap already signed still finalizes.'],
  ['429', 'rate-limited', 'Too many requests for this key (per wallet for a self-serve key). Wait Retry-After seconds.'],
  ['500', 'internal', 'Something unexpected failed; nothing was signed by Orientim or sent. Retry later.'],
  ['503', 'busy, unavailable', 'The market data or the network is overloaded. Wait Retry-After seconds and retry.'],
  ['503', 'fee-unavailable', 'Orientim cannot collect its fee on this swap right now, so it built nothing. Wait and retry.'],
  ['503', 'paused', 'Orientim has paused protected swaps, and issues no API keys meanwhile. Your funds are not affected.'],
  ['503', 'route-format', 'The route’s format changed and Orientim refuses what it cannot read. Wait at least Retry-After (300 seconds).'],
];

const PREPARE_FIELDS: [string, string, string][] = [
  ['owner', 'required', 'The wallet that pays and receives. It signs first.'],
  ['inputMint, outputMint', 'required', 'Mint addresses. SOL is So11111111111111111111111111111111111111112.'],
  ['amountIn', 'required', 'Base units, as a string ("5000000" is 5 USDC). It includes the fee when the fee is taken in the input token.'],
  ['minOut', 'required', 'Your own positive floor, as an integer string in output base units: what your wallet must keep. Get a price independently. This field alone does not replace checking the transaction before signing.'],
  ['slippageBps', 'optional', 'How far below the quote the swap may fill: 10 to 1500 (0.1% to 15%). Default 50, or 300 on a Pump.fun launch curve. The skill’s "auto" asks Jupiter for the trade’s own tolerance (0.5% to 3%) and sends that number; the owner’s policy may cap it (maxSlippageBps).'],
  ['acceptCostBps', 'optional', 'Accept a protected route this many bps below the open market (see costs-more): a whole number, as a number or a string. A route up to 50 bps past it is also taken, so that a market drifting by a few bps does not ask again; minOut still holds.'],
  ['routingMode', 'optional', 'standard (default). fast is not enabled on orientim.com: a request with it is answered 400 bad-request.'],
  ['version', 'optional', '0 (default). Version 1 transactions are not enabled on orientim.com: a request with 1 is answered 400 bad-request.'],
  ['ownRoutes, session, routes', 'optional', 'Routes your agent brings from Jupiter with its own key, in rounds: see Your own Jupiter key. The skill and the command line do it whenever JUPITER_API_KEY is set.'],
];

const PREPARE_ANSWER: [string, string][] = [
  ['ticket', 'Pass it to finalize, with the signed transaction.'],
  ['transaction', 'The unsigned transaction, base64. Verify it, then sign it as your wallet.'],
  ['messageSha256', 'The hash of the message; the certificate and the ticket are bound to it.'],
  ['temporaryAuthority', 'The one-time key of this swap.'],
  ['lastValidBlockHeight, blocksLeft', 'The transaction’s lifetime: 150 blocks, about 40 seconds.'],
  ['amounts', 'amountIn, fee, feeMint, feeBps, quotedOut, minOut and priceImpactPct (null when Jupiter did not state it: unknown, not none).'],
  ['costs', 'The network fee, rent returned and kept, Orientim’s fee in SOL (orientimFeeSolLamports, from whichever side), keptSolLamports: all the SOL the swap costs and does not return, and breakdown: the amount swapped, the fee in its own token and each SOL cost apart.'],
  ['notices, tokens', 'A busy network, and what each token’s issuer can do: freeze balances, mint more, or move and burn them (permanentDelegate).'],
  ['certificate, policy', 'What this exact transaction does, and the rules it was verified against.'],
];

/** What `orientim-verify` exits with (skills/orientim-protected-swap/src/cli.ts). */
const EXIT_CODES: [string, string][] = [
  ['0', 'Done. prepare: sign message. finalize: confirmed, with received. recover: all settled. check: safe to sign.'],
  ['1', 'Refused, or not swapped (failed, expired or rejected), including error.code floor-too-low, price-impact-high, unavailable (a service did not answer: try again after retryAfter) and the owner’s limits (mint-not-allowed, amount-over-limit, daily-limit). Nothing is left to settle.'],
  ['2', 'A usage or configuration error, such as a prepare without an order id, or an intent that names a treasury (it comes only from ORIENTIM_TREASURY): the answer says what is missing.'],
  ['3', 'Settle first: an earlier swap may still land, another finalize from this wallet is still running (busy), or the state directory cannot be made or read (a finalize then answers outcome unknown). Run recover; start nothing new.'],
  ['4', 'Orientim said no: error.code is one of the Errors below.'],
  ['5', 'This order id already swapped, or its transaction may still land (prepare, or a finalize of a second transaction for it). It is never swapped twice.'],
];

const ENV: [string, string][] = [
  ['ORIENTIM_API_URL', 'https://orientim.com'],
  ['ORIENTIM_API_KEY', 'Your key, ori_…'],
  ['SOLANA_RPC_URL', 'Your own RPC, never Orientim’s: the check is worth what the chain state it reads is worth.'],
  ['JUPITER_API_KEY', 'For the agent’s own price floor and, unless ORIENTIM_OWN_ROUTES is 0, the routes Orientim builds around (Your own Jupiter key). It never leaves your process. Free at developers.jup.ag; a busy bot does well with a paid key.'],
  ['ORIENTIM_OWN_ROUTES', 'Optional: 0 lets Orientim’s key fetch the routes, as without your key. Your key still prices your own floor.'],
  ['ORIENTIM_WALLET_KEYPAIR', 'The example only: the path to the wallet’s key file, or pass a signing service in code. The command line never reads a key; the bot signs. A key file the example can read, the agent that runs it can read too.'],
  ['ORIENTIM_POLICY', 'Optional, recommended for agents and unattended bots: the path to a JSON file of the owner’s limits, kept where the agent cannot edit it. maxAmountIn is the most one swap may spend of each input mint (a mint not listed is refused, selling included: list every token the agent may need to sell); maxAmountInPerDay the most all swaps from the wallet may spend in 24 hours, counting every swap once signed, retries included. Base units, as strings. stateDir, optional, pins the state directory to one absolute path. maxSlippageBps, maxBelowBps and maxPriceImpactBps, optional, are the owner’s ceilings on the tolerance, the floor’s distance below the market and the price impact the agent may choose.'],
  ['ORIENTIM_SEND_RPC_URL', 'Optional: an RPC of yours that sends the swap (a staked connection, a sender service). Orientim then signs it and sends nothing; the skill sends it at once and again until it lands. In code, sendTransaction.'],
  ['ORIENTIM_ARCHIVE_RPC_URL', 'Optional: an RPC that keeps the chain’s full history. When your own RPC missed the moment it could prove a swap expired, the archive proves it from the one-time key’s own history, so an outage near expiry does not stop the wallet at unknown.'],
  ['ORIENTIM_STATE_DIR', 'Where swaps in flight and the order book are kept across restarts (.orientim-state by default). Give it an absolute path on a disk that outlives the bot, not a container’s own file system. A policy with a daily limit names its own stateDir instead, and no other directory is used.'],
  ['ORIENTIM_TREASURY', 'Optional, for a test deployment only: Orientim’s treasury is built into the skill.'],
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
                An agent that trades needs a wallet. The skill checks each transaction against your limits on your own RPC before
                signing; direct API bots must run the same check. Keep the signing key and unattended spending limits outside the
                agent when it must not be able to spend independently.
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
                <strong>Use your own strategy. When your agent or bot decides to swap, call Orientim for the protected execution.</strong>{' '}
                Your agent or bot decides when and what to trade. Orientim builds the protected swap when the API is called, your
                wallet signs it, and it is sent. The strategy and its monitoring stay in your system.
              </p>
              <p>
                For example, your bot decides: &ldquo;Buy SOL with 100 USDC now.&rdquo; At that moment it calls Orientim, which
                prepares the protected swap; the wallet signs it and the swap is sent. Later the bot decides: &ldquo;Sell the SOL
                now.&rdquo; It calls Orientim again, for a new swap. DCA, stop-loss or any other strategy runs the same way: in your
                system, with each swap it triggers going through Orientim.
              </p>
              <p>The swap route only ever gets the amount you approve, under a one-time key, and if less than your minimum would arrive, the whole transaction reverts. Three ways in:</p>
              <div className="table-wrap">
                <table>
                  <thead><tr><th>Use</th><th>For</th></tr></thead>
                  <tbody>
                    <tr><td><a href="#skill">Agent skill</a></td><td>Coding agents: instructions, a working TypeScript example and the verifier.</td></tr>
                    <tr><td><a href="#cli">Command line</a></td><td>Bots in Python, Rust, Go or any language that can start a process.</td></tr>
                    <tr><td><a href="#api">API</a></td><td>Your own integration: two calls, with <a href="#verify">the check</a> run before you sign.</td></tr>
                  </tbody>
                </table>
              </div>
              <p>These are ways to connect, not different products:</p>
              <ul>
                <li><strong>The skill or the command line</strong> bring the check before signing, the record of each order and the recovery after an interruption.</li>
                <li><strong>The API directly</strong>: your client runs <a href="#verify">the check</a> before signing, keeps a record of each order, and confirms the result (<a href="#recovery">Results and recovery</a>).</li>
              </ul>
              <p>You need:</p>
              <ul>
                <li>An <a href="#access">API key</a> for the wallet that swaps.</li>
                <li>An RPC of your own.</li>
                <li>A Jupiter API key of your own (free at developers.jup.ag), for the agent&apos;s own price. It never leaves your machine.</li>
                <li>A wallet that signs first and hands the transaction back: a local key or a signing service.</li>
                <li>Node 22.18 or later, for the skill and the command line.</li>
              </ul>
            </section>

            <section id="start">
              <h2>Quickstart</h2>
              <ol>
                <li><strong>Get an API key</strong> with the wallet your agent swaps from, in <a href="#access">API keys</a>.</li>
                <li>
                  <strong>Download the skill</strong>: <a href={SKILL_ARCHIVE} download>orientim-protected-swap.zip</a> (v{SKILL_VERSION}).
                  It holds the instructions for your agent, a working example, the command line and the verifier. Its source is
                  open, under Apache-2.0, at <a href={SKILL_SOURCE}>github.com/orientimhq/orientim-protected-swap</a>.
                </li>
                <li>
                  <strong>Check it</strong>: in the unzipped folder, every file against the list this site serves (on macOS,{' '}
                  <code>shasum -a 256 -c</code>).
                  <pre tabIndex={0}><code>{`cd orientim-protected-swap
curl -s https://orientim.com/skill/SHA256SUMS | sha256sum -c`}</code></pre>
                  On Windows, in PowerShell; every line must say OK:
                  <pre tabIndex={0}><code>{`cd orientim-protected-swap
(irm https://orientim.com/skill/SHA256SUMS) -split "\`n" | ? { $_.Trim() } | % {
  $hash, $file = $_.Trim() -split '\\s+', 2
  if ((Get-FileHash $file -Algorithm SHA256).Hash -eq $hash) { "\${file}: OK" } else { "\${file}: FAILED" }
}`}</code></pre>
                </li>
                <li>
                  <strong>Run it</strong>: <code>npm ci</code>, set the <a href="#env">environment variables</a>, then follow{' '}
                  <a href="#skill">AI agents</a> or <a href="#cli">Bots</a>.
                </li>
                <li>
                  <strong>Make restarts safe</strong>, before the first real swap:
                  <ul>
                    <li>Give every trading decision one order id, and use the same id on every retry of it.</li>
                    <li>
                      On every start, settle what a stopped run left before anything new: <code>recoverPending</code> in code,{' '}
                      <code>node bin/orientim-verify.mjs recover</code> from a bot. Exit 3, or an <code>unknown</code> it cannot settle, means an
                      earlier swap may still land: start nothing new for that wallet.
                    </li>
                    <li>
                      Keep <code>ORIENTIM_STATE_DIR</code> on a disk that outlives the bot. Run one swap per wallet at a time; workers
                      on several machines need one shared store, or a signer that serializes and limits them.
                    </li>
                    <li>
                      Treat only <code>confirmed</code> as done. <code>sent</code> and <code>unknown</code> are not a final answer (see{' '}
                      <a href="#recovery">Results and recovery</a>).
                    </li>
                  </ul>
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
                          own key; the key file never leaves the machine. In the unzipped{' '}
                          <a href={SKILL_ARCHIVE} download>skill</a> folder:
                        </p>
                        <pre tabIndex={0}><code>{`npm ci
export ORIENTIM_API_URL=https://orientim.com
echo '{"wallet": "<the agent wallet address>"}' | node bin/orientim-verify.mjs key-challenge
# sign the bytes of "message" (the same bytes as "messageBase64", decoded) with the agent's key, then
# send "message" as it came, in plain text, not base64:
echo '{"message": "...", "challenge": "...", "signature": "<base58>"}' | node bin/orientim-verify.mjs key`}</code></pre>
                        <p>
                          In code, <code>requestApiKey</code> from the skill does both steps. It signs only Orientim&apos;s key message
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
                        <GetApiKey skill={{ href: SKILL_ARCHIVE, version: SKILL_VERSION }} />
                      </>
                    ),
                  },
                ]}
              />
            </section>

            <section id="skill">
              <h2>AI agents: the skill</h2>
              <p>
                For coding agents: instructions for the agent (<code>SKILL.md</code>), a working example that needs only{' '}
                <code>@solana/kit</code>, and the check it runs before every signature. The agent gets its settings from you, in the{' '}
                <a href="#env">environment variables</a>, never in chat.
              </p>
              <h3>1. Install it</h3>
              <ul>
                <li>
                  <strong>Claude Code</strong>: unzip it into <code>.claude/skills/</code> in your project (it makes <code>orientim-protected-swap/</code>), or into{' '}
                  <code>~/.claude/skills/</code> for every project. The agent picks it up when a task needs a swap.
                </li>
                <li><strong>Any other agent</strong>: put the folder in your project and point the agent to <code>SKILL.md</code>.</li>
                <li>Then, in that folder: check it (see <a href="#start">Quickstart</a>) and run <code>npm ci</code>.</li>
              </ul>
              <h3>2. Try it without signing</h3>
              <pre tabIndex={0}><code>{`node examples/swap.ts --in <mint> --out <mint> --amount 5000000 \\
  --owner <wallet> --dry-run`}</code></pre>
              <p>This prepares and verifies a swap on your RPC and prints what it would cost. Nothing is signed.</p>
              <h3>3. Swap</h3>
              <pre tabIndex={0}><code>{`node examples/swap.ts --in <mint> --out <mint> --amount 5000000 --id order-42`}</code></pre>
              <p>
                The same order id on every retry: the skill&apos;s order book stops an order that swapped or may still land from being swapped again. Or ask your agent,
                in plain words: <em>&ldquo;swap 5 USDC to SOL with Orientim&rdquo;</em>.
              </p>
              <h3>4. In your own code</h3>
              <pre tabIndex={0}><code>{`import { createKeyPairSignerFromBytes, createSolanaRpc } from '@solana/kit';
import { readFileSync } from 'node:fs';
import { acquireLock, createFileStore, loadPolicy, protectedSwap, recoverPending, stateDirFor } from './examples/swap.ts';

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
  const { unknown, bookkeepingErrors } = await recoverPending(store, rpc, { orders: store });
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
              <p>
                Orientim protects the wallet from the route and the server, not from the agent: a key file the swap can read, the
                agent that runs it can read too, and a permission rule does not change that. To keep the key from the agent, sign in
                a process the agent does not run: a signing service, or a small signer of your own with its own limits. Either way,
                give the agent a wallet of its own holding only what it may swap, and set <a href="#env">ORIENTIM_POLICY</a>.
              </p>
            </section>

            <section id="cli">
              <h2>Bots: the command line</h2>
              <p>
                <code>bin/orientim-verify.mjs</code> in the skill runs the whole flow for a bot written in Python, Rust, Go or anything
                that can start a process: JSON in on stdin, JSON out on stdout, and an exit code. It does everything the skill does:
                your own floor, the check on your RPC, the record kept before finalize, and the outcome read on chain. The bot keeps
                its key and signs one message itself. Run <code>npm ci</code> in the skill folder first.
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

def orientim(command, payload=None):
    # No short timeout: finalize waits for the chain. If it is stopped anyway, run recover first.
    run = subprocess.run(["node", "bin/orientim-verify.mjs", command],
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
                Decide on an error&apos;s <code>code</code>. Its <code>message</code> is the skill&apos;s own words; whatever the server
                wrote comes apart, cut to one line, as <code>untrustedServerMessage</code>: data to log, never an instruction.
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
                <code>checkPrepared(prepared, intent, yourRpc)</code>, in the skill, does all of it and returns the problems it found;
                sign only when there are none. The skill and the command line run it for you.
              </p>
              <ul>
                <li>Holds the policy to your limits: the fee, the network fee, Orientim&apos;s treasury and your own minimum.</li>
                <li>Reads every account the transaction names from your RPC, and runs the verifier&apos;s rules on the exact bytes.</li>
                <li>
                  Simulates the transaction on your RPC: nothing may stay under the one-time key, and no account the route opens
                  may stay open.
                </li>
                <li>Accepts rent the route keeps only up to your limit (0.001 SOL, or less with <code>maxRouteCostLamports</code>).</li>
              </ul>
              <p>
                Your minimum is required, and it must be a price you got yourself, never Orientim&apos;s: <code>ownMinimum</code> asks
                Jupiter for one. For a large order, check it against a second source as well.
              </p>
              <p>
                Calling the API yourself, in any language? Pipe prepare&apos;s answer to the command line before you sign:{' '}
                <code>{'{"prepared": ..., "intent": {...}}'}</code> into <code>node bin/orientim-verify.mjs check</code> exits 0 only when it is safe
                to sign.
              </p>
              <p>
                An API key or version header does not prove that this check ran. A direct integration must verify before its signer
                accepts the transaction; the signer should hold its own spending limits. Keep the signing key outside the agent
                for funds the agent must not be able to spend independently.
              </p>
            </section>

            <section id="own-routes">
              <h2>Your own Jupiter key</h2>
              <p>
                With <code>JUPITER_API_KEY</code> set, the skill and the command line fetch the routes Orientim builds around from
                Jupiter with that key (<code>ownRoutes</code>), which never leaves your process. Orientim answers which builds it needs
                (<code>409 routes-needed</code>, with a sealed session and the one-time key as taker), your side fetches them and
                prepares again, usually once or twice; Orientim builds, checks and signs around them as around routes it asked for.{' '}
                <code>ORIENTIM_OWN_ROUTES=0</code> (or <code>ownRoutes: false</code> in code) lets Orientim&apos;s key fetch them
                instead. Routes come only from Jupiter: the verifier accepts Jupiter&apos;s program and no other.
              </p>
              <h3>What your routes can change</h3>
              <ul>
                <li>Your routes are untrusted, as Jupiter&apos;s own answers are: a made-up route can make your own swap fail or be refused.</li>
                <li>
                  Orientim&apos;s fee on the input is a share of <code>amountIn</code>, and a fee in SOL is priced with Orientim&apos;s own
                  key: no route sets either.
                </li>
                <li>
                  A fee on the output is 0.25% of the guaranteed minimum, the minimum your route sets. That minimum is checked
                  against an independent price of Orientim&apos;s own, with a tolerance of up to 1%. Within it, the fee follows your
                  route&apos;s minimum; further below, or with routes Orientim&apos;s verifier refuses, Orientim builds the swap with its
                  own key instead. Your wallet keeps at least
                  that minimum less the fee, and never less than your <code>minOut</code>.
                </li>
                <li>
                  A DEX the swap excludes that Orientim cannot tell by its programs (Jupiter&apos;s labels unavailable): the swap is
                  built with Orientim&apos;s key too. Either way the answer is the prepared swap as ever.
                </li>
              </ul>
              <h3>Time and requests</h3>
              <ul>
                <li>
                  One preparation, from your own quote to the last check before signing, takes at most 110 seconds and 48 asks of
                  your Jupiter key, retries included; a swap that needs more than 24 routes or 10 rounds is built with
                  Orientim&apos;s key. A <code>429</code> from Jupiter is waited out as long as Jupiter says, when that fits. When the
                  budget is spent, nothing is signed: the command line answers <code>error.code</code> <code>unavailable</code>, code
                  sees <code>BudgetSpentError</code>; prepare again in a moment.
                </li>
                <li>Every round is one prepare request toward the API&apos;s <a href="#limits">rate limit</a>.</li>
              </ul>
              <div className="table-wrap">
                <table className="table-stack">
                  <thead><tr><th>Who asks</th><th>For what, in one swap</th></tr></thead>
                  <tbody>
                    <tr><td>Your Jupiter key</td><td>Your own price (the floor and the price impact), always: one ask. With <code>ownRoutes</code>, the routes: usually two, at most 24. For a fee in SOL, one ask for your own limit on it.</td></tr>
                    <tr><td>Orientim&apos;s Jupiter key</td><td>Without <code>ownRoutes</code>, the routes. With them: one ask for its own price when the fee is on the output (kept 15 seconds across the rounds), and the price of a fee in SOL.</td></tr>
                    <tr><td>Orientim&apos;s RPC</td><td>The chain state it builds from, its own simulations, and sending once at finalize (nothing with <code>{'"send": false'}</code>).</td></tr>
                    <tr><td>Your RPC</td><td>The check before signing: a few account reads, one or two simulations and the token-risk read. After finalize: a status read about every second, and a re-send of the same bytes every few seconds, until the swap confirms or its lifetime passes (about 40 seconds), then one read of the transaction for what arrived. Any Solana RPC of yours works.</td></tr>
                  </tbody>
                </table>
              </div>
            </section>

            <section id="recovery">
              <h2>Results and recovery</h2>
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
                <strong>Orientim keeps no order database.</strong> It does not know your order ids, does not deduplicate your
                orders and cannot tell you later what became of a ticket: the chain and your own store are the record. The skill
                and the command line keep that store for you; a direct API client keeps its own and runs{' '}
                <a href="#verify">the check</a> before every signature.
              </p>
              <p>
                The skill and the command line read the result on chain for you and answer an <code>outcome</code> instead:{' '}
                <code>confirmed</code>, <code>failed</code>, <code>expired</code>, <code>unknown</code> (check again before anything new),
                or <code>rejected</code> (finalize refused, and the transaction can no longer land).
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
                  <code>recoverPending</code>), and <code>node bin/orientim-verify.mjs resolve</code> settles a swap by hand.
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
                Orientim checks that the message is byte for byte the one it built, that your wallet&apos;s signature is valid and that
                the transaction has not expired, then adds the last signature and sends it once. If an earlier finalize of this
                ticket already sent it, the answer is that same transaction and nothing is sent again.
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
                <li>
                  Sign the challenge within 10 minutes. Within those minutes the same signed challenge can be exchanged again, for
                  another key of the same wallet, which gives nothing more.
                </li>
                <li>
                  Sign only Orientim&apos;s key message for your own wallet: a signature over bytes someone else chose could be a
                  signature for a transaction. The skill checks the message before anything is signed.
                </li>
                <li>
                  <code>400 bad-signature</code>: the signature does not match, or the challenge expired, was not Orientim&apos;s, or
                  names another site. <code>403 wallet-empty</code>: the wallet holds less than 0.01 SOL.
                </li>
                <li>From one IP address, 30 challenges and 10 keys an hour; a <code>429</code> carries <code>Retry-After</code>.</li>
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
                  60 requests a minute for each endpoint, counted per wallet for a self-serve key; each round of{' '}
                  <a href="#own-routes">your own routes</a> is one prepare request. A <code>429</code> carries{' '}
                  <code>Retry-After</code>: the seconds until the count starts again.
                </li>
                <li>
                  At the edge, before Orientim, a firewall rule its operator sets: now 120 prepare and finalize requests a minute from one IP address, answered{' '}
                  <code>429</code> above it.
                </li>
                <li>API keys: 30 challenges and 10 keys an hour from one IP address.</li>
                <li>One swap per output token at a time, and one per wallet in the skill.</li>
                <li>A key used to overload or attack the service is revoked.</li>
              </ul>
            </section>

            <section id="env">
              <h2>Environment variables</h2>
              <p>The skill and the command line read these. Never put a wallet key in a prompt, a message, a log or a command line.</p>
              <div className="table-wrap">
                <table className="table-stack">
                  <thead><tr><th>Variable</th><th>Value</th></tr></thead>
                  <tbody>{ENV.map(([name, value]) => <tr key={name}><td><code>{name}</code></td><td>{value}</td></tr>)}</tbody>
                </table>
              </div>
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
                      On the output: that share of the guaranteed minimum, the minimum the transaction enforces, paid after it is
                      checked; <code>amounts.minOut</code> is what the wallet keeps after it. With <a href="#own-routes">your own
                      routes</a>, that minimum is checked against Orientim&apos;s own price within 1%.
                    </li>
                    <li>
                      In SOL from the wallet, for a pair neither token of which can carry it: that share of the swap&apos;s value in
                      SOL, priced with Orientim&apos;s key; the wallet then needs that SOL besides the token, and the skill holds it to
                      a limit from your own Jupiter price.
                    </li>
                  </ul>
                  A swap whose fee cannot be collected is refused with <code>503 fee-unavailable</code>.
                </li>
                <li>
                  The public deployment, agent API and shipped skill refuse an Orientim fee above 0.3%. The core verifier has a
                  separate 1% safety ceiling; the network-fee ceiling is 0.001 SOL.
                </li>
                <li>
                  A slippage tolerance of your choice (<code>slippageBps</code>, 0.1% to 15%); 0.5% by default, 3% on a Pump.fun launch
                  curve.
                </li>
                <li>
                  The skill refuses a swap whose price impact is above 5% before anything is prepared (<code>maxPriceImpactBps</code>{' '}
                  raises it, to 20% at most).
                </li>
                <li>
                  Limits no flag can loosen: in the skill, a minimum never more than 20% below Jupiter&apos;s own price
                  (<code>floor-too-low</code>) and Orientim&apos;s fee at 0.3% at most.
                </li>
                <li>
                  The owner&apos;s own limits, per swap and per day for each input mint, in a file (<code>ORIENTIM_POLICY</code>):
                  a swap outside them is refused before anything is prepared and again before finalize.
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
                <li><a href={SKILL_ARCHIVE} download>orientim-protected-swap.zip</a>: the skill, version {SKILL_VERSION}.</li>
                <li><a href="/skill/SHA256SUMS">SHA256SUMS</a>: the checksum of every file in it.</li>
                <li><a href={SKILL_SOURCE}>Source on GitHub</a>: the skill and its verifier, Apache-2.0, with a build that gives this same zip, byte for byte.</li>
                <li>The full API reference, every field and recovery step, is <code>reference/AGENT-API.md</code> in the download.</li>
              </ul>
            </section>
          </article>
        </div>
      </main>
      <SiteFooter />
    </div>
  );
}
