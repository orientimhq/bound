# Historical browser-swap security model

This document records the former browser swap design for engineering reference. The current
product is the agent API, skill and command line; see the active [security model](../SECURITY.md).
Descriptions below of a swap page, browser transaction signing and browser recovery do not
describe the current website.

## Guarantee

For every swap Orientim builds:

1. The external swap program (Jupiter's route) can move at most `q − f` of the input token, where `q`
   is the amount the user entered and `f` is the Orientim fee. The fee is compiled into the page at
   build time (0.25% by default, 0.3% at most) and the verifier refuses anything above 0.3% (`MAX_FEE_BPS`). When
   the route opens an account in the temporary key's name and charges it the rent (both of
   Pump.fun's markets do, once per buyer), it can also reach exactly that rent, which is measured in simulation, capped at
   0.005 SOL (`MAX_TAKER_RENT_LAMPORTS`) and stated before signing. Nothing else in SOL, apart
   from Orientim's own fee when a pair pays it in SOL from the wallet (below).
2. It never receives the wallet W or any token account of W except the output account `W_out`. Any
   delegate on `W_out` is revoked by a trusted instruction before the swap runs, and a `W_out` with
   a close authority is refused.
3. The transaction grants no new authority over W's assets (no approvals, no ownership changes).
4. The user receives at least the minimum they accepted before signing, which is never below the
   quote less the slippage: 0.5%, or 3% when the route trades on a Pump.fun bonding curve, unless
   the person chose another on the page (⚙️, from 0.1% to 15%; the verifier holds the route to that
   choice, and a server or the agent skill can never raise it). Orientim
   checks it on chain after the swap; if less arrived, the whole transaction reverts. When a token
   is bought, the check compares the user's account for that token with its balance when the swap
   was prepared, and that balance is read from the RPC: the check assumes the RPC reports it
   truthfully, and a transfer into that account from someone else at the same moment counts toward
   it. Jupiter's program also enforces a floor on chain, a second one that does not depend on the
   RPC: it measures what its own instruction delivers, and the verifier requires that instruction to
   deliver into the user's own account (or E's temporary one for SOL), so that floor is always on the
   right account, and requires it to reach the whole minimum, not only the quote: when the user
   accepted more than the route's own floor, Orientim tightens the route's tolerance until it does.
   A transfer arriving at the same moment, or another swap into
   the same token, cannot then make up for a route that delivered less. Orientim never runs two of its
   own swaps into the same token at once in the same browser.

Orientim has one minimum-output model for every router: an exact base-unit amount enforced by a trusted
instruction in the same transaction and checked independently by the verifier. A router's own
threshold may make that amount stricter, never weaker. Router-only, off-chain or differently shaped
guarantees are not substitutes; an integration that cannot compile to this balance floor is not a
supported protected route.

SOL leaving W in one swap is at most:

```
network fee (≤ F_max, and never above 0.001 SOL)
+ q, when SOL is the input
+ rent, only when the swap opens W's account for the output token
  (1,488,440 lamports ≈ 0.0015 SOL on 23 September 2026, read from the cluster; the rent per byte
  falls again in November 2026 under SIMD-0437, and Orientim shows whatever the cluster says)
+ route rent, only when the route opens an account in E's name
  (1,346,200 or 1,478,280 lamports ≈ 0.0013–0.0015 SOL on Pump.fun's markets, September 2026;
  at most 0.005 SOL), of which the account's own rent comes back in the same transaction
  (1,346,200 lamports: all of it on PumpSwap, all but 132,080 on a bonding curve that grows)
+ Orientim's fee in SOL, only for a pair neither token of which can carry it
  (0.3% of the swap's value in SOL when it is built; shown before the wallet opens)
```

The account the route rent pays for, Pump.fun's per-buyer volume accumulator, is closed at the end of
the same transaction and its lamports go straight back to W: Orientim adds Pump's own
`close_user_volume_accumulator`, signed by E, and a transfer of what it returned from E to W. What
the market keeps is only what it spent elsewhere (132,080 lamports when a bonding curve grows its
own account; nothing on PumpSwap), and that is what the page shows as the market's account fee.
This is the one instruction of a market's program that Orientim itself places, and the verifier admits
it only in its exact IDL shape, for E's own account (the PDA is derived, not read), for Pump's two
programs, and only **after E's last token account is closed**: when it runs, E's signature reaches
nothing but the lamports it returns. A Pump program changed by its upgrade authority could keep
those lamports; the transfer to W would then fail and the whole swap revert, costing the network
fee. When closing is not possible (the transaction would not fit, the account also holds a cashback
coin's cashback, or the simulation says no), that route is not offered: a narrower one is tried, and
without one the swap is refused. Rent any other market takes for an account it
opens is caught the same way: before the wallet signs, the exact transaction is simulated, and every
account the route is given that did not exist before the swap must end closed, besides the wallet's
own output account. The page, the agent API and the agent's own check all do it.
A simulation is not the landing: a market that behaves differently a few seconds later is outside
what Orientim can check without a program of its own on chain.

Through the agent API, E is derived from Orientim's server secret and the ticket's nonce, so whoever
holds that secret can derive it again. Orientim does so only to countersign the same message when
finalize is asked again for a ticket, and never logs nonces. That is why nothing may remain under E,
or in an account the route opened, after the swap.

The rent stays in the user's own new token account and is shown before signing. Orientim never makes the
user pay rent for Orientim's own fee account.

The fee (0.3%) is taken in the order Jupiter prefers for its own (its pricing and token list differ):
in SOL first, then USDC, then USDT, on
whichever side of the swap they are and the treasury can receive them; otherwise in the input token
when the treasury has an account for it; otherwise in SOL from the wallet, 0.3% of what the swap is
worth in SOL as Jupiter prices it for the one-time key when the swap is built, paid before the swap
to the treasury wallet. A deployment with a treasury builds no swap without its fee: when none of
these can be collected (the treasury wallet does not exist yet, or there is no price in SOL), the
swap is refused (`fee-unavailable`), and one too small to carry a fee of about $1 of swap is
refused too (`amount-too-small`). Only test mode, without a treasury, is fee-free. The verifier
checks where that SOL fee goes and when, not its price: the page shows it before the wallet opens,
and an agent's check holds it to a price of the agent's own. On the input it is 0.3% of
the amount, paid before the swap. On the output it is 0.3% of the enforced minimum, paid after the
minimum is checked (from the wallet once E_out has paid out, for SOL; from `W_out`, for USDC or
USDT): the minimum the user sees and accepts is what the wallet keeps after it, and the fee is never
more than 0.3% of what the swap delivers, since Jupiter's own floor holds the route to that minimum
whatever else arrives in the account. This is what lets a memecoin sold for SOL pay, where the treasury
could never hold an account for every new token.

## Why it holds: R6 first

The load-bearing rule is **R6**: the transaction has exactly two signers, W and E, and W pays. **R1**
keeps W out of the external instruction, so W's signature is never available to the external
program. Everything that needs W's signature to move is out of reach even if its account were passed:
SPL transfers from W's accounts, SOL, stake, account closes, authority changes.

R1's address filter then only has to cover what can move **without** W's signature:

- token accounts with a pre-existing delegate: none of W's token accounts reach the external program
  except `W_out`, and `W_out`'s delegate is revoked before the swap;
- mints with a permanent delegate: such a delegate moves tokens without W's signature. Inside the
  swap it can reach only accounts of that mint the route was given: E's, which are the route's
  anyway, and `W_out`. What protects `W_out` is the minimum-output check, which counts `W_out`'s
  balance after the swap against its balance before, so anything the delegate takes out is netted.
  Orientim also refuses a delegate that is a program-derived address, but that rule is not what
  protects the user: an "ordinary" delegate can still be a Token-program multisig whose signer is a
  program, and the delegate can be reassigned after the snapshot. A transfer hook with a real
  program is refused. Tokens used only inside the route's own pools never reach W's accounts; the
  external instruction is untrusted anyway.

One exception, on the page only: a Lighthouse assertion a wallet adds (see "Adversaries covered")
may name W, and Phantom's do, since they check the wallet's own balances. The Solana runtime gives
every instruction that names W its signer and writable role, so the Lighthouse program is handed W's
signature. Its assertions (kinds 2 to 15) only read, so this is safe for the program as deployed
today, which is why Lighthouse is listed in the trusted computing base below. The agent API accepts
the exact message only, so this does not apply to agents.

Anyone changing R1 or R6 must re-read this section. The same note sits above the rules in
`packages/verifier/src/verify.ts`.

## Trusted computing base

The guarantee holds if these are correct and unmodified:

| Component | Assumption | Mitigation |
| --- | --- | --- |
| Solana runtime | A program cannot use accounts or signatures it was not given | Runtime attack tests (T1) and a malicious swap program run in a real Solana VM against classic SPL and Token-2022 (T6, 32/32) |
| SPL Token and Token-2022 programs | Transfers respect owner and amount; a self-transfer checks the balance | Audited, widely used; the self-transfer behaviour is tested on mainnet state (T5) and both programs are exercised through hostile CPI (T6) |
| Orientim code in the browser | Compiler and verifier are correct and untampered | Independent verifier, mutation and property tests, nonce-based CSP, minimal dependencies |
| Orientim's server | Serves the genuine page, and relays RPC answers and token metadata | CI compares two builds and the page uses partial SRI (details below). The server cannot change the fee or the treasury (compiled into the page); F_max from the server is capped by the verifier; decimals are checked against the mint on chain |
| RPC | Returns true lookup tables and account state | v1 has no lookup tables, but account state (owners, balances, decimals, authorities) still comes from the RPC; v0 tables come from the same single provider (see "One RPC provider") |
| Wallet | Signs what it is given | The returned message is re-verified before E signs: byte for byte, except that the page accepts Lighthouse assertions a wallet adds (below) |
| Lighthouse program (`L2TExMFKdjpN9kozasaurPirfHy9P8sbXoAN1qA3S95`), page only | Its assertion instructions (kinds 2 to 15) only read the accounts they name, W included | Pinned by address; only assertion kinds are accepted, added accounts must be read-only, and the agent API accepts none. If the program can still be upgraded, an upgrade by its authority could act with W's signature on a transaction Phantom signed with assertions. Accepting assertions at all is a choice for Phantom users; turning it off (`acceptAssertions: false`) refuses those swaps instead |
| Jupiter's on-chain program | Its floor measures what its route instruction delivered to the destination account | Pinned by address; only its two known route formats are accepted, and the verifier requires the floor at the account the minimum is checked on |

The largest remaining risk is a modified frontend (compromised server or supply chain). Serve it
from a reproducible build, keep dependencies minimal, and review every dependency update. What
"minimal" currently means is counted under "The dependencies that run in your browser".

## Adversaries covered

- A malicious or compromised DEX or program inside the route: limited to the approved amount; less
  than the minimum output reverts the transaction.
- A compromised Jupiter API response: rejected by the verifier (R1–R7) if it breaks isolation. A
  bad price, or a route label, is not something the verifier can detect.
- Changes to the transaction after verification (by the wallet or a browser extension): rejected by
  the wallet-return check (R6), which compares the message byte for byte and the wallet's signature.
  On the page, one change is accepted: Lighthouse assertions (kinds 2 to 15) that a wallet such as
  Phantom adds. Every original instruction must be unchanged and in order, the signers, blockhash and
  lookup tables the same, added accounts read-only, and the compute limit raised by at most 50,000
  units with the network fee still within F_max. An assertion can only make the transaction fail,
  as long as the Lighthouse program is the one deployed today (see "Trusted computing base"); the
  agent API accepts the exact message only.
  It does not freeze the chain: state that changes between the check and the landing (a balance, a
  pool, a token's settings) is met by what the transaction enforces on chain (the exact debits, the
  minimum-output check, Jupiter's floor), or the transaction reverts.
- A compromised Orientim server that still serves the genuine page: it sees mints, amounts, E's public
  key and the user's address, never the wallet's key. (The agent API is different: its server holds
  the secret E is derived from, and an agent that skips the verification in the skill trusts the
  server with its whole wallet; see AGENT-API.md.) It can pause swaps, change the alpha limit and
  the excluded DEXes, and lower F_max, but it cannot raise a fee taken from the input or the output
  above 1%, the network fee above 0.001 SOL, or send the fee anywhere else. A fee paid in SOL from
  the wallet (a pair neither token of which can carry it) is priced by Jupiter when the swap is
  built: the verifier pins where it goes, not its price, so the page shows it before the wallet
  opens and an agent's check holds it to a price of its own. The server also relays RPC answers,
  Jupiter's answers and token metadata. Wrong decimals are caught against the chain. A relay that
  under-reports the balance of the user's output account weakens Orientim's own minimum-output check
  for a token output, which counts from that balance; what still holds the route to the whole
  minimum is Jupiter's on-chain floor, which the verifier requires at that same account and which
  measures what Jupiter's instruction delivered there, whatever else is in it. That rests on Jupiter's program, pinned by its address, doing what its
  published program does (see the trusted computing base above). The defence against a relay that
  lies is serving the genuine page and relays from a published, monitored release (section
  "Verifying the code you are running").

## Not covered

- A compromised server or dependency that serves a **modified** page (see the TCB above).
- Phishing sites that do not use Orientim, and approvals the user granted elsewhere before.
- The value of the token bought (rug pulls, freeze authority, mint authority). The page warns about
  the last two.
- Price movement and MEV within the slippage tolerance (0.5%, or 3% on a Pump.fun bonding curve, or
  what the person chose on the page, up to 15%): the minimum output is the quoted amount minus that
  tolerance. The higher the tolerance, the more a bot that trades around the swap can take; above 5%
  the page warns, and keeps the choice for that visit only.
- Token-2022 tokens whose extensions Orientim refuses: a permanent delegate a program can sign for,
  accounts frozen by default, pausable, non-transferable, interest-bearing, a scaled UI amount, a
  required memo, a transfer hook with a real program, or any extension the verifier does not know.
- What a token's issuer can do outside the swap. A stablecoin such as PYUSD gives its issuer a
  delegate that can move or freeze it in any wallet; Orientim accepts it only when that delegate cannot
  act inside the swap, and says so to the user, but it cannot and does not limit the issuer.
- A token that charges its own transfer fee is supported, and costs more through Orientim than
  elsewhere: the fee applies to every transfer, and a protected swap makes one transfer more than
  an unprotected one. The page says so before the swap and again while the wallet is open. That
  money goes to the token, never to Orientim.
- A price that is worse than the open market: a protected route must fit in one transaction and
  leaves out pools that would leave an account behind. From 0.5% the page shows the difference and
  asks, with a stronger warning past 5%; the swap is never blocked over it, because a person who
  understands the cost and still wants the guarantee is entitled to it. Orientim refuses on its own
  only past 50%, where the answer is not a price but a broken one. Note that this difference is not
  price impact: the size of a trade moves the market for the protected and the unprotected route
  alike, so it cancels out of the comparison. **This comparison is a courtesy, not a guarantee:** both the protected route and
  the unrestricted one it is measured against come from Jupiter, so an aggregator that lowered both
  would pass it unnoticed. What protects the user is the minimum output they accepted, which is
  enforced on chain. A guarantee about the market price would need an independent price source.

- Two different transactions for the same order from workers that share no order book. The agent
  API keeps no state, by design (no database): the skill keeps one swap per wallet and per order for
  every worker that shares its state directory, and workers on several machines must share an order
  book of their own (AGENT-API.md). The page keeps one swap per wallet in this browser.

## What an outcome proves

A swap is reported `confirmed` (or `failed`) once the network confirms it: a supermajority of the
stake voted for its block. That is the finality Orientim acts on; `finalized` comes some 13 seconds
later. A confirmed block is not expected to be rolled back, but an integrator that needs rooted
finality should wait for it.

`expired` is said only when the chain proves that the transaction never landed and never will: its
signature has no record, the finalized block height is past its last valid block, and the node that
answered still holds every block the transaction could have landed in. A node answers from its status
cache, which holds its last 300 blocks, before any ledger history or archive; that history can be
pruned or missing, and an archive that fails answers "no record" as well. So "no record" is proof
only for some 30 seconds after the transaction's lifetime. Past that it proves
nothing, and the outcome stays unknown:

- on the page, the wallet starts no new swap until the network settles the last one; if it never
  can, the person looks it up on Solscan and sets it aside themselves ("I've checked it");
- for an agent, `recover` leaves it unknown, and `orientim-verify resolve` (or `resolvePending`) settles
  it once the operator has looked it up in a full history. The chain's own answer, when the RPC
  still has one, is used instead of the operator's.

The page keeps each swap in the browser before sending it, and sends nothing when the browser will
not keep the record: a closed tab or a lost connection never loses track of a
transaction that may have landed. This holds while the person keeps this browser's site data.

## What works and what is refused

| Class | Orientim's answer |
| --- | --- |
| SOL, classic SPL tokens | Swapped |
| Token-2022 with metadata, groups, close authority, confidential-transfer extensions, an unset transfer hook, default state initialized | Swapped; a confidential balance is not what is swapped |
| Token-2022 with a transfer fee (input, output or a hop) | Swapped; the tax is stated before the wallet opens |
| Token-2022 with a permanent delegate that is an ordinary key | Swapped, with a warning; a delegate a program signs for is refused |
| Active transfer hook, default state frozen, pausable, non-transferable, interest-bearing, scaled UI amount, required memo, unknown extensions | Refused, with the reason |
| An account the issuer froze, or freezes later | Fails in simulation, or reverts: nothing moves |
| Pump.fun bonding curve and PumpSwap | Swapped; the per-buyer account is closed and its rent returned, or the route is refused |
| Any other market that opens an account and leaves it open | Refused |
| Routes too large for one transaction | Refused: Orientim never splits a swap |
| Wallets that sign and return (Wallet Standard `signTransaction`) | Supported: tested on mainnet with Phantom, which may add Lighthouse assertions (accepted on the page, see R6 above), and Trust Wallet |
| Sign-and-send-only wallets, multisig vaults | Cannot sign first: not supported |
| v1 transactions | Built only when enabled and only for a route too big for v0 |

## The temporary key

E is a non-extractable WebCrypto key: its private bytes cannot be exported, not even by Orientim's own
code. That is not the same as "cannot be used": while the page is open, script running in it could
ask E to sign. This does not break the guarantee, because E's accounts are empty outside the
transaction and nothing moves without W's signature, but it is one more reason the page's CSP
matters. Through the agent API, E is derived from the server's secret instead (see "Guarantee"), so
it is only as discarded as that secret is kept.

## Certificate

After a transaction passes every rule, the verifier (`@orientim/verifier`) issues a certificate bound
to the SHA-256 of the exact message: approved total debit, swap amount, Orientim fee, minimum output,
signers, the programs the transaction invokes directly, "other tokens debited: none", "persistent
permissions: none", the verifier's version and the slot of the chain state the rules were checked
against. The page does not show it: the person swapping is told the amounts, the minimum and the
costs in plain words. The certificate travels with the prepared swap for whoever wants to check it.

A certificate is a receipt, not a proof. It is not signed by anyone, and it is issued by the same
code that verified the transaction, so a compromised page could show one that says anything. It is
worth exactly what the verifier that issued it is worth: a wallet, an agent or an auditor that does
not trust the page should run `@orientim/verifier` on the same bytes, policy and chain state and
compare. For an automated signer that is the intended use — run the verifier next to the signer.

## Frontend hardening

- Content-Security-Policy with a fresh nonce per request and `'strict-dynamic'` (no `'unsafe-inline'`
  for scripts), images only from Orientim's origin and `data:`, network connections only to Orientim's
  origin, no framing.
- The site has no swap page. The only page that asks a wallet for anything is the API-key page
  (`/developers#access`): it asks for a signature over Orientim's key message, checked against the
  expected text before the wallet opens, and never for a transaction.
- The CSP is a mitigation, not a guarantee.

## Data

Orientim maintains no customer database, no wallet database and no transaction history as part of its
protection engine; an agent's swap records live only in its own state directory (the skill). Requests are computed and
discarded. The hosting platform and the RPC provider keep their own operational logs, so Orientim does
not promise that nothing is logged anywhere.

## Verifying the code you are running

A page can claim anything. These are the two ways to check this one.

**The build is reproducible.** `ORIENTIM_BUILD_ID=<commit> npm run build && node tools/build-digest.ts`
prints one hash over every file the browser can load from `/_next/static`. Two builds of the same
commit produce the same hash — CI proves it for every release tag by building twice — so the digest
published with a release can be compared against a build you made yourself.

**Scripts carry their own hashes.** The page sets `integrity` on the scripts it loads
(`experimental.sri`, SHA-384), so a browser refuses a script whose bytes were altered between the
build and the tab. Next signs only the scripts it writes itself; the chunks of the page's own code
are written by React, so each page preloads them with the hashes Next computed at build time and
React copies the hash onto the tag (`apps/web/lib/server/scriptIntegrity.ts`). Today 7 of 8 script
tags carry one. The eighth is Next's layout chunk (router and error boundaries), which is written
before any page code runs; the browser test names it and fails if a second tag loses its hash. It
is still covered by the digest above, which is over every file.

**The live site is compared with the release.** A tag `v*` publishes a GitHub release with
`build-digest.txt`, the hash of every file for that commit (`.github/workflows/release.yml`). Every
six hours `tools/check-live.ts` fetches each of those files from the site and fails if one
differs, if a page refers to a static file the release does not have, or if a page loads a script
from anywhere else (`.github/workflows/live-check.yml`). Anyone can run the same check:
`node tools/check-live.ts --site <url> --manifest build-digest.txt`.

Neither of these protects against a backend that serves a different page on purpose, or a
different page to some visitors only; the inline HTML is also outside the digest, since its nonce
changes on every request. What they do is make a changed deploy visible to anyone who looks,
instead of impossible to tell. For a user to rebuild and compare, the source must be readable.

## The dependencies that run in your browser

"Keep dependencies minimal" is a claim until someone counts it. Counted on 2026-09-21:

| | |
| --- | --- |
| Known advisories, `npm audit` with and without dev | **0** |
| Packages in the whole locked tree that declare an install script | **1** — `fsevents`, macOS-only, optional, dev |
| Entries resolved from anywhere other than `registry.npmjs.org` | **0** |
| Entries without an integrity hash | **0** |
| Third-party code that can reach a browser | 55 packages, from 5 publishers |
| Built client JavaScript | 744 KB across 12 files |

An install script is how a supply-chain attack usually runs: it executes on `npm install`, with the
developer's or the build machine's privileges, before anyone has read a line of the package. One
package in this tree has one, it only installs on macOS, and it is a dev dependency of the test
runner. Nothing that ships has one.

The 55 browser-reachable packages are not 55 vendors. They are `@solana/*` (43 packages, one release
train of `@solana/kit`), `@solana-program/*` (3), `@wallet-standard/*` (2), React with its scheduler
(3), and Next's runtime helpers. Nothing else: no analytics, no error reporter, no font loader, no
wallet-adapter aggregator, no UI framework.

The Node-only packages `@solana/kit` carries for its own tooling — `ws`, `chalk`, `commander`,
`undici-types` — were checked against the built chunks rather than assumed away. None of their
markers appears anywhere in `.next/static`, so none of them reaches a browser.

Two things matter more than the count itself.

**`connect-src 'self'`.** A compromised dependency inside the page cannot send anything anywhere:
the CSP allows network calls only back to Orientim's own origin, and `img-src` is `'self' data:`. What
it could still do is alter the transaction before the wallet sees it — but the verifier lives in the
same bundle, so a compromised bundle is compromised whatever its dependency count. That is what the
reproducible build and SRI above are for, and it is why they matter more than this table.

**`npm ci` everywhere.** Every workflow installs from the lockfile, so a build uses the exact
versions recorded rather than whatever the `^` ranges resolve to that day. One deviation: `cpi.yml`
adds `litesvm@1.4.1` with `npm install --no-save`, because litesvm publishes no Windows binding and
only CI can run that test. It is pinned to an exact version but sits outside the lockfile.

One limit of this count: 81 of the locked entries are native binaries for platforms other than this
one (`@next/swc-*`, `sharp`, `litesvm`), so they are not installed here and could not be read. A
different subset installs on the deploy platform. The install-script figure above comes from the
lockfile's own `hasInstallScript` flags, which cover every entry regardless of platform.

A dependency update is therefore a security event, not a chore. It changes the bytes a browser runs,
and the digest published with the release is what makes that visible.

## One RPC provider

Orientim runs on a single RPC provider (Helius). That is an operational choice: two providers from two
companies would remove one trust assumption, at the cost of a second account, a second bill and a
second thing that can break.

The rules are applied to a snapshot the RPC provides, so the RPC is trusted for more than lookup
tables. What depends on it:

| Read | Used for | If the RPC lies |
| --- | --- | --- |
| Balance of the output account | The minimum-output check for a token output | Orientim's check can pass with less delivered, but Jupiter's floor still holds the route to the whole minimum: the verifier requires Jupiter to deliver into that same account and its floor (quote less tolerance) to reach the minimum, and Jupiter measures what its instruction delivered, not the balance |
| Lookup table contents | R1 | Together with a lying Jupiter, an account could be hidden. v1 transactions have no lookup tables |
| Owners and data of the route's accounts | R1's test for W's own accounts | A W account with a delegate the user set up earlier could be hidden |
| Mints: owner, decimals, extensions | R2, R7, amounts | A wrong decimals value reverts on chain (TransferChecked); a hidden extension falls back on the minimum |
| Simulation | The route rent sent to E | Up to the 0.005 SOL cap, stated before signing |
| Whether the treasury has an account | Fee on or off | Only Orientim's revenue |
| Blockhash, fee, epoch | Lifetime, the fee check, tax pricing | Expiry or a revert, never a loss |
| Statuses, block height | What the page and an agent report | For some 30 seconds after a swap's lifetime, a landed swap could be shown as expired; past it, "no record" is never read as expired (section "What an outcome proves") |

What does not depend on it: that W's signature never reaches the external program, the exact debit
templates, the fee caps, and the bytes the wallet signs.

A v1 transaction carries no lookup tables at all, so the assumption disappears as wallets adopt
it. Orientim does not cross-check the snapshot against a second provider.

## Operations and reporting

How production is run, paused and watched today is in `docs/OPERATORS.md`; how to report a
vulnerability is in `SECURITY.md` and on orientim.com/security.
