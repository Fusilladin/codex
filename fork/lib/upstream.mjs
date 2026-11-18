import { readFileSync } from 'node:fs';
import { invalid } from './manifest.mjs';

// No implicit fetch/global network. Owner integrations must explicitly inject one.
export async function latestStable({ fixture = process.env.FORKCTL_UPSTREAM_FIXTURE, fetch: fetcher } = {}) {
  let envelope;
  if (fixture) envelope = JSON.parse(readFileSync(fixture, 'utf8'));
  else {
    if (!fetcher) throw invalid('Supply an upstream fixture or an explicit fetch adapter');
    const release = await fetcher('https://api.github.com/repos/openai/codex/releases/latest');
    if (!release || release.draft !== false || release.prerelease !== false || !/^rust-v\d+\.\d+\.\d+$/.test(release.tag_name ?? '')) throw invalid('Not a stable release');
    // Adapter resolves annotated/lightweight tags to a full commit, not a tag-object SHA.
    const commit = await fetcher(`https://api.github.com/repos/openai/codex/commits/${encodeURIComponent(release.tag_name)}`);
    envelope = { release, commit: commit.sha };
  }
  const { release, commit } = envelope ?? {};
  if (!release || release.draft !== false || release.prerelease !== false || !/^rust-v\d+\.\d+\.\d+$/.test(release.tag_name ?? '') || !/^[a-f0-9]{40}$/.test(commit ?? '') || /^0+$/.test(commit)) throw invalid('Invalid stable release envelope');
  return { tag: release.tag_name, commit };
}
export function assertTagIdentity(release, known = {}) {
  if (!release || !/^rust-v\d+\.\d+\.\d+$/.test(release.tag ?? '') || !/^[a-f0-9]{40}$/.test(release.commit ?? '') || /^0+$/.test(release.commit)) throw invalid('Invalid resolved release identity');
  if (known[release.tag] && known[release.tag] !== release.commit) throw Object.assign(new Error('Previously pinned tag moved; owner review required'), { state: 'tag-moved', code: 23 });
}
