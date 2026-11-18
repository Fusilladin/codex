// Test-only resolution boundary: no copied tree or parent-plan imports needed.
import { registerHooks, isBuiltin } from 'node:module';
import { realpathSync } from 'node:fs';
import { relative, isAbsolute, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = realpathSync(fileURLToPath(new URL('../', import.meta.url)));
registerHooks({
  resolve(specifier, context, nextResolve) {
    const result = nextResolve(specifier, context);
    if (isBuiltin(result.url)) return result;
    if (!result.url.startsWith('file:')) throw new Error('Standalone boundary requires builtins or fork files');
    const file = realpathSync(fileURLToPath(result.url));
    const child = relative(root, file);
    if (child === '..' || child.startsWith(`..${sep}`) || isAbsolute(child)) {
      throw new Error('Test dependency resolves outside standalone fork');
    }
    return result;
  },
});
// Explicitly spawned Node CLI/lock probes inherit the same boundary as tests.
const preload = `--import=${import.meta.url}`;
if (!(process.env.NODE_OPTIONS ?? '').includes(preload)) {
  process.env.NODE_OPTIONS = `${process.env.NODE_OPTIONS ?? ''} ${preload}`.trim();
}
