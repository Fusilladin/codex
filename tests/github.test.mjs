import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { temp, manifest } from './helpers.mjs';
import { candidatePayload, githubTransport } from '../fork/lib/github.mjs';
import { githubRequest } from '../fork/lib/http.mjs';
import { verifyWithGh } from '../fork/lib/artifact.mjs';
import { packageStage, allowedFiles } from '../fork/lib/package.mjs';
import { sha256 } from '../fork/lib/manifest.mjs';

function payload() {
  const m = { ...manifest('1'.repeat(40)), production_ready: true, lockfile_sha256: '2'.repeat(64) };
  return candidatePayload({ manifest: m, artifactHash: '3'.repeat(64), receiptHash: '4'.repeat(64) });
}
function fixture(p, approved = true) {
  const calls = [], refs = new Map(), prs = [], releases = [];
  const repo = 'fixture-owner/codex', prefix = `/repos/${repo}`;
  const request = async call => {
    calls.push(call); const path = new URL(call.url).pathname, method = call.method;
    if (method === 'GET' && path === `${prefix}/pulls`) return { status: 200, data: prs };
    if (method === 'GET' && path === `${prefix}/git/ref/heads/fork`) return { status: 200, data: { object: { sha: 'a'.repeat(40) } } };
    if (method === 'GET' && path === `${prefix}/git/commits/${'a'.repeat(40)}`) return { status: 200, data: { tree: { sha: 'b'.repeat(40) } } };
    if (method === 'GET' && path === `${prefix}/git/ref/heads/${p.branch}`) return refs.has(p.branch) ? { status: 200, data: { object: { sha: refs.get(p.branch) } } } : { status: 404 };
    if (method === 'POST' && path === `${prefix}/git/trees`) { assert.equal(call.body.base_tree, 'b'.repeat(40)); assert.deepEqual(call.body.tree.map(x => x.path), ['fork/manifest.json', 'fork/candidate.json']); return { status: 201, data: { sha: 'c'.repeat(40) } }; }
    if (method === 'POST' && path === `${prefix}/git/commits`) return { status: 201, data: { sha: 'd'.repeat(40) } };
    if (method === 'POST' && path === `${prefix}/git/refs`) { assert.equal(call.body.ref, `refs/heads/${p.branch}`); refs.set(p.branch, call.body.sha); return { status: 201 }; }
    if (method === 'POST' && path === `${prefix}/pulls`) { const pr = { number: 1, state: 'open', base: { ref: 'fork' }, head: { ref: p.branch, repo: { full_name: repo } }, merged: true, merge_commit_sha: 'e'.repeat(40) }; prs.push(pr); return { status: 201, data: pr }; }
    if (method === 'GET' && path === `${prefix}/contents/fork/candidate.json`) return { status: 200, data: { content: Buffer.from(JSON.stringify(p, null, 2) + '\n').toString('base64') } };
    if (method === 'GET' && path === `${prefix}/pulls/1`) return { status: 200, data: prs[0] };
    if (method === 'GET' && path.startsWith(`${prefix}/releases/tags/`)) return { status: releases.length ? 200 : 404, data: releases[0] };
    if (method === 'POST' && path === `${prefix}/releases`) { assert.equal(call.body.draft, true); releases.push(call.body); return { status: 201, data: { id: 7 } }; }
    if (method === 'POST' && call.url.startsWith(`https://uploads.github.com/repos/${repo}/releases/7/assets?`)) return { status: 201 };
    assert.fail(`Unexpected fixture request: ${method} ${path}`);
  };
  const approveCommit = async identity => ({ ...identity, verdict: approved ? 'PASS' : 'FAIL' });
  return { repo, request, approveCommit, calls, refs, prs, releases };
}

test('unapproved candidate is refused before ref mutation; approved async transport deduplicates one branch/PR', async () => {
  const p = payload(), denied = fixture(p, false), blocked = githubTransport(denied);
  await assert.rejects(blocked.upsertCandidate(p), /Unapproved/);
  assert.equal(denied.refs.size, 0); assert.equal(denied.prs.length, 0);
  const f = fixture(p), transport = githubTransport(f);
  assert.equal((await transport.upsertCandidate(p)).submitted, true);
  assert.equal((await transport.upsertCandidate(p)).submitted, false);
  assert.equal(f.refs.size, 1); assert.equal(f.prs.length, 1);
  assert.ok(f.calls.every(c => !c.url.includes('/git/refs/heads/fork') && c.method !== 'PATCH'));
  f.approveCommit = async () => ({ verdict: 'FAIL' });
  await assert.rejects(githubTransport(f).upsertCandidate(p), /approval required/);
  const changed = { ...p, artifactHash: '5'.repeat(64) };
  await assert.rejects(transport.upsertCandidate(changed), /input changed/);
});

test('draft transport requires exact merged candidate, artifact/review and authenticated attestation; never overwrites release', async t => {
  const root = temp(t), p = payload(), stage = join(root, 'stage'); mkdirSync(join(stage, 'bin'), { recursive: true });
  for (const name of allowedFiles) writeFileSync(join(stage, name), name.startsWith('bin/') ? '#!/bin/sh\nexit 0\n' : name === 'manifest.json' ? JSON.stringify(p.manifest) : name === 'FORK-VERSION' ? p.manifest.fork_version : 'synthetic notice', { mode: name.startsWith('bin/') ? 0o755 : 0o644 });
  const packaged = packageStage({ stage, output: join(root, 'out'), fixture: true });
  const bytes = readFileSync(join(root, 'out', packaged.artifact)); p.artifactHash = sha256(bytes);
  const f = fixture(p), transport = githubTransport(f); await transport.upsertCandidate(p);
  const commit = 'e'.repeat(40), options = { candidate: p, commit, artifact: packaged.artifact, bytes, pullNumber: 1, review: { verdict: 'PASS', commit, inputHash: p.inputHash, artifactHash: p.artifactHash } };
  await assert.rejects(transport.createDraft(options), /attestation/); assert.equal(f.releases.length, 0);
  const signed = githubTransport({ ...f, verifyAttestation: async identity => ({ ...identity, verified: true }) });
  await assert.rejects(signed.createDraft({ ...options, bytes: Buffer.from('different') }), /Exact merged/);
  const result = await signed.createDraft(options); assert.equal(result.state, 'draft'); assert.equal(result.published, false);
  assert.equal(f.releases.length, 1); assert.equal(f.calls.filter(c => c.url.startsWith('https://uploads.github.com')).length, 3);
  await assert.rejects(signed.createDraft(options), /never overwrite/);
});

test('HTTP adapter constrains origins, bounds responses, redacts failures and never forwards token to asset CDN', async () => {
  assert.throws(() => githubRequest({ token: 'synthetic', fetch() {} }), /Explicit/);
  const calls = [], token = 'synthetic-test-token';
  const request = githubRequest({ token, enableNetwork: true, fetch: async (url, options) => {
    calls.push({ url, options });
    return calls.length === 1 ? new Response(null, { status: 302, headers: { location: 'https://release-assets.githubusercontent.com/synthetic' } }) : new Response('fixture artifact');
  } });
  const got = await request({ method: 'GET', url: 'https://api.github.com/repos/fixture-owner/codex/releases/assets/1', responseType: 'bytes' });
  assert.equal(got.data.toString(), 'fixture artifact'); assert.equal(calls[0].options.headers.Authorization, `Bearer ${token}`); assert.equal(calls[1].options.headers, undefined);
  await assert.rejects(request({ method: 'GET', url: 'https://example.invalid/secret' }), /scope/);
  const huge = githubRequest({ token, enableNetwork: true, fetch: async () => new Response('x', { headers: { 'content-length': String(9 * 1024 * 1024) } }) });
  await assert.rejects(huge({ method: 'GET', url: 'https://api.github.com/repos/fixture-owner/codex' }), error => /redacted/.test(error.message) && !error.message.includes(token));
});

test('attestation verifier binds repository, signer workflow, source digest and refuses unsupported gh without leaking output', t => {
  const root = temp(t), archive = join(root, 'artifact'); writeFileSync(archive, 'fixture');
  const input = { archive, repo: 'fixture-owner/codex', commit: 'a'.repeat(40) };
  assert.throws(() => verifyWithGh({ ...input, run: () => ({ status: 1, stderr: 'private diagnostic' }) }), /unavailable or refused/);
  const proof = verifyWithGh({ ...input, run: (cmd, args) => { assert.equal(cmd, 'gh'); assert.ok(args.includes('--source-digest')); assert.ok(args.includes('--signer-workflow')); assert.ok(args.includes('--deny-self-hosted-runners')); return { status: 0 }; } });
  assert.equal(proof.artifactHash, sha256(readFileSync(archive))); assert.equal(proof.verified, true);
});

test('published-release download verifies selection and install adapter authenticates before isolated activation', async t => {
  const { installRelease } = await import('../fork/lib/artifact.mjs');
  const { status } = await import('../fork/lib/install.mjs');
  const root = temp(t), p = payload(), stage = join(root, 'download-stage'); mkdirSync(join(stage, 'bin'), { recursive: true });
  for (const name of allowedFiles) writeFileSync(join(stage, name), name.startsWith('bin/') ? '#!/bin/sh\nprintf "%s\\n" "codex-cli 0.167.1"\n' : name === 'manifest.json' ? JSON.stringify(p.manifest) : name === 'FORK-VERSION' ? p.manifest.fork_version : 'synthetic notice', { mode: name.startsWith('bin/') ? 0o755 : 0o644 });
  const packed = packageStage({ stage, output: join(root, 'download-out'), fixture: true }), bytes = readFileSync(join(root, 'download-out', packed.artifact));
  const repo = 'fixture-owner/codex', commit = 'e'.repeat(40), tag = `fork-${p.manifest.fork_version}`; let corrupt = false;
  const transport = githubTransport({ repo, request: async ({ url }) => {
    const path = new URL(url).pathname;
    if (path.endsWith(`/releases/tags/${tag}`)) return { status: 200, data: { draft: false, prerelease: false, tag_name: tag, assets: [{ id: 1, name: 'SHA256SUMS' }, { id: 2, name: packed.artifact }] } };
    if (path.endsWith(`/commits/${tag}`)) return { status: 200, data: { sha: commit } };
    if (path.endsWith('/releases/assets/1')) return { status: 200, data: Buffer.from(`${packed.sha256}  ${packed.artifact}\n`) };
    if (path.endsWith('/releases/assets/2')) return { status: 200, data: corrupt ? Buffer.from('corrupt') : bytes };
    assert.fail('Unexpected release request');
  } });
  const home = join(root, 'download-home'), options = { home, repo, version: p.manifest.fork_version, commit, transport };
  const probe = ({ directory }) => ({ verdict: 'PASS', binaryHash: sha256(readFileSync(join(directory, 'bin/codex'))), steps: { pager24: 9, pager60: 24, transcript24: 9, transcript60: 24 } });
  await assert.rejects(installRelease({ ...options, archive: join(root, 'no-probe') }), /patch probe/);
  await assert.rejects(installRelease({ ...options, archive: join(root, 'unauthenticated'), probe, verify: () => ({ verified: false }) }), /authentication/);
  assert.equal(status({ home }).active, null);
  const verify = ({ archive, repo, commit }) => ({ verified: true, repo, commit, artifactHash: sha256(readFileSync(archive)), workflow: '.github/workflows/fork-release.yml' });
  assert.equal((await installRelease({ ...options, archive: join(root, 'verified'), probe, verify })).active, p.manifest.fork_version);
  corrupt = true; await assert.rejects(transport.downloadRelease({ repo, tag }), /checksum mismatch/);
});

test('publication transport receives full evidence and reauthenticates before the only publish mutation', async () => {
  const { publicationIdentity, publish } = await import('../fork/lib/release.mjs');
  const p = payload(), commit = 'e'.repeat(40), identity = publicationIdentity({ manifest: p.manifest, commit, artifactHash: p.artifactHash, draftId: '7' });
  const evidence = { identity, candidate: { ...identity, state: 'validated' }, review: { ...identity, verdict: 'PASS' }, draft: { ...identity, draft: true }, artifact: { ...identity, verified: true }, vm: { ...identity, verdict: 'PASS', vm: 'permitted-fixture', at: new Date().toISOString(), steps: { fresh: 'PASS', update: 'PASS', rollback: 'PASS' } } };
  let writes = 0, verified = false;
  const transport = githubTransport({ repo: 'fixture-owner/codex', request: async ({ method, body }) => {
    if (method === 'GET') return { status: 200, data: { draft: true, target_commitish: commit } };
    assert.equal(method, 'PATCH'); assert.deepEqual(body, { draft: false }); writes++; return { status: 200, data: {} };
  }, verifyAttestation: async value => ({ ...value, verified }) });
  await assert.rejects(publish(evidence, transport), /authenticated/); assert.equal(writes, 0);
  verified = true; assert.equal((await publish(evidence, transport)).state, 'published'); assert.equal(writes, 1);
  await assert.rejects(publish({ ...evidence, vm: { ...evidence.vm, verdict: 'FAIL' } }, transport), /gate refused/); assert.equal(writes, 1);
});
