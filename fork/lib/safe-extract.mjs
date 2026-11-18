import { gunzipSync } from 'node:zlib';
import { mkdirSync, writeFileSync, lstatSync, realpathSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { allowedFiles } from './package.mjs';
import { validateManifest, invalid } from './manifest.mjs';
import { scanBytes, scanEntryName } from './canary.mjs';

export function safeDirectory(path) {
  path = resolve(path);
  if (path !== dirname(path)) safeDirectory(dirname(path));
  try { const s = lstatSync(path); if (!s.isDirectory() || s.isSymbolicLink()) throw invalid('Unsafe directory component'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; mkdirSync(path, { mode: 0o700 }); }
  if (realpathSync(path) !== path) throw invalid('Directory alias refused');
  return path;
}
export function inspectArchive(bytes) {
  if (bytes.length > 128 * 1024 * 1024) throw invalid('Compressed archive limit');
  let tar; try { tar = gunzipSync(bytes, { maxOutputLength: 512 * 1024 * 1024 }); } catch { throw invalid('Corrupt or oversized archive'); }
  const files = new Map(); let offset = 0;
  const text = (h, a, b) => { const part = h.subarray(a, b), zero = part.indexOf(0); return part.subarray(0, zero < 0 ? part.length : zero).toString('utf8'); };
  const octal = (h, a, b) => { const s = text(h, a, b).trim(); if (!/^[0-7]+$/.test(s)) throw invalid('Invalid tar numeric field'); return parseInt(s, 8); };
  while (offset + 512 <= tar.length && tar[offset] !== 0) {
    const h = tar.subarray(offset, offset + 512);
    const name = text(h, 0, 100), size = octal(h, 124, 136), mode = octal(h, 100, 108);
    const sum = h.reduce((n, b, i) => n + (i >= 148 && i < 156 ? 32 : b), 0);
    if (sum !== octal(h, 148, 156) || text(h, 257, 263) !== 'ustar' || text(h, 263, 265) !== '00' || text(h, 345, 500) || !['0', ''].includes(text(h, 156, 157)) || text(h, 157, 257) || !allowedFiles.includes(name) || files.has(name) || mode & 0o7000 || !Number.isSafeInteger(size)) throw invalid('Unsafe tar entry');
    const end = offset + 512 + size, next = offset + 512 + Math.ceil(size / 512) * 512;
    if (end > tar.length || next > tar.length) throw invalid('Truncated archive');
    const body = tar.subarray(offset + 512, end);
    scanEntryName(name); scanBytes(body, {name});
    files.set(name, { bytes: body, mode }); offset = next;
  }
  if (tar.length - offset < 1024 || tar.subarray(offset).some(b => b !== 0) || JSON.stringify([...files.keys()].sort()) !== JSON.stringify(allowedFiles)) throw invalid('Invalid archive file set or trailer');
  let manifest; try { manifest = validateManifest(JSON.parse(files.get('manifest.json').bytes)); } catch { throw invalid('Invalid archive manifest'); }
  if (files.get('FORK-VERSION').bytes.toString().trim() !== manifest.fork_version || manifest.bins.some(bin => !(files.get(`bin/${bin}`).mode & 0o111))) throw invalid('Archive identity or executable mismatch');
  return { files, manifest };
}
export function safeExtract(bytes, destination) {
  const inspected = inspectArchive(bytes); // complete validation before filesystem writes
  safeDirectory(dirname(destination));
  mkdirSync(destination, { mode: 0o700 }); // fresh, exclusive final component
  mkdirSync(join(destination, 'bin'), { mode: 0o755 });
  for (const [name, entry] of inspected.files) writeFileSync(join(destination, name), entry.bytes, { flag: 'wx', mode: name.startsWith('bin/') ? 0o755 : 0o644 });
  return inspected.manifest;
}
