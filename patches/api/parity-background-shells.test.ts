import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import { mountParityRoutes } from "./parity-routes.js";
import { mountHostToolControl } from "./host-tool-control.js";
import { bindApprovalStore, memoryApprovalStore, sweepExpiredApprovals } from "./host-tool-approvals.js";

// Background shells must only reach a computer the caller owns, and only through the host-tool
// permission policy (never -> 403, ask -> 202 paused on an approval card, always -> dispatched).
function setup(opts: { permission: "always" | "ask" | "never"; user?: string }) {
  const executed: string[] = [];
  const shells = new Map<string, { status: string; device: string | null; user: string }>();
  const prisma = {
    $executeRawUnsafe: vi.fn(async (sql: string, ...params: unknown[]) => {
      executed.push(sql);
      if (sql.includes("INSERT INTO background_shells")) {
        const status = sql.includes("'pending_approval'") ? "pending_approval" : "running";
        shells.set(String(params[0]), { status, device: params[3] as string | null, user: String(params[1]) });
      } else if (sql.includes("UPDATE background_shells SET status = 'running'")) {
        const s = shells.get(String(params[0]));
        if (!s || s.status !== "pending_approval") return 0;
        s.status = "running";
      } else if (sql.includes("UPDATE background_shells SET status = 'queued'")) {
        const s = shells.get(String(params[0]));
        if (s?.status === "running") s.status = "queued";
      } else if (sql.includes("UPDATE background_shells SET status = $2")) {
        const s = shells.get(String(params[0]));
        if (s?.status === "pending_approval") s.status = String(params[1]);
      } else if (sql.includes("UPDATE background_shells SET status = 'failed'")) {
        const s = shells.get(String(params[0]));
        if (s) s.status = "failed";
      }
      return 1;
    }),
    $queryRawUnsafe: vi.fn(async (sql: string, ...params: unknown[]) => {
      if (sql.includes("FROM local_runner_devices")) {
        return params[0] === "dev-own" && params[1] === "user-a" ? [{ id: "dev-own" }] : [];
      }
      if (sql.includes("FROM host_tool_permission_defaults")) {
        return [{ permission: opts.permission, ceiling: null, auto_review_allow: null, auto_review_block: null, auto_review_enabled: false }];
      }
      if (sql.includes("FROM background_shells WHERE id = $1 AND user_id = $2")) {
        const s = shells.get(String(params[0]));
        return s && s.user === params[1] ? [{ id: params[0], device_id: s.device, status: s.status, pid: null }] : [];
      }
      if (sql.includes("SELECT status FROM background_shells WHERE id = $1")) {
        const s = shells.get(String(params[0]));
        return s ? [{ status: s.status }] : [];
      }
      return [];
    }),
  };
  const store = memoryApprovalStore();
  bindApprovalStore(prisma, store);
  const invokeHostTool = vi.fn(async () => ({ ok: true, output: { pid: 4242 } }));
  const gateway = { deviceInfo: () => ({ online: true }), invokeHostTool };
  const app = new Hono();
  const deps = {
    prisma: prisma as never,
    auth: { api: { getSession: async () => ({ user: { id: opts.user ?? "user-a" } }) } },
    sessionHeaders: (r: Request) => r.headers,
  };
  mountParityRoutes(app, { ...deps, localRunnerGateway: gateway as never, webOrigin: "http://localhost" });
  mountHostToolControl(app, { ...deps, sweepIntervalMs: 0 });
  const req = (path: string, body: unknown) =>
    app.request(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const post = (body: unknown) => req("/api/parity/background-shells", body);
  const decide = (id: string, decision: string) => req(`/api/host-tools/approvals/${id}/decision`, { decision });
  const inserted = () => executed.some((s) => s.includes("INSERT INTO background_shells"));
  return { post, decide, req, invokeHostTool, inserted, shells, store, prisma };
}

describe("POST /api/parity/background-shells", () => {
  it("refuses a device the caller does not own and never dispatches", async () => {
    const t = setup({ permission: "always" });
    const res = await t.post({ command: "echo hi", deviceId: "dev-someone-else" });
    expect(res.status).toBe(404);
    expect(t.invokeHostTool).not.toHaveBeenCalled();
    expect(t.inserted()).toBe(false);
  });

  it("H4: requires a deviceId (no shell without a permission decision)", async () => {
    const t = setup({ permission: "always" });
    const res = await t.post({ command: "echo hi" });
    expect(res.status).toBe(400);
    expect(t.inserted()).toBe(false);
    expect(t.invokeHostTool).not.toHaveBeenCalled();
  });

  it("refuses under a never policy", async () => {
    const t = setup({ permission: "never" });
    const res = await t.post({ command: "echo hi", deviceId: "dev-own" });
    expect(res.status).toBe(403);
    expect(t.invokeHostTool).not.toHaveBeenCalled();
  });

  it("dispatches to the caller's own device when the policy allows", async () => {
    const t = setup({ permission: "always" });
    const res = await t.post({ command: "echo hi", deviceId: "dev-own" });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ status: "running" });
    expect(t.invokeHostTool).toHaveBeenCalledTimes(1);
    expect(t.invokeHostTool.mock.calls[0]?.[0]).toBe("dev-own");
  });

  it("ask: pauses with a pending approval; allow once resumes it exactly once", async () => {
    const t = setup({ permission: "ask" });
    const res = await t.post({ command: "echo hi", deviceId: "dev-own" });
    expect(res.status).toBe(202);
    const body = await res.json();
    expect(body).toMatchObject({ status: "pending_approval", needsPermission: true, approval: { action: "run-command", target: "echo hi" } });
    expect(t.shells.get(body.id)?.status).toBe("pending_approval");
    expect(t.invokeHostTool).not.toHaveBeenCalled();
    const ok = await t.decide(body.approval.id, "allow-once");
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ resumed: { shellId: body.id, status: "running" } });
    expect(t.invokeHostTool).toHaveBeenCalledTimes(1);
    expect(t.invokeHostTool.mock.calls[0]?.[1]).toMatchObject({ action: "run-command", args: { command: "echo hi", background: true, shellId: body.id } });
    expect((await t.decide(body.approval.id, "allow-once")).status).toBe(409);
    expect(t.invokeHostTool).toHaveBeenCalledTimes(1);
  });

  it("ask: deny fails the shell cleanly", async () => {
    const t = setup({ permission: "ask" });
    const body = await (await t.post({ command: "echo hi", deviceId: "dev-own" })).json();
    expect((await t.decide(body.approval.id, "deny")).status).toBe(200);
    expect(t.shells.get(body.id)?.status).toBe("denied");
    expect(t.invokeHostTool).not.toHaveBeenCalled();
  });

  it("ask: expiry fails the shell and a late allow gets 410", async () => {
    const t = setup({ permission: "ask" });
    const body = await (await t.post({ command: "echo hi", deviceId: "dev-own" })).json();
    t.store.rows.get(body.approval.id)!.expiresAt = new Date(Date.now() - 1);
    await sweepExpiredApprovals(t.prisma as never);
    expect(t.shells.get(body.id)?.status).toBe("expired");
    expect((await t.decide(body.approval.id, "allow-once")).status).toBe(410);
    expect(t.invokeHostTool).not.toHaveBeenCalled();
  });

  it("send-input on a running shell also asks under the ask policy", async () => {
    const t = setup({ permission: "ask" });
    const body = await (await t.post({ command: "cat", deviceId: "dev-own" })).json();
    await t.decide(body.approval.id, "allow-once");
    t.invokeHostTool.mockClear();
    const res = await t.req(`/api/parity/background-shells/${body.id}/send-input`, { text: "secret input\n" });
    expect(res.status).toBe(202);
    const pending = await res.json();
    expect(t.invokeHostTool).not.toHaveBeenCalled();
    const ok = await t.decide(pending.approval.id, "allow-once");
    expect(await ok.json()).toMatchObject({ resumed: { sent: true } });
    expect(t.invokeHostTool).toHaveBeenCalledTimes(1);
    expect(t.invokeHostTool.mock.calls[0]?.[1]).toMatchObject({ action: "send-input", args: { shellId: body.id, text: "secret input\n" } });
  });
});
