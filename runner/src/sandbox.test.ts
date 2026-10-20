import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { executeHostTool as executeHostToolRaw } from "./host-tools.ts";

// The runner only calls executeHostTool after the local permissions.json allowed the action.
const executeHostTool = (req: Parameters<typeof executeHostToolRaw>[0]) =>
  executeHostToolRaw({ localDecision: "allow", ...req });
import { escalationAttempt, resetSandboxCache, sandboxStatus } from "./sandbox.ts";

const skip =
  !sandboxStatus().ok && process.env.RAKAZO_TEST_REQUIRE_SANDBOX !== "1" ? "bubblewrap sandbox unavailable" : false;

async function sh(root: string, command: string, extra: Record<string, unknown> = {}) {
  const res = await executeHostTool({ action: "run-command", args: { command }, hostRoot: root, ...extra });
  assert.equal(res.ok, true, res.ok ? "" : res.error);
  if (!res.ok) throw new Error(res.error);
  return { code: res.output.exitCode as number, out: String(res.output.stdout), err: String(res.output.stderr) };
}

describe("shell sandbox (bubblewrap)", () => {
  const dirs: string[] = [];
  const tmp = async (p: string) => {
    const d = await mkdtemp(join(tmpdir(), p));
    dirs.push(d);
    return d;
  };
  after(async () => {
    for (const d of dirs) await rm(d, { recursive: true, force: true });
  });

  it("CI requires a working sandbox", { skip: process.env.RAKAZO_TEST_REQUIRE_SANDBOX !== "1" }, () => {
    assert.deepEqual(sandboxStatus().ok, true, JSON.stringify(sandboxStatus()));
  });

  it("the root is writable and is $HOME", { skip }, async () => {
    const root = await tmp("rk-sb-");
    const r = await sh(root, 'echo inside > "$HOME/a.txt" && mkdir -p sub && echo ok > sub/b.txt && pwd && echo "$HOME"');
    assert.equal(r.code, 0, r.err);
    assert.equal(await readFile(join(root, "a.txt"), "utf8"), "inside\n");
    assert.equal(await readFile(join(root, "sub/b.txt"), "utf8"), "ok\n");
  });

  it("cannot read or write outside the root", { skip }, async () => {
    const root = await tmp("rk-sb-");
    const outside = await tmp("rk-sb-out-");
    await writeFile(join(outside, "secret.txt"), "TOPSECRET", "utf8");
    const r = await sh(
      root,
      [
        `cat ${outside}/secret.txt 2>/dev/null && echo READ_OUTSIDE`,
        `echo x > ${outside}/w.txt 2>/dev/null && echo WROTE_OUTSIDE`,
        `ls ${homedir()} 2>/dev/null && echo LISTED_HOME`,
        `cat ${homedir()}/.ssh/* ${homedir()}/.bashrc 2>/dev/null && echo READ_HOME`,
        `touch /etc/rk-x /usr/rk-x /rk-x 2>/dev/null && echo WROTE_SYSTEM`,
        `ls /run/user /media /mnt /srv /var/lib 2>/dev/null | head -1 | grep -q . && echo SAW_HOST_DIRS`,
        // /tmp inside is a private tmpfs; writing there must not reach the host's /tmp
        `touch ${join(tmpdir(), "rk-sb-escape-probe")} 2>/dev/null; true`,
        "echo done",
      ].join("; "),
    );
    assert.equal(r.out.trim(), "done", r.out);
    await assert.rejects(readFile(join(outside, "w.txt"), "utf8"));
    await assert.rejects(readFile(join(tmpdir(), "rk-sb-escape-probe"), "utf8"));
  });

  it("environment is cleared (runner tokens and display sockets don't leak)", { skip }, async () => {
    const root = await tmp("rk-sb-");
    process.env.RAKAZO_TEST_LEAK = "leaky-value";
    try {
      const r = await sh(root, "env");
      assert.doesNotMatch(r.out, /leaky-value|DISPLAY=|WAYLAND_DISPLAY=|DBUS_SESSION_BUS_ADDRESS=|XDG_RUNTIME_DIR=/);
      assert.match(r.out, /RAKAZO_SANDBOX=1/);
    } finally {
      delete process.env.RAKAZO_TEST_LEAK;
    }
  });

  it("no new privileges: setuid sudo/su can't escalate even when obfuscated", { skip }, async () => {
    const root = await tmp("rk-sb-");
    const r = await sh(
      root,
      [
        "grep '^NoNewPrivs' /proc/self/status",
        "grep '^CapEff' /proc/self/status",
        "id -u",
        "s=sud; ${s}o -n id -u >/dev/null 2>&1 && echo SUDO_WORKED",
        "p=pkex; ${p}ec id >/dev/null 2>&1 && echo PKEXEC_WORKED",
        "echo su | sh -c 'read t; $t -c id' </dev/null >/dev/null 2>&1 && echo SU_WORKED",
        "echo end",
      ].join("; "),
    );
    assert.match(r.out, /NoNewPrivs:\s*1/);
    assert.match(r.out, /CapEff:\s*0+\n/);
    assert.doesNotMatch(r.out, /^0$/m);
    assert.doesNotMatch(r.out, /WORKED/);
    assert.match(r.out, /end/);
  });

  it("the command check refuses sudo/su/doas/pkexec by name", async () => {
    const root = await tmp("rk-sb-");
    for (const c of ["sudo ls", "ls && su -", "doas id", "$(pkexec id)", "/usr/bin/sudo -n true", "env A=1 sudo id"]) {
      const res = await executeHostTool({ action: "run-command", args: { command: c }, hostRoot: root });
      assert.equal(res.ok, false, c);
      if (!res.ok) {
        assert.equal(res.denied, true);
        assert.match(res.error, /Privilege escalation/);
      }
    }
    for (const c of ["echo sudo", "grep su file", "git log --grep sg"]) assert.equal(escalationAttempt(c), null, c);
  });

  it("background shells are sandboxed too", { skip }, async () => {
    const root = await tmp("rk-sb-");
    const outside = await tmp("rk-sb-out-");
    const started = await executeHostTool({
      action: "run-command",
      args: { command: `echo bg > bg.txt; echo x > ${outside}/bg-out.txt`, background: true, shellId: "sb-bg-1" },
      hostRoot: root,
    });
    assert.equal(started.ok, true);
    for (let i = 0; i < 50; i++) {
      try {
        if ((await readFile(join(root, "bg.txt"), "utf8")) === "bg\n") break;
      } catch {
        /* wait */
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    assert.equal(await readFile(join(root, "bg.txt"), "utf8"), "bg\n");
    await assert.rejects(readFile(join(outside, "bg-out.txt"), "utf8"));
    await executeHostTool({ action: "kill-shell", args: { shellId: "sb-bg-1" }, hostRoot: root });
  });

  it("egress on keeps the host network namespace", { skip }, async () => {
    const root = await tmp("rk-sb-");
    const hostIfaces = (await readFile("/proc/net/dev", "utf8")).trim().split("\n").length;
    const r = await sh(root, "wc -l < /proc/net/dev", { egressAllowed: true });
    assert.equal(Number(r.out.trim()), hostIfaces);
  });

  it("refuses shell (no unsandboxed fallback) when bubblewrap is missing", async () => {
    const root = await tmp("rk-sb-");
    const prev = process.env.RAKAZO_BWRAP;
    process.env.RAKAZO_BWRAP = join(root, "no-such-bwrap");
    resetSandboxCache();
    try {
      for (const background of [false, true]) {
        const res = await executeHostTool({
          action: "run-command",
          args: { command: "echo should-not-run > ran.txt", background },
          hostRoot: root,
        });
        assert.equal(res.ok, false);
        if (!res.ok) {
          assert.equal(res.denied, true);
          assert.match(res.error, /Shell is refused/);
        }
      }
      await assert.rejects(readFile(join(root, "ran.txt"), "utf8"));
      // file tools don't need the sandbox and keep working inside the root
      await mkdir(join(root, "d"), { recursive: true });
      const w = await executeHostTool({ action: "write-file", args: { path: "d/f.txt", content: "y" }, hostRoot: root });
      assert.equal(w.ok, true);
    } finally {
      if (prev === undefined) delete process.env.RAKAZO_BWRAP;
      else process.env.RAKAZO_BWRAP = prev;
      resetSandboxCache();
    }
  });
});
