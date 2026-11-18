import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { supervisedRun } from '../fork/lib/process-runner.mjs';
import { completeScrollCoverage, requiredScrollTests } from '../fork/lib/build-codex.mjs';
import { withLock, readJSON } from '../fork/lib/state.mjs';
import { sha256 } from '../fork/lib/manifest.mjs';
import { temp } from './helpers.mjs';

test('required paging coverage accepts genuine green and rejects partial, ignored, failed and duplicate tests', () => {
  const green = readFileSync(new URL('./support/accepted-green.txt', import.meta.url), 'utf8');
  assert.equal(completeScrollCoverage(green), true);
  assert.equal(completeScrollCoverage(`\x1b[32m${green}\x1b[0m`), true);
  for (const text of [
    'test unrelated ... ok\ntest result: ok. 1 passed; 0 failed; 0 ignored;',
    green.replace(`test ${requiredScrollTests[0]} ... ok`, ''),
    green.replace(`${requiredScrollTests[0]} ... ok`, `${requiredScrollTests[0]} ... ignored`),
    green.replace(`${requiredScrollTests[0]} ... ok`, `${requiredScrollTests[0]} ... FAILED`),
    green + `test ${requiredScrollTests[0]} ... ok\n`,
  ]) assert.equal(completeScrollCoverage(text), false);
});

test('deadline terminates and awaits an owned compiler descendant before target ownership transfers', t => {
  const root = temp(t), key = sha256('compiler fixture'), report = join(root, 'process.json'), pidFile = join(root, 'child.pid');
  const program = `const {spawn}=require('node:child_process');const fs=require('node:fs'); const c=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});fs.writeFileSync(${JSON.stringify(pidFile)},String(c.pid));setInterval(()=>{},1000);`;
  withLock(root, key, () => {
    const result = supervisedRun(process.execPath, ['-e', program], { env: { PATH: process.env.PATH }, stdio: 'ignore', deadline: Date.now() + 500, processReport: report });
    assert.equal(result.supervision.reason, 'deadline'); assert.equal(result.supervision.cleaned, true); assert.equal(result.ownershipUncertain, false);
    const pid = Number(readFileSync(pidFile, 'utf8'));
    try { const raw = readFileSync(`/proc/${pid}/stat`, 'utf8'); assert.equal(raw.slice(raw.lastIndexOf(')') + 2).split(' ')[0], 'Z'); }
    catch (e) { assert.equal(e.code, 'ENOENT'); }
    assert.equal(withLock(root, key, () => assert.fail('overlap')).state, 'busy');
  });
  assert.equal(withLock(root, key, () => 'acquired'), 'acquired');
  const interrupted = sha256('interrupted'); mkdirSync(join(root, 'locks'), { recursive: true });
  writeFileSync(join(root, 'locks', interrupted), JSON.stringify({ pid: 99999999, start: 'unknown' }));
  assert.equal(withLock(root, interrupted, () => assert.fail('unsafe reclaim')).state, 'busy');
  assert.equal(readJSON(join(root, 'locks', interrupted)).start, 'unknown');
});
