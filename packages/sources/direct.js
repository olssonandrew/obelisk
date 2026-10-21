/** A source adapter resolves a user input into an acquisition plan. */
export const directSource = {
  id: 'direct',
  label: 'Direct download',
  resolve(input) {
    const url = new URL(input.url);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
      throw new Error('Use an HTTP or HTTPS URL without embedded credentials.');
    }
    let filename;
    try { filename = decodeURIComponent(url.pathname.split('/').pop()); }
    catch { throw new Error('The URL contains an invalid filename.'); }
    return {
      url: url.href,
      filename: input.filename?.trim() || filename || 'download.bin',
      title: input.title?.trim() || filename || 'Untitled download',
      description: input.description?.trim() || '',
      rights: input.rights?.trim() || 'Not specified; check the original source.',
      source: { adapter: 'direct', url: url.href, provider: url.hostname },
    };
  },
};
