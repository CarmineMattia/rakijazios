import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  hashDeviceToken,
  mintSharedLocalRunToken,
  SHARED_LOCAL_TOKEN_MAX_SEC,
  verifySharedLocalRunToken,
} from "./shared-local-token.js";

describe("shared-local run token (sl2)", () => {
  beforeEach(() => vi.useRealTimers());
  afterEach(() => vi.useRealTimers());

  it("round-trips owner and run", () => {
    const token = mintSharedLocalRunToken("user_123", "run-abc", 60);
    expect(token.startsWith("sl2.")).toBe(true);
    expect(verifySharedLocalRunToken(token)).toMatchObject({ ownerUserId: "user_123", runId: "run-abc" });
  });

  it("rejects a tampered owner or run id", () => {
    const token = mintSharedLocalRunToken("user_123", "run-abc", 60);
    const [v, , run, exp, sig] = token.split(".");
    expect(verifySharedLocalRunToken(`${v}.user_999.${run}.${exp}.${sig}`)).toBeNull();
    const [v2, owner, , exp2, sig2] = token.split(".");
    expect(verifySharedLocalRunToken(`${v2}.${owner}.run-other.${exp2}.${sig2}`)).toBeNull();
  });

  it("rejects forged, malformed and old sl1 tokens", () => {
    expect(verifySharedLocalRunToken("sl2.user_123.run.9999999999.forged")).toBeNull();
    expect(verifySharedLocalRunToken("sl1.user_123.9999999999.sig")).toBeNull();
    expect(verifySharedLocalRunToken("garbage")).toBeNull();
    expect(verifySharedLocalRunToken("")).toBeNull();
  });

  it("refuses ids with separators", () => {
    expect(() => mintSharedLocalRunToken("a.b", "run")).toThrow();
    expect(() => mintSharedLocalRunToken("user", "r.1")).toThrow();
  });

  it("expires, and caps the ttl at the 12h ceiling", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    const short = mintSharedLocalRunToken("user_123", "run", 60);
    const long = mintSharedLocalRunToken("user_123", "run", 10 * SHARED_LOCAL_TOKEN_MAX_SEC);
    expect(Number(long.split(".")[3]) - Date.now() / 1000).toBe(SHARED_LOCAL_TOKEN_MAX_SEC);
    vi.setSystemTime(new Date("2026-01-01T00:02:00Z"));
    expect(verifySharedLocalRunToken(short)).toBeNull();
    expect(verifySharedLocalRunToken(long)).not.toBeNull();
  });

  it("hashes device tokens deterministically without echoing them", () => {
    const hash = hashDeviceToken("secret-token");
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hash).toBe(hashDeviceToken("secret-token"));
    expect(hash).not.toContain("secret-token");
  });
});
