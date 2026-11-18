import { spawnSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export function processIdentity(pid = process.pid) {
  const raw = readFileSync(`/proc/${pid}/stat`, 'utf8');
  const fields = raw.slice(raw.lastIndexOf(')') + 2).split(' ');
  return { pid, start: fields[19], boot: readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim() };
}
// A separate event-loop supervisor owns the process group while the API caller
// waits synchronously. It also cleans up if the controller disappears abruptly.
export function supervisedRun(command, args, options) {
  const { deadline, processReport, ...opts } = options;
  try {
    const result = spawnSync(process.execPath, [fileURLToPath(new URL('./process-supervisor.mjs', import.meta.url)),
      JSON.stringify({ command, args, deadline, report: processReport, parent: processIdentity() })], opts);
    let supervision;
    if (existsSync(processReport)) supervision = JSON.parse(readFileSync(processReport, 'utf8'));
    return { ...result, status: supervision?.status ?? result.status, signal: supervision?.signal ?? result.signal,
      error: result.error ?? (supervision?.reason !== 'exited' ? new Error('Build process interrupted') : undefined),
      supervision, ownershipUncertain: !supervision?.cleaned };
  } catch (error) {
    return { status: null, error, ownershipUncertain: true };
  }
}
