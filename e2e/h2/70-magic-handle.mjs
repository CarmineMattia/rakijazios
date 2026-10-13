// H2 e2e: a brand-new magic-link sign-up gets an @handle from its email local part (no "?"),
// and a taken handle gets a _2 suffix. Creates two throwaway @rakazo.test accounts
// (qa-h2-<ts>, qah2dup<ts>) plus one placeholder that holds the taken handle; it prints their
// addresses at the end and deletes nothing (accounts own spaces/bots). Never prints tokens.
//   RK_BASE (http://127.0.0.1:5173)  RK_NPM_DIR (puppeteer-core)  RK_CHROME  RK_PG_CONTAINER  RK_E2E_OUT
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import fs from 'node:fs';
const env = (k, d) => process.env[k]?.trim() || d;
const BASE = env('RK_BASE', 'http://127.0.0.1:5173');
const OUT = env('RK_E2E_OUT', '/tmp/rk-e2e');
const PG = env('RK_PG_CONTAINER', 'rakazo-postgres-1');
const puppeteer = createRequire(join(env('RK_NPM_DIR', '/tmp/rk-e2e-npm'), 'package.json'))('puppeteer-core');
const sql = (q) => execFileSync('docker', ['exec', '-i', PG, 'psql', '-U', 'rakazo', '-d', 'rakazo', '-At', '-F', '|', '-c', q]).toString().trim();
const q = (s) => String(s).replace(/'/g, "''");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0; const results = {};
const ok = (k, v, pass) => { results[k] = { v, pass }; if (!pass) failures++; console.log(pass ? 'CHECK' : 'FAIL ', k, JSON.stringify(v)); };
fs.mkdirSync(OUT, { recursive: true });

async function signUp(email) {
  const browser = await puppeteer.launch({ executablePath: env('RK_CHROME', '/usr/bin/google-chrome-stable'), headless: 'new', args: ['--no-sandbox', '--window-size=1400,950'], defaultViewport: { width: 1400, height: 950 } });
  try {
    const page = await browser.newPage();
    await page.goto(BASE + '/sign-in', { waitUntil: 'networkidle2' });
    const since = sql(`select now() at time zone 'utc'`);
    let res;
    for (let i = 0; i < 4; i++) {
      res = await fetch(BASE + '/api/auth/sign-in/magic-link', { method: 'POST', headers: { 'content-type': 'application/json', origin: BASE }, body: JSON.stringify({ email, callbackURL: BASE + '/app' }) });
      if (res.status !== 429) break;
      await sleep((Number(res.headers.get('retry-after')) || 15 * (i + 1)) * 1000);
    }
    const token = sql(`select identifier from verification where value::text like '%"${q(email)}"%' and "createdAt" >= '${since}'::timestamp - interval '5 seconds' order by "createdAt" desc limit 1`);
    if (!token) throw new Error(`no verification token (magic-link ${res.status})`);
    await page.goto(`${BASE}/api/auth/magic-link/verify?token=${token}&callbackURL=${encodeURIComponent(BASE + '/app')}`, { waitUntil: 'networkidle2' });
    await sleep(2500);
    const session = await page.evaluate(async () => (await (await fetch('/api/auth/get-session', { credentials: 'include' })).json().catch(() => null))?.user ?? null);
    const onboardingText = await page.evaluate(() => document.body.innerText.slice(0, 400));
    if (process.env.RK_H2_DEBUG) console.log('PAGE', new URL(page.url()).pathname, JSON.stringify(onboardingText));
    // The avatar lives in the app shell; open /app (onboarding may redirect back, that's fine).
    await page.goto(BASE + '/app', { waitUntil: 'networkidle2' }); await sleep(2000);
    const avatar = await page.$eval('[data-testid="user-menu-trigger"]', (n) => n.innerText.trim()).catch(() => null);
    if (process.env.RK_H2_DEBUG) console.log('APP', new URL(page.url()).pathname, JSON.stringify(await page.evaluate(() => document.body.innerText.slice(0, 300))));
    await page.screenshot({ path: join(OUT, `h2-${email.split('@')[0]}.png`) });
    return { session, avatar, text: onboardingText, path: new URL(page.url()).pathname };
  } finally {
    await browser.close();
  }
}

const ts = Date.now().toString(36);
// 1) fresh account → handle from the local part
const e1 = `qa-h2-${ts}@rakazo.test`;
const r1 = await signUp(e1);
const want1 = `qa_h2_${ts}`;
ok('newAccountHasHandle', { name: r1.session?.name, path: r1.path }, r1.session?.name === want1);
ok('dbName', sql(`select name from "user" where email='${q(e1)}'`), sql(`select name from "user" where email='${q(e1)}'`) === want1);
// (a brand-new account stops at model onboarding; the avatar is checked on an onboarded account below)
ok('noOnboardingError', r1.text, !/Internal server error/i.test(r1.text || ''));
// 2) taken handle (any case) → _2
const base2 = `qah2dup${ts}`;
const holder = `holder-${ts}@rakazo.test`;
sql(`insert into "user" (id, name, email, "emailVerified", "createdAt", "updatedAt") values ('h2holder${ts}', '${base2.toUpperCase()}', '${holder}', false, now(), now())`);
const e2 = `${base2}@rakazo.test`;
const r2 = await signUp(e2);
ok('takenHandleGetsSuffix', r2.session?.name, r2.session?.name === `${base2}_2`);
// 3) existing named accounts untouched
ok('qaNameUnchanged', sql(`select name from "user" where email='qa@rakazo.test'`), sql(`select name from "user" where email='qa@rakazo.test'`) === 'rakazo_qa');
sql(`delete from "user" where id='h2holder${ts}'`);
// 4) an onboarded account that had no handle (backfilled): avatar shows a letter, not "?"
const existing = env('RK_H2_EXISTING', 'qa3@rakazo.test');
const r3 = await signUp(existing);
ok('existingHasHandle', r3.session?.name, !!r3.session?.name);
ok('avatarNotQuestionMark', { avatar: r3.avatar, path: r3.path }, r3.avatar !== null && r3.avatar !== '' && !r3.avatar.split('\n').includes('?'));
console.log('created test accounts:', e1, e2);
fs.writeFileSync(join(OUT, 'h2-results.json'), JSON.stringify(results, null, 2));
console.log(failures ? `FAILED ${failures}` : 'ALL PASSED');
process.exit(failures ? 1 : 0);
