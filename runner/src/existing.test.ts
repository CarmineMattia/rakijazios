import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  interpretAdoptAnswer,
  isRunnerCommandLine,
  looksLikeRunner,
  otherRunnerHolding,
  planForExisting,
  refusalMessage,
} from "./existing.ts";

const S = "http://127.0.0.1:5173";

describe("planForExisting", () => {
  it("no credentials → fresh pairing", () => {
    assert.deepEqual(planForExisting(null, S, false), { action: "fresh" });
  });
  it("same server → adopt (keep the key)", () => {
    const creds = { deviceId: "d", token: "k", gatewayWsUrl: "ws://127.0.0.1:5173/api/local-runners/ws", server: S };
    assert.deepEqual(planForExisting(creds, S, false), { action: "adopt", deviceId: "d", token: "k" });
  });
  it("M1 credentials on the same host → adopt", () => {
    const creds = { deviceId: "d", token: "k", gatewayWsUrl: "ws://127.0.0.1:3100/api/local-runners/ws" };
    assert.equal(planForExisting(creds, S, false).action, "adopt");
  });
  it("M1 rule: loopback names are one host, other hosts are not", () => {
    const m1 = { deviceId: "d", token: "k", gatewayWsUrl: "ws://127.0.0.1:3100/api/local-runners/ws" };
    assert.equal(planForExisting(m1, "http://localhost:5173", false).action, "adopt");
    assert.equal(planForExisting(m1, "http://[::1]:5173", false).action, "adopt");
    assert.equal(planForExisting(m1, "https://rakijazios.example", false).action, "refuse");
    assert.equal(planForExisting(m1, "http://192.168.1.10:5173", false).action, "refuse");
    const lan = { deviceId: "d", token: "k", gatewayWsUrl: "ws://192.168.1.10:3100/api/local-runners/ws" };
    assert.equal(planForExisting(lan, "http://192.168.1.10:5173", false).action, "adopt");
    assert.equal(planForExisting(lan, "http://127.0.0.1:5173", false).action, "refuse");
  });
  it("another server → refuse, unless --replace", () => {
    const creds = { deviceId: "d", token: "k", gatewayWsUrl: "wss://a.example/api/local-runners/ws", server: "https://a.example" };
    assert.deepEqual(planForExisting(creds, "https://b.example", false), { action: "refuse", reason: "other_server", host: "a.example" });
    assert.deepEqual(planForExisting(creds, "https://b.example", true), { action: "replace" });
    assert.deepEqual(planForExisting(creds, "https://a.example", true), { action: "replace" });
  });
});

describe("interpretAdoptAnswer", () => {
  it("maps server answers", () => {
    assert.deepEqual(interpretAdoptAnswer(200, { deviceId: "d", name: "Box", adopted: true }), { kind: "adopted", deviceId: "d", name: "Box" });
    assert.equal(interpretAdoptAnswer(200, { deviceId: "d", token: "t", gatewayWsUrl: "ws://x" }).kind, "rekeyed");
    assert.deepEqual(interpretAdoptAnswer(409, { reason: "inactive" }), { kind: "inactive" });
    assert.deepEqual(interpretAdoptAnswer(409, { reason: "other_account" }), { kind: "refuse", reason: "other_account" });
    assert.deepEqual(interpretAdoptAnswer(409, { reason: "other_device" }), { kind: "refuse", reason: "other_device" });
    assert.deepEqual(interpretAdoptAnswer(409, { reason: "unknown" }), { kind: "refuse", reason: "unknown" });
    assert.deepEqual(interpretAdoptAnswer(400, { error: "That code is wrong" }), { kind: "error", message: "That code is wrong" });
    assert.deepEqual(interpretAdoptAnswer(409, { error: "limit", reason: "weird" }), { kind: "error", message: "limit" });
    assert.equal(interpretAdoptAnswer(200, { deviceId: "d" }).kind, "error");
  });
  it("refusal messages explain --replace and never include a key", () => {
    for (const r of ["other_server", "other_account", "other_device", "unknown"] as const) {
      const m = refusalMessage(r, { host: "a.example", server: S, configDir: "/tmp/cfg" });
      assert.match(m, /--replace/);
      assert.match(m, /Nothing was changed/);
      assert.match(m, /RAKAZO_RUNNER_CONFIG_DIR/);
    }
  });
});

describe("one runner per config dir", () => {
  const base = { self: 100, alive: () => true, looksLikeRunner: () => true, pidFileAgeMs: 1000, platform: "linux" as NodeJS.Platform };
  it("detects a live runner from the pid file (M1 scripts/start.sh or M2)", () => {
    assert.equal(otherRunnerHolding({ ...base, pid: 42 }), 42);
  });
  it("ignores no pid, itself, dead pids and reused pids that are not runners", () => {
    assert.equal(otherRunnerHolding({ ...base, pid: null }), null);
    assert.equal(otherRunnerHolding({ ...base, pid: 100 }), null);
    assert.equal(otherRunnerHolding({ ...base, pid: 42, alive: () => false }), null);
    assert.equal(otherRunnerHolding({ ...base, pid: 42, looksLikeRunner: () => false }), null);
  });
  it("on Windows uses the pid file heartbeat", () => {
    assert.equal(otherRunnerHolding({ ...base, platform: "win32", pid: 42, pidFileAgeMs: 10_000 }), 42);
    assert.equal(otherRunnerHolding({ ...base, platform: "win32", pid: 42, pidFileAgeMs: 10 * 60_000 }), null);
  });
  it("recognises runner command lines (M1 checkout and installed)", () => {
    assert.ok(isRunnerCommandLine("node /home/u/projects/rakazo-online/runner/src/index.ts"));
    assert.ok(isRunnerCommandLine("/home/u/.local/share/rakijazios-runner/node-v22/bin/node /home/u/.local/share/rakijazios-runner/app/src/index.ts run"));
    assert.equal(isRunnerCommandLine("node /srv/other-app/src/index.ts"), false);
    assert.equal(isRunnerCommandLine("/usr/bin/bash"), false);
  });
  it("looksLikeRunner reads the real command line on Linux", { skip: process.platform !== "linux" }, async () => {
    const child = spawn(process.execPath, ["-e", "setTimeout(()=>{},5000)"], { stdio: "ignore" });
    try {
      assert.equal(looksLikeRunner(child.pid!), false);
      assert.equal(looksLikeRunner(2 ** 22 + 12345), false);
    } finally {
      child.kill();
    }
  });
});
