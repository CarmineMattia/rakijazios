import { afterEach, describe, expect, it, vi } from "vitest";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { readdirSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { Hono } from "hono";
import { createLocalRunnerGateway } from "./local-runners.js";
import { hashDeviceToken, mintSharedLocalRunToken } from "./shared-local-token.js";

// Entirely synthetic database and runner: no live stack, users or model server.
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(predicate: () => boolean, timeout = 3000): Promise<void> {
  const end = Date.now() + timeout;
  while (!predicate()) {
    if (Date.now() > end) throw new Error("Synthetic gateway condition timed out");
    await sleep(5);
  }
}
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); vi.unstubAllEnvs(); });

type Usage = { id: string; consumer: string; status: string; input: number; output: number };
type Frame = { type: string; id?: string; [key: string]: unknown };
async function fixture(options: { personCap?: number; dailyCap?: number; tokenCap?: number; rate?: number; concurrent?: number; deferUsage?: boolean } = {}) {
  vi.stubEnv("ENCRYPTION_KEY", "12".repeat(32));
  vi.stubEnv("RK_LOCAL_USAGE_RETENTION_DAYS", "off");
  const usage: Usage[] = [];
  let granted = true;
  let persist!: () => void;
  const persistence = options.deferUsage ? new Promise<void>((resolve) => { persist = resolve; }) : Promise.resolve();
  const limits = { max_concurrent: options.concurrent ?? 1, per_user_per_minute: options.rate ?? 20,
    daily_request_cap: options.dailyCap ?? null, person_daily_cap: options.personCap ?? null, daily_token_cap: options.tokenCap ?? null };
  const prisma = {
    $executeRawUnsafe: async (sql: string, ...args: unknown[]) => {
      if (sql.includes("INSERT INTO local_runner_usage (")) { await persistence; usage.push({ id: String(args[0]), consumer: String(args[3]), status: String(args[8]), input: Number(args[9] ?? 0), output: Number(args[10] ?? 0) }); }
      return 1;
    },
    $queryRawUnsafe: async (sql: string, ...args: unknown[]) => {
      if (sql.includes("FROM local_runner_devices WHERE id")) return [{ id: "device", user_id: "owner", token_hash: hashDeviceToken("synthetic-device-token"), status: "active", enabled: true, paired_via: "pairing" }];
      if (sql.includes("FROM local_runner_models")) return [{ model_id: "test-model" }];
      if (sql.includes("FROM local_runner_limits")) return [limits];
      if (sql.includes("FROM runs r")) {
        const run = String(args[0]);
        return [{ bot_id: run === "own" ? "owner-bot" : `bot-${run}`, run_user_id: "owner", run_status: "running", run_trigger: "chat", bot_user_id: "owner", bot_model_provider: "shared-local", bot_model_id: "test-model", bot_archived: false,
          thread_group_id: "group", thread_bot_id: null, thread_external: false, group_share_count: 1, group_granted: granted || run === "own", bind_device_id: "device", bind_model_id: "test-model", device_user_id: "owner", device_status: "active", device_enabled: true, model_enabled: true, model_advertised: true, consumer_user_id: run === "own" ? "owner" : "peer", model_context_window: 4096 }];
      }
      if (sql.includes("FROM local_runner_usage")) {
        const exclude = new Set(Array.isArray(args[2]) ? args[2].map(String) : []);
        const rows = usage.filter((u) => !exclude.has(u.id) && u.consumer !== "owner" && ["ok", "error", "cancelled"].includes(u.status));
        return [{ day_start: new Date().setUTCHours(0, 0, 0, 0), peer: rows.length, person: rows.filter((u) => u.consumer === args[1]).length, tokens: rows.reduce((sum, u) => sum + u.input + u.output, 0) }];
      }
      return [];
    },
  };
  const gateway = createLocalRunnerGateway({ prisma: prisma as never });
  const app = new Hono(); gateway.mountHttp(app);
  const server = createServer(); gateway.attachUpgrade(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const dir = readdirSync("/app/node_modules/.pnpm").filter((name) => /^ws@8\.\d+\.\d+$/.test(name)).sort((a, b) => a.localeCompare(b, undefined, { numeric: true })).pop()!;
  const require = createRequire(`/app/node_modules/.pnpm/${dir}/node_modules/ws/package.json`);
  const { WebSocket } = require("ws");
  const ws = new WebSocket(`ws://127.0.0.1:${(server.address() as AddressInfo).port}/api/local-runners/ws`);
  const frames: Frame[] = [];
  ws.on("message", (data: Buffer) => frames.push(JSON.parse(data.toString())));
  cleanups.push(async () => {
    ws.terminate();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  await new Promise<void>((resolve, reject) => { ws.once("open", resolve); ws.once("error", reject); });
  ws.send(JSON.stringify({ type: "hello", deviceId: "device", token: "synthetic-device-token", offeredModels: [{ id: "test-model" }], runnerVersion: "test" }));
  await until(() => frames.some((f) => f.type === "policy"));
  const inferences = () => frames.filter((f) => f.type === "infer.request");
  const request = (run: string) => app.request("/api/local-runners/v1/chat/completions", { method: "POST", headers: { authorization: `Bearer ${mintSharedLocalRunToken("owner", run)}`, "content-type": "application/json" }, body: JSON.stringify({ model: "test-model", stream: true, messages: [{ role: "user", content: "synthetic" }] }) });
  const done = (id: string) => ws.send(JSON.stringify({ type: "infer.done", id, status: 200 }));
  return { gateway, usage, frames, inferences, request, done, chunk: (id: string, input: number, output: number) => ws.send(JSON.stringify({ type: "infer.chunk", id, data: `data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: input, completion_tokens: output } })}` })), persist: () => persist?.(), revoke: () => { granted = false; } };
}

describe("M3b gateway admission regressions", () => {
  it("rechecks a person's daily cap after two peer requests wait behind the owner", async () => {
    const f = await fixture({ personCap: 1 });
    const owner = f.request("own"); await until(() => f.inferences().length === 1);
    const first = f.request("peer-a"), second = f.request("peer-b");
    await until(() => f.gateway.deviceInfo("device").queued === 2);
    f.done(f.inferences()[0]!.id!); expect((await owner).status).toBe(200);
    await until(() => f.inferences().length === 2);
    f.done(f.inferences()[1]!.id!);
    const responses = await Promise.all([first, second]);
    expect(responses.map((r) => r.status).sort()).toEqual([200, 429]);
    expect(f.inferences()).toHaveLength(2);
  });

  it("does not dispatch an inference whose group grant was revoked while waiting", async () => {
    const f = await fixture();
    const owner = f.request("own"); await until(() => f.inferences().length === 1);
    const peer = f.request("peer-a"); await until(() => f.gateway.deviceInfo("device").queued === 1);
    f.revoke(); f.gateway.cancelBotInGroup("bot-peer-a", "group");
    f.done(f.inferences()[0]!.id!); await owner;
    const response = await peer;
    expect([403, 499]).toContain(response.status);
    await sleep(230); expect(f.inferences()).toHaveLength(1);
  });

  it("applies the per-person minute rate at dispatch to requests already waiting", async () => {
    const f = await fixture({ rate: 1 });
    const owner = f.request("own"); await until(() => f.inferences().length === 1);
    const first = f.request("peer-a"), second = f.request("peer-b");
    await until(() => f.gateway.deviceInfo("device").queued === 2);
    f.done(f.inferences()[0]!.id!); await owner;
    await until(() => f.inferences().length === 2); f.done(f.inferences()[1]!.id!);
    const responses = await Promise.all([first, second]);
    expect(responses.map((r) => r.status).sort()).toEqual([200, 429]);
    expect(f.inferences()).toHaveLength(2);
  });

  it("rechecks the token cap consumed by another answer while waiting", async () => {
    const f = await fixture({ tokenCap: 1000 });
    const first = f.request("peer-a"); await until(() => f.inferences().length === 1);
    const second = f.request("peer-b"); await until(() => f.gateway.deviceInfo("device").queued === 1);
    f.chunk(f.inferences()[0]!.id!, 600, 400);
    f.done(f.inferences()[0]!.id!); expect((await first).status).toBe(200);
    expect((await second).status).toBe(429);
    expect(f.inferences()).toHaveLength(1);
  });

  it("queues the ninth request when all eight configured answer slots are occupied", async () => {
    const f = await fixture({ concurrent: 8 });
    const owners = Array.from({ length: 8 }, () => f.request("own"));
    await until(() => f.inferences().length === 8);
    const peer = f.request("peer-a");
    await until(() => f.gateway.deviceInfo("device").queued === 1);
    expect(f.inferences()).toHaveLength(8);
    f.done(f.inferences()[0]!.id!);
    await until(() => f.inferences().length === 9);
    for (const frame of f.inferences().slice(1)) f.done(frame.id!);
    expect((await peer).status).toBe(200);
    expect((await Promise.all(owners)).every((response) => response.status === 200)).toBe(true);
  });

  it("keeps completed requests counted while their usage write is still pending", async () => {
    const f = await fixture({ dailyCap: 1, deferUsage: true });
    const first = f.request("peer-a"); await until(() => f.inferences().length === 1);
    f.done(f.inferences()[0]!.id!); expect((await first).status).toBe(200);
    expect(f.usage).toHaveLength(0);
    try {
      const second = await f.request("peer-b");
      expect(second.status).toBe(429); expect(f.inferences()).toHaveLength(1);
    } finally { f.persist(); }
  });

  it("counts an active peer request towards the daily request allowance", async () => {
    const f = await fixture({ dailyCap: 1, concurrent: 2 });
    const first = f.request("peer-a"); await until(() => f.inferences().length === 1);
    expect(f.usage).toHaveLength(0); // the first inference has not finished or persisted yet
    const second = await f.request("peer-b");
    expect(second.status).toBe(429); expect(f.inferences()).toHaveLength(1);
    f.done(f.inferences()[0]!.id!); expect((await first).status).toBe(200);
  });
});
