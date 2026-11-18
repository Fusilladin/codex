import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { writeFileSync, symlinkSync, mkdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { latestStable } from '../fork/lib/upstream.mjs';
import { validateManifest, candidateKey, sha256 } from '../fork/lib/manifest.mjs';
import { checkRelease, rememberTag, withLock } from '../fork/lib/state.mjs';
import { temp, manifest, kit } from './helpers.mjs';
import { makeUpstream } from './support/make-upstream.mjs';

test('stable/no-new/new checks; strict prerelease/draft/alpha and no fallback', async t => {
  const root = temp(t);
  const fixture = await makeUpstream({ root });
  const m = manifest(fixture.commits.previous);
  const release = { tag: fixture.tags.stable, commit: fixture.commits.stable };
  assert.equal(checkRelease(m, m.upstream, root).state, 'up-to-date');
  assert.equal(checkRelease(m, release, root).state, 'new-release');
  assert.equal(candidateKey(m, release.commit), sha256(`codex|${release.commit}|${m.patchset_sha256}|${m.target}|${m.toolchain}`));
  const envelope = { release: { tag_name: release.tag, draft: false, prerelease: false }, commit: release.commit };
  const path = join(root, 'release.json');
  writeFileSync(path, JSON.stringify(envelope));
  assert.deepEqual(await latestStable({ fixture: path }), release);
  let calls = 0;
  await assert.rejects(latestStable({ fixture: join(root, 'missing'), fetch: () => { calls++; } }));
  assert.equal(calls, 0);
  for (const change of [{ draft: true }, { prerelease: true }, { tag_name: 'rust-v1.2.3-alpha.1' }]) {
    writeFileSync(path, JSON.stringify({ ...envelope, release: { ...envelope.release, ...change } }));
    await assert.rejects(latestStable({ fixture: path }), /stable/);
  }
  const injected = await latestStable({ fixture: '', fetch: async url => url.endsWith('/latest') ? envelope.release : { sha: release.commit } });
  assert.deepEqual(injected, release);
});

test('moved tags rejected against baseline and retained candidate identity', t => {
  const root = temp(t), m = manifest('1'.repeat(40));
  assert.throws(() => checkRelease(m, { tag: m.upstream.tag, commit: '2'.repeat(40) }, root), { code: 23 });
  rememberTag(root, { tag: 'rust-v0.169.0', commit: '3'.repeat(40) });
  assert.throws(() => checkRelease(m, { tag: 'rust-v0.169.0', commit: '4'.repeat(40) }, root), { code: 23 });
});

test('manifest rejects unsafe patch identity, bad hashes, unresolved commit and malformed inputs', () => {
  const m = manifest('1'.repeat(40));
  for (const changed of [
    { patches: [{ ...m.patches[0], file: '../escape.patch' }] },
    { patches: [m.patches[0], m.patches[0]] }, { patchset_sha256: '0'.repeat(64) },
    { upstream: { ...m.upstream, commit: 'short' } }, { schema: 2 },
    { fork_version: '1.2.3-p1' }, { target: '../target' }, { toolchain: 'floating' }, { lockfile_sha256: 'bad' },
  ]) assert.throws(() => validateManifest({ ...m, ...changed }), { code: 64 });
});

test('CLI executes through symlink, uses fixture only and rejects invalid arguments', t => {
  const root = temp(t), link = join(root, 'forkctl.mjs');
  symlinkSync(join(kit, 'fork/bin/forkctl.mjs'), link);
  const run = args => spawnSync(process.execPath, [link, ...args], { encoding: 'utf8', env: { ...process.env, FORKCTL_UPSTREAM_FIXTURE: join(kit, 'tests/support/releases/stable.json') } });
  const result = run(['check', '--state', join(root, 'state'), '--json']);
  assert.equal(result.status, 10, result.stderr);
  assert.equal(JSON.parse(result.stdout).state, 'new-release');
  const release = JSON.parse(result.stdout);
  withLock(join(root, 'state'), release.key, () => {
    const busy = run(['check', '--state', join(root, 'state'), '--json']);
    assert.equal(busy.status, 40, busy.stderr);
    assert.deepEqual(JSON.parse(busy.stdout), { state: 'busy', key: release.key });
  });
  assert.equal(run(['check', '--state', join(root, 'state'), '--json']).status, 10);
  for (const args of [['install'], ['check'], ['check', '--state'], ['check', '--wat'], ['check', '--state', root, '--state', root]]) assert.equal(run(args).status, 64);
});
