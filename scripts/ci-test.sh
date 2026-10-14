#!/usr/bin/env bash
# Rakijazios checks (CI and local): runner tests, typecheck and unit tests of the patches.
# Typecheck/unit tests run inside the published app image with this checkout's patches mounted
# exactly like docker-compose.override.yml does on Host-001. Exits non-zero on any failure.
#   scripts/ci-test.sh            (needs node >= 22.18 and docker)
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"; cd "$ROOT"
IMAGE="${RAKAZO_APP_IMAGE:-ghcr.io/elie222/rakazo/app:edge}"
fail=0

echo "== runner tests"
(cd runner && node --experimental-strip-types --test src/*.test.ts) || fail=1

# Mounts: every ./patches/... → /app/... bind in the override (web dist, vite config and supervisor are not typechecked here).
mounts=()
while IFS=: read -r src dst; do
  [ -e "${src#./}" ] && mounts+=(-v "$ROOT/${src#./}:$dst:ro,z")
done < <(grep -o '\./patches/[^:]*:/app[^:]*' docker-compose.override.yml | grep -v 'web/dist\|vite.config\|supervisor' | sort -u -t: -k2,2)

tests=()
for f in patches/api/*.test.ts; do
  b=$(basename "$f")
  [ "$b" = group-sharing.postgres.test.ts ] && continue   # needs a live Postgres
  case "$b" in executor-shared-local.test.ts) d=/app/packages/adapters/src/$b ;; *) d=/app/apps/api/src/$b ;; esac
  mounts+=(-v "$ROOT/$f:$d:ro,z"); tests+=("${d#/app/}")
done
for f in patches/auth/*.test.ts; do
  d=/app/packages/auth/src/$(basename "$f"); mounts+=(-v "$ROOT/$f:$d:ro,z"); tests+=("${d#/app/}")
done

# Canary: one deliberate type error proves tsc really reads the mounted files (SELinux/permissions can hide them).
canary="$(mktemp -d)/zz-canary.ts"; echo 'const rkCanary: number = "canary"; export {};' > "$canary"; chmod 644 "$canary"
mounts+=(-v "$canary:/app/apps/api/src/zz-canary.ts:ro,z")

echo "== typecheck + unit tests ($IMAGE, ${#tests[@]} test files)"
docker run --rm -u 0 --network none -e TESTS="${tests[*]}" "${mounts[@]}" "$IMAGE" sh -c '
  rc=0
  cd /app/apps/api
  out=$(/app/node_modules/.bin/tsc --noEmit -p tsconfig.json 2>&1 || true)
  n=$(printf "%s\n" "$out" | grep -c "error TS" || true)
  if [ "$n" != 1 ] || ! printf "%s\n" "$out" | grep -q zz-canary; then printf "%s\n" "$out" | grep -v zz-canary | head -40; echo "api tsc: FAIL ($n errors, expected only the canary)"; rc=1; else echo "api tsc: ok"; fi
  for p in adapters auth; do
    cd /app/packages/$p
    if /app/node_modules/.bin/tsc --noEmit -p tsconfig.json; then echo "$p tsc: ok"; else echo "$p tsc: FAIL"; rc=1; fi
  done
  cd /app && /app/node_modules/.bin/vitest run $TESTS || rc=1
  exit $rc
' || fail=1

[ "$fail" = 0 ] && echo "== ALL CHECKS PASSED" || echo "== CHECKS FAILED"
exit "$fail"
