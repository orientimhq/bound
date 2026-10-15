import type { ReactNode } from 'react';
import { SKILL_EXTENSION } from '@/lib/server/skill';
import { AgentTerminal, CapsuleFlow } from './Motion';

const CAPSULE_STEPS = [
  ['Your wallet never moves.', 'Your agent names the amount. Only that amount steps out, with the costs shown up front. The rest of your SOL, every other token and every NFT stay exactly where they are.'],
  ['The trade gets its own wallet.', 'The amount moves into a one-time key built for this swap alone. Orientim routes it across Solana’s markets, and the route never sees your wallet.'],
  ['Your price, or no trade.', 'Your agent sets the minimum before it signs. If the market can’t meet it, the whole swap reverts on chain: nothing is traded, and only the network fee is paid.', 'Reverted on chain'],
];

const AGENT_POINTS = [
  ['Checks before signing', 'The skill, the MCP server and the command line check the exact transaction on your own connection to Solana.'],
  ['Recovers an interrupted order', 'After a restart it settles what was in flight before anything new, and never swaps an order twice.'],
];

/**
 * The three ways in, one line each; the developer page has each in full. No version in these lines:
 * npx and npm take the current one, so the home page never names an old release.
 */
const GET_IT: { id: string; label: string; line: string; note: ReactNode; docs: string }[] = [
  {
    id: 'skill', label: 'Coding Agents (Skill)', line: 'cp -r node_modules/@orientimhq/swap/skills/orientim-protected-swap .claude/skills/',
    note: <>After <code>npm i @orientimhq/swap</code></>,
    docs: '/developers#skill',
  },
  {
    id: 'sdk', label: 'TypeScript / SDK', line: 'npm install @orientimhq/swap',
    note: <>Python, Rust, any language: <a href="/developers#cli">JSON CLI</a></>,
    docs: '/developers#skill',
  },
  {
    id: 'mcp', label: 'Claude & Cursor (MCP)', line: 'npx -y @orientimhq/swap mcp',
    note: <>Or <a href={SKILL_EXTENSION}>one click in Claude Desktop</a></>,
    docs: '/developers#mcp',
  },
];

/** What the protection rests on, in figures a visitor can check (the developer and security pages say how). */
const PROOF: [string, string, string][] = [
  ['7', 'byte-level rules', 'Checked on your own RPC before you sign, and fuzzed with about 29 million cases.'],
  ['1', 'one-time key per swap', 'It lives one transaction, about 150 blocks; its accounts close back to your wallet in it.'],
  ['0.25%', 'flat fee', 'No custody, no account to open, no sign-up: a key comes from one wallet signature.'],
  ['100%', 'open verifier', 'Apache-2.0, with every release attested on GitHub.'],
];

/** How an agent starts: the key, the skill, the first swap (the developer page has each in full). */
const START_STEPS = [
  ['Get an API key', 'Sign Orientim’s message with your agent’s wallet. The key comes at once and lasts 90 days; signing moves nothing. The MCP server gets one itself.'],
  ['Install the package', 'One npm package, @orientimhq/swap: instructions for your agent, the MCP server, a command line for bots, and the verifier that checks every swap.'],
  ['Ask for a swap', 'Tell your agent: “swap 5 USDC to SOL with Orientim”. It checks the transaction on its own RPC, then signs.'],
];

const THREATS: [string, string, string, string][] = [
  ['prompt', 'A message tells your agent to “swap everything” or “set slippage to 15%”.', 'With your policy file set, the skill stops at your limits: per swap, per day, the tokens you allow and the slippage you set.', 'Blocked before signing'],
  ['server', 'The swap server itself is hacked.', 'Orientim holds none of your keys. With the skill or verifier, a changed transaction is refused before it is signed.', 'Blocked before signing'],
  ['sandwich', 'A bot sandwiches the trade.', 'The minimum is enforced on chain: a swap that would fill below your tolerance (0.5% by default) reverts, and only the network fee is paid.', 'Reverted on chain'],
];

export function HomeSections() {
  return (
    <>
      <section className="hero">
        <div className="container hero-grid">
          <div className="hero-copy">
            <p className="eyebrow">Isolated swaps for AI agents and bots on Solana</p>
            <h1 className="hero-title">Your trade gets its own wallet. <span className="hero-title-dim">Your wallet never becomes the trade.</span></h1>
            <div className="cta-actions hero-actions">
              <a className="button primary-link" href="/developers#access">Get Instant API Key</a>
              <a className="button ghost-link" href="/developers">Explore Docs</a>
            </div>
          </div>
          <div className="hero-app">
            <AgentTerminal />
          </div>
        </div>
      </section>

      {/* How to get it, right under the hero: tabs without script (radio buttons and CSS). */}
      <section className="get-it" aria-label="Get Orientim">
        <div className="container">
          <div className="get-tabs">
            {GET_IT.map((g, i) => (
              <input key={g.id} type="radio" name="get-it" id={`get-${g.id}`} className={`get-radio get-radio-${g.id}`} defaultChecked={i === 0} />
            ))}
            <div className="get-labels" role="presentation">
              {GET_IT.map(g => <label key={g.id} htmlFor={`get-${g.id}`} className={`get-label get-label-${g.id}`}>{g.label}</label>)}
            </div>
            {GET_IT.map(g => (
              <div key={g.id} className={`get-panel get-panel-${g.id}`}>
                <pre tabIndex={0}><code><span className="get-prompt">$</span> {g.line}</code></pre>
                <p className="get-note">{g.note}</p>
                <a className="get-docs" href={g.docs}>Docs →</a>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section className="proof-band" aria-label="What the protection rests on">
        <div className="container">
          <ul className="proof-grid">
            {PROOF.map(([figure, label, text]) => (
              <li key={label}><b className="proof-figure">{figure}</b><span className="proof-label">{label}</span><p>{text}</p></li>
            ))}
          </ul>
        </div>
      </section>

      <section className="section" id="how">
        <div className="container">
          <div className="section-head">
            <p className="eyebrow">How protection works</p>
            <h2>Three steps, checked before anything is signed.</h2>
          </div>
          <div className="glass-stage">
            <div className="ambient" aria-hidden="true" />
            <div className="capsule-card">
              {/* On a phone the diagram keeps a readable size and scrolls sideways. */}
              <div className="capsule-scroll" role="region" aria-label="How protection works, as a diagram" tabIndex={0}>
                <CapsuleFlow />
              </div>
              <ol className="capsule-steps">
                {CAPSULE_STEPS.map(([title, text], i) => (
                  <li key={title}><span className="step-n">{i + 1}</span><div><h3>{title}</h3><p>{text}</p></div></li>
                ))}
              </ol>
            </div>
          </div>
        </div>
      </section>

      <section className="section" id="agents">
        <div className="container">
          <div className="dev-grid">
            <div>
              <p className="eyebrow eyebrow-cyan">For AI agents and bots</p>
              <h2>Your agent trades within the limits you set.</h2>
              <p className="lead">
                The skill checks each transaction before signing. For bots using the API directly, run the same verification and
                keep the signing key and spending policy outside the agent’s control.
              </p>
              <ul className="agent-points">
                {AGENT_POINTS.map(([title, text]) => <li key={title}><b>{title}</b><span>{text}</span></li>)}
              </ul>
              <div className="cta-actions">
                <a className="button ghost-link" href="/developers#mcp">Add to Claude Desktop</a>
                <a className="button ghost-link" href="/developers">Developer docs</a>
              </div>
            </div>
            <div className="glass-stage">
              <div className="ambient" aria-hidden="true" />
              <div className="capsule-card">
                <h3 className="start-title">Start in three steps</h3>
                <ol className="start-steps">
                  {START_STEPS.map(([title, text], i) => (
                    <li key={title}><span className="step-n">{i + 1}</span><div><h3>{title}</h3><p>{text}</p></div></li>
                  ))}
                </ol>
              </div>
            </div>
          </div>
        </div>
      </section>

      <section className="section" id="protects">
        <div className="container">
          <div className="section-head">
            <p className="eyebrow">What it protects against</p>
            <h2>What your agent can’t be tricked into.</h2>
            <p className="lead">
              The attacks that can empty a trading agent, and what happens when the swap goes through Orientim. What these checks
              cannot cover, such as the market itself, is in the <a href="/terms#risks">risks</a>.
            </p>
          </div>
          <div className="glass-stage">
            <div className="ambient" aria-hidden="true" />
            <ul className="threats">
              {THREATS.map(([k, attack, answer, verdict]) => (
                <li key={k}>
                  <div className="threat-attack">
                    <p className="threat-tag"><span className="x">✕</span> The attack</p>
                    <h3>{attack}</h3>
                  </div>
                  <div className="threat-answer">
                    <p className="threat-verdict"><span className="ok-dot">✓</span> {verdict}</p>
                    <p>{answer}</p>
                  </div>
                </li>
              ))}
            </ul>
          </div>
          <div className="limits-band">
            <div>
              <p className="eyebrow eyebrow-cyan">Limits you set</p>
              <h3>Rules in a file only you edit.</h3>
              <p className="lead">Per swap, per day, the tokens it may buy and the most slippage it may take. Your agent can’t raise them.</p>
              <ul className="policy-chips">
                <li><span>✓</span> At most 50 USDC a swap</li>
                <li><span>✓</span> At most 200 USDC a day</li>
                <li><span>✓</span> Buys only SOL, every other token refused</li>
                <li><span>✓</span> Never more than 3% slippage</li>
              </ul>
            </div>
            <div className="terminal policy">
              <div className="terminal-bar"><span /><span /><span /><em>orientim-policy.json, annotated</em></div>
              <pre tabIndex={0}>{`{
  "maxAmountIn": {
    "EPjF…Dt1v": "50000000"`}<span className="dim">{`      // 50 USDC a swap`}</span>{`
  },
  "maxAmountInPerDay": {
    "EPjF…Dt1v": "200000000"`}<span className="dim">{`     // 200 USDC a day`}</span>{`
  },
  "allowedOutputMints": ["So11…1112"],`}<span className="dim">{` // buys only SOL`}</span>{`
  "maxSlippageBps": 300,`}<span className="dim">{`         // never more than 3%`}</span>{`
  "stateDir": "/home/agent/.orientim-state"`}<span className="dim">{`  // where every swap is counted`}</span>{`
}`}{'\n\n'}<span className="dim">{`# the agent is told to swap 500 USDC`}</span>{'\n'}<span className="ok">{`✓ refused: over your limit of 50 USDC a swap`}</span>{'\n'}<span className="dim">{`# the agent is told to buy a token someone named`}</span>{'\n'}<span className="ok">{`✓ refused: not a token you allow it to buy`}</span>{'\n'}<span className="dim">{`# the agent is told to set slippage to 15%`}</span>{'\n'}<span className="ok">{`✓ refused: above your limit of 3%`}</span></pre>
            </div>
          </div>
          <p className="not-covered"><b>Not covered:</b> an agent that can read its own signing key and use it elsewhere, transfers made outside Orientim, a key stolen from your machine, and the value of the token you buy. Keep the key in a separate signer with its own limits.</p>
        </div>
      </section>

      <section className="section" id="security">
        <div className="container">
          <p className="keeps-nothing-line">
            No account, no cookies, no tracking. Orientim never holds your keys or funds, and keeps no database of your swaps.{' '}
            <a href="/privacy">Privacy notice →</a>
          </p>
        </div>
      </section>

      <section className="section">
        <div className="container">
          <div className="cta-band">
            <div>
              <h2>Give your agent a wallet, not a blank cheque.</h2>
              <p>Get a key with your agent’s wallet, download the skill, and let it swap within the limits you set.</p>
            </div>
            <div className="cta-actions">
              <a className="button primary-link" href="/developers#access">Get an API key</a>
              <a className="button ghost-link" href="/developers">Developer docs</a>
            </div>
          </div>
        </div>
      </section>
    </>
  );
}
