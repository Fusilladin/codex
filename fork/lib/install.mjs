import { readFileSync, writeFileSync, mkdirSync, symlinkSync, readlinkSync, renameSync, lstatSync, existsSync, realpathSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { invalid, sha256 } from './manifest.mjs';
import { atomicJSON, readJSON, withLock } from './state.mjs';
import { safeDirectory, safeExtract } from './safe-extract.mjs';

const versionOK = version => /^\d+\.\d+\.\d+-(?:p\d+|original)$/.test(version ?? '');
const installKey = sha256('codex installation');
const paths = home => { home = resolve(home); return { home, root: join(home, '.local/share/codex-fork'), launcher: join(home, '.local/bin/codex') }; };
function link(path, target) {
  const pending = `${path}.${randomUUID()}.pending`;
  symlinkSync(target, pending); renameSync(pending, path);
}
function load(root) { return readJSON(join(root, 'state.json'), { schema: 1, active: null, previous: null, versions: {} }); }
function verifyVersion(record, original = false) {
  if (!record || realpathSync(record.path) !== record.path) throw invalid('Retained version unavailable');
  safeDirectory(record.path); safeDirectory(join(record.path, 'bin'));
  const expected = original ? ['bin/codex'] : packagePolicy.allowedFiles;
  if (!record.hashes || JSON.stringify(Object.keys(record.hashes).sort()) !== JSON.stringify([...expected].sort())) throw invalid('Retained version inventory changed');
  for (const name of expected) {
    const path = join(record.path, name), stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink() || name.startsWith('bin/') && !(stat.mode & 0o111) || sha256(readFileSync(path)) !== record.hashes[name]) throw invalid('Retained version changed');
  }
}
function entry(path) { try { return lstatSync(path); } catch (error) { if (error.code === 'ENOENT') return null; throw error; } }
function managedLinks(p, state) {
  const active = state.versions[state.active], current = join(p.root, 'current');
  const c = entry(current), launcher = entry(p.launcher);
  if (c && (!c.isSymbolicLink() || !active || readlinkSync(current) !== active.path)) throw invalid('Unmanaged current path refused');
  if (launcher && (!launcher.isSymbolicLink() || !active || realpathSync(p.launcher) !== join(active.path, 'bin/codex'))) throw invalid('Unmanaged launcher refused');
}
function smoke(root, record, manifest, fixture, probe) {
  const home = join(root, 'isolated', randomUUID()); safeDirectory(home);
  const env = { PATH: process.env.PATH, HOME: home, CODEX_HOME: join(home, 'codex'), XDG_CONFIG_HOME: join(home, 'config') };
  const result = spawnSync(join(record.path, 'bin/codex'), ['--version'], { env, encoding: 'utf8', timeout: 10000 });
  if (result.error || result.signal || result.status !== 0 || result.stdout.trim() !== `codex-cli ${manifest.upstream.tag.slice(6)}`) throw invalid('Installed binary smoke failed');
  if (!fixture) {
    if (typeof probe !== 'function') throw invalid('Behavioral patch probe required');
    const checked = probe({ directory: record.path, manifest, env });
    const expected = { pager24: 9, pager60: 24, transcript24: 9, transcript60: 24 };
    if (checked?.then || checked?.verdict !== 'PASS' || checked.binaryHash !== record.hashes['bin/codex'] || !Object.entries(expected).every(([key, value]) => checked.steps?.[key] === value)) throw invalid('Behavioral patch probe failed');
    verifyVersion(record);
  }
}
function activate(p, state, version) {
  const record = state.versions[version]; verifyVersion(record, record.original);
  managedLinks(p, state);
  const next = { ...state, previous: state.active, active: version };
  const journal = { schema: 1, next, target: record.path, version };
  atomicJSON(join(p.root, 'transaction.json'), journal);
  link(join(p.root, 'current'), record.path);
  link(p.launcher, join(p.root, 'current/bin/codex'));
  atomicJSON(join(p.root, 'state.json'), next);
  atomicJSON(join(p.root, 'transaction.json'), { schema: 1, complete: true, version });
  return { state: 'active', active: version, previous: next.previous };
}
export function recoverInstall({ home }) {
  const p = paths(home); safeDirectory(p.root); safeDirectory(dirname(p.launcher));
  return withLock(p.root, installKey, () => {
    const journal = readJSON(join(p.root, 'transaction.json'));
    if (!journal || journal.complete) return { state: 'recovered', active: load(p.root).active };
    const record = journal.next?.versions?.[journal.version];
    if (!versionOK(journal.version) || record?.path !== journal.target) throw invalid('Invalid interrupted transaction');
    verifyVersion(record, record.original);
    const current = join(p.root, 'current');
    if (!entry(current) || !entry(current).isSymbolicLink() || readlinkSync(current) !== journal.target) {
      const state = load(p.root); managedLinks(p, state);
      const retained = { ...state, versions: { ...state.versions, [journal.version]: record } };
      atomicJSON(join(p.root, 'state.json'), retained);
      atomicJSON(join(p.root, 'transaction.json'), { schema: 1, complete: true, aborted: true, version: state.active });
      return { state: 'recovered', active: state.active, aborted: true };
    }
    const launcher = entry(p.launcher), old = load(p.root), original = old.versions[old.active];
    if (launcher && (!launcher.isSymbolicLink() || ![join(record.path, 'bin/codex'), original && join(original.path, 'bin/codex')].includes(realpathSync(p.launcher)))) throw invalid('Unmanaged recovery launcher refused');
    link(p.launcher, join(p.root, 'current/bin/codex'));
    atomicJSON(join(p.root, 'state.json'), journal.next);
    atomicJSON(join(p.root, 'transaction.json'), { schema: 1, complete: true, version: journal.version });
    return { state: 'recovered', active: journal.version };
  });
}
export function install({ home, archive, sha256: expectedHash, fixture = false, verification, localArtifact, interrupt, probe }) {
  if (!home || !archive || !/^[a-f0-9]{64}$/.test(expectedHash ?? '')) throw invalid('Explicit install inputs required');
  const bytes = readFileSync(archive);
  if (sha256(bytes) !== expectedHash) throw invalid('Archive checksum mismatch');
  const locallyAuthorized = localArtifact?.schema === 1 && localArtifact.kind === 'owner-requested-local-artifact' && localArtifact.artifactHash === expectedHash && localArtifact.verdict === 'PASS' && /^[a-f0-9]{64}$/.test(localArtifact.binaryHash ?? '');
  if (typeof fixture !== 'boolean' || (!fixture && !locallyAuthorized && (verification?.verified !== true || verification.artifactHash !== expectedHash || !/^[a-f0-9]{40}$/.test(verification.commit ?? '')))) throw invalid('Exact local-artifact evidence or verified attestation required');
  const p = paths(home); safeDirectory(p.root); safeDirectory(dirname(p.launcher));
  return withLock(p.root, installKey, () => {
    const pending = readJSON(join(p.root, 'transaction.json'));
    if (pending && !pending.complete) throw invalid('Interrupted activation requires recovery');
    const beforeState = load(p.root); managedLinks(p, beforeState);
    const versions = safeDirectory(join(p.root, 'versions')), incoming = safeDirectory(join(p.root, 'incoming'));
    const attempt = join(incoming, randomUUID()), m = safeExtract(bytes, attempt);
    if (!fixture && m.production_ready !== true) throw invalid('Non-release archive');
    const state = load(p.root), version = m.fork_version;
    if (state.versions[version] || existsSync(join(versions, version))) throw invalid('Version already installed');
    const record = { path: attempt, artifactHash: expectedHash, fixture, localOnly: locallyAuthorized, hashes: {} };
    const { allowedFiles } = packagePolicy;
    for (const name of allowedFiles) record.hashes[name] = sha256(readFileSync(join(attempt, name)));
    smoke(p.root, record, m, fixture, probe);
    if (interrupt === 'after-extract') throw invalid('Injected interruption after extraction');
    const destination = join(versions, version); renameSync(attempt, destination); record.path = destination;
    state.versions[version] = record;
    if (interrupt === 'before-switch') {
      atomicJSON(join(p.root, 'transaction.json'), { schema: 1, next: { ...state, previous: state.active, active: version }, target: destination, version });
      throw invalid('Injected interruption before switch');
    }
    if (interrupt === 'after-switch') {
      atomicJSON(join(p.root, 'transaction.json'), { schema: 1, next: { ...state, previous: state.active, active: version }, target: destination, version });
      link(join(p.root, 'current'), destination); throw invalid('Injected interruption after switch');
    }
    return activate(p, state, version);
  });
}
import * as packagePolicy from './package.mjs';
export function adoptOriginal({ home, directory, version }) {
  if (!versionOK(version) || !version.endsWith('-original')) throw invalid('Explicit original version required');
  const p = paths(home); safeDirectory(p.root);
  return withLock(p.root, installKey, () => {
    const state = load(p.root);
    if (state.active || state.versions[version]) throw invalid('Original adoption is first-use only');
    // The original installation has bin/codex, not a flattened codex executable.
    safeDirectory(realpathSync(directory)); safeDirectory(join(realpathSync(directory), 'bin'));
    if (!lstatSync(join(realpathSync(directory), 'bin/codex')).isFile()) throw invalid('Original executable must be a regular file');
    const record = { path: realpathSync(directory), original: true, hashes: { 'bin/codex': sha256(readFileSync(join(realpathSync(directory), 'bin/codex'))) } }; verifyVersion(record, true);
    state.versions[version] = record; state.active = version; atomicJSON(join(p.root, 'state.json'), state);
    return { state: 'adopted', active: version };
  });
}
export function rollback({ home, version }) {
  const p = paths(home); safeDirectory(p.root); safeDirectory(dirname(p.launcher));
  return withLock(p.root, installKey, () => {
    const pending = readJSON(join(p.root, 'transaction.json'));
    if (pending && !pending.complete) throw invalid('Recovery required');
    const state = load(p.root); version ??= state.previous;
    if (!versionOK(version) || !state.versions[version] || version === state.active) throw invalid('Unknown rollback version');
    return activate(p, state, version);
  });
}
export function status({ home }) { const state = load(paths(home).root); return { state: 'status', ...state }; }
export function list({ home }) { return { state: 'versions', versions: Object.keys(load(paths(home).root).versions).sort() }; }
export function runOld({ home, version, isolated, args = ['--version'] }) {
  if (!versionOK(version) || isolated !== true) throw invalid('Retained versions require explicit --isolated');
  const p = paths(home), state = load(p.root), record = state.versions[version]; verifyVersion(record, record?.original);
  const sandbox = join(p.root, 'isolated', randomUUID()); safeDirectory(sandbox);
  const result = spawnSync(join(record.path, 'bin/codex'), args, { env: { PATH: process.env.PATH, HOME: sandbox, CODEX_HOME: join(sandbox, 'codex'), XDG_CONFIG_HOME: join(sandbox, 'config') }, encoding: 'utf8', timeout: 10000 });
  if (result.error || result.signal || result.status !== 0) throw invalid('Retained version execution failed');
  return { state: 'ran', version, isolated: true, output: result.stdout };
}
