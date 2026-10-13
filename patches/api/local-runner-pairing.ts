/**
 * Rakijazios M2a: pure helpers for one-time pairing codes and device input.
 * No I/O here so the rules are unit-testable.
 */
import { randomInt } from "node:crypto";

/** Crockford base32: no I, L, O, U, so codes are easy to read aloud and type. */
export const CODE_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
export const CODE_LENGTH = 8; // 40 bits
export const PAIRING_TTL_MS = 10 * 60_000;
export const MAX_DEVICES_PER_USER = 10;
export const MAX_MODELS_PER_DEVICE = 200;
export const MAX_MODEL_ID_LENGTH = 200;

export function generatePairingCode(): string {
  let out = "";
  for (let i = 0; i < CODE_LENGTH; i++) out += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
  return out;
}

/** "K7QF3MZD" → "K7QF-3MZD" */
export function formatPairingCode(code: string): string {
  return `${code.slice(0, 4)}-${code.slice(4)}`;
}

/** Upper-case, drop separators/spaces, map look-alikes (O→0, I/L→1). Null when invalid. */
export function normalizePairingCode(raw: unknown): string | null {
  if (typeof raw !== "string" || raw.length > 32) return null;
  const s = raw
    .toUpperCase()
    .replace(/[\s-]/g, "")
    .replace(/O/g, "0")
    .replace(/[IL]/g, "1");
  if (s.length !== CODE_LENGTH) return null;
  for (const ch of s) if (!CODE_ALPHABET.includes(ch)) return null;
  return s;
}

/** Device names are shown back to their owner only; keep them short and printable. */
export function sanitizeDeviceName(raw: unknown, fallback = "My computer"): string {
  if (typeof raw !== "string") return fallback;
  // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping control characters
  const s = raw.replace(/[\u0000-\u001f\u007f<>]/g, "").replace(/\s+/g, " ").trim().slice(0, 64);
  return s || fallback;
}

export function sanitizeShort(raw: unknown, max = 64): string | null {
  if (typeof raw !== "string") return null;
  // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping control characters
  const s = raw.replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, max);
  return s || null;
}

export type AdvertisedModel = { id: string; contextWindow: number | null };

/** Bound and clean a runner's advertised model list (hello / models frames). */
export function sanitizeAdvertisedModels(raw: unknown): AdvertisedModel[] {
  if (!Array.isArray(raw)) return [];
  const out: AdvertisedModel[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    const id = typeof item === "string" ? item : item && typeof item === "object" ? (item as { id?: unknown }).id : null;
    if (typeof id !== "string") continue;
    const trimmed = id.trim();
    if (!trimmed || trimmed.length > MAX_MODEL_ID_LENGTH || !/^[\x21-\x7e]+$/.test(trimmed)) continue;
    if (seen.has(trimmed)) continue;
    seen.add(trimmed);
    const ctx = item && typeof item === "object" ? (item as { contextWindow?: unknown }).contextWindow : null;
    out.push({
      id: trimmed,
      contextWindow: typeof ctx === "number" && Number.isSafeInteger(ctx) && ctx > 0 && ctx < 10_000_000 ? ctx : null,
    });
    if (out.length >= MAX_MODELS_PER_DEVICE) break;
  }
  return out;
}

export type PairingOs = "linux" | "macos" | "windows";
export function normalizeOs(raw: unknown): PairingOs | null {
  return raw === "linux" || raw === "macos" || raw === "windows" ? raw : null;
}

/** ws(s) URL for runners, derived from the public web origin unless configured. */
export function gatewayWsUrlFor(webOrigin: string, override?: string): string {
  if (override?.trim()) return override.trim();
  const url = new URL(webOrigin);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = "/api/local-runners/ws";
  url.search = "";
  url.hash = "";
  return url.toString();
}

/**
 * Simple fixed-window limiter for failed pairing attempts. In-memory is fine for the
 * single api instance (see O2); a restart only resets the window.
 */
export class FailureLimiter {
  private readonly hits = new Map<string, { count: number; resetAt: number }>();
  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
  ) {}
  blocked(key: string, now = Date.now()): boolean {
    const h = this.hits.get(key);
    return Boolean(h && h.resetAt > now && h.count >= this.limit);
  }
  fail(key: string, now = Date.now()): void {
    const h = this.hits.get(key);
    if (!h || h.resetAt <= now) this.hits.set(key, { count: 1, resetAt: now + this.windowMs });
    else h.count += 1;
    if (this.hits.size > 10_000) {
      for (const [k, v] of this.hits) if (v.resetAt <= now) this.hits.delete(k);
    }
  }
}

// ---------------------------------------------------------------------------
// Rakijazios M2b: who may use a shared-local bot right now.
// The gateway loads one row per request (run + bot + thread + binding + computer
// + model) and this pure function decides. Every refusal carries a type the
// executor turns into a readable chat notice; nothing falls back to another model.
// ---------------------------------------------------------------------------

export type SharedLocalAccessRow = {
  bot_id: string;
  run_user_id: string;
  run_status: string;
  run_trigger: string;
  bot_user_id: string;
  bot_model_provider: string | null;
  bot_model_id: string | null;
  bot_archived: boolean;
  thread_group_id: string | null;
  /** The bot whose 1:1 thread this is (null for group threads). */
  thread_bot_id: string | null;
  thread_external: boolean;
  group_share_count: number;
  /** M2c: a grant (bot, group) by the owner of both exists. */
  group_granted: boolean;
  bind_device_id: string | null;
  bind_model_id: string | null;
  device_user_id: string | null;
  device_status: string | null;
  device_enabled: boolean | null;
  model_enabled: boolean | null;
  model_advertised: boolean | null;
  /** M3: the person this run answers (a shared group's sender), else the run user. */
  consumer_user_id?: string | null;
  model_context_window: number | null;
};

export type SharedLocalDenyType =
  | "shared_local_run_ended"
  | "shared_local_unbound"
  | "shared_local_removed"
  | "shared_local_paused"
  | "shared_local_model_off"
  | "shared_local_group_denied"
  | "shared_local_thread_denied"
  | "shared_local_external_denied";

export type SharedLocalAccess =
  | {
      ok: true;
      deviceId: string;
      modelId: string;
      contextWindow: number | null;
      botId: string;
      groupId: string | null;
    }
  | { ok: false; status: number; type: SharedLocalDenyType; message: string };

/** Triggers that answer outside Rakazo chat (bridged channels, inbound webhooks). */
const EXTERNAL_TRIGGERS = new Set(["messaging", "webhook"]);
const LIVE_RUN = new Set(["leased", "running"]);

function deny(status: number, type: SharedLocalDenyType, message: string): SharedLocalAccess {
  return { ok: false, status, type, message: `[${type}] ${message}` };
}

export function decideSharedLocalAccess(
  ownerUserId: string,
  row: SharedLocalAccessRow | undefined,
  requestedModel?: string,
): SharedLocalAccess {
  if (!row || row.run_user_id !== ownerUserId || !LIVE_RUN.has(row.run_status)) {
    return deny(401, "shared_local_run_ended", "This run has ended.");
  }
  if (row.bot_user_id !== ownerUserId || row.bot_archived || row.bot_model_provider !== "shared-local") {
    return deny(403, "shared_local_unbound", "This bot no longer runs on its owner's computer.");
  }
  if (row.thread_external || EXTERNAL_TRIGGERS.has(row.run_trigger)) {
    return deny(403, "shared_local_external_denied", "Bots on a personal computer don't answer in external channels.");
  }
  // M2c (plan §6, fails closed): the bot's own 1:1 chat; a group nobody else can see;
  // or a shared group the owner granted this bot. Anything else is refused.
  if (row.thread_group_id) {
    if (row.group_share_count > 0 && !row.group_granted) {
      return deny(403, "shared_local_group_denied", "This bot runs on its owner's computer and isn't enabled for this shared group.");
    }
  } else if (row.thread_bot_id !== row.bot_id) {
    return deny(403, "shared_local_thread_denied", "This bot only answers in its owner's chats and groups.");
  }
  if (!row.bind_device_id || !row.bind_model_id) {
    return deny(403, "shared_local_unbound", "This bot isn't connected to a computer yet.");
  }
  if (row.device_user_id !== ownerUserId || row.device_status !== "active") {
    return deny(403, "shared_local_removed", "The computer this bot used was removed.");
  }
  if (row.device_enabled === false) {
    return deny(503, "shared_local_paused", "The owner's computer is paused.");
  }
  if (row.bot_model_id !== row.bind_model_id || (requestedModel && requestedModel !== row.bind_model_id)) {
    return deny(403, "shared_local_model_off", "This bot's model changed. Pick the model again under My hardware.");
  }
  if (!row.model_enabled) {
    return deny(403, "shared_local_model_off", "This model is switched off on the owner's computer.");
  }
  if (!row.model_advertised) {
    return deny(403, "shared_local_model_off", "The owner's computer doesn't offer this model right now.");
  }
  return {
    ok: true,
    deviceId: row.bind_device_id,
    modelId: row.bind_model_id,
    contextWindow: row.model_context_window,
    botId: row.bot_id,
    groupId: row.thread_group_id,
  };
}
