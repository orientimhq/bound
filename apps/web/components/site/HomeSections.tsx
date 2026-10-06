import { AgentTerminal, CapsuleFlow, CheckedTwice } from './Motion';

const CAPSULE_STEPS = [
  ['Your agent chooses the amount.', 'Only what it approves leaves the wallet: the amount, the fees and any market deposit it was shown. The rest of the wallet is never part of the swap.'],
  ['Only that amount goes into the swap.', 'Orientim finds a route across Solana’s markets and trades just that amount, never the wallet.'],
  ['At least the minimum, or nothing happens.', 'Your agent sets its own minimum before it signs. If less would arrive, the whole swap cancels and nothing is traded; at most the small network fee is paid.'],
];

const AGENT_POINTS = [
  ['Checks before signing', 'With the skill or command line, the exact transaction is checked on your own connection to Solana. Direct API integrations must run the same check.'],
  ['Limits you set', 'Set an amount per swap, a daily budget and the most slippage a swap may take in the owner’s policy, and your own price floor and fee ceiling per swap. Keep unattended limits at the signer.'],
  ['Recovers an interrupted order', 'The skill keeps an order record across restarts and settles what was in flight before anything new, so an unattended bot that keeps its state directory and one order id per decision never swaps an order twice. Direct bots need durable, shared order records.'],
  ['Works with your stack', 'For coding agents, a skill that checks every swap and asks before a worse price. For bots in any language, a command line: JSON in, JSON out, clear exit codes. Keep the signing key outside the agent.'],
];

/** How an agent starts: the key, the skill, the first swap (the developer page has each in full). */
const START_STEPS = [
  ['Get an API key', 'Sign Orientim’s message with the wallet your agent swaps from, from the skill’s command line or a browser wallet. The wallet needs 0.01 SOL; the key comes at once and lasts 90 days; signing moves nothing.'],
  ['Download the skill', 'Instructions for your agent, a working example, a command line for bots, and the verifier that checks every swap.'],
  ['Ask for a swap', 'Tell your agent: “swap 5 USDC to SOL with Orientim”. It checks the transaction on its own RPC, then signs.'],
];


const THREATS: [string, string, string][] = [
  ['prompt', 'A message tells your agent to “swap everything” or “set slippage to 15%”.', 'With your policy file set, the skill stops at your limits: the most per swap, per day, only from the tokens you allow, and never more slippage than you set.'],
  ['drain', 'A server hands your agent a transaction that drains the wallet.', 'With the skill or verifier, every instruction is checked on your own RPC. Approvals, authority changes and stray transfers are refused.'],
  ['server', 'The swap server itself is hacked.', 'Orientim holds none of your keys. With the skill or verifier, a changed transaction is refused before it is signed.'],
  ['sandwich', 'A bot sandwiches the trade.', 'The minimum is enforced on chain: the most it can take is your tolerance below the quoted price, 0.5% by default (3% on a Pump.fun launch curve), never above the ceiling you set. A swap that would fill below it reverts; only the network fee is paid.'],
  ['token', 'A token built to trap you.', 'Tokens whose extensions Orientim can’t isolate are refused before anything is signed, with the reason. Powers the issuer keeps, such as a freeze authority (USDC and USDT have one), are shown before your agent signs, not removed.'],
  ['crash', 'The agent crashes mid-swap and tries again.', 'The skill keeps every order by id: after a restart it settles what was in flight and, as long as its state directory survives, never swaps it twice.'],
];

const KEEPS_NOTHING = [
  [NoDatabaseIcon, 'No account. No database.', 'No sign-up and no database: Orientim stores no API keys and no list of your swaps. Each swap request leaves a few log lines at our host, with your wallet address and the outcome, never a key or a transaction, deleted after a set time.'],
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
            <p className="hero-sub">Orientim isolates the amount being traded. With the skill or verifier and a signer you control, each transaction is checked against your limits before it is signed.</p>
            <div className="cta-actions hero-actions">
              <a className="button primary-link" href="/developers#access">Get an API key</a>
              <a className="button ghost-link" href="/developers#start">Quickstart</a>
            </div>
          </div>
          <div className="hero-app">
            <AgentTerminal />
          </div>
        </div>
      </section>

      {/* The one line under the hero: how every swap is protected. */}
      <section className="proof-strip" aria-label="How every swap is protected">
        <div className="container proof-row">
          <p className="one-key">
            <LockIcon />
            <strong>Your trade gets its own wallet. Your wallet never becomes the trade.</strong>
          </p>
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
                <a className="button primary-link" href="/developers#access">Get an API key</a>
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
              The attacks that have emptied trading agents and bots, and what happens when the swap goes through Orientim. These are
              the checks made before your agent signs; what they cannot cover, such as the market itself, is in the{' '}
              <a href="/terms#risks">risks</a> of the Terms.
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
  "maxSlippageBps": 300`}<span className="dim">{`          // never more than 3%`}</span>{`
}`}{'\n\n'}<span className="dim">{`# the agent is told to swap 500 USDC`}</span>{'\n'}<span className="ok">{`✓ refused: over your limit of 50 USDC a swap`}</span>{'\n'}<span className="dim">{`# the agent is told to set slippage to 15%`}</span>{'\n'}<span className="ok">{`✓ refused: above your limit of 3%`}</span></pre>
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

function LockIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="4.5" y="10.5" width="15" height="10.5" rx="2.5" />
      <path d="M8 10.5V7.5a4 4 0 0 1 8 0v3M12 14.5v2.5" />
    </svg>
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
