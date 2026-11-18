import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

export const sha256 = data => createHash('sha256').update(data).digest('hex');
export const patchsetHash = patches => sha256(patches.map(p => `${p.file}:${p.sha256}\n`).join(''));
export function invalid(message) {
  return Object.assign(new Error(message), { state: 'invalid-input', code: 64 });
}
export function validateManifest(m) {
  const hex = /^[a-f0-9]{64}$/;
  if (!m || m.schema !== 1 || m.fork !== 'codex' || !/^\d+\.\d+\.\d+-p\d+$/.test(m.fork_version ?? '')) throw invalid('Invalid manifest identity');
  if (m.upstream?.repo !== 'openai/codex' || !/^rust-v\d+\.\d+\.\d+$/.test(m.upstream.tag ?? '') || !/^[a-f0-9]{40}$/.test(m.upstream.commit ?? '') || /^0+$/.test(m.upstream.commit)) throw invalid('Unresolved or invalid upstream identity');
  if (m.fork_version.split('-p')[0] !== m.upstream.tag.slice(6)) throw invalid('Version/tag mismatch');
  if (m.target !== 'x86_64-unknown-linux-gnu' || !/^\d+\.\d+\.\d+$/.test(m.toolchain ?? '')) throw invalid('Invalid target/toolchain');
  if (typeof m.production_ready !== 'boolean') throw invalid('Explicit boolean readiness required');
  if (m.production_ready && !hex.test(m.lockfile_sha256 ?? '')) throw invalid('Ready manifest requires pinned lock');
  if (!(m.lockfile_sha256 === null && m.production_ready === false) && !hex.test(m.lockfile_sha256 ?? '')) throw invalid('Invalid lockfile hash');
  if (m.native_assets !== undefined) {
    if (!Array.isArray(m.native_assets) || m.native_assets.length !== 2 || m.native_assets.some(a => !a || typeof a !== 'object') || new Set(m.native_assets.map(a => a.name)).size !== 2 || !m.native_assets.some(a => a.name?.startsWith('src_binding')) || !m.native_assets.some(a => a.name?.startsWith('librusty_v8'))) throw invalid('Pinned native input pair required');
    for (const asset of m.native_assets) {
      let url; try { url = new URL(asset.url); } catch { throw invalid('Invalid native input URL'); }
      if (!/^(?:src_binding[A-Za-z0-9_-]*\.rs|librusty_v8[A-Za-z0-9_.-]*\.a(?:\.gz)?)$/.test(asset.name ?? '') || !hex.test(asset.sha256 ?? '') || url.origin !== 'https://github.com' || !/^\/(?:denoland|seanh-oai)\/rusty_v8\/releases\/download\//.test(url.pathname) || url.username || url.password || url.search || url.hash) throw invalid('Invalid pinned native input');
    }
  }
  if (!Array.isArray(m.patches)) throw invalid('Invalid patch list');
  let previous = '';
  for (const patch of m.patches) {
    if (!/^\d{4}-[a-z0-9-]+\.patch$/.test(patch.file ?? '') || patch.file <= previous || !hex.test(patch.sha256 ?? '')) throw invalid('Invalid ordered patch identity');
    previous = patch.file;
  }
  if (!hex.test(m.patchset_sha256 ?? '') || m.patchset_sha256 !== patchsetHash(m.patches)) throw invalid('Patchset hash mismatch');
  if (JSON.stringify(m.bins) !== JSON.stringify(['codex', 'codex-code-mode-host', 'codex-exec-server'])) throw invalid('Invalid helper list');
  return m;
}
export const readManifest = path => validateManifest(JSON.parse(readFileSync(path, 'utf8')));
export function candidateKey(m, commit = m.upstream.commit) {
  validateManifest(m);
  if (!/^[a-f0-9]{40}$/.test(commit)) throw invalid('Invalid candidate commit');
  return sha256(`${m.fork}|${commit}|${m.patchset_sha256}|${m.target}|${m.toolchain}`);
}

export const inputRevision = m => sha256(JSON.stringify(validateManifest(m)));
