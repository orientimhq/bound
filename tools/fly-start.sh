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
exec setpriv --reuid=node --regid=node --init-groups node /app/node_modules/next/dist/bin/next start -H 0.0.0.0 -p "${PORT:-8080}"
