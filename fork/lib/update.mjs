import { join } from 'node:path';
import { mkdirSync } from 'node:fs';
import { invalid, candidateKey, sha256 } from './manifest.mjs';
import { checkRelease, withLock, readJSON, atomicJSON } from './state.mjs';

export async function updateCandidate({ manifest, release, stateRoot, transport }) {
  if (typeof transport?.upsertCandidate !== 'function') throw invalid('Explicit PR transport required');
  const key = candidateKey(manifest, release.commit);
  const snapshot = withLock(stateRoot, key, ownership => {
    const result = checkRelease(manifest, release, stateRoot, ownership);
    if (result.state !== 'candidate-exists') return result;
    const candidate = readJSON(join(stateRoot, 'candidates', `${key}.json`));
    const path = join(stateRoot, 'pr-requests', `${key}.json`);
    const previous = readJSON(path);
    const request = { schema: 1, key, branch: `update/${key.slice(0, 12)}`, base: 'fork', inputHash: candidate.inputHash, state: candidate.state, prior: previous?.branch ?? null };
    mkdirSync(join(stateRoot, 'pr-requests'), { recursive: true }); atomicJSON(path, request);
    const receipt = candidate.lastValidatedAttempt && readJSON(join(stateRoot, 'build-attempts', candidate.lastValidatedAttempt, 'attempt.json'));
    const ready = candidate.state === 'validated' && receipt?.state === 'validated' && receipt.key === key && receipt.inputHash === candidate.inputHash && sha256(JSON.stringify(receipt)) === candidate.validatedReceiptHash;
    return { state: 'candidate-exists', key, branch: request.branch, ready, submitted: false, request };
  });
  if (!snapshot.ready) { const { request, ...result } = snapshot; return result; }
  // The local capability is gone before any asynchronous/network work starts.
  // Remote writes must independently enforce exact-commit approval, create-only
  // branch identity, and PR idempotence; a local lock cannot serialize GitHub.
  const outcome = await transport.upsertCandidate(snapshot.request);
  return { state: snapshot.state, key, branch: snapshot.branch, outcome };
}
