import { describe, expect, it } from "vitest";
import {
  CODE_ALPHABET,
  FailureLimiter,
  formatPairingCode,
  gatewayWsUrlFor,
  generatePairingCode,
  normalizeOs,
  normalizePairingCode,
  sanitizeAdvertisedModels,
  sanitizeDeviceName,
} from "./local-runner-pairing.js";

describe("pairing codes", () => {
  it("are 8 Crockford base32 characters and round-trip through formatting", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 200; i++) {
      const code = generatePairingCode();
      expect(code).toHaveLength(8);
      for (const ch of code) expect(CODE_ALPHABET).toContain(ch);
      expect(normalizePairingCode(formatPairingCode(code))).toBe(code);
      seen.add(code);
    }
    expect(seen.size).toBeGreaterThan(195);
  });

  it("normalizes look-alikes and rejects bad input", () => {
    expect(normalizePairingCode("k7qf-3mzo")).toBe("K7QF3MZ0");
    expect(normalizePairingCode("il00 0000")).toBe("11000000");
    expect(normalizePairingCode("K7QF-3MZ")).toBeNull();
    expect(normalizePairingCode("K7QF-3MZU")).toBeNull();
    expect(normalizePairingCode(12345678)).toBeNull();
    expect(normalizePairingCode("x".repeat(100))).toBeNull();
  });
});

describe("device input", () => {
  it("cleans names", () => {
    expect(sanitizeDeviceName("  My <b>PC</b>\n ")).toBe("My bPC/b");
    expect(sanitizeDeviceName("")).toBe("My computer");
    expect(sanitizeDeviceName(null)).toBe("My computer");
    expect(sanitizeDeviceName("x".repeat(100))).toHaveLength(64);
  });

  it("bounds advertised models", () => {
    const many = Array.from({ length: 300 }, (_, i) => ({ id: `m${i}`, contextWindow: 4096 }));
    expect(sanitizeAdvertisedModels(many)).toHaveLength(200);
    expect(
      sanitizeAdvertisedModels(["gemma", "gemma", "bad id", { id: "q", contextWindow: -1 }, { id: 5 }, null]),
    ).toEqual([
      { id: "gemma", contextWindow: null },
      { id: "q", contextWindow: null },
    ]);
    expect(sanitizeAdvertisedModels("nope")).toEqual([]);
  });

  it("accepts only known OSes", () => {
    expect(normalizeOs("windows")).toBe("windows");
    expect(normalizeOs("android")).toBeNull();
  });

  it("derives the runner WS URL from the web origin", () => {
    expect(gatewayWsUrlFor("http://127.0.0.1:5173")).toBe("ws://127.0.0.1:5173/api/local-runners/ws");
    expect(gatewayWsUrlFor("https://rakijazios.example/")).toBe("wss://rakijazios.example/api/local-runners/ws");
    expect(gatewayWsUrlFor("http://127.0.0.1:5173", "ws://127.0.0.1:3100/api/local-runners/ws")).toBe(
      "ws://127.0.0.1:3100/api/local-runners/ws",
    );
  });
});

describe("FailureLimiter", () => {
  it("blocks after the limit inside the window and resets after it", () => {
    const l = new FailureLimiter(3, 1000);
    for (let i = 0; i < 3; i++) l.fail("a", 0);
    expect(l.blocked("a", 10)).toBe(true);
    expect(l.blocked("b", 10)).toBe(false);
    expect(l.blocked("a", 1001)).toBe(false);
  });
});
