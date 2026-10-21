export const dynamic = 'force-dynamic';

/** The process is up and answers. For the host's own check (fly.toml); asks nothing of the RPC or Jupiter, unlike /api/health. */
export function GET() {
  return Response.json({ ok: true }, { headers: { 'cache-control': 'no-store' } });
}
