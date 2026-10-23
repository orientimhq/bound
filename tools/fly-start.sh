#!/bin/sh
# Starts Orientim as the unprivileged `node` user. The volume (ORIENTIM_TERMS_DIR, ORIENTIM_STATE_DIR) is
# mounted owned by root, so it is handed to `node` first; nothing else runs as root.
set -e
for dir in "$ORIENTIM_TERMS_DIR" "$ORIENTIM_STATE_DIR"; do
  if [ -n "$dir" ]; then
    mkdir -p "$dir"
    chown node:node "$dir"
  fi
done
# Cloudflare Tunnel (docs/FLY.md), with the token from `fly secrets set TUNNEL_TOKEN=...`: started beside
# Orientim as the same unprivileged user, and again whenever it exits.
if [ -n "$TUNNEL_TOKEN" ]; then
  (
    while true; do
      setpriv --reuid=node --regid=node --init-groups cloudflared --no-autoupdate tunnel run || true
      sleep 2
    done
  ) &
fi
exec setpriv --reuid=node --regid=node --init-groups node /app/node_modules/next/dist/bin/next start -H 0.0.0.0 -p "${PORT:-8080}"
