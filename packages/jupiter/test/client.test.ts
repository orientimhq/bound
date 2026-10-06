/**
 * Jupiter is untrusted, including the shape of its answers: a malformed quote must fail as a
 * JupiterError, not as a crash further down the pipeline.
 */
import { describe, expect, it } from 'vitest';
import { address } from '@solana/kit';
import { checkBuildResponse, createJupiterClient, JupiterError } from '../src/client.ts';

const good = {
  inputMint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
  outputMint: 'So11111111111111111111111111111111111111112',
  inAmount: '100000000',
  outAmount: '450000000',
  otherAmountThreshold: '447750000',
  routePlan: [{ percent: 100, swapInfo: { label: 'Whirlpool', ammKey: 'x' } }],
  computeBudgetInstructions: [],
  setupInstructions: [],
  swapInstruction: { programId: 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4', accounts: [], data: '' },
  cleanupInstruction: null,
  otherInstructions: [],
  addressesByLookupTableAddress: null,
};

describe('Jupiter /build responses are validated', () => {
  it('adds mode=fast only for an explicit fast request', async () => {
    const urls: string[] = [];
    const client = createJupiterClient({
      buildUrl: 'https://jupiter.test/build', tokensUrl: 'https://jupiter.test/tokens', labelsUrl: 'https://jupiter.test/labels',
      fetchImpl: (async (url: string) => { urls.push(url); return Response.json(good); }) as typeof fetch,
    });
    const params = {
      inputMint: address(good.inputMint), outputMint: address(good.outputMint), amount: 100_000_000n,
      taker: address('11111111111111111111111111111111'), slippageBps: 50, maxAccounts: 64,
    };
    await client.build(params);
    await client.build({ ...params, mode: 'fast' });
    expect(new URL(urls[0]).searchParams.has('mode')).toBe(false);
    expect(new URL(urls[1]).searchParams.get('mode')).toBe('fast');
  });
  it('a well-formed quote passes unchanged', () => {
    expect(checkBuildResponse(good)).toBe(good);
  });

  const bad: [string, unknown][] = [
    ['a non-numeric amount', { ...good, outAmount: '4.5e8' }],
    ['a negative floor', { ...good, otherAmountThreshold: '-1' }],
    ['a missing floor', { ...good, otherAmountThreshold: undefined }],
    ['a missing swap instruction', { ...good, swapInstruction: undefined }],
    ['a swap instruction without accounts', { ...good, swapInstruction: { ...good.swapInstruction, accounts: null } }],
    ['no route plan', { ...good, routePlan: null }],
    ['a body that is not an object', 'oops'],
    // What a build reads further down: a missing label crashed the route's naming with a TypeError.
    ['a route step without a label', { ...good, routePlan: [{ percent: 100 }] }],
    ['an account without its roles', { ...good, swapInstruction: { ...good.swapInstruction, accounts: [{ pubkey: good.inputMint }] } }],
    ['a setup instruction without data', { ...good, setupInstructions: [{ programId: good.inputMint, accounts: [] }] }],
    ['lookup tables that are not lists of addresses', { ...good, addressesByLookupTableAddress: { x: 'y' } }],
    ['no mints', { ...good, inputMint: undefined }],
    // Values, not only shapes: what cannot be decoded would crash the build instead of being refused.
    ['a program that is not an address', { ...good, swapInstruction: { ...good.swapInstruction, programId: 'not-an-address' } }],
    ['an account that is not an address', { ...good, swapInstruction: { ...good.swapInstruction, accounts: [{ pubkey: '0OIl', isSigner: false, isWritable: true }] } }],
    ['data that is not base64', { ...good, swapInstruction: { ...good.swapInstruction, data: '***' } }],
    ['a lookup table key that is not an address', { ...good, addressesByLookupTableAddress: { nope: [good.inputMint] } }],
    ['a lookup table entry that is not an address', { ...good, addressesByLookupTableAddress: { [good.inputMint]: ['nope'] } }],
    ['a mint that is not an address', { ...good, outputMint: 'USDC' }],
  ];
  for (const [name, body] of bad) {
    it(`${name} is refused with a JupiterError`, () => {
      expect(() => checkBuildResponse(body)).toThrow(JupiterError);
    });
  }

  it('the client applies the check to every /build answer', async () => {
    const client = createJupiterClient({
      buildUrl: 'https://jupiter.test/build',
      tokensUrl: 'https://jupiter.test/tokens',
      labelsUrl: 'https://jupiter.test/labels',
      fetchImpl: (async () => new Response(JSON.stringify({ ...good, inAmount: 'abc' }))) as unknown as typeof fetch,
    });
    await expect(
      client.build({
        inputMint: address(good.inputMint), outputMint: address(good.outputMint), amount: 100_000_000n,
        taker: address('11111111111111111111111111111111'), slippageBps: 50, maxAccounts: 64,
      }),
    ).rejects.toThrow('malformed quote');
  });
});

describe('a Jupiter under load', () => {
  const params = {
    inputMint: address(good.inputMint), outputMint: address(good.outputMint), amount: 100_000_000n,
    taker: address('11111111111111111111111111111111'), slippageBps: 50, maxAccounts: 64,
  };
  const clientAnswering = (statuses: number[], counter: { calls: number }) => createJupiterClient({
    buildUrl: 'https://jupiter.test/build', tokensUrl: 'https://jupiter.test/tokens', labelsUrl: 'https://jupiter.test/labels',
    retryBaseMs: 1,
    fetchImpl: (async () => {
      const status = statuses[Math.min(counter.calls++, statuses.length - 1)];
      return status === 200 ? new Response(JSON.stringify(good)) : new Response('{"error":"Too many requests"}', { status });
    }) as unknown as typeof fetch,
  });

  it('a 429 is retried, and the answer that follows is used', async () => {
    const counter = { calls: 0 };
    expect((await clientAnswering([429, 429, 200], counter).build(params)).outAmount).toBe(good.outAmount);
    expect(counter.calls).toBe(3);
  });

  it("a 400 around a stale oracle is asked again; a 400 refusing the trade is not", async () => {
    const answering = (bodies: string[], counter: { calls: number }) => createJupiterClient({
      buildUrl: 'https://jupiter.test/build', tokensUrl: 'https://jupiter.test/tokens', labelsUrl: 'https://jupiter.test/labels',
      retryBaseMs: 1,
      fetchImpl: (async () => {
        const body = bodies[Math.min(counter.calls++, bodies.length - 1)];
        return body === 'ok' ? new Response(JSON.stringify(good)) : new Response(body, { status: 400 });
      }) as unknown as typeof fetch,
    });
    // A token program Jupiter's own service could not find, inside its 500: its index lagging behind a
    // new Pump.fun token, which passes a few seconds later on mainnet.
    for (const busy of ['{"error":"Oracle price out of date. Pair temporarily unavailable"}', '{"error":"500: Oracle is stale"}', '{"error":"The price was expired"}', '{"error":"500: {\\"error\\":\\"Missing token program for Xpump\\"}"}']) {
      const counter = { calls: 0 };
      expect((await answering([busy, 'ok'], counter).build(params)).outAmount).toBe(good.outAmount);
      expect(counter.calls).toBe(2);
    }
    for (const refusal of ['{"error":"No routes found"}', '{"error":"Missing token program for X pump"}', '{"error":"inputMint cannot be same as outputMint, oracle"}']) {
      const counter = { calls: 0 };
      await expect(answering([refusal, 'ok'], counter).build(params)).rejects.toMatchObject({ status: 400 });
      expect(counter.calls).toBe(1);
    }
  });

  it('after every retry was refused, the page stops asking for a few seconds instead of adding to the load', async () => {
    const counter = { calls: 0 };
    const client = clientAnswering([429], counter);
    await expect(client.build(params)).rejects.toMatchObject({ status: 429 });
    const asked = counter.calls;
    expect(asked).toBe(4);
    await expect(client.build(params)).rejects.toMatchObject({ status: 429 });
    expect(counter.calls).toBe(asked);
  });
});

describe('a Jupiter that does not answer', () => {
  it('a request past the timeout ends as a 504 JupiterError, which the pipeline reports as unavailable', async () => {
    const client = createJupiterClient({
      buildUrl: 'https://jupiter.test/build', tokensUrl: 'https://jupiter.test/tokens', labelsUrl: 'https://jupiter.test/labels',
      timeoutMs: 20,
      fetchImpl: ((_: string, init: RequestInit) => new Promise((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => reject(init.signal?.reason));
      })) as unknown as typeof fetch,
    });
    await expect(client.build({
      inputMint: address(good.inputMint), outputMint: address(good.outputMint), amount: 1n,
      taker: address('11111111111111111111111111111111'), slippageBps: 50, maxAccounts: 64,
    })).rejects.toMatchObject({ status: 504 });
  });
});
