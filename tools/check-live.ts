/**
 * Is the site serving the release that was published?
 *
 * `tools/build-digest.ts` writes the hash of every file under `/_next/static` for a build; a release
 * publishes that list. This fetches the live site and checks, against the list:
 *
 *   - every file in it is served with exactly the published bytes;
 *   - every static asset the pages refer to is in it (a file added to a deploy is as bad as one
 *     changed);
 *   - no page loads a script from anywhere else.
 *
 * It exits 1 on any difference, so a scheduled workflow that runs it fails and its owner is told.
 * What it cannot see: a server that serves one thing to this check and another to a user, and the
 * inline parts of the HTML (the CSP nonce changes them on every request). SECURITY.md says so.
 *
 *   node tools/check-live.ts --site https://example.com [--manifest apps/web/.next/build-digest.txt]
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

/** A browser's user agent, as any visitor's, so the site cannot tell the check from a user. */
const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';

// The public pages whose scripts matter: the swap, and the page that issues API keys (/docs, which
// leads to /developers; the address stays valid before and after a deploy).
const PAGES = ['/', '/docs', '/security'];
const STATIC = '/_next/static/';

function arg(name: string, fallback?: string): string {
  const i = process.argv.indexOf(name);
  const value = i >= 0 ? process.argv[i + 1] : fallback;
  if (!value) {
    console.error('usage: node tools/check-live.ts --site <url> [--manifest <build-digest.txt>]');
    process.exit(2);
  }
  return value;
}

const site = arg('--site').replace(/\/+$/, '');
const manifestPath = arg('--manifest', 'apps/web/.next/build-digest.txt');

// The format build-digest.ts writes: "<sha256>  <path>" lines, a blank line, then the totals.
const text = readFileSync(manifestPath, 'utf8');
const expected = new Map<string, string>();
for (const line of text.split('\n')) {
  const m = /^([0-9a-f]{64}) {2}(\S.*)$/.exec(line);
  if (m) expected.set(m[2], m[1]);
}
const digest = /^digest: ([0-9a-f]{64})$/m.exec(text)?.[1];
if (expected.size === 0 || !digest) {
  console.error(`${manifestPath} is not a build digest`);
  process.exit(2);
}

const problems: string[] = [];

async function get(path: string): Promise<Response | null> {
  try {
    return await fetch(site + path, { redirect: 'follow', headers: { 'user-agent': BROWSER_UA } });
  } catch (e) {
    problems.push(`${path}: ${(e as Error).message}`);
    return null;
  }
}

// What the pages refer to. Hosting may add a query (Vercel's ?dpl=…); the file is the same.
const referenced = new Set<string>();
for (const page of PAGES) {
  const res = await get(page);
  if (!res) continue;
  if (!res.ok) {
    problems.push(`${page}: HTTP ${res.status}`);
    continue;
  }
  const html = await res.text();
  for (const m of html.matchAll(/\/_next\/static\/([^"'\s\\)?#]+)/g)) referenced.add(decodeURIComponent(m[1]));
  for (const m of html.matchAll(/<script\b[^>]*\bsrc\s*=\s*["']([^"']+)["']/gi)) {
    const src = new URL(m[1], site + page);
    if (src.origin !== new URL(site).origin || !src.pathname.startsWith(STATIC)) {
      problems.push(`${page}: loads a script from outside the build: ${m[1]}`);
    }
  }
}
for (const name of referenced) {
  if (!expected.has(name)) problems.push(`${STATIC}${name}: referenced by a page, not in the release`);
}

// Every published file, byte for byte.
const names = [...expected.keys()];
for (let i = 0; i < names.length; i += 8) {
  await Promise.all(names.slice(i, i + 8).map(async name => {
    const res = await get(STATIC + name.split('/').map(encodeURIComponent).join('/'));
    if (!res) return;
    if (!res.ok) {
      problems.push(`${STATIC}${name}: HTTP ${res.status}`);
      return;
    }
    const hash = createHash('sha256').update(Buffer.from(await res.arrayBuffer())).digest('hex');
    if (hash !== expected.get(name)) problems.push(`${STATIC}${name}: served bytes differ from the release`);
  }));
}

console.log(`site      ${site}`);
console.log(`release   ${digest} (${expected.size} files)`);
console.log(`pages     ${PAGES.join(' ')} (${referenced.size} static assets referenced)`);
if (problems.length) {
  console.log(`\nMISMATCH: ${problems.length}`);
  for (const p of problems) console.log(`  ${p}`);
  process.exitCode = 1;
} else {
  console.log('\nOK: the site serves the published release');
}
