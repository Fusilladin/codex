import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { checkWorkflow } from '../fork/lib/workflow-policy.mjs';
import { publicationIdentity, validatePublication } from '../fork/lib/release.mjs';
import { temp, manifest } from './helpers.mjs';

test('workflow policy validates read-only builds/data-only attestation and rejects execution/permission bypasses', t => {
  const root = temp(t), path = new URL('../.github/workflows/fork-check.yml', import.meta.url).pathname;
  const releasePath = new URL('../.github/workflows/fork-release.yml', import.meta.url).pathname;
  assert.equal(checkWorkflow(path).mode, 'draft'); assert.equal(checkWorkflow(releasePath).mode, 'draft');
  assert.equal(checkWorkflow(path, { release: true }).state, 'policy-pass'); assert.equal(checkWorkflow(releasePath, { release: true }).state, 'policy-pass');
  const source = readFileSync(path, 'utf8'), release = readFileSync(releasePath, 'utf8');
  const cases = [source.replace('workflow_dispatch:', 'pull_request_target:'), source.replace('contents: read', 'contents: write'), source.replace(/checkout@[0-9a-f]{40}/, 'checkout@v4'), source.replace('timeout-minutes: 180', 'timeout-minutes: 900'), source.replace('persist-credentials: false', 'persist-credentials: true'), release.replace('needs: validate', 'needs: validate\n    if: always()'), release.replace('environment: p85-reviewed-draft', 'environment: p85-reviewed-draft\n    env: {NODE_OPTIONS: "--import=verified/untrusted.mjs"}'), release.replace('subject-path: verified/*.tar.gz', 'subject-path: verified/*'), release.replace('attestations: write', 'attestations: read')];
  cases.push(source.replace('    timeout-minutes: 180', '    timeout-minutes: 180\n    continue-on-error: true'));
  cases.push(source.replace('      - name: Tests and workflow policy', '      - name: Tests and workflow policy\n        continue-on-error: true'));
  for (const [index, bad] of cases.entries()) { const dest = join(root, `${index}.yml`); writeFileSync(dest, bad); assert.throws(() => checkWorkflow(dest)); }
});

test('publication binds candidate, review, draft, artifact and fresh disposable VM identity', () => {
  const m = { ...manifest('1'.repeat(40)), production_ready: true, lockfile_sha256: '2'.repeat(64) };
  const identity = publicationIdentity({ manifest: m, commit: '3'.repeat(40), artifactHash: '4'.repeat(64), draftId: '5' });
  const evidence = { identity, candidate: { ...identity, state: 'validated' }, review: { ...identity, verdict: 'PASS' }, draft: { ...identity, draft: true }, artifact: { ...identity, verified: true }, vm: { ...identity, verdict: 'PASS', vm: 'permitted-fixture', at: new Date().toISOString(), steps: { fresh: 'PASS', update: 'PASS', rollback: 'PASS' } } };
  assert.deepEqual(validatePublication(evidence), identity);
  assert.throws(() => validatePublication({ ...evidence, identity: {} }), /Exact publication identity/);
  for (const key of ['candidate', 'review', 'draft', 'artifact', 'vm']) assert.throws(() => validatePublication({ ...evidence, [key]: { ...evidence[key], artifactHash: 'a'.repeat(64) } }));
  for (const vm of [{ ...evidence.vm, at: '2020-01-01T00:00:00Z' }, { ...evidence.vm, steps: { fresh: 'PASS' } }, { ...evidence.vm, vm: 'windows-11-ic' }]) assert.throws(() => validatePublication({ ...evidence, vm }));
});
