// P29-2: "On my PC" finds the open bot in a real bot chat (/app/<botId>), not only /bots/<id> or ?botId=.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
const { JSDOM } = createRequire(import.meta.url)(process.env.RAKAZO_JSDOM_PATH || "jsdom");
const script = readFileSync(new URL("../patches/web/dist/parity-overlays.js", import.meta.url), "utf8");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function mount(url) {
  const dom = new JSDOM("<body></body>", { url, runScripts: "outside-only" });
  const calls = [], alerts = [];
  dom.window.alert = (m) => alerts.push(m);
  dom.window.fetch = async (u) => {
    calls.push(String(u));
    if (String(u).endsWith("/local-runners/offered-models")) return { ok: true, status: 200, json: async () => ({ devices: [] }) };
    if (String(u).includes("/local-runners/bots/")) return { ok: true, status: 200, json: async () => ({ id: "x", onMyComputer: false }) };
    return { ok: true, status: 200, json: async () => ({ approvals: [] }) };
  };
  dom.window.eval(script);
  // The menu installs on DOMContentLoaded; wait for it.
  const click = async () => {
    let b;
    for (let i = 0; i < 100 && !b; i++) {
      b = [...dom.window.document.querySelectorAll("#rk-parity-fab button")].find((x) => x.textContent === "On my PC");
      if (!b) await sleep(10);
    }
    assert.ok(b, "On my PC button installed");
    b.click();
  };
  return { dom, calls, alerts, click };
}

for (const [url, want] of [
  ["http://localhost:5173/app/cmbot123abc", "cmbot123abc"],
  ["http://localhost:5173/app/cmbot123abc?thread=t1", "cmbot123abc"],
  ["http://localhost:5173/app?botId=cmbot456", "cmbot456"],
  ["http://localhost:5173/bots/cmbot789", "cmbot789"],
]) {
  test(`On my PC opens the picker for ${new URL(url).pathname}${new URL(url).search}`, async () => {
    const f = mount(url);
    try {
      assert.equal(f.dom.window.RakijaziosParity.currentBotId(), want);
      await f.click();
      await sleep(30);
      assert.deepEqual(f.alerts, []);
      assert.ok(f.calls.includes(`/api/local-runners/bots/${want}`), f.calls.join(","));
    } finally { f.dom.window.close(); }
  });
}

for (const url of ["http://localhost:5173/app/g/cmgroup1", "http://localhost:5173/app", "http://localhost:5173/app/"]) {
  test(`On my PC asks to open a bot chat on ${new URL(url).pathname}`, async () => {
    const f = mount(url);
    try {
      assert.equal(f.dom.window.RakijaziosParity.currentBotId(), null);
      await f.click();
      assert.deepEqual(f.alerts, ["Open a bot chat first, then use On my PC."]);
    } finally { f.dom.window.close(); }
  });
}
