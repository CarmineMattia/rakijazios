// Reliability: group members see whether a bot's computer is online, reconnecting or offline,
// and whether its model server answers, without device names or hosts (synthetic data only).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
const { JSDOM } = createRequire(import.meta.url)(process.env.RAKAZO_JSDOM_PATH || 'jsdom');
const script = readFileSync(new URL('../patches/web/dist/group-sharing-overlay.js', import.meta.url), 'utf8');
const response = (data, status = 200) => ({ ok: status === 200, status, json: async () => data });
async function until(predicate) { for (let n = 0; n < 100; n++) { if (predicate()) return; await new Promise((r) => setTimeout(r, 10)); } assert.fail('UI did not reach expected state'); }

test('runs-on badge shows reconnecting, offline and model server state', async () => {
  const dom = new JSDOM('<div id="rk-invite-root" class="rk-open"><div class="rk-card"></div></div>', { url: 'http://localhost:5173/app/test', runScripts: 'outside-only' });
  const observers = [], Observer = dom.window.MutationObserver;
  dom.window.MutationObserver = class extends Observer { constructor(cb) { super(cb); observers.push(this); } };
  const runsOn = { bots: [
    { botId: 'a', name: 'Alpha', runsOn: "Ann's computer", online: false, state: 'reconnecting', modelServerOk: null, enabledHere: true },
    { botId: 'b', name: 'Beta', runsOn: "Ann's computer", online: true, state: 'online', modelServerOk: false, enabledHere: true },
    { botId: 'c', name: 'Gamma', runsOn: "Bob's computer", online: false, state: 'offline', modelServerOk: null, enabledHere: true },
    { botId: 'd', name: 'Delta', runsOn: "Bob's computer", online: true, state: 'online', modelServerOk: true, enabledHere: true },
  ] };
  dom.window.fetch = (path) => {
    if (path.includes('/runs-on')) return Promise.resolve(response(runsOn));
    if (path.startsWith('/api/local-runners/groups/')) return Promise.resolve(response({ bots: [] }));
    if (path.endsWith('/groups')) return Promise.resolve(response({ groups: [{ id: 'g', name: 'Team', owned: false, bots: ['Alpha'] }] }));
    return Promise.resolve(response({ name: 'Team', messages: [], active: [] }));
  };
  dom.window.eval(script);
  const doc = dom.window.document;
  try {
    await until(() => [...doc.querySelectorAll('button')].some((b) => b.textContent === 'Open'));
    [...doc.querySelectorAll('button')].find((b) => b.textContent === 'Open').click();
    await until(() => doc.querySelector('[data-rk-runs-on]'));
    const text = doc.querySelector('[data-rk-runs-on]').textContent;
    assert.match(text, /Alpha runs on Ann's computer \(reconnecting\)/);
    assert.match(text, /Beta runs on Ann's computer \(model server not answering\)/);
    assert.match(text, /Gamma runs on Bob's computer \(offline\)/);
    assert.match(text, /Delta runs on Bob's computer( ·|$)/);
  } finally {
    observers.forEach((o) => o.disconnect()); dom.window.close(); await Promise.resolve();
  }
});
