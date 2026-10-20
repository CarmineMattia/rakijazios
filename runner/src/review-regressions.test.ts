// Regression tests for the PR #22 security review (C1-C3, H1-H3, M3).
import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { executeHostTool as raw } from "./host-tools.ts";
import { sandboxStatus } from "./sandbox.ts";
import { effectiveLocalPolicy, loadPermissions } from "./permissions.ts";
import { LocalRunnerClient } from "./client.ts";

const exec = (req: Parameters<typeof raw>[0]) => raw({ localDecision: "allow", ...req });
const skip =
  !sandboxStatus().ok && process.env.RAKAZO_TEST_REQUIRE_SANDBOX !== "1" ? "bubblewrap sandbox unavailable" : false;

describe("security review regressions", () => {
  const dirs: string[] = [];
  const tmp = async (p: string) => {
    const d = await mkdtemp(join(tmpdir(), p));
    dirs.push(d);
    return d;
  };
  after(async () => {
    for (const d of dirs) await rm(d, { recursive: true, force: true });
  });

  it("C1: write-file through a dangling symlink does not escape the root", async () => {
    const root = await tmp("rk-c1-");
    const outside = await tmp("rk-c1-out-");
    await symlink(join(outside, "created-by-write.txt"), join(root, "dangling"));
    await symlink(join(outside, "newdir"), join(root, "danglingdir"));
    for (const path of ["dangling", "danglingdir/x.txt"]) {
      const res = await exec({ action: "write-file", args: { path, content: "ESCAPED" }, hostRoot: root });
      assert.equal(res.ok, false, path);
      if (!res.ok) assert.match(res.error, /escapes/);
    }
    await assert.rejects(readFile(join(outside, "created-by-write.txt"), "utf8"));
    await assert.rejects(readFile(join(outside, "newdir/x.txt"), "utf8"));
    // a symlink that stays inside the root still works
    await mkdir(join(root, "real"));
    await symlink(join(root, "real"), join(root, "inlink"));
    const ok = await exec({ action: "write-file", args: { path: "inlink/f.txt", content: "fine" }, hostRoot: root });
    assert.equal(ok.ok, true);
    assert.equal(await readFile(join(root, "real/f.txt"), "utf8"), "fine");
  });

  it("C2/H3: the shell can't read runner credentials or rewrite permissions.json", { skip }, async () => {
    const root = await tmp("rk-c2-");
    const cfg = await tmp("rk-c2-cfg-");
    await writeFile(join(cfg, "credentials.json"), '{"token":"FAKE-DEVICE-TOKEN"}', "utf8");
    await writeFile(join(cfg, "permissions.json"), '{"permission":"ask"}', "utf8");
    const prev = process.env.RAKAZO_RUNNER_CONFIG_DIR;
    process.env.RAKAZO_RUNNER_CONFIG_DIR = cfg;
    try {
      const res = await exec({
        action: "run-command",
        args: {
          command: `cat ${cfg}/credentials.json; echo '{"permission":"always","egressAllowed":true,"computerUseGate":true}' > ${cfg}/permissions.json; echo end`,
        },
        hostRoot: root,
      });
      assert.equal(res.ok, true);
      if (res.ok) assert.doesNotMatch(String(res.output.stdout), /FAKE-DEVICE-TOKEN/);
      assert.equal(await readFile(join(cfg, "permissions.json"), "utf8"), '{"permission":"ask"}');
      const perms = await loadPermissions(cfg);
      assert.equal(perms.permission, "ask");
      // file tools can't reach it either
      const w = await exec({ action: "write-file", args: { path: `${cfg}/permissions.json`, content: "{}" }, hostRoot: root });
      assert.equal(w.ok, true); // stripped to a path *inside* the root (L3)
      assert.equal(await readFile(join(cfg, "permissions.json"), "utf8"), '{"permission":"ask"}');
    } finally {
      if (prev === undefined) delete process.env.RAKAZO_RUNNER_CONFIG_DIR;
      else process.env.RAKAZO_RUNNER_CONFIG_DIR = prev;
    }
  });

  it("H3: host tools are refused when the runner config dir is inside the host root", async () => {
    const root = await tmp("rk-h3-");
    const prev = process.env.RAKAZO_RUNNER_CONFIG_DIR;
    process.env.RAKAZO_RUNNER_CONFIG_DIR = join(root, ".config/rakazo-runner");
    try {
      for (const [action, args] of [
        ["run-command", { command: "true" }],
        ["write-file", { path: ".config/rakazo-runner/permissions.json", content: "{}" }],
        ["read-file", { path: "x" }],
      ] as const) {
        const res = await exec({ action, args: { ...args }, hostRoot: root });
        assert.equal(res.ok, false, action);
        if (!res.ok) assert.match(res.error, /overlaps the host root/);
      }
    } finally {
      if (prev === undefined) delete process.env.RAKAZO_RUNNER_CONFIG_DIR;
      else process.env.RAKAZO_RUNNER_CONFIG_DIR = prev;
    }
  });

  it("H1: host tools are off unless RAKAZO_HOST_TOOLS=1", () => {
    const prev = process.env.RAKAZO_HOST_TOOLS;
    try {
      for (const [val, expected] of [[undefined, false], ["", false], ["0", false], ["true", false], ["1", true]] as const) {
        if (val === undefined) delete process.env.RAKAZO_HOST_TOOLS;
        else process.env.RAKAZO_HOST_TOOLS = val;
        const c = new LocalRunnerClient({
          credentials: { gatewayWsUrl: "wss://example.invalid/ws", token: "t", deviceId: "d" } as never,
          runnerVersion: "0.0.0",
          log: () => {},
        });
        assert.equal((c as unknown as { hostToolsEnabled: boolean }).hostToolsEnabled, expected, String(val));
      }
    } finally {
      if (prev === undefined) delete process.env.RAKAZO_HOST_TOOLS;
      else process.env.RAKAZO_HOST_TOOLS = prev;
    }
  });

  it("H1: local 'ask' (the default) refuses even when the server says allow; local can only tighten", async () => {
    const base = await loadPermissions(await tmp("rk-h1-")); // defaults
    const env = { computerUseGate: true, egressAllowed: true };
    const d = effectiveLocalPolicy(base, env, "run-command", "ls");
    assert.equal(d.localDecision, "deny");
    assert.equal(d.computerUseGate, false); // file doesn't enable it
    assert.equal(d.egressAllowed, false);
    const always = effectiveLocalPolicy({ ...base, permission: "always", computerUseGate: true, egressAllowed: true }, { computerUseGate: false, egressAllowed: false }, "run-command", "ls");
    assert.equal(always.localDecision, "allow");
    assert.equal(always.computerUseGate, false); // env opt-in still required
    assert.equal(always.egressAllowed, false);
    const grant = effectiveLocalPolicy({ ...base, grants: [{ action: "read-file", grant: "always" }] }, env, "read-file", "a.txt");
    assert.equal(grant.localDecision, "allow");
    assert.equal(effectiveLocalPolicy({ ...base, grants: [{ action: "read-file", grant: "always" }] }, env, "run-command", "ls").localDecision, "deny");
    // executeHostTool itself fails closed without an explicit local decision
    const root = await tmp("rk-h1b-");
    const res = await raw({ action: "list-directory", args: { path: "." }, hostRoot: root });
    assert.equal(res.ok, false);
  });

  it("H2: network off can't be bypassed with quoting, /dev/tcp or interpreters", { skip }, async () => {
    const root = await tmp("rk-h2-");
    const res = await exec({
      action: "run-command",
      args: {
        command: [
          "command -v curl >/dev/null && { c''url -s -m 3 http://1.1.1.1/ >/dev/null 2>&1 && echo CURL_OK || echo CURL_FAIL; }",
          "(exec 3<>/dev/tcp/1.1.1.1/80) 2>/dev/null && echo TCP_OK || echo TCP_FAIL",
          "command -v python3 >/dev/null && { python3 -c 'import socket; socket.create_connection((\"1.1.1.1\", 80), 3)' 2>/dev/null && echo PY_OK || echo PY_FAIL; }",
          "true",
        ].join("; "),
      },
      hostRoot: root,
      egressAllowed: false,
    });
    assert.equal(res.ok, true);
    if (res.ok) {
      assert.doesNotMatch(String(res.output.stdout), /_OK/);
      assert.match(String(res.output.stdout), /TCP_FAIL/);
    }
  });

  it("M3: a second background shell can't reuse (and orphan) a running shell id", { skip }, async () => {
    const root = await tmp("rk-m3-");
    const first = await exec({ action: "run-command", args: { command: "sleep 30", background: true, shellId: "dup" }, hostRoot: root });
    assert.equal(first.ok, true);
    try {
      const second = await exec({ action: "run-command", args: { command: "sleep 30", background: true, shellId: "dup" }, hostRoot: root });
      assert.equal(second.ok, false);
      if (!second.ok) assert.match(second.error, /already in use/);
    } finally {
      const killed = await exec({ action: "kill-shell", args: { shellId: "dup" }, hostRoot: root });
      assert.equal(killed.ok, true);
    }
  });
});
