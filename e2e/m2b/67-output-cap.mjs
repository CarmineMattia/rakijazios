// Output cap e2e: a prompt that asks for far more than the cap still ends as a completed answer,
// with output tokens at or under the cap (default 4096, RAKAZO_SHARED_LOCAL_MAX_OUTPUT_TOKENS),
// instead of streaming until the 30 min hard timeout. Same throwaway-runner setup as 64:
// temp HOME, config dir and service name for the QA account; ~/.config/rakazo-runner is never touched.
// Never prints codes or tokens; only counts of their occurrences in logs (expect 0).
//   RK_M2B_MODEL  model to switch on (default: smallest advertised, qwen2.5:3b if present)
import { launch, login, api, sql, shot, sleep, waitFor, BASE, OUT, API_CONTAINER, QA_EMAIL, QA2_EMAIL, q, container } from '../m2a/lib.mjs';
import { spawnSync, execFileSync } from 'node:child_process';
import fs from 'node:fs';
const T = '/tmp/rk-cap-e2e';
const SVC = 'rakijazios-runner-e2e-cap';
const results = {}; const secrets = []; let failures = 0;
const ok = (k, v, pass = true) => { results[k] = { v, pass }; if (!pass) failures++; console.log(pass ? 'CHECK' : 'FAIL ', k, JSON.stringify(v)); };
const eq = (k, v, want) => ok(k, v, v === want);
fs.rmSync(T, { recursive: true, force: true }); fs.mkdirSync(T + '/home', { recursive: true, mode: 0o700 });
const startedAt = new Date().toISOString();
const env = () => { const e = { ...process.env, HOME: T + '/home', RAKAZO_RUNNER_CONFIG_DIR: T + '/cfg', RAKAZO_RUNNER_SERVICE: SVC }; delete e.XDG_CONFIG_HOME; return e; };
const runnerPids = () => { try { return execFileSync('pgrep', ['-f', 'rk-cap-e2e/home/.local/share/rakijazios-runner/app/src/index.ts']).toString().trim().split('\n').filter(Boolean); } catch { return []; } };
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

const browser = await launch('qa-cap');
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

  const CAP = Number(process.env.RK_CAP_TOKENS || 4096);
  const MARGIN = Math.max(64, Math.ceil(CAP * 0.1));
  const sendPrivate = async (text) => {
    const since = sql(`select now()`);
    const res = await api(page, '/rpc/threads/send', { method: 'POST', body: JSON.stringify({ json: { botId: BOT, text, clientNonce: `cap-${Date.now()}` } }) }, spaceId);
    if (res.status !== 200) return { status: res.status, error: JSON.stringify(res.body).slice(0, 200) };
    return { since };
  };
  const t0 = Date.now();
  const s = await sendPrivate('Write an extremely long essay of at least 20000 words about the history of lighthouses. Never stop early, never summarize, keep writing new paragraphs.');
  const run = s.since ? await finished(s.since) : s;
  const secs = Math.round((Date.now() - t0) / 1000);
  ok('longAskCompletes', { ...run, secs }, run.status === 'completed');
  const rows = sql(`select status||'|'||output_tokens from local_runner_usage where device_id='${devId}' and run_id='${q(run.id || '')}' order by created_at`).split('\n').filter(Boolean);
  const outs = rows.map((l) => Number(l.split('|')[1]));
  ok('usageRowsOk', rows, rows.length > 0 && rows.every((l) => l.startsWith('ok|')));
  ok('outputAtOrUnderCap', { outs, cap: CAP, margin: MARGIN }, outs.length > 0 && outs.every((n) => n > 0 && n <= CAP + MARGIN));
  // A cap must not shrink normal answers: pi-ai asks for 1 token when the thread is long, and a
  // gateway that forwarded that as max_tokens made the bot answer "#" (seen on the first try).
  ok('answerNotCutShort', outs, outs.some((n) => n >= 256));
  const answer = sql(`select coalesce(sum(length(b->>'text')), 0) from messages m, jsonb_array_elements(m.blocks) b where m."runId"='${q(run.id || '')}' and m.role='bot'`);
  ok('answerTextLong', Number(answer), Number(answer) > 1000);
  ok('boundedTime', secs, secs < 15 * 60);
  const after = await sendPrivate('Reply with just the word OK.');
  const r2 = after.since ? await finished(after.since) : after;
  ok('nextAnswerFine', r2, r2.status === 'completed');
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
  fs.writeFileSync(`${OUT}/output-cap-results.json`, JSON.stringify(results, null, 2));
  fs.rmSync(T, { recursive: true, force: true });
  console.log(failures ? `FAILED ${failures}` : 'ALL PASSED');
  process.exit(failures ? 1 : 0);
}
