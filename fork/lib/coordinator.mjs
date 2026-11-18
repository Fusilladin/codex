import { join } from 'node:path';
import { mkdirSync, writeFileSync, readdirSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { sha256, invalid } from './manifest.mjs';
import { atomicJSON, readJSON, withLock } from './state.mjs';

export function registerCoordinator(root) {
  mkdirSync(join(root, 'outcomes'), { recursive: true });
  const token = randomUUID();
  writeFileSync(join(root, 'coordinator.json'), JSON.stringify({ token, pid: process.pid }), { flag: 'wx' });
  return token;
}
export function recordOutcome(root, name, outcome) {
  if (!/^[a-z0-9-]+$/.test(name)) throw invalid('Invalid outcome name');
  writeFileSync(join(root, 'outcomes', `${name}.json`), JSON.stringify(outcome), { flag: 'wx' });
}
export function integrateOutcomes(root, token) {
  if (readJSON(join(root, 'coordinator.json'))?.token !== token) throw invalid('Only designated coordinator writes shared status');
  return withLock(root, sha256('status writer'), () => {
    const outcomes = Object.fromEntries(readdirSync(join(root, 'outcomes')).filter(n => n.endsWith('.json')).sort().map(name => {
      const outcome = readJSON(join(root, 'outcomes', name));
      return [name, { ...outcome, accepted: outcome.product === 'PASS' && outcome.audit === 'PASS' && outcome.evidence === 'PASS' }];
    }));
    atomicJSON(join(root, 'acceptance.json'), outcomes);
    return outcomes;
  });
}
