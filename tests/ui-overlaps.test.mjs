// UI overlaps (Rakazo Tester, Oct 23): the parity "Tools" menu must never cover the composer (send button)
// and the PWA install toast must only show on touch devices, below the chat header.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
const { JSDOM } = createRequire(import.meta.url)(process.env.RAKAZO_JSDOM_PATH || "jsdom");
const parity = readFileSync(new URL("../patches/web/dist/parity-overlays.js", import.meta.url), "utf8");
const pwa = readFileSync(new URL("../patches/web/dist/pwa-overlay.js", import.meta.url), "utf8");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rect = (l, t, r, b) => ({ left: l, top: t, right: r, bottom: b, x: l, y: t, width: r - l, height: b - t });
const PHONE = { w: 390, h: 844, composer: rect(12, 770, 378, 828), header: rect(0, 0, 390, 66) };
const DESKTOP = { w: 1400, h: 950, composer: rect(340, 868, 1376, 926), header: rect(316, 0, 1400, 64) };

function dom({ w, h, coarse = false }) {
  const d = new JSDOM("<body></body>", { url: "http://localhost:5173/app/cmbot1", runScripts: "outside-only" });
  const win = d.window;
  Object.defineProperty(win, "innerWidth", { value: w, configurable: true });
  Object.defineProperty(win, "innerHeight", { value: h, configurable: true });
  win.matchMedia = (q) => ({ matches: q.includes("pointer: coarse") ? coarse : false, media: q, addEventListener() {}, removeEventListener() {} });
  win.alert = () => {};
  win.fetch = async () => ({ ok: true, status: 200, json: async () => ({ approvals: [], devices: [] }) });
  return d;
}
function addComposer(d, r) {
  const c = d.window.document.createElement("div");
  c.dataset.testid = "composer-bar";
  c.innerHTML = '<textarea></textarea><button aria-label="Send">→</button>';
  c.getBoundingClientRect = () => r;
  d.window.document.body.append(c);
  return c;
}
async function fab(d) {
  for (let i = 0; i < 100; i++) { const f = d.window.document.getElementById("rk-parity-fab"); if (f) return f; await sleep(10); }
  throw new Error("menu not installed");
}
// The menu's bottom edge (viewport y) given its CSS bottom offset.
const menuBottomY = (d, f) => d.window.innerHeight - parseFloat(f.style.bottom);

for (const [name, vp] of [["390 px phone", PHONE], ["desktop", DESKTOP]]) {
  test(`Tools menu sits above the composer (${name})`, async () => {
    const d = dom({ w: vp.w, h: vp.h });
    addComposer(d, vp.composer);
    d.window.eval(parity);
    const f = await fab(d);
    d.window.RakijaziosParity.placeMenu();
    assert.ok(menuBottomY(d, f) < vp.composer.top, `menu bottom ${menuBottomY(d, f)} above composer top ${vp.composer.top}`);
    assert.equal(f.style.bottom, `${vp.h - vp.composer.top + 8}px`);
    assert.equal(f.style.right, `${vp.w - vp.composer.right}px`, "aligned with the composer's right edge");
    // Collapsed by default; the six actions are still in the DOM (e2e 69 clicks "On my PC").
    const list = f.querySelector('[data-rk="parity-fab-list"]');
    const toggle = f.querySelector('[data-rk="parity-fab-toggle"]');
    assert.equal(list.style.display, "none");
    assert.deepEqual([...list.querySelectorAll("button")].map((b) => b.textContent), ["Permissions", "Marketplace", "Connectors", "Security", "On my PC", "Routines"]);
    // The expanded list opens upward inside the same container, so it is above the composer too.
    toggle.click();
    assert.equal(list.style.display, "flex");
    assert.equal(toggle.getAttribute("aria-expanded"), "true");
    assert.equal(f.lastElementChild, toggle, "toggle is the bottom-most item");
    d.window.document.dispatchEvent(new d.window.KeyboardEvent("keydown", { key: "Escape" }));
    assert.equal(list.style.display, "none");
    d.window.close();
  });
}

test("Tools menu follows a growing composer and falls back to 16px without one", async () => {
  const d = dom({ w: 390, h: 844 });
  d.window.eval(parity);
  const f = await fab(d);
  assert.equal(f.style.bottom, "16px");
  const c = addComposer(d, PHONE.composer);
  await sleep(450); // re-measured on its own (interval), no resize needed
  assert.equal(f.style.bottom, "82px");
  c.getBoundingClientRect = () => rect(12, 690, 378, 828); // composer grew with a long message
  await sleep(450);
  assert.ok(menuBottomY(d, f) < 690);
  c.remove();
  await sleep(450);
  assert.equal(f.style.bottom, "16px");
  d.window.close();
});

test("picking an action closes the menu and still runs it", async () => {
  const d = dom({ w: 1400, h: 950 });
  d.window.eval(parity);
  const f = await fab(d);
  f.querySelector('[data-rk="parity-fab-toggle"]').click();
  const calls = [];
  d.window.fetch = async (u) => { calls.push(String(u)); return { ok: true, status: 200, json: async () => ({ devices: [] }) }; };
  [...f.querySelectorAll("button")].find((b) => b.textContent === "On my PC").click();
  await sleep(50);
  assert.equal(f.querySelector('[data-rk="parity-fab-list"]').style.display, "none");
  assert.ok(calls.some((u) => u.includes("/local-runners/")), "On my PC opened the picker");
  d.window.close();
});

function installEvent(win) {
  const e = new win.Event("beforeinstallprompt", { cancelable: true });
  e.prompt = () => {}; e.userChoice = Promise.resolve({ outcome: "dismissed" });
  return e;
}
function addHeader(d, r) {
  const row = d.window.document.createElement("div");
  row.innerHTML = '<span data-testid="chat-header-status">Today 18:14</span>';
  row.getBoundingClientRect = () => r;
  row.firstChild.getBoundingClientRect = () => rect(r.left + 90, 37, r.left + 193, 50);
  d.window.document.body.append(row);
}

test("install toast is not shown on desktop (fine pointer)", () => {
  const d = dom({ w: DESKTOP.w, h: DESKTOP.h, coarse: false });
  addHeader(d, DESKTOP.header);
  d.window.eval(pwa);
  d.window.dispatchEvent(installEvent(d.window));
  assert.equal(d.window.document.getElementById("rk-pwa-install"), null);
  d.window.close();
});

test("install toast shows on a 390 px touch phone, below the chat header and above the composer", () => {
  const d = dom({ w: PHONE.w, h: PHONE.h, coarse: true });
  addHeader(d, PHONE.header);
  addComposer(d, PHONE.composer);
  d.window.eval(pwa);
  d.window.dispatchEvent(installEvent(d.window));
  const bar = d.window.document.getElementById("rk-pwa-install");
  assert.ok(bar, "toast shown on touch");
  assert.equal(bar.style.top, "74px");
  assert.ok(parseFloat(bar.style.top) >= PHONE.header.bottom, "never over the header");
  assert.ok(parseFloat(bar.style.top) + 80 < PHONE.composer.top, "nowhere near the composer");
  bar.querySelector('[data-rk="pwa-install-dismiss"]').click();
  assert.equal(d.window.document.getElementById("rk-pwa-install"), null);
  assert.ok(d.window.localStorage.getItem("rk-pwa-install-dismissed"));
  d.window.close();
});

test("install toast follows a taller header (e.g. transcript starting lower)", () => {
  const d = dom({ w: PHONE.w, h: PHONE.h, coarse: true });
  addHeader(d, PHONE.header);
  const t = d.window.document.createElement("div");
  t.dataset.testid = "transcript";
  t.getBoundingClientRect = () => rect(0, 96, 390, 760);
  d.window.document.body.append(t);
  d.window.eval(pwa);
  d.window.dispatchEvent(installEvent(d.window));
  assert.equal(d.window.document.getElementById("rk-pwa-install").style.top, "104px");
  d.window.close();
});
