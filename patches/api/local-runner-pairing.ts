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
