import { describe, expect, it } from "vitest";
import { runnerSupportsHealth, runnerUpdateAvailable, sanitizeHealth } from "./local-runners.js";

describe("runner health", () => {
  it("only 0.2.3+ runners answer health checks", () => {
    expect(runnerSupportsHealth("0.2.3-health")).toBe(true);
    expect(runnerSupportsHealth("0.3.0")).toBe(true);
    expect(runnerSupportsHealth("1.0.0")).toBe(true);
    expect(runnerSupportsHealth("0.2.2-m2b")).toBe(false);
    expect(runnerSupportsHealth("0.1.9")).toBe(false);
    expect(runnerSupportsHealth("")).toBe(false);
    expect(runnerSupportsHealth(null)).toBe(false);
  });
  it("suggests an update for older runners only", () => {
    expect(runnerUpdateAvailable("0.2.2-m2b")).toBe(true);
    expect(runnerUpdateAvailable("0.2.3-health")).toBe(false);
    expect(runnerUpdateAvailable(null)).toBe(false);
  });
  it("sanitizes what the runner reports", () => {
    const h = sanitizeHealth({
      modelServer: "ollama\n\u0000",
      modelServerOk: "yes",
      models: -4,
      inFlight: 2.4,
      uptimeSec: 99,
      latencyMs: 12.7,
      lastError: "x".repeat(500),
      token: "must-not-be-kept",
    });
    expect(h.modelServer).toBe("ollama");
    expect(h.modelServerOk).toBe(false);
    expect(h.models).toBe(0);
    expect(h.inFlight).toBe(2);
    expect(h.latencyMs).toBe(13);
    expect(h.lastError).toHaveLength(200);
    expect(h).not.toHaveProperty("token");
  });
});
