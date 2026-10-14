#!/usr/bin/env node
// After a deploy, ONE reload must run the new overlay code, with the service worker active.
// Deploys a harmless marker into the live pwa-overlay.js twice (plain in-place change, then a
// change + scripts/stamp-overlays.mjs), reloads once each time, checks the marker; restores after.
// Needs write access to the live dist: RK_LIVE_DIST (default ~/projects/rakazo/patches/web/dist).
import { readFileSync, writeFileSync, copyFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { launch, login, sleep, BASE, QA_EMAIL } from '../m2a/lib.mjs';

const DIST = process.env.RK_LIVE_DIST || join(homedir(), 'projects/rakazo/patches/web/dist');
const STAMP = new URL('../../scripts/stamp-overlays.mjs', import.meta.url).pathname;
const file = join(DIST, 'pwa-overlay.js'); const index = join(DIST, 'index.html');
const orig = { file: readFileSync(file), index: readFileSync(index) };
let failed = 0;
const ok = (name, got, pass) => { if (!pass) failed++; console.log(`${pass ? 'PASS' : 'FAIL'} ${name} ${JSON.stringify(got)}`); };
const deploy = (token, stamp) => {
  writeFileSync(file, Buffer.concat([orig.file, Buffer.from(`\nwindow.__rkDeployMarker = ${JSON.stringify(token)};\n`)]));
  if (stamp) execFileSync('node', [STAMP, DIST]);
};
const marker = (page) => page.waitForFunction(() => window.__rkPwa === true, { timeout: 15000 }).then(() => page.evaluate(() => window.__rkDeployMarker ?? null));
const browser = await launch('qa-mobile');
try {
  const page = await browser.newPage();
  await login(page, QA_EMAIL);
  await page.goto(BASE + '/app', { waitUntil: 'networkidle2' });
  await page.waitForFunction(async () => !!(await navigator.serviceWorker.getRegistration())?.active, { timeout: 20000 });
  // A profile from before this deploy still runs the v1 worker: let the browser pick up the new sw.js
  // (skipWaiting + clients.claim), then reload so the page is controlled by v2 and overlays are cached.
  await page.evaluate(async () => { const r = await navigator.serviceWorker.getRegistration(); await r.update(); });
  await page.waitForFunction(async () => { const k = await caches.keys(); return k.includes('rk-shell-v2') && !k.includes('rk-shell-v1'); }, { timeout: 20000 });
  await page.reload({ waitUntil: 'networkidle2' });
  await page.reload({ waitUntil: 'networkidle2' });
  const sw = await page.evaluate(async () => ({ controlled: !!navigator.serviceWorker.controller, caches: await caches.keys() }));
  ok('swControlsPage', sw, sw.controlled && sw.caches.includes('rk-shell-v2') && !sw.caches.includes('rk-shell-v1'));
  ok('noMarkerBefore', await marker(page), (await marker(page)) === null);

  const t1 = `inplace-${Date.now()}`; deploy(t1, false);
  await page.reload({ waitUntil: 'networkidle2' });
  ok('oneReloadRunsInPlaceChange', await marker(page), (await marker(page)) === t1);

  const t2 = `stamped-${Date.now()}`; deploy(t2, true);
  const tag = readFileSync(index, 'utf8').match(/pwa-overlay\.js\?v=(\w+)/)?.[1];
  await page.reload({ waitUntil: 'networkidle2' });
  const loaded = await page.evaluate(() => [...document.scripts].map((s) => s.src).find((s) => s.includes('pwa-overlay.js')));
  ok('stampedTagLoaded', loaded, loaded?.includes(`v=${tag}`));
  ok('oneReloadRunsStampedChange', await marker(page), (await marker(page)) === t2);

  // offline: cached shell + overlays still come up
  await page.setOfflineMode(true);
  await page.reload({ waitUntil: 'domcontentloaded' }).catch(() => {});
  const off = await page.waitForFunction(() => window.__rkPwa === true, { timeout: 10000 }).then(() => true).catch(() => false);
  ok('offlineShellRunsOverlays', off, off);
  await page.setOfflineMode(false);
} finally {
  writeFileSync(file, orig.file); writeFileSync(index, orig.index);
  await browser.close();
}
console.log(failed ? `${failed} FAILED` : 'ALL PASSED');
process.exit(failed ? 1 : 0);
