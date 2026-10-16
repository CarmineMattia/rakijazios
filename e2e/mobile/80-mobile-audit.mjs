#!/usr/bin/env node
// Mobile usability audit (Pixel 5 profile, 393x851 @2.75, touch): sign-in, app shell, chat + composer,
// settings, My hardware, PWA (manifest, service worker, cache contents). Screenshots → $OUT/mobile-*.png.
import { createRequire } from 'node:module';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { launch, login, sql, sleep, BASE, OUT, QA_EMAIL, q } from '../m2a/lib.mjs';
const require = createRequire(process.env.RK_NPM_DIR ? join(process.env.RK_NPM_DIR, 'package.json') : import.meta.url);
const { KnownDevices } = require('puppeteer-core');
const PIXEL = KnownDevices['Pixel 5'];
const results = []; let failed = 0;
const ok = (name, got, pass) => { results.push({ name, pass: !!pass, got }); if (!pass) failed++; console.log(`${pass ? 'PASS' : 'FAIL'} ${name} ${JSON.stringify(got)}`); };
mkdirSync(OUT, { recursive: true });
const snap = (page, name) => page.screenshot({ path: join(OUT, `mobile-${name}.png`) }).then(() => console.log('shot', `mobile-${name}.png`));
// Elements wider than the screen or sticking out of it (ignores hidden / off-canvas drawers and scrollers' children).
const overflow = (page) => page.evaluate(() => {
  const vw = window.innerWidth; const bad = [];
  for (const el of document.querySelectorAll('body *')) {
    const cs = getComputedStyle(el); if (cs.display === 'none' || cs.visibility === 'hidden' || +cs.opacity === 0) continue;
    const r = el.getBoundingClientRect(); if (!r.width || !r.height) continue;
    if (r.right <= 0 || r.left >= vw) continue; // fully off-canvas (closed drawers)
    let p = el.parentElement, clipped = false;
    while (p && p !== document.body) { const o = getComputedStyle(p).overflowX; if (o !== 'visible') { clipped = true; break; } p = p.parentElement; }
    if (clipped) continue;
    if (r.right > vw + 1 || r.left < -1) bad.push(`${el.tagName.toLowerCase()}${el.id ? '#' + el.id : ''}${el.dataset.rk ? '[rk=' + el.dataset.rk + ']' : ''}.${String(el.className).slice(0, 40)} ${Math.round(r.left)}..${Math.round(r.right)}`);
  }
  return { docWidth: document.documentElement.scrollWidth, vw, bad: bad.slice(0, 12) };
});
// Tap targets under 32px (buttons/links that are visible).
const smallTargets = (page) => page.evaluate(() => [...document.querySelectorAll('button, a[href], [role=button], input, textarea, select')]
  .filter((el) => { const r = el.getBoundingClientRect(); const cs = getComputedStyle(el); return r.width && r.height && cs.visibility !== 'hidden' && r.top < innerHeight && r.bottom > 0 && r.left < innerWidth && r.right > 0 && (r.height < 32 || r.width < 32); })
  .map((el) => `${el.tagName.toLowerCase()} "${(el.getAttribute('aria-label') || el.textContent || el.placeholder || '').trim().slice(0, 30)}" ${Math.round(el.getBoundingClientRect().width)}x${Math.round(el.getBoundingClientRect().height)}`).slice(0, 15));

const browser = await launch('qa-mobile');
try {
  // Signed-out sign-in page in a clean context.
  const anon = await browser.createBrowserContext();
  const p0 = await anon.newPage(); await p0.emulate(PIXEL);
  await p0.goto(BASE + '/sign-in', { waitUntil: 'networkidle2' }); await sleep(800);
  await snap(p0, '01-sign-in');
  const o0 = await overflow(p0); ok('signInNoHorizontalOverflow', o0, o0.docWidth <= o0.vw + 1 && !o0.bad.length);
  ok('signInTapTargets', await smallTargets(p0), true);
  const manifest = await p0.evaluate(async () => (await fetch('/site.webmanifest')).json());
  ok('manifest', { name: manifest.name, icons: manifest.icons.map((i) => `${i.sizes}/${i.purpose}`) }, manifest.name === 'Rakijazios' && manifest.icons.some((i) => i.purpose === 'maskable' && i.sizes === '512x512') && manifest.icons.some((i) => i.sizes === '192x192' && i.purpose === 'any'));
  await anon.close();

  const page = await browser.newPage(); await page.emulate(PIXEL);
  await login(page, QA_EMAIL);
  await page.goto(BASE + '/app', { waitUntil: 'networkidle2' }); await sleep(1500);
  await snap(page, '02-app');
  const o1 = await overflow(page); ok('appNoHorizontalOverflow', o1, o1.docWidth <= o1.vw + 1 && !o1.bad.length);
  ok('appTapTargets', await smallTargets(page), true);
  writeFileSync(join(OUT, 'mobile-app.html'), await page.content());
  const bar = await page.evaluate(() => { const b = document.getElementById('rk-pwa-install')?.getBoundingClientRect(); const c = document.querySelector('textarea')?.getBoundingClientRect(); return { bar: b ? [Math.round(b.top), Math.round(b.bottom)] : null, composer: c ? [Math.round(c.top), Math.round(c.bottom)] : null }; });
  ok('installBarDoesNotCoverComposer', bar, !bar.bar || !bar.composer || bar.bar[1] < bar.composer[0] || bar.bar[0] > bar.composer[1]);
  await page.evaluate(() => document.querySelector('[data-rk="pwa-install-dismiss"]')?.click());
  // composer
  const ta = await page.$('textarea');
  ok('composerVisible', !!ta, !!ta);
  if (ta) { await ta.tap(); await page.keyboard.type('Hello from a phone, this is a long line to see how the composer grows on a small screen'); await sleep(400); }
  await snap(page, '03-composer');
  const comp = await page.evaluate(() => { const t = document.querySelector('textarea'); const r = t.getBoundingClientRect(); const form = t.closest('form') || t.parentElement.parentElement; const fr = form.getBoundingClientRect(); return { ta: [Math.round(r.left), Math.round(r.width), Math.round(r.height)], box: [Math.round(fr.left), Math.round(fr.width)], vw: innerWidth, html: form.outerHTML.slice(0, 1500) }; });
  writeFileSync(join(OUT, 'mobile-composer.json'), JSON.stringify(comp, null, 2));
  ok('composerWidth', comp.ta, comp.ta[1] >= comp.vw * 0.45);
  await page.evaluate(() => { const t = document.querySelector('textarea'); const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set; set.call(t, ''); t.dispatchEvent(new Event('input', { bubbles: true })); });
  // drawer / menu
  const burger = await page.$('button[aria-label="Open navigation"]');
  ok('burgerVisible', !!burger, !!burger && await burger.isIntersectingViewport());
  if (burger) { await burger.tap(); await sleep(700); }
  await snap(page, '04-drawer');
  const o2 = await overflow(page); ok('drawerNoHorizontalOverflow', o2, o2.docWidth <= o2.vw + 1);
  writeFileSync(join(OUT, 'mobile-drawer.html'), await page.content());
  const trig = await page.$('[data-testid="user-menu-trigger"]');
  ok('userMenuReachable', !!trig, !!trig && await trig.isIntersectingViewport());
  if (trig && await trig.isIntersectingViewport()) { await trig.tap(); await sleep(500); await snap(page, '05-user-menu');
    await page.evaluate(() => [...document.querySelectorAll('button,[role=menuitem],a')].find((b) => b.textContent.trim() === 'Settings')?.click()); await sleep(1500); }
  await snap(page, '06-settings');
  const o3 = await overflow(page); ok('settingsNoHorizontalOverflow', o3, o3.docWidth <= o3.vw + 1 && !o3.bad.length);
  ok('settingsTapTargets', await smallTargets(page), true);
  writeFileSync(join(OUT, 'mobile-settings.html'), await page.content());
  const sheet = await page.$eval('[data-testid="user-settings"]', (n) => { const r = n.getBoundingClientRect(); return [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)]; });
  ok('settingsFullScreen', sheet, sheet[0] === 0 && sheet[1] === 0 && sheet[2] === 393);
  ok('settingsNavHasFade', await page.$eval('[data-testid="settings-nav"]', (n) => getComputedStyle(n).maskImage || getComputedStyle(n).webkitMaskImage), true);
  // Swipe the tab strip to its end, as a person would.
  await page.$eval('[data-testid="settings-nav"]', (n) => { n.scrollLeft = n.scrollWidth; n.dispatchEvent(new Event('scroll')); }); await sleep(400);
  const hw = await page.$('#rk-hw-nav');
  ok('myHardwareNavReachable', !!hw, !!hw && await hw.isIntersectingViewport());
  if (hw) { await hw.tap(); await sleep(2500); }
  await snap(page, '07-my-hardware');
  const o4 = await overflow(page); ok('hardwareNoHorizontalOverflow', o4, o4.docWidth <= o4.vw + 1 && !o4.bad.length);
  ok('hardwareTapTargets', await smallTargets(page), true);
  await page.evaluate(() => window.scrollTo(0, 99999)); await page.evaluate(() => document.querySelectorAll('*').forEach((e) => { if (e.scrollHeight > e.clientHeight + 50 && getComputedStyle(e).overflowY !== 'visible') e.scrollTop = 600; })); await sleep(400);
  await snap(page, '08-my-hardware-scrolled');
  writeFileSync(join(OUT, 'mobile-hardware.html'), await page.content());
  // PWA: service worker controls the page; cache holds no API/auth responses
  await page.goto(BASE + '/app', { waitUntil: 'networkidle2' }); await sleep(1500);
  const sw = await page.evaluate(async () => { const reg = await navigator.serviceWorker.getRegistration(); const keys = []; for (const n of await caches.keys()) { const c = await caches.open(n); for (const r of await c.keys()) keys.push(new URL(r.url).pathname); } return { scope: reg?.scope, active: !!reg?.active, controlled: !!navigator.serviceWorker.controller, keys }; });
  ok('serviceWorkerActive', { scope: sw.scope, active: sw.active, controlled: sw.controlled, n: sw.keys.length }, sw.active && sw.controlled);
  ok('cacheHasShellOnly', sw.keys.filter((k) => /^\/(api|rpc|novnc)/.test(k)), sw.keys.length > 3 && !sw.keys.some((k) => /^\/(api|rpc|novnc)/.test(k)));
  const authAfter = await page.evaluate(async () => { const r = await fetch('/api/auth/get-session'); return { status: r.status, sw: r.headers.get('x-from-sw') }; });
  ok('apiStillLive', authAfter, authAfter.status === 200);
} finally {
  await browser.close();
  writeFileSync(join(OUT, 'mobile-audit-results.json'), JSON.stringify(results, null, 2));
}
console.log(failed ? `${failed} FAILED` : 'ALL PASSED');
