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

  // Always the bot owner's policy and computer: resolved from the bot row, never from the run actor
  // (a peer's shared-local run must not decide host tools on the owner's machine).
  const owners = await input.prisma.$queryRawUnsafe<Array<{ user_id: string; published: boolean | null }>>(
    `SELECT b."userId" AS user_id, (to_jsonb(b)->>'published')::boolean AS published FROM bots b WHERE b.id = $1`,
    input.botId,
  );
  const ownerUserId = owners[0]?.user_id;
  if (!ownerUserId) return { kind: "fallback" };
  if (input.ownerUserId && input.ownerUserId !== ownerUserId) return { kind: "fallback" };
  // Published (marketplace) bots can be triggered by other people: they never reach the owner's
  // computer and use the normal sandbox instead.
  if (owners[0]?.published === true) return { kind: "fallback" };
  const host = await resolveBotHostDevice(input.prisma, ownerUserId, input.botId);
  if (!host || !input.hostTools.deviceSupportsHostTools(host.deviceId)) {
    return { kind: "fallback" };
  }

  const mappedArgs = mapArgs(action, input.args);
  const hostResult = await invokeHostToolWithPermissions(input.prisma, input.hostTools, {
    userId: ownerUserId,
    deviceId: host.deviceId,
    action,
    args: mappedArgs,
  });

  if (!hostResult.ok && hostResult.refused) {
    // Denied by policy, by the owner, expired, or refused by the sandbox/guards on the computer.
    // Never fall back to another executor for an action the owner refused.
    return {
      kind: "result",
      value: { error: hostResult.error, refused: true, action, approvalId: hostResult.approvalId ?? null },
    };
  }
  if (!hostResult.ok && hostResult.needsPermission) {
    return {
      kind: "needs_permission",
      value: { error: hostResult.error, needsPermission: true, action, deviceId: host.deviceId },
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
