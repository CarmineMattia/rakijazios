/**
 * Host-tool permission model for Rakijazios parity (P0).
 * always | ask | never + standing grants per action + optional ceiling per machine.
 */
import type { PrismaClient } from "@rakazo/db";

export const HOST_TOOL_ACTIONS = [
  "run-command",
  "send-input",
  "kill-shell",
  "read-file",
  "write-file",
  "list-directory",
  "computer-screenshot",
  "computer-click",
  "computer-type",
  "computer-key",
  "computer-scroll",
  "computer-wait",
  "computer-apps",
] as const;

export type HostToolAction = (typeof HOST_TOOL_ACTIONS)[number];
export type HostToolPermission = "always" | "ask" | "never";
export type StandingGrant = "allow-once" | "always" | "never";

const ACTION_SET = new Set<string>(HOST_TOOL_ACTIONS);

export function isHostToolAction(value: string): value is HostToolAction {
  return ACTION_SET.has(value);
}

export function normalizePermission(value: unknown): HostToolPermission {
  if (value === "always" || value === "never" || value === "ask") return value;
  return "ask";
}

/** Lower privilege wins when combining permission with a ceiling. */
export function resolveWithCeiling(
  permission: HostToolPermission,
  ceiling: HostToolPermission | null | undefined,
): HostToolPermission {
  if (!ceiling || ceiling === "always") return permission;
  if (ceiling === "never") return "never";
  // ceiling ask: never stays never, always downgrades to ask
  if (permission === "never") return "never";
  return "ask";
}

export type PermissionDecision =
  | { kind: "allow"; source: "policy" | "standing" | "once" }
  | { kind: "deny"; source: "policy" | "standing" | "ceiling" }
  | { kind: "ask" };

export type HostToolPermissionRow = {
  user_id: string;
  device_id: string | null;
  permission: string;
  ceiling: string | null;
  auto_review_allow: string | null;
  auto_review_block: string | null;
  auto_review_enabled: boolean;
};

export type StandingGrantRow = {
  action: string;
  grant: string;
  target: string | null;
};

let tablesReady: WeakMap<PrismaClient, Promise<void>> | undefined;

export function ensureHostToolPermissionTables(prisma: PrismaClient): Promise<void> {
  tablesReady ??= new WeakMap();
  let pending = tablesReady.get(prisma);
  if (!pending) {
    pending = (async () => {
      await prisma.$executeRawUnsafe(`CREATE TABLE IF NOT EXISTS host_tool_permissions (
        user_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
        device_id TEXT NOT NULL REFERENCES local_runner_devices(id) ON DELETE CASCADE,
        permission TEXT NOT NULL DEFAULT 'ask',
        ceiling TEXT,
        auto_review_allow TEXT,
        auto_review_block TEXT,
        auto_review_enabled BOOLEAN NOT NULL DEFAULT false,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (user_id, device_id)
      )`);
      await prisma.$executeRawUnsafe(`CREATE TABLE IF NOT EXISTS host_tool_permission_defaults (
        user_id TEXT PRIMARY KEY REFERENCES "user"(id) ON DELETE CASCADE,
        permission TEXT NOT NULL DEFAULT 'ask',
        ceiling TEXT,
        auto_review_allow TEXT,
        auto_review_block TEXT,
        auto_review_enabled BOOLEAN NOT NULL DEFAULT false,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`);
      await prisma.$executeRawUnsafe(`CREATE TABLE IF NOT EXISTS host_tool_standing_grants (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
        device_key TEXT NOT NULL DEFAULT '',
        action TEXT NOT NULL,
        "grant" TEXT NOT NULL,
        target TEXT NOT NULL DEFAULT '',
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE (user_id, device_key, action, target)
      )`);
      await prisma.$executeRawUnsafe(
        `CREATE INDEX IF NOT EXISTS host_tool_standing_grants_user_idx
         ON host_tool_standing_grants (user_id, device_key)`,
      );
    })().catch((error) => {
      tablesReady?.delete(prisma);
      throw error;
    });
    tablesReady.set(prisma, pending);
  }
  return pending;
}

function parseAutoReviewList(raw: string | null | undefined): string[] {
  if (!raw?.trim()) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (Array.isArray(parsed)) {
      return parsed.filter((x): x is string => typeof x === "string" && x.trim().length > 0);
    }
  } catch {
    /* plain newline / comma list */
  }
  return raw
    .split(/[\n,]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Shell metacharacters that can chain or substitute another command. */
const SHELL_META = /[;&|`$()<>\n\r\\]/;

/**
 * Auto-review. Block rules match anywhere (case-insensitive substring: more blocking is safe).
 * Allow rules are anchored: the target must equal the rule or start with "rule " (argument
 * boundary), and must not contain shell metacharacters, so "ls" doesn't allow
 * "curl https://evil/ls" or "ls; curl evil". A rule may include the action ("run-command ls").
 */
export function matchAutoReview(
  commandOrTarget: string,
  allow: string[],
  block: string[],
  enabled: boolean,
): "allow" | "block" | null {
  if (!enabled) return null;
  const hay = commandOrTarget.toLowerCase().trim();
  for (const rule of block) {
    if (hay.includes(rule.toLowerCase())) return "block";
  }
  const space = hay.indexOf(" ");
  const target = space >= 0 ? hay.slice(space + 1).trim() : "";
  if (SHELL_META.test(target)) return null;
  const anchored = (text: string, rule: string) => text === rule || text.startsWith(`${rule} `);
  for (const raw of allow) {
    const rule = raw.toLowerCase().trim();
    if (!rule) continue;
    if (anchored(target, rule) || anchored(hay, rule)) return "allow";
  }
  return null;
}

export async function loadPermissionPolicy(
  prisma: PrismaClient,
  userId: string,
  deviceId: string | null,
): Promise<{
  permission: HostToolPermission;
  ceiling: HostToolPermission | null;
  autoReviewAllow: string[];
  autoReviewBlock: string[];
  autoReviewEnabled: boolean;
}> {
  await ensureHostToolPermissionTables(prisma);
  if (deviceId) {
    const rows = await prisma.$queryRawUnsafe<
      Array<{
        permission: string;
        ceiling: string | null;
        auto_review_allow: string | null;
        auto_review_block: string | null;
        auto_review_enabled: boolean;
      }>
    >(
      `SELECT permission, ceiling, auto_review_allow, auto_review_block, auto_review_enabled
       FROM host_tool_permissions WHERE user_id = $1 AND device_id = $2`,
      userId,
      deviceId,
    );
    if (rows[0]) {
      return {
        permission: normalizePermission(rows[0].permission),
        ceiling: rows[0].ceiling ? normalizePermission(rows[0].ceiling) : null,
        autoReviewAllow: parseAutoReviewList(rows[0].auto_review_allow),
        autoReviewBlock: parseAutoReviewList(rows[0].auto_review_block),
        autoReviewEnabled: rows[0].auto_review_enabled === true,
      };
    }
  }
  const defaults = await prisma.$queryRawUnsafe<
    Array<{
      permission: string;
      ceiling: string | null;
      auto_review_allow: string | null;
      auto_review_block: string | null;
      auto_review_enabled: boolean;
    }>
  >(
    `SELECT permission, ceiling, auto_review_allow, auto_review_block, auto_review_enabled
     FROM host_tool_permission_defaults WHERE user_id = $1`,
    userId,
  );
  if (defaults[0]) {
    return {
      permission: normalizePermission(defaults[0].permission),
      ceiling: defaults[0].ceiling ? normalizePermission(defaults[0].ceiling) : null,
      autoReviewAllow: parseAutoReviewList(defaults[0].auto_review_allow),
      autoReviewBlock: parseAutoReviewList(defaults[0].auto_review_block),
      autoReviewEnabled: defaults[0].auto_review_enabled === true,
    };
  }
  return {
    permission: "ask",
    ceiling: null,
    autoReviewAllow: [],
    autoReviewBlock: [],
    autoReviewEnabled: false,
  };
}

export async function decideHostToolPermission(
  prisma: PrismaClient,
  input: {
    userId: string;
    deviceId: string | null;
    action: HostToolAction;
    target?: string;
  },
): Promise<PermissionDecision> {
  const policy = await loadPermissionPolicy(prisma, input.userId, input.deviceId);
  const effective = resolveWithCeiling(policy.permission, policy.ceiling);
  if (effective === "never") return { kind: "deny", source: "ceiling" };

  const auto = matchAutoReview(
    `${input.action} ${input.target ?? ""}`,
    policy.autoReviewAllow,
    policy.autoReviewBlock,
    policy.autoReviewEnabled,
  );
  if (auto === "block") return { kind: "deny", source: "policy" };
  if (auto === "allow") return { kind: "allow", source: "policy" };

  const deviceKey = input.deviceId ?? "";
  const grants = await prisma.$queryRawUnsafe<StandingGrantRow[]>(
    `SELECT action, "grant", NULLIF(target, '') AS target FROM host_tool_standing_grants
     WHERE user_id = $1 AND device_key IN ($2, '') AND action = $3
     ORDER BY CASE WHEN device_key = $2 THEN 0 ELSE 1 END,
              CASE WHEN target = $4 THEN 0 WHEN target = '' THEN 1 ELSE 2 END`,
    input.userId,
    deviceKey,
    input.action,
    input.target ?? "",
  );
  for (const g of grants) {
    if (g.target && input.target && g.target !== input.target) continue;
    if (!g.target || g.target === input.target || g.target === "") {
      if (g.grant === "never") return { kind: "deny", source: "standing" };
      if (g.grant === "always") return { kind: "allow", source: "standing" };
    }
  }

  if (effective === "always") return { kind: "allow", source: "policy" };
  return { kind: "ask" };
}

export async function upsertPermissionDefaults(
  prisma: PrismaClient,
  userId: string,
  patch: {
    permission?: HostToolPermission;
    ceiling?: HostToolPermission | null;
    autoReviewAllow?: string[];
    autoReviewBlock?: string[];
    autoReviewEnabled?: boolean;
    deviceId?: string | null;
  },
): Promise<void> {
  await ensureHostToolPermissionTables(prisma);
  const permission = patch.permission ?? "ask";
  const ceiling = patch.ceiling ?? null;
  const allow = JSON.stringify(patch.autoReviewAllow ?? []);
  const block = JSON.stringify(patch.autoReviewBlock ?? []);
  const enabled = patch.autoReviewEnabled ?? false;
  if (patch.deviceId) {
    await prisma.$executeRawUnsafe(
      `INSERT INTO host_tool_permissions
         (user_id, device_id, permission, ceiling, auto_review_allow, auto_review_block, auto_review_enabled, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
       ON CONFLICT (user_id, device_id) DO UPDATE SET
         permission = EXCLUDED.permission,
         ceiling = EXCLUDED.ceiling,
         auto_review_allow = EXCLUDED.auto_review_allow,
         auto_review_block = EXCLUDED.auto_review_block,
         auto_review_enabled = EXCLUDED.auto_review_enabled,
         updated_at = NOW()`,
      userId,
      patch.deviceId,
      permission,
      ceiling,
      allow,
      block,
      enabled,
    );
    return;
  }
  await prisma.$executeRawUnsafe(
    `INSERT INTO host_tool_permission_defaults
       (user_id, permission, ceiling, auto_review_allow, auto_review_block, auto_review_enabled, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, NOW())
     ON CONFLICT (user_id) DO UPDATE SET
       permission = EXCLUDED.permission,
       ceiling = EXCLUDED.ceiling,
       auto_review_allow = EXCLUDED.auto_review_allow,
       auto_review_block = EXCLUDED.auto_review_block,
       auto_review_enabled = EXCLUDED.auto_review_enabled,
       updated_at = NOW()`,
    userId,
    permission,
    ceiling,
    allow,
    block,
    enabled,
  );
}

export async function recordStandingGrant(
  prisma: PrismaClient,
  input: {
    id: string;
    userId: string;
    deviceId: string | null;
    action: HostToolAction;
    grant: StandingGrant;
    target?: string;
  },
): Promise<void> {
  await ensureHostToolPermissionTables(prisma);
  if (input.grant === "allow-once") return; // one-shot is not persisted
  await prisma.$executeRawUnsafe(
    `INSERT INTO host_tool_standing_grants (id, user_id, device_key, action, "grant", target, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, NOW())
     ON CONFLICT (user_id, device_key, action, target) DO UPDATE SET "grant" = EXCLUDED."grant"`,
    input.id,
    input.userId,
    input.deviceId ?? "",
    input.action,
    input.grant === "always" ? "always" : "never",
    input.target ?? "",
  );
}
