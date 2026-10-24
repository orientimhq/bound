import type { ReactNode } from 'react';
import { SKILL_EXTENSION } from '@/lib/server/skill';
import { AgentTerminal, CapsuleFlow } from './Motion';

const CAPSULE_STEPS = [
  ['Only the amount you approve can move', 'Your wallet signs for one trade: its amount, plus the fee and network costs shown before it signs. No open allowances, no lingering permissions, nothing more of your balance.'],
  ['Your balance never enters the market', 'Pools, curves and other contracts never reach your wallet or its other tokens. The only account they reach is the one that receives what you buy.'],
  ['Your minimum, or nothing happens', 'At least your minimum arrives in your wallet, after every fee, or the whole trade reverts: nothing is traded, and only the network fee is paid.'],
];

const AGENT_POINTS = [
  ['Sealed Blast Radius', 'A compromised route or malicious contract can never reach past the single approved trade amount. Checked by the verifier on your own RPC before signing, your main balance stays out of reach.'],
  ['Weaponized-Token Screening', 'Tokens with transfer hooks, unknown extensions or a frozen account are refused before signing; an issuer that can still freeze, mint or move balances is named to your agent first.'],
  ['Independent Price Enforcement', 'Your client cross-checks market quotes independently and enforces an unbreakable on-chain delivery floor that no server or route can lower.'],
  ['Prompt-Immune Spend Guardrails', 'Per-trade caps, daily budgets and asset allowlists are enforced from /etc/orientim/policy.json, a file you keep where the agent cannot write (owned by root), completely outside the AI model’s context window.'],
];

/**
 * The three ways in, one line each; the developer page has each in full. No version in these lines:
 * npx and npm take the current one, so the home page never names an old release.
 */
const GET_IT: { id: string; label: string; line: string; note: ReactNode; docs: string }[] = [
  {
    id: 'agent-kit', label: 'Solana Agent Kit', line: 'npx -y @orientimhq/swap mcp',
    note: <>Its tools beside your kit&apos;s: <a href="/developers/vercel-ai-sdk">Vercel AI SDK</a>, <a href="/developers/langchain">LangChain</a></>,
    docs: '/developers/vercel-ai-sdk',
  },
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

/** One small line icon for each of AGENT_POINTS, in the same order. */
const AGENT_ICONS = [
  <path key="0" d="M12 3l7 3v5c0 4.5-3 8.2-7 10-4-1.8-7-5.5-7-10V6l7-3z M9 12l2 2 4-4" />,
  <path key="1" d="M12 3a9 9 0 100 18 9 9 0 000-18z M6 6l12 12" />,
  <path key="2" d="M4 17l5-5 4 3 7-8 M4 20h16" />,
  <path key="3" d="M7 11V8a5 5 0 0110 0v3 M5 11h14v10H5z M12 15v2" />,
];

/** The six fields of the owner policy file, as the limits diagram names them. */
const LIMIT_CHIPS = ['Allowed tokens', 'Per-trade cap', 'Daily budget', 'Max slippage', 'Price floor', 'Impact cap'];

const LIMIT_GROUPS = [
  ['Spend caps', 'A cap per trade and a budget per day, set for each token your agent spends.'],
  ['Asset allowlist', 'Your agent sells only the tokens you gave a cap, and buys only the tokens you chose. A token someone names to your agent is refused.'],
  ['Price protection', 'The most slippage a trade may take, the furthest its floor may sit below the market price, and the largest price impact it may cause.'],
  ['Your approval', 'Want to see the price first? Your agent asks for a quote and shows you the least that will arrive and the fees. The swap that follows can never accept less than you approved, and your yes lapses after 10 minutes.'],
];

/** The hero's examples of the owner's limits, as the policy file on this page sets them. */
const HERO_RULES = ['50 USDC a trade, at most', '200 USDC a day, at most', 'Only the tokens you choose', 'Slippage capped at 3%', 'Never less than you approved'];

const THREATS: [string, string, string, string][] = [
  ['prompt', 'A message tells your agent to “swap everything” or “set slippage to 15%”.', 'With your policy file set, the skill stops at your limits: per trade, per day, the tokens you allow and the slippage you set.', 'Blocked before signing'],
  ['server', 'The swap server itself is hacked.', 'Orientim holds none of your keys. With the skill or verifier, your wallet signs only the transaction you asked for; a changed one never gets a signature.', 'Blocked before signing'],
  ['sandwich', 'A bot sandwiches the trade.', 'The minimum is enforced on chain: a swap that would fill beyond your slippage (0.5% by default) reverts, and only the network fee is paid.', 'Reverted on chain'],
];

export function HomeSections() {
  return (
    <>
      <section className="hero">
        <div className="container hero-grid">
          <div className="hero-copy">
            <p className="eyebrow">Zero-trust trade execution for AI agents on Solana</p>
            <h1 className="hero-title">Your trade gets its own wallet. <span className="hero-title-dim">Your wallet never becomes the trade.</span></h1>
            <p className="hero-lead">
              <b>You write the rules. Your agent can’t break them.</b> Every trade is checked against your limits on your own machine
              before your wallet signs, so even a hijacked agent stops where you said.
            </p>
            <ul className="hero-rules" aria-label="Examples of limits you set">
              {HERO_RULES.map((rule, i) => (
                <li key={rule} style={{ animationDelay: `${0.15 + i * 0.12}s` }}>
                  <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3.5 8.5l3 3 6-7" /></svg>{rule}
                </li>
              ))}
              <li className="hero-rules-more"><a href="#limits">See every limit →</a></li>
            </ul>
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

      <section className="section" id="how">
        <div className="container">
          <div className="section-head">
            <p className="eyebrow">Containment by design</p>
            <h2>Absolute separation between your capital and the market.</h2>
            <p className="lead">
              <b className="lead-strong">Only what you approve, one trade at a time.</b> Each trade can move only the amount your agent
              approved, plus the costs shown before it signs.
            </p>
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
          <div className="agents-head">
            <div>
              <p className="eyebrow eyebrow-cyan">Autonomous capital protection</p>
              <h2>When an agent hallucinates or gets hijacked, it still can’t spend past your limits.</h2>
            </div>
            <p className="lead">
              The skill checks each transaction before signing. For bots using the API directly, run the same verification and
              keep the signing key and spending policy outside the agent’s control.
            </p>
          </div>
          <ul className="agent-points">
            {AGENT_POINTS.map(([title, text], i) => (
              <li key={title}>
                <svg className="agent-icon" viewBox="0 0 24 24" aria-hidden="true">{AGENT_ICONS[i]}</svg>
                <b>{title}</b><span>{text}</span>
              </li>
            ))}
          </ul>
          <div className="cta-actions">
            <a className="button ghost-link" href="/developers#mcp">Add to Claude Desktop</a>
            <a className="button ghost-link" href="/developers">Developer docs</a>
          </div>
        </div>
      </section>

      <section className="section" id="protects">
        <div className="container">
          <div className="section-head">
            <p className="eyebrow">What it protects against</p>
            <h2>What your agent can’t be tricked into.</h2>
            <p className="lead">
              The attacks that can empty a trading agent, and what happens when the trade goes through Orientim. The market itself
              is the one thing no check controls; its <a href="/terms#risks">risks</a> are set out in the terms.
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
        </div>
      </section>

      <section className="section" id="limits">
        <div className="container">
          <div className="limits-grid">
            {/* The policy's six fields flow into the client on the agent's machine, which checks the trade before Solana sees it. */}
            <div className="lim-diagram" role="img" aria-label="Six limits from your policy file go into Orientim on your machine, which checks every trade before it reaches Solana.">
              <ul className="lim-chips" aria-hidden="true">
                {LIMIT_CHIPS.map(c => <li key={c}>{c}</li>)}
              </ul>
              <svg className="lim-wires" viewBox="0 0 600 90" aria-hidden="true">
                {['M100 0 C100 55 300 35 300 90', 'M300 0 V90', 'M500 0 C500 55 300 35 300 90'].map((d, i) => (
                  <g key={d}>
                    <path className="lim-line" d={d} />
                    <path className="lim-dot" d={d} pathLength={100} style={{ animationDelay: `${i * 1.2}s` }} />
                  </g>
                ))}
              </svg>
              <div className="lim-hub" aria-hidden="true">
                <b>Orientim · on your machine</b>
                <span>checked before your wallet signs</span>
              </div>
              <svg className="lim-out" viewBox="0 0 600 130" aria-hidden="true">
                <path className="lim-line" d="M300 0 V76" />
                <path className="lim-dot" d="M300 0 V76" pathLength={100} style={{ animationDelay: '2s' }} />
                {[36, 24, 12].map(r => <circle key={r} className="lim-ring" cx="300" cy="88" r={r} />)}
                <circle className="lim-node" cx="300" cy="88" r="6" />
              </svg>
              <p className="lim-chain" aria-hidden="true">Solana</p>
            </div>
            <div>
              <p className="eyebrow eyebrow-cyan">Limits you set</p>
              <h2>Your rules, enforced before every signature.</h2>
              <p className="lead">
                Six limits in one file you keep out of your agent’s reach, and your approval whenever you want to see the price first.
                Every trade is checked against them on your own machine before the wallet is asked to sign. A trade that breaks one is never signed.
              </p>
              <div className="lim-groups">
                {LIMIT_GROUPS.map(([title, text], i) => (
                  <details key={title} open={i === 0}>
                    <summary>{title}</summary>
                    <p>{text}</p>
                  </details>
                ))}
              </div>
              <details className="lim-policy">
                <summary>View the policy file →</summary>
                <div className="terminal policy">
                  <div className="terminal-bar"><span /><span /><span /><em>/etc/orientim/policy.json, annotated</em></div>
                  <pre tabIndex={0}>{`{
  "maxAmountIn": {
    "EPjF…Dt1v": "50000000"`}<span className="dim">{`      // 50 USDC a trade`}</span>{`
  },
  "maxAmountInPerDay": {
    "EPjF…Dt1v": "200000000"`}<span className="dim">{`     // 200 USDC a day`}</span>{`
  },
  "allowedOutputMints": ["So11…1112"],`}<span className="dim">{` // buys only SOL`}</span>{`
  "maxSlippageBps": 300,`}<span className="dim">{`         // never more than 3% slippage`}</span>{`
  "maxBelowBps": 500,`}<span className="dim">{`            // floor at most 5% below market`}</span>{`
  "maxPriceImpactBps": 500,`}<span className="dim">{`      // price impact at most 5%`}</span>{`
  "stateDir": "/var/lib/orientim"`}<span className="dim">{`  // every trade counted, out of the agent’s reach`}</span>{`
}`}{'\n\n'}<span className="dim">{`# the agent is told to trade 500 USDC`}</span>{'\n'}<span className="ok">{`✓ your policy holds it to 50 USDC a trade`}</span>{'\n'}<span className="dim">{`# the agent is told to buy a token someone named`}</span>{'\n'}<span className="ok">{`✓ your policy allows only the tokens you chose`}</span>{'\n'}<span className="dim">{`# the agent is told to set slippage to 15%`}</span>{'\n'}<span className="ok">{`✓ your policy caps slippage at 3%`}</span>{'\n'}<span className="dim">{`# the agent is told to accept less than you approved`}</span>{'\n'}<span className="ok">{`✓ the swap is held to the minimum you said yes to`}</span></pre>
                </div>
              </details>
            </div>
          </div>
          <p className="not-covered"><b>Your part:</b> keep the signing key in a separate signer with its own limits. The protection covers every trade through Orientim; an agent that can read its own key, transfers made outside Orientim, a key stolen from your machine and the value of the token you buy are outside it.</p>
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
              <h2>Deploy autonomous agents with hard limits, not a blank cheque.</h2>
              <p>Get a key with your agent’s wallet, download the skill, and let it trade within the limits you set.</p>
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
