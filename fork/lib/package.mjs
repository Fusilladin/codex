import { lstatSync, readdirSync, readFileSync, mkdirSync, writeFileSync, realpathSync } from 'node:fs';
import { join, resolve, relative, sep, isAbsolute, dirname, basename } from 'node:path';
import { spawnSync } from 'node:child_process';
import { readManifest, sha256, invalid, candidateKey } from './manifest.mjs';
import { verifiedStripped } from './strip-artifacts.mjs';
import { readJSON } from './state.mjs';
import { scanBytes, scanEntryName } from './canary.mjs';

export const allowedFiles = ['bin/codex', 'bin/codex-code-mode-host', 'bin/codex-exec-server', 'manifest.json', 'FORK-VERSION', 'LICENSE', 'NOTICE', 'FORK-NOTICE.md'].sort();
function contains(parent, path) {
  const rel = relative(parent, path);
  return !rel || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`));
}
// Resolve existing parents as well as the final entry, without creating anything.
function resolvedDestination(path) {
  try { return realpathSync(path); }
  catch (error) {
    if (error.code !== 'ENOENT') throw invalid('Unsafe output path');
    // A dangling link is not a fresh destination.
    try { lstatSync(path); throw invalid('Unsafe output path'); }
    catch (entryError) { if (entryError.code !== 'ENOENT') throw entryError; }
    const parent = dirname(path);
    if (parent === path) throw invalid('Unsafe output path');
    return join(resolvedDestination(parent), basename(path));
  }
}
export function packageStage({ stage, output, fixture = false, stateRoot, attempt }) {
  stage = resolve(stage); output = resolve(output);
  if (contains(stage, output) || contains(realpathSync(stage), resolvedDestination(output))) {
    throw invalid('Output must be outside staging');
  }
  const found = [];
  function walk(dir, prefix = '') {
    if (!lstatSync(dir).isDirectory() || lstatSync(dir).isSymbolicLink()) throw invalid('Unsafe staging root');
    for (const name of readdirSync(dir).sort()) {
      const path = join(dir, name), local = prefix + name, stat = lstatSync(path);
      if (stat.isDirectory() && local === 'bin') walk(path, 'bin/');
      else {
        if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || !allowedFiles.includes(local)) throw invalid('Unexpected or linked staged file');
        scanEntryName(local); scanBytes(readFileSync(path), {name: local});
        found.push(local);
      }
    }
  }
  walk(stage);
  if (JSON.stringify(found.sort()) !== JSON.stringify(allowedFiles)) throw invalid('Missing required package files/helpers');
  const m = readManifest(join(stage, 'manifest.json'));
  if (readFileSync(join(stage, 'FORK-VERSION'), 'utf8').trim() !== m.fork_version) throw invalid('Fork version mismatch');
  for (const name of m.bins) if (!(lstatSync(join(stage, 'bin', name)).mode & 0o111)) throw invalid('Binary is not executable');
  if (typeof fixture !== 'boolean') throw invalid('Explicit packaging mode required');
  let binding;
  if (!fixture || stateRoot || attempt) {
    if (m.production_ready !== true || !m.lockfile_sha256 || !stateRoot || !/^[a-f0-9-]{36}$/.test(attempt ?? '')) throw invalid('Release package requires ready manifest and exact validated receipt');
    const candidate = readJSON(join(stateRoot, 'candidates', `${candidateKey(m)}.json`));
    const receipt = readJSON(join(stateRoot, 'build-attempts', attempt, 'attempt.json'));
    if (!candidate || !receipt || (!fixture && receipt.executionKind !== 'host') || candidate.lastValidatedAttempt !== attempt || receipt.state !== 'validated' || receipt.id !== attempt || receipt.key !== candidateKey(m) || receipt.inputHash !== sha256(JSON.stringify(m)) || candidate.inputHash !== receipt.inputHash || candidate.validatedReceiptHash !== sha256(JSON.stringify(receipt)) || receipt.refreshedLockHash !== m.lockfile_sha256 || receipt.artifacts?.length !== 3) throw invalid('Exact-input build receipt required');
    const stripped = fixture ? { artifacts: receipt.artifacts } : verifiedStripped(stateRoot, attempt);
    for (const bin of m.bins) {
      const artifact = receipt.artifacts.find(a => a.bin === bin);
      const expectedPath = join(realpathSync(stateRoot), 'build-attempts', attempt, 'artifacts', bin);
      if (!artifact || artifact.path !== expectedPath || realpathSync(artifact.path) !== expectedPath || !lstatSync(artifact.path).isFile() || sha256(readFileSync(artifact.path)) !== artifact.sha256 || sha256(readFileSync(join(stage, 'bin', bin))) !== stripped.artifacts.find(a => a.bin === bin).sha256) throw invalid('Frozen build artifact mismatch');
    }
    binding = { key: receipt.key, inputHash: receipt.inputHash, receiptHash: candidate.validatedReceiptHash, stripReceiptHash: candidate.stripReceiptHash, artifacts: stripped.artifacts.map(({ bin, sha256, rawSha256 }) => ({ bin, sha256, rawSha256 })) };
  }
  const name = `codex-${m.fork_version}-${m.target}.tar.gz`;
  // Validate everything before creating any output. Deterministic GNU tar metadata.
  const tarBytes = Math.ceil((allowedFiles.reduce((n, name) => n + 512 + Math.ceil(lstatSync(join(stage, name)).size / 512) * 512, 0) + 1024) / 10240) * 10240;
  if (tarBytes > 512 * 1024 * 1024) throw invalid('Expanded archive limit');
  const packed = spawnSync('tar', ['--format=ustar', '--sort=name', '--mtime=@0', '--owner=0', '--group=0', '--numeric-owner', '--mode=u+rwX,go+rX,go-w', '-czf', '-', '-C', stage, '--', ...allowedFiles], { maxBuffer: 128 * 1024 * 1024 });
  if (packed.status !== 0) throw invalid('Packaging failed');
  const hash = sha256(packed.stdout);
  mkdirSync(output); // fresh output only; never replace previous artifacts
  writeFileSync(join(output, name), packed.stdout, { flag: 'wx' });
  writeFileSync(join(output, 'SHA256SUMS'), `${hash}  ${name}\n`, { flag: 'wx' });
  writeFileSync(join(output, 'PACKAGE.json'), JSON.stringify({ schema: 1, fixture, artifact: name, sha256: hash, binding }), { flag: 'wx' });
  return { state: 'packaged', artifact: name, sha256: hash, published: false, fixture, production_ready: !fixture && m.production_ready === true };
}
