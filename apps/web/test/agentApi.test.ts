/**
 * The agent API (AGENT-API.md): the real pipeline behind /v1/prepare and /v1/finalize,
 * against the fake RPC and Jupiter the pipeline's own tests use. The fee holds because Orientim signs
 * as E only the exact message it built; every test here that changes that message must end with
 * nothing signed and nothing sent.
 */
import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import {
  address, compileTransaction, decompileTransactionMessage, generateKeyPairSigner, getCompiledTransactionMessageDecoder,
  SolanaError, SOLANA_ERROR__JSON_RPC__METHOD_NOT_FOUND, SOLANA_ERROR__JSON_RPC__SERVER_ERROR_MIN_CONTEXT_SLOT_NOT_REACHED, SOLANA_ERROR__JSON_RPC__SERVER_ERROR_SEND_TRANSACTION_PREFLIGHT_FAILURE, getPublicKeyFromAddress, getSignatureFromTransaction, getTransactionDecoder, getTransactionEncoder,
  partiallySignTransaction, signBytes, verifySignature,
} from '@solana/kit';
import type { Address, KeyPairSigner, Transaction } from '@solana/kit';
import { ataOf, feeFor, SYSTEM_PROGRAM, WSOL_MINT } from '@orientim/core';
import { fakeJupiter, fakeRpc, fundedAccounts, mint, OUT, POOL, DEX, tokenAccount, USDC, BONK } from '../../../packages/jupiter/test/fakes.ts';
import type { Account } from '../../../packages/jupiter/test/fakes.ts';
import type { BuildParams } from '../../../packages/jupiter/src/client.ts';
import { agentFinalize, agentPrepare, FINALIZE_DEADLINE_MS, olderThan, PREPARE_DEADLINE_MS, withinDeadline } from '../lib/server/agent/api.ts';
import type { AgentDeps } from '../lib/server/agent/api.ts';
import { ephemeralFor, kidOf, openTicket, sealTicket } from '../lib/server/agent/ticket.ts';
import { issueKey } from '../lib/server/agent/keys.ts';
import { loggableError, maskedReason, observed } from '../lib/server/agent/events.ts';

const KEY = 'ori_test_key_for_the_agent_api_0001';
const OTHER_KEY = 'ori_test_key_for_another_agent_0002';
const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const secret = (fill: number) => new Uint8Array(32).fill(fill);
const TREASURY = address('9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM');

let n = 0;
async function world(opts: {
  height?: bigint; disabled?: boolean; jupiter?: AgentDeps['jupiter']; sendError?: unknown; treasury?: null; treasuryWallet?: boolean;
  landOnSend?: boolean; statusFails?: boolean;
} = {}) {
  const W = await generateKeyPairSigner();
  const accounts = new Map<string, Account>([
    [USDC, mint(6)], [WSOL_MINT, mint(9)], [BONK, mint(5)],
    [DEX, { owner: address('BPFLoaderUpgradeab1e11111111111111111111111'), data: new Uint8Array(36) }],
    [POOL, { owner: DEX, data: new Uint8Array(300) }],
    // The treasury has an account for USDC, so the fee is charged.
    [await ataOf(TREASURY, USDC), tokenAccount(TREASURY, USDC)],
    ...await fundedAccounts(W.address, USDC),
    // With a wallet, the treasury takes the fee of a sale into SOL in SOL, out of the output.
    ...(opts.treasuryWallet ? [[TREASURY, { owner: SYSTEM_PROGRAM, data: new Uint8Array(0) }] as [string, Account]] : []),
  ]);
  const sent: string[] = [];
  const statuses: NonNullable<NonNullable<Parameters<typeof fakeRpc>[1]>['statuses']> = new Map();
  const deps: AgentDeps = {
    rpc: fakeRpc(accounts, { height: opts.height, sent, sendError: opts.sendError, statuses, landOnSend: opts.landOnSend, statusFails: opts.statusFails }),
    jupiter: opts.jupiter ?? fakeJupiter(),
    secrets: [secret(7)],
    keys: new Map([[sha(KEY), 'agent-one'], [sha(OTHER_KEY), 'agent-two']]),
    feeBps: 20n,
    treasury: opts.treasury === null ? null : TREASURY,
    excludeDexes: ['HumidiFi'],
    maxNetworkFeeLamports: 200_000n,
    disabled: opts.disabled ?? false,
    v1: false,
    perMinute: 1_000,
    ownRoutes: true,
  };
  return { W, deps, sent, accounts, statuses };
}

const post = (path: string, body: unknown, key: string | null = KEY) =>
  new Request(`http://orientim.test/api/v1/${path}?n=${++n}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(key ? { authorization: `Bearer ${key}` } : {}) },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });

const swapBody = (W: Address, extra: Record<string, unknown> = {}) =>
  ({ owner: W, inputMint: USDC, outputMint: WSOL_MINT, amountIn: '1000000', minOut: '1', ...extra });

type Prepared = { ticket: string; transaction: string; messageSha256: string; temporaryAuthority: string; amounts: { fee: string; feeBps: string } };

async function prepared(w: Awaited<ReturnType<typeof world>>, extra: Record<string, unknown> = {}): Promise<Prepared> {
  const res = await agentPrepare(post('prepare', swapBody(w.W.address, extra)), w.deps);
  expect(res.status).toBe(200);
  return res.json();
}

/** What an honest agent does: sign the transaction it was given, as W, and nothing else. */
async function signAsWallet(W: KeyPairSigner, wire: string): Promise<string> {
  const tx = getTransactionDecoder().decode(Buffer.from(wire, 'base64'));
  const signed = await partiallySignTransaction([W.keyPair], tx);
  return Buffer.from(getTransactionEncoder().encode(signed)).toString('base64');
}

/** A message with one byte changed, signed by W: the shape of an agent that edited the transaction. */
async function signChanged(W: KeyPairSigner, wire: string, at: (length: number) => number): Promise<string> {
  const tx = getTransactionDecoder().decode(Buffer.from(wire, 'base64'));
  const bytes = new Uint8Array(tx.messageBytes);
  bytes[at(bytes.length)] ^= 1;
  const changed = { ...tx, messageBytes: bytes } as unknown as Transaction;
  const signed = await partiallySignTransaction([W.keyPair], changed);
  return Buffer.from(getTransactionEncoder().encode(signed)).toString('base64');
}

const finalize = (w: Awaited<ReturnType<typeof world>>, ticket: string, signedTransaction: string, key = KEY) =>
  agentFinalize(post('finalize', { ticket, signedTransaction }, key), w.deps);

/** The transaction's id: the wallet's signature, known to the agent before finalize. */
const signatureOf = (wire: string) => getSignatureFromTransaction(getTransactionDecoder().decode(Buffer.from(wire, 'base64')));

describe('prepare', () => {
  it('keeps fast routing off unless enabled and requested, while allowing a standard-price baseline', async () => {
    const asked: BuildParams[] = [];
    const w = await world({ jupiter: fakeJupiter({ asked }) });
    expect((await agentPrepare(post('prepare', swapBody(w.W.address, { routingMode: 'fast' })), w.deps)).status).toBe(400);
    expect(asked).toHaveLength(0);
    w.deps.fastRouting = true;
    const response = await agentPrepare(post('prepare', swapBody(w.W.address, { routingMode: 'fast' })), w.deps);
    expect(response.status).toBe(200);
    expect(response.headers.get('server-timing')).toMatch(/prepare;dur=\d+, initial;dur=\d+, jupiter-build;dur=\d+, simulation;dur=\d+, verification;dur=\d+, local;dur=\d+/);
    expect(asked.some(p => p.mode === undefined && !p.excludeDexes?.length)).toBe(true);
    expect(asked.some(p => p.mode === 'fast' && !!p.excludeDexes?.length)).toBe(true);
  });

  it('builds v1 only when the deployment enables it', async () => {
    const w = await world();
    expect((await agentPrepare(post('prepare', swapBody(w.W.address, { version: 1 })), w.deps)).status).toBe(400);
    w.deps.v1 = true;
    const p = await prepared(w, { version: 1 });
    expect(getTransactionDecoder().decode(Buffer.from(p.transaction, 'base64')).messageBytes[0]).toBe(0x81);
  });
  it('builds the protected swap with the fee in it, and a ticket bound to the exact message', async () => {
    const w = await world();
    const p = await prepared(w);
    expect(p.amounts.feeBps).toBe('20');
    expect(BigInt(p.amounts.fee)).toBe(feeFor(1_000_000n, { feeBps: 20n, treasury: TREASURY }));
    const tx = getTransactionDecoder().decode(Buffer.from(p.transaction, 'base64'));
    expect(createHash('sha256').update(Buffer.from(tx.messageBytes)).digest('hex')).toBe(p.messageSha256);
    const opened = await openTicket(w.deps.secrets, p.ticket);
    expect(opened?.ticket.msg).toBe(p.messageSha256);
    expect(opened?.ticket.key).toBe('agent-one');
    expect(Object.keys(tx.signatures).sort()).toEqual([w.W.address, p.temporaryAuthority].sort());
    // What the transaction has left to live, in blocks: the fake chain is at 1.
    expect((p as unknown as { blocksLeft: string }).blocksLeft).toBe('999');
  });

  it('takes the tolerance the agent chose, as the page does, and says what the mints allow their issuers', async () => {
    const w = await world();
    for (const bad of [5, 1_501, 2.5, '300']) {
      const res = await agentPrepare(post('prepare', swapBody(w.W.address, { slippageBps: bad })), w.deps);
      expect(res.status, String(bad)).toBe(400);
    }
    const p = await prepared(w, { slippageBps: 300 }) as unknown as { slippageBps: number; tokens: Record<string, { freezeAuthority: boolean; mintAuthority: boolean; permanentDelegate: boolean }> };
    expect(p.slippageBps).toBe(300);
    expect(p.tokens.input).toEqual({ freezeAuthority: false, mintAuthority: false, permanentDelegate: false });
    expect(p.tokens.output).toEqual({ freezeAuthority: false, mintAuthority: false, permanentDelegate: false });
  });

  it('a 429 says in Retry-After how long until the count starts again', async () => {
    const w = await world();
    const deps = { ...w.deps, perMinute: 1 };
    // Its own path, so that no other test's requests count in the same window.
    const first = await agentPrepare(post('prepare-limit', swapBody(w.W.address)), deps);
    expect(first.status).toBe(200);
    const second = await agentPrepare(post('prepare-limit', swapBody(w.W.address)), deps);
    expect(second.status).toBe(429);
    const after = Number(second.headers.get('retry-after'));
    expect(after).toBeGreaterThan(50);
    expect(after).toBeLessThanOrEqual(60);
  });

  it('takes acceptCostBps as a number or as an integer string, and refuses anything else', async () => {
    const w = await world();
    for (const bad of [-1, 2.5, 100_000, '12.5', 'abc', true]) {
      const res = await agentPrepare(post('prepare', swapBody(w.W.address, { acceptCostBps: bad })), w.deps);
      expect(res.status, String(bad)).toBe(400);
    }
    for (const good of [120, '120']) {
      const res = await agentPrepare(post('prepare', swapBody(w.W.address, { acceptCostBps: good })), w.deps);
      expect(res.status, String(good)).toBe(200);
    }
  });

  it("Jupiter's format changing is a 503 to retry much later, not a price", async () => {
    const w = await world({ jupiter: fakeJupiter({ unknownFormat: true }) });
    const res = await agentPrepare(post('prepare', swapBody(w.W.address)), w.deps);
    expect(res.status).toBe(503);
    expect(res.headers.get('retry-after')).toBe('300');
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('route-format');
  });

  it('refuses without a valid API key', async () => {
    const w = await world();
    expect((await agentPrepare(post('prepare', swapBody(w.W.address), null), w.deps)).status).toBe(401);
    expect((await agentPrepare(post('prepare', swapBody(w.W.address), 'ori_not_a_key_we_ever_issued'), w.deps)).status).toBe(401);
  });

  it('refuses while swaps are paused, before anything is built', async () => {
    const w = await world({ disabled: true });
    const res = await agentPrepare(post('prepare', swapBody(w.W.address)), w.deps);
    expect(res.status).toBe(503);
    expect((await res.json()).error.code).toBe('paused');
  });

  it('refuses malformed requests with the reason', async () => {
    const w = await world();
    for (const bad of [
      { owner: 'not-an-address' }, { amountIn: '0' }, { amountIn: 1_000_000 }, { amountIn: '1.5' }, { outputMint: USDC },
      { minOut: undefined }, { minOut: '0' }, { minOut: '-1' }, { version: 2 }, { version: 1 },
    ]) {
      const res = await agentPrepare(post('prepare', swapBody(w.W.address, bad)), w.deps);
      expect(res.status, JSON.stringify(bad)).toBe(400);
    }
    expect((await agentPrepare(post('prepare', '[1,2]'), w.deps)).status).toBe(400);
  });

  it('a minimum the market cannot meet is put back to the agent with the new one, never lowered for it', async () => {
    const w = await world();
    const res = await agentPrepare(post('prepare', swapBody(w.W.address, { minOut: String(10n ** 12n) })), w.deps);
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error.code).toBe('price-moved');
    expect(BigInt(body.error.newMinOut)).toBeGreaterThan(0n);
    // A new authorization, not a retry, in a field a program reads.
    expect(body.error.requiresApproval).toBe(true);
  });

  it('a busy Jupiter is a 503 to retry, not a missing route', async () => {
    const honest = fakeJupiter();
    const w = await world({
      jupiter: {
        ...honest,
        async build() {
          const { JupiterError } = await import('@orientim/jupiter');
          throw new JupiterError('Jupiter 429: Too many requests', 429);
        },
      },
    });
    const res = await agentPrepare(post('prepare', swapBody(w.W.address)), w.deps);
    expect(res.status).toBe(503);
    expect((await res.json()).error.code).toBe('busy');
    expect(res.headers.get('retry-after')).toBe('5');
  });
});

describe('a finalize that takes too long', () => {
  // Every RPC method but the ones named answers only when its request is aborted.
  const hanging = (real: AgentDeps['rpc'], answering: string[]) => new Proxy(real as object, {
    get(target, method) {
      const call = (target as Record<string | symbol, unknown>)[method];
      if (typeof call !== 'function' || answering.includes(String(method))) return call;
      return () => ({
        send: ({ abortSignal }: { abortSignal?: AbortSignal } = {}) => new Promise((_, reject) => {
          abortSignal?.addEventListener('abort', () => reject(abortSignal.reason));
        }),
      });
    },
  }) as AgentDeps['rpc'];

  it('ends within its deadline, inside the function limit, and says nothing was sent', async () => {
    expect(FINALIZE_DEADLINE_MS).toBeLessThan(30_000);
    const w = await world();
    const p = await prepared(w);
    const signed = await signAsWallet(w.W, p.transaction);
    w.deps.rpc = hanging(w.deps.rpc, ['getSignatureStatuses']);
    w.deps.finalizeDeadlineMs = 50;
    const started = Date.now();
    const res = await finalize(w, p.ticket, signed);
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.error.code).toBe('unavailable');
    expect(body.error.message).toContain('sent nothing');
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(w.sent).toHaveLength(0);
  });

  it('a send the deadline cuts short is unknown, with the bytes to confirm, never "nothing was sent"', async () => {
    const w = await world();
    const p = await prepared(w);
    const signed = await signAsWallet(w.W, p.transaction);
    const real = w.deps.rpc;
    w.deps.rpc = new Proxy(real as object, {
      get(target, method) {
        const call = (target as Record<string | symbol, unknown>)[method];
        if (method !== 'sendTransaction' || typeof call !== 'function') return call;
        return () => ({
          send: ({ abortSignal }: { abortSignal?: AbortSignal } = {}) => new Promise((_, reject) => {
            abortSignal?.addEventListener('abort', () => reject(abortSignal.reason));
          }),
        });
      },
    }) as AgentDeps['rpc'];
    w.deps.finalizeDeadlineMs = 80;
    const res = await finalize(w, p.ticket, signed);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe('unknown');
    expect(body.signedTransaction).toBeTruthy();
  });
});

describe('finalize', () => {
  it('signs as E the message W signed, and sends it once', async () => {
    const w = await world();
    const p = await prepared(w);
    const res = await finalize(w, p.ticket, await signAsWallet(w.W, p.transaction));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe('sent');
    expect(w.sent).toHaveLength(1);
    const signed = getTransactionDecoder().decode(Buffer.from(body.signedTransaction, 'base64'));
    expect(getSignatureFromTransaction(signed)).toBe(body.signature);
    for (const signer of [w.W.address, p.temporaryAuthority]) {
      const signature = signed.signatures[signer as Address];
      expect(signature).toBeTruthy();
      expect(await verifySignature(await getPublicKeyFromAddress(signer as Address), signature!, signed.messageBytes)).toBe(true);
    }
  });

  it('with send: false, signs as E and sends nothing: the agent sends the same bytes its own way', async () => {
    const w = await world();
    const p = await prepared(w);
    const signedByW = await signAsWallet(w.W, p.transaction);
    const res = await agentFinalize(post('finalize', { ticket: p.ticket, signedTransaction: signedByW, send: false }), w.deps);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe('signed');
    expect(w.sent).toHaveLength(0);
    const signed = getTransactionDecoder().decode(Buffer.from(body.signedTransaction, 'base64'));
    expect(getSignatureFromTransaction(signed)).toBe(signatureOf(signedByW));
    const e = signed.signatures[p.temporaryAuthority as Address];
    expect(await verifySignature(await getPublicKeyFromAddress(p.temporaryAuthority as Address), e!, signed.messageBytes)).toBe(true);
    // Asked again, the same bytes; and send must be true or false.
    const again = await (await agentFinalize(post('finalize', { ticket: p.ticket, signedTransaction: signedByW, send: false }), w.deps)).json();
    expect(again.signedTransaction).toBe(body.signedTransaction);
    const bad = await agentFinalize(post('finalize', { ticket: p.ticket, signedTransaction: signedByW, send: 'no' }), w.deps);
    expect(bad.status).toBe(400);
    expect(w.sent).toHaveLength(0);
  });

  it('the same ticket twice gives the same transaction, which can land once', async () => {
    const w = await world();
    const p = await prepared(w);
    const signed = await signAsWallet(w.W, p.transaction);
    const first = await (await finalize(w, p.ticket, signed)).json();
    const second = await (await finalize(w, p.ticket, signed)).json();
    expect(second.signature).toBe(first.signature);
    expect(second.signedTransaction).toBe(first.signedTransaction);
  });

  // The fee: a message without it, or with any byte changed, is not the message Orientim built.
  for (const [where, at] of [
    ['the first byte', () => 0],
    ['the middle', (len: number) => Math.floor(len / 2)],
    ['the last byte', (len: number) => len - 1],
  ] as const) {
    it(`a message changed at ${where} is refused: E does not sign, nothing is sent`, async () => {
      const w = await world();
      const p = await prepared(w);
      const res = await finalize(w, p.ticket, await signChanged(w.W, p.transaction, at));
      expect(res.status).toBe(400);
      expect((await res.json()).error.code).toBe('transaction-changed');
      expect(w.sent).toHaveLength(0);
    });
  }

  it('an agent that removes the fee transfer, rebuilds and signs the rest is refused', async () => {
    const w = await world();
    const res0 = await agentPrepare(post('prepare', swapBody(w.W.address)), w.deps);
    const p = await res0.json() as Prepared & { policy: { accounts: { feeDestination: string } } };
    const feeTo = p.policy.accounts.feeDestination;
    expect(feeTo).toBeTruthy();
    const tx = getTransactionDecoder().decode(Buffer.from(p.transaction, 'base64'));
    const message = decompileTransactionMessage(getCompiledTransactionMessageDecoder().decode(tx.messageBytes) as never);
    const withoutFee = {
      ...message,
      instructions: message.instructions.filter(ix => !ix.accounts?.some(a => a.address === feeTo)),
    } as typeof message;
    expect(withoutFee.instructions.length).toBe(message.instructions.length - 1);
    const rebuilt = await partiallySignTransaction([w.W.keyPair], compileTransaction(withoutFee as never));
    const r = await finalize(w, p.ticket, Buffer.from(getTransactionEncoder().encode(rebuilt)).toString('base64'));
    expect(r.status).toBe(400);
    expect((await r.json()).error.code).toBe('transaction-changed');
    expect(w.sent).toHaveLength(0);
  });

  it('a transaction W did not sign is refused (R6)', async () => {
    const w = await world();
    const p = await prepared(w);
    const res = await finalize(w, p.ticket, p.transaction);
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe('wallet-changed-transaction');
    expect(w.sent).toHaveLength(0);
  });

  it("a signature in W's place made by another key is refused", async () => {
    const w = await world();
    const p = await prepared(w);
    const tx = getTransactionDecoder().decode(Buffer.from(p.transaction, 'base64'));
    const other = await generateKeyPairSigner();
    const forged = { ...tx, signatures: { ...tx.signatures, [w.W.address]: await signBytes(other.keyPair.privateKey, tx.messageBytes) } };
    const res = await finalize(w, p.ticket, Buffer.from(getTransactionEncoder().encode(forged as never)).toString('base64'));
    expect(res.status).toBe(400);
    expect(w.sent).toHaveLength(0);
  });

  it('a forged ticket is refused', async () => {
    const w = await world();
    const p = await prepared(w);
    const signed = await signAsWallet(w.W, p.transaction);
    const [payload] = p.ticket.split('.');
    const forged = `${payload}.${Buffer.from(new Uint8Array(32)).toString('base64url')}`;
    expect((await finalize(w, forged, signed)).status).toBe(400);
    // A ticket rewritten to point at another message, sealed with a key that is not the server's.
    const opened = (await openTicket(w.deps.secrets, p.ticket))!.ticket;
    const selfSealed = await sealTicket(secret(9), { ...opened, kid: await kidOf(secret(9)) });
    expect((await finalize(w, selfSealed, signed)).status).toBe(400);
    expect(w.sent).toHaveLength(0);
  });

  it("another API key cannot finalize this key's ticket", async () => {
    const w = await world();
    const p = await prepared(w);
    const res = await finalize(w, p.ticket, await signAsWallet(w.W, p.transaction), OTHER_KEY);
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe('invalid-ticket');
    expect(w.sent).toHaveLength(0);
  });

  it('a ticket past its lifetime is refused as expired', async () => {
    const w = await world();
    const p = await prepared(w);
    const late = { ...w, deps: { ...w.deps, rpc: fakeRpc(new Map(), { height: 10_000n, sent: w.sent }) } };
    const signed = await signAsWallet(w.W, p.transaction);
    const res = await finalize(late, p.ticket, signed);
    expect(res.status).toBe(410);
    expect((await res.json()).error.signature).toBe(signatureOf(signed));
    expect(w.sent).toHaveLength(0);
  });

  it('a rotated secret still finalizes the tickets it sealed, while it is listed as previous', async () => {
    const w = await world();
    const p = await prepared(w);
    const signed = await signAsWallet(w.W, p.transaction);
    const rotated = { ...w, deps: { ...w.deps, secrets: [secret(8), secret(7)] } };
    expect((await finalize(rotated, p.ticket, signed)).status).toBe(200);
    const dropped = { ...w, deps: { ...w.deps, secrets: [secret(8)] } };
    expect((await finalize(dropped, p.ticket, signed)).status).toBe(400);
  });

  it('refuses while swaps are paused: E does not sign', async () => {
    const w = await world();
    const p = await prepared(w);
    const paused = { ...w, deps: { ...w.deps, disabled: true } };
    const res = await finalize(paused, p.ticket, await signAsWallet(w.W, p.transaction));
    expect(res.status).toBe(503);
    expect((await res.json()).error.code).toBe('paused');
    expect(w.sent).toHaveLength(0);
  });
});

describe('a finalize repeated after its answer was lost', () => {
  // A swap into BONK: once it lands the output balance has moved, which must not be answered
  // with "prepare again": an agent that did would swap twice.
  async function landedSwap() {
    const w = await world({ landOnSend: true });
    const res = await agentPrepare(post('prepare', swapBody(w.W.address, { outputMint: BONK })), w.deps);
    expect(res.status).toBe(200);
    const p = (await res.json()) as Prepared;
    const signed = await signAsWallet(w.W, p.transaction);
    const first = await (await finalize(w, p.ticket, signed)).json();
    expect(first.status).toBe('sent');
    const arrived = tokenAccount(w.W.address, BONK);
    new DataView(arrived.data.buffer).setBigUint64(64, 5_000n, true);
    w.accounts.set(await ataOf(w.W.address, BONK), arrived);
    return { w, p, signed, first };
  }

  it('answers with the same transaction and sends nothing more, though the output balance moved', async () => {
    const { w, p, signed, first } = await landedSwap();
    const res = await finalize(w, p.ticket, signed);
    expect(res.status).toBe(200);
    const again = await res.json();
    expect(again).toMatchObject({ status: 'sent', signature: first.signature, signedTransaction: first.signedTransaction });
    expect(again.signature).toBe(signatureOf(signed));
    expect(w.sent).toHaveLength(1);
  });

  it('the same after its lifetime ended, and while swaps are paused: nothing is sent again', async () => {
    const { w, p, signed, first } = await landedSwap();
    const rpc = { ...w.deps.rpc, getBlockHeight: () => ({ send: async () => 10_000n }) } as unknown as AgentDeps['rpc'];
    const later = { ...w, deps: { ...w.deps, rpc, disabled: true } };
    const res = await finalize(later, p.ticket, signed);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ status: 'sent', signature: first.signature, signedTransaction: first.signedTransaction });
    expect(w.sent).toHaveLength(1);
  });

  it("a signature in W's place that is not W's gets no answer, even when it is on chain", async () => {
    const { w, p } = await landedSwap();
    // Another landed transaction's signature put in W's place is not a way to obtain E's signature.
    const tx = getTransactionDecoder().decode(Buffer.from(p.transaction, 'base64'));
    const other = await generateKeyPairSigner();
    const forgedSignature = await signBytes(other.keyPair.privateKey, tx.messageBytes);
    const forged = Buffer.from(getTransactionEncoder().encode({ ...tx, signatures: { ...tx.signatures, [w.W.address]: forgedSignature } } as never)).toString('base64');
    w.statuses.set(signatureOf(forged), { confirmationStatus: 'confirmed', err: null });
    const res = await finalize(w, p.ticket, forged);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe('wallet-changed-transaction');
    expect(body.signedTransaction).toBeUndefined();
  });

  it('when the network cannot say whether it was sent, this request sends nothing and names the transaction', async () => {
    const w = await world({ statusFails: true });
    const p = await prepared(w);
    const signed = await signAsWallet(w.W, p.transaction);
    const res = await finalize(w, p.ticket, signed);
    expect(res.status).toBe(503);
    expect(res.headers.get('retry-after')).toBe('5');
    const { error } = await res.json();
    expect(error).toMatchObject({ code: 'unavailable', signature: signatureOf(signed), lastValidBlockHeight: '1000' });
    expect(w.sent).toHaveLength(0);
  });

  it('a transaction the wallet did not sign cannot have been sent, and is refused as such', async () => {
    const w = await world();
    const p = await prepared(w);
    const res = await finalize(w, p.ticket, p.transaction);
    expect(res.status).toBe(400);
    const { error } = await res.json();
    expect(error.code).toBe('wallet-changed-transaction');
    expect(error.signature).toBeUndefined();
  });
});

describe('E, derived rather than stored', () => {
  it('the same secret and nonce give the same E on any instance; another nonce or secret, another E', async () => {
    const a = await ephemeralFor(secret(7), 'nonce-one');
    const b = await ephemeralFor(secret(7), 'nonce-one');
    expect(a.address).toBe(b.address);
    expect((await ephemeralFor(secret(7), 'nonce-two')).address).not.toBe(a.address);
    expect((await ephemeralFor(secret(8), 'nonce-one')).address).not.toBe(a.address);
  });

  it('its private key cannot be exported', async () => {
    const E = await ephemeralFor(secret(7), 'nonce-one');
    expect(E.keyPair.privateKey.extractable).toBe(false);
  });
});

describe('further safeguards on the API', () => {
  it('a swap into a token whose balance moved since prepare is not signed', async () => {
    const w = await world();
    const res = await agentPrepare(post('prepare', swapBody(w.W.address, { outputMint: BONK })), w.deps);
    expect(res.status).toBe(200);
    const p = (await res.json()) as Prepared;
    // Another swap into BONK lands between prepare and finalize.
    const wOut = await ataOf(w.W.address, BONK);
    const landed = tokenAccount(w.W.address, BONK);
    new DataView(landed.data.buffer).setBigUint64(64, 5_000n, true);
    w.accounts.set(wOut, landed);
    const signed = await signAsWallet(w.W, p.transaction);
    const r = await finalize(w, p.ticket, signed);
    expect(r.status).toBe(409);
    const { error } = await r.json();
    expect(error.code).toBe('output-balance-changed');
    // What this request did, and the transaction an earlier finalize may have sent.
    expect(error.signature).toBe(signatureOf(signed));
    expect(error.lastValidBlockHeight).toBe('1000');
    expect(error.message).toContain('this request signed and sent nothing');
    expect(error.message).toContain('earlier finalize');
    expect(w.sent).toHaveLength(0);
  });

  it('a finalize refused by the network hands back no transaction to broadcast', async () => {
    const preflight = new SolanaError(SOLANA_ERROR__JSON_RPC__SERVER_ERROR_SEND_TRANSACTION_PREFLIGHT_FAILURE, {} as never);
    const w = await world({ sendError: preflight });
    const p = await prepared(w);
    const body = await (await finalize(w, p.ticket, await signAsWallet(w.W, p.transaction))).json();
    expect(body.status).toBe('rejected');
    expect(body.signedTransaction).toBeUndefined();
  });

  it('a fee-free swap says 0 bps, not the configured fee', async () => {
    const w = await world({ treasury: null });
    const p = await prepared(w);
    expect(p.amounts.fee).toBe('0');
    expect(p.amounts.feeBps).toBe('0');
  });
});

describe('API keys from the environment', () => {
  it('a fee above the shipped skill and public 30 bps ceiling turns the API off', async () => {
    const { agentDeps } = await import('../lib/server/agent/config.ts');
    process.env.ORIENTIM_API_SECRET = Buffer.alloc(32, 1).toString('base64');
    process.env.ORIENTIM_API_KEYS = `a:${sha('key-one')}`;
    process.env.ORIENTIM_API_FEE_BPS = '31';
    try {
      expect(agentDeps()).toBeNull();
      // Above the site's own fee, 25 bps when it is unset, the API is off too.
      process.env.ORIENTIM_API_FEE_BPS = '30';
      expect(agentDeps()).toBeNull();
      delete process.env.ORIENTIM_API_FEE_BPS;
      expect(agentDeps()?.feeBps).toBe(25n);
      process.env.NEXT_PUBLIC_ORIENTIM_FEE_BPS = '30';
      process.env.ORIENTIM_API_FEE_BPS = '30';
      expect(agentDeps()?.feeBps).toBe(30n);
      process.env.NEXT_PUBLIC_ORIENTIM_FEE_BPS = '20';
      expect(agentDeps()).toBeNull();
    } finally {
      delete process.env.ORIENTIM_API_SECRET;
      delete process.env.ORIENTIM_API_KEYS;
      delete process.env.ORIENTIM_API_FEE_BPS;
      delete process.env.NEXT_PUBLIC_ORIENTIM_FEE_BPS;
    }
  });

  it('two keys with one id: the first one wins, so they never share tickets and limits', async () => {
    const { agentDeps } = await import('../lib/server/agent/config.ts');
    process.env.ORIENTIM_API_SECRET = Buffer.alloc(32, 1).toString('base64');
    process.env.ORIENTIM_API_KEYS = `a:${sha('key-one')},a:${sha('key-two')},b:${sha('key-three')}`;
    try {
      const deps = agentDeps()!;
      expect([...deps.keys.values()]).toEqual(['a', 'b']);
      expect(deps.keys.has(sha('key-one'))).toBe(true);
      expect(deps.keys.has(sha('key-two'))).toBe(false);
    } finally {
      delete process.env.ORIENTIM_API_SECRET;
      delete process.env.ORIENTIM_API_KEYS;
    }
  });

  it('a malformed entry is skipped without taking its id, so it cannot shut out a valid key', async () => {
    const { keysOf } = await import('../lib/server/agent/config.ts');
    const keys = keysOf(`ops:typo,ops:${sha('key-one')},bad id:${sha('key-two')}`);
    expect([...keys.entries()]).toEqual([[sha('key-one'), 'ops']]);
  });
});

describe("the fee, taken like Jupiter's", () => {
  it('a sale into SOL names SOL as the fee token and states the minimum the wallet keeps', async () => {
    const w = await world({ treasuryWallet: true });
    const p = await prepared(w) as unknown as { amounts: Record<string, string>; policy: Record<string, string> };
    expect(p.amounts.feeMint).toBe(WSOL_MINT);
    expect(p.amounts.swapAmount).toBe(p.amounts.amountIn);
    expect(BigInt(p.amounts.minOut) + BigInt(p.amounts.fee)).toBe(BigInt(p.policy.minOut));
  });

  it("without a treasury wallet the sale pays in USDC, the next token in line, from the input", async () => {
    const w = await world();
    const p = await prepared(w) as unknown as { amounts: Record<string, string> };
    expect(p.amounts.feeMint).toBe(USDC);
  });
});

describe('the skill says its version, and an old copy is asked to update', () => {
  const withSkill = (W: Address, version: string | null) => {
    const req = post('prepare', swapBody(W));
    const headers = new Headers(req.headers);
    if (version) headers.set('x-orientim-skill', version);
    return new Request(req.url, { method: 'POST', headers, body: JSON.stringify(swapBody(W)) });
  };

  it('versions compare by major, minor and patch; what is not a version is not judged', () => {
    expect(olderThan('1.0.0', '1.0.1')).toBe(true);
    expect(olderThan('1.9.9', '2.0.0')).toBe(true);
    expect(olderThan('1.10.0', '1.9.0')).toBe(false);
    expect(olderThan('2.0.0', '2.0.0')).toBe(false);
    expect(olderThan('dev', '2.0.0')).toBe(false);
  });

  it('prepare answers an older skill with 426 and the minimum; a current one, or none named, is served', async () => {
    const w = await world();
    w.deps.minSkillVersion = '1.2.0';
    const old = await agentPrepare(withSkill(w.W.address, '1.1.9'), w.deps);
    expect(old.status).toBe(426);
    const body = await old.json();
    expect(body.error.code).toBe('skill-outdated');
    expect(body.error.minimum).toBe('1.2.0');
    expect((await agentPrepare(withSkill(w.W.address, '1.2.0'), w.deps)).status).toBe(200);
    expect((await agentPrepare(withSkill(w.W.address, null), w.deps)).status).toBe(200);
  });

  it('a swap already signed is finalized whatever the skill that signed it', async () => {
    const w = await world();
    const p = await prepared(w);
    w.deps.minSkillVersion = '9.0.0';
    const req = post('finalize', { ticket: p.ticket, signedTransaction: await signAsWallet(w.W, p.transaction) });
    const headers = new Headers(req.headers);
    headers.set('x-orientim-skill', '1.0.0');
    const res = await agentFinalize(new Request(req.url, { method: 'POST', headers, body: await req.text() }), w.deps);
    expect(res.status).toBe(200);
  });
});

describe("an RPC that answers but cannot serve the request is unavailable, not an internal error", () => {
  it('prepare answers 503 unavailable with a Retry-After when the RPC has no such method', async () => {
    const w = await world();
    const missing = new SolanaError(SOLANA_ERROR__JSON_RPC__METHOD_NOT_FOUND, { __serverMessage: 'Method not found' } as never);
    w.deps.rpc = new Proxy({}, { get: () => () => ({ send: async () => { throw missing; } }) }) as AgentDeps['rpc'];
    const res = await agentPrepare(post('prepare', swapBody(w.W.address)), w.deps);
    expect(res.status).toBe(503);
    expect(res.headers.get('retry-after')).toBe('5');
    expect((await res.json()).error.code).toBe('unavailable');
    expect(w.sent).toHaveLength(0);
  });

  it('prepare answers unavailable, not internal, when a node stays behind the slot of an earlier read', async () => {
    const w = await world();
    const behind = new SolanaError(SOLANA_ERROR__JSON_RPC__SERVER_ERROR_MIN_CONTEXT_SLOT_NOT_REACHED, { contextSlot: 1n });
    w.deps.rpc = new Proxy({}, { get: () => () => ({ send: async () => { throw behind; } }) }) as AgentDeps['rpc'];
    const res = await agentPrepare(post('prepare', swapBody(w.W.address)), w.deps);
    expect(res.status).toBe(503);
    expect((await res.json()).error.code).toBe('unavailable');
    expect(w.sent).toHaveLength(0);
  });
});

describe("a swap whose fee cannot be collected is refused, never built free", () => {
  it('prepare answers 503 fee-unavailable, with a Retry-After, and signs nothing', async () => {
    const w = await world();
    // No USDC account and no wallet for the treasury: the fee of USDC → SOL has nowhere to go.
    w.accounts.delete(await ataOf(TREASURY, USDC));
    const res = await agentPrepare(post('prepare', swapBody(w.W.address)), w.deps);
    expect(res.status).toBe(503);
    expect(res.headers.get('retry-after')).toBe('60');
    const body = await res.json();
    expect(body.error.code).toBe('fee-unavailable');
    expect(w.sent).toHaveLength(0);
  });
});

describe('a self-serve key, end to end (API access)', () => {
  it('prepares and finalizes for its own wallet, like a key issued by hand; another key cannot finalize it', async () => {
    const w = await world();
    w.deps.keySecrets = [secret(9)];
    const { key } = await issueKey(secret(9), w.W.address, Math.floor(Date.now() / 1000));
    const res = await agentPrepare(post('prepare', swapBody(w.W.address), key), w.deps);
    expect(res.status).toBe(200);
    const p = await res.json() as Prepared;
    expect((await openTicket(w.deps.secrets, p.ticket))?.ticket.key).toBe(`w:${w.W.address}`);
    const signed = await signAsWallet(w.W, p.transaction);
    expect((await finalize(w, p.ticket, signed, KEY)).status).toBe(400);
    const fin = await finalize(w, p.ticket, signed, key);
    expect(fin.status).toBe(200);
    expect(((await fin.json()) as { status: string }).status).toBe('sent');
    expect(w.sent).toHaveLength(1);
  });
});

describe('a route below the open market is put to the user, in fields a program can read', () => {
  it('prepare answers 409 costs-more with the gap; with acceptCostBps at that gap it is built', async () => {
    const w = await world({ jupiter: fakeJupiter({ worseByBps: 1_000n }) });
    const res = await agentPrepare(post('prepare', swapBody(w.W.address)), w.deps);
    expect(res.status).toBe(409);
    const { error } = await res.json() as { error: { code: string; gapBps: string; outAmount: string; baselineOut: string; requiresApproval: boolean; retry: string } };
    expect(error).toMatchObject({ code: 'costs-more', requiresApproval: true });
    expect(Number(error.gapBps)).toBeGreaterThanOrEqual(1_000);
    expect(BigInt(error.outAmount)).toBeLessThan(BigInt(error.baselineOut));
    expect(error.retry).toContain('acceptCostBps');
    const accepted = await agentPrepare(post('prepare', swapBody(w.W.address, { acceptCostBps: error.gapBps })), w.deps);
    expect(accepted.status).toBe(200);
    expect(w.sent).toHaveLength(0);
  });
});

describe('a prepare that takes too long', () => {
  it('ends in unavailable within its deadline, before the function limit and the skill stop waiting', async () => {
    expect(PREPARE_DEADLINE_MS).toBeLessThan(60_000);
    const slow = new Promise<string>(resolve => setTimeout(() => resolve('late'), 200));
    await expect(withinDeadline(slow, 20)).rejects.toMatchObject({ code: 'unavailable' });
    await expect(withinDeadline(Promise.resolve('on time'), 20)).resolves.toBe('on time');
  });

  // The deadline covers the whole prepare: a slow read of the mints before the build counts.
  it('a slow first read of the mints counts against the one deadline, and its request is aborted', async () => {
    const w = await world();
    let aborted = false;
    const real = w.deps.rpc;
    w.deps.rpc = new Proxy(real as object, {
      get(target, method) {
        const call = (target as Record<string | symbol, unknown>)[method];
        if (method !== 'getMultipleAccounts' || typeof call !== 'function') return call;
        return () => ({
          send: ({ abortSignal }: { abortSignal?: AbortSignal } = {}) => new Promise((_, reject) => {
            abortSignal?.addEventListener('abort', () => { aborted = true; reject(abortSignal.reason); });
          }),
        });
      },
    }) as AgentDeps['rpc'];
    w.deps.prepareDeadlineMs = 50;
    const started = Date.now();
    const res = await agentPrepare(post('prepare', swapBody(w.W.address)), w.deps);
    expect(res.status).toBe(503);
    expect((await res.json()).error.code).toBe('unavailable');
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(aborted).toBe(true);
  });

  it('a slow Jupiter ends the prepare at the deadline, and no request to it starts afterwards', async () => {
    const base = fakeJupiter();
    let calls = 0;
    const slow: AgentDeps['jupiter'] = { ...base, build: async p => { calls++; await new Promise(r => setTimeout(r, 80)); return base.build(p); } };
    const w = await world({ jupiter: slow });
    w.deps.prepareDeadlineMs = 60;
    const res = await agentPrepare(post('prepare', swapBody(w.W.address)), w.deps);
    expect(res.status).toBe(503);
    expect((await res.json()).error.code).toBe('unavailable');
    const atDeadline = calls;
    await new Promise(r => setTimeout(r, 400));
    expect(calls).toBe(atDeadline);
    expect(w.sent).toHaveLength(0);
  });
});

describe("routes the agent brings from Jupiter with its own key", () => {
  type Asked = { error: { code: string; session: string; taker: string; requests: Record<string, unknown>[] } };
  const paramsOf = (r: Record<string, unknown>) => ({
    inputMint: address(r.inputMint as string), outputMint: address(r.outputMint as string), amount: BigInt(r.amount as string),
    taker: address(r.taker as string), slippageBps: r.slippageBps as number, maxAccounts: r.maxAccounts as number,
    ...(r.destinationTokenAccount ? { destinationTokenAccount: address(r.destinationTokenAccount as string) } : {}),
    ...(r.excludeDexes ? { excludeDexes: r.excludeDexes as string[] } : {}),
  });
  /** Orientim's own client, counting what is asked of its key. */
  const counting = () => {
    const asked: unknown[] = [];
    return { asked, jupiter: fakeJupiter({ asked: asked as never }) };
  };

  it('prepare asks for the routes it needs, the agent fetches them, and the swap is built without Orientim\'s key', async () => {
    const own = counting();
    const w = await world({ jupiter: own.jupiter });
    const agentMarket = fakeJupiter();
    const routes: { params: Record<string, unknown>; response: unknown }[] = [];
    let session: string | undefined;
    let res: Response | undefined;
    for (let round = 0; round < 6; round++) {
      res = await agentPrepare(post('prepare', swapBody(w.W.address, { ownRoutes: true, routes, ...(session ? { session } : {}) })), w.deps);
      if (res.status !== 409) break;
      const asked = (await res.json() as Asked).error;
      expect(asked.code).toBe('routes-needed');
      session = asked.session;
      for (const r of asked.requests) {
        expect(r.taker).toBe(asked.taker);
        routes.push({ params: r, response: await agentMarket.build(paramsOf(r)) });
      }
    }
    expect(res!.status).toBe(200);
    const p = await res!.json() as Prepared;
    expect(p.temporaryAuthority).toBe((await openSessionOf(session!)).taker);
    expect(own.asked).toHaveLength(0);
    // Finalize as ever: the wallet signs, E signs last.
    const fin = await agentFinalize(post('finalize', { ticket: p.ticket, signedTransaction: await signAsWallet(w.W, p.transaction) }), w.deps);
    expect(fin.status).toBe(200);
  });

  it('a session opens only for the swap and the key it was sealed for, and routes come only with ownRoutes', async () => {
    const w = await world();
    const first = await agentPrepare(post('prepare', swapBody(w.W.address, { ownRoutes: true })), w.deps);
    expect(first.status).toBe(409);
    const { session } = (await first.json() as Asked).error;
    for (const [body, key] of [
      [swapBody(w.W.address, { ownRoutes: true, session, amountIn: '2000000' }), KEY],
      [swapBody(w.W.address, { ownRoutes: true, session, outputMint: BONK }), KEY],
      [swapBody(w.W.address, { ownRoutes: true, session }), OTHER_KEY],
      [swapBody(w.W.address, { ownRoutes: true, session: `${session}x` }), KEY],
    ] as const) {
      const res = await agentPrepare(post('prepare', body, key), w.deps);
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect((await res.json()).error.code).toBe('bad-session');
    }
    for (const body of [swapBody(w.W.address, { routes: [] }), swapBody(w.W.address, { session }), swapBody(w.W.address, { ownRoutes: 'yes' })]) {
      expect((await agentPrepare(post('prepare', body), w.deps)).status).toBe(400);
    }
    expect(w.sent).toHaveLength(0);
  });

  it('a route that does not answer the swap is refused like a bad answer from Jupiter, and nothing is built', async () => {
    const w = await world();
    const first = await agentPrepare(post('prepare', swapBody(w.W.address, { ownRoutes: true })), w.deps);
    const asked = (await first.json() as Asked).error;
    // Built for twice the amount: not this swap.
    const lying = fakeJupiter({ inAmountFactor: 2n });
    const routes = await Promise.all(asked.requests.map(async r => ({ params: r, response: await lying.build(paramsOf(r)) })));
    const res = await agentPrepare(post('prepare', swapBody(w.W.address, { ownRoutes: true, session: asked.session, routes })), w.deps);
    expect(res.status).toBe(422);
    expect((await res.json()).error.code).toBe('bad-quote');
  });

  it("routes that build a transaction Orientim's verifier refuses (delivering elsewhere) are not used: Orientim builds with its own key", async () => {
    const own = counting();
    const w = await world({ jupiter: own.jupiter });
    // The agent's Jupiter answers for another destination than the one Orientim asked for.
    const elsewhere = (await generateKeyPairSigner()).address;
    const honest = fakeJupiter();
    const misdirected = { ...honest, build: (q: Parameters<typeof honest.build>[0]) => honest.build({ ...q, destinationTokenAccount: elsewhere }) } as ReturnType<typeof fakeJupiter>;
    const res = await inRounds(w, misdirected);
    expect(res.status).toBe(200);
    // Built with Orientim's key: the protected routes were asked of it, and the swap finalizes.
    expect(own.asked.some(a => (a as { excludeDexes?: string[] }).excludeDexes?.includes('HumidiFi'))).toBe(true);
    const p = await res.json() as Prepared;
    const fin = await agentFinalize(post('finalize', { ticket: p.ticket, signedTransaction: await signAsWallet(w.W, p.transaction) }), w.deps);
    expect(fin.status).toBe(200);
  });

  /** Prepare in rounds, the agent fetching every route asked for from `agentMarket`. */
  async function inRounds(w: Awaited<ReturnType<typeof world>>, agentMarket: ReturnType<typeof fakeJupiter>, onRound?: (round: number) => void) {
    const routes: { params: Record<string, unknown>; response: unknown }[] = [];
    let session: string | undefined;
    let res: Response | undefined;
    for (let round = 0; round < 6; round++) {
      onRound?.(round);
      res = await agentPrepare(post('prepare', swapBody(w.W.address, { ownRoutes: true, routes, ...(session ? { session } : {}) })), w.deps);
      if (res.status !== 409) break;
      const asked = (await res.json() as Asked).error;
      session = asked.session;
      for (const r of asked.requests) routes.push({ params: r, response: await agentMarket.build(paramsOf(r)) });
    }
    return res!;
  }
  /** The fee of the same swap built with Orientim's own key. */
  async function feeWithOrientimsKey(treasuryWallet: boolean) {
    const w = await world({ treasuryWallet });
    const res = await agentPrepare(post('prepare', swapBody(w.W.address)), w.deps);
    expect(res.status).toBe(200);
    return (await res.json() as Prepared).amounts.fee;
  }

  it('with a fee on the output, the routes are held to Orientim\'s own price: one ask of its key, and the same fee', async () => {
    const own = counting();
    const w = await world({ jupiter: own.jupiter, treasuryWallet: true });
    const askedBefore: number[] = [];
    const res = await inRounds(w, fakeJupiter(), () => askedBefore.push(own.asked.length));
    expect(res.status).toBe(200);
    const p = await res.json() as Prepared & { amounts: { feeMint: string } };
    expect(p.amounts.feeMint).toBe(WSOL_MINT);
    // The round that only learns which routes to bring asks Orientim's key nothing.
    expect(askedBefore[1]).toBe(0);
    // The baseline alone, unrestricted: the protected routes are the agent's.
    expect(own.asked).toHaveLength(1);
    expect((own.asked[0] as { excludeDexes?: string[] }).excludeDexes ?? []).toEqual([]);
    expect(p.amounts.fee).toBe(await feeWithOrientimsKey(true));
  });

  it('a route that understates its output 100 times does not lower the fee: Orientim builds the swap with its own key', async () => {
    const own = counting();
    const w = await world({ jupiter: own.jupiter, treasuryWallet: true });
    const res = await inRounds(w, fakeJupiter({ out: OUT / 100n }));
    expect(res.status).toBe(200);
    const p = await res.json() as Prepared;
    const honest = await feeWithOrientimsKey(true);
    expect(BigInt(p.amounts.fee)).toBeGreaterThan(0n);
    expect(p.amounts.fee).toBe(honest);
    // Built with Orientim's key: the protected routes were asked of it, with the exclusion.
    expect(own.asked.some(a => (a as { excludeDexes?: string[] }).excludeDexes?.includes('HumidiFi'))).toBe(true);
    const fin = await agentFinalize(post('finalize', { ticket: p.ticket, signedTransaction: await signAsWallet(w.W, p.transaction) }), w.deps);
    expect(fin.status).toBe(200);
  });

  it('the fee on the output, exactly as documented: 0.25% of the guaranteed minimum, the route held within 1% of Orientim\'s price', async () => {
    const honest = BigInt(await feeWithOrientimsKey(true));
    for (const below of [0n, 50n, 100n, 200n, 9_900n]) {
      const own = counting();
      const w = await world({ jupiter: own.jupiter, treasuryWallet: true });
      const agentOut = OUT - (OUT * below) / 10_000n;
      // A route 1% below the market costs more than the 0.5% the user is asked about: approved here.
      const { res } = await roundsWith(w, fakeJupiter({ out: agentOut }), () => ({ acceptCostBps: 200 }));
      expect(res.status, `${below} bps`).toBe(200);
      const p = await res.json() as Prepared & { amounts: { minOut: string } };
      const fee = BigInt(p.amounts.fee);
      const keeps = BigInt(p.amounts.minOut);
      // The minimum the transaction enforces is what the wallet keeps plus the fee; the fee is
      // feeBps (20 here) of it, rounded down.
      expect(fee, `${below} bps`).toBe(((keeps + fee) * 20n) / 10_000n);
      // Within 1%, the agent's route sets the minimum; beyond it, Orientim's own routes do.
      if (below <= 100n) expect((keeps + fee) * 10_000n, `${below} bps`).toBe(((agentOut * 9_950n) / 10_000n) * 10_000n);
      else expect(fee, `${below} bps`).toBe(honest);
      // Never more than 1% below the fee of Orientim's own routes, and the wallet's minimum is kept.
      expect(fee * 10_000n, `${below} bps`).toBeGreaterThanOrEqual(honest * 9_900n);
      expect(keeps, `${below} bps`).toBeGreaterThanOrEqual(1n);
    }
  });

  it('a route only 0.5% below Orientim\'s price is the agent\'s to use; 2% below, Orientim builds it', async () => {
    for (const [below, builtByOrientim] of [[50n, false], [200n, true]] as const) {
      const own = counting();
      const w = await world({ jupiter: own.jupiter, treasuryWallet: true });
      const res = await inRounds(w, fakeJupiter({ out: OUT - (OUT * below) / 10_000n }));
      expect(res.status, `${below} bps`).toBe(200);
      expect(own.asked.some(a => (a as { excludeDexes?: string[] }).excludeDexes?.length), `${below} bps`).toBe(builtByOrientim);
    }
  });

  /** The agent's market: routes wider than 48 accounts do not fit, so the build takes three rounds. */
  async function narrowMarket() {
    const extra = await Promise.all(Array.from({ length: 60 }, async () => (await generateKeyPairSigner()).address));
    const wide = fakeJupiter({ extraAccounts: extra });
    const narrow = fakeJupiter();
    return { ...narrow, build: (q: Parameters<typeof narrow.build>[0]) => ((q.maxAccounts ?? 64) > 48 ? wide.build(q) : narrow.build(q)) } as ReturnType<typeof fakeJupiter>;
  }
  /** Rounds as the skill makes them, with a body of its own for each round. */
  async function roundsWith(w: Awaited<ReturnType<typeof world>>, agentMarket: ReturnType<typeof fakeJupiter>, extra: (round: number) => Record<string, unknown> = () => ({})) {
    const routes: { params: Record<string, unknown>; response: unknown }[] = [];
    let session: string | undefined;
    let res: Response | undefined;
    let rounds = 0;
    for (; rounds < 8; rounds++) {
      res = await agentPrepare(post('prepare', swapBody(w.W.address, { ownRoutes: true, routes, ...(session ? { session } : {}), ...extra(rounds) })), w.deps);
      if (res.status !== 409) break;
      const asked = (await res.json() as Asked).error;
      session = asked.session;
      for (const r of asked.requests) routes.push({ params: r, response: await agentMarket.build(paramsOf(r)) });
    }
    return { res: res!, rounds: rounds + 1 };
  }
  const baselineAsks = (asked: unknown[]) => asked.filter(a => !(a as { excludeDexes?: string[] }).excludeDexes?.length).length;

  it('three rounds within the price\'s freshness ask Orientim\'s key for its price once', async () => {
    const own = counting();
    const w = await world({ jupiter: own.jupiter, treasuryWallet: true });
    const { res, rounds } = await roundsWith(w, await narrowMarket());
    expect(res.status).toBe(200);
    expect(rounds).toBe(3);
    expect(own.asked).toHaveLength(1);
    expect(baselineAsks(own.asked)).toBe(1);
  });

  it('an expired price, or a round asking another tolerance, is asked for again', async () => {
    const expired = counting();
    const w = await world({ jupiter: expired.jupiter, treasuryWallet: true });
    expect((await roundsWith(w, await narrowMarket())).res.status).toBe(200);
    const w2 = await world({ jupiter: expired.jupiter, treasuryWallet: true });
    expired.asked.length = 0;
    const r2 = await roundsWith({ ...w2, deps: { ...w2.deps, referenceFreshMs: -1 } }, await narrowMarket());
    expect(r2.res.status).toBe(200);
    expect(baselineAsks(expired.asked)).toBe(2);
    const other = counting();
    const w3 = await world({ jupiter: other.jupiter, treasuryWallet: true });
    // The last round asks another tolerance: a price asked for 0.5% is not the one for 1%.
    const r3 = await roundsWith(w3, await narrowMarket(), round => (round === 2 ? { slippageBps: 100 } : {}));
    expect(r3.res.status).toBe(200);
    expect(baselineAsks(other.asked)).toBe(2);
  });

  it('the operator counts each swap and whose routes built it, in one JSON line per event, never a key\'s secret', async () => {
    const lines: string[] = [];
    const spy = vi.spyOn(console, 'info').mockImplementation((line: unknown) => { lines.push(String(line)); });
    try {
      const own = counting();
      const w = await world({ jupiter: own.jupiter, treasuryWallet: true });
      // Routes 100 times below Orientim's price: not used, built with its key.
      const res = await observed('prepare', () => inRounds(w, fakeJupiter({ out: OUT / 100n })));
      expect(res.status).toBe(200);
    } finally {
      spy.mockRestore();
    }
    const events = lines.map(l => JSON.parse(l) as Record<string, unknown>);
    expect(events.some(e => e.event === 'orientim.routes_needed')).toBe(true);
    expect(events.find(e => e.event === 'orientim.routes_not_used')?.reason).toMatch(/below Orientim's own price/);
    expect(events.find(e => e.event === 'orientim.prepared')).toMatchObject({ routes: 'orientim-fallback', feeSide: 'output' });
    expect(events.find(e => e.event === 'orientim.reference_price')).toMatchObject({ why: 'none' });
    expect(events.at(-1)).toMatchObject({ event: 'orientim.prepare', http: 200 });
    expect(lines.join('\n')).not.toContain(KEY);
  });

  it('an observed error is counted by its code', async () => {
    const lines: string[] = [];
    const spy = vi.spyOn(console, 'info').mockImplementation((line: unknown) => { lines.push(String(line)); });
    try {
      await observed('prepare', async () => Response.json({ error: { code: 'busy', message: 'm' } }, { status: 503 }));
      await observed('finalize', async () => Response.json({ signature: 's', status: 'unknown' }));
    } finally {
      spy.mockRestore();
    }
    expect(JSON.parse(lines[0])).toMatchObject({ event: 'orientim.prepare', http: 503, code: 'busy' });
    expect(JSON.parse(lines[1])).toMatchObject({ event: 'orientim.finalize', http: 200, status: 'unknown' });
  });

  it('a refusal by the check is counted with its rules and reason, with no address or signature in the line', async () => {
    const lines: string[] = [];
    const spy = vi.spyOn(console, 'info').mockImplementation((line: unknown) => { lines.push(String(line)); });
    const mint = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263';
    try {
      await observed('prepare', async () => Response.json({ error: {
        code: 'verification-failed', message: 'A protected transaction cannot be produced.',
        violations: [{ rule: 'R7', detail: `mint ${mint}: transfer hook` }, { rule: 'R1', detail: "the wallet's output token account is frozen" }],
      } }, { status: 422 }));
    } finally {
      spy.mockRestore();
    }
    const line = JSON.parse(lines[0]);
    expect(line).toMatchObject({ event: 'orientim.prepare', http: 422, code: 'verification-failed', rules: 'R7,R1', reason: 'mint …: transfer hook' });
    expect(lines[0]).not.toContain(mint);
  });

  it('a reason written to a log line names no address or signature, and is cut to its length', () => {
    const mint = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263';
    expect(maskedReason(`route delivers to ${mint}, not the wallet`, 200)).toBe('route delivers to …, not the wallet');
    expect(maskedReason('no route. '.repeat(30), 200)).toHaveLength(200);
  });

  it('an unexpected error is logged with every URL cut to its host and every address masked', () => {
    const wallet = 'GfGp9SdvbVBPnsbhSBvfLkX7RLigmhXees4Vm6pRSiiA';
    const e = new Error(`fetch https://mainnet.helius-rpc.com/?api-key=SECRET123 failed for ${wallet}`, {
      cause: new Error('upstream https://solana-mainnet.g.alchemy.com/v2/KEY456 refused'),
    });
    const line = loggableError(e);
    expect(line).toContain('https://mainnet.helius-rpc.com/…');
    expect(line).toContain('https://solana-mainnet.g.alchemy.com/…');
    expect(line).not.toContain('SECRET123');
    expect(line).not.toContain('KEY456');
    expect(line).not.toContain(wallet);
    expect(loggableError('plain text')).toBe('plain text');
  });

  it('without Orientim\'s program labels an excluded DEX cannot be checked: the swap is built with its own key', async () => {
    const asked: unknown[] = [];
    const w = await world({ jupiter: fakeJupiter({ asked: asked as never, labels: 'down' }) });
    const res = await inRounds(w, fakeJupiter());
    expect(res.status).toBe(200);
    expect(asked.some(a => (a as { excludeDexes?: string[] }).excludeDexes?.includes('HumidiFi'))).toBe(true);
    // Labels that do not name an excluded DEX cannot tell it either.
    const asked2: unknown[] = [];
    const w2 = await world({ jupiter: fakeJupiter({ asked: asked2 as never, labels: { [DEX]: 'Whirlpool' } }) });
    expect((await inRounds(w2, fakeJupiter())).status).toBe(200);
    expect(asked2.some(a => (a as { excludeDexes?: string[] }).excludeDexes?.includes('HumidiFi'))).toBe(true);
  });

  it('the first round of own routes may come without minOut; no round that could build does', async () => {
    const w = await world();
    const { minOut: _m, ...noMin } = swapBody(w.W.address);
    const first = await agentPrepare(post('prepare', { ...noMin, ownRoutes: true }), w.deps);
    expect(first.status).toBe(409);
    const asked = (await first.json() as Asked).error;
    const agentMarket = fakeJupiter();
    const routes = await Promise.all(asked.requests.map(async r => ({ params: r, response: await agentMarket.build(paramsOf(r)) })));
    // With routes, or with a session, or without own routes: minOut is required, as ever.
    for (const body of [{ ...noMin, ownRoutes: true, session: asked.session, routes }, { ...noMin, ownRoutes: true, session: asked.session }, noMin]) {
      const res = await agentPrepare(post('prepare', body), w.deps);
      expect(res.status, JSON.stringify(Object.keys(body))).toBe(400);
      expect((await res.json()).error.message).toMatch(/minOut is required/);
    }
    // Where own routes are off, a first round without minOut is refused too: it would build.
    expect((await agentPrepare(post('prepare', { ...noMin, ownRoutes: true }), { ...w.deps, ownRoutes: false })).status).toBe(400);
    const done = await agentPrepare(post('prepare', swapBody(w.W.address, { ownRoutes: true, session: asked.session, routes })), w.deps);
    expect(done.status).toBe(200);
  });

  it('a session ends two minutes after the first round, however many rounds follow', async () => {
    const w = await world();
    const expOf = (session: string) => (JSON.parse(Buffer.from(session.split('.')[0], 'base64url').toString('utf8')) as { exp: number }).exp;
    const first = (await (await agentPrepare(post('prepare', swapBody(w.W.address, { ownRoutes: true })), w.deps)).json() as Asked).error;
    await new Promise(r => setTimeout(r, 1_100));
    const second = (await (await agentPrepare(post('prepare', swapBody(w.W.address, { ownRoutes: true, session: first.session })), w.deps)).json() as Asked).error;
    expect(second.code).toBe('routes-needed');
    expect(expOf(second.session)).toBe(expOf(first.session));
    expect(second.taker).toBe(first.taker);
  });

  it('where own routes are off, ownRoutes is ignored and Orientim builds with its own key', async () => {
    const w = await world();
    const res = await agentPrepare(post('prepare', swapBody(w.W.address, { ownRoutes: true, routes: [] })), { ...w.deps, ownRoutes: false });
    expect(res.status).toBe(200);
    expect((await res.json() as Prepared).ticket).toBeTruthy();
  });
});

/** The taker a session was opened for, read from its payload (the MAC is checked by the server). */
async function openSessionOf(session: string) {
  const payload = JSON.parse(Buffer.from(session.split('.')[0], 'base64url').toString('utf8')) as { nonce: string };
  return { taker: (await ephemeralFor(secret(7), payload.nonce)).address };
}
