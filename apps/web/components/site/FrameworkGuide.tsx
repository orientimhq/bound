import type { ReactNode } from 'react';
import { InfoPage } from './InfoPage';

const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const SOL = 'So11111111111111111111111111111111111111112';

/**
 * A page per agent framework: the Orientim MCP server in that framework, with a working example. The
 * framework's own part is its install line, its code and a note on how it lets the server ask the
 * person; the rest (the limits, running it, unattended agents, where it runs) is the same for each.
 */
export function FrameworkGuide(props: { framework: string; install: string; code: string; asking: ReactNode }) {
  return (
    <InfoPage
      eyebrow="Developers · Guide"
      title={`Orientim in ${props.framework}`}
      lead={
        <>
          Give an agent built with {props.framework} protected Solana swaps. It gets the four tools of the Orientim MCP server,
          your limits hold, and nothing is signed until you say yes.
        </>
      }
    >
      <section id="need">
        <h2>What you need</h2>
        <ul>
          <li>Node 20.18 or later.</li>
          <li>
            A wallet for the agent alone, as a keypair file, holding only what it may trade and 0.01 SOL. The server gets its
            own <a href="/developers#access">API key</a> with it.
          </li>
          <li>Your own Solana RPC, and a key for your model (here Claude, through <code>ANTHROPIC_API_KEY</code>).</li>
        </ul>
        <pre tabIndex={0}><code>{props.install}</code></pre>
      </section>

      <section id="limits">
        <h2>1. Write your limits</h2>
        <p>
          A policy file the agent cannot edit. Here: at most 5 USDC a swap, and only SOL to buy. Every limit is in the 
          <a href="https://github.com/orientimhq/orientim-protected-swap/blob/main/skills/orientim-protected-swap/reference/GUIDE.md#setup">guide</a>.
        </p>
        <pre tabIndex={0}><code>{`{
  "maxAmountIn": { "${USDC}": "5000000" },
  "allowedOutputMints": ["${SOL}"]
}`}</code></pre>
      </section>

      <section id="agent">
        <h2>2. The agent</h2>
        <p>
          In <code>agent.ts</code>: the server starts with the agent and stops with it. Before the first swap of each quote it asks you, in your terminal;
          only a typed <code>yes</code> makes the swap.
        </p>
        <pre tabIndex={0}><code>{props.code}</code></pre>
        {props.asking}
      </section>

      <section id="run">
        <h2>3. Run it</h2>
        <p>First a quote: Orientim prices the swap and verifies it on your RPC. Nothing is signed.</p>
        <pre tabIndex={0}><code>{`export SOLANA_RPC_URL=<your own RPC>
export ANTHROPIC_API_KEY=...
npx tsx agent.ts "Show my wallet, then quote 1 USDC to SOL."`}</code></pre>
        <p>
          Then a swap. The server asks you first, with the amounts; answer <code>yes</code>, and the agent tells you what the
          swap did. Your policy enforces your limits before anything is signed.
        </p>
        <pre tabIndex={0}><code>{`npx tsx agent.ts "Swap 1 USDC to SOL."`}</code></pre>
      </section>

      <section id="unattended">
        <h2>Without a person at the keyboard</h2>
        <p>
          A bot that runs alone has no one to ask. Leave out the question, and the server swaps on the agent&apos;s word: then the
          policy file is all that stops it. Keep the file where the agent cannot change it, at{' '}
          <code>/etc/orientim/policy.json</code>, which is used whatever the environment says. The agent may ask for at most 3%
          slippage and 5% price impact; only you raise them.
        </p>
      </section>

      <section id="where">
        <h2>Where it runs</h2>
        <p>
          The server is a process beside your agent, with the wallet&apos;s key, on a machine or container you control. It keeps a
          record of each order in <code>ORIENTIM_STATE_DIR</code>, on a disk that outlives a restart. A serverless function, such as
          Vercel Functions, has neither. The assistant never sees the key, only the wallet&apos;s address and what each swap did.
        </p>
        <p>
          More: <a href="/developers#mcp">the MCP server</a>, its four tools and its settings, and{' '}
          <a href="/developers#verify">what the check before signing does</a>.
        </p>
      </section>
    </InfoPage>
  );
}
