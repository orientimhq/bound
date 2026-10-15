import { connection } from 'next/server';
import { InfoPage } from '@/components/site/InfoPage';
import { FEE_BPS, TREASURY } from '@/lib/client/config';
import { legal } from '@/lib/legal';
import { signPageChunks } from '@/lib/server/scriptIntegrity';

/** The fee this build charges, as the developer page states it. */
const feeText = `${(Number(FEE_BPS) / 100).toLocaleString('en-US', { maximumFractionDigits: 2 })}%`;

export const metadata = {
  title: 'Security — Orientim',
  description: 'What a protected swap enforces, what it does not, what it costs, and what it supports.',
};

const SUPPORTED: [string, string][] = [
  ['SOL and standard SPL tokens', 'Supported'],
  ['Token-2022 tokens with metadata, groups, close authority or confidential transfers', 'Supported'],
  ['Token-2022 tokens with a transfer tax', 'Supported; the tax is stated before your agent signs'],
  ['Stablecoins whose issuer can move balances with its own key (PYUSD, USDG, AUSD, CASH)', 'Supported, with a warning'],
  ['Pump.fun launch curve and PumpSwap routes', 'Supported when the route fits and passes verification'],
  ['Tokens whose issuer can move balances through a program, or with an active transfer hook, frozen by default, pausable, non-transferable, interest-bearing, requiring a memo, with a scaled UI amount, or with a Token-2022 extension Orientim has not reviewed', 'Not supported, with the reason'],
  ['Tokens whose issuer can freeze accounts or mint more (USDC and USDT among them)', 'Supported; shown to your agent before it signs'],
  ['A token account of your wallet that its issuer has frozen', 'Not supported, with the reason: the swap could not land'],
  ['Routes through a market that would leave an account open', 'Not supported'],
  ['Routes too large for one transaction', 'Not supported: Orientim never splits a swap'],
];

/** The verifier's seven rules (packages/verifier, verify.ts), in the words of the page. */
const RULES: [string, string, string][] = [
  ['R1', 'Your wallet stays out of reach', 'The swap program never receives your wallet, or any of its token accounts except the one that receives what you buy.'],
  ['R2', 'Only the instructions expected', 'Every instruction Orientim adds fills one expected place, with the exact accounts and amounts: the approved amount, the minimum checked on chain, the fee to the pinned treasury, the cleanup.'],
  ['R3', 'A new one-time key', 'The one-time key and its token accounts do not exist on chain yet, so nothing was prepared in them beforehand.'],
  ['R4', 'A capped network fee', 'The network fee your wallet pays, priority fee included, stays under a fixed maximum.'],
  ['R5', 'One transaction, nothing left open', 'One transaction within the size limit, each account loaded once, and every temporary account created and closed in it.'],
  ['R6', 'Only two signers', 'Your wallet pays the fee, and the only signers are your wallet and the one-time key.'],
  ['R7', 'Only tokens it can isolate', 'Both tokens, and any token the route passes through, are standard tokens or Token-2022 tokens without the features that would break the protection.'],
];

/**
 * What the product promises, in the words the owner of an agent needs, and no more than the code
 * enforces (README, SECURITY.md). A trust page for people who never read a repository.
 */
export default async function Page() {
  signPageChunks('security/page');
  // Rendered per request so that every response carries a fresh CSP nonce (proxy.ts).
  await connection();
  return (
    <InfoPage
      eyebrow="Security"
      title="How Orientim protects you"
      lead="A typical swap acts with the wallet's authority for the whole transaction. Orientim builds each swap so that the swap program never gets it: only the amount your agent approves is placed within its reach, under a one-time key that exists for this one transaction."
    >
      <nav className="sub-nav" aria-label="On this page">
        <a href="#how">How it is checked</a>
        <a href="#rules">The 7 rules</a>
        <a href="#supported">Supported tokens</a>
        <a href="#fees">Fees ({feeText})</a>
      </nav>

      <section id="how">
        <h2>What happens when your agent swaps</h2>
        <ol>
          <li>Your agent asks Orientim for a swap. Orientim finds a route across Solana&apos;s markets, builds one transaction around it and checks it against its rules.</li>
          <li>
            With the skill, the command line or the MCP server, the exact transaction is checked again on your own connection to Solana before signing.
            A direct API client must run the same independent check before handing bytes to its signer.
          </li>
          <li>Your agent&apos;s wallet signs first. Orientim then adds the one-time key&apos;s signature and sends it.</li>
          <li>The swap runs. If less than your agent&apos;s minimum would arrive, the whole transaction is cancelled.</li>
        </ol>
      </section>

      <section>
        <h2>What every protected swap enforces</h2>
        <ul>
          <li>The swap can spend only the amount your agent approves, plus a market&apos;s one-time account deposit when one is stated first.</li>
          <li>The wallet&apos;s other tokens, its NFTs and the rest of its SOL are never given to the swap program.</li>
          <li>No permission over your wallet is granted, and none outlives the transaction.</li>
          <li>The wallet receives at least the minimum, or nothing happens and only the network fee is paid.</li>
          <li>Orientim never holds your funds and never asks for your seed phrase.</li>
        </ul>
        <p>
          This describes how Orientim is designed. What is and is not guaranteed is set out in the <a href="/terms#protection">Terms</a>.
        </p>
      </section>

      <section id="rules">
        <h2>The 7 rules, checked before your wallet signs</h2>
        <p>
          The open-source verifier decodes the exact bytes your wallet will sign and checks them against seven rules, with
          every account read from your own RPC. Your wallet signs only a transaction that passes all seven.
        </p>
        <ol className="rules">
          {RULES.map(([id, name, text]) => (
            <li key={id}><span className="rule-id">{id}</span><div><h3>{name}</h3><p>{text}</p></div></li>
          ))}
        </ol>
        <p>
          The code is in <a href="https://github.com/orientimhq/orientim-protected-swap/tree/main/packages/verifier">packages/verifier</a>, under Apache-2.0.
        </p>
      </section>

      <section>
        <h2>Where the protection ends</h2>
        <ul>
          <li>It protects your wallet, not the price or the future value of the token you buy.</li>
          <li>
            Orientim swaps only tokens it can isolate, and names the reason for any other: those whose issuer can run code on
            every transfer or move balances through a program.
          </li>
          <li>It cannot stop an agent that can read the signing key from using it outside Orientim. For unattended funds, keep the key in a separate signer with its own limits and use a wallet funded only for the agent&apos;s job.</li>
          <li>
            Give your agent its own RPC, never Orientim&apos;s, and use the skill as published: check a download against its <a href="https://github.com/orientimhq/orientim-protected-swap/releases">GitHub release</a> (<code>gh attestation verify</code>), not against this site.
          </li>
        </ul>
      </section>

      <section id="fees">
        <h2>Fees</h2>
        <p>Every cost is in Orientim&apos;s answer, with the exact amounts, before your agent signs.</p>
        <div className="table-wrap">
          <table>
            <thead><tr><th>Cost</th><th>Amount</th><th>Who receives it</th></tr></thead>
            <tbody>
              <tr><td>Orientim fee</td><td>{TREASURY ? `${feeText} of the swap: of the amount in, when taken from the input; of the enforced minimum, when taken from the output; of the swap’s value in SOL, when paid in SOL from your wallet` : 'None'}</td><td>Orientim. Inside the transaction you sign: in SOL, USDC or USDT when the swap has one of them, otherwise in the input token or in SOL from your wallet.</td></tr>
              <tr><td>Network fee</td><td>Usually under 0.0001 SOL; with the skill, never more than 0.001 SOL</td><td>Solana&apos;s validators. The exact amount is stated before your agent signs.</td></tr>
              <tr><td>Market account fee</td><td>Only on some markets, such as a Pump.fun launch curve</td><td>The market. Stated before your agent signs, with what comes back.</td></tr>
              <tr><td>Token transfer tax</td><td>Only on tokens that tax transfers</td><td>The token&apos;s issuer. Stated before your agent signs.</td></tr>
            </tbody>
          </table>
        </div>
        <ul>
          <li>No fee for an API key, or for a swap your agent does not sign.</li>
          <li>A swap that does not run, because less than the minimum would arrive or its time ran out, costs at most the network fee.</li>
          <li>Swaps smaller than about 0.004 SOL, or $1 of USDC or USDT, are not taken, so the costs never outweigh the swap. Selling the whole balance of a token (not SOL) is allowed at any size.</li>
        </ul>
      </section>

      <section id="supported">
        <h2>Supported tokens and wallets</h2>
        <p>
          Most Solana tokens are supported. Orientim takes only the swaps it can protect, and says why when it cannot.
        </p>
        <div className="table-wrap">
          <table>
            <thead><tr><th>Kind</th><th>Answer</th></tr></thead>
            <tbody>{SUPPORTED.map(([kind, answer]) => <tr key={kind}><td>{kind}</td><td>{answer}</td></tr>)}</tbody>
          </table>
        </div>
        <ul>
          <li><strong>A key file or a signing service your agent controls</strong>: supported. A signing service keeps the key away from the agent.</li>
          <li><strong>For the API key</strong>: a browser wallet that can sign a message, such as Phantom, Solflare or Backpack, or the skill&apos;s command line.</li>
          <li><strong>Signers that can only sign and send at once, and multisig vaults</strong>: not supported, because the agent&apos;s wallet must sign first and Orientim last.</li>
        </ul>
      </section>

      <section id="report">
        <h2>Report a vulnerability</h2>
        <p>
          If you find a security problem in Orientim, write to {legal('securityEmail')} before telling anyone else, with enough detail to
          reproduce it. We answer, keep you informed while we fix it, and credit you if you wish.
        </p>
        <p>
          We will not take legal action against research done in good faith that avoids harm to users and their funds, does not access
          other people&apos;s data, does not disrupt the service, and gives us reasonable time to fix the problem before it is disclosed.
          Never test with other people&apos;s wallets or funds.
        </p>
      </section>
    </InfoPage>
  );
}
