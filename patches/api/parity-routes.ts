/**
 * Parity HTTP surface (P2–P9): routines, marketplace, auth helpers, MCP catalog,
 * transcripts, computer-use gate, secrets vault list.
 */
import { randomUUID } from "node:crypto";
import type { PrismaClient } from "@rakazo/db";
import type { Context, Hono } from "hono";
import type { LocalRunnerGateway } from "./local-runners.js";
import { decideHostToolPermission, ensureHostToolPermissionTables } from "./host-tool-permissions.js";
import { approvalView, claimApproval, registerApprovalHandler, requestApproval } from "./host-tool-approvals.js";

type SessionAuth = {
  api: {
    getSession: (input: { headers: Headers }) => Promise<{ user: { id: string } } | null>;
  };
};

export type ParityRouteDeps = {
  prisma: PrismaClient;
  auth: SessionAuth;
  sessionHeaders: (request: Request) => Headers;
  localRunnerGateway: LocalRunnerGateway;
  webOrigin: string;
};

class HttpError extends Error {
  constructor(
    readonly status: 400 | 401 | 403 | 404,
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

async function ensureParityTables(prisma: PrismaClient): Promise<void> {
  await ensureHostToolPermissionTables(prisma);
  await prisma.$executeRawUnsafe(`CREATE TABLE IF NOT EXISTS bot_marketplace_listings (
    bot_id TEXT PRIMARY KEY REFERENCES bots(id) ON DELETE CASCADE,
    owner_user_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
    published BOOLEAN NOT NULL DEFAULT false,
    title TEXT NOT NULL,
    summary TEXT NOT NULL DEFAULT '',
    published_at TIMESTAMPTZ,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);
  await prisma.$executeRawUnsafe(`CREATE TABLE IF NOT EXISTS bot_run_transcripts (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL,
    bot_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
    summary TEXT NOT NULL DEFAULT '',
    body TEXT NOT NULL DEFAULT '',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);
  await prisma.$executeRawUnsafe(
    `CREATE INDEX IF NOT EXISTS bot_run_transcripts_bot_idx ON bot_run_transcripts (bot_id, created_at DESC)`,
  );
  await prisma.$executeRawUnsafe(`CREATE TABLE IF NOT EXISTS background_shells (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
    bot_id TEXT REFERENCES bots(id) ON DELETE SET NULL,
    device_id TEXT,
    command TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'running',
    pid INTEGER,
    output_tail TEXT NOT NULL DEFAULT '',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    finished_at TIMESTAMPTZ
  )`);
  await prisma.$executeRawUnsafe(`ALTER TABLE bots ADD COLUMN IF NOT EXISTS published BOOLEAN NOT NULL DEFAULT false`);
  await prisma.$executeRawUnsafe(`ALTER TABLE bots ADD COLUMN IF NOT EXISTS private_by_default BOOLEAN NOT NULL DEFAULT true`);
}

export function mountParityRoutes(app: Hono, deps: ParityRouteDeps): void {
  const { prisma, localRunnerGateway } = deps;

  async function dispatchBackgroundShell(id: string, deviceId: string | null, command: string): Promise<boolean> {
    // Prefer live host runner when a device is online; otherwise it stays queued for runner pickup.
    if (!deviceId || !localRunnerGateway.deviceInfo(deviceId).online) return false;
    try {
      const result = await localRunnerGateway.invokeHostTool(deviceId, {
        id: randomUUID(),
        action: "run-command",
        args: { command, cwd: ".", background: true, shellId: id },
        timeoutMs: 5_000,
      });
      if (!result.ok) {
        // refused on the computer (sandbox missing, escalation, ...) or failed to start
        await prisma.$executeRawUnsafe(
          `UPDATE background_shells SET status = 'failed', output_tail = $2, finished_at = NOW() WHERE id = $1`,
          id,
          String(result.error ?? "failed").slice(0, 2000),
        );
        return false;
      }
      const pid =
        result.output && typeof result.output === "object" && "pid" in result.output
          ? Number((result.output as { pid?: unknown }).pid)
          : null;
      if (Number.isFinite(pid)) {
        await prisma.$executeRawUnsafe(`UPDATE background_shells SET pid = $2 WHERE id = $1`, id, pid);
      }
      return true;
    } catch {
      return false;
    }
  }

  async function shellStatus(id: string): Promise<string> {
    const rows = await prisma.$queryRawUnsafe<Array<{ status: string }>>(
      `SELECT status FROM background_shells WHERE id = $1`,
      id,
    );
    return rows[0]?.status ?? "unknown";
  }

  // Resume paused background shells when the owner allows them; fail them on deny / expiry.
  registerApprovalHandler("background-shell", {
    async onAllowed(row) {
      const id = row.refId ?? "";
      const command = String(row.payload.command ?? "");
      if (!id || !command || !(await claimApproval(prisma, row.id))) return { status: await shellStatus(id) };
      const moved = await prisma.$executeRawUnsafe(
        `UPDATE background_shells SET status = 'running' WHERE id = $1 AND user_id = $2 AND status = 'pending_approval'`,
        id,
        row.userId,
      );
      if (!Number(moved)) return { status: await shellStatus(id) };
      const dispatched = await dispatchBackgroundShell(id, row.deviceId, command);
      if (!dispatched) {
        await prisma.$executeRawUnsafe(
          `UPDATE background_shells SET status = 'queued' WHERE id = $1 AND status = 'running'`,
          id,
        );
      }
      return { shellId: id, status: await shellStatus(id) };
    },
    async onFinal(row) {
      if (!row.refId) return;
      await prisma.$executeRawUnsafe(
        `UPDATE background_shells SET status = $2, finished_at = NOW()
         WHERE id = $1 AND status = 'pending_approval'`,
        row.refId,
        row.status === "expired" ? "expired" : "denied",
      );
    },
  });

  registerApprovalHandler("send-input", {
    async onAllowed(row) {
      const shellId = row.refId ?? "";
      if (!shellId || !(await claimApproval(prisma, row.id))) return { sent: false };
      const live = await prisma.$queryRawUnsafe<Array<{ status: string }>>(
        `SELECT status FROM background_shells WHERE id = $1 AND user_id = $2`,
        shellId,
        row.userId,
      );
      if (live[0]?.status !== "running" || !localRunnerGateway.deviceInfo(row.deviceId).online) {
        return { sent: false, error: "Shell is not running or the computer is offline" };
      }
      const result = await localRunnerGateway.invokeHostTool(row.deviceId, {
        id: randomUUID(),
        action: "send-input",
        args: { shellId, text: String(row.payload.text ?? "") },
        timeoutMs: 5_000,
      });
      return result.ok ? { sent: true } : { sent: false, error: result.error ?? "send-input failed" };
    },
    async onFinal() {
      /* nothing to clean up: the input is simply not sent */
    },
  });

  function route(handler: (c: Context) => Promise<Response>) {
    return async (c: Context) => {
      try {
        await ensureParityTables(prisma);
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

  // ---- P2 Routines (read/control over existing schedule rows when present) ----
  app.get(
    "/api/parity/bots/:botId/routines",
    route(async (c) => {
      const uid = await userId(c);
      const botId = (c.req.param("botId") ?? "").slice(0, 64);
      const bot = await prisma.bot.findFirst({
        where: { id: botId, userId: uid },
        select: { id: true, name: true },
      });
      if (!bot) throw new HttpError(404, "Not found");
      // Prefer prisma model if present; fall back to raw for older schemas.
      let routines: Array<Record<string, unknown>> = [];
      try {
        routines = await prisma.$queryRawUnsafe(
          `SELECT id, name, active, cron, "nextRunAt" AS next_run_at, "lastRunAt" AS last_run_at,
                  "pausedAt" AS paused_at, "createdAt" AS created_at
           FROM routines WHERE "botId" = $1 ORDER BY "createdAt" DESC LIMIT 100`,
          botId,
        );
      } catch {
        try {
          routines = await prisma.$queryRawUnsafe(
            `SELECT id, name, active, schedule AS cron, next_run_at, last_run_at, created_at
             FROM bot_routines WHERE bot_id = $1 ORDER BY created_at DESC LIMIT 100`,
            botId,
          );
        } catch {
          routines = [];
        }
      }
      return c.json({ botId, botName: bot.name, routines });
    }),
  );

  app.post(
    "/api/parity/bots/:botId/routines/:routineId/pause",
    route(async (c) => {
      const uid = await userId(c);
      const botId = (c.req.param("botId") ?? "").slice(0, 64);
      const routineId = (c.req.param("routineId") ?? "").slice(0, 64);
      const bot = await prisma.bot.findFirst({ where: { id: botId, userId: uid }, select: { id: true } });
      if (!bot) throw new HttpError(404, "Not found");
      try {
        await prisma.$executeRawUnsafe(
          `UPDATE routines SET active = false, "pausedAt" = NOW() WHERE id = $1 AND "botId" = $2`,
          routineId,
          botId,
        );
      } catch {
        await prisma.$executeRawUnsafe(
          `UPDATE bot_routines SET active = false WHERE id = $1 AND bot_id = $2`,
          routineId,
          botId,
        );
      }
      return c.json({ ok: true, active: false });
    }),
  );

  app.post(
    "/api/parity/bots/:botId/routines/:routineId/resume",
    route(async (c) => {
      const uid = await userId(c);
      const botId = (c.req.param("botId") ?? "").slice(0, 64);
      const routineId = (c.req.param("routineId") ?? "").slice(0, 64);
      const bot = await prisma.bot.findFirst({ where: { id: botId, userId: uid }, select: { id: true } });
      if (!bot) throw new HttpError(404, "Not found");
      try {
        await prisma.$executeRawUnsafe(
          `UPDATE routines SET active = true, "pausedAt" = NULL WHERE id = $1 AND "botId" = $2`,
          routineId,
          botId,
        );
      } catch {
        await prisma.$executeRawUnsafe(
          `UPDATE bot_routines SET active = true WHERE id = $1 AND bot_id = $2`,
          routineId,
          botId,
        );
      }
      return c.json({ ok: true, active: true });
    }),
  );

  app.post(
    "/api/parity/bots/:botId/routines/:routineId/run-now",
    route(async (c) => {
      const uid = await userId(c);
      const botId = (c.req.param("botId") ?? "").slice(0, 64);
      const routineId = (c.req.param("routineId") ?? "").slice(0, 64);
      const bot = await prisma.bot.findFirst({ where: { id: botId, userId: uid }, select: { id: true } });
      if (!bot) throw new HttpError(404, "Not found");
      let found = false;
      try {
        const n = await prisma.$executeRawUnsafe(
          `UPDATE routines SET "nextRunAt" = NOW(), "lastRunAt" = NOW() WHERE id = $1 AND "botId" = $2`,
          routineId,
          botId,
        );
        found = Number(n) > 0;
      } catch {
        const n = await prisma.$executeRawUnsafe(
          `UPDATE bot_routines SET next_run_at = NOW(), last_run_at = NOW() WHERE id = $1 AND bot_id = $2`,
          routineId,
          botId,
        );
        found = Number(n) > 0;
      }
      if (!found) throw new HttpError(404, "Routine not found");
      return c.json({ ok: true, queued: true, routineId, botId });
    }),
  );

  // ---- P3 transcripts + background shells ----
  app.get(
    "/api/parity/bots/:botId/transcripts",
    route(async (c) => {
      const uid = await userId(c);
      const botId = (c.req.param("botId") ?? "").slice(0, 64);
      const bot = await prisma.bot.findFirst({ where: { id: botId, userId: uid }, select: { id: true } });
      if (!bot) throw new HttpError(404, "Not found");
      const rows = await prisma.$queryRawUnsafe<
        Array<{ id: string; run_id: string; summary: string; created_at: Date }>
      >(
        `SELECT id, run_id, summary, created_at FROM bot_run_transcripts
         WHERE bot_id = $1 AND user_id = $2 ORDER BY created_at DESC LIMIT 50`,
        botId,
        uid,
      );
      return c.json({
        transcripts: rows.map((r) => ({
          id: r.id,
          runId: r.run_id,
          summary: r.summary,
          createdAt: r.created_at.toISOString(),
        })),
      });
    }),
  );

  app.get(
    "/api/parity/transcripts/:id",
    route(async (c) => {
      const uid = await userId(c);
      const id = (c.req.param("id") ?? "").slice(0, 64);
      const rows = await prisma.$queryRawUnsafe<
        Array<{ id: string; run_id: string; summary: string; body: string; created_at: Date }>
      >(
        `SELECT id, run_id, summary, body, created_at FROM bot_run_transcripts
         WHERE id = $1 AND user_id = $2`,
        id,
        uid,
      );
      if (!rows[0]) throw new HttpError(404, "Not found");
      return c.json({
        id: rows[0].id,
        runId: rows[0].run_id,
        summary: rows[0].summary,
        body: rows[0].body,
        createdAt: rows[0].created_at.toISOString(),
      });
    }),
  );

  app.get(
    "/api/parity/background-shells",
    route(async (c) => {
      const uid = await userId(c);
      const rows = await prisma.$queryRawUnsafe<
        Array<{
          id: string;
          bot_id: string | null;
          command: string;
          status: string;
          output_tail: string;
          created_at: Date;
          finished_at: Date | null;
        }>
      >(
        `SELECT id, bot_id, command, status, output_tail, created_at, finished_at
         FROM background_shells WHERE user_id = $1 ORDER BY created_at DESC LIMIT 50`,
        uid,
      );
      return c.json({
        shells: rows.map((r) => ({
          id: r.id,
          botId: r.bot_id,
          command: r.command,
          status: r.status,
          outputTail: r.output_tail,
          createdAt: r.created_at.toISOString(),
          finishedAt: r.finished_at?.toISOString() ?? null,
        })),
      });
    }),
  );

  app.post(
    "/api/parity/background-shells",
    route(async (c) => {
      const uid = await userId(c);
      const body = await readJson(c);
      const command = typeof body.command === "string" ? body.command.trim().slice(0, 4000) : "";
      if (!command) throw new HttpError(400, "command required");
      const botId =
        typeof body.botId === "string" && body.botId.trim() ? body.botId.slice(0, 64) : null;
      const deviceId =
        typeof body.deviceId === "string" && body.deviceId.trim()
          ? body.deviceId.slice(0, 64)
          : null;
      // A shell always targets one specific computer, so the permission policy always applies.
      if (!deviceId) throw new HttpError(400, "deviceId required");
      if (botId) {
        const bot = await prisma.bot.findFirst({
          where: { id: botId, userId: uid },
          select: { id: true },
        });
        if (!bot) throw new HttpError(404, "Bot not found");
      }
      // The device must belong to the caller, and the host-tool permission policy
      // (ceiling, auto-review, standing grants, always/ask/never) applies like any run-command.
      if (deviceId) {
        const owned = await prisma.$queryRawUnsafe<Array<{ id: string }>>(
          `SELECT id FROM local_runner_devices WHERE id = $1 AND user_id = $2 AND status = 'active'`,
          deviceId,
          uid,
        );
        if (!owned[0]) throw new HttpError(404, "Device not found");
        const decision = await decideHostToolPermission(prisma, {
          userId: uid,
          deviceId,
          action: "run-command",
          target: command,
        });
        if (decision.kind === "deny") {
          throw new HttpError(403, "Host tool denied by permission policy.");
        }
        if (decision.kind === "ask") {
          // Paused: the shell row waits in pending_approval until the owner decides on the card.
          const id = randomUUID();
          await prisma.$executeRawUnsafe(
            `INSERT INTO background_shells
               (id, user_id, bot_id, device_id, command, status, output_tail, created_at)
             VALUES ($1, $2, $3, $4, $5, 'pending_approval', '', NOW())`,
            id,
            uid,
            botId,
            deviceId,
            command,
          );
          const approval = await requestApproval(prisma, {
            userId: uid,
            deviceId,
            action: "run-command",
            target: command,
            payload: { command },
            source: "background-shell",
            refId: id,
          });
          return c.json(
            {
              id,
              status: "pending_approval",
              command,
              needsPermission: true,
              approval: approvalView(approval),
            },
            202,
          );
        }
      }
      const id = randomUUID();
      await prisma.$executeRawUnsafe(
        `INSERT INTO background_shells
           (id, user_id, bot_id, device_id, command, status, output_tail, created_at)
         VALUES ($1, $2, $3, $4, $5, 'running', '', NOW())`,
        id,
        uid,
        botId,
        deviceId,
        command,
      );
      const dispatched = await dispatchBackgroundShell(id, deviceId, command);
      const status = dispatched ? "running" : await shellStatus(id);
      if (!dispatched && status === "running") {
        await prisma.$executeRawUnsafe(`UPDATE background_shells SET status = 'queued' WHERE id = $1 AND status = 'running'`, id);
      }
      return c.json({ id, status: dispatched ? "running" : status === "running" ? "queued" : status, command });
    }),
  );

  app.post(
    "/api/parity/background-shells/:id/kill",
    route(async (c) => {
      const uid = await userId(c);
      const id = (c.req.param("id") ?? "").slice(0, 64);
      const rows = await prisma.$queryRawUnsafe<
        Array<{ id: string; device_id: string | null; pid: number | null; status: string }>
      >(
        `SELECT id, device_id, pid, status FROM background_shells WHERE id = $1 AND user_id = $2`,
        id,
        uid,
      );
      if (!rows[0]) throw new HttpError(404, "Not found");
      const row = rows[0];
      if (row.device_id && localRunnerGateway.deviceInfo(row.device_id).online) {
        try {
          await localRunnerGateway.invokeHostTool(row.device_id, {
            id: randomUUID(),
            action: "kill-shell",
            args: { shellId: id, pid: row.pid },
            timeoutMs: 5_000,
          });
        } catch {
          /* best effort */
        }
      }
      await prisma.$executeRawUnsafe(
        `UPDATE background_shells SET status = 'killed', finished_at = NOW()
         WHERE id = $1 AND user_id = $2`,
        id,
        uid,
      );
      return c.json({ ok: true, status: "killed" });
    }),
  );

  app.post(
    "/api/parity/background-shells/:id/send-input",
    route(async (c) => {
      const uid = await userId(c);
      const id = (c.req.param("id") ?? "").slice(0, 64);
      const body = await readJson(c);
      const text = typeof body.text === "string" ? body.text.slice(0, 16_000) : "";
      if (!text) throw new HttpError(400, "text required");
      const rows = await prisma.$queryRawUnsafe<
        Array<{ id: string; device_id: string | null; status: string }>
      >(
        `SELECT id, device_id, status FROM background_shells WHERE id = $1 AND user_id = $2`,
        id,
        uid,
      );
      if (!rows[0]) throw new HttpError(404, "Not found");
      if (rows[0].status !== "running") throw new HttpError(400, "Shell is not running");
      if (!rows[0].device_id || !localRunnerGateway.deviceInfo(rows[0].device_id).online) {
        throw new HttpError(400, "Device offline");
      }
      const decision = await decideHostToolPermission(prisma, {
        userId: uid,
        deviceId: rows[0].device_id,
        action: "send-input",
        target: text,
      });
      if (decision.kind === "deny") throw new HttpError(403, "Host tool denied by permission policy.");
      if (decision.kind === "ask") {
        const approval = await requestApproval(prisma, {
          userId: uid,
          deviceId: rows[0].device_id,
          action: "send-input",
          target: text.slice(0, 500),
          payload: { text },
          source: "send-input",
          refId: id,
        });
        return c.json({ ok: false, status: "pending_approval", needsPermission: true, approval: approvalView(approval) }, 202);
      }
      const result = await localRunnerGateway.invokeHostTool(rows[0].device_id, {
        id: randomUUID(),
        action: "send-input",
        args: { shellId: id, text },
        timeoutMs: 5_000,
      });
      if (!result.ok) throw new HttpError(400, result.error || "send-input failed");
      return c.json({ ok: true });
    }),
  );

  // ---- P4 MCP catalog snapshot + secrets vault list ----
  app.get(
    "/api/parity/mcp/catalog",
    route(async (c) => {
      await userId(c);
      return c.json({
        catalog: [
          {
            id: "google",
            name: "Google",
            connectors: ["gmail", "drive", "calendar"],
            oauth: true,
            status: "available",
          },
          { id: "slack", name: "Slack", connectors: ["slack"], oauth: true, status: "available" },
          {
            id: "microsoft-teams",
            name: "Microsoft Teams",
            connectors: ["teams"],
            oauth: true,
            status: "available",
          },
          {
            id: "custom-mcp",
            name: "Custom MCP server",
            connectors: ["stdio", "http"],
            oauth: false,
            status: "available",
          },
        ],
        note: "Connect via Settings → MCP. OAuth uses the existing McpOAuthBroker.",
      });
    }),
  );

  app.get(
    "/api/parity/secrets",
    route(async (c) => {
      const uid = await userId(c);
      // Secret rows carry only id/kind/ciphertext/createdAt; never return ciphertext.
      const secrets = await prisma.secret.findMany({
        where: { userId: uid, spaceId: null },
        select: { id: true, kind: true, createdAt: true },
        orderBy: { createdAt: "desc" },
        take: 200,
      });
      return c.json({
        secrets: secrets.map((s) => ({
          id: s.id,
          name: s.kind,
          kind: s.kind,
          createdAt: s.createdAt.toISOString(),
        })),
      });
    }),
  );

  // ---- P5 computer-use gate per device ----
  app.get(
    "/api/parity/devices/:deviceId/computer-use",
    route(async (c) => {
      const uid = await userId(c);
      const deviceId = (c.req.param("deviceId") ?? "").slice(0, 64);
      const rows = await prisma.$queryRawUnsafe<
        Array<{ id: string; computer_use_gate: boolean; capabilities: string }>
      >(
        `SELECT id, computer_use_gate, capabilities FROM local_runner_devices
         WHERE id = $1 AND user_id = $2 AND status = 'active'`,
        deviceId,
        uid,
      );
      if (!rows[0]) throw new HttpError(404, "Not found");
      let caps: string[] = [];
      try {
        caps = JSON.parse(rows[0].capabilities) as string[];
      } catch {
        caps = ["inference"];
      }
      const live = localRunnerGateway.deviceInfo(deviceId);
      return c.json({
        deviceId,
        gateOn: rows[0].computer_use_gate === true,
        online: live.online,
        capabilities: caps,
      });
    }),
  );

  app.post(
    "/api/parity/devices/:deviceId/computer-use",
    route(async (c) => {
      const uid = await userId(c);
      const deviceId = (c.req.param("deviceId") ?? "").slice(0, 64);
      const body = await readJson(c);
      const gateOn = body.gateOn === true;
      const n = await prisma.$executeRawUnsafe(
        `UPDATE local_runner_devices SET computer_use_gate = $3, updated_at = NOW()
         WHERE id = $1 AND user_id = $2 AND status = 'active'`,
        deviceId,
        uid,
        gateOn,
      );
      if (!n) throw new HttpError(404, "Not found");
      return c.json({ ok: true, gateOn });
    }),
  );

  // ---- P7 marketplace ----
  app.get(
    "/api/parity/marketplace",
    route(async (c) => {
      await userId(c);
      const q = (c.req.query("q") ?? "").trim().toLowerCase().slice(0, 80);
      const rows = await prisma.$queryRawUnsafe<
        Array<{
          bot_id: string;
          title: string;
          summary: string;
          owner_user_id: string;
          published_at: Date | null;
          bot_name: string;
        }>
      >(
        `SELECT l.bot_id, l.title, l.summary, l.owner_user_id, l.published_at, b.name AS bot_name
         FROM bot_marketplace_listings l
         JOIN bots b ON b.id = l.bot_id
         WHERE l.published = true
         ORDER BY l.published_at DESC NULLS LAST
         LIMIT 100`,
      );
      const filtered = q
        ? rows.filter(
            (r) =>
              r.title.toLowerCase().includes(q) ||
              r.summary.toLowerCase().includes(q) ||
              r.bot_name.toLowerCase().includes(q),
          )
        : rows;
      return c.json({
        bots: filtered.map((r) => ({
          botId: r.bot_id,
          name: r.bot_name,
          title: r.title,
          summary: r.summary,
          ownerUserId: r.owner_user_id,
          publishedAt: r.published_at?.toISOString() ?? null,
          runsAsOwner: true,
        })),
      });
    }),
  );

  app.post(
    "/api/parity/bots/:botId/publish",
    route(async (c) => {
      const uid = await userId(c);
      const botId = (c.req.param("botId") ?? "").slice(0, 64);
      const body = await readJson(c);
      const published = body.published !== false;
      const bot = await prisma.bot.findFirst({
        where: { id: botId, userId: uid },
        select: { id: true, name: true, title: true, description: true },
      });
      if (!bot) throw new HttpError(404, "Not found");
      const title =
        (typeof body.title === "string" && body.title.trim()) || bot.title || bot.name;
      const summary =
        (typeof body.summary === "string" && body.summary.trim()) || bot.description || "";
      if (published) {
        await prisma.$executeRawUnsafe(
          `INSERT INTO bot_marketplace_listings
             (bot_id, owner_user_id, published, title, summary, published_at, updated_at)
           VALUES ($1, $2, true, $3, $4, NOW(), NOW())
           ON CONFLICT (bot_id) DO UPDATE SET
             published = true, title = EXCLUDED.title, summary = EXCLUDED.summary,
             published_at = COALESCE(bot_marketplace_listings.published_at, NOW()),
             updated_at = NOW()`,
          botId,
          uid,
          title.slice(0, 120),
          summary.slice(0, 2000),
        );
        await prisma.$executeRawUnsafe(
          `UPDATE bots SET published = true WHERE id = $1 AND "userId" = $2`,
          botId,
          uid,
        );
      } else {
        await prisma.$executeRawUnsafe(
          `UPDATE bot_marketplace_listings SET published = false, updated_at = NOW() WHERE bot_id = $1`,
          botId,
        );
        await prisma.$executeRawUnsafe(
          `UPDATE bots SET published = false WHERE id = $1 AND "userId" = $2`,
          botId,
          uid,
        );
      }
      return c.json({ ok: true, published, runsAsOwner: true });
    }),
  );

  app.post(
    "/api/parity/marketplace/:botId/add-to-chat",
    route(async (c) => {
      const uid = await userId(c);
      const botId = (c.req.param("botId") ?? "").slice(0, 64);
      const listings = await prisma.$queryRawUnsafe<
        Array<{ bot_id: string; owner_user_id: string; published: boolean; title: string }>
      >(
        `SELECT bot_id, owner_user_id, published, title FROM bot_marketplace_listings
         WHERE bot_id = $1 AND published = true`,
        botId,
      );
      if (!listings[0]) throw new HttpError(404, "Published bot not found");
      const listing = listings[0];
      // Private-by-default: add creates a user bookmark / chat pin, not a fork.
      await prisma.$executeRawUnsafe(`CREATE TABLE IF NOT EXISTS bot_marketplace_pins (
        user_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
        bot_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
        pinned_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (user_id, bot_id)
      )`);
      await prisma.$executeRawUnsafe(
        `INSERT INTO bot_marketplace_pins (user_id, bot_id, pinned_at)
         VALUES ($1, $2, NOW())
         ON CONFLICT (user_id, bot_id) DO UPDATE SET pinned_at = NOW()`,
        uid,
        botId,
      );
      return c.json({
        ok: true,
        botId,
        title: listing.title,
        runsAsOwner: true,
        ownerUserId: listing.owner_user_id,
        privateByDefault: true,
        note: "Pinned to your chat list. The bot still runs as its owner.",
      });
    }),
  );

  // ---- P8 auth: password status (set-password uses Better Auth /api/auth) ----
  app.get(
    "/api/parity/auth/status",
    route(async (c) => {
      const uid = await userId(c);
      const accounts = await prisma.account
        .findMany({
          where: { userId: uid },
          select: { providerId: true, password: true },
        })
        .catch(() => [] as Array<{ providerId: string; password: string | null }>);
      const hasPassword = accounts.some(
        (a) => a.providerId === "credential" && Boolean(a.password),
      );
      const passkeys = await prisma.$queryRawUnsafe<Array<{ n: number }>>(
        `SELECT COUNT(*)::int AS n FROM passkey WHERE "userId" = $1`,
        uid,
      ).catch(() => [{ n: 0 }]);
      return c.json({
        hasPassword,
        passkeyCount: passkeys[0]?.n ?? 0,
        magicLinkEnabled: true,
        setPasswordPath: "/api/auth/set-password",
        passkeyPath: "/api/auth/passkey",
      });
    }),
  );

  // ---- P9 i18n catalog ----
  app.get(
    "/api/parity/i18n",
    route(async (c) => {
      await userId(c);
      return c.json({
        defaultLocale: "en",
        locales: [
          { id: "en", label: "English" },
          { id: "it", label: "Italiano" },
          { id: "de", label: "Deutsch" },
          { id: "fr", label: "Français" },
          { id: "es", label: "Español" },
        ],
        strings: {
          en: {
            routines: "Routines",
            myHardware: "My hardware",
            onMyComputer: "On my computer",
            toolPermissions: "Tool permissions",
            marketplace: "Marketplace",
            computerUse: "Computer use",
            publishBot: "Publish bot",
          },
          it: {
            routines: "Routine",
            myHardware: "Il mio hardware",
            onMyComputer: "Sul mio computer",
            toolPermissions: "Permessi tool",
            marketplace: "Marketplace",
            computerUse: "Uso del computer",
            publishBot: "Pubblica bot",
          },
          de: {
            routines: "Routinen",
            myHardware: "Meine Hardware",
            onMyComputer: "Auf meinem Computer",
            toolPermissions: "Tool-Berechtigungen",
            marketplace: "Marktplatz",
            computerUse: "Computernutzung",
            publishBot: "Bot veröffentlichen",
          },
          fr: {
            routines: "Routines",
            myHardware: "Mon matériel",
            onMyComputer: "Sur mon ordinateur",
            toolPermissions: "Permissions des outils",
            marketplace: "Marketplace",
            computerUse: "Utilisation de l'ordinateur",
            publishBot: "Publier le bot",
          },
          es: {
            routines: "Rutinas",
            myHardware: "Mi hardware",
            onMyComputer: "En mi ordenador",
            toolPermissions: "Permisos de herramientas",
            marketplace: "Marketplace",
            computerUse: "Uso del ordenador",
            publishBot: "Publicar bot",
          },
        },
      });
    }),
  );

  // Desktop app discovery (P6)
  app.get("/api/parity/desktop/manifest", async (c) =>
    c.json({
      name: "Rakijazios",
      version: "0.1.0-parity",
      download: {
        linux: `${deps.webOrigin.replace(/\/+$/, "")}/desktop/rakijazios-linux.AppImage`,
        mac: `${deps.webOrigin.replace(/\/+$/, "")}/desktop/Rakijazios.dmg`,
        windows: `${deps.webOrigin.replace(/\/+$/, "")}/desktop/Rakijazios-Setup.exe`,
      },
      features: ["chat", "embedded-runner", "tray", "auto-update"],
      note: "Desktop shell lives in packages/desktop; installers are published with releases.",
    }),
  );

  // Helper used by executor / tests to persist a transcript
  app.post(
    "/api/parity/transcripts",
    route(async (c) => {
      const uid = await userId(c);
      const body = await readJson(c);
      const botId = typeof body.botId === "string" ? body.botId.slice(0, 64) : "";
      const runId = typeof body.runId === "string" ? body.runId.slice(0, 64) : randomUUID();
      const summary = typeof body.summary === "string" ? body.summary.slice(0, 500) : "";
      const text = typeof body.body === "string" ? body.body.slice(0, 200_000) : "";
      if (!botId) throw new HttpError(400, "botId required");
      const bot = await prisma.bot.findFirst({ where: { id: botId, userId: uid }, select: { id: true } });
      if (!bot) throw new HttpError(404, "Not found");
      const id = randomUUID();
      await prisma.$executeRawUnsafe(
        `INSERT INTO bot_run_transcripts (id, run_id, bot_id, user_id, summary, body, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, NOW())`,
        id,
        runId,
        botId,
        uid,
        summary,
        text,
      );
      return c.json({ id });
    }),
  );
}
