import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, readFileSync, existsSync, symlinkSync, linkSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { allowedFiles, packageStage } from '../fork/lib/package.mjs';
import { sha256 } from '../fork/lib/manifest.mjs';
import { scanTree } from '../fork/lib/canary.mjs';
import { temp, manifest } from './helpers.mjs';
function stage(root) {
  const dir = join(root, 'stage'); mkdirSync(join(dir, 'bin'), { recursive: true });
  const m = manifest('1'.repeat(40));
  for (const file of allowedFiles) writeFileSync(join(dir, file), file.startsWith('bin/') ? '#!/bin/sh\nexit 0\n' : file === 'manifest.json' ? JSON.stringify(m) : file === 'FORK-VERSION' ? m.fork_version + '\n' : 'Fixture notice only\n', { mode: file.startsWith('bin/') ? 0o755 : 0o644 });
  return dir;
}
test('fixed package file list, notices, deterministic bytes and SHA256SUMS', t => {
  const root = temp(t), dir = stage(root);
  const result = packageStage({ fixture: true, stage: dir, output: join(root, 'out1') });
  const again = packageStage({ fixture: true, stage: dir, output: join(root, 'out2') });
  const bytes = readFileSync(join(root, 'out1', result.artifact));
  assert.equal(result.sha256, sha256(bytes)); assert.equal(result.sha256, again.sha256);
  assert.equal(readFileSync(join(root, 'out1/SHA256SUMS'), 'utf8'), `${result.sha256}  ${result.artifact}\n`);
  const listing = spawnSync('tar', ['-tzf', join(root, 'out1', result.artifact)], { encoding: 'utf8' });
  assert.equal(listing.status, 0); assert.deepEqual(listing.stdout.trim().split('\n').sort(), allowedFiles);
  assert.throws(() => packageStage({ fixture: true, stage: dir, output: join(root, 'out1') }));
  assert.deepEqual(readFileSync(join(root, 'out1', result.artifact)), bytes);
});
test('secret/home canaries refused before output and without disclosing value', t => {
  const root = temp(t), dir = stage(root), out = join(root, 'out');
  for (const canary of ['sk-' + 'SyntheticSecret'.repeat(3), '/' + 'home/' + 'synthetic-user/private', 'FORK_SECRET_CANARY_' + 'TestOnly']) {
    writeFileSync(join(dir, 'NOTICE'), canary);
    assert.throws(() => packageStage({ fixture: true, stage: dir, output: out }), error => !error.message.includes(canary) && /redacted/.test(error.message));
    assert.throws(() => scanTree(dir), /redacted/);
    assert.equal(existsSync(out), false);
  }
  const blocklist = join(root, 'privacy-patterns.txt');
  writeFileSync(blocklist, '# synthetic privacy pattern\nPrivateFixtureMarker\n');
  const previous = process.env.FORKCTL_BLOCKLIST;
  try {
    process.env.FORKCTL_BLOCKLIST = blocklist;
    writeFileSync(join(dir, 'NOTICE'), 'PrivateFixtureMarker');
    assert.throws(() => packageStage({ fixture: true, stage: dir, output: out }), /redacted/);
    assert.equal(existsSync(out), false);
    process.env.FORKCTL_BLOCKLIST = join(root, 'absent');
    assert.throws(() => packageStage({ fixture: true, stage: dir, output: out }), /blocklist unreadable/);
    const empty = join(root, 'empty'); mkdirSync(empty);
    assert.throws(() => scanTree(empty), /blocklist unreadable/);
    process.env.FORKCTL_BLOCKLIST = blocklist;
    writeFileSync(blocklist, '[invalid');
    assert.throws(() => scanTree(empty), /blocklist unreadable or invalid/);
    assert.throws(() => packageStage({ fixture: true, stage: dir, output: out }), /blocklist unreadable or invalid/);
    assert.equal(existsSync(out), false);
  } finally {
    if (previous === undefined) delete process.env.FORKCTL_BLOCKLIST;
    else process.env.FORKCTL_BLOCKLIST = previous;
  }
});
test('missing helper, extras and links refused before output', t => {
  const root = temp(t);
  for (const kind of ['missing', 'extra', 'symlink', 'hardlink']) {
    const local = join(root, kind); mkdirSync(local);
    const dir = stage(local), out = join(local, 'out');
    if (kind === 'missing') {
      // No destructive cleanup: move a helper outside stage, both test-owned.
      const move = spawnSync('mv', [join(dir, 'bin/codex-exec-server'), join(local, 'helper')]); assert.equal(move.status, 0);
    } else if (kind === 'extra') writeFileSync(join(dir, 'extra'), 'no');
    else if (kind === 'symlink') symlinkSync('NOTICE', join(dir, 'extra'));
    else linkSync(join(dir, 'NOTICE'), join(local, 'notice-link'));
    assert.throws(() => packageStage({ fixture: true, stage: dir, output: out })); assert.equal(existsSync(out), false);
  }
});

test('arbitrarily named files beneath tests are scanned with redacted diagnostics', t => {
  const root = temp(t), tests = join(root, 'tests'); mkdirSync(tests);
  const canary = ['FORK', 'SECRET', 'CANARY', 'RuntimeOnly'].join('_');
  const file = join(tests, 'previously-unlisted-data.txt');
  writeFileSync(file, canary);
  assert.throws(() => scanTree(root), error => /redacted/.test(error.message) && !error.message.includes(canary));
  writeFileSync(file, 'ordinary fixture');
  const sensitiveName = ['auth', 'json'].join('.');
  writeFileSync(join(tests, sensitiveName), 'ordinary fixture');
  assert.throws(() => scanTree(root), error => /redacted/.test(error.message) && !error.message.includes(sensitiveName));
});
test('tests-root symlinks are refused rather than skipped or followed', t => {
  const root = temp(t), target = join(root, 'ordinary'); mkdirSync(target);
  symlinkSync(target, join(root, 'tests'));
  assert.throws(() => scanTree(root), /Unsafe scan entry/);
});
test('stage equality, descendants and resolved-parent aliases cannot receive output', t => {
  const root = temp(t), dir = stage(root);
  const alias = join(root, 'alias'); symlinkSync(dir, alias);
  const parentAlias = join(root, 'parent-alias'); symlinkSync(root, parentAlias);
  const cases = [
    { stage: dir, output: dir },
    { stage: dir, output: join(dir, 'out') },
    { stage: dir, output: join(dir, '..out') },
    { stage: dir, output: alias },
    { stage: dir, output: join(alias, '..out') },
    { stage: join(parentAlias, 'stage'), output: join(dir, '..out') },
  ];
  const before = readFileSync(join(dir, 'NOTICE'));
  for (const options of cases) assert.throws(() => packageStage({ ...options, fixture: true }), /outside staging/);
  assert.equal(existsSync(join(dir, 'out')), false);
  assert.equal(existsSync(join(dir, '..out')), false);
  assert.deepEqual(readFileSync(join(dir, 'NOTICE')), before);
});

test('ordinary credential filename references pass content scanning while actual credential entries and secrets fail', t => {
  const root = temp(t), dir = stage(root);
  writeFileSync(join(dir, 'bin/codex'), '#!/bin/sh\n# ordinary auth.json filename reference\nexit 0\n');
  assert.equal(packageStage({ stage: dir, fixture: true, output: join(root, 'safe') }).state, 'packaged');
  writeFileSync(join(dir, ['auth', 'json'].join('.')), '{}');
  assert.throws(() => scanTree(dir), /redacted/);
});
