// Planning range only: regional tile density varies dramatically.
export function estimateMap(bbox, zoom) {
  if (
    bbox.length !== 4 ||
    bbox.some((v) => !Number.isFinite(v)) ||
    bbox[0] >= bbox[2] ||
    bbox[1] >= bbox[3] ||
    bbox[0] < -180 ||
    bbox[2] > 180 ||
    bbox[1] < -85 ||
    bbox[3] > 85 ||
    !Number.isInteger(zoom) ||
    zoom < 6 ||
    zoom > 15
  )
    return null;
  let tiles = 0;
  const y = (lat) =>
    (1 - Math.asinh(Math.tan((lat * Math.PI) / 180)) / Math.PI) / 2;
  for (let z = 0; z <= zoom; z++) {
    const n = 2 ** z;
    const west = Math.max(0, Math.floor(((bbox[0] + 180) / 360) * n)),
      east = Math.min(n - 1, Math.floor(((bbox[2] + 180) / 360) * n)),
      north = Math.max(0, Math.floor(y(bbox[3]) * n)),
      south = Math.min(n - 1, Math.floor(y(bbox[1]) * n));
    tiles += (east - west + 1) * (south - north + 1);
  }
  const area = Math.abs(
    (((bbox[2] - bbox[0]) * Math.PI) / 180) *
      (Math.sin((bbox[3] * Math.PI) / 180) -
        Math.sin((bbox[1] * Math.PI) / 180)) *
      6371 ** 2,
  );
  return { tiles, area, low: tiles * 8 * 1024, high: tiles * 100 * 1024 };
}
