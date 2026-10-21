/** Small, bounded catalog requests. Large content transfers use the download core. */
export function httpUrl(value, base) {
  const url = new URL(value, base);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('Expected an HTTP(S) URL without credentials.');
  return url.href;
}
export async function fetchText(url, { headers = {}, maxBytes = 8 * 1024 ** 2, fetchImpl = fetch } = {}) {
  const response = await fetchImpl(httpUrl(url), { headers: { 'User-Agent': 'Obelisk/0.2 (personal offline archive)', ...headers }, signal: AbortSignal.timeout(25000) });
  if (!response.ok) throw new Error(`Source returned HTTP ${response.status}. Please try again later.`);
  const chunks = []; let bytes = 0;
  for await (const chunk of response.body) {
    bytes += chunk.length;
    if (bytes > maxBytes) throw new Error('This catalog/feed is too large to load.');
    chunks.push(chunk);
  }
  return { text: Buffer.concat(chunks).toString('utf8'), url: response.url || url };
}
export async function fetchJson(url, options) { return JSON.parse((await fetchText(url, options)).text); }
