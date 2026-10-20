// M3b(a) e2e: with 1 answer at a time, a second request waits for the slot instead of being refused.
// Based on 61: Bind a bot to one computer + model from "My hardware", then exercise the
// run-bound gateway rules with real runs. Throwaway runner (temp HOME, config dir,
// service name) for the QA account; the default ~/.config/rakazo-runner is never touched.
// Never prints codes or tokens; only counts of their occurrences in logs (expect 0).
//   RK_M2B_MODEL  model to switch on (default: smallest advertised, qwen2.5:3b if present)
import { launch, login, api, sql, shot, sleep, waitFor, BASE, OUT, API_CONTAINER, QA_EMAIL, QA2_EMAIL, q, container } from '../m2a/lib.mjs';
import { spawnSync, execFileSync } from 'node:child_process';
import fs from 'node:fs';
const T = '/tmp/rk-m3b-e2e';
const SVC = 'rakijazios-runner-e2e-m3b';
const results = {}; const secrets = []; let failures = 0;
const ok = (k, v, pass = true) => { results[k] = { v, pass }; if (!pass) failures++; console.log(pass ? 'CHECK' : 'FAIL ', k, JSON.stringify(v)); };
const eq = (k, v, want) => ok(k, v, v === want);
fs.rmSync(T, { recursive: true, force: true }); fs.mkdirSync(T + '/home', { recursive: true, mode: 0o700 });
const startedAt = new Date().toISOString();
const env = () => { const e = { ...process.env, HOME: T + '/home', RAKAZO_RUNNER_CONFIG_DIR: T + '/cfg', RAKAZO_RUNNER_SERVICE: SVC }; delete e.XDG_CONFIG_HOME; return e; };
const runnerPids = () => { try { return execFileSync('pgrep', ['-f', 'rk-m3b-e2e/home/.local/share/rakijazios-runner/app/src/index.ts']).toString().trim().split('\n').filter(Boolean); } catch { return []; } };
const stopRunner = () => { for (const pid of runnerPids()) { try { process.kill(Number(pid), 'SIGTERM'); } catch {} } };

const qaId = sql(`select id from "user" where email='${q(QA_EMAIL)}'`);
const BOT = sql(`select id from bots where "userId"='${qaId}' and name='QA Tester Bot' and "archivedAt" is null limit 1`);
const GROUP = sql(`select id from chat_groups where "userId"='${qaId}' and name='QA Group' limit 1`);
if (!BOT) throw new Error('QA Tester Bot not found');
const BOT2 = sql(`select id from bots where "userId"='${qaId}' and name='Chief' and "archivedAt" is null limit 1`);
const original2 = sql(`select coalesce("modelProvider",'')||'|'||coalesce("modelId",'') from bots where id='${BOT2}'`);
const binding2 = sql(`select device_id||'|'||model_id from local_runner_bot_bindings where bot_id='${BOT2}'`);
if (!BOT2 || binding2) throw new Error('needs qa\'s Chief without a computer binding (left untouched otherwise)');
const original = sql(`select coalesce("modelProvider",'')||'|'||coalesce("modelId",'') from bots where id='${BOT}'`);
// Only what this script creates is removed: its own pairing and the computer that pairing made.
const created = { pairingId: null, devId: null };
const cleanupDb = () => {
  if (created.devId) sql(`delete from local_runner_devices where id='${q(created.devId)}' and user_id='${qaId}'`);
  if (created.pairingId) sql(`delete from local_runner_pairings where id='${q(created.pairingId)}' and user_id='${qaId}'`);
};
const devicesBefore = new Set(sql(`select id from local_runner_devices where user_id='${qaId}'`).split('\n').filter(Boolean));

const browser = await launch('qa-m2c');
const page = await browser.newPage();
page.on('dialog', (d) => d.accept());
page.on('pageerror', (e) => console.log('PAGEERROR', e.message));
await login(page, QA_EMAIL);
await page.goto(BASE + '/app', { waitUntil: 'networkidle2' });
const spaceId = sql(`select "spaceId" from bots where id='${BOT}'`);

try {
  const pairing = await api(page, '/api/local-runners/pairings', { method: 'POST', body: JSON.stringify({ os: 'linux' }) });
  secrets.push(pairing.body?.code);
  created.pairingId = pairing.body?.pairingId || null;
  const r = spawnSync('sh', ['-c', pairing.body.commands.unixNoAutostart], { env: env(), encoding: 'utf8', timeout: 240000 });
  eq('install_exit', r.status, 0);
  try { secrets.push(JSON.parse(fs.readFileSync(T + '/cfg/credentials.json', 'utf8')).token); } catch {}
  const devId = await waitFor(() => sql(`select result_device_id from local_runner_pairings where id='${q(created.pairingId)}' and result_device_id is not null`) || null, 30000);
  created.devId = devId;
  ok('newDeviceOnly', !!devId && !devicesBefore.has(devId), !!devId && !devicesBefore.has(devId));
  const online = await waitFor(async () => { const d = await api(page, '/api/local-runners/devices'); return d.body?.devices?.find((x) => x.id === devId && x.online && x.models.length) || null; }, 90000);
  ok('runnerOnline', !!online, !!online);
  const want = process.env.RK_M2B_MODEL || (online.models.find((m) => m.id === 'qwen2.5:3b') ? 'qwen2.5:3b' : online.models[0].id);
  await api(page, `/api/local-runners/devices/${devId}/models`, { method: 'POST', body: JSON.stringify({ modelId: want, enabled: true }) });
  const bind = await api(page, `/api/local-runners/bots/${BOT}/model`, { method: 'POST', body: JSON.stringify({ deviceId: devId, modelId: want }) });
  eq('bind', bind.status, 200);
  eq('groupIsShared', Number(sql(`select count(*) from group_shares where group_id='${GROUP}'`)) > 0, true);

  const send = async (text, wait = true) => {
    const since = sql(`select now()`);
    const res = await api(page, '/rpc/threads/send', { method: 'POST', body: JSON.stringify({ json: { groupId: GROUP, mentions: [BOT], text, clientNonce: `m2c-${Date.now()}-${Math.random()}` } }) }, spaceId);
    if (res.status !== 200) return { status: res.status, error: JSON.stringify(res.body).slice(0, 200) };
    if (!wait) return { since };
    return finished(since);
  };
  const finished = async (since) => {
    const run = await waitFor(() => sql(`select id||'|'||status||'|'||coalesce(error,'') from runs where "botId"='${BOT}' and "createdAt" > '${since}' and status in ('completed','failed','cancelled') order by "createdAt" desc limit 1`) || null, 240000, 1000);
    if (!run) return { status: 'timeout' };
    const [id, status, ...err] = run.split('|'); return { id, status, error: err.join('|') };
  };

  // ---------- M3b(a): queue instead of refusing when busy ----------
  await api(page, `/api/local-runners/groups/${GROUP}/grants`, { method: 'POST', body: JSON.stringify({ botId: BOT, allowed: true }) });
  const setL = await api(page, `/api/local-runners/devices/${devId}/limits`, { method: 'POST', body: JSON.stringify({ maxConcurrent: 1 }) });
  ok('setConcurrency1', setL.body?.limits, setL.status === 200 && setL.body.limits.maxConcurrent === 1);
  // A second bot on the same computer: runs of one bot are serialised by the worker, so the
  // queue is only reached by two different bots. qa's Chief is bound for the test and restored after.
  const bind2 = await api(page, `/api/local-runners/bots/${BOT2}/model`, { method: 'POST', body: JSON.stringify({ deviceId: devId, modelId: want }) });
  ok('bindSecondBot', bind2.status, bind2.status === 200);
  const sendPrivate = async (text) => {
    const since = sql(`select now()`);
    const res = await api(page, '/rpc/threads/send', { method: 'POST', body: JSON.stringify({ json: { botId: BOT2, text, clientNonce: `m3b-p-${Date.now()}` } }) }, spaceId);
    if (res.status !== 200) return { status: res.status, error: JSON.stringify(res.body).slice(0, 200) };
    return { since };
  };
  const finishedAfter = async (since, notIn = [], bot = BOT) => {
    const run = await waitFor(() => sql(`select id||'|'||status||'|'||coalesce(error,'') from runs where "botId"='${bot}' and "createdAt" > '${since}' and status in ('completed','failed','cancelled') ${notIn.length ? `and id not in (${notIn.map((x) => `'${x}'`).join(',')})` : ''} order by "createdAt" asc limit 1`) || null, 240000, 1000);
    if (!run) return { status: 'timeout' };
    const [id, status, ...err] = run.split('|'); return { id, status, error: err.join('|') };
  };
  // a long-ish answer first, then a second request while it is still answering
  const g = await send('Count from 1 to 100, one number per line, digits only. Do not skip any number.', false);
  await waitFor(async () => { const d = (await api(page, '/api/local-runners/devices')).body?.devices?.find((x) => x.id === devId); return d?.health?.inFlight > 0 || null; }, 90000, 100);
  const pv = await sendPrivate('Reply with just the word OK.');
  const queuedSeen = await waitFor(async () => { const d = (await api(page, '/api/local-runners/devices')).body?.devices?.find((x) => x.id === devId); return d?.health?.queued > 0 || null; }, 60000, 100);
  ok('secondRequestQueued', !!queuedSeen, !!queuedSeen);
  const r1 = await finishedAfter(g.since);
  const r2 = await finishedAfter(pv.since, [r1.id], BOT2);
  ok('bothAnswered', [r1.status, r2.status, r2.error], r1.status === 'completed' && r2.status === 'completed');
  const refused = sql(`select count(*) from local_runner_usage where device_id='${devId}' and status like 'refused_%'`);
  ok('noBusyRefusal', refused, refused === '0');
  const okRows = Number(sql(`select count(*) from local_runner_usage where device_id='${devId}' and status='ok'`));
  ok('usageRowsForBoth', okRows, okRows >= 2);
  const d1 = (await api(page, '/api/local-runners/devices')).body?.devices?.find((x) => x.id === devId);
  ok('queueEmptyAfter', d1?.health?.queued, d1?.health?.queued === 0);
} finally {
  stopRunner();
  const [p, m] = original.split('|');
  sql(`update bots set "modelProvider"=${p ? `'${q(p)}'` : 'null'}, "modelId"=${m ? `'${q(m)}'` : 'null'} where id='${BOT}'`);
  sql(`delete from local_runner_grants where bot_id='${BOT}'`);
  if (created.devId) sql(`delete from local_runner_usage where device_id='${q(created.devId)}'`);
  sql(`delete from local_runner_bot_bindings where bot_id='${BOT}'`);
  { const [p2, m2] = original2.split('|');
    sql(`update bots set "modelProvider"=${p2 ? `'${q(p2)}'` : 'null'}, "modelId"=${m2 ? `'${q(m2)}'` : 'null'} where id='${BOT2}'`);
    sql(`delete from local_runner_bot_bindings where bot_id='${BOT2}'`);
  }
  cleanupDb();
  const left = new Set(sql(`select id from local_runner_devices where user_id='${qaId}'`).split('\n').filter(Boolean));
  ok('otherDevicesUntouched', { before: devicesBefore.size, oursGone: !created.devId || !left.has(created.devId) }, [...devicesBefore].every((id) => left.has(id)) && (!created.devId || !left.has(created.devId)));
  await browser.close();
  const logs = ['api', 'worker'].map((s) => spawnSync('docker', ['logs', '--since', startedAt, container(s)], { encoding: 'utf8', maxBuffer: 1 << 28 })).map((x) => x.stdout + x.stderr).join('\n')
    + (fs.existsSync(T + '/cfg/runner.log') ? fs.readFileSync(T + '/cfg/runner.log', 'utf8') : '');
  const leaks = secrets.filter(Boolean).reduce((n, s) => n + logs.split(s).length - 1, 0) + (logs.match(/sl2\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.\d+\.[A-Za-z0-9_-]{20,}/g) || []).length;
  eq('secretsInLogs', leaks, 0);
  fs.writeFileSync(`${OUT}/m3b-queue-results.json`, JSON.stringify(results, null, 2));
  fs.rmSync(T, { recursive: true, force: true });
  console.log(failures ? `FAILED ${failures}` : 'ALL PASSED');
  process.exit(failures ? 1 : 0);
}
