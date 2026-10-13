// End-to-end checks of the runner CLI on this machine: one runner per config dir, and
// `stop` also stops a runner started by the M1 scripts (pid file only, no service).
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const INDEX = join(dirname(fileURLToPath(import.meta.url)), "index.ts");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** Run the CLI without blocking this process (so it can reap the runners it spawned). */
function cli(args: string[], env: NodeJS.ProcessEnv): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const c = spawn(process.execPath, [INDEX, ...args], { env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    c.stdout.on("data", (d) => (stdout += d));
    c.stderr.on("data", (d) => (stderr += d));
    c.on("close", (status) => resolve({ status, stdout, stderr }));
  });
}
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

describe("runner CLI: one runner per config dir", { skip: process.platform === "win32" }, () => {
  let root = "";
  let env: NodeJS.ProcessEnv = {};
  const children: ChildProcess[] = [];
  before(() => {
    root = mkdtempSync(join(tmpdir(), "rk-runner-cli-"));
    const cfg = join(root, "cfg");
    mkdirSync(cfg, { mode: 0o700 });
    // M1-style credentials pointing at a closed local port: the runner just keeps retrying.
    writeFileSync(join(cfg, "credentials.json"), JSON.stringify({ deviceId: "d", token: "not-a-real-key", gatewayWsUrl: "ws://127.0.0.1:9/api/local-runners/ws" }), { mode: 0o600 });
    env = {
      ...process.env,
      HOME: root,
      RAKAZO_RUNNER_CONFIG_DIR: cfg,
      RAKAZO_RUNNER_MODEL_URL: "http://127.0.0.1:9/v1",
      RAKAZO_RUNNER_SERVICE: "rakijazios-runner-unit-test-none",
      XDG_CONFIG_HOME: join(root, "xdg"),
    };
  });
  after(() => {
    for (const c of children) if (c.pid && alive(c.pid)) c.kill("SIGKILL");
    rmSync(root, { recursive: true, force: true });
  });

  it("a second `run` on the same folder refuses to start", async () => {
    const first = spawn(process.execPath, [INDEX, "run"], { env, stdio: "ignore" });
    children.push(first);
    for (let i = 0; i < 30 && !existsSync(join(root, "cfg", "runner.pid")); i++) await sleep(100);
    await sleep(500);
    assert.equal(readFileSync(join(root, "cfg", "runner.pid"), "utf8").trim(), String(first.pid));
    const second = spawnSync(process.execPath, [INDEX, "run"], { env, encoding: "utf8", timeout: 15_000 });
    assert.equal(second.status, 1);
    assert.match(second.stderr, /Another runner \(pid \d+\) is already using/);
    assert.ok(alive(first.pid!));
    assert.equal(readFileSync(join(root, "cfg", "runner.pid"), "utf8").trim(), String(first.pid));

    const stop = await cli(["stop"], env);
    assert.equal(stop.status, 0, stop.stderr);
    await sleep(300);
    assert.equal(alive(first.pid!), false);
  });

  it("`stop` stops an M1 scripts/start.sh runner found through the pid file", async () => {
    // Stand-in for the M1 runner: a process whose command line is ".../runner/src/index.ts".
    const m1dir = join(root, "rakazo-online", "runner", "src");
    mkdirSync(m1dir, { recursive: true });
    writeFileSync(join(m1dir, "index.ts"), "setInterval(() => {}, 1000);\n");
    const m1 = spawn(process.execPath, [join(m1dir, "index.ts")], { env, stdio: "ignore", detached: true });
    children.push(m1);
    writeFileSync(join(root, "cfg", "runner.pid"), String(m1.pid)); // what scripts/start.sh writes
    await sleep(300);
    const status = spawnSync(process.execPath, [INDEX, "inspect"], { env, encoding: "utf8" });
    assert.match(status.stdout, new RegExp(`running: yes \\(pid ${m1.pid}\\)`));
    assert.equal(/not-a-real-key/.test(status.stdout + status.stderr), false);
    const stop = await cli(["stop"], env);
    assert.equal(stop.status, 0, stop.stderr);
    assert.match(stop.stdout, new RegExp(`Runner stopped \\(pid ${m1.pid}\\)`));
    await sleep(200);
    assert.equal(alive(m1.pid!), false);
  });

  it("a stale pid file (pid reused by something else) does not block a runner", async () => {
    const other = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
    children.push(other);
    writeFileSync(join(root, "cfg", "runner.pid"), String(other.pid));
    const run = spawn(process.execPath, [INDEX, "run"], { env, stdio: "ignore" });
    children.push(run);
    await sleep(1500);
    assert.ok(alive(run.pid!), "runner should start");
    assert.equal(readFileSync(join(root, "cfg", "runner.pid"), "utf8").trim(), String(run.pid));
    assert.ok(alive(other.pid!), "the unrelated process is left alone");
    await cli(["stop"], env);
    other.kill();
  });
});
