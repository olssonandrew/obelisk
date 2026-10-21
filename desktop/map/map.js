/* One atlas of everything saved: each map drawn in full inside its own area,
   the rest of the world faded so it is clear where the saved detail stops. */
(async () => {
  const notice = document.querySelector("#notice"),
    places = document.querySelector("#places"),
    query = new URLSearchParams(location.search),
    focusId = query.get("item");
  let listed = [];
  try {
    listed = JSON.parse(query.get("maps") || "[]").filter((m) => m && typeof m.id === "string");
  } catch {}
  if (focusId && !listed.some((m) => m.id === focusId)) listed.unshift({ id: focusId, title: "" });
  const all = await atlas.read(listed.slice(0, 60));
  const focus = all.find((m) => m.id === focusId) || all[0];
  if (!focus) {
    notice.textContent = "This map could not be opened.";
    return;
  }
  // Full detail for the map that was opened and its nearest neighbours; the rest
  // keep their outline and open with a click. Each one costs about eighty layers.
  const distance = (m) =>
    Math.hypot((m.bbox[0] + m.bbox[2] - focus.bbox[0] - focus.bbox[2]) / 2, (m.bbox[1] + m.bbox[3] - focus.bbox[1] - focus.bbox[3]) / 2);
  const drawn = [focus, ...all.filter((m) => m !== focus).sort((a, b) => distance(a) - distance(b))].slice(0, 8);
  const sources = {
    world: { type: "geojson", data: "world.json" },
    outside: { type: "geojson", data: atlas.outside(all) },
    outlines: { type: "geojson", data: atlas.outlines(all, focus.id) },
    pins: { type: "geojson", data: atlas.centers(all) },
  };
  drawn.forEach((map, index) => {
    sources[`saved${index}`] = map.vector ? { type: "vector", url: map.url } : { type: "raster", url: map.url, tileSize: 256 };
  });
  /** The whole look, built from the theme in force right now. */
  function style() {
    const flavor = atlas.flavor(),
      accent = flavor.accent,
      below = [],
      labels = [];
  const template = basemaps.layers("saved", flavor, { lang: "en" }).filter((layer) => layer.type !== "background");
  for (const layer of template)
    drawn.forEach((map, index) => {
      if (!map.vector) return;
      // Seen from far away, a saved area's tiles are a few continent-sized blocks.
      // The plain world outline does that job better, so detail starts closer in.
      if (layer.type === "symbol") labels.push({ ...layer, id: `${layer.id}@${index}`, source: `saved${index}` });
      else below.push({ ...layer, id: `${layer.id}@${index}`, source: `saved${index}`, minzoom: Math.max(layer.minzoom || 0, 5) });
    });
  drawn.forEach((map, index) => {
    if (!map.vector) below.push({ id: `raster@${index}`, type: "raster", source: `saved${index}` });
  });
    return {
      version: 8,
      sprite: new URL(`sprites/${atlas.dark() ? "dark" : "light"}`, location.href).href,
      sources,
      layers: [
        { id: "ocean", type: "background", paint: { "background-color": flavor.water } },
        { id: "world", type: "fill", source: "world", paint: { "fill-color": flavor.earth } },
        { id: "world-borders", type: "line", source: "world", maxzoom: 6, paint: { "line-color": flavor.boundaries, "line-width": 0.6, "line-opacity": 0.6 } },
        ...below,
        // The fog: saved detail ends at the outline, and this says so.
        { id: "outside", type: "fill", source: "outside", paint: { "fill-color": flavor.fog, "fill-opacity": ["interpolate", ["linear"], ["zoom"], 3, 0.3, 8, 0.7], "fill-antialias": false } },
        { id: "outline", type: "line", source: "outlines", paint: { "line-color": accent, "line-width": ["case", ["get", "focus"], 2, 1.25], "line-opacity": ["case", ["get", "focus"], 0.95, 0.6] } },
        { id: "outline-hit", type: "fill", source: "outlines", paint: { "fill-color": accent, "fill-opacity": 0 } },
        ...labels,
        // From far away a saved area is smaller than a pixel; a pin keeps it findable.
        { id: "pins", type: "circle", source: "pins", maxzoom: 6, paint: { "circle-radius": 5, "circle-color": accent, "circle-stroke-color": flavor.fog, "circle-stroke-width": 2 } },
        { id: "pin-names", type: "symbol", source: "pins", maxzoom: 6, layout: { "text-field": ["get", "title"], "text-size": 11.5, "text-offset": [0, 1.1], "text-anchor": "top", "text-max-width": 10, "text-font": ["Noto Sans Medium"], "text-optional": true }, paint: { "text-color": accent, "text-halo-color": flavor.fog, "text-halo-width": 1.5 } },
      ],
    };
  }
  const map = new maplibregl.Map({
    container: "map",
    attributionControl: false,
    canvasContextAttributes: { preserveDrawingBuffer: true },
    maxZoom: Math.min(19, Math.max(...drawn.map((m) => m.maxZoom)) + 2),
    renderWorldCopies: false,
    bounds: atlas.bounds([focus]),
    fitBoundsOptions: { padding: 48 },
    style: style(),
  });
  // Light or dark was switched while the map is open: redraw in place, same view.
  atlas.onTheme(() => map.setStyle(style()));
  map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "top-right");
  map.addControl(new maplibregl.ScaleControl({ maxWidth: 120 }), "bottom-right");
  const show = (target) => map.fitBounds(atlas.bounds([target]), { padding: 48, duration: 700 });
  const open = (target) => {
    if (drawn.includes(target)) show(target);
    else parent.postMessage({ type: "map:open", id: target.id }, "obelisk://app");
  };
  if (all.length > 1) {
    // Tucked under the zoom buttons; the list appears only when asked for.
    const toggle = document.createElement("button"),
      group = document.createElement("div");
    toggle.type = "button";
    toggle.id = "places-toggle";
    toggle.title = toggle.ariaLabel = `Your ${all.length} saved maps`;
    toggle.setAttribute("aria-expanded", "false");
    toggle.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3l9 5-9 5-9-5zM3 13l9 5 9-5M3 17.5l9 5 9-5"/></svg>';
    group.className = "maplibregl-ctrl maplibregl-ctrl-group";
    group.append(toggle);
    map.addControl({ onAdd: () => group, onRemove: () => group.remove() }, "top-right");
    const shut = () => {
      places.hidden = true;
      toggle.setAttribute("aria-expanded", "false");
    };
    toggle.onclick = (event) => {
      event.stopPropagation();
      places.hidden = !places.hidden;
      toggle.setAttribute("aria-expanded", String(!places.hidden));
    };
    addEventListener("keydown", (event) => event.key === "Escape" && shut());
    map.on("mousedown", shut);
    const everything = document.createElement("button");
    everything.textContent = `Show all ${all.length}`;
    everything.className = "all";
    everything.onclick = () => {
      shut();
      map.fitBounds(atlas.bounds(all), { padding: 48, duration: 700 });
    };
    for (const item of [focus, ...all.filter((m) => m !== focus).sort((a, b) => a.title.localeCompare(b.title))]) {
      const button = document.createElement("button"),
        name = document.createElement("strong"),
        depth = document.createElement("small");
      name.textContent = item.title || "This map";
      depth.textContent = drawn.includes(item) ? atlas.detail(item.maxZoom) : "Open to see detail";
      button.append(name, depth);
      if (item === focus) button.setAttribute("aria-current", "true");
      button.onclick = () => {
        shut();
        open(item);
      };
      places.append(button);
    }
    places.append(everything);
  }
  map.on("click", "pins", (event) => {
    const target = all.find((m) => m.id === event.features[0]?.properties.id);
    if (target) open(target);
  });
  map.on("click", "outline-hit", (event) => {
    const target = all.find((m) => m.id === event.features[0]?.properties.id);
    // Only when looking from far enough away that the area is a shape, not the view.
    if (target && target !== focus && !drawn.includes(target)) open(target);
  });
  // Missing tiles at an area's edge are expected, not worth a message.
  map.on("error", (event) => {
    if (!map.loaded() && !/tile|404|Not Found/i.test(event.error?.message || ""))
      notice.textContent = `This map could not be drawn: ${event.error?.message || "unknown problem"}`;
  });
  map.once("load", () => (notice.textContent = ""));
  const credits = await Promise.all(drawn.map((m) => m.archive.getMetadata().then((meta) => atlas.tidy(meta.attribution), () => "")));
  const credit = [...new Set(credits.filter(Boolean))].join(" · ") || "© OpenStreetMap";
  document.querySelector("#credit").textContent = credit;
  map.once("idle", () => {
    if (!focusId || !map.queryRenderedFeatures().length) return;
    const canvas = document.createElement("canvas"),
      source = map.getCanvas(),
      context = canvas.getContext("2d");
    canvas.width = 480;
    canvas.height = 360;
    const scale = Math.max(480 / source.width, 360 / source.height);
    context.drawImage(source, (480 - source.width * scale) / 2, (360 - source.height * scale) / 2, source.width * scale, source.height * scale);
    context.fillStyle = atlas.dark() ? "#141218cc" : "#ffffffcc";
    context.fillRect(0, 344, 480, 16);
    context.fillStyle = atlas.dark() ? "#beb8ce" : "#514a61";
    context.font = "9px sans-serif";
    context.fillText(credit.slice(0, 100), 6, 355);
    parent.postMessage({ type: "map:thumbnail", id: focusId, image: canvas.toDataURL("image/jpeg", 0.85) }, "obelisk://app");
  });
})();
