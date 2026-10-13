// Shared helpers for the M2a end-to-end scripts (puppeteer-core + the live docker stack).
// Everything machine-specific comes from the environment; nothing secret lives here.
//   RK_BASE           web origin of the stack            (default http://127.0.0.1:5173)
//   RK_API_DIRECT     api port, for limiter checks       (default http://127.0.0.1:3100)
//   RK_NPM_DIR        dir whose node_modules has puppeteer-core (default /tmp/rk-e2e-npm)
//   RK_CHROME         Chrome/Chromium binary             (default /usr/bin/google-chrome-stable)
//   RK_E2E_OUT        browser profiles, screenshots, results (default /tmp/rk-e2e)
//   RK_PG_CONTAINER   postgres container                 (default rakazo-postgres-1)
//   RK_API_CONTAINER  api container                      (default rakazo-api-1)
// Login uses a magic link read from the `verification` table, so it only works against a
// stack you operate. Test accounts default to qa@rakazo.test / qa2@rakazo.test.
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

const env = (k, d) => process.env[k]?.trim() || d;
export const BASE = env('RK_BASE', 'http://127.0.0.1:5173');
export const API_DIRECT = env('RK_API_DIRECT', 'http://127.0.0.1:3100');
export const OUT = env('RK_E2E_OUT', '/tmp/rk-e2e');
export const PG = env('RK_PG_CONTAINER', 'rakazo-postgres-1');
export const API_CONTAINER = env('RK_API_CONTAINER', 'rakazo-api-1');
export const QA_EMAIL = env('RK_QA_EMAIL', 'qa@rakazo.test');
export const QA2_EMAIL = env('RK_QA2_EMAIL', 'qa2@rakazo.test');
const require = createRequire(join(env('RK_NPM_DIR', '/tmp/rk-e2e-npm'), 'package.json'));
const puppeteer = require('puppeteer-core');

export function sql(q) {
  return execFileSync('docker', ['exec', '-i', PG, 'psql', '-U', 'rakazo', '-d', 'rakazo', '-At', '-F', '|', '-c', q]).toString().trim();
}
export const q = (s) => String(s).replace(/'/g, "''");
export async function launch(profile) {
  return puppeteer.launch({ executablePath: env('RK_CHROME', '/usr/bin/google-chrome-stable'), headless: 'new',
    userDataDir: join(OUT, `profile-${profile}`), args: ['--no-sandbox', '--window-size=1400,950'],
    defaultViewport: { width: 1400, height: 950 } });
}
export async function loggedIn(page) {
  return page.evaluate(async () => { const r = await fetch('/api/auth/get-session', { credentials: 'include' }); const j = await r.json().catch(() => null); return j?.user ? { id: j.user.id, email: j.user.email, name: j.user.name } : null; });
}
export async function login(page, email) {
  await page.goto(BASE + '/sign-in', { waitUntil: 'networkidle2' });
  const who = await loggedIn(page);
  if (who && who.email === email) return who;
  const since = sql(`select now() at time zone 'utc'`);
  const res = await fetch(BASE + '/api/auth/sign-in/magic-link', { method: 'POST', headers: { 'content-type': 'application/json', origin: BASE },
    body: JSON.stringify({ email, callbackURL: BASE + '/app' }) });
  console.log('magic-link request', res.status);
  const token = sql(`select identifier from verification where value::text like '%"${q(email)}"%' and "createdAt" >= '${since}'::timestamp - interval '5 seconds' order by "createdAt" desc limit 1`);
  if (!token) throw new Error('no verification token for the test account');
  await page.goto(`${BASE}/api/auth/magic-link/verify?token=${token}&callbackURL=${encodeURIComponent(BASE + '/app')}`, { waitUntil: 'networkidle2' });
  const after = await loggedIn(page);
  if (!after || after.email !== email) throw new Error('login failed');
  return after;
}
export async function api(page, path, options = {}, spaceId) {
  return page.evaluate(async (path, options, spaceId) => {
    const headers = { 'content-type': 'application/json', ...(options.headers || {}) };
    const sid = spaceId || localStorage.getItem('rakazo:space-id'); if (sid) headers['x-rakazo-space-id'] = sid;
    const r = await fetch(path, { credentials: 'include', ...options, headers });
    let body; try { body = await r.json(); } catch { body = null; }
    return { status: r.status, body };
  }, path, options, spaceId);
}
export const shot = (page, name) => page.screenshot({ path: join(OUT, `${name}.png`), fullPage: false }).then(() => console.log('shot', name));
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const waitFor = async (fn, ms, step = 1000) => { const end = Date.now() + ms; while (Date.now() < end) { const v = await fn(); if (v) return v; await sleep(step); } return null; };

/** Settings → My hardware. */
export async function openHardware(page) {
  if (!(await page.$('[data-testid="user-settings"]'))) {
    await page.click('[data-testid="user-menu-trigger"]'); await sleep(400);
    await page.evaluate(() => [...document.querySelectorAll('button,[role=menuitem],a')].find((b) => b.textContent.trim() === 'Settings')?.click());
    await page.waitForSelector('[data-testid="user-settings"]', { timeout: 10000 });
  }
  await page.waitForSelector('#rk-hw-nav', { timeout: 10000 }); await page.click('#rk-hw-nav');
  await page.waitForSelector('#rk-hw-panel', { visible: true, timeout: 10000 });
}

/** Count how often any secret (and its dash-less form) appears in each text. */
export function leakCounts(texts, secrets) {
  const out = {};
  for (const [k, v] of Object.entries(texts)) {
    let n = 0;
    for (const s of secrets) { if (!s) continue; n += String(v).split(s).length - 1; const raw = s.replace('-', ''); if (raw !== s) n += String(v).split(raw).length - 1; }
    out[k] = n;
  }
  return out;
}
