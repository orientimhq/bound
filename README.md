# Orientim — Protected Swap

Protected swaps on Solana for AI agents and bots: swap SOL and SPL or Token-2022 tokens without giving
the swap program authority over the rest of the wallet. A token and route must fit one protected
transaction and pass verification and simulation; otherwise the API refuses them with a reason
([security model](SECURITY.md)).

> **What the agent approves is all the swap can touch.** The external swap program can move at most
> the amount approved, plus a market's one-time account fee when one is stated before the agent
> signs. It gets no spending authority over your other tokens, your NFTs or your SOL, no permission
> outlives the transaction, and the minimum output shown is enforced on successful execution: if
> less would arrive, the whole swap reverts. For a token output that check relies on the RPC's
> report of your balance of that token (see [security model](SECURITY.md)).

## How it works

1. The agent asks the API for a swap (`/api/v1/prepare`). Orientim's server makes a one-time key **E** for this
   swap alone, derived from a server secret and the swap's ticket.
2. In a single transaction, the wallet **W** moves exactly the amount to swap into a temporary account
   owned by E, pays the Orientim fee (0.25%), and only E and that account are given to the one untrusted
   instruction (Jupiter's swap). After the swap, Orientim checks that at least the minimum output
   arrived, then closes the temporary accounts back to W.
3. The **verifier** checks the exact bytes the wallet is asked to sign against 7 rules (below): on Orientim's
   server when it builds them, and again by the skill or command line on the client's own RPC before signing.
   A direct API client must run that independent check itself; its API key does not prove it happened.
4. The agent's wallet signs first (no send) and hands it to `/api/v1/finalize`. Orientim checks that the
   returned message is byte-for-byte the verified one with a valid W signature. Only then does E add the
   last required signature and Orientim sends it.

If the check refuses, the client must not sign. If an on-chain assertion fails, the swap reverts;
the network fee may still be charged. An agent with direct access to its key can sign outside this
flow, so unattended funds need a separate signer that enforces the owner's limits.

Signers: any key file or signing service that signs a transaction and hands it back unsent, with a
second signer left empty. Orientim builds v0 transactions; a v1 transaction is built only when a request asks for
`version: 1` and the deployment enables it (off on orientim.com), because not every signer reads v1
yet (Ledger's Solana app does not). Signers that
can only sign and send at once, and multisig or smart-wallet vaults (Squads, Swig), cannot sign first,
so they cannot use Orientim. The API key itself is signed for with any wallet that signs a message
(`/developers#access`) or with the skill's command line.

| Rule | Guarantee |
| --- | --- |
| R6 | Only W and E sign; W pays; the agent API accepts the wallet's signature over the exact verified message. Because W never appears in the external swap instruction, W's signature is unavailable to that program. Historical browser-wallet assertion handling is documented in [docs/LEGACY_BROWSER_SECURITY.md](docs/LEGACY_BROWSER_SECURITY.md) |
| R1 | W and W's token accounts (except the output account) never reach the external program, including through lookup tables; nor do Orientim's fee accounts. A token account of W that its issuer has frozen is refused, with the reason, instead of failing on chain |
| R2 | Every trusted instruction matches an exact template: amounts, accounts, order. No `Approve`, `SetAuthority`, stray transfers or closes. The output account's delegate is revoked before the swap, and the minimum output is checked after it. Jupiter's route must deliver into that output account (E's temporary one for SOL), where its own floor is measured. The fee is at most 1% when taken from the input before the swap or from a SOL, USDC or USDT output after the minimum is checked. For a pair neither token of which can carry it, the fee is paid in SOL from the wallet before the swap, priced by Jupiter when it is built: the verifier pins where it goes, and the agent holds it to its own price before the wallet signs |
| R3 | E and its accounts are fresh |
| R4 | The network fee paid by W is capped (never above 0.001 SOL). SOL sent to E is rent for an account the route opens, at most 0.005 SOL, and the route keeps at most 0.001 SOL of it: the rest is returned to W in the same transaction |
| R5 | One transaction within size limits; every temporary account is closed. Before signing, the exact transaction is simulated: nothing may stay under E, and no account the route opens may stay open |
| R7 | Input, output and intermediate mints are classic SPL, or Token-2022 carrying only extensions that cannot touch the swap (metadata, groups, close authority, confidential transfers and their fee, an unset transfer hook, accounts initialized by default, a permanent delegate that is an ordinary key, and a transfer fee on the swap's own mints) |

## Repository

```text
bound/
├── packages/
│   ├── core/       intent → policy, compiler, constants (pure, no network)
│   ├── verifier/   the 7 rules and the certificate (pure, no network, independent of the compiler) + tests
│   ├── solana/     chain snapshot, simulation, send/confirm, ephemeral key
│   └── jupiter/    Jupiter Swap API V2 client, prepare → finalize pipeline, route repair
├── apps/web/       Next.js site (home, developer docs, API keys, legal), CSP proxy, /api/status, /api/health
│                   and the agent API (/api/v1/prepare, /api/v1/finalize, /api/v1/keys)
├── skills/orientim-protected-swap/   the package agents and bots download: SKILL.md, the verifier bundle,
│                                  the `orientim-verify` command and the example (AGENT-API.md)
├── tests/
│   ├── integration/   mainnet simulations: T4, T1 and T5 (mainnet.ts), T7 sizes (large.ts), T9 cost of
│   │                  protection (thresholds.ts), Jupiter's floor, Pump.fun, Token-2022 and issuer stablecoins
│   └── cpi/           T6: a malicious swap program (Rust) executed against the protected transaction in a real Solana VM
├── tools/          skill build, release digest, live check, canary, agent API keys
├── docs/           OPERATORS.md (running the agent API)
└── .github/        CI, fuzz, T6, canary, monitor, release and live-check workflows
```

The verifier (`packages/verifier`, `@orientim/verifier`) imports only `@solana/kit`, the token program
client and Orientim's constants and types, never the compiler or the policy builder, and takes its
limits from `constants.ts`; a test enforces all of it. After a transaction passes every rule it
issues a certificate bound to the message's SHA-256, which travels with the prepared swap for a
wallet, an agent or an auditor; the prepare answer states the minimum and the costs.

Orientim supports any token pair that Jupiter can route and Orientim can safely isolate. It keeps no
customer, wallet or transaction database; hosting and RPC providers keep their own operational
logs.

## Requirements

- Node.js 22.18 or newer (the scripts run TypeScript directly)

## Commands

```bash
npm install
npm test                  # unit, mutation (M1–M17), audit regression, proxy and property tests
npm run test:fuzz         # every property at full size; the Fuzz workflow runs about 29 million cases in 81 jobs
npm run typecheck
npm run integration       # mainnet simulation: T4 + T1 + T5 (nothing is signed or sent)
npm run cpi               # T6: build the malicious program and run it (Linux or macOS)
npm run build             # production build of the site and the agent API
npm run start -w @orientim/web   # serve it on http://localhost:3000
node tools/agent-key.ts <id>   # an API key for the agent API (docs/OPERATORS.md)
node tools/agent-key.ts --key-secret   # the secret that turns on self-serve API keys (/developers#access)
node skills/orientim-protected-swap/examples/swap.ts   # the agent skill's example (SKILL.md); prints its usage
node tools/build-skill.ts             # rebuild the verifier bundled in the skill (CI checks it)
node tests/integration/jupiter-floor.ts   # Jupiter's on-chain floor and where it is measured, on mainnet state
node tools/canary.ts                  # do seven protected swaps, with every kind of fee, v1 and Pump.fun, still build and execute?
npm run build:digest      # one hash over everything the browser loads, to compare with a release
node tools/check-live.ts --site <url> --manifest build-digest.txt   # is a site serving that release?
```

## Configuration

Copy `apps/web/.env.example` to `apps/web/.env.local`.

Fixed at build time (compiled into the build, so they cannot change without a new deploy):

| Variable | Default | Meaning |
| --- | --- | --- |
| `NEXT_PUBLIC_ORIENTIM_TREASURY` | — | Fee wallet. Empty = test mode, no fee. The fee is taken like Jupiter's: in SOL first, then USDC, then USDT, on whichever side of the swap they are; otherwise in the input token. Fund the wallet with a little SOL and open its USDC and USDT accounts: then every swap pays, memecoin sales included; a pair neither token of which the treasury can receive pays in SOL from the wallet, at the swap's value. With a treasury set, a swap whose fee cannot be collected (the wallet not funded yet, a pair that cannot be priced in SOL, an amount too small to carry it) is refused, never built free |
| `NEXT_PUBLIC_ORIENTIM_FEE_BPS` | 25 | 0.25%. Production configuration and the shipped agent skill refuse more than 30 bps. The agent API also refuses an `ORIENTIM_API_FEE_BPS` above 30 bps. |
| `NEXT_PUBLIC_ORIENTIM_ENABLE_V1` | — | `1` lets the agent API build a v1 transaction when a request asks for `version: 1`. Off until an Orientim v1 swap has landed on mainnet |
| `ORIENTIM_ENABLE_FAST_ROUTING` | — | `1` allows agent requests with `routingMode: "fast"`. Off by default. Jupiter fast routing is beta and can worsen price or priority fee; the bot must still opt in, and the standard baseline, simulation, and verifier remain mandatory. |
| `ORIENTIM_OWN_ROUTES` | on | `0` turns off routes agents bring with their own Jupiter key (`ownRoutes`): prepare then builds every swap with Orientim's key and ignores `ownRoutes`, `routes` and `session`. A fee on the output is held to Orientim's own price either way. |

Server only (never sent to the browser):

| Variable | Default | Meaning |
| --- | --- | --- |
| `RPC_URL` | public mainnet RPC | Solana RPC for the server. Use a reliable provider; clients must use their own trusted RPC for independent verification |
| `RPC_URL_FALLBACK` | none | A backup RPC from another provider, asked only when `RPC_URL` does not answer, is rate-limited or fails. A send takes its answer only when it is a success |
| `JUPITER_API_KEY` | — | Required for any real use (free at developers.jup.ag/portal): Jupiter asks for a key on every endpoint and throttles keyless requests after one or two, so quotes fail as "busy". `/api/status` says whether it is set |
| `ORIENTIM_DISABLED` | 0 | Kill switch: `1` (or `true`) makes the server refuse new swaps and new API keys |
| `ORIENTIM_CLIENT_IP_HEADER` | `x-vercel-forwarded-for` | The one header your ingress overwrites with the client address (Cloudflare: `cf-connecting-ip`). The app's rate limit is per instance; add a rule in the hosting firewall too |
| `ORIENTIM_EXCLUDE_DEXES` | `HumidiFi` | DEXes whose per-taker rent is too high to pay on every swap |
| `ORIENTIM_MAX_NETWORK_FEE_LAMPORTS` | 500000 | F_max, capped at 1,000,000 by the verifier |

### Deploy: the firewall

The app's own limits are per instance and in memory; the hosting firewall is what holds under load,
and what stops a script from spending Orientim's RPC (Helius) and Jupiter quota through the agent API.
On Vercel, add rate-limit rules per client IP, for example:

| Path | Limit | Why |
| --- | --- | --- |
| `/api/v1/*` | 120 per minute | The agent API; each key has its own limit too (`ORIENTIM_API_PER_MINUTE`) |

The agent API uses `RPC_URL` and `JUPITER_API_KEY`, or `RPC_URL_AGENTS` and `JUPITER_API_KEY_AGENTS`
when they are set (Jupiter counts rate limits per organisation, so a second key in the same one shares
its limit). Set usage alerts at the RPC provider (Helius: credit usage) and on the hosting bill, so
abnormal consumption is seen the day it starts.

## Scope

Protected: authority over the wallet and everything in it except the approved amount, and the
positive `minOut` the caller supplied, which the transaction enforces on chain. The skill obtains
that floor from its own quote and holds its price and slippage limits; direct API clients must
do those checks themselves. If the market cannot meet the supplied floor, the API answers
`price-moved` rather than lowering it.
Every router must compile its quote to this same exact on-chain balance floor. A router-only or
off-chain minimum is not accepted as protection; a route that cannot express the floor is refused.
Not in scope: price movement and MEV within that tolerance, the value of the token you buy,
approvals granted elsewhere before, phishing sites that do not use Orientim, and Token-2022 tokens
whose extensions Orientim refuses (a permanent delegate a program can sign for, frozen by default,
pausable and the rest), and what a token's own issuer can do outside
the swap (PYUSD's, for example, can move it in any wallet; the prepare answer says so). Transfer-fee tokens are supported: Orientim prices the active schedule
from the current epoch and harvests temporary accounts before closing them.

See `SECURITY.md` for the threat model, `AGENT-API.md` for the agent API and `docs/OPERATORS.md` for
running it.
