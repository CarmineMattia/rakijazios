// M3b(b) e2e: per-person daily cap and daily token cap for other people (owner exempt), UI fields.
// Based on 61: Bind a bot to one computer + model from "My hardware", then exercise the
// run-bound gateway rules with real runs. Throwaway runner (temp HOME, config dir,
// service name) for the QA account; the default ~/.config/rakazo-runner is never touched.
// Never prints codes or tokens; only counts of their occurrences in logs (expect 0).
//   RK_M2B_MODEL  model to switch on (default: smallest advertised, qwen2.5:3b if present)
import { launch, login, api, sql, shot, sleep, waitFor, BASE, OUT, API_CONTAINER, QA_EMAIL, QA2_EMAIL, q, container } from '../m2a/lib.mjs';
import { spawnSync, execFileSync } from 'node:child_process';
import fs from 'node:fs';
const T = '/tmp/rk-m3c-e2e';
const SVC = 'rakijazios-runner-e2e-m3c';
const results = {}; const secrets = []; let failures = 0;
const ok = (k, v, pass = true) => { results[k] = { v, pass }; if (!pass) failures++; console.log(pass ? 'CHECK' : 'FAIL ', k, JSON.stringify(v)); };
const eq = (k, v, want) => ok(k, v, v === want);
fs.rmSync(T, { recursive: true, force: true }); fs.mkdirSync(T + '/home', { recursive: true, mode: 0o700 });
const startedAt = new Date().toISOString();
const env = () => { const e = { ...process.env, HOME: T + '/home', RAKAZO_RUNNER_CONFIG_DIR: T + '/cfg', RAKAZO_RUNNER_SERVICE: SVC }; delete e.XDG_CONFIG_HOME; return e; };
const runnerPids = () => { try { return execFileSync('pgrep', ['-f', 'rk-m3c-e2e/home/.local/share/rakijazios-runner/app/src/index.ts']).toString().trim().split('\n').filter(Boolean); } catch { return []; } };
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

  // ---------- M3b(b): per-person daily cap + token cap ----------
  const qa2Id = sql(`select id from "user" where email='${q(QA2_EMAIL)}'`);
  await api(page, `/api/local-runners/groups/${GROUP}/grants`, { method: 'POST', body: JSON.stringify({ botId: BOT, allowed: true }) });
  eq('tokenCapValidation', (await api(page, `/api/local-runners/devices/${devId}/limits`, { method: 'POST', body: JSON.stringify({ dailyTokenCap: 10 }) })).status, 400);
  const page2 = await (await launch('qa2-m2c')).newPage();
  await login(page2, QA2_EMAIL); await page2.goto(BASE + '/app', { waitUntil: 'networkidle2' });
  const botName = sql(`select name from bots where id='${BOT}'`);
  const sharedSend = async (text) => {
    const since = sql(`select now()`);
    const r = await api(page2, `/api/group-sharing/groups/${GROUP}/messages`, { method: 'POST', body: JSON.stringify({ text: `@${botName} ${text}`, clientNonce: `m3bc${Date.now()}${Math.floor(Math.random() * 1e6)}` }) }, spaceId);
    if (r.status !== 200) return { status: r.status, error: JSON.stringify(r.body).slice(0, 200) };
    return finished(since);
  };
  const p1 = await sharedSend('Reply with just the word OK.');
  ok('peerAnswersWithoutCaps', p1.status, p1.status === 'completed');
  const personToday = Number(sql(`select count(*) from local_runner_usage where device_id='${devId}' and consumer_user_id='${qa2Id}' and status in ('ok','error','cancelled') and created_at >= date_trunc('day', now())`));
  const s1 = await api(page, `/api/local-runners/devices/${devId}/limits`, { method: 'POST', body: JSON.stringify({ personDailyCap: Math.max(1, personToday) }) });
  ok('setPersonCap', s1.body?.limits, s1.status === 200 && s1.body.limits.personDailyCap === Math.max(1, personToday));
  const p2 = await sharedSend('Reply with just the word OK.');
  ok('personCapRefused', p2, p2.status === 'failed' && /your limit for today is used up/.test(p2.error));
  ok('personCapRecorded', sql(`select count(*) from local_runner_usage where run_id='${p2.id}' and status='refused_person_cap'`), Number(sql(`select count(*) from local_runner_usage where run_id='${p2.id}' and status='refused_person_cap'`)) >= 1);
  const own1 = await send('Reply with just the word OK.');
  ok('ownerNotPersonCapped', own1.status, own1.status === 'completed');
  // token cap: other people already used more than 1000 tokens today on this computer
  const peerTokens = Number(sql(`select coalesce(sum(input_tokens+output_tokens),0) from local_runner_usage where device_id='${devId}' and consumer_user_id is distinct from owner_user_id and created_at >= date_trunc('day', now())`));
  const s2 = await api(page, `/api/local-runners/devices/${devId}/limits`, { method: 'POST', body: JSON.stringify({ personDailyCap: null, dailyTokenCap: 1000 }) });
  ok('setTokenCap', { limits: s2.body?.limits, peerTokens }, s2.status === 200 && s2.body.limits.dailyTokenCap === 1000 && s2.body.limits.personDailyCap === null && peerTokens >= 1000);
  const p3 = await sharedSend('Reply with just the word OK.');
  ok('tokenCapRefused', p3, p3.status === 'failed' && /today's limit for other people is used up/.test(p3.error));
  const own2 = await send('Reply with just the word OK.');
  ok('ownerNotTokenCapped', own2.status, own2.status === 'completed');
  await api(page, `/api/local-runners/devices/${devId}/limits`, { method: 'POST', body: JSON.stringify({ dailyTokenCap: null }) });
  const p4 = await sharedSend('Reply with just the word OK.');
  ok('capsClearedPeerAnswers', p4.status, p4.status === 'completed');
  eq('foreignLimits404', (await api(page2, `/api/local-runners/devices/${devId}/limits`, { method: 'POST', body: JSON.stringify({ personDailyCap: 1 }) })).status, 404);
  await page2.browser().close();
  // UI: the summary shows the caps, the fields save
  await api(page, `/api/local-runners/devices/${devId}/limits`, { method: 'POST', body: JSON.stringify({ personDailyCap: 7, dailyTokenCap: 50000 }) });
  await page.goto(BASE + '/app', { waitUntil: 'networkidle2' });
  await page.click('[data-testid="user-menu-trigger"]'); await sleep(400);
  await page.evaluate(() => [...document.querySelectorAll('button,[role=menuitem],a')].find((b) => b.textContent.trim() === 'Settings')?.click());
  await page.waitForSelector('#rk-hw-nav', { timeout: 15000 }); await page.click('#rk-hw-nav');
  const card = `[data-rk-device="${devId}"]`;
  await page.waitForSelector(`${card} [data-rk="hw-limits"] summary`, { timeout: 20000 });
  const summary = await page.$eval(`${card} [data-rk="hw-limits"] summary`, (n) => n.textContent);
  ok('uiSummaryShowsCaps', summary, /7\/day per person/.test(summary) && /50,000 tokens\/day|50000 tokens\/day|50\.000 tokens\/day/.test(summary));
  await page.click(`${card} [data-rk="hw-limits"] summary`);
  await page.$eval(`${card} [data-rk-limit="personDailyCap"]`, (n) => { n.value = ''; });
  await page.$eval(`${card} [data-rk-limit="dailyTokenCap"]`, (n) => { n.value = '2000'; });
  await page.click(`${card} [data-rk="hw-limits-save"]`);
  const saved = await waitFor(() => sql(`select coalesce(person_daily_cap::text,'none')||'|'||coalesce(daily_token_cap::text,'none') from local_runner_limits where device_id='${devId}'`) === 'none|2000' || null, 8000, 300);
  ok('uiSaveCaps', sql(`select coalesce(person_daily_cap::text,'none')||'|'||coalesce(daily_token_cap::text,'none') from local_runner_limits where device_id='${devId}'`), !!saved);
  await shot(page, 'm3b-caps-01');
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
  fs.writeFileSync(`${OUT}/m3b-caps-results.json`, JSON.stringify(results, null, 2));
  fs.rmSync(T, { recursive: true, force: true });
  console.log(failures ? `FAILED ${failures}` : 'ALL PASSED');
  process.exit(failures ? 1 : 0);
}
