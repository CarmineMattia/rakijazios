/**
 * Per-action approvals for host tools.
 *
 * Under the "ask" policy a host action is not run: a pending approval is stored and shown to the
 * owner as an approval card (allow once / always / deny). The action runs only after the owner
 * allows it, at most once per approval (allowed -> consumed is atomic), and never after the
 * approval expired. Deny and expiry fail the action cleanly.
 *
 * Sources: "bot" (a bot tool call waits for the decision, then resumes), "background-shell" and
 * "send-input" (the HTTP request returns 202 and the action is dispatched when it's allowed).
 */
import { randomUUID } from "node:crypto";
import type { PrismaClient } from "@rakazo/db";
import { recordStandingGrant, type HostToolAction } from "./host-tool-permissions.js";

export type ApprovalStatus = "pending" | "allowed" | "denied" | "expired" | "consumed";
export type ApprovalDecision = "allow-once" | "always" | "deny" | "never";
export type ApprovalSource = "bot" | "background-shell" | "send-input";

export type ApprovalRow = {
  id: string;
  userId: string;
  deviceId: string;
  action: HostToolAction;
  target: string;
  payload: Record<string, unknown>;
  source: ApprovalSource;
  refId: string | null;
  status: ApprovalStatus;
  decision: ApprovalDecision | null;
  createdAt: Date;
  expiresAt: Date;
  decidedAt: Date | null;
};

export type NewApproval = Pick<ApprovalRow, "userId" | "deviceId" | "action" | "target" | "payload" | "source" | "refId"> & {
  ttlMs?: number;
};

export interface ApprovalStore {
  insert(row: ApprovalRow): Promise<void>;
  get(id: string): Promise<ApprovalRow | null>;
  listPending(userId: string, now: Date): Promise<ApprovalRow[]>;
  /** pending and not expired -> status; returns the updated row or null when nothing changed. */
  decide(id: string, userId: string, status: "allowed" | "denied", decision: ApprovalDecision, now: Date): Promise<ApprovalRow | null>;
  /** allowed -> consumed, exactly once. */
  claim(id: string): Promise<boolean>;
  /** pending rows past expires_at -> expired; returns them. */
  expireDue(now: Date): Promise<ApprovalRow[]>;
}

export const DEFAULT_APPROVAL_TTL_MS = 10 * 60_000;

export function approvalTtlMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number(env.RAKAZO_HOST_APPROVAL_TTL_MS);
  const ms = Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_APPROVAL_TTL_MS;
  return Math.min(Math.max(ms, 30_000), 60 * 60_000);
}

// ---------------------------------------------------------------------------------------------
// Postgres store (additive table, created on first use)

type DbRow = {
  id: string;
  user_id: string;
  device_id: string;
  action: string;
  target: string;
  payload: string;
  source: string;
  ref_id: string | null;
  status: string;
  decision: string | null;
  created_at: Date;
  expires_at: Date;
  decided_at: Date | null;
};

const COLS = "id, user_id, device_id, action, target, payload, source, ref_id, status, decision, created_at, expires_at, decided_at";

function fromDb(r: DbRow): ApprovalRow {
  let payload: Record<string, unknown> = {};
  try {
    payload = JSON.parse(r.payload) as Record<string, unknown>;
  } catch {
    payload = {};
  }
  return {
    id: r.id,
    userId: r.user_id,
    deviceId: r.device_id,
    action: r.action as HostToolAction,
    target: r.target,
    payload,
    source: r.source as ApprovalSource,
    refId: r.ref_id,
    status: r.status as ApprovalStatus,
    decision: (r.decision as ApprovalDecision | null) ?? null,
    createdAt: new Date(r.created_at),
    expiresAt: new Date(r.expires_at),
    decidedAt: r.decided_at ? new Date(r.decided_at) : null,
  };
}

const tablesReady = new WeakMap<PrismaClient, Promise<void>>();

function ensureApprovalTable(prisma: PrismaClient): Promise<void> {
  let p = tablesReady.get(prisma);
  if (!p) {
    p = (async () => {
      await prisma.$executeRawUnsafe(`CREATE TABLE IF NOT EXISTS host_tool_pending_approvals (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
        device_id TEXT NOT NULL REFERENCES local_runner_devices(id) ON DELETE CASCADE,
        action TEXT NOT NULL,
        target TEXT NOT NULL DEFAULT '',
        payload TEXT NOT NULL DEFAULT '{}',
        source TEXT NOT NULL,
        ref_id TEXT,
        status TEXT NOT NULL DEFAULT 'pending',
        decision TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        expires_at TIMESTAMPTZ NOT NULL,
        decided_at TIMESTAMPTZ
      )`);
      await prisma.$executeRawUnsafe(
        `CREATE INDEX IF NOT EXISTS host_tool_pending_approvals_user_idx
         ON host_tool_pending_approvals (user_id, status, expires_at)`,
      );
    })().catch((error) => {
      tablesReady.delete(prisma);
      throw error;
    });
    tablesReady.set(prisma, p);
  }
  return p;
}

export function postgresApprovalStore(prisma: PrismaClient): ApprovalStore {
  const q = async <T>(sql: string, ...params: unknown[]) => {
    await ensureApprovalTable(prisma);
    return prisma.$queryRawUnsafe<T>(sql, ...params);
  };
  return {
    async insert(row) {
      await ensureApprovalTable(prisma);
      await prisma.$executeRawUnsafe(
        `INSERT INTO host_tool_pending_approvals
           (id, user_id, device_id, action, target, payload, source, ref_id, status, created_at, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'pending', $9, $10)`,
        row.id,
        row.userId,
        row.deviceId,
        row.action,
        row.target,
        JSON.stringify(row.payload),
        row.source,
        row.refId,
        row.createdAt,
        row.expiresAt,
      );
    },
    async get(id) {
      const rows = await q<DbRow[]>(`SELECT ${COLS} FROM host_tool_pending_approvals WHERE id = $1`, id);
      return rows[0] ? fromDb(rows[0]) : null;
    },
    async listPending(userId, now) {
      const rows = await q<DbRow[]>(
        `SELECT ${COLS} FROM host_tool_pending_approvals
         WHERE user_id = $1 AND status = 'pending' AND expires_at > $2
         ORDER BY created_at ASC LIMIT 50`,
        userId,
        now,
      );
      return rows.map(fromDb);
    },
    async decide(id, userId, status, decision, now) {
      const rows = await q<DbRow[]>(
        `UPDATE host_tool_pending_approvals
         SET status = $3, decision = $4, decided_at = $5
         WHERE id = $1 AND user_id = $2 AND status = 'pending' AND expires_at > $5
         RETURNING ${COLS}`,
        id,
        userId,
        status,
        decision,
        now,
      );
      return rows[0] ? fromDb(rows[0]) : null;
    },
    async claim(id) {
      const rows = await q<Array<{ id: string }>>(
        `UPDATE host_tool_pending_approvals SET status = 'consumed'
         WHERE id = $1 AND status = 'allowed' RETURNING id`,
        id,
      );
      return rows.length === 1;
    },
    async expireDue(now) {
      const rows = await q<DbRow[]>(
        `UPDATE host_tool_pending_approvals SET status = 'expired', decided_at = $1
         WHERE status = 'pending' AND expires_at <= $1
         RETURNING ${COLS}`,
        now,
      );
      return rows.map(fromDb);
    },
  };
}

/** In-memory store (tests, and the shape the Postgres store must match). */
export function memoryApprovalStore(): ApprovalStore & { rows: Map<string, ApprovalRow> } {
  const rows = new Map<string, ApprovalRow>();
  const copy = (r: ApprovalRow) => ({ ...r, payload: { ...r.payload } });
  return {
    rows,
    async insert(row) {
      rows.set(row.id, copy(row));
    },
    async get(id) {
      const r = rows.get(id);
      return r ? copy(r) : null;
    },
    async listPending(userId, now) {
      return [...rows.values()].filter((r) => r.userId === userId && r.status === "pending" && r.expiresAt > now).map(copy);
    },
    async decide(id, userId, status, decision, now) {
      const r = rows.get(id);
      if (!r || r.userId !== userId || r.status !== "pending" || r.expiresAt <= now) return null;
      Object.assign(r, { status, decision, decidedAt: now });
      return copy(r);
    },
    async claim(id) {
      const r = rows.get(id);
      if (!r || r.status !== "allowed") return false;
      r.status = "consumed";
      return true;
    },
    async expireDue(now) {
      const out: ApprovalRow[] = [];
      for (const r of rows.values()) {
        if (r.status === "pending" && r.expiresAt <= now) {
          Object.assign(r, { status: "expired", decidedAt: now });
          out.push(copy(r));
        }
      }
      return out;
    },
  };
}

const stores = new WeakMap<object, ApprovalStore>();

/** Use a specific store for this prisma client (tests). */
export function bindApprovalStore(prisma: object, store: ApprovalStore): void {
  stores.set(prisma, store);
}

export function approvalStore(prisma: PrismaClient): ApprovalStore {
  let s = stores.get(prisma);
  if (!s) {
    s = postgresApprovalStore(prisma);
    stores.set(prisma, s);
  }
  return s;
}

// ---------------------------------------------------------------------------------------------
// Handlers (resume / finalize) and in-process waiters

export type ApprovalHandler = {
  /** Called once after the owner allowed it; must claim() before running the action. */
  onAllowed: (row: ApprovalRow) => Promise<Record<string, unknown> | void>;
  /** Called after deny or expiry. */
  onFinal: (row: ApprovalRow) => Promise<void>;
};

const handlers = new Map<ApprovalSource, ApprovalHandler>();
const waiters = new Map<string, Set<(row: ApprovalRow) => void>>();

export function registerApprovalHandler(source: ApprovalSource, handler: ApprovalHandler): void {
  handlers.set(source, handler);
}

function notify(row: ApprovalRow): void {
  for (const w of waiters.get(row.id) ?? []) w(row);
}

export async function requestApproval(prisma: PrismaClient, input: NewApproval, now = new Date()): Promise<ApprovalRow> {
  const ttl = input.ttlMs ?? approvalTtlMs();
  const row: ApprovalRow = {
    id: randomUUID(),
    userId: input.userId,
    deviceId: input.deviceId,
    action: input.action,
    target: input.target.slice(0, 4000),
    payload: input.payload,
    source: input.source,
    refId: input.refId,
    status: "pending",
    decision: null,
    createdAt: now,
    expiresAt: new Date(now.getTime() + ttl),
    decidedAt: null,
  };
  await approvalStore(prisma).insert(row);
  return row;
}

export async function listPendingApprovals(prisma: PrismaClient, userId: string): Promise<ApprovalRow[]> {
  await sweepExpiredApprovals(prisma);
  return approvalStore(prisma).listPending(userId, new Date());
}

export async function sweepExpiredApprovals(prisma: PrismaClient, now = new Date()): Promise<ApprovalRow[]> {
  const expired = await approvalStore(prisma).expireDue(now);
  for (const row of expired) {
    notify(row);
    await handlers.get(row.source)?.onFinal(row).catch(() => undefined);
  }
  return expired;
}

export type DecideResult =
  | { ok: true; approval: ApprovalRow; resumed?: Record<string, unknown> }
  | { ok: false; status: 400 | 404 | 409 | 410; error: string; approval?: ApprovalRow };

export function isApprovalDecision(v: unknown): v is ApprovalDecision {
  return v === "allow-once" || v === "always" || v === "deny" || v === "never";
}

export async function decideApproval(
  prisma: PrismaClient,
  input: { id: string; userId: string; decision: ApprovalDecision },
  now = new Date(),
): Promise<DecideResult> {
  const store = approvalStore(prisma);
  const allowed = input.decision === "allow-once" || input.decision === "always";
  const row = await store.decide(input.id, input.userId, allowed ? "allowed" : "denied", input.decision, now);
  if (!row) {
    const existing = await store.get(input.id);
    if (!existing || existing.userId !== input.userId) return { ok: false, status: 404, error: "Approval not found" };
    if (existing.status === "pending" && existing.expiresAt <= now) {
      await sweepExpiredApprovals(prisma, now);
      return { ok: false, status: 410, error: "This approval expired.", approval: { ...existing, status: "expired" } };
    }
    if (existing.status === "expired") return { ok: false, status: 410, error: "This approval expired.", approval: existing };
    return { ok: false, status: 409, error: `This approval was already ${existing.status}.`, approval: existing };
  }
  if (input.decision === "always" || input.decision === "never") {
    await recordStandingGrant(prisma, {
      id: randomUUID(),
      userId: row.userId,
      deviceId: row.deviceId,
      action: row.action,
      grant: input.decision,
      target: row.target || undefined,
    });
  }
  notify(row);
  const handler = handlers.get(row.source);
  if (!handler) return { ok: true, approval: row };
  if (allowed) {
    const resumed = await handler.onAllowed(row);
    return { ok: true, approval: row, resumed: resumed ?? undefined };
  }
  await handler.onFinal(row);
  return { ok: true, approval: row };
}

/** Atomically use an allowed approval (single use). */
export function claimApproval(prisma: PrismaClient, id: string): Promise<boolean> {
  return approvalStore(prisma).claim(id);
}

/**
 * Wait until the approval is decided or expires. Wakes immediately for decisions made in this
 * process and polls the store for decisions made elsewhere (e.g. api vs worker).
 */
export async function waitForApproval(
  prisma: PrismaClient,
  id: string,
  opts: { pollMs?: number; signal?: AbortSignal } = {},
): Promise<ApprovalRow> {
  const store = approvalStore(prisma);
  const pollMs = opts.pollMs ?? 1_000;
  for (;;) {
    const row = await store.get(id);
    if (!row) throw new Error("Approval not found");
    if (row.status !== "pending") return row;
    if (row.expiresAt.getTime() <= Date.now()) {
      await sweepExpiredApprovals(prisma);
      const after = await store.get(id);
      if (after && after.status !== "pending") return after;
    }
    if (opts.signal?.aborted) throw new Error("Aborted while waiting for approval");
    const delay = Math.max(10, Math.min(pollMs, row.expiresAt.getTime() - Date.now() + 5));
    await new Promise<void>((resolve) => {
      const set = waiters.get(id) ?? new Set();
      waiters.set(id, set);
      const done = () => {
        clearTimeout(timer);
        set.delete(done);
        if (set.size === 0) waiters.delete(id);
        opts.signal?.removeEventListener("abort", done);
        resolve();
      };
      const timer = setTimeout(done, delay);
      set.add(done);
      opts.signal?.addEventListener("abort", done, { once: true });
    });
  }
}

export function approvalView(row: ApprovalRow): Record<string, unknown> {
  return {
    id: row.id,
    action: row.action,
    target: row.target,
    deviceId: row.deviceId,
    source: row.source,
    refId: row.refId,
    status: row.status,
    decision: row.decision,
    createdAt: row.createdAt.toISOString(),
    expiresAt: row.expiresAt.toISOString(),
    decidedAt: row.decidedAt?.toISOString() ?? null,
  };
}
