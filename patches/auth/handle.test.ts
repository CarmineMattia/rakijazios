import { describe, expect, it } from "vitest";
import { handleFromEmail, uniqueHandle } from "./index.js";

describe("magic-link handle", () => {
  it("derives a clean handle from the email local part", () => {
    expect(handleFromEmail("qa3@rakazo.test")).toBe("qa3");
    expect(handleFromEmail("Qa.Three+news@x.io")).toBe("qa_three");
    expect(handleFromEmail("José-Ñúñez@x.io")).toBe("jose_nunez");
    expect(handleFromEmail("a@x.io")).toBe("user_a");
    expect(handleFromEmail("...@x.io")).toBe("user");
    expect(handleFromEmail("x".repeat(60) + "@x.io")).toHaveLength(24);
  });
  it("picks the first free handle, case-insensitively", async () => {
    const used = new Set(["qa3", "qa3_2"]);
    const taken = async (c: string) => used.has(c.toLowerCase());
    expect(await uniqueHandle("QA3@x.io", taken)).toBe("qa3_3");
    expect(await uniqueHandle("new@x.io", taken)).toBe("new");
  });
  it("stays within 24 chars with a suffix and falls back to random", async () => {
    const long = "y".repeat(30) + "@x.io";
    const h = await uniqueHandle(long, async (c) => c === "y".repeat(24));
    expect(h).toBe("y".repeat(22) + "_2");
    const all = await uniqueHandle("bob@x.io", async (c) => !c.includes("zz"), () => "zz9");
    expect(all).toBe("bob_zz9");
  });
});
