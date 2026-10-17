# Security model

Orientim currently provides protected Solana swaps for agents and bots through the agent API,
the published skill and the command line. The website does not offer a browser swap. Its wallet
connection on the developer page signs a message to obtain an API key; it does not sign a trade.

## What a protected transaction enforces

Orientim builds one transaction around a Jupiter route. The wallet signs first; Orientim's
one-time authority signs last. The route receives only the input amount set aside for this swap,
not the wallet's general authority. The exact transaction is checked against rules R1–R7: only
expected instructions and signers, no persistent approval or account authority for the route,
a bounded network fee and rent, and an on-chain minimum output. If the minimum is not met, the
swap reverts; a network fee may still be paid. The rules, assumptions and counterexamples are
in [README.md](README.md); the agent flow is in [AGENT-API.md](AGENT-API.md).

The route and token must fit one protected transaction and pass verification and simulation.
Pump.fun launch-curve and PumpSwap routes are candidates, not blanket support for every token or
route. A route that is too large, leaves an account open, uses an unsupported token extension or
changes format is refused. Token issuer powers such as freeze or permanent delegate are stated
separately; isolation cannot remove issuer powers outside the swap.

## The independent check is a condition

The server builds the bytes the wallet is asked to sign. The skill and command line independently
check those exact bytes with chain state from the client's own RPC before signing. This check
limits what a compromised builder can make that client sign. A direct API client must run the
same check before handing bytes to its signer. An API key grants access and an optional
`x-orientim-skill` header helps compatibility; neither is evidence that a check happened.
`minOut` is required on prepare, but a caller can submit an arbitrary value, so that field alone
does not establish an independent market floor.

Price impact, slippage, MEV, token value and issuer actions are not solved by transaction
isolation. The skill gets its own quote and applies its price and impact limits. For larger
trades, compare another price source. On-chain checks enforce the supplied floor, not a fair
market price. If the client's RPC lies about state, the independent check is only as good as
that state; use an RPC controlled by or trusted by the owner.

## Signer and order boundaries

If an agent can read its wallet key file, it can sign outside Orientim. Keep unattended funds
in a separate signer that the agent cannot administer. That signer should inspect the exact
transaction and enforce the owner's wallet, token, per-swap and daily limits before returning
a signature. Give the agent a wallet funded only for its permitted work. A prompt or API key
cannot impose these limits on an agent that controls its key.

The API has no order database. Two prepares for one trading decision produce two transactions;
finalize idempotency applies only to the same ticket. The skill and command line keep durable
local order state, recover unknown results and lock a wallet on one machine. Direct clients
must implement the same behavior. Workers on several machines need shared atomic state and
daily-budget reservations. Never create a new order id to bypass an unknown outcome. See the
[direct API integration contract](AGENT-API.md#direct-api-integration-contract).

## Fees and availability

Orientim's fee is 25 bps (0.25%). The public deployment and agent API cap it at 30 bps (0.3%). The
shipped skill refuses a fee above 25 bps unless the owner's `maxFeeBps` allows up to 30, so the API
fee stays at 25. The
network fee, market account rent and token transfer tax are separate costs stated in the
prepare response. The core verifier enforces the same 30 bps ceiling (`MAX_FEE_BPS` in
`packages/core/src/constants.ts` of the public repository, orientimhq/orientim-protected-swap). The API fails closed if its fee configuration
exceeds 30 bps or the site's configured fee.

Jupiter routes and Solana state can change. A safe refusal, an expired transaction or an
unknown outcome is possible. Resolve an unknown signature against the chain before any retry.
The API can refuse a route or be unavailable; no token or route is guaranteed to trade.

The previous browser-swap threat model is retained only as a historical record in
[docs/LEGACY_BROWSER_SECURITY.md](docs/LEGACY_BROWSER_SECURITY.md). Its browser swap flow is
not the current product.

## Reporting a vulnerability

Please report privately, never in a public issue or pull request: through GitHub, **Security**, then
**Report a vulnerability**, on [orientimhq/orientim-protected-swap](https://github.com/orientimhq/orientim-protected-swap),
or by email, to the address in [orientim.com/.well-known/security.txt](https://orientim.com/.well-known/security.txt)
(also on [orientim.com/security](https://orientim.com/security#report)). Include what you found, the version, and a way to
reproduce it. Please give us reasonable time to fix it before you publish.

