import { connection } from 'next/server';
import { SiteFooter, SiteHeader } from '@/components/site/Brand';
import { MobileNav } from '@/components/site/MobileNav';
import { DevNav, type DevNavGroup } from '@/components/site/DevNav';
import { GetApiKey } from '@/components/site/GetApiKey';
import { KeyAccess } from '@/components/site/KeyAccess';
import { FEE_BPS, FEE_TIER_TEXT, TREASURY } from '@/lib/client/config';
import { signPageChunks } from '@/lib/server/scriptIntegrity';
import { SKILL_EXTENSION, SKILL_FOLDER, SKILL_RELEASE, SKILL_VERSION } from '@/lib/server/skill';

/** The package's public source, and the workflow that publishes it to npm with provenance. */
const SKILL_SOURCE = 'https://github.com/orientimhq/orientim-protected-swap';

export const metadata = {
  title: 'Developers — Orientim',
  description: 'Protected Solana swaps for AI agents and bots: the agent skill, the command line and the API.',
};

/** The fee this build charges, as the other pages state it. */
const feeText = TREASURY
  ? `${(Number(FEE_BPS) / 100).toLocaleString('en-US', { maximumFractionDigits: 2 })}%${FEE_TIER_TEXT ? ` (${FEE_TIER_TEXT})` : ''}`
  : 'No fee (test deployment)';

/** Why an agent needs this, before the docs: what a developer gets, in their words. */
const PITCH: [string, string][] = [
  ['Signs only what it asked for', 'An extra instruction, another token or a worse price, and the agent does not sign.'],
  ['Your limits', 'Per swap, per day and which tokens it may buy, set by the owner.'],
  ['Safe after a crash', 'Each order is recorded and settled after a restart.'],
  ['No sign-up', 'The wallet signs a message and gets a key.'],
];

/** The sidebar's contents: every entry is a section of this page. */
const NAV: DevNavGroup[] = [
  { title: 'Getting started', items: [['overview', 'Overview'], ['start', 'Quickstart'], ['access', 'API keys']] },
  {
    title: 'Guides',
    items: [['skill', 'AI agents: the skill'], ['cli', 'Bots: the command line'], ['mcp', 'Assistants: the MCP server'], ['verify', 'Pre-sign verification'], ['policy', 'Your limits'], ['recovery', 'Results']],
  },
  { title: 'API reference', items: [['api', 'Authentication'], ['prepare', 'Prepare'], ['finalize', 'Finalize'], ['keys', 'Key endpoints'], ['errors', 'Errors'], ['limits', 'Rate limits']] },
  { title: 'Reference', items: [['fees', 'Fees and limits'], ['supported', 'Tokens and wallets'], ['downloads', 'Downloads']] },
];

/** Every error the API answers with, and what the caller does about it (AGENT-API.md, "Errors"). */
const ERRORS: [string, string, string][] = [
  ['400', 'bad-request', 'Fix the field named in message.'],
  ['400', 'invalid-ticket', 'The ticket is not this key’s, or was altered.'],
  ['400', 'transaction-changed', 'Sign the transaction exactly as returned.'],
  ['400', 'bad-signature', 'Keys: the signature or challenge is not valid. Ask for a new challenge.'],
  ['400', 'wallet-changed-transaction', 'Your wallet’s signature is missing or wrong.'],
  ['401', 'unauthorized', 'The API key is missing, expired or revoked. Get a new one.'],
  ['403', 'wrong-wallet', 'A key prepares swaps for its own wallet only.'],
  ['403', 'wallet-empty', 'Keys: the wallet holds less than 0.01 SOL.'],
  ['409', 'price-moved', 'The market cannot meet minOut. Retry with newMinOut only if the user approves.'],
  ['409', 'costs-more', 'The protected route is gapBps below the market. Retry with acceptCostBps only if the user approves.'],
  ['409', 'output-balance-changed', 'Your output balance moved since prepare. Check the signature, then prepare again.'],
  ['409', 'output-in-flight', 'Another swap into the same account has not landed yet. Finalize again after Retry-After.'],
  ['410', 'expired', 'The transaction expired. Check the signature, then prepare again.'],
  ['422', 'amount-too-small', 'Below about 0.004 SOL or $1. Selling a token’s whole balance is allowed at any size.'],
  ['422', 'unsupported-token, no-route, insufficient-sol, insufficient-balance, simulation-failed, …', 'This swap cannot be built safely now; message says why.'],
  ['426', 'skill-outdated', 'Update the skill. A swap already signed still finalizes.'],
  ['429', 'rate-limited', 'Too many requests. Wait Retry-After seconds.'],
  ['500', 'internal', 'Nothing was signed or sent. Retry later.'],
  ['503', 'busy, unavailable', 'Briefly unavailable. Retry after Retry-After.'],
  ['503', 'paused', 'Swaps and new keys are paused. Your funds are not affected.'],
];

const PREPARE_FIELDS: [string, string, string][] = [
  ['owner', 'required', 'The wallet that pays, receives and signs first.'],
  ['inputMint, outputMint', 'required', 'Mint addresses. SOL is So11111111111111111111111111111111111111112.'],
  ['amountIn', 'required', 'Base units, as a string ("5000000" is 5 USDC).'],
  ['minOut', 'required', 'The least your wallet must receive, in base units, from a price you got yourself.'],
  ['slippageBps', 'optional', '10 to 1500. Default 50, or 300 on a Pump.fun curve.'],
  ['acceptCostBps', 'optional', 'Accept a protected route this many bps below the market (costs-more). minOut still holds.'],
];

const PREPARE_ANSWER: [string, string][] = [
  ['ticket', 'Pass it to finalize.'],
  ['transaction', 'The unsigned transaction, base64. Verify it, then sign.'],
  ['messageSha256', 'The hash of the transaction message.'],
  ['temporaryAuthority', 'The swap’s one-time key.'],
  ['lastValidBlockHeight, blocksLeft', 'The lifetime: 150 blocks, about 40 seconds.'],
  ['amounts', 'amountIn, fee, feeMint, feeBps, quotedOut, minOut, priceImpactPct (null means unknown).'],
  ['costs', 'Network fee, rent, Orientim’s fee, and keptSolLamports: all the SOL the swap does not return.'],
  ['notices, tokens', 'A busy network, and whether a token’s issuer can freeze, mint or move balances.'],
  ['certificate, policy', 'What the transaction does, and the rules it was checked against.'],
];

/** What `orientim` exits with (src/cli.ts in @orientimhq/swap). */
const EXIT_CODES: [string, string][] = [
  ['0', 'Done: ready to sign, confirmed, all settled, or safe to sign.'],
  ['1', 'Refused or not swapped; error.code says why. Nothing is left to settle.'],
  ['2', 'Usage or configuration error; the answer says what is missing.'],
  ['3', 'An earlier swap may still land. Run recover; start nothing new.'],
  ['4', 'Orientim refused: error.code is one of the Errors below.'],
  ['5', 'This order id already swapped, or may still land. It never swaps twice.'],
];

/** The skill in your own code: the owner's limits, one swap per wallet, and recovery first. */
const OWN_CODE = <pre tabIndex={0}><code>{`import { createKeyPairSignerFromBytes, createSolanaRpc } from '@solana/kit';
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
}`}</code></pre>;

/** A bot in Python, through the command line. */
const PYTHON = <pre tabIndex={0}><code>{`import base64, json, subprocess

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
        "checked": ready["checked"], "signature": str(signature)})`}</code></pre>;

/** The MCP server in a client's configuration. */
const MCP_JSON = <pre tabIndex={0}><code>{`{
  "mcpServers": {
    "orientim": {
      "command": "npx",
      "args": ["-y", "@orientimhq/swap@${SKILL_VERSION}", "mcp"],
      "env": {
        "SOLANA_RPC_URL": "https://your-own-rpc.example/...",
        "ORIENTIM_WALLET_KEYPAIR": "/path/to/agent-wallet.json",
        "ORIENTIM_POLICY": "/path/to/orientim-policy.json",
        "JUPITER_API_KEY": "..."
      }
    }
  }
}`}</code></pre>;

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
              <h1>Deploy autonomous agents with hard limits, not a blank cheque.</h1>
              <p className="lead">Each swap is checked against your limits, on your own RPC, before the agent signs.</p>
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
              <p>
                Your agent decides what to trade. Orientim builds the swap, your agent checks it on its own RPC, your wallet signs it,
                and if less than your minimum would arrive, the transaction reverts. Pick a way in:
              </p>
              <div className="table-wrap">
                <table>
                  <thead><tr><th>Use</th><th>For</th></tr></thead>
                  <tbody>
                    <tr><td><a href="#skill">Agent skill</a></td><td>Coding agents such as Claude Code.</td></tr>
                    <tr><td><a href="#cli">Command line</a></td><td>Bots in Python, Rust, Go or any language.</td></tr>
                    <tr><td><a href="#mcp">MCP server</a></td><td>Claude Desktop, Cursor and other assistants.</td></tr>
                    <tr><td><a href="#api">API</a></td><td>Your own client. It must run <a href="#verify">pre-sign verification</a> before signing and keep its own <a href="#recovery">records</a>.</td></tr>
                  </tbody>
                </table>
              </div>
              <p>All but the API check, record and recover each swap for you. You need:</p>
              <ul>
                <li>An <a href="#access">API key</a> for the wallet (the MCP server gets its own).</li>
                <li>Your own RPC, and your own <a href="https://developers.jup.ag">Jupiter API key</a> (free).</li>
                <li>A wallet that signs and hands the transaction back: a key file or a signing service.</li>
                <li>Node 20.18 or later.</li>
              </ul>
            </section>

            <section id="start">
              <h2>Quickstart</h2>
              <p>
                On Claude Desktop, open <a href={SKILL_EXTENSION}>orientim.mcpb</a> and answer its questions (<a href="#mcp">MCP server</a>).
                Otherwise:
              </p>
              <ol>
                <li><strong>Get an API key</strong> for the wallet: <a href="#access">API keys</a>.</li>
                <li>
                  <strong>Install</strong> <code>@orientimhq/swap</code> v{SKILL_VERSION} (<a href={SKILL_SOURCE}>source</a>, Apache-2.0).
                  <pre tabIndex={0}><code>{`npm install --save-exact @orientimhq/swap@${SKILL_VERSION}`}</code></pre>
                </li>
                <li>
                  <strong>Check it</strong> was built from the GitHub source: the file npm installs, against the release&apos;s attestation.
                  <pre tabIndex={0}><code>{`npm pack @orientimhq/swap@${SKILL_VERSION}
gh attestation verify orientimhq-swap-${SKILL_VERSION}.tgz -R orientimhq/orientim-protected-swap`}</code></pre>
                </li>
                <li>
                  <strong>Configure</strong> (all settings: <a href="https://github.com/orientimhq/orientim-protected-swap/blob/main/skills/orientim-protected-swap/reference/GUIDE.md#setup">guide</a>).
                  <pre tabIndex={0}><code>{`export ORIENTIM_API_URL=https://orientim.com
export ORIENTIM_API_KEY=ori_...
export SOLANA_RPC_URL=<your own RPC>
export JUPITER_API_KEY=<your Jupiter key>
export ORIENTIM_POLICY=/etc/orientim/policy.json`}</code></pre>
                </li>
                <li>
                  <strong>Set the owner&apos;s limits</strong> in a file the agent cannot edit: 50 USDC a swap, 200 a day, only into SOL. A daily limit needs a <code>stateDir</code>.
                  <pre tabIndex={0}><code>{`{
  "maxAmountIn": { "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v": "50000000" },
  "maxAmountInPerDay": { "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v": "200000000" },
  "allowedOutputMints": ["So11111111111111111111111111111111111111112"],
  "stateDir": "/var/lib/orientim"
}`}</code></pre>
                </li>
                <li>
                  <strong>Try it</strong> without signing.
                  <pre tabIndex={0}><code>{`npx orientim swap --in EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v \\
  --out So11111111111111111111111111111111111111112 --amount 5000000 \\
  --owner <wallet> --dry-run`}</code></pre>
                </li>
                <li>
                  <strong>Swap</strong>, with the same order id on every retry.
                  <pre tabIndex={0}><code>{`export ORIENTIM_WALLET_KEYPAIR=/path/to/wallet.json
npx orientim swap --in EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v \\
  --out So11111111111111111111111111111111111111112 --amount 5000000 --id order-1`}</code></pre>
                </li>
                <li>
                  <strong>Make restarts safe</strong>: keep the state directory on a lasting disk, run <code>recover</code> on every start,
                  and count only <code>confirmed</code> as done (<a href="#recovery">Results</a>).
                </li>
              </ol>
            </section>

            <section id="access">
              <h2>API keys</h2>
              <p>
                The wallet signs a message and gets a key for itself. Signing moves nothing. The wallet needs 0.01 SOL; a key lasts 90 days.
              </p>
              <KeyAccess
                ways={[
                  {
                    id: 'agent',
                    label: 'Agent or bot wallet',
                    content: (
                      <>
                        <p>A key file or a signing service (Turnkey, Privy). The key never leaves your machine.</p>
                        <pre tabIndex={0}><code>{`export ORIENTIM_API_URL=https://orientim.com
echo '{"wallet": "<address>"}' | npx orientim key-challenge
# sign the bytes of "message" with the wallet, then send "message" unchanged:
echo '{"message": "...", "challenge": "...", "signature": "<base58>"}' | npx orientim key`}</code></pre>
                        <p>
                          In code: <code>requestApiKey</code>, which signs only Orientim&apos;s key message. Over HTTP: <a href="#keys">Keys</a>.
                        </p>
                      </>
                    ),
                  },
                  {
                    id: 'browser',
                    label: 'Wallet in the browser',
                    content: (
                      <>
                        <p>Phantom, Solflare or Backpack: connect and sign.</p>
                        <GetApiKey skill={{ href: '#start', version: SKILL_VERSION }} />
                      </>
                    ),
                  },
                ]}
              />
            </section>

            <section id="skill" className="way">
              <h2>AI agents: the skill</h2>
              <p className="way-lead">
                For coding agents such as Claude Code. <code>@orientimhq/swap</code> holds the skill, the <code>orientim</code> command and the library.
              </p>
              <KeyAccess
                label="Set up the skill"
                ways={[
                  {
                    id: 'skill-install',
                    label: 'Install',
                    content: (
                      <>
                        <pre tabIndex={0}><code>{`npm install --save-exact @orientimhq/swap@${SKILL_VERSION}
cp -r node_modules/@orientimhq/swap/skills/orientim-protected-swap .claude/skills/`}</code></pre>
                        <p className="hint">Other agents: point them to <code>SKILL.md</code> (<a href={SKILL_FOLDER}>GitHub</a>). Settings: <a href="#start">Quickstart</a>.</p>
                      </>
                    ),
                  },
                  {
                    id: 'skill-try',
                    label: 'Try',
                    content: (
                      <>
                        <pre tabIndex={0}><code>{`npx orientim swap --in <mint> --out <mint> --amount 5000000 \\
  --owner <wallet> --dry-run`}</code></pre>
                        <p className="hint">Shows the swap and its cost. Nothing is signed.</p>
                      </>
                    ),
                  },
                  {
                    id: 'skill-swap',
                    label: 'Swap',
                    content: (
                      <>
                        <pre tabIndex={0}><code>{`npx orientim swap --in <mint> --out <mint> --amount 5000000 --id order-42`}</code></pre>
                        <p className="hint">Or ask your agent: <em>&ldquo;swap 5 USDC to SOL with Orientim&rdquo;</em>.</p>
                      </>
                    ),
                  },
                  { id: 'skill-code', label: 'In your code', content: OWN_CODE },
                ]}
              />
              <ul className="way-notes">
                <li>Use the same order id on every retry. An order never swaps twice.</li>
                <li>In your own code, pass <code>policy</code> and <code>spends</code>, or the owner&apos;s limits do not apply.</li>
                <li>Signing service: pass <code>signerFromSignTransaction</code> (Turnkey, Privy) or <code>signerFromSignBytes</code> (KMS, HSM) as <code>wallet</code>.</li>
              </ul>
              <h3>Production setup</h3>
              <ul className="way-notes">
                <li>Keep the key out of the agent&apos;s reach: a signing service, a KMS or an HSM.</li>
                <li>Put the policy at <code>/etc/orientim/policy.json</code> (<code>C:\ProgramData\Orientim\policy.json</code> on Windows), read-only to the agent.</li>
                <li>Fund the wallet with only what the agent may swap.</li>
              </ul>
            </section>

            <section id="cli" className="way">
              <h2>Bots: the command line</h2>
              <p className="way-lead">
                For bots in any language: JSON on stdin, JSON on stdout, and an exit code. Your bot signs one message.
              </p>
              <KeyAccess
                label="Set up the command line"
                ways={[
                  {
                    id: 'cli-flow',
                    label: 'The flow',
                    content: (
                      <ol>
                        <li><strong>recover</strong>: settles earlier swaps. Exit 3: start nothing new.</li>
                        <li><strong>prepare</strong> <code>{'{"intent": {...}}'}</code>: returns <code>message</code> and <code>checked</code>.</li>
                        <li><strong>Sign</strong> the bytes of <code>message</code> (base64) with the wallet&apos;s key.</li>
                        <li><strong>finalize</strong> <code>{'{"checked": ..., "signature": "<base58>"}'}</code>: returns <code>outcome</code> and <code>received</code>.</li>
                      </ol>
                    ),
                  },
                  { id: 'cli-python', label: 'Python', content: PYTHON },
                  {
                    id: 'cli-exit',
                    label: 'Exit codes',
                    content: (
                      <div className="table-wrap">
                        <table>
                          <thead><tr><th>Code</th><th>Meaning</th></tr></thead>
                          <tbody>{EXIT_CODES.map(([code, text]) => <tr key={code}><td><code>{code}</code></td><td>{text}</td></tr>)}</tbody>
                        </table>
                      </div>
                    ),
                  },
                ]}
              />
              <ul className="way-notes">
                <li>Branch on <code>error.code</code>. <code>untrustedServerMessage</code> is for logs only.</li>
                <li>Rust: <code>keypair.sign_message(&amp;message).to_string()</code>.</li>
                <li><code>resolve</code> settles a swap by hand; <code>key-challenge</code> and <code>key</code> get an <a href="#access">API key</a>.</li>
              </ul>
            </section>

            <section id="mcp" className="way">
              <h2>Assistants: the MCP server</h2>
              <p className="way-lead">
                For Claude Desktop, Claude Code, Cursor and any client that runs a local MCP server. It gets its own API key.
              </p>
              <KeyAccess
                label="Set up the MCP server"
                ways={[
                  {
                    id: 'mcp-desktop',
                    label: 'Desktop',
                    content: (
                      <>
                        <pre tabIndex={0}><code>{`gh attestation verify orientim.mcpb -R orientimhq/orientim-protected-swap`}</code></pre>
                        <p className="hint">
                          Download <a href={SKILL_EXTENSION}>orientim.mcpb</a> (v{SKILL_VERSION}), verify it and open it. It asks for your RPC, keypair file and limits file.
                        </p>
                      </>
                    ),
                  },
                  { id: 'mcp-json', label: 'Cursor', content: MCP_JSON },
                  {
                    id: 'mcp-code',
                    label: 'Claude Code',
                    content: <pre tabIndex={0}><code>{`claude mcp add --transport stdio orientim --env SOLANA_RPC_URL=... --env ORIENTIM_WALLET_KEYPAIR=... --env ORIENTIM_POLICY=... -- npx -y @orientimhq/swap@${SKILL_VERSION} mcp`}</code></pre>,
                  },
                  {
                    id: 'mcp-own',
                    label: 'Own agent',
                    content: (
                      <p className="hint">
                        Start the same server from your agent: <a href="/developers/vercel-ai-sdk">Vercel AI SDK</a> and <a href="/developers/langchain">LangChain</a> examples.
                      </p>
                    ),
                  },
                ]}
              />
              <div className="table-wrap">
                <table>
                  <thead><tr><th>Tool</th><th>What it does</th></tr></thead>
                  <tbody>
                    <tr><td><code>orientim_wallet</code></td><td>Address and balances.</td></tr>
                    <tr><td><code>orientim_quote</code></td><td>Prices and verifies a swap. Nothing is signed.</td></tr>
                    <tr><td><code>orientim_swap</code></td><td>Swaps the quote you approved, within 10 minutes.</td></tr>
                    <tr><td><code>orientim_recover</code></td><td>Settles an interrupted swap.</td></tr>
                  </tbody>
                </table>
              </div>
              <ul className="way-notes">
                <li>Your client asks you before each swap, when it supports it.</li>
                <li>Caps: 3% slippage and 5% price impact. Raise them with <code>ORIENTIM_MAX_SLIPPAGE_BPS</code> and <code>ORIENTIM_MAX_PRICE_IMPACT_BPS</code>.</li>
                <li>It runs locally, next to the key. Remote-only assistants such as ChatGPT cannot use it.</li>
              </ul>
            </section>

            <section id="verify">
              <h2>Pre-sign verification</h2>
              <p>
                With pre-sign verification, even a compromised server cannot make your wallet sign more than you approved, or below your own
                floor. <strong>Without it, you trust Orientim&apos;s server with your wallet.</strong>
              </p>
              <p>
                The skill, the command line and the MCP server run it for you. Your own client: call{' '}
                <code>checkPrepared(prepared, intent, yourRpc)</code>, or pipe <code>{'{"prepared": ..., "intent": {...}}'}</code> into{' '}
                <code>npx orientim check</code>, and sign only when it finds no problems. Take your minimum from your own price
                (<code>ownMinimum</code>), never from Orientim.
              </p>
            </section>

            <section id="policy">
              <h2>Your limits</h2>
              <p>
                <strong>You write the rules; your agent cannot break them.</strong> The skill, the command line and the MCP server check every trade
                against the owner&apos;s policy file before the wallet signs. A trade that breaks one limit is refused and nothing is signed, whatever
                the agent was told. There is no swap without a policy.
              </p>
              <div className="table-wrap">
                <table>
                  <thead><tr><th>Field</th><th>What it holds the agent to</th></tr></thead>
                  <tbody>
                    <tr><td><code>maxAmountIn</code></td><td>The most one trade may spend, per token. Required. A token without a cap here cannot be sold at all.</td></tr>
                    <tr><td><code>maxAmountInPerDay</code></td><td>A budget per token over any 24 hours. A trade whose outcome is unknown counts for the full 24 hours.</td></tr>
                    <tr><td><code>allowedOutputMints</code></td><td>The only tokens the agent may buy. Unset, any token.</td></tr>
                    <tr><td><code>maxSlippageBps</code></td><td>The most slippage a trade may take, 0.1% to 15%. A higher request is refused.</td></tr>
                    <tr><td><code>maxBelowBps</code></td><td>The furthest the minimum may sit below the market price, up to 20%.</td></tr>
                    <tr><td><code>maxPriceImpactBps</code></td><td>The largest price impact a trade may cause, up to 20%. The 5% default can only be lowered.</td></tr>
                    <tr><td><code>allowUnknownPriceImpact</code></td><td>Whether a route with no reported price impact may go. No by default.</td></tr>
                    <tr><td><code>stateDir</code></td><td>Where every trade is counted. Required with a daily budget.</td></tr>
                  </tbody>
                </table>
              </div>
              <p>
                <strong>Your approval.</strong> Before a swap you want to see, your agent asks for a quote (<code>orientim_quote</code>, or{' '}
                <code>--dry-run</code>): you see the least that will arrive and the fees. The swap that follows can never accept less than you
                approved, and your yes lapses after 10 minutes.
              </p>
              <p>
                <strong>Out of your agent&apos;s reach.</strong> Point <code>ORIENTIM_POLICY</code> at the file, or put it at{' '}
                <code>/etc/orientim/policy.json</code> (<code>C:\ProgramData\Orientim\policy.json</code> on Windows), owned by an administrator:
                when that file exists it is the only policy used, so an agent that unsets the variable changes nothing. Keep the signing key in a
                separate signer too. A client of your own on the bare API enforces its own limits.
              </p>
            </section>

            <section id="recovery">
              <h2>Results</h2>
              <p>
                Every swap ends with an <code>outcome</code>: <code>confirmed</code>, <code>failed</code>, <code>expired</code>,{' '}
                <code>rejected</code>, or <code>unknown</code> (check again before anything new).{' '}
                <strong>Only a swap confirmed on chain is done.</strong>
              </p>
              <p>
                Orientim keeps no order database: your state directory and the chain are the record, so keep it on a lasting disk
                and run <code>recover</code> on every start. A direct API client keeps its own records and settles them on start, as{' '}
                <code>reference/AGENT-API.md</code> describes.
              </p>
            </section>

            <section id="api">
              <h2>Authentication</h2>
              <p>Base URL <code>https://orientim.com</code>. Every request carries an API key:</p>
              <pre tabIndex={0}><code>Authorization: Bearer ori_...</code></pre>
              <p>A key prepares swaps for its own wallet only.</p>
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
              <p>A prepare answers within 45 seconds, or <code>503 unavailable</code>.</p>
            </section>

            <section id="finalize">
              <h2>Finalize</h2>
              <pre tabIndex={0}><code>{`POST /api/v1/finalize
Authorization: Bearer ori_...
Content-Type: application/json

{ "ticket": "eyJ2Ijox....", "signedTransaction": "<base64, signed by your wallet>" }`}</code></pre>
              <p>Orientim signs and sends. The same ticket again returns the same transaction.</p>
              <pre tabIndex={0}><code>{`{
  "signature": "5h...",
  "status": "sent",
  "signedTransaction": "<base64, fully signed>",
  "lastValidBlockHeight": "312345678"
}`}</code></pre>
              <div className="table-wrap">
                <table>
                  <thead><tr><th>status</th><th>Meaning</th></tr></thead>
                  <tbody>
                    <tr><td><code>sent</code></td><td>Accepted. Confirm on chain; re-send <code>signedTransaction</code> until it confirms or expires. It lands only once.</td></tr>
                    <tr><td><code>unknown</code></td><td>The answer was lost. Check the signature first.</td></tr>
                    <tr><td><code>signed</code></td><td>With <code>{'"send": false'}</code>: signed, not sent. Send it yourself (staked RPC, bundle).</td></tr>
                    <tr><td><code>rejected</code></td><td>Not sent, usually because the price moved.</td></tr>
                  </tbody>
                </table>
              </div>
              <p>Store the signature and the ticket before you call finalize: the signature is the transaction id.</p>
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
                <li>Sign only Orientim&apos;s key message. Other bytes could be a transaction.</li>
                <li>Keep your key; do not request a new one on every start.</li>
              </ul>
            </section>

            <section id="errors">
              <h2>Errors</h2>
              <p>
                Every error is <code>{'{ "error": { "code": "...", "message": "..." } }'}</code>, and nothing was signed or sent.{' '}
                <code>requiresApproval: true</code> means ask the user, do not retry.
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
                <li>Per wallet: 20 prepare and 15 finalize a minute, whatever the number of its keys.</li>
                <li>Per IP address: 120 prepare a minute.</li>
                <li>Keys: 30 challenges and 30 keys an hour per IP, 3 keys a day per wallet.</li>
                <li>A <code>429</code> carries <code>Retry-After</code>.</li>
                <li><code>GET /api/health</code> needs no key: 200 when swaps can go through, else 503.</li>
              </ul>
            </section>

            <section id="fees">
              <h2>Fees and limits</h2>
              <ul>
                <li>Orientim&apos;s fee: {feeText}, inside the transaction and shown before you sign (<code>amounts.fee</code>, <code>amounts.feeMint</code>).</li>
                <li>The skill refuses an Orientim fee above 0.25% (<code>maxFeeBps</code>, up to 0.3%) and a network fee above 0.001 SOL.</li>
                <li>Slippage: 0.5% by default, 3% on a Pump.fun curve (<code>slippageBps</code>, 0.1% to 15%).</li>
                <li>Price impact: at most 5% (<code>maxPriceImpactBps</code>, up to 20%).</li>
                <li>The minimum is never more than 20% below Jupiter&apos;s price.</li>
                <li>The owner&apos;s limits per swap, per day and per token: see <a href="#policy">Your limits</a>.</li>
                <li>Smallest swap: about 0.004 SOL or $1, except selling a whole balance.</li>
              </ul>
            </section>

            <section id="supported">
              <h2>Tokens and wallets</h2>
              <p>
                See <a href="/security#supported">supported tokens</a>. Key files and signing services work; sign-and-send-only
                wallets and multisig vaults do not.
              </p>
            </section>

            <section id="downloads">
              <h2>Downloads</h2>
              <ul>
                <li>
                  <a href={`https://www.npmjs.com/package/@orientimhq/swap/v/${SKILL_VERSION}`}>@orientimhq/swap</a> v{SKILL_VERSION} on npm: library, CLI, MCP server and skill.
                </li>
                <li><a href={SKILL_EXTENSION}>orientim.mcpb</a>: the MCP server for Claude Desktop.</li>
                <li>
                  Verify: <code>gh attestation verify &lt;file&gt; -R orientimhq/orientim-protected-swap</code>, or the sha256 in{' '}
                  <code>RELEASE-SHA256SUMS</code> on the <a href={SKILL_RELEASE}>release</a>.
                </li>
                <li><a href={SKILL_SOURCE}>Source on GitHub</a>, Apache-2.0, with a reproducible build.</li>
                <li>Full API reference: <code>reference/AGENT-API.md</code> in the skill folder.</li>
              </ul>
            </section>
          </article>
        </div>
      </main>
      <SiteFooter />
    </div>
  );
}
