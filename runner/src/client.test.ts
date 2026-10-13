import { test } from "node:test";
import assert from "node:assert/strict";
import { LocalRunnerClient, reconnectDelay } from "./client.ts";

test("reconnect backoff grows, caps at 30s and is jittered (50-100% of the step)", () => {
  assert.equal(reconnectDelay(0, () => 1), 1_000);
  assert.equal(reconnectDelay(0, () => 0), 500);
  assert.equal(reconnectDelay(3, () => 1), 8_000);
  assert.equal(reconnectDelay(10, () => 1), 30_000);
  assert.equal(reconnectDelay(1_000, () => 1), 30_000);
  assert.equal(reconnectDelay(10, () => 0), 15_000);
  for (let i = 0; i < 50; i++) {
    const d = reconnectDelay(i % 8);
    assert.ok(d >= 500 && d <= 30_000, String(d));
  }
});

const creds = { gatewayWsUrl: "wss://example.invalid/ws", token: "t", deviceId: "d" } as never;
const down: typeof fetch = async () => {
  throw new TypeError("fetch failed: connect ECONNREFUSED 127.0.0.1:9");
};

test("pinned model server that is down reports not OK with a last problem", async () => {
  const c = new LocalRunnerClient({ credentials: creds, runnerVersion: "0.2.3", modelBaseUrl: "http://127.0.0.1:9/v1", fetchImpl: down, log: () => {} });
  await c.refreshModels();
  const h = c.healthReport();
  assert.equal(h.modelServerOk, false);
  assert.equal(h.models, 0);
  assert.match(h.lastError ?? "", /Pinned model server \(127\.0\.0\.1:9\) is not answering/);
  assert.equal(typeof h.lastErrorAt, "number");
});

test("pinned model server that answers reports OK", async () => {
  const up: typeof fetch = async (input) => {
    const url = String(input);
    if (url.endsWith("/models")) return new Response(JSON.stringify({ data: [{ id: "m1" }] }), { status: 200, headers: { "content-type": "application/json" } });
    return new Response("not found", { status: 404 });
  };
  const c = new LocalRunnerClient({ credentials: creds, runnerVersion: "0.2.3", modelBaseUrl: "http://127.0.0.1:8080/v1", fetchImpl: up, log: () => {} });
  await c.refreshModels();
  const h = c.healthReport();
  assert.equal(h.modelServerOk, true);
  assert.equal(h.models, 1);
  assert.equal(h.lastError, undefined);
});

test("auto-detect with nothing running reports not OK", async () => {
  const c = new LocalRunnerClient({ credentials: creds, runnerVersion: "0.2.3", fetchImpl: down, log: () => {} });
  await c.refreshModels();
  const h = c.healthReport();
  assert.equal(h.modelServerOk, false);
  assert.match(h.lastError ?? "", /No local model server/);
});
