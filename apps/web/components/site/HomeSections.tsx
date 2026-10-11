import { FEE_BPS, TREASURY } from '@/lib/client/config';
import { AgentTerminal, CapsuleFlow, CheckedTwice } from './Motion';

/** The fee this build charges, as the other pages state it. */
const feeText = `${(Number(FEE_BPS) / 100).toLocaleString('en-US', { maximumFractionDigits: 2 })}%`;

const CAPSULE_STEPS = [
  ['Your agent chooses the amount.', 'Only that amount and the fees it was shown leave the wallet, plus a market deposit when one is stated first.'],
  ['Only that amount goes into the swap.', 'Orientim finds a route across Solana’s markets and trades just that amount.'],
  ['At least the minimum, or nothing happens.', 'Your agent sets its minimum before it signs. If less would arrive, the swap cancels and only the network fee is paid.'],
];

const AGENT_POINTS = [
  ['Checks before signing', 'The skill and the command line check the exact transaction on your own connection to Solana.'],
  ['Limits you set', 'An amount per swap, a daily budget, the tokens it may buy and the most slippage it may take, in the owner’s policy.'],
  ['Recovers an interrupted order', 'After a restart it settles what was in flight before anything new, and never swaps an order twice as long as its state directory is kept.'],
  ['Works with your stack', 'A skill for coding agents. For bots in any language, a command line: JSON in, JSON out, clear exit codes.'],
];

/** How an agent starts: the key, the skill, the first swap (the developer page has each in full). */
const START_STEPS = [
  ['Get an API key', 'Sign Orientim’s message with your agent’s wallet. The key comes at once and lasts 90 days; signing moves nothing.'],
  ['Download the skill', 'Instructions for your agent, a working example, a command line for bots, and the verifier that checks every swap.'],
  ['Ask for a swap', 'Tell your agent: “swap 5 USDC to SOL with Orientim”. It checks the transaction on its own RPC, then signs.'],
];


const THREATS: [string, string, string][] = [
  ['prompt', 'A message tells your agent to “swap everything” or “set slippage to 15%”.', 'With your policy file set, the skill stops at your limits: per swap, per day, the tokens you allow and the slippage you set.'],
  ['drain', 'A server hands your agent a transaction that drains the wallet.', 'With the skill or verifier, every instruction is checked on your own RPC. Approvals, authority changes and stray transfers are refused.'],
  ['server', 'The swap server itself is hacked.', 'Orientim holds none of your keys. With the skill or verifier, a changed transaction is refused before it is signed.'],
  ['sandwich', 'A bot sandwiches the trade.', 'The minimum is enforced on chain: a swap that would fill below your tolerance (0.5% by default) reverts, and only the network fee is paid.'],
  ['token', 'A token built to trap you.', 'Tokens Orientim can’t isolate are refused before anything is signed, with the reason. Powers the issuer keeps, such as a freeze authority, are shown before your agent signs.'],
  ['crash', 'The agent crashes mid-swap and tries again.', 'The skill keeps every order by id: after a restart it settles what was in flight and, as long as its state directory survives, never swaps it twice.'],
];

const KEEPS_NOTHING = [
  [NoDatabaseIcon, 'No account. No database.', 'Orientim stores no API keys and no list of your swaps. Our host keeps short-lived request logs, never a key or a transaction.'],
  [ShieldIcon, 'Never your keys or funds.', 'Your agent signs with its own wallet or signing service. Orientim never holds funds or asks for a seed phrase.'],
  [EyeOffIcon, 'No tracking.', 'No cookies, analytics or trackers on this site.'],
] as const;

export function HomeSections() {
  return (
    <>
      <section className="hero">
        <div className="container hero-grid">
          <div className="hero-copy">
            <p className="eyebrow">Protected swaps on Solana, for AI agents and bots</p>
            <h1 className="hero-title">Give your agent a safer way to swap.</h1>
            <p className="hero-sub">Your agent’s swap only ever reaches the amount it approves, and the skill checks every transaction against your limits before it signs.</p>
            <div className="cta-actions hero-actions">
              <a className="button primary-link" href="/developers#access">Get an API key</a>
              <a className="button ghost-link" href="/developers#start">Quickstart</a>
            </div>
            {TREASURY && (
              <p className="cta-note">
                {feeText} a swap, inside the transaction your agent signs. No sign-up, no subscription. <a href="/security#fees">See fees</a>
              </p>
            )}
          </div>
          <div className="hero-app">
            <AgentTerminal />
          </div>
        </div>
      </section>

      <section className="section" id="how">
        <div className="container">
          <div className="section-head">
            <p className="eyebrow">How protection works</p>
            <h2>The swap gets the amount. Never your wallet.</h2>
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
                <a className="button ghost-link" href="/developers">Developer docs</a>
              </div>
              <p className="cta-note">
                The skill is open source, under Apache-2.0: <a href="https://github.com/orientimhq/orientim-protected-swap">read it on GitHub</a>.
              </p>
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
          <div className="checked-twice">
            <h3>Checked by Orientim, checked again by your agent</h3>
            <CheckedTwice />
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
              {THREATS.map(([k, attack, answer]) => (
                <li key={k}>
                  <p className="threat-tag"><span className="x">✕</span> The attack</p>
                  <h3>{attack}</h3>
                  <div className="threat-answer"><span className="ok-dot">✓</span><p>{answer}</p></div>
                </li>
              ))}
            </ul>
          </div>
          <div className="limits-band">
            <div>
              <p className="eyebrow eyebrow-cyan">Limits you set</p>
              <h3>Rules in a file only you edit.</h3>
              <ul className="limit-list">
                <li><b>Per swap</b><span>The most one swap may spend, for each token.</span></li>
                <li><b>Per day</b><span>The most all swaps may spend in 24 hours.</span></li>
                <li><b>Only these tokens</b><span>A token not on the list is never spent.</span></li>
                <li><b>Only these buys</b><span>A token not on your list is never bought, whoever names it.</span></li>
                <li><b>A price floor</b><span>From your agent’s own quote, never more than 20% below the market.</span></li>
                <li><b>Max slippage</b><span>The most the price may move against a swap. Your agent can’t raise it.</span></li>
                <li><b>Max price impact</b><span>A swap that would move a thin market too far is refused.</span></li>
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
          <div className="section-head">
            <p className="eyebrow">Private by design</p>
            <h2>Protection that keeps nothing.</h2>
          </div>
          <div className="glass-stage">
            <div className="ambient" aria-hidden="true" />
            <ul className="keeps-nothing">
              {KEEPS_NOTHING.map(([Icon, title, text]) => (
                <li key={title}><span className="trust-icon"><Icon /></span><h3>{title}</h3><p>{text}</p></li>
              ))}
            </ul>
          </div>
          <a className="text-link" href="/privacy">Privacy notice →</a>
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

function NoDatabaseIcon() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <ellipse cx="12" cy="5.5" rx="7" ry="2.5" />
      <path d="M5 5.5v13c0 1.4 3.1 2.5 7 2.5s7-1.1 7-2.5v-13M5 12c0 1.4 3.1 2.5 7 2.5s7-1.1 7-2.5M3 3l18 18" />
    </svg>
  );
}

function ShieldIcon() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 3l7 3v5.5c0 4.3-2.9 7.9-7 9.5-4.1-1.6-7-5.2-7-9.5V6z" />
      <circle cx="12" cy="10.5" r="1.8" />
      <path d="M12 12.3V15" />
    </svg>
  );
}

function EyeOffIcon() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z" />
      <circle cx="12" cy="12" r="2.8" />
      <path d="M4 4l16 16" />
    </svg>
  );
}
