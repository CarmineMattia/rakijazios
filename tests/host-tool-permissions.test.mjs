/**
 * Pure permission helpers (P0) — node:test port of host-tool-permissions.test.ts
 * Avoids vitest so it runs in this checkout without the upstream monorepo.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = join(ROOT, "patches/api/host-tool-permissions.ts");

/** Load pure helpers via node --experimental-strip-types. */
function loadPureFromSource() {
  const raw = spawnSync(
    process.execPath,
    ["--experimental-strip-types", "-e", `
      import {
        matchAutoReview,
        normalizePermission,
        resolveWithCeiling,
        isHostToolAction,
        HOST_TOOL_ACTIONS,
      } from ${JSON.stringify(SRC)};
      console.log(JSON.stringify({
        n1: normalizePermission("nope"),
        n2: normalizePermission("always"),
        c1: resolveWithCeiling("always", "ask"),
        c2: resolveWithCeiling("ask", "never"),
        c3: resolveWithCeiling("never", "ask"),
        c4: resolveWithCeiling("always", null),
        b1: matchAutoReview("run-command rm -rf /", [], ["rm -rf"], true),
        b2: matchAutoReview("run-command ls", ["ls"], [], true),
        b3: matchAutoReview("run-command ls", ["ls"], [], false),
        a1: isHostToolAction("run-command"),
        a2: isHostToolAction("explode"),
        a3: isHostToolAction("kill-shell"),
        actions: HOST_TOOL_ACTIONS,
      }));
    `],
    { encoding: "utf8", cwd: ROOT },
  );
  if (raw.status !== 0) {
    throw new Error(raw.stderr || raw.stdout || "failed to load permissions module");
  }
  return JSON.parse(raw.stdout.trim().split("\n").pop());
}

describe("host-tool-permissions (node)", () => {
  const r = loadPureFromSource();

  it("normalizes unknown permission to ask", () => {
    assert.equal(r.n1, "ask");
    assert.equal(r.n2, "always");
  });

  it("applies ceiling so always cannot exceed ask", () => {
    assert.equal(r.c1, "ask");
    assert.equal(r.c2, "never");
    assert.equal(r.c3, "never");
    assert.equal(r.c4, "always");
  });

  it("matches auto-review allow/block rules", () => {
    assert.equal(r.b1, "block");
    assert.equal(r.b2, "allow");
    assert.equal(r.b3, null);
  });

  it("recognizes host actions including kill-shell", () => {
    assert.equal(r.a1, true);
    assert.equal(r.a2, false);
    assert.equal(r.a3, true);
    assert.ok(r.actions.includes("kill-shell"));
  });
});
