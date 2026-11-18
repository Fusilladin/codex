#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export function checkWorkflow(path, { release = false } = {}) {
  const source = readFileSync(path, 'utf8');
  // The installed PyYAML is the only parser; no new packages are introduced.
  const parsed = spawnSync('python3', ['-c', 'import sys,json,yaml; d=yaml.safe_load(sys.stdin.read()); d["on"]=d.pop(True,d.get("on")); print(json.dumps(d))'], { input: source, encoding: 'utf8' });
  if (parsed.error || parsed.status !== 0) throw new Error('Invalid workflow YAML');
  const w = JSON.parse(parsed.stdout);
  const assert = (condition, reason) => { if (!condition) throw new Error(reason); };
  const readOnly = p => p && typeof p === 'object' && Object.entries(p).every(([k, v]) => v === 'read' && k === 'contents');
  assert(!w.env && !w.defaults, 'Workflow environment/default injection refused');
  assert(w && readOnly(w.permissions), 'Read-only explicit default permissions required');
  const events = typeof w.on === 'string' ? [w.on] : Object.keys(w.on ?? {});
  assert(events.length && events.every(e => ['push', 'schedule', 'workflow_dispatch'].includes(e)), 'Unsafe workflow event');
  if (events.includes('push')) assert(JSON.stringify(w.on.push?.branches) === '["fork"]', 'Push must target fork only');
  assert(w.concurrency?.['cancel-in-progress'] === false && w.concurrency.group, 'Non-cancelling concurrency required');
  assert(w.jobs && Object.keys(w.jobs).length, 'Jobs required');
  for (const job of Object.values(w.jobs)) {
    assert(Number.isInteger(job['timeout-minutes']) && job['timeout-minutes'] > 0 && job['timeout-minutes'] <= 360, 'Bounded timeout required');
    assert(job['runs-on'] === 'ubuntu-24.04', 'Trusted hosted runner required');
    assert(!('continue-on-error' in job) || job['continue-on-error'] === false, 'Validation failures may not be ignored');
    assert(!job.env && !job.defaults && !job.container && !job.services, 'Job execution injection refused');
    const permissions = job.permissions;
    assert(permissions && typeof permissions === 'object' && Object.entries(permissions).every(([k, v]) => ['contents', 'pull-requests', 'id-token', 'attestations'].includes(k) && ['read', 'write'].includes(v)), 'Explicit supported job permissions required');
    const writer = Object.values(permissions).includes('write');
    assert(!writer || (job.needs === 'validate' && !job.if && ['p85-reviewed-candidate', 'p85-reviewed-draft'].includes(job.environment)), 'Writer requires successful validation and owner environment');
    if (!writer) assert(job.if === "github.ref == 'refs/heads/fork'", 'Validation must run from fork branch only');
    assert(Array.isArray(job.steps) && job.steps.length, 'Steps required');
    for (const step of job.steps) {
      assert(!('continue-on-error' in step) || step['continue-on-error'] === false, 'Step failures may not be ignored');
      assert(!/\bsecrets\s*(?:\.|\[)/.test(JSON.stringify(step)), 'Secret injection refused');
      if (step.uses) {
        assert(/^actions\/[a-z0-9-]+@(?:[a-f0-9]{40}|<SHA-TO-PIN>)$/.test(step.uses), 'SHA-pinned allowed action required');
        assert(!release || !step.uses.endsWith('@<SHA-TO-PIN>'), 'Release action pin unresolved');
        if (step.uses.startsWith('actions/checkout@')) assert(step.with?.['persist-credentials'] === false, 'Checkout must not persist credentials');
      }
      if (writer) {
        assert(!step.env && !step.if, 'Writer environment/condition injection refused');
        assert(!step.run && step.uses && ['actions/github-script@', 'actions/download-artifact@', 'actions/attest-build-provenance@'].some(action => step.uses.startsWith(action)), 'Writer may not execute checked-out code');
        // Until reviewed owner transport exists, the only allowed privileged body
        // is this fail-closed literal. General JS string matching is not a sandbox.
        if (step.uses.startsWith('actions/github-script@')) { assert(JSON.stringify(Object.keys(step.with ?? {})) === '["script"]', 'Fixed writer inputs required'); assert(/^core\.setFailed\('[A-Za-z0-9 .,\-]+'\);\s*$/.test(step.with?.script ?? ''), 'Unreviewed writer script refused'); }
        else if (step.uses.startsWith('actions/download-artifact@')) assert(JSON.stringify(step.with) === JSON.stringify({ name: 'fork-release', path: 'verified' }), 'Fixed same-run release artifact required');
        else assert(JSON.stringify(step.with) === JSON.stringify({ 'subject-path': 'verified/*.tar.gz' }) && permissions['id-token'] === 'write' && permissions.attestations === 'write' && permissions.contents === 'read' && !permissions['pull-requests'], 'Data-only attestation permissions required');
      }
      assert(!JSON.stringify(step).includes('${{ github.event.'), 'Untrusted event interpolation refused');
    }
  }
  return { state: 'policy-pass', mode: release ? 'release' : 'draft' };
}
if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2), release = args.includes('--release');
    const paths = args.filter(a => !['--draft', '--release'].includes(a));
    if (!paths.length) throw new Error('Workflow paths required');
    for (const path of paths) checkWorkflow(path, { release });
    console.log(JSON.stringify({ state: 'policy-pass', mode: release ? 'release' : 'draft', files: paths.length }));
  } catch (error) { console.error(error.message); process.exitCode = 64; }
}
