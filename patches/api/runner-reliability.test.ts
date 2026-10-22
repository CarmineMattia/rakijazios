import { afterEach, describe, expect, it, vi } from "vitest";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { readdirSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { Hono } from "hono";
import { createLocalRunnerGateway, liveStateOf, RECONNECT_GRACE_MS, typeRunnerInferError } from "./local-runners.js";
import { hashDeviceToken, mintSharedLocalRunToken } from "./shared-local-token.js";

// Reliability of runner links: entirely synthetic database and runner sockets.
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(predicate: () => boolean, timeout = 4000): Promise<void> {
  const end = Date.now() + timeout;
  while (!predicate()) {
    if (Date.now() > end) throw new Error("Synthetic gateway condition timed out");
    await sleep(5);
  }
}
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
  vi.unstubAllEnvs();
});

type Frame = { type: string; id?: string; [key: string]: unknown };
type Ws = {
  on: (e: string, cb: (...a: never[]) => void) => void;
  once: (e: string, cb: (...a: never[]) => void) => void;
  send: (d: string) => void;
  terminate: () => void;
  _socket: { pause: () => void };
};

async function fixture(env: Record<string, string> = {}) {
  vi.stubEnv("ENCRYPTION_KEY", "12".repeat(32));
  vi.stubEnv("RK_LOCAL_USAGE_RETENTION_DAYS", "off");
  for (const [k, v] of Object.entries(env)) vi.stubEnv(k, v);
  const limits = { max_concurrent: 2, per_user_per_minute: 50, daily_request_cap: null, person_daily_cap: null, daily_token_cap: null };
  const prisma = {
    $executeRawUnsafe: async () => 1,
    $queryRawUnsafe: async (sql: string) => {
      if (sql.includes("FROM local_runner_devices WHERE id")) return [{ id: "device", user_id: "owner", token_hash: hashDeviceToken("synthetic-device-token"), status: "active", enabled: true, paired_via: "pairing" }];
      if (sql.includes("FROM local_runner_models")) return [{ model_id: "test-model" }];
      if (sql.includes("FROM local_runner_limits")) return [limits];
      if (sql.includes("FROM runs r")) {
        return [{ bot_id: "owner-bot", run_user_id: "owner", run_status: "running", run_trigger: "chat", bot_user_id: "owner", bot_model_provider: "shared-local", bot_model_id: "test-model", bot_archived: false,
          thread_group_id: "group", thread_bot_id: null, thread_external: false, group_share_count: 1, group_granted: true, bind_device_id: "device", bind_model_id: "test-model", device_user_id: "owner", device_status: "active", device_enabled: true, model_enabled: true, model_advertised: true, consumer_user_id: "owner", model_context_window: 4096 }];
      }
      if (sql.includes("FROM local_runner_usage")) return [{ day_start: new Date().setUTCHours(0, 0, 0, 0), peer: 0, person: 0, tokens: 0 }];
      return [];
    },
  };
  const gateway = createLocalRunnerGateway({ prisma: prisma as never });
  const app = new Hono();
  gateway.mountHttp(app);
  const server = createServer();
  gateway.attachUpgrade(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const dir = readdirSync("/app/node_modules/.pnpm").filter((name) => /^ws@8\.\d+\.\d+$/.test(name)).sort((a, b) => a.localeCompare(b, undefined, { numeric: true })).pop()!;
  const { WebSocket } = createRequire(`/app/node_modules/.pnpm/${dir}/node_modules/ws/package.json`)("ws");
  const sockets: Ws[] = [];
  cleanups.push(async () => {
    for (const s of sockets) s.terminate();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  /** A synthetic runner: connects, says hello, waits for the policy. */
  async function runner(capabilities = ["inference"], extra: Record<string, unknown> = {}, waitPolicy = true) {
    const ws: Ws = new WebSocket(`ws://127.0.0.1:${(server.address() as AddressInfo).port}/api/local-runners/ws`);
    sockets.push(ws);
    const frames: Frame[] = [];
    const closed: { code?: number; reason?: string } = {};
    ws.on("message", (data: Buffer) => frames.push(JSON.parse(data.toString())));
    ws.on("close", (code: number, reason: Buffer) => Object.assign(closed, { code, reason: reason.toString() }));
    await new Promise<void>((resolve, reject) => { ws.once("open", resolve); ws.once("error", reject); });
    ws.send(JSON.stringify({ type: "hello", deviceId: "device", token: "synthetic-device-token", offeredModels: [{ id: "test-model" }], runnerVersion: "0.2.4-test", capabilities, ...extra }));
    if (waitPolicy) await until(() => frames.some((f) => f.type === "policy"));
    return { ws, frames, closed, inferences: () => frames.filter((f) => f.type === "infer.request") };
  }
  const request = (run = "own") =>
    app.request("/api/local-runners/v1/chat/completions", {
      method: "POST",
      headers: { authorization: `Bearer ${mintSharedLocalRunToken("owner", run)}`, "content-type": "application/json" },
      body: JSON.stringify({ model: "test-model", stream: true, messages: [{ role: "user", content: "synthetic" }] }),
    });
  return { gateway, app, runner, request };
}

describe("runner drops fail requests at once (no hang, no fallback)", () => {
  it("a runner that disconnects before the first token fails the request promptly with a typed error", async () => {
    const f = await fixture();
    const r = await f.runner();
    const t0 = Date.now();
    const pending = f.request();
    await until(() => r.inferences().length === 1);
    r.ws.terminate();
    const res = await pending;
    expect(Date.now() - t0).toBeLessThan(2_000);
    expect(res.status).toBe(502);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toMatch(/^\[shared_local_dropped\] Runner disconnected \(closed\)/);
    const info = f.gateway.deviceInfo("device");
    expect(info.online).toBe(false);
    expect(info.state).toBe("reconnecting");
    expect(info.lastDisconnect?.reason).toBe("closed");
  });

  it("a runner that disconnects mid-stream ends the stream with a typed SSE error", async () => {
    const f = await fixture();
    const r = await f.runner();
    const pending = f.request();
    await until(() => r.inferences().length === 1);
    const id = r.inferences()[0]!.id!;
    r.ws.send(JSON.stringify({ type: "infer.chunk", id, data: `data: ${JSON.stringify({ choices: [{ delta: { content: "Hel" } }] })}` }));
    const res = await pending;
    expect(res.status).toBe(200);
    r.ws.terminate();
    const text = await res.text();
    expect(text).toContain("Hel");
    expect(text).toMatch(/shared_local_dropped/);
    expect(text).toContain("data: [DONE]");
  });

  it("a silent link (no pongs) is dropped after the pong miss and its request fails", async () => {
    const f = await fixture({ RK_LOCAL_RUNNER_PING_MS: "100", RK_LOCAL_RUNNER_PONG_MISS_MS: "600" });
    const r = await f.runner();
    await sleep(350); // a few pings answered: the fast rule is armed
    expect(f.gateway.deviceInfo("device").online).toBe(true);
    const pending = f.request();
    await until(() => r.inferences().length === 1);
    r.ws._socket.pause(); // half-open link: TCP stays up, nothing is read or answered
    const t0 = Date.now();
    const res = await pending;
    expect(Date.now() - t0).toBeLessThan(2_500);
    expect(((await res.json()) as { error: { message: string } }).error.message).toMatch(/shared_local_dropped\] Runner disconnected \(ping-timeout\)/);
    expect(f.gateway.deviceInfo("device").state).toBe("reconnecting");
  });

  it("a request right after a drop says reconnecting; a reconnect brings the computer back", async () => {
    const f = await fixture();
    const r = await f.runner();
    r.ws.terminate();
    await until(() => !f.gateway.deviceInfo("device").online);
    const res = await f.request();
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: { type: string; message: string } };
    expect(body.error.type).toBe("shared_local_reconnecting");
    expect(body.error.message).toMatch(/^\[shared_local_reconnecting\]/);
    const again = await f.runner();
    expect(f.gateway.deviceInfo("device").state).toBe("online");
    const ok = f.request();
    await until(() => again.inferences().length === 1);
    again.ws.send(JSON.stringify({ type: "infer.done", id: again.inferences()[0]!.id, status: 200 }));
    expect((await ok).status).toBe(200);
  });

  it("a runner stopped on purpose reads as offline, not reconnecting", async () => {
    const f = await fixture();
    const r = await f.runner();
    (r.ws as unknown as { close: (c: number, why: string) => void }).close(1000, "runner stop");
    await until(() => !f.gateway.deviceInfo("device").online);
    expect(f.gateway.deviceInfo("device").lastDisconnect?.reason).toBe("stopped");
    expect(f.gateway.deviceInfo("device").state).toBe("offline");
    const res = await f.request();
    expect(((await res.json()) as { error: { type: string } }).error.type).toBe("shared_local_offline");
  });

  it("a second runner with the same key replaces the first; repeated fights are flagged", async () => {
    const f = await fixture();
    const first = await f.runner();
    const second = await f.runner();
    await until(() => first.closed.reason === "replaced");
    expect(f.gateway.deviceInfo("device").online).toBe(true);
    expect(f.gateway.deviceInfo("device").duplicateRunner).toBe(false);
    await f.runner();
    await f.runner();
    await until(() => second.closed.reason === "replaced");
    expect(f.gateway.deviceInfo("device").duplicateRunner).toBe(true);
  });

  it("a model server that stops answering is reported as such, not as an offline computer", async () => {
    const f = await fixture();
    const r = await f.runner();
    const pending = f.request();
    await until(() => r.inferences().length === 1);
    r.ws.send(JSON.stringify({ type: "infer.error", id: r.inferences()[0]!.id, message: "fetch failed (connect ECONNREFUSED 127.0.0.1:8080)", retryable: true }));
    const body = (await (await pending).json()) as { error: { message: string } };
    expect(body.error.message).toMatch(/^\[shared_local_model_server_down\]/);
    expect(f.gateway.deviceInfo("device").online).toBe(true);
  });

  it("host tool calls on a computer that disconnects fail at once", async () => {
    const f = await fixture();
    const r = await f.runner(["inference", "host-tools"]);
    const call = f.gateway.invokeHostTool("device", { id: "tool-1", action: "shell", args: { command: "true" }, timeoutMs: 600_000 } as never);
    await until(() => r.frames.some((x) => x.type === "tool.invoke"));
    const t0 = Date.now();
    r.ws.terminate();
    const result = await call;
    expect(Date.now() - t0).toBeLessThan(2_000);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/offline right now.*disconnected: closed/);
  });
});

describe("P29 follow-ups", () => {
  it("P29-1: a dead link reads 'reconnecting' the moment it reads offline (no 'offline' gap before the sweep)", async () => {
    // Sweep effectively off: only reads notice the dead link.
    const f = await fixture({ RK_LOCAL_RUNNER_PING_MS: "100", RK_LOCAL_RUNNER_PONG_MISS_MS: "600", RK_LOCAL_RUNNER_SWEEP_MS: "600000" });
    const r = await f.runner();
    await sleep(350);
    expect(f.gateway.deviceInfo("device").state).toBe("online");
    r.ws._socket.pause();
    const seen: string[] = [];
    const end = Date.now() + 2_500;
    while (Date.now() < end) {
      const info = f.gateway.deviceInfo("device");
      if (!info.online) seen.push(`${info.state}:${info.lastDisconnect?.reason}`);
      await sleep(20);
    }
    expect(seen.length).toBeGreaterThan(0);
    expect([...new Set(seen)]).toEqual(["reconnecting:ping-timeout"]);
  });

  it("a standby runner never takes over a live session; it takes over once the slot is free", async () => {
    const f = await fixture();
    const active = await f.runner();
    const probe = await f.runner(["inference"], { standby: true }, false);
    await until(() => probe.closed.reason === "in-use");
    expect(probe.frames.some((x) => x.type === "policy")).toBe(false);
    expect(active.closed.reason).toBeUndefined();
    const info = f.gateway.deviceInfo("device");
    expect(info.online).toBe(true);
    expect(info.duplicateRunner).toBe(true);
    // A request still goes to the active runner.
    const pending = f.request();
    await until(() => active.inferences().length === 1);
    active.ws.send(JSON.stringify({ type: "infer.done", id: active.inferences()[0]!.id, status: 200 }));
    expect((await pending).status).toBe(200);
    // The active runner stops: the next standby probe gets the slot.
    active.ws.terminate();
    await until(() => !f.gateway.deviceInfo("device").online);
    const takeover = await f.runner(["inference"], { standby: true });
    expect(takeover.frames.some((x) => x.type === "policy")).toBe(true);
    expect(f.gateway.deviceInfo("device").state).toBe("online");
  });
});

describe("pure helpers", () => {
  it("liveStateOf: reconnecting only for a recent transient drop", () => {
    const now = 1_000_000_000;
    expect(liveStateOf(true, null, now)).toBe("online");
    expect(liveStateOf(false, null, now)).toBe("offline");
    expect(liveStateOf(false, { reason: "closed", at: now - 5_000 }, now)).toBe("reconnecting");
    expect(liveStateOf(false, { reason: "ping-timeout", at: now - 5_000 }, now)).toBe("reconnecting");
    expect(liveStateOf(false, { reason: "closed", at: now - RECONNECT_GRACE_MS - 1 }, now)).toBe("offline");
    expect(liveStateOf(false, { reason: "revoked", at: now - 1_000 }, now)).toBe("offline");
    expect(liveStateOf(false, { reason: "rotated", at: now - 1_000 }, now)).toBe("offline");
  });
  it("typeRunnerInferError separates a dead model server from a model error", () => {
    expect(typeRunnerInferError("fetch failed (connect ECONNREFUSED 127.0.0.1:11434)")).toMatch(/^\[shared_local_model_server_down\]/);
    expect(typeRunnerInferError("No local model server is running on this computer")).toMatch(/^\[shared_local_model_server_down\]/);
    expect(typeRunnerInferError("Local model HTTP 500: boom")).toBe("[shared_local_model_error] Local model HTTP 500: boom");
    expect(typeRunnerInferError("Cancelled")).toBe("Cancelled");
    expect(typeRunnerInferError("Sharing is paused for this computer")).toBe("Sharing is paused for this computer");
    expect(typeRunnerInferError("[shared_local_dropped] x")).toBe("[shared_local_dropped] x");
  });
});
