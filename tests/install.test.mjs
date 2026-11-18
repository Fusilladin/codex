import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { mkdirSync, readFileSync, writeFileSync, existsSync, symlinkSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { gzipSync, gunzipSync } from 'node:zlib';
import { makeTarballs } from './support/make-tarballs.mjs';
import { temp } from './helpers.mjs';
import { sha256 } from '../fork/lib/manifest.mjs';
import { inspectArchive } from '../fork/lib/safe-extract.mjs';
import { install, adoptOriginal, status, rollback, recoverInstall, runOld, list } from '../fork/lib/install.mjs';

async function setup(t) {
  const root = temp(t), fixtures = join(root, 'archives'); mkdirSync(fixtures);
  const archives = await makeTarballs({ root: fixtures }), home = join(root, 'home'), original = join(root, 'codex-scroll-patch');
  mkdirSync(join(home, '.local/bin'), { recursive: true }); mkdirSync(join(original, 'bin'), { recursive: true });
  writeFileSync(join(original, 'bin/codex'), '#!/bin/sh\nif [ "$1" = "--hold" ]; then exec sleep 30; fi\nprintf "%s\\n" "codex-cli 0.167.1"\n', { mode: 0o755 });
  symlinkSync(join(original, 'bin/codex'), join(home, '.local/bin/codex'));
  adoptOriginal({ home, directory: original, version: '0.167.1-original' });
  const options = { home, archive: archives.good, sha256: sha256(readFileSync(archives.good)), fixture: true };
  return { root, archives, home, original, options };
}

test('hostile archives, checksum, wrong target and missing helpers refuse before activation', async t => {
  const f = await setup(t);
  for (const name of ['corrupt', 'traversal', 'symlink', 'wrongTarget', 'missingHelper']) {
    const archive = f.archives[name];
    assert.throws(() => install({ ...f.options, archive, sha256: sha256(readFileSync(archive)) }));
    assert.equal(status(f).active, '0.167.1-original');
  }
  assert.throws(() => install({ ...f.options, sha256: 'a'.repeat(64) }), /checksum/);
  assert.throws(() => install({ ...f.options, fixture: false }), /attestation/);
  assert.equal(existsSync(join(f.home, '.local/share/codex-fork/current')), false);
  const tar = gunzipSync(readFileSync(f.archives.good));
  // Maintain a valid checksum while turning an allowlisted file into a hardlink.
  tar[156] = '1'.charCodeAt(0); tar.fill(32, 148, 156);
  const sum = tar.subarray(0, 512).reduce((a, b) => a + b, 0);
  tar.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 8);
  assert.throws(() => inspectArchive(gzipSync(tar)), /Unsafe/);
});

test('activation keeps a live original process, supports isolated old execution, retains versions and rolls back', async t => {
  const f = await setup(t), child = spawn(join(f.home, '.local/bin/codex'), ['--hold'], { stdio: 'ignore' });
  const closed = once(child, 'close'); await once(child, 'spawn');
  t.after(async () => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM'); await closed; });
  assert.equal(install(f.options).active, '0.169.0-p1');
  process.kill(child.pid, 0);
  assert.deepEqual(list(f).versions, ['0.167.1-original', '0.169.0-p1']);
  assert.equal(runOld({ ...f, version: '0.167.1-original', isolated: true }).output.trim(), 'codex-cli 0.167.1');
  assert.throws(() => runOld({ ...f, version: '0.167.1-original' }), /isolated/);
  assert.throws(() => runOld({ ...f, version: '../../escape', isolated: true }));
  assert.equal(rollback(f).active, '0.167.1-original');
  assert.equal(status(f).previous, '0.169.0-p1');
  assert.equal(readFileSync(join(f.original, 'bin/codex'), 'utf8').includes('0.167.1'), true);
});

test('interruption before switch preserves launcher and retry; after switch journal recovery restores coherent state', async t => {
  const f = await setup(t);
  assert.throws(() => install({ ...f.options, interrupt: 'after-extract' }), /interruption/);
  assert.equal(runOld({ ...f, version: '0.167.1-original', isolated: true }).output.trim(), 'codex-cli 0.167.1');
  assert.equal(status(f).active, '0.167.1-original');
  assert.throws(() => install({ ...f.options, interrupt: 'after-switch' }), /interruption/);
  assert.equal(status(f).active, '0.167.1-original');
  assert.throws(() => rollback(f), /Recovery/);
  assert.equal(recoverInstall(f).active, '0.169.0-p1');
  assert.equal(status(f).active, '0.169.0-p1');
  assert.equal(rollback(f).active, '0.167.1-original');
});

test('pre-switch journal recovery retains a verified inactive version and leaves original launcher usable', async t => {
  const f = await setup(t);
  assert.throws(() => install({ ...f.options, interrupt: 'before-switch' }), /before switch/);
  assert.equal(status(f).active, '0.167.1-original');
  assert.equal(recoverInstall(f).aborted, true);
  assert.equal(runOld({ ...f, version: '0.167.1-original', isolated: true }).output.trim(), 'codex-cli 0.167.1');
  assert.equal(rollback({ ...f, version: '0.169.0-p1' }).active, '0.169.0-p1');
});

test('installation refuses an unmanaged launcher and retained execution refuses a redirected bin directory', async t => {
  const { renameSync } = await import('node:fs');
  const f = await setup(t), launcher = join(f.home, '.local/bin/codex'), archive = join(f.root, '_archive/20261117-probe'); mkdirSync(archive, { recursive: true });
  renameSync(launcher, join(archive, 'original-link')); writeFileSync(launcher, 'owner launcher bytes');
  assert.throws(() => install(f.options), /Unmanaged launcher/); assert.equal(readFileSync(launcher, 'utf8'), 'owner launcher bytes');
  renameSync(launcher, join(archive, 'owner-file')); renameSync(join(archive, 'original-link'), launcher);
  install(f.options);
  const active = status(f), dir = active.versions[active.active].path;
  renameSync(join(dir, 'bin'), join(archive, 'retained-bin')); symlinkSync(join(f.original, 'bin'), join(dir, 'bin'));
  assert.throws(() => runOld({ ...f, version: active.active, isolated: true }), /Unsafe directory/);
});

test('release install requires a binary-bound 24/60-row behavioral patch probe before activation', async t => {
  const { inspectArchive } = await import('../fork/lib/safe-extract.mjs');
  const { packageStage } = await import('../fork/lib/package.mjs');
  const f = await setup(t), stage = join(f.root, 'ready-stage'); mkdirSync(join(stage, 'bin'), { recursive: true });
  const inspected = inspectArchive(readFileSync(f.archives.good));
  const m = { ...inspected.manifest, production_ready: true, lockfile_sha256: 'a'.repeat(64) };
  for (const [name, entry] of inspected.files) writeFileSync(join(stage, name), name === 'manifest.json' ? JSON.stringify(m) : entry.bytes, { mode: name.startsWith('bin/') ? 0o755 : 0o644 });
  const out = join(f.root, 'ready-package'), packaged = packageStage({ stage, output: out, fixture: true });
  const options = { ...f.options, fixture: false, archive: join(out, packaged.artifact), sha256: packaged.sha256, verification: { verified: true, artifactHash: packaged.sha256, commit: 'b'.repeat(40) } };
  assert.throws(() => install(options), /probe required/); assert.equal(status(f).active, '0.167.1-original');
  assert.throws(() => install({ ...options, probe: () => ({ verdict: 'PASS', binaryHash: '0'.repeat(64), steps: {} }) }), /probe failed/);
  const probe = ({ directory, env }) => {
    assert.notEqual(env.HOME, f.home); assert.ok(env.CODEX_HOME.startsWith(env.HOME));
    return { verdict: 'PASS', binaryHash: sha256(readFileSync(join(directory, 'bin/codex'))), steps: { pager24: 9, pager60: 24, transcript24: 9, transcript60: 24 } };
  };
  assert.equal(install({ ...options, probe }).active, m.fork_version);
});
