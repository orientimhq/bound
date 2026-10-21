#!/bin/sh
# Starts Orientim as the unprivileged `node` user. The volume (ORIENTIM_TERMS_DIR) is mounted owned by
# root, so it is handed to `node` first; nothing else runs as root.
set -e
if [ -n "$ORIENTIM_TERMS_DIR" ]; then
  mkdir -p "$ORIENTIM_TERMS_DIR"
  chown node:node "$ORIENTIM_TERMS_DIR"
fi
exec setpriv --reuid=node --regid=node --init-groups node /app/node_modules/next/dist/bin/next start -H 0.0.0.0 -p "${PORT:-8080}"
