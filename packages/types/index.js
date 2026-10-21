/**
 * Shelves are the only categories. A file's `type` is its shelf: it names the
 * folder the file lives in and where it appears in the library. `kind` places it
 * one level deeper. Neither decides how a file opens; that follows its format.
 */
export const shelves = [
  { id: 'document', label: 'Documents', folder: 'Documents', kinds: [
    { id: 'book', label: 'Books' }, { id: 'paper', label: 'Papers & articles' },
    { id: 'manual', label: 'Manuals & guides' }, { id: 'note', label: 'Notes' },
    { id: 'record', label: 'Personal records' } ] },
  { id: 'audio', label: 'Audio', folder: 'Audio', kinds: [
    { id: 'podcast', label: 'Podcasts' }, { id: 'music', label: 'Music' },
    { id: 'audiobook', label: 'Audiobooks' }, { id: 'recording', label: 'Recordings' } ] },
  { id: 'video', label: 'Video', folder: 'Video', kinds: [
    { id: 'film', label: 'Films' }, { id: 'lecture', label: 'Talks & lectures' },
    { id: 'clip', label: 'Clips' }, { id: 'home', label: 'Home video' } ] },
  { id: 'image', label: 'Images', folder: 'Images', kinds: [
    { id: 'photo', label: 'Photos' }, { id: 'art', label: 'Art' }, { id: 'scan', label: 'Scans' } ] },
  { id: 'map', label: 'Maps', folder: 'Maps', kinds: [] },
  { id: 'reference', label: 'Reference', folder: 'Reference', kinds: [
    { id: 'encyclopedia', label: 'Encyclopedias' }, { id: 'website', label: 'Saved websites' } ] },
  { id: 'software', label: 'Software', folder: 'Software', kinds: [
    { id: 'installer', label: 'Apps & installers' }, { id: 'model', label: 'AI models' } ] },
  { id: 'other', label: 'Other', folder: 'Other', kinds: [
    { id: 'data', label: 'Data' }, { id: 'archive', label: 'Compressed archives' } ] },
];

/** shelf, kind implied by the format (if any), and the bundled way to open it. */
const table = [
  ['document', 'book', 'epub', ['epub']],
  ['document', 'book', '', ['mobi', 'azw', 'azw3', 'fb2', 'cbz', 'cbr', 'djvu']],
  ['document', '', 'pdf', ['pdf']],
  ['document', 'note', 'text', ['txt', 'md', 'markdown']],
  ['document', '', '', ['doc', 'docx', 'odt', 'rtf', 'pages', 'tex', 'html', 'htm', 'xls', 'xlsx', 'ods', 'numbers', 'ppt', 'pptx', 'odp', 'key']],
  ['audio', 'audiobook', 'audio', ['m4b']],
  ['audio', '', 'audio', ['mp3', 'm4a', 'aac', 'wav', 'flac', 'ogg', 'oga', 'opus']],
  ['audio', '', '', ['aiff', 'aif', 'wma', 'mid', 'midi']],
  ['video', '', 'video', ['mp4', 'm4v', 'webm', 'mov', 'mkv']],
  ['video', '', '', ['avi', 'wmv', 'mpg', 'mpeg', '3gp', 'flv']],
  ['image', '', 'image', ['jpg', 'jpeg', 'png', 'webp', 'gif', 'svg', 'avif', 'bmp']],
  ['image', 'photo', '', ['heic', 'heif', 'dng', 'cr2', 'cr3', 'nef', 'arw', 'raf', 'orf']],
  ['image', '', '', ['tif', 'tiff', 'psd']],
  ['map', '', 'map', ['pmtiles']],
  ['map', '', '', ['mbtiles', 'geojson', 'gpx', 'kml', 'kmz', 'osm.pbf']],
  ['reference', 'encyclopedia', 'zim', ['zim']],
  ['reference', 'website', 'web', ['wacz']],
  ['reference', 'website', '', ['warc', 'warc.gz', 'mht', 'mhtml']],
  ['software', 'installer', '', ['dmg', 'pkg', 'exe', 'msi', 'appimage', 'deb', 'rpm', 'apk', 'ipa', 'iso']],
  ['software', 'model', '', ['gguf', 'safetensors', 'onnx']],
  ['other', 'data', 'text', ['csv', 'tsv', 'json', 'xml', 'yaml', 'yml', 'log']],
  ['other', 'data', '', ['sqlite', 'db', 'parquet']],
  ['other', 'archive', '', ['zip', '7z', 'rar', 'tar', 'tar.gz', 'tgz', 'gz']],
];
const formats = new Map();
for (const [type, kind, media, extensions] of table)
  for (const ext of extensions) formats.set(ext, { type, kind, media });

export const shelfOf = (id) => shelves.find((s) => s.id === id);
export const hasKind = (type, kind) => !!shelfOf(type)?.kinds.some((k) => k.id === kind);

/** Recognizes a file by its extension, longest suffix first (`.tar.gz` before `.gz`). */
export function classify(filename) {
  const parts = String(filename).toLowerCase().split('.');
  for (let n = Math.min(parts.length - 1, 2); n >= 1; n--) {
    const found = formats.get(parts.slice(-n).join('.'));
    if (found) return found;
  }
  return { type: 'other', kind: '', media: '' };
}
/** Extensions offered first when adding to a shelf. Any file may still be chosen. */
export function shelfExtensions(type) {
  return [...formats].filter(([ext, f]) => f.type === type && !ext.includes('.')).map(([ext]) => ext);
}
/** Extensions that open inside the app on a shelf (narrowed to a kind where that kind has its own). */
export function viewable(type, kind = '') {
  const rows = table.filter(([t, , media]) => t === type && media),
    own = kind ? rows.filter(([, k]) => k === kind) : [];
  return (own.length ? own : rows).flatMap(([, , , extensions]) => extensions);
}
/** How the app opens a file, whatever shelf it has been filed on. */
export const mediaOf = (filename) => classify(filename).media;

const legacy = {
  podcast: ['audio', 'podcast'], book: ['document', 'book'], text: ['document', 'note'],
  encyclopedia: ['reference', 'encyclopedia'], web: ['reference', 'website'],
  model: ['software', 'model'], file: ['other', ''],
};
/** Manifests written before shelves keep working; their folders are left alone. */
export function normalizeItem(item) {
  const next = { ...item };
  if (legacy[next.type]) {
    const found = classify(next.filename || '');
    [next.type, next.kind] = found.type === 'other' && found.kind ? [found.type, found.kind] : legacy[next.type];
  }
  if (!shelfOf(next.type)) next.type = classify(next.filename || '').type;
  if (next.kind && !hasKind(next.type, next.kind)) delete next.kind;
  if (!next.kind) delete next.kind;
  if (next.section === 'personal' && next.personalFolder && !next.source?.folder)
    next.source = { ...next.source, folder: next.personalFolder };
  delete next.section; delete next.personalFolder;
  return next;
}

export function accessNote(filename, type = classify(filename).type) {
  const media = mediaOf(filename);
  if (media === 'epub') return 'Read in Obelisk or your preferred EPUB reader.';
  if (media === 'zim') return 'Read offline in Obelisk. Kiwix can also open the original ZIM.';
  if (media === 'map') return 'Explore in the bundled map viewer.';
  if (media === 'web') return 'Opens in Obelisk as it looked when saved, without using the internet. Any WACZ reader, such as ReplayWeb.page, can open it too.';
  if (media) return 'Opens in Obelisk.';
  return {
    map: 'This map format needs a compatible reader.',
    reference: 'Open with a compatible web archive reader. A reader is not bundled.',
    software: 'Check the publisher’s operating system and processor requirements before running.',
    audio: 'This audio format needs another player.',
    video: 'This video format needs another player.',
    image: 'This image format needs another viewer.',
  }[type] ?? 'Preserved as an ordinary file. Use a compatible application to open it.';
}
