// Runner reliability e2e (isolated stack only): a throwaway runner for the QA account, pinned
// to a fake OpenAI-compatible model server this script starts (no Ollama, no real model).
//   1. freeze the runner mid-answer (SIGSTOP = network loss / sleep): the run fails fast with
//      "went offline during the answer"; owner and API show "reconnecting"; after 40 s the
//      runner resumes, notices the wake and comes back as one session; a new run completes;
//   2. kill it (no goodbye): the next run says "reconnecting" at once;
//   3. stop it cleanly: the next run says "offline right now" at once;
//   4. the model server dies mid-request: "model server isn't answering", health flips to not OK.
//   5. P29-2: in a real bot chat (/app/<botId>) "On my PC" opens the bot's picker;
//   P29-1: while the runner is frozen the device never reads "offline" before "reconnecting";
//   6. two runners with one key (copied config): they settle within a few replacements, the
//      older one stands by with a clear log line, the newest keeps the slot, the UI shows the
//      duplicate hint; when the newest stops, the standby one takes over.
// Only the computer and pairing this script creates are removed; the bot is restored.
// Never prints codes or tokens (counts their occurrences in logs, expect 0).
import { launch, login, api, sql, shot, sleep, waitFor, BASE, OUT, QA_EMAIL, q, container, openHardware } from '../m2a/lib.mjs';
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
const T = '/tmp/rk-rel-e2e';
const SVC = 'rakijazios-runner-e2e-rel';
const MODEL = 'rk-fake-reliability';
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
const runnerPids = () => { try { return execFileSync('pgrep', ['-f', 'rk-rel-e2e/home/.local/share/rakijazios-runner/app/src/index.ts']).toString().trim().split('\n').filter(Boolean).map(Number); } catch { return []; } };
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

const browser = await launch('qa-rel');
const page = await browser.newPage();
const dialogs = [];
page.on('dialog', (d) => { dialogs.push(d.message()); d.accept(); });
page.on('pageerror', (e) => console.log('PAGEERROR', e.message));
await login(page, QA_EMAIL);
await page.goto(BASE + '/app', { waitUntil: 'networkidle2' });

const device = async () => (await api(page, '/api/local-runners/devices')).body?.devices?.find((x) => x.id === created.devId) || null;
let seq = 0;
/** Starts a run; returns a promise of its outcome with the time from send to the end. */
const send = async (text) => {
  const since = sql(`select now()`); const t0 = Date.now();
  const res = await api(page, '/rpc/threads/send', { method: 'POST', body: JSON.stringify({ json: { botId: BOT, text, clientNonce: `rel-${Date.now()}-${++seq}` } }) }, spaceId);
  if (res.status !== 200) return { status: res.status, error: JSON.stringify(res.body).slice(0, 200) };
  const run = await waitFor(() => sql(`select id||'|'||status||'|'||coalesce(error,'') from runs where "botId"='${BOT}' and "createdAt" > '${since}' and status in ('completed','failed','cancelled') order by "createdAt" desc limit 1`) || null, 180000, 500);
  if (!run) return { status: 'timeout' };
  const [id, status, ...err] = run.split('|');
  return { id, status, error: err.join('|').slice(0, 300), seconds: Math.round((Date.now() - t0) / 100) / 10 };
};
const pill = () => page.$eval(`[data-rk-device="${created.devId}"] [data-rk="hw-state"]`, (n) => n.textContent).catch(() => null);

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
  ok('onlineStatusFields', d0 && { state: d0.state, version: d0.runnerVersion, modelServerOk: d0.modelServerOk, dup: d0.duplicateRunner },
    d0?.state === 'online' && d0.modelServerOk === true && d0.duplicateRunner === false && /^0\.2\.4/.test(d0.runnerVersion || ''));

  await api(page, `/api/local-runners/devices/${created.devId}/models`, { method: 'POST', body: JSON.stringify({ modelId: MODEL, enabled: true }) });
  const bind = await api(page, `/api/local-runners/bots/${BOT}/model`, { method: 'POST', body: JSON.stringify({ deviceId: created.devId, modelId: MODEL }) });
  ok('bound', bind.status, bind.status === 200);
  const botView = (await api(page, `/api/local-runners/bots/${BOT}`)).body;
  ok('botOwnerSeesState', botView && { state: botView.state, online: botView.online, modelServerOk: botView.modelServerOk }, botView?.state === 'online' && botView.modelServerOk === true);
  // ---------- P29-2: "On my PC" in a real bot chat ----------
  await page.goto(`${BASE}/app/${BOT}`, { waitUntil: 'networkidle2' });
  const fabBtn = await waitFor(async () => (await page.$$('#rk-parity-fab button')).length ? true : null, 20000, 500);
  const nDialogs = dialogs.length;
  await page.evaluate(() => [...document.querySelectorAll('#rk-parity-fab button')].find((b) => b.textContent === 'On my PC')?.click());
  const cur = await waitFor(() => page.$eval('[data-rk="bot-runs-on"]', (n) => n.textContent).catch(() => null), 15000, 300);
  ok('pickerInBotChat', { fab: !!fabBtn, current: cur, alerts: dialogs.slice(nDialogs) }, !!cur && cur.includes(MODEL) && dialogs.length === nDialogs);
  await shot(page, 'rel-00-picker-in-bot-chat');
  await page.goto(BASE + '/app', { waitUntil: 'networkidle2' });

  const base = await send('Reply with just the word OK.');
  ok('baselineRunCompletes', base, base.status === 'completed');

  await openHardware(page);
  await page.waitForSelector(`[data-rk-device="${created.devId}"]`, { timeout: 20000 });
  ok('uiOnline', await pill(), (await pill()) === 'Online');

  // ---------- 1. freeze mid-answer (network loss / sleep) ----------
  fake.mode = 'hang';
  const before = fake.requests;
  const frozenRun = send('Reply with just the word OK.');
  await waitFor(() => fake.requests > before || null, 60000, 200);
  await sleep(500); // the first token reached the gateway
  const frozenAt = Date.now();
  signal('SIGSTOP');
  // P29-1: watch the state the whole freeze; "offline" must never show before "reconnecting".
  const seenStates = []; let watching = true;
  const watcher = (async () => { while (watching) { const d = await device(); if (d) seenStates.push(d.state); await sleep(150); } })();
  const fr = await frozenRun;
  ok('midAnswerFreezeFailsFast', fr, fr.status === 'failed' && /went offline during the answer/.test(fr.error) && (Date.now() - frozenAt) < 35000);
  const st = await waitFor(async () => { const d = await device(); return d && d.state === 'reconnecting' ? d : null; }, 20000, 500);
  ok('apiReconnecting', st && { state: st.state, lastDisconnect: st.health?.lastDisconnect?.reason, lastSeenAt: !!st.lastSeenAt }, st?.state === 'reconnecting' && st.health?.lastDisconnect?.reason === 'ping-timeout' && !!st.lastSeenAt);
  const uiRe = await waitFor(async () => ((await pill()) === 'Reconnecting…' ? 'Reconnecting…' : null), 25000, 1000);
  ok('uiReconnecting', uiRe, uiRe === 'Reconnecting…');
  await shot(page, 'rel-01-reconnecting');
  const botRe = (await api(page, `/api/local-runners/bots/${BOT}`)).body;
  ok('botOwnerSeesReconnecting', botRe?.state, botRe?.state === 'reconnecting');
  await sleep(Math.max(0, 40000 - (Date.now() - frozenAt))); // long enough to count as a sleep
  watching = false; await watcher;
  const firstDown = seenStates.find((x) => x !== 'online');
  ok('neverOfflineBeforeReconnecting', { samples: seenStates.length, states: [...new Set(seenStates)], firstDown }, firstDown === 'reconnecting' && !seenStates.includes('offline'));
  fake.mode = 'ok';
  for (const res of fake.hung.splice(0)) res.destroy();
  signal('SIGCONT');
  const backAt = Date.now();
  const back = await waitFor(async () => { const d = await device(); return d?.state === 'online' ? d : null; }, 30000, 500);
  ok('reconnectsAfterWake', back && { seconds: Math.round((Date.now() - backAt) / 1000) }, !!back);
  ok('wakeDetected', /woke up after \d+s; reconnecting now/.test(runnerLog()), /woke up after \d+s; reconnecting now/.test(runnerLog()));
  await sleep(3000);
  const one = await device();
  ok('singleSession', { pids: runnerPids().length, dup: one?.duplicateRunner, replacedInLog: /took over/.test(runnerLog()) }, runnerPids().length === 1 && one?.duplicateRunner === false && !/took over/.test(runnerLog()));
  const after = await send('Reply with just the word OK.');
  ok('runAfterReconnect', after, after.status === 'completed');

  // ---------- 2. killed without goodbye: "reconnecting" at once ----------
  signal('SIGKILL');
  await waitFor(async () => ((await device())?.state === 'reconnecting' ? true : null), 15000, 300);
  const killed = await send('Reply OK.');
  ok('reconnectingNotice', killed, killed.status === 'failed' && /lost its connection a moment ago and is reconnecting/.test(killed.error) && killed.seconds < 20);

  // ---------- 3. stopped cleanly: "offline right now" at once ----------
  startRunner();
  await waitFor(async () => ((await device())?.state === 'online' ? true : null), 60000, 500);
  stopRunner();
  const off = await waitFor(async () => { const d = await device(); return d && d.state === 'offline' ? d : null; }, 15000, 300);
  ok('stoppedReadsOffline', off && { state: off.state, reason: off.health?.lastDisconnect?.reason }, off?.state === 'offline' && off.health?.lastDisconnect?.reason === 'stopped');
  const offline = await send('Reply OK.');
  ok('offlineNotice', offline, offline.status === 'failed' && /offline right now/.test(offline.error) && offline.seconds < 20);
  await page.reload({ waitUntil: 'networkidle2' }); await openHardware(page);
  await page.waitForSelector(`[data-rk-device="${created.devId}"]`, { timeout: 20000 });
  ok('uiOffline', await pill(), (await pill()) === 'Offline');

  // ---------- 4. model server dies mid-request ----------
  startRunner();
  await waitFor(async () => { const d = await device(); return d?.state === 'online' && d.modelServerOk === true ? true : null; }, 60000, 500);
  fake.mode = 'die';
  const dead = await send('Reply OK.');
  ok('modelServerDownNotice', dead, dead.status === 'failed' && /online, but its model server .* isn't answering/.test(dead.error));
  const h = await waitFor(async () => { const d = await device(); return d && d.modelServerOk === false ? d : null; }, 15000, 500);
  ok('healthFlipsNotOk', h && { modelServerOk: h.modelServerOk, lastError: h.health?.report?.lastError }, h?.modelServerOk === false && /stopped answering/.test(h.health?.report?.lastError || ''));
  const healthLine = await waitFor(async () => { const t = await page.$eval(`[data-rk-device="${created.devId}"] [data-rk="hw-health"]`, (n) => n.textContent).catch(() => ''); return /Model server not answering/.test(t) ? t : null; }, 25000, 1000);
  ok('uiModelServerDown', healthLine, !!healthLine);
  await shot(page, 'rel-02-model-server-down');
  fake.mode = 'ok';

  // ---------- 6. two runners with the same key settle ----------
  await waitFor(async () => { const d = await device(); return d?.state === 'online' && d.modelServerOk === true ? true : null; }, 60000, 500);
  fs.mkdirSync(T + '/cfg2', { recursive: true });
  for (const f of fs.readdirSync(T + '/cfg')) {
    if (/\.(log|pid|lock)$|^status/.test(f) || !fs.statSync(`${T}/cfg/${f}`).isFile()) continue;
    fs.copyFileSync(`${T}/cfg/${f}`, `${T}/cfg2/${f}`);
  }
  const logA = () => runnerLog();
  const logB = () => { try { return fs.readFileSync(T + '/cfg2/runner.log', 'utf8'); } catch { return ''; } };
  // The launcher pins the first runner's config dir, so start the second one with its node directly.
  const PREFIX = T + '/home/.local/share/rakijazios-runner';
  const nodeBin = (fs.readFileSync(PREFIX + '/rakazo-runner', 'utf8').match(/^exec '([^']+)'/m) || [])[1];
  const second = spawn(nodeBin, [PREFIX + '/app/src/index.ts', 'run'], { env: { ...env(), RAKAZO_RUNNER_CONFIG_DIR: T + '/cfg2', RAKAZO_RUNNER_SERVICE: SVC + '-2' }, stdio: logTo(T + '/cfg2'), detached: true });
  second.unref(); created.secondPgid = second.pid;
  const dupAt = Date.now();
  const standbyRe = /Another runner is using this computer's key, so this runner is standing by/;
  const settled = await waitFor(() => (standbyRe.test(logA()) ? true : null), 240000, 2000);
  const replacements = () => (logA().match(/connected and took over|standing by/g) || []).length + (logB().match(/connected and took over|standing by/g) || []).length;
  ok('duplicateSettles', { seconds: Math.round((Date.now() - dupAt) / 1000), olderStandsBy: !!settled, newerStandsBy: standbyRe.test(logB()) }, !!settled && !standbyRe.test(logB()));
  const r0 = replacements();
  await sleep(45000);
  const dd = await device();
  ok('staysSettled', { newReplacements: replacements() - r0, state: dd?.state, dup: dd?.duplicateRunner }, replacements() === r0 && dd?.state === 'online' && dd?.duplicateRunner === true);
  const settledRun = await send('Reply with just the word OK.');
  ok('runWhileDuplicate', settledRun, settledRun.status === 'completed');
  await page.reload({ waitUntil: 'networkidle2' }); await openHardware(page);
  const hint = await waitFor(() => page.$eval(`[data-rk-device="${created.devId}"] [data-rk="hw-duplicate"]`, (n) => n.textContent).catch(() => null), 25000, 1000);
  ok('uiDuplicateHint', hint, !!hint);
  await shot(page, 'rel-03-duplicate-settled');
  try { process.kill(-created.secondPgid, 'SIGTERM'); } catch {}
  const tookAt = Date.now();
  const took = await waitFor(() => (/the other runner with this computer's key is gone; this runner took over/.test(logA()) ? true : null), 90000, 1000);
  const dt = await waitFor(async () => { const d = await device(); return d?.state === 'online' ? d : null; }, 15000, 500);
  ok('standbyTakesOver', { seconds: Math.round((Date.now() - tookAt) / 1000), state: dt?.state }, !!took && dt?.state === 'online');
  const takenRun = await send('Reply with just the word OK.');
  ok('runAfterTakeover', takenRun, takenRun.status === 'completed');
} finally {
  if (created.secondPgid) { try { process.kill(-created.secondPgid, 'SIGTERM'); } catch {} }
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
  fs.writeFileSync(`${OUT}/rel-runner.log`, runnerLog().replace(/sl2\.\S+/g, '[token]'));
  try { fs.writeFileSync(`${OUT}/rel-runner2.log`, fs.readFileSync(T + '/cfg2/runner.log', 'utf8').replace(/sl2\.\S+/g, '[token]')); } catch {}
  const leaks = secrets.filter(Boolean).reduce((n, s) => n + logs.split(s).length - 1, 0);
  ok('secretsInLogs', leaks, leaks === 0);
  fs.writeFileSync(`${OUT}/rel-results.json`, JSON.stringify(results, null, 2));
  fs.rmSync(T, { recursive: true, force: true });
  console.log(failures ? `FAILED ${failures}` : 'ALL PASSED');
  process.exit(failures ? 1 : 0);
}
