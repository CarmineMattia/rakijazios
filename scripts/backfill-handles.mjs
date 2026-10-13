// Give a unique @handle to accounts that have none (empty user.name), same rule as sign-up:
// email local part → [a-z0-9_], 3–24 chars, first free of base, base_2 … (case-insensitive).
// Only fills EMPTY names; never changes an existing one. Dry run by default.
//   node scripts/backfill-handles.mjs                       list what it would change
//   node scripts/backfill-handles.mjs --apply --domain rakazo.test   change only @rakazo.test
//   RK_PG=rakazo-postgres-1 (container)   RK_PGUSER=rakazo   RK_PGDB=rakazo
import { execFileSync } from 'node:child_process';
const args = process.argv.slice(2);
const apply = args.includes('--apply');
const domain = args.includes('--domain') ? args[args.indexOf('--domain') + 1] : null;
const PG = process.env.RK_PG || 'rakazo-postgres-1';
const sql = (q) => execFileSync('docker', ['exec', '-i', PG, 'psql', '-U', process.env.RK_PGUSER || 'rakazo', '-d', process.env.RK_PGDB || 'rakazo', '-At', '-F', '\t', '-v', 'ON_ERROR_STOP=1', '-c', q]).toString().trim();
const lit = (s) => `'${String(s).replace(/'/g, "''")}'`;

export function handleFromEmail(email) {
  const local = String(email ?? '').split('@')[0].split('+')[0];
  let base = local.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9_]+/g, '_').replace(/_+/g, '_').replace(/^_+|_+$/g, '').slice(0, 24);
  if (base.length < 3) base = `user${base ? `_${base}` : ''}`;
  return base;
}

const rows = sql(`select id, email from "user" where coalesce(trim(name), '') = '' and email not ilike '%@messaging.invalid' order by "createdAt"`).split('\n').filter(Boolean).map((l) => { const [id, email] = l.split('\t'); return { id, email }; });
const used = new Set(sql(`select lower(name) from "user" where coalesce(trim(name), '') <> ''`).split('\n').filter(Boolean));
const plan = [];
for (const r of rows) {
  const base = handleFromEmail(r.email);
  // Same rule as sign-up: base, base_2 … base_99, then a random suffix.
  let h = base;
  for (let n = 2; used.has(h) && n < 100; n++) h = base.slice(0, 24 - `_${n}`.length) + `_${n}`;
  while (used.has(h)) { const sfx = `_${Math.random().toString(36).slice(2, 8)}`; h = base.slice(0, 24 - sfx.length) + sfx; }
  used.add(h);
  const inScope = !domain || r.email.toLowerCase().endsWith('@' + domain.toLowerCase());
  plan.push({ ...r, handle: h, inScope });
}
for (const p of plan) console.log(`${p.inScope ? (apply ? 'SET ' : 'WOULD') : 'SKIP '}  ${p.email}  →  ${p.handle}`);
if (!apply) { console.log(`dry run: ${plan.length} account(s) without a handle`); process.exit(0); }
let changed = 0;
for (const p of plan.filter((x) => x.inScope)) {
  // Re-check emptiness in the UPDATE itself: never overwrite a name set meanwhile.
  const n = sql(`with u as (update "user" set name = ${lit(p.handle)}, "updatedAt" = now() where id = ${lit(p.id)} and coalesce(trim(name), '') = '' returning 1) select count(*) from u`);
  changed += Number(n) || 0;
}
console.log(`updated ${changed} account(s)`);
