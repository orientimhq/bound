#!/bin/sh
# Deploys the commit checked out to Fly (docs/FLY.md). The image's ORIENTIM_BUILD_ID names that commit,
# so a tree with changes no commit holds is refused: the digest would vouch for code in no commit.
set -e
cd "$(git rev-parse --show-toplevel)"
if [ -n "$(git status --porcelain)" ]; then
  echo 'The working tree has changes no commit holds: commit or stash them, then deploy.' >&2
  git status --short >&2
  exit 1
fi
exec fly deploy --build-arg ORIENTIM_BUILD_ID="$(git rev-parse HEAD)" "$@"
