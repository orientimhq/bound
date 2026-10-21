# Orientim on Fly.io, behind Cloudflare

One machine (`performance-1x`, 4 GB, `iad`), no Redis, Cloudflare's free plan in front for DNS, TLS,
DDoS protection and rate limits. The image is `Dockerfile`; the machine is `fly.toml`.

## How it holds without Redis

`ORIENTIM_SINGLE_INSTANCE=1`: one process serves every request, so its memory is the state they all
share (one message per one-time key, one swap in flight per output account, the rate limits). Each
ticket and session carries the id of the process start that sealed it. After a restart or a deploy,
finalize refuses a ticket from before with 409 `server-restarted` and signs nothing: the agent prepares
again. A transaction already on chain is still answered as sent. Never run two machines in this mode:
`fly.toml` keeps one, updated in place (`strategy = "rolling"`), so the old process stops before the
new one starts.

## First deploy

```sh
fly apps create orientim
fly volumes create orientim_data --region iad --size 1
fly secrets set RPC_URL=... RPC_URL_FALLBACK=... JUPITER_API_KEY=... \
  ORIENTIM_API_SECRET=... ORIENTIM_API_KEYS=... ORIENTIM_KEY_SECRET=... \
  ORIENTIM_ORIGIN_SECRET=$(node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))")
fly deploy --build-arg ORIENTIM_BUILD_ID=$(git rev-parse HEAD)
fly scale count 1
```

The secrets are the ones Vercel holds today, with the same values (a new `ORIENTIM_API_SECRET` would
end the tickets in flight; a new `ORIENTIM_KEY_SECRET` would end every self-serve key). Keep the
`ORIENTIM_ORIGIN_SECRET` value for Cloudflare below. Check: `fly status` shows one machine, and
`https://orientim.fly.dev/api/live` answers `{"ok":true}` while every other path there answers 404.

## Cloudflare (free plan)

1. DNS: `orientim.com` and `www` as CNAME to `orientim.fly.dev`, proxied (orange cloud).
   On Fly: `fly certs add orientim.com` and `fly certs add www.orientim.com`.
2. SSL/TLS: Full (strict).
3. Rules, Transform Rules, Modify Request Header: for all incoming requests, set static
   `x-orientim-origin` to the `ORIENTIM_ORIGIN_SECRET` value. Without it, Fly answers 404.
4. Security, WAF, Rate limiting rules (the free plan's one rule): path starts with `/api/`, 300 requests
   per 10 seconds per IP, block for 10 seconds. The app keeps its own limits per key and per address.
5. Leave caching on its defaults: every API answer says `no-store`.

`ORIENTIM_CLIENT_IP_HEADER=cf-connecting-ip` (in `fly.toml`): the rate limits count Cloudflare's client
address, which a request cannot set, since one without the origin header never gets in.

## The Terms record

Each acceptance is a file on the volume (`ORIENTIM_TERMS_DIR=/data`):
`/data/terms-acceptances/<day>/<wallet>-<time>-<random>.json`, never overwritten. Fly snapshots the
volume daily; `fly ssh console` and `ls /data/terms-acceptances` to read it.

## A deploy, and going back

`fly deploy --build-arg ORIENTIM_BUILD_ID=$(git rev-parse HEAD)`. The machine restarts once: swaps
prepared in the seconds before are prepared again. `fly releases` lists earlier images;
`fly deploy --image <image>` returns to one. `ORIENTIM_DISABLED=1` (`fly secrets set`) pauses swaps.

## The lower fee for large swaps

Off. `NEXT_PUBLIC_ORIENTIM_FEE_TIER_BPS=15` in `[build.args]` makes swaps of $10,000 or more in USDC or
USDT pay 0.15%; `NEXT_PUBLIC_ORIENTIM_FEE_TIER_SOL` gives the SOL value from which a fee taken in SOL
does too. The site's and the docs' fee text change with it.
