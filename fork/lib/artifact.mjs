import { readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { sha256, invalid } from './manifest.mjs';
import { inspectArchive } from './safe-extract.mjs';
import { install } from './install.mjs';

// The installed gh version must support attestation verification. No fallback
// treats checksums, supplied booleans, or unsigned JSON as authentication.
export function verifyWithGh({ archive, repo, commit, run = spawnSync }) {
  if (!/^[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(repo ?? '') || repo === 'openai/codex' || !/^[a-f0-9]{40}$/.test(commit ?? '')) throw invalid('Explicit trusted fork identity required');
  const artifactHash = sha256(readFileSync(archive));
  const result = run('gh', ['attestation', 'verify', archive, '--repo', repo, '--signer-workflow', `${repo}/.github/workflows/fork-release.yml`, '--source-digest', commit, '--deny-self-hosted-runners'], { encoding: 'utf8', timeout: 60000, maxBuffer: 1024 * 1024 });
  if (result.error || result.signal || result.status !== 0) throw invalid('GitHub attestation verification unavailable or refused (details redacted)');
  if (sha256(readFileSync(archive)) !== artifactHash) throw invalid('Artifact changed during verification');
  return { verified: true, repo, commit, artifactHash, workflow: '.github/workflows/fork-release.yml' };
}
export async function installRelease({ home, repo, version, commit, transport, archive, probe, verify = verifyWithGh }) {
  if (!/^\d+\.\d+\.\d+-p\d+$/.test(version ?? '') || typeof transport?.downloadRelease !== 'function' || typeof probe !== 'function') throw invalid('Explicit release transport and behavioral patch probe required');
  const selected = await transport.downloadRelease({ repo, tag: `fork-${version}` });
  const expectedArtifact = `codex-${version}-x86_64-unknown-linux-gnu.tar.gz`;
  if (selected?.repo !== repo || selected.tag !== `fork-${version}` || selected.commit !== commit || selected.draft !== false || selected.artifact !== expectedArtifact || !Buffer.isBuffer(selected.bytes) || !/^[a-f0-9]{64}$/.test(selected.sha256 ?? '') || sha256(selected.bytes) !== selected.sha256) throw invalid('Selected release identity/checksum mismatch');
  const inspected = inspectArchive(selected.bytes);
  if (inspected.manifest.fork_version !== version || !inspected.manifest.production_ready) throw invalid('Release manifest mismatch');
  // Caller supplies a fresh private download path; no overwrite or HOME lookup.
  writeFileSync(archive, selected.bytes, { flag: 'wx', mode: 0o600 });
  const verification = await verify({ archive, repo, commit });
  if (verification?.verified !== true || verification.repo !== repo || verification.commit !== commit || verification.artifactHash !== selected.sha256 || verification.workflow !== '.github/workflows/fork-release.yml') throw invalid('Exact release authentication required');
  return install({ home, archive, sha256: selected.sha256, verification, probe });
}
