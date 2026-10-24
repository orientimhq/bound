import { connection } from 'next/server';
import { InfoPage } from '@/components/site/InfoPage';
import { swapState, type SwapState } from '@/lib/server/health';
import { signPageChunks } from '@/lib/server/scriptIntegrity';

export const metadata = { title: 'Status — Orientim', description: 'Whether protected swaps are running right now.' };

const SHOWN: Record<SwapState, { title: string; row: string; className: string }> = {
  running: { title: 'Protected swaps are running', row: 'Running', className: 'status-ok' },
  degraded: {
    title: 'Protected swaps may fail right now',
    row: 'Degraded: new swaps may be refused for now. Your funds are not affected.',
    className: 'status-warn',
  },
  paused: { title: 'Protected swaps are paused', row: 'Paused: no new swaps start. Your funds are not affected.', className: 'status-bad' },
};

export default async function Page() {
  signPageChunks('status/page');
  await connection();
  const shown = SHOWN[await swapState()];
  return (
    <InfoPage eyebrow="Status" title={shown.title} lead="Whether new protected swaps can start right now, checked at most a minute ago.">
      <section>
        <div className="status-row">
          <span>Protected swaps</span>
          <span className={shown.className}>{shown.row}</span>
        </div>
        <p>
          When needed, we pause new swaps. A swap already sent is settled by the Solana network.
        </p>
      </section>
    </InfoPage>
  );
}
