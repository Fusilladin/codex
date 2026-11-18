import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { discover, nativeAssets, ciMain, reviewedReleasePayload } from '../fork/lib/ci.mjs';
import { sha256, candidateKey, inputRevision } from '../fork/lib/manifest.mjs';
import { candidatePayload } from '../fork/lib/github.mjs';
import { temp, manifest } from './helpers.mjs';

test('CI discovery resolves stable identity and suppresses existing candidates through injected HTTP', async () => {
  const m = manifest('1'.repeat(40)); let seen = false;
  const fetcher = async url => url.endsWith('/releases/latest') ? new Response(JSON.stringify({ tag_name: 'rust-v0.169.0', draft: false, prerelease: false })) : url.includes('/pulls?') ? new Response('[]') : url.includes('/commits/') ? new Response(JSON.stringify({ sha: '2'.repeat(40) })) : new Response('', { status: seen ? 200 : 404 });
  const first = await discover({ manifest: m, repo: 'fixture-owner/codex', fetch: fetcher }); assert.equal(first.build, true);
  seen = true; assert.equal((await discover({ manifest: m, repo: 'fixture-owner/codex', fetch: fetcher })).build, false);
  const prior = { ...m, fork_version: '0.169.0-p1', upstream: { ...m.upstream, tag: 'rust-v0.169.0', commit: '4'.repeat(40) } }, key = candidateKey(prior);
  const moved = async url => url.includes('/pulls?') ? new Response(JSON.stringify([{ head: { repo: { full_name: 'fixture-owner/codex' }, ref: `update/${key.slice(0, 12)}` } }])) : url.includes('/contents/') ? new Response(JSON.stringify({ content: Buffer.from(JSON.stringify({ key, manifest: prior })).toString('base64') })) : fetcher(url);
  await assert.rejects(discover({ manifest: m, repo: 'fixture-owner/codex', fetch: moved }), /tag moved/);
  const old = process.env.GITHUB_ACTIONS;
  try { delete process.env.GITHUB_ACTIONS; await assert.rejects(ciMain(['candidate']), /not a local build mode/); }
  finally { if (old !== undefined) process.env.GITHUB_ACTIONS = old; }
});

test('native cache preparation requires two pinned local artifacts and refuses checksum changes', async t => {
  const root = temp(t), bytes = Buffer.from('synthetic native asset');
  const assets = ['src_binding_fixture.rs', 'librusty_v8_fixture.a.gz'].map(name => ({ name, url: `https://github.com/denoland/rusty_v8/releases/download/v0.0.0/${name}`, sha256: sha256(bytes) }));
  const m = manifest('1'.repeat(40)); assert.notEqual(inputRevision({ ...m, native_assets: assets }), inputRevision({ ...m, native_assets: [{ ...assets[0], sha256: '0'.repeat(64) }, assets[1]] }));
  let calls = 0; const fetcher = async () => { calls++; return new Response(bytes); };
  const directory = join(root, 'native'); await nativeAssets({ assets, directory, fetch: fetcher });
  assert.equal(calls, 2); assert.deepEqual(readFileSync(join(directory, assets[0].name)), bytes);
  await nativeAssets({ assets, directory, fetch: fetcher }); assert.equal(calls, 2);
  await assert.rejects(nativeAssets({ assets: [{ ...assets[0], sha256: '0'.repeat(64) }, assets[1]], directory, fetch: fetcher }), /pin changed/);
  await assert.rejects(nativeAssets({ assets: [], directory, fetch: fetcher }), /binding and library/);
});


test('release rebuild preserves reviewed candidate provenance while comparing exact artifact/input bytes', () => {
  const m = { ...manifest('1'.repeat(40)), production_ready: true, lockfile_sha256: '2'.repeat(64) };
  const merged = candidatePayload({ manifest: m, artifactHash: '3'.repeat(64), receiptHash: '4'.repeat(64), previousCommit: '5'.repeat(40) });
  const rebuilt = candidatePayload({ manifest: m, artifactHash: merged.artifactHash, receiptHash: '6'.repeat(64), previousCommit: m.upstream.commit });
  assert.equal(reviewedReleasePayload({ merged, rebuilt }), merged);
  assert.notEqual(merged.receiptHash, rebuilt.receiptHash);
  assert.throws(() => reviewedReleasePayload({ merged, rebuilt: { ...rebuilt, artifactHash: '7'.repeat(64) } }), /differs/);
});
