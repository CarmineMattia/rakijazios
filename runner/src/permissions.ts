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

/**
 * Effective local decision for one server tool.invoke. The local file can only tighten what the
 * server asks for: an action runs only when the local mirror explicitly allows it ("always" or an
 * "always" grant); the default "ask" refuses. Computer use and network egress need both the env
 * opt-in on the runner and the local file to enable them.
 */
export function effectiveLocalPolicy(
  file: LocalPermissionFile,
  env: { computerUseGate: boolean; egressAllowed: boolean },
  action: string,
  target?: string,
): { localDecision: "allow" | "deny"; computerUseGate: boolean; egressAllowed: boolean; reason?: string } {
  const d = localAllows(file, action, target);
  return {
    localDecision: d === "allow" ? "allow" : "deny",
    reason:
      d === "deny"
        ? "Denied by the local permissions.json on this computer."
        : d === "ask"
          ? "This computer's permissions.json doesn't allow host tools (permission is 'ask'). Set it to 'always' or add an 'always' grant locally to let approved actions run."
          : undefined,
    computerUseGate: env.computerUseGate && file.computerUseGate === true,
    egressAllowed: env.egressAllowed && file.egressAllowed === true,
  };
}
