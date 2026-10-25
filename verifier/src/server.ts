/**
 * Orientim's verifier as an HTTP service.
 *
 *   POST /v1/cosign  {"transaction": "<base64 wire transaction>"}
 *     200 {"transaction": "<base64, co-signed>"}   the agent adds its own signature and sends it
 *     4xx {"error": "<why>", "logs"?: [...]}
 *   GET  /health
 *
 * Environment: VERIFIER_KEY (the key pair's 64 bytes, base64), RPC_URL, GUARD_PROGRAM, PORT (8080),
 * VERIFIER_PER_MINUTE (30). The key never leaves the process; nothing is logged but the outcome.
 */
import { address, createKeyPairFromBytes, createSolanaRpc, fetchAddressesForLookupTables, getAddressFromPublicKey } from '@solana/kit';
import type { Transaction } from '@solana/kit';
import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createCosigner, encodeTransaction } from './cosign.ts';
import type { Simulation } from './cosign.ts';

const need = (name: string) => {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is not set`);
  return v;
};

/** Simulation through an RPC node, without checking signatures (the agent has not signed yet). */
export const rpcSimulator = (rpc: ReturnType<typeof createSolanaRpc>) => async (tx: Transaction): Promise<Simulation> => {
  const wire = Buffer.from(encodeTransaction(tx)).toString('base64') as Parameters<typeof rpc.simulateTransaction>[0];
  const { value } = await rpc.simulateTransaction(wire, { encoding: 'base64', sigVerify: false, replaceRecentBlockhash: false, commitment: 'confirmed' }).send();
  return { ok: value.err === null, error: value.err ? JSON.stringify(value.err, (_, v) => (typeof v === 'bigint' ? String(v) : v)) : undefined, logs: value.logs ?? [] };
};

const MAX_BODY = 8 * 1024;

export function handler(cosign: ReturnType<typeof createCosigner>) {
  const reply = (res: ServerResponse, status: number, body: unknown) => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  };
  const readBody = (req: IncomingMessage) => new Promise<string>((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new Error('too large'));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });

  return async (req: IncomingMessage, res: ServerResponse) => {
    if (req.method === 'GET' && req.url === '/health') return reply(res, 200, { ok: true });
    if (req.method !== 'POST' || req.url !== '/v1/cosign') return reply(res, 404, { error: 'not found' });
    let wire: Uint8Array;
    try {
      const body = JSON.parse(await readBody(req)) as { transaction?: unknown };
      if (typeof body.transaction !== 'string') throw new Error('no transaction');
      wire = Uint8Array.from(Buffer.from(body.transaction, 'base64'));
    } catch {
      return reply(res, 400, { error: 'expected {"transaction": "<base64>"} of at most 8 KB' });
    }
    try {
      const v = await cosign(wire);
      console.log(JSON.stringify({ at: new Date().toISOString(), ok: v.ok, ...(v.ok ? { agent: v.agent } : { reason: v.reason }) }));
      if (!v.ok) return reply(res, v.status, { error: v.reason, ...(v.logs ? { logs: v.logs } : {}) });
      return reply(res, 200, { transaction: Buffer.from(encodeTransaction(v.transaction)).toString('base64') });
    } catch (e) {
      console.error('cosign failed', e instanceof Error ? e.message : e);
      return reply(res, 503, { error: 'the verifier could not check this transaction now' });
    }
  };
}

if (import.meta.main) {
  const key = await createKeyPairFromBytes(Uint8Array.from(Buffer.from(need('VERIFIER_KEY'), 'base64')));
  const rpc = createSolanaRpc(need('RPC_URL'));
  const cosign = createCosigner({
    program: address(need('GUARD_PROGRAM')),
    key,
    address: await getAddressFromPublicKey(key.publicKey),
    loadTables: tables => fetchAddressesForLookupTables(tables, rpc, { commitment: 'confirmed' }),
    simulate: rpcSimulator(rpc),
    perMinute: Number(process.env.VERIFIER_PER_MINUTE ?? 30),
  });
  const port = Number(process.env.PORT ?? 8080);
  createServer(handler(cosign)).listen(port, () => console.log(`verifier on :${port}`));
}
