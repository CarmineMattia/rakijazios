import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { executeHostTool } from "./host-tools.ts";

describe("host-tools", () => {
  it("lists and reads files under the host root", async () => {
    const root = await mkdtemp(join(tmpdir(), "rk-host-"));
    try {
      await writeFile(join(root, "note.txt"), "hello rakijazios", "utf8");
      const listed = await executeHostTool({
        action: "list-directory",
        args: { path: "." },
        hostRoot: root,
      });
      assert.equal(listed.ok, true);
      if (!listed.ok) return;
      const names = (listed.output.entries as Array<{ name: string }>).map((e) => e.name);
      assert.ok(names.includes("note.txt"));

      const read = await executeHostTool({
        action: "read-file",
        args: { path: "note.txt" },
        hostRoot: root,
      });
      assert.equal(read.ok, true);
      if (read.ok) assert.equal(read.output.text, "hello rakijazios");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("writes files and runs a command", async () => {
    const root = await mkdtemp(join(tmpdir(), "rk-host-"));
    try {
      const wrote = await executeHostTool({
        action: "write-file",
        args: { path: "out.txt", content: "x" },
        hostRoot: root,
      });
      assert.equal(wrote.ok, true);
      assert.equal(await readFile(join(root, "out.txt"), "utf8"), "x");

      const ran = await executeHostTool({
        action: "run-command",
        args: { command: "echo hi", cwd: "." },
        hostRoot: root,
      });
      assert.equal(ran.ok, true);
      if (ran.ok) assert.match(String(ran.output.stdout), /hi/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("refuses computer use when gate is off", async () => {
    const res = await executeHostTool({
      action: "computer-screenshot",
      args: {},
      computerUseGate: false,
    });
    assert.equal(res.ok, false);
    if (!res.ok) assert.equal(res.denied, true);
  });

  it("blocks path escape outside host root", async () => {
    const root = await mkdtemp(join(tmpdir(), "rk-host-"));
    try {
      const res = await executeHostTool({
        action: "read-file",
        args: { path: "../../etc/passwd" },
        hostRoot: root,
      });
      assert.equal(res.ok, false);
      if (!res.ok) assert.match(res.error, /escapes|Path/i);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("honors localDecision deny", async () => {
    const res = await executeHostTool({
      action: "run-command",
      args: { command: "echo no" },
      localDecision: "deny",
      hostRoot: await mkdtemp(join(tmpdir(), "rk-host-")),
    });
    assert.equal(res.ok, false);
    if (!res.ok) assert.equal(res.denied, true);
  });

  it("blocks network tools when egress is off", async () => {
    const root = await mkdtemp(join(tmpdir(), "rk-host-"));
    try {
      const res = await executeHostTool({
        action: "run-command",
        args: { command: "curl https://example.com" },
        hostRoot: root,
        egressAllowed: false,
      });
      assert.equal(res.ok, false);
      if (!res.ok) assert.equal(res.denied, true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("starts and kills a background shell", async () => {
    const root = await mkdtemp(join(tmpdir(), "rk-host-"));
    try {
      const started = await executeHostTool({
        action: "run-command",
        args: { command: "sleep 30", background: true, shellId: "test-shell-1" },
        hostRoot: root,
      });
      assert.equal(started.ok, true);
      if (!started.ok) return;
      assert.equal(started.output.shellId, "test-shell-1");

      const killed = await executeHostTool({
        action: "kill-shell",
        args: { shellId: "test-shell-1" },
        hostRoot: root,
      });
      assert.equal(killed.ok, true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("computer-wait works when gate is on (linux)", async () => {
    if (process.platform !== "linux") return;
    const res = await executeHostTool({
      action: "computer-wait",
      args: { ms: 10 },
      computerUseGate: true,
    });
    assert.equal(res.ok, true);
    if (res.ok) assert.equal(res.output.waitedMs, 10);
  });
});

describe("host-tools hardening", () => {
  it("does not follow a symlink inside the root that points outside it", async () => {
    const { symlink, mkdir } = await import("node:fs/promises");
    const root = await mkdtemp(join(tmpdir(), "rk-host-"));
    const outside = await mkdtemp(join(tmpdir(), "rk-out-"));
    try {
      await writeFile(join(outside, "secret.txt"), "outside", "utf8");
      await symlink(outside, join(root, "link"));
      await mkdir(join(root, "real"));
      for (const [action, args] of [
        ["read-file", { path: "link/secret.txt" }],
        ["list-directory", { path: "link" }],
        ["write-file", { path: "link/new.txt", content: "x" }],
        ["run-command", { command: "pwd", cwd: "link" }],
      ] as const) {
        const res = await executeHostTool({ action, args: { ...args }, hostRoot: root });
        assert.equal(res.ok, false, action);
        if (!res.ok) assert.match(res.error, /escapes/i);
      }
      await assert.rejects(readFile(join(outside, "new.txt"), "utf8"));
      const inside = await executeHostTool({
        action: "write-file",
        args: { path: "real/sub/new.txt", content: "ok" },
        hostRoot: root,
      });
      assert.equal(inside.ok, true);
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });

  it("kill-shell refuses an arbitrary pid that is not one of its background shells", async () => {
    const { spawn } = await import("node:child_process");
    const victim = spawn("sleep", ["30"]);
    try {
      const res = await executeHostTool({
        action: "kill-shell",
        args: { shellId: "nope", pid: victim.pid },
      });
      assert.equal(res.ok, false);
      assert.equal(victim.exitCode, null);
      assert.equal(victim.signalCode, null);
    } finally {
      victim.kill("SIGKILL");
    }
  });
});
