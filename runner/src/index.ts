#!/usr/bin/env node
/**
 * Rakijazios local runner (M2a).
 *
 *   rakazo-runner pair --server https://example.com --code K7QF-3MZD [--name "My PC"] [--replace]
 *   rakazo-runner start | stop | status
 *   rakazo-runner run          (foreground; also the default with no command, as in M1)
 *
 * Files: ~/.config/rakazo-runner/ (credentials.json 0600, config.json, status.json,
 * runner.pid, runner.log). The device token is never printed. Only one runner may use a
 * config dir at a time; an existing install is kept or refused, never silently overwritten
 * (see ./existing.ts).
 *
 * Env overrides:
 *   RAKAZO_RUNNER_MODEL_URL   pin the local model server (default: auto-detect on loopback)
 *   RAKAZO_RUNNER_MODELS      optional comma-separated allowlist of local model ids
 *   RAKAZO_RUNNER_CONFIG_DIR  config directory
 *   RAKAZO_RUNNER_CREDENTIALS credentials file path
 *   RAKAZO_RUNNER_SERVICE     systemd user unit / launchd label (default rakijazios-runner /
 *                             com.rakijazios.runner)
 */
import { spawn, spawnSync } from "node:child_process";
import {
  closeSync,
  existsSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { LocalRunnerClient } from "./client.ts";
import {
  assertSecureTransport,
  configDir,
  ensureConfigDir,
  logPath,
  pidPath,
  readConfig,
  readCredentials,
  readStatus,
  writeStatus,
} from "./config.ts";
import { discoverModelServer, filterModels } from "./discover.ts";
import { parseLoopbackBaseUrl } from "./loopback.ts";
import { EXIT_REFUSED, PID_HEARTBEAT_MS, fileAgeMs, looksLikeRunner, otherRunnerHolding } from "./existing.ts";
import { PairRefused, pairDevice, platformTag } from "./pair.ts";

export const VERSION = "0.2.1-m2a";
const SCRIPT = fileURLToPath(import.meta.url);

function arg(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(`--${name}`);
  if (i < 0) return undefined;
  const v = argv[i + 1];
  return v && !v.startsWith("--") ? v : undefined;
}

function readPid(): number | null {
  try {
    const n = Number(readFileSync(pidPath(), "utf8").trim());
    return Number.isSafeInteger(n) && n > 0 ? n : null;
  } catch {
    return null;
  }
}

function alive(pid: number | null): boolean {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  if (process.platform === "linux") {
    // An exited process its parent has not reaped yet ("zombie") is not a runner any more.
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      if (stat.slice(stat.lastIndexOf(")") + 2).startsWith("Z")) return false;
    } catch {
      /* gone */
    }
  }
  return true;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Another live runner using this config dir (M1 scripts/start.sh, `start`, a service or a foreground run). */
function holder(): number | null {
  return otherRunnerHolding({
    pid: readPid(),
    self: process.pid,
    alive: (p) => alive(p),
    looksLikeRunner: (p) => looksLikeRunner(p),
    pidFileAgeMs: fileAgeMs(pidPath()),
    platform: process.platform,
  });
}

function dropStalePidFile(): void {
  const pid = readPid();
  if (pid && pid !== process.pid && !holder()) {
    try {
      unlinkSync(pidPath());
    } catch {
      /* ignore */
    }
  }
}

const ONE_RUNNER =
  "Only one runner may use a config folder. Stop the other one first (rakazo-runner stop), or give this one its own RAKAZO_RUNNER_CONFIG_DIR.";

/** Autostart integration written by the installer (systemd --user / launchd). */
function service(): { kind: "systemd" | "launchd"; name: string } | null {
  if (process.platform === "linux") {
    const name = process.env.RAKAZO_RUNNER_SERVICE?.trim() || "rakijazios-runner";
    const base = process.env.XDG_CONFIG_HOME?.trim() || join(homedir(), ".config");
    return existsSync(join(base, "systemd", "user", `${name}.service`)) ? { kind: "systemd", name } : null;
  }
  if (process.platform === "darwin") {
    const name = process.env.RAKAZO_RUNNER_SERVICE?.trim() || "com.rakijazios.runner";
    return existsSync(join(homedir(), "Library", "LaunchAgents", `${name}.plist`))
      ? { kind: "launchd", name }
      : null;
  }
  return null;
}

function uid(): string {
  return typeof process.getuid === "function" ? String(process.getuid()) : "";
}

function modelBaseUrl(): string | undefined {
  const fixed = process.env.RAKAZO_RUNNER_MODEL_URL?.trim() || readConfig().modelBaseUrl;
  if (fixed) parseLoopbackBaseUrl(fixed);
  return fixed || undefined;
}

async function runForeground(): Promise<void> {
  const credentials = readCredentials();
  if (!credentials) {
    console.error(
      "This computer is not paired yet. In Rakijazios open Settings → My hardware → Add a computer.",
    );
    process.exit(1);
  }
  assertSecureTransport(credentials.gatewayWsUrl, "gateway");
  ensureConfigDir();
  const other = holder();
  if (other) {
    console.error(`[runner] Another runner (pid ${other}) is already using ${configDir()}. ${ONE_RUNNER}`);
    process.exit(1);
  }
  writeFileSync(pidPath(), String(process.pid), { mode: 0o600 });
  // Two runners starting at the same moment: the last writer keeps the folder.
  await sleep(300);
  if (readPid() !== process.pid) {
    const winner = holder();
    if (winner) {
      console.error(`[runner] Another runner (pid ${winner}) took ${configDir()} at the same time. ${ONE_RUNNER}`);
      process.exit(1);
    }
    writeFileSync(pidPath(), String(process.pid), { mode: 0o600 });
  }
  // Heartbeat: where the command line of a pid can't be checked (Windows), a pid file that
  // stopped being refreshed is treated as stale.
  const heartbeat = setInterval(() => {
    try {
      if (readPid() === process.pid) utimesSync(pidPath(), new Date(), new Date());
    } catch {
      /* ignore */
    }
  }, PID_HEARTBEAT_MS);
  heartbeat.unref();
  const cleanup = () => {
    try {
      if (readPid() === process.pid) unlinkSync(pidPath());
    } catch {
      /* ignore */
    }
  };
  const client = new LocalRunnerClient({
    credentials,
    modelBaseUrl: modelBaseUrl(),
    modelFilter: process.env.RAKAZO_RUNNER_MODELS,
    runnerVersion: VERSION,
    platform: platformTag(),
    onStatus: (s) => writeStatus(s),
    onFatal: (reason) => {
      console.error(
        reason === "unauthorized"
          ? "[runner] The server refused this computer's key. Pair it again from Settings → My hardware."
          : `[runner] This computer was ${reason === "rotated" ? "given a new key" : "removed"} in Rakijazios. Pair it again from Settings → My hardware.`,
      );
      cleanup();
      // Exit 0 so service managers (Restart=on-failure) do not loop.
      process.exit(0);
    },
  });
  const shutdown = () => {
    client.stop();
    cleanup();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  console.error(`[runner] start pid=${process.pid} version=${VERSION}`);
  await client.start();
}

function systemdMainPid(name: string): number | null {
  const r = spawnSync("systemctl", ["--user", "show", "-p", "MainPID", "--value", `${name}.service`], { encoding: "utf8" });
  const n = Number((r.stdout ?? "").trim());
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

async function startBackground(): Promise<number> {
  const svc = service();
  const other = holder();
  if (other && !(svc?.kind === "systemd" && systemdMainPid(svc.name) === other)) {
    if (!svc) {
      console.log(`Runner already running (pid ${other}).`);
      return 0;
    }
    console.error(`Another runner (pid ${other}) is using ${configDir()}, outside the ${svc.name} service. ${ONE_RUNNER}`);
    return 1;
  }
  if (svc?.kind === "systemd") {
    const r = spawnSync("systemctl", ["--user", "start", `${svc.name}.service`], { stdio: "inherit" });
    return r.status ?? 1;
  }
  if (svc?.kind === "launchd") {
    const r = spawnSync("launchctl", ["kickstart", `gui/${uid()}/${svc.name}`], { stdio: "inherit" });
    return r.status ?? 1;
  }
  const running = holder();
  if (running) {
    console.log(`Runner already running (pid ${running}).`);
    return 0;
  }
  dropStalePidFile();
  ensureConfigDir();
  try {
    if (statSync(logPath()).size > 5 * 1024 * 1024) renameSync(logPath(), `${logPath()}.1`);
  } catch {
    /* no log yet */
  }
  const fd = openSync(logPath(), "a", 0o600);
  const child = spawn(process.execPath, [...process.execArgv, SCRIPT, "run"], {
    detached: true,
    stdio: ["ignore", fd, fd],
    windowsHide: true,
    env: process.env,
  });
  child.unref();
  closeSync(fd);
  await sleep(1500);
  if (child.pid && alive(child.pid)) {
    console.log(`Runner started (pid ${child.pid}). Log: ${logPath()}`);
    return 0;
  }
  console.error(`Runner failed to start; see ${logPath()}`);
  return 1;
}

async function stopRunner(): Promise<number> {
  const svc = service();
  if (svc?.kind === "systemd") {
    spawnSync("systemctl", ["--user", "stop", `${svc.name}.service`], { stdio: "inherit" });
  } else if (svc?.kind === "launchd") {
    // KeepAlive only restarts after a failure; SIGTERM makes the runner exit cleanly.
    spawnSync("launchctl", ["kill", "SIGTERM", `gui/${uid()}/${svc.name}`], { stdio: "ignore" });
  }
  // Give a service-managed runner a moment to exit and remove its pid file.
  for (let i = 0; i < 15 && svc && holder(); i++) await sleep(200);
  // Any other runner on this folder: M1 scripts/start.sh, `start`, or a foreground run.
  const pid = holder();
  if (!pid) {
    dropStalePidFile();
    console.log(svc ? `Runner stopped (${svc.name}).` : "Runner is not running.");
    return 0;
  }
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    /* already gone */
  }
  for (let i = 0; i < 40 && alive(pid); i++) await sleep(200);
  if (alive(pid)) {
    console.error(`Runner (pid ${pid}) did not stop. Stop it by hand, then try again.`);
    return 1;
  }
  dropStalePidFile();
  console.log(`Runner stopped (pid ${pid}).`);
  return 0;
}

async function printStatus(): Promise<number> {
  const creds = readCredentials();
  if (!creds) {
    console.log("Not paired. In Rakijazios open Settings → My hardware → Add a computer.");
    return 1;
  }
  const pid = holder();
  const running = pid !== null;
  const st = readStatus();
  let server = "?";
  try {
    server = new URL(creds.gatewayWsUrl).host;
  } catch {
    /* ignore */
  }
  console.log(`Rakijazios runner ${VERSION}`);
  console.log(`Server:        ${server}`);
  console.log(`Runner:        ${running ? `running (pid ${pid})` : "not running"}${service() ? " · starts at login" : ""}`);
  console.log(`Connection:    ${running && st ? st.state : "offline"}${st?.detail && running ? ` (${st.detail})` : ""}`);
  if (running && st) {
    console.log(`Model server:  ${st.modelServer ?? "none"}`);
    console.log(`Models:        ${st.models?.length ? st.models.join(", ") : "none"}`);
  } else {
    const found = await discoverModelServer(modelBaseUrl());
    const models = filterModels(found?.models ?? [], process.env.RAKAZO_RUNNER_MODELS);
    console.log(`Model server:  ${found ? `${found.kind} (${models.length} model(s))` : "none found"}`);
  }
  return running ? 0 : 3;
}

/** Non-secret summary of an existing install in this config dir (used by the installers). Exit 1 = nothing found. */
function inspectExisting(): number {
  const creds = readCredentials();
  const pid = holder();
  const svc = service();
  const credsFile = existsSync(join(configDir(), "credentials.json"));
  if (!creds && !credsFile && !pid && !svc) return 1;
  let host = "?";
  try {
    host = creds ? new URL(creds.server || creds.gatewayWsUrl).host : "?";
  } catch {
    /* ignore */
  }
  console.log(`Existing runner in ${configDir()}:`);
  console.log(`  key:     ${creds ? `present (server ${host})` : credsFile ? "unreadable file" : "none"}`);
  console.log(`  running: ${pid ? `yes (pid ${pid})` : "no"}`);
  console.log(`  service: ${svc ? `${svc.kind} ${svc.name}` : "none"}`);
  return 0;
}

async function pairCommand(argv: string[]): Promise<number> {
  const server = arg(argv, "server") ?? readConfig().server;
  const code = arg(argv, "code");
  if (!server || !code) {
    console.error("usage: rakazo-runner pair --server <url> --code <XXXX-XXXX> [--name <name>] [--replace]");
    return 2;
  }
  let paired;
  try {
    paired = await pairDevice({
      server,
      code,
      name: arg(argv, "name"),
      runnerVersion: VERSION,
      replace: argv.includes("--replace"),
    });
  } catch (err) {
    if (err instanceof PairRefused) {
      console.error(err.message);
      return EXIT_REFUSED;
    }
    throw err;
  }
  switch (paired.outcome) {
    case "adopted":
      console.log(`This computer is already connected as "${paired.name}". Kept its key and settings (no new pairing).`);
      break;
    case "reconnected":
      console.log(`Reconnected as "${paired.name}" with a new key.`);
      break;
    case "replaced":
      console.log(`Paired as a new computer, "${paired.name}". The previous key was saved to ${paired.backup ?? "(none)"};`);
      console.log("its entry was not removed anywhere. Remove it in My hardware if you no longer need it.");
      break;
    case "repaired":
      console.log(`The previous key no longer worked (computer removed or given a new key). Paired again as "${paired.name}".`);
      if (paired.backup) console.log(`Old credentials saved to ${paired.backup}.`);
      break;
    default:
      console.log(`Paired as "${paired.name}".`);
      if (paired.backup) console.log(`An unreadable credentials file was saved to ${paired.backup}.`);
  }
  const found = await discoverModelServer(modelBaseUrl());
  const models = filterModels(found?.models ?? [], process.env.RAKAZO_RUNNER_MODELS);
  if (found) {
    console.log(`Local model server: ${found.kind} with ${models.length} model(s)${models.length ? `: ${models.map((m) => m.id).join(", ")}` : ""}.`);
  } else {
    console.log(
      "No local model server found yet (Ollama, LM Studio, llama.cpp…). Start one; the runner checks every minute.",
    );
  }
  return 0;
}

async function main(argv: string[]): Promise<void> {
  const cmd = argv[0] && !argv[0].startsWith("--") ? argv[0] : "run";
  try {
    switch (cmd) {
      case "run":
        await runForeground();
        return;
      case "pair":
        process.exit(await pairCommand(argv.slice(1)));
        break;
      case "start":
        process.exit(await startBackground());
        break;
      case "stop":
        process.exit(await stopRunner());
        break;
      case "status":
        process.exit(await printStatus());
        break;
      case "inspect":
        process.exit(inspectExisting());
        break;
      case "version":
      case "--version":
        console.log(VERSION);
        process.exit(0);
        break;
      default:
        console.error("usage: rakazo-runner [run|pair|start|stop|status|inspect|version]");
        process.exit(2);
    }
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}

void main(process.argv.slice(2));
