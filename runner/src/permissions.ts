/**
 * Local mirror of host-tool grants (P0/P1).
 * File: ~/.config/rakazo-runner/permissions.json (0600)
 */
import { mkdir, readFile, writeFile, rename } from "node:fs/promises";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

export type LocalPermissionFile = {
  version: 1;
  permission: "always" | "ask" | "never";
  ceiling?: "always" | "ask" | "never" | null;
  computerUseGate?: boolean;
  egressAllowed?: boolean;
  grants: Array<{ action: string; grant: "always" | "never"; target?: string }>;
  updatedAt: string;
};

const DEFAULTS: LocalPermissionFile = {
  version: 1,
  permission: "ask",
  ceiling: null,
  computerUseGate: false,
  egressAllowed: false,
  grants: [],
  updatedAt: new Date(0).toISOString(),
};

export function permissionsPath(configDir?: string): string {
  const dir =
    configDir ||
    process.env.RAKAZO_RUNNER_CONFIG_DIR?.trim() ||
    join(homedir(), ".config", "rakazo-runner");
  return join(dir, "permissions.json");
}

export async function loadPermissions(configDir?: string): Promise<LocalPermissionFile> {
  const path = permissionsPath(configDir);
  try {
    const raw = await readFile(path, "utf8");
    const parsed = JSON.parse(raw) as Partial<LocalPermissionFile>;
    return {
      ...DEFAULTS,
      ...parsed,
      version: 1,
      grants: Array.isArray(parsed.grants) ? parsed.grants : [],
    };
  } catch {
    return { ...DEFAULTS };
  }
}

export async function savePermissions(
  next: LocalPermissionFile,
  configDir?: string,
): Promise<void> {
  const path = permissionsPath(configDir);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const body = JSON.stringify({ ...next, version: 1, updatedAt: new Date().toISOString() }, null, 2);
  const tmp = `${path}.${process.pid}.tmp`;
  await writeFile(tmp, body, { encoding: "utf8", mode: 0o600 });
  await rename(tmp, path);
}

export function localAllows(
  file: LocalPermissionFile,
  action: string,
  target?: string,
): "allow" | "deny" | "ask" {
  if (file.ceiling === "never" || file.permission === "never") return "deny";
  for (const g of file.grants) {
    if (g.action !== action) continue;
    if (g.target && target && g.target !== target) continue;
    if (g.grant === "never") return "deny";
    if (g.grant === "always") return "allow";
  }
  if (file.permission === "always" && file.ceiling !== "ask") return "allow";
  if (file.permission === "always" && !file.ceiling) return "allow";
  return "ask";
}
