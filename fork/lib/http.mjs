import { invalid } from './manifest.mjs';

// No token lookup or default fetch: the owner explicitly constructs this adapter.
export function githubRequest({ token, fetch: fetcher, enableNetwork = false }) {
  if (enableNetwork !== true || typeof fetcher !== 'function' || typeof token !== 'string' || !token || /[\r\n]/.test(token)) throw invalid('Explicit authenticated network adapter required');
  return async ({ method, url, body, contentType, responseType = 'json' }) => {
    const target = new URL(url);
    if (!['https://api.github.com', 'https://uploads.github.com'].includes(target.origin) || target.username || target.password || !['GET', 'POST', 'PATCH'].includes(method) || !['json', 'bytes'].includes(responseType)) throw invalid('Authenticated HTTP scope refused');
    try {
      let result = await fetcher(target.href, { method, headers: { Authorization: `Bearer ${token}`, Accept: responseType === 'bytes' ? 'application/octet-stream' : 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', ...(body !== undefined ? { 'Content-Type': contentType ?? 'application/json' } : {}) }, body: body === undefined ? undefined : Buffer.isBuffer(body) ? body : JSON.stringify(body), redirect: 'manual', signal: AbortSignal.timeout(60000) });
      if (result.status === 302 && method === 'GET' && responseType === 'bytes' && /^\/repos\/[^/]+\/[^/]+\/releases\/assets\/\d+$/.test(target.pathname)) {
        const location = new URL(result.headers.get('location'));
        if (location.origin !== 'https://release-assets.githubusercontent.com' || location.username || location.password) throw invalid('Release redirect refused');
        // Signed public asset URL receives no Authorization header.
        result = await fetcher(location.href, { method: 'GET', redirect: 'error', signal: AbortSignal.timeout(60000) });
      }
      if (result.status >= 300 && result.status < 400) throw invalid('Redirect refused');
      const limit = responseType === 'bytes' ? 128 * 1024 * 1024 : 8 * 1024 * 1024;
      if (Number(result.headers?.get('content-length') ?? 0) > limit) throw invalid('Oversized GitHub response');
      const chunks = []; let size = 0;
      for await (const chunk of result.body ?? []) { size += chunk.length; if (size > limit) throw invalid('Oversized GitHub response'); chunks.push(Buffer.from(chunk)); }
      const bytes = Buffer.concat(chunks);
      return { status: result.status, data: responseType === 'bytes' ? bytes : bytes.length ? JSON.parse(bytes.toString()) : null };
    } catch { throw invalid('GitHub request failed (details redacted)'); }
  };
}
