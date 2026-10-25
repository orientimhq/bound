# Integrating Orientim Guard

For a company that runs agents or bots on Solana and wants every swap to go through the owner's
on-chain rules. Nothing here needs Jupiter: bring your own route.

```sh
npm install @orientimhq/guard @solana/kit
```

The package is compiled JavaScript with TypeScript declarations (Node 20 or later, ES modules).

## 1. The owner's set-up, once

The owner signs once in their wallet: the policy, the agent's grant (the rules), the accounts the
swaps need and the approval of the Guard over each input account, for a budget.

```ts
import { rpcChain, sendOwnerSetup } from '@orientimhq/guard';

const chain = rpcChain('https://your-rpc');
const result = await sendOwnerSetup(chain, {
  program: GUARD_PROGRAM,
  owner: ownerAddress,
  agent: agentAddress,
  verifiers: [ORIENTIM_VERIFIER],          // and the owner's own, with threshold: 2
  programs: [YOUR_SWAP_PROGRAM],           // the programs allowed between Pull and Settle
  rules: {
    limits: [{ mint: USDC, perSwap: 100_000_000n, perDay: 500_000_000n }], // the fee included
    outputs: [SOL_MINT],
  },
  budgets: [{ mint: USDC, amount: 1_000_000_000n }],
  agentLamports: 10_000_000n,              // SOL for the agent's network fees
}, txs => wallet.signAllTransactions(txs));
```

The set-up is larger than one Solana transaction, so it is sent as two or three, signed in one
wallet approval and confirmed in order. If it stops part way, call `sendOwnerSetup` again with the
same arguments: it sees what exists and finishes the rest. To stop every agent without Orientim,
the owner revokes the approval in their wallet (`revoke`).

## 2. The agent's swap, with your own route

A route is any list of instructions that takes at most the amount from the agent's account for the
input mint (the hopper) and delivers to the owner's account for the output mint, with the least
output it promises:

```ts
import type { GuardRoute, RouteRequest } from '@orientimhq/guard';

async function myRoute(r: RouteRequest): Promise<GuardRoute> {
  // r.amount, r.inputMint, r.outputMint; r.taker is the agent, r.destination the owner's output account.
  return {
    instructions: [/* your aggregator's or your own program's instructions */],
    minOut: 9_900_000n,
    lookupTables: { /* address → addresses, if the route uses any */ },
  };
}
```

Then one call does everything: it reads the owner's rules and says before sending why a swap would be
refused, builds `Pull, your route, Settle`, signs as the agent, has each verifier co-sign (checking
it changed nothing and really signed), sends and reports what arrived.

```ts
import { createGuardClient } from '@orientimhq/guard';

const guard = createGuardClient({
  program: GUARD_PROGRAM, owner: ownerAddress, agent: agentKeyPair, chain,
  verifiers: [{ address: ORIENTIM_VERIFIER, cosign: ORIENTIM_VERIFIER_URL }],
  route: myRoute,
  maxMicroLamportsPerUnit: 100_000n,       // the most the agent ever pays as priority fee
});
const r = await guard.swap({ mintIn: USDC, mintOut: SOL_MINT, amount: 50_000_000n });
if (!r.ok) console.log(r.stage, r.reason); // 'rules' | 'route' | 'verifier' | 'chain'
```

The route's own compute budget instructions are dropped: the priority fee is the agent's alone.
Nothing is simulated: `rpcChain` sends without the RPC node's own simulation (preflight), so a fast
price does not turn a good swap into a refused one; a swap that fails on chain costs the agent its
network fee. `rpcChain(url, { skipPreflight: false })` asks the node to simulate first.
`fromJupiter` turns Jupiter's `/swap/v2/build` answer into a `GuardRoute`, and is the default route.

## 3. A transaction you build yourself

If your system already builds and sends transactions, build the guarded swap, then co-sign it with
`cosignPrepared`. It never returns a transaction a verifier changed or did not sign.

```ts
import { accountsFor, compileGuardedSwap, cosignPrepared, guardedSwap } from '@orientimhq/guard';

const accounts = await accountsFor({ program: GUARD_PROGRAM, owner, agent: agentKeyPair.address, verifier: ORIENTIM_VERIFIER, mintIn, mintOut });
const built = guardedSwap({ accounts, amount, route: await myRoute(request) });
const tx = compileGuardedSwap(built, agentKeyPair.address, await chain.latestBlockhash());
const signed = await cosignPrepared(tx, [{ address: ORIENTIM_VERIFIER, cosign: ORIENTIM_VERIFIER_URL }], { agent: agentKeyPair });
if (signed.ok) await chain.send(signed.transaction); // or your own sender
```

## The verifier's HTTP API

```
POST /v1/cosign   {"transaction": "<base64 wire transaction, signed by the agent>"}
200               {"transaction": "<base64, with the verifier's signature added>"}
4xx/5xx           {"error": "<why>"}
```

It co-signs only `[ComputeBudget*] Pull, the route, Settle`, where its key is nothing but Pull's
verifier, the agent pays and has already signed, and the blockhash is recent. It answers at once: it
does not simulate the swap (the program checks everything that protects the owner when the swap
lands). 400: not the Guard's shape; 401: the agent has not signed; 429: too many swaps from this
agent in a minute; 503: the verifier could not check it now. The verifier adds no rule
of its own: the Guard program enforces the owner's rules on chain whatever the verifier does.
