// M2a e2e: "My hardware" pairing flow with a throwaway runner (temp HOME, config dir and service
// name), as the QA account. Never prints codes or tokens; only counts of their occurrences in logs.
// Never touches the default ~/.config/rakazo-runner or the default service name.
import { launch, login, api, sql, shot, sleep, BASE, OUT, API_DIRECT, API_CONTAINER, QA_EMAIL, QA2_EMAIL } from './lib.mjs';
import os from 'node:os';
import { join } from 'node:path';
import { spawnSync, execFileSync } from 'node:child_process';
import fs from 'node:fs';
const T = '/tmp/rk-m2a-e2e';
const SVC = 'rakijazios-runner-e2e';
// systemd --user only reads units from the real config home; the unit name is unique to this test.
const REAL_CFG = process.env.XDG_CONFIG_HOME || join(os.homedir(), '.config');
const results = {}; const secrets = [];
const ok = (k, v) => { results[k] = v; console.log('CHECK', k, JSON.stringify(v)); };
fs.rmSync(T, { recursive: true, force: true }); fs.mkdirSync(T + '/home', { recursive: true, mode: 0o700 });
const startedAt = new Date().toISOString();
const baseEnv = () => { const e = { ...process.env, HOME: T + '/home', RAKAZO_RUNNER_CONFIG_DIR: T + '/cfg', RAKAZO_RUNNER_SERVICE: SVC }; delete e.XDG_CONFIG_HOME; return e; };
const launcher = T + '/home/.local/share/rakijazios-runner/rakazo-runner';
const runSh = (cmd, env, logName) => { const r = spawnSync('sh', ['-c', cmd], { env, encoding: 'utf8', timeout: 240000 }); fs.writeFileSync(`${T}/${logName}`, (r.stdout || '') + (r.stderr || '')); return r.status; };
const runnerPids = () => { try { return execFileSync('pgrep', ['-f', 'rk-m2a-e2e/home/.local/share/rakijazios-runner/app/src/index.ts']).toString().trim().split('\n').filter(Boolean); } catch { return []; } };
const readToken = () => { try { const c = JSON.parse(fs.readFileSync(T + '/cfg/credentials.json', 'utf8')); if (c.token) secrets.push(c.token); return c; } catch { return null; } };
const waitFor = async (fn, ms, step = 1000) => { const end = Date.now() + ms; while (Date.now() < end) { const v = await fn(); if (v) return v; await sleep(step); } return null; };
const q = s => s.replace(/'/g, "''");

const qaId = sql(`select id from "user" where email='${QA_EMAIL.replace(/'/g, "''")}'`);
sql(`delete from local_runner_devices where user_id='${qaId}'`); sql(`delete from local_runner_pairings where user_id='${qaId}'`);

const browser = await launch('qa-b1');
const page = await browser.newPage();
page.on('dialog', d => d.accept());
page.on('pageerror', e => console.log('PAGEERROR', e.message));
await login(page, QA_EMAIL);
await page.goto(BASE + '/app', { waitUntil: 'networkidle2' });
async function openHardware() {
  if (!(await page.$('[data-testid="user-settings"]'))) {
    await page.click('[data-testid="user-menu-trigger"]'); await sleep(400);
    await page.evaluate(() => [...document.querySelectorAll('button,[role=menuitem],a')].find(b => b.textContent.trim() === 'Settings')?.click());
    await page.waitForSelector('[data-testid="user-settings"]', { timeout: 10000 });
  }
  await page.waitForSelector('#rk-hw-nav', { timeout: 10000 }); await page.click('#rk-hw-nav');
  await page.waitForSelector('#rk-hw-panel', { visible: true, timeout: 10000 });
}
const statusText = () => page.$eval('[data-rk="hw-status"]', n => n.textContent).catch(() => '');
await openHardware(); await sleep(800);
ok('nativeContentHidden', await page.evaluate(() => { const nav = document.querySelector('[data-testid="settings-nav"]'); const c = nav.nextElementSibling; return c && c.id !== 'rk-hw-panel' ? getComputedStyle(c).display === 'none' : 'n/a'; }));
await shot(page, 'm2a-01-empty');

// ---------- A: add a computer (Linux, no autostart, system Node) ----------
await page.click('[data-rk="hw-add"]');
await page.waitForSelector('[data-rk="hw-command"]', { timeout: 15000 });
ok('osDetected', await page.$eval('[data-rk="hw-os"]', s => s.value));
ok('existingInstallHint', !!(await page.$('[data-rk="hw-existing-hint"]')));
await page.click('#rk-hw-auto'); await sleep(300);
const cmdA = await page.$eval('[data-rk="hw-command"]', n => n.textContent);
const codeA = (cmdA.match(/--code ([0-9A-Z-]+)/) || [])[1]; if (codeA) secrets.push(codeA);
const urlPart = (cmdA.match(/'([^']+)'/) || [])[1] || '';
ok('commandShape', { hasCode: !!codeA, noAutostartFlag: cmdA.includes('--no-autostart'), codeNotInUrl: !!codeA && !urlPart.includes(codeA.replace('-', '')) && !urlPart.includes(codeA), url: urlPart });
await shot(page, 'm2a-02-add-linux');
// Windows view renders a download button (no command text with code in a URL)
await page.select('[data-rk="hw-os"]', 'windows'); await sleep(300);
ok('windowsView', { download: !!(await page.$('[data-rk="hw-download"]')) });
await shot(page, 'm2a-03-add-windows');
await page.select('[data-rk="hw-os"]', 'linux'); await sleep(300);
const pairingA = await page.evaluate(() => null);
const rcA = runSh(cmdA, baseEnv(), 'install-a.log');
ok('installA_exit', rcA);
const connectedA = await waitFor(async () => (await statusText()).includes('is connected') && (await statusText()).includes('Found'), 60000);
ok('uiConnectedA', !!connectedA); await shot(page, 'm2a-04-connected');
await sleep(3000);
{ const rl = fs.readFileSync(T + '/cfg/runner.log', 'utf8'); ok('runnerLogA', { policy: /policy enabled=/.test(rl), helloRequired: (rl.match(/hello required/g) || []).length, tooMany: (rl.match(/too many attempts/g) || []).length, reconnects: (rl.match(/reconnect in/g) || []).length }); }
const credA = readToken();
ok('credFileMode', credA ? (fs.statSync(T + '/cfg/credentials.json').mode & 0o777).toString(8) : null);
ok('credServer', credA?.server || null);
ok('credGatewayViaWebOrigin', credA?.gatewayWsUrl || null);
const dev = sql(`select id||'|'||status||'|'||enabled||'|'||coalesce(paired_via,'')||'|'||coalesce(platform,'')||'|'||coalesce(runner_version,'') from local_runner_devices where user_id='${qaId}'`);
ok('deviceRow', dev.replace(/^[^|]+/, '<id>')); const devId = dev.split('|')[0];
ok('modelsAllOffInitially', sql(`select count(*) filter (where enabled)||'/'||count(*) from local_runner_models where device_id='${devId}'`));
await page.click('[data-rk="hw-done"]'); await page.waitForSelector(`[data-rk-device="${devId}"]`, { timeout: 10000 }); await sleep(500);
ok('listPill', await page.$eval(`[data-rk-device="${devId}"] [data-rk="hw-state"]`, n => n.textContent));
const firstModel = await page.$eval(`[data-rk-device="${devId}"] [data-rk-model]`, n => n.getAttribute('data-rk-model'));
await page.click(`[data-rk-device="${devId}"] [data-rk-model="${firstModel}"] [role=switch]`); await sleep(1000);
ok('modelToggledOn', sql(`select enabled from local_runner_models where device_id='${devId}' and model_id='${q(firstModel)}'`));
ok('runnerStatusA', spawnSync(launcher, ['status'], { env: baseEnv(), encoding: 'utf8' }).stdout.split('\n').slice(0, 6).join(' | '));
// rename via API, pause/resume via UI
ok('rename', (await api(page, `/api/local-runners/devices/${devId}`, { method: 'POST', body: JSON.stringify({ name: 'E2E box' }) })).status);
await page.click(`[data-rk-device="${devId}"] [data-rk="hw-pause"]`); await sleep(1500);
ok('pausedPill', await page.$eval(`[data-rk-device="${devId}"] [data-rk="hw-state"]`, n => n.textContent));
ok('pausedDb', sql(`select enabled from local_runner_devices where id='${devId}'`));
await sleep(1500); ok('runnerStatusPaused', spawnSync(launcher, ['status'], { env: baseEnv(), encoding: 'utf8' }).stdout.split('\n').slice(0, 6).join(' | '));
await shot(page, 'm2a-05-paused');
await page.click(`[data-rk-device="${devId}"] [data-rk="hw-pause"]`); await sleep(1500);
ok('resumedPill', await page.$eval(`[data-rk-device="${devId}"] [data-rk="hw-state"]`, n => n.textContent));

// ---------- abuse / isolation ----------
const pairPost = (code, base = BASE) => fetch(base + '/api/local-runners/pair', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code, name: 'x', platform: 'linux-x64', runnerVersion: 'e2e' }) }).then(r => r.status);
ok('reuseUsedCode', await pairPost(codeA));
ok('wrongCode', await pairPost('ZZZZ-ZZZZ'));
const p1 = (await api(page, '/api/local-runners/pairings', { method: 'POST', body: JSON.stringify({ os: 'linux' }) })).body;
if (p1?.code) secrets.push(p1.code);
const p2 = (await api(page, '/api/local-runners/pairings', { method: 'POST', body: JSON.stringify({ os: 'linux' }) })).body;
if (p2?.code) secrets.push(p2.code);
ok('newCodeCancelsOld', (await api(page, `/api/local-runners/pairings/${p1.pairingId}`)).body?.status);
ok('cancelledCodeRejected', await pairPost(p1.code));
sql(`update local_runner_pairings set expires_at=now()-interval '1 minute' where id='${q(p2.pairingId)}'`);
ok('expiredStatus', (await api(page, `/api/local-runners/pairings/${p2.pairingId}`)).body?.status);
ok('expiredCodeRejected', await pairPost(p2.code));
ok('textPlain415', await page.evaluate(async () => (await fetch('/api/local-runners/pairings', { method: 'POST', credentials: 'include', headers: { 'content-type': 'text/plain' }, body: '{}' })).status));
const cookieHdr = (await page.cookies()).map(c => `${c.name}=${c.value}`).join('; ');
ok('foreignOriginPost', await fetch(BASE + '/api/local-runners/pairings', { method: 'POST', headers: { 'content-type': 'application/json', cookie: cookieHdr, origin: 'https://evil.example' }, body: '{}' }).then(r => r.status));
ok('anonDevices', await fetch(BASE + '/api/local-runners/devices').then(r => r.status));
const qaList = (await api(page, '/api/local-runners/devices')).body;
ok('qaSeesOnlyOwn', (qaList.devices || []).map(d => d.id === devId ? 'own' : 'OTHER'));
// second account
const b2 = await launch('qa2-b2'); const p2page = await b2.newPage(); await login(p2page, QA2_EMAIL);
const foreign = {};
foreign.list = ((await api(p2page, '/api/local-runners/devices')).body.devices || []).some(d => d.id === devId);
for (const [k, path, body] of [['rename', `/devices/${devId}`, { name: 'pwn' }], ['pause', `/devices/${devId}`, { enabled: false }], ['model', `/devices/${devId}/models`, { modelId: firstModel, enabled: false }], ['rotate', `/devices/${devId}/rotate`, {}], ['revoke', `/devices/${devId}/revoke`, {}], ['cancelPairing', `/pairings/${p2.pairingId}/cancel`, {}]])
  foreign[k] = (await api(p2page, '/api/local-runners' + path, { method: 'POST', body: JSON.stringify(body) })).status;
foreign.getPairing = (await api(p2page, `/api/local-runners/pairings/${p1.pairingId}`)).status;
ok('foreignAccount', foreign);
ok('deviceUnchangedByForeign', sql(`select name||'|'||enabled||'|'||status from local_runner_devices where id='${devId}'`));
await b2.close();
// max 10 (dummy active rows, removed right after)
sql(`insert into local_runner_devices (id,user_id,name,token_hash,status,paired_via) select 'e2edummy'||g,'${qaId}','dummy '||g,'e2edummy-'||g||'-'||md5(random()::text),'active','e2e' from generate_series(1,9) g`);
const over = await api(page, '/api/local-runners/pairings', { method: 'POST', body: JSON.stringify({ os: 'linux' }) });
ok('max10', { status: over.status, error: over.body?.error });
await page.reload({ waitUntil: 'networkidle2' }); await openHardware(); await sleep(1500);
ok('addDisabledAtMax', await page.$eval('[data-rk="hw-add"]', b => b.disabled));
await shot(page, 'm2a-06-max');
sql(`delete from local_runner_devices where user_id='${qaId}' and paired_via='e2e'`);
await page.reload({ waitUntil: 'networkidle2' }); await openHardware(); await page.waitForSelector(`[data-rk-device="${devId}"]`, { timeout: 15000 });

// ---------- B: rotate (New key) -> old runner exits; re-run with portable Node + systemd autostart ----------
const pidsBefore = runnerPids(); ok('runnerRunningBeforeRotate', pidsBefore.length);
await page.click(`[data-rk-device="${devId}"] [data-rk="hw-rotate"]`);
await page.waitForSelector('[data-rk="hw-command"]', { timeout: 15000 });
ok('oldRunnerExitedAfterRotate', !!(await waitFor(() => runnerPids().length === 0, 20000)));
const cmdB = await page.$eval('[data-rk="hw-command"]', n => n.textContent);
const codeB = (cmdB.match(/--code ([0-9A-Z-]+)/) || [])[1]; if (codeB) secrets.push(codeB);
ok('rotateCommandAutostart', !cmdB.includes('--no-autostart'));
await shot(page, 'm2a-07-reconnect');
const envB = { ...baseEnv(), PATH: '/usr/local/bin:/usr/bin:/bin', XDG_CONFIG_HOME: REAL_CFG, RAKAZO_RUNNER_SERVICE: SVC };
const rcB = runSh(cmdB, envB, 'install-b.log');
ok('installB_exit', rcB);
ok('installB_usedPortableNode', /Downloading Node\.js/.test(fs.readFileSync(T + '/install-b.log', 'utf8')));
ok('installB_outcome', /Reconnected as/.test(fs.readFileSync(T + '/install-b.log', 'utf8')));
ok('installB_systemd', /systemd user service/.test(fs.readFileSync(T + '/install-b.log', 'utf8')));
const connectedB = await waitFor(async () => (await statusText()).includes('is connected'), 60000);
ok('uiConnectedB', !!connectedB); await shot(page, 'm2a-08-reconnected');
readToken();
ok('sameDeviceAfterRotate', sql(`select count(*)||'|'||string_agg(id,',') from local_runner_devices where user_id='${qaId}'`) === `1|${devId}`);
ok('modelSwitchKept', sql(`select enabled from local_runner_models where device_id='${devId}' and model_id='${q(firstModel)}'`));
ok('serviceActive', spawnSync('systemctl', ['--user', 'is-active', SVC], { encoding: 'utf8' }).stdout.trim());

// ---------- C: revoke (Remove) -> runner stops and stays stopped ----------
await page.click('[data-rk="hw-done"]').catch(() => {}); await page.waitForSelector(`[data-rk-device="${devId}"]`, { timeout: 15000 });
await page.click(`[data-rk-device="${devId}"] [data-rk="hw-remove"]`); await sleep(1500);
ok('revokedDb', sql(`select status||'|'||enabled from local_runner_devices where id='${devId}'`));
ok('cardGone', !(await page.$(`[data-rk-device="${devId}"]`)));
await shot(page, 'm2a-09-removed');
ok('serviceStoppedAfterRevoke', await waitFor(() => { const s = spawnSync('systemctl', ['--user', 'is-active', SVC], { encoding: 'utf8' }).stdout.trim(); return s !== 'active' && s !== 'activating' ? s : null; }, 20000));
await sleep(12000);
ok('serviceNotRestarted', spawnSync('systemctl', ['--user', 'is-active', SVC], { encoding: 'utf8' }).stdout.trim());
const t0 = Date.now(); const rerun = spawnSync(launcher, ['run'], { env: baseEnv(), encoding: 'utf8', timeout: 60000 });
ok('runnerLogAfterRotateRevoke', (() => { const j = spawnSync('journalctl', ['--user', '-u', SVC, '--since', '-10min', '--no-pager', '-o', 'cat'], { encoding: 'utf8' }).stdout; return { byeRevoked: /server bye: revoked/.test(j), stopping: /stopping: revoked/.test(j), helloRequired: (j.match(/hello required/g) || []).length }; })());
{ const rl = fs.readFileSync(T + '/cfg/runner.log', 'utf8'); ok('runnerLogRotated', { byeRotated: /server bye: rotated/.test(rl), stopping: /stopping: rotated/.test(rl) }); }
ok('revokedKeyRunExits', { status: rerun.status, seconds: Math.round((Date.now() - t0) / 1000), timedOut: rerun.error?.code === 'ETIMEDOUT' });
fs.writeFileSync(T + '/run-revoked.log', (rerun.stdout || '') + (rerun.stderr || ''));

// ---------- limiter (direct api port, so the web-origin client is not locked out) ----------
const lim = []; for (let i = 0; i < 12; i++) lim.push(await pairPost('ABCD-EF' + String(i).padStart(2, '0').replace(/[01]/g, 'G'), API_DIRECT));
ok('pairLimiter', lim.join(','));
ok('spoofedXffStillLimited', await fetch(BASE + '/api/local-runners/pair', { method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': '203.0.113.9' }, body: JSON.stringify({ code: 'ABCD-EFGH' }) }).then(r => r.status));

// ---------- secrets in logs ----------
const logs = {};
logs.api = execFileSync('docker', ['logs', '--since', startedAt, API_CONTAINER], { maxBuffer: 1 << 28, stdio: ['ignore', 'pipe', 'pipe'] }).toString() + '';
try { logs.apiErr = spawnSync('docker', ['logs', '--since', startedAt, API_CONTAINER], { encoding: 'utf8', maxBuffer: 1 << 28 }).stderr; } catch {}
logs.web = spawnSync('docker', ['logs', '--since', startedAt, 'rakazo-web-1'], { encoding: 'utf8', maxBuffer: 1 << 28 }); logs.web = logs.web.stdout + logs.web.stderr;
logs.journal = spawnSync('journalctl', ['--user', '-u', SVC, '--since', '-30min', '--no-pager'], { encoding: 'utf8' }).stdout;
for (const f of fs.readdirSync(T)) if (f.endsWith('.log')) logs[f] = fs.readFileSync(`${T}/${f}`, 'utf8');
if (fs.existsSync(T + '/cfg')) for (const f of fs.readdirSync(T + '/cfg')) if (f.endsWith('.log')) logs['cfg/' + f] = fs.readFileSync(`${T}/cfg/${f}`, 'utf8');
const leak = {};
for (const [k, v] of Object.entries(logs)) { let n = 0; for (const s of secrets) { if (!s) continue; n += v.split(s).length - 1; const raw = s.replace('-', ''); if (raw !== s) n += v.split(raw).length - 1; } leak[k] = n; }
ok('secretOccurrencesInLogs', { secretsChecked: secrets.length, ...leak });
ok('installLogSample', logs['install-a.log'].split('\n').filter(Boolean).slice(0, 12));
await browser.close();
fs.writeFileSync(join(OUT, '50-m2a-results.json'), JSON.stringify(results, null, 2));
// cleanup: test service, temp dirs, qa devices
spawnSync('systemctl', ['--user', 'disable', '--now', SVC + '.service']);
fs.rmSync(`${REAL_CFG}/systemd/user/${SVC}.service`, { force: true });
spawnSync('systemctl', ['--user', 'daemon-reload']);
for (const pid of runnerPids()) { try { process.kill(Number(pid)); } catch {} }
fs.rmSync(T, { recursive: true, force: true });
sql(`delete from local_runner_pairings where user_id='${qaId}'`); sql(`delete from local_runner_devices where user_id='${qaId}'`);
console.log('DONE');
