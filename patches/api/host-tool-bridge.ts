/**
 * Bridge: executor → local-runner gateway host-tools (P1).
 */
import type { PrismaClient } from "@rakazo/db";
import {
  decideHostToolPermission,
  type HostToolAction,
  type PermissionDecision,
} from "./host-tool-permissions.js";

export type HostToolInvokeInput = {
  userId: string;
  deviceId: string;
  action: HostToolAction;
  args: Record<string, unknown>;
  timeoutMs?: number;
};

export type HostToolInvokeResult =
  | { ok: true; output: Record<string, unknown> }
  | { ok: false; error: string; needsPermission?: boolean; decision?: PermissionDecision };

export type HostToolGateway = {
  /** True when a device session is online and listed host-tools capability. */
  deviceSupportsHostTools: (deviceId: string) => boolean;
  /** Send tool.invoke and wait for tool.result / tool.denied. */
  invokeHostTool: (
    deviceId: string,
    request: {
      id: string;
      action: HostToolAction;
      args: Record<string, unknown>;
      timeoutMs?: number;
    },
  ) => Promise<{ ok: boolean; output?: Record<string, unknown>; error?: string; denied?: boolean }>;
};

export async function resolveBotHostDevice(
  prisma: PrismaClient,
  userId: string,
  botId: string,
): Promise<{ deviceId: string; modelId: string } | null> {
  const rows = await prisma.$queryRawUnsafe<Array<{ device_id: string; model_id: string }>>(
    `SELECT device_id, model_id FROM local_runner_bot_bindings
     WHERE bot_id = $1 AND user_id = $2`,
    botId,
    userId,
  );
  if (rows[0]) return { deviceId: rows[0].device_id, modelId: rows[0].model_id };
  // Fallback: single online-capable device for the owner
  const devices = await prisma.$queryRawUnsafe<Array<{ id: string }>>(
    `SELECT id FROM local_runner_devices
     WHERE user_id = $1 AND status = 'active' AND enabled
       AND capabilities LIKE '%host-tools%'
     ORDER BY last_seen_at DESC NULLS LAST
     LIMIT 1`,
    userId,
  );
  return devices[0] ? { deviceId: devices[0].id, modelId: "" } : null;
}

export function mapShellToolToHostAction(name: string): HostToolAction | null {
  switch (name) {
    case "shell":
      return "run-command";
    case "read_file":
    case "read":
      return "read-file";
    case "write_file":
    case "write":
      return "write-file";
    case "list_directory":
    case "list_files":
    case "ls":
      return "list-directory";
    case "computer_screenshot":
      return "computer-screenshot";
    case "computer_click":
      return "computer-click";
    case "computer_type":
      return "computer-type";
    case "computer_key":
      return "computer-key";
    case "computer_scroll":
      return "computer-scroll";
    case "computer_wait":
      return "computer-wait";
    case "computer_apps":
      return "computer-apps";
    default:
      return null;
  }
}

export async function invokeHostToolWithPermissions(
  prisma: PrismaClient,
  gateway: HostToolGateway,
  input: HostToolInvokeInput,
): Promise<HostToolInvokeResult> {
  if (!gateway.deviceSupportsHostTools(input.deviceId)) {
    return { ok: false, error: "Host tools are not available on that computer right now." };
  }
  const target =
    typeof input.args.command === "string"
      ? input.args.command
      : typeof input.args.path === "string"
        ? input.args.path
        : undefined;
  const decision = await decideHostToolPermission(prisma, {
    userId: input.userId,
    deviceId: input.deviceId,
    action: input.action,
    target,
  });
  if (decision.kind === "deny") {
    return { ok: false, error: "Host tool denied by permission policy.", decision };
  }
  if (decision.kind === "ask") {
    return {
      ok: false,
      error: "Host tool needs your approval.",
      needsPermission: true,
      decision,
    };
  }
  const id = `ht_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  const result = await gateway.invokeHostTool(input.deviceId, {
    id,
    action: input.action,
    args: input.args,
    timeoutMs: input.timeoutMs,
  });
  if (result.denied) {
    return { ok: false, error: result.error ?? "Denied on the computer.", needsPermission: true };
  }
  if (!result.ok) {
    return { ok: false, error: result.error ?? "Host tool failed." };
  }
  return { ok: true, output: result.output ?? {} };
}
