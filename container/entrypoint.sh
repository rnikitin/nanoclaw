#!/bin/bash
# Container entrypoint: compile TS if source changed, then run agent runner.
# Source hash lives in /app/dist/.build-hash (image-built) or /tmp/dist/.build-hash (runtime-built).
# If the mounted /app/src matches either, skip tsc — saves ~4s per cold start.
set -e
cd /app

HASH=$(find src -name '*.ts' -type f -print0 | sort -z | xargs -0 md5sum | md5sum | awk '{print $1}')

if [ -f /app/dist/.build-hash ] && [ "$(cat /app/dist/.build-hash)" = "$HASH" ]; then
  DIST=/app/dist
  echo "nanoclaw: source matches image build, using /app/dist" >&2
elif [ -f /tmp/dist/.build-hash ] && [ "$(cat /tmp/dist/.build-hash)" = "$HASH" ]; then
  DIST=/tmp/dist
  echo "nanoclaw: source matches /tmp cache, skipping tsc" >&2
else
  echo "nanoclaw: source changed, compiling" >&2
  rm -rf /tmp/dist
  npx tsc --outDir /tmp/dist 2>&1 >&2
  printf '%s' "$HASH" > /tmp/dist/.build-hash
  [ -e /tmp/dist/node_modules ] || ln -s /app/node_modules /tmp/dist/node_modules
  chmod -R a-w /tmp/dist
  DIST=/tmp/dist
fi

cat > /tmp/input.json
node "$DIST/index.js" < /tmp/input.json
