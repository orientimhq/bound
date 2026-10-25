// An outside project that installed the packed @orientimhq/guard from npm, with plain Node (no
// TypeScript): every public entry imports, a swap builds from a route that is not Jupiter's, and
// cosignPrepared refuses a verifier that changes the transaction or does not sign it.
import { address, generateKeyPairSigner, getTransactionEncoder, partiallySignTransaction } from '@solana/kit';
// biome-ignore lint/performance/noNamespaceImport: the test checks the package's whole public surface
import * as guard from '@orientimhq/guard';
import { existsSync } from 'node:fs';

const failures = [];
const check = (what, ok) => {
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${what}`);
  if (!ok) failures.push(what);
};

for (const name of ['createGuardClient', 'cosignPrepared', 'guardedSwap', 'compileGuardedSwap', 'fromJupiter', 'ownerSetup', 'ownerSetupTransactions', 'rpcChain', 'accountsFor', 'feeOf', 'revoke']) {
  // biome-ignore lint/performance/noDynamicNamespaceImportAccess: each public entry by name
  check(`exports ${name}`, typeof guard[name] === 'function');
}

check('ships TypeScript declarations', existsSync('node_modules/@orientimhq/guard/dist/index.d.ts'));

const [owner, agent, verifier, stranger, programKey] = await Promise.all([1, 2, 3, 4, 5].map(() => generateKeyPairSigner()));
const program = programKey.address;
const mintIn = address('So11111111111111111111111111111111111111112');
const mintOut = address('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');
const TOKEN = address('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
const accounts = await guard.accountsFor({
  program, owner: owner.address, agent: agent.address, verifier: verifier.address, mintIn, mintOut, tokenIn: TOKEN, tokenOut: TOKEN,
});
// A route of one's own: any instructions, the least output, no lookup tables.
const route = { instructions: [{ programAddress: address('11111111111111111111111111111111'), accounts: [], data: new Uint8Array([2, 0, 0, 0]) }], minOut: 5n };
const built = guard.guardedSwap({ accounts, amount: 1_000n, route });
check('a route that is not Jupiter\'s builds: Pull, the route, Settle', built.minOut === 5n && built.instructions.length >= 4);
const lifetime = { blockhash: 'EkSnNWid2cvwEVnVx9aBqawnmiCNiDgp3gUdkDPTKN1N', lastValidBlockHeight: 100n };
const tx = guard.compileGuardedSwap(built, agent.address, lifetime);

const honest = async t => partiallySignTransaction([verifier.keyPair], t);
const ok = await guard.cosignPrepared(tx, [{ address: verifier.address, cosign: honest }], { agent });
check('cosignPrepared: an honest verifier, the agent signed first', ok.ok && !!ok.transaction.signatures[agent.address] && !!ok.transaction.signatures[verifier.address]);

// The same swap with another blockhash: what a verifier that swaps the transaction would return.
const other = guard.compileGuardedSwap(built, agent.address, { blockhash: stranger.address, lastValidBlockHeight: 100n });
const changed = await guard.cosignPrepared(tx, [{ address: verifier.address, cosign: async () => partiallySignTransaction([verifier.keyPair], other) }], { agent });
check('cosignPrepared: a verifier that returns another transaction is refused', !changed.ok && /different transaction/.test(changed.reason));
const unsigned = await guard.cosignPrepared(tx, [{ address: verifier.address, cosign: async t => t }], { agent });
check('cosignPrepared: a verifier that does not sign is refused', !unsigned.ok && /did not sign/.test(unsigned.reason));
const forged = await guard.cosignPrepared(tx, [{ address: verifier.address, cosign: async t => ({ ...t, signatures: { ...t.signatures, [verifier.address]: (await partiallySignTransaction([stranger.keyPair], t)).signatures[stranger.address] } }) }], { agent });
check('cosignPrepared: a signature by another key is refused', !forged.ok);
// Over HTTP, an answer that is not the same transaction.
const otherSigned = await partiallySignTransaction([verifier.keyPair], other);
const fakeFetch = async () => new Response(JSON.stringify({ transaction: Buffer.from(getTransactionEncoder().encode(otherSigned)).toString('base64') }), { status: 200 });
const http = await guard.cosignPrepared(tx, [{ address: verifier.address, cosign: 'https://verifier.invalid' }], { agent, fetchImpl: fakeFetch });
check('cosignPrepared over HTTP: an answer with another transaction is refused', !http.ok && /different transaction/.test(http.reason));

console.log(failures.length ? `${failures.length} failed` : 'the package works for an outside project');
process.exit(failures.length ? 1 : 0);
