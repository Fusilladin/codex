import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { temp, manifest, patchDir } from './helpers.mjs';
import { makeUpstream } from './support/make-upstream.mjs';
import { checkRelease } from '../fork/lib/state.mjs';
import { prepare } from '../fork/lib/patches.mjs';
import { updateCandidate } from '../fork/lib/update.mjs';

test('third fixture release prepares once and retains a single PR request without submitting unvalidated work', async t => {
  const root = temp(t), f = await makeUpstream({ root }), m = manifest(f.commits.previous), stateRoot = join(root, 'state');
  const env = { PATH: process.env.PATH, HOME: root, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 'Fixture', GIT_COMMITTER_NAME: 'Fixture', GIT_AUTHOR_EMAIL: '91526142+Fusilladin@users.noreply.github.com', GIT_COMMITTER_EMAIL: '91526142+Fusilladin@users.noreply.github.com' };
  const git = args => { const r = spawnSync('git', ['-C', f.repo, '-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgSign=false', '-c', 'tag.gpgSign=false', ...args], { env, encoding: 'utf8' }); assert.equal(r.status, 0); return r.stdout.trim(); };
  writeFileSync(join(f.repo, 'fixture-release.txt'), 'Synthetic third release\n');
  git(['add', 'fixture-release.txt']); git(['commit', '-qm', 'third fixture']); git(['tag', 'rust-v0.170.0']);
  const release = { tag: 'rust-v0.170.0', commit: git(['rev-parse', 'HEAD']) };
  assert.equal(checkRelease(m, release, stateRoot).state, 'new-release');
  assert.equal(prepare({ manifest: m, release, source: f.repo, patchDir, stateRoot }).state, 'prepared');
  assert.equal(checkRelease(m, release, stateRoot).state, 'candidate-exists');
  const branches = new Map(), transport = { upsertCandidate: request => { branches.set(request.branch, request); return { fixture: true, count: branches.size }; } };
  for (let i = 0; i < 2; i++) {
    assert.equal((await updateCandidate({ manifest: m, release, stateRoot, transport })).submitted, false);
    assert.equal(checkRelease(m, release, stateRoot).state, 'candidate-exists');
  }
  assert.equal(branches.size, 0);
});
