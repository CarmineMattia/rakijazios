import { describe, expect, it } from "vitest";
import { DEFAULT_LIMITS, decideLimit, normalizeLimits, usageFromSseLine } from "./local-runners.js";

const base = { limits: { ...DEFAULT_LIMITS, maxConcurrent: 2, perUserPerMinute: 3, dailyRequestCap: 5 }, inFlight: 0, isOwner: false, recentRequests: 0, todayPeerRequests: 0 };

describe("M3 limits", () => {
  it("concurrency applies to everyone, including the owner", () => {
    expect(decideLimit({ ...base, inFlight: 2 })).toBe("busy");
    expect(decideLimit({ ...base, inFlight: 2, isOwner: true })).toBe("busy");
    expect(decideLimit({ ...base, inFlight: 1 })).toBeNull();
  });
  it("per-person rate and daily cap apply to other people only", () => {
    expect(decideLimit({ ...base, recentRequests: 3 })).toBe("rate_limited");
    expect(decideLimit({ ...base, recentRequests: 2 })).toBeNull();
    expect(decideLimit({ ...base, todayPeerRequests: 5 })).toBe("daily_cap");
    expect(decideLimit({ ...base, recentRequests: 99, todayPeerRequests: 99, isOwner: true })).toBeNull();
    expect(decideLimit({ ...base, limits: { ...base.limits, dailyRequestCap: null }, todayPeerRequests: 1e6 })).toBeNull();
  });
  it("validates owner updates and keeps unspecified fields", () => {
    expect(normalizeLimits({})).toEqual(DEFAULT_LIMITS);
    expect(normalizeLimits({ perUserPerMinute: 5 })).toEqual({ ...DEFAULT_LIMITS, perUserPerMinute: 5 });
    expect(normalizeLimits({ dailyRequestCap: 100 }, { ...DEFAULT_LIMITS, maxConcurrent: 4 })).toEqual({ ...DEFAULT_LIMITS, maxConcurrent: 4, dailyRequestCap: 100 });
    expect(normalizeLimits({ dailyRequestCap: null }, { ...DEFAULT_LIMITS, dailyRequestCap: 9 })).toEqual(DEFAULT_LIMITS);
    expect(normalizeLimits({ maxConcurrent: 0 })).toMatch(/1 to 8/);
    expect(normalizeLimits({ maxConcurrent: 9 })).toMatch(/1 to 8/);
    expect(normalizeLimits({ perUserPerMinute: 1.5 })).toMatch(/whole number/);
    expect(normalizeLimits({ dailyRequestCap: "10" })).toMatch(/whole number/);
  });
  it("reads token usage from the final streamed chunk", () => {
    expect(usageFromSseLine('data: {"choices":[],"usage":{"prompt_tokens":12,"completion_tokens":34,"total_tokens":46}}')).toEqual({ input: 12, output: 34 });
    expect(usageFromSseLine('data: {"choices":[{"delta":{"content":"hi"}}]}')).toBeNull();
    expect(usageFromSseLine("data: [DONE]")).toBeNull();
    expect(usageFromSseLine('data: {"usage": broken')).toBeNull();
  });
});

describe("M3b caps", () => {
  it("per-person daily cap and token cap apply to other people only", () => {
    const limits = { ...DEFAULT_LIMITS, personDailyCap: 2, dailyTokenCap: 5000 };
    const b = { limits, inFlight: 0, isOwner: false, recentRequests: 0, todayPeerRequests: 0 };
    expect(decideLimit({ ...b, todayPersonRequests: 1 })).toBeNull();
    expect(decideLimit({ ...b, todayPersonRequests: 2 })).toBe("person_cap");
    expect(decideLimit({ ...b, todayPeerTokens: 4999 })).toBeNull();
    expect(decideLimit({ ...b, todayPeerTokens: 5000 })).toBe("daily_cap");
    expect(decideLimit({ ...b, isOwner: true, todayPersonRequests: 99, todayPeerTokens: 1e9 })).toBeNull();
  });
  it("validates and clears the new caps", () => {
    expect(normalizeLimits({ personDailyCap: 10, dailyTokenCap: 20000 })).toEqual({ ...DEFAULT_LIMITS, personDailyCap: 10, dailyTokenCap: 20000 });
    expect(normalizeLimits({ dailyTokenCap: 999 })).toMatch(/1000 to 1000000000/);
    expect(normalizeLimits({ personDailyCap: 0 })).toMatch(/1 to 100000/);
    expect(normalizeLimits({ personDailyCap: null, dailyTokenCap: "" }, { ...DEFAULT_LIMITS, personDailyCap: 3, dailyTokenCap: 9000 })).toEqual(DEFAULT_LIMITS);
  });
  it("reads limits rows, old rows without the new columns included", async () => {
    const { limitsFromRow } = await import("./local-runners.js");
    expect(limitsFromRow(undefined)).toEqual(DEFAULT_LIMITS);
    expect(limitsFromRow({ max_concurrent: 3, per_user_per_minute: 5, daily_request_cap: null })).toEqual({ ...DEFAULT_LIMITS, maxConcurrent: 3, perUserPerMinute: 5 });
    expect(limitsFromRow({ max_concurrent: 1, per_user_per_minute: 1, daily_request_cap: 7, person_daily_cap: 2, daily_token_cap: 1000 })).toEqual({ maxConcurrent: 1, perUserPerMinute: 1, dailyRequestCap: 7, personDailyCap: 2, dailyTokenCap: 1000 });
  });
});
