import { spawn } from 'node:child_process';
import { readdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { processIdentity } from './process-runner.mjs';

const spec = JSON.parse(process.argv[2]);
const receipt = { command: spec.command, args: spec.args, supervisor: processIdentity(), parent: spec.parent,
  startedAt: new Date().toISOString(), reason: 'running', cleaned: false, status: null, signal: null };
function save() { writeFileSync(`${spec.report}.pending`, JSON.stringify(receipt)); renameSync(`${spec.report}.pending`, spec.report); }
const child = spawn(spec.command, spec.args, { stdio: 'inherit', detached: true });
receipt.pid = child.pid;
try { receipt.identity = processIdentity(child.pid); } catch { /* spawn error is retained below */ }
save();
let ended = false, terminating = false, killAt = 0, cleanupDeadline;
function members() {
  // A group can contain zombies already reaped by another parent; those cannot run.
  return readdirSync('/proc').filter(n => /^\d+$/.test(n)).flatMap(n => {
    try {
      const raw = readFileSync(`/proc/${n}/stat`, 'utf8'), f = raw.slice(raw.lastIndexOf(')') + 2).split(' ');
      return Number(f[2]) === child.pid && f[0] !== 'Z' ? [{ pid: Number(n), start: f[19] }] : [];
    } catch (error) { if (['ENOENT', 'ESRCH'].includes(error.code)) return []; throw error; }
  });
}
function signalGroup(signal) { if (!child.pid) return; try { process.kill(-child.pid, signal); } catch (e) { if (e.code !== 'ESRCH') receipt.cleanupError = e.code; } }
function terminate(reason) {
  if (terminating) return;
  terminating = true; receipt.reason = reason; killAt = Date.now() + 250; cleanupDeadline = Date.now() + 5000;
  signalGroup('SIGTERM'); save();
}
for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.on(signal, () => terminate(signal));
child.on('error', error => { receipt.processError = error.code; receipt.reason = 'spawn-error'; ended = true; });
child.on('exit', (code, signal) => { receipt.status = code; receipt.signal = signal; ended = true; if (!terminating) receipt.reason = 'exited'; });
const tick = setInterval(() => {
  try {
    if (Date.now() >= spec.deadline) terminate('deadline');
    try { if (JSON.stringify(processIdentity(spec.parent.pid)) !== JSON.stringify(spec.parent)) terminate('parent-changed'); }
    catch { terminate('parent-absent'); }
    if (terminating && Date.now() >= killAt) signalGroup('SIGKILL');
    const live = child.pid ? members() : [];
    // Successful parent exit is insufficient: wait for or terminate its descendants.
    if (ended && live.length && !terminating) terminate('descendants-after-exit');
    if (ended && live.length === 0) {
      receipt.cleaned = !receipt.cleanupError; receipt.finishedAt = new Date().toISOString(); save(); clearInterval(tick);
      process.exitCode = receipt.cleaned && receipt.reason === 'exited' && receipt.status === 0 ? 0 : 1;
    } else if (terminating && Date.now() >= cleanupDeadline) {
      receipt.remaining = live; receipt.cleaned = false; save(); clearInterval(tick); process.exit(1);
    }
  } catch (error) { receipt.cleanupError = error.code ?? 'unknown'; terminate('ownership-uncertain'); }
}, 25);
