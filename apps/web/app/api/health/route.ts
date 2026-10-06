import { recentHealth } from '@/lib/server/health';
import { clientKey, rateLimited } from '@/lib/server/rateLimit';

export const dynamic = 'force-dynamic';
// Two rounds of upstream checks, each bounded at 5 s, with room to answer.
export const maxDuration = 30;

/** 200 when a swap could go through now, 503 when the RPC or Jupiter does not answer or the agent API is off. For uptime monitors. */
export async function GET(req: Request) {
  // The RPC and Jupiter are asked at most every 15 seconds, whoever calls (recentHealth).
  if (rateLimited(`health:${clientKey(req)}`, 30)) return Response.json({ error: 'Too many requests' }, { status: 429 });
  const health = await recentHealth();
  return Response.json(health, { status: health.ok ? 200 : 503, headers: { 'cache-control': 'no-store' } });
}
