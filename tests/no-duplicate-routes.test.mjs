// H5: every HTTP route is registered once across the api patches (Hono serves the first
// registration, so a second copy is dead code that can silently diverge in its auth checks).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const API = join(dirname(fileURLToPath(import.meta.url)), "../patches/api");

test("no route is registered twice in patches/api", () => {
  const seen = new Map();
  const dups = [];
  for (const f of readdirSync(API).filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"))) {
    const src = readFileSync(join(API, f), "utf8");
    for (const m of src.matchAll(/\bapp\.(get|post|put|patch|delete)\(\s*["'`]([^"'`]+)["'`]/g)) {
      const key = `${m[1].toUpperCase()} ${m[2]}`;
      if (seen.has(key)) dups.push(`${key} (${seen.get(key)} and ${f})`);
      else seen.set(key, f);
    }
  }
  assert.deepEqual(dups, []);
  assert.ok(seen.has("GET /api/local-runners/offered-models"));
  assert.ok(seen.has("POST /api/host-tools/approvals/:id/decision"));
});
