import test from 'node:test';
import assert from 'node:assert/strict';
import { join, dirname } from 'node:path';
import { mkdirSync, writeFileSync, readFileSync, readdirSync, chmodSync, symlinkSync, renameSync, realpathSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { temp, manifest, patchDir } from './helpers.mjs';
import { makeUpstream } from './support/make-upstream.mjs';
import { prepare } from '../fork/lib/patches.mjs';
import { buildCodex, parseLock, compareLocks, completeAltUCoverage, requiredAltUTests } from '../fork/lib/build-codex.mjs';
import { sha256, candidateKey } from '../fork/lib/manifest.mjs';
import { readJSON, checkRelease, withLock, exits } from '../fork/lib/state.mjs';
import { main } from '../fork/bin/forkctl.mjs';

const lock = (version = '0.0.0') => `# synthetic lock\nversion = 4\n\n[[package]]\nname = "codex-tui"\nversion = "${version}"\ndependencies = [\n "external 1.0.0",\n]\n\n[[package]]\nname = "consumer"\nversion = "1.0.0"\ndependencies = [\n "codex-tui ${version}",\n]\n\n[[package]]\nname = "external"\nversion = "1.0.0"\nsource = "registry+https://example.invalid/index"\nchecksum = "${'a'.repeat(64)}"\n`;
async function fixture(t, channel, { links, pin } = {}) {
  const root = temp(t), f = await makeUpstream({ root });
  const m = manifest(f.commits.previous);
  writeFileSync(join(f.repo, 'codex-rs/Cargo.lock'), lock());
  writeFileSync(join(f.repo, 'codex-rs/Cargo.toml'), '[workspace]\nmembers = ["tui"]\n');
  writeFileSync(join(f.repo, 'codex-rs/tui/Cargo.toml'), '[package]\nname = "codex-tui"\nversion = "0.169.0"\n');
  writeFileSync(join(f.repo, 'codex-rs/rust-toolchain.toml'), `[toolchain]\nchannel = "${channel ?? m.toolchain}"\n`);
  if (links) {
    const vendor = join(f.repo, 'codex-rs/vendor/bubblewrap'); mkdirSync(vendor, { recursive: true });
    writeFileSync(join(vendor, 'COPYING'), 'synthetic license');
    for (const [name, target] of Object.entries(links)) symlinkSync(target, join(vendor, name));
  }
  const env = { PATH: process.env.PATH, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: '91526142+Fusilladin@users.noreply.github.com', GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: '91526142+Fusilladin@users.noreply.github.com' };
  for (const args of [['add', '.'], ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgSign=false', 'commit', '-qm', 'synthetic build inputs']]) assert.equal(spawnSync('git', ['-C', f.repo, ...args], { env }).status, 0);
  const commit = spawnSync('git', ['-C', f.repo, 'rev-parse', 'HEAD'], { env }).stdout.toString().trim();
  const release = { tag: 'rust-v0.169.0', commit }, stateRoot = join(root, 'state');
  const baseline = { ...m, upstream: { ...m.upstream, ...release }, fork_version: '0.169.0-p1', lockfile_sha256: pin ?? null };
  assert.equal(prepare({ manifest: baseline, baseline: true, source: f.repo, patchDir, stateRoot }).state, 'prepared');
  const key = candidateKey(baseline), path = join(stateRoot, 'candidates', `${key}.json`), candidate = readJSON(path);
  const args = { manifest: candidate.manifest, source: candidate.source, stateRoot, patchDir, local: true, offline: true, storageBase: root };
  return { root, m, release, key, path, args, candidate };
}
function runner(f, { failBuild, failTest, drift, omitOutput, failRefresh, onCall } = {}) {
  const calls = [];
  const run = (cmd, args, opts) => {
    calls.push({ cmd, args, env: opts.env });
    onCall?.(cmd, args, opts);
    assert.equal(checkRelease(f.m, f.release, f.args.stateRoot).state, 'busy');
    if (cmd === 'rustc') return { status: 0, stdout: `rustc ${f.args.manifest.toolchain} (fixture)\n` };
    if (args.includes('metadata')) return { status: 0, stdout: JSON.stringify({ workspace_members: ['member'], packages: [{ id: 'member', name: 'codex-tui', version: '0.169.0', source: null, manifest_path: join(f.args.source, 'codex-rs/tui/Cargo.toml') }] }) };
    if (args.includes('update')) { writeFileSync(join(f.args.source, 'codex-rs/Cargo.lock'), drift ?? lock('0.169.0')); return failRefresh ?? { status: 0 }; }
    if (args.includes('build')) {
      if (failBuild) return failBuild;
      if (!omitOutput) {
        const bin = args[args.indexOf('--bin') + 1], path = join(opts.env.CARGO_TARGET_DIR, f.args.manifest.target, 'release', bin);
        mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, `synthetic ${bin}`); chmodSync(path, 0o755);
      }
      return { status: 0 };
    }
    if (args.includes('test')) return failTest ?? { status: 0, stdout: 'test pager_overlay::tests::scroll_40_static_pager_steps_and_bounds ... ok\ntest transcript_view::input::tests::scroll_40_transcript_pager_steps_and_bounds ... ok\ntest transcript_view::input::tests::scroll_40_transcript_ordinary_input_steps_and_bounds ... ok\ntest result: ok. 3 passed; 0 failed; 0 ignored;\n' };
    throw new Error('Unexpected fixture command');
  };
  return { calls, run };
}
function attempt(f, result) { return readJSON(join(f.args.stateRoot, 'build-attempts', result.attempt, 'attempt.json')); }

test('prepared archive validates workspace refresh, pinned offline three-bin commands and exact hashes', async t => {
  const f = await fixture(t), r = runner(f);
  const good = '{"active":"known-good"}\n'; writeFileSync(join(f.args.stateRoot, 'state.json'), good);
  assert.equal(f.candidate.state, 'prepared-not-built');
  assert.equal(checkRelease(f.m, f.release, f.args.stateRoot).state, 'candidate-exists');
  const result = buildCodex({ ...f.args, run: r.run });
  assert.equal(result.state, 'validated'); assert.equal(result.published, false);
  const evidence = attempt(f, result), candidate = readJSON(f.path);
  assert.equal(candidate.inputHash, sha256(JSON.stringify(f.args.manifest)));
  assert.equal(evidence.refreshedLockHash, sha256(lock('0.169.0')));
  assert.equal(candidate.manifest.lockfile_sha256, null);
  assert.equal(candidate.source, f.candidate.source);
  assert.equal(evidence.artifacts.length, 3);
  for (const a of evidence.artifacts) assert.equal(a.sha256, sha256(readFileSync(a.path)));
  const builds = r.calls.filter(c => c.args.includes('build'));
  assert.deepEqual(builds.map(c => c.args.at(-1)), f.args.manifest.bins);
  for (const c of r.calls) {
    assert.equal(c.args[0], `+${f.args.manifest.toolchain}`);
    assert.equal(c.env.RUSTUP_AUTO_INSTALL, '0'); assert.equal(c.env.CARGO_BUILD_JOBS, '4');
    assert.equal(c.env.CARGO_PROFILE_RELEASE_DEBUG, '0');
    assert.ok(c.env.CARGO_HOME.startsWith(f.args.stateRoot));
    if (c.cmd === 'cargo') assert.ok(c.args.includes('--offline'));
    if (c.args.includes('build') || c.args.includes('test')) {
      assert.ok(c.args.includes('--locked')); assert.ok(c.args.includes(f.args.manifest.target));
    }
  }
  assert.ok(r.calls.at(-1).args.includes('scroll_40'));
  assert.equal(readFileSync(join(f.args.stateRoot, 'state.json'), 'utf8'), good);
});

test('external version/source/checksum/dependency drift and unsupported lock records fail closed before builds', async t => {
  const before = parseLock(lock()), after = lock('0.169.0'), members = [{ name: 'codex-tui', version: '0.169.0' }];
  for (const changed of [after.replace('checksum = "a', 'checksum = "b'), after.replace('external 1.0.0', 'external 2.0.0'), after.replace('registry+', 'git+'), after.replace('name = "external"\nversion = "1.0.0"', 'name = "external"\nversion = "2.0.0"')]) {
    assert.throws(() => compareLocks(before, parseLock(changed), members), { code: 22 });
  }
  assert.throws(() => parseLock(`${after}\n[metadata]\nvalue = true\n`), { code: 22 });
  const f = await fixture(t), r = runner(f, { drift: after.replace('checksum = "a', 'checksum = "b') });
  const result = buildCodex({ ...f.args, run: r.run });
  assert.equal(result.state, 'lock-drift'); assert.equal(exits[result.state], 22);
  assert.ok(!r.calls.some(c => c.args.includes('build')));
  assert.equal(readJSON(f.path).state, 'lock-drift');
});

test('build process error, signal, missing outputs and test failure remain retryable with private immutable attempts', async t => {
  const f = await fixture(t);
  const cases = [
    [{ failBuild: { status: 0, error: new Error('synthetic compiler error') } }, 'build-failed', 30],
    [{ failBuild: { status: 0, signal: 'SIGTERM' } }, 'build-failed', 30],
    [{ omitOutput: true }, 'build-failed', 30],
    [{ failTest: { status: 7 } }, 'test-failed', 31],
    [{ failTest: { status: 0, stdout: 'test result: ok. 0 passed; 0 failed;\n' } }, 'test-failed', 31],
  ];
  const ids = [], snapshots = [];
  for (const [options, state, code] of cases) {
    const r = runner(f, options), result = buildCodex({ ...f.args, run: r.run });
    ids.push(result.attempt); assert.equal(result.state, state); assert.equal(result.validated, false); assert.equal(exits[state], code);
    assert.equal(readJSON(f.path).state, state);
    assert.equal(checkRelease(f.m, f.release, f.args.stateRoot).state, 'candidate-exists');
    const path = join(f.args.stateRoot, 'build-attempts', result.attempt, 'attempt.json');
    snapshots.push([path, readFileSync(path, 'utf8')]);
  }
  const result = buildCodex({ ...f.args, run: runner(f).run }); ids.push(result.attempt);
  assert.equal(result.state, 'validated'); assert.equal(result.key, f.key);
  assert.equal(new Set(ids).size, ids.length);
  assert.deepEqual(readJSON(f.path).buildAttempts, ids);
  for (const [path, bytes] of snapshots) assert.equal(readFileSync(path, 'utf8'), bytes);
  assert.equal(readdirSync(join(f.args.stateRoot, 'build-attempts')).length, ids.length);
});

test('unsafe, unrelated, changed, wrong-toolchain and bad patch inputs refuse without commands; busy stays busy', async t => {
  const f = await fixture(t);
  let calls = 0; const run = () => { calls++; throw new Error('Must not execute'); };
  for (const args of [{ local: false }, { offline: false }, { source: f.root }, { storageBase: f.args.stateRoot }, { manifest: { ...f.args.manifest, toolchain: '1.1.1' } }]) {
    assert.throws(() => buildCodex({ ...f.args, ...args, run }));
  }
  withLock(f.args.stateRoot, f.key, () => assert.equal(buildCodex({ ...f.args, run }).state, 'busy'));
  const changed = join(f.args.source, 'extra.txt'); writeFileSync(changed, 'unaccounted');
  assert.throws(() => buildCodex({ ...f.args, run }), /unaccounted/);
  const wrong = await fixture(t, '1.1.1');
  assert.throws(() => buildCodex({ ...wrong.args, run }), /toolchain/);
  const badPatchDir = join(f.root, 'bad-patches'); mkdirSync(badPatchDir);
  writeFileSync(join(badPatchDir, f.args.manifest.patches[0].file), 'wrong');
  assert.throws(() => buildCodex({ ...f.args, patchDir: badPatchDir, run }), /bytes/);
  assert.equal(calls, 0);
});

test('safe committed internal links reach commands; unsafe resolution and changed provenance refuse', async t => {
  const f = await fixture(t, undefined, { links: { LICENSE: 'COPYING', intermediate: 'COPYING', chained: 'intermediate' } });
  assert.equal(buildCodex({ ...f.args, run: runner(f).run }).state, 'validated');
  const license = join(f.args.source, 'codex-rs/vendor/bubblewrap/LICENSE');
  renameSync(license, join(f.root, 'retired-license-link')); symlinkSync('other', license); // only this test-owned entry
  assert.throws(() => buildCodex({ ...f.args, run: () => assert.fail('unexpected command') }), /unaccounted/);
  const changed = await fixture(t, undefined, { links: { LICENSE: 'COPYING' } });
  writeFileSync(join(changed.args.source, 'codex-rs/vendor/bubblewrap/COPYING'), 'changed');
  assert.throws(() => buildCodex({ ...changed.args, run: () => assert.fail('unexpected command') }), /unaccounted/);
  for (const links of [{ LICENSE: 'missing' }, { LICENSE: 'cycle', cycle: 'LICENSE' }, { LICENSE: '../../../../../../outside' }, { LICENSE: `${String.fromCharCode(47)}outside` }, { LICENSE: 'intermediate/COPYING', intermediate: '../../../../../../outside' }]) {
    const unsafe = await fixture(t, undefined, { links });
    assert.throws(() => buildCodex({ ...unsafe.args, run: () => assert.fail('unexpected command') }));
  }
});

test('failed mutating refresh retains lock/process evidence and retries only proven workspace changes', async t => {
  const untouched = await fixture(t);
  const early = buildCodex({ ...untouched.args, run: runner(untouched, { failRefresh: { status: 7 }, drift: lock() }).run });
  assert.equal(early.state, 'build-failed');
  assert.equal(readJSON(join(untouched.args.stateRoot, 'build-attempts', early.attempt, 'lock-comparison.json')).classification, 'unchanged');
  assert.equal(buildCodex({ ...untouched.args, run: runner(untouched).run }).state, 'validated');
  const f = await fixture(t);
  const r = runner(f, { failRefresh: { status: null, signal: 'SIGTERM' } });
  const failed = buildCodex({ ...f.args, run: r.run });
  assert.equal(failed.state, 'build-failed');
  const dir = join(f.args.stateRoot, 'build-attempts', failed.attempt);
  const snapshots = readdirSync(dir).filter(name => !['home', 'artifacts'].includes(name)).map(name => [join(dir, name), readFileSync(join(dir, name))]);
  assert.equal(readFileSync(join(dir, 'Cargo.lock.before'), 'utf8'), lock());
  assert.equal(readFileSync(join(dir, 'Cargo.lock.after'), 'utf8'), lock('0.169.0'));
  assert.equal(attempt(f, failed).commands.at(-1).signal, 'SIGTERM');
  assert.equal(buildCodex({ ...f.args, run: runner(f).run }).state, 'validated');
  for (const [path, bytes] of snapshots) assert.deepEqual(readFileSync(path), bytes);
  const bad = await fixture(t), br = runner(bad, { failRefresh: { status: 7 }, drift: lock('0.169.0').replace('checksum = "a', 'checksum = "b') });
  assert.equal(buildCodex({ ...bad.args, run: br.run }).state, 'lock-drift');
  assert.throws(() => buildCodex({ ...bad.args, run: () => assert.fail('unexpected retry command') }), /unaccounted/);
});

test('non-null pins mean verified refreshed bytes, including failed-refresh resumes', async t => {
  const correct = sha256(lock('0.169.0'));
  const f = await fixture(t, undefined, { pin: correct });
  assert.notEqual(correct, sha256(lock()));
  assert.equal(buildCodex({ ...f.args, run: runner(f, { failRefresh: { status: 7 } }).run }).state, 'build-failed');
  assert.equal(buildCodex({ ...f.args, run: runner(f).run }).state, 'validated');
  const wrong = await fixture(t, undefined, { pin: sha256(lock()) });
  const r = runner(wrong);
  assert.equal(buildCodex({ ...wrong.args, run: r.run }).state, 'lock-drift');
  assert.ok(!r.calls.some(c => c.args.includes('build')));
  assert.throws(() => buildCodex({ ...wrong.args, run: () => assert.fail('unexpected resumed command') }), /pin mismatch/);
});

test('sequential shared target excludes other candidates, freezes artifacts and rejects stale missing outputs', async t => {
  const f = await fixture(t), first = buildCodex({ ...f.args, run: runner(f).run });
  const frozen = attempt(f, first), snapshots = frozen.artifacts.map(a => [a.path, readFileSync(a.path)]);
  const second = runner(f, { omitOutput: true, onCall: () => {
    const other = { ...f.args.manifest, toolchain: f.args.manifest.toolchain, upstream: { ...f.args.manifest.upstream, commit: 'c'.repeat(40) } };
    assert.equal(buildCodex({ ...f.args, manifest: other, run: () => assert.fail('concurrent command') }).state, 'busy');
  } });
  const failed = buildCodex({ ...f.args, run: second.run });
  assert.equal(failed.state, 'build-failed');
  assert.equal(attempt(f, failed).target, frozen.target);
  assert.ok(second.calls[0].env.CARGO_TARGET_DIR !== join(f.args.stateRoot, 'build-attempts', first.attempt, 'target'));
  for (const [path, bytes] of snapshots) assert.deepEqual(readFileSync(path), bytes);
  const alias = join(f.root, 'storage-alias'); symlinkSync(realpathSync(f.root), alias);
  assert.equal(buildCodex({ ...f.args, storageBase: alias, run: runner(f).run }).state, 'validated');
});

test('build CLI parses flags strictly and does not perform upstream lookup', async () => {
  for (const args of [[], ['--local', 'true'], ['--offline', '--offline'], ['--wat'], ['--fixture', 'unused']]) {
    await assert.rejects(main(['build', ...args]), { code: 64 });
  }
});

test('finalization retains immutable provenance, rebuilds exact revision, and binds fixture packages to frozen bytes', async t => {
  const { finalizeCandidate } = await import('../fork/lib/state.mjs');
  const { packageStage, allowedFiles } = await import('../fork/lib/package.mjs');
  const { validateManifest } = await import('../fork/lib/manifest.mjs');
  const f = await fixture(t), first = buildCodex({ ...f.args, run: runner(f).run });
  const oldPath = join(f.args.stateRoot, 'build-attempts', first.attempt, 'attempt.json'), oldBytes = readFileSync(oldPath);
  const finalized = finalizeCandidate({ manifest: f.args.manifest, stateRoot: f.args.stateRoot });
  assert.equal(finalized.key, first.key); assert.notEqual(finalized.inputHash, f.candidate.inputHash);
  assert.equal(checkRelease(f.m, f.release, f.args.stateRoot).state, 'candidate-exists');
  const finalArgs = { ...f.args, manifest: finalized.manifest };
  const updated = { ...f, args: finalArgs };
  const rebuilt = buildCodex({ ...finalArgs, run: runner(updated).run });
  assert.equal(rebuilt.state, 'validated'); assert.deepEqual(readFileSync(oldPath), oldBytes);
  const { updateCandidate } = await import('../fork/lib/update.mjs');
  const branches = new Set(), transport = { upsertCandidate: request => { branches.add(request.branch); return { count: branches.size }; } };
  for (let n = 0; n < 2; n++) assert.equal((await updateCandidate({ manifest: finalArgs.manifest, release: f.release, stateRoot: f.args.stateRoot, transport })).outcome.count, 1);
  const stage = join(f.root, 'package-stage'); mkdirSync(join(stage, 'bin'), { recursive: true });
  const receipt = attempt(f, rebuilt);
  for (const file of allowedFiles) {
    const bytes = file.startsWith('bin/') ? readFileSync(receipt.artifacts.find(a => file === `bin/${a.bin}`).path) : file === 'manifest.json' ? JSON.stringify(finalized.manifest) : file === 'FORK-VERSION' ? finalized.manifest.fork_version : 'synthetic notice';
    writeFileSync(join(stage, file), bytes, { mode: file.startsWith('bin/') ? 0o755 : 0o644 });
  }
  const options = { stage, fixture: true, stateRoot: f.args.stateRoot, attempt: rebuilt.attempt };
  assert.equal(packageStage({ ...options, output: join(f.root, 'bound') }).production_ready, false);
  const { submitPackagedCandidate } = await import('../fork/lib/submit.mjs');
  await assert.rejects(submitPackagedCandidate({ manifest: finalArgs.manifest, release: f.release, stateRoot: f.args.stateRoot, packageDir: join(f.root, 'bound'), transport: { upsertCandidate: () => assert.fail('fixture cannot submit') } }), /Exact host-built package/);
  assert.throws(() => packageStage({ ...options, fixture: false, output: join(f.root, 'not-release') }), /receipt/);
  for (const file of ['bin/codex-exec-server', 'manifest.json']) {
    const path = join(stage, file), original = readFileSync(path);
    writeFileSync(path, file === 'manifest.json' ? JSON.stringify({ ...finalized.manifest, lockfile_sha256: 'a'.repeat(64) }) : 'changed helper');
    assert.throws(() => packageStage({ ...options, output: join(f.root, `bad-${file.split('/').at(-1)}`) }));
    writeFileSync(path, original);
  }
  const receiptPath = join(f.args.stateRoot, 'build-attempts', rebuilt.attempt, 'attempt.json'), receiptBytes = readFileSync(receiptPath);
  writeFileSync(receiptPath, JSON.stringify({ ...receipt, state: 'build-failed' }));
  assert.throws(() => packageStage({ ...options, output: join(f.root, 'bad-receipt') }));
  writeFileSync(receiptPath, receiptBytes);
  const { production_ready, ...missing } = finalized.manifest;
  for (const value of [missing, { ...missing, production_ready: 'true' }]) assert.throws(() => validateManifest(value), /readiness/);
});

test('uncertain process cleanup retains candidate and compilation locks until explicit host recovery', async t => {
  const f = await fixture(t), r = runner(f, { failBuild: { status: null, error: new Error('cleanup unknown'), ownershipUncertain: true } });
  const failed = buildCodex({ ...f.args, run: r.run });
  assert.equal(failed.state, 'build-failed');
  const targetKey = sha256(`compilation|${f.args.manifest.target}|${f.args.manifest.toolchain}`);
  for (const key of [targetKey, f.key]) {
    const lockOwner = readJSON(join(f.args.stateRoot, 'locks', key));
    assert.equal(lockOwner.pid, process.pid); assert.ok(lockOwner.start); assert.ok(lockOwner.boot); assert.ok(lockOwner.metadata.resource);
  }
  assert.equal(buildCodex({ ...f.args, run: () => assert.fail('unsafe retry') }).state, 'busy');
  assert.equal(attempt(f, failed).commands.at(-1).ownershipUncertain, true);
});


test('explicit CI cache preparation is classified and every actual compile/test stays offline', async t => {
  const f = await fixture(t), r = runner(f), before = process.env.GITHUB_ACTIONS;
  delete process.env.GITHUB_ACTIONS;
  assert.throws(() => buildCodex({ ...f.args, prepareCache: true, run: r.run }), /CI-only/);
  try {
    process.env.GITHUB_ACTIONS = 'true';
    const calls = [];
    const run = (cmd, args, opts) => { calls.push({ cmd, args, env: opts.env }); return args.includes('fetch') ? { status: 0 } : r.run(cmd, args, opts); };
    assert.equal(buildCodex({ ...f.args, prepareCache: true, run }).state, 'validated');
    for (const call of calls.filter(c => c.cmd === 'cargo')) {
      const network = call.args.includes('update') || call.args.includes('fetch');
      assert.equal(call.env.CARGO_NET_OFFLINE, network ? 'false' : 'true');
      if (call.args.includes('build') || call.args.includes('test')) assert.ok(call.args.includes('--offline'));
      assert.ok(call.env.RUSTY_V8_ARCHIVE.startsWith(f.args.stateRoot));
    }
  } finally { if (before === undefined) delete process.env.GITHUB_ACTIONS; else process.env.GITHUB_ACTIONS = before; }
});


test('finalization appends native pins only when they match the validated provisional native inventory', async t => {
  const { finalizeCandidate } = await import('../fork/lib/state.mjs');
  const f = await fixture(t), directory = join(f.args.stateRoot, 'cargo-home/native-v8'); mkdirSync(directory, { recursive: true });
  const assets = ['src_binding_fixture.rs', 'librusty_v8_fixture.a.gz'].map(name => { const bytes = `synthetic ${name}`; writeFileSync(join(directory, name), bytes); return { name, url: `https://github.com/denoland/rusty_v8/releases/download/v0.0.0/${name}`, sha256: sha256(bytes) }; });
  assert.equal(buildCodex({ ...f.args, run: runner(f).run }).state, 'validated');
  assert.throws(() => finalizeCandidate({ manifest: f.args.manifest, stateRoot: f.args.stateRoot }), /exact declared pins/);
  const finalized = finalizeCandidate({ manifest: f.args.manifest, stateRoot: f.args.stateRoot, nativeAssets: assets });
  assert.deepEqual(finalized.manifest.native_assets, assets);
  const updated = { ...f, args: { ...f.args, manifest: finalized.manifest } };
  assert.equal(buildCodex({ ...updated.args, run: runner(updated).run }).state, 'validated');
});

test('build job selection reaches Cargo and refuses values above the owner ceiling', async t => {
  const f = await fixture(t), r = runner(f);
  assert.throws(() => buildCodex({ ...f.args, jobs: 17, run: r.run }), /between 1 and 16/);
  assert.equal(r.calls.length, 0);
  assert.equal(buildCodex({ ...f.args, jobs: 16, run: r.run }).state, 'validated');
  for (const call of r.calls) {
    assert.equal(call.env.CARGO_BUILD_JOBS, '16');
    if (call.args.includes('build') || call.args.includes('test')) assert.equal(call.args[call.args.indexOf('--jobs') + 1], '16');
  }
});


test('Alt+U build coverage requires each behavior test once, passed and not filtered out', () => {
  const passed = requiredAltUTests.map(name => `test ${name} ... ok`).join('\n');
  const summary = '\ntest result: ok. 4 passed; 0 failed; 0 ignored; 123 filtered out;\n';
  assert.equal(completeAltUCoverage(passed + summary), true);
  assert.equal(completeAltUCoverage((passed + summary).replaceAll("ok", "\x1b[32mok\x1b[0m")), true);
  for (const output of [summary, passed, passed.replace(requiredAltUTests[0], 'other') + summary,
    passed.replace('... ok', '... FAILED') + summary, passed + '\n' + passed + summary]) {
    assert.equal(completeAltUCoverage(output), false);
  }
});
