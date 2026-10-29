/** Discovery UI is separate from library rendering and source implementation. */
import { estimateMap } from "./map-estimate.js";
export function initSources({ api, el, size, toast, onQueued }) {
  const $ = (selector) => document.querySelector(selector);
  const post = (url, data) =>
    api(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data),
    });
  let status = {},
    currentFeed = null,
    episodePage = 0,
    wikiStart = 0,
    wikiCount = 0,
    maps = null,
    selected = new Set();
  const initialized = new Set();
  const duration = (value) =>
    /^\d+$/.test(String(value))
      ? `${Math.floor(Number(value) / 60)}:${String(Number(value) % 60).padStart(2, "0")}`
      : value;
  function message(target, text, error = false) {
    const node = $(target);
    node.replaceChildren(
      el("p", text, error ? "source-message error" : "source-message"),
    );
  }
  function notice(data, target) {
    $(target).textContent =
      data.warning ||
      `${data.cached ? "Saved catalog" : "Checked just now"}${data.checkedAt ? ` · ${new Date(data.checkedAt).toLocaleString()}` : ""}`;
    $(target).classList.toggle("error", Boolean(data.stale));
  }
  function button(label, action, className = "secondary") {
    const b = el("button", label, className);
    b.type = "button";
    b.addEventListener("click", action);
    return b;
  }
  function loading(container, text = "Finding something worth keeping…") {
    message(container, text);
  }
  function queueButton(item, extra) {
    const b = button(
      item.saved ? "In your library" : "Download",
      async () => {
        b.disabled = true;
        b.textContent = "Preparing…";
        try {
          const result = await post("/api/sources/acquire", { key: item.key });
          b.textContent = result.duplicate ? "In your library" : "Queued";
          toast(
            result.duplicate
              ? "Already in your library."
              : "Added to downloads.",
          );
          await onQueued();
          extra?.();
        } catch (error) {
          b.disabled = false;
          b.textContent = "Try again";
          toast(error.message, true);
        }
      },
      "primary",
    );
    b.disabled = Boolean(item.saved);
    return b;
  }
  $("#page-wikipedia").innerHTML =
    `<div class="source-heading"><div><h1>Wikipedia</h1></div><div class="source-emblem">W</div></div>
    <form id="wiki-form" class="discovery-search"><input name="query" aria-label="Search Wikipedia editions" placeholder="Find a topic, or browse everything"><select name="language" aria-label="Wikipedia language"><option value="eng">English</option><option value="spa">Español</option><option value="fra">Français</option><option value="deu">Deutsch</option><option value="ita">Italiano</option><option value="por">Português</option><option value="zho">中文</option><option value="jpn">日本語</option><option value="hin">हिन्दी</option><option value="ara">العربية</option></select><button class="primary">Find editions</button></form>
    <div class="source-context"><span>Current editions from Kiwix</span><button id="wiki-refresh" class="text-button"><i data-icon="refresh"></i>Refresh catalog</button></div><p id="wiki-notice" class="source-note" role="status"></p><div id="wiki-results" class="discovery-grid"></div><div class="pagination"><button id="wiki-prev" class="secondary">← Previous</button><span id="wiki-page"></span><button id="wiki-next" class="secondary">Next →</button></div>
    <details class="source-details"><summary>About editions and offline reading</summary><p>Full editions can be very large. “Maxi” includes pictures; “nopic” omits them; “mini” is a shorter edition where offered. Dates refer to the archive edition, not a live Wikipedia mirror. Downloading a newer edition keeps your existing copy. Read downloaded Wikipedia editions directly in Obelisk, including search and saved images. When available, publisher SHA-256 checksums are verified before files enter your library.</p></details>`;
  $("#page-podcasts").innerHTML =
    `<div class="source-heading"><div><h1>Podcasts</h1></div><div class="source-emblem podcast-emblem"><i></i><i></i><i></i><i></i><i></i><i></i><i></i></div></div>
    <form id="podcast-search" class="discovery-search"><input name="query" required minlength="2" aria-label="Search public podcasts" placeholder="Search shows, people, or a subject"><button class="primary">Find podcasts</button></form>
    <div class="source-context"><span>Public podcast search · no account needed</span><button id="show-rss" class="text-button"><i data-icon="plus"></i>Add by RSS link</button></div>
    <form id="rss-form" class="discovery-search" hidden><input name="url" type="url" required aria-label="Podcast RSS URL" placeholder="https://example.com/podcast/feed.xml"><button class="primary">Open feed</button></form>
    <div id="saved-shows" class="saved-shows"></div><p id="podcast-notice" class="source-note" role="status"></p><div id="podcast-results" class="discovery-grid"></div><section id="episode-panel" hidden><div class="feed-heading"><div><h2 id="feed-title"></h2><p id="feed-description"></p></div><button id="follow-show" class="secondary">Save show</button></div><div class="episode-toolbar"><label><input id="select-episodes" type="checkbox"> Select 10 available on this page</label><button id="download-selected" class="primary" disabled>Download selected</button><button id="refresh-feed" class="text-button"><i data-icon="refresh"></i>Check for new episodes</button></div><nav id="episodes-top" class="episode-pagination" aria-label="Episode pages, top"></nav><div id="episodes"></div><nav id="episodes-bottom" class="episode-pagination" aria-label="Episode pages, bottom"></nav></section>
    <details class="source-details"><summary>Sources and organization</summary><p>Search uses Apple’s public podcast directory. Episodes come directly from the publisher’s RSS feed and original media links. Saved shows are bookmarks: Obelisk checks for new episodes when you ask, without downloading them automatically. Episodes are grouped by show, named by date and title, and remembered by their feed identity. Browse episodes 100 at a time, newest first. Only episodes included in the publisher’s feed are available. Publisher rights still apply.</p></details>`;
  $("#page-maps").innerHTML = `<div class="source-heading"><h1>Maps</h1></div>
    <p class="muted page-lede">Find a place, or move the map until the frame holds what you want.</p>
    <div class="map-planner">
      <div class="map-selection"><iframe id="map-selector" src="map/planner.html" title="Choose map area"></iframe></div>
      <form id="map-form" class="panel map-form">
        <div class="map-search">
          <div class="discovery-search"><input id="map-place" type="search" aria-label="Find a place" placeholder="Find a city, region or country" autocomplete="off"><button type="button" id="map-find" class="secondary">Find</button></div>
          <div id="map-places" class="map-places" role="listbox" aria-label="Places found" hidden></div>
        </div>
        <label>Name<input name="title" maxlength="100" placeholder="Name this map" required></label>
        <fieldset class="map-detail"><legend>How much detail</legend>
          <label><input type="radio" name="zoom" value="10"><span><strong>Towns and highways</strong><small>For a country or large region</small></span></label>
          <label><input type="radio" name="zoom" value="12"><span><strong>Main streets</strong><small>Finding your way between places</small></span></label>
          <label><input type="radio" name="zoom" value="14" checked><span><strong>Every street</strong><small>Street names; right for a city</small></span></label>
          <label><input type="radio" name="zoom" value="15"><span><strong>Buildings and paths</strong><small>The most there is; largest</small></span></label>
        </fieldset>
        <div id="map-estimate" class="map-estimate" role="status"></div>
        <button id="map-download" class="primary">Save this map</button>
        <p id="map-tool-note" class="source-note"></p>
      </form>
    </div>
    <div class="source-context"><span id="maps-notice" role="status"></span><button id="maps-refresh" class="text-button"><i data-icon="refresh"></i>Check for newer map data</button></div>
    <details class="source-details"><summary>What you get</summary><p>One PMTiles file on the Maps shelf holding roads, street and place names, water, parks and buildings for the framed area, from OpenStreetMap as packaged by Protomaps. It opens in the map viewer here alongside every other map you have saved, and other PMTiles tools can read it. The street picture on this page is a live preview from OpenFreeMap and is not what is saved. Satellite imagery, routing and address search are not included. A paused map download starts again from the beginning.</p></details>`;

  function savedShows() {
    $("#saved-shows").replaceChildren();
    if (!status.followed?.length) return;

    for (const show of status.followed)
      $("#saved-shows").append(
        button(show.title, () => loadFeed(show.feedUrl), "show-chip"),
      );
  }
  async function loadWiki(refresh = false) {
    loading("#wiki-results", "Checking the Kiwix catalog…");
    $("#wiki-prev").disabled = true;
    $("#wiki-next").disabled = true;
    const fields = new FormData($("#wiki-form"));
    try {
      const data = await api(
        `/api/sources/wikipedia?${new URLSearchParams({ language: fields.get("language"), query: fields.get("query"), start: wikiStart, refresh: refresh ? "1" : "0" })}`,
      );
      wikiCount = data.total;
      notice(data, "#wiki-notice");
      $("#wiki-results").replaceChildren();
      for (const entry of data.entries) {
        const card = el("article", "", "source-card");
        const top = el("div", "", "source-card-top");
        top.append(
          el("span", entry.edition || "EDITION", "source-badge"),
          el("span", entry.version, "source-date"),
        );
        card.append(
          top,
          el("h2", entry.title),
          el("p", entry.description, "source-description"),
        );
        const stats = el("div", "", "source-card-stats");
        stats.append(
          el("strong", entry.bytes ? size(entry.bytes) : "Size unknown"),
          el("span", entry.language.toUpperCase()),
        );
        card.append(stats);
        if (entry.updateAvailable)
          card.append(el("p", "Newer than your saved edition", "update-note"));
        if (entry.localVersions.length)
          card.append(
            el(
              "small",
              `Saved: ${entry.localVersions.join(", ")}`,
              "source-note",
            ),
          );
        card.append(queueButton(entry));
        $("#wiki-results").append(card);
      }
      if (!data.entries.length)
        message(
          "#wiki-results",
          "No editions found. Try a broader topic or another language.",
        );
      $("#wiki-page").textContent = data.total
        ? `${wikiStart + 1}–${wikiStart + data.entries.length} of ${data.total}`
        : "No editions";
      $("#wiki-prev").disabled = wikiStart === 0;
      $("#wiki-next").disabled = wikiStart + 24 >= data.total;
    } catch (error) {
      message("#wiki-results", error.message, true);
    }
  }
  $("#wiki-form").addEventListener("submit", (e) => {
    e.preventDefault();
    wikiStart = 0;
    loadWiki();
  });
  $("#wiki-refresh").addEventListener("click", () => loadWiki(true));
  $("#wiki-prev").addEventListener("click", () => {
    wikiStart = Math.max(0, wikiStart - 24);
    loadWiki();
  });
  $("#wiki-next").addEventListener("click", () => {
    if (wikiStart + 24 < wikiCount) {
      wikiStart += 24;
      loadWiki();
    }
  });
  $("#show-rss").addEventListener("click", () => {
    $("#rss-form").hidden = !$("#rss-form").hidden;
    if (!$("#rss-form").hidden) $("#rss-form input").focus();
  });
  $("#rss-form").addEventListener("submit", (e) => {
    e.preventDefault();
    loadFeed(new FormData(e.currentTarget).get("url"));
  });
  $("#podcast-search").addEventListener("submit", async (e) => {
    e.preventDefault();
    $("#episode-panel").hidden = true;
    loading("#podcast-results", "Searching public podcasts…");
    try {
      const data = await api(
        `/api/sources/podcasts/search?${new URLSearchParams({ q: new FormData(e.currentTarget).get("query"), provider: "apple" })}`,
      );
      notice(data, "#podcast-notice");
      $("#podcast-results").replaceChildren();
      for (const show of data.shows) {
        const card = el("article", "", "source-card podcast-card");
        card.append(
          el("div", show.title.slice(0, 1).toUpperCase(), "show-avatar"),
          el("h2", show.title),
          el("p", show.author, "source-description"),
          el("small", show.description, "source-note"),
          button(
            "Explore episodes →",
            () => loadFeed(show.feedUrl),
            "secondary",
          ),
        );
        $("#podcast-results").append(card);
      }
      if (!data.shows.length)
        message(
          "#podcast-results",
          "No shows found. Try another search or paste a public RSS link.",
        );
    } catch (error) {
      message("#podcast-results", error.message, true);
    }
  });
  function selectionChanged() {
    const available = [...$("#episodes").querySelectorAll("input:not(:disabled)")].slice(0, 10);
    $("#select-episodes").checked = available.length > 0 && available.every((box) => selected.has(box.dataset.key));
    $("#select-episodes").indeterminate = !$("#select-episodes").checked && available.some((box) => selected.has(box.dataset.key));
    $("#download-selected").disabled = !selected.size;
    $("#download-selected").textContent = selected.size
      ? `Download ${selected.size} episode${selected.size === 1 ? "" : "s"}`
      : "Download selected";
  }
  async function loadFeed(url, refresh = false) {
    loading("#podcast-results", "Reading the publisher’s feed…");
    $("#episode-panel").hidden = true;
    selected.clear();
    selectionChanged();
    try {
      currentFeed = await api(
        `/api/sources/podcasts/feed?${new URLSearchParams({ url, refresh: refresh ? "1" : "0" })}`,
      );
      notice(currentFeed, "#podcast-notice");
      $("#podcast-results").replaceChildren();
      $("#episode-panel").hidden = false;
      $("#feed-title").textContent = currentFeed.title;
      $("#feed-description").textContent = currentFeed.description;
      $("#follow-show").textContent = currentFeed.followed
        ? "Show saved"
        : "Save show";
      $("#follow-show").disabled = currentFeed.followed;
      $("#select-episodes").checked = false;
      episodePage = 0;
      renderEpisodes();
    } catch (error) {
      message("#podcast-results", error.message, true);
    }
  }
  function renderEpisodes() {
    $("#episodes").replaceChildren();
    for (const episode of currentFeed.episodes.slice(episodePage * 100, (episodePage + 1) * 100)) {
      const row = el("article", "", "episode-row");
      const box = el("input");
      box.type = "checkbox";
      box.dataset.key = episode.key;
      box.disabled = episode.saved;
      box.checked = selected.has(episode.key);
      box.setAttribute("aria-label", `Select ${episode.title}`);
      box.addEventListener("change", () => {
        box.checked
          ? selected.add(episode.key)
          : selected.delete(episode.key);
        selectionChanged();
      });
      const body = el("div", "", "episode-copy");
      body.append(
        el(
          "span",
          `${episode.published ? new Date(episode.published).toLocaleDateString() : "Undated"}${episode.duration ? ` · ${duration(episode.duration)}` : ""}${episode.bytes ? ` · ${size(episode.bytes)}` : ""}`,
          "source-note",
        ),
        el("h3", episode.title),
        el("p", episode.description, "source-description"),
      );
      row.append(box, body, queueButton(episode));
      $("#episodes").append(row);
    }
    if (!currentFeed.episodes.length)
      message(
        "#episodes",
        "This feed has no downloadable audio or video enclosures.",
      );
    for (const id of ["#episodes-top", "#episodes-bottom"]) {
      const nav = $(id);
      nav.replaceChildren();
      nav.hidden = currentFeed.episodes.length <= 100;
      if (nav.hidden) continue;
      const newer = button("View newer", () => changeEpisodePage(-1));
      newer.disabled = episodePage === 0;
      const older = button("View older", () => changeEpisodePage(1));
      older.disabled = (episodePage + 1) * 100 >= currentFeed.episodes.length;
      const range = el("span", `${episodePage * 100 + 1}–${Math.min((episodePage + 1) * 100, currentFeed.episodes.length)} of ${currentFeed.episodes.length}`, "source-note");
      range.setAttribute("role", "status");
      nav.append(newer, range, older);
    }
    selectionChanged();
  }
  function changeEpisodePage(direction) {
    episodePage += direction;
    renderEpisodes();
    $("#episodes-top").scrollIntoView({ block: "start" });
    $("#episodes-top button:not(:disabled)")?.focus({ preventScroll: true });
  }
  $("#follow-show").addEventListener("click", async () => {
    try {
      const result = await post("/api/sources/podcasts/follow", {
        feedUrl: currentFeed.feedUrl,
      });
      status.followed = result.followed;
      savedShows();
      $("#follow-show").textContent = "Show saved";
      $("#follow-show").disabled = true;
      toast("Show saved. Check for new episodes whenever you like.");
    } catch (e) {
      toast(e.message, true);
    }
  });
  $("#refresh-feed").addEventListener(
    "click",
    () => currentFeed && loadFeed(currentFeed.feedUrl, true),
  );
  $("#select-episodes").addEventListener("change", (e) => {
    const boxes = [...$("#episodes").querySelectorAll("input[type=checkbox]")];
    let count = 0;
    for (const box of boxes) {
      selected.delete(box.dataset.key);
      box.checked = e.target.checked && !box.disabled && count++ < 10;
      if (box.checked) selected.add(box.dataset.key);
    }
    selectionChanged();
  });
  $("#download-selected").addEventListener("click", async () => {
    const keys = [...selected];
    $("#download-selected").disabled = true;
    let count = 0;
    try {
      for (const key of keys) {
        await post("/api/sources/acquire", { key });
        selected.delete(key);
        count++;
      }
      toast(`${count} episodes added to downloads.`);
      await onQueued();
      await loadFeed(currentFeed.feedUrl);
    } catch (e) {
      toast(`${count} queued. ${e.message}`, true);
    } finally {
      selectionChanged();
    }
  });
  let mapArea = null,
    mapNamed = false,
    sizing = 0,
    sizeTimer = null;
  const mapFrame = () => $("#map-selector").contentWindow;
  const mapZoom = () => Number($("#map-form").elements.zoom.value);
  async function shareSavedMaps() {
    try {
      const { items } = await window.obelisk.state();
      mapFrame().postMessage(
        {
          type: "map:saved",
          maps: items
            .filter((i) => /\.pmtiles$/i.test(i.filename) && !["missing", "ambiguous"].includes(i.fileState))
            .map((i) => ({ id: i.id, title: i.title })),
        },
        "obelisk://app",
      );
    } catch {}
  }
  // The chooser stays loaded while you are elsewhere in the app, so it is told
  // again what is saved every time it comes back into view: after a map is
  // deleted, added or finishes downloading, its outlines are current.
  new IntersectionObserver((entries) => {
    if (entries.some((entry) => entry.isIntersecting)) void shareSavedMaps();
  }).observe($("#map-selector"));
  async function loadMaps(refresh = false) {
    $("#map-download").disabled = true;
    $("#maps-notice").textContent = "Checking for current map data…";
    try {
      const [data, tools] = await Promise.all([
        api(`/api/sources/maps?refresh=${refresh ? 1 : 0}`),
        api("/api/sources/status"),
      ]);
      maps = data;
      status = tools;
      const latest = data.builds[0];
      $("#maps-notice").textContent =
        data.warning ||
        (latest
          ? `OpenStreetMap data as of ${new Date(latest.date).toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric", timeZone: "UTC" })}, packaged by Protomaps`
          : "No map data is available right now.");
      $("#maps-notice").classList.toggle("error", Boolean(data.stale) || !latest);
      $("#map-tool-note").textContent = tools.mapTool
        ? ""
        : "Maps need a small helper that is not installed yet. Run “npm run setup:maps” once, then check again.";
      updateEstimate();
    } catch (error) {
      $("#maps-notice").textContent = error.message;
      $("#maps-notice").classList.add("error");
    }
  }
  /** A quick range straight away, then the exact figure once the area stops moving. */
  function updateEstimate() {
    const note = $("#map-estimate"),
      zoom = mapZoom(),
      rough = mapArea && estimateMap(mapArea, zoom),
      ready = Boolean(status.mapTool && maps?.builds.length);
    clearTimeout(sizeTimer);
    const turn = ++sizing;
    if (!rough) {
      note.textContent = "Move the map until the frame holds the area you want.";
      $("#map-download").disabled = true;
      return;
    }
    const tooBig = (mapArea[2] - mapArea[0]) * (mapArea[3] - mapArea[1]) > 400 && zoom > 10;
    $("#map-download").disabled = !ready || tooBig;
    if (tooBig) {
      note.textContent = "That is too large an area for street detail. Zoom in, or choose “Towns and highways”.";
      return;
    }
    const area = `${Math.round(rough.area).toLocaleString()} km²`;
    note.textContent = `${area} · working out the size…`;
    if (!ready || rough.tiles > 250000) {
      note.textContent = `${area} · roughly ${size(rough.low)} to ${size(rough.high)}`;
      return;
    }
    sizeTimer = setTimeout(async () => {
      let exact = null;
      try {
        exact = await window.obelisk.source("mapSize", { bbox: mapArea, zoom });
      } catch {}
      if (turn !== sizing) return;
      note.textContent = exact
        ? `${area} · ${size(exact.bytes)} to download`
        : `${area} · roughly ${size(rough.low)} to ${size(rough.high)}`;
    }, 700);
  }
  window.addEventListener("message", (event) => {
    if (event.source !== mapFrame() || event.origin !== "obelisk://app") return;
    if (event.data.type === "map:ready") return void shareSavedMaps();
    if (event.data.type !== "map:selection" || !Array.isArray(event.data.bbox)) return;
    mapArea = event.data.bbox.map((n) => Number(Number(n).toFixed(5)));
    updateEstimate();
  });
  async function findPlace() {
    const list = $("#map-places"),
      query = $("#map-place").value.trim();
    if (!query) return;
    $("#map-find").disabled = true;
    list.hidden = false;
    list.replaceChildren(el("p", "Searching…", "muted"));
    try {
      const { places } = await window.obelisk.source("places", { query });
      list.replaceChildren();
      if (!places.length) list.append(el("p", "Nothing found by that name.", "muted"));
      for (const place of places) {
        const row = el("button", "", "map-place");
        row.type = "button";
        row.setAttribute("role", "option");
        row.append(el("strong", place.name), el("small", [place.kind, place.where].filter(Boolean).join(" · ")));
        row.onclick = () => {
          mapFrame().postMessage({ type: "map:goto", bbox: place.bbox }, "obelisk://app");
          // The place names the map unless a name was already typed.
          if (!mapNamed) $("#map-form").elements.title.value = place.name;
          list.hidden = true;
        };
        list.append(row);
      }
      if (places.length === 1) list.firstChild.click();
    } catch (error) {
      list.replaceChildren(el("p", error.message, "muted"));
    } finally {
      $("#map-find").disabled = false;
    }
  }
  $("#map-find").addEventListener("click", findPlace);
  $("#map-place").addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      void findPlace();
    }
  });
  $("#map-form [name=title]").addEventListener("input", (event) => {
    mapNamed = Boolean(event.target.value.trim());
  });
  $("#map-form").addEventListener("change", (event) => {
    if (event.target.name === "zoom") updateEstimate();
  });
  $("#maps-refresh").addEventListener("click", () => loadMaps(true));
  $("#map-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    if (!mapArea) return;
    $("#map-download").disabled = true;
    try {
      const result = await post("/api/sources/maps/acquire", {
        title: e.currentTarget.elements.title.value,
        build: maps?.builds[0]?.id,
        zoom: mapZoom(),
        bbox: mapArea,
      });
      toast(
        result.duplicate
          ? "You already have this map."
          : "Saving your map. You can follow it in Transfers.",
      );
      await onQueued();
    } catch (error) {
      toast(error.message, true);
    } finally {
      updateEstimate();
    }
  });
  document.addEventListener("obelisk:page", async ({ detail }) => {
    if (initialized.has(detail)) return;
    initialized.add(detail);
    if (detail === "wikipedia") loadWiki();
    if (detail === "maps") loadMaps();
    if (detail === "podcasts") {
      try {
        status = await api("/api/sources/status");
        savedShows();
        message(
          "#podcast-results",
          "Search for a favorite show, or discover something new.",
        );
      } catch (e) {
        toast(e.message, true);
      }
    }
  });
  return {
    /** Opens a show's episodes, as if its feed had been pasted in. */
    openFeed: (url) => loadFeed(url),
  };
}
