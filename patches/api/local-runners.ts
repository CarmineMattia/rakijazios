/**
 * Local-runner gateway: WebSocket session manager + OpenAI-compatible HTTP proxy
 * that forwards chat completions to the owner's connected runner.
 *
 * M1: one runner per owner, seeded by CLI.
 * M2a: several computers per owner (one live session per device), advertised
 * models stored in local_runner_models with an owner on/off switch, a per-device
 * pause switch, `policy` pushed on every change and `bye` on revoke/rotate.
 * M2b: each shared-local bot is bound to one computer + model
 * (local_runner_bot_bindings). The gateway takes a run-bound token and re-checks
 * run, bot, binding, computer, model and group on every request, then routes to
 * the bound computer only.
 * M2c: a bot may answer in a shared group only with a grant (local_runner_grants)
 * from the owner of both; revoking a grant cancels its in-flight answers.
 */
import { readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import type { Server as HttpServer, IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import type { PrismaClient } from "@rakazo/db";
import type { Hono } from "hono";
import {
  hashDeviceToken,
  sharedLocalModelIds,
  verifySharedLocalRunToken,
} from "./shared-local-token.js";
import {
  decideSharedLocalAccess,
  type SharedLocalAccess,
  type SharedLocalAccessRow,
  MAX_MODELS_PER_DEVICE,
  sanitizeAdvertisedModels,
  sanitizeShort,
  type AdvertisedModel,
} from "./local-runner-pairing.js";

type WsModule = {
  WebSocketServer: new (opts: { noServer: boolean; maxPayload?: number }) => {
    handleUpgrade: (
      req: IncomingMessage,
      socket: Duplex,
      head: Buffer,
      cb: (ws: WsSocket) => void,
    ) => void;
    emit: (event: string, ...args: unknown[]) => boolean;
  };
  WebSocket: { OPEN: number };
};

type WsSocket = {
  readyState: number;
  send: (data: string) => void;
  close: (code?: number, reason?: string) => void;
  on: (event: string, cb: (...args: unknown[]) => void) => void;
};

/**
 * `ws` ships in the image (transitively) but is not a declared dependency of
 * @rakazo/api, so plain `import "ws"` does not resolve under pnpm. Load the
 * newest ws@8 from the store instead of hand-rolling RFC 6455 framing.
 */
function loadWs(): WsModule {
  const store = "/app/node_modules/.pnpm";
  const dir = readdirSync(store)
    .filter((name) => /^ws@8\.\d+\.\d+$/.test(name))
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
    .pop();
  if (!dir) throw new Error("ws@8 not found in the image's pnpm store");
  const require = createRequire(`${store}/${dir}/node_modules/ws/package.json`);
  return require(".") as WsModule;
}

const HEARTBEAT_MISS_MS = 45_000;
/**
 * M2b long runs: an answer may stream for up to HARD_TIMEOUT_MS as long as tokens
 * keep coming; IDLE_TIMEOUT_MS without a single chunk ends it (model stuck or
 * runner wedged). Big local models can take minutes before the first token.
 */
const HARD_TIMEOUT_MS = 30 * 60_000;
const IDLE_TIMEOUT_MS = 5 * 60_000;
/** How often in-flight answers are checked against their run (cancelled/finished runs stop). */
const RUN_SWEEP_MS = 10_000;
const MAX_IN_FLIGHT = 2;

/** M3: owner limits for one computer. Rate and daily cap apply to other people, not the owner. */
export type DeviceLimits = {
  maxConcurrent: number;
  perUserPerMinute: number;
  /** Requests per day from all other people together. */
  dailyRequestCap: number | null;
  /** M3b: requests per day from each other person. */
  personDailyCap: number | null;
  /** M3b: tokens (in + out) per day from all other people together. */
  dailyTokenCap: number | null;
};
export const DEFAULT_LIMITS: DeviceLimits = {
  maxConcurrent: MAX_IN_FLIGHT,
  perUserPerMinute: 20,
  dailyRequestCap: null,
  personDailyCap: null,
  dailyTokenCap: null,
};
export const LIMIT_BOUNDS = {
  maxConcurrent: [1, 8],
  perUserPerMinute: [1, 600],
  dailyRequestCap: [1, 100_000],
  personDailyCap: [1, 100_000],
  dailyTokenCap: [1_000, 1_000_000_000],
} as const;
type LimitKey = keyof typeof LIMIT_BOUNDS;
const NULLABLE_LIMITS = new Set<LimitKey>(["dailyRequestCap", "personDailyCap", "dailyTokenCap"]);

/** Row from local_runner_limits → DeviceLimits (missing row = defaults). */
export function limitsFromRow(r: Record<string, unknown> | undefined): DeviceLimits {
  if (!r) return DEFAULT_LIMITS;
  const n = (v: unknown) => (v === null || v === undefined ? null : Number(v));
  return {
    maxConcurrent: Number(r.max_concurrent),
    perUserPerMinute: Number(r.per_user_per_minute),
    dailyRequestCap: n(r.daily_request_cap),
    personDailyCap: n(r.person_daily_cap),
    dailyTokenCap: n(r.daily_token_cap),
  };
}

/** Validates an owner's limits update; returns an error message or the new limits. */
export function normalizeLimits(input: unknown, current: DeviceLimits = DEFAULT_LIMITS): DeviceLimits | string {
  const body = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  const out = { ...current };
  const int = (key: LimitKey, label: string): string | null => {
    if (!(key in body)) return null;
    const v = body[key];
    if (NULLABLE_LIMITS.has(key) && (v === null || v === "")) {
      (out as Record<LimitKey, number | null>)[key] = null;
      return null;
    }
    const [min, max] = LIMIT_BOUNDS[key];
    if (typeof v !== "number" || !Number.isInteger(v) || v < min || v > max) return `${label} must be a whole number from ${min} to ${max}`;
    (out as Record<LimitKey, number | null>)[key] = v;
    return null;
  };
  return (
    int("maxConcurrent", "Answers at the same time") ??
    int("perUserPerMinute", "Requests per person per minute") ??
    int("dailyRequestCap", "Daily requests from other people") ??
    int("personDailyCap", "Daily requests per person") ??
    int("dailyTokenCap", "Daily tokens from other people") ??
    out
  );
}

export type LimitRefusal = "busy" | "rate_limited" | "daily_cap" | "person_cap";

/** M3b: how long a request may wait for a free slot, and how many may wait per computer. */
export const QUEUE_WAIT_MS = 60_000;
export const QUEUE_MAX = 8;

/**
 * M3b: first-come-first-served wait for a free answer slot on one computer.
 * `free()` says whether a slot is free right now; the caller must take the slot
 * synchronously after `"ok"` (no await in between), so two waiters never share one.
 */
export class SlotQueue {
  private readonly queues = new Map<string, object[]>();
  constructor(
    private readonly opts: { waitMs: number; max: number; pollMs?: number } = { waitMs: QUEUE_WAIT_MS, max: QUEUE_MAX },
  ) {}

  waiting(key: string): number {
    return this.queues.get(key)?.length ?? 0;
  }

  async acquire(key: string, free: () => boolean | "gone", signal?: AbortSignal): Promise<"ok" | "busy" | "gone" | "aborted"> {
    const q = this.queues.get(key) ?? [];
    const first = free();
    if (first === "gone") return "gone";
    if (!q.length && first) return "ok";
    if (q.length >= this.opts.max) return "busy";
    const ticket = {};
    q.push(ticket);
    this.queues.set(key, q);
    const leave = () => {
      const i = q.indexOf(ticket);
      if (i >= 0) q.splice(i, 1);
      if (!q.length) this.queues.delete(key);
    };
    const deadline = Date.now() + this.opts.waitMs;
    const poll = this.opts.pollMs ?? 200;
    for (;;) {
      if (signal?.aborted) {
        leave();
        return "aborted";
      }
      const f = free();
      if (f === "gone") {
        leave();
        return "gone";
      }
      if (f && q[0] === ticket) {
        leave();
        return "ok";
      }
      if (Date.now() >= deadline) {
        leave();
        return "busy";
      }
      await new Promise((r) => setTimeout(r, poll));
    }
  }
}

/** Pure M3 decision: may one more request start on this computer now? */
export function decideLimit(input: {
  limits: DeviceLimits;
  inFlight: number;
  isOwner: boolean;
  /** This person's requests on this computer in the last 60 s. */
  recentRequests: number;
  /** Requests from people other than the owner on this computer today. */
  todayPeerRequests: number;
  /** M3b: this person's requests on this computer today. */
  todayPersonRequests?: number;
  /** M3b: tokens used by other people on this computer today. */
  todayPeerTokens?: number;
}): LimitRefusal | null {
  if (input.inFlight >= input.limits.maxConcurrent) return "busy";
  if (input.isOwner) return null;
  if (input.recentRequests >= input.limits.perUserPerMinute) return "rate_limited";
  if (input.limits.personDailyCap != null && (input.todayPersonRequests ?? 0) >= input.limits.personDailyCap) return "person_cap";
  if (input.limits.dailyRequestCap != null && input.todayPeerRequests >= input.limits.dailyRequestCap) return "daily_cap";
  if (input.limits.dailyTokenCap != null && (input.todayPeerTokens ?? 0) >= input.limits.dailyTokenCap) return "daily_cap";
  return null;
}

/** OpenAI-style usage from a streamed SSE line (`data: {..."usage":{...}}`), if any. */
export function usageFromSseLine(line: string): { input: number; output: number } | null {
  if (!line.startsWith("data:") || !line.includes('"usage"')) return null;
  try {
    const u = (JSON.parse(line.slice(5).trim()) as { usage?: { prompt_tokens?: unknown; completion_tokens?: unknown } }).usage;
    if (!u) return null;
    const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.round(v) : 0);
    return { input: n(u.prompt_tokens), output: n(u.completion_tokens) };
  } catch {
    return null;
  }
}
const OFFLINE_MESSAGE =
  "This bot runs on the owner's computer, which is offline right now. Try again later.";

type DeviceRow = {
  id: string;
  user_id: string;
  name: string;
  token_hash: string;
  status: string;
  enabled: boolean;
  paired_via: string | null;
};

/** Frames from runners are small (SSE lines); hello/models lists are bounded too. */
const MAX_FRAME_BYTES = 1024 * 1024;
const FAILED_HELLO_LIMIT = 20;
const FAILED_HELLO_WINDOW_MS = 60_000;

type PendingInfer = {
  id: string;
  ownerUserId: string;
  runId: string;
  botId: string;
  groupId: string | null;
  lastChunkAt: number;
  chunks: string[];
  /** At least one token arrived (the answer is streaming). */
  streamed?: boolean;
  /** M3 usage accounting. */
  deviceId?: string;
  consumerUserId?: string;
  model?: string;
  startedAt?: number;
  usage?: { input: number; output: number };
  status?: number;
  error?: { message: string; retryable: boolean };
  done: boolean;
  waiters: Array<() => void>;
  hardTimer: ReturnType<typeof setTimeout>;
};

type RunnerSession = {
  deviceId: string;
  userId: string;
  ws: WsSocket;
  lastSeenAt: number;
  connectedAt: number;
  /** What the runner advertises right now. */
  offeredModels: string[];
  /** Advertised AND switched on by the owner. */
  allowedModels: Set<string>;
  /** Owner's pause switch (false = paused). */
  enabled: boolean;
  modelServer: string | null;
  platform: string | null;
  runnerVersion: string;
  inFlight: Set<string>;
  health: RunnerHealth | null;
};

/** What a 0.2.3+ runner reports about itself (sanitized). */
export type RunnerHealth = {
  modelServer: string;
  modelServerOk: boolean;
  models: number;
  inFlight: number;
  uptimeSec: number;
  latencyMs?: number;
  lastError?: string;
  lastErrorAt?: number;
  at: number;
};

export type DeviceLiveInfo = {
  online: boolean;
  connectedAt: number | null;
  modelServer: string | null;
  /** Health view (in memory, since the api started). */
  runnerVersion?: string | null;
  health?: RunnerHealth | null;
  inFlight?: number;
  /** In-flight answers that already received tokens. */
  streaming?: number;
  /** M3b: requests waiting for a free slot. */
  queued?: number;
  answers?: number;
  lastAnswerAt?: number | null;
  lastFailure?: { message: string; at: number } | null;
  lastDisconnect?: { reason: string; at: number } | null;
};

export type DeviceCheckResult =
  | { online: false }
  | { online: true; supported: false; runnerVersion: string }
  | { online: true; supported: true; health: RunnerHealth };

/** Version of the runner bundle this server hands out (keep in sync with runner/src/index.ts). */
export const LATEST_RUNNER_VERSION = "0.2.3";

export function runnerUpdateAvailable(version: string | null | undefined): boolean {
  if (!version) return false;
  return !runnerSupportsHealth(version);
}

export function iso(ms: number | null | undefined): string | null {
  return ms ? new Date(ms).toISOString() : null;
}

/** Runners from this version on answer `health.check`. */
export const HEALTH_MIN_VERSION = [0, 2, 3];

export function runnerSupportsHealth(version: string | null | undefined): boolean {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(version ?? "");
  if (!m) return false;
  const v = [Number(m[1]), Number(m[2]), Number(m[3])];
  for (let i = 0; i < 3; i++) if (v[i] !== HEALTH_MIN_VERSION[i]) return v[i]! > HEALTH_MIN_VERSION[i]!;
  return true;
}

function shortText(value: unknown, max = 200): string | undefined {
  if (typeof value !== "string") return undefined;
  const t = value.replace(/[\u0000-\u001f]+/g, " ").trim();
  return t ? t.slice(0, max) : undefined;
}

export function sanitizeHealth(frame: Record<string, unknown>): RunnerHealth {
  const num = (v: unknown, max: number) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.min(Math.round(v), max) : 0);
  const at = num(frame.lastErrorAt, 1e15);
  const lastError = shortText(frame.lastError);
  return {
    modelServer: shortText(frame.modelServer, 40) ?? "none",
    modelServerOk: frame.modelServerOk === true,
    models: num(frame.models, 10_000),
    inFlight: num(frame.inFlight, 1000),
    uptimeSec: num(frame.uptimeSec, 1e9),
    ...(typeof frame.latencyMs === "number" ? { latencyMs: num(frame.latencyMs, 600_000) } : {}),
    ...(lastError ? { lastError, lastErrorAt: at || Date.now() } : {}),
    at: Date.now(),
  };
}

const ready = new WeakMap<PrismaClient, Promise<void>>();

export function ensureLocalRunnerTables(prisma: PrismaClient): Promise<void> {
  let pending = ready.get(prisma);
  if (!pending) {
    pending = (async () => {
      await prisma.$executeRawUnsafe(`CREATE TABLE IF NOT EXISTS local_runner_devices (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        token_hash TEXT NOT NULL UNIQUE,
        status TEXT NOT NULL DEFAULT 'active',
        runner_version TEXT,
        last_seen_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`);
      await prisma.$executeRawUnsafe(
        `CREATE INDEX IF NOT EXISTS local_runner_devices_user_id_idx ON local_runner_devices (user_id)`,
      );
      // M2a (additive): pause switch, platform, lifecycle timestamps, how it was paired
      // (NULL/'seed' = M1 operator seed, 'pairing' = pairing code from the UI).
      for (const column of [
        "enabled BOOLEAN NOT NULL DEFAULT true",
        "platform TEXT",
        "revoked_at TIMESTAMPTZ",
        "rotated_at TIMESTAMPTZ",
        "paired_via TEXT",
      ]) {
        await prisma.$executeRawUnsafe(`ALTER TABLE local_runner_devices ADD COLUMN IF NOT EXISTS ${column}`);
      }
      await prisma.$executeRawUnsafe(`CREATE TABLE IF NOT EXISTS local_runner_pairings (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
        code_hash TEXT NOT NULL UNIQUE,
        device_id TEXT REFERENCES local_runner_devices(id) ON DELETE CASCADE,
        result_device_id TEXT REFERENCES local_runner_devices(id) ON DELETE SET NULL,
        os TEXT,
        expires_at TIMESTAMPTZ NOT NULL,
        used_at TIMESTAMPTZ,
        cancelled_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`);
      await prisma.$executeRawUnsafe(
        `CREATE INDEX IF NOT EXISTS local_runner_pairings_user_idx ON local_runner_pairings (user_id, created_at)`,
      );
      await prisma.$executeRawUnsafe(`CREATE TABLE IF NOT EXISTS local_runner_models (
        device_id TEXT NOT NULL REFERENCES local_runner_devices(id) ON DELETE CASCADE,
        model_id TEXT NOT NULL,
        context_window INTEGER,
        advertised BOOLEAN NOT NULL DEFAULT true,
        enabled BOOLEAN NOT NULL DEFAULT false,
        last_advertised_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (device_id, model_id)
      )`);
      // M2b (additive): which computer + model each shared-local bot runs on.
      await prisma.$executeRawUnsafe(`CREATE TABLE IF NOT EXISTS local_runner_bot_bindings (
        bot_id TEXT PRIMARY KEY REFERENCES bots(id) ON DELETE CASCADE,
        user_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
        device_id TEXT NOT NULL REFERENCES local_runner_devices(id) ON DELETE CASCADE,
        model_id TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`);
      await prisma.$executeRawUnsafe(
        `CREATE INDEX IF NOT EXISTS local_runner_bot_bindings_device_idx ON local_runner_bot_bindings (device_id)`,
      );
      await migrateM1Bindings(prisma);
      // M2c (additive): the owner lets a bot answer for people in one shared group.
      await prisma.$executeRawUnsafe(`CREATE TABLE IF NOT EXISTS local_runner_grants (
        bot_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
        group_id TEXT NOT NULL REFERENCES chat_groups(id) ON DELETE CASCADE,
        owner_user_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (bot_id, group_id)
      )`);
      // M3 (additive): owner limits per computer, and one usage row per answer request.
      await prisma.$executeRawUnsafe(`CREATE TABLE IF NOT EXISTS local_runner_limits (
        device_id TEXT PRIMARY KEY REFERENCES local_runner_devices(id) ON DELETE CASCADE,
        max_concurrent INT NOT NULL DEFAULT 2,
        per_user_per_minute INT NOT NULL DEFAULT 20,
        daily_request_cap INT,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`);
      // M3b (additive): per-person daily request cap and a daily token cap for other people.
      await prisma.$executeRawUnsafe(`ALTER TABLE local_runner_limits ADD COLUMN IF NOT EXISTS person_daily_cap INT`);
      await prisma.$executeRawUnsafe(`ALTER TABLE local_runner_limits ADD COLUMN IF NOT EXISTS daily_token_cap INT`);
      await prisma.$executeRawUnsafe(`CREATE TABLE IF NOT EXISTS local_runner_usage (
        id TEXT PRIMARY KEY,
        device_id TEXT NOT NULL,
        owner_user_id TEXT NOT NULL,
        consumer_user_id TEXT,
        bot_id TEXT,
        run_id TEXT,
        group_id TEXT,
        model_id TEXT,
        status TEXT NOT NULL,
        input_tokens INT NOT NULL DEFAULT 0,
        output_tokens INT NOT NULL DEFAULT 0,
        duration_ms INT NOT NULL DEFAULT 0,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`);
      await prisma.$executeRawUnsafe(
        `CREATE INDEX IF NOT EXISTS local_runner_usage_device_idx ON local_runner_usage (device_id, created_at)`,
      );
      await prisma.$executeRawUnsafe(
        `CREATE INDEX IF NOT EXISTS local_runner_usage_owner_idx ON local_runner_usage (owner_user_id, created_at)`,
      );
      await prisma.$executeRawUnsafe(`CREATE TABLE IF NOT EXISTS local_runner_usage_daily (
        day DATE NOT NULL,
        device_id TEXT NOT NULL,
        owner_user_id TEXT NOT NULL,
        consumer_user_id TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL,
        requests INT NOT NULL DEFAULT 0,
        input_tokens BIGINT NOT NULL DEFAULT 0,
        output_tokens BIGINT NOT NULL DEFAULT 0,
        duration_ms BIGINT NOT NULL DEFAULT 0,
        PRIMARY KEY (day, device_id, owner_user_id, consumer_user_id, status)
      )`);
      await prisma.$executeRawUnsafe(
        `CREATE INDEX IF NOT EXISTS local_runner_usage_daily_owner_idx ON local_runner_usage_daily (owner_user_id, day)`,
      );
    })().catch((error) => {
      ready.delete(prisma);
      throw error;
    });
    ready.set(prisma, pending);
  }
  return pending;
}

/**
 * M2b migration (idempotent, additive): an M1/M2a shared-local bot with no
 * binding whose owner has exactly one active computer gets bound to it, and that
 * model is switched on there, so bots like Chief Local keep working untouched.
 * Owners with several computers pick one in the UI (the bot shows a notice).
 */
export async function migrateM1Bindings(prisma: PrismaClient): Promise<number> {
  const bound = await prisma.$queryRawUnsafe<Array<{ device_id: string; model_id: string }>>(
    `WITH single AS (
       SELECT user_id, MIN(id) AS device_id FROM local_runner_devices
       WHERE status = 'active' GROUP BY user_id HAVING COUNT(*) = 1
     )
     INSERT INTO local_runner_bot_bindings (bot_id, user_id, device_id, model_id)
     SELECT b.id, b."userId", s.device_id, b."modelId"
     FROM bots b JOIN single s ON s.user_id = b."userId"
     WHERE b."modelProvider" = 'shared-local' AND b."modelId" IS NOT NULL AND b."modelId" <> ''
       AND NOT EXISTS (SELECT 1 FROM local_runner_bot_bindings x WHERE x.bot_id = b.id)
     ON CONFLICT (bot_id) DO NOTHING
     RETURNING device_id, model_id`,
  );
  for (const row of bound) {
    await prisma.$executeRawUnsafe(
      `INSERT INTO local_runner_models (device_id, model_id, advertised, enabled)
       VALUES ($1, $2, false, true)
       ON CONFLICT (device_id, model_id) DO UPDATE SET enabled = true`,
      row.device_id,
      row.model_id,
    );
  }
  return bound.length;
}

/** One row with everything the access rule needs; undefined = no such run. */
export async function loadSharedLocalAccessRow(
  prisma: PrismaClient,
  runId: string,
): Promise<SharedLocalAccessRow | undefined> {
  const rows = await prisma.$queryRawUnsafe<SharedLocalAccessRow[]>(
    `SELECT b.id AS bot_id, r."userId" AS run_user_id, r.status::text AS run_status, r.trigger::text AS run_trigger,
            b."userId" AS bot_user_id, b."modelProvider" AS bot_model_provider, b."modelId" AS bot_model_id,
            (b."archivedAt" IS NOT NULL) AS bot_archived,
            t."groupId" AS thread_group_id, t."botId" AS thread_bot_id,
            (t."externalConversationId" IS NOT NULL) AS thread_external,
            (SELECT COUNT(*)::int FROM group_shares gs WHERE gs.group_id = t."groupId") AS group_share_count,
            EXISTS (SELECT 1 FROM local_runner_grants g JOIN chat_groups cg ON cg.id = g.group_id
                     WHERE g.bot_id = b.id AND g.group_id = t."groupId"
                       AND g.owner_user_id = r."userId" AND cg."userId" = r."userId"
                       AND cg."archivedAt" IS NULL) AS group_granted,
            bb.device_id AS bind_device_id, bb.model_id AS bind_model_id,
            d.user_id AS device_user_id, d.status AS device_status, d.enabled AS device_enabled,
            m.enabled AS model_enabled, m.advertised AS model_advertised, m.context_window AS model_context_window,
            COALESCE((SELECT a.user_id FROM group_message_authors a WHERE a.message_id = r."sourceMessageId" LIMIT 1), r."userId") AS consumer_user_id
       FROM runs r
       JOIN bots b ON b.id = r."botId"
       LEFT JOIN threads t ON t.id = r."threadId"
       LEFT JOIN local_runner_bot_bindings bb ON bb.bot_id = b.id
       LEFT JOIN local_runner_devices d ON d.id = bb.device_id
       LEFT JOIN local_runner_models m ON m.device_id = bb.device_id AND m.model_id = bb.model_id
      WHERE r.id = $1`,
    runId,
  );
  return rows[0];
}

/** Seed a device for a user. Returns plaintext token once (caller must store securely). */
export async function seedLocalRunnerDevice(
  prisma: PrismaClient,
  input: { userId: string; name: string; deviceId?: string },
): Promise<{ deviceId: string; token: string }> {
  await ensureLocalRunnerTables(prisma);
  const deviceId = input.deviceId ?? randomUUID().replace(/-/g, "").slice(0, 24);
  const token = randomBytes(32).toString("base64url");
  const tokenHash = hashDeviceToken(token);
  await prisma.$executeRawUnsafe(
    `INSERT INTO local_runner_devices (id, user_id, name, token_hash, status, paired_via, updated_at)
     VALUES ($1, $2, $3, $4, 'active', 'seed', NOW())
     ON CONFLICT (id) DO UPDATE SET
       token_hash = EXCLUDED.token_hash,
       name = EXCLUDED.name,
       status = 'active',
       revoked_at = NULL,
       updated_at = NOW()`,
    deviceId,
    input.userId,
    input.name,
    tokenHash,
  );
  return { deviceId, token };
}

export type LocalRunnerGateway = {
  mountHttp: (app: Hono) => void;
  attachUpgrade: (server: HttpServer) => void;
  /** Test/ops helper */
  isOwnerOnline: (userId: string) => boolean;
  /** M2a: live state of one computer (for Settings → My hardware). */
  deviceInfo: (deviceId: string) => DeviceLiveInfo;
  /** M2a: reload pause switch + enabled models from the DB and push `policy`. */
  refreshDevice: (deviceId: string) => Promise<void>;
  /** M2a: send `bye{reason}` and drop the live session (revoke / rotate / re-pair). */
  disconnectDevice: (deviceId: string, reason: string) => void;
  /** M2b: models this computer can serve right now (advertised live AND switched on). */
  offeredModels: (deviceId: string) => string[];
  /** M3: forget cached limits after the owner changed them. */
  invalidateLimits: (deviceId: string) => void;
  /** Health: ask the runner to re-check its model server now (8 s timeout). */
  checkDevice: (deviceId: string) => Promise<DeviceCheckResult>;
  /** M2c: stop in-flight answers of a bot in a group (grant revoked). Returns how many. */
  cancelBotInGroup: (botId: string, groupId: string) => number;
};

/**
 * Store what a runner advertises. New rows start switched OFF, except for M1-era
 * devices (seeded by the operator CLI), where the operator's
 * RAKAZO_SHARED_LOCAL_MODELS list stays on so existing bots keep working.
 * Returns the models that are advertised AND enabled.
 */
export async function syncAdvertisedModels(
  prisma: PrismaClient,
  device: { id: string; paired_via: string | null },
  models: AdvertisedModel[],
): Promise<string[]> {
  const legacy = device.paired_via !== "pairing";
  const legacyOn = legacy ? sharedLocalModelIds() : [];
  const list = models.slice(0, MAX_MODELS_PER_DEVICE);
  await prisma.$executeRawUnsafe(
    `INSERT INTO local_runner_models (device_id, model_id, context_window, advertised, enabled, last_advertised_at)
     SELECT $1, m.id, m.ctx, true, m.id IN (SELECT jsonb_array_elements_text($3::jsonb)), NOW()
     FROM jsonb_to_recordset($2::jsonb) AS m(id text, ctx int)
     ON CONFLICT (device_id, model_id) DO UPDATE SET
       advertised = true,
       context_window = COALESCE(EXCLUDED.context_window, local_runner_models.context_window),
       last_advertised_at = NOW()`,
    device.id,
    JSON.stringify(list.map((m) => ({ id: m.id, ctx: m.contextWindow }))),
    JSON.stringify(legacyOn),
  );
  await prisma.$executeRawUnsafe(
    `UPDATE local_runner_models SET advertised = false
     WHERE device_id = $1 AND advertised AND model_id NOT IN (SELECT jsonb_array_elements_text($2::jsonb))`,
    device.id,
    JSON.stringify(list.map((m) => m.id)),
  );
  // Forget models that are gone and were never switched on.
  await prisma.$executeRawUnsafe(
    `DELETE FROM local_runner_models WHERE device_id = $1 AND NOT advertised AND NOT enabled`,
    device.id,
  );
  return loadAllowedModels(prisma, device.id);
}

async function loadAllowedModels(prisma: PrismaClient, deviceId: string): Promise<string[]> {
  const rows = await prisma.$queryRawUnsafe<Array<{ model_id: string }>>(
    `SELECT model_id FROM local_runner_models WHERE device_id = $1 AND advertised AND enabled ORDER BY model_id`,
    deviceId,
  );
  return rows.map((r) => r.model_id);
}

function hashesEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

export function createLocalRunnerGateway(deps: {
  prisma: PrismaClient;
}): LocalRunnerGateway {
  const sessionsByDevice = new Map<string, RunnerSession>();
  const sessionsByUser = new Map<string, Set<RunnerSession>>();
  const pending = new Map<string, PendingInfer>();
  // Health view per computer, kept across reconnects (in memory; resets when the api restarts).
  type DeviceStats = { answers: number; lastAnswerAt: number | null; lastFailure: { message: string; at: number } | null; lastDisconnect: { reason: string; at: number } | null };
  const stats = new Map<string, DeviceStats>();
  const statsFor = (deviceId: string): DeviceStats => {
    let st = stats.get(deviceId);
    if (!st) {
      st = { answers: 0, lastAnswerAt: null, lastFailure: null, lastDisconnect: null };
      stats.set(deviceId, st);
    }
    return st;
  };
  const checks = new Map<string, { deviceId: string; resolve: (h: RunnerHealth | null) => void }>();
  // M3: owner limits (cached 30 s, dropped on change) and per-person request times (last 60 s).
  const limitsCache = new Map<string, { limits: DeviceLimits; at: number }>();
  const slots = new SlotQueue();
  const recent = new Map<string, number[]>();
  async function limitsFor(deviceId: string): Promise<DeviceLimits> {
    const hit = limitsCache.get(deviceId);
    if (hit && Date.now() - hit.at < 30_000) return hit.limits;
    const rows = await deps.prisma.$queryRawUnsafe<Array<Record<string, unknown>>>(
      `SELECT * FROM local_runner_limits WHERE device_id = $1`,
      deviceId,
    );
    const limits = limitsFromRow(rows[0]);
    limitsCache.set(deviceId, { limits, at: Date.now() });
    return limits;
  }
  function recentCount(key: string, now: number): number {
    const list = (recent.get(key) ?? []).filter((t) => now - t < 60_000);
    if (list.length) recent.set(key, list);
    else recent.delete(key);
    return list.length;
  }
  const failedHellos = new Map<string, { count: number; resetAt: number }>();
  const wsMod = loadWs();
  const wss = new wsMod.WebSocketServer({ noServer: true, maxPayload: MAX_FRAME_BYTES });

  function userSessions(userId: string): Set<RunnerSession> {
    let set = sessionsByUser.get(userId);
    if (!set) {
      set = new Set();
      sessionsByUser.set(userId, set);
    }
    return set;
  }

  function sendPolicy(session: RunnerSession): void {
    try {
      session.ws.send(
        JSON.stringify({
          type: "policy",
          maxInFlight: MAX_IN_FLIGHT,
          hardTimeoutMs: HARD_TIMEOUT_MS,
          enabled: session.enabled,
          allowedModels: [...session.allowedModels],
        }),
      );
    } catch {
      /* socket closing */
    }
  }

  function touch(session: RunnerSession): void {
    session.lastSeenAt = Date.now();
  }

  function dropSession(session: RunnerSession, reason: string, closeCode = 1000): void {
    if (sessionsByDevice.get(session.deviceId) === session) {
      sessionsByDevice.delete(session.deviceId);
      if (reason !== "replaced") statsFor(session.deviceId).lastDisconnect = { reason: reason.slice(0, 40), at: Date.now() };
    }
    const set = sessionsByUser.get(session.userId);
    if (set) {
      set.delete(session);
      if (!set.size) sessionsByUser.delete(session.userId);
    }
    for (const id of [...session.inFlight]) {
      failPending(id, `Runner disconnected (${reason})`, true);
    }
    session.inFlight.clear();
    try {
      session.ws.close(closeCode, reason.slice(0, 64));
    } catch {
      /* ignore */
    }
  }

  function wake(p: PendingInfer): void {
    const waiters = p.waiters.splice(0);
    for (const w of waiters) w();
  }

  function recordUsage(p: PendingInfer, status: string): void {
    if (!p.deviceId) return;
    void deps.prisma
      .$executeRawUnsafe(
        `INSERT INTO local_runner_usage (id, device_id, owner_user_id, consumer_user_id, bot_id, run_id, group_id, model_id, status, input_tokens, output_tokens, duration_ms)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
        p.id, p.deviceId, p.ownerUserId, p.consumerUserId ?? null, p.botId, p.runId, p.groupId, p.model ?? null, status,
        p.usage?.input ?? 0, p.usage?.output ?? 0, Math.max(0, Date.now() - (p.startedAt ?? Date.now())),
      )
      .catch(() => undefined);
  }

  function failPending(id: string, message: string, retryable: boolean): void {
    const p = pending.get(id);
    if (!p || p.done) return;
    recordUsage(p, message === "Cancelled" || /run_ended|cancel/i.test(message) ? "cancelled" : "error");
    p.done = true;
    p.error = { message, retryable };
    clearTimeout(p.hardTimer);
    wake(p);
  }

  function completePending(id: string, status: number): void {
    const p = pending.get(id);
    if (!p || p.done) return;
    recordUsage(p, status < 400 ? "ok" : "error");
    p.done = true;
    p.status = status;
    clearTimeout(p.hardTimer);
    wake(p);
  }

  function parseFrame(raw: string): { type: string; [k: string]: unknown } | null {
    try {
      const v = JSON.parse(raw) as { type?: unknown };
      if (!v || typeof v !== "object" || typeof v.type !== "string") return null;
      return v as { type: string; [k: string]: unknown };
    } catch {
      return null;
    }
  }

  async function authenticateHello(frame: Record<string, unknown>): Promise<{
    device: DeviceRow;
    models: AdvertisedModel[];
    allowedModels: string[];
    runnerVersion: string;
    platform: string | null;
    modelServer: string | null;
  } | null> {
    const deviceId = typeof frame.deviceId === "string" ? frame.deviceId.slice(0, 64) : "";
    const token = typeof frame.token === "string" ? frame.token.slice(0, 256) : "";
    if (!deviceId || !token) return null;
    await ensureLocalRunnerTables(deps.prisma);
    const rows = await deps.prisma.$queryRawUnsafe<DeviceRow[]>(
      `SELECT id, user_id, name, token_hash, status, enabled, paired_via FROM local_runner_devices WHERE id = $1`,
      deviceId,
    );
    const device = rows[0];
    if (!device || device.status !== "active") return null;
    if (!hashesEqual(hashDeviceToken(token), device.token_hash)) return null;
    const models = sanitizeAdvertisedModels(frame.offeredModels);
    const runnerVersion = sanitizeShort(frame.runnerVersion) ?? "";
    const platform = sanitizeShort(frame.platform, 40);
    const modelServer = sanitizeShort(frame.modelServer, 40);
    await deps.prisma.$executeRawUnsafe(
      `UPDATE local_runner_devices SET last_seen_at = NOW(), runner_version = $2,
         platform = COALESCE($3, platform), updated_at = NOW() WHERE id = $1`,
      deviceId,
      runnerVersion || null,
      platform,
    );
    const allowedModels = await syncAdvertisedModels(deps.prisma, device, models);
    return { device, models, allowedModels, runnerVersion, platform, modelServer };
  }

  function helloBlocked(ip: string): boolean {
    const h = failedHellos.get(ip);
    return Boolean(h && h.resetAt > Date.now() && h.count >= FAILED_HELLO_LIMIT);
  }

  function helloFailed(ip: string): void {
    const now = Date.now();
    const h = failedHellos.get(ip);
    if (!h || h.resetAt <= now) failedHellos.set(ip, { count: 1, resetAt: now + FAILED_HELLO_WINDOW_MS });
    else h.count += 1;
    if (failedHellos.size > 10_000) {
      for (const [k, v] of failedHellos) if (v.resetAt <= now) failedHellos.delete(k);
    }
  }

  function bindSocket(ws: WsSocket, ip: string): void {
    let session: RunnerSession | null = null;
    let helloTimer = setTimeout(() => {
      try {
        ws.close(1008, "hello timeout");
      } catch {
        /* ignore */
      }
    }, 15_000);

    // Frames that arrive while the hello is still being checked (the runner sends
    // its models right after hello) wait for that check instead of failing it.
    let authenticating: Promise<void> | null = null;

    ws.on("message", (data: unknown) => {
      void (async () => {
        const raw = typeof data === "string" ? data : Buffer.isBuffer(data) ? data.toString("utf8") : String(data);
        const frame = parseFrame(raw);
        if (!frame) return;

        if (!session && authenticating && frame.type !== "hello") {
          await authenticating;
          if (!session) return;
        }
        if (!session) {
          if (frame.type !== "hello") {
            ws.close(1008, "hello required");
            return;
          }
          if (authenticating) return; // one hello per socket
          clearTimeout(helloTimer);
          // Keyed by address *and* claimed device, so one misconfigured or revoked
          // runner behind the shared web proxy cannot lock out everyone else.
          const limiterKey = `${ip}|${typeof frame.deviceId === "string" ? frame.deviceId.slice(0, 64) : "-"}`;
          if (helloBlocked(limiterKey)) {
            ws.close(1008, "too many attempts");
            return;
          }
          let done!: () => void;
          authenticating = new Promise<void>((resolve) => (done = resolve));
          try {
            const auth = await authenticateHello(frame).catch(() => null);
            if (!auth) {
              helloFailed(limiterKey);
              ws.close(1008, "unauthorized");
              return;
            }
            if (ws.readyState !== 1) return; // closed while we were checking
            // One live session per computer; other computers of the same owner stay.
            const existing = sessionsByDevice.get(auth.device.id);
            if (existing) dropSession(existing, "replaced");
            session = {
              deviceId: auth.device.id,
              userId: auth.device.user_id,
              ws,
              lastSeenAt: Date.now(),
              connectedAt: Date.now(),
              offeredModels: auth.models.map((m) => m.id),
              allowedModels: new Set(auth.allowedModels),
              enabled: auth.device.enabled !== false,
              modelServer: auth.modelServer,
              platform: auth.platform,
              runnerVersion: auth.runnerVersion,
              inFlight: new Set(),
              health: null,
            };
            sessionsByDevice.set(session.deviceId, session);
            userSessions(session.userId).add(session);
            sendPolicy(session);
          } finally {
            done();
          }
          return;
        }

        touch(session);
        if (frame.type === "heartbeat") {
          ws.send(JSON.stringify({ type: "heartbeat_ack", at: Date.now() }));
          return;
        }
        if (frame.type === "models" && Array.isArray(frame.models)) {
          const current = session;
          const models = sanitizeAdvertisedModels(frame.models);
          current.offeredModels = models.map((m) => m.id);
          const server = sanitizeShort(frame.modelServer, 40);
          if (server) current.modelServer = server;
          const rows = await deps.prisma.$queryRawUnsafe<DeviceRow[]>(
            `SELECT id, user_id, name, token_hash, status, enabled, paired_via FROM local_runner_devices WHERE id = $1`,
            current.deviceId,
          );
          const device = rows[0];
          if (!device || device.status !== "active") {
            dropSession(current, "revoked");
            return;
          }
          current.allowedModels = new Set(await syncAdvertisedModels(deps.prisma, device, models));
          current.enabled = device.enabled !== false;
          sendPolicy(current);
          return;
        }
        if (frame.type === "health") {
          session.health = sanitizeHealth(frame);
          const checkId = typeof frame.checkId === "string" ? frame.checkId : "";
          const waiting = checkId ? checks.get(checkId) : undefined;
          if (waiting && waiting.deviceId === session.deviceId) {
            checks.delete(checkId);
            waiting.resolve(session.health);
          }
          return;
        }
        if (frame.type === "infer.chunk") {
          const id = typeof frame.id === "string" ? frame.id : "";
          const dataLine = typeof frame.data === "string" ? frame.data : "";
          const p = pending.get(id);
          if (p && !p.done && session.inFlight.has(id)) {
            p.lastChunkAt = Date.now();
            p.streamed = true;
            const u = usageFromSseLine(dataLine);
            if (u) p.usage = u;
            p.chunks.push(dataLine);
            wake(p);
          }
          return;
        }
        if (frame.type === "infer.done") {
          const id = typeof frame.id === "string" ? frame.id : "";
          const status = typeof frame.status === "number" ? frame.status : 200;
          session.inFlight.delete(id);
          if (pending.has(id)) {
            const st = statsFor(session.deviceId);
            if (status < 400) {
              st.answers += 1;
              st.lastAnswerAt = Date.now();
            } else st.lastFailure = { message: `Local model server answered HTTP ${status}`, at: Date.now() };
          }
          completePending(id, status);
          return;
        }
        if (frame.type === "infer.error") {
          const id = typeof frame.id === "string" ? frame.id : "";
          const message =
            typeof frame.message === "string" ? frame.message : "Runner inference error";
          const retryable = Boolean(frame.retryable);
          if (pending.has(id) && message !== "Cancelled") {
            statsFor(session.deviceId).lastFailure = { message: shortText(message) ?? "error", at: Date.now() };
          }
          session.inFlight.delete(id);
          failPending(id, message, retryable);
          return;
        }
      })();
    });

    ws.on("close", () => {
      clearTimeout(helloTimer);
      if (session) dropSession(session, "closed");
    });
  }

  startUsageRetention(deps.prisma);

  // Stale heartbeat sweeper
  setInterval(() => {
    const now = Date.now();
    for (const session of [...sessionsByDevice.values()]) {
      if (now - session.lastSeenAt > HEARTBEAT_MISS_MS) {
        dropSession(session, "heartbeat-timeout");
      }
    }
  }, 5_000).unref?.();

  /** Live, non-stale, not paused sessions of an owner. */
  function ownerSessions(ownerUserId: string): RunnerSession[] {
    const out: RunnerSession[] = [];
    for (const session of [...(sessionsByUser.get(ownerUserId) ?? [])]) {
      if (Date.now() - session.lastSeenAt > HEARTBEAT_MISS_MS) {
        dropSession(session, "stale");
        continue;
      }
      if (session.enabled) out.push(session);
    }
    return out;
  }

  /**
   * M2b: the bound computer's live session, if it is online, not paused and
   * offers the model right now. `busy` = online but already at MAX_IN_FLIGHT.
   */
  function deviceSession(deviceId: string, model: string): RunnerSession | "busy" | "paused" | "no_model" | undefined {
    const session = sessionsByDevice.get(deviceId);
    if (!session) return undefined;
    if (Date.now() - session.lastSeenAt > HEARTBEAT_MISS_MS) {
      dropSession(session, "stale");
      return undefined;
    }
    if (!session.enabled) return "paused";
    if (!session.allowedModels.has(model) || !session.offeredModels.includes(model)) return "no_model";
    // M3: the owner's concurrency limit is checked in proxyChatCompletions (async).
    return session.inFlight.size < LIMIT_BOUNDS.maxConcurrent[1] ? session : "busy";
  }

  function liveError(kind: "busy" | "paused" | "no_model" | "rate_limited" | "daily_cap" | "person_cap" | undefined): Response {
    if (kind === "person_cap") {
      return Response.json(
        { error: { message: "[shared_local_person_cap] Your daily limit on the owner's computer is used up.", type: "shared_local_person_cap" } },
        { status: 429 },
      );
    }
    if (kind === "rate_limited") {
      return Response.json(
        { error: { message: "[shared_local_rate_limited] Too many requests to the owner's computer this minute.", type: "shared_local_rate_limited" } },
        { status: 429, headers: { "retry-after": "60" } },
      );
    }
    if (kind === "daily_cap") {
      return Response.json(
        { error: { message: "[shared_local_daily_cap] The owner's daily limit for this computer is used up.", type: "shared_local_daily_cap" } },
        { status: 429 },
      );
    }
    if (kind === "busy") {
      return Response.json(
        { error: { message: "[shared_local_busy] Owner's local runner is busy. Try again shortly.", type: "shared_local_busy" } },
        { status: 429 },
      );
    }
    if (kind === "paused") {
      return Response.json(
        { error: { message: "[shared_local_paused] The owner's computer is paused.", type: "shared_local_paused" } },
        { status: 503 },
      );
    }
    if (kind === "no_model") {
      return Response.json(
        {
          error: {
            message: "[shared_local_model_off] The owner's computer doesn't offer this model right now.",
            type: "shared_local_model_off",
          },
        },
        { status: 403 },
      );
    }
    return Response.json({ error: { message: OFFLINE_MESSAGE, type: "shared_local_offline" } }, { status: 503 });
  }

  /** Token signature + a fresh database check of the run and everything it touches. */
  async function authorize(header: string, requestedModel?: string): Promise<
    | { ok: true; ownerUserId: string; runId: string; access: Extract<SharedLocalAccess, { ok: true }>; consumerUserId: string }
    | { ok: false; response: Response }
  > {
    const token = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
    const verified = token ? verifySharedLocalRunToken(token) : null;
    if (!verified) {
      return { ok: false, response: Response.json({ error: { message: "Unauthorized", type: "shared_local_unauthorized" } }, { status: 401 }) };
    }
    await ensureLocalRunnerTables(deps.prisma);
    const row = await loadSharedLocalAccessRow(deps.prisma, verified.runId);
    const access = decideSharedLocalAccess(verified.ownerUserId, row, requestedModel);
    if (!access.ok) {
      return {
        ok: false,
        response: Response.json({ error: { message: access.message, type: access.type } }, { status: access.status }),
      };
    }
    return { ok: true, ownerUserId: verified.ownerUserId, runId: verified.runId, access, consumerUserId: row?.consumer_user_id || verified.ownerUserId };
  }

  // Answers whose run has finished or been cancelled stop at once: the token is
  // only as alive as its run, including mid-stream.
  setInterval(() => {
    const live = [...pending.values()].filter((p) => !p.done);
    const now = Date.now();
    for (const p of live) {
      if (now - p.lastChunkAt > IDLE_TIMEOUT_MS) cancelPending(p.id, "Inference idle timeout (no tokens for 5 min)");
    }
    const runIds = [...new Set(live.map((p) => p.runId))];
    if (!runIds.length) return;
    void deps.prisma
      .$queryRawUnsafe<Array<{ id: string }>>(
        `SELECT id FROM runs WHERE id = ANY($1::text[]) AND status::text IN ('leased', 'running')`,
        runIds,
      )
      .then((rows) => {
        const alive = new Set(rows.map((r) => r.id));
        for (const p of live) if (!alive.has(p.runId)) cancelPending(p.id, "[shared_local_run_ended] This run has ended.");
      })
      .catch(() => undefined);
  }, RUN_SWEEP_MS).unref?.();

  function cancelPending(id: string, message: string): void {
    for (const session of sessionsByDevice.values()) {
      if (!session.inFlight.has(id)) continue;
      try {
        session.ws.send(JSON.stringify({ type: "infer.cancel", id }));
      } catch {
        /* ignore */
      }
      session.inFlight.delete(id);
    }
    failPending(id, message, false);
  }

  async function proxyChatCompletions(
    ownerUserId: string,
    runId: string,
    access: { deviceId: string; botId: string; groupId: string | null },
    body: Record<string, unknown>,
    signal: AbortSignal,
    consumerUserId: string = ownerUserId,
  ): Promise<Response> {
    const model = typeof body.model === "string" ? body.model : "";
    if (!model) {
      return Response.json({ error: { message: "model is required" } }, { status: 400 });
    }
    const picked = deviceSession(access.deviceId, model);
    if (!picked || typeof picked === "string") return liveError(picked);
    if (picked.userId !== ownerUserId) return liveError(undefined);

    // M3 limits: owner's concurrency for everyone; per-person rate and daily cap for others.
    const limits = await limitsFor(access.deviceId);
    const isOwner = consumerUserId === ownerUserId;
    const now = Date.now();
    const rateKey = `${access.deviceId}|${consumerUserId}`;
    let todayPeer = 0;
    let todayPerson = 0;
    let todayPeerTokens = 0;
    if (!isOwner && (limits.dailyRequestCap !== null || limits.personDailyCap !== null || limits.dailyTokenCap !== null)) {
      const rows = await deps.prisma.$queryRawUnsafe<Array<{ peer: number; person: number; tokens: number }>>(
        `SELECT COUNT(*)::int AS peer,
                COUNT(*) FILTER (WHERE consumer_user_id = $2)::int AS person,
                COALESCE(SUM(input_tokens + output_tokens), 0)::bigint::float8 AS tokens
           FROM local_runner_usage
          WHERE device_id = $1 AND consumer_user_id IS DISTINCT FROM owner_user_id
            AND status IN ('ok', 'error', 'cancelled') AND created_at >= date_trunc('day', NOW())`,
        access.deviceId,
        consumerUserId,
      );
      todayPeer = rows[0]?.peer ?? 0;
      todayPerson = rows[0]?.person ?? 0;
      todayPeerTokens = Number(rows[0]?.tokens ?? 0);
    }
    // Rate and daily cap first (concurrency is handled by the queue below).
    let refusal: LimitRefusal | null = decideLimit({ limits, inFlight: 0, isOwner, recentRequests: isOwner ? 0 : recentCount(rateKey, now), todayPeerRequests: todayPeer, todayPersonRequests: todayPerson, todayPeerTokens });
    let session = picked;
    if (!refusal) {
      // M3b: when the computer is busy, wait briefly (FIFO) instead of refusing at once.
      const got = await slots.acquire(
        access.deviceId,
        () => {
          const s = deviceSession(access.deviceId, model);
          if (!s || typeof s === "string") return s === "busy" ? false : "gone";
          return s.inFlight.size < limits.maxConcurrent;
        },
        signal,
      );
      if (got === "aborted") return Response.json({ error: { message: "Cancelled" } }, { status: 499 });
      if (got === "gone") {
        const s = deviceSession(access.deviceId, model);
        return liveError(typeof s === "string" ? s : undefined);
      }
      if (got === "busy") refusal = "busy";
      else {
        const s = deviceSession(access.deviceId, model);
        if (!s || typeof s === "string") return liveError(s);
        if (s.userId !== ownerUserId) return liveError(undefined);
        session = s;
      }
    }
    if (refusal) {
      void deps.prisma
        .$executeRawUnsafe(
          `INSERT INTO local_runner_usage (id, device_id, owner_user_id, consumer_user_id, bot_id, run_id, group_id, model_id, status)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
          randomUUID(), access.deviceId, ownerUserId, consumerUserId, access.botId, runId, access.groupId, model, `refused_${refusal}`,
        )
        .catch(() => undefined);
      return liveError(refusal);
    }
    if (!isOwner) recent.set(rateKey, [...(recent.get(rateKey) ?? []), now]);

    const id = randomUUID();
    const p: PendingInfer = {
      id,
      ownerUserId,
      runId,
      botId: access.botId,
      groupId: access.groupId,
      lastChunkAt: Date.now(),
      chunks: [],
      done: false,
      waiters: [],
      deviceId: access.deviceId,
      consumerUserId,
      model,
      startedAt: Date.now(),
      hardTimer: setTimeout(() => {
        failPending(id, "Inference hard timeout (30 min)", false);
        try {
          session.ws.send(JSON.stringify({ type: "infer.cancel", id }));
        } catch {
          /* ignore */
        }
        session.inFlight.delete(id);
      }, HARD_TIMEOUT_MS),
    };
    pending.set(id, p);
    session.inFlight.add(id);

    const onAbort = () => {
      try {
        session.ws.send(JSON.stringify({ type: "infer.cancel", id }));
      } catch {
        /* ignore */
      }
      failPending(id, "Cancelled", false);
      session.inFlight.delete(id);
    };
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });

    try {
      session.ws.send(
        JSON.stringify({
          type: "infer.request",
          id,
          model,
          // Ask for token counts in the final chunk (OpenAI-compatible servers; ignored otherwise).
          body: { ...body, stream: true, stream_options: { include_usage: true, ...((body.stream_options as object) ?? {}) } },
        }),
      );
    } catch {
      failPending(id, OFFLINE_MESSAGE, true);
      session.inFlight.delete(id);
      pending.delete(id);
      clearTimeout(p.hardTimer);
      return Response.json(
        { error: { message: OFFLINE_MESSAGE, type: "shared_local_offline" } },
        { status: 503 },
      );
    }

    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const encoder = new TextEncoder();
        let cursor = 0;
        const pump = () => {
          while (cursor < p.chunks.length) {
            const line = p.chunks[cursor++]!;
            // Runner forwards non-empty SSE lines; each OpenAI `data:` line is a
            // complete event, so restore the blank-line event terminator.
            controller.enqueue(encoder.encode(line.startsWith("data:") ? `${line}\n\n` : `${line}\n`));
          }
          if (p.done) {
            if (p.error) {
              // Surface as SSE error then close — clients that already got
              // headers still need a terminal signal.
              const errEvent = `data: ${JSON.stringify({ error: { message: p.error.message, type: "shared_local_disconnected" } })}\n\n`;
              controller.enqueue(encoder.encode(errEvent));
              controller.enqueue(encoder.encode("data: [DONE]\n\n"));
              controller.close();
            } else {
              controller.close();
            }
            pending.delete(id);
            clearTimeout(p.hardTimer);
            signal.removeEventListener("abort", onAbort);
            return;
          }
          p.waiters.push(pump);
        };
        pump();
      },
      cancel() {
        onAbort();
        pending.delete(id);
        clearTimeout(p.hardTimer);
      },
    });

    // Wait until we have the first byte or an early error so we can still
    // return 503/4xx before committing to SSE when the runner is gone.
    await new Promise<void>((resolve) => {
      if (p.done || p.chunks.length) {
        resolve();
        return;
      }
      p.waiters.push(() => resolve());
    });

    if (p.done && p.error && p.chunks.length === 0) {
      pending.delete(id);
      clearTimeout(p.hardTimer);
      const status = p.error.message === OFFLINE_MESSAGE ? 503 : 502;
      return Response.json(
        { error: { message: p.error.message, type: "shared_local_error" } },
        { status },
      );
    }

    return new Response(stream, {
      status: 200,
      headers: {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache",
        connection: "keep-alive",
      },
    });
  }

  return {
    isOwnerOnline(userId: string) {
      return ownerSessions(userId).length > 0;
    },
    deviceInfo(deviceId: string): DeviceLiveInfo {
      const session = sessionsByDevice.get(deviceId);
      const st = stats.get(deviceId);
      const common = {
        answers: st?.answers ?? 0,
        lastAnswerAt: st?.lastAnswerAt ?? null,
        lastFailure: st?.lastFailure ?? null,
        lastDisconnect: st?.lastDisconnect ?? null,
      };
      if (!session || Date.now() - session.lastSeenAt > HEARTBEAT_MISS_MS) {
        return { online: false, connectedAt: null, modelServer: null, ...common };
      }
      return {
        online: true,
        connectedAt: session.connectedAt,
        modelServer: session.modelServer,
        runnerVersion: session.runnerVersion || null,
        health: session.health,
        inFlight: session.inFlight.size,
        queued: slots.waiting(deviceId),
        streaming: [...session.inFlight].filter((id) => pending.get(id)?.streamed).length,
        ...common,
      };
    },
    invalidateLimits(deviceId: string) {
      limitsCache.delete(deviceId);
    },
    async checkDevice(deviceId: string): Promise<DeviceCheckResult> {
      const session = sessionsByDevice.get(deviceId);
      if (!session || Date.now() - session.lastSeenAt > HEARTBEAT_MISS_MS) return { online: false };
      if (!runnerSupportsHealth(session.runnerVersion)) {
        return { online: true, supported: false, runnerVersion: session.runnerVersion };
      }
      const id = randomUUID();
      const health = await new Promise<RunnerHealth | null>((resolve) => {
        const timer = setTimeout(() => {
          checks.delete(id);
          resolve(null);
        }, 8_000);
        checks.set(id, { deviceId, resolve: (h) => { clearTimeout(timer); resolve(h); } });
        try {
          session.ws.send(JSON.stringify({ type: "health.check", id }));
        } catch {
          clearTimeout(timer);
          checks.delete(id);
          resolve(null);
        }
      });
      if (!health) return { online: false };
      return { online: true, supported: true, health };
    },
    async refreshDevice(deviceId: string) {
      const session = sessionsByDevice.get(deviceId);
      if (!session) return;
      const rows = await deps.prisma.$queryRawUnsafe<Array<{ enabled: boolean; status: string }>>(
        `SELECT enabled, status FROM local_runner_devices WHERE id = $1`,
        deviceId,
      );
      if (!rows[0] || rows[0].status !== "active") {
        this.disconnectDevice(deviceId, "revoked");
        return;
      }
      session.enabled = rows[0].enabled !== false;
      session.allowedModels = new Set(await loadAllowedModels(deps.prisma, deviceId));
      if (!session.enabled) {
        // Pausing stops answers in progress too.
        for (const id of [...session.inFlight]) {
          try {
            session.ws.send(JSON.stringify({ type: "infer.cancel", id }));
          } catch {
            /* ignore */
          }
          failPending(id, OFFLINE_MESSAGE, false);
        }
        session.inFlight.clear();
      }
      sendPolicy(session);
    },
    cancelBotInGroup(botId: string, groupId: string): number {
      let n = 0;
      for (const p of [...pending.values()]) {
        if (p.done || p.botId !== botId || p.groupId !== groupId) continue;
        cancelPending(p.id, "[shared_local_group_denied] This bot isn't enabled for this shared group any more.");
        n++;
      }
      return n;
    },
    offeredModels(deviceId: string): string[] {
      const session = sessionsByDevice.get(deviceId);
      if (!session || Date.now() - session.lastSeenAt > HEARTBEAT_MISS_MS) return [];
      return session.offeredModels.filter((id) => session.allowedModels.has(id)).sort();
    },
    disconnectDevice(deviceId: string, reason: string) {
      const session = sessionsByDevice.get(deviceId);
      if (!session) return;
      try {
        session.ws.send(JSON.stringify({ type: "bye", reason }));
      } catch {
        /* ignore */
      }
      dropSession(session, reason, 4001);
    },
    mountHttp(app: Hono) {
      // M2b: `/models` lists only the bound model of the run's bot, and only when
      // the bound computer can serve it right now. Refusals carry a typed error.
      app.get("/api/local-runners/v1/models", async (c) => {
        const auth = await authorize(c.req.header("authorization") ?? "");
        if (!auth.ok) return auth.response;
        const live = deviceSession(auth.access.deviceId, auth.access.modelId);
        if (!live || live === "paused" || live === "no_model") return liveError(live);
        return c.json({
          object: "list",
          data: [
            {
              id: auth.access.modelId,
              object: "model",
              owned_by: "shared-local",
              context_window: auth.access.contextWindow,
            },
          ],
        });
      });

      app.post("/api/local-runners/v1/chat/completions", async (c) => {
        let body: Record<string, unknown>;
        try {
          body = (await c.req.json()) as Record<string, unknown>;
        } catch {
          return c.json({ error: "Invalid JSON" }, 400);
        }
        const model = typeof body.model === "string" ? body.model : "";
        const auth = await authorize(c.req.header("authorization") ?? "", model || undefined);
        if (!auth.ok) return auth.response;
        return proxyChatCompletions(auth.ownerUserId, auth.runId, auth.access, body, c.req.raw.signal, auth.consumerUserId);
      });
    },
    attachUpgrade(server: HttpServer) {
      server.on("upgrade", (req: IncomingMessage, socket: Duplex, head: Buffer) => {
        const host = req.headers.host ?? "127.0.0.1";
        const url = new URL(req.url ?? "/", `http://${host}`);
        if (url.pathname !== "/api/local-runners/ws") return;
        // Behind the web proxy every runner shares the proxy's address; the
        // limiter then acts as a global cap on failed hellos, which is fine.
        // The web proxy appends the real client address last; earlier entries are client-supplied.
        const forwarded = String(req.headers["x-forwarded-for"] ?? "").split(",").pop()?.trim();
        const ip = forwarded || req.socket.remoteAddress || "unknown";
        wss.handleUpgrade(req, socket, head, (ws) => {
          bindSocket(ws, ip);
        });
      });
    },
  };
}


// ---------- M3b(c): usage retention ----------
// Raw usage rows older than the retention window are folded into
// local_runner_usage_daily (one row per day/computer/owner/person/status) and
// deleted in the same statement, so totals and charts never change.

export const USAGE_RETENTION_DEFAULT_DAYS = 90;
/** The chart reads up to 90 days, but the rollups keep it exact, so a shorter window is fine; 15 keeps today's caps and a 14-day view on raw rows. */
export const USAGE_RETENTION_MIN_DAYS = 15;
export const USAGE_RETENTION_BATCH = 5_000;
export const USAGE_RETENTION_MAX_BATCHES = 200;

/** RK_LOCAL_USAGE_RETENTION_DAYS: unset/invalid → 90, "0"/"off" → disabled (null), else clamped to ≥ 15. */
export function usageRetentionDays(raw: string | undefined): number | null {
  if (raw === undefined || raw.trim() === "") return USAGE_RETENTION_DEFAULT_DAYS;
  const v = raw.trim().toLowerCase();
  if (v === "0" || v === "off" || v === "false") return null;
  const n = Number.parseInt(v, 10);
  if (!Number.isFinite(n) || n < 0 || String(n) !== v) return USAGE_RETENTION_DEFAULT_DAYS;
  return Math.max(USAGE_RETENTION_MIN_DAYS, n);
}

/** Raw rows + rollups as (day, device_id, owner_user_id, consumer_user_id, status, n, input_tokens, output_tokens). */
export const USAGE_ROWS_SQL = `(
  SELECT date_trunc('day', created_at)::date AS day, device_id, owner_user_id, consumer_user_id, status,
         1::bigint AS n, input_tokens::bigint AS input_tokens, output_tokens::bigint AS output_tokens
    FROM local_runner_usage
  UNION ALL
  SELECT day, device_id, owner_user_id, NULLIF(consumer_user_id, ''), status,
         requests::bigint, input_tokens, output_tokens
    FROM local_runner_usage_daily
)`;

const ROLLUP_BATCH_SQL = `WITH victims AS (
    SELECT id FROM local_runner_usage
     WHERE created_at < date_trunc('day', NOW()) - $1::int * INTERVAL '1 day'
     ORDER BY created_at LIMIT $2::int FOR UPDATE SKIP LOCKED
  ), del AS (
    DELETE FROM local_runner_usage u USING victims v WHERE u.id = v.id
    RETURNING u.created_at, u.device_id, u.owner_user_id, u.consumer_user_id, u.status, u.input_tokens, u.output_tokens, u.duration_ms
  ), agg AS (
    INSERT INTO local_runner_usage_daily AS d (day, device_id, owner_user_id, consumer_user_id, status, requests, input_tokens, output_tokens, duration_ms)
    SELECT date_trunc('day', created_at)::date, device_id, owner_user_id, COALESCE(consumer_user_id, ''), status,
           COUNT(*), SUM(input_tokens), SUM(output_tokens), SUM(duration_ms)
      FROM del GROUP BY 1, 2, 3, 4, 5
    ON CONFLICT (day, device_id, owner_user_id, consumer_user_id, status) DO UPDATE SET
      requests = d.requests + EXCLUDED.requests,
      input_tokens = d.input_tokens + EXCLUDED.input_tokens,
      output_tokens = d.output_tokens + EXCLUDED.output_tokens,
      duration_ms = d.duration_ms + EXCLUDED.duration_ms
  )
  SELECT COUNT(*)::int AS n FROM del`;

/** Dry run: how many raw rows a sweep would fold, split by qa-owned vs everyone else. */
export async function countExpiredUsage(prisma: PrismaClient, days: number): Promise<{ total: number; byOwner: Array<{ owner_user_id: string; n: number }> }> {
  await ensureLocalRunnerTables(prisma);
  const byOwner = await prisma.$queryRawUnsafe<Array<{ owner_user_id: string; n: number }>>(
    `SELECT owner_user_id, COUNT(*)::int AS n FROM local_runner_usage
      WHERE created_at < date_trunc('day', NOW()) - $1::int * INTERVAL '1 day' GROUP BY 1 ORDER BY 2 DESC`,
    days,
  );
  return { total: byOwner.reduce((a, r) => a + Number(r.n), 0), byOwner };
}

/** Fold + delete expired raw rows in batches. Safe to run concurrently (SKIP LOCKED, one atomic statement per batch). */
export async function sweepUsage(
  prisma: PrismaClient,
  days: number,
  opts: { batch?: number; maxBatches?: number } = {},
): Promise<{ folded: number; batches: number }> {
  await ensureLocalRunnerTables(prisma);
  const batch = opts.batch ?? USAGE_RETENTION_BATCH;
  const maxBatches = opts.maxBatches ?? USAGE_RETENTION_MAX_BATCHES;
  let folded = 0;
  let batches = 0;
  while (batches < maxBatches) {
    const [row] = await prisma.$queryRawUnsafe<Array<{ n: number }>>(ROLLUP_BATCH_SQL, days, batch);
    const n = Number(row?.n ?? 0);
    batches += 1;
    folded += n;
    if (n < batch) break;
  }
  return { folded, batches };
}

let retentionTimer: ReturnType<typeof setInterval> | null = null;
/** Starts the periodic sweep (first run after 1 min, then every 6 h). Idempotent. */
export function startUsageRetention(prisma: PrismaClient, env: NodeJS.ProcessEnv = process.env): number | null {
  const days = usageRetentionDays(env.RK_LOCAL_USAGE_RETENTION_DAYS);
  if (days === null || retentionTimer) return days;
  const run = () => {
    void sweepUsage(prisma, days)
      .then((r) => {
        if (r.folded) console.log(`[local-runners] usage retention: folded ${r.folded} rows older than ${days} days into daily totals`);
      })
      .catch((error) => console.warn("[local-runners] usage retention sweep failed:", error instanceof Error ? error.message : error));
  };
  setTimeout(run, 60_000).unref?.();
  retentionTimer = setInterval(run, 6 * 60 * 60_000);
  retentionTimer.unref?.();
  return days;
}
