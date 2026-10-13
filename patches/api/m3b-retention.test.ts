import { describe, expect, it } from "vitest";
import { USAGE_RETENTION_DEFAULT_DAYS, USAGE_ROWS_SQL, usageRetentionDays, sweepUsage } from "./local-runners.js";

describe("M3b usage retention", () => {
  it("parses RK_LOCAL_USAGE_RETENTION_DAYS", () => {
    expect(usageRetentionDays(undefined)).toBe(USAGE_RETENTION_DEFAULT_DAYS);
    expect(usageRetentionDays("")).toBe(90);
    expect(usageRetentionDays("180")).toBe(180);
    expect(usageRetentionDays("3")).toBe(15);
    expect(usageRetentionDays("0")).toBeNull();
    expect(usageRetentionDays("off")).toBeNull();
    expect(usageRetentionDays("abc")).toBe(90);
    expect(usageRetentionDays("-5")).toBe(90);
    expect(usageRetentionDays("30d")).toBe(90);
  });
  it("chart rows read both raw rows and rollups", () => {
    expect(USAGE_ROWS_SQL).toMatch(/FROM local_runner_usage\s/);
    expect(USAGE_ROWS_SQL).toMatch(/FROM local_runner_usage_daily/);
  });
  it("sweeps in batches until a short batch", async () => {
    const calls: unknown[][] = [];
    const sizes = [3, 3, 1];
    const prisma = {
      $executeRawUnsafe: async () => 0,
      $queryRawUnsafe: async (...args: unknown[]) => { if (!String(args[0]).includes("DELETE FROM local_runner_usage")) return []; calls.push(args); return [{ n: sizes.shift() ?? 0 }]; },
    } as never;
    const r = await sweepUsage(prisma, 90, { batch: 3, maxBatches: 10 });
    expect(r).toEqual({ folded: 7, batches: 3 });
    expect(calls.every((c) => String(c[0]).includes("DELETE FROM local_runner_usage") && String(c[0]).includes("INSERT INTO local_runner_usage_daily") && c[1] === 90 && c[2] === 3)).toBe(true);
    const capped = await sweepUsage({ $executeRawUnsafe: async () => 0, $queryRawUnsafe: async (sql: string) => (sql.includes("DELETE FROM") ? [{ n: 3 }] : []) } as never, 90, { batch: 3, maxBatches: 4 });
    expect(capped).toEqual({ folded: 12, batches: 4 });
  });
});
