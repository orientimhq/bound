# Orientim on Fly.io, behind Cloudflare

One machine (`performance-1x`, 4 GB, `iad`), no Redis, Cloudflare's free plan in front for DNS, TLS,
DDoS protection and rate limits. The machine reaches Cloudflare through a Cloudflare Tunnel and has no
public address of its own. The image is `Dockerfile`; the machine is `fly.toml`.

## How it holds without Redis

`ORIENTIM_SINGLE_INSTANCE=1`: one process serves every request, so its memory is the state they all
share (one message per one-time key, one swap in flight per output account, the rate limits). Each
ticket and session carries the id of the process start that sealed it. After a restart or a deploy,
finalize refuses a ticket from before with 409 `server-restarted` and signs nothing: the agent prepares
again. A transaction already on chain is still answered as sent. The output accounts held for swaps
already sent are written to the volume (`ORIENTIM_STATE_DIR=/data`, `holds.json`) and read back at the
next start: a swap prepared after a restart into the same account waits (409 `output-in-flight`) until
the one sent before lands or expires. Never run two machines in this mode:
`fly.toml` keeps one, updated in place (`strategy = "rolling"`), so the old process stops before the
new one starts. Should a second one start anyway (`fly scale count 2`, a clone, another region), each
sees it in Fly's private DNS (`orientim.internal`, asked every 15 seconds), logs it, and finalize signs
nothing until one is left.

## First deploy

```sh
fly apps create orientim
fly volumes create orientim_data --region iad --size 1
fly secrets set RPC_URL=... RPC_URL_FALLBACK=... JUPITER_API_KEY=... \
  ORIENTIM_API_SECRET=... ORIENTIM_API_KEYS=... ORIENTIM_KEY_SECRET=... \
  ORIENTIM_ORIGIN_SECRET=$(node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))") \
  TUNNEL_TOKEN=...
tools/fly-deploy.sh
fly scale count 1
```

The secrets are the ones Vercel holds today, with the same values (a new `ORIENTIM_API_SECRET` would
end the tickets in flight; a new `ORIENTIM_KEY_SECRET` would end every self-serve key). `JUPITER_API_KEY`
is the Developer plan's key: `fly.toml` paces Jupiter to that plan's 600 requests a minute
(`ORIENTIM_JUPITER_PER_MINUTE`), and a Free key would answer 429 past 60. `TUNNEL_TOKEN` comes from
Cloudflare below. Keep the `ORIENTIM_ORIGIN_SECRET` value for Cloudflare too. Check: `fly status` shows
one machine, and `fly logs` shows the tunnel connected.

## Cloudflare (free plan)

1. Zero Trust, Networks, Tunnels: create a tunnel (cloudflared) named `orientim`, and copy its token into
   `fly secrets set TUNNEL_TOKEN=...`. The machine runs `cloudflared` beside Orientim and restarts it if
   it exits (`tools/fly-start.sh`).
2. In the tunnel, Public hostnames: `orientim.com` and `www.orientim.com`, service `http://localhost:8080`.
   Cloudflare writes the DNS records itself; no certificate is needed on Fly.
3. Rules, Transform Rules, Modify Request Header: for all incoming requests, set static
   `x-orientim-origin` to the `ORIENTIM_ORIGIN_SECRET` value. Without it, Orientim answers 404.
   The secret is required: in production on one machine, without it (or with one under 32
   characters) every request, `/api/live` included, is answered 503, so the deploy fails its check.
4. Security, WAF, Rate limiting rules (the free plan's one rule): path starts with `/api/`, 300 requests
   per 10 seconds per IP, block for 10 seconds. The app keeps its own limits per key and per address.
5. Security, WAF, Custom rules: a rule that blocks URI path starting with `/api/v1/`, saved **disabled**.
   Turning it on stops every swap and key request within seconds, with nothing on Fly touched.
6. Leave caching on its defaults: every API answer says `no-store`.
7. Once `https://orientim.com` answers through the tunnel, take the machine's public addresses away:
   `fly ips list`, then `fly ips release <address>` for each. `orientim.fly.dev` then answers nothing,
   and every request goes through Cloudflare's rules and limits. Fly's health check reaches the machine
   from inside Fly and keeps working.

`ORIENTIM_CLIENT_IP_HEADER=cf-connecting-ip` (in `fly.toml`): the rate limits count Cloudflare's client
address, which a request cannot set, since one without the origin header never gets in. Through the
tunnel, `[http_service.concurrency]` no longer applies (it is Fly's proxy that counts); the app's own
limits, per key, per address and in all, are what bound the load.

## The Terms record

Each acceptance is a file on the volume (`ORIENTIM_TERMS_DIR=/data`):
`/data/terms-acceptances/<day>/<wallet>-<time>-<random>.json`, never overwritten. Fly snapshots the
volume daily and keeps the snapshots 5 days; `fly ssh console` and `ls /data/terms-acceptances` to read
it. `df -i /data` shows the files left: each acceptance takes one.

## A deploy, and going back

`tools/fly-deploy.sh` builds and deploys the commit checked out, and refuses a tree with changes no
commit holds (the image's `ORIENTIM_BUILD_ID` names the commit). With one machine, a deploy is an
outage of about a minute: the old process stops, then the new one starts and passes its check. Swaps
prepared before are prepared again; meanwhile Cloudflare answers every request with an error. `fly releases` lists earlier
images; `fly deploy --image <image>` returns to one.

To pause swaps at once, with no restart: `fly ssh console -C "touch /data/paused"`; to resume:
`fly ssh console -C "rm /data/paused"`. `ORIENTIM_DISABLED=1` pauses too, but `fly secrets set`
restarts the machine. Faster still, from Cloudflare: the disabled rule of step 5.

`fly logs` shows what the machine is writing now; Fly keeps logs for a few days only.

## Pump.fun curves without Jupiter

`ORIENTIM_LOCAL_CURVE=1` (in `fly.toml`): a swap on an active Pump.fun bonding curve, SOL in or out, is
built from the chain (the curve, Pump's fee config and global account, Jupiter's lookup table) in one
RPC read, the same `route_v2` instruction Jupiter would give, without the round trip to Jupiter. It goes
through the same checks as Jupiter's answer, the verifier and the final simulation included. Whether a
pool elsewhere pays more is the agent's check: its own minimum comes from its own Jupiter quote. Anything it
does not know to build exactly as Jupiter does (a cashback coin, a curve's own creator fee, a second fee
tier, a classic SPL mint, fast mode, a narrower account budget) and every error goes to Jupiter. Each
route built here is an `orientim.curve_local` event, and each unexpected fallback an
`orientim.curve_fallback` event with its reason. The canary compares the two routes on new curves, buys
and sells, on every run: a difference fails it. Unset, every route comes from Jupiter.

## The lower fee for large swaps

Off. `NEXT_PUBLIC_ORIENTIM_FEE_TIER_BPS=15` in `[build.args]` makes swaps of $10,000 or more in USDC or
USDT pay 0.15%; `NEXT_PUBLIC_ORIENTIM_FEE_TIER_SOL` gives the SOL value from which a fee taken in SOL
does too. The site's and the docs' fee text change with it.
