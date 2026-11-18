import { candidateKey, inputRevision, validateManifest, sha256, invalid } from './manifest.mjs';
import { latestStable } from './upstream.mjs';
import { scanBytes } from './canary.mjs';
import { validatePublication } from './release.mjs';
import { inspectArchive } from './safe-extract.mjs';

const hex40 = value => /^[a-f0-9]{40}$/.test(value ?? '');
const hex64 = value => /^[a-f0-9]{64}$/.test(value ?? '');
export function candidatePayload({ manifest, artifactHash, receiptHash, previousCommit = manifest.upstream.commit }) {
  validateManifest(manifest);
  if (!manifest.production_ready || !hex64(artifactHash) || !hex64(receiptHash) || !hex40(previousCommit) || /^0+$/.test(previousCommit)) throw invalid('Validated release payload required');
  const key = candidateKey(manifest);
  return { schema: 1, key, inputHash: inputRevision(manifest), branch: `update/${key.slice(0, 12)}`, base: 'fork', manifest, previousCommit, artifactHash, receiptHash };
}
function payload(value) {
  const expected = candidatePayload(value);
  if (JSON.stringify(value) !== JSON.stringify(expected)) throw invalid('Canonical exact candidate payload required');
  scanBytes(Buffer.from(JSON.stringify(value))); return expected;
}
// request is a trusted, explicitly supplied authenticated HTTP adapter. Tests
// replace it completely; importing this module never reads credentials or fetches.
export function githubTransport({ repo, request, approveCommit, verifyAttestation }) {
  if (!/^[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(repo ?? '') || repo === 'openai/codex' || typeof request !== 'function') throw invalid('Explicit fork repository and HTTP adapter required');
  const prefix = `/repos/${repo}`;
  const api = async (method, path, body) => {
    if (!path.startsWith(`${prefix}/`) && !path.startsWith('/repos/openai/codex/')) throw invalid('GitHub request scope refused');
    if (path.startsWith('/repos/openai/codex/') && method !== 'GET') throw invalid('Upstream writes refused');
    const result = await request({ method, url: `https://api.github.com${path}`, body });
    if (!result || !Number.isInteger(result.status)) throw invalid('Invalid GitHub response');
    return result;
  };
  const must = async (...args) => { const r = await api(...args); if (r.status < 200 || r.status > 299) throw invalid('GitHub operation refused (details redacted)'); return r.data; };
  const currentPR = async branch => {
    const prs = await must('GET', `${prefix}/pulls?state=all&head=${encodeURIComponent(repo.split('/')[0] + ':' + branch)}&base=fork&per_page=100`);
    if (!Array.isArray(prs) || prs.length > 1) throw invalid('Ambiguous candidate PR identity');
    return prs[0];
  };
  return {
    latest: () => latestStable({ fixture: null, fetch: async url => {
      const u = new URL(url); if (u.origin !== 'https://api.github.com' || !u.pathname.startsWith('/repos/openai/codex/')) throw invalid('Upstream URL refused');
      return must('GET', u.pathname);
    } }),
    async upsertCandidate(value) {
      const p = payload(value);
      const previous = await currentPR(p.branch);
      if (previous && previous.state !== 'open') return { state: 'candidate-exists', number: previous.number, submitted: false };
      const base = await must('GET', `${prefix}/git/ref/heads/fork`);
      if (!hex40(base?.object?.sha)) throw invalid('Invalid fork branch identity');
      const old = await api('GET', `${prefix}/git/ref/heads/${p.branch}`);
      if (![200, 404].includes(old.status)) throw invalid('Candidate branch lookup failed');
      // Never force-update or overwrite a candidate branch. A new input revision
      // requires its own explicit review rather than rebasing someone else's work.
      if (old.status === 200) {
        const stored = await must('GET', `${prefix}/contents/fork/candidate.json?ref=${encodeURIComponent(p.branch)}`);
        let prior; try { prior = JSON.parse(Buffer.from(stored.content, 'base64')); } catch { throw invalid('Candidate branch content unavailable'); }
        if (JSON.stringify(prior) !== JSON.stringify(p)) throw invalid('Candidate branch input changed; explicit owner review required');
        const approval = await approveCommit?.({ repo, commit: old.data?.object?.sha, parent: base.object.sha, ...p });
        if (!hex40(old.data?.object?.sha) || approval?.verdict !== 'PASS' || approval.repo !== repo || approval.commit !== old.data.object.sha || approval.parent !== base.object.sha || approval.inputHash !== p.inputHash || approval.artifactHash !== p.artifactHash) throw invalid('Existing candidate commit approval required');
      } else {
        const baseCommit = await must('GET', `${prefix}/git/commits/${base.object.sha}`);
        if (!hex40(baseCommit?.tree?.sha)) throw invalid('Invalid fork base tree');
        const tree = await must('POST', `${prefix}/git/trees`, { base_tree: baseCommit.tree.sha, tree: [
          { path: 'fork/manifest.json', mode: '100644', type: 'blob', content: JSON.stringify(p.manifest, null, 2) + '\n' },
          { path: 'fork/candidate.json', mode: '100644', type: 'blob', content: JSON.stringify(p, null, 2) + '\n' },
        ] });
        if (!hex40(tree?.sha)) throw invalid('Invalid candidate tree');
        const commit = await must('POST', `${prefix}/git/commits`, { message: `Update Codex to ${p.manifest.upstream.tag}`, tree: tree.sha, parents: [base.object.sha] });
        if (!hex40(commit?.sha)) throw invalid('Invalid candidate commit');
        const approval = await approveCommit?.({ repo, commit: commit.sha, parent: base.object.sha, ...p });
        if (approval?.verdict !== 'PASS' || approval.repo !== repo || approval.commit !== commit.sha || approval.parent !== base.object.sha || approval.inputHash !== p.inputHash || approval.artifactHash !== p.artifactHash) throw invalid('Unapproved candidate commit refused before ref mutation');
        // POST is create-only: a concurrent writer wins; no force update exists.
        const created = await api('POST', `${prefix}/git/refs`, { ref: `refs/heads/${p.branch}`, sha: commit.sha });
        if (created.status !== 201) throw invalid('Candidate ref changed concurrently; retry lookup');
      }
      if (previous) return { state: 'candidate-exists', number: previous.number, submitted: false };
      const body = `Upstream diff: https://github.com/openai/codex/compare/${p.previousCommit}...${p.manifest.upstream.commit}\n\nCandidate: ${p.key}\nInput: ${p.inputHash}\nPatchset: ${p.manifest.patchset_sha256}\nArtifact SHA256: ${p.artifactHash}\nValidated receipt: ${p.receiptHash}\n\nAll three named scroll tests passed before this request. Manual merge required.`;
      const result = await api('POST', `${prefix}/pulls`, { title: `Update to ${p.manifest.upstream.tag}`, head: p.branch, base: 'fork', body });
      if (result.status === 422) { const found = await currentPR(p.branch); if (found) return { state: 'candidate-exists', number: found.number, submitted: false }; }
      if (result.status !== 201 || !Number.isSafeInteger(result.data?.number)) throw invalid('PR creation failed');
      return { state: 'candidate-exists', number: result.data.number, submitted: true };
    },
    async createDraft({ candidate, commit, artifact, bytes, pullNumber, review }) {
      const p = payload(candidate);
      const tag = `fork-${p.manifest.fork_version}`;
      const expectedName = `codex-${p.manifest.fork_version}-${p.manifest.target}.tar.gz`;
      if (!hex40(commit) || artifact !== expectedName || !Buffer.isBuffer(bytes) || sha256(bytes) !== p.artifactHash || !Number.isSafeInteger(pullNumber) || pullNumber < 1 || review?.verdict !== 'PASS' || review.commit !== commit || review.inputHash !== p.inputHash || review.artifactHash !== p.artifactHash) throw invalid('Exact merged build/review required');
      if (inputRevision(inspectArchive(bytes).manifest) !== p.inputHash) throw invalid('Artifact manifest input mismatch');
      const pr = await must('GET', `${prefix}/pulls/${pullNumber}`);
      if (!pr?.merged || pr.merge_commit_sha !== commit || pr.base?.ref !== 'fork' || pr.head?.ref !== p.branch || pr.head?.repo?.full_name !== repo) throw invalid('Manual merged candidate required');
      const merged = await must('GET', `${prefix}/contents/fork/candidate.json?ref=${commit}`);
      if (Buffer.from(merged.content ?? '', 'base64').toString() !== JSON.stringify(p, null, 2) + '\n') throw invalid('Merged candidate identity mismatch');
      const proof = await verifyAttestation?.({ repo, commit, artifact, bytes, artifactHash: p.artifactHash, workflow: '.github/workflows/fork-release.yml' });
      if (proof?.verified !== true || proof.repo !== repo || proof.commit !== commit || proof.artifactHash !== p.artifactHash || proof.workflow !== '.github/workflows/fork-release.yml') throw invalid('Authenticated artifact attestation required');
      const existing = await api('GET', `${prefix}/releases/tags/${tag}`);
      if (existing.status !== 404) throw invalid('Release already exists; never overwrite assets or tags');
      const release = await must('POST', `${prefix}/releases`, { tag_name: tag, target_commitish: commit, name: tag, draft: true, prerelease: false, body: `Input: ${p.inputHash}\nArtifact SHA256: ${p.artifactHash}\nFresh VM and exact-byte owner review required before publication.` });
      if (!Number.isSafeInteger(release?.id)) throw invalid('Invalid draft identity');
      for (const [name, data, type] of [[artifact, bytes, 'application/gzip'], ['SHA256SUMS', Buffer.from(`${p.artifactHash}  ${artifact}\n`), 'text/plain'], ['manifest.json', Buffer.from(JSON.stringify(p.manifest, null, 2) + '\n'), 'application/json']]) {
        const result = await request({ method: 'POST', url: `https://uploads.github.com/repos/${repo}/releases/${release.id}/assets?name=${encodeURIComponent(name)}`, body: data, contentType: type });
        if (result?.status !== 201) throw invalid('Draft asset upload failed; retain draft for explicit owner recovery');
      }
      return { state: 'draft', draftId: String(release.id), commit, artifactHash: p.artifactHash, published: false };
    },
    async downloadRelease({ repo: selectedRepo, tag }) {
      if (selectedRepo !== repo || !/^fork-\d+\.\d+\.\d+-p\d+$/.test(tag ?? '')) throw invalid('Explicit published fork release required');
      const release = await must('GET', `${prefix}/releases/tags/${tag}`);
      if (release?.draft !== false || release.prerelease !== false || release.tag_name !== tag || !Array.isArray(release.assets)) throw invalid('Published stable fork release required');
      const resolved = await must('GET', `${prefix}/commits/${tag}`);
      if (!hex40(resolved?.sha)) throw invalid('Release commit unavailable');
      const artifact = `codex-${tag.slice(5)}-x86_64-unknown-linux-gnu.tar.gz`;
      const download = async name => {
        const matches = release.assets.filter(a => a.name === name);
        if (matches.length !== 1 || !Number.isSafeInteger(matches[0].id) || matches[0].id < 1) throw invalid('Release asset unavailable or ambiguous');
        const response = await request({ method: 'GET', url: `https://api.github.com${prefix}/releases/assets/${matches[0].id}`, responseType: 'bytes' });
        if (response?.status !== 200 || !Buffer.isBuffer(response.data)) throw invalid('Release asset download failed');
        return response.data;
      };
      const sums = (await download('SHA256SUMS')).toString('utf8');
      const lines = sums.trim().split('\n').filter(line => line.endsWith(`  ${artifact}`));
      if (lines.length !== 1 || !/^[a-f0-9]{64}  [A-Za-z0-9_.-]+$/.test(lines[0])) throw invalid('Release checksum identity refused');
      const bytes = await download(artifact), artifactHash = lines[0].slice(0, 64);
      if (sha256(bytes) !== artifactHash) throw invalid('Downloaded release checksum mismatch');
      return { repo, tag, commit: resolved.sha, draft: false, artifact, sha256: artifactHash, bytes };
    },
    async publishDraft(evidence) {
      const identity = validatePublication(evidence);
      const draft = await must('GET', `${prefix}/releases/${identity.draftId}`);
      if (draft?.draft !== true || draft.target_commitish !== identity.commit) throw invalid('Draft changed after review');
      // The publisher reauthenticates bytes immediately before mutation through
      // the trusted adapter; old local booleans alone are insufficient.
      const proof = await verifyAttestation?.({ repo, commit: identity.commit, artifactHash: identity.artifactHash, draftId: identity.draftId, workflow: '.github/workflows/fork-release.yml' });
      if (proof?.verified !== true || proof.repo !== repo || proof.commit !== identity.commit || proof.artifactHash !== identity.artifactHash || proof.workflow !== '.github/workflows/fork-release.yml') throw invalid('Fresh authenticated artifact required');
      await must('PATCH', `${prefix}/releases/${identity.draftId}`, { draft: false });
      return { state: 'published', ...identity };
    },
  };
}
