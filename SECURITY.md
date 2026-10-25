# Security

Orientim Guard is a proof of concept. It is not deployed, not audited and holds no funds. Do not use
it with real money.

## What the program enforces

The rules are listed in [docs/GUARD.md](docs/GUARD.md) (I1–I11) and each one has fixed test cases;
the fuzzer runs a thousand random transactions per CI run and must catch two deliberately broken
copies of the program. In short: the agent can spend only through `Pull`, within the grant's limits,
only into a route between `Pull` and `Settle`, and every swap must deliver at least its minimum to
the owner's own account or revert. The authority's signature never reaches another program.

## What it does not protect against

- A loss within the limits the owner set: a grant that allows a slippage or a loss budget allows
  losses up to it.
- Token issuers' own powers (freeze, for example). Token-2022 mints with a permanent delegate and
  other risky extensions are refused.
- A compromised owner wallet: the owner can change the policy and the grants.

## Reporting

Report a vulnerability privately through GitHub's security advisories for this repository, not in
a public issue.
