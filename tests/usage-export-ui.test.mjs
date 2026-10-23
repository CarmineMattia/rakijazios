// My hardware → usage CSV export: the picked range survives the periodic list refresh (P28-1),
// and a bad range shows an inline error and blocks the download (P28-2), same rules as the server.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { JSDOM } = require(process.env.RAKAZO_JSDOM_PATH || "jsdom");
const script = readFileSync(new URL("../patches/web/dist/local-hardware-overlay.js", import.meta.url), "utf8");

async function waitFor(fn, ms = 3000) {
  for (let i = 0; i < ms / 10; i++) {
    const v = fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 10));
  }
  return null;
}

const json = (status, body) => ({ ok: status < 400, status, json: async () => body });

async function mount() {
  const dom = new JSDOM(
    '<body><div data-testid="user-settings"><nav data-testid="settings-nav"><button data-testid="settings-nav-account">Account</button></nav><div>native</div></div></body>',
    { url: "http://localhost:5173/app", runScripts: "outside-only", pretendToBeVisual: true },
  );
  dom.window.fetch = async (url) => {
    const u = String(url);
    if (u === "/api/local-runners/config") return json(200, { enabled: true });
    if (u === "/api/local-runners/devices") return json(200, { devices: [], maxDevices: 3 });
    if (u.startsWith("/api/local-runners/usage?")) return json(200, { daily: [], people: [] });
    return json(404, { error: "not in this test" });
  };
  const observers = [], Observer = dom.window.MutationObserver;
  dom.window.MutationObserver = class extends Observer { constructor(cb) { super(cb); observers.push(this); } };
  dom.observers = observers;
  dom.window.eval(script);
  const doc = dom.window.document;
  const nav = await waitFor(() => doc.getElementById("rk-hw-nav"));
  assert.ok(nav, "My hardware nav mounted");
  return { dom, doc, nav };
}

// Opening My hardware again runs the same renderList() the 10 s refresh runs: everything is rebuilt.
async function openExport({ doc, nav }) {
  const prev = doc.querySelector('[data-rk="hw-usage-export"]');
  nav.click();
  return waitFor(() => {
    const w = doc.querySelector('[data-rk="hw-usage-export"]');
    return w && w !== prev ? w : null;
  });
}

function pick(dom, input, value) {
  input.value = value;
  input.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
  input.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
}

// Leave My hardware (stops the refresh timer), let pending fetches settle, then close.
async function unmount({ dom, doc }) {
  doc.querySelector('[data-testid="settings-nav-account"]').click();
  await new Promise((r) => setTimeout(r, 50));
  dom.observers.forEach((o) => o.disconnect());
  await new Promise((r) => setTimeout(r, 20));
  dom.window.close();
  await Promise.resolve();
}

const parts = (w) => ({
  from: w.querySelector('[data-rk="hw-usage-from"]'),
  to: w.querySelector('[data-rk="hw-usage-to"]'),
  link: w.querySelector('[data-rk="hw-usage-csv"]'),
  err: w.querySelector('[data-rk="hw-usage-error"]'),
});

test("default range is the last 30 days, with a working link and no error", async () => {
  const m = await mount();
  try {
    const { from, to, link, err } = parts(await openExport(m));
    const today = new Date().toISOString().slice(0, 10);
    const start = new Date(Date.now() - 29 * 86400000).toISOString().slice(0, 10);
    assert.equal(from.value, start);
    assert.equal(to.value, today);
    assert.equal(link.getAttribute("href"), `/api/local-runners/usage.csv?from=${start}&to=${today}`);
    assert.equal(err.textContent, "");
  } finally {
    await unmount(m);
  }
});

test("P28-1: the picked range survives a list refresh and is what the link downloads", async () => {
  const m = await mount();
  try {
    let w = await openExport(m);
    pick(m.dom, parts(w).from, "2026-10-01");
    pick(m.dom, parts(w).to, "2026-10-05");
    w = await openExport(m);
    const { from, to, link, err } = parts(w);
    assert.equal(from.value, "2026-10-01");
    assert.equal(to.value, "2026-10-05");
    assert.equal(link.getAttribute("href"), "/api/local-runners/usage.csv?from=2026-10-01&to=2026-10-05");
    assert.equal(err.textContent, "");
  } finally {
    await unmount(m);
  }
});

for (const [name, fromV, toV, msg] of [
  ["reversed range", "2026-10-05", "2026-10-01", /start date must be on or before the end date/],
  ["more than 366 days", "2025-01-01", "2026-01-02", /At most 366 days/],
  ["empty start date", "", "2026-10-05", /valid start date/],
  ["empty end date", "2026-10-01", "", /valid end date/],
]) {
  test(`P28-2: ${name} shows an inline error and blocks the download`, async () => {
    const m = await mount();
    try {
      let w = await openExport(m);
      pick(m.dom, parts(w).from, fromV);
      pick(m.dom, parts(w).to, toV);
      let { link, err } = parts(w);
      assert.match(err.textContent, msg);
      assert.equal(err.getAttribute("role"), "alert");
      assert.equal(link.hasAttribute("href"), false);
      assert.equal(link.getAttribute("aria-disabled"), "true");
      const click = new m.dom.window.MouseEvent("click", { bubbles: true, cancelable: true });
      link.dispatchEvent(click);
      assert.equal(click.defaultPrevented, true);
      // Still blocked after a refresh (the bad range is kept, not silently reset to the default).
      w = await openExport(m);
      ({ link, err } = parts(w));
      assert.match(err.textContent, msg);
      assert.equal(link.hasAttribute("href"), false);
      // Fixing the range clears the error and re-enables the link.
      pick(m.dom, parts(w).from, "2026-01-01");
      pick(m.dom, parts(w).to, "2026-12-31");
      ({ link, err } = parts(w));
      assert.equal(err.textContent, "");
      assert.equal(link.getAttribute("aria-disabled"), null);
      assert.equal(link.getAttribute("href"), "/api/local-runners/usage.csv?from=2026-01-01&to=2026-12-31");
    } finally {
      await unmount(m);
    }
  });
}

test("366 days exactly is allowed (same limit as the server)", async () => {
  const m = await mount();
  try {
    const w = await openExport(m);
    pick(m.dom, parts(w).from, "2025-01-01");
    pick(m.dom, parts(w).to, "2026-01-01");
    const { link, err } = parts(w);
    assert.equal(err.textContent, "");
    assert.equal(link.getAttribute("href"), "/api/local-runners/usage.csv?from=2025-01-01&to=2026-01-01");
  } finally {
    await unmount(m);
  }
});
