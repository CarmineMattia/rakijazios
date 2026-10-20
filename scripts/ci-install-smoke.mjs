#!/usr/bin/env node
// Installs the runner from the bundle the api serves, with the real install.sh, into a throwaway
// HOME, then starts it and waits for it to connect. Fails on any missing module / file.
//   RK_BASE=http://127.0.0.1:PORT node scripts/ci-install-smoke.mjs
// Never prints the one-time pairing code or the device key. No autostart, unique service name,
// throwaway HOME/config dir; the runner is stopped and everything is removed at the end.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const BASE = (process.env.RK_BASE || "").replace(/\/+$/, "");
if (!BASE) { console.error("RK_BASE is required"); process.exit(2); }
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const T = mkdtempSync(join(tmpdir(), "rk-ci-install-"));
const HOME = join(T, "home");
const PREFIX = join(HOME, ".local/share/rakijazios-runner");
const LAUNCHER = join(PREFIX, "rakazo-runner");
const secrets = [];
const redact = (s) => secrets.reduce((acc, x) => (x ? acc.split(x).join("<redacted>") : acc), String(s ?? ""));
let failed = 0;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${!ok && detail ? `  ${redact(detail)}` : ""}`);
  if (!ok) failed++;
};
const runnerEnv = {
  PATH: process.env.PATH,
  HOME,
  LANG: "C.UTF-8",
  XDG_CONFIG_HOME: join(HOME, ".config"),
  RAKAZO_RUNNER_CONFIG_DIR: join(T, "cfg"),
  RAKAZO_RUNNER_SERVICE: `rk-ci-install-${process.pid}`,
  RAKAZO_RUNNER_MODEL_URL: "http://127.0.0.1:9/v1", // pinned to nothing: never probes local model servers
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function signUp(email) {
  const res = await fetch(`${BASE}/api/auth/sign-up/email`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: BASE },
    body: JSON.stringify({ email, password: `Ci-${Math.random().toString(36).slice(2)}-Pass1`, name: "ci-install" }),
  });
  const cookie = (res.headers.getSetCookie?.() ?? []).map((c) => c.split(";")[0]).join("; ");
  if (!res.ok || !cookie) throw new Error(`sign-up ${res.status}`);
  secrets.push(...cookie.split("; ").map((c) => c.split("=").slice(1).join("=")));
  return async (path, body) => {
    const r = await fetch(`${BASE}/api${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: { "content-type": "application/json", origin: BASE, cookie },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: r.status, body: await r.json().catch(() => ({})) };
  };
}

try {
  const owner = await signUp(`ci-install-${Date.now()}@example.invalid`);

  const manifest = await (await fetch(`${BASE}/api/local-runners/runner/manifest.json`)).json();
  check("manifest served", Array.isArray(manifest.files) && manifest.files.length > 0, JSON.stringify(manifest).slice(0, 200));
  const repoSrc = readdirSync(join(ROOT, "runner/src")).filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"));
  const servedPaths = new Set((manifest.files ?? []).map((f) => f.path));
  const notServed = repoSrc.filter((f) => !servedPaths.has(`src/${f}`));
  check("manifest serves every runner/src/*.ts", notServed.length === 0, `missing: ${notServed.join(", ")}`);

  const pairing = await owner("/local-runners/pairings", { os: "linux" });
  secrets.push(pairing.body?.code);
  const cmd = pairing.body?.commands?.unixNoAutostart;
  check("pairing created", pairing.status === 200 && typeof cmd === "string", `status ${pairing.status}`);

  const inst = spawnSync("sh", ["-c", cmd], { env: runnerEnv, encoding: "utf8", timeout: 240_000 });
  const out = `${inst.stdout ?? ""}${inst.stderr ?? ""}`;
  check("install.sh exits 0", inst.status === 0, `rc=${inst.status}\n${out.slice(-1500)}`);
  check("no missing module / file in install output", !/ERR_MODULE_NOT_FOUND|Cannot find module|checksum mismatch/.test(out), out.slice(-800));

  // Installed files == manifest, byte for byte.
  const bad = (manifest.files ?? []).filter((f) => {
    const p = join(PREFIX, "app", f.path);
    return !existsSync(p) || createHash("sha256").update(readFileSync(p)).digest("hex") !== f.sha256;
  });
  check("installed app matches the manifest", bad.length === 0, bad.map((f) => f.path).join(", "));

  // Every installed module loads (also ones only imported lazily).
  const mods = readdirSync(join(PREFIX, "app/src")).filter((f) => f.endsWith(".ts") && f !== "index.ts");
  const imp = spawnSync(process.execPath, ["--experimental-strip-types", "--no-warnings", "--input-type=module", "-e",
    `for (const f of ${JSON.stringify(mods.map((m) => pathToFileURL(join(PREFIX, "app/src", m)).href))}) await import(f); console.log("imported");`],
    { env: runnerEnv, encoding: "utf8", timeout: 60_000 });
  check(`all ${mods.length} installed modules import`, imp.status === 0 && /imported/.test(imp.stdout), `${imp.stderr}`.slice(-800));

  const ver = spawnSync(LAUNCHER, ["version"], { env: runnerEnv, encoding: "utf8", timeout: 30_000 });
  check("launcher version == served version", ver.status === 0 && ver.stdout.trim() === manifest.version, `${ver.stdout}${ver.stderr}`.slice(-300));

  // install.sh started it in the background (--no-autostart); it must connect.
  let dev = null;
  for (let i = 0; i < 30 && !dev?.online; i++) {
    const d = await owner("/local-runners/devices");
    dev = (d.body?.devices ?? [])[0] ?? null;
    if (!dev?.online) await sleep(1000);
  }
  check("installed runner connects (online)", dev?.online === true, JSON.stringify(dev ?? {}).slice(0, 300));
  check("connected runner reports the served version", dev?.runnerVersion === manifest.version, `${dev?.runnerVersion}`);
} catch (e) {
  check("smoke ran", false, e?.stack || String(e));
} finally {
  if (existsSync(LAUNCHER)) spawnSync(LAUNCHER, ["stop"], { env: runnerEnv, encoding: "utf8", timeout: 30_000 });
  const left = spawnSync("pgrep", ["-f", PREFIX], { encoding: "utf8" }).stdout.trim();
  check("runner stopped", !left, left);
  rmSync(T, { recursive: true, force: true });
}
console.log(failed ? `== INSTALL SMOKE FAILED (${failed})` : "== INSTALL SMOKE PASSED");
process.exit(failed ? 1 : 0);
