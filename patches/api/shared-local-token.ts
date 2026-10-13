/**
 * shared-local provider helpers (M1, run-bound since M2b).
 * Worker mints an HMAC bearer bound to one run; the api gateway verifies it and
 * re-checks the run, bot, binding and computer in the database on every request.
 * Keyed by a sub-key derived from ENCRYPTION_KEY (present on api and worker;
 * the worker deliberately has no BETTER_AUTH_SECRET). The derived key is used
 * only for these tokens, so the raw encryption key never signs anything.
 */
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { resolveEncryptionKey } from "@rakazo/core";

export const SHARED_LOCAL_PROVIDER_ID = "shared-local";

export const SHARED_LOCAL_GATEWAY_URL_ENV = "RAKAZO_SHARED_LOCAL_GATEWAY_URL";
export const SHARED_LOCAL_MODELS_ENV = "RAKAZO_SHARED_LOCAL_MODELS";

// M2b: sl2 tokens are bound to one run. sl1 (owner-only, 1h) is no longer accepted.
const TOKEN_PREFIX = "sl2";

let signingKeyCache: Buffer | undefined;
function signingSecret(): Buffer {
  signingKeyCache ??= createHmac("sha256", resolveEncryptionKey(process.env))
    .update("rakazo:shared-local-gateway-token:v2")
    .digest();
  return signingKeyCache;
}

/** M1 compatibility only: models switched on for operator-seeded computers. */
export function sharedLocalModelIds(): string[] {
  return (process.env[SHARED_LOCAL_MODELS_ENV] ?? "")
    .split(",")
    .map((id) => id.trim())
    .filter((id) => id.length > 0);
}

export function sharedLocalGatewayBaseUrl(): string {
  const value =
    process.env[SHARED_LOCAL_GATEWAY_URL_ENV]?.trim() ||
    "http://api:3100/api/local-runners/v1";
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${SHARED_LOCAL_GATEWAY_URL_ENV} must be an absolute HTTP(S) URL`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`${SHARED_LOCAL_GATEWAY_URL_ENV} must be an absolute HTTP(S) URL`);
  }
  return value.replace(/\/+$/, "");
}

/**
 * Rakijazios M2b: hard ceiling for one run token. The real limit is the run
 * itself: the gateway re-checks on every request that the run is still
 * leased/running, so the token dies the moment the run ends.
 */
export const SHARED_LOCAL_TOKEN_MAX_SEC = 12 * 60 * 60;

const ID_RE = /^[A-Za-z0-9_-]{1,128}$/;

/** Mint a run-bound bearer: `sl2.<ownerUserId>.<runId>.<exp>.<hmac>`. */
export function mintSharedLocalRunToken(
  ownerUserId: string,
  runId: string,
  ttlSec = SHARED_LOCAL_TOKEN_MAX_SEC,
): string {
  if (!ID_RE.test(ownerUserId)) throw new Error("Invalid ownerUserId for shared-local token");
  if (!ID_RE.test(runId)) throw new Error("Invalid runId for shared-local token");
  const ttl = Math.max(1, Math.min(Math.floor(ttlSec), SHARED_LOCAL_TOKEN_MAX_SEC));
  const exp = Math.floor(Date.now() / 1000) + ttl;
  const payload = `${TOKEN_PREFIX}.${ownerUserId}.${runId}.${exp}`;
  const sig = createHmac("sha256", signingSecret()).update(payload).digest("base64url");
  return `${payload}.${sig}`;
}

/** Signature + expiry only. The gateway must still check the run in the DB. */
export function verifySharedLocalRunToken(
  token: string,
): { ownerUserId: string; runId: string; exp: number } | null {
  if (token.length > 512) return null;
  const parts = token.split(".");
  if (parts.length !== 5) return null;
  const [ver, ownerUserId, runId, expStr, sig] = parts as [string, string, string, string, string];
  if (ver !== TOKEN_PREFIX || !ID_RE.test(ownerUserId) || !ID_RE.test(runId) || !sig) return null;
  if (!/^[0-9]{1,12}$/.test(expStr)) return null;
  const exp = Number(expStr);
  const now = Math.floor(Date.now() / 1000);
  if (exp < now || exp > now + SHARED_LOCAL_TOKEN_MAX_SEC + 60) return null;
  let expected: string;
  try {
    expected = createHmac("sha256", signingSecret())
      .update(`${ver}.${ownerUserId}.${runId}.${expStr}`)
      .digest("base64url");
  } catch {
    return null;
  }
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  return { ownerUserId, runId, exp };
}

export function hashDeviceToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

let pairingKeyCache: Buffer | undefined;
/**
 * Rakijazios M2a: one-time pairing codes are stored as a keyed hash, so a database
 * read alone cannot brute-force the short code space.
 */
export function hashPairingCode(normalizedCode: string): string {
  pairingKeyCache ??= createHmac("sha256", resolveEncryptionKey(process.env))
    .update("rakazo:local-runner-pairing-code:v1")
    .digest();
  return createHmac("sha256", pairingKeyCache).update(normalizedCode).digest("hex");
}
