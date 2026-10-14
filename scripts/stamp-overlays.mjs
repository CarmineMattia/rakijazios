#!/usr/bin/env node
// Stamp content-hash ?v= tags on the overlay/patch <script> tags in index.html, so a deploy
// changes the URL of every overlay whose content changed (browser and service worker fetch it fresh).
//   node scripts/stamp-overlays.mjs [distDir]      default: patches/web/dist
// Run after changing any overlay and before/at deploy; idempotent. Only same-origin, top-level *.js
// scripts are stamped (hashed /assets/* already carry a hash in the file name).
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

const dist = resolve(process.argv[2] || 'patches/web/dist');
const indexPath = join(dist, 'index.html');
const html = readFileSync(indexPath, 'utf8');
const changes = [];
const out = html.replace(/(<script\b[^>]*\bsrc=")\/([\w.-]+\.js)(?:\?v=[^"]*)?(")/g, (all, pre, file, post) => {
  const path = join(dist, file);
  if (!existsSync(path)) { console.warn(`stamp-overlays: ${file} not found, left as is`); return all; }
  const v = createHash('sha256').update(readFileSync(path)).digest('hex').slice(0, 10);
  changes.push(`${file}?v=${v}`);
  return `${pre}/${file}?v=${v}${post}`;
});
if (out !== html) writeFileSync(indexPath, out);
console.log(`stamp-overlays: ${changes.length} scripts${out === html ? ' (unchanged)' : ''}`);
for (const c of changes) console.log('  ' + c);
