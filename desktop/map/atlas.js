/* Shared by the map viewer and the area chooser: reading saved maps and
   describing where they are. No remote fonts, tiles, sprites, or styles. */
window.atlas = (() => {
  const protocol = new pmtiles.Protocol();
  maplibregl.addProtocol("pmtiles", protocol.tile);
  const dark = () => document.documentElement.dataset.theme === "dark";
  const tidy = (html) =>
    String(html || "")
      .replace(/<[^>]+>/g, " ")
      .replace(/&copy;/g, "©")
      .replace(/&amp;/g, "&")
      .replace(/&nbsp;/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  /** Opens each saved map just far enough to learn where it is and how deep it goes. */
  async function read(maps) {
    const opened = await Promise.all(
      maps.map(async ({ id, title }) => {
        try {
          const archive = new pmtiles.PMTiles(
            new pmtiles.FetchSource(`obelisk://archive/${encodeURIComponent(id)}`),
          );
          const header = await archive.getHeader();
          protocol.add(archive);
          return {
            id,
            title: String(title || "Map"),
            archive,
            url: `pmtiles://${archive.source.getKey()}`,
            vector: header.tileType === 1,
            maxZoom: header.maxZoom,
            bbox: [header.minLon, header.minLat, header.maxLon, header.maxLat],
          };
        } catch {
          return null;
        }
      }),
    );
    return opened.filter(Boolean);
  }
  const ring = ([w, s, e, n]) => [[[w, s], [e, s], [e, n], [w, n], [w, s]]];
  /** One point per saved map, for a pin or a single name. */
  const centers = (maps) => ({
    type: "FeatureCollection",
    features: maps.map((map) => ({
      type: "Feature",
      properties: { id: map.id, title: map.title },
      geometry: { type: "Point", coordinates: [(map.bbox[0] + map.bbox[2]) / 2, (map.bbox[1] + map.bbox[3]) / 2] },
    })),
  });
  const outlines = (maps, focus) => ({
    type: "FeatureCollection",
    features: maps.map((map) => ({
      type: "Feature",
      properties: { id: map.id, title: map.title, focus: map.id === focus },
      geometry: { type: "Polygon", coordinates: ring(map.bbox) },
    })),
  });
  /**
   * Everything outside the saved areas, as plain rectangles. Saved areas may overlap,
   * so the world is cut into a grid along their edges and the uncovered cells kept.
   */
  function outside(maps) {
    const xs = [...new Set([-180, 180, ...maps.flatMap((m) => [m.bbox[0], m.bbox[2]])])].sort((a, b) => a - b),
      ys = [...new Set([-85.06, 85.06, ...maps.flatMap((m) => [m.bbox[1], m.bbox[3]])])].sort((a, b) => a - b),
      cells = [];
    for (let y = 0; y < ys.length - 1; y++) {
      let start = null;
      for (let x = 0; x < xs.length; x++) {
        const covered =
          x === xs.length - 1 ||
          maps.some(
            (m) => m.bbox[0] <= xs[x] && m.bbox[2] >= xs[x + 1] && m.bbox[1] <= ys[y] && m.bbox[3] >= ys[y + 1],
          );
        if (!covered && start === null) start = xs[x];
        if (covered && start !== null) {
          cells.push(ring([start, ys[y], xs[x], ys[y + 1]]));
          start = null;
        }
      }
    }
    return { type: "Feature", properties: {}, geometry: { type: "MultiPolygon", coordinates: cells } };
  }
  const bounds = (list) => [
    [Math.min(...list.map((m) => m.bbox[0])), Math.min(...list.map((m) => m.bbox[1]))],
    [Math.max(...list.map((m) => m.bbox[2])), Math.max(...list.map((m) => m.bbox[3]))],
  ];
  const detail = (zoom) =>
    zoom >= 15 ? "Buildings" : zoom >= 13 ? "Every street" : zoom >= 11 ? "Main streets" : zoom >= 9 ? "Towns and highways" : "Overview";
  /** Protomaps' cartography; the dark version is retuned to this app's palette so streets stay readable. */
  function flavor() {
    if (!dark()) return { ...basemaps.namedFlavor("light"), fog: "#f4f2f8", accent: "#6a3fe0" };
    const road = { other: "#2e2a3a", minor_service: "#322d40", minor_a: "#3a3449", minor_b: "#3a3449", link: "#4a4360", major: "#4a4360", highway: "#5e557a" },
      casing = "#141218", halo = "#141218";
    const stock = basemaps.namedFlavor("dark"), next = { ...stock };
    for (const key of Object.keys(stock)) {
      if (/casing/.test(key)) next[key] = casing;
      else if (/halo/.test(key)) next[key] = halo;
      else if (/^tunnel_/.test(key)) next[key] = "#2a2636";
      else if (/^bridges_/.test(key)) next[key] = road[key.slice(8)] || stock[key];
    }
    return {
      ...next, ...road,
      background: "#141218", earth: "#1b1823", water: "#101a33", buildings: "#262232", pedestrian: "#1f1c29",
      park_a: "#1a2a22", park_b: "#1b2e25", wood_a: "#1a2620", wood_b: "#1a2620", railway: "#3a3449", boundaries: "#6b6485",
      roads_label_minor: "#9a93ad", roads_label_major: "#b8b1cb", subplace_label: "#8a839c", city_label: "#d9d4e6",
      state_label: "#6f688a", country_label: "#a39db3", ocean_label: "#5f79b0", address_label: "#7c7590",
      fog: "#0b0a0e", accent: "#a586ff",
    };
  }
  /** Runs when the app switches between light and dark, however that happened. */
  function onTheme(change) {
    let last = dark();
    const check = () => {
      window.applyTheme?.();
      if (dark() !== last) {
        last = dark();
        change();
      }
    };
    // The app saves the choice; every other open page of the app hears about it.
    addEventListener("storage", (event) => (event.key === "theme" || event.key === null) && check());
    matchMedia("(prefers-color-scheme: dark)").addEventListener("change", check);
  }
  return { read, outlines, centers, outside, bounds, detail, dark, tidy, flavor, onTheme };
})();
