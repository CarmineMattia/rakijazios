import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertSecureTransport, readCredentials, writeCredentials } from "./config.ts";
import { EXIT_REFUSED } from "./existing.ts";
import { PairRefused, normalizePairingCode, pairDevice, sameServer } from "./pair.ts";

describe("pairing helpers", () => {
  it("normalizes codes like the server", () => {
    assert.equal(normalizePairingCode("k7qf-3mzd"), "K7QF3MZD");
    assert.equal(normalizePairingCode(" K7QF 3MZO "), "K7QF3MZ0");
    assert.equal(normalizePairingCode("IL00-0000"), "11000000");
    assert.throws(() => normalizePairingCode("K7QF-3MZ"));
    assert.throws(() => normalizePairingCode("K7QF-3MZU"));
  });

  it("only allows plain http/ws to this same computer", () => {
    assert.ok(assertSecureTransport("http://127.0.0.1:5173", "server"));
    assert.ok(assertSecureTransport("ws://localhost:5173/api/local-runners/ws", "gateway"));
    assert.ok(assertSecureTransport("https://rakijazios.example", "server"));
    assert.ok(assertSecureTransport("wss://rakijazios.example/api/local-runners/ws", "gateway"));
    assert.throws(() => assertSecureTransport("http://192.168.1.5:5173", "server"), /unencrypted/);
    assert.throws(() => assertSecureTransport("ws://example.com/api/local-runners/ws", "gateway"), /unencrypted/);
    assert.throws(() => assertSecureTransport("https://u:p@example.com", "server"), /credentials/);
    assert.throws(() => assertSecureTransport("ftp://example.com", "server"));
  });

  it("hands an old key back only to the server that issued it", () => {
    assert.equal(sameServer({ server: "https://a.example", gatewayWsUrl: "wss://a.example/x" }, "https://a.example"), true);
    assert.equal(sameServer({ server: "https://a.example", gatewayWsUrl: "wss://a.example/x" }, "https://b.example"), false);
    // M1 credentials have no `server`: same host only.
    assert.equal(sameServer({ gatewayWsUrl: "ws://127.0.0.1:3100/api/local-runners/ws" }, "http://127.0.0.1:5173"), true);
    assert.equal(sameServer({ gatewayWsUrl: "ws://127.0.0.1:3100/api/local-runners/ws" }, "https://evil.example"), false);
  });
});

type Seen = Array<Record<string, unknown>>;
const json = (body: unknown, status = 200) => Response.json(body, { status });
function fakeServer(seen: Seen, answer: (body: Record<string, unknown>) => Response) {
  return (async (_url: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    seen.push(body);
    return answer(body);
  }) as unknown as typeof fetch;
}
const S = "http://127.0.0.1:5173";
const GW = "ws://127.0.0.1:5173/api/local-runners/ws";

describe("pairDevice", () => {
  let dir = "";
  const file = () => join(dir, "credentials.json");
  const backups = () => readdirSync(dir).filter((f) => f.startsWith("credentials.") && f !== "credentials.json");
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "rk-runner-test-"));
    process.env.RAKAZO_RUNNER_CONFIG_DIR = dir;
    delete process.env.RAKAZO_RUNNER_CREDENTIALS;
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    delete process.env.RAKAZO_RUNNER_CONFIG_DIR;
  });

  it("fresh computer: stores the key privately and returns no secret", async () => {
    const seen: Seen = [];
    const out = await pairDevice({
      server: `${S}/`, code: "k7qf-3mzd", name: "box", runnerVersion: "t",
      fetchImpl: fakeServer(seen, () => json({ deviceId: "dev1", token: "SECRET-TOKEN-1", gatewayWsUrl: GW, name: "box" })),
    });
    assert.deepEqual(out, { outcome: "paired", deviceId: "dev1", name: "box" });
    assert.equal(JSON.stringify(out).includes("SECRET"), false);
    assert.equal(seen[0]!.code, "K7QF3MZD");
    assert.equal("adopt" in seen[0]! || "existing" in seen[0]!, false);
    assert.equal(statSync(file()).mode & 0o777, 0o600);
    assert.equal(readCredentials()?.token, "SECRET-TOKEN-1");
    assert.equal(readCredentials()?.server, S);
  });

  it("existing install on the same server: keeps the credentials untouched (adopt)", async () => {
    writeCredentials({ deviceId: "dev1", token: "OLD-KEY", gatewayWsUrl: GW, server: S });
    const before = readFileSync(file(), "utf8");
    const seen: Seen = [];
    const out = await pairDevice({
      server: S, code: "K7QF3MZD", runnerVersion: "t",
      fetchImpl: fakeServer(seen, () => json({ deviceId: "dev1", name: "Box", adopted: true })),
    });
    assert.deepEqual(out, { outcome: "adopted", deviceId: "dev1", name: "Box" });
    assert.deepEqual(seen[0]!.adopt, { deviceId: "dev1", token: "OLD-KEY" });
    assert.equal(readFileSync(file(), "utf8"), before);
    assert.deepEqual(backups(), []);
  });

  it("M1 credentials (no `server`, gateway on the api port of the same host) are adopted too", async () => {
    writeFileSync(file(), JSON.stringify({ deviceId: "m1dev", token: "M1-KEY", gatewayWsUrl: "ws://127.0.0.1:3100/api/local-runners/ws" }), { mode: 0o600 });
    const before = readFileSync(file(), "utf8");
    const seen: Seen = [];
    const out = await pairDevice({
      server: S, code: "K7QF3MZD", runnerVersion: "t",
      fetchImpl: fakeServer(seen, () => json({ deviceId: "m1dev", name: "my-pc", adopted: true })),
    });
    assert.equal(out.outcome, "adopted");
    assert.deepEqual(seen[0]!.adopt, { deviceId: "m1dev", token: "M1-KEY" });
    assert.equal(readFileSync(file(), "utf8"), before);
  });

  it("credentials for another server: refuses without sending anything, changes nothing", async () => {
    writeCredentials({ deviceId: "dev1", token: "OLD-KEY", gatewayWsUrl: "wss://a.example/api/local-runners/ws", server: "https://a.example" });
    const before = readFileSync(file(), "utf8");
    const seen: Seen = [];
    await assert.rejects(
      () => pairDevice({ server: "https://b.example", code: "K7QF3MZD", runnerVersion: "t", fetchImpl: fakeServer(seen, () => json({})) }),
      (err: unknown) => err instanceof PairRefused && err.exitCode === EXIT_REFUSED && /a\.example/.test(err.message) && /--replace/.test(err.message),
    );
    assert.equal(seen.length, 0); // the old key never leaves for another server
    assert.equal(readFileSync(file(), "utf8"), before);
  });

  for (const reason of ["other_account", "other_device", "unknown"] as const) {
    it(`server says ${reason}: refuses, credentials untouched, no backup`, async () => {
      writeCredentials({ deviceId: "dev1", token: "OLD-KEY", gatewayWsUrl: GW, server: S });
      const before = readFileSync(file(), "utf8");
      const seen: Seen = [];
      await assert.rejects(
        () => pairDevice({ server: S, code: "K7QF3MZD", runnerVersion: "t", fetchImpl: fakeServer(seen, () => json({ error: "no", reason }, 409)) }),
        (err: unknown) => err instanceof PairRefused && /Nothing was changed/.test(err.message),
      );
      assert.equal(seen.length, 1);
      assert.equal(readFileSync(file(), "utf8"), before);
      assert.deepEqual(backups(), []);
    });
  }

  it("dead key (removed / re-keyed): pairs again and keeps a private backup", async () => {
    writeCredentials({ deviceId: "dev1", token: "DEAD-KEY", gatewayWsUrl: GW, server: S });
    const seen: Seen = [];
    const out = await pairDevice({
      server: S, code: "K7QF3MZD", runnerVersion: "t",
      fetchImpl: fakeServer(seen, (b) => (b.adopt ? json({ error: "dead", reason: "inactive" }, 409) : json({ deviceId: "dev2", token: "NEW-KEY", gatewayWsUrl: GW, name: "box" }))),
    });
    assert.equal(out.outcome, "repaired");
    assert.equal(seen.length, 2);
    assert.equal("adopt" in seen[1]!, false);
    assert.equal(readCredentials()?.token, "NEW-KEY");
    const [backup] = backups();
    assert.ok(backup?.startsWith("credentials.previous-"));
    assert.equal(statSync(join(dir, backup!)).mode & 0o777, 0o600);
    assert.ok(readFileSync(join(dir, backup!), "utf8").includes("DEAD-KEY"));
  });

  it("a New key code for this computer: stores the new key for the same device", async () => {
    writeCredentials({ deviceId: "dev1", token: "ROTATED-OLD", gatewayWsUrl: GW, server: S });
    const out = await pairDevice({
      server: S, code: "K7QF3MZD", runnerVersion: "t",
      fetchImpl: fakeServer([], () => json({ deviceId: "dev1", token: "ROTATED-NEW", gatewayWsUrl: GW, name: "box", reused: true })),
    });
    assert.equal(out.outcome, "reconnected");
    assert.equal(readCredentials()?.token, "ROTATED-NEW");
  });

  it("--replace: pairs as a new computer, never sends the old key, keeps a backup", async () => {
    writeCredentials({ deviceId: "dev1", token: "OLD-KEY", gatewayWsUrl: "wss://a.example/api/local-runners/ws", server: "https://a.example" });
    const seen: Seen = [];
    const out = await pairDevice({
      server: S, code: "K7QF3MZD", runnerVersion: "t", replace: true,
      fetchImpl: fakeServer(seen, () => json({ deviceId: "dev9", token: "NEW-KEY", gatewayWsUrl: GW, name: "box" })),
    });
    assert.equal(out.outcome, "replaced");
    assert.equal(JSON.stringify(seen).includes("OLD-KEY"), false);
    assert.equal(readCredentials()?.token, "NEW-KEY");
    assert.ok(backups()[0]?.startsWith("credentials.replaced-"));
  });

  it("a failed pairing never touches existing credentials", async () => {
    writeCredentials({ deviceId: "dev1", token: "OLD-KEY", gatewayWsUrl: GW, server: S });
    const before = readFileSync(file(), "utf8");
    await assert.rejects(() =>
      pairDevice({ server: S, code: "K7QF3MZD", runnerVersion: "t", replace: true, fetchImpl: fakeServer([], () => json({ error: "That code is wrong" }, 400)) }),
    /That code is wrong/);
    assert.equal(readFileSync(file(), "utf8"), before);
  });

  it("refuses a server that answers with an insecure remote gateway", async () => {
    await assert.rejects(
      () => pairDevice({ server: "https://good.example", code: "K7QF3MZD", runnerVersion: "t", fetchImpl: fakeServer([], () => json({ deviceId: "d", token: "t", gatewayWsUrl: "ws://evil.example/ws" })) }),
      /unencrypted/,
    );
  });
});
