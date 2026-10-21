import { fetchJson } from './http.js';
export const MAP_BUILDS = 'https://build-metadata.protomaps.dev/builds.json';
/** Detail levels offered, by the deepest zoom saved. */
export const mapDetail = { 10: 'towns and highways', 12: 'main streets', 14: 'every street', 15: 'buildings and paths' };
/**
 * Finds a place by name so its area can be framed. Uses OpenStreetMap's Nominatim,
 * whose usage policy asks for an identifying User-Agent, searches a person asked
 * for (no search-as-you-type), and no more than one a second.
 */
export async function searchPlaces(query, options) {
  const text = String(query || '').trim().slice(0, 200);
  if (text.length < 2) throw new Error('Type the name of a place.');
  let found;
  try { found = await fetchJson(`https://nominatim.openstreetmap.org/search?${new URLSearchParams({ q: text, format: 'jsonv2', limit: '6', 'accept-language': 'en' })}`, options); }
  catch { throw new Error('Place search is unavailable right now. You can still move the map by hand.'); }
  const places = (Array.isArray(found) ? found : []).map((place) => {
    const [south, north, west, east] = (place.boundingbox || []).map(Number);
    if (![south, north, west, east].every(Number.isFinite) || west >= east || south >= north) return null;
    // A point of interest gets a little room around it.
    const padX = Math.max(0, (0.02 - (east - west)) / 2), padY = Math.max(0, (0.015 - (north - south)) / 2);
    const parts = String(place.display_name || text).split(',').map((part) => part.trim());
    return { name: parts[0], where: parts.slice(1).join(', '), kind: String(place.addresstype || place.type || '').replace(/_/g, ' '),
      bbox: [Math.max(-180, west - padX), Math.max(-85, south - padY), Math.min(180, east + padX), Math.min(85, north + padY)] };
  }).filter(Boolean);
  return { places, attribution: 'Search © OpenStreetMap contributors' };
}
export async function mapCatalog(options) {
  const builds = await fetchJson(MAP_BUILDS, options);
  return { checkedAt: new Date().toISOString(), sourceUrl: MAP_BUILDS,
    builds: builds.filter(b => /^\d{8}\.pmtiles$/.test(b.key) && /^4\./.test(b.version)).sort((a,b) => b.key.localeCompare(a.key)).slice(0, 7)
      .map(b => ({ id: b.key, url: `https://build.protomaps.com/${b.key}`, bytes: b.size, version: b.version, date: `${b.key.slice(0,4)}-${b.key.slice(4,6)}-${b.key.slice(6,8)}` })) };
}
export function validateRegion(input) {
  const bbox = Array.isArray(input.bbox) ? input.bbox.map(Number) : [];
  const zoom = Number(input.zoom);
  if (bbox.length !== 4 || bbox.some(v => !Number.isFinite(v)) || bbox[0] < -180 || bbox[2] > 180 || bbox[1] < -85 || bbox[3] > 85 || bbox[0] >= bbox[2] || bbox[1] >= bbox[3]) throw new Error('Choose an area on the map. An area cannot cross the date line.');
  if (!Number.isInteger(zoom) || zoom < 6 || zoom > 15) throw new Error('Choose a detail level between 6 and 15.');
  const area = (bbox[2] - bbox[0]) * (bbox[3] - bbox[1]);
  if (area > 400 && zoom > 10) throw new Error('That area is too large for street detail. Zoom in, or choose “Towns and highways”.');
  return { bbox, zoom };
}
export function mapPlan(input, build) {
  const { bbox, zoom } = validateRegion(input);
  if (!build) throw new Error('Refresh map builds and select an available edition.');
  const title = String(input.title || '').trim().slice(0, 100) || 'My area';
  return { url: build.url, driver: 'pmtiles', bbox, zoom, type: 'map', filename: `${title.replace(/[\\/]/g,'-')} - ${build.date} - z${zoom}.pmtiles`, title,
    description: `Offline map with ${mapDetail[zoom] || `detail to zoom ${zoom}`}. OpenStreetMap data as of ${build.date}.`,
    rights: '© OpenStreetMap contributors · ODbL. Protomaps basemap; additional source attribution: https://github.com/protomaps/basemaps/blob/main/LICENSE_DATA.md',
    source: { adapter: 'maps', provider: 'Protomaps / OpenStreetMap', url: build.url, version: build.date, tilesetVersion: build.version, bbox, maxZoom: zoom,
      seriesKey: `map:${bbox.join(',')}:z${zoom}` } };
}
