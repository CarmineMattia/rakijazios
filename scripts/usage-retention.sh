#!/bin/sh
# M3b(c) usage retention, run by hand. Dry run by default (counts only).
#   scripts/usage-retention.sh [days]          → count raw usage rows older than <days> (default: RK_LOCAL_USAGE_RETENTION_DAYS or 90), per owner
#   scripts/usage-retention.sh [days] --apply  → fold them into local_runner_usage_daily and delete them (batched)
# The api server also does this by itself every 6 h.
set -eu
DAYS="${1:-}"; MODE="${2:-}"
[ "$DAYS" = "--apply" ] && { MODE=--apply; DAYS=""; }
C="${RK_API_CONTAINER:-rakazo-api-1}"
exec docker exec -w /app/apps/api -e RK_DAYS="$DAYS" -e RK_MODE="$MODE" "$C" /app/node_modules/.bin/tsx --eval '
import { createDb } from "@rakazo/db";
import { countExpiredUsage, sweepUsage, usageRetentionDays } from "./src/local-runners.ts";
const days = usageRetentionDays(process.env.RK_DAYS || process.env.RK_LOCAL_USAGE_RETENTION_DAYS);
const { prisma: p, pool } = createDb(process.env.DATABASE_URL!);
(async () => { try {
  if (days === null) { console.log(JSON.stringify({ disabled: true })); }
  else if (process.env.RK_MODE === "--apply") console.log(JSON.stringify({ days, applied: await sweepUsage(p, days) }));
  else console.log(JSON.stringify({ days, dryRun: await countExpiredUsage(p, days) }));
} finally { await p.$disconnect(); await pool.end(); } })().catch((e) => { console.error(e); process.exit(1); });
'
