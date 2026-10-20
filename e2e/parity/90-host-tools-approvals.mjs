// e2e (isolated stack only): per-action approvals + sandboxed shell with a throwaway runner.
//   ISO_BASE=http://127.0.0.1:PORT ISO_PG=rkiso-...-pg node e2e/parity/90-host-tools-approvals.mjs
// Start the stack with e2e/parity/isolated-stack.sh up. Refuses to run against the live stack.
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const BASE = process.env.ISO_BASE;
const PG = process.env.ISO_PG;
if (!BASE || !PG || !PG.startsWith("rkiso-") || /:(3100|5173)\b/.test(BASE)) {
  console.error("ISO_BASE / ISO_PG of an isolated rkiso-* stack required (never the live stack)");
  process.exit(2);
}
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const T = mkdtempSync(join(tmpdir(), "rk-e2e90-"));
const HOSTROOT = join(T, "home/Rakijazios");
const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok: !!ok });
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (fn, ms = 20000, step = 250) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await fn();
    if (v) return v;
    await sleep(step);
  }
  return null;
};
const sql = (q) =>
  spawnSync("docker", ["exec", PG, "psql", "-U", "rakazo", "-d", "rakazo", "-tAc", q], { encoding: "utf8" }).stdout.trim();

async function signUp(email) {
  const res = await fetch(`${BASE}/api/auth/sign-up/email`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: BASE },
    body: JSON.stringify({ email, password: `Iso-${Math.random().toString(36).slice(2)}-Pass1`, name: email.split("@")[0] }),
  });
  const cookie = (res.headers.getSetCookie?.() ?? []).map((c) => c.split(";")[0]).join("; ");
  if (!res.ok || !cookie) throw new Error(`sign-up ${res.status}`);
  return cookie;
}
function client(cookie) {
  return async (path, body, method) => {
    const res = await fetch(`${BASE}/api${path}`, {
      method: method ?? (body === undefined ? "GET" : "POST"),
      headers: { "content-type": "application/json", origin: BASE, cookie },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, body: await res.json().catch(() => ({})) };
  };
}

const runnerEnv = {
  PATH: process.env.PATH,
  HOME: join(T, "home"),
  RAKAZO_RUNNER_CONFIG_DIR: join(T, "cfg"),
  RAKAZO_RUNNER_SERVICE: "rk-e2e90-none",
  RAKAZO_RUNNER_MODEL_URL: "http://127.0.0.1:9/v1", // pinned to nothing: never probes local model servers
  LANG: "C.UTF-8",
};
const setLocal = (permission) =>
  writeFileSync(join(T, "cfg/permissions.json"), JSON.stringify({ version: 1, permission, grants: [], updatedAt: new Date().toISOString() }));
let runner;

try {
  mkdirSync(join(T, "home"), { recursive: true });
  const owner = client(await signUp(`iso-owner-${Date.now()}@example.invalid`));
  const peer = client(await signUp(`iso-peer-${Date.now()}@example.invalid`));

  const pairing = await owner("/local-runners/pairings", { os: "linux" });
  check("pairing created", pairing.status === 200 && pairing.body.code, `status ${pairing.status}`);
  const paired = spawnSync(process.execPath, ["--experimental-strip-types", "runner/src/index.ts", "pair", "--server", BASE, "--code", pairing.body.code, "--name", "iso-e2e"], { cwd: ROOT, env: runnerEnv, encoding: "utf8", timeout: 60000 });
  check("throwaway runner paired", paired.status === 0, (paired.stderr || "").trim().slice(0, 200));
  setLocal("always"); // the local mirror must explicitly allow (default 'ask' refuses)
  runner = spawn(process.execPath, ["--experimental-strip-types", "runner/src/index.ts", "run"], { cwd: ROOT, env: { ...runnerEnv, RAKAZO_HOST_TOOLS: "1" }, stdio: ["ignore", "pipe", "pipe"] });
  let runnerLog = "";
  runner.stdout.on("data", (b) => (runnerLog += b));
  runner.stderr.on("data", (b) => (runnerLog += b));
  const deviceId = await waitFor(() => sql(`select id from local_runner_devices where name='iso-e2e' and capabilities like '%host-tools%' and last_seen_at > now() - interval '30 seconds'`) || null, 30000);
  check("runner online with host-tools", deviceId, deviceId ? "" : runnerLog.slice(-400));

  const shells = async () => (await owner("/parity/background-shells")).body.shells ?? [];
  const shellStatus = async (id) => (await shells()).find((s) => s.id === id);
  const start = (command) => owner("/parity/background-shells", { command, deviceId });
  const decide = (who, id, decision) => who(`/host-tools/approvals/${id}/decision`, { decision });

  // H4 + M5
  check("H4: background shell without deviceId -> 400", (await owner("/parity/background-shells", { command: "true" })).status === 400);
  check("M5: /grants can't mint 'always'", (await owner("/host-tools/grants", { action: "run-command", grant: "always", deviceId, target: "true" })).status === 400);

  // A: ask -> pending -> allow once -> runs once, sandboxed
  const realHome = homedir();
  const A = await start(
    [
      "echo approved > approved.txt",
      "id -u > uid.txt",
      "grep NoNewPrivs /proc/self/status > nnp.txt",
      `cat ${realHome}/.bashrc > leak.txt 2>/dev/null`,
      `echo x > ${T}/outside.txt 2>/dev/null`,
      "s=sud; ${s}o -n true 2>/dev/null && echo ROOT > root.txt",
      "(exec 3<>/dev/tcp/1.1.1.1/80) 2>/dev/null && echo NET > net.txt",
      "env > env.txt",
    ].join("; "),
  );
  check("ask: shell paused with 202 pending_approval", A.status === 202 && A.body.status === "pending_approval", `status ${A.status}`);
  const listed = await owner("/host-tools/approvals");
  check("approval card data listed for the owner", listed.body.approvals?.some((a) => a.id === A.body.approval?.id && a.action === "run-command"));
  check("not run before the decision", !existsSync(join(HOSTROOT, "approved.txt")));
  check("foreign user sees no approvals", ((await peer("/host-tools/approvals")).body.approvals ?? []).length === 0);
  check("foreign user can't decide (404)", (await decide(peer, A.body.approval.id, "allow-once")).status === 404);
  const allowed = await decide(owner, A.body.approval.id, "allow-once");
  check("allow once -> resumed", allowed.status === 200 && allowed.body.resumed?.status === "running", JSON.stringify(allowed.body.resumed));
  const ran = await waitFor(() => existsSync(join(HOSTROOT, "env.txt")) && readFileSync(join(HOSTROOT, "env.txt"), "utf8").length > 0);
  check("approved action ran inside ~/Rakijazios", ran && readFileSync(join(HOSTROOT, "approved.txt"), "utf8") === "approved\n");
  check("replayed decision -> 409", (await decide(owner, A.body.approval.id, "allow-once")).status === 409);
  const uid = String(process.getuid());
  check("sandbox: not root, same uid", existsSync(join(HOSTROOT, "uid.txt")) && readFileSync(join(HOSTROOT, "uid.txt"), "utf8").trim() === uid);
  check("sandbox: no_new_privs", /NoNewPrivs:\s*1/.test(readFileSync(join(HOSTROOT, "nnp.txt"), "utf8")));
  check("sandbox: can't read the real home", !existsSync(join(HOSTROOT, "leak.txt")) || readFileSync(join(HOSTROOT, "leak.txt"), "utf8") === "");
  check("sandbox: can't write outside the root", !existsSync(join(T, "outside.txt")));
  check("sandbox: obfuscated sudo fails", !existsSync(join(HOSTROOT, "root.txt")));
  check("sandbox: network off", !existsSync(join(HOSTROOT, "net.txt")));
  const envTxt = readFileSync(join(HOSTROOT, "env.txt"), "utf8");
  check("sandbox: env scrubbed", !/RAKAZO_RUNNER_CONFIG_DIR|RAKAZO_HOST_TOOLS|DISPLAY=|DBUS_/.test(envTxt));

  // B: deny
  const B = await start("echo denied > denied.txt");
  await decide(owner, B.body.approval.id, "deny");
  check("deny -> shell denied, never ran", (await shellStatus(B.body.id))?.status === "denied" && !existsSync(join(HOSTROOT, "denied.txt")));

  // C: expiry
  const C = await start("echo expired > expired.txt");
  sql(`update host_tool_pending_approvals set expires_at = now() - interval '1 second' where id = '${C.body.approval.id}'`);
  const afterSweep = await owner("/host-tools/approvals");
  check("expired approval disappears from the card list", !(afterSweep.body.approvals ?? []).some((a) => a.id === C.body.approval.id));
  check("expired -> shell expired", (await shellStatus(C.body.id))?.status === "expired");
  check("late allow -> 410, never ran", (await decide(owner, C.body.approval.id, "allow-once")).status === 410 && !existsSync(join(HOSTROOT, "expired.txt")));

  // D: escalation refused on the computer even after approval
  const D = await start("sudo id > sudo.txt");
  await decide(owner, D.body.approval.id, "allow-once");
  const dRow = await waitFor(async () => {
    const s = await shellStatus(D.body.id);
    return s && s.status !== "running" ? s : null;
  }, 10000);
  check("sudo refused by the runner after approval", dRow?.status === "failed" && /Privilege escalation/.test(dRow.outputTail ?? "") && !existsSync(join(HOSTROOT, "sudo.txt")), dRow?.outputTail);

  // E: local 'ask' tightens even when the server approved
  setLocal("ask");
  const E = await start("echo local > local.txt");
  await decide(owner, E.body.approval.id, "allow-once");
  const eRow = await waitFor(async () => {
    const s = await shellStatus(E.body.id);
    return s && s.status === "failed" ? s : null;
  }, 10000);
  check("local permissions.json 'ask' refuses a server-approved action", eRow && /permissions\.json/.test(eRow.outputTail ?? "") && !existsSync(join(HOSTROOT, "local.txt")), eRow?.outputTail);
  setLocal("always");

  // F: always -> standing grant for this exact command on this computer
  const F = await start("echo always >> always.txt");
  await decide(owner, F.body.approval.id, "always");
  const F2 = await start("echo always >> always.txt");
  check("always: same command runs without asking again", F2.status === 200);
  check("always is scoped to the exact command", (await start("echo other > other.txt")).status === 202);
  await waitFor(() => existsSync(join(HOSTROOT, "always.txt")) && readFileSync(join(HOSTROOT, "always.txt"), "utf8") === "always\nalways\n", 10000);
  check("always: both runs happened", existsSync(join(HOSTROOT, "always.txt")) && readFileSync(join(HOSTROOT, "always.txt"), "utf8") === "always\nalways\n");

  // G: send-input also asks
  const G = await start("cat > typed.txt");
  await decide(owner, G.body.approval.id, "allow-once");
  await sleep(500);
  const input = await owner(`/parity/background-shells/${G.body.id}/send-input`, { text: "typed-line\n" });
  check("send-input paused with 202", input.status === 202);
  check("input not delivered before the decision", !existsSync(join(HOSTROOT, "typed.txt")) || readFileSync(join(HOSTROOT, "typed.txt"), "utf8") === "");
  const sent = await decide(owner, input.body.approval.id, "allow-once");
  check("send-input allowed -> delivered", sent.body.resumed?.sent === true && (await waitFor(() => existsSync(join(HOSTROOT, "typed.txt")) && readFileSync(join(HOSTROOT, "typed.txt"), "utf8") === "typed-line\n", 5000)));
  await owner(`/parity/background-shells/${G.body.id}/kill`, {});
} catch (error) {
  check("e2e crashed", false, String(error?.stack || error));
} finally {
  if (runner) runner.kill("SIGTERM");
  await sleep(500);
  rmSync(T, { recursive: true, force: true });
}
const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
