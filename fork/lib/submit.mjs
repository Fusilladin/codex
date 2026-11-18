import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { candidateKey, inputRevision, sha256, invalid } from './manifest.mjs';
import { readJSON } from './state.mjs';
import { candidatePayload } from './github.mjs';
import { updateCandidate } from './update.mjs';

export async function submitPackagedCandidate({ manifest, release, stateRoot, packageDir, transport }) {
  const candidate = readJSON(join(stateRoot, 'candidates', `${candidateKey(manifest)}.json`));
  const receipt = candidate?.lastValidatedAttempt && readJSON(join(stateRoot, 'build-attempts', candidate.lastValidatedAttempt, 'attempt.json'));
  const packaged = readJSON(join(packageDir, 'PACKAGE.json'));
  const expectedArtifact = `codex-${manifest.fork_version}-${manifest.target}.tar.gz`;
  if (!candidate || candidate.state !== 'validated' || receipt?.executionKind !== 'host' || receipt.state !== 'validated' || receipt.inputHash !== inputRevision(manifest) || sha256(JSON.stringify(receipt)) !== candidate.validatedReceiptHash || packaged?.fixture !== false || packaged.artifact !== expectedArtifact || packaged.binding?.key !== candidate.key || packaged.binding.inputHash !== candidate.inputHash || packaged.binding.receiptHash !== candidate.validatedReceiptHash || sha256(readFileSync(join(packageDir, expectedArtifact))) !== packaged.sha256) throw invalid('Exact host-built package required before PR submission');
  const payload = candidatePayload({ manifest, artifactHash: packaged.sha256, receiptHash: candidate.validatedReceiptHash, previousCommit: candidate.previousCommit ?? manifest.upstream.commit });
  return updateCandidate({ manifest, release, stateRoot, transport: { upsertCandidate: async request => {
    if (request.key !== payload.key || request.inputHash !== payload.inputHash || request.branch !== payload.branch) throw invalid('Candidate changed before submission');
    return transport.upsertCandidate(payload);
  } } });
}
