// Failed-run notices persist in chat history (isolated stack only). A throwaway runner for the QA
// account, pinned to a fake model server this script starts (no Ollama, no real model).
// Four failed runs, one per share-local-AI notice:
//   A. the runner freezes mid-answer (network loss / sleep): "went offline during the answer";
//   B. the runner is killed (no goodbye): "lost its connection … reconnecting";
//   C. the runner stops cleanly: "offline right now";
//   D. the model server dies mid-request: "model server … isn't answering".
// Each failed run gets one system notice in history (DB), right after its user message; open chats
// get it live; after reloading the chat every notice is still shown, once; threads.get returns them;
// a completed run gets none. Only the computer and pairing this script creates are removed; the
// bot is restored. Never prints codes or tokens (counts their occurrences in logs, expect 0).
import { launch, login, api, sql, shot, sleep, waitFor, BASE, OUT, QA_EMAIL, q, container, openHardware } from '../m2a/lib.mjs';
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
const T = '/tmp/rk-notice-e2e';
const SVC = 'rakijazios-runner-e2e-notice';
const MODEL = 'rk-fake-notice';
const results = {}; const secrets = []; let failures = 0;
const ok = (k, v, pass = true) => { results[k] = { v, pass }; if (!pass) failures++; console.log(pass ? 'CHECK' : 'FAIL ', k, JSON.stringify(v)); };
fs.rmSync(T, { recursive: true, force: true }); fs.mkdirSync(T + '/home', { recursive: true, mode: 0o700 }); fs.mkdirSync(OUT, { recursive: true });
const startedAt = new Date().toISOString();

// ---------- fake model server ----------
const fake = { mode: 'ok', requests: 0, hung: [] };
const srv = http.createServer((req, res) => {
  if (req.method === 'GET' && req.url.endsWith('/models')) {
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ object: 'list', data: [{ id: MODEL, object: 'model' }] }));
  }
  if (req.method === 'POST' && req.url.endsWith('/chat/completions')) {
    fake.requests++;
    req.resume();
    if (fake.mode === 'die') { req.socket.destroy(); return; }
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const chunk = (o) => res.write(`data: ${JSON.stringify(o)}\n\n`);
    chunk({ id: 'c', object: 'chat.completion.chunk', model: MODEL, choices: [{ index: 0, delta: { role: 'assistant', content: 'OK' } }] });
    if (fake.mode === 'hang') { fake.hung.push(res); return; }
    chunk({ id: 'c', object: 'chat.completion.chunk', model: MODEL, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
    chunk({ id: 'c', object: 'chat.completion.chunk', model: MODEL, choices: [], usage: { prompt_tokens: 5, completion_tokens: 1, total_tokens: 6 } });
    res.end('data: [DONE]\n\n');
    return;
  }
  res.writeHead(404); res.end();
});
await new Promise((r) => srv.listen(0, '127.0.0.1', r));
const MODEL_URL = `http://127.0.0.1:${srv.address().port}/v1`;

const env = () => { const e = { ...process.env, HOME: T + '/home', RAKAZO_RUNNER_CONFIG_DIR: T + '/cfg', RAKAZO_RUNNER_SERVICE: SVC, RAKAZO_RUNNER_MODEL_URL: MODEL_URL }; delete e.XDG_CONFIG_HOME; return e; };
const runnerPids = () => { try { return execFileSync('pgrep', ['-f', 'rk-notice-e2e/home/.local/share/rakijazios-runner/app/src/index.ts']).toString().trim().split('\n').filter(Boolean).map(Number); } catch { return []; } };
const signal = (sig) => { for (const pid of runnerPids()) { try { process.kill(pid, sig); } catch {} } };
const stopRunner = () => { signal('SIGCONT'); signal('SIGTERM'); };
// `run` logs to stdout (only `start` redirects), so append to the config dir's runner.log like `start` does.
const logTo = (dir) => { const fd = fs.openSync(dir + '/runner.log', 'a', 0o600); return ['ignore', fd, fd]; };
const startRunner = () => { const c = spawn(T + '/home/.local/share/rakijazios-runner/rakazo-runner', ['run'], { env: env(), stdio: logTo(T + '/cfg'), detached: true }); c.unref(); };
const runnerLog = () => { try { return fs.readFileSync(T + '/cfg/runner.log', 'utf8'); } catch { return ''; } };


const qaId = sql(`select id from "user" where email='${q(QA_EMAIL)}'`);
const BOT = sql(`select id from bots where "userId"='${qaId}' and name='QA Tester Bot' and "archivedAt" is null limit 1`);
if (!BOT) throw new Error('QA Tester Bot not found');
const original = sql(`select coalesce("modelProvider",'')||'|'||coalesce("modelId",'') from bots where id='${BOT}'`);
const spaceId = sql(`select "spaceId" from bots where id='${BOT}'`);
const created = { pairingId: null, devId: null };
const devicesBefore = new Set(sql(`select id from local_runner_devices where user_id='${qaId}'`).split('\n').filter(Boolean));

const browser = await launch('qa-notice');
const page = await browser.newPage();
page.on('dialog', (d) => d.accept());
page.on('pageerror', (e) => console.log('PAGEERROR', e.message));
await login(page, QA_EMAIL);

const device = async () => (await api(page, '/api/local-runners/devices')).body?.devices?.find((x) => x.id === created.devId) || null;
let seq = 0;
const send = async (text) => {
  const since = sql(`select now()`); const t0 = Date.now();
  const res = await api(page, '/rpc/threads/send', { method: 'POST', body: JSON.stringify({ json: { botId: BOT, text, clientNonce: `notice-${Date.now()}-${++seq}` } }) }, spaceId);
  if (res.status !== 200) return { status: res.status, error: JSON.stringify(res.body).slice(0, 200) };
  const run = await waitFor(() => sql(`select id||'|'||status||'|'||coalesce(error,'') from runs where "botId"='${BOT}' and "createdAt" > '${since}' and status in ('completed','failed','cancelled') order by "createdAt" desc limit 1`) || null, 180000, 500);
  if (!run) return { status: 'timeout' };
  const [id, status, ...err] = run.split('|');
  return { id, status, error: err.join('|'), seconds: Math.round((Date.now() - t0) / 100) / 10 };
};
/** The system notice rows for a run: role, meta text, and whether it sits after the run's user message. */
const noticeRows = (runId) => sql(`select m.role||'|'||(m.blocks->0->>'kind')||'|'||(m.seq > coalesce(s.seq,-1))::text||'|'||(m.blocks->0->>'text') from messages m join runs r on r.id=m."runId" left join messages s on s.id=r."sourceMessageId" where m."runId"='${q(runId)}' and m.role='system'`).split('\n').filter(Boolean)
  .map((l) => { const [role, kind, after, ...t] = l.split('|'); return { role, kind, after: after === 'true', text: t.join('|') }; });
const checkRow = (key, run, re) => {
  const rows = noticeRows(run.id);
  ok(key, { status: run.status, error: run.error.slice(0, 160), rows: rows.map((r) => ({ ...r, text: r.text.slice(0, 80) })) },
    run.status === 'failed' && re.test(run.error) && rows.length === 1 && rows[0].role === 'system' && rows[0].kind === 'meta' && rows[0].after && rows[0].text === run.error);
};
/** Where a text shows on the page: count of leaf-ish elements whose text contains it, split by chat pane vs elsewhere. */
const where = (text) => page.evaluate((t) => {
  const hits = [...document.querySelectorAll('body *')].filter((n) => n.children.length === 0 || [...n.childNodes].some((c) => c.nodeType === 3 && c.textContent.includes(t.slice(0, 40))))
    .filter((n) => (n.textContent || '').includes(t.slice(0, 60)));
  const leaves = hits.filter((n) => !hits.some((o) => o !== n && n.contains(o)));
  const inNav = (n) => !!n.closest('aside, nav, [data-rk-sidebar], [class*="sidebar" i]');
  return { pane: leaves.filter((n) => !inNav(n)).length, nav: leaves.filter(inNav).length, tags: leaves.slice(0, 4).map((n) => `${n.tagName.toLowerCase()}.${String(n.className).slice(0, 40)}`) };
}, text);
const openChat = async () => { await page.goto(`${BASE}/app/${BOT}`, { waitUntil: 'networkidle2' }); await sleep(1500); };

try {
  // ---------- pair a throwaway runner pinned to the fake model server ----------
  const pairing = await api(page, '/api/local-runners/pairings', { method: 'POST', body: JSON.stringify({ os: 'linux' }) });
  secrets.push(pairing.body?.code); created.pairingId = pairing.body?.pairingId || null;
  const r = spawnSync('sh', ['-c', pairing.body?.commands?.unixNoAutostart], { env: env(), encoding: 'utf8', timeout: 240000 });
  fs.writeFileSync(T + '/install.log', (r.stdout || '') + (r.stderr || ''));
  ok('install_exit', r.status, r.status === 0);
  try { secrets.push(JSON.parse(fs.readFileSync(T + '/cfg/credentials.json', 'utf8')).token); } catch {}
  created.devId = await waitFor(() => sql(`select result_device_id from local_runner_pairings where id='${q(created.pairingId)}' and result_device_id is not null`) || null, 30000);
  ok('newDeviceOnly', !!created.devId && !devicesBefore.has(created.devId), !!created.devId && !devicesBefore.has(created.devId));
  if (!runnerPids().length) startRunner();
  const d0 = await waitFor(async () => { const d = await device(); return d?.online && d.models.some((m) => m.id === MODEL) && d.modelServerOk === true ? d : null; }, 90000, 1000);
  ok('online', d0?.state, d0?.state === 'online');
  await api(page, `/api/local-runners/devices/${created.devId}/models`, { method: 'POST', body: JSON.stringify({ modelId: MODEL, enabled: true }) });
  const bind = await api(page, `/api/local-runners/bots/${BOT}/model`, { method: 'POST', body: JSON.stringify({ deviceId: created.devId, modelId: MODEL }) });
  ok('bound', bind.status, bind.status === 200);

  await openChat();
  const base = await send('Reply with just the word OK.');
  ok('completedRunHasNoNotice', { status: base.status, notices: base.id ? noticeRows(base.id).length : null }, base.status === 'completed' && noticeRows(base.id).length === 0);

  // ---------- A. freeze mid-answer ----------
  fake.mode = 'hang';
  const before = fake.requests;
  const frozenRun = send('Notice A: freeze mid-answer.');
  await waitFor(() => fake.requests > before || null, 60000, 200);
  await sleep(500);
  signal('SIGSTOP');
  const A = await frozenRun;
  checkRow('A_midAnswerNoticeSaved', A, /went offline during the answer/);
  fake.mode = 'ok';
  for (const res of fake.hung.splice(0)) res.destroy();
  signal('SIGCONT');
  await waitFor(async () => ((await device())?.state === 'online' ? true : null), 60000, 500);

  // ---------- B. killed: live notice in the open chat ----------
  signal('SIGKILL');
  await waitFor(async () => ((await device())?.state === 'reconnecting' ? true : null), 15000, 300);
  const B = await send('Notice B: runner killed.');
  checkRow('B_reconnectingNoticeSaved', B, /lost its connection a moment ago and is reconnecting/);
  const live = await waitFor(async () => { const w = await where(B.error); return w.pane > 0 ? w : null; }, 15000, 500);
  ok('B_shownLiveInOpenChat', live, !!live);
  await shot(page, 'notice-01-live');

  // ---------- C. stopped cleanly ----------
  startRunner();
  await waitFor(async () => ((await device())?.state === 'online' ? true : null), 60000, 500);
  stopRunner();
  await waitFor(async () => ((await device())?.state === 'offline' ? true : null), 15000, 300);
  const C = await send('Notice C: runner stopped.');
  checkRow('C_offlineNoticeSaved', C, /offline right now/);

  // ---------- D. model server dies mid-request ----------
  startRunner();
  await waitFor(async () => { const d = await device(); return d?.state === 'online' && d.modelServerOk === true ? true : null; }, 60000, 500);
  fake.mode = 'die';
  const D = await send('Notice D: model server dies.');
  checkRow('D_modelServerNoticeSaved', D, /online, but its model server .* isn't answering/);
  fake.mode = 'ok';

  // ---------- reopen the chat: every notice is still there, once ----------
  await page.goto(BASE + '/app', { waitUntil: 'networkidle2' });
  await openChat();
  await page.reload({ waitUntil: 'networkidle2' }); await sleep(2000);
  const shown = {};
  for (const [k, run] of Object.entries({ A, B, C, D })) shown[k] = await where(run.error);
  ok('reopenedShowsEveryNotice', shown, Object.values(shown).every((w) => w.pane >= 1));
  // On a reused chat (live, after e2e 69) earlier failed runs left notices with the same text, so
  // "no duplicates" means the page never shows a text more often than history holds it (one per run).
  const historyCount = (run) => Number(sql(`select count(*) from messages m join runs r on r.id='${q(run.id)}' where m."threadId"=r."threadId" and m.role='system' and m.blocks->0->>'text'='${q(run.error)}'`));
  for (const [k, run] of Object.entries({ A, B, C, D })) shown[k].inHistory = historyCount(run);
  ok('reopenedNoDuplicates', shown, Object.values(shown).every((w) => w.pane >= 1 && w.pane <= w.inHistory));
  await shot(page, 'notice-02-reopened');
  const snap = await api(page, '/rpc/threads/get', { method: 'POST', body: JSON.stringify({ json: { botId: BOT } }) }, spaceId);
  const msgs = snap.body?.json?.messages || snap.body?.messages || [];
  const inHistory = Object.fromEntries(Object.entries({ A, B, C, D }).map(([k, run]) => [k, msgs.filter((m) => m.runId === run.id && m.role === 'system' && m.blocks?.[0]?.kind === 'meta' && m.blocks[0].text === run.error).length]));
  ok('threadsGetReturnsNotices', { status: snap.status, inHistory }, snap.status === 200 && Object.values(inHistory).every((n) => n === 1));

  // A new run still works and adds no notice.
  const after = await send('Reply with just the word OK.');
  ok('runAfterCompletes', { status: after.status, notices: after.id ? noticeRows(after.id).length : null }, after.status === 'completed' && noticeRows(after.id).length === 0);
} finally {
  stopRunner();
  for (const res of fake.hung.splice(0)) res.destroy();
  const [p, m] = original.split('|');
  sql(`update bots set "modelProvider"=${p ? `'${q(p)}'` : 'null'}, "modelId"=${m ? `'${q(m)}'` : 'null'} where id='${BOT}'`);
  sql(`delete from local_runner_bot_bindings where bot_id='${BOT}'`);
  if (created.devId) sql(`delete from local_runner_devices where id='${q(created.devId)}' and user_id='${qaId}'`);
  if (created.pairingId) sql(`delete from local_runner_pairings where id='${q(created.pairingId)}' and user_id='${qaId}'`);
  const left = new Set(sql(`select id from local_runner_devices where user_id='${qaId}'`).split('\n').filter(Boolean));
  ok('otherDevicesUntouched', { before: devicesBefore.size }, [...devicesBefore].every((id) => left.has(id)) && (!created.devId || !left.has(created.devId)));
  await browser.close();
  srv.close();
  const logs = ['api', 'worker'].map((s) => spawnSync('docker', ['logs', '--since', startedAt, container(s)], { encoding: 'utf8', maxBuffer: 1 << 28 })).map((x) => x.stdout + x.stderr).join('\n') + runnerLog();
  ok('noNoticeWriteErrors', (logs.match(/failed-run notice/g) || []).length, !/failed-run notice/.test(logs));
  const leaks = secrets.filter(Boolean).reduce((n, s) => n + logs.split(s).length - 1, 0);
  ok('secretsInLogs', leaks, leaks === 0);
  fs.writeFileSync(`${OUT}/notice-results.json`, JSON.stringify(results, null, 2));
  fs.rmSync(T, { recursive: true, force: true });
  console.log(failures ? `FAILED ${failures}` : 'ALL PASSED');
  process.exit(failures ? 1 : 0);
}
