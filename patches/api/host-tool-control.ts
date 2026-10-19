/**
 * HTTP control plane for host-tool permissions and approvals (P0).
 */
import { randomUUID } from "node:crypto";
import type { PrismaClient } from "@rakazo/db";
import type { Context, Hono } from "hono";
import {
  HOST_TOOL_ACTIONS,
  decideHostToolPermission,
  ensureHostToolPermissionTables,
  isHostToolAction,
  loadPermissionPolicy,
  normalizePermission,
  recordStandingGrant,
  upsertPermissionDefaults,
  type HostToolAction,
  type HostToolPermission,
  type StandingGrant,
} from "./host-tool-permissions.js";

type SessionAuth = {
  api: {
    getSession: (input: { headers: Headers }) => Promise<{ user: { id: string } } | null>;
  };
};

export type HostToolControlDeps = {
  prisma: PrismaClient;
  auth: SessionAuth;
  sessionHeaders: (request: Request) => Headers;
};

class HttpError extends Error {
  constructor(
    readonly status: 400 | 401 | 404,
    message: string,
  ) {
    super(message);
  }
}

async function readJson(c: Context): Promise<Record<string, unknown>> {
  const text = await c.req.text();
  if (!text) return {};
  try {
    const v = JSON.parse(text) as unknown;
    if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error("bad");
    return v as Record<string, unknown>;
  } catch {
    throw new HttpError(400, "Invalid JSON");
  }
}

export function mountHostToolControl(app: Hono, deps: HostToolControlDeps): void {
  const { prisma } = deps;

  function route(handler: (c: Context) => Promise<Response>) {
    return async (c: Context) => {
      try {
        await ensureHostToolPermissionTables(prisma);
        return await handler(c);
      } catch (error) {
        if (error instanceof HttpError) return c.json({ error: error.message }, error.status);
        throw error;
      }
    };
  }

  async function userId(c: Context): Promise<string> {
    const session = await deps.auth.api.getSession({ headers: deps.sessionHeaders(c.req.raw) });
    if (!session?.user?.id) throw new HttpError(401, "Unauthorized");
    return session.user.id;
  }

  app.get(
    "/api/host-tools/actions",
    route(async (c) => c.json({ actions: HOST_TOOL_ACTIONS })),
  );

  app.get(
    "/api/host-tools/permissions",
    route(async (c) => {
      const uid = await userId(c);
      const deviceId = c.req.query("deviceId")?.slice(0, 64) || null;
      const policy = await loadPermissionPolicy(prisma, uid, deviceId);
      return c.json({
        deviceId,
        permission: policy.permission,
        ceiling: policy.ceiling,
        autoReviewEnabled: policy.autoReviewEnabled,
        autoReviewAllow: policy.autoReviewAllow,
        autoReviewBlock: policy.autoReviewBlock,
      });
    }),
  );

  app.post(
    "/api/host-tools/permissions",
    route(async (c) => {
      const uid = await userId(c);
      const body = await readJson(c);
      const deviceId =
        typeof body.deviceId === "string" && body.deviceId.trim() ? body.deviceId.slice(0, 64) : null;
      const permission = normalizePermission(body.permission) as HostToolPermission;
      const ceiling =
        body.ceiling === null || body.ceiling === undefined
          ? null
          : normalizePermission(body.ceiling);
      await upsertPermissionDefaults(prisma, uid, {
        deviceId,
        permission,
        ceiling,
        autoReviewEnabled: body.autoReviewEnabled === true,
        autoReviewAllow: Array.isArray(body.autoReviewAllow)
          ? body.autoReviewAllow.filter((x): x is string => typeof x === "string")
          : undefined,
        autoReviewBlock: Array.isArray(body.autoReviewBlock)
          ? body.autoReviewBlock.filter((x): x is string => typeof x === "string")
          : undefined,
      });
      return c.json({ ok: true });
    }),
  );

  app.post(
    "/api/host-tools/decide",
    route(async (c) => {
      const uid = await userId(c);
      const body = await readJson(c);
      const action = typeof body.action === "string" ? body.action : "";
      if (!isHostToolAction(action)) throw new HttpError(400, "Unknown action");
      const deviceId =
        typeof body.deviceId === "string" && body.deviceId.trim() ? body.deviceId.slice(0, 64) : null;
      const target = typeof body.target === "string" ? body.target.slice(0, 2000) : undefined;
      const decision = await decideHostToolPermission(prisma, {
        userId: uid,
        deviceId,
        action,
        target,
      });
      return c.json(decision);
    }),
  );

  app.post(
    "/api/host-tools/grants",
    route(async (c) => {
      const uid = await userId(c);
      const body = await readJson(c);
      const action = typeof body.action === "string" ? body.action : "";
      if (!isHostToolAction(action)) throw new HttpError(400, "Unknown action");
      const grant = body.grant;
      if (grant !== "always" && grant !== "never" && grant !== "allow-once") {
        throw new HttpError(400, "grant must be always, never, or allow-once");
      }
      const deviceId =
        typeof body.deviceId === "string" && body.deviceId.trim() ? body.deviceId.slice(0, 64) : null;
      const target = typeof body.target === "string" ? body.target.slice(0, 2000) : undefined;
      await recordStandingGrant(prisma, {
        id: randomUUID(),
        userId: uid,
        deviceId,
        action: action as HostToolAction,
        grant: grant as StandingGrant,
        target,
      });
      return c.json({ ok: true });
    }),
  );
}
