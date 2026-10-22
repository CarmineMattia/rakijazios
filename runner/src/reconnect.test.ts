import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { LocalRunnerClient, isModelServerUnreachable } from "./client.ts";

// A scripted stand-in for the global WebSocket: no network, no gateway.
class FakeSocket extends EventTarget {
  static OPEN = 1;
  static all: FakeSocket[] = [];
  readyState = 0;
  sent: Array<Record<string, unknown>> = [];
  url: string;
  constructor(url: string) {
    super();
    this.url = url;
    FakeSocket.all.push(this);
  }
  send(data: string): void {
    this.sent.push(JSON.parse(data));
  }
  close(): void {
    this.readyState = 3;
  }
  open(): void {
    this.readyState = 1;
    this.dispatchEvent(new Event("open"));
  }
  frame(frame: Record<string, unknown>): void {
    this.dispatchEvent(Object.assign(new Event("message"), { data: JSON.stringify(frame) }));
  }
  drop(code: number, reason: string): void {
    this.readyState = 3;
    this.dispatchEvent(Object.assign(new Event("close"), { code, reason }));
  }
}

const realWebSocket = globalThis.WebSocket;
const clients: LocalRunnerClient[] = [];
afterEach(() => {
  for (const c of clients.splice(0)) c.stop(false);
  globalThis.WebSocket = realWebSocket;
  FakeSocket.all = [];
});

const creds = { gatewayWsUrl: "wss://example.invalid/ws", token: "t", deviceId: "d" } as never;

async function connectedClient(fetchImpl: typeof fetch) {
  globalThis.WebSocket = FakeSocket as never;
  const logs: string[] = [];
  const c = new LocalRunnerClient({
    credentials: creds,
    runnerVersion: "test",
    modelBaseUrl: "http://127.0.0.1:8080/v1",
    fetchImpl,
    log: (l) => logs.push(l),
  });
  clients.push(c);
  await c.start();
  const ws = FakeSocket.all.at(-1)!;
  ws.open();
  ws.frame({ type: "policy", enabled: true, allowedModels: ["m1"] });
  return { c, ws, logs };
}

const modelsOk = (url: string) =>
  url.endsWith("/models")
    ? new Response(JSON.stringify({ data: [{ id: "m1" }] }), { status: 200, headers: { "content-type": "application/json" } })
    : null;

test("a 'replaced' close waits the long backoff instead of fighting the other runner", async () => {
  const { c, ws, logs } = await connectedClient(async (input) => modelsOk(String(input)) ?? new Response("", { status: 404 }));
  ws.drop(1000, "replaced");
  assert.equal(c.replacedCount, 1);
  assert.match(logs.join("\n"), /another runner with this computer's key/);
  const wait = logs.map((l) => /reconnect in (\d+)ms/.exec(l)?.[1]).filter(Boolean).map(Number).at(-1)!;
  assert.ok(wait >= 15_000, `waited ${wait}ms`);
  assert.equal(FakeSocket.all.length, 1, "no immediate reconnect");
});

test("an ordinary close reconnects quickly", async () => {
  const { logs } = await connectedClient(async (input) => modelsOk(String(input)) ?? new Response("", { status: 404 }));
  FakeSocket.all[0]!.drop(1006, "");
  const wait = logs.map((l) => /reconnect in (\d+)ms/.exec(l)?.[1]).filter(Boolean).map(Number).at(-1)!;
  assert.ok(wait <= 1_000, `waited ${wait}ms`);
});

test("waking from sleep reconnects at once with a fresh backoff", async () => {
  const { c, ws, logs } = await connectedClient(async (input) => modelsOk(String(input)) ?? new Response("", { status: 404 }));
  // Fail a few times so the backoff is long, then sleep.
  ws.drop(1006, "");
  const internals = c as unknown as { reconnectAttempt: number; reconnectTimer: unknown; lastTickAt: number };
  internals.reconnectAttempt = 8;
  assert.ok(internals.reconnectTimer, "a reconnect is scheduled");
  assert.equal(c.checkWake(internals.lastTickAt + 1_000), false, "a normal tick is not a wake");
  assert.equal(c.checkWake(internals.lastTickAt + 5 * 60_000), true);
  assert.equal(FakeSocket.all.length, 2, "reconnected immediately, without waiting for the timer");
  assert.equal(internals.reconnectTimer, null);
  assert.equal(internals.reconnectAttempt, 0);
  assert.match(logs.join("\n"), /woke up after 300s/);
});

test("waking with a socket that looks open tears it down and reconnects", async () => {
  const { c, logs } = await connectedClient(async (input) => modelsOk(String(input)) ?? new Response("", { status: 404 }));
  const internals = c as unknown as { lastTickAt: number };
  assert.equal(c.checkWake(internals.lastTickAt + 120_000), true);
  assert.match(logs.join("\n"), /woke from sleep; reconnecting/);
  const wait = logs.map((l) => /reconnect in (\d+)ms/.exec(l)?.[1]).filter(Boolean).map(Number).at(-1)!;
  assert.ok(wait <= 1_000, `waited ${wait}ms`);
});

test("a model server that dies mid-request flips health to not OK at once", async () => {
  const { c, ws } = await connectedClient(async (input) => {
    const ok = modelsOk(String(input));
    if (ok) return ok;
    throw new TypeError("fetch failed", { cause: new Error("connect ECONNREFUSED 127.0.0.1:8080") });
  });
  assert.equal(c.healthReport().modelServerOk, true);
  ws.frame({ type: "infer.request", id: "r1", model: "m1", body: { messages: [] } });
  await new Promise((r) => setTimeout(r, 20));
  const err = ws.sent.find((f) => f.type === "infer.error" && f.id === "r1");
  assert.ok(err, "the request fails promptly");
  assert.match(String(err!.message), /fetch failed \(connect ECONNREFUSED/);
  assert.equal(c.healthReport().modelServerOk, false);
  const health = ws.sent.filter((f) => f.type === "health").at(-1)!;
  assert.equal(health.modelServerOk, false);
  assert.match(String(health.lastError), /stopped answering/);
});

test("model-server-unreachable classifier", () => {
  for (const m of ["fetch failed (connect ECONNREFUSED 127.0.0.1:8080)", "socket hang up", "other side closed", "terminated"]) {
    assert.equal(isModelServerUnreachable(m), true, m);
  }
  for (const m of ["Local model HTTP 400: bad", "Cancelled", "Model m1 is not offered by this computer"]) {
    assert.equal(isModelServerUnreachable(m), false, m);
  }
});

test("a model server that comes back is reported OK again without waiting for an error", async () => {
  let up = false;
  const { c, ws } = await connectedClient(async (input) => {
    if (up) return modelsOk(String(input)) ?? new Response("", { status: 404 });
    throw new TypeError("fetch failed", { cause: new Error("connect ECONNREFUSED 127.0.0.1:8080") });
  });
  assert.equal(c.healthReport().modelServerOk, false);
  up = true;
  await c.refreshModels();
  const health = ws.sent.filter((f) => f.type === "health").at(-1)!;
  assert.equal(health.modelServerOk, true);
});

test("replaced 3 times by another runner on the same key: stand by, never retake a live slot, take over when it is free", async () => {
  const { c, logs } = await connectedClient(async (input) => modelsOk(String(input)) ?? new Response("", { status: 404 }));
  const internals = c as unknown as { reconnectTimer: ReturnType<typeof setTimeout> | null; connect: () => void };
  const lastWait = () => logs.map((l) => /reconnect in (\d+)ms/.exec(l)?.[1]).filter(Boolean).map(Number).at(-1)!;
  /** Skip the wait: reconnect now and return the new socket's hello. */
  const reconnectNow = () => {
    if (internals.reconnectTimer) clearTimeout(internals.reconnectTimer);
    internals.reconnectTimer = null;
    internals.connect();
    const ws = FakeSocket.all.at(-1)!;
    ws.open();
    return { ws, hello: ws.sent.find((f) => f.type === "hello")! };
  };
  FakeSocket.all.at(-1)!.drop(1000, "replaced");
  for (let i = 0; i < 2; i++) {
    const { ws, hello } = reconnectNow();
    assert.equal(hello.standby, undefined, "still competing");
    ws.frame({ type: "policy", enabled: true, allowedModels: ["m1"] });
    ws.drop(1000, "replaced");
  }
  assert.equal(c.standby, true);
  assert.match(logs.join("\n"), /Another runner is using this computer's key, so this runner is standing by.*To fix: stop the other runner/);
  assert.ok(lastWait() >= 30_000, `standby waits ${lastWait()}ms`);
  // Probe while the other runner is live: the server refuses with "in-use"; keep standing by.
  const probe = reconnectNow();
  assert.equal(probe.hello.standby, true);
  probe.ws.drop(1000, "in-use");
  assert.equal(c.standby, true);
  assert.ok(lastWait() >= 30_000);
  // The other runner stopped: the probe is accepted and this runner takes over.
  const free = reconnectNow();
  assert.equal(free.hello.standby, true);
  free.ws.frame({ type: "policy", enabled: true, allowedModels: ["m1"] });
  assert.equal(c.standby, false);
  assert.match(logs.join("\n"), /this runner took over/);
  // If the other one comes back and takes over again, stand by at once (history kept).
  free.ws.drop(1000, "replaced");
  assert.equal(c.standby, true);
});
