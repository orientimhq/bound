import { connection } from 'next/server';
import { InfoPage } from '@/components/site/InfoPage';
import { FEE_BPS, TREASURY } from '@/lib/client/config';
import { LEGAL, legal, legalDraft } from '@/lib/legal';
import { signPageChunks } from '@/lib/server/scriptIntegrity';

export const metadata = { title: 'Terms of Use — Orientim', description: 'The terms for using Orientim, and the risks that remain.' };

/** The fee this build charges, as the other pages state it. */
const feeText = `${(Number(FEE_BPS) / 100).toLocaleString('en-US', { maximumFractionDigits: 2 })}%`;
/** Disputes go to arbitration or to courts, as the operator's details say (lib/legal.ts); the Terms say the same in both places. */
const byArbitration = /arbitrat/i.test(LEGAL.disputeForum);

/** The risks that remain, in plain words: what the protection does not change (README, SECURITY.md). */
const RISKS: [string, string][] = [
  ['Price and token value', 'Digital assets are highly volatile and can lose all their value at any time; new tokens often do. Orientim does not guarantee the price or the value of any asset.'],
  ['What a token’s issuer can do', 'Some issuers can freeze balances, mint more, charge on transfer, or move tokens. Orientim may warn you before the swap; it cannot change what a token can do.'],
  ['Software, including Orientim’s', 'Programs, markets, the Solana network, RPC providers, wallets and the Services themselves may contain errors or vulnerabilities, may be attacked, or may behave unexpectedly. This may cause the loss of some or all of the assets involved.'],
  ['The network', 'A transaction can be delayed, fail, expire, or land later than expected. One that does not execute moves nothing but may still cost its network fee.'],
  ['An outcome not yet known', 'While the network has not confirmed a transaction, it may still land. The skill starts no new swap from the same wallet until it knows the outcome, as long as it keeps its state directory; another copy without it does not know about it.'],
  ['Your wallet and device', 'A compromised wallet, machine, key or seed phrase, or malicious software where your agent runs, can lead to loss. Orientim will never ask for your seed phrase. Give your agent a wallet holding only what it may swap, and keep its signing key where the agent cannot read it.'],
  ['Impostor sites and copies', 'Open Orientim only at orientim.com, and get the Software only from orientim.com, github.com/orientimhq/orientim-protected-swap or the npm package @orientimhq/swap (formerly orientim-mcp). A copy elsewhere is not Orientim and may steal your funds.'],
  ['Law and taxes', 'Laws on digital assets differ by country and change, and may affect your use of the Services or the value of your assets. You are responsible for those that apply to you, and for your taxes.'],
];

export default async function Page() {
  signPageChunks('terms/page');
  await connection();
  const entity = legal('entity');
  return (
    <InfoPage
      eyebrow="Terms"
      title="Terms of Use"
      updated={LEGAL.lastUpdated}
      draft={legalDraft}
      lead={`These terms are a binding agreement between you and Orientim's operator. They limit our liability and require disputes to be resolved individually, ${byArbitration ? 'by arbitration' : 'before the courts named in section 18'}, except where the mandatory law of your country gives you other rights. Please read them carefully.`}
    >
      <section id="agreement">
        <h2>1. The agreement</h2>
        <p>
          These Terms of Use (the <strong>Terms</strong>) are an agreement between you and <strong>{entity}</strong>,{' '}
          {LEGAL.operator === 'company'
            ? <>{legal('registration')}, registered in {legal('country')}, with its registered office at {legal('address')}{' '}</>
            : <>who operates Orientim in their own name, resident in {legal('country')}, at {legal('address')}{' '}</>}
          (<strong>Orientim</strong>, <strong>we</strong>, <strong>us</strong>). They govern your use of orientim.com, the
          Orientim API (the <strong>API</strong>), the downloadable agent skill, command line, verifier and
          example code (the <strong>Software</strong>), and any related service we provide (together, the <strong>Services</strong>).
        </p>
        <p>
          By using the Services, connecting a wallet, requesting an API key, downloading the Software or signing a transaction
          prepared through the Services, you accept these Terms and our <a href="/privacy">Privacy Notice</a>. If you do not agree,
          do not use the Services. If you use them for a company or other entity, or through an agent or a bot, you confirm that
          you may bind it; &ldquo;you&rdquo; then includes it, and you are responsible for everything your agent or bot does.
        </p>
      </section>

      <section id="eligibility">
        <h2>2. Who may use Orientim</h2>
        <p>You may use the Services only if:</p>
        <ul>
          <li>you are at least 18 years old and may lawfully enter into these Terms;</li>
          <li>
            you are not, and do not act for or on behalf of, a person who is the target of sanctions of the United Nations, the
            European Union, the United Kingdom, the United States, {legal('country')} or any other relevant authority
            (<strong>Sanctions</strong>), or listed on a Sanctions list;
          </li>
          <li>
            you are not located, organised or resident in a territory subject to comprehensive Sanctions; and
          </li>
          <li>no law that applies to you prohibits your use of the Services.</li>
        </ul>
        <p>
          You will not use a VPN or any other means to get around these restrictions. We may restrict access from any territory
          and refuse or end access at any time if we reasonably believe you do not meet this section.
        </p>
      </section>

      <section id="service">
        <h2>3. What Orientim is, and what it is not</h2>
        <p>
          <strong>Non-custodial software.</strong> Orientim builds a Solana swap transaction, checks it against published rules
          and, only after your wallet has signed it, adds the signature of a one-time key and sends it to the Solana network, or
          returns it to your agent to send, when it asks.
          Swaps are executed by the Solana network and by third-party programs and markets, including those routed through
          Jupiter, which we do not own, operate or control.
        </p>
        <p>
          <strong>We never hold your assets or keys.</strong> At no time do we take custody or control of your digital assets,
          private keys or seed phrase. Every transaction executes only if your wallet signs it. We cannot reverse, cancel or
          freeze a transaction, or recover assets.
        </p>
        <p>
          <strong>We are not an exchange, broker, dealer, custodian, money transmitter, adviser or fiduciary.</strong> We do not
          set prices, match orders or trade for you. Nothing on the Services is investment, financial, legal or tax advice, or a
          recommendation. No fiduciary relationship exists between you and us, and to the extent the law allows, any such duty is
          excluded.
        </p>
        <p>
          <strong>Your decision.</strong> You alone decide whether to swap, which assets, how much, and on what terms, including
          the minimum you accept and your slippage tolerance, and you, or the check your agent runs, review every transaction before it is signed.
        </p>
      </section>

      <section id="protection">
        <h2>4. The protection, and its limits</h2>
        <p>
          The Services are designed so that, in a transaction they prepare, the swap programs can reach only the amount you
          approve (and a market&apos;s one-time account deposit when one is stated first), through a one-time key, and the transaction reverts if less than the minimum you accepted would arrive. How
          this works, and what it does not cover, is described on <a href="/security">Security</a>.
        </p>
        <p>
          <strong>
            This protection is a technical measure, not a guarantee, insurance or promise of any outcome. Software can contain
            errors, and the rules, the Software or their implementation may not work as intended in every case. We do not
            guarantee that any transaction will be protected, will execute, or will execute at any price, or that you will not
            suffer a loss.
          </strong>
        </p>
        <p>
          It does not cover, among other things: the price, value or legitimacy of any asset; what a token&apos;s issuer does; a
          compromised wallet, key, seed phrase or device; a copy of the website anywhere but orientim.com; and a transaction the
          Services did not prepare, or that you or your wallet changed.
        </p>
      </section>

      <section id="responsibilities">
        <h2>5. Your responsibilities</h2>
        <ul>
          <li>You are responsible for the security of your wallet, keys, seed phrase, devices, API keys, and any agent, bot or signing service you use.</li>
          <li>You open Orientim&apos;s website only at orientim.com, get the Software only from orientim.com, its GitHub repository or the npm package <code>@orientimhq/swap</code> (formerly <code>orientim-mcp</code>), and you or the check your agent runs read every transaction before it is signed.</li>
          <li>
            Where you use the API or the Software, you run the check the Software provides, on your own RPC, before you sign. If you
            skip or change it, you rely on the transaction as our servers prepared it, at your own risk.
          </li>
          <li>You are responsible for your taxes and for complying with the laws that apply to you.</li>
          <li>The assets you use are lawfully yours, or you are authorised to use them, and do not come from unlawful activity.</li>
        </ul>
      </section>

      <section id="fees">
        <h2>6. Fees</h2>
        <p>
          Orientim charges a fee of {TREASURY ? feeText : 'the percentage shown before you sign'} of the swap, included in and
          collected through the transaction you sign: of the amount in when it is taken from the input, of the enforced minimum
          when it is taken from the output, and of the swap&apos;s value in SOL when it is paid in SOL from your wallet. The fee, the network fee and any charge of a market or token are shown before
          you sign; see <a href="/security#fees">fees</a>. We may change the fee for future transactions; the fee that applies is
          the one in the transaction you sign.
        </p>
        <p>
          Fees are collected on chain when the transaction executes and are <strong>non-refundable</strong>. A transaction that does
          not execute may still cost its network fee, which is paid to the Solana network, not to us.
        </p>
      </section>

      <section id="third-parties">
        <h2>7. Third-party services</h2>
        <p>
          The Services depend on third parties, including the Solana network, Jupiter and the markets it routes through, token
          issuers, RPC and hosting providers, and wallets. We do not control them and are not responsible for their availability,
          security or conduct, or for any loss they cause. Their own terms may apply to you.
        </p>
      </section>

      <section id="prohibited">
        <h2>8. What you may not do</h2>
        <p>You will not, and will not let anyone, including your agent or bot:</p>
        <ul>
          <li>use the Services in breach of any law or Sanctions, or to finance, launder or hide the proceeds of unlawful activity;</li>
          <li>use the Services for a person described in section 2;</li>
          <li>attack, overload, probe or disrupt the Services or their users, or get around a rate limit, fee or security measure;</li>
          <li>copy, mirror, frame or impersonate the Services or Orientim, or run anything that could be confused with Orientim;</li>
          <li>use the Services to manipulate a market, including wash trading or spoofing; or</li>
          <li>resell or offer the API or the Services to others as your own service without our written permission.</li>
        </ul>
      </section>

      <section id="developers">
        <h2>9. Developers, agents and bots</h2>
        <ul>
          <li>An API key is bound to the wallet that signed for it, works for that wallet only, and expires after 90 days. You are responsible for every use of your keys.</li>
          <li>We may set and change rate limits, and suspend, revoke or refuse any key at any time, with or without notice.</li>
          <li>The API has no uptime, support or service-level commitment, and we may change or discontinue any part of it.</li>
          <li>
            You are responsible for your agent or bot: its instructions and limits, how it keeps keys and records, what it signs, and
            every transaction it makes. We are not responsible for any decision, error or loss of an agent, a bot or an AI model.
          </li>
        </ul>
      </section>

      <section id="software">
        <h2>10. The Software</h2>
        <p>
          The Software is open source, under the Apache License, Version 2.0. The licence is in the <code>LICENSE</code> file of
          the download and of its source repository (<a href="https://github.com/orientimhq/orientim-protected-swap">github.com/orientimhq/orientim-protected-swap</a>), and it governs your use of the Software itself: you may use, copy, modify
          and share it under its terms. The licence gives no right to the name &ldquo;Orientim&rdquo; or its logo (see the{' '}
          <code>NOTICE</code> file of the repository), and a changed copy must not be presented as Orientim&rsquo;s. Using the Software with the
          Services is governed by these Terms.{' '}
          <strong>The Software is provided as is (section 14);</strong> you are responsible for reviewing and testing it before
          you rely on it.
        </p>
      </section>

      <section id="ip">
        <h2>11. Intellectual property</h2>
        <p>
          The Services, the Software, the name &ldquo;Orientim&rdquo;, the logo and the content of orientim.com belong to Orientim
          or its licensors. Apart from the Software&rsquo;s licence (section 10), these Terms give you no right in them. If you send us feedback,
          we may use it freely.
        </p>
      </section>

      <section id="availability">
        <h2>12. Availability and pauses</h2>
        <p>
          We may change, pause, suspend or discontinue all or part of the Services at any time, for any reason, including security,
          with or without notice. While swaps are paused, no new swap starts; a transaction already sent is settled by the Solana
          network. We are not liable for any unavailability, or for a transaction you could not make because of it.
        </p>
      </section>

      <section id="risks">
        <h2>13. Risks</h2>
        <p>
          Orientim is built to remove one risk: that a swap takes more of your wallet than you approved. These remain, and{' '}
          <strong>you use the Services at your own risk.</strong>
        </p>
        <ul>{RISKS.map(([name, text]) => <li key={name}><strong>{name}.</strong> {text}</li>)}</ul>
      </section>

      <section id="warranties">
        <h2>14. No warranties</h2>
        <p>
          <strong>
            To the fullest extent the law allows, the Services and the Software are provided &ldquo;as is&rdquo; and &ldquo;as
            available&rdquo;, with all faults and without warranty of any kind,
          </strong>{' '}
          express, implied or statutory, including any warranty of merchantability, fitness for a particular purpose, title,
          non-infringement or accuracy. We do not warrant that the Services or the Software will be uninterrupted, secure or free of
          errors, that any error will be corrected, that any transaction will be protected, executed or executed at any price, or
          that any quote, estimate, warning or verification result is accurate or complete.
        </p>
      </section>

      <section id="liability">
        <h2>15. Limitation of liability</h2>
        <p>
          <strong>
            To the fullest extent the law allows, Orientim, its affiliates and their directors, officers, employees and contractors
            (the Orientim Parties) are not liable for any indirect, incidental, special, consequential or punitive damages, or for
            any loss of profits, revenue, opportunity, data, or digital assets or their value,
          </strong>{' '}
          arising from the Services, the Software or these Terms, under any theory of liability, even if advised of the
          possibility.
        </p>
        <p>
          This includes, to the fullest extent the law allows, any loss caused by: an error, bug, vulnerability or failure of the
          Services or the Software, including the transaction builder, the verifier and its rules; a third-party service; market
          movements, price or slippage; a transaction you or your agent signed; unauthorised access to your wallet, device or keys;
          or any pause or unavailability.
        </p>
        <p>
          <strong>
            The Orientim Parties&apos; total liability for all claims is limited to the greater of the fees you paid to Orientim in the
            12 months before the event that gave rise to the first claim, and US${LEGAL.liabilityCapUsd}.
          </strong>
        </p>
        <p>
          Nothing in these Terms excludes or limits liability that the law does not allow to be excluded or limited, such as for
          fraud, or rights you have as a consumer under the mandatory law of your country of residence. There, our liability is
          limited to the smallest extent the law permits. These limits are an essential part of the agreement and are reflected in
          the fee.
        </p>
      </section>

      <section id="indemnity">
        <h2>16. Indemnity and release</h2>
        <p>
          To the extent the law allows, you will defend, indemnify and hold harmless the Orientim Parties against any claim, loss,
          liability and cost, including reasonable legal fees, arising from your use of the Services or the Software or that of
          your agent or bot, your breach of these Terms, of any law or of Sanctions, or any transaction you or your agent signed.
          You release the Orientim Parties from any claim arising from a dispute between you and a third party, such as a token
          issuer or a market, in connection with the Services.
        </p>
      </section>

      <section id="termination">
        <h2>17. Suspension and termination</h2>
        <p>
          We may suspend or end your access to all or part of the Services, revoke API keys or refuse any request, at any time and
          without liability, including if we reasonably believe you breached these Terms or that it is needed for security or by
          law. You may stop using the Services at any time. Sections 3 to 6, 10 and 13 to 20 survive.
        </p>
      </section>

      <section id="disputes">
        <h2>18. Governing law and disputes</h2>
        <p>
          These Terms and any dispute about them or the Services are governed by the laws of {legal('governingLaw')}, without regard to
          its conflict-of-laws rules. Before starting any proceeding, you agree to write to us at {legal('legalEmail')} and try in good
          faith to resolve the dispute for at least 30 days.
        </p>
        <p>
          {byArbitration
            ? <>A dispute not resolved that way will be finally resolved by {legal('disputeForum')}, seated in {legal('disputeSeat')}, in English, by a sole arbitrator.</>
            : <>A dispute not resolved that way will be resolved by {legal('disputeForum')}, sitting in {legal('disputeSeat')}.</>}{' '}
          To the extent the law allows, claims may be brought only
          individually, not in any class or representative proceeding, and any claim must be brought within one year after it
          arose. If you are a consumer, nothing in this section takes away a right the mandatory law of your country of residence
          gives you to bring proceedings in its courts or to rely on its law.
        </p>
      </section>

      <section id="changes">
        <h2>19. Changes</h2>
        <p>
          We may change these Terms. The version in force is the one on this page, with the date at the top. Material changes take
          effect seven days after they are published here, except those required by law or for security, which take effect at
          once. By using the Services after a change takes effect, you accept it.
        </p>
      </section>

      <section id="general">
        <h2>20. General</h2>
        <p>
          These Terms and the Privacy Notice are the whole agreement between you and us about the Services. If a provision is held
          unenforceable, it is limited to the minimum extent and the rest remains in force. Not enforcing a provision is not a waiver
          of it. You may not transfer these Terms without our written consent; we may transfer them, including to an affiliate or a
          successor. We are not liable for failures caused by events beyond our reasonable control, including failures of the
          Solana network or of third-party services. If these Terms are translated, the English version prevails.
        </p>
      </section>

      <section id="contact">
        <h2>21. Contact</h2>
        <p>
          {entity}, {legal('address')}. Support: {legal('supportEmail')}. Legal notices: {legal('legalEmail')}. Security reports:{' '}
          {legal('securityEmail')}. The only official website is orientim.com.
        </p>
      </section>
    </InfoPage>
  );
}
