# Orientim Guard

An on-chain policy co-signer for AI agents that trade on Solana. The owner keeps their tokens in
their own wallet and writes the agent's limits on chain once. The agent builds its own swaps
(Jupiter), but each one runs only between the Guard's `Pull` and `Settle`, with Orientim's
co-signature, inside the owner's limits. The owner never signs a swap and can stop everything from
their wallet without Orientim.

Status: proof of concept. Not deployed, not audited, no real funds.

## How it works

1. The owner sets up once: a policy (the verifiers who co-sign and the swap programs allowed), a grant
   for the agent (input mints with limits per swap and per day, output mints, an expiry, optionally a
   slippage against Pyth's price and a loss budget) and an SPL `Approve` of the Guard's authority over
   each input account, for a budget.
2. The agent picks the trade, asks Jupiter for the route and sends
   `Pull → the route → Settle` through its own RPC, signed by its own key and by a verifier.
3. `Pull` moves exactly the amount to the agent's hopper and the fee to the treasury. `Settle`, the
   last instruction, requires that at least the minimum arrived in the owner's account (and at least
   Pyth's price less the slippage, when set), returns what the route left, and charges the loss budget.
   If any check fails, the whole transaction reverts.
4. Every output goes straight to the owner's account. The owner can revoke the approval, pause the
   policy or revoke the grant at any time.

The full rules (I1–I11), the transaction's shape and every test case are in
[docs/GUARD.md](docs/GUARD.md).

## Layout

| Path | What |
| --- | --- |
| `programs/guard` | The Guard program (native Rust, solana-program) |
| `sdk` | `@orientimhq/guard`: the instructions, the owner's set-up, the agent's guarded swap (Jupiter route, Pull and Settle around it, v0 with lookup tables) and the verifier client |
| `verifier` | Orientim's verifier, an HTTP service (`POST /v1/cosign`) for Fly |
| `tests/guard/run.ts` | The fixed cases, in litesvm |
| `tests/guard/fuzz.ts` | The attack fuzzer; CI requires it to catch two broken copies of the program |
| `tests/guard/rules.ts` | The owner's rules fuzzed against an independent model; CI requires it to catch three broken copies |
| `tests/guard/verifier.ts` | The verifier against the Guard, and the agent's whole path through the SDK |
| `tests/guard/jupiter.ts` | Real Jupiter routes from a copy of mainnet, with Pyth's real prices |
| `tests/guard/attacker` | A malicious swap program the tests use as the route |

## Running the tests

Needs Node 22.18 or later, Rust and the Solana toolchain (`cargo build-sbf`).

```sh
npm ci
npm run build        # the Guard and the attacker program
npm test             # the fixed cases
npm run fuzz
node tests/guard/rules.ts
node tests/guard/verifier.ts
RPC_URL=… JUPITER_API_KEY=… npm run jupiter
```

The program's own unit tests: `cargo test` in `programs/guard`. Every night both fuzzers run a
million cases each across 20 shards (`.github/workflows/guard-fuzz.yml`).

## The agent's swap, with the SDK

```ts
import { accountsFor, compileGuardedSwap, guardedSwap, jupiterRoute, requestCosign } from '@orientimhq/guard';

const accounts = await accountsFor({ program, owner, agent: agent.address, verifier, mintIn, mintOut });
const route = await jupiterRoute({ inputMint: mintIn, outputMint: mintOut, amount, taker: agent.address,
  destination: accounts.ownerOut, slippageBps: 50, apiKey });
const tx = compileGuardedSwap(guardedSwap({ accounts, amount, route }), agent.address, await latestBlockhash());
const cosigned = await requestCosign('https://verifier.orientim…', tx);
// the agent signs `cosigned` and sends it through its own RPC
```

The owner's one set-up transaction comes from `ownerSetup(...)`; `revoke(...)` ends every approval.

## Security

See [SECURITY.md](SECURITY.md).
