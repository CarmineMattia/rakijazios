// The approval card: pending approvals show up as a card; buttons decide that one approval.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { JSDOM } = require(process.env.RAKAZO_JSDOM_PATH || "jsdom");
const script = readFileSync(new URL("../patches/web/dist/parity-overlays.js", import.meta.url), "utf8");

async function waitFor(fn, ms = 3000) {
  for (let i = 0; i < ms / 10; i++) {
    const v = fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 10));
  }
  return null;
}

function mount(pending) {
  const dom = new JSDOM("<body></body>", { url: "http://localhost:5173/", runScripts: "outside-only" });
  const calls = [];
  dom.window.fetch = async (url, options = {}) => {
    calls.push({ url, method: options.method || "GET", body: options.body ? JSON.parse(options.body) : null });
    if (url === "/api/host-tools/approvals") return { ok: true, status: 200, json: async () => ({ approvals: pending.list }) };
    if (String(url).startsWith("/api/host-tools/approvals/")) {
      pending.list = [];
      return { ok: pending.decisionOk !== false, status: pending.decisionOk === false ? 410 : 200, statusText: "Gone", json: async () => (pending.decisionOk === false ? { error: "This approval expired." } : { ok: true }) };
    }
    return { ok: true, status: 200, json: async () => ({}) };
  };
  dom.window.eval(script);
  return { dom, calls };
}

const approval = { id: "ap-1", action: "run-command", target: "echo hi > notes.txt", expiresAt: new Date(Date.now() + 600000).toISOString() };

for (const [button, decision] of [["allow-once", "allow-once"], ["always", "always"], ["deny", "deny"]]) {
  test(`pending approval shows a card; ${button} posts that decision for that approval`, async () => {
    const state = { list: [approval] };
    const { dom, calls } = mount(state);
    try {
      const card = await waitFor(() => dom.window.document.getElementById("rk-host-approval"));
      assert.ok(card, "card shown");
      assert.equal(card.getAttribute("data-approval-id"), "ap-1");
      assert.match(card.textContent, /run-command: echo hi > notes\.txt/);
      assert.match(card.textContent, /Expires at/);
      card.querySelector(`button[data-decision="${button}"]`).click();
      await waitFor(() => !dom.window.document.getElementById("rk-host-approval"));
      const post = calls.find((c) => c.method === "POST");
      assert.deepEqual(post, { url: "/api/host-tools/approvals/ap-1/decision", method: "POST", body: { decision } });
      assert.equal(calls.some((c) => c.url === "/api/host-tools/grants"), false);
    } finally {
      dom.window.close();
    }
  });
}

test("an expired approval shows the error instead of pretending it ran", async () => {
  const state = { list: [approval], decisionOk: false };
  const { dom } = mount(state);
  try {
    const card = await waitFor(() => dom.window.document.getElementById("rk-host-approval"));
    card.querySelector('button[data-decision="allow-once"]').click();
    const status = await waitFor(() => {
      const s = dom.window.document.querySelector(".rk-approval-status");
      return s && s.textContent ? s : null;
    });
    assert.match(status.textContent, /expired/);
  } finally {
    dom.window.close();
  }
});
