import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { temp } from './helpers.mjs';
import { registerCoordinator, integrateOutcomes } from '../fork/lib/coordinator.mjs';
import { withLock } from '../fork/lib/state.mjs';
import { sha256 } from '../fork/lib/manifest.mjs';

test('overlapping completions preserve outcomes; sole writer and target exclusion never infer acceptance from skipped audit or exit', async t => {
  const root = temp(t), token = registerCoordinator(root), module = new URL('../fork/lib/coordinator.mjs', import.meta.url).href;
  await Promise.all(['first', 'second'].map(async (name, i) => {
    const code = `import {recordOutcome} from ${JSON.stringify(module)};recordOutcome(${JSON.stringify(root)},${JSON.stringify(name)},${JSON.stringify({ exit: 0, product: 'PASS', audit: i ? 'SKIPPED' : 'PASS', evidence: i ? 'NONE' : 'PASS' })});`;
    const child = spawn(process.execPath, ['--input-type=module', '-e', code], { stdio: 'ignore' });
    t.after(() => { if (child.exitCode === null) child.kill('SIGTERM'); });
    const [status] = await once(child, 'close'); assert.equal(status, 0);
  }));
  assert.throws(() => integrateOutcomes(root, 'not-owner'), /coordinator/);
  const outcomes = integrateOutcomes(root, token);
  assert.equal(Object.keys(outcomes).length, 2); assert.equal(outcomes['first.json'].accepted, true); assert.equal(outcomes['second.json'].accepted, false);
  assert.equal(JSON.parse(readFileSync(join(root, 'acceptance.json'))).first, undefined);
  const key = sha256('exclusive target');
  withLock(root, key, () => assert.equal(withLock(root, key, () => assert.fail('duplicate target owner')).state, 'busy'));
});
