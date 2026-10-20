#!/usr/bin/env bash
# Install smoke: start a throwaway api (e2e/parity/isolated-stack.sh: own network, tmpfs PostgreSQL,
# 127.0.0.1 only) that serves ./runner as the installer bundle exactly like docker-compose.override.yml,
# then install the runner from it with the real install.sh, start it and wait for it to connect.
#   scripts/ci-install.sh     (needs docker, node >= 22.18, curl, tar)
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"; cd "$ROOT"
out="$(e2e/parity/isolated-stack.sh up)"
P="$(sed -n 's/^PROJECT=//p' <<<"$out")"; PORT="$(sed -n 's/^PORT=//p' <<<"$out")"
[ -n "$P" ] && [ -n "$PORT" ] || { echo "$out"; echo "isolated stack did not start"; exit 1; }
trap 'e2e/parity/isolated-stack.sh down "$P" >/dev/null' EXIT
echo "== install smoke against $P (127.0.0.1:$PORT)"
rc=0
RK_BASE="http://127.0.0.1:$PORT" node scripts/ci-install-smoke.mjs || rc=1
if docker logs "$P-api" 2>&1 | grep -E 'ERR_MODULE_NOT_FOUND|42601|42P01|syntax error at or near'; then echo "errors in api log"; rc=1; fi
[ "$rc" = 0 ] || docker logs --tail 40 "$P-api" 2>&1 | tail -40
exit "$rc"
