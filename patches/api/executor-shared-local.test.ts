import { describe, expect, it } from "vitest";
import { classifySharedLocalFailure } from "./executor.js";

describe("classifySharedLocalFailure", () => {
  it("treats runner/gateway drops mid-answer as offline", () => {
    for (const raw of [
      '503: {"message":"This bot runs on the owner\'s computer, which is offline right now. Try again later.","type":"shared_local_offline"}',
      "Runner disconnected (socket closed)",
      "Connection error.",
      "terminated",
      "TypeError: fetch failed",
      "Inference hard timeout after 600000ms",
      '{"error":{"message":"x","type":"shared_local_disconnected"}}',
    ]) expect(classifySharedLocalFailure(raw), raw).toBe("offline");
  });
  it("recognises a busy runner", () => {
    expect(classifySharedLocalFailure('429: {"type":"shared_local_busy"}')).toBe("busy");
  });
  it("leaves model/content errors alone", () => {
    for (const raw of ["400: context length exceeded", "Tool call failed: bad args", "Run cancelled"]) {
      expect(classifySharedLocalFailure(raw), raw).toBeNull();
    }
  });
});

describe("shared-local refusals (M2b)", () => {
  it("maps typed gateway refusals to readable notices, not offline", async () => {
    const { sharedLocalRefusalKind, sharedLocalRefusalNotice } = await import("./executor.js");
    expect(sharedLocalRefusalKind('403 [shared_local_group_denied] This bot runs…')).toBe("group_denied");
    expect(sharedLocalRefusalKind("shared_local_external_denied")).toBe("external_denied");
    expect(sharedLocalRefusalKind("[shared_local_run_ended] This run has ended.")).toBe("run_ended");
    expect(sharedLocalRefusalKind("[shared_local_thread_denied] x")).toBe("thread_denied");
    expect(sharedLocalRefusalKind("shared_local_offline")).toBeNull();
    expect(sharedLocalRefusalKind("shared_local_busy")).toBeNull();
    expect(sharedLocalRefusalNotice("group_denied", "Chief", "Carmine", "m")).toBe(
      "Chief runs on Carmine's computer and isn't enabled for this shared group.",
    );
    expect(sharedLocalRefusalNotice("paused", "Chief", "Carmine", "m")).toContain("paused");
  });
  it("treats an idle timeout as a drop", () => {
    expect(classifySharedLocalFailure("Inference idle timeout (no tokens for 5 min)")).toBe("offline");
  });
});

describe("M3 limit refusals", () => {
  it("maps rate limit and daily cap to readable notices", async () => {
    const { sharedLocalRefusalKind, sharedLocalRefusalNotice } = await import("./executor.js");
    expect(sharedLocalRefusalKind("[shared_local_rate_limited] Too many requests")).toBe("rate_limited");
    expect(sharedLocalRefusalKind('429 {"type":"shared_local_daily_cap"}')).toBe("daily_cap");
    expect(sharedLocalRefusalNotice("rate_limited", "Bot", "Ann", "m")).toMatch(/Try again in a minute/);
    expect(sharedLocalRefusalNotice("daily_cap", "Bot", "Ann", "m")).toMatch(/Try again tomorrow/);
  });
});
