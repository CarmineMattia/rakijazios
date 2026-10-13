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
import { ensureLocalRunnerTables } from "./local-runners.js";
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
      return c.json({
        maxDevices: MAX_DEVICES_PER_USER,
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
