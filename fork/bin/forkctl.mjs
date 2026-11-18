#!/usr/bin/env node
import { realpathSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve, dirname } from 'node:path';
import { readManifest, invalid } from '../lib/manifest.mjs';
import { latestStable } from '../lib/upstream.mjs';
import { checkRelease, exits, stateRoot, finalizeCandidate } from '../lib/state.mjs';
import { prepare } from '../lib/patches.mjs';
import { buildCodex } from '../lib/build-codex.mjs';
import { install, rollback, adoptOriginal, recoverInstall, status, list, runOld } from '../lib/install.mjs';
import { stripArtifacts } from '../lib/strip-artifacts.mjs';
import { packageStage } from '../lib/package.mjs';
const kit = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const help = `Offline forkctl (Node 24)\ncheck --state DIR [--manifest FILE] [--fixture FILE] [--json]\nprepare --state DIR --source REPO [--manifest FILE] [--baseline | --fixture FILE] [--json]\nbuild --local --source DIR --state DIR --offline [--manifest FILE] [--json]\nBuild state: project .work/<dedicated-state>, prepared archives only.\nstrip --state DIR --attempt UUID [--json]\npackage --stage DIR --output NEW_DIR [--json]\nFixture env: FORKCTL_UPSTREAM_FIXTURE. No implicit network or HOME writes.\nfinalize --state DIR --manifest FILE [--native-pins PUBLIC_JSON]\ninstall --home DIR --archive FILE --sha256 HASH [--local-evidence FILE | --fixture]\nstatus|list|recover --home DIR\nrollback --home DIR [--version VERSION]\nrun --home DIR --version VERSION --isolated\nadopt-original --home DIR --directory DIR --version VERSION\nLive upstream, PR and publish transports remain owner integrations.\n`;
export async function main(args) {
  if (!args.length || args[0] === '--help' || args[0] === 'help') return { help };
  const [command, ...rest] = args;
  if (command === 'publish') { if (rest.length !== 2 || rest[0] !== '--evidence') throw invalid('publish --evidence FILE required'); return (await import('../lib/publish.mjs')).publishFile(rest[1]); }
  if (!['check', 'prepare', 'package', 'strip', 'build', 'finalize', 'install', 'rollback', 'adopt-original', 'recover', 'status', 'list', 'run'].includes(command)) throw invalid('Command not implemented');
  const installCommands = ['install', 'rollback', 'adopt-original', 'recover', 'status', 'list', 'run'];
  const installOptions = { install: ['home', 'archive', 'sha256', 'fixture', 'local-evidence'], rollback: ['home', 'version'], 'adopt-original': ['home', 'directory', 'version'], recover: ['home'], status: ['home'], list: ['home'], run: ['home', 'version', 'isolated'] };
  const allowed = installCommands.includes(command) ? [...installOptions[command], 'json'] : command === 'finalize' ? ['state', 'manifest', 'native-pins', 'json'] : command === 'strip' ? ['state', 'attempt', 'json'] : command === 'package' ? ['stage', 'output', 'json', 'fixture', 'state', 'attempt'] : command === 'build' ? ['local', 'offline', 'source', 'state', 'manifest', 'json'] : command === 'prepare' ? ['state', 'source', 'manifest', 'fixture', 'baseline', 'json'] : ['state', 'source', 'manifest', 'fixture', 'json'];
  const opts = {};
  for (let i = 0; i < rest.length; i++) {
    const key = rest[i].slice(2);
    if (!rest[i].startsWith('--') || !allowed.includes(key) || key in opts) throw invalid('Unknown or duplicate argument');
    if ((['json', 'local', 'offline', 'baseline', 'isolated'].includes(key) || key === 'fixture' && ['install', 'package'].includes(command))) opts[key] = true;
    else {
      if (!rest[i + 1] || rest[i + 1].startsWith('--')) throw invalid('Missing option value');
      opts[key] = rest[++i];
    }
  }
  if (installCommands.includes(command)) {
    if (!opts.home) throw invalid('Explicit --home required');
    if (opts['local-evidence']) {
      const proof = JSON.parse(readFileSync(opts['local-evidence'], 'utf8'));
      opts.localArtifact = proof;
      opts.probe = () => ({ verdict: proof.verdict, binaryHash: proof.binaryHash, steps: proof.steps });
    }
    return { install, rollback, 'adopt-original': adoptOriginal, recover: recoverInstall, status, list, run: runOld }[command](opts);
  }
  if (command === 'strip') {
    if (!opts.state || !opts.attempt) throw invalid('Strip requires --state and --attempt');
    return stripArtifacts({stateRoot: opts.state, attempt: opts.attempt});
  }
  if (command === 'package') {
    if (!opts.stage || !opts.output) throw invalid('Package requires --stage and --output');
    return packageStage({ ...opts, stateRoot: opts.state });
  }
  if (command === 'check' && opts.source) throw invalid('--source is only valid for prepare');
  const root = stateRoot(opts.state);
  const manifestPath = resolve(opts.manifest ?? resolve(kit, 'fork/manifest.json'));
  const m = readManifest(manifestPath);
  if (command === 'finalize') return finalizeCandidate({ manifest: m, stateRoot: root, ...(opts['native-pins'] ? { nativeAssets: JSON.parse(readFileSync(opts['native-pins'], 'utf8')) } : {}) });
  if (command === 'build') return buildCodex({ manifest: m, source: opts.source, stateRoot: root,
    patchDir: resolve(kit, 'fork/patches'), local: opts.local, offline: opts.offline });
  if (opts.baseline && (opts.fixture || process.env.FORKCTL_UPSTREAM_FIXTURE)) throw invalid('Baseline cannot use upstream fixture discovery');
  if (opts.baseline) {
    if (!opts.source) throw invalid('Prepare requires explicit source repository');
    return prepare({ manifest: m, baseline: true, source: resolve(opts.source), patchDir: resolve(dirname(manifestPath), 'patches'), stateRoot: root });
  }
  const release = await latestStable({ fixture: opts.fixture ?? process.env.FORKCTL_UPSTREAM_FIXTURE });
  if (command === 'check') return checkRelease(m, release, root);
  if (!opts.source) throw invalid('Prepare requires explicit source repository');
  return prepare({ manifest: m, release, source: resolve(opts.source), patchDir: resolve(dirname(manifestPath), 'patches'), stateRoot: root });
}
if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const result = await main(process.argv.slice(2));
    console.log(result.help ?? JSON.stringify(result));
    process.exitCode = exits[result.state] ?? 0;
  } catch (error) {
    // Do not echo underlying FS/process errors: they may contain private paths/content.
    console.error(JSON.stringify({ state: error.state ?? 'invalid-input', message: error.state ? error.message : 'Input or filesystem operation failed (details redacted)' }));
    process.exitCode = error.code && Number.isInteger(error.code) ? error.code : 64;
  }
}
