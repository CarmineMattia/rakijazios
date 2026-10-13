/**
 * Runner files (M2a). Everything lives in one private directory:
 *   credentials.json  { deviceId, token, gatewayWsUrl, server? }   (0600, never printed)
 *   config.json       { server?, modelBaseUrl?, name? }             (no secrets)
 *   status.json       { state, models, modelServer, … }             (no secrets)
 *   runner.pid / runner.log
 */
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type RunnerCredentials = {
  deviceId: string;
  token: string;
  /** ws:// or wss:// URL including path, e.g. wss://example.com/api/local-runners/ws */
  gatewayWsUrl: string;
  server?: string;
};

export type RunnerConfig = { server?: string; modelBaseUrl?: string; name?: string };

export type RunnerStatus = {
  state: "starting" | "connecting" | "connected" | "offline" | "revoked" | "unauthorized" | "stopped";
  detail?: string;
  server?: string;
  modelServer?: string;
  models?: string[];
  pid?: number;
  updatedAt: string;
};

export function configDir(): string {
  return process.env.RAKAZO_RUNNER_CONFIG_DIR?.trim() || join(homedir(), ".config", "rakazo-runner");
}

export function credentialsPath(): string {
  return process.env.RAKAZO_RUNNER_CREDENTIALS?.trim() || join(configDir(), "credentials.json");
}

export const pidPath = () => join(configDir(), "runner.pid");
export const logPath = () => join(configDir(), "runner.log");
const configPath = () => join(configDir(), "config.json");
const statusPath = () => join(configDir(), "status.json");

export function ensureConfigDir(): string {
  const dir = configDir();
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    chmodSync(dir, 0o700);
  } catch {
    /* not owner / Windows */
  }
  return dir;
}

/** Atomic, private write (0600). */
export function writePrivateJson(path: string, value: unknown): void {
  ensureConfigDir();
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  try {
    chmodSync(tmp, 0o600);
  } catch {
    /* Windows */
  }
  renameSync(tmp, path);
}

function readJson(path: string): Record<string, unknown> | null {
  if (!existsSync(path)) return null;
  try {
    const v = JSON.parse(readFileSync(path, "utf8")) as unknown;
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export function readCredentials(): RunnerCredentials | null {
  const raw = readJson(credentialsPath());
  if (!raw) return null;
  const deviceId = typeof raw.deviceId === "string" ? raw.deviceId : "";
  const token = typeof raw.token === "string" ? raw.token : "";
  const gatewayWsUrl =
    typeof raw.gatewayWsUrl === "string" && raw.gatewayWsUrl
      ? raw.gatewayWsUrl
      : "ws://127.0.0.1:3100/api/local-runners/ws"; // M1 default
  if (!deviceId || !token) return null;
  return {
    deviceId,
    token,
    gatewayWsUrl,
    ...(typeof raw.server === "string" ? { server: raw.server } : {}),
  };
}

export function writeCredentials(creds: RunnerCredentials): void {
  writePrivateJson(credentialsPath(), creds);
}

export function readConfig(): RunnerConfig {
  const raw = readJson(configPath()) ?? {};
  return {
    ...(typeof raw.server === "string" ? { server: raw.server } : {}),
    ...(typeof raw.modelBaseUrl === "string" ? { modelBaseUrl: raw.modelBaseUrl } : {}),
    ...(typeof raw.name === "string" ? { name: raw.name } : {}),
  };
}

export function writeConfig(cfg: RunnerConfig): void {
  writePrivateJson(configPath(), cfg);
}

export function readStatus(): RunnerStatus | null {
  return readJson(statusPath()) as RunnerStatus | null;
}

export function writeStatus(status: Omit<RunnerStatus, "updatedAt">): void {
  try {
    writePrivateJson(statusPath(), { ...status, updatedAt: new Date().toISOString() });
  } catch {
    /* status is best-effort */
  }
}

const LOOPBACK = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

export function isLoopbackHost(hostname: string): boolean {
  return LOOPBACK.has(hostname.toLowerCase());
}

/**
 * The device token travels over this connection, so plain ws:// / http:// is
 * only allowed to this same computer. RAKAZO_RUNNER_ALLOW_INSECURE=1 exists for
 * LAN tests and prints a warning.
 */
export function assertSecureTransport(raw: string, kind: "server" | "gateway"): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`Invalid ${kind} URL`);
  }
  const ok = kind === "server" ? ["http:", "https:"] : ["ws:", "wss:"];
  if (!ok.includes(url.protocol)) throw new Error(`The ${kind} URL must use ${ok.join(" or ")}`);
  if (url.username || url.password) throw new Error(`The ${kind} URL must not contain credentials`);
  const plain = url.protocol === "http:" || url.protocol === "ws:";
  if (plain && !isLoopbackHost(url.hostname)) {
    if (process.env.RAKAZO_RUNNER_ALLOW_INSECURE === "1") {
      console.error(`[runner] WARNING: unencrypted connection to ${url.host} (RAKAZO_RUNNER_ALLOW_INSECURE=1)`);
    } else {
      throw new Error(
        `Refusing an unencrypted ${kind} connection to ${url.host}: use https:// (wss://) for other computers`,
      );
    }
  }
  return url;
}
