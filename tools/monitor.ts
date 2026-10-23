/**
 * Is production up, on tested code, and pointing to a package npm says was built by its release? For a scheduled workflow
 * (`.github/workflows/monitor.yml`), which fails, so GitHub tells its owner, when:
 *
 *   - `/api/health` does not answer 200 with `ok` three times, 20 seconds apart (an outage, not a blip);
 *   - `/api/health` says, three times, that a service refuses the deployment's key (`refused`: a wrong key,
 *     a plan unpaid or out of credits), even while the backup RPC keeps swaps going;
 *   - the deployment says it was built from a commit that is not on `main`, or whose CI failed;
 *   - the version of @orientimhq/swap it names is not on npm with the release workflow's provenance.
 *
 * A pause by the kill switch (`paused`, or `/api/status` `enabled: false`) is said, not failed: it is
 * the operator's own decision. Production behind `main` is said too, with how far.
 *
 * A check that could not be made (`/api/status` not answering or naming no commit, GitHub not
 * answering, no finished CI run for the commit) is INCOMPLETE, not passed, and fails the run too: a
 * green run means that the version, its CI and the package named were all checked.
 *
 *   node tools/monitor.ts --site https://orientim.com [--repo owner/name]   (GH_TOKEN for the repository checks)
 */
import { createHash } from 'node:crypto';
import { appendFileSync } from 'node:fs';

type Health = { ok?: boolean; paused?: boolean; refused?: string[]; agentApi?: string; sharedState?: string; rpc?: { ok: boolean; ms: number }; rpcFallback?: { ok: boolean; ms: number } | null; jupiter?: { ok: boolean; ms: number }; agents?: { rpc: { ok: boolean; ms: number }; build: { ok: boolean; ms: number } } | null };
type Status = { enabled?: boolean; build?: string | null; skillVersion?: string };

function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : fallback;
}

const site = (arg('--site', process.env.ORIENTIM_SITE_URL) ?? 'https://orientim.com').replace(/\/+$/, '');
const repo = arg('--repo', process.env.GITHUB_REPOSITORY);
const token = process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN;
const tries = Number(arg('--tries', '3'));
const pauseMs = Number(arg('--pause-ms', '20000'));

const failures: string[] = [];
/** Checks that could not be made: not a failure of the site, and not a pass either. */
const incomplete: string[] = [];
const notices: string[] = [];
const rows: [string, string][] = [];
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
/**
 * A browser's user agent, as any visitor's: a deployment that served the monitor something other than
 * what it serves its users would otherwise be told which requests are the monitor's.
 */
const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';
const uaFor = (url: string) => (url.startsWith('https://api.github.com/') ? 'orientim-monitor' : BROWSER_UA);
const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

/** The bytes at `url`, or null (said in the notes) when it did not answer 200. */
async function bytesOf(url: string, headers: Record<string, string> = {}): Promise<Uint8Array | null> {
  try {
    const res = await fetch(url, { headers: { 'user-agent': uaFor(url), 'cache-control': 'no-cache', ...headers }, signal: AbortSignal.timeout(30_000) });
    if (res.status !== 200) {
      notices.push(`${url}: ${res.status}`);
      return null;
    }
    return new Uint8Array(await res.arrayBuffer());
  } catch (e) {
    notices.push(`${url}: ${(e as Error).message}`);
    return null;
  }
}

async function get(url: string, headers: Record<string, string> = {}): Promise<{ status: number; ms: number; text: string } | null> {
  const started = performance.now();
  try {
    const res = await fetch(url, { headers: { 'user-agent': uaFor(url), ...headers }, signal: AbortSignal.timeout(20_000) });
    return { status: res.status, ms: Math.round(performance.now() - started), text: await res.text() };
  } catch (e) {
    notices.push(`${url}: ${(e as Error).message}`);
    return null;
  }
}

const json = <T>(text: string | undefined): T | null => {
  try {
    return text ? (JSON.parse(text) as T) : null;
  } catch {
    return null;
  }
};

// 1. Health: three tries, 20 s apart, before an outage is called one.
let health: Health | null = null;
let healthMs = 0;
for (let i = 0; i < tries; i++) {
  const res = await get(`${site}/api/health`);
  health = json<Health>(res?.text);
  healthMs = res?.ms ?? 0;
  // A refusal is asked again too: one 429 in a busy second is not an empty plan.
  if (res?.status === 200 && health?.ok === true && !health.refused?.length) break;
  if (i < tries - 1) await sleep(pauseMs);
}
if (health?.ok !== true) {
  failures.push(`/api/health is not ok after ${tries} tries: ${health ? JSON.stringify(health) : 'no answer'}`);
}
rows.push(['health', health ? `${health.ok ? 'ok' : 'DOWN'} in ${healthMs} ms (rpc ${health.rpc?.ms ?? '-'} ms, jupiter ${health.jupiter?.ms ?? '-'} ms, agent build ${health.agents?.build.ms ?? '-'} ms)` : 'no answer']);
if (health?.paused) notices.push('the kill switch is on: swaps are paused (the operator\'s decision, not an outage)');
// One RPC only: every swap stops with it. Said, not failed.
if (health && health.rpcFallback === null) notices.push('no backup RPC (RPC_URL_FALLBACK): swaps stop whenever the main RPC does');
if (health?.rpcFallback && !health.rpcFallback.ok) notices.push('the backup RPC (RPC_URL_FALLBACK) does not answer');
if (health && health.agentApi !== 'on') failures.push(`the agent API is ${health.agentApi ?? 'unknown'}`);
if (health?.refused?.length) failures.push(`refused by ${health.refused.join(', ')}: the key or the plan (401/403 a wrong key, 402 unpaid, 429 out of credits or over the rate)`);
if (health?.sharedState === 'missing') failures.push('production has no Redis (UPSTASH_REDIS_REST_URL / KV_REST_API_URL): finalize refuses every swap');

// 2. Status: the commit it was built from, and the skill it serves.
const status = json<Status>((await get(`${site}/api/status`))?.text);
rows.push(['status', status ? `enabled ${status.enabled}, build ${status.build ?? 'not said'}, skill ${status.skillVersion ?? 'not said'}` : 'no answer']);
if (status?.enabled === false) notices.push('/api/status: enabled is false (paused)');

// 3. The commit: on main, and its CI.
const gh = async <T>(path: string): Promise<T | null> => {
  if (!repo) return null;
  const res = await get(`https://api.github.com/repos/${repo}${path}`, {
    accept: 'application/vnd.github+json', ...(token ? { authorization: `Bearer ${token}` } : {}),
  });
  return res && res.status === 200 ? json<T>(res.text) : null;
};
const build = status?.build ?? null;
if (build && repo) {
  const compare = await gh<{ status: string; ahead_by: number; commits?: { commit: { committer: { date: string } } }[] }>(`/compare/${build}...main`);
  if (!compare) incomplete.push(`could not compare ${build} with main`);
  else if (compare.status === 'identical') rows.push(['commit', `${build.slice(0, 7)}, the head of main`]);
  else if (compare.status === 'ahead') {
    const newest = compare.commits?.at(-1)?.commit.committer.date;
    const minutes = newest ? Math.round((Date.now() - Date.parse(newest)) / 60_000) : null;
    rows.push(['commit', `${build.slice(0, 7)}, ${compare.ahead_by} commit(s) behind main`]);
    if (minutes !== null && minutes > 30) notices.push(`production is ${compare.ahead_by} commit(s) behind main, the newest ${minutes} minutes old: a deploy may be stuck`);
  } else failures.push(`production was built from ${build}, which is not on main (${compare.status})`);

  const runs = await gh<{ workflow_runs: { status: string; conclusion: string | null; html_url: string }[] }>(`/actions/workflows/ci.yml/runs?head_sha=${build}&per_page=5`);
  const run = runs?.workflow_runs[0];
  if (!run) incomplete.push(`no CI run for ${build.slice(0, 7)} (a change only to the docs runs none)`);
  else if (run.status !== 'completed') {
    rows.push(['CI', `running (${run.html_url})`]);
    incomplete.push(`the CI of ${build.slice(0, 7)} has not finished`);
  }
  else if (run.conclusion === 'success') rows.push(['CI', 'passed']);
  else failures.push(`production runs ${build.slice(0, 7)}, whose CI ended ${run.conclusion}: ${run.html_url}`);

  // 4. The package the site points agents to (/api/status skillVersion): on npm, as the version's
  // release workflow built it (npm's provenance), and its Claude Desktop extension on that release.
  const version = status?.skillVersion;
  const published = version ? json<{ dist?: { attestations?: { provenance?: { predicateType?: string } } } }>(
    (await get(`https://registry.npmjs.org/@orientimhq%2fswap/${version}`))?.text) : null;
  if (!version || !published) incomplete.push(`could not find @orientimhq/swap@${version ?? '?'} on npm`);
  else if (!published.dist?.attestations?.provenance) failures.push(`@orientimhq/swap@${version} on npm has no provenance: it was not published by the release workflow`);
  else rows.push(['package', `@orientimhq/swap@${version}, with npm's provenance`]);
  const mcpb = version ? await bytesOf(`https://github.com/orientimhq/orientim-protected-swap/releases/download/v${version}/orientim.mcpb`) : null;
  if (!mcpb) incomplete.push(`could not download orientim.mcpb from the v${version ?? '?'} release`);
  else rows.push(['orientim.mcpb', `on the v${version} release, sha256 ${sha256(mcpb).slice(0, 16)}…`]);
} else if (!build) {
  incomplete.push(status
    ? '/api/status does not say which commit it was built from: its CI and the package named were not checked'
    : '/api/status did not answer: the version, its CI and the package named were not checked');
} else incomplete.push('no repository named (--repo or GITHUB_REPOSITORY): the commit, its CI and the package named were not checked');

// The report: a table in the run's summary, and the exit code.
const verdict = failures.length ? 'FAILED' : incomplete.length ? 'INCOMPLETE' : 'PASSED';
const lines = [`## ${site}: ${verdict}`, '', '| check | result |', '|---|---|', ...rows.map(([k, v]) => `| ${k} | ${v} |`), ''];
for (const n of notices) lines.push(`- note: ${n}`);
for (const f of failures) lines.push(`- **FAILED**: ${f}`);
for (const i of incomplete) lines.push(`- **INCOMPLETE**: ${i}`);
console.log(lines.join('\n'));
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${lines.join('\n')}\n`);
for (const n of notices) console.log(`::warning::${n}`);
for (const f of failures) console.log(`::error::${f}`);
for (const i of incomplete) console.log(`::error::not checked: ${i}`);
if (failures.length || incomplete.length) process.exitCode = 1;
