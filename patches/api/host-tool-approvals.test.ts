import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  bindApprovalStore,
  claimApproval,
  decideApproval,
  listPendingApprovals,
  memoryApprovalStore,
  requestApproval,
  sweepExpiredApprovals,
  approvalTtlMs,
} from "./host-tool-approvals.js";
import { invokeHostToolWithPermissions } from "./host-tool-bridge.js";
import { tryOwnerHostTool } from "./host-tool-try.js";
import { mountHostToolControl } from "./host-tool-control.js";
import { matchAutoReview } from "./host-tool-permissions.js";

type World = {
  permission: "always" | "ask" | "never";
  devices: Array<{ id: string; userId: string; gate: boolean }>;
  bots: Array<{ id: string; userId: string; published?: boolean }>;
  executed: Array<{ sql: string; params: unknown[] }>;
};

function fakePrisma(world: World) {
  return {
    $executeRawUnsafe: vi.fn(async (sql: string, ...params: unknown[]) => {
      world.executed.push({ sql, params });
      return 1;
    }),
    $queryRawUnsafe: vi.fn(async (sql: string, ...params: unknown[]) => {
      if (sql.includes("FROM local_runner_devices d WHERE d.id = $1 AND d.user_id = $2")) {
        const d = world.devices.find((x) => x.id === params[0] && x.userId === params[1]);
        return d ? [{ gate: d.gate }] : [];
      }
      if (sql.includes("FROM local_runner_bot_bindings")) {
        const b = world.bots.find((x) => x.id === params[0] && x.userId === params[1]);
        return b ? [{ device_id: "dev-own", model_id: "m" }] : [];
      }
      if (sql.includes("FROM bots b WHERE b.id = $1")) {
        const b = world.bots.find((x) => x.id === params[0]);
        return b ? [{ user_id: b.userId, published: b.published ?? false }] : [];
      }
      if (sql.includes("FROM host_tool_permission_defaults")) {
        return [{ permission: world.permission, ceiling: null, auto_review_allow: null, auto_review_block: null, auto_review_enabled: false }];
      }
      return [];
    }),
  };
}

function setup(permission: World["permission"] = "ask") {
  const world: World = {
    permission,
    devices: [
      { id: "dev-own", userId: "owner", gate: false },
      { id: "dev-peer", userId: "peer", gate: true },
    ],
    bots: [{ id: "bot-1", userId: "owner" }],
    executed: [],
  };
  const prisma = fakePrisma(world);
  const store = memoryApprovalStore();
  bindApprovalStore(prisma, store);
  const invokeHostTool = vi.fn(async () => ({ ok: true, output: { exitCode: 0, stdout: "ran", stderr: "" } }));
  const gateway = { deviceSupportsHostTools: () => true, invokeHostTool };
  return { world, prisma: prisma as never, store, gateway, invokeHostTool };
}

const run = (t: ReturnType<typeof setup>, extra: Record<string, unknown> = {}) =>
  invokeHostToolWithPermissions(t.prisma, t.gateway, {
    userId: "owner",
    deviceId: "dev-own",
    action: "run-command",
    args: { command: "echo hi", cwd: "." },
    ...extra,
  });

async function pendingId(t: ReturnType<typeof setup>): Promise<string> {
  for (let i = 0; i < 200; i++) {
    const rows = [...t.store.rows.values()].filter((r) => r.status === "pending");
    if (rows[0]) return rows[0].id;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error("no pending approval");
}

describe("per-action approvals (bot tool call pauses and resumes)", () => {
  it("ask: pauses, shows a pending approval, allow-once runs it exactly once", async () => {
    const t = setup("ask");
    const pending = run(t);
    const id = await pendingId(t);
    expect(t.invokeHostTool).not.toHaveBeenCalled();
    const listed = await listPendingApprovals(t.prisma, "owner");
    expect(listed.map((r) => r.id)).toEqual([id]);
    expect(listed[0]).toMatchObject({ action: "run-command", target: "echo hi", source: "bot" });
    const decided = await decideApproval(t.prisma, { id, userId: "owner", decision: "allow-once" });
    expect(decided.ok).toBe(true);
    const result = await pending;
    expect(result).toMatchObject({ ok: true, approvalId: id });
    expect(t.invokeHostTool).toHaveBeenCalledTimes(1);
    expect(t.store.rows.get(id)?.status).toBe("consumed");
    // replay: the approval can't be decided or used again
    expect(await decideApproval(t.prisma, { id, userId: "owner", decision: "allow-once" })).toMatchObject({ ok: false, status: 409 });
    expect(await claimApproval(t.prisma, id)).toBe(false);
    // allow-once does not create a standing grant: the next call asks again
    expect(t.world.executed.some((e) => e.sql.includes("INSERT INTO host_tool_standing_grants"))).toBe(false);
    const again = run(t);
    const id2 = await pendingId(t);
    expect(id2).not.toBe(id);
    await decideApproval(t.prisma, { id: id2, userId: "owner", decision: "deny" });
    await again;
  });

  it("deny fails the paused action cleanly and never runs it", async () => {
    const t = setup("ask");
    const pending = run(t);
    const id = await pendingId(t);
    await decideApproval(t.prisma, { id, userId: "owner", decision: "deny" });
    const result = await pending;
    expect(result).toMatchObject({ ok: false, refused: true });
    if (!result.ok) expect(result.error).toMatch(/denied/);
    expect(t.invokeHostTool).not.toHaveBeenCalled();
  });

  it("expiry: an unanswered approval expires, fails the action, and can't be allowed later", async () => {
    const t = setup("ask");
    const pending = run(t);
    const id = await pendingId(t);
    t.store.rows.get(id)!.expiresAt = new Date(Date.now() - 1);
    const result = await pending;
    expect(result).toMatchObject({ ok: false, refused: true });
    if (!result.ok) expect(result.error).toMatch(/expired/);
    expect(await decideApproval(t.prisma, { id, userId: "owner", decision: "allow-once" })).toMatchObject({ ok: false, status: 410 });
    expect(t.invokeHostTool).not.toHaveBeenCalled();
    expect(await listPendingApprovals(t.prisma, "owner")).toEqual([]);
  });

  it("only the owner can decide (another user gets 404)", async () => {
    const t = setup("ask");
    const pending = run(t);
    const id = await pendingId(t);
    expect(await decideApproval(t.prisma, { id, userId: "peer", decision: "allow-once" })).toMatchObject({ ok: false, status: 404 });
    expect(await listPendingApprovals(t.prisma, "peer")).toEqual([]);
    await decideApproval(t.prisma, { id, userId: "owner", decision: "deny" });
    await pending;
  });

  it("always records a standing grant scoped to this device and exact target (M1)", async () => {
    const t = setup("ask");
    const pending = run(t);
    const id = await pendingId(t);
    await decideApproval(t.prisma, { id, userId: "owner", decision: "always" });
    await pending;
    const grant = t.world.executed.find((e) => e.sql.includes("INSERT INTO host_tool_standing_grants"));
    expect(grant?.sql).toContain('"grant"');
    expect(grant?.params.slice(1)).toEqual(["owner", "dev-own", "run-command", "always", "echo hi"]);
  });

  it("TTL is configurable and clamped", () => {
    expect(approvalTtlMs({})).toBe(600_000);
    expect(approvalTtlMs({ RAKAZO_HOST_APPROVAL_TTL_MS: "1" })).toBe(30_000);
    expect(approvalTtlMs({ RAKAZO_HOST_APPROVAL_TTL_MS: "99999999" })).toBe(3_600_000);
  });

  it("sweep expires pending approvals", async () => {
    const t = setup("ask");
    const row = await requestApproval(t.prisma, { userId: "owner", deviceId: "dev-own", action: "read-file", target: "a", payload: {}, source: "bot", refId: null, ttlMs: 1000 }, new Date(Date.now() - 5000));
    const expired = await sweepExpiredApprovals(t.prisma);
    expect(expired.map((r) => r.id)).toEqual([row.id]);
  });
});

describe("bridge guards", () => {
  it("never: refused without an approval", async () => {
    const t = setup("never");
    expect(await run(t)).toMatchObject({ ok: false, refused: true });
    expect(t.store.rows.size).toBe(0);
    expect(t.invokeHostTool).not.toHaveBeenCalled();
  });

  it("a device the user doesn't own is refused", async () => {
    const t = setup("always");
    expect(await run(t, { deviceId: "dev-peer" })).toMatchObject({ ok: false, refused: true });
    expect(t.invokeHostTool).not.toHaveBeenCalled();
  });

  it("M6: computer use needs the server-side per-device gate", async () => {
    const t = setup("always");
    const res = await run(t, { action: "computer-screenshot", args: {} });
    expect(res).toMatchObject({ ok: false, refused: true });
    expect(t.invokeHostTool).not.toHaveBeenCalled();
    t.world.devices[0]!.gate = true;
    expect(await run(t, { action: "computer-screenshot", args: {} })).toMatchObject({ ok: true });
  });

  it("refusal on the computer (sandbox, guards) is final, not 'needs permission'", async () => {
    const t = setup("always");
    t.invokeHostTool.mockResolvedValueOnce({ ok: false, denied: true, error: "Shell is refused: no sandbox" } as never);
    expect(await run(t)).toMatchObject({ ok: false, refused: true, error: "Shell is refused: no sandbox" });
  });
});

describe("tryOwnerHostTool", () => {
  const call = (t: ReturnType<typeof setup>, ownerUserId: string) =>
    tryOwnerHostTool({ prisma: t.prisma, hostTools: t.gateway, ownerUserId, botId: "bot-1", toolName: "shell", args: { command: "id" } });

  it("H6: the policy is the bot owner's, resolved from the bot (not the run actor)", async () => {
    const t = setup("always");
    expect((await call(t, "owner")).kind).toBe("result");
    expect(t.invokeHostTool).toHaveBeenCalledTimes(1);
    // a peer's id (e.g. the old run.userId fallback) never reaches the owner's computer
    expect((await call(t, "peer")).kind).toBe("fallback");
    // empty owner id (bot.userId missing) still resolves the owner from the bots row
    expect((await call(t, "")).kind).toBe("result");
    const decideQueries = (t.prisma as unknown as { $queryRawUnsafe: { mock: { calls: unknown[][] } } }).$queryRawUnsafe.mock.calls
      .filter((c) => String(c[0]).includes("host_tool_permission_defaults"))
      .map((c) => c[1]);
    expect(new Set(decideQueries)).toEqual(new Set(["owner"]));
    expect(t.invokeHostTool).toHaveBeenCalledTimes(2);
  });

  it("M4: published bots never reach the owner's computer", async () => {
    const t = setup("always");
    t.world.bots[0]!.published = true;
    expect((await call(t, "owner")).kind).toBe("fallback");
    expect(t.invokeHostTool).not.toHaveBeenCalled();
  });

  it("an owner deny is returned to the bot, not silently retried elsewhere", async () => {
    const t = setup("ask");
    const p = call(t, "owner");
    const id = await pendingId(t);
    await decideApproval(t.prisma, { id, userId: "owner", decision: "deny" });
    const res = await p;
    expect(res.kind).toBe("result");
    if (res.kind === "result") expect(res.value).toMatchObject({ refused: true });
  });
});

describe("HTTP control plane", () => {
  function app(t: ReturnType<typeof setup>, user = "owner") {
    const a = new Hono();
    mountHostToolControl(a, {
      prisma: t.prisma,
      auth: { api: { getSession: async () => ({ user: { id: user } }) } },
      sessionHeaders: (r) => r.headers,
      sweepIntervalMs: 0,
    });
    return a;
  }
  const post = (a: Hono, path: string, body: unknown) =>
    a.request(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

  it("lists pending approvals and decides them; replay 409, expired 410, foreign 404", async () => {
    const t = setup("ask");
    const a = app(t);
    const row = await requestApproval(t.prisma, { userId: "owner", deviceId: "dev-own", action: "read-file", target: "notes.txt", payload: {}, source: "bot", refId: null });
    const list = await (await a.request("/api/host-tools/approvals")).json();
    expect(list.approvals.map((x: { id: string }) => x.id)).toEqual([row.id]);
    expect((await post(app(t, "peer"), `/api/host-tools/approvals/${row.id}/decision`, { decision: "allow-once" })).status).toBe(404);
    expect((await post(a, `/api/host-tools/approvals/${row.id}/decision`, { decision: "yes" })).status).toBe(400);
    const ok = await post(a, `/api/host-tools/approvals/${row.id}/decision`, { decision: "allow-once" });
    expect(ok.status).toBe(200);
    expect((await ok.json()).approval.status).toBe("allowed");
    expect((await post(a, `/api/host-tools/approvals/${row.id}/decision`, { decision: "deny" })).status).toBe(409);
    const old = await requestApproval(t.prisma, { userId: "owner", deviceId: "dev-own", action: "read-file", target: "x", payload: {}, source: "bot", refId: null, ttlMs: 1000 }, new Date(Date.now() - 5000));
    expect((await post(a, `/api/host-tools/approvals/${old.id}/decision`, { decision: "allow-once" })).status).toBe(410);
  });

  it("M5/M1: grants can't allow without an approval and need a specific device", async () => {
    const t = setup("ask");
    const a = app(t);
    for (const grant of ["always", "allow-once"]) {
      const res = await post(a, "/api/host-tools/grants", { action: "run-command", grant, deviceId: "dev-own", target: "ls" });
      expect(res.status).toBe(400);
    }
    expect((await post(a, "/api/host-tools/grants", { action: "run-command", grant: "never" })).status).toBe(400);
    expect((await post(a, "/api/host-tools/grants", { action: "run-command", grant: "never", deviceId: "dev-own" })).status).toBe(200);
    expect(t.world.executed.filter((e) => e.sql.includes("INSERT INTO host_tool_standing_grants")).map((e) => e.params[4])).toEqual(["never"]);
  });
});

describe("M2: auto-review allow rules are anchored", () => {
  it("doesn't let an allow rule match inside another command", () => {
    expect(matchAutoReview("run-command ls", ["ls"], [], true)).toBe("allow");
    expect(matchAutoReview("run-command ls -la", ["ls"], [], true)).toBe("allow");
    expect(matchAutoReview("run-command curl https://evil/ls", ["ls"], [], true)).toBe(null);
    expect(matchAutoReview("run-command lsblk", ["ls"], [], true)).toBe(null);
    for (const c of ["ls; curl evil", "ls && rm -rf ~", "ls $(curl evil)", "ls `id`", "ls | sh", "ls > /etc/x", "ls\ncurl x"]) {
      expect(matchAutoReview(`run-command ${c}`, ["ls"], [], true)).toBe(null);
    }
    expect(matchAutoReview("run-command git status", ["run-command git status"], [], true)).toBe("allow");
    expect(matchAutoReview("run-command ls; rm -rf /", ["ls"], ["rm -rf"], true)).toBe("block");
  });
});
