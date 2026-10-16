#!/usr/bin/env node
// M3b(c) e2e: usage retention folds old raw rows into daily totals; the usage API (chart + people) is unchanged.
// Uses synthetic rows owned by the qa account on a fake device id; aborts if a sweep would touch anyone else.
import { execFileSync } from 'node:child_process';
import { writeFileSync, mkdirSync } from 'node:fs';
import { launch, login, api, sql, BASE, OUT, QA_EMAIL, QA2_EMAIL, q } from '../m2a/lib.mjs';

const results = []; let failed = 0;
const ok = (name, got, pass) => { results.push({ name, pass: !!pass, got }); if (!pass) failed++; console.log(`${pass ? 'PASS' : 'FAIL'} ${name} ${JSON.stringify(got)}`); };
const retention = (...args) => JSON.parse(execFileSync('sh', [new URL('../../scripts/usage-retention.sh', import.meta.url).pathname, ...args]).toString().trim().split('\n').pop());

const qaId = sql(`select id from "user" where email='${q(QA_EMAIL)}'`);
const qa2Id = sql(`select id from "user" where email='${q(QA2_EMAIL)}'`);
const DEV = `e2e-retention-${Date.now()}`;
const cleanup = () => { sql(`delete from local_runner_usage where device_id='${DEV}'`); sql(`delete from local_runner_usage_daily where device_id='${DEV}'`); };
let browser;
try {
  // Safety: a 30-day sweep must only touch qa data.
  const pre = retention('30');
  const others = pre.dryRun.byOwner.filter((r) => r.owner_user_id !== qaId);
  if (others.length) { console.log('ABORT: 30-day sweep would touch non-qa owners', others); process.exit(2); }
  const ins = (daysAgo, consumer, status, inp, out, n = 1) => {
    for (let i = 0; i < n; i++) sql(`insert into local_runner_usage (id, device_id, owner_user_id, consumer_user_id, status, input_tokens, output_tokens, duration_ms, created_at)
      values ('${DEV}-${daysAgo}-${status}-${i}-${Math.random().toString(36).slice(2)}', '${DEV}', '${qaId}', ${consumer ? `'${consumer}'` : 'null'}, '${status}', ${inp}, ${out}, 100, date_trunc('day', now()) - interval '${daysAgo} days' + interval '3 hours')`);
  };
  ins(40, qaId, 'ok', 10, 20, 2); ins(40, qa2Id, 'ok', 5, 7); ins(40, qa2Id, 'refused_daily_cap', 0, 0); ins(40, null, 'error', 1, 0);
  ins(41, qa2Id, 'ok', 3, 4);
  ins(20, qa2Id, 'ok', 2, 2);
  browser = await launch('qa-m3c');
  const page = await browser.newPage();
  await login(page, QA_EMAIL); await page.goto(BASE + '/app', { waitUntil: 'networkidle2' });
  const usage = async () => {
    const r = await api(page, '/api/local-runners/usage?days=90');
    return { status: r.status, daily: r.body.daily.filter((d) => d.deviceId === DEV), people: r.body.people };
  };
  const before = await usage();
  ok('usageBefore', before.daily, before.status === 200 && before.daily.length === 3);
  const dry = retention('30');
  ok('dryRunCountsOnlyQa', dry.dryRun, dry.dryRun.byOwner.every((r) => r.owner_user_id === qaId) && dry.dryRun.total >= 6);
  ok('dryRunDeletesNothing', sql(`select count(*) from local_runner_usage where device_id='${DEV}'`), sql(`select count(*) from local_runner_usage where device_id='${DEV}'`) === '7');
  const applied = retention('30', '--apply');
  ok('applied', applied, applied.applied.folded >= 6);
  ok('oldRawRowsGone', sql(`select count(*) from local_runner_usage where device_id='${DEV}'`), sql(`select count(*) from local_runner_usage where device_id='${DEV}'`) === '1');
  ok('rollupRows', sql(`select string_agg(day||':'||coalesce(nullif(consumer_user_id,''),'-')||':'||status||':'||requests||':'||input_tokens||':'||output_tokens, ' ' order by 1) from local_runner_usage_daily where device_id='${DEV}'`),
    sql(`select sum(requests) from local_runner_usage_daily where device_id='${DEV}'`) === '6');
  const after = await usage();
  ok('chartUnchanged', after.daily, JSON.stringify(after.daily) === JSON.stringify(before.daily));
  ok('peopleUnchanged', after.people, JSON.stringify(after.people) === JSON.stringify(before.people));
  const again = retention('30', '--apply');
  ok('idempotent', again.applied, again.applied.folded === 0);
  ok('stillUnchanged', null, JSON.stringify((await usage()).daily) === JSON.stringify(before.daily));
  ok('defaultIs90', retention().days, retention().days === 90);
  ok('apiLogClean', null, !/usage retention sweep failed/.test(execFileSync('docker', ['logs', '--since', '10m', 'rakazo-api-1'], { stdio: ['ignore', 'pipe', 'pipe'] }).toString()));
} finally {
  cleanup();
  await browser?.close();
  mkdirSync(OUT, { recursive: true });
  writeFileSync(`${OUT}/m3b-retention-results.json`, JSON.stringify(results, null, 2));
}
console.log(failed ? `${failed} FAILED` : 'ALL PASSED');
process.exit(failed ? 1 : 0);
