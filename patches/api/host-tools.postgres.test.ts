import { afterAll, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { createDb } from "@rakazo/db";
import {
  decideHostToolPermission,
  ensureHostToolPermissionTables,
  recordStandingGrant,
  upsertPermissionDefaults,
} from "./host-tool-permissions.js";
import { claimApproval, decideApproval, listPendingApprovals, requestApproval, sweepExpiredApprovals } from "./host-tool-approvals.js";
import { mountParityRoutes } from "./parity-routes.js";
import { mountHostToolControl } from "./host-tool-control.js";

// Runs the host-tool SQL for real (reserved words, types, constraints) on the throwaway CI database
// that scripts/ci-boot.sh creates after booting the api. Never against the live database.
const enabled = process.env.VERIFY_HOST_TOOLS_PG === "true";
(enabled ? describe : describe.skip)("host tools on PostgreSQL", () => {
  let db: ReturnType<typeof createDb>;
  afterAll(async () => {
    if (db) {
      await db.prisma.$disconnect();
      await db.pool.end();
    }
  });

  it("permissions, standing grants, approvals and paused background shells", async () => {
    const url = new URL(process.env.RAKAZO_CI_DATABASE_URL ?? "");
    expect(url.pathname).toBe("/rakazo_ci"); // never write fixtures anywhere else
    db = createDb(url.href);
    const p = db.prisma;
    const s = Date.now();
    const owner = `ht-owner-${s}`, other = `ht-other-${s}`, dev = `ht-dev-${s}`;
    for (const id of [owner, other]) await p.user.create({ data: { id, name: id, email: `${id}@example.invalid`, emailVerified: true } });
    await p.$executeRawUnsafe(
      `INSERT INTO local_runner_devices (id, user_id, name, token_hash, status) VALUES ($1, $2, 'ci', $3, 'active')`,
      dev,
      owner,
      `hash-${s}`,
    );

    await ensureHostToolPermissionTables(p);
    await ensureHostToolPermissionTables(p);
    await upsertPermissionDefaults(p, owner, { permission: "ask" });
    expect(await decideHostToolPermission(p, { userId: owner, deviceId: dev, action: "run-command", target: "ls" })).toEqual({ kind: "ask" });
    await recordStandingGrant(p, { id: `g1-${s}`, userId: owner, deviceId: dev, action: "run-command", grant: "always", target: "ls" });
    await recordStandingGrant(p, { id: `g2-${s}`, userId: owner, deviceId: dev, action: "run-command", grant: "never", target: "rm x" });
    expect(await decideHostToolPermission(p, { userId: owner, deviceId: dev, action: "run-command", target: "ls" })).toMatchObject({ kind: "allow" });
    expect(await decideHostToolPermission(p, { userId: owner, deviceId: dev, action: "run-command", target: "rm x" })).toMatchObject({ kind: "deny" });
    expect(await decideHostToolPermission(p, { userId: owner, deviceId: dev, action: "run-command", target: "id" })).toEqual({ kind: "ask" });

    // approvals: decide once, single use, replay/foreign/expired refused
    const a = await requestApproval(p, { userId: owner, deviceId: dev, action: "read-file", target: "notes.txt", payload: { path: "notes.txt" }, source: "bot", refId: null });
    expect((await listPendingApprovals(p, owner)).map((r) => r.id)).toContain(a.id);
    expect(await listPendingApprovals(p, other)).toEqual([]);
    expect(await decideApproval(p, { id: a.id, userId: other, decision: "allow-once" })).toMatchObject({ ok: false, status: 404 });
    expect(await decideApproval(p, { id: a.id, userId: owner, decision: "allow-once" })).toMatchObject({ ok: true });
    expect(await claimApproval(p, a.id)).toBe(true);
    expect(await claimApproval(p, a.id)).toBe(false);
    expect(await decideApproval(p, { id: a.id, userId: owner, decision: "deny" })).toMatchObject({ ok: false, status: 409 });
    const old = await requestApproval(p, { userId: owner, deviceId: dev, action: "read-file", target: "x", payload: {}, source: "bot", refId: null, ttlMs: 1000 }, new Date(Date.now() - 60_000));
    expect((await sweepExpiredApprovals(p)).map((r) => r.id)).toContain(old.id);
    expect(await decideApproval(p, { id: old.id, userId: owner, decision: "allow-once" })).toMatchObject({ ok: false, status: 410 });
    const always = await requestApproval(p, { userId: owner, deviceId: dev, action: "write-file", target: "out.txt", payload: {}, source: "bot", refId: null });
    expect(await decideApproval(p, { id: always.id, userId: owner, decision: "always" })).toMatchObject({ ok: true });
    expect(await decideHostToolPermission(p, { userId: owner, deviceId: dev, action: "write-file", target: "out.txt" })).toMatchObject({ kind: "allow" });

    // paused background shell over HTTP -> allow once -> dispatched once
    const invokeHostTool = vi.fn(async () => ({ ok: true, output: { pid: 1 } }));
    const app = new Hono();
    const deps = { prisma: p, auth: { api: { getSession: async () => ({ user: { id: owner } }) } }, sessionHeaders: (r: Request) => r.headers };
    mountParityRoutes(app, { ...deps, localRunnerGateway: { deviceInfo: () => ({ online: true }), invokeHostTool } as never, webOrigin: "http://localhost" } as never);
    mountHostToolControl(app, { ...deps, sweepIntervalMs: 0 } as never);
    const post = (path: string, body: unknown) => app.request(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const created = await post("/api/parity/background-shells", { command: "echo ci", deviceId: dev });
    expect(created.status).toBe(202);
    const body = await created.json();
    const row = async () => (await p.$queryRawUnsafe<Array<{ status: string }>>(`SELECT status FROM background_shells WHERE id = $1`, body.id))[0]?.status;
    expect(await row()).toBe("pending_approval");
    expect((await post(`/api/host-tools/approvals/${body.approval.id}/decision`, { decision: "allow-once" })).status).toBe(200);
    expect(await row()).toBe("running");
    expect(invokeHostTool).toHaveBeenCalledTimes(1);
    const denied = await (await post("/api/parity/background-shells", { command: "echo no", deviceId: dev })).json();
    await post(`/api/host-tools/approvals/${denied.approval.id}/decision`, { decision: "deny" });
    expect((await p.$queryRawUnsafe<Array<{ status: string }>>(`SELECT status FROM background_shells WHERE id = $1`, denied.id))[0]?.status).toBe("denied");
    expect(invokeHostTool).toHaveBeenCalledTimes(1);

    await p.user.deleteMany({ where: { id: { in: [owner, other] } } });
  });
});
