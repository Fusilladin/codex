import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { testTemp } from './support/make-upstream.mjs';
export { testTmpRoot } from './support/make-upstream.mjs';
import { fileURLToPath } from 'node:url';
import { readManifest, patchsetHash, validateManifest } from '../fork/lib/manifest.mjs';
export const kit = fileURLToPath(new URL('../', import.meta.url));
export const patchDir = fileURLToPath(new URL('../fork/patches/', import.meta.url));
export function temp(t) {
  return testTemp(t, 'codex-');
}
/**
 * P1's tiny upstream templates model only 0001 application, not the real Rust APIs.
 * Derive an explicitly synthetic 0001-only manifest; never weaken the real manifest
 * (which also pins 0002). The caller supplies a test-owned synthetic commit.
 * Package fixtures reuse this identity to test packaging, not production readiness.
 */
export function synthetic0001OnlyManifest(commit) {
  const patch = readFileSync(new URL('../fork/patches/0001-scroll-40-percent.patch', import.meta.url));
  if (createHash('sha256').update(patch).digest('hex') !== '555a8ab95a01cc2dc3bee177fb860499cf8b177d1552e611e21228dc6877e6e1') {
    throw new Error('Checked-in patch provenance mismatch');
  }
  const m = readManifest(new URL('../fork/manifest.json', import.meta.url));
  const patches = m.patches.filter(p => p.file === '0001-scroll-40-percent.patch');
  if (patches.length !== 1) throw new Error('Synthetic fixture requires exact 0001 identity');
  const { native_assets, ...synthetic } = m; // Tiny fixture has no native engine dependency.
  return validateManifest({ ...synthetic, patches, patchset_sha256: patchsetHash(patches),
    upstream: { ...m.upstream, commit }, production_ready: false, lockfile_sha256: null });
}
// Preserve existing fixture call sites while making the synthetic derivation explicit.
export { synthetic0001OnlyManifest as manifest };
