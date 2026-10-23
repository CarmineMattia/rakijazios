#!/usr/bin/env bash
# Boot smoke: start the api (pinned app image + this checkout's patches) against a throwaway
# PostgreSQL, run the real migrations and the patches' CREATE TABLE/ALTER statements, and fail if
# the api does not come up healthy or logs an SQL error (e.g. 42601 reserved word). Then run the
# *.postgres.test.ts suites against that database (group sharing on its own rakazo_sharing_test database).
#   scripts/ci-boot.sh     (needs docker; isolated: own network, tmpfs database, no published ports)
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"; cd "$ROOT"
IMAGE="${RAKAZO_APP_IMAGE:-ghcr.io/elie222/rakazo/app@sha256:1a70f06cf3c7a3f5c7f53e15b62f3c0709b81520ed40e671a1acb2ffcc40654c}"
PG_IMAGE="${POSTGRES_IMAGE:-postgres:16@sha256:e17e86066e5ef83e0952a9347f5c792b7ece00972e2aa787a6986f471b3dd3d5}"
P="rkci-boot-$$-$RANDOM"
NET="$P-net"
DB=rakazo_ci
PGPASS="ci-$(od -An -tx1 -N12 /dev/urandom | tr -d ' \n')"
rnd() { od -An -tx1 -N32 /dev/urandom | tr -d ' \n'; }   # throwaway values, never stored
AUTH_SECRET="$(rnd)"; ENC_KEY="$(rnd)"; SUP_TOKEN="$(rnd)"; SCREEN_SECRET="$(rnd)"
DBURL="postgres://rakazo:$PGPASS@$P-pg:5432/$DB"

cleanup() {
  docker rm -f "$P-api" "$P-pg" >/dev/null 2>&1 || true
  docker network rm "$NET" >/dev/null 2>&1 || true
}
trap cleanup EXIT

mounts=()
while IFS=: read -r src dst; do
  [ -e "${src#./}" ] && mounts+=(-v "$ROOT/${src#./}:$dst:ro,z")
done < <(grep -o '\./\(patches\|runner\)[^:]*:/app[^:]*' docker-compose.override.yml | grep -v 'web/dist\|vite.config\|supervisor' | sort -u -t: -k2,2)

docker network create --internal "$NET" >/dev/null
docker run -d --name "$P-pg" --network "$NET" --tmpfs /var/lib/postgresql/data \
  -e POSTGRES_USER=rakazo -e POSTGRES_PASSWORD="$PGPASS" -e POSTGRES_DB="$DB" "$PG_IMAGE" >/dev/null
for i in $(seq 1 60); do
  docker exec "$P-pg" pg_isready -U rakazo -d "$DB" >/dev/null 2>&1 && break
  sleep 1
done

echo "== boot api against throwaway PostgreSQL ($P)"
docker run -d --name "$P-api" --network "$NET" -u 0 "${mounts[@]}" \
  -e NODE_ENV=production -e API_HOST=0.0.0.0 -e DATABASE_URL="$DBURL" -e DATA_DIR=/tmp/rkdata \
  -e BETTER_AUTH_SECRET="$AUTH_SECRET" -e BETTER_AUTH_URL=http://127.0.0.1:5173 \
  -e WEB_ORIGIN=http://127.0.0.1:5173 -e API_URL=http://127.0.0.1:5173 \
  -e SANDBOX_PROVIDER=docker -e SANDBOX_SUPERVISOR_URL=http://127.0.0.1:9 -e SANDBOX_SUPERVISOR_TOKEN="$SUP_TOKEN" \
  -e ENCRYPTION_KEY="$ENC_KEY" -e SCREEN_PROXY_SECRET="$SCREEN_SECRET" \
  -e CLOUD_AGENT_PROVIDER=none -e WAKEUP_DRIVER=graphile -e AGENT_RUNTIME=pi \
  "$IMAGE" bash -lc 'mkdir -p /tmp/rkdata && pnpm --filter @rakazo/db exec prisma migrate deploy >/tmp/migrate.log 2>&1 || { cat /tmp/migrate.log; exit 1; }; pnpm --filter @rakazo/api start' >/dev/null

probe() { docker exec "$P-api" node -e "fetch('http://127.0.0.1:3100$1').then(r=>{console.log(r.status)}).catch(()=>console.log('ERR'))" 2>/dev/null || echo ERR; }
up=0
for i in $(seq 1 120); do
  if [ "$(docker inspect -f '{{.State.Running}}' "$P-api" 2>/dev/null)" != true ]; then break; fi
  [ "$(probe /health)" = 200 ] && { up=1; break; }
  sleep 1
done
fail=0
if [ "$up" != 1 ]; then
  echo "api did not become healthy:"; docker logs --tail 80 "$P-api" 2>&1; exit 1
fi
echo "api healthy"

# Routes whose first request runs the patches' DDL (host-tool tables, approvals, parity tables).
check() {
  local path=$1 want=$2 got
  got=$(probe "$path")
  if [ "$got" = "$want" ]; then echo "  $path -> $got ok"; else echo "  $path -> $got (want $want) FAIL"; fail=1; fi
}
check /api/host-tools/actions 200
check /api/host-tools/permissions 401
check /api/host-tools/approvals 401
check /api/parity/background-shells 401

sleep 2
if [ "$(docker inspect -f '{{.State.Running}} {{.RestartCount}}' "$P-api")" != "true 0" ]; then
  echo "api is not running cleanly"; fail=1
fi
if docker logs "$P-api" 2>&1 | grep -E '42601|42P01|42703|syntax error at or near|PrismaClientKnownRequestError|Raw query failed'; then
  echo "SQL errors in api log"; fail=1
fi

echo "== PostgreSQL suites (*.postgres.test.ts) against the throwaway database"
pgmounts=()
pgtests=()
for f in patches/api/*.postgres.test.ts; do
  b=$(basename "$f")
  [ "$b" = group-sharing.postgres.test.ts ] && continue   # own rakazo_sharing_test database, below
  d=/app/apps/api/src/$b; pgmounts+=(-v "$ROOT/$f:$d:ro,z"); pgtests+=("${d#/app/}")
done
if [ "${#pgtests[@]}" -gt 0 ]; then
  docker run --rm --network "$NET" -u 0 "${mounts[@]}" "${pgmounts[@]}" \
    -e RAKAZO_CI_DATABASE_URL="$DBURL" -e VERIFY_HOST_TOOLS_PG=true -e TESTS="${pgtests[*]}" \
    "$IMAGE" sh -c 'cd /app && /app/node_modules/.bin/vitest run $TESTS' || fail=1
fi

# group-sharing.postgres.test.ts refuses any database not named rakazo_sharing_test (it writes fixtures),
# so give it its own migrated database on the same throwaway server.
if [ -e patches/api/group-sharing.postgres.test.ts ]; then
  echo "== group sharing suite against its own throwaway rakazo_sharing_test database"
  SHARE_URL="postgres://rakazo:$PGPASS@$P-pg:5432/rakazo_sharing_test"
  docker exec "$P-pg" createdb -U rakazo rakazo_sharing_test || fail=1
  d=/app/apps/api/src/group-sharing.postgres.test.ts
  docker run --rm --network "$NET" -u 0 "${mounts[@]}" -v "$ROOT/patches/api/group-sharing.postgres.test.ts:$d:ro,z" \
    -e DATABASE_URL="$SHARE_URL" -e VERIFY_DATABASE=1 -e VERIFY_GROUP_SHARING=true -e TESTS="${d#/app/}" \
    "$IMAGE" sh -c 'cd /app && { pnpm --filter @rakazo/db exec prisma migrate deploy >/tmp/migrate.log 2>&1 || { cat /tmp/migrate.log; exit 1; }; } && /app/node_modules/.bin/vitest run $TESTS' || fail=1
fi

[ "$fail" = 0 ] && echo "== BOOT SMOKE PASSED" || { echo "== BOOT SMOKE FAILED"; docker logs --tail 60 "$P-api" 2>&1 | tail -60; }
exit "$fail"
