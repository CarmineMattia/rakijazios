import { createHash } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  RUNNER_FILES,
  installCommands,
  loadRunnerBundle,
  NODE_SHA256,
  renderInstallPs1,
  renderInstallSh,
  renderWindowsCmd,
  safeOrigin,
  type RunnerBundle,
} from "./local-runner-install.js";

const BUNDLE_DIR = process.env.RAKAZO_RUNNER_BUNDLE_DIR ?? "/app/apps/api/local-runner-bundle";

const bundle: RunnerBundle = {
  version: "0.2.0-test",
  files: [
    { name: "index.ts", path: "src/index.ts", sha256: "a".repeat(64), body: Buffer.from("x") },
    { name: "package.json", path: "package.json", sha256: "b".repeat(64), body: Buffer.from("{}") },
  ],
};

describe("installers", () => {
  it("install.sh is valid POSIX sh and pins every checksum", () => {
    const sh = renderInstallSh("http://127.0.0.1:5173", bundle);
    const dir = mkdtempSync(join(tmpdir(), "rk-install-"));
    writeFileSync(join(dir, "install.sh"), sh);
    execFileSync("sh", ["-n", join(dir, "install.sh")]); // throws on syntax error
    expect(sh).toContain(`fetch_file 'index.ts' 'src/index.ts' '${"a".repeat(64)}'`);
    expect(sh).toContain(NODE_SHA256["linux-x64"]);
    expect(sh).toContain("SERVER='http://127.0.0.1:5173'");
    expect(sh).not.toMatch(/\$\{origin\}|undefined/);
  });

  it("install.ps1 pins checksums and uses CRLF", () => {
    const ps = renderInstallPs1("https://rk.example", bundle);
    expect(ps).toContain("'src\\index.ts'");
    expect(ps).toContain(NODE_SHA256["win-x64"]);
    expect(ps.includes("\r\n")).toBe(true);
    expect(ps.replace(/\r\n/g, "").includes("\n")).toBe(false);
  });

  it("the Windows .cmd bakes in only the one-time code", () => {
    const cmd = renderWindowsCmd("https://rk.example", "K7QF-3MZD", false);
    expect(cmd).toContain('set "RAKAZO_PAIR_CODE=K7QF-3MZD"');
    expect(cmd).toContain('set "RAKAZO_NO_AUTOSTART=1"');
    expect(cmd).toContain("https://rk.example/api/local-runners/install.ps1");
    expect(() => renderWindowsCmd("https://rk.example", 'K7QF"&calc', true)).toThrow();
  });

  it("commands keep the code out of URLs", () => {
    const c = installCommands("https://rk.example", "K7QF-3MZD");
    expect(c.unix).toBe("curl -fsSL 'https://rk.example/api/local-runners/install.sh' | sh -s -- --code K7QF-3MZD");
    expect(c.unixNoAutostart.endsWith("--no-autostart")).toBe(true);
    for (const v of Object.values(c)) expect(v).not.toMatch(/install\.(sh|ps1)\?/);
  });

  it("install.sh handles existing installs: --replace, inspect, stop before the files are swapped", () => {
    const sh = renderInstallSh("http://127.0.0.1:5173", bundle);
    expect(sh).toContain("--replace) REPLACE=1");
    expect(sh).toContain('"$NODE" "$STAGED" inspect');
    const pair = sh.indexOf('"$NODE" "$STAGED" "$@"');
    const stop = sh.indexOf('"$NODE" "$STAGED" stop');
    const swap = sh.indexOf('mv "$TMP/app" "$PREFIX/app"');
    expect(pair).toBeGreaterThan(0);
    expect(stop).toBeGreaterThan(pair);
    expect(swap).toBeGreaterThan(stop);
    const ps = renderInstallPs1("https://rk.example", bundle);
    expect(ps).toContain("$env:RAKAZO_REPLACE -eq '1'");
    expect(ps.indexOf("& $Node $Staged stop")).toBeGreaterThan(ps.indexOf("& $Node $Staged @pairArgs"));
    expect(ps.indexOf("Move-Item -LiteralPath $App")).toBeGreaterThan(ps.indexOf("& $Node $Staged stop"));
  });

  it.skipIf(!existsSync(BUNDLE_DIR))("the served bundle contains every file the runner imports", () => {
    const loaded = loadRunnerBundle(BUNDLE_DIR);
    expect(loaded).not.toBeNull();
    const served = new Set(RUNNER_FILES.map((f) => f.name));
    for (const f of loaded!.files) {
      if (!f.name.endsWith(".ts")) continue;
      for (const m of f.body.toString("utf8").matchAll(/from "\.\/([\w-]+\.ts)"/g)) {
        expect(served.has(m[1]!), `${f.name} imports ${m[1]} which is not served`).toBe(true);
      }
    }
    expect(loaded!.version).toMatch(/^\d+\.\d+\.\d+/);
  });

  it("rejects odd origins", () => {
    expect(safeOrigin("https://rk.example/some/path")).toBe("https://rk.example");
    expect(() => safeOrigin("javascript:alert(1)")).toThrow();
  });
});

// Runs the real install.sh against a local fake server with a stub runner that records
// which commands the installer calls (Linux/macOS only; no network, no systemd).
describe.skipIf(process.platform === "win32")("install.sh with an existing install", { timeout: 60_000 }, () => {
  const stub = `
const fs = require("node:fs");
const log = process.env.STUB_LOG;
const cmd = process.argv[2] || "run";
fs.appendFileSync(log, cmd + " " + process.argv.slice(3).filter((a) => a.startsWith("--") && a !== "--code" && a !== "--server").join(" ") + "\\n");
const mode = process.env.STUB_MODE || "ok";
if (cmd === "inspect") process.exit(process.env.STUB_EXISTING === "1" ? 0 : 1);
if (cmd === "pair") process.exit(mode === "refuse" ? 3 : mode === "fail" ? 1 : 0);
if (cmd === "stop") process.exit(mode === "stopfail" ? 1 : 0);
process.exit(0);
`;
  const files = [
    { name: "index.ts", path: "src/index.ts", body: Buffer.from(stub) },
    { name: "package.json", path: "package.json", body: Buffer.from('{"type":"commonjs"}') },
  ].map((f) => ({ ...f, sha256: createHash("sha256").update(f.body).digest("hex") }));
  const b: RunnerBundle = { version: "0.0.0-stub", files };

  async function runInstall(opts: { mode?: string; existing?: boolean; args?: string[]; foreignUnit?: boolean }) {
    const server = createServer((req, res) => {
      const f = files.find((x) => req.url === `/api/local-runners/runner/files/${x.name}`);
      if (!f) return void res.writeHead(404).end();
      res.writeHead(200).end(f.body);
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const root = mkdtempSync(join(tmpdir(), "rk-install-run-"));
    const home = join(root, "home");
    mkdirSync(home);
    const script = join(root, "install.sh");
    writeFileSync(script, renderInstallSh(origin, b));
    const unitDir = join(root, "xdg", "systemd", "user");
    const unit = join(unitDir, "rakijazios-runner.service");
    if (opts.foreignUnit) {
      mkdirSync(unitDir, { recursive: true });
      writeFileSync(unit, "[Service]\nExecStart=/somewhere/else/rakazo-runner run\n");
    }
    // An earlier install whose files must survive a refused/failed run.
    const prefix = join(home, ".local", "share", "rakijazios-runner");
    mkdirSync(join(prefix, "app", "src"), { recursive: true });
    writeFileSync(join(prefix, "app", "src", "index.ts"), "// previous version\n");
    const log = join(root, "calls.log");
    writeFileSync(log, "");
    const env = {
      PATH: `${dirname(process.execPath)}:/usr/bin:/bin`,
      HOME: home,
      XDG_CONFIG_HOME: join(root, "xdg"),
      STUB_LOG: log,
      STUB_MODE: opts.mode ?? "ok",
      STUB_EXISTING: opts.existing ? "1" : "0",
    };
    const result = await new Promise<{ code: number | null; out: string }>((resolve) => {
      const c = spawn("sh", [script, "--code", "K7QF-3MZD", "--no-autostart", ...(opts.args ?? [])], { env });
      let out = "";
      c.stdout.on("data", (d) => (out += d));
      c.stderr.on("data", (d) => (out += d));
      c.on("close", (code) => resolve({ code, out }));
    });
    server.close();
    return {
      ...result,
      calls: readFileSync(log, "utf8").trim().split("\n").filter(Boolean),
      appBody: readFileSync(join(prefix, "app", "src", "index.ts"), "utf8"),
      unitExists: existsSync(unit),
      unitBody: existsSync(unit) ? readFileSync(unit, "utf8") : "",
    };
  }

  it("normal run: inspect → pair → stop, then the new files, then start", async () => {
    const r = await runInstall({ existing: true });
    expect(r.code, r.out).toBe(0);
    expect(r.calls.map((c) => c.split(" ")[0])).toEqual(["inspect", "pair", "stop", "start", "status"]);
    expect(r.appBody).toBe(stub);
    expect(r.out).toContain("kept as is");
  });

  it("refused pairing (exit 3): nothing stopped, old files kept", async () => {
    const r = await runInstall({ existing: true, mode: "refuse" });
    expect(r.code).toBe(3);
    expect(r.calls.map((c) => c.split(" ")[0])).toEqual(["inspect", "pair"]);
    expect(r.appBody).toBe("// previous version\n");
  });

  it("failed pairing: nothing stopped, old files kept", async () => {
    const r = await runInstall({ mode: "fail" });
    expect(r.code).toBe(1);
    expect(r.calls.map((c) => c.split(" ")[0])).toEqual(["inspect", "pair"]);
    expect(r.appBody).toBe("// previous version\n");
  });

  it("old runner cannot be stopped: never starts a second one, old files kept", async () => {
    const r = await runInstall({ existing: true, mode: "stopfail" });
    expect(r.code).toBe(1);
    expect(r.calls.map((c) => c.split(" ")[0])).toEqual(["inspect", "pair", "stop"]);
    expect(r.appBody).toBe("// previous version\n");
    expect(r.out).toContain("could not stop the runner");
  });

  it("a login service from another install: refused before pairing; --replace takes it over", async () => {
    const r = await runInstall({ foreignUnit: true });
    expect(r.code).toBe(3);
    expect(r.calls.map((c) => c.split(" ")[0])).toEqual(["inspect"]);
    expect(r.unitBody).toContain("/somewhere/else");
    const r2 = await runInstall({ foreignUnit: true, args: ["--replace"] });
    expect(r2.code, r2.out).toBe(0);
    expect(r2.calls[1]).toBe("pair --replace");
    // --no-autostart: the taken-over service is removed, the runner is started directly.
    expect(r2.unitExists).toBe(false);
    expect(r2.calls.map((c) => c.split(" ")[0])).toEqual(["inspect", "pair", "stop", "start", "status"]);
  });
});
