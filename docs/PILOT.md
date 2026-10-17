# The pilot: a few real bots, real swaps, small amounts

Before the agent API is opened to everyone, a few bots run it with real funds, small amounts and
budgets the operator chose, and every swap is checked against the chain. The tests and the mainnet
matrix stop before a wallet signs; the pilot is where swaps are signed, sent and land.

## What it must show

1. **No order carried out twice**, through restarts, retries and two workers on one wallet.
2. **No limit exceeded**: no swap above the owner's per-swap limit, no day above the daily one.
3. **Every unknown outcome kept for recovery**, and settled by `recover` (or by hand) before anything
   new for that wallet.
4. **The fee reached the treasury**, in the mint and the amount each bot was shown before it signed.
5. **Each wallet received at least the minimum it was shown** (`amounts.minOut`).

`tools/pilot-report.ts` checks all five from the bots' logs, their state directories and the chain,
and exits 1 on any failure. It only reads: it never signs or sends.

## Set-up

- **Three to five bots**, each with a wallet of its own holding only what the pilot may spend (say
  $50 each), and an owner's policy (`ORIENTIM_POLICY`): `maxAmountIn` per input mint (say $10 a
  swap) and `maxAmountInPerDay` (say $50), with `stateDir` set to an absolute path on a disk that
  survives restarts.
- **The ways in**: at least one agent with the skill (`protectedSwap`), one bot through the
  `orientim` command (`orientim prepare`, `finalize` and `recover`, from Python, say), and, if anyone
  will integrate the API directly, one such client holding to `AGENT-API.md`, "Direct API
  integration contract".
- **Both kinds of routes**: some bots with `JUPITER_API_KEY` (their own routes), some with
  `ORIENTIM_OWN_ROUTES=0`.
- **Every side of the fee**:
  - a sale into SOL, USDC or USDT (the fee on the output: USDC to SOL, a memecoin to SOL);
  - a purchase with SOL or USDC (the fee on the input: SOL to USDC, USDC to a memecoin);
  - a swap between two other tokens (the fee in SOL from the wallet: BONK to JUP, say);
  - a Pump.fun curve buy and a PumpSwap buy, the markets Orientim names.
- **The logs**: each bot appends one JSON line per swap, whatever its outcome.
  - With the skill: `{ id: intent.id, ...result }`, the object `protectedSwap` returns.
  - With the `orientim` command: `orientim prepare`'s `checked` and `orientim finalize`'s whole
    answer in one line, `{ "checked": ..., ...finalizeOutput }`.

## What to do on purpose

| Exercise | How | Expected |
| --- | --- | --- |
| Restart during finalize | Kill the bot (`kill -9`) right after it signs, several times. | On restart `recover` settles the swap; the order is never carried out twice. |
| The same order again | Run an order id that confirmed. | Refused (`orientim prepare` exit 5); nothing prepared. |
| Two workers, one wallet | Start two at once on one state directory. | One waits for the lock, or stands down; one swap at a time. |
| A network that fails | Point a bot at an RPC that stops answering during finalize (a firewall rule, a dead proxy). | `unknown`, kept; settled by `recover` once the RPC answers. |
| A limit reached | Ask for more than `maxAmountIn`, then swap until the day's limit. | Refused before anything is prepared (`amount-over-limit`, `daily-limit`). |
| A pause | The operator pauses (docs/OPERATORS.md, "Pausing"). | Prepares answer `503 paused`; nothing is lost; swaps resume after. |

## Every day

```
node tools/pilot-report.ts --log bot-a.jsonl --log bot-b.jsonl ... \
  --state /srv/bot-a/state --state /srv/bot-b/state ... \
  --policy policy.json --rpc "$SOLANA_RPC_URL"
```

- A failure stops the pilot: pause, find the cause, fix it, and start the count again.
- Read the server's events for those days (docs/OPERATORS.md, "What the logs count"): errors by
  code, prepare times, and `routes_not_used`.
- Reconcile the treasury: what it received over the days against the sum of the fees shown.

## When it is done

At least 100 confirmed swaps over at least three days, every exercise above done at least once with
the expected result, `tools/pilot-report.ts` with no failure, every `unknown` settled, and the
treasury reconciled. Keep the report, the logs and the dates with the release.

## First pilot (2026-09-29)

A first, shorter run with real money, on skill 1.7.5 downloaded from orientim.com (its hashes
matched), one wallet, an agent (`examples/swap.ts`) and a bot (`orientim-verify`, since 2.0.0 the `orientim` command), with the fee then
at 0.30%.

- 42 swaps confirmed over two rounds, 1 expired before it landed, at no cost. Each confirmed swap was
  read on chain: the wallet received at least `minOut`, the fee went to the treasury at exactly the
  rate shown, and there was no other transfer and no approval.
- The refusals asked for were refused before anything was prepared or signed: an order already
  swapped (exit 5), a tolerance above 15% (exit 2), half a balance below the smallest swap
  (`amount-too-small`); a route 1.11% below the open market was put to the owner (`costs-more`).
- From the order to confirmation: the agent 3.2 / 3.7 / 9.6 s (min / mean / max, 18 swaps), the bot
  5.0 / 5.4 / 6.7 s (10 swaps; each command starts a new Node process). The agent's mean: its own
  quote 0.44 s, prepare 0.91 s (0.47 s of it Orientim's work), its own check 0.37 s, sending and
  confirmation 1.77 s. The slowest swap waited 6.4 s on Jupiter.

It does not meet "When it is done" above: it was one day, under 100 swaps, and not every exercise was
run. No swap has yet run on skill 1.8 or later, or at the 0.25% fee.

