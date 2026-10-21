/**
 * Rakijazios M2a: "Settings → My hardware" API, one-time pairing and the
 * OS-aware runner installers.
 *
 * Cookie-session routes (owner only; foreign ids → 404):
 *   GET  /api/local-runners/config
 *   GET  /api/local-runners/devices
 *   POST /api/local-runners/pairings                 {os?}        → one-time code + install commands
 *   GET  /api/local-runners/pairings/:id                          → pending | paired | connected | expired | cancelled
 *   POST /api/local-runners/pairings/:id/cancel
 *   POST /api/local-runners/devices/:id              {name?, enabled?}
 *   POST /api/local-runners/devices/:id/models       {modelId, enabled}
 *   POST /api/local-runners/devices/:id/rotate                    → new code for the same computer
 *   POST /api/local-runners/devices/:id/revoke
 *   POST /api/local-runners/devices/:id/check                     → re-check the computer now (health)
 *   POST /api/local-runners/devices/:id/limits   {maxConcurrent?, perUserPerMinute?, dailyRequestCap?, personDailyCap?, dailyTokenCap? (caps: number|null)}
 *   GET  /api/local-runners/usage?days=14                          → owner's usage per day / computer / person
 *   GET  /api/local-runners/usage.csv?from=YYYY-MM-DD&to=YYYY-MM-DD → owner's usage as CSV (default last 30 days)
 * Runner (no cookie; the one-time code is the credential):
 *   POST /api/local-runners/pair                     {code, name, platform, runnerVersion, existing?}
 * Public installer files (no secrets):
 *   GET  /api/local-runners/install.sh | install.ps1 | runner/manifest.json | runner/files/:name
 *
 * Everything except the gateway (/ws, /v1/*) is behind RAKAZO_LOCAL_RUNNERS_UI=1.
 */
import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import type { PrismaClient } from "@rakazo/db";
import type { Context, Hono } from "hono";
import type { LocalRunnerGateway } from "./local-runners.js";
import {
  ensureLocalRunnerTables,
  iso,
  LATEST_RUNNER_VERSION,
  LIMIT_BOUNDS,
  limitsFromRow,
  USAGE_ROWS_SQL,
  USAGE_EXPORT_MAX_ROWS,
  normalizeLimits,
  parseUsageExportRange,
  queryUsageExport,
  usageCsv,
  runnerUpdateAvailable,
  type DeviceLimits,
} from "./local-runners.js";
import {
  FailureLimiter,
  MAX_DEVICES_PER_USER,
  PAIRING_TTL_MS,
  formatPairingCode,
  gatewayWsUrlFor,
  generatePairingCode,
  normalizeOs,
  normalizePairingCode,
  sanitizeDeviceName,
  sanitizeShort,
} from "./local-runner-pairing.js";
import {
  installCommands,
  loadRunnerBundle,
  renderInstallPs1,
  renderInstallSh,
  type RunnerBundle,
} from "./local-runner-install.js";
import { hashDeviceToken, hashPairingCode } from "./shared-local-token.js";

type SessionAuth = {
  api: {
    getSession: (input: { headers: Headers }) => Promise<{ user: { id: string } } | null>;
  };
};

export type LocalRunnerControlDeps = {
  prisma: PrismaClient;
  auth: SessionAuth;
  sessionHeaders: (request: Request) => Headers;
  gateway: LocalRunnerGateway;
  webOrigin: string;
};

const MAX_BODY_BYTES = 8 * 1024;
const BAD_CODE =
  "This code is wrong, expired or already used. Get a new one in Settings → My hardware.";
const DEVICE_LIMIT = `You can connect up to ${MAX_DEVICES_PER_USER} computers. Remove one first.`;

export function localRunnersUiEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.RAKAZO_LOCAL_RUNNERS_UI === "1";
}

type DeviceRow = {
  id: string;
  name: string;
  enabled: boolean;
  platform: string | null;
  runner_version: string | null;
  last_seen_at: Date | null;
  created_at: Date;
  paired_via: string | null;
};

type PairingRow = {
  id: string;
  user_id: string;
  device_id: string | null;
  result_device_id: string | null;
  os: string | null;
  expires_at: Date;
  used_at: Date | null;
  cancelled_at: Date | null;
};

class HttpError extends Error {
  constructor(
    readonly status: 400 | 401 | 404 | 409 | 413 | 415 | 429,
    message: string,
    /** Machine-readable reason for the runner (e.g. why an existing install can't be kept). */
    readonly reason?: string,
  ) {
    super(message);
  }
}

async function readBody(c: Context): Promise<Record<string, unknown>> {
  if (c.req.header("content-type")?.split(";")[0]?.trim() !== "application/json") {
    throw new HttpError(415, "Use application/json");
  }
  const text = await c.req.text();
  if (text.length > MAX_BODY_BYTES) throw new HttpError(413, "Request too large");
  if (!text) return {};
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    throw new HttpError(400, "Invalid JSON");
  }
  if (!v || typeof v !== "object" || Array.isArray(v)) throw new HttpError(400, "Invalid request");
  return v as Record<string, unknown>;
}

function newToken(): string {
  return randomBytes(32).toString("base64url");
}

/** Placeholder hash that no token can match (keeps token_hash UNIQUE NOT NULL). */
function deadHash(tag: string): string {
  return `${tag}:${randomBytes(16).toString("hex")}`;
}

export function mountLocalRunnerControl(app: Hono, deps: LocalRunnerControlDeps): void {
  const { prisma, gateway } = deps;
  const bundleDir = process.env.RAKAZO_RUNNER_BUNDLE_DIR?.trim() || "/app/apps/api/local-runner-bundle";
  let bundle: RunnerBundle | null | undefined;
  const getBundle = () => {
    bundle ??= loadRunnerBundle(bundleDir);
    return bundle;
  };
  const origin = deps.webOrigin.replace(/\/+$/, "");
  const wsUrl = () => gatewayWsUrlFor(origin, process.env.RAKAZO_RUNNER_GATEWAY_WS_URL);
  // Failed pair attempts: per client (address appended by the web proxy) and a global cap.
  const perClient = new FailureLimiter(10, 10 * 60_000);
  // 40-bit codes live 10 minutes, so even 300 guesses per 10 minutes is hopeless
  // for an attacker, while one noisy client cannot block pairing for everyone.
  const global = new FailureLimiter(300, 10 * 60_000);

  function route(handler: (c: Context) => Promise<Response>) {
    return async (c: Context) => {
      if (!localRunnersUiEnabled()) return c.json({ error: "Not found" }, 404);
      try {
        await ensureLocalRunnerTables(prisma);
        return await handler(c);
      } catch (error) {
        if (error instanceof HttpError) {
          return c.json(error.reason ? { error: error.message, reason: error.reason } : { error: error.message }, error.status);
        }
        throw error;
      }
    };
  }

  async function userId(c: Context): Promise<string> {
    const session = await deps.auth.api.getSession({ headers: deps.sessionHeaders(c.req.raw) });
    if (!session?.user?.id) throw new HttpError(401, "Unauthorized");
    return session.user.id;
  }

  async function ownedDevice(uid: string, deviceId: string): Promise<DeviceRow> {
    const rows = await prisma.$queryRawUnsafe<DeviceRow[]>(
      `SELECT id, name, enabled, platform, runner_version, last_seen_at, created_at, paired_via
       FROM local_runner_devices WHERE id = $1 AND user_id = $2 AND status = 'active'`,
      deviceId.slice(0, 64),
      uid,
    );
    if (!rows[0]) throw new HttpError(404, "Not found");
    return rows[0];
  }

  async function activeDeviceCount(uid: string): Promise<number> {
    const rows = await prisma.$queryRawUnsafe<Array<{ n: number }>>(
      `SELECT COUNT(*)::int AS n FROM local_runner_devices WHERE user_id = $1 AND status = 'active'`,
      uid,
    );
    return rows[0]?.n ?? 0;
  }

  async function createPairing(uid: string, input: { os: string | null; deviceId: string | null }) {
    await prisma.$executeRawUnsafe(
      `DELETE FROM local_runner_pairings WHERE created_at < NOW() - INTERVAL '1 day'`,
    );
    // Only one live code per purpose: a new code cancels the previous unused one.
    await prisma.$executeRawUnsafe(
      `UPDATE local_runner_pairings SET cancelled_at = NOW()
       WHERE user_id = $1 AND device_id IS NOT DISTINCT FROM $2 AND used_at IS NULL AND cancelled_at IS NULL`,
      uid,
      input.deviceId,
    );
    const code = generatePairingCode();
    const id = randomUUID();
    const expiresAt = new Date(Date.now() + PAIRING_TTL_MS);
    await prisma.$executeRawUnsafe(
      `INSERT INTO local_runner_pairings (id, user_id, code_hash, device_id, os, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      id,
      uid,
      hashPairingCode(code),
      input.deviceId,
      input.os,
      expiresAt,
    );
    const pretty = formatPairingCode(code);
    return {
      pairingId: id,
      code: pretty,
      expiresAt: expiresAt.toISOString(),
      ttlSeconds: Math.round(PAIRING_TTL_MS / 1000),
      server: origin,
      runnerVersion: getBundle()?.version ?? null,
      reconnectDeviceId: input.deviceId,
      commands: installCommands(origin, pretty),
    };
  }

  // ---- public installer files (behind the feature flag, no auth, no secrets) ----
  app.get(
    "/api/local-runners/install.sh",
    route(async (c) => {
      const b = getBundle();
      if (!b) return c.json({ error: "Runner bundle not available on this server" }, 404);
      return c.body(renderInstallSh(origin, b), 200, {
        "content-type": "text/x-shellscript; charset=utf-8",
        "cache-control": "no-store",
      });
    }),
  );
  app.get(
    "/api/local-runners/install.ps1",
    route(async (c) => {
      const b = getBundle();
      if (!b) return c.json({ error: "Runner bundle not available on this server" }, 404);
      return c.body(renderInstallPs1(origin, b), 200, {
        "content-type": "text/plain; charset=utf-8",
        "cache-control": "no-store",
      });
    }),
  );
  app.get(
    "/api/local-runners/runner/manifest.json",
    route(async (c) => {
      const b = getBundle();
      if (!b) return c.json({ error: "Runner bundle not available on this server" }, 404);
      return c.json({ version: b.version, files: b.files.map((f) => ({ name: f.name, path: f.path, sha256: f.sha256 })) });
    }),
  );
  app.get(
    "/api/local-runners/runner/files/:name",
    route(async (c) => {
      const f = getBundle()?.files.find((x) => x.name === c.req.param("name"));
      if (!f) return c.json({ error: "Not found" }, 404);
      return c.body(new Uint8Array(f.body), 200, {
        "content-type": f.name.endsWith(".json") ? "application/json" : "text/plain; charset=utf-8",
        "cache-control": "no-store",
        "x-content-sha256": f.sha256,
      });
    }),
  );

  // ---- owner routes ----
  app.get("/api/local-runners/config", async (c) =>
    c.json({ enabled: localRunnersUiEnabled(), maxDevices: MAX_DEVICES_PER_USER }),
  );

  app.get(
    "/api/local-runners/devices",
    route(async (c) => {
      const uid = await userId(c);
      const devices = await prisma.$queryRawUnsafe<DeviceRow[]>(
        `SELECT id, name, enabled, platform, runner_version, last_seen_at, created_at, paired_via
         FROM local_runner_devices WHERE user_id = $1 AND status = 'active' ORDER BY created_at`,
        uid,
      );
      const models = devices.length
        ? await prisma.$queryRawUnsafe<
            Array<{ device_id: string; model_id: string; advertised: boolean; enabled: boolean; context_window: number | null }>
          >(
            `SELECT device_id, model_id, advertised, enabled, context_window FROM local_runner_models
             WHERE device_id IN (SELECT id FROM local_runner_devices WHERE user_id = $1 AND status = 'active')
             ORDER BY model_id`,
            uid,
          )
        : [];
      const limitRows = devices.length
        ? await prisma.$queryRawUnsafe<Array<Record<string, unknown>>>(
            `SELECT * FROM local_runner_limits WHERE device_id = ANY($1::text[])`,
            devices.map((d) => d.id),
          )
        : [];
      const limitsOf = (id: string): DeviceLimits => limitsFromRow(limitRows.find((x) => x.device_id === id));
      return c.json({
        maxDevices: MAX_DEVICES_PER_USER,
        limitBounds: LIMIT_BOUNDS,
        devices: devices.map((d) => {
          const live = gateway.deviceInfo(d.id);
          return {
            id: d.id,
            name: d.name,
            enabled: d.enabled !== false,
            online: live.online,
            modelServer: live.modelServer,
            platform: d.platform,
            runnerVersion: d.runner_version,
            latestRunnerVersion: LATEST_RUNNER_VERSION,
            limits: limitsOf(d.id),
            updateAvailable: runnerUpdateAvailable(live.runnerVersion ?? d.runner_version),
            health: {
              report: live.health ?? null,
              inFlight: live.inFlight ?? 0,
              streaming: live.streaming ?? 0,
              queued: live.queued ?? 0,
              answers: live.answers ?? 0,
              lastAnswerAt: iso(live.lastAnswerAt),
              lastFailure: live.lastFailure ? { message: live.lastFailure.message, at: iso(live.lastFailure.at) } : null,
              lastDisconnect: live.lastDisconnect ? { reason: live.lastDisconnect.reason, at: iso(live.lastDisconnect.at) } : null,
            },
            lastSeenAt: d.last_seen_at ? new Date(d.last_seen_at).toISOString() : null,
            createdAt: new Date(d.created_at).toISOString(),
            legacy: d.paired_via !== "pairing",
            models: models
              .filter((m) => m.device_id === d.id)
              .map((m) => ({
                id: m.model_id,
                available: m.advertised,
                enabled: m.enabled,
                contextWindow: m.context_window,
              })),
          };
        }),
      });
    }),
  );

  app.post(
    "/api/local-runners/pairings",
    route(async (c) => {
      const uid = await userId(c);
      const body = await readBody(c);
      if ((await activeDeviceCount(uid)) >= MAX_DEVICES_PER_USER) throw new HttpError(409, DEVICE_LIMIT);
      return c.json(await createPairing(uid, { os: normalizeOs(body.os), deviceId: null }));
    }),
  );

  app.get(
    "/api/local-runners/pairings/:id",
    route(async (c) => {
      const uid = await userId(c);
      const rows = await prisma.$queryRawUnsafe<PairingRow[]>(
        `SELECT id, user_id, device_id, result_device_id, os, expires_at, used_at, cancelled_at
         FROM local_runner_pairings WHERE id = $1 AND user_id = $2`,
        c.req.param("id")!.slice(0, 64),
        uid,
      );
      const p = rows[0];
      if (!p) throw new HttpError(404, "Not found");
      let status: string;
      let device: { id: string; name: string; online: boolean; modelServer: string | null; models: string[] } | null =
        null;
      if (p.used_at && p.result_device_id) {
        const d = await prisma.$queryRawUnsafe<Array<{ id: string; name: string }>>(
          `SELECT id, name FROM local_runner_devices WHERE id = $1 AND user_id = $2 AND status = 'active'`,
          p.result_device_id,
          uid,
        );
        const live = gateway.deviceInfo(p.result_device_id);
        const models = await prisma.$queryRawUnsafe<Array<{ model_id: string }>>(
          `SELECT model_id FROM local_runner_models WHERE device_id = $1 AND advertised ORDER BY model_id`,
          p.result_device_id,
        );
        status = live.online ? "connected" : "paired";
        if (d[0]) {
          device = {
            id: d[0].id,
            name: d[0].name,
            online: live.online,
            modelServer: live.modelServer,
            models: models.map((m) => m.model_id),
          };
        }
      } else if (p.cancelled_at) status = "cancelled";
      else if (new Date(p.expires_at).getTime() <= Date.now()) status = "expired";
      else status = "pending";
      return c.json({ pairingId: p.id, status, expiresAt: new Date(p.expires_at).toISOString(), device });
    }),
  );

  app.post(
    "/api/local-runners/pairings/:id/cancel",
    route(async (c) => {
      const uid = await userId(c);
      await readBody(c);
      const id = c.req.param("id")!.slice(0, 64);
      const owned = await prisma.$queryRawUnsafe<Array<{ id: string }>>(
        `SELECT id FROM local_runner_pairings WHERE id = $1 AND user_id = $2`,
        id,
        uid,
      );
      if (!owned.length) throw new HttpError(404, "Not found");
      await prisma.$executeRawUnsafe(
        `UPDATE local_runner_pairings SET cancelled_at = NOW()
         WHERE id = $1 AND user_id = $2 AND used_at IS NULL AND cancelled_at IS NULL`,
        id,
        uid,
      );
      return c.json({ ok: true });
    }),
  );

  app.post(
    "/api/local-runners/devices/:id",
    route(async (c) => {
      const uid = await userId(c);
      const device = await ownedDevice(uid, c.req.param("id")!);
      const body = await readBody(c);
      const name = body.name === undefined ? undefined : sanitizeDeviceName(body.name, "");
      if (name === "") throw new HttpError(400, "Enter a name");
      if (body.enabled !== undefined && typeof body.enabled !== "boolean") {
        throw new HttpError(400, "Invalid request");
      }
      await prisma.$executeRawUnsafe(
        `UPDATE local_runner_devices SET name = COALESCE($3, name), enabled = COALESCE($4, enabled), updated_at = NOW()
         WHERE id = $1 AND user_id = $2 AND status = 'active'`,
        device.id,
        uid,
        name ?? null,
        typeof body.enabled === "boolean" ? body.enabled : null,
      );
      await gateway.refreshDevice(device.id);
      return c.json({ ok: true });
    }),
  );

  app.post(
    "/api/local-runners/devices/:id/models",
    route(async (c) => {
      const uid = await userId(c);
      const device = await ownedDevice(uid, c.req.param("id")!);
      const body = await readBody(c);
      if (typeof body.modelId !== "string" || typeof body.enabled !== "boolean") {
        throw new HttpError(400, "Choose a model and on/off");
      }
      const updated = await prisma.$executeRawUnsafe(
        `UPDATE local_runner_models SET enabled = $3 WHERE device_id = $1 AND model_id = $2`,
        device.id,
        body.modelId.slice(0, 200),
        body.enabled,
      );
      if (!updated) throw new HttpError(404, "Not found");
      await gateway.refreshDevice(device.id);
      return c.json({ ok: true });
    }),
  );

  app.post(
    "/api/local-runners/devices/:id/rotate",
    route(async (c) => {
      const uid = await userId(c);
      const device = await ownedDevice(uid, c.req.param("id")!);
      const body = await readBody(c);
      // The old key stops working now; the computer is offline until it pairs again.
      await prisma.$executeRawUnsafe(
        `UPDATE local_runner_devices SET token_hash = $3, rotated_at = NOW(), updated_at = NOW()
         WHERE id = $1 AND user_id = $2 AND status = 'active'`,
        device.id,
        uid,
        deadHash("rotated"),
      );
      gateway.disconnectDevice(device.id, "rotated");
      return c.json(await createPairing(uid, { os: normalizeOs(body.os), deviceId: device.id }));
    }),
  );

  app.post(
    "/api/local-runners/devices/:id/check",
    route(async (c) => {
      const uid = await userId(c);
      const device = await ownedDevice(uid, c.req.param("id")!);
      await readBody(c);
      const result = await gateway.checkDevice(device.id);
      if (!result.online) return c.json({ online: false, checkedAt: new Date().toISOString() });
      if (!result.supported) {
        return c.json({ online: true, supported: false, runnerVersion: result.runnerVersion, latestRunnerVersion: LATEST_RUNNER_VERSION, checkedAt: new Date().toISOString() });
      }
      return c.json({ online: true, supported: true, health: result.health, checkedAt: new Date().toISOString() });
    }),
  );

  app.post(
    "/api/local-runners/devices/:id/limits",
    route(async (c) => {
      const uid = await userId(c);
      const device = await ownedDevice(uid, c.req.param("id")!);
      const body = await readBody(c);
      const rows = await prisma.$queryRawUnsafe<Array<Record<string, unknown>>>(
        `SELECT * FROM local_runner_limits WHERE device_id = $1`,
        device.id,
      );
      const current = limitsFromRow(rows[0]);
      const next = normalizeLimits(body, current);
      if (typeof next === "string") return c.json({ error: next }, 400);
      await prisma.$executeRawUnsafe(
        `INSERT INTO local_runner_limits (device_id, max_concurrent, per_user_per_minute, daily_request_cap, person_daily_cap, daily_token_cap, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, NOW())
         ON CONFLICT (device_id) DO UPDATE SET max_concurrent = $2, per_user_per_minute = $3, daily_request_cap = $4,
           person_daily_cap = $5, daily_token_cap = $6, updated_at = NOW()`,
        device.id,
        next.maxConcurrent,
        next.perUserPerMinute,
        next.dailyRequestCap,
        next.personDailyCap,
        next.dailyTokenCap,
      );
      gateway.invalidateLimits(device.id);
      return c.json({ ok: true, limits: next });
    }),
  );

  app.get(
    "/api/local-runners/usage",
    route(async (c) => {
      const uid = await userId(c);
      await ensureLocalRunnerTables(prisma);
      const days = Math.min(90, Math.max(1, Number.parseInt(c.req.query("days") ?? "14", 10) || 14));
      const daily = await prisma.$queryRawUnsafe<Array<{ day: string; device_id: string; requests: number; refused: number; input_tokens: number; output_tokens: number; peer_requests: number }>>(
        `SELECT to_char(day, 'YYYY-MM-DD') AS day, device_id,
                COALESCE(SUM(n) FILTER (WHERE status NOT LIKE 'refused_%'), 0)::int AS requests,
                COALESCE(SUM(n) FILTER (WHERE status LIKE 'refused_%'), 0)::int AS refused,
                COALESCE(SUM(input_tokens), 0)::int AS input_tokens,
                COALESCE(SUM(output_tokens), 0)::int AS output_tokens,
                COALESCE(SUM(n) FILTER (WHERE status NOT LIKE 'refused_%' AND consumer_user_id IS DISTINCT FROM owner_user_id), 0)::int AS peer_requests
           FROM ${USAGE_ROWS_SQL} AS u
          WHERE owner_user_id = $1 AND day >= (date_trunc('day', NOW()) - ($2::int - 1) * INTERVAL '1 day')::date
          GROUP BY 1, 2 ORDER BY 1, 2`,
        uid,
        days,
      );
      const people = await prisma.$queryRawUnsafe<Array<{ user_id: string | null; name: string | null; requests: number; refused: number; tokens: number }>>(
        `SELECT u.consumer_user_id AS user_id, us.name,
                COALESCE(SUM(u.n) FILTER (WHERE u.status NOT LIKE 'refused_%'), 0)::int AS requests,
                COALESCE(SUM(u.n) FILTER (WHERE u.status LIKE 'refused_%'), 0)::int AS refused,
                COALESCE(SUM(u.input_tokens + u.output_tokens), 0)::int AS tokens
           FROM ${USAGE_ROWS_SQL} AS u LEFT JOIN "user" us ON us.id = u.consumer_user_id
          WHERE u.owner_user_id = $1 AND u.day >= (date_trunc('day', NOW()) - ($2::int - 1) * INTERVAL '1 day')::date
          GROUP BY 1, 2 ORDER BY requests DESC LIMIT 20`,
        uid,
        days,
      );
      return c.json({
        days,
        daily: daily.map((r) => ({ day: r.day, deviceId: r.device_id, requests: r.requests, refused: r.refused, inputTokens: r.input_tokens, outputTokens: r.output_tokens, peerRequests: r.peer_requests })),
        people: people.map((p) => ({ you: p.user_id === uid, name: p.user_id === uid ? "You" : p.name || "Someone", requests: p.requests, refused: p.refused, tokens: p.tokens })),
      });
    }),
  );

  app.get(
    "/api/local-runners/usage.csv",
    route(async (c) => {
      const uid = await userId(c);
      const range = parseUsageExportRange(c.req.query("from") || undefined, c.req.query("to") || undefined);
      if (!range.ok) return c.json({ error: range.error }, 400);
      await ensureLocalRunnerTables(prisma);
      const rows = await queryUsageExport(prisma, uid, range);
      if (rows.length > USAGE_EXPORT_MAX_ROWS) return c.json({ error: "Too many rows: pick a shorter date range" }, 413);
      return new Response(usageCsv(rows, uid), {
        status: 200,
        headers: {
          "content-type": "text/csv; charset=utf-8",
          "content-disposition": `attachment; filename="rakijazios-usage-${range.from}_${range.to}.csv"`,
          "cache-control": "no-store",
          "x-content-type-options": "nosniff",
        },
      });
    }),
  );

  app.post(
    "/api/local-runners/devices/:id/revoke",
    route(async (c) => {
      const uid = await userId(c);
      const device = await ownedDevice(uid, c.req.param("id")!);
      await readBody(c);
      await prisma.$executeRawUnsafe(
        `UPDATE local_runner_devices SET status = 'revoked', enabled = false, token_hash = $3,
           revoked_at = NOW(), updated_at = NOW()
         WHERE id = $1 AND user_id = $2 AND status = 'active'`,
        device.id,
        uid,
        deadHash("revoked"),
      );
      await prisma.$executeRawUnsafe(
        `UPDATE local_runner_pairings SET cancelled_at = NOW()
         WHERE device_id = $1 AND used_at IS NULL AND cancelled_at IS NULL`,
        device.id,
      );
      gateway.disconnectDevice(device.id, "revoked");
      return c.json({ ok: true });
    }),
  );

  // ---- M2b: "On my computer" — bind a bot to one computer + model ----
  type BotRow = {
    id: string;
    name: string;
    model_provider: string | null;
    model_id: string | null;
    device_id: string | null;
    bound_model_id: string | null;
  };

  async function ownerBots(uid: string, botId?: string): Promise<BotRow[]> {
    return prisma.$queryRawUnsafe<BotRow[]>(
      `SELECT b.id, b.name, b."modelProvider" AS model_provider, b."modelId" AS model_id,
              bb.device_id, bb.model_id AS bound_model_id
         FROM bots b LEFT JOIN local_runner_bot_bindings bb ON bb.bot_id = b.id
        WHERE b."userId" = $1 AND b."archivedAt" IS NULL AND ($2::text IS NULL OR b.id = $2)
        ORDER BY b.name`,
      uid,
      botId ?? null,
    );
  }

  function botView(b: BotRow) {
    const shared = b.model_provider === "shared-local";
    return {
      id: b.id,
      name: b.name,
      onMyComputer: shared,
      deviceId: b.device_id,
      modelId: shared ? b.model_id : null,
      // Shared-local but no binding (owner has several computers) or a stale one.
      needsSetup: shared && (!b.device_id || b.bound_model_id !== b.model_id),
    };
  }

  /** Models the owner switched on, per active computer, with live availability. */
  app.get(
    "/api/local-runners/offered-models",
    route(async (c) => {
      const uid = await userId(c);
      const rows = await prisma.$queryRawUnsafe<
        Array<{ device_id: string; name: string; enabled: boolean; model_id: string; context_window: number | null }>
      >(
        `SELECT d.id AS device_id, d.name, d.enabled, m.model_id, m.context_window
           FROM local_runner_devices d JOIN local_runner_models m ON m.device_id = d.id
          WHERE d.user_id = $1 AND d.status = 'active' AND m.enabled
          ORDER BY d.created_at, m.model_id`,
        uid,
      );
      const devices = new Map<string, { id: string; name: string; online: boolean; paused: boolean; models: unknown[] }>();
      for (const r of rows) {
        let d = devices.get(r.device_id);
        if (!d) {
          d = { id: r.device_id, name: r.name, online: gateway.deviceInfo(r.device_id).online, paused: r.enabled === false, models: [] };
          devices.set(r.device_id, d);
        }
        d.models.push({
          id: r.model_id,
          contextWindow: r.context_window,
          availableNow: gateway.offeredModels(r.device_id).includes(r.model_id),
        });
      }
      return c.json({ devices: [...devices.values()] });
    }),
  );

  app.get(
    "/api/local-runners/bots",
    route(async (c) => {
      const uid = await userId(c);
      return c.json({ bots: (await ownerBots(uid)).map(botView) });
    }),
  );

  app.get(
    "/api/local-runners/bots/:botId",
    route(async (c) => {
      const uid = await userId(c);
      const bot = (await ownerBots(uid, c.req.param("botId")!.slice(0, 64)))[0];
      if (!bot) throw new HttpError(404, "Not found");
      return c.json(botView(bot));
    }),
  );

  app.post(
    "/api/local-runners/bots/:botId/model",
    route(async (c) => {
      const uid = await userId(c);
      const bot = (await ownerBots(uid, c.req.param("botId")!.slice(0, 64)))[0];
      if (!bot) throw new HttpError(404, "Not found");
      const body = await readBody(c);
      if (body.clear === true) {
        await prisma.$executeRawUnsafe(`DELETE FROM local_runner_bot_bindings WHERE bot_id = $1`, bot.id);
        // Back to the space default model; never to someone else's key.
        await prisma.$executeRawUnsafe(
          `UPDATE bots SET "modelProvider" = NULL, "modelId" = NULL, "updatedAt" = NOW()
            WHERE id = $1 AND "userId" = $2 AND "modelProvider" = 'shared-local'`,
          bot.id,
          uid,
        );
        return c.json(botView((await ownerBots(uid, bot.id))[0]!));
      }
      const deviceId = typeof body.deviceId === "string" ? body.deviceId : "";
      const modelId = typeof body.modelId === "string" ? body.modelId.trim() : "";
      if (!deviceId || !modelId || modelId.length > 200) throw new HttpError(400, "Pick a computer and a model.");
      const device = await ownedDevice(uid, deviceId);
      const model = await prisma.$queryRawUnsafe<Array<{ enabled: boolean }>>(
        `SELECT enabled FROM local_runner_models WHERE device_id = $1 AND model_id = $2`,
        device.id,
        modelId,
      );
      if (!model[0]?.enabled) {
        throw new HttpError(409, "Switch this model on for that computer first (My hardware).");
      }
      await prisma.$executeRawUnsafe(
        `INSERT INTO local_runner_bot_bindings (bot_id, user_id, device_id, model_id)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (bot_id) DO UPDATE SET device_id = EXCLUDED.device_id, model_id = EXCLUDED.model_id,
           user_id = EXCLUDED.user_id, updated_at = NOW()`,
        bot.id,
        uid,
        device.id,
        modelId,
      );
      await prisma.$executeRawUnsafe(
        `UPDATE bots SET "modelProvider" = 'shared-local', "modelId" = $3, "updatedAt" = NOW()
          WHERE id = $1 AND "userId" = $2`,
        bot.id,
        uid,
        modelId,
      );
      return c.json(botView((await ownerBots(uid, bot.id))[0]!));
    }),
  );

  // ---- M2c: group grants (owner of the group AND the bot) + transparency ----
  async function ownedGroup(uid: string, groupId: string): Promise<{ id: string }> {
    const rows = await prisma.$queryRawUnsafe<Array<{ id: string }>>(
      `SELECT id FROM chat_groups WHERE id = $1 AND "userId" = $2 AND "archivedAt" IS NULL`,
      groupId.slice(0, 64),
      uid,
    );
    if (!rows[0]) throw new HttpError(404, "Not found");
    return rows[0];
  }

  type GroupBotRow = {
    bot_id: string;
    name: string;
    owner_user_id: string;
    owner_name: string | null;
    device_id: string | null;
    granted: boolean;
  };

  /** Bots of this group that run on their owner's computer. */
  async function groupLocalBots(groupId: string): Promise<GroupBotRow[]> {
    return prisma.$queryRawUnsafe<GroupBotRow[]>(
      `SELECT b.id AS bot_id, b.name, b."userId" AS owner_user_id, u.name AS owner_name, bb.device_id,
              EXISTS (SELECT 1 FROM local_runner_grants g
                       WHERE g.bot_id = b.id AND g.group_id = cg.id AND g.owner_user_id = cg."userId") AS granted
         FROM chat_groups cg
         JOIN chat_group_members m ON m."groupId" = cg.id
         JOIN bots b ON b.id = m."botId" AND b."archivedAt" IS NULL
         JOIN "user" u ON u.id = b."userId"
         LEFT JOIN local_runner_bot_bindings bb ON bb.bot_id = b.id
        WHERE cg.id = $1 AND b."modelProvider" = 'shared-local' AND b."userId" = cg."userId"
        ORDER BY b.name`,
      groupId,
    );
  }

  app.get(
    "/api/local-runners/groups/:groupId/grants",
    route(async (c) => {
      const uid = await userId(c);
      const group = await ownedGroup(uid, c.req.param("groupId")!);
      const shares = await prisma.$queryRawUnsafe<Array<{ n: number }>>(
        `SELECT COUNT(*)::int AS n FROM group_shares WHERE group_id = $1`,
        group.id,
      );
      const bots = await groupLocalBots(group.id);
      return c.json({
        shared: (shares[0]?.n ?? 0) > 0,
        bots: bots.map((b) => ({ botId: b.bot_id, name: b.name, granted: b.granted, online: b.device_id ? gateway.deviceInfo(b.device_id).online : false })),
      });
    }),
  );

  app.post(
    "/api/local-runners/groups/:groupId/grants",
    route(async (c) => {
      const uid = await userId(c);
      const group = await ownedGroup(uid, c.req.param("groupId")!);
      const body = await readBody(c);
      const botId = typeof body.botId === "string" ? body.botId.slice(0, 64) : "";
      if (typeof body.allowed !== "boolean" || !botId) throw new HttpError(400, "botId and allowed are required");
      const bot = (await groupLocalBots(group.id)).find((b) => b.bot_id === botId);
      if (!bot) throw new HttpError(404, "Not found");
      let cancelled = 0;
      if (body.allowed) {
        await prisma.$executeRawUnsafe(
          `INSERT INTO local_runner_grants (bot_id, group_id, owner_user_id) VALUES ($1, $2, $3)
           ON CONFLICT (bot_id, group_id) DO UPDATE SET owner_user_id = EXCLUDED.owner_user_id`,
          bot.bot_id,
          group.id,
          uid,
        );
      } else {
        await prisma.$executeRawUnsafe(
          `DELETE FROM local_runner_grants WHERE bot_id = $1 AND group_id = $2`,
          bot.bot_id,
          group.id,
        );
        // Takes effect at once: answers in progress stop, and the gateway refuses the next turn.
        cancelled = gateway.cancelBotInGroup(bot.bot_id, group.id);
      }
      return c.json({ botId: bot.bot_id, granted: body.allowed, cancelled });
    }),
  );

  /**
   * Members' view: which bots in this group run on someone's computer, and whether it is
   * online. Owner name only — never device names, hostnames or addresses.
   */
  app.get(
    "/api/local-runners/groups/:groupId/runs-on",
    route(async (c) => {
      const uid = await userId(c);
      const groupId = c.req.param("groupId")!.slice(0, 64);
      const access = await prisma.$queryRawUnsafe<Array<{ ok: boolean }>>(
        `SELECT TRUE AS ok FROM chat_groups cg
          WHERE cg.id = $1 AND cg."archivedAt" IS NULL
            AND (cg."userId" = $2 OR EXISTS (SELECT 1 FROM group_shares s WHERE s.group_id = cg.id AND s.user_id = $2))`,
        groupId,
        uid,
      );
      if (!access[0]) throw new HttpError(404, "Not found");
      const bots = await groupLocalBots(groupId);
      return c.json({
        bots: bots.map((b) => ({
          botId: b.bot_id,
          name: b.name,
          runsOn: `${b.owner_name?.trim() || "its owner"}'s computer`,
          online: b.device_id ? gateway.deviceInfo(b.device_id).online : false,
          enabledHere: b.granted,
        })),
      });
    }),
  );

  function parseDeviceCredentials(raw: unknown): { deviceId: string; token: string } | null {
    if (!raw || typeof raw !== "object") return null;
    const r = raw as { deviceId?: unknown; token?: unknown };
    if (typeof r.deviceId !== "string" || typeof r.token !== "string") return null;
    if (!r.deviceId || r.deviceId.length > 64 || !r.token || r.token.length > 256) return null;
    return { deviceId: r.deviceId, token: r.token };
  }

  // ---- runner: redeem a one-time code ----
  app.post(
    "/api/local-runners/pair",
    route(async (c) => {
      // The web proxy appends the real client address last; earlier entries are client-supplied.
      const client = c.req.header("x-forwarded-for")?.split(",").pop()?.trim() || "direct";
      if (perClient.blocked(client) || global.blocked("all")) {
        throw new HttpError(429, "Too many attempts. Wait a few minutes and try again.");
      }
      const fail = (): never => {
        perClient.fail(client);
        global.fail("all");
        throw new HttpError(400, BAD_CODE);
      };
      const body = await readBody(c);
      const code = normalizePairingCode(body.code);
      if (!code) fail();

      // Keep an existing install ("adopt"): the runner on this computer already holds a
      // valid key for one of this user's computers. The code is consumed (so the dialog
      // shows "connected") but no new key is issued and nothing is overwritten. Every
      // refusal leaves the code unused so the user can re-run with --replace.
      const adopt = parseDeviceCredentials(body.adopt);
      if (adopt) {
        const open = await prisma.$queryRawUnsafe<PairingRow[]>(
          `SELECT id, user_id, device_id, result_device_id, os, expires_at, used_at, cancelled_at
             FROM local_runner_pairings
            WHERE code_hash = $1 AND used_at IS NULL AND cancelled_at IS NULL AND expires_at > NOW()`,
          hashPairingCode(code!),
        );
        const pending = open[0];
        if (!pending) return fail();
        const rows = await prisma.$queryRawUnsafe<Array<{ id: string; user_id: string; name: string; status: string; token_hash: string }>>(
          `SELECT id, user_id, name, status, token_hash FROM local_runner_devices WHERE id = $1`,
          adopt.deviceId,
        );
        const dev = rows[0];
        if (!dev) {
          throw new HttpError(409, "The key stored on this computer is not known to this server.", "unknown");
        }
        if (dev.user_id !== pending.user_id) {
          throw new HttpError(409, "This computer is connected to a different Rakijazios account.", "other_account");
        }
        if (pending.device_id && pending.device_id !== dev.id) {
          throw new HttpError(409, "This code is for a different computer than the one this runner is connected as.", "other_device");
        }
        const presented = Buffer.from(hashDeviceToken(adopt.token));
        const stored = Buffer.from(dev.token_hash);
        const keyOk = dev.status === "active" && presented.length === stored.length && timingSafeEqual(presented, stored);
        if (keyOk) {
          const taken = await prisma.$queryRawUnsafe<Array<{ id: string }>>(
            `UPDATE local_runner_pairings SET used_at = NOW(), result_device_id = $2
              WHERE id = $1 AND used_at IS NULL AND cancelled_at IS NULL AND expires_at > NOW()
              RETURNING id`,
            pending.id,
            dev.id,
          );
          if (!taken.length) return fail();
          await prisma.$executeRawUnsafe(
            `UPDATE local_runner_devices SET platform = COALESCE($2, platform),
               runner_version = COALESCE($3, runner_version), updated_at = NOW() WHERE id = $1`,
            dev.id,
            sanitizeShort(body.platform, 40),
            sanitizeShort(body.runnerVersion),
          );
          return c.json({ deviceId: dev.id, name: dev.name, adopted: true });
        }
        // Dead key (removed, or given a new key). With a plain "Add" code the runner pairs
        // again as a new computer; a "New key" code for this very computer re-keys it below.
        if (!pending.device_id) {
          throw new HttpError(409, "The key stored on this computer no longer works.", "inactive");
        }
      }

      // Single use, atomically: only one request can claim a code.
      const claimed = await prisma.$queryRawUnsafe<PairingRow[]>(
        `UPDATE local_runner_pairings SET used_at = NOW()
         WHERE code_hash = $1 AND used_at IS NULL AND cancelled_at IS NULL AND expires_at > NOW()
         RETURNING id, user_id, device_id, result_device_id, os, expires_at, used_at, cancelled_at`,
        hashPairingCode(code!),
      );
      const pairing = claimed[0];
      if (!pairing) return fail();
      const uid = pairing.user_id;
      const name = sanitizeDeviceName(body.name);
      const platform = sanitizeShort(body.platform, 40);
      const runnerVersion = sanitizeShort(body.runnerVersion);
      const token = newToken();
      const tokenHash = hashDeviceToken(token);

      // Re-key an existing computer: a "new key" code is bound to it, or the runner
      // proves it already holds a valid key for one of this user's computers.
      let deviceId: string | null = pairing.device_id;
      if (!deviceId && body.existing && typeof body.existing === "object") {
        const ex = body.existing as { deviceId?: unknown; token?: unknown };
        if (typeof ex.deviceId === "string" && typeof ex.token === "string") {
          const rows = await prisma.$queryRawUnsafe<Array<{ id: string }>>(
            `SELECT id FROM local_runner_devices
             WHERE id = $1 AND user_id = $2 AND status = 'active' AND token_hash = $3`,
            ex.deviceId.slice(0, 64),
            uid,
            hashDeviceToken(ex.token.slice(0, 256)),
          );
          deviceId = rows[0]?.id ?? null;
        }
      }
      let reused = false;
      if (deviceId) {
        const n = await prisma.$executeRawUnsafe(
          `UPDATE local_runner_devices SET token_hash = $3, platform = COALESCE($4, platform),
             runner_version = COALESCE($5, runner_version), rotated_at = NOW(), updated_at = NOW()
           WHERE id = $1 AND user_id = $2 AND status = 'active'`,
          deviceId,
          uid,
          tokenHash,
          platform,
          runnerVersion,
        );
        if (!n) throw new HttpError(409, "That computer was removed. Add it again as a new computer.");
        reused = true;
        // An older runner on that computer still holds the previous key: stop it.
        gateway.disconnectDevice(deviceId, "rotated");
      } else {
        if ((await activeDeviceCount(uid)) >= MAX_DEVICES_PER_USER) throw new HttpError(409, DEVICE_LIMIT);
        deviceId = randomUUID().replace(/-/g, "").slice(0, 24);
        await prisma.$executeRawUnsafe(
          `INSERT INTO local_runner_devices (id, user_id, name, token_hash, status, platform, runner_version, paired_via, updated_at)
           VALUES ($1, $2, $3, $4, 'active', $5, $6, 'pairing', NOW())`,
          deviceId,
          uid,
          name,
          tokenHash,
          platform,
          runnerVersion,
        );
      }
      await prisma.$executeRawUnsafe(
        `UPDATE local_runner_pairings SET result_device_id = $2 WHERE id = $1`,
        pairing.id,
        deviceId,
      );
      const finalName = (
        await prisma.$queryRawUnsafe<Array<{ name: string }>>(
          `SELECT name FROM local_runner_devices WHERE id = $1`,
          deviceId,
        )
      )[0]?.name;
      return c.json({ deviceId, token, gatewayWsUrl: wsUrl(), name: finalName ?? name, reused });
    }),
  );
}
