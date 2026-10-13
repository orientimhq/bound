'use client';

import { useState } from 'react';
import type { Wallet } from '@wallet-standard/base';
import { isKeyMessage } from '@/lib/client/keyMessage';
import { connectWallet, signsMessages, useWallets, walletSignMessage } from '@/lib/client/wallets';

type Issued = { key: string; wallet: string; expiresAt: string };

/** A failure this page can explain in its own words; anything else is shown as a short, general message. */
class Said extends Error {}

/** What went wrong, in a sentence; `detail` is the raw error, kept for someone who wants it. */
type Failure = { text: string; detail?: string };

/** The skill as one download, public: its path on this site and its version. */
export type SkillDownload = { href: string; version: string };

/**
 * An API key at once: connect the wallet the agent swaps from, sign Orientim's message, and the key
 * appears, bound to that wallet (AGENT-API.md, "API access"), with what to do next. Signing moves nothing.
 */
export function GetApiKey({ skill }: { skill: SkillDownload }) {
  const wallets = useWallets().filter(signsMessages);
  const [choosing, setChoosing] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<Failure | null>(null);
  const [issued, setIssued] = useState<Issued | null>(null);
  const [copied, setCopied] = useState(false);

  async function get(wallet: Wallet) {
    setChoosing(false);
    setError(null);
    try {
      setBusy('Connecting…');
      const account = await connectWallet(wallet);
      if (!account) throw new Said('The wallet returned no account.');
      setBusy('Preparing the message…');
      const c = await fetch(`/api/v1/keys/challenge?wallet=${encodeURIComponent(account.address)}`);
      // 404 is this deployment's API being off (not-enabled): before launch, or while it is paused.
      if (c.status === 404) throw new Said('API keys are not available on this site right now. Try again later.');
      const challenge = await c.json() as { message?: unknown; challenge?: string; error?: { message: string } };
      if (!c.ok) throw new Said(challenge.error?.message ?? 'Orientim could not prepare the message. Try again.');
      if (!isKeyMessage(challenge.message, window.location.host, account.address)) throw new Said('The message was not the expected one, so nothing was signed.');
      setBusy('Sign the message in your wallet…');
      const signature = await walletSignMessage(wallet, account, new TextEncoder().encode(challenge.message));
      setBusy('Getting your key…');
      const res = await fetch('/api/v1/keys', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ message: challenge.message, challenge: challenge.challenge, signature: btoa(String.fromCharCode(...signature)) }),
      });
      const body = await res.json() as Issued & { error?: { message: string } };
      if (!res.ok) throw new Said(body.error?.message ?? 'Orientim could not issue a key. Try again.');
      // A key for another wallet than the one that signed is not this wallet's key.
      if (body.wallet !== account.address) throw new Said('Orientim answered with a key for another wallet, so it is not shown. Try again.');
      setIssued(body);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      if (e instanceof Said) setError({ text: message });
      else if (/reject|denied|cancel|4001/i.test(message)) setError({ text: 'Cancelled in your wallet. Nothing was signed.' });
      // A network failure, a wallet's own error or an answer that is not JSON: said plainly, the detail kept.
      else setError({ text: 'Something went wrong, and no key was issued. Signing moves nothing. Try again.', detail: message });
    } finally {
      setBusy(null);
    }
  }

  function copy() {
    if (!issued) return;
    navigator.clipboard.writeText(issued.key).then(() => setCopied(true), () => setCopied(false));
  }

  if (issued) {
    return (
      <div className="key-box">
        <p><strong>Your API key.</strong> It is shown once.</p>
        <div className="codebox">
          <pre tabIndex={0}><code>{issued.key}</code></pre>
          <button className="copy-btn" onClick={copy}>{copied ? 'Copied' : 'Copy'}</button>
        </div>
        <p className="hint">
          It works for {issued.wallet.slice(0, 4)}…{issued.wallet.slice(-4)} only, until {new Date(issued.expiresAt).toLocaleDateString()}.
          Sign again for a new one at any time.
        </p>
        <p className="key-next-title">Next</p>
        <ol className="key-next">
          <li>Save it as <code>ORIENTIM_API_KEY</code> where your agent reads its settings.</li>
          <li>
            <a className="button primary-link" href={skill.href} download>Download the skill</a>
            <span className="hint">v{skill.version}: instructions for your agent, a working example, the command line and the verifier</span>
          </li>
          <li>
            Unzip it, run <code>npm ci</code>, and set <code>ORIENTIM_API_URL=https://orientim.com</code>, your own RPC as{' '}
            <code>SOLANA_RPC_URL</code> and your own Jupiter key as <code>JUPITER_API_KEY</code> (free at developers.jup.ag). Then follow{' '}
            <code>SKILL.md</code>.
          </li>
        </ol>
      </div>
    );
  }

  return (
    <div className="key-box">
      {choosing ? (
        wallets.length ? (
          <div className="key-wallets">
            {wallets.map(w => (
              <button key={w.name} className="wallet-option" onClick={() => get(w)}>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={w.icon} alt="" width={24} height={24} />
                {w.name}
              </button>
            ))}
            <button className="ghost key-cancel" onClick={() => setChoosing(false)}>Cancel</button>
          </div>
        ) : (
          <>
            <p className="hint">No wallet in this browser can sign a message. Use the Agent or bot wallet tab instead.</p>
            <button className="ghost key-cancel" onClick={() => setChoosing(false)}>Cancel</button>
          </>
        )
      ) : (
        <button className="button primary-link key-button" onClick={() => setChoosing(true)} disabled={busy !== null}>
          {busy ?? 'Get an API key'}
        </button>
      )}
      {!choosing && <p className="hint">By getting a key, you accept the <a href="/terms">Terms of Use</a> and the <a href="/privacy">Privacy Notice</a>.</p>}
      {/* Always in the page, so that a screen reader announces an error when it appears. */}
      <div aria-live="polite">
        {error && <p className="key-error">{error.text}</p>}
        {error?.detail && (
          <details className="key-detail">
            <summary>Details</summary>
            <code>{error.detail}</code>
          </details>
        )}
      </div>
    </div>
  );
}
