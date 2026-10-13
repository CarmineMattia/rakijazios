/**
 * Existing installs (M2a): what to do when this config dir already holds a runner.
 *
 * Rules (also in runner/README.md):
 * - Credentials present and valid for the same server and account → **keep them** ("adopt"):
 *   no new key, the runner files are upgraded and the runner restarted.
 * - Credentials for another server / account, or a "New key" code for another computer →
 *   **refuse** (exit 3), change nothing, leave the code unused. `--replace` pairs this
 *   computer as a new one and keeps a backup of the old credentials; nothing is revoked.
 * - Credentials whose key no longer works (computer removed or re-keyed) → pair normally,
 *   keeping a backup of the old file.
 * - Only one runner may use a config dir at a time (pid file, also written by the M1
 *   `scripts/start.sh`).
 */
import { readFileSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";

export const EXIT_REFUSED = 3;

export type StoredCredentials = { deviceId: string; token: string; gatewayWsUrl: string; server?: string };

/** Host to show for stored credentials (never the token). */
export function credentialsHost(creds: { server?: string; gatewayWsUrl: string }): string {
  try {
    return new URL(creds.server || creds.gatewayWsUrl).host;
  } catch {
    return "an unknown server";
  }
}

/**
 * Only hand an existing token back to the server that issued it. Credentials written by
 * M2a carry `server` (exact origin match). M1 credentials only have the gateway URL, which
 * pointed straight at the api port of the same host, so the hostname has to match.
 */
export function sameServer(creds: { server?: string; gatewayWsUrl: string }, server: string): boolean {
  if (creds.server) return creds.server === server;
  try {
    return hostKey(new URL(creds.gatewayWsUrl).hostname) === hostKey(new URL(server).hostname);
  } catch {
    return false;
  }
}

/** localhost, 127.0.0.1 and ::1 are all this computer, so they count as one host. */
function hostKey(hostname: string): string {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  return h === "localhost" || h === "::1" || /^127\./.test(h) ? "loopback" : h;
}

export type ExistingPlan =
  | { action: "fresh" }
  | { action: "replace" }
  | { action: "adopt"; deviceId: string; token: string }
  | { action: "refuse"; reason: "other_server"; host: string };

export function planForExisting(creds: StoredCredentials | null, server: string, replace: boolean): ExistingPlan {
  if (!creds) return { action: "fresh" };
  if (replace) return { action: "replace" };
  if (!sameServer(creds, server)) return { action: "refuse", reason: "other_server", host: credentialsHost(creds) };
  return { action: "adopt", deviceId: creds.deviceId, token: creds.token };
}

export type AdoptAnswer =
  | { kind: "adopted"; deviceId: string; name: string }
  | { kind: "rekeyed"; deviceId: string; token: string; gatewayWsUrl: string; name: string }
  | { kind: "inactive" }
  | { kind: "refuse"; reason: "other_account" | "other_device" | "unknown" }
  | { kind: "error"; message: string };

/** Interpret the server's answer to a pair request that carried `adopt`. */
export function interpretAdoptAnswer(status: number, body: Record<string, unknown> | null): AdoptAnswer {
  const str = (v: unknown) => (typeof v === "string" ? v : "");
  if (status >= 200 && status < 300 && body) {
    if (body.adopted === true && str(body.deviceId)) {
      return { kind: "adopted", deviceId: str(body.deviceId), name: str(body.name) };
    }
    if (str(body.deviceId) && str(body.token) && str(body.gatewayWsUrl)) {
      return {
        kind: "rekeyed",
        deviceId: str(body.deviceId),
        token: str(body.token),
        gatewayWsUrl: str(body.gatewayWsUrl),
        name: str(body.name),
      };
    }
    return { kind: "error", message: "incomplete answer" };
  }
  if (status === 409 && body) {
    const reason = str(body.reason);
    if (reason === "inactive") return { kind: "inactive" };
    if (reason === "other_account" || reason === "other_device" || reason === "unknown") return { kind: "refuse", reason };
  }
  return { kind: "error", message: str(body?.error) || `HTTP ${status}` };
}

export function refusalMessage(
  reason: "other_server" | "other_account" | "other_device" | "unknown",
  ctx: { host: string; server: string; configDir: string },
): string {
  const head = {
    other_server: `This computer already runs a Rakijazios runner connected to ${ctx.host}.`,
    other_account: "This computer is already connected to a different Rakijazios account.",
    other_device: 'This "New key" code is for a different computer than the one this runner is connected as.',
    unknown: `The runner on this computer holds a key that ${new URL(ctx.server).host} does not know.`,
  }[reason];
  return [
    head,
    `Nothing was changed (config: ${ctx.configDir}) and the one-time code was not used.`,
    `- To connect this computer to ${ctx.server} as a new computer instead, run the installer again with --replace`,
    "  (Windows: set RAKAZO_REPLACE=1). The old key is kept in a backup file; nothing is removed on any server.",
    "- To run a second, separate runner, set RAKAZO_RUNNER_CONFIG_DIR and RAKAZO_RUNNER_SERVICE to other values.",
  ].join("\n");
}

/** Does this pid look like a Rakijazios runner (M1 or M2)? Best effort per OS. */
export function looksLikeRunner(pid: number, platform: NodeJS.Platform = process.platform): boolean {
  let cmd = "";
  try {
    if (platform === "linux") cmd = readFileSync(`/proc/${pid}/cmdline`, "utf8").replace(/\0/g, " ");
    else if (platform === "darwin") cmd = spawnSync("ps", ["-p", String(pid), "-o", "command="], { encoding: "utf8" }).stdout ?? "";
    else return true; // Windows: rely on the pid file heartbeat instead
  } catch {
    return false;
  }
  return isRunnerCommandLine(cmd);
}

export function isRunnerCommandLine(cmd: string): boolean {
  return /index\.ts\b/.test(cmd) && /(rakazo|rakijazios|runner)/i.test(cmd);
}

/** How old a pid file may get on Windows before it is treated as stale (it is rewritten every 30 s). */
export const PID_HEARTBEAT_MS = 30_000;
export const PID_STALE_MS = 120_000;

/**
 * The pid of another live runner holding this config dir, or null.
 * `pidFileAgeMs` is only used where the command line can't be checked (Windows).
 */
export function otherRunnerHolding(opts: {
  pid: number | null;
  self: number;
  alive: (pid: number) => boolean;
  looksLikeRunner: (pid: number) => boolean;
  pidFileAgeMs: number | null;
  platform: NodeJS.Platform;
}): number | null {
  const { pid } = opts;
  if (!pid || pid === opts.self || !opts.alive(pid)) return null;
  if (opts.platform === "win32") return opts.pidFileAgeMs !== null && opts.pidFileAgeMs < PID_STALE_MS ? pid : null;
  return opts.looksLikeRunner(pid) ? pid : null;
}

export function fileAgeMs(path: string): number | null {
  try {
    return Date.now() - statSync(path).mtimeMs;
  } catch {
    return null;
  }
}
