/**
 * shared-local provider helpers (M1).
 * Worker mints a short-lived HMAC bearer; api gateway verifies it.
 * Keyed by a sub-key derived from ENCRYPTION_KEY (present on api and worker;
 * the worker deliberately has no BETTER_AUTH_SECRET). The derived key is used
 * only for these tokens, so the raw encryption key never signs anything.
 */
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { resolveEncryptionKey } from "@rakazo/core";

export const SHARED_LOCAL_PROVIDER_ID = "shared-local";

export const SHARED_LOCAL_GATEWAY_URL_ENV = "RAKAZO_SHARED_LOCAL_GATEWAY_URL";
export const SHARED_LOCAL_MODELS_ENV = "RAKAZO_SHARED_LOCAL_MODELS";

const TOKEN_PREFIX = "sl1";

let signingKeyCache: Buffer | undefined;
function signingSecret(): Buffer {
  signingKeyCache ??= createHmac("sha256", resolveEncryptionKey(process.env))
    .update("rakazo:shared-local-gateway-token:v1")
    .digest();
  return signingKeyCache;
}

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

/** Mint a bearer token bound to the bot owner's userId. Default TTL 10 minutes. */
export function mintSharedLocalToken(ownerUserId: string, ttlSec = 600): string {
  if (!ownerUserId || ownerUserId.includes(".")) {
    throw new Error("Invalid ownerUserId for shared-local token");
  }
  const exp = Math.floor(Date.now() / 1000) + ttlSec;
  const payload = `${TOKEN_PREFIX}.${ownerUserId}.${exp}`;
  const sig = createHmac("sha256", signingSecret()).update(payload).digest("base64url");
  return `${payload}.${sig}`;
}

export function verifySharedLocalToken(
  token: string,
): { ownerUserId: string; exp: number } | null {
  const parts = token.split(".");
  if (parts.length !== 4) return null;
  const [ver, ownerUserId, expStr, sig] = parts;
  if (ver !== TOKEN_PREFIX || !ownerUserId || !expStr || !sig) return null;
  if (ownerUserId.includes(".") || !/^[0-9]+$/.test(expStr)) return null;
  const exp = Number(expStr);
  if (!Number.isSafeInteger(exp)) return null;
  if (exp < Math.floor(Date.now() / 1000)) return null;
  const payload = `${ver}.${ownerUserId}.${expStr}`;
  let expected: string;
  try {
    expected = createHmac("sha256", signingSecret()).update(payload).digest("base64url");
  } catch {
    return null;
  }
  try {
    const a = Buffer.from(sig);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  } catch {
    return null;
  }
  return { ownerUserId, exp };
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
