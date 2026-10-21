import { afterAll, describe, expect, it } from "vitest";
import { createDb } from "@rakazo/db";
import { ensureLocalRunnerTables, queryUsageExport, usageCsv } from "./local-runners.js";

// Runs the export SQL for real on the throwaway CI database that scripts/ci-boot.sh creates.
// Never against the live database (it checks the database name before writing fixtures).
const enabled = Boolean(process.env.RAKAZO_CI_DATABASE_URL);
(enabled ? describe : describe.skip)("usage CSV export on PostgreSQL", () => {
  let db: ReturnType<typeof createDb>;
  afterAll(async () => {
    if (db) {
      await db.prisma.$disconnect();
      await db.pool.end();
    }
  });

  it("only the owner's computers, raw rows + rollups, inclusive range", async () => {
    const url = new URL(process.env.RAKAZO_CI_DATABASE_URL ?? "");
    expect(url.pathname).toBe("/rakazo_ci");
    db = createDb(url.href);
    const p = db.prisma;
    await ensureLocalRunnerTables(p);
    const s = Date.now();
    const ownerA = `ux-a-${s}`, ownerB = `ux-b-${s}`, peer = `ux-peer-${s}`;
    for (const [id, name] of [[ownerA, "Owner A"], [ownerB, "Owner B"], [peer, "Peer P"]]) {
      await p.user.create({ data: { id, name, email: `${id}@example.invalid`, emailVerified: true } });
    }
    const devA = `ux-dev-a-${s}`, devB = `ux-dev-b-${s}`;
    await p.$executeRawUnsafe(`INSERT INTO local_runner_devices (id, user_id, name, token_hash, status) VALUES ($1, $2, 'A laptop', $3, 'active'), ($4, $5, 'B secret box', $6, 'active')`, devA, ownerA, `h1-${s}`, devB, ownerB, `h2-${s}`);
    const raw = (id: string, dev: string, owner: string, consumer: string, at: string, status = "ok", inTok = 10, outTok = 20, ms = 100) =>
      p.$executeRawUnsafe(
        `INSERT INTO local_runner_usage (id, device_id, owner_user_id, consumer_user_id, model_id, status, input_tokens, output_tokens, duration_ms, created_at)
         VALUES ($1, $2, $3, $4, 'qwen2.5:3b', $5, $6, $7, $8, $9::timestamptz)`,
        `${id}-${s}`, dev, owner, consumer, status, inTok, outTok, ms, at,
      );
    // A's computer: owner twice + peer once on Oct 2, peer refused on Oct 3, one row just outside the range
    await raw("r1", devA, ownerA, ownerA, "2026-10-02 10:00:00");
    await raw("r2", devA, ownerA, ownerA, "2026-10-02 11:00:00");
    await raw("r3", devA, ownerA, peer, "2026-10-02 12:00:00");
    await raw("r4", devA, ownerA, peer, "2026-10-03 09:00:00", "refused_person_cap", 0, 0, 0);
    await raw("r5", devA, ownerA, peer, "2026-10-08 00:30:00");
    // A rolled-up day (older raw usage folded by retention): no model
    await p.$executeRawUnsafe(
      `INSERT INTO local_runner_usage_daily (day, device_id, owner_user_id, consumer_user_id, status, requests, input_tokens, output_tokens, duration_ms)
       VALUES ('2026-10-01', $1, $2, $3, 'ok', 7, 700, 1400, 7000)`, devA, ownerA, peer);
    // B's computer, used by A and the peer: must never show up in A's export
    await raw("b1", devB, ownerB, ownerA, "2026-10-02 10:00:00");
    await raw("b2", devB, ownerB, peer, "2026-10-02 10:00:00");

    const rowsA = await queryUsageExport(p, ownerA, { from: "2026-10-01", to: "2026-10-07" });
    const csvA = usageCsv(rowsA, ownerA).slice(1).split("\r\n").slice(1, -1);
    expect(csvA).toEqual([
      "2026-10-01,A laptop,Peer P,other,,ok,7,700,1400,7000",
      "2026-10-02,A laptop,You,you,qwen2.5:3b,ok,2,20,40,200",
      "2026-10-02,A laptop,Peer P,other,qwen2.5:3b,ok,1,10,20,100",
      "2026-10-03,A laptop,Peer P,other,qwen2.5:3b,refused_person_cap,1,0,0,0",
    ]);
    const all = usageCsv(rowsA, ownerA);
    expect(all).not.toContain("B secret box");
    expect(all).not.toContain("@example.invalid");
    expect(rowsA.every((r) => r.device_id === devA)).toBe(true);

    // B sees only B's computer; the peer (owns no computer) gets an empty export
    const rowsB = await queryUsageExport(p, ownerB, { from: "2026-10-01", to: "2026-10-07" });
    expect(rowsB.map((r) => [r.device_name, r.consumer_name, Number(r.requests)])).toEqual([["B secret box", "Owner A", 1], ["B secret box", "Peer P", 1]].sort((x, y) => String(x[1]).localeCompare(String(y[1]))));
    expect(await queryUsageExport(p, peer, { from: "2026-10-01", to: "2026-10-07" })).toEqual([]);

    // range edges: the last day is inclusive, the day after is not
    expect((await queryUsageExport(p, ownerA, { from: "2026-10-08", to: "2026-10-08" })).length).toBe(1);
    expect((await queryUsageExport(p, ownerA, { from: "2026-10-04", to: "2026-10-07" })).length).toBe(0);

    await p.$executeRawUnsafe(`DELETE FROM local_runner_usage WHERE id LIKE $1`, `%-${s}`);
    await p.$executeRawUnsafe(`DELETE FROM local_runner_usage_daily WHERE owner_user_id IN ($1, $2)`, ownerA, ownerB);
    await p.$executeRawUnsafe(`DELETE FROM local_runner_devices WHERE id IN ($1, $2)`, devA, devB);
    await p.user.deleteMany({ where: { id: { in: [ownerA, ownerB, peer] } } });
  });
});
