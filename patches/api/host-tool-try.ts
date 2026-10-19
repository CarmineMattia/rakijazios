/**
 * Shared helper: try owner host-tools first, else signal fallback to sandbox.
 */
import type { PrismaClient } from "@rakazo/db";
import {
  invokeHostToolWithPermissions,
  mapShellToolToHostAction,
  resolveBotHostDevice,
  type HostToolGateway,
} from "./host-tool-bridge.js";
import type { HostToolAction } from "./host-tool-permissions.js";

export type HostTryResult =
  | { kind: "result"; value: Record<string, unknown> }
  | { kind: "needs_permission"; value: Record<string, unknown> }
  | { kind: "fallback" };

export async function tryOwnerHostTool(input: {
  prisma: PrismaClient;
  hostTools?: HostToolGateway;
  ownerUserId: string;
  botId: string;
  toolName: string;
  args: Record<string, unknown>;
  redact?: (value: Record<string, unknown>) => Record<string, unknown>;
}): Promise<HostTryResult> {
  if (!input.hostTools) return { kind: "fallback" };
  const action = mapShellToolToHostAction(input.toolName);
  if (!action) return { kind: "fallback" };

  const host = await resolveBotHostDevice(input.prisma, input.ownerUserId, input.botId);
  if (!host || !input.hostTools.deviceSupportsHostTools(host.deviceId)) {
    return { kind: "fallback" };
  }

  const mappedArgs = mapArgs(action, input.args);
  const hostResult = await invokeHostToolWithPermissions(input.prisma, input.hostTools, {
    userId: input.ownerUserId,
    deviceId: host.deviceId,
    action,
    args: mappedArgs,
  });

  if (hostResult.needsPermission) {
    return {
      kind: "needs_permission",
      value: {
        error: hostResult.error,
        needsPermission: true,
        action,
        deviceId: host.deviceId,
        approveHint: "POST /api/host-tools/grants with grant=always|allow-once|never",
      },
    };
  }
  if (!hostResult.ok) return { kind: "fallback" };

  const raw = normalizeOutput(action, hostResult.output, input.args);
  return { kind: "result", value: input.redact ? input.redact(raw) : raw };
}

function mapArgs(action: HostToolAction, args: Record<string, unknown>): Record<string, unknown> {
  switch (action) {
    case "run-command":
      return { command: String(args.command ?? args.cmd ?? ""), cwd: args.cwd ? String(args.cwd) : "." };
    case "read-file":
    case "write-file":
    case "list-directory":
      return {
        path: String(args.path ?? "."),
        content: args.content ?? args.text,
      };
    default:
      return { ...args };
  }
}

function normalizeOutput(
  action: HostToolAction,
  output: Record<string, unknown>,
  args: Record<string, unknown>,
): Record<string, unknown> {
  if (action === "run-command") {
    return {
      exitCode: Number(output.exitCode ?? 0),
      stdout: String(output.stdout ?? ""),
      stderr: String(output.stderr ?? ""),
    };
  }
  if (action === "read-file") {
    return {
      path: String(args.path ?? output.path ?? ""),
      content: String(output.text ?? ""),
      truncated: Boolean(output.truncated),
    };
  }
  if (action === "write-file") {
    return { ok: true, path: String(args.path ?? output.path ?? ""), bytes: output.bytes };
  }
  if (action === "list-directory") {
    return {
      path: String(args.path ?? output.path ?? ""),
      entries: Array.isArray(output.entries) ? output.entries : [],
    };
  }
  return output;
}
