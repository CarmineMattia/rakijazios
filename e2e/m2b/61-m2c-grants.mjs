// M2c e2e: group grants. Bind a bot to one computer + model from "My hardware", then exercise the
// run-bound gateway rules with real runs. Throwaway runner (temp HOME, config dir,
// service name) for the QA account; the default ~/.config/rakazo-runner is never touched.
// Never prints codes or tokens; only counts of their occurrences in logs (expect 0).
//   RK_M2B_MODEL  model to switch on (default: smallest advertised, qwen2.5:3b if present)
import { launch, login, api, sql, shot, sleep, waitFor, BASE, OUT, API_CONTAINER, QA_EMAIL, QA2_EMAIL, q } from '../m2a/lib.mjs';
import { spawnSync, execFileSync } from 'node:child_process';
import fs from 'node:fs';
const T = '/tmp/rk-m2c-e2e';
const SVC = 'rakijazios-runner-e2e-m2c';
const results = {}; const secrets = []; let failures = 0;
const ok = (k, v, pass = true) => { results[k] = { v, pass }; if (!pass) failures++; console.log(pass ? 'CHECK' : 'FAIL ', k, JSON.stringify(v)); };
const eq = (k, v, want) => ok(k, v, v === want);
fs.rmSync(T, { recursive: true, force: true }); fs.mkdirSync(T + '/home', { recursive: true, mode: 0o700 });
const startedAt = new Date().toISOString();
const env = () => { const e = { ...process.env, HOME: T + '/home', RAKAZO_RUNNER_CONFIG_DIR: T + '/cfg', RAKAZO_RUNNER_SERVICE: SVC }; delete e.XDG_CONFIG_HOME; return e; };
const runnerPids = () => { try { return execFileSync('pgrep', ['-f', 'rk-m2c-e2e/home/.local/share/rakijazios-runner/app/src/index.ts']).toString().trim().split('\n').filter(Boolean); } catch { return []; } };
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

  // ---------- grants UI (owner) ----------
  const g0 = await api(page, `/api/local-runners/groups/${GROUP}/grants`);
  ok('grantsListed', g0.body, g0.status === 200 && g0.body.shared === true && g0.body.bots.some((b) => b.botId === BOT && !b.granted));
  const denied = await send('Reply with just the word OK.');
  ok('noGrantRefused', denied, denied.status === 'failed' && /isn't enabled for this shared group/.test(denied.error));
  // Grant through the Share dialog overlay.
  await page.goto(BASE + '/app', { waitUntil: 'networkidle2' });
  await page.waitForSelector('#rk-invite-share', { timeout: 15000 }).catch(() => null);
  const opened = !!(await page.$('#rk-invite-share'));
  if (opened) await page.click('#rk-invite-share');
  let uiGrant = false;
  if (opened) {
    await sleep(1500);
    await page.waitForFunction(() => [...document.querySelectorAll('[data-rk-group-sharing] button')].some((b) => b.textContent === 'Manage sharing'), { timeout: 10000 }).catch(() => null);
    const manage = await page.evaluateHandle(() => [...document.querySelectorAll('[data-rk-group-sharing] .rk-group-row')].find((r) => /QA Group/.test(r.textContent))?.querySelector('button:last-of-type'));
    if (manage && (await manage.evaluate((b) => !!b))) {
      await manage.click(); await page.waitForSelector(`[data-rk-grant="${BOT}"] button`, { timeout: 10000 }).catch(() => null);
      await shot(page, 'm2c-01-share-dialog');
      const b = await page.$(`[data-rk-grant="${BOT}"] button`);
      if (b) { await b.click(); uiGrant = !!(await waitFor(() => sql(`select count(*) from local_runner_grants where bot_id='${BOT}' and group_id='${GROUP}'`) === '1' || null, 8000, 300)); await shot(page, 'm2c-02-granted'); }
      if (uiGrant) {
        const warn = () => page.$eval('[data-rk-grant-warning]', (n) => (n.hidden ? '' : n.textContent)).catch(() => null);
        const whenOn = await warn();
        await b.click();
        const whenOff = await waitFor(async () => { const w = await warn(); return w && w.includes('QA Tester Bot') ? w : null; }, 5000, 200);
        await shot(page, 'm2c-03-warning-after-off');
        await b.click();
        await waitFor(() => sql(`select count(*) from local_runner_grants where bot_id='${BOT}' and group_id='${GROUP}'`) === '1' || null, 8000, 300);
        const backOn = await warn();
        ok('warningUpdatesOnToggle', { whenOn, whenOff, backOn }, whenOn === '' && !!whenOff && backOn === '');
      }
    }
  }
  if (!uiGrant) await api(page, `/api/local-runners/groups/${GROUP}/grants`, { method: 'POST', body: JSON.stringify({ botId: BOT, allowed: true }) });
  eq('grantViaShareDialog', uiGrant, true);
  ok('shareDialogDisclosure', await page.$eval(`[data-rk-grant="${BOT}"]`, (n) => n.textContent).catch(() => null), true);
  eq('grantRow', sql(`select owner_user_id='${qaId}' from local_runner_grants where bot_id='${BOT}' and group_id='${GROUP}'`), 't');
  const allowed = await send('Reply with just the word OK.');
  ok('grantedGroupAnswers', allowed, allowed.status === 'completed');

  // ---------- revoke mid-answer ----------
  // The model sometimes answers briefly; retry until a long answer is actually cut off.
  let revoke = null, midRun = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    await api(page, `/api/local-runners/groups/${GROUP}/grants`, { method: 'POST', body: JSON.stringify({ botId: BOT, allowed: true }) });
    const long = await send('Write a very long, detailed 2000-word story about a lighthouse keeper. Do not summarize.', false);
    await waitFor(() => sql(`select count(*) from runs where "botId"='${BOT}' and "createdAt" > '${long.since}' and status='running'`) === '1' || null, 60000, 200);
    // Revoke the moment tokens start arriving on the throwaway computer (no fixed delay).
    const streaming = await waitFor(async () => {
      const d = (await api(page, '/api/local-runners/devices')).body?.devices?.find((x) => x.id === created.devId);
      return d?.health?.streaming > 0 || null;
    }, 90000, 100);
    if (!streaming) console.log(`attempt ${attempt}: answer never started streaming`);
    revoke = await api(page, `/api/local-runners/groups/${GROUP}/grants`, { method: 'POST', body: JSON.stringify({ botId: BOT, allowed: false }) });
    midRun = await finished(long.since);
    if (revoke.body?.cancelled > 0) break;
  }
  ok('revokeMidAnswerStops', { cancelled: revoke.body?.cancelled, run: midRun }, revoke.status === 200 && revoke.body.cancelled > 0 && midRun.status === 'failed' && /isn't enabled for this shared group/.test(midRun.error));
  const after = await send('Reply with just the word OK.');
  ok('afterRevokeRefused', after, after.status === 'failed' && /isn't enabled for this shared group/.test(after.error));
  const priv = await api(page, '/rpc/threads/send', { method: 'POST', body: JSON.stringify({ json: { botId: BOT, text: 'Reply with just the word OK.', clientNonce: `m2c-p-${Date.now()}` } }) }, spaceId);
  eq('privateStillOk', priv.status, 200);
  await sleep(4000);

  // ---------- members: badge; never device names; no grant power ----------
  const page2 = await (await launch('qa2-m2c')).newPage();
  await login(page2, QA2_EMAIL); await page2.goto(BASE + '/app', { waitUntil: 'networkidle2' });
  const runsOn = await api(page2, `/api/local-runners/groups/${GROUP}/runs-on`);
  const devName = sql(`select name from local_runner_devices where id='${devId}'`);
  const mine = runsOn.body?.bots?.find((b) => b.botId === BOT);
  ok('memberSeesRunsOn', mine, runsOn.status === 200 && /computer$/.test(mine?.runsOn || '') && mine.enabledHere === false && !JSON.stringify(runsOn.body).includes(devName) && !JSON.stringify(runsOn.body).includes(devId));
  eq('memberCannotListGrants', (await api(page2, `/api/local-runners/groups/${GROUP}/grants`)).status, 404);
  eq('memberCannotGrant', (await api(page2, `/api/local-runners/groups/${GROUP}/grants`, { method: 'POST', body: JSON.stringify({ botId: BOT, allowed: true }) })).status, 404);
  eq('grantStillOff', sql(`select count(*) from local_runner_grants where bot_id='${BOT}'`), '0');
  const qa2Group = sql(`select id from chat_groups where "userId"=(select id from "user" where email='${q(QA2_EMAIL)}') limit 1`);
  if (qa2Group) eq('strangerRunsOn404', (await api(page, `/api/local-runners/groups/${qa2Group}/runs-on`)).status, sql(`select count(*) from group_shares where group_id='${qa2Group}' and user_id='${qaId}'`) === '0' ? 404 : 200);
  await page2.browser().close();
  eq('anonRunsOn401', (await fetch(`${BASE}/api/local-runners/groups/${GROUP}/runs-on`)).status, 401);
} finally {
  stopRunner();
  const [p, m] = original.split('|');
  sql(`update bots set "modelProvider"=${p ? `'${q(p)}'` : 'null'}, "modelId"=${m ? `'${q(m)}'` : 'null'} where id='${BOT}'`);
  sql(`delete from local_runner_grants where bot_id='${BOT}'`);
  sql(`delete from local_runner_bot_bindings where bot_id='${BOT}'`);
  cleanupDb();
  const left = new Set(sql(`select id from local_runner_devices where user_id='${qaId}'`).split('\n').filter(Boolean));
  ok('otherDevicesUntouched', { before: devicesBefore.size, oursGone: !created.devId || !left.has(created.devId) }, [...devicesBefore].every((id) => left.has(id)) && (!created.devId || !left.has(created.devId)));
  await browser.close();
  const logs = ['api', 'worker'].map((s) => spawnSync('docker', ['logs', '--since', startedAt, `rakazo-${s}-1`], { encoding: 'utf8', maxBuffer: 1 << 28 })).map((x) => x.stdout + x.stderr).join('\n')
    + (fs.existsSync(T + '/cfg/runner.log') ? fs.readFileSync(T + '/cfg/runner.log', 'utf8') : '');
  const leaks = secrets.filter(Boolean).reduce((n, s) => n + logs.split(s).length - 1, 0) + (logs.match(/sl2\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.\d+\.[A-Za-z0-9_-]{20,}/g) || []).length;
  eq('secretsInLogs', leaks, 0);
  fs.writeFileSync(`${OUT}/m2c-results.json`, JSON.stringify(results, null, 2));
  fs.rmSync(T, { recursive: true, force: true });
  console.log(failures ? `FAILED ${failures}` : 'ALL PASSED');
  process.exit(failures ? 1 : 0);
}
