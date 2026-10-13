// M2a e2e: installing on a computer that already runs a runner (QA finding on PR #7).
// Simulates an M1 install in a THROWAWAY config dir: a seeded ("legacy") device for the QA
// account, run by the M1 runner code (RK_M1_REF, default origin/main) via its scripts/start.sh.
// Then, with the real installer from the web dialog:
//   a) install → keeps the M1 key (adopt), stops the M1 process, one runner (the service)
//   b) install again → adopt again, still one runner
//   e) a second `run` / M1 start.sh while the service runs → refused / no second process
//   c) another account's code → refused (exit 3), nothing changed, code unused; then --replace
//   d) key revoked → a new code pairs again, old file backed up
// Never prints codes, tokens or credential contents; secret occurrences in logs are counted.
// Never uses the default ~/.config/rakazo-runner or the default service name.
import { launch, login, api, sql, q, shot, sleep, waitFor, openHardware, leakCounts, BASE, OUT, API_CONTAINER, QA_EMAIL, QA2_EMAIL } from './lib.mjs';
import { spawnSync, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

const REPO = process.env.RK_REPO || join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const M1_REF = process.env.RK_M1_REF || 'origin/main';
const T = join(os.tmpdir(), 'rk-m2a-mig');
const HOME = join(T, 'home');
const CFG = join(T, 'cfg');
const SVC = 'rakijazios-runner-e2e-mig';
const REAL_CFG = process.env.XDG_CONFIG_HOME || join(os.homedir(), '.config');
const UNIT = join(REAL_CFG, 'systemd', 'user', `${SVC}.service`);
if (CFG === join(os.homedir(), '.config', 'rakazo-runner') || SVC === 'rakijazios-runner') throw new Error('refusing to use the default runner');
const LAUNCHER = join(HOME, '.local/share/rakijazios-runner/rakazo-runner');
const env = () => ({ ...process.env, HOME, RAKAZO_RUNNER_CONFIG_DIR: CFG, RAKAZO_RUNNER_SERVICE: SVC, XDG_CONFIG_HOME: REAL_CFG });
const results = {}; const secrets = []; let failures = 0;
const ok = (k, v, pass) => { results[k] = v; if (pass === false) failures++; console.log(pass === false ? 'FAIL ' : 'CHECK', k, JSON.stringify(v)); };
const sh = (cmd, logName, extraEnv = {}) => { const r = spawnSync('sh', ['-c', cmd], { env: { ...env(), ...extraEnv }, encoding: 'utf8', timeout: 240000 }); const out = (r.stdout || '') + (r.stderr || ''); fs.writeFileSync(join(T, logName), out); return { rc: r.status, out }; };
const sha = (f) => { try { return createHash('sha256').update(fs.readFileSync(f)).digest('hex'); } catch { return null; } };
const creds = () => { try { const c = JSON.parse(fs.readFileSync(join(CFG, 'credentials.json'), 'utf8')); if (c.token) secrets.push(c.token); return { deviceId: c.deviceId, server: c.server ?? null }; } catch { return null; } };
const mainPid = () => Number(spawnSync('systemctl', ['--user', 'show', '-p', 'MainPID', '--value', SVC], { encoding: 'utf8' }).stdout.trim()) || 0;
const active = () => spawnSync('systemctl', ['--user', 'is-active', SVC], { encoding: 'utf8' }).stdout.trim();
const alive = (pid) => { try { return !/^\S+ \(.*\) Z/.test(fs.readFileSync(`/proc/${pid}/stat`, 'utf8')); } catch { return false; } };
/** Live runner processes (M1 or M2) whose environment points at our throwaway config dir. */
function runnersOnCfg() {
  const out = [];
  for (const d of fs.readdirSync('/proc')) {
    if (!/^\d+$/.test(d)) continue;
    try {
      const cmd = fs.readFileSync(`/proc/${d}/cmdline`, 'utf8');
      if (!cmd.includes('index.ts')) continue;
      if (!fs.readFileSync(`/proc/${d}/environ`, 'utf8').split('\0').includes(`RAKAZO_RUNNER_CONFIG_DIR=${CFG}`)) continue;
      if (alive(Number(d))) out.push(Number(d));
    } catch { /* gone or not ours */ }
  }
  return out;
}
const pidFile = () => { try { return Number(fs.readFileSync(join(CFG, 'runner.pid'), 'utf8').trim()); } catch { return 0; } };
const backups = (kind) => fs.readdirSync(CFG).filter((f) => f.startsWith(`credentials.${kind}-`) && f.endsWith('.json'));
const mode = (f) => (fs.statSync(join(CFG, f)).mode & 0o777).toString(8);
function cleanupRunner() {
  spawnSync('systemctl', ['--user', 'disable', '--now', `${SVC}.service`], { stdio: 'ignore' });
  fs.rmSync(UNIT, { force: true });
  spawnSync('systemctl', ['--user', 'daemon-reload']);
  if (fs.existsSync(CFG)) for (const pid of runnersOnCfg()) { try { process.kill(pid); } catch {} }
}

const startedAt = new Date().toISOString();
const qaId = sql(`select id from "user" where email='${q(QA_EMAIL)}'`);
const qa2Id = sql(`select id from "user" where email='${q(QA2_EMAIL)}'`);
const wipeRows = () => { for (const u of [qaId, qa2Id]) { sql(`delete from local_runner_pairings where user_id='${u}'`); sql(`delete from local_runner_devices where user_id='${u}'`); } };
cleanupRunner(); fs.rmSync(T, { recursive: true, force: true });
fs.mkdirSync(HOME, { recursive: true, mode: 0o700 }); fs.mkdirSync(CFG, { recursive: true, mode: 0o700 });
wipeRows();
const browsers = [];
try {
  // ---------- simulated M1 install ----------
  const seed = spawnSync('docker', ['exec', API_CONTAINER, 'sh', '-c', `cd /app/apps/api && npx tsx src/local-runner-seed.ts --email '${q(QA_EMAIL)}' --name m1-sim`], { encoding: 'utf8' });
  const line = (seed.stdout || '').split('\n').find((l) => l.startsWith('{"'));
  if (seed.status !== 0 || !line) throw new Error('seeding failed (exit ' + seed.status + ')');
  fs.writeFileSync(join(CFG, 'credentials.json'), line + '\n', { mode: 0o600 });
  fs.writeFileSync(join(T, 'seed.log'), (seed.stdout || '') + (seed.stderr || ''));
  const m1 = creds(); const devId = m1.deviceId;
  ok('m1Seeded', { pairedVia: sql(`select coalesce(paired_via,'') from local_runner_devices where id='${q(devId)}'`), server: m1.server });
  fs.mkdirSync(join(T, 'm1'));
  execFileSync('sh', ['-c', `git -C '${REPO}' archive '${M1_REF}' runner | tar -x -C '${T}/m1'`]);
  const st = sh(`bash '${T}/m1/runner/scripts/start.sh'`, 'm1-start.log');
  const m1Pid = pidFile();
  ok('m1Started', { rc: st.rc, pidAlive: alive(m1Pid), oneRunner: runnersOnCfg().length }, st.rc === 0 && alive(m1Pid));

  const browser = await launch('qa-b1'); browsers.push(browser);
  const page = await browser.newPage(); page.on('dialog', (d) => d.accept());
  await login(page, QA_EMAIL); await page.goto(BASE + '/app', { waitUntil: 'networkidle2' });
  const online = await waitFor(async () => ((await api(page, '/api/local-runners/devices')).body?.devices || []).find((d) => d.id === devId && d.online), 30000);
  ok('m1Online', !!online, !!online);
  await sleep(2000);
  const modelsBefore = sql(`select coalesce(string_agg(model_id||'='||enabled, ',' order by model_id),'') from local_runner_models where device_id='${q(devId)}'`);
  const hash0 = sha(join(CFG, 'credentials.json'));
  await openHardware(page); await page.waitForSelector(`[data-rk-device="${devId}"]`, { timeout: 15000 });
  await shot(page, 'm2a-20-m1-listed');

  // ---------- a) install over the M1 runner ----------
  const addComputer = async () => {
    if (await page.$('[data-rk="hw-done"]')) { await page.click('[data-rk="hw-done"]'); await sleep(500); }
    await page.click('[data-rk="hw-add"]'); await page.waitForSelector('[data-rk="hw-command"]', { timeout: 15000 });
    const auto = await page.$eval('#rk-hw-auto', (c) => c.checked); if (!auto) { await page.click('#rk-hw-auto'); await sleep(300); }
    const cmd = await page.$eval('[data-rk="hw-command"]', (n) => n.textContent);
    const code = (cmd.match(/--code ([0-9A-Z-]+)/) || [])[1]; if (code) secrets.push(code);
    return cmd;
  };
  const statusText = () => page.$eval('[data-rk="hw-status"]', (n) => n.textContent).catch(() => '');
  const cmdA = await addComputer();
  ok('hintShown', !!(await page.$('[data-rk="hw-existing-hint"]')), !!(await page.$('[data-rk="hw-existing-hint"]')));
  const a = sh(cmdA, 'install-a.log');
  const pidA = mainPid();
  ok('a_exit', a.rc, a.rc === 0);
  ok('a_keptMessage', /already connected as "m1-sim"\. Kept its key/.test(a.out), /already connected as "m1-sim"\. Kept its key/.test(a.out));
  ok('a_credentialsUnchanged', sha(join(CFG, 'credentials.json')) === hash0, sha(join(CFG, 'credentials.json')) === hash0);
  ok('a_m1ProcessStopped', !alive(m1Pid), !alive(m1Pid));
  ok('a_service', { active: active(), mainPid: pidA > 0 }, active() === 'active' && pidA > 0);
  await sleep(1500);
  const rA = runnersOnCfg();
  ok('a_oneRunnerIsService', { count: rA.length, isService: rA[0] === pidA, pidFileIsService: pidFile() === pidA }, rA.length === 1 && rA[0] === pidA && pidFile() === pidA);
  const uiA = await waitFor(async () => { const t = await statusText(); return t.includes('m1-sim is connected') ? t : null; }, 60000);
  ok('a_dialogConnectedAsM1', !!uiA, !!uiA); await shot(page, 'm2a-21-adopted');
  const rowA = sql(`select count(*)||'|'||string_agg(id||'|'||coalesce(paired_via,'')||'|'||coalesce(runner_version,'')||'|'||status, ',') from local_runner_devices where user_id='${qaId}'`);
  ok('a_sameDevice', rowA.replace(devId, '<m1>'), rowA.startsWith(`1|${devId}|seed|`) && rowA.endsWith('|active'));
  ok('a_runnerVersionUpdated', rowA.split('|')[3], /m2a/.test(rowA.split('|')[3] || ''));
  await sleep(2000);
  const modelsA = sql(`select coalesce(string_agg(model_id||'='||enabled, ',' order by model_id),'') from local_runner_models where device_id='${q(devId)}'`);
  ok('a_legacyModelsKept', { before: modelsBefore, after: modelsA }, modelsBefore === modelsA || modelsA.startsWith(modelsBefore));
  ok('a_noBackupNeeded', fs.readdirSync(CFG).filter((f) => f.startsWith('credentials.') && f !== 'credentials.json'), fs.readdirSync(CFG).filter((f) => f.startsWith('credentials.') && f !== 'credentials.json').length === 0);

  // ---------- b) install again ----------
  const cmdB = await addComputer();
  const b = sh(cmdB, 'install-b.log');
  const pidB = mainPid(); await sleep(1500); const rB = runnersOnCfg();
  ok('b_exit', b.rc, b.rc === 0);
  ok('b_keptAgain', /Kept its key/.test(b.out), /Kept its key/.test(b.out));
  ok('b_credentialsUnchanged', sha(join(CFG, 'credentials.json')) === hash0, sha(join(CFG, 'credentials.json')) === hash0);
  ok('b_restartedOneRunner', { count: rB.length, newPid: pidB !== pidA, isService: rB[0] === pidB }, rB.length === 1 && rB[0] === pidB && pidB !== pidA && !alive(pidA));
  ok('b_stillOneDevice', sql(`select count(*) from local_runner_devices where user_id='${qaId}'`), sql(`select count(*) from local_runner_devices where user_id='${qaId}'`) === '1');
  const uiB = await waitFor(async () => (await statusText()).includes('m1-sim is connected'), 60000);
  ok('b_dialogConnected', !!uiB, !!uiB);

  // ---------- e) no second runner on the same config dir ----------
  const second = spawnSync(LAUNCHER, ['run'], { env: env(), encoding: 'utf8', timeout: 20000 });
  ok('e_secondRunRefused', { status: second.status, message: /Another runner \(pid \d+\) is already using/.test(second.stderr) }, second.status === 1 && /Another runner/.test(second.stderr));
  const m1Again = sh(`bash '${T}/m1/runner/scripts/start.sh'`, 'm1-start-again.log');
  ok('e_m1StartShSeesRunner', { rc: m1Again.rc, says: /already running/.test(m1Again.out) }, /already running/.test(m1Again.out));
  const ins = spawnSync(LAUNCHER, ['inspect'], { env: env(), encoding: 'utf8' });
  fs.writeFileSync(join(T, 'inspect.log'), ins.stdout + ins.stderr);
  ok('e_inspect', ins.stdout.split('\n').filter(Boolean).slice(1).map((s) => s.trim().replace(/pid \d+/, 'pid N')), /running: yes/.test(ins.stdout) && new RegExp(`service: systemd ${SVC}`).test(ins.stdout));
  const rE = runnersOnCfg(); ok('e_stillOneRunner', rE.length, rE.length === 1 && rE[0] === pidB);

  // ---------- c) another account's code: refused, then --replace ----------
  const b2 = await launch('qa2-b2'); browsers.push(b2);
  const p2 = await b2.newPage(); await login(p2, QA2_EMAIL);
  const pc = (await api(p2, '/api/local-runners/pairings', { method: 'POST', body: JSON.stringify({ os: 'linux' }) })).body;
  if (pc?.code) secrets.push(pc.code);
  const c1 = sh(pc.commands.unix, 'install-c1.log');
  ok('c_refusedExit3', c1.rc, c1.rc === 3);
  ok('c_message', { otherAccount: /different Rakijazios account/.test(c1.out), mentionsReplace: /--replace/.test(c1.out), codeUnused: /code was not used/.test(c1.out) }, /different Rakijazios account/.test(c1.out) && /--replace/.test(c1.out));
  ok('c_nothingChanged', { credentials: sha(join(CFG, 'credentials.json')) === hash0, samePid: mainPid() === pidB && alive(pidB), runners: runnersOnCfg().length }, sha(join(CFG, 'credentials.json')) === hash0 && mainPid() === pidB && runnersOnCfg().length === 1);
  const pcStatus = (await api(p2, `/api/local-runners/pairings/${pc.pairingId}`)).body?.status;
  ok('c_codeStillPending', pcStatus, pcStatus === 'pending');
  ok('c_qa2HasNoDevice', sql(`select count(*) from local_runner_devices where user_id='${qa2Id}'`), sql(`select count(*) from local_runner_devices where user_id='${qa2Id}'`) === '0');
  const c2 = sh(`${pc.commands.unix} --replace`, 'install-c2.log');
  const pidC = mainPid(); await sleep(1500);
  const credC = creds();
  const replacedFiles = backups('replaced');
  ok('c_replaceExit', c2.rc, c2.rc === 0);
  ok('c_replaceMessage', /Paired as a new computer/.test(c2.out), /Paired as a new computer/.test(c2.out));
  ok('c_backup', { count: replacedFiles.length, mode: replacedFiles[0] && mode(replacedFiles[0]), isOldKey: replacedFiles[0] && sha(join(CFG, replacedFiles[0])) === hash0 }, replacedFiles.length === 1 && mode(replacedFiles[0]) === '600' && sha(join(CFG, replacedFiles[0])) === hash0);
  const ownerC = sql(`select user_id||'|'||coalesce(paired_via,'') from local_runner_devices where id='${q(credC?.deviceId || '')}'`);
  ok('c_newDeviceForQa2', { isQa2: ownerC.startsWith(qa2Id + '|'), differs: credC?.deviceId !== devId, pairedVia: ownerC.split('|')[1] }, ownerC.startsWith(qa2Id + '|') && credC?.deviceId !== devId);
  ok('c_oldDeviceNotRevoked', sql(`select status from local_runner_devices where id='${q(devId)}'`), sql(`select status from local_runner_devices where id='${q(devId)}'`) === 'active');
  const rC = runnersOnCfg(); ok('c_oneRunner', { count: rC.length, isService: rC[0] === pidC }, rC.length === 1 && rC[0] === pidC);
  const pcAfter = await waitFor(async () => { const s = (await api(p2, `/api/local-runners/pairings/${pc.pairingId}`)).body?.status; return s === 'connected' ? s : null; }, 30000);
  ok('c_qa2Connected', pcAfter, pcAfter === 'connected');

  // ---------- d) key revoked → pairs again with a backup ----------
  ok('d_revoke', (await api(p2, `/api/local-runners/devices/${credC.deviceId}/revoke`, { method: 'POST', body: '{}' })).status);
  const stopped = await waitFor(() => { const s = active(); return s !== 'active' && s !== 'activating' ? s : null; }, 20000);
  ok('d_serviceStoppedByBye', stopped, !!stopped);
  const pd = (await api(p2, '/api/local-runners/pairings', { method: 'POST', body: JSON.stringify({ os: 'linux' }) })).body;
  if (pd?.code) secrets.push(pd.code);
  const d = sh(pd.commands.unix, 'install-d.log');
  const pidD = mainPid(); await sleep(1500);
  const credD = creds(); const prev = backups('previous');
  ok('d_exit', d.rc, d.rc === 0);
  ok('d_message', /no longer worked/.test(d.out), /no longer worked/.test(d.out));
  ok('d_backup', { count: prev.length, mode: prev[0] && mode(prev[0]) }, prev.length === 1 && mode(prev[0]) === '600');
  const qa2Rows = sql(`select string_agg(status, ',' order by created_at) from local_runner_devices where user_id='${qa2Id}'`);
  ok('d_newDevice', { qa2Devices: qa2Rows, differs: credD?.deviceId !== credC.deviceId }, credD?.deviceId !== credC.deviceId && /active/.test(qa2Rows));
  const rD = runnersOnCfg(); ok('d_oneRunner', { count: rD.length, isService: rD[0] === pidD, active: active() }, rD.length === 1 && rD[0] === pidD);

  // ---------- secrets ----------
  const texts = {};
  texts.api = spawnSync('docker', ['logs', '--since', startedAt, API_CONTAINER], { encoding: 'utf8', maxBuffer: 1 << 28 }); texts.api = texts.api.stdout + texts.api.stderr;
  texts.web = spawnSync('docker', ['logs', '--since', startedAt, 'rakazo-web-1'], { encoding: 'utf8', maxBuffer: 1 << 28 }); texts.web = texts.web.stdout + texts.web.stderr;
  texts.journal = spawnSync('journalctl', ['--user', '-u', SVC, '--since', '-30min', '--no-pager'], { encoding: 'utf8' }).stdout;
  for (const f of fs.readdirSync(T)) if (f.endsWith('.log') && f !== 'seed.log') texts[f] = fs.readFileSync(join(T, f), 'utf8');
  for (const f of fs.readdirSync(CFG)) if (f.endsWith('.log')) texts['cfg/' + f] = fs.readFileSync(join(CFG, f), 'utf8');
  const leaks = leakCounts(texts, secrets);
  ok('secretOccurrencesInLogs', { secretsChecked: secrets.length, ...leaks }, Object.values(leaks).every((n) => n === 0));
  ok('installLogSampleA', a.out.split('\n').filter(Boolean).slice(-8));
} finally {
  for (const b of browsers) await b.close().catch(() => {});
  cleanupRunner();
  ok('cleanup', { runnersLeft: fs.existsSync(CFG) ? runnersOnCfg().length : 0, unitLeft: fs.existsSync(UNIT) });
  fs.rmSync(T, { recursive: true, force: true });
  wipeRows();
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(join(OUT, '52-m2a-results.json'), JSON.stringify({ failures, results }, null, 2));
  console.log(failures ? `DONE with ${failures} failure(s)` : 'DONE all passed');
}
process.exit(failures ? 1 : 0);
