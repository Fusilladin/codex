import { mkdirSync, readFileSync, writeFileSync, renameSync, openSync, closeSync, lstatSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { processIdentity } from './process-runner.mjs';
import { candidateKey, invalid, sha256, validateManifest } from './manifest.mjs';
import { assertTagIdentity } from './upstream.mjs';

export const exits = { 'up-to-date': 0, 'candidate-exists': 0, 'new-release': 10, conflict: 20, 'already-applied': 21, 'lock-drift': 22, 'tag-moved': 23, 'build-failed': 30, 'test-failed': 31, busy: 40, 'invalid-input': 64 };
export function readJSON(path, fallback) {
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch (e) { if (e.code === 'ENOENT') return fallback; throw e; }
}
export function atomicJSON(path, value) {
  const temp = `${path}.${randomUUID()}.tmp`;
  writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  renameSync(temp, path);
}
export function stateRoot(root) {
  if (!root) throw invalid('Explicit state root required');
  return resolve(root);
}
// Opaque capabilities are valid only during the owning synchronous callback.
const ownedLocks = new WeakMap();
export function withLock(root, key, fn, metadata = {}) {
  if (!/^[a-f0-9]{64}$/.test(key)) throw invalid('Invalid lock key');
  root = stateRoot(root);
  mkdirSync(join(root, 'locks'), { recursive: true });
  const path = join(root, 'locks', key);
  let fd;
  try { fd = openSync(path, 'wx', 0o600); } catch (e) { if (e.code === 'EEXIST') return { state: 'busy', key }; throw e; }
  const ownership = { retained: false };
  const owner = { schema: 1, token: randomUUID(), ...processIdentity(), createdAt: new Date().toISOString(), command: process.argv.slice(0, 2), metadata };
  writeFileSync(fd, JSON.stringify(owner));
  const acquired = lstatSync(path);
  ownedLocks.set(ownership, path);
  try { return fn(ownership); } finally {
    ownedLocks.delete(ownership); closeSync(fd);
    if (!ownership.retained) {
      const current = lstatSync(path);
      if (current.ino !== acquired.ino || current.dev !== acquired.dev || readJSON(path)?.token !== owner.token) throw invalid('Lock ownership changed; recovery required');
      const archive = join(root, 'locks', '_archive', '20261117-released');
      mkdirSync(archive, { recursive: true });
      renameSync(path, join(archive, `${key}-${owner.token}.json`));
    }
  }
}
export function rememberTag(root, release) {
  assertTagIdentity(release);
  const dir = join(stateRoot(root), 'tags');
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${release.tag}.json`);
  try { writeFileSync(path, JSON.stringify(release), { flag: 'wx', mode: 0o600 }); }
  catch (e) {
    if (e.code !== 'EEXIST') throw e;
    assertTagIdentity(release, { [release.tag]: readJSON(path).commit });
  }
}
export function checkRelease(m, release, root, ownership) {
  root = stateRoot(root);
  assertTagIdentity(release, { [m.upstream.tag]: m.upstream.commit });
  const known = readJSON(join(root, 'tags', `${release.tag}.json`));
  if (known) assertTagIdentity(release, { [release.tag]: known.commit });
  const key = candidateKey(m, release.commit);
  const lockPath = join(root, 'locks', key);
  if (existsSync(lockPath) && ownedLocks.get(ownership) !== lockPath) return { state: 'busy', key };
  if (readJSON(join(root, 'candidates', `${key}.json`))) return { state: 'candidate-exists', key };
  return { state: release.commit === m.upstream.commit && release.tag === m.upstream.tag ? 'up-to-date' : 'new-release', key };
}

export function retainLock(ownership) { ownership.retained = true; }

// Finalize by appending a new immutable input revision, keeping candidate/PR identity.
export function finalizeCandidate({ manifest: m, stateRoot: root, nativeAssets }) {
  validateManifest(m);
  const key = candidateKey(m);
  return withLock(root, key, () => {
    const path = join(root, 'candidates', `${key}.json`), candidate = readJSON(path);
    if (!candidate || candidate.inputHash !== sha256(JSON.stringify(m)) || m.production_ready !== false || !candidate.lastValidatedAttempt) throw invalid('Validated provisional candidate required');
    const receipt = readJSON(join(root, 'build-attempts', candidate.lastValidatedAttempt, 'attempt.json'));
    if (receipt?.state !== 'validated' || receipt.key !== key || receipt.inputHash !== candidate.inputHash || sha256(JSON.stringify(receipt)) !== candidate.validatedReceiptHash || receipt.refreshedLockHash !== candidate.refreshedLockHash || sha256(readFileSync(join(candidate.source, 'codex-rs/Cargo.lock'))) !== receipt.refreshedLockHash) throw invalid('Finalization receipt mismatch');
    const next = validateManifest({ ...m, ...(nativeAssets === undefined ? {} : { native_assets: nativeAssets }), lockfile_sha256: receipt.refreshedLockHash, production_ready: true });
    const pins = (next.native_assets ?? []).map(({ name, sha256 }) => ({ name, sha256 })).sort((a, b) => a.name.localeCompare(b.name));
    if (JSON.stringify(pins) !== JSON.stringify(receipt.nativeArtifacts ?? [])) throw invalid('Native inputs require exact declared pins before finalization');
    const inputHash = sha256(JSON.stringify(next)), dir = join(root, 'revisions'); mkdirSync(dir, { recursive: true });
    const revision = { schema: 1, key, inputHash, previousInputHash: candidate.inputHash, manifest: next, validatedAttempt: receipt.id, receiptHash: candidate.validatedReceiptHash };
    writeFileSync(join(dir, `${inputHash}.json`), JSON.stringify(revision), { flag: 'wx', mode: 0o600 });
    candidate.initialInputHash ??= candidate.inputHash;
    candidate.inputHash = inputHash; candidate.manifest = next; candidate.state = 'finalized-rebuild-required';
    candidate.lastValidatedAttempt = null; candidate.validatedReceiptHash = null;
    atomicJSON(path, candidate);
    return { state: 'finalized-rebuild-required', key, inputHash, manifest: next };
  });
}
