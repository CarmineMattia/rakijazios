// e2e/m2a/lock.mjs: scripts on one stack run one at a time; a dead holder's lock is taken over.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const lockUrl = pathToFileURL(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'e2e', 'm2a', 'lock.mjs')).href;
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'rk-lock-'));

function holder(lock, log, name, holdMs) {
  const code = `const { acquireE2ELock } = await import(${JSON.stringify(lockUrl)});
    const fs = await import('node:fs');
    await acquireE2ELock(${JSON.stringify(lock)}, { pollMs: 50, log: () => {} });
    fs.appendFileSync(${JSON.stringify(log)}, 'start ${name}\\n');
    await new Promise((r) => setTimeout(r, ${holdMs}));
    fs.appendFileSync(${JSON.stringify(log)}, 'end ${name}\\n');`;
  return new Promise((resolve, reject) => {
    const c = spawn(process.execPath, ['--input-type=module', '-e', code], { stdio: 'inherit' });
    c.on('exit', (status) => (status === 0 ? resolve() : reject(new Error(`${name} exit ${status}`))));
  });
}

test('two scripts never overlap', async () => {
  const dir = tmp(); const lock = path.join(dir, 'l'); const log = path.join(dir, 'log');
  await Promise.all([holder(lock, log, 'a', 400), holder(lock, log, 'b', 400), holder(lock, log, 'c', 400)]);
  const lines = fs.readFileSync(log, 'utf8').trim().split('\n');
  assert.equal(lines.length, 6);
  for (let i = 0; i < 6; i += 2) {
    assert.match(lines[i], /^start /);
    assert.equal(lines[i + 1], lines[i].replace('start', 'end'));
  }
  assert.equal(fs.existsSync(lock), false, 'released on exit');
});

test('a lock left by a dead process is taken over', async () => {
  const { acquireE2ELock } = await import(lockUrl);
  const dir = tmp(); const lock = path.join(dir, 'l');
  const dead = spawn(process.execPath, ['-e', '0']);
  await new Promise((r) => dead.on('exit', r));
  fs.writeFileSync(lock, JSON.stringify({ pid: dead.pid, script: 'gone.mjs', at: new Date().toISOString() }));
  const release = await acquireE2ELock(lock, { waitMs: 2000, pollMs: 20, log: () => {} });
  assert.equal(JSON.parse(fs.readFileSync(lock, 'utf8')).pid, process.pid);
  release();
  assert.equal(fs.existsSync(lock), false);
});

test('gives up with a clear error when a live holder keeps it', async () => {
  const { acquireE2ELock } = await import(lockUrl);
  const dir = tmp(); const lock = path.join(dir, 'l');
  const live = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 5000)']);
  try {
    fs.writeFileSync(lock, JSON.stringify({ pid: live.pid, script: 'other.mjs', at: 'now' }));
    await assert.rejects(acquireE2ELock(lock, { waitMs: 200, pollMs: 20, log: () => {} }), /held by pid \d+ \(other\.mjs\)/);
    assert.equal(JSON.parse(fs.readFileSync(lock, 'utf8')).script, 'other.mjs', 'live holder untouched');
  } finally { live.kill(); }
});

test('"off" disables the lock', async () => {
  const { acquireE2ELock } = await import(lockUrl);
  const release = await acquireE2ELock('off');
  assert.equal(typeof release, 'function');
});
