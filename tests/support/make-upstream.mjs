import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { cp, mkdir, readdir, writeFile } from 'node:fs/promises';
import { mkdirSync, mkdtempSync, realpathSync, renameSync, lstatSync } from 'node:fs';
import { join, relative, isAbsolute, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const exec = promisify(execFile);
const templates = fileURLToPath(new URL('./upstream-src/', import.meta.url));

/** Strict test-only scratch policy; never accepts arbitrary host directories. */
export function testTmpRoot() {
  const configured = process.env.FORKCTL_TEST_TMP_ROOT ?? '/tmp/t85/portable-tests';
  const spelling = resolve(configured);
  if (spelling === '/tmp/t85') throw new Error('Reserved test scratch parent');
  if (configured.split('/').some(c => c === '..' || c === '.' || c.startsWith('..'))) throw new Error('Invalid test scratch traversal');
  const tmp = realpathSync(process.env.TMPDIR ?? '/tmp');
  const legacy = /^\/tmp\/t85\/[a-zA-Z0-9][a-zA-Z0-9_-]*\/?$/.test(configured);
  // The caller authorizes one direct child, never TMPDIR itself or a descendant link.
  let parent;
  try { parent = legacy ? '/tmp/t85' : realpathSync(join(spelling, '..')); } catch { throw new Error('Invalid test scratch parent'); }
  if (!legacy && parent !== tmp) throw new Error('Test scratch must be an authorized TMPDIR child');
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(spelling.split('/').at(-1))) throw new Error('Invalid test scratch name');
  if (legacy) {
    mkdirSync('/tmp/t85', { recursive: true });
    if (realpathSync('/tmp/t85') !== '/tmp/t85') throw new Error('Unsafe test scratch ancestor');
  }
  const candidate = join(parent, spelling.split('/').at(-1));
  mkdirSync(candidate, { recursive: true });
  const base = realpathSync(candidate);
  if (resolve(base, '..') !== parent || !lstatSync(base).isDirectory()) throw new Error('Unsafe test scratch link');
  return base;
}

export function validateFixtureRoot(root) {
  const allowed = testTmpRoot();
  const base = realpathSync(root);
  const configured = resolve(process.env.FORKCTL_TEST_TMP_ROOT ?? '/tmp/t85/portable-tests');
  const spellings = [allowed, configured];
  const admitted = !root.split('/').some(c => c === '..') && spellings.some(parent => {
    const child = relative(parent, resolve(root));
    return child && child !== '..' && !child.startsWith(`..${sep}`) && !isAbsolute(child) && base === join(allowed, child);
  });
  if (!admitted) throw new Error('Fixture root must be a real child of configured test scratch');
  return base;
}

/** Allocate one unique caller-owned directory, removed after its test. */
export function testTemp(t, prefix = 'fixture-') {
  if (!/^[a-zA-Z0-9_-]+$/.test(prefix)) throw new Error('Invalid test temp prefix');
  const root = mkdtempSync(join(testTmpRoot(), prefix));
  t.after(() => {
    const archive = join(testTmpRoot(), '_archive', '20261117-tests');
    mkdirSync(archive, { recursive: true });
    renameSync(root, join(archive, root.split('/').at(-1)));
  });
  return root;
}

/** Create a tiny repository only in an empty, caller-owned round temp root. */
export async function makeUpstream({ root }) {
  const base = validateFixtureRoot(root);
  if ((await readdir(base)).length !== 0) throw new Error('Fixture root must be empty');
  const repo = join(base, 'upstream');
  await mkdir(repo);
  // Whitelist the environment: never inherit Git config, index, hooks or identity.
  const env = {
    PATH: process.env.PATH,
    HOME: base,
    XDG_CONFIG_HOME: base,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_TERMINAL_PROMPT: '0',
    GIT_AUTHOR_NAME: 'Offline Fixture',
    GIT_AUTHOR_EMAIL: '91526142+Fusilladin@users.noreply.github.com',
    GIT_COMMITTER_NAME: 'Offline Fixture',
    GIT_COMMITTER_EMAIL: '91526142+Fusilladin@users.noreply.github.com',
    GIT_AUTHOR_DATE: '2020-01-01T00:00:00Z',
    GIT_COMMITTER_DATE: '2020-01-01T00:00:00Z',
    LC_ALL: 'C',
  };
  const git = async (...args) => (await exec('git', [
    '-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgSign=false',
    '-c', 'tag.gpgSign=false', ...args,
  ], { cwd: repo, env, timeout: 15000 })).stdout.trim();
  await git('init', '--quiet', '--template=', '--initial-branch=fixture', '--object-format=sha1');
  for (const name of await readdir(templates)) {
    await cp(join(templates, name), join(repo, name), {
      recursive: true, force: false, errorOnExist: true,
    });
  }
  await writeFile(join(repo, 'fixture-release.txt'), 'Synthetic previous release\n', { flag: 'wx' });
  await git('add', '.');
  await git('commit', '--quiet', '-m', 'Synthetic previous release');
  const previous = await git('rev-parse', 'HEAD');
  await git('tag', 'rust-v0.167.1');
  await writeFile(join(repo, 'fixture-release.txt'), 'Synthetic stable release\n');
  await git('add', 'fixture-release.txt');
  await git('commit', '--quiet', '-m', 'Synthetic stable release');
  const stable = await git('rev-parse', 'HEAD');
  await git('tag', 'rust-v0.169.0');
  return {
    repo,
    tags: { previous: 'rust-v0.167.1', stable: 'rust-v0.169.0' },
    commits: { previous, stable },
  };
}
