/**
 * `rpcChain().send` (sdk/src/rpc.ts) against a scripted RPC node on localhost: what it answers once a
 * transaction may be on the chain. A node that drops the connection while the status is read is waited
 * out (U01); a transaction seen processed is never reported as expired (U02); a node that cannot say
 * within the deadline gives `unknown`, never a failure; a transaction never seen, past its blockhash's
 * life, has expired; a node that refuses the transaction is believed at once.
 *
 *   node tests/guard/rpc.ts
 */
import {
  appendTransactionMessageInstructions, compileTransaction, createTransactionMessage, generateKeyPairSigner, pipe,
  setTransactionMessageFeePayer, setTransactionMessageLifetimeUsingBlockhash, signTransaction,
} from '@solana/kit';
import type { Blockhash } from '@solana/kit';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { getTransferSolInstruction } from '@solana-program/system';
import { rpcChain } from '../../sdk/src/index.ts';

type Status = null | { confirmationStatus: 'processed' | 'confirmed' | 'finalized'; err: unknown };
/** One case's node: the block height, and the status for each read (the last one repeats); 'drop' closes the connection. */
type Script = { height: () => number; statuses: (Status | 'drop')[]; refuse?: boolean };

let script: Script = { height: () => 0, statuses: [null] };
let reads = 0;
let sent = 0;
const server = createServer((req, res) => {
  let body = '';
  req.on('data', c => { body += c; });
  req.on('end', () => {
    const { id, method } = JSON.parse(body) as { id: number; method: string };
    const answer = (result: unknown) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ jsonrpc: '2.0', id, result }));
    };
    if (method === 'getBlockHeight') return answer(script.height());
    if (method === 'sendTransaction') {
      sent++;
      if (script.refuse) {
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ jsonrpc: '2.0', id, error: { code: -32_002, message: 'Transaction simulation failed', data: { logs: ['Program failed: custom program error: 0xc'] } } }));
      }
      return answer('sig');
    }
    if (method === 'getSignatureStatuses') {
      const s = script.statuses[Math.min(reads++, script.statuses.length - 1)];
      if (s === 'drop') return req.socket.destroy();
      return answer({ context: { slot: 1 }, value: [s && { slot: 1, confirmations: null, ...s }] });
    }
    res.writeHead(400).end();
  });
});
await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

const payer = await generateKeyPairSigner();
const tx = await signTransaction([payer.keyPair], compileTransaction(pipe(
  createTransactionMessage({ version: 0 }),
  m => setTransactionMessageFeePayer(payer.address, m),
  m => setTransactionMessageLifetimeUsingBlockhash({ blockhash: '11111111111111111111111111111111' as Blockhash, lastValidBlockHeight: 100n }, m),
  m => appendTransactionMessageInstructions([getTransferSolInstruction({ source: payer, destination: payer.address, amount: 1n })], m),
)));

const results: string[] = [];
let failed = 0;
async function check(id: string, what: string, s: Script, expect: (r: { ok: boolean; error?: string; unknown?: boolean }) => boolean, confirmTimeoutMs = 2_000) {
  script = s;
  reads = 0;
  sent = 0;
  const r = await rpcChain(url, { pollMs: 5, confirmTimeoutMs }).send(tx);
  const pass = expect(r);
  if (!pass) failed++;
  results.push(`${pass ? 'PASS' : 'FAIL'}  ${id}  ${what}${pass ? '' : `: ${JSON.stringify(r)}`}`);
}

const confirmed: Status = { confirmationStatus: 'confirmed', err: null };
const processed: Status = { confirmationStatus: 'processed', err: null };

await check('R01', 'the node drops the connection twice while the status is read, then it is confirmed: ok',
  { height: () => 50, statuses: ['drop', 'drop', null, confirmed] }, r => r.ok);
await check('R02', 'the node never answers the status: unknown, not a failure',
  { height: () => 50, statuses: ['drop'] }, r => !r.ok && r.unknown === true && sent === 1, 300);
await check('R03', 'seen processed, then past its blockhash\'s life: still watched, and it confirms',
  { height: () => 101, statuses: [processed, processed, processed, confirmed] }, r => r.ok);
await check('R04', 'seen processed, gone again past its blockhash\'s life: unknown, never "expired"',
  { height: () => 101, statuses: [processed, null] }, r => !r.ok && r.unknown === true, 300);
await check('R05', 'never seen and past its blockhash\'s life: expired, known not to have landed',
  { height: () => 101, statuses: [null] }, r => !r.ok && !r.unknown && /expired/.test(r.error ?? ''));
await check('R06', 'the program refused it on chain: failed with its error, not unknown',
  { height: () => 50, statuses: [{ confirmationStatus: 'confirmed', err: { InstructionError: [1, { Custom: 12 }] } }] },
  r => !r.ok && !r.unknown && r.error === 'instruction 1: custom program error: 0xc');
await check('R07', 'the node refuses the transaction: failed at once, its status never read',
  { height: () => 50, statuses: [confirmed], refuse: true }, r => !r.ok && !r.unknown && reads === 0 && /0xc/.test(r.error ?? ''));

server.close();
console.log(results.join('\n'));
console.log(failed ? `${failed} of ${results.length} send() cases failed` : `all ${results.length} send() cases passed`);
process.exit(failed ? 1 : 0);
