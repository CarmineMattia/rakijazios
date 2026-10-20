#!/usr/bin/env bash
# Throwaway Rakijazios api stack for e2e of unmerged branches, isolated from the live stack:
# own project name/containers, own docker network, tmpfs PostgreSQL (no volumes), random
# throwaway secrets, api published on 127.0.0.1 only at a free port. Never touches rakazo-*.
#   e2e/parity/isolated-stack.sh up   -> prints PROJECT=..., PORT=..., PG=..., API=...
#   e2e/parity/isolated-stack.sh down PROJECT
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"; cd "$ROOT"
IMAGE="${RAKAZO_APP_IMAGE:-ghcr.io/elie222/rakazo/app@sha256:1a70f06cf3c7a3f5c7f53e15b62f3c0709b81520ed40e671a1acb2ffcc40654c}"
PG_IMAGE="${POSTGRES_IMAGE:-postgres:16@sha256:e17e86066e5ef83e0952a9347f5c792b7ece00972e2aa787a6986f471b3dd3d5}"

if [ "${1:-}" = down ]; then
  P="${2:?project}"
  case "$P" in rkiso-*) ;; *) echo "refusing to remove non-rkiso project $P"; exit 2 ;; esac
  docker rm -f "$P-api" "$P-pg" >/dev/null 2>&1 || true
  docker network rm "$P-net" >/dev/null 2>&1 || true
  echo "removed $P"; exit 0
fi

P="rkiso-$(date +%H%M%S)-$RANDOM"
PORT="$(python3 -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1",0)); print(s.getsockname()[1])')"
rnd() { od -An -tx1 -N32 /dev/urandom | tr -d ' \n'; }
PGPASS="$(rnd)"; ORIGIN="http://127.0.0.1:$PORT"

mounts=()
while IFS=: read -r src dst; do
  [ -e "${src#./}" ] && mounts+=(-v "$ROOT/${src#./}:$dst:ro,z")
done < <(grep -o '\./\(patches\|runner\)[^:]*:/app[^:]*' docker-compose.override.yml | grep -v 'web/dist\|vite.config\|supervisor' | sort -u -t: -k2,2)

docker network create "$P-net" >/dev/null
docker run -d --name "$P-pg" --network "$P-net" --tmpfs /var/lib/postgresql/data \
  -e POSTGRES_USER=rakazo -e POSTGRES_PASSWORD="$PGPASS" -e POSTGRES_DB=rakazo "$PG_IMAGE" >/dev/null
for i in $(seq 1 60); do docker exec "$P-pg" pg_isready -U rakazo -d rakazo >/dev/null 2>&1 && break; sleep 1; done
docker run -d --name "$P-api" --network "$P-net" -p "127.0.0.1:$PORT:3100" -u 0 "${mounts[@]}" \
  -e NODE_ENV=production -e API_HOST=0.0.0.0 -e DATABASE_URL="postgres://rakazo:$PGPASS@$P-pg:5432/rakazo" \
  -e DATA_DIR=/tmp/rkdata -e BETTER_AUTH_SECRET="$(rnd)" -e ENCRYPTION_KEY="$(rnd)" \
  -e SANDBOX_SUPERVISOR_TOKEN="$(rnd)" -e SCREEN_PROXY_SECRET="$(rnd)" \
  -e BETTER_AUTH_URL="$ORIGIN" -e WEB_ORIGIN="$ORIGIN" -e API_URL="$ORIGIN" \
  -e SANDBOX_PROVIDER=docker -e SANDBOX_SUPERVISOR_URL=http://127.0.0.1:9 -e CLOUD_AGENT_PROVIDER=none \
  -e WAKEUP_DRIVER=graphile -e AGENT_RUNTIME=pi -e RAKAZO_LOCAL_RUNNERS_UI=1 -e RAKAZO_HOST_APPROVAL_TTL_MS="${RAKAZO_HOST_APPROVAL_TTL_MS:-600000}" \
  "$IMAGE" bash -lc 'mkdir -p /tmp/rkdata && pnpm --filter @rakazo/db exec prisma migrate deploy >/tmp/migrate.log 2>&1 || { cat /tmp/migrate.log; exit 1; }; pnpm --filter @rakazo/api start' >/dev/null
for i in $(seq 1 120); do
  curl -fsS "$ORIGIN/health" >/dev/null 2>&1 && break
  [ "$(docker inspect -f '{{.State.Running}}' "$P-api")" = true ] || { docker logs --tail 50 "$P-api"; exit 1; }
  sleep 1
done
curl -fsS "$ORIGIN/health" >/dev/null
echo "PROJECT=$P"; echo "PORT=$PORT"; echo "PG=$P-pg"; echo "API=$P-api"
