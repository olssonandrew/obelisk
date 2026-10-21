/** Collections: lists of things worth keeping, chosen by people, on the Add content page. */
import { el, size } from "./bridge.js";
import { icon, hydrateIcons } from "./icons.js";

export const TYPE_INFO = {
  podcasts: { label: "Podcasts", icon: "podcast", noun: ["show", "shows"], importer: "podcasts" },
  websites: { label: "Websites", icon: "browser", noun: ["page", "pages"], importer: "web" },
  books: { label: "Books", icon: "book", noun: ["book", "books"], importer: "documents" },
  documents: { label: "Documents", icon: "book", noun: ["document", "documents"], importer: "documents" },
  images: { label: "Images", icon: "image", noun: ["image", "images"], importer: "images" },
  music: { label: "Music", icon: "music", noun: ["recording", "recordings"], importer: "audio" },
  audiobooks: { label: "Audiobooks", icon: "headphones", noun: ["part", "parts"], importer: "audio" },
  video: { label: "Video", icon: "video", noun: ["film", "films"], importer: "video" },
};
const TOPIC_NAMES = { history: "History", science: "Science", art: "Art", literature: "Literature", technology: "Technology", music: "Music", nature: "Nature", culture: "Culture", learning: "Learning" };
const ACTIVE = new Set(["queued", "downloading", "verifying", "pausing", "waiting"]);
const FINAL = new Set(["gone", "changed"]);
const keysOf = (c, e) => (c.type === "websites" ? e.dates.map((d) => `${e.id}@${d}`) : [e.id]);
const count = (n, [one, many]) => `${n.toLocaleString()} ${n === 1 ? one : many}`;
const clock = (ms) => new Date(ms).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
const hostOf = (url) => {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
};

/**
 * What a set of downloads from one collection is doing, in a sentence or two: the
 * server asked to wait, refused, the disk filled, or some files can't be had. Shared by
 * the collection page and Transfers so both say the same thing.
 */
export function summarize(states, hostFor = () => "") {
  const lines = [];
  const all = Object.entries(states),
    pick = (fn) => all.filter(([, s]) => fn(s));
  const busy = pick((s) => s.state === "waiting" && s.failure === "busy");
  if (busy.length) {
    const at = Math.min(...busy.map(([, s]) => s.retryAt || Infinity)),
      host = hostFor(busy[0][0]) || "The server";
    lines.push({ tone: "wait", text: `${host} asked Obelisk to slow down. Continuing${Number.isFinite(at) ? ` at ${clock(at)}` : " shortly"}.` });
  }
  const offline = pick((s) => s.state === "waiting" && s.failure === "offline");
  if (offline.length) lines.push({ tone: "wait", text: `Couldn't reach ${hostFor(offline[0][0]) || "the server"}. Trying again by itself.` });
  // Refused files and the ones paused because of them are one story.
  const turned = pick((s) => s.state === "failed" && s.failure === "refused"),
    held = pick((s) => s.state === "paused" && s.failure === "refused");
  if (turned.length || held.length) {
    const host = hostFor((turned[0] || held[0])[0]) || "The server";
    lines.push({
      tone: "stop",
      text: `${host} is refusing downloads${turned.length ? ` (${count(turned.length, ["file", "files"])} turned away)` : ""}${held.length ? `, so ${count(held.length, ["other is", "others are"])} paused` : ""}. Resume to try again later.`,
    });
  }
  const space = pick((s) => s.state === "paused" && s.failure === "space");
  if (space.length) lines.push({ tone: "stop", text: `${space[0][1].error || "Not enough disk space."} Free some space, then resume.` });
  const closed = pick((s) => s.state === "paused" && !s.failure);
  if (closed.length && !held.length && !space.length) lines.push({ tone: "info", text: `${count(closed.length, ["file is", "files are"])} paused.` });
  const failed = pick((s) => s.state === "failed");
  const lost = failed.filter(([, s]) => FINAL.has(s.failure)),
    retry = failed.filter(([, s]) => !FINAL.has(s.failure) && s.failure !== "refused");
  if (retry.length) lines.push({ tone: "stop", text: `${count(retry.length, ["file", "files"])} couldn't be saved yet. ${retry[0][1].error || ""} `.trim() });
  if (lost.length)
    lines.push({
      tone: "info",
      text: `${count(lost.length, ["file", "files"])} can't be saved: ${lost.every(([, s]) => s.failure === "gone") ? "no longer at the source" : "changed at the source since this collection was made"}.`,
    });
  return lines;
}

export function createCollections({ desktop, toast, openImporter, openFeed, openItem, openFolder, showTransfers, getState }) {
  const $ = (s) => document.querySelector(s);
  let data = null,
    loading = null,
    page = null, // { kind: "collection", id, back } | { kind: "all", back }
    selected = new Map(), // collection id -> Set of chosen keys
    filters = { type: "", topic: "", query: "" };
  const view = $("#collections-view");

  let loadedAt = 0;
  async function load(force = false) {
    // Badges on cards stay current without asking on every redraw.
    if (data && !force && Date.now() - loadedAt < 3000) return data;
    loadedAt = Date.now();
    loading ||= desktop
      .collections()
      .then((d) => (data = d))
      .catch((e) => {
        toast(e.message);
        return data || { collections: [], featured: [], status: {} };
      })
      .finally(() => (loading = null));
    return loading;
  }
  const byId = (id) => data?.collections.find((c) => c.id === id) || null;
  const statusOf = (c) => data?.status?.[c.id] || { started: false, folder: null, entries: {} };
  const isFiles = (c) => c.type !== "podcasts";
  const keys = (c) => c.entries.flatMap((e) => keysOf(c, e));
  const sizeOf = (c, list = keys(c)) => {
    const wanted = new Set(list);
    return c.entries.reduce((n, e) => n + (e.bytes && wanted.has(e.id) ? e.bytes : 0), 0);
  };
  function progress(c) {
    const s = statusOf(c).entries,
      all = keys(c);
    const saved = all.filter((k) => s[k]?.state === "saved").length,
      active = all.filter((k) => ACTIVE.has(s[k]?.state)).length,
      stopped = all.filter((k) => (s[k]?.state === "paused" || s[k]?.state === "failed") && !FINAL.has(s[k]?.failure)).length,
      fresh = all.filter((k) => s[k]?.state === "new").length;
    return { all: all.length, saved, active, stopped, fresh };
  }

  /* Covers: drawn, not downloaded, so they work offline and cost nothing. */
  function cover(c, big = false) {
    const art = el("span", "", `collection-cover type-${c.type}${big ? " big" : ""}`);
    art.append(icon(TYPE_INFO[c.type].icon));
    if (big) art.append(el("span", TYPE_INFO[c.type].label, "collection-cover-label"));
    return art;
  }
  function badge(c) {
    if (!isFiles(c)) return null;
    const p = progress(c);
    if (p.active) return el("span", `${p.saved} of ${p.all}`, "collection-badge busy");
    if (p.saved && p.saved === p.all) return el("span", "Saved", "collection-badge done");
    if (p.fresh) return el("span", `${p.fresh} new`, "collection-badge new");
    if (p.saved) return el("span", `${p.saved} of ${p.all}`, "collection-badge");
    return null;
  }
  function measure(c) {
    const parts = [count(c.type === "websites" ? keys(c).length : c.entries.length, TYPE_INFO[c.type].noun)];
    if (sizeOf(c)) parts.push(size(sizeOf(c)));
    return parts.join(" · ");
  }
  function card(c, back) {
    const b = el("button", "", "collection-card");
    b.type = "button";
    const text = el("span", "", "collection-card-text");
    text.append(el("strong", c.title), el("span", c.summary, "collection-card-summary"), el("span", measure(c), "collection-card-meta"));
    b.append(cover(c), text);
    const mark = badge(c);
    if (mark) b.append(mark);
    b.onclick = () => show({ kind: "collection", id: c.id, back });
    return b;
  }

  // A random order, drawn once per session, so the cards shown change between launches
  // but not while someone is looking.
  const luck = new Map();
  const shuffled = (list) => {
    for (const c of list) if (!luck.has(c.id)) luck.set(c.id, Math.random());
    return [...list].sort((a, b) => luck.get(a.id) - luck.get(b.id));
  };
  // Podcasts have one list of recommended shows, on the Podcasts page; every other
  // type has collections.
  const listed = () => data.collections.filter((c) => c.type !== "podcasts");
  // Saving needs the internet; without it, the space says so.
  function offline(title) {
    const wrap = el("section", "", "collection-strip"),
      note = el("div", "", "collection-offline");
    note.append(icon("offline"), el("strong", "You're offline"), el("span", "Collections appear when you're connected.", "muted"));
    wrap.append(el("div", title, "section-label"), note);
    return wrap;
  }

  /** Four featured collections for Add content's front page; null when there are none. */
  async function homeRow() {
    await load();
    const all = listed();
    if (!all.length) return null;
    if (!navigator.onLine) return offline("Collections");
    const featured = data.featured.map(byId).filter((c) => c && c.type !== "podcasts"),
      list = shuffled(featured.length ? featured : all).slice(0, 4);
    return section("Collections", list, { kind: "home" }, all.length > list.length ? all.length : 0);
  }
  /** Up to twelve of an importer's collections in session-random order. */
  async function strip(importer) {
    await load();
    if (importer === "podcasts") return shows();
    const list = listed().filter((c) => TYPE_INFO[c.type]?.importer === importer);
    if (!list.length) return null;
    const title = list.length === 1 ? "Collection" : "Collections";
    if (!navigator.onLine) return offline(title);
    const shown = shuffled(list).slice(0, 12);
    return section(title, shown, { kind: "importer", importer }, list.length > shown.length ? list.length : 0, importer);
  }
  /** The recommended shows, each opening above in the Podcasts page. */
  function shows() {
    const c = data.collections.find((x) => x.type === "podcasts");
    if (!c?.entries.length) return null;
    if (!navigator.onLine) return offline(c.title);
    const wrap = el("section", "", "collection-strip"),
      list = el("div", "", "show-cards");
    for (const entry of c.entries) {
      const card = el("button", "", "show-card");
      card.type = "button";
      card.title = `Browse episodes of ${entry.title}`;
      card.append(el("strong", entry.title));
      if (entry.note) card.append(el("span", entry.note, "muted"));
      card.onclick = () => {
        openFeed(entry.feed);
        document.querySelector("#view-discover").scrollTop = 0;
      };
      list.append(card);
    }
    wrap.append(el("div", c.title, "section-label"), list);
    return wrap;
  }
  function section(title, list, back, more, importer) {
    const wrap = el("section", "", "collection-strip"),
      head = el("div", "", "collection-strip-head");
    head.append(el("div", title, "section-label"));
    if (more) {
      const all = el("button", `See all ${more}`, "text-button");
      all.type = "button";
      all.onclick = () => show({ kind: "all", back, type: importer ? Object.keys(TYPE_INFO).filter((t) => TYPE_INFO[t].importer === importer) : null });
      head.append(all);
    }
    const grid = el("div", "", "collection-grid");
    for (const c of list) grid.append(card(c, back));
    wrap.append(head, grid);
    return wrap;
  }

  /* The collection's own page, and the list of all of them, replace the Add content page. */
  function show(next) {
    page = next;
    document.querySelector("#view-discover").classList.add("showing-collections");
    view.hidden = false;
    if (next.kind === "collection") {
      const c = byId(next.id);
      if (!c) return leave();
      if (Object.values(statusOf(c).entries).some((e) => e.state === "new")) void desktop.sawCollection(c.id).catch(() => {});
    }
    render();
    document.querySelector("#view-discover").scrollTop = 0;
  }
  function leave() {
    const back = page?.back;
    page = null;
    view.hidden = true;
    view.replaceChildren();
    document.querySelector("#view-discover").classList.remove("showing-collections");
    if (back?.kind === "importer") openImporter(back.importer);
    else if (back?.kind === "all") show(back);
    else openImporter(null);
  }
  /** Leaves without going anywhere: another part of Add content is being opened. */
  function close() {
    page = null;
    view.hidden = true;
    view.replaceChildren();
    document.querySelector("#view-discover").classList.remove("showing-collections");
  }
  function backButton() {
    const b = el("button", "", "text-button collection-back");
    b.type = "button";
    const label = page.back?.kind === "importer" ? importerLabel(page.back.importer) : page.back?.kind === "all" ? "Collections" : "Add content";
    b.append(icon("chevron-left"), document.createTextNode(label));
    b.onclick = leave;
    return b;
  }
  const importerLabel = (id) => ({ web: "Web pages", documents: "Books and documents", images: "Images", audio: "Music and audio", video: "Video", podcasts: "Podcasts" })[id] || "Add content";

  function render() {
    if (!page || !data) return;
    if (page.kind === "all") renderAll();
    else renderCollection(byId(page.id));
    hydrateIcons(view);
  }

  function renderAll() {
    const types = page.type || null,
      list = listed().filter((c) => !types || types.includes(c.type));
    const head = el("header", "", "collection-list-head");
    head.append(el("h1", "Collections"), el("p", "Lists of things worth keeping, chosen by people. Save a whole one, or just the parts you want.", "muted"));
    const bar = el("div", "", "collection-filters");
    const search = el("input");
    search.type = "search";
    search.placeholder = "Search collections";
    search.value = filters.query;
    search.setAttribute("aria-label", "Search collections");
    search.oninput = () => {
      filters.query = search.value;
      drawGrid();
    };
    const chips = el("div", "", "collection-chips");
    const chip = (label, active, onclick) => {
      const b = el("button", label, `collection-chip${active ? " on" : ""}`);
      b.type = "button";
      b.setAttribute("aria-pressed", String(active));
      b.onclick = onclick;
      return b;
    };
    const topics = [...new Set(list.flatMap((c) => c.topics))].sort();
    chips.append(chip("All", !filters.topic, () => ((filters.topic = ""), renderAll(), hydrateIcons(view))));
    for (const t of topics) chips.append(chip(TOPIC_NAMES[t] || t, filters.topic === t, () => ((filters.topic = filters.topic === t ? "" : t), renderAll(), hydrateIcons(view))));
    bar.append(search, chips);
    const grid = el("div", "", "collection-grid wide");
    function drawGrid() {
      const q = filters.query.trim().toLowerCase(),
        shown = list.filter((c) => (!filters.topic || c.topics.includes(filters.topic)) && (!q || `${c.title} ${c.summary} ${c.curator}`.toLowerCase().includes(q)));
      shown.sort((a, b) => a.title.localeCompare(b.title));
      grid.replaceChildren(...shown.map((c) => card(c, { kind: "all", back: page.back, type: page.type })));
      if (!shown.length) grid.append(el("p", "No collections match.", "muted"));
      hydrateIcons(grid);
    }
    drawGrid();
    view.replaceChildren(backButton(), head, topics.length > 1 || list.length > 6 ? bar : el("span"), grid);
  }

  function renderCollection(c) {
    if (!c) return leave();
    const info = TYPE_INFO[c.type],
      st = statusOf(c),
      entries = st.entries,
      all = keys(c),
      p = progress(c);
    // What's ticked: by default everything not yet saved.
    if (!selected.has(c.id)) selected.set(c.id, new Set(all.filter((k) => entries[k]?.state !== "saved")));
    const chosen = selected.get(c.id);
    for (const k of [...chosen]) if (entries[k]?.state === "saved" || !all.includes(k)) chosen.delete(k);
    // Only entries with nothing under way can be chosen; stopped ones belong to Resume.
    const free = (k) => !entries[k] || entries[k].state === "new";
    const choosable = all.filter(free);
    for (const k of all) if (!free(k)) chosen.delete(k);

    const hero = el("header", "", "collection-hero"),
      words = el("div", "", "collection-hero-text");
    const kicker = [info.label, ...c.topics.map((t) => TOPIC_NAMES[t] || t)].join(" · ");
    const updated = new Date(`${c.updated}T12:00:00Z`).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
    words.append(el("span", kicker, "collection-kicker"), el("h1", c.title), el("p", c.summary, "collection-lede"), el("p", `Chosen by ${c.curator} · Updated ${updated} · ${measure(c)}`, "collection-byline"));
    const actions = el("div", "", "collection-actions");
    const act = (label, cls, fn) => {
      const b = el("button", label, cls);
      b.type = "button";
      b.onclick = async () => {
        b.disabled = true;
        try {
          await fn();
        } catch (e) {
          toast(e.message);
        } finally {
          b.disabled = false;
        }
      };
      return b;
    };
    if (isFiles(c)) {
      const wanted = choosable.filter((k) => chosen.has(k)),
        bytes = sizeOf(c, wanted);
      if (p.stopped) actions.append(act(`Resume ${p.stopped}`, "primary", () => group(c, "resume")));
      if (p.active) {
        actions.append(act("Pause", "secondary", () => group(c, "pause")));
        actions.append(el("span", `Saving ${p.saved} of ${p.all}`, "collection-progress-text"));
      }
      if (!p.active && wanted.length) {
        const everything = wanted.length === choosable.length && !p.saved;
        actions.append(act(`${everything ? "Save all" : `Save ${wanted.length.toLocaleString()}`}${bytes ? ` · ${size(bytes)}` : ""}`, p.stopped ? "secondary" : "primary", () => save(c, wanted)));
      }
      if (p.saved === p.all && p.all) actions.append(el("span", "Everything here is in your library.", "collection-progress-text"));
      if (st.folder) actions.append(act("Show in library", "secondary", async () => openFolder(st.folder)));
      if (p.active || p.stopped) actions.append(act("Transfers", "text-button", async () => showTransfers()));
    }
    words.append(actions);
    const notices = el("div", "", "collection-notices");
    notices.setAttribute("role", "status");
    for (const line of summarize(entries, (k) => hostOf(c.entries.find((e) => keysOf(c, e).includes(k))?.url || "")))
      notices.append(el("p", line.text, `collection-notice ${line.tone}`));
    words.append(notices);
    hero.append(cover(c, true), words);

    const list = el("div", "", "collection-entries");
    if (isFiles(c) && choosable.length > 1) {
      const bar = el("label", "", "collection-select-all"),
        box = el("input");
      box.type = "checkbox";
      box.checked = choosable.every((k) => chosen.has(k));
      box.indeterminate = !box.checked && choosable.some((k) => chosen.has(k));
      box.onchange = () => {
        for (const k of choosable) box.checked ? chosen.add(k) : chosen.delete(k);
        render();
      };
      bar.append(box, el("span", "Select all"));
      list.append(bar);
    }
    for (const entry of c.entries) list.append(row(c, entry, entries, chosen));
    view.replaceChildren(backButton(), hero, list);
  }

  function stateChip(s) {
    if (!s) return null;
    const pct = s.total ? Math.floor((s.bytes / s.total) * 100) : null;
    const text =
      {
        saved: "Saved",
        new: "New",
        queued: "Waiting",
        downloading: pct !== null ? `${pct}%` : "Saving",
        verifying: "Checking",
        pausing: "Pausing",
        paused: "Paused",
        waiting: s.failure === "busy" ? "Server busy" : "Retrying",
      }[s.state] || (s.state === "failed" ? { gone: "Gone from source", changed: "Changed at source", refused: "Refused" }[s.failure] || "Failed" : s.state);
    const chip = el("span", text, `entry-state ${s.state}${s.failure ? ` ${s.failure}` : ""}`);
    if (s.error) chip.title = s.error;
    return chip;
  }

  function row(c, entry, entries, chosen) {
    const r = el("div", "", "collection-entry");
    const keysHere = keysOf(c, entry);
    if (c.type === "websites") {
      const text = el("div", "", "entry-text");
      text.append(el("strong", entry.title), el("span", entry.note || hostOf(entry.url), "entry-sub"));
      const dates = el("div", "", "entry-dates");
      for (const k of keysHere) {
        const date = k.slice(entry.id.length + 1),
          s = entries[k],
          locked = !!s && s.state !== "new";
        const label = date === "live" ? "Today" : new Date(`${date}T12:00:00Z`).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
        const d = el("label", "", `entry-date${chosen.has(k) ? " on" : ""}${locked ? " locked" : ""}`),
          box = el("input");
        box.type = "checkbox";
        box.checked = chosen.has(k) || (!!s && s.state !== "new" && !FINAL.has(s.failure));
        box.disabled = locked;
        box.onchange = () => {
          box.checked ? chosen.add(k) : chosen.delete(k);
          render();
        };
        d.append(box, el("span", label));
        const chip = stateChip(s);
        if (chip) d.append(chip);
        dates.append(d);
      }
      r.append(text, dates);
      return r;
    }
    const k = keysHere[0],
      s = entries[k],
      locked = !!s && s.state !== "new";
    const box = el("input");
    box.type = "checkbox";
    box.checked = chosen.has(k) || (!!s && s.state !== "new" && !FINAL.has(s.failure));
    box.disabled = locked;
    box.setAttribute("aria-label", `Save ${entry.title}`);
    box.onchange = () => {
      box.checked ? chosen.add(k) : chosen.delete(k);
      render();
    };
    const text = el("div", "", "entry-text");
    const title = el(s?.state === "saved" ? "button" : "strong", entry.title, s?.state === "saved" ? "entry-title-link" : "");
    if (s?.state === "saved") {
      title.type = "button";
      title.onclick = () => openItem(s.itemId);
    }
    text.append(title, el("span", [entry.creator, entry.date].filter(Boolean).join(" · "), "entry-sub"));
    if (entry.description) text.title = entry.description;
    r.append(box, text, el("span", entry.bytes ? size(entry.bytes) : "", "entry-size"));
    const chip = stateChip(s);
    r.append(chip || el("span"));
    if (s?.state === "downloading" && s.total) {
      const bar = el("i", "", "entry-bar");
      bar.style.width = `${Math.min(100, (s.bytes / s.total) * 100)}%`;
      r.append(bar);
    }
    return r;
  }

  async function save(c, wanted) {
    const result = await desktop.saveCollection(c.id, wanted);
    selected.delete(c.id);
    toast(result.queued ? `Saving ${count(result.queued, ["file", "files"])} from ${c.title}. Follow along here or in Transfers.` : "Everything chosen is already in your library.");
    await update(true);
  }
  async function group(c, action) {
    await desktop.collectionTransfers(`collection:${c.id}`, action);
    await update(true);
  }

  let pending = null,
    last = 0;
  /** Fresh status while a collection page is showing; at most a few times a second. */
  function update(now = false) {
    if (!page && !now) return;
    const wait = now ? 0 : Math.max(0, 600 - (Date.now() - last));
    pending ||= new Promise((resolve) =>
      setTimeout(async () => {
        last = Date.now();
        await load(true);
        pending = null;
        render();
        resolve();
      }, wait),
    );
    return pending;
  }

  return { homeRow, strip, show, close, update, get open() { return !!page; }, summarize };
}
