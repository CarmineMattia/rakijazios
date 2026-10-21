#!/usr/bin/env node
// Usage CSV export e2e: GET /api/local-runners/usage.csv is owner-scoped, honours the date range,
// includes retention rollups, and refuses bad ranges / no session.
// Synthetic rows only, on a fake *revoked* computer owned by the qa account; removed at the end.
import { launch, login, sql, BASE, QA_EMAIL, QA2_EMAIL, q } from '../m2a/lib.mjs';
let failed = 0;
const ok = (name, got, pass) => { if (!pass) failed++; console.log(`${pass ? 'PASS' : 'FAIL'} ${name} ${JSON.stringify(got)}`); };
const qaId = sql(`select id from "user" where email='${q(QA_EMAIL)}'`);
const qa2Id = sql(`select id from "user" where email='${q(QA2_EMAIL)}'`);
if (!qaId || !qa2Id) { console.log('ABORT: qa accounts missing'); process.exit(2); }
const S = Date.now();
const DEV = `e2e-csv-${S}`, NAME = `E2E CSV box ${S}`;
const day = (ago) => sql(`select to_char(date_trunc('day', now()) - interval '${ago} days', 'YYYY-MM-DD')`);
const cleanup = () => {
  sql(`delete from local_runner_usage where device_id='${DEV}'`);
  sql(`delete from local_runner_usage_daily where device_id='${DEV}'`);
  sql(`delete from local_runner_devices where id='${DEV}' and user_id='${qaId}'`);
};
const fetchCsv = (page, qs) => page.evaluate(async (u) => {
  const r = await fetch(u, { credentials: 'include' });
  return { status: r.status, type: r.headers.get('content-type'), disposition: r.headers.get('content-disposition'), text: await r.text() };
}, `/api/local-runners/usage.csv${qs}`);
const lines = (text) => text.replace(/^\ufeff/, '').split('\r\n').filter(Boolean);
let b1, b2;
try {
  sql(`insert into local_runner_devices (id, user_id, name, token_hash, status, enabled, revoked_at) values ('${DEV}', '${qaId}', '${NAME}', 'e2e-csv-${S}', 'revoked', false, now())`);
  let seq = 0;
  const ins = (ago, consumer, status, inp, out, n = 1) => {
    for (let i = 0; i < n; i++) sql(`insert into local_runner_usage (id, device_id, owner_user_id, consumer_user_id, model_id, status, input_tokens, output_tokens, duration_ms, created_at)
      values ('${DEV}-${seq++}', '${DEV}', '${qaId}', '${consumer}', 'e2e-model', '${status}', ${inp}, ${out}, 100, date_trunc('day', now()) - interval '${ago} days' + interval '3 hours')`);
  };
  ins(3, qaId, 'ok', 10, 20, 2); ins(3, qa2Id, 'ok', 5, 7); ins(3, qa2Id, 'refused_person_cap', 0, 0); ins(9, qa2Id, 'ok', 1, 1);
  sql(`insert into local_runner_usage_daily (day, device_id, owner_user_id, consumer_user_id, status, requests, input_tokens, output_tokens, duration_ms)
       values ((date_trunc('day', now()) - interval '40 days')::date, '${DEV}', '${qaId}', '${qa2Id}', 'ok', 6, 60, 120, 600)`);
  const qa2Name = sql(`select name from "user" where id='${qa2Id}'`);
  const d3 = day(3), d9 = day(9), d40 = day(40), d2 = day(2);

  b1 = await launch('qa-m2b'); const page = await b1.newPage(); await login(page, QA_EMAIL);
  await page.goto(BASE + '/app', { waitUntil: 'networkidle2' });
  const r = await fetchCsv(page, `?from=${d3}&to=${d2}`);
  ok('csvDownload', { status: r.status, type: r.type, disposition: r.disposition }, r.status === 200 && r.type === 'text/csv; charset=utf-8' && r.disposition === `attachment; filename="rakijazios-usage-${d3}_${d2}.csv"`);
  const L = lines(r.text);
  ok('header', L[0], L[0] === 'date,computer,person,person_type,model,status,requests,input_tokens,output_tokens,duration_ms');
  const ours = L.filter((l) => l.includes(NAME));
  const want = [`${d3},${NAME},You,you,e2e-model,ok,2,20,40,200`, `${d3},${NAME},${qa2Name},other,e2e-model,ok,1,5,7,100`, `${d3},${NAME},${qa2Name},other,e2e-model,refused_person_cap,1,0,0,100`];
  ok('rowsForRange', ours, JSON.stringify([...ours].sort()) === JSON.stringify([...want].sort()));
  ok('noIdsOrEmails', null, !r.text.includes(qaId) && !r.text.includes(qa2Id) && !/@rakazo\.test/.test(r.text));
  const outside = lines((await fetchCsv(page, `?from=${d9}&to=${d9}`)).text).filter((l) => l.includes(NAME));
  ok('singleDay', outside, outside.length === 1 && outside[0].startsWith(`${d9},${NAME},${qa2Name},other,e2e-model,ok,1,`));
  const rolled = lines((await fetchCsv(page, `?from=${d40}&to=${d40}`)).text).filter((l) => l.includes(NAME));
  ok('rollupIncluded', rolled, rolled.length === 1 && rolled[0] === `${d40},${NAME},${qa2Name},other,,ok,6,60,120,600`);
  const bad = await fetchCsv(page, `?from=${d2}&to=${d3}`);
  ok('reversedRange400', bad.status, bad.status === 400);
  const long = await fetchCsv(page, `?from=2020-01-01&to=${d2}`);
  ok('tooLongRange400', long.status, long.status === 400);

  b2 = await launch('qa2-m2b'); const page2 = await b2.newPage(); await login(page2, QA2_EMAIL);
  await page2.goto(BASE + '/app', { waitUntil: 'networkidle2' });
  const r2 = await fetchCsv(page2, `?from=${d40}&to=${d2}`);
  ok('otherOwnerExcluded', { status: r2.status, leaks: r2.text.includes(NAME) || r2.text.includes('e2e-model') }, r2.status === 200 && !r2.text.includes(NAME) && !r2.text.includes('e2e-model'));

  const anon = await fetch(`${BASE}/api/local-runners/usage.csv`);
  ok('noSession401', anon.status, anon.status === 401);
} catch (e) {
  failed++; console.log('ERROR', e?.message || e);
} finally {
  cleanup();
  const left = sql(`select (select count(*) from local_runner_usage where device_id='${DEV}') + (select count(*) from local_runner_usage_daily where device_id='${DEV}') + (select count(*) from local_runner_devices where id='${DEV}')`);
  ok('cleanedUp', Number(left), Number(left) === 0);
  await b1?.close(); await b2?.close();
}
console.log(failed ? `${failed} FAILED` : 'ALL PASSED');
process.exit(failed ? 1 : 0);
