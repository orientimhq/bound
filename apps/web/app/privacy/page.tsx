import { connection } from 'next/server';
import { InfoPage } from '@/components/site/InfoPage';
import { LEGAL, legal, legalDraft } from '@/lib/legal';
import { signPageChunks } from '@/lib/server/scriptIntegrity';

/** The data protection authority of the operator's country (LEGAL.country). */
const AUTHORITY: Record<string, string> = {
  'North Macedonia': 'the Personal Data Protection Agency',
  Albania: 'the Information and Data Protection Commissioner',
};

export const metadata = { title: 'Privacy Notice — Orientim', description: 'What Orientim processes, why, who receives it, and your rights.' };

/** What passes through Orientim, as the code does it (lib/server, lib/client), and on which basis. */
const PROCESSING: [string, string, string][] = [
  [
    'Your public wallet address, and your account for the token you receive',
    'To read the chain for you, and to build, check and send the swap you ask for; to issue an API key bound to your wallet.',
    'Providing the service you request',
  ],
  ['The swap: tokens, amounts, your minimum, and the transaction you signed', 'The same.', 'Providing the service you request'],
  ['Your IP address', 'To limit how often requests can be made, by our servers in memory and by our hosting provider\'s firewall, and to protect the service from abuse.', 'Our legitimate interest in security'],
  [
    'Logs kept by our hosting provider: for each request, its time, the address requested (which can name a wallet or a token account), IP address and browser type; for each swap request, a few lines that together name the wallet the API key belongs to, the outcome (its error code, why a check refused it, with every address removed), which routes built it, the side of the fee and how long it took; and, when our servers fail, the error',
    'Running, securing and troubleshooting the service, and counting errors and delays.',
    'Our legitimate interest in security',
  ],
  ['For an API key: the message your wallet signed, and its SOL balance', 'To check that you control the wallet and that it meets the minimum balance. Neither is kept.', 'Providing the service you request'],
  ['What you write to us', 'To answer you.', 'Our legitimate interest, or providing the service'],
];

const RECIPIENTS: [string, string, string][] = [
  ['Vercel Inc.', 'Hosting; keeps the request logs', 'United States'],
  ['Helius', 'Solana RPC provider: chain reads, simulations and your signed transaction, which include your wallet address', 'United States'],
  ['Alchemy', 'Backup Solana RPC provider, asked only when Helius does not answer: the same data', 'United States'],
  ['Jupiter', 'Building the route, or pricing the swap when your agent brings its own routes: the tokens, the amount and, for a route, your receiving token account', 'Outside the EU'],
  ['The Solana network', 'Executes your signed transaction, which becomes public', 'Global and public'],
];

export default async function Page() {
  signPageChunks('privacy/page');
  await connection();
  return (
    <InfoPage
      eyebrow="Privacy"
      title="Privacy Notice"
      updated={LEGAL.lastUpdated}
      draft={legalDraft}
      lead="Orientim has no accounts, no database of users, no cookies, no analytics and no advertising trackers. It processes as little as a swap needs."
    >
      <section id="controller">
        <h2>1. Who is responsible</h2>
        <p>
          The controller of your personal data is <strong>{legal('entity')}</strong>, {legal('address')}. For anything about your
          data, write to {legal('privacyEmail')}.
        </p>
      </section>

      <section id="data">
        <h2>2. What we process, why, and on which basis</h2>
        <div className="table-wrap">
          <table>
            <thead><tr><th>Data</th><th>Why</th><th>Legal basis</th></tr></thead>
            <tbody>{PROCESSING.map(([data, why, basis]) => <tr key={data}><td>{data}</td><td>{why}</td><td>{basis}</td></tr>)}</tbody>
          </table>
        </div>
        <p>
          We do not collect your name, email address (unless you write to us), identity documents, private keys or seed phrase. We keep
          no database of your swaps and no list of the API keys we issue: a key itself carries its wallet address and expiry,
          sealed so that only Orientim can verify it. The log lines above are the only record of a swap request, and they are
          deleted after the retention period below. They never contain your private key or your API key. We do not sell your data, use it for advertising, or profile you.
          When Orientim refuses a swap, for example an unsafe token, that is a technical rule about the transaction, not a decision
          about you.
        </p>
      </section>

      <section id="browser">
        <h2>3. Nothing in your browser</h2>
        <p>
          This site sets no cookies and keeps nothing in your browser&apos;s storage. The skill keeps its own records, such as the
          swaps in flight and its order book, on the machine where your agent runs, never on our servers.
        </p>
      </section>

      <section id="recipients">
        <h2>4. Who receives it</h2>
        <p>We share personal data only as the service needs it, with:</p>
        <div className="table-wrap">
          <table>
            <thead><tr><th>Recipient</th><th>What for</th><th>Where</th></tr></thead>
            <tbody>{RECIPIENTS.map(([who, what, where]) => <tr key={who}><td>{who}</td><td>{what}</td><td>{where}</td></tr>)}</tbody>
          </table>
        </div>
        <p>
          We may disclose data where the law, a court or a competent authority requires it, or to protect the rights and security of Orientim, its
          users or others.
        </p>
      </section>

      <section id="transfers">
        <h2>5. Transfers outside your country</h2>
        <p>
          Some recipients are outside {LEGAL.country} and the European Economic Area, including in the United States. Where the law requires
          it, transfers rely on an adequacy decision, including the EU–US Data Privacy Framework for certified recipients, or on the
          European Commission&apos;s standard contractual clauses. Write to us for a copy of the safeguards.
        </p>
      </section>

      <section id="retention">
        <h2>6. How long</h2>
        <ul>
          <li>Rate-limit counts: in memory, and at our hosting provider&apos;s firewall, for at most an hour.</li>
          <li>Request logs and swap log lines at our hosting provider: up to {legal('logRetentionDays')} days, then deleted.</li>
          <li>What you write to us: as long as needed to answer you, and up to 12 months after.</li>
        </ul>
      </section>

      <section id="public">
        <h2>7. What is public by nature</h2>
        <p>
          Every Solana transaction, including your swaps and your wallet address, is public and permanent on the blockchain and can be
          read by anyone. No one, including us, can change or delete it. The rights below apply to the data we hold, not to the
          blockchain.
        </p>
      </section>

      <section id="rights">
        <h2>8. Your rights</h2>
        <p>
          You have the right to access your personal data, to have it corrected or erased, to restrict or object to its processing
          (including processing based on our legitimate interest), and to data portability. Because we hold almost nothing about
          you and cannot identify you from a wallet address alone, we may ask you to show that you control the wallet concerned.
          Write to {legal('privacyEmail')}; we answer within one month.
        </p>
        <p>
          You may also complain to a data protection authority: in {LEGAL.country}, {AUTHORITY[LEGAL.country] ?? 'its data protection authority'}; in the
          European Union, the authority of the country where you live.
        </p>
      </section>

      <section id="security">
        <h2>9. Security</h2>
        <p>
          Connections are encrypted, the pages run under a strict content security policy, there is no database of users, and
          rate-limit counts are kept only for as long as they limit anything. No system is fully secure; see the <a href="/terms#risks">risks</a>.
        </p>
      </section>

      <section id="children">
        <h2>10. Children</h2>
        <p>Orientim is not for anyone under 18, and we do not knowingly process children&apos;s data.</p>
      </section>

      <section id="changes">
        <h2>11. Changes</h2>
        <p>This notice may change. The version in force is the one on this page, with the date at the top.</p>
      </section>

      <section id="contact">
        <h2>12. Contact</h2>
        <p>{legal('entity')}, {legal('address')}. Privacy: {legal('privacyEmail')}.</p>
      </section>
    </InfoPage>
  );
}
