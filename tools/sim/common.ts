/**
 * What the signing and capacity simulations share: Orientim's agent API as a deployment runs it
 * (apps/web/lib/server/agent/config.ts, from the environment, in this process) or a deployment of it
 * by its address, every outgoing call counted by swap and by side, public wallets that hold what a
 * swap spends, and the report.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { address, createDefaultRpcTransport, createSolanaRpcFromTransport } from '@solana/kit';
import type { Rpc, SolanaRpcApi } from '@solana/kit';
import { retryingTransport } from '@orientimhq/swap/solana';
import { agentFinalize, agentPrepare } from '../../apps/web/lib/server/agent/api.ts';
import type { AgentDeps } from '../../apps/web/lib/server/agent/api.ts';
import { agentDeps } from '../../apps/web/lib/server/agent/config.ts';
import { ORIENTIM_TREASURY } from '@orientimhq/swap';

/** The test fakes instead of mainnet: checks the simulation itself, with no network and no key. */
export const OFFLINE = process.env.SIM_OFFLINE === '1';
export const RPC_URL = process.env.RPC_URL || 'https://api.mainnet-beta.solana.com';
export const JUPITER_API_KEY = process.env.JUPITER_API_KEY || undefined;
export const OUT = process.env.SIM_OUT ?? join(tmpdir(), 'orientim-sim');
export const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

export const SOL = 'So11111111111111111111111111111111111111112';
export const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
export const JUP = 'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN';
/** Public exchange wallets (the matrix's), tried first as holders. */
export const KNOWN_HOLDERS = [
  'GJRs4FwHtemZ5ZE9x3FNvJ8TMwitKTh21yxdRPqn7npE', '5tzFkiKscXHK5ZXCGbXZxdw7gTjjD1mBwuoFbhUvuAi9',
  'H8sMJSCQxfKiFTCfDR3DUMLPwcRbM61LGFJ8N4dK3WjS', '2AQdpHJ2JpcEgPiATUXjQxA8QmafFegfQwSLWSprPicm',
  'FWznbcNXWQuHTawe9RxvQ2LdCENssh12dsznf4RiouN5', 'AC5RDfQFmDS1deWZos921JfqscXdByf8BKHs5ACWjtW2',
  'ASTyfSima4LLAdDgoFGkgqoKowG1LZFDr9fAQrg7iaJZ', '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM',
];

// --- every outgoing call, counted for the swap it belongs to
export type Tally = {
  /** RPC calls by method, the server's and the agent's apart. */
  serverRpc: Record<string, number>;
  agentRpc: Record<string, number>;
  /** Jupiter calls by path, the server's and the agent's apart. */
  serverJupiter: Record<string, number>;
  agentJupiter: Record<string, number>;
  /** Answers 429 from the RPC or Jupiter, by who asked. */
  limited: Record<string, number>;
  /** The Server-Timing of the last prepare that built something. */
  serverTiming?: Record<string, number>;
};
export const newTally = (): Tally => ({ serverRpc: {}, agentRpc: {}, serverJupiter: {}, agentJupiter: {}, limited: {} });
/** The tally of the swap running in this async context; and the whole run's. */
export const tallyOf = new AsyncLocalStorage<Tally>();
export const runTally = newTally();
/** Who is asking: the agent (its own RPC, its own Jupiter key) or Orientim's server. */
const sideOf = new AsyncLocalStorage<'agent' | 'server'>();

/** A failure the capacity run puts in a service's way: answers instead of the real one. */
export type Injection = {
  rpc?: (url: string, init?: RequestInit) => Response | Promise<Response> | null;
  jupiter?: (url: string, side: 'agent' | 'server') => Response | null;
};
export const injected: Injection = {};

const bump = (m: Record<string, number>, k: string, n = 1) => { m[k] = (m[k] ?? 0) + n; };
const realFetch = globalThis.fetch.bind(globalThis);
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = String(input instanceof Request ? input.url : input);
  const side = sideOf.getStore() ?? 'server';
  const tallies = [runTally, tallyOf.getStore()].filter((t): t is Tally => !!t);
  let kind: 'rpc' | 'jupiter' | null = null;
  if (url.startsWith('https://api.jup.ag/')) {
    kind = 'jupiter';
    for (const t of tallies) bump(side === 'agent' ? t.agentJupiter : t.serverJupiter, new URL(url).pathname);
  } else if (typeof init?.body === 'string' && init.body.includes('"jsonrpc"')) {
    kind = 'rpc';
    let methods: string[] = [];
    try {
      const body = JSON.parse(init.body) as { method?: string } | { method?: string }[];
      methods = (Array.isArray(body) ? body : [body]).map(b => String(b.method));
    } catch { /* counted as one */ }
    for (const t of tallies) for (const m of methods.length ? methods : ['?']) bump(side === 'agent' ? t.agentRpc : t.serverRpc, m);
  }
  const fake = kind === 'rpc' ? injected.rpc?.(url, init) : kind === 'jupiter' ? injected.jupiter?.(url, side) : null;
  const res = fake ? await fake : await realFetch(input, init);
  if (res.status === 429 && kind) for (const t of tallies) bump(t.limited, `${side} ${kind}`);
  return res;
}) as typeof fetch;

/** The agent's own RPC: the same provider, counted apart from the server's. */
export function agentRpc(url = RPC_URL): Rpc<SolanaRpcApi> {
  const base = retryingTransport(createDefaultRpcTransport({ url: url as `https://${string}` }), 5, 500, 15_000);
  return createSolanaRpcFromTransport(((config: Parameters<typeof base>[0]) => sideOf.run('agent', () => base(config))) as typeof base) as unknown as Rpc<SolanaRpcApi>;
}

// --- Orientim: in this process (the default), or a deployment by its address
export type Target = {
  apiUrl: string;
  /** One API key per agent: the per-key limit holds for each of them, as for agents of their own. */
  keys: string[];
  /** The agent's fetch: Orientim's endpoints in this process when local, everything else counted. */
  fetchImpl: typeof fetch;
  local: boolean;
};

const LOCAL_URL = 'http://orientim.sim';

/**
 * SIM_API_URL and SIM_API_KEYS (comma-separated) aim at a deployment, such as a preview; otherwise
 * the agent API runs here, configured from the environment as a deployment configures it: RPC_URL,
 * RPC_URL_FALLBACK, JUPITER_API_KEY, ORIENTIM_API_PER_MINUTE, ORIENTIM_DISABLED.
 */
export function orientim(keyCount = 1, depsOf: () => AgentDeps | null = agentDeps): Target {
  const remote = OFFLINE ? undefined : process.env.SIM_API_URL?.replace(/\/+$/, '');
  if (remote) {
    const keys = (process.env.SIM_API_KEYS ?? '').split(',').map(s => s.trim()).filter(Boolean);
    if (!keys.length) throw new Error('SIM_API_URL needs SIM_API_KEYS, one or more API keys of that deployment.');
    const fetchImpl = ((url: string, init?: RequestInit) =>
      sideOf.run(String(url).startsWith(remote) ? 'server' : 'agent', async () => {
        const res = await fetch(url, init);
        if (String(url).startsWith(`${remote}/api/v1/prepare`)) keepTiming(res);
        return res;
      })) as unknown as typeof fetch;
    return { apiUrl: remote, keys, fetchImpl, local: false };
  }
  const keys = Array.from({ length: keyCount }, () => `ori_sim_${randomBytes(16).toString('hex')}`);
  process.env.ORIENTIM_API_SECRET ??= randomBytes(32).toString('base64');
  process.env.ORIENTIM_API_KEYS = keys.map((k, i) => `sim${i}:${createHash('sha256').update(k).digest('hex')}`).join(',');
  // As production: Orientim's own treasury and fee, unless the run sets others.
  process.env.NEXT_PUBLIC_ORIENTIM_TREASURY ??= ORIENTIM_TREASURY;
  const fetchImpl = ((url: string, init?: RequestInit) => {
    const u = String(url);
    if (!u.startsWith(LOCAL_URL)) return sideOf.run('agent', () => fetch(url, init));
    return sideOf.run('server', async () => {
      // Read on every request, as the route does: the kill switch and the RPC follow the environment.
      const deps = depsOf();
      if (!deps) return Response.json({ error: { code: 'not-enabled', message: 'not configured' } }, { status: 404 });
      const req = new Request(u, init);
      const res = u.startsWith(`${LOCAL_URL}/api/v1/prepare`) ? await agentPrepare(req, deps) : await agentFinalize(req, deps);
      if (u.startsWith(`${LOCAL_URL}/api/v1/prepare`)) keepTiming(res);
      return res;
    });
  }) as unknown as typeof fetch;
  return { apiUrl: LOCAL_URL, keys, fetchImpl, local: true };
}

function keepTiming(res: Response) {
  const header = res.headers.get('server-timing');
  const t = tallyOf.getStore();
  if (!header || !t) return;
  t.serverTiming = Object.fromEntries(header.split(',').map(p => {
    const [name, ...rest] = p.trim().split(';');
    const dur = rest.find(x => x.trim().startsWith('dur='));
    return [name.trim(), Number(dur?.split('=')[1] ?? NaN)];
  }));
}

// --- wallets and prices
let solUsd: number | null = null;
/** SOL's price in USD, from Jupiter. */
export async function solPrice(): Promise<number> {
  if (solUsd) return solUsd;
  const r = await fetch(`https://api.jup.ag/tokens/v2/search?query=${SOL}`, { headers: JUPITER_API_KEY ? { 'x-api-key': JUPITER_API_KEY } : {} });
  const list = r.ok ? await r.json() as { id: string; usdPrice?: number }[] : [];
  const price = Array.isArray(list) ? list.find(t => t.id === SOL)?.usdPrice : undefined;
  if (!price) throw new Error(`No SOL price from Jupiter (${r.status}).`);
  solUsd = price;
  return price;
}

/**
 * Public wallets (system accounts) holding at least `minLamports` of SOL and, for a mint, `minUnits`
 * of it in their own associated account: they stand in for the agents' wallets. Nothing is signed.
 */
export async function publicWallets(rpc: Rpc<SolanaRpcApi>, minLamports: bigint, mint?: string, minUnits = 0n, want = 40): Promise<string[]> {
  const candidates = new Set(KNOWN_HOLDERS);
  for (const m of [USDC, mint].filter((x): x is string => !!x && x !== SOL)) {
    try {
      const largest = await rpc.getTokenLargestAccounts(address(m)).send();
      const infos = await rpc.getMultipleAccounts(largest.value.slice(0, 20).map(a => a.address), { encoding: 'jsonParsed' }).send();
      for (const info of infos.value) {
        const owner = (info?.data as { parsed?: { info?: { owner?: string } } } | undefined)?.parsed?.info?.owner;
        if (owner) candidates.add(owner);
      }
    } catch { /* the known wallets only */ }
  }
  const found: string[] = [];
  const all = [...candidates];
  const infos = await rpc.getMultipleAccounts(all.map(a => address(a)), { encoding: 'base64' }).send();
  for (const [i, info] of infos.value.entries()) {
    if (!info || info.owner !== '11111111111111111111111111111111' || BigInt(info.lamports) < minLamports) continue;
    if (mint && mint !== SOL) {
      const accounts = await rpc.getTokenAccountsByOwner(address(all[i]), { mint: address(mint) }, { encoding: 'jsonParsed' }).send().catch(() => null);
      const units = (accounts?.value ?? []).reduce((s, a) => s + BigInt((a.account.data as { parsed: { info: { tokenAmount: { amount: string } } } }).parsed.info.tokenAmount.amount), 0n);
      if (units < minUnits) continue;
    }
    found.push(all[i]);
    if (found.length >= want) break;
  }
  return found;
}

// --- numbers and the report
export function percentile(values: number[], p: number): number {
  if (!values.length) return NaN;
  const s = [...values].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1))];
}
export const ms = (n: number) => (Number.isFinite(n) ? `${Math.round(n)} ms` : '-');
export const sum = (m: Record<string, number>) => Object.values(m).reduce((a, b) => a + b, 0);
export const counts = (m: Record<string, number>) => Object.entries(m).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join(', ') || '-';
export const esc = (s: string) => s.replace(/\|/g, '\\|').replace(/\n/g, ' ');

/** Writes the report where the matrix writes its own, and to the job's summary. */
export function writeReport(name: string, md: string, data: unknown) {
  mkdirSync(OUT, { recursive: true });
  writeFileSync(join(OUT, `${name}.md`), md);
  writeFileSync(join(OUT, `${name}.json`), JSON.stringify(data, (_, v) => (typeof v === 'bigint' ? v.toString() : v), 2));
  if (process.env.GITHUB_STEP_SUMMARY) writeFileSync(process.env.GITHUB_STEP_SUMMARY, md, { flag: 'a' });
  console.log(`\nReport: ${join(OUT, `${name}.md`)}\n\n===== SUMMARY =====\n${md}===== END OF SUMMARY =====`);
}

// --- how the capacity run judges what it saw (unit tested in apps/web/test/capacitySim.test.ts)
/** The skill's refusal when the minimum-output check is its one problem: "check for X, expected Y". */
const MIN_OUTPUT_ONLY = /^Not signing: R2: instruction \d+: minimum-output check for (\d+), expected (\d+)$/;

/**
 * Is a refusal a borrowed wallet's output balance moving between Orientim's build and the agent's
 * check? Only when the minimum-output check is the refusal's one problem, and its gap (what the agent
 * expected less what the check asks) is the change seen in that balance meanwhile: the agent reads
 * the balance after Orientim did, so a balance up by d makes it expect d more. A refusal that also
 * names a fee sent elsewhere, or a check lowered with no such change, is never this: it is a server
 * weakening the floor, and needs a look.
 */
export function balanceMoved(message: string, seenChange: bigint | null): boolean {
  const m = MIN_OUTPUT_ONLY.exec(message);
  if (!m || seenChange === null || seenChange === 0n) return false;
  return BigInt(m[2]) - BigInt(m[1]) === seenChange;
}

/**
 * A phase that must build: PASS only with no unclear answer and at least `share` of its swaps built.
 * One built swap of many proves little: at 5 runs, 5 passes still allow a failure rate up to 45%.
 */
export function buildVerdict(built: number, n: number, unclear: number, share: number): 'PASS' | 'LOOK' {
  return unclear === 0 && n > 0 && built >= Math.ceil(share * n - 1e-9) ? 'PASS' : 'LOOK';
}

/** An error, as a short code for counting: Orientim's code, or what kind of failure it was. */
export function codeOf(e: unknown): string {
  const err = e as { code?: unknown; name?: string; message?: string };
  if (typeof err?.code === 'string' && /^[a-z][a-z-]{1,40}$/.test(err.code)) return err.code;
  const message = err?.message ?? String(e);
  const kind = (e as object | null)?.constructor?.name;
  if (kind && kind !== 'Error' && kind !== 'Object' && kind !== 'TypeError' && kind !== 'SolanaError') return kind;
  if (/429|rate.?limit/i.test(message)) return 'jupiter-429';
  if (/timeout|timed out|abort/i.test(message)) return 'timeout';
  return message.slice(0, 60);
}

// --- the test fakes: a funded wallet with a key, an honest market, no network
export type OfflineWorld = {
  target: Target; rpc: Rpc<SolanaRpcApi>; deps: AgentDeps;
  /** A wallet of the fakes, holding USDC, whose key signs here. */
  wallet: import('@solana/kit').KeyPairSigner;
  inputMint: string; outputMint: string; amountIn: string;
};

export async function offlineWorld(keyCount = 1): Promise<OfflineWorld> {
  const { generateKeyPairSigner } = await import('@solana/kit');
  const fakes = await import('../../packages/jupiter/test/fakes.ts');
  const { ataOf } = await import('@orientimhq/swap/core');
  const wallet = await generateKeyPairSigner();
  const accounts = new Map<string, import('../../packages/jupiter/test/fakes.ts').Account>([
    [fakes.USDC, fakes.mint(6)], [SOL, fakes.mint(9)],
    [fakes.DEX, { owner: address('BPFLoaderUpgradeab1e11111111111111111111111'), data: new Uint8Array(36) }],
    [fakes.POOL, { owner: fakes.DEX, data: new Uint8Array(300) }],
    [await ataOf(address(ORIENTIM_TREASURY), fakes.USDC), fakes.tokenAccount(address(ORIENTIM_TREASURY), fakes.USDC)],
    ...await fakes.fundedAccounts(wallet.address, fakes.USDC),
  ]);
  // Every transaction sent lands, confirmed: what the chain knows is shared by Orientim and the agent.
  const statuses = new Map<string, { confirmationStatus: 'processed' | 'confirmed' | 'finalized'; err: unknown }>();
  const rpc = fakes.fakeRpc(accounts, { landOnSend: true, statuses });
  const jupiter = fakes.fakeJupiter();
  const deps: AgentDeps = {
    rpc, jupiter, secrets: [randomBytes(32)], keys: new Map(),
    feeBps: 25n, treasury: address(ORIENTIM_TREASURY), excludeDexes: [], maxNetworkFeeLamports: 200_000n,
    disabled: process.env.ORIENTIM_DISABLED === '1', v1: true, perMinute: Number(process.env.ORIENTIM_API_PER_MINUTE) || 60, ownRoutes: true,
  };
  const target = orientim(keyCount, () => ({ ...deps, disabled: /^(1|true|yes|on)$/i.test(process.env.ORIENTIM_DISABLED?.trim() ?? '') }));
  deps.keys = new Map(target.keys.map((k, i) => [createHash('sha256').update(k).digest('hex'), `sim${i}`]));
  // Jupiter, as the fakes answer it, for the agent's own price and the routes it brings.
  const agentFetch = target.fetchImpl;
  target.fetchImpl = (async (url: string, init?: RequestInit) => {
    if (!String(url).startsWith('https://api.jup.ag/')) return agentFetch(url, init);
    const q = new URL(url).searchParams;
    const r = await jupiter.build({
      inputMint: address(q.get('inputMint')!), outputMint: address(q.get('outputMint')!), amount: BigInt(q.get('amount')!),
      taker: address(q.get('taker')!), slippageBps: Number(q.get('slippageBps')) || 50, maxAccounts: Number(q.get('maxAccounts')) || 64,
      ...(q.get('destinationTokenAccount') ? { destinationTokenAccount: address(q.get('destinationTokenAccount')!) } : {}),
    });
    return Response.json({ ...r, priceImpactPct: 0 });
  }) as unknown as typeof fetch;
  const agent = { ...rpc, getBlockHeight: () => ({ send: async () => 850n }) } as unknown as Rpc<SolanaRpcApi>;
  return { target, rpc: agent, deps, wallet, inputMint: fakes.USDC, outputMint: SOL, amountIn: '100000000' };
}
