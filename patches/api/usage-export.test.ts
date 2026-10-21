import { afterEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import {
  USAGE_CSV_COLUMNS,
  USAGE_EXPORT_MAX_ROWS,
  csvField,
  parseUsageExportRange,
  usageCsv,
  type UsageExportRow,
} from "./local-runners.js";
import { mountLocalRunnerControl } from "./local-runner-control.js";

const NOW = new Date("2026-10-21T09:30:00Z");

describe("usage CSV export: date range", () => {
  it("defaults to the last 30 days, inclusive", () => {
    expect(parseUsageExportRange(undefined, undefined, NOW)).toEqual({ ok: true, from: "2026-09-22", to: "2026-10-21" });
    expect(parseUsageExportRange(undefined, "2026-10-01", NOW)).toEqual({ ok: true, from: "2026-09-02", to: "2026-10-01" });
  });
  it("accepts an explicit range, a single day and up to 366 days", () => {
    expect(parseUsageExportRange("2026-10-01", "2026-10-07", NOW)).toEqual({ ok: true, from: "2026-10-01", to: "2026-10-07" });
    expect(parseUsageExportRange("2026-10-05", "2026-10-05", NOW)).toMatchObject({ ok: true });
    expect(parseUsageExportRange("2025-10-21", "2026-10-21", NOW)).toMatchObject({ ok: true });
  });
  it("refuses bad dates, reversed and too long ranges", () => {
    for (const bad of ["2026-02-30", "2026-13-01", "21-10-2026", "2026-10-1", "yesterday", "2026-10-01'--"]) {
      expect(parseUsageExportRange(bad, "2026-10-21", NOW)).toMatchObject({ ok: false });
      expect(parseUsageExportRange("2026-10-01", bad, NOW)).toMatchObject({ ok: false });
    }
    expect(parseUsageExportRange("2026-10-08", "2026-10-07", NOW)).toEqual({ ok: false, error: "from must be on or before to" });
    expect(parseUsageExportRange("2025-10-20", "2026-10-21", NOW)).toMatchObject({ ok: false, error: expect.stringContaining("366") });
  });
});

describe("usage CSV export: CSV text", () => {
  it("quotes per RFC 4180 and defuses spreadsheet formulas", () => {
    expect(csvField("plain")).toBe("plain");
    expect(csvField("a,b")).toBe('"a,b"');
    expect(csvField('say "hi"')).toBe('"say ""hi"""');
    expect(csvField("two\nlines")).toBe('"two\nlines"');
    for (const f of ["=SUM(A1)", "+1", "-1", "@cmd", "\tx"]) expect(csvField(f).replace(/^"/, "").startsWith("'")).toBe(true);
    expect(csvField('=HYPERLINK("http://x","y")')).toBe(`"'=HYPERLINK(""http://x"",""y"")"`);
    expect(csvField(42)).toBe("42");
    expect(csvField(Number.NaN)).toBe("");
    expect(csvField(null)).toBe("");
  });

  it("one row per day/computer/person/model/status; people by display name only", () => {
    const owner = "owner-1";
    const rows: UsageExportRow[] = [
      { day: "2026-10-01", device_id: "d1", device_name: "Desk PC", consumer_user_id: owner, consumer_name: "Carmine", model_id: "qwen2.5:3b", status: "ok", requests: 3, input_tokens: 30, output_tokens: 90, duration_ms: 4000 },
      { day: "2026-10-01", device_id: "d1", device_name: "Desk PC", consumer_user_id: "friend-1", consumer_name: "Ana, from work", model_id: "qwen2.5:3b", status: "refused_person_cap", requests: 1, input_tokens: 0, output_tokens: 0, duration_ms: 0 },
      { day: "2026-07-01", device_id: "d2", device_name: null, consumer_user_id: "friend-2", consumer_name: null, model_id: null, status: "ok", requests: 12, input_tokens: 1200, output_tokens: 3400, duration_ms: 99000 },
      { day: "2026-07-01", device_id: "d2", device_name: null, consumer_user_id: null, consumer_name: null, model_id: null, status: "ok", requests: 2, input_tokens: 1, output_tokens: 2, duration_ms: 3 },
    ];
    const csv = usageCsv(rows, owner);
    expect(csv.startsWith("\ufeff")).toBe(true);
    const lines = csv.slice(1).split("\r\n");
    expect(lines.at(-1)).toBe("");
    expect(lines[0]).toBe(USAGE_CSV_COLUMNS.join(","));
    expect(lines[0]).toBe("date,computer,person,person_type,model,status,requests,input_tokens,output_tokens,duration_ms");
    expect(lines.slice(1, -1)).toEqual([
      "2026-10-01,Desk PC,You,you,qwen2.5:3b,ok,3,30,90,4000",
      '2026-10-01,Desk PC,"Ana, from work",other,qwen2.5:3b,refused_person_cap,1,0,0,0',
      "2026-07-01,Removed computer,Someone,other,,ok,12,1200,3400,99000",
      "2026-07-01,Removed computer,You,you,,ok,2,1,2,3",
    ]);
    // never ids (the owner's own name is not needed either: "You")
    for (const id of [owner, "friend-1", "friend-2", "d1", "d2", "Carmine"]) expect(csv).not.toContain(id);
  });

  it("an empty range is just the header", () => {
    expect(usageCsv([], "o")).toBe(`\ufeff${USAGE_CSV_COLUMNS.join(",")}\r\n`);
  });
});

describe("usage CSV export: route", () => {
  afterEach(() => vi.unstubAllEnvs());

  function app(sessionUser: string | null, rows: UsageExportRow[] = []) {
    vi.stubEnv("RAKAZO_LOCAL_RUNNERS_UI", "1");
    const queries: Array<{ sql: string; params: unknown[] }> = [];
    const prisma = {
      $executeRawUnsafe: async () => 0,
      $queryRawUnsafe: async (sql: string, ...params: unknown[]) => {
        queries.push({ sql, params });
        return /local_runner_usage_daily/.test(sql) && /to_char\(u\.day/.test(sql) ? rows : [];
      },
    };
    const a = new Hono();
    mountLocalRunnerControl(a, {
      prisma: prisma as never,
      auth: { api: { getSession: async () => (sessionUser ? { user: { id: sessionUser } } : null) } } as never,
      sessionHeaders: (r: Request) => r.headers,
      gateway: {} as never,
      webOrigin: "http://localhost",
    });
    return { a, queries };
  }
  const exportQuery = (qs: Array<{ sql: string; params: unknown[] }>) => qs.filter((q) => /to_char\(u\.day/.test(q.sql));

  it("401 without a session, and no usage query", async () => {
    const { a, queries } = app(null);
    expect((await a.request("/api/local-runners/usage.csv")).status).toBe(401);
    expect(exportQuery(queries)).toEqual([]);
  });

  it("400 on a bad range, before any usage query", async () => {
    const { a, queries } = app("u1");
    const res = await a.request("/api/local-runners/usage.csv?from=2026-10-09&to=2026-10-01");
    expect(res.status).toBe(400);
    expect(exportQuery(queries)).toEqual([]);
  });

  it("CSV download scoped to the signed-in owner and the requested range", async () => {
    const { a, queries } = app("u1", [
      { day: "2026-10-02", device_id: "d", device_name: "Laptop", consumer_user_id: "u1", consumer_name: "x", model_id: "m", status: "ok", requests: 1, input_tokens: 2, output_tokens: 3, duration_ms: 4 },
    ]);
    const res = await a.request("/api/local-runners/usage.csv?from=2026-10-01&to=2026-10-07");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/csv; charset=utf-8");
    expect(res.headers.get("content-disposition")).toBe('attachment; filename="rakijazios-usage-2026-10-01_2026-10-07.csv"');
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.text()).toContain("2026-10-02,Laptop,You,you,m,ok,1,2,3,4");
    const [q] = exportQuery(queries);
    expect(q.params).toEqual(["u1", "2026-10-01", "2026-10-07"]);
    // every source is filtered by the owner parameter
    expect(q.sql.match(/owner_user_id = \$1/g)?.length).toBe(2);
    expect(q.sql).toContain("d.user_id = $1");
  });

  it("413 when the range has too many rows", async () => {
    const many = Array.from({ length: USAGE_EXPORT_MAX_ROWS + 1 }, (_, i) => ({ day: "2026-10-01", device_id: `d${i}`, device_name: "x", consumer_user_id: null, consumer_name: null, model_id: null, status: "ok", requests: 1, input_tokens: 0, output_tokens: 0, duration_ms: 0 }));
    const { a } = app("u1", many);
    expect((await a.request("/api/local-runners/usage.csv")).status).toBe(413);
  });
});
