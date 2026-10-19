import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadPermissions, savePermissions, localAllows, permissionsPath } from "./permissions.ts";

describe("permissions.json mirror", () => {
  it("loads defaults when missing", async () => {
    const dir = await mkdtemp(join(tmpdir(), "rk-perm-"));
    try {
      const p = await loadPermissions(dir);
      assert.equal(p.version, 1);
      assert.equal(p.permission, "ask");
      assert.deepEqual(p.grants, []);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("round-trips save/load and respects standing grants", async () => {
    const dir = await mkdtemp(join(tmpdir(), "rk-perm-"));
    try {
      await savePermissions(
        {
          version: 1,
          permission: "ask",
          ceiling: null,
          computerUseGate: true,
          egressAllowed: false,
          grants: [
            { action: "run-command", grant: "always", target: "echo hi" },
            { action: "read-file", grant: "never" },
          ],
          updatedAt: new Date().toISOString(),
        },
        dir,
      );
      const path = permissionsPath(dir);
      const raw = JSON.parse(await readFile(path, "utf8"));
      assert.equal(raw.computerUseGate, true);

      const p = await loadPermissions(dir);
      assert.equal(localAllows(p, "run-command", "echo hi"), "allow");
      assert.equal(localAllows(p, "read-file", "x"), "deny");
      assert.equal(localAllows(p, "run-command", "ls"), "ask");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("never permission denies everything", async () => {
    const p = {
      version: 1 as const,
      permission: "never" as const,
      grants: [{ action: "run-command", grant: "always" as const }],
      updatedAt: new Date().toISOString(),
    };
    assert.equal(localAllows(p, "run-command", "echo"), "deny");
  });
});
