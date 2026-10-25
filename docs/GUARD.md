# Orientim Guard (proof of concept)

An agent trades from the owner's own token accounts, but only with Orientim's co-signature and only
within limits the owner wrote on chain. The owner never signs a swap and can stop everything from
their wallet (SPL `Revoke`) without Orientim.

Status: proof of concept. Not deployed, not audited, no real funds.
Research is still open: the design (fee level and tiers, referral share, the hopper or a one-time key
E, the verifier's role) may change as studies and tests go on. Decisions so far: the agent's hopper
(E optional later), optional 2 of 2 chosen by the owner, Pyth price floor per grant; fee 25 bps with
a 30 bps cap, referral and volume tiers proposed, not decided.
The treasury in the program (`TREASURY`) is a placeholder that no one holds a key for.

## The transaction

```text
[ComputeBudget ...]
Guard::Pull    the agent and a verifier (Orientim) sign; the authority PDA moves exactly `amount`
               from the owner's input account to the agent's hopper, and the 0.25% fee to the
               treasury's account; the output account's balance is recorded
[the swap]     only programs the owner allowed (and the ATA program, ComputeBudget)
Guard::Settle  the last instruction: at least `min_out` arrived in the owner's output account during
               this transaction (and, if the owner set a slippage, at least Pyth's price less it);
               anything left in the hopper goes back to the owner
```

The owner sets up once: `InitPolicy` (verifiers and how many must sign, 1 or 2; allowed swap programs), `SetGrant` (the agent, its
input mints with limits per swap and per day, its output mints, status and expiry, and optionally a
slippage against Pyth with each mint's feed) and an SPL
`Approve` of the authority PDA `["auth", owner]` over each input account, for a budget.

## Rules the program enforces

| Rule | What |
| --- | --- |
| I1 | `Pull` needs the agent of an active, unexpired grant and a verifier named in the policy; with threshold 2, a second, different verifier of the policy signs too (Orientim and the owner's own); the policy is not paused |
| I2 | The amount and its fee together are within the grant's limit per swap and per day; the mints are allowed; the input and output accounts are the owner's; the hopper is the agent's account for the input mint; the fee goes to the treasury's ATA |
| I3 | `[ComputeBudget*] Pull (allowed | ATA | ComputeBudget)* Settle`: one pull, settle last and naming the same policy; pull and settle are top-level instructions |
| I4 | `Settle`: the output account grew by at least `min_out`, measured from the balance `Pull` recorded, inside the transaction |
| I5 | `Settle`: the hopper ends with the balance it had before `Pull`; the surplus goes back to the owner; less than before is refused |
| I6 | The fee is 25 bps of the amount, rounded up (at least one base unit, so no swap is free), fixed in the program, to the treasury |
| I7 | The authority PDA signs only the two `TransferChecked` of `Pull`; its signature never reaches another program |
| I8 | Nothing moves the owner's tokens elsewhere; only the owner changes the policy and grants |
| I10 | When the grant sets a slippage, `Settle` reads Pyth's price of both mints (a fully verified `PriceUpdateV2` of the grant's feed, at most 60 s old and at most 30 s ahead of the chain's clock, confidence within 2%) and refuses unless the output is worth at least the input less that slippage, the least whole output not below that value (rounded up, so a tiny swap cannot pass with nothing). A pair without a feed is refused, unless the owner allows unpriced pairs. Even a verifier and an agent that agree on a minimum of 1 cannot sell below the price |
| I11 | When the grant sets a loss budget (micro-USD per day and in all), `Settle` charges each swap's loss by Pyth's prices to the grant: what actually left the owner's input account (measured after the refund, so a Token-2022 transfer fee on the way in or back counts, fee included), valued rounded up, less what arrived, valued rounded down; gains are never credited. The swap that would cross a cap is refused, and `Pull` refuses once a cap is spent. This stops an agent that churns many swaps each just inside the slippage (the sawtooth). A loss budget needs prices for both mints |
| I9 | Token-2022 mints may carry only: transfer fee, mint close authority, default account state, a transfer hook with no program, metadata and group extensions. A permanent delegate, non-transferable, pausable and every other extension are refused |

Error codes: `GuardError` in `programs/guard/src/lib.rs`. The numbers are part of the interface.

## Tests

`node tests/guard/run.ts` after `cargo build-sbf` in `programs/guard` and `tests/guard/attacker`
(CI: `.github/workflows/guard.yml`). The swap program in every case is the malicious program in `tests/guard/attacker`. Each
case checks its outcome and the program's reason, and the promise from balances alone: a refused
transaction moves nothing; a passed one takes from the owner at most the amount and the fee, pays
exactly the fee, delivers at least the minimum and leaves the hopper and the owner's other tokens
untouched.

| ID | Case |
| --- | --- |
| G-T03, G-T06a | Honest swap; the route uses less and the rest returns |
| G-T04a, G-T04b | Below the minimum; the route keeps the input |
| G-T06b | The route takes more from the hopper than was pulled |
| G-T01a, G-T01b | No verifier signature; an unknown verifier |
| G-T02 | The agent transfers from the owner's account directly |
| G-T07a–c | The route signs as the authority, burns, or takes another token of the owner |
| G-T05a–f | No settle; an instruction after settle; two pulls; a program not allowed; pull through CPI; settle alone |
| G-T03b–i | Limit per swap; input or output mint not allowed; output not the owner's; fee not to the treasury; hopper not the agent's; the limit per swap includes the fee (at the limit refused, amount + fee at the limit passes) |
| G-T08a, G-T08b | Daily limit crossed; the next day |
| G-T09a–e | Paused; grant revoked; grant expired; SPL `Revoke`; budget spent |
| G-T11a, G-T11b | The agent changes the policy; the agent raises its own limits |
| G-T12a–e | Threshold 2: both sign; only Orientim; the same verifier twice; a second key not in the policy; threshold 2 with one verifier named |
| G-T13a–j | Pyth: within 1%; minimum 1 but 10% below the price; stale; not Pyth's account; feeds swapped; partially verified; wide confidence; no prices passed; unpriced pair refused; unpriced pair allowed |
| G-T14a–i | Loss budget: one losing swap fits; the second of the day crosses it (sawtooth); the next day; the total cap across days; a gain buys no room; settle without the grant; an unpriced pair refused; an input with a 10% transfer fee, where the fee lost on the refund crosses the cap, and where it does not |
| G-T10a, G-T10b | Token-2022 honest swap; permanent delegate refused |

`node tests/guard/fuzz.ts` sends random transactions through the Guard (1,000 per CI run, seeded by the
run number): random amounts, minimums, decimals and token programs, a random shape (no settle,
something after settle, two pulls, an unknown or absent verifier, the output paid to the agent, the
hopper swapped for the attacker's) and a random route (take more or less, deliver more or less, pay the
agent, sign as the authority, burn, spend the owner's other tokens). The same balance checks apply to
every case, and an honest swap must go through.

The workflow then builds two broken copies of the program and requires the fuzzer to fail on each: M1
drops the minimum check of `Settle` (I4), M2 drops the check that the output account is the owner's
(I2).

`node tests/guard/jupiter.ts` (CI: `.github/workflows/guard-jupiter.yml`, one job per Jupiter
`maxAccounts`: 64, 40, 28) asks Jupiter's Swap API for real routes, copies every account and program
they name from mainnet into litesvm, and runs Pull → the route → Settle with Pyth's real price
accounts, the price floor and a loss budget; the same route also runs alone as the baseline. Measured
so far: the Guard adds about 400 bytes to a transaction, or about 155 with the owner's own lookup
table (its policy, grant, authority and token accounts), and 22,000–37,000 compute units. Routes of one
or two hops fit in 1,232 bytes with room; routes of four may not. The job fails only when a route works
alone and not through the Guard; a route that has gone stale in the copy fails both ways and is reported.

The verifier (`verifier/`, tested by `tests/guard/verifier.ts`) co-signs only a transaction of the
shape above in which its key is nothing but a verifier of the one `Pull` (never the fee payer, never
writable, never in another instruction), with a recent blockhash (so a co-signed swap expires within
about 90 s), already signed by the agent (so no one else can spend the agent's rate), within a rate per
agent (30 a minute by default). It does not simulate the swap: a simulation would protect nothing the
program does not, and would add an RPC round trip in which a fast-moving price can turn a good swap into
a refused one. It adds no rule the program does not already enforce; it refuses early,
with a reason, and keeps its signature from authorising anything but a `Pull`. CI requires its tests
to catch a verifier that lets its key be used outside `Pull` (M6).
