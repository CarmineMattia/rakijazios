// M3a e2e: limits + usage (per-person rate, daily cap for other people, usage rows, chart).
// Based on 61: Bind a bot to one computer + model from "My hardware", then exercise the
// run-bound gateway rules with real runs. Throwaway runner (temp HOME, config dir,
// service name) for the QA account; the default ~/.config/rakazo-runner is never touched.
// Never prints codes or tokens; only counts of their occurrences in logs (expect 0).
//   RK_M2B_MODEL  model to switch on (default: smallest advertised, qwen2.5:3b if present)
import { launch, login, api, sql, shot, sleep, waitFor, BASE, OUT, API_CONTAINER, QA_EMAIL, QA2_EMAIL, q, container } from '../m2a/lib.mjs';
import { spawnSync, execFileSync } from 'node:child_process';
import fs from 'node:fs';
const T = '/tmp/rk-m3-e2e';
const SVC = 'rakijazios-runner-e2e-m3';
const results = {}; const secrets = []; let failures = 0;
const ok = (k, v, pass = true) => { results[k] = { v, pass }; if (!pass) failures++; console.log(pass ? 'CHECK' : 'FAIL ', k, JSON.stringify(v)); };
const eq = (k, v, want) => ok(k, v, v === want);
fs.rmSync(T, { recursive: true, force: true }); fs.mkdirSync(T + '/home', { recursive: true, mode: 0o700 });
const startedAt = new Date().toISOString();
const env = () => { const e = { ...process.env, HOME: T + '/home', RAKAZO_RUNNER_CONFIG_DIR: T + '/cfg', RAKAZO_RUNNER_SERVICE: SVC }; delete e.XDG_CONFIG_HOME; return e; };
const runnerPids = () => { try { return execFileSync('pgrep', ['-f', 'rk-m3-e2e/home/.local/share/rakijazios-runner/app/src/index.ts']).toString().trim().split('\n').filter(Boolean); } catch { return []; } };
const stopRunner = () => { for (const pid of runnerPids()) { try { process.kill(Number(pid), 'SIGTERM'); } catch {} } };

const qaId = sql(`select id from "user" where email='${q(QA_EMAIL)}'`);
const BOT = sql(`select id from bots where "userId"='${qaId}' and name='QA Tester Bot' and "archivedAt" is null limit 1`);
const GROUP = sql(`select id from chat_groups where "userId"='${qaId}' and name='QA Group' limit 1`);
if (!BOT) throw new Error('QA Tester Bot not found');
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

  // ---------- M3a: limits + usage ----------
  const qa2Id = sql(`select id from "user" where email='${q(QA2_EMAIL)}'`);
  await api(page, `/api/local-runners/groups/${GROUP}/grants`, { method: 'POST', body: JSON.stringify({ botId: BOT, allowed: true }) });
  const d0 = (await api(page, '/api/local-runners/devices')).body.devices.find((x) => x.id === devId);
  ok('defaultLimits', d0?.limits, d0?.limits?.maxConcurrent === 2 && d0.limits.perUserPerMinute === 20 && d0.limits.dailyRequestCap === null);
  eq('limitsValidation', (await api(page, `/api/local-runners/devices/${devId}/limits`, { method: 'POST', body: JSON.stringify({ maxConcurrent: 99 }) })).status, 400);
  const setL = await api(page, `/api/local-runners/devices/${devId}/limits`, { method: 'POST', body: JSON.stringify({ perUserPerMinute: 1 }) });
  ok('setRate1', setL.body, setL.status === 200 && setL.body.limits.perUserPerMinute === 1);

  // owner answer: one usage row per model request, run ids match, owner not rate limited
  const own1 = await send('Reply with just the word OK.');
  const own2 = await send('Reply with just the word OK.');
  ok('ownerNotRateLimited', [own1.status, own2.status], own1.status === 'completed' && own2.status === 'completed');
  const ownRows = sql(`select status||'|'||consumer_user_id||'|'||input_tokens||'|'||output_tokens from local_runner_usage where run_id='${own1.id}'`);
  ok('usageRowForOwner', ownRows, /^ok\|/.test(ownRows) && ownRows.includes(qaId));
  ok('usageTokensCounted', ownRows, ownRows.split('\n').some((l) => Number(l.split('|')[2]) > 0 && Number(l.split('|')[3]) > 0));
  const recRuns = sql(`select count(*) from usage_records where "runId"='${own1.id}'`);
  ok('matchesUsageRecords', { usageRecords: recRuns, ours: ownRows.split('\n').length }, Number(recRuns) >= 1);

  // qa2 in the shared group: 1 per minute → the second request is refused with a notice
  const page2 = await (await launch('qa2-m2c')).newPage();
  await login(page2, QA2_EMAIL); await page2.goto(BASE + '/app', { waitUntil: 'networkidle2' });
  const botName = sql(`select name from bots where id='${BOT}'`);
  const sharedSend = async (text) => {
    const since = sql(`select now()`);
    const r = await api(page2, `/api/group-sharing/groups/${GROUP}/messages`, { method: 'POST', body: JSON.stringify({ text: `@${botName} ${text}`, clientNonce: `m3a${Date.now()}${Math.floor(Math.random() * 1e6)}` }) }, spaceId);
    if (r.status !== 200) return { status: r.status, error: JSON.stringify(r.body).slice(0, 200) };
    return finished(since);
  };
  const peer1 = await sharedSend('Reply with just the word OK.');
  ok('peerFirstAnswers', peer1, peer1.status === 'completed');
  const peerRow = sql(`select consumer_user_id from local_runner_usage where run_id='${peer1.id}' limit 1`);
  ok('peerUsageAttributed', { consumerIsQa2: peerRow === qa2Id }, peerRow === qa2Id);
  const peer2 = await sharedSend('Reply with just the word OK.');
  ok('peerRateLimited', peer2, peer2.status === 'failed' && /limits how often each person can ask/.test(peer2.error));
  ok('refusalRecorded', sql(`select count(*) from local_runner_usage where run_id='${peer2.id}' and status='refused_rate_limited'`), Number(sql(`select count(*) from local_runner_usage where run_id='${peer2.id}' and status='refused_rate_limited'`)) >= 1);

  // daily cap for other people
  const peerToday = Number(sql(`select count(*) from local_runner_usage where device_id='${devId}' and consumer_user_id is distinct from owner_user_id and status in ('ok','error','cancelled') and created_at >= date_trunc('day', now())`));
  await api(page, `/api/local-runners/devices/${devId}/limits`, { method: 'POST', body: JSON.stringify({ perUserPerMinute: 600, dailyRequestCap: Math.max(1, peerToday) }) });
  const peer3 = await sharedSend('Reply with just the word OK.');
  ok('peerDailyCap', peer3, peer3.status === 'failed' && /today's limit for other people is used up/.test(peer3.error));
  const own3 = await send('Reply with just the word OK.');
  ok('ownerNotCapped', own3.status, own3.status === 'completed');

  // isolation: qa2 can't change qa's limits or see qa's usage
  eq('foreignLimits404', (await api(page2, `/api/local-runners/devices/${devId}/limits`, { method: 'POST', body: JSON.stringify({ maxConcurrent: 8 }) })).status, 404);
  const u2 = await api(page2, '/api/local-runners/usage');
  ok('foreignUsageHidden', { status: u2.status, rowsForQaDevice: (u2.body?.daily || []).filter((r) => r.deviceId === devId).length }, u2.status === 200 && !(u2.body?.daily || []).some((r) => r.deviceId === devId));
  await page2.browser().close();

  // owner usage API + UI
  const u = await api(page, '/api/local-runners/usage?days=14');
  const today = (u.body?.daily || []).filter((r) => r.deviceId === devId);
  ok('usageApi', today, today.length === 1 && today[0].requests >= 3 && today[0].peerRequests >= 1 && today[0].refused >= 2);
  ok('usagePeople', u.body?.people?.map((p) => p.name), (u.body?.people || []).some((p) => p.you) && (u.body?.people || []).some((p) => !p.you));
  await page.goto(BASE + '/app', { waitUntil: 'networkidle2' });
  await page.click('[data-testid="user-menu-trigger"]'); await sleep(400);
  await page.evaluate(() => [...document.querySelectorAll('button,[role=menuitem],a')].find((b) => b.textContent.trim() === 'Settings')?.click());
  await page.waitForSelector('#rk-hw-nav', { timeout: 15000 }); await page.click('#rk-hw-nav');
  const chart = await page.waitForSelector('[data-rk="hw-usage-chart"]', { timeout: 20000 }).catch(() => null);
  ok('uiChart', !!chart && (await page.$eval('[data-rk="hw-usage-total"]', (n) => n.textContent).catch(() => null)), !!chart);
  const card = `[data-rk-device="${devId}"]`;
  await page.click(`${card} [data-rk="hw-limits"] summary`);
  await page.$eval(`${card} [data-rk-limit="maxConcurrent"]`, (n) => { n.value = '3'; });
  await page.$eval(`${card} [data-rk-limit="dailyRequestCap"]`, (n) => { n.value = ''; });
  await page.click(`${card} [data-rk="hw-limits-save"]`);
  const saved = await waitFor(() => sql(`select max_concurrent||'|'||coalesce(daily_request_cap::text,'none') from local_runner_limits where device_id='${devId}'`) === '3|none' || null, 8000, 300);
  ok('uiSaveLimits', sql(`select max_concurrent||'|'||per_user_per_minute||'|'||coalesce(daily_request_cap::text,'none') from local_runner_limits where device_id='${devId}'`), !!saved);
  await shot(page, 'm3a-01-usage');
} finally {
  stopRunner();
  const [p, m] = original.split('|');
  sql(`update bots set "modelProvider"=${p ? `'${q(p)}'` : 'null'}, "modelId"=${m ? `'${q(m)}'` : 'null'} where id='${BOT}'`);
  sql(`delete from local_runner_grants where bot_id='${BOT}'`);
  if (created.devId) sql(`delete from local_runner_usage where device_id='${q(created.devId)}'`);
  sql(`delete from local_runner_bot_bindings where bot_id='${BOT}'`);
  cleanupDb();
  const left = new Set(sql(`select id from local_runner_devices where user_id='${qaId}'`).split('\n').filter(Boolean));
  ok('otherDevicesUntouched', { before: devicesBefore.size, oursGone: !created.devId || !left.has(created.devId) }, [...devicesBefore].every((id) => left.has(id)) && (!created.devId || !left.has(created.devId)));
  await browser.close();
  const logs = ['api', 'worker'].map((s) => spawnSync('docker', ['logs', '--since', startedAt, container(s)], { encoding: 'utf8', maxBuffer: 1 << 28 })).map((x) => x.stdout + x.stderr).join('\n')
    + (fs.existsSync(T + '/cfg/runner.log') ? fs.readFileSync(T + '/cfg/runner.log', 'utf8') : '');
  const leaks = secrets.filter(Boolean).reduce((n, s) => n + logs.split(s).length - 1, 0) + (logs.match(/sl2\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.\d+\.[A-Za-z0-9_-]{20,}/g) || []).length;
  eq('secretsInLogs', leaks, 0);
  fs.writeFileSync(`${OUT}/m3a-results.json`, JSON.stringify(results, null, 2));
  fs.rmSync(T, { recursive: true, force: true });
  console.log(failures ? `FAILED ${failures}` : 'ALL PASSED');
  process.exit(failures ? 1 : 0);
}
