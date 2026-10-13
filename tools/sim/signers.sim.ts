/**
 * Wallets held by a signing service, Turnkey and Privy, through the whole path an agent takes:
 * Orientim's agent API (its real code, in this process, or a deployment: SIM_API_URL), the skill's
 * check, the service's signature as `signerFromSignTransaction` takes it, and finalize.
 *
 * What it checks, for each service whose credentials are set (tools/sim/providers.ts):
 *
 *   sign-no-send      the service signs and hands the transaction back; it does not reach the chain
 *   empty-slot        Orientim's signature slot (E, the second signer) is left empty, not refused
 *   bytes-unchanged   the message comes back byte for byte, so the skill and finalize accept it
 *   v0-lookup-tables  a v0 transaction with address lookup tables is signed as it is
 *   provider-policy   the service's own policy lets an Orientim swap through
 *   unattended        the whole swap with no person: order id, state directory, no approval
 *   sign-latency      how long the service takes to sign, against the blocks the swap has left
 *   concurrent        ten wallets sign at the same moment: limits or errors of the service
 *   policy-refusal    what a refusal by the service's policy looks like, and that the skill stops
 *                     on it as a refusal: nothing kept, nothing finalized, not retried
 *   sign-then-timeout the service signs and then times out, and a run stops after finalize: the
 *                     state directory finds the swap again, and it is never made twice
 *   agent-auth        the agent's own credentials (Turnkey: an API key; Privy: the authorization
 *                     key that owns the wallet), never a person's login
 *   both-policies     the service's policy and the owner's (ORIENTIM_POLICY) together: a swap within
 *                     both goes through, and each still refuses on its own
 *
 * Nothing is sent unless SIM_REAL_SWAPS=1: finalize asks with send: false and the fully signed
 * transaction is simulated, signatures checked, instead of sent. With SIM_REAL_SWAPS=1 three swaps
 * per service land on mainnet, each of SIM_SIGNER_USD (default $1.20, above Orientim's least swap)
 * of SOL into USDC. Each wallet needs about 0.05 SOL.
 *
 *   SIM_OFFLINE=1   the test fakes and a key in this process stand in for a service: checks this file
 */
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import {
  address, appendTransactionMessageInstruction, compileTransaction, createNoopSigner, createTransactionMessage, getBase64EncodedWireTransaction,
  getCompiledTransactionMessageDecoder, getSignatureFromTransaction, getTransactionDecoder, getTransactionEncoder, pipe,
  setTransactionMessageFeePayer, setTransactionMessageLifetimeUsingBlockhash,
} from '@solana/kit';
import type { Rpc, SolanaRpcApi } from '@solana/kit';
import { getTransferSolInstruction } from '@solana-program/system';
import {
  createFileStore, loadPolicy, MIN_BLOCKS_TO_FINALIZE, OrientimOrderError, PendingSwapError, PolicyError, prepareChecked, protectedSwap,
  recoverPending, signAsWallet, signerFromSignTransaction,
} from '../../skills/orientim-protected-swap/examples/swap.ts';
import type { Checked, OwnerPolicy } from '../../skills/orientim-protected-swap/examples/swap.ts';
import {
  agentRpc, codeOf, esc, JUPITER_API_KEY, ms, newTally, OFFLINE, offlineWorld, orientim, percentile, RPC_URL, SOL, solPrice, tallyOf, USDC, writeReport,
} from './common.ts';
import type { Target } from './common.ts';
import { providersFromEnv, SignerRefusedError, SignerUnavailableError } from './providers.ts';
import type { Provider } from './providers.ts';

const REAL = process.env.SIM_REAL_SWAPS === '1' || OFFLINE;
const USD = Number(process.env.SIM_SIGNER_USD ?? 1.2);
const SAMPLES = Number(process.env.SIM_SIGN_SAMPLES ?? 10);
/** How long to wait for a swap that was not sent to expire: past a blockhash's life, with margin. */
const EXPIRY_WAIT_MS = 150_000;

type Verdict = 'PASS' | 'FAIL' | 'UNTESTED';
type Row = { provider: string; check: string; verdict: Verdict; detail: string };

type World = {
  target: Target; rpc: Rpc<SolanaRpcApi>;
  inputMint: string; outputMint: string; amountIn: string;
};

// --- a service in this process, for SIM_OFFLINE: the fakes' wallet key, a second one that refuses
async function offlineProvider(world: Awaited<ReturnType<typeof offlineWorld>>): Promise<Provider> {
  const { generateKeyPairSigner } = await import('@solana/kit');
  const others = await Promise.all(Array.from({ length: 10 }, () => generateKeyPairSigner()));
  const deny = await generateKeyPairSigner();
  const keys = new Map([world.wallet, ...others].map(k => [k.address as string, k]));
  return {
    name: 'turnkey', wallet: world.wallet.address, wallets: others.map(k => k.address), denyWallet: deny.address,
    async sign(addr, transaction) {
      if (addr === deny.address) throw new SignerRefusedError('offline', 403, '{"code":7,"message":"policy denied: no policy allows this activity"}');
      const tx = getTransactionDecoder().decode(Buffer.from(transaction, 'base64'));
      const [sigs] = await keys.get(addr)!.signTransactions([tx as never]);
      return Buffer.from(getTransactionEncoder().encode({ ...tx, signatures: { ...tx.signatures, ...sigs } })).toString('base64');
    },
    async whoAmI() { return 'a key in this process (offline)'; },
  };
}

// --- helpers
const decode = (b64: string) => getTransactionDecoder().decode(Buffer.from(b64, 'base64'));
const sameBytes = (a: ArrayLike<number>, b: ArrayLike<number>) => a.length === b.length && Array.from(a).every((x, i) => x === b[i]);

async function amountFor(world: World): Promise<string> {
  if (OFFLINE) return world.amountIn;
  return String(Math.round((USD / await solPrice()) * 1e9));
}

async function prepare(world: World, owner: string, key = world.target.keys[0]): Promise<Checked> {
  return prepareChecked({
    apiUrl: world.target.apiUrl, apiKey: key, rpc: world.rpc, owner, fetchImpl: world.target.fetchImpl, jupiterApiKey: JUPITER_API_KEY,
    intent: { inputMint: world.inputMint, outputMint: world.outputMint, amountIn: await amountFor(world) },
  });
}

/** A transaction that moves nothing (0 lamports to itself), for a wallet with no funds to swap. */
async function emptyTransaction(rpc: Rpc<SolanaRpcApi>, owner: string): Promise<string> {
  const { value: blockhash } = await rpc.getLatestBlockhash().send();
  const signer = createNoopSigner(address(owner));
  const message = pipe(
    createTransactionMessage({ version: 0 }),
    m => setTransactionMessageFeePayer(address(owner), m),
    m => setTransactionMessageLifetimeUsingBlockhash(blockhash, m),
    m => appendTransactionMessageInstruction(getTransferSolInstruction({ source: signer, destination: address(owner), amount: 0n }), m),
  );
  return getBase64EncodedWireTransaction(compileTransaction(message));
}

/**
 * A sender that sends nothing: it keeps the fully signed transaction for the check to simulate.
 * With SIM_REAL_SWAPS=1, undefined: Orientim sends, as it does for an agent.
 */
function dryRun(): { send?: (wire: string) => Promise<unknown>; last: () => string | undefined } {
  let kept: string | undefined;
  if (REAL) return { last: () => kept };
  return { send: async wire => { kept = wire; return null; }, last: () => kept };
}

/** The fully signed transaction, simulated with its signatures checked: it would land as it is. */
async function wouldLand(rpc: Rpc<SolanaRpcApi>, wire: string): Promise<string | null> {
  if (OFFLINE) return null;
  const sim = await rpc.simulateTransaction(wire as never, { encoding: 'base64', sigVerify: true, replaceRecentBlockhash: false }).send();
  return sim.value.err ? `simulation: ${JSON.stringify(sim.value.err, (_, v) => (typeof v === 'bigint' ? v.toString() : v))}` : null;
}

/** A state directory and, when asked, the owner's policy file in it, as an unattended agent keeps them. */
function stateWithPolicy(policy?: Omit<OwnerPolicy, 'stateDir'>): { dir: string; policy?: OwnerPolicy } {
  const dir = mkdtempSync(join(tmpdir(), 'orientim-signer-'));
  if (!policy) return { dir };
  const path = join(dir, 'policy.json');
  writeFileSync(path, JSON.stringify({ ...policy, stateDir: join(dir, 'state') }));
  return { dir: join(dir, 'state'), policy: loadPolicy(path) };
}

/** `rpc`, which stops answering about signatures and heights once `stopped()`: a run that ends there. */
function blindAfter(rpc: Rpc<SolanaRpcApi>, stopped: () => boolean): Rpc<SolanaRpcApi> {
  return new Proxy(rpc as object, {
    get(target, method) {
      const call = (target as Record<string | symbol, unknown>)[method];
      if (method !== 'getSignatureStatuses' && method !== 'getBlockHeight' && method !== 'getTransaction') return call;
      return (...args: unknown[]) => {
        const request = (call as (...a: unknown[]) => { send: (o?: unknown) => Promise<unknown> }).apply(target, args);
        return { ...request, send: (o?: unknown) => (stopped() ? Promise.reject(new Error('the run stopped (simulated)')) : request.send(o)) };
      };
    },
  }) as Rpc<SolanaRpcApi>;
}

/** Counts what reaches Orientim's finalize (and with what `send`), for the "never twice" checks. */
function countingFinalize(target: Target) {
  const seen: { send: boolean }[] = [];
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    if (String(url).endsWith('/api/v1/finalize')) seen.push({ send: JSON.parse(String(init?.body ?? '{}')).send !== false });
    return target.fetchImpl(url, init);
  }) as unknown as typeof fetch;
  return { fetchImpl, seen };
}

// --- the checks
async function checks(p: Provider, world: World): Promise<Row[]> {
  const rows: Row[] = [];
  const row = (check: string, verdict: Verdict, detail: string) => {
    const r = { provider: p.name, check, verdict, detail };
    rows.push(r);
    console.log(`${p.name.padEnd(8)} ${verdict.padEnd(8)} ${check.padEnd(18)} ${detail.slice(0, 200)}`);
  };
  const attempt = async (check: string, work: () => Promise<void>) => {
    try {
      await work();
    } catch (e) {
      const unavailable = e instanceof SignerUnavailableError || /busy|unavailable|429|rate/i.test(codeOf(e));
      row(check, unavailable ? 'UNTESTED' : 'FAIL', `${codeOf(e)}: ${(e as Error).message}`);
    }
  };
  const signer = (addr = p.wallet) => signerFromSignTransaction(addr, tx => p.sign(addr, tx));
  const base = { apiUrl: world.target.apiUrl, apiKey: world.target.keys[0], rpc: world.rpc, fetchImpl: world.target.fetchImpl, jupiterApiKey: JUPITER_API_KEY, pollMs: OFFLINE ? 10 : 2_000 };

  // agent-auth: who the credentials are, and (Privy) that the wallet answers to the agent's key only.
  await attempt('agent-auth', async () => {
    const who = await p.whoAmI();
    if (!p.signWithoutAuthorization) return row('agent-auth', 'PASS', `${who}; signed below with these credentials only`);
    const checked = await prepare(world, p.wallet);
    try {
      await p.signWithoutAuthorization(p.wallet, checked.prepared.transaction);
      row('agent-auth', 'FAIL', `${who}; the app's secret alone signed for this wallet: it does not answer to the agent's authorization key only`);
    } catch (e) {
      row('agent-auth', e instanceof SignerRefusedError ? 'PASS' : 'UNTESTED', `${who}; without the authorization key: ${(e as Error).message}`);
    }
  });

  // The first list, on one prepared swap: sign, then read what came back.
  let checked: Checked | undefined;
  let signedBack: string | undefined;
  await attempt('sign-no-send', async () => {
    checked = await prepare(world, p.wallet);
    signedBack = await p.sign(p.wallet, checked.prepared.transaction);
    const tx = decode(signedBack);
    const signature = getSignatureFromTransaction(tx);
    await new Promise(r => setTimeout(r, OFFLINE ? 10 : 5_000));
    const { value: [status] } = await world.rpc.getSignatureStatuses([signature as never]).send();
    row('sign-no-send', status ? 'FAIL' : 'PASS', status ? `the service sent it: ${signature} is ${status.confirmationStatus}` : `signed (${signature.slice(0, 12)}…), not seen on chain 5 s later`);
  });
  if (checked && signedBack) {
    const built = decode(checked.prepared.transaction);
    const back = decode(signedBack);
    const e = checked.prepared.temporaryAuthority;
    await attempt('empty-slot', async () => {
      const slots = Object.keys(back.signatures);
      const filled = back.signatures[e as never];
      row('empty-slot', !filled && slots.includes(e) && back.signatures[p.wallet as never] ? 'PASS' : 'FAIL',
        `${slots.length} signers; the wallet's slot ${back.signatures[p.wallet as never] ? 'signed' : 'EMPTY'}, Orientim's (E) ${filled ? 'FILLED by the service' : 'left empty'}`);
    });
    await attempt('bytes-unchanged', async () => {
      const same = sameBytes(back.messageBytes, built.messageBytes);
      // As the skill takes it: refused if one byte changed, and the signature checked against the message.
      if (same) await signAsWallet(signer(), checked!.prepared.transaction);
      row('bytes-unchanged', same ? 'PASS' : 'FAIL', same ? `${built.messageBytes.length} bytes, identical; the skill's signer accepted it` : 'the service changed the message');
    });
    await attempt('v0-lookup-tables', async () => {
      const compiled = getCompiledTransactionMessageDecoder().decode(built.messageBytes) as { version: number | 'legacy'; addressTableLookups?: unknown[] };
      const tables = compiled.addressTableLookups?.length ?? 0;
      row('v0-lookup-tables', compiled.version === 0 && tables > 0 ? 'PASS' : 'UNTESTED',
        `v${compiled.version}, ${tables} lookup table(s)${tables ? ', signed as it is' : ': this route used none'}`);
    });
    await attempt('provider-policy', async () => {
      const who = await p.whoAmI();
      const policyKnown = p.name === 'privy' ? !/no policy/.test(who) : true;
      row('provider-policy', policyKnown ? 'PASS' : 'UNTESTED',
        p.name === 'privy' ? `${who}: the swap was signed under it` : "signed by an API user, who signs only what the organisation's policies allow");
    });
  }

  // sign-latency: the same transaction signed again and again, and the blocks left once it is.
  await attempt('sign-latency', async () => {
    const c = await prepare(world, p.wallet);
    const times: number[] = [];
    let fewest = Infinity;
    for (let i = 0; i < SAMPLES; i++) {
      const t = performance.now();
      await p.sign(p.wallet, c.prepared.transaction);
      times.push(performance.now() - t);
      const height = BigInt(await world.rpc.getBlockHeight({ commitment: 'confirmed' }).send());
      fewest = Math.min(fewest, Number(BigInt(c.prepared.lastValidBlockHeight) - height));
    }
    const enough = fewest >= Number(MIN_BLOCKS_TO_FINALIZE);
    row('sign-latency', enough ? 'PASS' : 'FAIL',
      `${SAMPLES} signatures: p50 ${ms(percentile(times, 50))}, p95 ${ms(percentile(times, 95))}, max ${ms(Math.max(...times))}; fewest blocks left after signing ${fewest} (finalize needs ${MIN_BLOCKS_TO_FINALIZE}), all ${SAMPLES} signed in a row from one prepare`);
  });

  // concurrent: ten wallets at the same moment (or ten swaps from one, when only one is set).
  await attempt('concurrent', async () => {
    const wallets = [p.wallet, ...p.wallets].slice(0, 10);
    const jobs = await Promise.all(Array.from({ length: 10 }, async (_, i) => {
      const owner = wallets[i % wallets.length];
      try {
        return { owner, tx: (await prepare(world, owner)).prepared.transaction, kind: 'swap' };
      } catch {
        // A wallet with nothing to swap still signs: a transaction that moves nothing.
        return { owner, tx: await emptyTransaction(world.rpc, owner), kind: 'empty' };
      }
    }));
    const started = performance.now();
    const results = await Promise.allSettled(jobs.map(async j => {
      const t = performance.now();
      await p.sign(j.owner, j.tx);
      return performance.now() - t;
    }));
    const wall = performance.now() - started;
    const ok = results.filter(r => r.status === 'fulfilled').map(r => (r as PromiseFulfilledResult<number>).value);
    const errors = results.filter(r => r.status === 'rejected').map(r => codeOf((r as PromiseRejectedResult).reason) + ': ' + String((r as PromiseRejectedResult).reason?.message).slice(0, 120));
    const swaps = jobs.filter(j => j.kind === 'swap').length;
    row('concurrent', errors.length ? 'FAIL' : 'PASS',
      `${new Set(wallets).size} wallet(s), 10 at once (${swaps} swaps, ${10 - swaps} empty transactions): ${ok.length} signed, p50 ${ms(percentile(ok, 50))}, max ${ms(Math.max(...ok, 0))}, all in ${ms(wall)}${errors.length ? `; errors: ${[...new Set(errors)].join(' | ')}` : ''}`);
  });

  // policy-refusal: a wallet whose policy says no, through the skill as an agent runs it.
  await attempt('policy-refusal', async () => {
    if (!p.denyWallet) return row('policy-refusal', 'UNTESTED', `no wallet with a refusing policy (${p.name === 'turnkey' ? 'TURNKEY_DENY_WALLET' : 'PRIVY_DENY_WALLET_ID'})`);
    const deny = p.denyWallet;
    let raw: unknown;
    try {
      await p.sign(deny, await emptyTransaction(world.rpc, deny));
    } catch (e) {
      raw = e;
    }
    // The same refusal as the skill meets it: on a swap of the refusing wallet when it holds enough
    // to prepare one, otherwise on the main wallet's swap, handed to the refusing wallet to sign.
    const funded = await prepare(world, deny).then(() => true, () => false);
    const owner = funded ? deny : p.wallet;
    const state = stateWithPolicy();
    const store = createFileStore(state.dir);
    const fin = countingFinalize(world.target);
    let signs = 0;
    let skillError: unknown;
    try {
      await protectedSwap({
        ...base, fetchImpl: fin.fetchImpl, wallet: signerFromSignTransaction(owner, tx => { signs++; return p.sign(deny, tx); }),
        intent: { inputMint: world.inputMint, outputMint: world.outputMint, amountIn: await amountFor(world), id: `refusal-${Date.now()}` },
        orders: store, pending: store, spends: store,
      });
    } catch (e) {
      skillError = e;
    }
    const kept = (await store.list()).length;
    const understood = raw instanceof SignerRefusedError;
    const reachedSigner = signs > 0;
    // Kept nothing, finalized nothing, asked once, and the agent got the service's refusal as it was.
    const clean = !kept && fin.seen.length === 0 && signs <= 1 && (!reachedSigner || skillError instanceof SignerRefusedError);
    row('policy-refusal', understood && clean ? 'PASS' : 'FAIL',
      `the service answered: ${raw === undefined ? 'it SIGNED (the policy did not refuse)' : (raw as Error).message}; read as ${understood ? 'a refusal' : raw instanceof SignerUnavailableError ? 'NOT ANSWERING (a network failure)' : 'something else'}. `
      + `Through the skill${funded ? '' : " (the refusing wallet cannot fund a swap: it was asked to sign the main wallet's)"}: ${reachedSigner ? `signer asked ${signs} time(s), then ${codeOf(skillError)}` : `stopped before signing (${codeOf(skillError)})`}; ${kept} swap(s) kept, ${fin.seen.length} finalize call(s). `
      + 'The skill passes the service\'s error through as it is: whether it reads as a refusal is up to the adapter (here SignerRefusedError).');
  });

  // sign-then-timeout: the service signs and then does not answer; then a run stops after finalize.
  await attempt('sign-then-timeout', async () => {
    const { dir } = stateWithPolicy();
    const store = createFileStore(dir);
    const id = `order-${p.name}-${Date.now()}`;
    const amountIn = await amountFor(world);
    const intent = { inputMint: world.inputMint, outputMint: world.outputMint, amountIn, id };
    const fin = countingFinalize(world.target);
    const dry = dryRun();
    const swap = (wallet: ReturnType<typeof signer>, extra: { maxWaitMs?: number; rpc?: Rpc<SolanaRpcApi> } = {}) => protectedSwap({
      ...base, fetchImpl: fin.fetchImpl, wallet, intent, orders: store, pending: store, spends: store, ...(dry.send ? { sendTransaction: dry.send } : {}), ...extra,
    });
    const notes: string[] = [];
    // 1. Signed at the service, but the answer never came back.
    const late = signerFromSignTransaction(p.wallet, async tx => {
      await p.sign(p.wallet, tx);
      throw new SignerUnavailableError(p.name, null, 'timed out after signing (simulated)');
    });
    await swap(late).then(() => notes.push('1: went through?!'), async e => notes.push(`1: ${codeOf(e)}, ${(await store.list()).length} kept, ${fin.seen.length} finalize`));
    const firstClean = (await store.list()).length === 0 && fin.seen.length === 0;
    // 2. Signed and finalized, then the run stops before it learns the outcome: from the moment
    // finalize is asked, this run's RPC no longer answers, and the swap is left as pending.
    const second = await swap(signer(), { maxWaitMs: OFFLINE ? 50 : 5_000, rpc: blindAfter(world.rpc, () => fin.seen.length > 0) });
    const keptAfter = (await store.list()).length;
    notes.push(`2: ${second.outcome}, ${keptAfter} kept`);
    // 3. Started again with the same order: refused while that swap may still land.
    let again: unknown;
    await swap(signer()).then(() => { again = null; }, e => { again = e; });
    const refusedAgain = again instanceof PendingSwapError || again instanceof OrientimOrderError;
    notes.push(`3: ${again === null ? 'SWAPPED AGAIN' : codeOf(again)}`);
    // 4. The state directory settles it.
    const recovered = await recoverPending(store, world.rpc, { orders: store, maxWaitMs: EXPIRY_WAIT_MS, pollMs: 2_000 });
    const outcome = recovered.settled[0]?.outcome ?? (recovered.unknown.length ? 'unknown' : 'nothing kept');
    notes.push(`4: recovered ${outcome}`);
    // 5. Landed: the same order is never swapped again. Not sent (dry): it expired, and may go again.
    let fifth = 'not asked';
    if (outcome === 'confirmed') await swap(signer()).then(() => { fifth = 'SWAPPED TWICE'; }, e => { fifth = codeOf(e); });
    notes.push(`5: ${fifth}`);
    const sends = fin.seen.length;
    const ok = firstClean && keptAfter === 1 && refusedAgain && (REAL ? outcome === 'confirmed' && fifth !== 'SWAPPED TWICE' : outcome === 'expired');
    row('sign-then-timeout', ok ? 'PASS' : 'FAIL', `${notes.join('; ')}; finalize asked ${sends} time(s) in all${dry.last() ? `; ${await wouldLand(world.rpc, dry.last()!) ?? 'its signed bytes would land'}` : ''}`);
  });

  // unattended and both-policies: the whole swap with no person, without and with the owner's policy.
  const owners: [string, Omit<OwnerPolicy, 'stateDir'> | undefined][] = [
    ['unattended', undefined],
    ['both-policies', { maxAmountIn: { [world.inputMint]: String(BigInt(await amountFor(world)) * 2n) }, allowedOutputMints: [world.outputMint] }],
  ];
  for (const [check, ownerPolicy] of owners) {
    await attempt(check, async () => {
      const state = stateWithPolicy(ownerPolicy);
      const store = createFileStore(state.dir);
      const dry = dryRun();
      const timings: Record<string, number> = {};
      const done = await protectedSwap({
        ...base, wallet: signer(), intent: { inputMint: world.inputMint, outputMint: world.outputMint, amountIn: await amountFor(world), id: `${check}-${Date.now()}` },
        orders: store, pending: store, spends: store, ...(state.policy ? { policy: state.policy } : {}), ...(dry.send ? { sendTransaction: dry.send } : {}),
        maxWaitMs: REAL ? 120_000 : EXPIRY_WAIT_MS, onTiming: (phase, t) => { timings[phase] = t; },
      });
      const land = dry.last() ? await wouldLand(world.rpc, dry.last()!) : null;
      const good = REAL ? done.outcome === 'confirmed' : done.outcome === 'expired' && !!dry.last() && !land;
      let detail = `${done.outcome}${done.received ? `, received ${done.received}` : ''} (${done.signature.slice(0, 12)}…); sign ${ms(timings.sign)}, finalize ${ms(timings.finalize)}`
        + `${dry.last() ? `; not sent: Orientim co-signed with send: false, ${land ?? 'and the fully signed bytes would land'}` : ''}`;
      if (state.policy) {
        // Each still refuses on its own: the owner's limit below this amount stops it before the service is asked.
        const tight = stateWithPolicy({ maxAmountIn: { [world.inputMint]: '1' }, allowedOutputMints: [world.outputMint] });
        let asked = 0;
        const refused = await protectedSwap({
          ...base, wallet: signerFromSignTransaction(p.wallet, tx => { asked++; return p.sign(p.wallet, tx); }),
          intent: { inputMint: world.inputMint, outputMint: world.outputMint, amountIn: await amountFor(world) }, policy: tight.policy, spends: createFileStore(tight.dir),
        }).then(() => null, e => e);
        const ownerHeld = refused instanceof PolicyError && asked === 0;
        detail += `; the owner's limit alone: ${refused instanceof PolicyError ? `refused (${codeOf(refused)})` : `NOT refused (${codeOf(refused)})`}, service asked ${asked} time(s)`;
        return row(check, good && ownerHeld ? 'PASS' : 'FAIL', detail);
      }
      row(check, good ? 'PASS' : 'FAIL', detail);
    });
  }
  return rows;
}

function report(rows: Row[], providers: string[], started: number): string {
  const lines = [
    '# Signing services: Turnkey and Privy', '',
    `${new Date().toISOString()}, ${Math.round((Date.now() - started) / 1000)} s. ${OFFLINE ? 'Offline (the test fakes).' : `Orientim ${process.env.SIM_API_URL ? `at ${process.env.SIM_API_URL}` : 'in this process'}, RPC ${new URL(RPC_URL).host}.`} `
    + `${REAL ? `Real swaps of $${USD} SOL into USDC.` : 'Nothing sent: finalize with send: false, the signed bytes simulated.'}`, '',
  ];
  if (!providers.length) {
    lines.push('Skipped: no service is set up. Turnkey needs TURNKEY_ORGANIZATION_ID, TURNKEY_API_PUBLIC_KEY, TURNKEY_API_PRIVATE_KEY and TURNKEY_WALLET; Privy needs PRIVY_APP_ID, PRIVY_APP_SECRET, PRIVY_AUTHORIZATION_KEY and PRIVY_WALLET_ID (tools/sim/providers.ts).');
    return `${lines.join('\n')}\n`;
  }
  for (const v of ['PASS', 'FAIL', 'UNTESTED'] as const) lines.push(`- ${v}: ${rows.filter(r => r.verdict === v).length}`);
  lines.push('', '| service | check | result | detail |', '|---|---|---|---|');
  for (const r of rows) lines.push(`| ${r.provider} | ${r.check} | ${r.verdict} | ${esc(r.detail)} |`);
  return `${lines.join('\n')}\n`;
}

it('signing services: Turnkey and Privy', async () => {
  const started = Date.now();
  let providers: Provider[];
  let world: World;
  if (OFFLINE) {
    const w = await offlineWorld();
    providers = [await offlineProvider(w)];
    world = w;
  } else {
    providers = await providersFromEnv();
    world = { target: orientim(1), rpc: agentRpc(), inputMint: SOL, outputMint: USDC, amountIn: '' };
  }
  const rows: Row[] = [];
  for (const p of providers) rows.push(...await tallyOf.run(newTally(), () => checks(p, world)));
  writeReport('signers', report(rows, providers.map(p => p.name), started), rows);
  expect(rows.filter(r => r.verdict === 'FAIL').map(r => `${r.provider} ${r.check}: ${r.detail}`)).toEqual([]);
}, 60 * 60_000);
