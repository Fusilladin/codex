#!/usr/bin/env node
import { mkdirSync, readFileSync, writeFileSync, copyFileSync, realpathSync, lstatSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { safeDirectory } from './safe-extract.mjs';
import { latestStable } from './upstream.mjs';
import { readManifest, candidateKey, inputRevision, sha256, invalid } from './manifest.mjs';
import { prepare } from './patches.mjs';
import { readJSON, finalizeCandidate } from './state.mjs';
import { buildCodex } from './build-codex.mjs';
import { stripArtifacts } from './strip-artifacts.mjs';
import { packageStage } from './package.mjs';
import { candidatePayload } from './github.mjs';

const kit = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
export function sourceToolchain(text) {
  const channels = [...text.matchAll(/^\s*channel\s*=\s*"([^"]+)"\s*(?:#.*)?$/gm)];
  if (channels.length !== 1 || !/^\d+\.\d+\.\d+$/.test(channels[0][1])) throw invalid('Invalid source toolchain pin');
  return channels[0][1];
}
export function candidateToolchain(text, discovered) {
  const toolchain = sourceToolchain(text);
  if (toolchain !== discovered) throw invalid('Discovered source toolchain mismatch');
  return toolchain;
}
export async function discover({ manifest, repo, fetch: fetcher }) {
  if (!/^[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(repo ?? '') || repo === 'openai/codex') throw invalid('Explicit fork repository required');
  const release = await latestStable({ fixture: null, fetch: async url => {
    const r = await fetcher(url, { redirect: 'error', signal: AbortSignal.timeout(30000), headers: { Accept: 'application/vnd.github+json' } });
    if (r.status !== 200) throw invalid('Upstream discovery failed'); return r.json();
  } });
  if (release.tag === manifest.upstream.tag && release.commit !== manifest.upstream.commit) throw invalid('Pinned upstream tag moved');
  const toolchainResponse = await fetcher(`https://api.github.com/repos/openai/codex/contents/codex-rs/rust-toolchain.toml?ref=${release.commit}`, { redirect: 'error', signal: AbortSignal.timeout(30000), headers: { Accept: 'application/vnd.github+json' } });
  if (toolchainResponse.status !== 200) throw invalid('Upstream toolchain lookup failed');
  const toolchainFile = await toolchainResponse.json();
  if (toolchainFile.encoding !== 'base64' || typeof toolchainFile.content !== 'string') throw invalid('Upstream toolchain content invalid');
  const toolchain = sourceToolchain(Buffer.from(toolchainFile.content, 'base64').toString('utf8'));
  const key = candidateKey({ ...manifest, toolchain }, release.commit), branch = `update/${key.slice(0, 12)}`;
  const historyResponse = await fetcher(`https://api.github.com/repos/${repo}/pulls?state=all&base=fork&per_page=100`, { redirect: 'error', signal: AbortSignal.timeout(30000) });
  if (historyResponse.status !== 200) throw invalid('Candidate history lookup failed');
  const history = await historyResponse.json();
  if (!Array.isArray(history) || history.length >= 100) throw invalid('Candidate history needs an owner checkpoint');
  for (const prior of history) {
    if (prior.head?.repo?.full_name !== repo || !/^update\/[a-f0-9]{12}$/.test(prior.head?.ref ?? '')) continue;
    const previous = await fetcher(`https://api.github.com/repos/${repo}/contents/fork/candidate.json?ref=${encodeURIComponent(prior.head.ref)}`, { redirect: 'error', signal: AbortSignal.timeout(30000) });
    if (previous.status === 404) continue; // owner-deleted branch; merged pin remains authoritative
    if (previous.status !== 200) throw invalid('Candidate history content unavailable');
    const content = await previous.json(); let record;
    try { record = JSON.parse(Buffer.from(content.content, 'base64')); } catch { throw invalid('Candidate history malformed'); }
    const key = candidateKey(record.manifest);
    if (record.key !== key || prior.head.ref !== `update/${key.slice(0, 12)}`) throw invalid('Candidate history identity mismatch');
    if (record.manifest.upstream.tag === release.tag && record.manifest.upstream.commit !== release.commit) throw invalid('Previously seen upstream tag moved');
  }
  const existing = await fetcher(`https://api.github.com/repos/${repo}/git/ref/heads/${branch}`, { redirect: 'error', signal: AbortSignal.timeout(30000) });
  if (![200, 404].includes(existing.status)) throw invalid('Remote candidate lookup failed');
  return { ...release, toolchain, key, build: existing.status === 404 && (release.commit !== manifest.upstream.commit || release.tag !== manifest.upstream.tag) };
}
export async function nativeAssets({ assets, directory, fetch: fetcher }) {
  if (!Array.isArray(assets) || assets.length !== 2 || new Set(assets.map(a => a.name)).size !== 2 || !assets.some(a => a.name.startsWith('src_binding')) || !assets.some(a => a.name.startsWith('librusty_v8'))) throw invalid('Pinned V8 binding and library assets required');
  safeDirectory(directory);
  for (const asset of assets) {
    const url = new URL(asset.url);
    if (!/^(?:src_binding[A-Za-z0-9_-]*\.rs|librusty_v8[A-Za-z0-9_.-]*\.a(?:\.gz)?)$/.test(asset.name ?? '') || !/^[a-f0-9]{64}$/.test(asset.sha256 ?? '') || url.origin !== 'https://github.com' || !/^\/(?:denoland|seanh-oai)\/rusty_v8\/releases\/download\//.test(url.pathname) || url.username || url.password || url.search || url.hash) throw invalid('Native asset identity refused');
    const path = join(directory, asset.name);
    let existing; try { const stat = lstatSync(path); if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw invalid('Unsafe native asset entry'); existing = readFileSync(path); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (existing) { if (sha256(existing) !== asset.sha256) throw invalid('Native asset pin changed'); continue; }
    const response = await fetcher(url.href, { redirect: 'follow', signal: AbortSignal.timeout(120000) });
    if (response.status !== 200 || Number(response.headers?.get('content-length') ?? 0) > 128 * 1024 * 1024) throw invalid('Native asset download refused');
    const chunks = []; let size = 0;
    for await (const chunk of response.body) { size += chunk.length; if (size > 128 * 1024 * 1024) throw invalid('Native asset size limit'); chunks.push(Buffer.from(chunk)); }
    const bytes = Buffer.concat(chunks); if (sha256(bytes) !== asset.sha256) throw invalid('Native asset checksum mismatch');
    writeFileSync(path, bytes, { flag: 'wx', mode: 0o600 });
  }
}
export function reviewedReleasePayload({ merged, rebuilt }) {
  const expected = candidatePayload(merged);
  if (JSON.stringify(merged) !== JSON.stringify(expected) || merged.key !== rebuilt.key || merged.inputHash !== rebuilt.inputHash || merged.artifactHash !== rebuilt.artifactHash) throw invalid('Merged candidate artifact differs; release refused');
  return merged; // preserve reviewed receipt/compare identity; rebuild evidence is separate
}
export async function ciMain(args) {
  if (process.env.GITHUB_ACTIONS !== 'true') throw invalid('CI network preparation is not a local build mode');
  const [command] = args, m = readManifest(join(kit, 'fork/manifest.json'));
  if (command === 'discover') {
    const found = await discover({ manifest: m, repo: process.env.GITHUB_REPOSITORY, fetch });
    if (!process.env.GITHUB_OUTPUT) throw invalid('Actions output required');
    writeFileSync(process.env.GITHUB_OUTPUT, `commit=${found.commit}\ntag=${found.tag}\ntoolchain=${found.toolchain}\nbuild=${found.build}\n`, { flag: 'a' }); return found;
  }
  if (!['candidate', 'release'].includes(command)) throw invalid('Unknown CI command');
  const source = realpathSync(join(kit, '.work/upstream')), stateRoot = join(kit, '.work/ci-state');
  let assets; try { assets = command === 'release' ? m.native_assets : JSON.parse(process.env.P85_NATIVE_ASSETS ?? 'null'); } catch { throw invalid('Pinned native asset policy required'); }
  let manifest = m;
  if (command === 'candidate') {
    const release = { tag: process.env.UPSTREAM_TAG, commit: process.env.UPSTREAM_COMMIT };
    const toolchain = candidateToolchain(readFileSync(join(source, 'codex-rs/rust-toolchain.toml'), 'utf8'), process.env.UPSTREAM_TOOLCHAIN);
    const result = prepare({ manifest: { ...m, toolchain, native_assets: assets }, release, source, patchDir: join(kit, 'fork/patches'), stateRoot });
    if (result.state !== 'prepared') throw invalid('Candidate preparation refused');
    manifest = readJSON(join(stateRoot, 'candidates', `${result.key}.json`)).manifest;
  } else {
    if (!m.production_ready) throw invalid('Merged finalized manifest required');
    const result = prepare({ manifest: m, baseline: true, source, patchDir: join(kit, 'fork/patches'), stateRoot });
    if (result.state !== 'prepared') throw invalid('Release preparation refused');
  }
  await nativeAssets({ assets, directory: join(stateRoot, 'cargo-home/native-v8'), fetch });
  const candidatePath = join(stateRoot, 'candidates', `${candidateKey(manifest)}.json`), candidate = readJSON(candidatePath);
  const argsBuild = { manifest, source: candidate.source, stateRoot, patchDir: join(kit, 'fork/patches'), local: true, offline: true, deadlineMs: 85 * 60 * 1000 };
  let built = buildCodex({ ...argsBuild, prepareCache: true });
  if (built.state !== 'validated') throw invalid('CI build/test failed; private receipts retained on runner');
  if (!manifest.production_ready) {
    manifest = finalizeCandidate({ manifest, stateRoot }).manifest;
    built = buildCodex({ ...argsBuild, manifest });
    if (built.state !== 'validated') throw invalid('Exact finalized rebuild failed');
  }
  const receipt = readJSON(join(stateRoot, 'build-attempts', built.attempt, 'attempt.json'));
  const stripped = stripArtifacts({stateRoot, attempt: built.attempt});
  const stage = join(kit, '.work/stage'); mkdirSync(stage, { mode: 0o700 }); safeDirectory(join(stage, 'bin'));
  for (const artifact of stripped.artifacts) copyFileSync(artifact.path, join(stage, 'bin', artifact.bin));
  for (const name of ['LICENSE', 'NOTICE']) copyFileSync(join(candidate.source, name), join(stage, name));
  copyFileSync(join(kit, 'FORK-NOTICE.md'), join(stage, 'FORK-NOTICE.md'));
  writeFileSync(join(stage, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx' });
  writeFileSync(join(stage, 'FORK-VERSION'), manifest.fork_version + '\n', { flag: 'wx' });
  const output = join(kit, '.work/output'), packaged = packageStage({ stage, output, stateRoot, attempt: built.attempt });
  let payload = candidatePayload({ manifest, artifactHash: packaged.sha256, receiptHash: sha256(JSON.stringify(receipt)), previousCommit: candidate.previousCommit ?? m.upstream.commit });
  if (command === 'release') {
    const merged = readJSON(join(kit, 'fork/candidate.json'));
    const rebuilt = payload; payload = reviewedReleasePayload({ merged, rebuilt });
    writeFileSync(join(output, 'RELEASE-BUILD.json'), JSON.stringify({ key: rebuilt.key, inputHash: rebuilt.inputHash, artifactHash: rebuilt.artifactHash, receiptHash: rebuilt.receiptHash, reviewedReceiptHash: merged.receiptHash }) + '\n', { flag: 'wx' });
  }
  writeFileSync(join(output, 'candidate.json'), JSON.stringify(payload, null, 2) + '\n', { flag: 'wx' });
  copyFileSync(join(stage, 'manifest.json'), join(output, 'manifest.json'));
  return { state: 'validated-package', key: payload.key, inputHash: payload.inputHash, artifactHash: payload.artifactHash, submitted: false, published: false };
}
if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { console.log(JSON.stringify(await ciMain(process.argv.slice(2)))); }
  catch (error) { console.error(error.state === 'invalid-input' ? error.message : 'CI integration refused; inspect private runner evidence (details redacted)'); process.exitCode = 1; }
}
