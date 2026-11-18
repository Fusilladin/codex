import { readFileSync, mkdirSync, mkdtempSync, writeFileSync, openSync, closeSync, realpathSync, readdirSync, lstatSync, readlinkSync } from 'node:fs';
import { join, dirname, isAbsolute } from 'node:path';
import { spawnSync } from 'node:child_process';
import { sha256, validateManifest, invalid } from './manifest.mjs';
import { withLock, checkRelease, rememberTag, atomicJSON } from './state.mjs';

// Receipts are private local state: the dedicated state parent must be trusted.
export function sourceFingerprint(source) {
  const files = Object.create(null);
  function walk(dir, prefix = '') {
    for (const name of readdirSync(dir).sort()) {
      const path = prefix ? `${prefix}/${name}` : name;
      const full = join(dir, name), stat = lstatSync(full);
      if (stat.isSymbolicLink()) files[path] = { link: readlinkSync(full) };
      else if (stat.isDirectory()) walk(full, path);
      else if (stat.isFile()) files[path] = { sha256: sha256(readFileSync(full)), executable: Boolean(stat.mode & 0o111) };
      else throw invalid('Unsupported source entry');
    }
  }
  walk(source);
  return files;
}
function gitEnv(source) {
  // Never inherit discovery, index, object replacement or injected config state.
  return { PATH: process.env.PATH, LC_ALL: 'C', GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0',
    GIT_NO_REPLACE_OBJECTS: '1', GIT_OPTIONAL_LOCKS: '0',
    GIT_CEILING_DIRECTORIES: dirname(realpathSync(source)) };
}
const succeeded = result => !result.error && !result.signal && result.status === 0;
function git(source, args, input) {
  return spawnSync('git', ['-C', source, ...args], {
    env: gitEnv(source), encoding: 'utf8', input, maxBuffer: 8 * 1024 * 1024,
  });
}
function patchPaths(text) {
  const paths = [...new Set([...text.matchAll(/^(?:--- a|\+\+\+ b)\/(.+)$/gm)].map(x => x[1]))];
  if (!paths.length || paths.some(p => isAbsolute(p) || p.split('/').some(c => c === '..' || c === '.git') || p.includes('\\'))) {
    throw invalid('Invalid patch paths');
  }
  return paths;
}
function fingerprint(source, path) {
  try { return sha256(readFileSync(join(source, path))); }
  catch (e) { if (e.code === 'ENOENT') return null; throw e; }
}
export function verifyPatches(m, patchDir) {
  validateManifest(m);
  return m.patches.map(p => {
    const bytes = readFileSync(join(patchDir, p.file));
    if (sha256(bytes) !== p.sha256) throw invalid('Patch bytes do not match manifest');
    const text = bytes.toString('utf8');
    return { ...p, bytes, text, paths: patchPaths(text) };
  });
}
export function applyPatches(m, patchDir, source, reportDir) {
  const patches = verifyPatches(m, patchDir); // verify all before any application
  for (const p of patches) {
    const before = p.paths.map(path => fingerprint(source, path));
    if (!succeeded(git(source, ['apply', '--check', '-'], p.bytes))) {
      const reversed = succeeded(git(source, ['apply', '--reverse', '--check', '-'], p.bytes));
      // Derive diagnostics only from validated patch text; never echo git stderr/host paths.
      const files = [...p.text.matchAll(/^\+\+\+ b\/(.+)$/gm)].map(x => x[1]);
      const hunks = [...p.text.matchAll(/^@@ (.+?) @@/gm)].map(x => x[1]);
      const result = { state: reversed ? 'already-applied' : 'conflict', patch: p.file, files, hunks, action: 'Review patch against pinned source; no fuzzy application performed' };
      mkdirSync(reportDir, { recursive: true });
      atomicJSON(join(reportDir, 'conflict.json'), result);
      return result;
    }
    if (!succeeded(git(source, ['apply', '-'], p.bytes))) throw invalid('Patch could not be written');
    if (p.paths.some((path, i) => fingerprint(source, path) === before[i]) ||
        !succeeded(git(source, ['apply', '--reverse', '--check', '-'], p.bytes))) {
      throw invalid('Patch did not change every required path');
    }
  }
  return { state: 'prepared' };
}
export function prepare({ manifest: m, release, source, patchDir, stateRoot, baseline = false, run = spawnSync }) {
  validateManifest(m);
  if (typeof baseline !== 'boolean' || (baseline && release !== undefined)) throw invalid('Baseline uses only the exact manifest identity');
  if (baseline) release = m.upstream;
  const eligible = state => state === 'new-release' || (baseline && state === 'up-to-date');
  const initial = checkRelease(m, release, stateRoot);
  if (!eligible(initial.state)) return initial;
  return withLock(stateRoot, initial.key, ownership => {
    const check = checkRelease(m, release, stateRoot, ownership);
    if (!eligible(check.state)) return check;
    verifyPatches(m, patchDir);
    const resolved = git(source, ['rev-parse', `${release.commit}^{commit}`]);
    if (!succeeded(resolved) || resolved.stdout.trim() !== release.commit) throw invalid('Source lacks exact release commit');
    rememberTag(stateRoot, release);
    mkdirSync(join(stateRoot, 'attempts'), { recursive: true });
    const attempt = mkdtempSync(join(stateRoot, 'attempts', `${check.key}-`));
    const workspace = join(attempt, 'source');
    mkdirSync(workspace);
    // Archive objects, never the caller's dirty worktree. No original source mutation.
    const archivePath = join(attempt, 'source.tar');
    const fd = openSync(archivePath, 'wx', 0o600);
    let archive;
    try {
      archive = run('git', ['-C', source, 'archive', '--format=tar', release.commit], {
        env: gitEnv(source), stdio: ['ignore', fd, 'ignore'],
      });
    } finally { closeSync(fd); }
    const fail = stage => {
      atomicJSON(join(attempt, 'failure.json'), { state: 'invalid-input', stage, message: 'Candidate preparation failed; process details redacted' });
      throw invalid(stage === 'archive' ? 'Cannot archive pinned source' : 'Cannot create candidate workspace');
    };
    if (!succeeded(archive)) fail('archive');
    const extract = run('tar', ['-xf', archivePath, '--no-same-owner', '-C', workspace], {
      env: { PATH: process.env.PATH, LC_ALL: 'C' }, stdio: 'ignore',
    });
    if (!succeeded(extract)) fail('extract');
    const applied = applyPatches(m, patchDir, workspace, attempt);
    if (applied.state !== 'prepared') return { ...applied, key: check.key };
    const next = baseline ? structuredClone(m) : { ...m, upstream: { ...m.upstream, ...release }, fork_version: `${release.tag.slice(6)}-p${m.fork_version.split('-p')[1]}`, lockfile_sha256: null, production_ready: false };
    const inputHash = sha256(JSON.stringify(next));
    const provenance = { schema: 1, kind: 'prepared-archive', key: check.key,
      commit: release.commit, inputHash, source: realpathSync(workspace),
      archiveHash: sha256(readFileSync(archivePath)), files: sourceFingerprint(workspace) };
    atomicJSON(join(attempt, 'provenance.json'), provenance);
    const candidate = { schema: 1, previousCommit: m.upstream.commit, key: check.key, state: 'prepared-not-built', manifest: next,
      inputHash, prepareAttempt: realpathSync(attempt), source: realpathSync(workspace),
      provenanceHash: sha256(JSON.stringify(provenance)), buildAttempts: [] };
    atomicJSON(join(attempt, 'manifest.json'), next);
    writeFileSync(join(attempt, 'PR-BODY.md'), `# Candidate ${release.tag}\n\nCommit: ${release.commit}\nPatchset: ${m.patchset_sha256}\nCompare: https://github.com/openai/codex/compare/${m.upstream.commit}...${release.commit}\n\nP1 preparation only. NOT built, tested or released. CI must build and run behavioral tests before publishing a PR. No live PR created.\n`);
    mkdirSync(join(stateRoot, 'candidates'), { recursive: true });
    atomicJSON(join(stateRoot, 'candidates', `${check.key}.json`), candidate);
    return { state: 'prepared', key: check.key, built: false, published: false };
  });
}
