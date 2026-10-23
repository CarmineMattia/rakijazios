// M2b e2e: bind a bot to one computer + model from "My hardware", then exercise the
// run-bound gateway rules with real runs. Throwaway runner (temp HOME, config dir,
// service name) for the QA account; the default ~/.config/rakazo-runner is never touched.
// Never prints codes or tokens; only counts of their occurrences in logs (expect 0).
//   RK_M2B_MODEL  model to switch on (default: smallest advertised, qwen2.5:3b if present)
import { launch, login, api, sql, shot, sleep, waitFor, BASE, OUT, API_CONTAINER, QA_EMAIL, QA2_EMAIL, q, container } from '../m2a/lib.mjs';
import { spawnSync, execFileSync } from 'node:child_process';
import fs from 'node:fs';
const T = '/tmp/rk-m2b-e2e';
const SVC = 'rakijazios-runner-e2e-m2b';
const results = {}; const secrets = []; let failures = 0;
const ok = (k, v, pass = true) => { results[k] = { v, pass }; if (!pass) failures++; console.log(pass ? 'CHECK' : 'FAIL ', k, JSON.stringify(v)); };
const eq = (k, v, want) => ok(k, v, v === want);
fs.rmSync(T, { recursive: true, force: true }); fs.mkdirSync(T + '/home', { recursive: true, mode: 0o700 });
const startedAt = new Date().toISOString();
const env = () => { const e = { ...process.env, HOME: T + '/home', RAKAZO_RUNNER_CONFIG_DIR: T + '/cfg', RAKAZO_RUNNER_SERVICE: SVC }; delete e.XDG_CONFIG_HOME; return e; };
const runnerPids = () => { try { return execFileSync('pgrep', ['-f', 'rk-m2b-e2e/home/.local/share/rakijazios-runner/app/src/index.ts']).toString().trim().split('\n').filter(Boolean); } catch { return []; } };
const stopRunner = () => { for (const pid of runnerPids()) { try { process.kill(Number(pid), 'SIGTERM'); } catch {} } };

const qaId = sql(`select id from "user" where email='${q(QA_EMAIL)}'`);
const BOT = sql(`select id from bots where "userId"='${qaId}' and name='QA Tester Bot' and "archivedAt" is null limit 1`);
const GROUP = sql(`select id from chat_groups where "userId"='${qaId}' and name='QA Group' limit 1`);
if (!BOT) throw new Error('QA Tester Bot not found');
const original = sql(`select coalesce("modelProvider",'')||'|'||coalesce("modelId",'') from bots where id='${BOT}'`);
// Only what this script creates is removed: its own pairing and the computer that pairing made.
// Other computers of the QA account (e.g. the tester's) are never touched.
const created = { pairingId: null, devId: null };
const cleanupDb = () => {
  // Usage rows of the throwaway computer go too (raw + daily rollup), else they outlive it as orphans.
  if (created.devId) for (const t of ['local_runner_usage', 'local_runner_usage_daily']) sql(`delete from ${t} where device_id='${q(created.devId)}' and owner_user_id='${qaId}'`);
  if (created.devId) sql(`delete from local_runner_devices where id='${q(created.devId)}' and user_id='${qaId}'`);
  if (created.pairingId) sql(`delete from local_runner_pairings where id='${q(created.pairingId)}' and user_id='${qaId}'`);
};
const devicesBefore = new Set(sql(`select id from local_runner_devices where user_id='${qaId}'`).split('\n').filter(Boolean));

const browser = await launch('qa-m2b');
const page = await browser.newPage();
page.on('dialog', (d) => d.accept());
page.on('pageerror', (e) => console.log('PAGEERROR', e.message));
await login(page, QA_EMAIL);
await page.goto(BASE + '/app', { waitUntil: 'networkidle2' });
const spaceId = sql(`select "spaceId" from bots where id='${BOT}'`);

try {
  // ---------- pair a throwaway runner ----------
  const pairing = await api(page, '/api/local-runners/pairings', { method: 'POST', body: JSON.stringify({ os: 'linux' }) });
  const cmd = pairing.body?.commands?.unixNoAutostart; secrets.push(pairing.body?.code);
  created.pairingId = pairing.body?.pairingId || null;
  const r = spawnSync('sh', ['-c', cmd], { env: env(), encoding: 'utf8', timeout: 240000 });
  fs.writeFileSync(T + '/install.log', (r.stdout || '') + (r.stderr || ''));
  eq('install_exit', r.status, 0);
  try { secrets.push(JSON.parse(fs.readFileSync(T + '/cfg/credentials.json', 'utf8')).token); } catch {}
  const devId = await waitFor(() => sql(`select result_device_id from local_runner_pairings where id='${q(created.pairingId)}' and result_device_id is not null`) || null, 30000);
  created.devId = devId;
  ok('newDeviceOnly', { isNew: !!devId && !devicesBefore.has(devId), othersKept: devicesBefore.size }, !!devId && !devicesBefore.has(devId));
  const online = await waitFor(async () => { const d = await api(page, '/api/local-runners/devices'); return d.body?.devices?.find((x) => x.id === devId && x.online && x.models.length) || null; }, 90000);
  ok('runnerOnlineWithModels', { online: !!online, version: online?.runnerVersion, models: online?.models?.length }, !!online && /^0\.2\.([2-9]|[1-9][0-9])|^0\.([3-9]|[1-9][0-9])\.|^[1-9]/.test(online?.runnerVersion || ''));
  const want = process.env.RK_M2B_MODEL || (online.models.find((m) => m.id === 'qwen2.5:3b') ? 'qwen2.5:3b' : online.models[0].id);
  // ---------- UI: Bots on my computer ----------
  const before = await api(page, '/api/local-runners/offered-models');
  eq('offeredEmptyBeforeSwitchOn', before.body.devices.some((d) => d.id === devId), false);
  await api(page, `/api/local-runners/devices/${devId}/models`, { method: 'POST', body: JSON.stringify({ modelId: want, enabled: true }) });
  const refused = await api(page, `/api/local-runners/bots/${BOT}/model`, { method: 'POST', body: JSON.stringify({ deviceId: devId, modelId: 'not-switched-on' }) });
  eq('bindRefusedForModelSwitchedOff', refused.status, 409);
  const { openHardware } = await import('../m2a/lib.mjs');
  await openHardware(page);
  const sel = `[data-rk-bot="${BOT}"] select`;
  await page.waitForSelector(sel, { timeout: 15000 });
  await shot(page, 'm2b-01-bots-section');
  await page.select(sel, `${devId}|${want}`);
  await waitFor(async () => (await page.$eval(`[data-rk-bot="${BOT}"] [role=status]`, (n) => n.textContent).catch(() => '')) === 'Saved', 10000, 300);
  await shot(page, 'm2b-02-bound');
  eq('bindingRow', sql(`select (device_id='${devId}')::text||'|'||model_id from local_runner_bot_bindings where bot_id='${BOT}'`), `true|${want}`);
  eq('botModel', sql(`select "modelProvider"||'|'||"modelId" from bots where id='${BOT}'`), `shared-local|${want}`);

  // ---------- runs ----------
  const send = async (target, text) => {
    const since = sql(`select now()`);
    const res = await api(page, '/rpc/threads/send', { method: 'POST', body: JSON.stringify({ json: { ...target, text, clientNonce: `m2b-${Date.now()}-${Math.random()}` } }) }, spaceId);
    if (res.status !== 200) return { status: res.status, error: JSON.stringify(res.body).slice(0, 200) };
    const run = await waitFor(() => { const row = sql(`select id||'|'||status||'|'||coalesce("modelProvider",'')||'|'||coalesce(error,'') from runs where "botId"='${BOT}' and "createdAt" > '${since}' and status in ('completed','failed','cancelled') order by "createdAt" desc limit 1`); return row || null; }, 240000, 1500);
    if (!run) return { status: 'timeout' };
    const [id, status, provider, ...err] = run.split('|');
    return { id, status, provider, error: err.join('|') };
  };
  const one = await send({ botId: BOT }, 'Reply with just the word OK.');
  ok('privateRunCompletes', one, one.status === 'completed' && one.provider === 'shared-local');
  const grp = await send({ groupId: GROUP, mentions: [BOT] }, 'Reply with just the word OK.');
  ok('sharedGroupRefused', grp, grp.status === 'failed' && /isn't enabled for this shared group/.test(grp.error));
  await api(page, `/api/local-runners/devices/${devId}`, { method: 'POST', body: JSON.stringify({ enabled: false }) });
  const paused = await send({ botId: BOT }, 'Reply OK.');
  ok('pausedRefused', paused, paused.status === 'failed' && /paused/.test(paused.error));
  await api(page, `/api/local-runners/devices/${devId}`, { method: 'POST', body: JSON.stringify({ enabled: true }) });
  await api(page, `/api/local-runners/devices/${devId}/models`, { method: 'POST', body: JSON.stringify({ modelId: want, enabled: false }) });
  const off = await send({ botId: BOT }, 'Reply OK.');
  ok('modelOffRefused', off, off.status === 'failed' && /switched off/.test(off.error));
  await api(page, `/api/local-runners/devices/${devId}/models`, { method: 'POST', body: JSON.stringify({ modelId: want, enabled: true }) });
  stopRunner();
  await sleep(2000);
  const offline = await send({ botId: BOT }, 'Reply OK.');
  ok('offlineNotice', offline, offline.status === 'failed' && /offline right now/.test(offline.error));

  // ---------- gateway token rules (token minted inside the api container, never printed) ----------
  const gw = (runId, extra = '') => execFileSync('docker', ['exec', API_CONTAINER, 'sh', '-c',
    `cd /app/apps/api && T=$(npx tsx -e 'import("./src/shared-local-token.ts").then(m=>process.stdout.write(m.mintSharedLocalRunToken(process.argv[1], process.argv[2], 60)))' '${qaId}' '${runId}') && curl -s -o /dev/null -w '%{http_code}' ${extra} -H "authorization: Bearer $T" http://127.0.0.1:3100/api/local-runners/v1/models`]).toString().trim();
  eq('gatewayEndedRun401', gw(one.id), '401');
  const status = (h) => execFileSync('docker', ['exec', API_CONTAINER, 'sh', '-c', `curl -s -o /dev/null -w '%{http_code}' ${h} http://127.0.0.1:3100/api/local-runners/v1/models`]).toString().trim();
  eq('gatewayNoToken401', status(''), '401');
  eq('gatewayForgedSl2_401', status(`-H 'authorization: Bearer sl2.${qaId}.${one.id}.9999999999.forged'`), '401');
  eq('gatewayOldSl1_401', status(`-H 'authorization: Bearer sl1.${qaId}.9999999999.forged'`), '401');

  // ---------- another account cannot see or bind this bot ----------
  const page2 = await (await launch('qa2-m2b')).newPage();
  await login(page2, QA2_EMAIL); await page2.goto(BASE + '/app', { waitUntil: 'networkidle2' });
  const other = await api(page2, `/api/local-runners/bots/${BOT}/model`, { method: 'POST', body: JSON.stringify({ deviceId: devId, modelId: want }) });
  eq('otherAccountBind404', other.status, 404);
  const otherList = await api(page2, '/api/local-runners/bots');
  eq('otherAccountListHidesBot', (otherList.body?.bots || []).some((b) => b.id === BOT), false);
  await page2.browser().close();

  // ---------- unbind ----------
  const clear = await api(page, `/api/local-runners/bots/${BOT}/model`, { method: 'POST', body: JSON.stringify({ clear: true }) });
  eq('clearStatus', clear.status, 200);
  eq('clearRemovesBinding', sql(`select count(*) from local_runner_bot_bindings where bot_id='${BOT}'`), '0');
} finally {
  stopRunner();
  // Restore the bot exactly as it was and remove the throwaway computer.
  const [p, m] = original.split('|');
  sql(`update bots set "modelProvider"=${p ? `'${q(p)}'` : 'null'}, "modelId"=${m ? `'${q(m)}'` : 'null'} where id='${BOT}'`);
  sql(`delete from local_runner_bot_bindings where bot_id='${BOT}'`);
  cleanupDb();
  const left = new Set(sql(`select id from local_runner_devices where user_id='${qaId}'`).split('\n').filter(Boolean));
  ok('otherDevicesUntouched', { before: devicesBefore.size, missing: [...devicesBefore].filter((id) => !left.has(id)).length, oursGone: !created.devId || !left.has(created.devId) }, [...devicesBefore].every((id) => left.has(id)) && (!created.devId || !left.has(created.devId)));
  await browser.close();
  const logs = ['api', 'worker'].map((s) => spawnSync('docker', ['logs', '--since', startedAt, container(s)], { encoding: 'utf8', maxBuffer: 1 << 28 })).map((x) => x.stdout + x.stderr).join('\n')
    + (fs.existsSync(T + '/cfg/runner.log') ? fs.readFileSync(T + '/cfg/runner.log', 'utf8') : '');
  const leaks = secrets.filter(Boolean).reduce((n, s) => n + logs.split(s).length - 1, 0) + (logs.match(/sl2\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.\d+\.[A-Za-z0-9_-]{20,}/g) || []).length;
  eq('secretsInLogs', leaks, 0);
  fs.writeFileSync(`${OUT}/m2b-results.json`, JSON.stringify(results, null, 2));
  fs.rmSync(T, { recursive: true, force: true });
  console.log(failures ? `FAILED ${failures}` : 'ALL PASSED');
  process.exit(failures ? 1 : 0);
}
