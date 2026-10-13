// Runner health e2e: a throwaway 0.2.3 runner for the QA account reports health; the owner
// can "Check now" (API + UI); another account gets 404; a stopped runner reads as not reachable.
// Only the computer and pairing this script creates are removed. Never prints codes or tokens.
import { launch, login, api, sql, sleep, shot, waitFor, BASE, OUT, QA_EMAIL, QA2_EMAIL, q } from '../m2a/lib.mjs';
import { spawnSync, execFileSync } from 'node:child_process';
import fs from 'node:fs';
const T = '/tmp/rk-health-e2e';
const SVC = 'rakijazios-runner-e2e-health';
const results = {}; const secrets = []; let failures = 0;
const ok = (k, v, pass = true) => { results[k] = { v, pass }; if (!pass) failures++; console.log(pass ? 'CHECK' : 'FAIL ', k, JSON.stringify(v)); };
fs.rmSync(T, { recursive: true, force: true }); fs.mkdirSync(T + '/home', { recursive: true, mode: 0o700 });
const startedAt = new Date().toISOString();
const env = () => { const e = { ...process.env, HOME: T + '/home', RAKAZO_RUNNER_CONFIG_DIR: T + '/cfg', RAKAZO_RUNNER_SERVICE: SVC }; delete e.XDG_CONFIG_HOME; return e; };
const runnerPids = () => { try { return execFileSync('pgrep', ['-f', 'rk-health-e2e/home/.local/share/rakijazios-runner/app/src/index.ts']).toString().trim().split('\n').filter(Boolean); } catch { return []; } };
const stopRunner = () => { for (const pid of runnerPids()) { try { process.kill(Number(pid), 'SIGTERM'); } catch {} } };
const qaId = sql(`select id from "user" where email='${q(QA_EMAIL)}'`);
const created = { pairingId: null, devId: null };
const devicesBefore = new Set(sql(`select id from local_runner_devices where user_id='${qaId}'`).split('\n').filter(Boolean));

const browser = await launch('qa-m2b');
const page = await browser.newPage();
page.on('dialog', (d) => d.accept());
page.on('pageerror', (e) => console.log('PAGEERROR', e.message));
await login(page, QA_EMAIL);
await page.goto(BASE + '/app', { waitUntil: 'networkidle2' });
let b2;
try {
  const pairing = await api(page, '/api/local-runners/pairings', { method: 'POST', body: JSON.stringify({ os: 'linux' }) });
  secrets.push(pairing.body?.code); created.pairingId = pairing.body?.pairingId || null;
  const r = spawnSync('sh', ['-c', pairing.body?.commands?.unixNoAutostart], { env: env(), encoding: 'utf8', timeout: 240000 });
  fs.writeFileSync(T + '/install.log', (r.stdout || '') + (r.stderr || ''));
  ok('install_exit', r.status, r.status === 0);
  try { secrets.push(JSON.parse(fs.readFileSync(T + '/cfg/credentials.json', 'utf8')).token); } catch {}
  const devId = await waitFor(() => sql(`select result_device_id from local_runner_pairings where id='${q(created.pairingId)}' and result_device_id is not null`) || null, 30000);
  created.devId = devId;
  ok('newDeviceOnly', { isNew: !!devId && !devicesBefore.has(devId) }, !!devId && !devicesBefore.has(devId));
  const d = await waitFor(async () => { const l = await api(page, '/api/local-runners/devices'); return l.body?.devices?.find((x) => x.id === devId && x.online && x.health?.report) || null; }, 90000);
  ok('healthReported', { version: d?.runnerVersion, report: d?.health?.report && { ok: d.health.report.modelServerOk, server: d.health.report.modelServer, models: d.health.report.models } }, !!d && d.health.report.modelServerOk === true && d.health.report.models > 0);
  ok('noUpdateHintForNew', { updateAvailable: d?.updateAvailable, latest: d?.latestRunnerVersion }, d?.updateAvailable === false);

  const chk = await api(page, `/api/local-runners/devices/${devId}/check`, { method: 'POST', body: '{}' });
  ok('checkApi', { status: chk.status, online: chk.body?.online, supported: chk.body?.supported, latencyMs: chk.body?.health?.latencyMs, ok: chk.body?.health?.modelServerOk }, chk.status === 200 && chk.body?.supported === true && chk.body?.health?.modelServerOk === true && typeof chk.body?.health?.latencyMs === 'number');
  ok('checkNoSecrets', Object.keys(chk.body?.health || {}).sort(), !JSON.stringify(chk.body).match(/token|sl2\.|code/i));

  // UI
  await page.click('[data-testid="user-menu-trigger"]'); await sleep(400);
  await page.evaluate(() => [...document.querySelectorAll('button,[role=menuitem],a')].find((b) => b.textContent.trim() === 'Settings')?.click());
  await page.waitForSelector('#rk-hw-nav', { timeout: 15000 }); await page.click('#rk-hw-nav');
  const opened = await page.waitForSelector(`[data-rk-device="${devId}"] [data-rk="hw-check"]`, { timeout: 20000 }).catch(() => null);
  ok('uiCheckButton', !!opened, !!opened);
  if (opened) {
    const healthLine = await page.$eval(`[data-rk-device="${devId}"] [data-rk="hw-health"]`, (n) => n.textContent).catch(() => null);
    ok('uiHealthLine', healthLine, /Model server OK/.test(healthLine || ''));
    await page.click(`[data-rk-device="${devId}"] [data-rk="hw-check"]`);
    const txt = await waitFor(async () => { const t = await page.$eval(`[data-rk-device="${devId}"] [data-rk="hw-check-result"]`, (n) => n.textContent); return /All good|Not reachable|can't/.test(t) ? t : null; }, 15000);
    ok('uiCheckResult', txt, /^All good: model server answered in \d+ ms/.test(txt || ''));
    await shot(page, 'health-01-check');
  }

  // another account cannot check or see it
  b2 = await launch('qa2-health'); const p2 = await b2.newPage(); await login(p2, QA2_EMAIL);
  await p2.goto(BASE + '/app', { waitUntil: 'networkidle2' });
  const foreign = await api(p2, `/api/local-runners/devices/${devId}/check`, { method: 'POST', body: '{}' });
  ok('foreignCheck404', foreign.status, foreign.status === 404);

  // runner stopped → not reachable, disconnect remembered
  stopRunner();
  const off = await waitFor(async () => { const c = await api(page, `/api/local-runners/devices/${devId}/check`, { method: 'POST', body: '{}' }); return c.body?.online === false ? c : null; }, 30000);
  ok('checkWhenStopped', off?.body, off?.body?.online === false);
  const l2 = (await api(page, '/api/local-runners/devices')).body?.devices?.find((x) => x.id === devId);
  ok('disconnectRemembered', l2?.health?.lastDisconnect, !!l2?.health?.lastDisconnect?.at);
  if (opened) {
    await page.click(`[data-rk-device="${devId}"] [data-rk="hw-check"]`).catch(() => {});
    const t = await waitFor(async () => { const s = await page.$eval(`[data-rk-device="${devId}"] [data-rk="hw-check-result"]`, (n) => n.textContent).catch(() => ''); return /Not reachable/.test(s) ? s : null; }, 15000);
    ok('uiNotReachable', t, !!t);
    await shot(page, 'health-02-offline');
  }
} finally {
  stopRunner();
  if (created.devId) sql(`delete from local_runner_devices where id='${q(created.devId)}' and user_id='${qaId}'`);
  if (created.pairingId) sql(`delete from local_runner_pairings where id='${q(created.pairingId)}' and user_id='${qaId}'`);
  const left = new Set(sql(`select id from local_runner_devices where user_id='${qaId}'`).split('\n').filter(Boolean));
  ok('otherDevicesUntouched', { before: devicesBefore.size }, [...devicesBefore].every((id) => left.has(id)) && (!created.devId || !left.has(created.devId)));
  await browser.close(); if (b2) await b2.close();
  const logs = ['api', 'worker'].map((s) => spawnSync('docker', ['logs', '--since', startedAt, `rakazo-${s}-1`], { encoding: 'utf8', maxBuffer: 1 << 28 })).map((x) => x.stdout + x.stderr).join('\n')
    + (fs.existsSync(T + '/cfg/runner.log') ? fs.readFileSync(T + '/cfg/runner.log', 'utf8') : '');
  const leaks = secrets.filter(Boolean).reduce((n, s) => n + logs.split(s).length - 1, 0);
  ok('secretsInLogs', leaks, leaks === 0);
  fs.writeFileSync(`${OUT}/health-results.json`, JSON.stringify(results, null, 2));
  fs.rmSync(T, { recursive: true, force: true });
  console.log(failures ? `FAILED ${failures}` : 'ALL PASSED');
  process.exit(failures ? 1 : 0);
}
