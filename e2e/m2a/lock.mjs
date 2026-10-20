// One e2e script at a time per stack. The scripts share the qa account's "QA Tester Bot", its
// binding and "QA Group" grants, so two scripts running together (two agents, two shells)
// rebind or delete each other's state mid-test (seen on 2026-10-20: 64 cleared 61's binding).
// The lock file holds {pid, script, at}; a lock whose pid is gone is stale and is taken over.
//   RK_E2E_LOCK          lock file (default /tmp/rk-e2e-qa.lock); "off" disables locking
//   RK_E2E_LOCK_WAIT_MS  how long to wait for another script (default 30 min)
import fs from 'node:fs';

const alive = (pid) => {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
};
const readHolder = (path) => { try { return JSON.parse(fs.readFileSync(path, 'utf8')); } catch { return null; } };

export async function acquireE2ELock(path, { waitMs = 30 * 60_000, pollMs = 2_000, log = console.log } = {}) {
  if (!path || path === 'off') return () => {};
  const deadline = Date.now() + waitMs;
  let announced = false;
  for (;;) {
    try {
      fs.writeFileSync(path, JSON.stringify({ pid: process.pid, script: process.argv[1] || '', at: new Date().toISOString() }), { flag: 'wx', mode: 0o644 });
      break;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      const holder = readHolder(path);
      if (!holder || !Number.isInteger(holder.pid) || !alive(holder.pid)) {
        // Stale (holder died) or half-written: remove only if it is still the same file content.
        const again = readHolder(path);
        if (JSON.stringify(again) === JSON.stringify(holder)) { try { fs.unlinkSync(path); } catch {} }
        continue;
      }
      if (holder.pid === process.pid) break;
      if (Date.now() > deadline) throw new Error(`e2e lock ${path} is held by pid ${holder.pid} (${holder.script}) since ${holder.at}`);
      if (!announced) { log(`waiting for e2e lock ${path}: pid ${holder.pid} (${holder.script}) since ${holder.at}`); announced = true; }
      await new Promise((r) => setTimeout(r, pollMs));
    }
  }
  const release = () => {
    const h = readHolder(path);
    if (h && h.pid === process.pid) { try { fs.unlinkSync(path); } catch {} }
  };
  process.once('exit', release);
  return release;
}
