# Orientim Guard (proof of concept)

An agent trades from the owner's own token accounts, but only with Orientim's co-signature and only
within limits the owner wrote on chain. The owner never signs a swap and can stop everything from
their wallet (SPL `Revoke`) without Orientim.

Status: proof of concept on the `guard-poc` branch. Not deployed, not audited, no real funds.
The treasury in the program (`TREASURY`) is a placeholder that no one holds a key for.

## The transaction

```text
[ComputeBudget ...]
Guard::Pull    the agent and a verifier (Orientim) sign; the authority PDA moves exactly `amount`
               from the owner's input account to the agent's hopper, and the 0.25% fee to the
               treasury's account; the output account's balance is recorded
[the swap]     only programs the owner allowed (and the ATA program, ComputeBudget)
Guard::Settle  the last instruction: at least `min_out` arrived in the owner's output account during
               this transaction; anything left in the hopper goes back to the owner
```

The owner sets up once: `InitPolicy` (verifiers, allowed swap programs), `SetGrant` (the agent, its
input mints with limits per swap and per day, its output mints, status and expiry) and an SPL
`Approve` of the authority PDA `["auth", owner]` over each input account, for a budget.

## Rules the program enforces

| Rule | What |
| --- | --- |
| I1 | `Pull` needs the agent of an active, unexpired grant and a verifier named in the policy; the policy is not paused |
| I2 | The amount is within the grant's limit per swap and per day (fee included); the mints are allowed; the input and output accounts are the owner's; the hopper is the agent's account for the input mint; the fee goes to the treasury's ATA |
| I3 | `[ComputeBudget*] Pull (allowed | ATA | ComputeBudget)* Settle`: one pull, settle last and naming the same policy; pull and settle are top-level instructions |
| I4 | `Settle`: the output account grew by at least `min_out`, measured from the balance `Pull` recorded, inside the transaction |
| I5 | `Settle`: the hopper ends with the balance it had before `Pull`; the surplus goes back to the owner; less than before is refused |
| I6 | The fee is 25 bps of the amount, fixed in the program, to the treasury |
| I7 | The authority PDA signs only the two `TransferChecked` of `Pull`; its signature never reaches another program |
| I8 | Nothing moves the owner's tokens elsewhere; only the owner changes the policy and grants |
| I9 | Token-2022 mints may carry only: transfer fee, mint close authority, default account state, a transfer hook with no program, metadata and group extensions. A permanent delegate, non-transferable, pausable and every other extension are refused |

Error codes: `GuardError` in `programs/guard/src/lib.rs`. The numbers are part of the interface.

## Tests

`node tests/guard/run.ts` after `cargo build-sbf` in `programs/guard` and `tests/cpi/attacker`
(CI: `.github/workflows/guard.yml`). The swap program in every case is T6's malicious program. Each
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
| G-T03b–g | Limit per swap; input or output mint not allowed; output not the owner's; fee not to the treasury; hopper not the agent's |
| G-T08a, G-T08b | Daily limit crossed; the next day |
| G-T09a–e | Paused; grant revoked; grant expired; SPL `Revoke`; budget spent |
| G-T11a, G-T11b | The agent changes the policy; the agent raises its own limits |
| G-T10a, G-T10b | Token-2022 honest swap; permanent delegate refused |

Still to come in this proof of concept: the fuzzer with two deliberate defects it must catch, a real
Jupiter route captured from mainnet with its compute and size, and the off-chain verifier.
