import { mkdirSync, readFileSync, writeFileSync, openSync, closeSync, realpathSync, lstatSync, existsSync, renameSync, copyFileSync, readdirSync } from 'node:fs';
import { join, resolve, relative, isAbsolute, dirname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { compilerPolicy } from './compiler-policy.mjs';
import { candidateKey, sha256, validateManifest, invalid } from './manifest.mjs';
import { supervisedRun } from './process-runner.mjs';
import { atomicJSON, readJSON, withLock, retainLock } from './state.mjs';
import { verifyPatches, sourceFingerprint } from './patches.mjs';

const kit = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const lockPath = 'codex-rs/Cargo.lock';
export const requiredScrollTests = [
  'pager_overlay::tests::scroll_40_static_pager_steps_and_bounds',
  'transcript_view::input::tests::scroll_40_transcript_pager_steps_and_bounds',
  'transcript_view::input::tests::scroll_40_transcript_ordinary_input_steps_and_bounds',
];
export function completeScrollCoverage(output) {
  const clean = output.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').replace(/\r/g, '');
  const lines = clean.split('\n').map(line => line.trim());
  return requiredScrollTests.every(name => lines.filter(line => line.startsWith(`test ${name} ... `)).length === 1 && lines.includes(`test ${name} ... ok`)) &&
    /test result: ok\. 3 passed; 0 failed; 0 ignored;/.test(clean);
}
const ok = r => r && !r.error && !r.signal && r.status === 0;
const inside = (parent, child) => { const p = relative(parent, child); return p !== '' && !p.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) && p !== '..' && !isAbsolute(p); };
const drift = () => Object.assign(new Error('Unsupported or non-workspace lock drift'), { state: 'lock-drift', code: 22 });

// Deliberately narrow Cargo.lock v3/v4 grammar. Unknown fields/tables fail closed.
export function parseLock(text) {
  const lines = text.split('\n');
  let version, record, array = false;
  const packages = [];
  const string = value => { try { return JSON.parse(value); } catch { throw drift(); } };
  for (let raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    if (line === '[[package]]' && !array) { record = {}; packages.push(record); continue; }
    if (array) {
      if (line === ']') { array = false; continue; }
      if (!/^"(?:[^"\\]|\\.)*",?$/.test(line)) throw drift();
      record.dependencies.push(string(line.replace(/,$/, ''))); continue;
    }
    const m = /^(version|name|source|checksum|dependencies) = (.+)$/.exec(line);
    if (!m) throw drift();
    const [, key, value] = m;
    if (!record) {
      if (key !== 'version' || version || !/^[34]$/.test(value)) throw drift();
      version = Number(value); continue;
    }
    if (key in record) throw drift();
    if (key === 'dependencies') {
      if (!['[', '[]'].includes(value)) throw drift();
      record.dependencies = []; array = value === '[';
    } else {
      if (!/^"(?:[^"\\]|\\.)*"$/.test(value)) throw drift();
      record[key] = string(value);
    }
  }
  if (!version || array || !packages.length) throw drift();
  const ids = new Set();
  for (const p of packages) {
    if (!/^[a-zA-Z0-9_-]+$/.test(p.name ?? '') || !/^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/.test(p.version ?? '')) throw drift();
    if (p.source !== undefined && !/^(?:registry|git)\+\S+$/.test(p.source)) throw drift();
    if (p.checksum !== undefined && !/^[a-f0-9]{64}$/.test(p.checksum)) throw drift();
    const id = `${p.name}|${p.version}|${p.source ?? ''}`;
    if (ids.has(id)) throw drift();
    ids.add(id);
  }
  return { version, packages };
}
export function compareLocks(before, after, members) {
  if (before.version !== after.version || !members.length) throw drift();
  const workspace = new Map(members.map(p => [p.name, p.version]));
  if (workspace.size !== members.length) throw drift();
  const changes = new Map();
  for (const [name, version] of workspace) {
    const a = before.packages.filter(p => p.name === name && !p.source);
    const b = after.packages.filter(p => p.name === name && !p.source);
    if (a.length !== 1 || b.length !== 1 || b[0].version !== version || a[0].checksum || b[0].checksum) throw drift();
    changes.set(`${name} ${a[0].version}`, `${name} ${version}`);
  }
  const normalize = (data, old) => data.packages.map(p => {
    const q = { ...p, dependencies: (p.dependencies ?? []).map(d => old ? (changes.get(d) ?? d) : d).sort() };
    if (!p.source && workspace.has(p.name)) q.version = workspace.get(p.name);
    return q;
  }).sort((a, b) => `${a.name}|${a.version}|${a.source ?? ''}`.localeCompare(`${b.name}|${b.version}|${b.source ?? ''}`));
  if (JSON.stringify(normalize(before, true)) !== JSON.stringify(normalize(after, false))) throw drift();
  return { before, after, members };
}
function workspaceMembers(text, source) {
  let data; try { data = JSON.parse(text); } catch { throw drift(); }
  if (!Array.isArray(data.workspace_members) || !Array.isArray(data.packages)) throw drift();
  const members = data.workspace_members.map(id => {
    const p = data.packages.find(p => p.id === id);
    if (!p || p.source != null || !inside(source, resolve(p.manifest_path ?? '')) || !/^[\w-]+$/.test(p.name) || !/^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/.test(p.version)) throw drift();
    return { name: p.name, version: p.version };
  });
  return members;
}
// Resolve each component without ever following an outside intermediate link.
function checkedLinks(source, files) {
  const resolveParts = (parts, seen = new Set()) => {
    let current = source;
    for (let i = 0; i < parts.length; i++) {
      current = resolve(current, parts[i]);
      if (current !== source && !inside(source, current)) throw invalid('Unsafe source link');
      const entry = files[relative(source, current).split(sep).join('/')];
      if (entry && 'link' in entry) {
        if (seen.has(current)) throw invalid('Cyclic source link');
        const next = new Set(seen); next.add(current);
        const destination = resolve(dirname(current), entry.link);
        if (!inside(source, destination)) throw invalid('Unsafe source link');
        const parts = isAbsolute(entry.link) ? relative(source, destination).split(sep) : [...relative(source, dirname(current)).split(sep), ...entry.link.split(sep)];
        current = resolveParts(parts, next);
      } else if (i < parts.length - 1 && !lstatSync(current).isDirectory()) throw invalid('Invalid source link component');
    }
    return current;
  };
  for (const [path, entry] of Object.entries(files)) {
    if (!('link' in entry)) continue;
    const destination = resolveParts(path.split('/'));
    const expected = files[relative(source, destination).split(sep).join('/')];
    if (!expected?.sha256 || !lstatSync(destination).isFile() || sha256(readFileSync(destination)) !== expected.sha256) throw invalid('Invalid source link referent');
  }
}
function safeDirectory(path) {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  if (realpathSync(path) !== path) throw invalid('Unsafe compilation storage');
  return path;
}
function checkedSource(m, source, root, storageBase) {
  const base = realpathSync(storageBase), actualRoot = realpathSync(root);
  if (!inside(base, actualRoot)) throw invalid('Build state must be a dedicated child of project storage');
  const key = candidateKey(m), path = join(root, 'candidates', `${key}.json`);
  const candidate = readJSON(path);
  if (!candidate || candidate.key !== key || candidate.inputHash !== sha256(JSON.stringify(m))) throw invalid('Exact prepared candidate required');
  const attempt = realpathSync(candidate.prepareAttempt);
  if (!inside(join(actualRoot, 'attempts'), attempt) || dirname(attempt) !== join(actualRoot, 'attempts') ||
      realpathSync(source) !== join(attempt, 'source') || candidate.source !== realpathSync(source)) throw invalid('Unsafe or unrelated prepared source');
  const provenance = readJSON(join(attempt, 'provenance.json'));
  if (!provenance || provenance.kind !== 'prepared-archive' || provenance.commit !== m.upstream.commit ||
      provenance.key !== key || provenance.inputHash !== (candidate.initialInputHash ?? candidate.inputHash) || provenance.source !== candidate.source ||
      sha256(JSON.stringify(provenance)) !== candidate.provenanceHash ||
      sha256(readFileSync(join(attempt, 'source.tar'))) !== provenance.archiveHash) throw invalid('Source provenance mismatch');
  const expected = structuredClone(provenance.files);
  if (candidate.refreshedLockHash) expected[lockPath] = { ...expected[lockPath], sha256: candidate.refreshedLockHash };
  const actual = sourceFingerprint(source);
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw invalid('Source has unaccounted changes');
  checkedLinks(source, actual);
  if (candidate.refreshedLockHash && m.lockfile_sha256 && candidate.refreshedLockHash !== m.lockfile_sha256) throw invalid('Resumed refreshed lock pin mismatch');
  const toolchain = readFileSync(join(source, 'codex-rs/rust-toolchain.toml'), 'utf8');
  const channels = [...toolchain.matchAll(/^\s*channel\s*=\s*"([^"]+)"\s*(?:#.*)?$/gm)];
  if (channels.length !== 1 || channels[0][1] !== m.toolchain) throw invalid('Pinned source toolchain mismatch');
  return { candidate, path, actual, pristineLock: provenance.files[lockPath]?.sha256 };
}

// Only prepare-produced archives in dedicated project storage are supported.
// storageBase is injectable for a private host driver and tiny fixture tests.
export function buildCodex({ manifest: m, source, stateRoot: root, patchDir, local, offline,
  prepareCache = false, jobs = 4, run = supervisedRun, deadlineMs = 60 * 60 * 1000, storageBase = join(kit, '.work') }) {
  validateManifest(m);
  if (!Number.isSafeInteger(jobs) || jobs < 1 || jobs > 16) throw invalid('Build jobs must be between 1 and 16');
  if (typeof prepareCache !== 'boolean' || prepareCache && process.env.GITHUB_ACTIONS !== 'true') throw invalid('Explicit CI-only cache preparation required');
  if (!Number.isSafeInteger(deadlineMs) || deadlineMs < 100 || deadlineMs > 4 * 60 * 60 * 1000) throw invalid('Invalid aggregate build deadline');
  const deadline = Date.now() + deadlineMs;
  if (local !== true || offline !== true || !root || !source) throw invalid('Build requires --local --offline --state and --source');
  source = realpathSync(source); root = realpathSync(root);
  verifyPatches(m, patchDir);
  // Validate location before withLock creates anything.
  storageBase = realpathSync(storageBase);
  if (!inside(storageBase, root)) throw invalid('Unsafe build state root');
  // Shared across candidates in this state, not merely the candidate lock.
  const targetKey = sha256(`compilation|${m.target}|${m.toolchain}`);
  return withLock(root, targetKey, targetOwnership => withLock(root, candidateKey(m), candidateOwnership => {
    const { candidate, path, actual, pristineLock } = checkedSource(m, source, root, storageBase);
    const id = randomUUID(), evidence = join(root, 'build-attempts', id);
    mkdirSync(evidence, { recursive: true, mode: 0o700 });
    const target = safeDirectory(join(safeDirectory(join(root, 'compilation')), targetKey));
    const artifacts = safeDirectory(join(evidence, 'artifacts'));
    const receipt = { schema: 1, networkPreparation: prepareCache, executionKind: run === supervisedRun ? 'host' : 'fixture', id, key: candidate.key, inputHash: candidate.inputHash,
      source, target, pristineLockHash: pristineLock, expectedLockHash: m.lockfile_sha256, prepareAttempt: candidate.prepareAttempt, startedAt: new Date().toISOString(), state: 'building', commands: [], artifacts: [], published: false };
    candidate.buildAttempts ??= [];
    candidate.buildAttempts.push(id);
    candidate.state = 'prepared-not-built';
    const save = () => { atomicJSON(join(evidence, 'attempt.json'), receipt); atomicJSON(path, candidate); };
    save();
    const policy = compilerPolicy({ home: homedir(), root, source });
    receipt.compilerPolicy = policy;
    const env = { PATH: process.env.PATH, LC_ALL: 'C', HOME: join(evidence, 'home'),
      CARGO_HOME: join(root, 'cargo-home'), CARGO_TARGET_DIR: target,
      RUSTY_V8_ARCHIVE: join(root, 'cargo-home/native-v8'),
      RUSTUP_HOME: process.env.RUSTUP_HOME ?? join(homedir(), '.rustup'),
      RUSTUP_AUTO_INSTALL: '0', RUSTUP_TOOLCHAIN: m.toolchain,
      ...policy.env,
      CARGO_NET_OFFLINE: 'true', CARGO_BUILD_JOBS: String(jobs) };
    mkdirSync(env.HOME); safeDirectory(env.CARGO_HOME); safeDirectory(env.RUSTY_V8_ARCHIVE);
    const exec = (stage, command, args, network = false) => {
      receipt.stage = stage; save();
      const output = join(evidence, `${receipt.commands.length}-${stage}.log`);
      const errorOutput = `${output}.stderr`;
      const fd = openSync(output, 'wx', 0o600), errfd = openSync(errorOutput, 'wx', 0o600);
      let result;
      try { result = Date.now() >= deadline - 5000 ? { status: null, error: new Error('Aggregate deadline reached') } : run(command, args, { cwd: join(source, 'codex-rs'), env: network ? { ...env, CARGO_NET_OFFLINE: 'false' } : env, stdio: ['ignore', fd, errfd], deadline: deadline - 5000, processReport: join(evidence, `${receipt.commands.length}-process.json`) }); }
      catch (error) { result = { error }; }
      finally { closeSync(fd); closeSync(errfd); }
      // Injected runners may return captured output instead of writing the provided fd.
      if (result?.stdout) writeFileSync(output, result.stdout, { flag: 'a' });
      if (result?.stderr || result?.error) writeFileSync(errorOutput, String(result.stderr ?? result.error), { flag: 'a' });
      if (result?.ownershipUncertain) { retainLock(targetOwnership); retainLock(candidateOwnership); }
      receipt.commands.push({ supervision: result?.supervision, ownershipUncertain: Boolean(result?.ownershipUncertain), stage, command, args, output, errorOutput, status: result?.status ?? null,
        signal: result?.signal ?? null, processError: Boolean(result?.error) });
      receipt.stage = stage; save();
      return { success: ok(result), text: readFileSync(output, 'utf8') };
    };
    const fail = state => { receipt.state = state; receipt.finishedAt = new Date().toISOString(); candidate.state = state; save(); return { state, key: candidate.key, attempt: id, validated: false, published: false }; };
    try {
    receipt.nativeArtifacts = readdirSync(env.RUSTY_V8_ARCHIVE).sort().map(name => {
      const path = join(env.RUSTY_V8_ARCHIVE, name), stat = lstatSync(path);
      if (!stat.isFile() || stat.isSymbolicLink() || !/^(?:src_binding[A-Za-z0-9_-]*\.rs|librusty_v8[A-Za-z0-9_.-]*\.a(?:\.gz)?)$/.test(name)) throw invalid('Unsafe native cache entry');
      return { name, sha256: sha256(readFileSync(path)) };
    });
    if (m.native_assets && JSON.stringify(receipt.nativeArtifacts) !== JSON.stringify(m.native_assets.map(({ name, sha256 }) => ({ name, sha256 })).sort((a, b) => a.name.localeCompare(b.name)))) throw invalid('Native cache pin mismatch');
    save();
      const nativeNeeded = parseLock(readFileSync(join(source, lockPath), 'utf8')).packages.some(p => p.name === 'v8');
      if (nativeNeeded && (!receipt.nativeArtifacts.some(a => a.name.startsWith('src_binding')) || !receipt.nativeArtifacts.some(a => a.name.startsWith('librusty_v8')))) {
        receipt.stage = 'native-preflight'; receipt.failure = 'Pinned V8 generated binding and static archive are missing from the local native cache; no download or compilation started';
        return fail('build-failed');
      }
      const rust = exec('toolchain', 'rustc', [`+${m.toolchain}`, '--version']);
      if (!rust.success || !rust.text.startsWith(`rustc ${m.toolchain} `)) return fail('build-failed');
      const beforeText = readFileSync(join(source, lockPath), 'utf8');
      writeFileSync(join(evidence, 'Cargo.lock.before'), beforeText, { flag: 'wx', mode: 0o600 });
      receipt.beforeLockHash = sha256(beforeText); save();
      const before = parseLock(beforeText);
      const metadata = exec('metadata', 'cargo', [`+${m.toolchain}`, 'metadata', '--format-version', '1', '--no-deps', '--offline']);
      if (!metadata.success) return fail('build-failed');
      const members = workspaceMembers(metadata.text, source);
      if (JSON.stringify(sourceFingerprint(source)) !== JSON.stringify(actual)) throw drift();
      const refresh = exec('lock-refresh', 'cargo', [`+${m.toolchain}`, 'update', '--workspace', ...(prepareCache ? [] : ['--offline'])], prepareCache);
      const afterText = readFileSync(join(source, lockPath), 'utf8');
      writeFileSync(join(evidence, 'Cargo.lock.after'), afterText, { flag: 'wx', mode: 0o600 });
      receipt.afterLockHash = sha256(afterText); save();
      if (!refresh.success && afterText === beforeText) {
        atomicJSON(join(evidence, 'lock-comparison.json'), { classification: 'unchanged', beforeHash: sha256(beforeText), afterHash: sha256(afterText) });
        if (JSON.stringify(sourceFingerprint(source)) !== JSON.stringify(actual)) throw drift();
        return fail('build-failed');
      }
      let comparison;
      try {
        comparison = compareLocks(before, parseLock(afterText), members);
        atomicJSON(join(evidence, 'lock-comparison.json'), { classification: 'workspace-only', ...comparison });
      } catch (error) {
        atomicJSON(join(evidence, 'lock-comparison.json'), { classification: 'lock-drift', beforeHash: sha256(beforeText), afterHash: sha256(afterText) });
        throw error;
      }
      const after = sourceFingerprint(source);
      const expected = { ...actual, [lockPath]: { ...actual[lockPath], sha256: sha256(afterText) } };
      if (JSON.stringify(after) !== JSON.stringify(expected)) throw drift();
      candidate.refreshedLockHash = receipt.refreshedLockHash = sha256(afterText);
      save();
      if (m.lockfile_sha256 && m.lockfile_sha256 !== receipt.refreshedLockHash) return fail('lock-drift');
      if (!refresh.success) return fail('build-failed');
      if (prepareCache && !exec('cache-fetch', 'cargo', [`+${m.toolchain}`, 'fetch', '--locked', '--target', m.target], true).success) return fail('build-failed');
      for (const bin of m.bins) {
        const releaseDir = safeDirectory(join(safeDirectory(join(target, m.target)), 'release'));
        const artifact = join(releaseDir, bin);
        // Cargo success must not accept bytes left by a preceding attempt.
        let previous;
        try { previous = lstatSync(artifact); } catch (error) { if (error.code !== 'ENOENT') throw error; }
        if (previous) {
          const prior = safeDirectory(join(evidence, 'prior-outputs'));
          if (!previous.isFile()) throw invalid('Unsafe existing build output');
          renameSync(artifact, join(prior, bin));
        }
        const result = exec(`build-${bin}`, 'cargo', [`+${m.toolchain}`, 'build', '--release', '--locked', '--offline', '--target', m.target, '--jobs', String(jobs), '--bin', bin]);
        if (!result.success) return fail('build-failed');
        if (realpathSync(releaseDir) !== releaseDir) return fail('build-failed');
        if (!existsSync(artifact) || !lstatSync(artifact).isFile() || !(lstatSync(artifact).mode & 0o111) || !lstatSync(artifact).size) return fail('build-failed');
        const frozen = join(artifacts, bin);
        copyFileSync(artifact, frozen);
        receipt.artifacts.push({ bin, path: frozen, buildPath: artifact, sha256: sha256(readFileSync(frozen)) });
      }
      const tests = exec('scroll-tests', 'cargo', [`+${m.toolchain}`, 'test', '-p', 'codex-tui', '--locked', '--offline', '--target', m.target, '--jobs', String(jobs), 'scroll_40']);
      if (!tests.success || !completeScrollCoverage(tests.text)) return fail('test-failed');
      if (JSON.stringify(sourceFingerprint(source)) !== JSON.stringify(expected) ||
          receipt.nativeArtifacts.some(a => !lstatSync(join(env.RUSTY_V8_ARCHIVE, a.name)).isFile() || sha256(readFileSync(join(env.RUSTY_V8_ARCHIVE, a.name))) !== a.sha256) ||
          receipt.artifacts.some(a => !lstatSync(a.path).isFile() || !(lstatSync(a.path).mode & 0o111) || sha256(readFileSync(a.path)) !== a.sha256 || sha256(readFileSync(a.buildPath)) !== a.sha256)) return fail('build-failed');
      receipt.state = candidate.state = 'validated'; receipt.finishedAt = new Date().toISOString();
      candidate.lastValidatedAttempt = id; candidate.validatedReceiptHash = sha256(JSON.stringify(receipt)); save();
      return { state: 'validated', key: candidate.key, attempt: id, validated: true, published: false };
    } catch (error) {
      receipt.failure = error.state ? error.message : 'Build input validation failed (details redacted)';
      return fail(error.state === 'lock-drift' ? 'lock-drift' : 'build-failed');
    }
  }, { resource: 'candidate', source }), { resource: 'compilation', targetKey, storageBase });
}

