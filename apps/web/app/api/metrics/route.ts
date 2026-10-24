import { timingSafeEqual } from 'node:crypto';
import { metrics } from '@/lib/server/metrics';
import { clientKey, rateLimited } from '@/lib/server/rateLimit';

export const dynamic = 'force-dynamic';

/**
 * This instance's own measurements (metrics.ts), for the operator: `Authorization: Bearer
 * <ORIENTIM_METRICS_TOKEN>`. Durations and counts only, but they show how loaded the server is, so
 * they are not public: without the token set, this route does not exist.
 */
export function GET(req: Request) {
  const token = process.env.ORIENTIM_METRICS_TOKEN?.trim() ?? '';
  if (token.length < 32) return new Response('Not found', { status: 404 });
  if (rateLimited(`metrics:${clientKey(req)}`, 30)) return Response.json({ error: 'Too many requests' }, { status: 429 });
  const given = Buffer.from(req.headers.get('authorization')?.replace(/^Bearer\s+/i, '') ?? '');
  const wanted = Buffer.from(token);
  if (given.length !== wanted.length || !timingSafeEqual(given, wanted)) return new Response('Not found', { status: 404 });
  return Response.json(metrics(), { headers: { 'cache-control': 'no-store' } });
}
