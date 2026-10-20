#!/usr/bin/env bash
# Full throwaway Rakijazios stack (postgres, supervisor, api, worker, web, mailpit) for running the
# e2e scripts (50-67, 80, 81, 90) against an unmerged branch, isolated from the live stack:
# own compose project rkfull-*, own volumes and networks, fresh database, throwaway secrets and
# mail CA, web/api published on 127.0.0.1 only at free ports. Never touches rakazo-* or ~/projects/rakazo.
# Seeds the QA fixtures the e2e scripts expect, the normal way (magic link, RPC, invite, sharing):
# qa@rakazo.test + qa2@rakazo.test, "QA Tester Bot", "QA Helper Bot", "Chief", "QA Group" shared with qa2,
# and an openai-compatible model connection pointing at nothing (the bot runs on the runner).
#   e2e/iso-full-stack.sh up          -> prints the dir; then:  . <dir>/iso-env.sh  and run e2e scripts
#   e2e/iso-full-stack.sh down <dir>  -> removes the containers, volumes, network and dir
# Note: the supervisor mounts /var/run/docker.sock (as on live). Runners in e2e talk to the local
# model server like the live e2e runs do (read-only use).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
IMAGE_DIGEST="${RAKAZO_APP_DIGEST:-1a70f06cf3c7a3f5c7f53e15b62f3c0709b81520ed40e671a1acb2ffcc40654c}"
compose() { docker compose -p "$P" -f docker-compose.images.yml -f docker-compose.override.yml -f docker-compose.iso.yml "$@"; }

if [ "${1:-}" = down ]; then
  D="${2:?dir}"; . "$D/iso.vars"
  case "$P" in rkfull-*) ;; *) echo "refusing: $P is not an rkfull-* project"; exit 2 ;; esac
  (cd "$D" && compose down -v --remove-orphans >/dev/null 2>&1) || true
  rm -f "/tmp/rk-e2e-$P.lock"; rm -rf "$D" "/tmp/rk-iso-e2e-$P"
  echo "removed $P"; exit 0
fi

P="rkfull-$(date +%H%M%S)-$RANDOM"
D="$(mktemp -d "/tmp/$P.XXXX")"
rsync -a --exclude .git --exclude node_modules "$ROOT/" "$D/"
cd "$D"
free() { python3 -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1",0)); print(s.getsockname()[1])'; }
WEBP=$(free); APIP=$(free); O="http://127.0.0.1:$WEBP"
rnd() { od -An -tx1 -N32 /dev/urandom | tr -d ' \n'; }
umask 077
cat > .env <<ENV
POSTGRES_USER=rakazo
POSTGRES_PASSWORD=$(rnd)
POSTGRES_DB=rakazo
BETTER_AUTH_SECRET=$(rnd)
ENCRYPTION_KEY=$(rnd)
SCREEN_PROXY_SECRET=$(rnd)
SANDBOX_SUPERVISOR_TOKEN=$(rnd)
BETTER_AUTH_URL=$O
WEB_ORIGIN=$O
API_URL=$O
RAKAZO_HOST=127.0.0.1
SIGNUPS_ENABLED=true
SMTP_URL=smtp://mailpit:1025
EMAIL_FROM=iso@example.invalid
RAKAZO_IMAGE=ghcr.io/elie222/rakazo/app@sha256
RAKAZO_IMAGE_TAG=$IMAGE_DIGEST
SANDBOX_PROVIDER=docker
ENV
umask 022
mkdir -p mailpit-tls && (cd mailpit-tls &&
  openssl req -x509 -newkey rsa:2048 -nodes -keyout ca.key -out ca.crt -days 2 -subj "/CN=$P-ca" 2>/dev/null &&
  openssl req -newkey rsa:2048 -nodes -keyout mailpit.key -out mailpit.csr -subj "/CN=mailpit" 2>/dev/null &&
  printf 'subjectAltName=DNS:mailpit\n' > ext &&
  openssl x509 -req -in mailpit.csr -CA ca.crt -CAkey ca.key -CAcreateserial -out mailpit.crt -days 2 -extfile ext 2>/dev/null &&
  rm -f ca.key && chmod 644 ca.crt mailpit.crt mailpit.key)
cat > docker-compose.iso.yml <<YML
services:
  api:
    ports: !override
      - "127.0.0.1:$APIP:3100"
    environment:
      NODE_EXTRA_CA_CERTS: /mailpit-tls/ca.crt
    volumes:
      - ./mailpit-tls/ca.crt:/mailpit-tls/ca.crt:ro,z
  worker:
    environment:
      NODE_EXTRA_CA_CERTS: /mailpit-tls/ca.crt
    volumes:
      - ./mailpit-tls/ca.crt:/mailpit-tls/ca.crt:ro,z
  web:
    ports: !override
      - "127.0.0.1:$WEBP:5173"
  mailpit:
    image: axllent/mailpit:latest
    networks: [app]
    environment:
      MP_SMTP_TLS_CERT: /tls/mailpit.crt
      MP_SMTP_TLS_KEY: /tls/mailpit.key
      MP_SMTP_AUTH_ACCEPT_ANY: "1"
      MP_SMTP_AUTH_ALLOW_INSECURE: "1"
    volumes:
      - ./mailpit-tls:/tls:ro,z
YML
printf 'P=%s\nWEBP=%s\nAPIP=%s\n' "$P" "$WEBP" "$APIP" > iso.vars
cat > iso-env.sh <<ENVSH
export RK_BASE=$O RK_API_DIRECT=http://127.0.0.1:$APIP RK_PG_CONTAINER=$P-postgres-1 RK_API_CONTAINER=$P-api-1
export RK_STACK_PREFIX=$P RK_E2E_LOCK=/tmp/rk-e2e-$P.lock RK_E2E_OUT=/tmp/rk-iso-e2e-$P
export RK_LIVE_DIST=$D/patches/web/dist   # 81 writes overlays here (this stack's web dist), never the live one
ENVSH
compose up -d >/dev/null 2>&1 || { compose ps; exit 1; }
for i in $(seq 1 180); do curl -fsS "http://127.0.0.1:$APIP/health" >/dev/null 2>&1 && curl -fsS -o /dev/null "$O/" 2>/dev/null && break; sleep 1; done
curl -fsS "http://127.0.0.1:$APIP/health" >/dev/null

# QA fixtures, created the way a user would (no secrets printed).
PSQL() { docker exec "$P-postgres-1" psql -U rakazo -d rakazo -Atc "$1"; }
J() { python3 -c 'import sys,json; d=json.load(sys.stdin); print(eval(sys.argv[1]))' "$1"; }
req() { curl -fsS -b "$D/cj-$1" -c "$D/cj-$1" -H 'content-type: application/json' -H "origin: $O" -X "$2" "$O$3" ${4:+-d "$4"}; }
for who in qa qa2; do
  curl -fsS -o /dev/null -H 'content-type: application/json' -H "origin: $O" -X POST "$O/api/auth/sign-in/magic-link" \
    -d "{\"email\":\"$who@rakazo.test\",\"callbackURL\":\"$O/app\"}"
  t=$(PSQL "select identifier from verification where value::text like '%\"$who@rakazo.test\"%' order by \"createdAt\" desc limit 1")
  curl -sS -o /dev/null -c "$D/cj-$who" "$O/api/auth/magic-link/verify?token=$t&callbackURL=$O/app"
done
BOT1=$(req qa POST /rpc/bots/create '{"json":{"name":"QA Tester Bot","description":"Isolated e2e bot"}}' | J 'd["json"]["id"]')
BOT2=$(req qa POST /rpc/bots/create '{"json":{"name":"QA Helper Bot","description":"Isolated e2e helper"}}' | J 'd["json"]["id"]')
req qa POST /rpc/bots/create '{"json":{"name":"Chief","description":"Isolated e2e default bot"}}' >/dev/null   # 64 needs qa's Chief
G=$(req qa POST /rpc/groups/create "{\"json\":{\"name\":\"QA Group\",\"botIds\":[\"$BOT1\",\"$BOT2\"]}}" | J 'd["json"]["id"]')
TOK=$(req qa POST /api/space-invites '{}' | J 'd.get("token") or d.get("url","").rsplit("/",1)[-1]')
req qa2 POST /api/space-invites/redeem "{\"token\":\"$TOK\"}" >/dev/null
QA2=$(PSQL "select id from \"user\" where email='qa2@rakazo.test'")
req qa POST "/api/group-sharing/groups/$G/people" "{\"userId\":\"$QA2\",\"shared\":true}" >/dev/null
req qa POST /rpc/models/connect '{"json":{"provider":"openai-compatible","baseUrl":"http://127.0.0.1:9/v1","modelId":"iso-dummy","label":"iso dummy"}}' >/dev/null
rm -f "$D"/cj-*
echo "DIR=$D"; echo "PROJECT=$P"; echo "WEB=$O"; echo "API=http://127.0.0.1:$APIP"
echo "next: . $D/iso-env.sh && cd e2e/m2b && node 60-m2b-bind.mjs"
