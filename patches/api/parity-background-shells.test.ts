import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import { mountParityRoutes } from "./parity-routes.js";

// Background shells must only reach a computer the caller owns, and only through
// the host-tool permission policy (never → 403, ask → 409, always → dispatched).
function setup(opts: { permission: "always" | "ask" | "never" }) {
  const executed: string[] = [];
  const prisma = {
    $executeRawUnsafe: vi.fn(async (sql: string) => {
      executed.push(sql);
      return 1;
    }),
    $queryRawUnsafe: vi.fn(async (sql: string, ...params: unknown[]) => {
      if (sql.includes("FROM local_runner_devices")) {
        return params[0] === "dev-own" && params[1] === "user-a" ? [{ id: "dev-own" }] : [];
      }
      if (sql.includes("FROM host_tool_permission_defaults")) {
        return [
          {
            permission: opts.permission,
            ceiling: null,
            auto_review_allow: null,
            auto_review_block: null,
            auto_review_enabled: false,
          },
        ];
      }
      return [];
    }),
  };
  const invokeHostTool = vi.fn(async () => ({ ok: true, output: { pid: 4242 } }));
  const gateway = {
    deviceInfo: () => ({ online: true }),
    invokeHostTool,
  };
  const app = new Hono();
  mountParityRoutes(app, {
    prisma: prisma as never,
    auth: { api: { getSession: async () => ({ user: { id: "user-a" } }) } },
    sessionHeaders: (r) => r.headers,
    localRunnerGateway: gateway as never,
    webOrigin: "http://localhost",
  });
  const post = (body: unknown) =>
    app.request("/api/parity/background-shells", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  const inserted = () => executed.some((s) => s.includes("INSERT INTO background_shells"));
  return { post, invokeHostTool, inserted };
}

describe("POST /api/parity/background-shells", () => {
  it("refuses a device the caller does not own and never dispatches", async () => {
    const t = setup({ permission: "always" });
    const res = await t.post({ command: "echo hi", deviceId: "dev-someone-else" });
    expect(res.status).toBe(404);
    expect(t.invokeHostTool).not.toHaveBeenCalled();
    expect(t.inserted()).toBe(false);
  });

  it("asks for approval under the default ask policy", async () => {
    const t = setup({ permission: "ask" });
    const res = await t.post({ command: "echo hi", deviceId: "dev-own" });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ needsPermission: true });
    expect(t.invokeHostTool).not.toHaveBeenCalled();
    expect(t.inserted()).toBe(false);
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
});
