# The tests: what each one proves, and where to look when one fails

Three layers, from the fastest to the closest to the real thing:

| Layer | Runs | Where | Fails when |
| --- | --- | --- | --- |
| Unit and scenario tests | every push (`ci.yml`), `npx vitest run` | the files below | any test fails |
| Fuzz (property tests) | 8 to 2,000 cases each in CI (`RUNS` at the top of each file); millions by hand (`fuzz.yml`, `npm run test:fuzz`) | `*.property.test.ts` | a counterexample: fast-check prints the case and its seed |
| Mainnet simulation matrix | by hand (`sim-matrix.yml`), about 90 minutes | `tools/sim/matrix.sim.ts` | a case marked BUG ("to look at"), or an unhandled error |

Nothing in any layer signs with a real wallet or sends a real transaction: the matrix stops after the
full check, before the wallet would sign.

## How a swap works now, and which test covers each step

| Step | What happens | Tests |
| --- | --- | --- |
| 1. The agent's own price | The skill asks Jupiter with the agent's key for its price, floor and price impact | `skillExample`: "Jupiter's answers to the agent's own price"; `agents.limits.property` (any price and amount) |
| 2. First round | Sent while step 1 runs, without `minOut`; Orientim answers `routes-needed` | `agentApi`: "the first round of own routes may come without minOut"; `skillExample`: "the first round goes out while..." and "...not left unhandled" |
| 3. Routes | The agent fetches the routes asked for with its own key (usually 2, at most 24, 10 rounds) | `agentApi`, "routes the agent brings"; `skillExample`, "the agent's own Jupiter key"; `provided.test` |
| 4. Orientim's check of the routes | Fee on the output: held to Orientim's own price within 1%; labels fail closed; routes its verifier refuses are not used | `agentApi`: "understates its output 100 times", "exactly as documented", "delivering elsewhere"; `agents.routes.property` |
| 5. Build | The transaction from chain state on Orientim's RPC, simulated, verified (R1 to R7) | `prepare.test`, `swap.test`, `verifier.test`, `audit.test`, the verifier's property tests |
| 6. The agent's check | On the agent's RPC: the bytes against the intent, the floor, the fee, the impact, token risk | `skillExample`: "a server that lies is refused"; `agents.property` (five lies); `mutation.property` |
| 7. Sign and finalize | The wallet signs; Orientim signs as the one-time key; sends, or not with `send: false` | `agentApi`, "finalize"; `skillExample`: "with a sender of its own"; `agents.routes.property` |
| 8. After | Status reads, re-sends, recovery, the same order never twice, one swap per wallet | `skillExample`: "after signing, the chain is the only witness", "recovery", "the same order is never swapped twice"; `agents.load.property` |
| Limits | The owner's policy, ceilings, the one preparation budget (48 asks, 110 s), 429 waits | `agents.limits.property`, `agents.ceilings.property`; `skillExample`: "one budget for the whole preparation" |

## Fuzz: what each property holds, and the paths it runs

Every end-to-end property now runs the current flow: the agent's own routes (rounds of
`routes-needed`) in about half the cases, and Orientim's routes (no key, or own routes off) in the
rest.

| File | Cases by hand | Holds |
| --- | --- | --- |
| `agents.routes.property` | 12,000 | Whose routes (own, Orientim's, own routes off); fee on the input or the output; the agent's Jupiter honest, within 1%, or far below the market; routes too wide (more rounds); the agent's sender or Orientim's; any tolerance and amount. An honest swap confirms; the input fee is exactly 0.25% of the amount; the output fee is 0.25% of the enforced minimum, never more than 1% below Orientim's own price; with own routes Orientim's key builds nothing unless the routes were unusable; the agent's sender means Orientim sends nothing; at most 10 rounds and 24 routes. |
| `agents.property` | 100,000 | Five ways a server lies, any tolerance and price impact, own routes or not: swap exactly when honest, valid and within the limit; else nothing sent. |
| `agents.limits.property` | 20,000 | Agent and bot decide alike at any price and amount; the 20% floor; the owner's limits per swap and per day at prepare and finalize. |
| `agents.ceilings.property` | 20,000 | The owner's ceilings on tolerance, floor and impact; "auto" tolerance; the archive's proof of expiry. |
| `agents.load.property` | 100,000+ | Bursts against the key's limit; several clients at once, own routes or not: no order twice, no limit crossed, nothing left to settle. |
| verifier and pipeline properties | millions | Honest shapes pass, attacks fail, any byte or instruction change, Token-2022 extensions, any amount and decimals, the tolerance rule. |

## The matrix: groups and what each shows

| Group | Cases | Shows |
| --- | --- | --- |
| repeat, sizes, pairs, majors, more-tokens | ~130 | The major pairs from $1 to $1M, and the same swaps at the start, middle and end |
| whales, giants | ~300 | Up to $5M; price impact and cost refusals |
| personas, rules, tolerance, parity, hard | ~190 | Owners' policies, tolerances, agent and bot alike, the edges |
| **grid** | 45 | Tolerance (0.1%, 0.5%, 3%, 10%, auto) against size ($10, $1,000, $50,000) on SOL → USDC, USDC → BONK, BONK → SOL |
| **routes** | 20 | The same swap with the agent's routes and with Orientim's, a moment apart: the minimum and the fee compared; a fee more than 1.5% lower with the agent's routes is a BUG |
| fallback | 4 | Routes understated 100 times: Orientim's key builds |
| tamper | 14 | 8 changes on each passed transaction, every one refused |
| pump | 18 | The Pump.fun curve and PumpSwap |
| approve, burst, v1-compare, modes | ~60 | Costlier routes approved; 14 swaps at once; v0 against v1; fast routing |

A case is PASS, REFUSED (a reason the docs name), UNTESTED (no holder, Jupiter busy, the market
decided twice) or BUG. Only a BUG fails the run.

## When something fails: where to look

| What failed | Look at | Then |
| --- | --- | --- |
| CI | The failing test's name says the promise broken | Run that file: `npx vitest run <file> -t "<name>"` |
| A fuzz property | The counterexample and seed fast-check prints | Rerun with `ORIENTIM_FUZZ_SEED=<seed>`; the label in the assertion names every dimension of the case |
| A matrix case | The summary at the end of the job's log ("To look at", "Why each case was not a pass") | A difference between agent and bot or a moved balance is run again before it counts |
| Production | `monitor.yml` (every 30 min), `canary.yml` (every 6 h) | `docs/OPERATORS.md`, "Watching production" |

## What changed in this pass (October 2026)

- No test was deleted: none asserted the old behaviour; Orientim's own routes are still the fall
  back and the path without a key, and the tests of it still hold.
- The end-to-end fuzz ran only Orientim's routes; it now runs the agent's own routes in about half
  of every property (`agents.property`, `agents.limits.property`, `agents.ceilings.property`,
  `agents.load.property`), and `agents.routes.property` fuzzes the current flow itself.
- The fakes of those tests now pass `destinationTokenAccount` and `excludeDexes` to Jupiter, as the
  real one takes them.
- Found and fixed: routes from the agent that built a transaction Orientim's verifier refused ended
  in `verification-failed`; Orientim now builds with its own key instead (test: "delivering
  elsewhere").
- The matrix has two new groups, **routes** and **grid**.
