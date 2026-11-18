import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { validateFixtureRoot } from './make-upstream.mjs';
import { gzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';

const bins = ['codex', 'codex-code-mode-host', 'codex-exec-server'];
const hash = (data) => createHash('sha256').update(data).digest('hex');

// Minimal ustar writer lets us encode unsafe names/links without creating them
// on disk, invoking an extractor, or requiring third-party archive libraries.
function archive(entries) {
  const blocks = [];
  for (const { name, body = '', mode = 0o644, type = '0', link = '' } of entries) {
    const data = Buffer.from(body);
    const header = Buffer.alloc(512);
    const text = (value, offset, length) => header.write(value, offset, length, 'ascii');
    const octal = (value, offset, length) => text(value.toString(8).padStart(length - 1, '0') + '\0', offset, length);
    text(name, 0, 100);
    octal(mode, 100, 8);
    octal(0, 108, 8);
    octal(0, 116, 8);
    octal(data.length, 124, 12);
    octal(0, 136, 12);
    header.fill(32, 148, 156);
    text(type, 156, 1);
    text(link, 157, 100);
    text('ustar\0', 257, 6);
    text('00', 263, 2);
    const checksum = header.reduce((sum, byte) => sum + byte, 0);
    text(checksum.toString(8).padStart(6, '0') + '\0 ', 148, 8);
    blocks.push(header, data, Buffer.alloc((512 - data.length % 512) % 512));
  }
  blocks.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(blocks));
}

/** Write six tiny archives into an existing caller-owned round temp root. */
export async function makeTarballs({ root }) {
  const base = validateFixtureRoot(root);
  const patchset = hash('');
  const manifest = {
    schema: 1,
    production_ready: false,
    fork: 'codex',
    fork_version: '0.169.0-p1',
    upstream: { repo: 'openai/codex', tag: 'rust-v0.169.0', commit: '1'.repeat(40) },
    patches: [],
    patchset_sha256: patchset,
    toolchain: '1.95.0',
    lockfile_sha256: hash('synthetic fixture lockfile\n'),
    target: 'x86_64-unknown-linux-gnu',
    bins,
  };
  const entries = [
    ...bins.map((name) => ({
      name: `bin/${name}`, mode: 0o755,
      body: `#!/bin/sh\n# Harmless offline fixture, not a runtime.\nprintf '%s\\n' '${name === 'codex' ? 'codex-cli 0.169.0' : `${name} fixture`}'\n`,
    })),
    { name: 'LICENSE', body: 'Synthetic fixture license placeholder; not upstream licensing evidence.\n' },
    { name: 'NOTICE', body: 'Synthetic fixture notice; no upstream source distributed.\n' },
    { name: 'FORK-NOTICE.md', body: 'Unofficial synthetic test fixture. No real runtime included.\n' },
    { name: 'FORK-VERSION', body: '0.169.0-p1\n' },
    { name: 'manifest.json', body: JSON.stringify(manifest, null, 2) + '\n' },
  ];
  const good = archive(entries);
  const samples = {
    good,
    // One damaged gzip magic byte, otherwise byte-identical to good.
    corrupt: Buffer.from(good),
    traversal: archive(entries.map((entry) => entry.name === 'NOTICE'
      ? { ...entry, name: '../NOTICE' } : entry)),
    symlink: archive(entries.map((entry) => entry.name === 'NOTICE'
      ? { name: 'NOTICE', type: '2', link: 'LICENSE' } : entry)),
    wrongTarget: archive(entries.map((entry) => entry.name === 'manifest.json'
      ? { ...entry, body: JSON.stringify({ ...manifest, target: 'aarch64-unknown-linux-gnu' }, null, 2) + '\n' } : entry)),
    missingHelper: archive(entries.filter((entry) => entry.name !== 'bin/codex-exec-server')),
  };
  samples.corrupt[0] ^= 0xff;
  const paths = {};
  for (const [key, data] of Object.entries(samples)) {
    paths[key] = join(base, `${key}.tar.gz`);
    await writeFile(paths[key], data, { flag: 'wx' });
  }
  return paths;
}
