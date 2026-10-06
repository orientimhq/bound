import { keyChallenge } from '@/lib/server/agent/access';
import { accessDeps, notEnabled } from '@/lib/server/agent/config';

export const dynamic = 'force-dynamic';
// The wallet's balance is read from the RPC, which may take its full timeout.
export const maxDuration = 30;

/** The message a wallet signs to get an API key (AGENT-API.md, "API access"). */
export function GET(req: Request) {
  const deps = accessDeps();
  return deps ? keyChallenge(req, deps) : notEnabled();
}
