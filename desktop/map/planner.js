/* Choosing an area to save: move and zoom the map until the frame holds it, and
   drag the frame's edges or corners for a different shape.
   Streets come from OpenStreetMap's public tiles as a preview only; with no
   connection the bundled world outline is still enough to aim with. */
(() => {
  const frame = document.querySelector("#frame"),
    measure = document.querySelector("#measure"),
    notice = document.querySelector("#notice"),
    accent = "#6a3fe0",
    empty = { type: "FeatureCollection", features: [] };
  const send = (data) => parent.postMessage(data, "obelisk://app");
  let last = null;
  try {
    last = JSON.parse(localStorage.getItem("mapPlannerView") || "null");
  } catch {}
  const map = new maplibregl.Map({
    container: "map",
    center: Array.isArray(last?.center) ? last.center : [8, 30],
    zoom: Number.isFinite(last?.zoom) ? last.zoom : 1.4,
    maxZoom: 17,
    renderWorldCopies: false,
    attributionControl: false,
    dragRotate: false,
    pitchWithRotate: false,
    style: {
      version: 8,
      sources: {
        world: { type: "geojson", data: "world.json" },
        streets: { type: "raster", tiles: ["https://tile.openstreetmap.org/{z}/{x}/{y}.png"], tileSize: 256, maxzoom: 19 },
        saved: { type: "geojson", data: empty },
        names: { type: "geojson", data: empty },
      },
      layers: [
        { id: "ocean", type: "background", paint: { "background-color": atlas.dark() ? "#101a33" : "#dfe8ee" } },
        { id: "land", type: "fill", source: "world", paint: { "fill-color": atlas.dark() ? "#1b1823" : "#f8f7f2" } },
        { id: "borders", type: "line", source: "world", paint: { "line-color": atlas.dark() ? "#423b52" : "#b8b8b0", "line-width": 0.65 } },
        { id: "streets", type: "raster", source: "streets", paint: { "raster-fade-duration": 0 } },
        // Areas already saved, so a new one can sit beside them or deliberately overlap.
        { id: "saved-fill", type: "fill", source: "saved", paint: { "fill-color": accent, "fill-opacity": 0.14 } },
        { id: "saved-line", type: "line", source: "saved", paint: { "line-color": accent, "line-width": 1.5, "line-dasharray": [3, 2] } },
        { id: "saved-name", type: "symbol", source: "names", layout: { "text-field": ["get", "title"], "text-size": 11, "text-max-width": 9, "text-font": ["Noto Sans Medium"] }, paint: { "text-color": "#4a22b8", "text-halo-color": "#ffffff", "text-halo-width": 2 } },
      ],
    },
  });
  atlas.onTheme(() => {
    map.setPaintProperty("ocean", "background-color", atlas.dark() ? "#101a33" : "#dfe8ee");
    map.setPaintProperty("land", "fill-color", atlas.dark() ? "#1b1823" : "#f8f7f2");
    map.setPaintProperty("borders", "line-color", atlas.dark() ? "#423b52" : "#b8b8b0");
  });
  map.touchZoomRotate.disableRotation();
  map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "top-right");
  const insets = () => {
    const box = frame.getBoundingClientRect();
    return { left: box.left, top: box.top, right: innerWidth - box.right, bottom: innerHeight - box.bottom };
  };
  function selection() {
    const box = frame.getBoundingClientRect(),
      a = map.unproject([box.left, box.bottom]),
      b = map.unproject([box.right, box.top]);
    return [Math.max(-180, a.lng), Math.max(-85, a.lat), Math.min(180, b.lng), Math.min(85, b.lat)];
  }
  function describe() {
    const [w, s, e, n] = selection(),
      rad = Math.PI / 180,
      width = Math.abs(e - w) * rad * 6371 * Math.cos(((s + n) / 2) * rad),
      height = Math.abs(n - s) * rad * 6371,
      show = (km) => (km >= 100 ? Math.round(km).toLocaleString() : km >= 10 ? km.toFixed(0) : km.toFixed(1));
    measure.textContent = `${show(width)} × ${show(height)} km`;
  }
  map.on("move", describe);

  // The frame's shape, as fractions of the view from each side, so it scales with it.
  const DEFAULT = { top: 0.13, right: 0.12, bottom: 0.13, left: 0.12 };
  let shape = { ...DEFAULT };
  try {
    const saved = JSON.parse(localStorage.getItem("mapPlannerFrame") || "null");
    if (saved && ["top", "right", "bottom", "left"].every((k) => Number.isFinite(saved[k]))) shape = saved;
  } catch {}
  // Room kept clear around it (the zoom buttons sit top right), and its smallest size.
  const MARGIN = { top: 16, right: 56, bottom: 16, left: 16 },
    SMALLEST = 64;
  function place() {
    const w = innerWidth,
      h = innerHeight,
      px = { top: shape.top * h, right: shape.right * w, bottom: shape.bottom * h, left: shape.left * w };
    for (const side of ["top", "right", "bottom", "left"]) px[side] = Math.max(MARGIN[side], px[side]);
    px.right = Math.min(px.right, w - px.left - SMALLEST);
    px.bottom = Math.min(px.bottom, h - px.top - SMALLEST);
    frame.style.inset = `${px.top}px ${px.right}px ${px.bottom}px ${px.left}px`;
    // With no room below, the size label moves inside the frame.
    frame.classList.toggle("tight", px.bottom < 44);
    describe();
  }
  for (const grip of frame.querySelectorAll(".grip")) {
    const side = grip.dataset.side;
    grip.addEventListener("pointerdown", (event) => {
      event.preventDefault();
      grip.setPointerCapture(event.pointerId);
      frame.classList.add("resizing");
      const start = { ...shape },
        x = event.clientX,
        y = event.clientY;
      const move = (e) => {
        const dx = (e.clientX - x) / innerWidth,
          dy = (e.clientY - y) / innerHeight,
          minW = (SMALLEST + MARGIN.left) / innerWidth,
          minH = (SMALLEST + MARGIN.top) / innerHeight;
        if (side.includes("w")) shape.left = Math.min(Math.max(0, start.left + dx), 1 - shape.right - minW);
        if (side.includes("e")) shape.right = Math.min(Math.max(0, start.right - dx), 1 - shape.left - minW);
        if (side.includes("n")) shape.top = Math.min(Math.max(0, start.top + dy), 1 - shape.bottom - minH);
        if (side.includes("s")) shape.bottom = Math.min(Math.max(0, start.bottom - dy), 1 - shape.top - minH);
        place();
      };
      const end = () => {
        grip.removeEventListener("pointermove", move);
        frame.classList.remove("resizing");
        try {
          localStorage.setItem("mapPlannerFrame", JSON.stringify(shape));
        } catch {}
        map.fire("moveend");
      };
      grip.addEventListener("pointermove", move);
      grip.addEventListener("pointerup", end, { once: true });
      grip.addEventListener("pointercancel", end, { once: true });
    });
    // Double-click puts the frame back to its usual shape.
    grip.addEventListener("dblclick", () => {
      shape = { ...DEFAULT };
      place();
      try {
        localStorage.removeItem("mapPlannerFrame");
      } catch {}
      map.fire("moveend");
    });
  }
  place();
  map.on("moveend", () => {
    const bbox = selection();
    if (bbox[0] < bbox[2] && bbox[1] < bbox[3]) send({ type: "map:selection", bbox });
    try {
      localStorage.setItem("mapPlannerView", JSON.stringify({ center: map.getCenter().toArray(), zoom: map.getZoom() }));
    } catch {}
  });
  addEventListener("resize", () => {
    place();
    map.once("idle", () => map.fire("moveend"));
  });
  addEventListener("message", async (event) => {
    if (event.source !== parent || event.origin !== "obelisk://app") return;
    const data = event.data || {};
    // Put a place inside the frame.
    if (data.type === "map:goto" && Array.isArray(data.bbox) && data.bbox.length === 4 && data.bbox.every(Number.isFinite)) {
      const [w, s, e, n] = data.bbox;
      map.fitBounds([[w, s], [e, n]], { padding: insets(), maxZoom: 15, duration: 900 });
    }
    if (data.type === "map:saved" && Array.isArray(data.maps)) {
      const saved = await atlas.read(data.maps.slice(0, 60));
      map.getSource("saved")?.setData(atlas.outlines(saved));
      map.getSource("names")?.setData(atlas.centers(saved));
    }
  });
  map.on("load", () => {
    describe();
    send({ type: "map:ready" });
    map.fire("moveend");
  });
  let warned = false;
  map.on("error", (event) => {
    if (warned || event.sourceId !== "streets") return;
    warned = true;
    notice.textContent = "No connection for the street preview. The outline is still enough to choose an area.";
  });
})();
