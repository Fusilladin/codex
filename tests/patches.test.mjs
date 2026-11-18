import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync, statSync, openSync, closeSync, ftruncateSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { prepare, applyPatches, verifyPatches } from '../fork/lib/patches.mjs';
import { checkRelease } from '../fork/lib/state.mjs';
import { candidateKey } from '../fork/lib/manifest.mjs';
import { temp, manifest, patchDir } from './helpers.mjs';
import { makeUpstream } from './support/make-upstream.mjs';

test('prepare archives exact clean source, applies, dedupes, leaves source and good state unchanged', async t => {
  const root = temp(t), fixture = await makeUpstream({ root });
  const m = manifest(fixture.commits.previous), release = { tag: fixture.tags.stable, commit: fixture.commits.stable };
  // Place state inside an ancestor Git worktree and leave caller data dirty.
  const stateRoot = join(fixture.repo, 'candidate-state'); mkdirSync(stateRoot);
  writeFileSync(join(fixture.repo, 'fixture-release.txt'), 'dirty caller content\n');
  const indexBefore = readFileSync(join(fixture.repo, '.git/index'));
  const good = '{"active":"known-good"}\n'; writeFileSync(join(stateRoot, 'state.json'), good);
  const before = spawnSync('git', ['-C', fixture.repo, 'diff', '--no-ext-diff']).stdout.toString();
  const args = { manifest: m, release, source: fixture.repo, patchDir, stateRoot };
  // Hostile inherited Git state must neither redirect archives nor applications.
  const injected = { GIT_DIR: join(fixture.repo, '.git'), GIT_WORK_TREE: fixture.repo,
    GIT_INDEX_FILE: join(root, 'unwanted-index'), GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: 'apply.ignoreWhitespace', GIT_CONFIG_VALUE_0: 'change',
    GIT_OBJECT_DIRECTORY: join(root, 'nonexistent-objects') };
  const saved = Object.fromEntries(Object.keys(injected).map(k => [k, process.env[k]]));
  try {
    Object.assign(process.env, injected);
    assert.equal(prepare(args).state, 'prepared');
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
  const attempt = join(stateRoot, 'attempts', readdirSync(join(stateRoot, 'attempts'))[0]);
  const pager = readFileSync(join(attempt, 'source/codex-rs/tui/src/pager_overlay.rs'), 'utf8');
  const transcript = readFileSync(join(attempt, 'source/codex-rs/tui/src/transcript_view/input.rs'), 'utf8');
  assert.equal((pager.match(/\* 2 \/ 5/g) ?? []).length, 2);
  assert.equal((transcript.match(/\* 2 \/ 5/g) ?? []).length, 2);
  assert.equal(readFileSync(join(attempt, 'source/fixture-release.txt'), 'utf8'), 'Synthetic stable release\n');
  assert.equal(JSON.parse(readFileSync(join(attempt, 'manifest.json'))).upstream.commit, release.commit);
  assert.match(readFileSync(join(attempt, 'PR-BODY.md'), 'utf8'), /NOT built/);
  assert.equal(prepare(args).state, 'candidate-exists');
  assert.equal(checkRelease(m, release, stateRoot).state, 'candidate-exists');
  assert.equal(readdirSync(join(stateRoot, 'attempts')).length, 1);
  assert.equal(readFileSync(join(stateRoot, 'state.json'), 'utf8'), good);
  assert.equal(spawnSync('git', ['-C', fixture.repo, 'diff', '--no-ext-diff']).stdout.toString(), before);
  assert.deepEqual(readFileSync(join(fixture.repo, '.git/index')), indexBefore);
  assert.equal(existsSync(join(root, 'unwanted-index')), false);
  const untracked = spawnSync('git', ['-C', fixture.repo, 'ls-files', '--others', '--exclude-standard']).stdout.toString().trim().split('\n');
  assert.ok(untracked.every(path => path.startsWith('candidate-state/')));
});

test('explicit baseline preserves exact manifest and lock pin with normal no-write up-to-date and repeat dedupe', async t => {
  const root = temp(t), f = await makeUpstream({ root });
  const m = { ...manifest(f.commits.previous), upstream: { repo: 'openai/codex', tag: f.tags.stable, commit: f.commits.stable }, fork_version: `${f.tags.stable.slice(6)}-p1`, lockfile_sha256: 'a'.repeat(64) };
  const stateRoot = join(root, 'baseline-state');
  const args = { manifest: m, source: f.repo, patchDir, stateRoot };
  assert.equal(prepare({ ...args, release: m.upstream }).state, 'up-to-date');
  assert.equal(existsSync(stateRoot), false);
  assert.throws(() => prepare({ ...args, baseline: true, release: m.upstream }), /Baseline/);
  assert.equal(prepare({ ...args, baseline: true }).state, 'prepared');
  const attempt = join(stateRoot, 'attempts', readdirSync(join(stateRoot, 'attempts'))[0]);
  assert.deepEqual(JSON.parse(readFileSync(join(attempt, 'manifest.json'))), m);
  assert.equal(JSON.parse(readFileSync(join(attempt, 'provenance.json'))).commit, m.upstream.commit);
  assert.equal(prepare({ ...args, baseline: true }).state, 'candidate-exists');
  assert.equal(readdirSync(join(stateRoot, 'attempts')).length, 1);
});

test('prepare detects already-applied upstream commit and does not register success', async t => {
  const root = temp(t), fixture = await makeUpstream({ root });
  const m = manifest(fixture.commits.previous);
  assert.equal(applyPatches(m, patchDir, fixture.repo, join(root, 'reports')).state, 'prepared');
  const env = { PATH: process.env.PATH, HOME: root, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: '91526142+Fusilladin@users.noreply.github.com', GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: '91526142+Fusilladin@users.noreply.github.com' };
  for (const args of [['add', '.'], ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgSign=false', 'commit', '-qm', 'fixture already applied']]) assert.equal(spawnSync('git', ['-C', fixture.repo, ...args], { env }).status, 0);
  const commit = spawnSync('git', ['-C', fixture.repo, 'rev-parse', 'HEAD'], { env }).stdout.toString().trim();
  const stateRoot = join(root, 'state');
  const result = prepare({ manifest: m, release: { tag: 'rust-v0.170.0', commit }, source: fixture.repo, patchDir, stateRoot });
  assert.equal(result.state, 'already-applied');
  assert.equal(existsSync(join(stateRoot, 'candidates')), false);
});

test('conflict produces sanitized file/hunk report; failed prepare not published', async t => {
  const root = temp(t), fixture = await makeUpstream({ root });
  const m = manifest(fixture.commits.previous);
  // Make a new test-owned commit with incompatible source (never modify shared templates).
  const path = join(fixture.repo, 'codex-rs/tui/src/pager_overlay.rs');
  writeFileSync(path, 'incompatible fixture\n');
  const env = { PATH: process.env.PATH, HOME: root, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: '91526142+Fusilladin@users.noreply.github.com', GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: '91526142+Fusilladin@users.noreply.github.com' };
  for (const args of [['add', '.'], ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgSign=false', 'commit', '-qm', 'fixture conflict']]) assert.equal(spawnSync('git', ['-C', fixture.repo, ...args], { env }).status, 0);
  const commit = spawnSync('git', ['-C', fixture.repo, 'rev-parse', 'HEAD'], { env }).stdout.toString().trim();
  const stateRoot = join(root, 'state');
  const result = prepare({ manifest: m, release: { tag: 'rust-v0.170.0', commit }, source: fixture.repo, patchDir, stateRoot });
  assert.equal(result.state, 'conflict');
  assert.equal(existsSync(join(stateRoot, 'candidates')), false);
  const attempt = join(stateRoot, 'attempts', readdirSync(join(stateRoot, 'attempts'))[0]);
  const report = readFileSync(join(attempt, 'conflict.json'), 'utf8');
  assert.match(report, /pager_overlay.rs/); assert.match(report, /297/); assert.ok(!report.includes(root));
  const altered = join(root, 'patches'); mkdirSync(altered);
  writeFileSync(join(altered, m.patches[0].file), 'wrong bytes');
  assert.throws(() => verifyPatches(m, altered), /bytes/);
});

test('concurrent key lock returns busy, no forced breaking or candidate writes', async t => {
  const root = temp(t), fixture = await makeUpstream({ root });
  const m = manifest(fixture.commits.previous), release = { tag: fixture.tags.stable, commit: fixture.commits.stable };
  const stateRoot = join(root, 'state'), key = candidateKey(m, release.commit);
  const script = `import { withLock } from ${JSON.stringify(new URL('../fork/lib/state.mjs', import.meta.url).href)}; import { readSync } from 'node:fs'; withLock(${JSON.stringify(stateRoot)}, ${JSON.stringify(key)}, () => { process.stdout.write('ready'); readSync(0, Buffer.alloc(1), 0, 1); });`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', script], { stdio: ['pipe', 'pipe', 'pipe'] });
  t.after(() => { if (child.exitCode === null) child.kill(); });
  await once(child.stdout, 'data');
  const result = prepare({ manifest: m, release, source: fixture.repo, patchDir, stateRoot });
  assert.equal(result.state, 'busy');
  assert.equal(existsSync(join(stateRoot, 'candidates')), false);
  child.stdin.end('x');
  const [code] = await once(child, 'exit'); assert.equal(code, 0);
});

function commitFixture(repo) {
  const env = { PATH: process.env.PATH, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: '91526142+Fusilladin@users.noreply.github.com',
    GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: '91526142+Fusilladin@users.noreply.github.com' };
  for (const args of [['add', '.'], ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgSign=false', 'commit', '-qm', 'test-owned data']]) {
    const result = spawnSync('git', ['-C', repo, ...args], { env });
    assert.equal(result.status, 0, result.stderr?.toString());
  }
  return spawnSync('git', ['-C', repo, 'rev-parse', 'HEAD'], { env }).stdout.toString().trim();
}

test('file-backed preparation handles committed archives larger than 32 MiB without capture', async t => {
  const root = temp(t), fixture = await makeUpstream({ root });
  // Sparse zero fixture compresses cheaply in Git; no large source buffers or real repo copies.
  const size = 33 * 1024 * 1024;
  const fd = openSync(join(fixture.repo, 'large-fixture.bin'), 'wx');
  try { ftruncateSync(fd, size); } finally { closeSync(fd); }
  const release = { tag: 'rust-v0.170.0', commit: commitFixture(fixture.repo) };
  const m = manifest(fixture.commits.previous), stateRoot = join(root, 'state');
  const result = prepare({ manifest: m, release, source: fixture.repo, patchDir, stateRoot });
  assert.equal(result.state, 'prepared');
  const attempt = join(stateRoot, 'attempts', readdirSync(join(stateRoot, 'attempts'))[0]);
  assert.ok(statSync(join(attempt, 'source.tar')).size > 32 * 1024 * 1024);
  assert.equal(statSync(join(attempt, 'source/large-fixture.bin')).size, size);
  const payloadBytes = size * 2 + statSync(join(attempt, 'source.tar')).size;
  assert.ok(payloadBytes < 2 * 1024 ** 3);
  t.diagnostic(`Large fixture logical payload (original + archive + extracted): ${payloadBytes} bytes; unique root cleaned by t.after`);
  assert.equal(checkRelease(m, release, stateRoot).state, 'candidate-exists');
});

test('archive/extract process errors, signals and nonzero statuses retain diagnostics but never candidates', async t => {
  const root = temp(t), fixture = await makeUpstream({ root });
  const m = manifest(fixture.commits.previous), release = { tag: fixture.tags.stable, commit: fixture.commits.stable };
  const failures = [
    ['archive', { status: 0, error: new Error('synthetic child error') }],
    ['extract', { status: 0, signal: 'SIGTERM' }],
    ['archive', { status: 1 }],
  ];
  for (const [i, [stage, failure]] of failures.entries()) {
    const stateRoot = join(root, `failure-state-${i}`);
    mkdirSync(stateRoot);
    const good = '{"active":"known-good"}\n';
    writeFileSync(join(stateRoot, 'state.json'), good);
    const run = (command, args, options) => {
      assert.equal(checkRelease(m, release, stateRoot).state, 'busy');
      if ((command === 'git' ? 'archive' : 'extract') === stage) return failure;
      return spawnSync(command, args, options);
    };
    assert.throws(() => prepare({ manifest: m, release, source: fixture.repo, patchDir, stateRoot, run }), /Cannot/);
    assert.equal(existsSync(join(stateRoot, 'candidates')), false);
    assert.equal(readFileSync(join(stateRoot, 'state.json'), 'utf8'), good);
    assert.equal(checkRelease(m, release, stateRoot).state, 'new-release');
    const attempt = join(stateRoot, 'attempts', readdirSync(join(stateRoot, 'attempts'))[0]);
    const report = readFileSync(join(attempt, 'failure.json'), 'utf8');
    assert.equal(JSON.parse(report).stage, stage);
    assert.ok(!report.includes(root));
  }
});
