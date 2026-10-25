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
same arguments, and the owner signs again: it reads what is on chain and sends only what is missing.
Nothing already there is set again without the owner asking, and `skipped` says what was kept: an
existing grant keeps its rules, an input account already approved to the Guard keeps its budget
(`approveAgain: true` sets it to `budgets`), and `agentLamports` goes only to an agent that had no
grant when the run began (`fundAgent: true` sends it anyway). To stop every agent without Orientim,
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

Once a swap is sent, the answer is one of: landed (`ok`, with `arrived`), refused on chain (the
program's error), expired (never seen, its blockhash past its life: it cannot land), or
`unknown: true`: the RPC node could not say within three minutes. **An unknown swap may have landed.**
Look its `signature` up; do not build the swap again, or the owner may get two. `arrivedFrom` says
whether `arrived` comes from the transaction's own token balances (`'transaction'`) or, when those
could not be read, from the owner's balance before and after (`'balances'`), which also counts
anything else that arrived meanwhile.

The route's own compute budget instructions are dropped: the priority fee is the agent's alone.
Nothing is simulated: `rpcChain` sends without the RPC node's own simulation (preflight), so a fast
price does not turn a good swap into a refused one; a swap that fails on chain costs the agent its
network fee. `rpcChain(url, { skipPreflight: false })` asks the node to simulate first.
`fromJupiter` turns Jupiter's `/swap/v2/build` answer into a `GuardRoute`, and is the default route.

## 3. A transaction you build yourself

If your system already builds and sends transactions, build the guarded swap, then co-sign it with
`cosignPrepared`. It never returns a transaction a verifier changed or did not sign. (`requestCosign`
is only the HTTP call, with none of these checks.)

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
lands). It reads the lookup tables a transaction names from its RPC node, and only after the fee
payer's signature and rate are checked. 400: not the Guard's shape; 401: the agent has not signed;
429: too many swaps from this agent in a minute (counted on each verifier machine); 503: the verifier
could not check it now (its lookup tables could not be read in time). The verifier adds no rule
of its own: the Guard program enforces the owner's rules on chain whatever the verifier does.

## Retries and duplicate swaps

A swap's identity on Solana is its signature, and the signature is fixed by the transaction's bytes:
the same route, amount, accounts, priority fee and blockhash give the same transaction. Solana runs a
signature once, so sending the same signed transaction again (H4-03) never makes a second swap.

A new transaction is a new swap. Two swaps the agent builds, even for the same amount, differ once
their blockhash differs, and both can land within the owner's limits. So:

- Retry by sending the same signed transaction again, until it is confirmed, failed or expired.
- Build a new one only when the last answer was `expired` (never seen, its blockhash past its life:
  it can no longer land) or a refusal that names a reason.
- After `unknown`, do not build a new one: look the signature up (`getSignatureStatuses` with the
  history searched) until it is settled.

The Guard does not keep an order id on chain: two distinct transactions are two orders to it, and only
the owner's limits bound them. An integrator that needs "this order at most once" keeps its own order
id next to the signature it sent.

## What the Guard does not do

- The limits are per agent (its grant) and per input mint; the approved budget is per input account,
  shared by every agent of the owner. There is no limit across the owner's whole wallet: no
  wallet-wide stop-loss or take-profit.
- The loss budget and the price floor need a Pyth feed for both mints. With a slippage limit set, a
  pair without feeds is refused unless the owner allows unpriced pairs, and then it has only the
  route's own minimum; with a loss budget, it is always refused. With neither set, no price is checked.
- Mints with a transfer hook or a permanent delegate are always refused. Other tokens and strategies
  are not all tested: the tested kinds are in `tests/guard/hard.ts` (classic SPL at 0 to 9 decimals,
  Token-2022 plain, with metadata, with a transfer fee) and `tests/guard/jupiter.ts` (real Jupiter
  routes, wrapped SOL).
- A frozen account fails the swap on chain, and costs the agent the network fee; `swap()` does not read
  freezes first.
