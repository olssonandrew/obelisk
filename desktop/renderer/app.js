import { libraryViews, needsAttention } from "./library-views.js";
import { tagControls } from "./tags.js";
import { attachThumbnail, forgetThumbnail } from "./thumbnails.js";
import { initVideo } from "./video.js";
import { initSources } from "./discover.js";
import { createImporter } from "./importer.js";
import { createOnboarding } from "./onboarding.js";
import { createCollections, summarize as summarizeCollection } from "./collections.js";
import { createFolderUI } from "./folders.js";
import {
  sourceApi,
  el,
  size,
  coverURL,
  formatOf,
  shortDate,
  copyText,
} from "./bridge.js";
import { renderSoftware, renderReport } from "./organize.js";
import { preview, clearPreview, exitMediaFullscreen } from "./preview.js";
import { createInspector } from "./inspector.js";
import { icon, hydrateIcons } from "./icons.js";
const $ = (s) => document.querySelector(s),
  desktop = window.obelisk,
  mac = window.navigator.platform.includes("Mac");
hydrateIcons();
let state = { items: [], jobs: [], handlers: [] },
  view = "library",
  // The folder being browsed, or null for the whole library.
  folder = null,
  includeSub = localStorage.getItem("includeSubfolders") === "1",
  // `selected` is the file the keyboard and viewer act on; `selection` holds all.
  selected = null,
  anchor = null,
  viewerId = null,
  layout = localStorage.getItem("libraryLayout") === "list" ? "list" : "grid",
  inspectorOn = localStorage.getItem("inspector") !== "off",
  timer,
  busy = false;
const selection = new Set();
export function toast(message) {
  clearTimeout(timer);
  $("#toast").textContent = message;
  $("#toast").hidden = false;
  timer = setTimeout(() => ($("#toast").hidden = true), 4500);
}
const button = (label, fn, cls = "") => {
  const b = el("button", label, cls);
  b.addEventListener("click", fn);
  return b;
};
const run = (fn) => async () => {
  try {
    await fn();
  } catch (e) {
    toast(e.message);
  }
};
// Rebuilt whenever the items change; lookups stay instant with any number of files.
let index = new Map();
const byId = (id) => index.get(id);
const selectedItems = () => [...selection].map(byId).filter(Boolean);
// What a file is, from its format: used by the format filter and list view.
const groups = [
  ["document", "Documents"], ["audio", "Audio"], ["video", "Video"], ["image", "Images"],
  ["map", "Maps"], ["reference", "Reference"], ["software", "Software"], ["other", "Other"],
];
const groupLabel = Object.fromEntries(groups);
/** What a file is, from its format. */
const singular = { document: "Document", audio: "Audio", video: "Video", image: "Image", map: "Map", reference: "Reference", software: "Software", other: "File" };
const typeLabel = (item) => singular[item.group] || "File";
// What belongs in a default folder, said when it's empty. Found by name, so a renamed
// folder gets the usual message.
const EMPTY_HINTS = {
  backups: "Drop in copies of what you can't replace: important documents, photos, and zips of anything kept in the cloud.",
};
const folderName = (id) => folderUI.byId(id || state.inbox)?.name || "Inbox";
const shelfIcons = { document: "book", reference: "encyclopedia", other: "file" };
const shelfIcon = (id) => shelfIcons[id] || id;
const filters = ["#type-filter", "#tag-filter", "#rating-filter", "#source-filter", "#added-filter"];
let favoritesOnly = false;
function resetFilters() {
  $("#search").value = "";
  for (const id of filters) $(id).value = "";
  favoritesOnly = false;
}
const views = libraryViews(
  () => state,
  () => {
    // The Favorites shortcut and the Favorites filter are one switch.
    const favorites = views.current === "favorites";
    if (favorites) views.reset();
    folder = null;
    resetFilters();
    favoritesOnly = favorites;
    closeViewer();
    clearSelection();
    setView("library");
    renderCollections();
    renderLibrary();
  },
);
const tags = tagControls(desktop, () => state, refresh, toast);
let visibleIds = [];
const inspector = createInspector({
  host: $("#file-details"),
  desktop,
  getState: () => state,
  toast,
  refresh,
  actions: {
    open: openViewer,
    typeLabel,
    rate,
    favorite,
    trash,
    chooseCover,
    editTags: () => tags.open([...selection]),
    goto: (next) => setView(next),
    add: () => importer.home() || setView("discover"),
    shelfIcon,
    folderName,
    folderPath: (id) => folderUI.pathTo(id || state.inbox).map((f) => f.name).join(" › "),
    moveTo: () => folderUI.moveItemsTo([...selection]),
    showFolder: (id) => openFolder(id || state.inbox),
  },
});
const renderInspector = (force) => inspector.render(selectedItems(), force);

const folderUI = createFolderUI({
  desktop,
  toast,
  refresh: () => refresh(),
  getState: () => state,
  openFolder: (id) => openFolder(id),
  currentFolder: () => (view === "library" ? folder : null),
  selectedIds: () => [...selection],
});
const importer = createImporter({
  folders: folderUI,
  desktop,
  toast,
  refresh,
  getState: () => state,
  showImport: () => setView("discover", { keep: true }),
  onPage: (name) =>
    document.dispatchEvent(new CustomEvent("obelisk:page", { detail: name })),
});
const openVideo = initVideo(
  desktop,
  toast,
  async () => {
    setView("transfers");
    await refresh();
  },
  () => importer.open("video"),
);
// The folder Add content was opened from; files added from this computer go there.
let importInto = null;
/** Opens the Add content page for a type, or its front page. */
function openImport(id, { into = null } = {}) {
  importInto = into;
  const name = into && folderUI.byId(into)?.name;
  $("#import-subtitle").textContent = name ? `Files from this computer go to ${name}` : "From this computer or the internet";
  if (id) importer.open(id);
  else {
    setView("discover");
  }
}

function setView(next, { keep = false } = {}) {
  if (next === "discover" && !keep) importer.home();
  view = next;
  views.sync(next === "library" && folder === null);
  document
    .querySelectorAll(".view")
    .forEach((p) => (p.hidden = p.id !== `view-${view}`));
  document
    .querySelectorAll("[data-view]")
    .forEach((b) =>
      b.classList.toggle(
        "active",
        b.dataset.view === view &&
          !(view === "library" && (folder !== null || views.current !== "all")),
      ),
    );
  if (next !== "library") closeViewer();
  if (state.folders) renderCollections();
  syncInspector();
  if (next === "tags") renderTags();
  if (next === "health") {
    renderArchive();
    renderReport(state.lastCheck, desktop, toast, refresh, importer.untracked);
  }
  renderSidebarTags();
}
function syncInspector() {
  $("#inspector").hidden = view !== "library" || !inspectorOn;
  $("#preview-details").setAttribute("aria-pressed", String(inspectorOn));
}
document.querySelectorAll("[data-view]").forEach((b) =>
  b.addEventListener("click", () => {
    // A tab always opens at its front page, whatever was open inside it.
    if (b.dataset.view === "discover") return openImport();
    if (b.dataset.view === "library") {
      views.reset();
      folder = null;
      resetFilters();
      closeViewer();
      clearSelection();
      renderLibrary();
      renderCollections();
      $("#file-area").scrollTop = 0;
    }
    setView(b.dataset.view);
  }),
);
/** Shows one folder (null: the whole library). */
function openFolder(id) {
  views.reset();
  folder = id || null;
  resetFilters();
  closeViewer();
  clearSelection();
  setView("library");
  renderCollections();
  renderLibrary();
  $("#file-area").scrollTop = 0;
}
const renderCollections = () => folderUI.renderSidebar();
function renderSidebarTags() {
  const host = $("#sidebar-tags");
  host.replaceChildren();
  const top = tags
    .counts()
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 6);
  if (!top.length) {
    const hint = el("p", "Tag files to find them again by subject.", "muted");
    hint.style.margin = "2px 9px";
    host.append(hint);
    return;
  }
  for (const [tag, count] of top) {
    const active = view === "library" && tags.value === "tag:" + tag;
    const b = button("", () => {
      if (folder !== null || views.current !== "all" || view !== "library") {
        views.reset();
        folder = null;
        resetFilters();
      }
      tags.set(active ? "" : tag);
      closeViewer();
      setView("library");
      renderCollections();
      renderLibrary();
    });
    b.className = active ? "active" : "";
    b.append(icon("tag"), el("span", tag), el("small", String(count)));
    host.append(b);
  }
}

/* Selection */
function clearSelection() {
  selection.clear();
  selected = anchor = null;
  syncSelection();
}
function syncSelection() {
  for (const id of [...selection]) if (!byId(id)) selection.delete(id);
  if (selected && !selection.has(selected))
    selected = [...selection].at(-1) || null;
  for (const card of $("#library").querySelectorAll(".file-card")) {
    const on = selection.has(card.dataset.id);
    card.classList.toggle("selected", on);
    card.setAttribute("aria-selected", String(on));
    card.querySelector(".file-select").checked = on;
  }
  $("#tag-actions").hidden = selection.size < 2;
  $("#selection-count").textContent = `${selection.size} selected`;
  $("#favorite-selected").textContent = selectedItems().every((i) => i.favorite)
    ? "Unfavorite"
    : "Favorite";
  renderInspector();
}
function select(id, { additive = false, range = false } = {}) {
  if (range && anchor && visibleIds.includes(anchor)) {
    const a = visibleIds.indexOf(anchor),
      b = visibleIds.indexOf(id);
    if (!additive) selection.clear();
    for (const each of visibleIds.slice(Math.min(a, b), Math.max(a, b) + 1))
      selection.add(each);
    selected = id;
  } else if (additive) {
    if (selection.has(id)) selection.delete(id);
    else selection.add(id);
    selected = selection.has(id) ? id : [...selection].at(-1) || null;
    anchor = id;
  } else {
    selection.clear();
    selection.add(id);
    selected = anchor = id;
  }
  syncSelection();
}
const cardFor = (id) =>
  id && $("#library").querySelector(`.file-card[data-id="${CSS.escape(id)}"]`);

/* Actions on the selection */
async function patch(values) {
  const ids = [...selection];
  if (!ids.length) return;
  await desktop.updateMetadata(ids.length === 1 ? ids[0] : ids, values);
  await refresh();
  renderInspector(true);
}
function rate(rating) {
  return run(() => patch({ rating }))();
}
function favorite() {
  return run(() =>
    patch({ favorite: !selectedItems().every((i) => i.favorite) }),
  )();
}
async function trash(ids = [...selection]) {
  if (!ids.length) return;
  try {
    const removed = await desktop.trash(ids);
    if (!removed.length) return;
    const index = Math.max(0, visibleIds.indexOf(removed[0]));
    for (const id of removed) {
      selection.delete(id);
      forgetThumbnail(id);
    }
    if (removed.includes(viewerId)) closeViewer();
    selected = anchor = null;
    await refresh();
    // Keep the keyboard where it was so a run of deletions stays quick.
    const next = visibleIds[Math.min(index, visibleIds.length - 1)];
    if (next) {
      select(next);
      reveal(next)?.focus({ preventScroll: true });
    } else syncSelection();
    toast(
      `${removed.length === 1 ? "1 file" : `${removed.length} files`} moved to the Trash.`,
    );
  } catch (e) {
    toast(e.message);
  }
}
async function chooseCover(id) {
  if (await desktop.chooseCover(id)) {
    forgetThumbnail(id);
    renderLibrary();
    renderInspector(true);
  }
}
$("#edit-selected-tags").onclick = () => tags.open([...selection]);
$("#favorite-selected").onclick = favorite;
$("#trash-selected").onclick = () => trash();
$("#clear-selection").onclick = clearSelection;
$("#select-visible").onclick = () => {
  for (const id of visibleIds) selection.add(id);
  selected ||= visibleIds[0] || null;
  syncSelection();
};

/* Library */
const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" }),
  // Items are replaced, never edited, when the library changes, so this stays correct.
  searchable = new WeakMap();
function searchText(i) {
  let text = searchable.get(i);
  if (text === undefined) {
    text =
      `${i.title} ${i.description || ""} ${i.creator || ""} ${i.created || ""} ${i.source?.provider || ""} ${i.filename} ${i.collection?.title || ""} ${i.source?.folder || ""} ${(i.tags || []).join(" ")}`.toLowerCase();
    searchable.set(i, text);
  }
  return text;
}
// Filter choices depend on the items alone, so they are worked out once per change.
let factsFor = { items: null, byScope: new Map() };
function facts(scope, items) {
  if (factsFor.items !== state.items) factsFor = { items: state.items, byScope: new Map() };
  if (!factsFor.byScope.has(scope)) {
    const providers = new Set(),
      present = new Set();
    for (const i of items) {
      providers.add(i.source?.provider || "Unknown");
      present.add(i.group);
    }
    factsFor.byScope.set(scope, { providers: [...providers].sort(), groups: present });
  }
  return factsFor.byScope.get(scope);
}
/** Whether anything narrows the view beyond the folder itself. */
const narrowing = () =>
  !!$("#search").value.trim() || favoritesOnly || filters.some((id) => $(id).value) || (folder === null && views.current !== "all");
function filtered() {
  const terms = $("#search").value.toLowerCase().split(/\s+/).filter(Boolean),
    rating = $("#rating-filter").value,
    source = $("#source-filter").value,
    added = Number($("#added-filter").value);
  // A folder shows its own files; searching or filtering, or "Show subfolders",
  // reaches everything inside it.
  let scope = state.items;
  if (folder !== null) {
    const inside = includeSub || narrowing() ? folderUI.within(folder) : new Set([folder]);
    scope = state.items.filter((i) => inside.has(i.folderId || state.inbox));
  }
  const narrowed = $("#type-filter").value,
    since = added && new Date(Date.now() - added * 86400000).toISOString();
  const items = scope.filter((i) => {
    if (narrowed && i.group !== narrowed) return false;
    if (favoritesOnly && !i.favorite) return false;
    if (!tags.matches(i) || (folder === null && !views.matches(i))) return false;
    if (rating && (rating === "0" ? i.rating : (i.rating || 0) < Number(rating)))
      return false;
    if (source && (i.source?.provider || "Unknown") !== source) return false;
    if (since && String(i.acquiredAt) < since) return false;
    if (!terms.length) return true;
    const text = searchText(i);
    return terms.every((term) => text.includes(term));
  });
  const sort = $("#sort").value,
    added_ = (a, b) => (a.acquiredAt < b.acquiredAt ? 1 : a.acquiredAt > b.acquiredAt ? -1 : 0);
  items.sort(
    {
      title: (a, b) => collator.compare(a.title, b.title),
      "title-desc": (a, b) => collator.compare(b.title, a.title),
      // By the date of the work; files without one come last, newest added first.
      date: (a, b) => (b.created || "").localeCompare(a.created || "") || added_(a, b),
      "date-asc": (a, b) =>
        !a.created - !b.created || (a.created || "").localeCompare(b.created || "") || added_(a, b),
      size: (a, b) => b.bytes - a.bytes,
      "size-asc": (a, b) => a.bytes - b.bytes,
      oldest: (a, b) => added_(b, a),
      rating: (a, b) => (b.rating || 0) - (a.rating || 0) || added_(a, b),
      type: (a, b) =>
        collator.compare(formatOf(a), formatOf(b)) || collator.compare(a.title, b.title),
    }[sort] || added_,
  );
  return { items, scope, terms };
}
function fillCover(cover, item) {
  if (
    item.media === "image" &&
    !["missing", "ambiguous"].includes(item.fileState)
  ) {
    const img = el("img");
    img.src = coverURL(item);
    img.alt = "";
    img.decoding = "async";
    img.draggable = false;
    cover.append(img);
  } else {
    cover.append(icon(item.type));
    attachThumbnail(cover, item);
  }
}
function buildCard(item) {
  const card = el("div", "", "file-card");
  card.setAttribute("role", "button");
  card.tabIndex = 0;
  card.draggable = true;
  card.dataset.id = item.id;
  card.setAttribute("aria-label", `Preview ${item.title}`);
  const check = el("input", "", "file-select"),
    on = selection.has(item.id);
  check.type = "checkbox";
  check.tabIndex = -1;
  check.checked = on;
  card.classList.toggle("selected", on);
  card.setAttribute("aria-selected", String(on));
  check.setAttribute("aria-label", `Select ${item.title}`);
  const cover = el("div", "", `file-cover ${item.media}`);
  fillCover(cover, item);
  const info = el("div", "", "file-info"),
    star = el(
      "button",
      "",
      `card-favorite${item.favorite ? " is-favorite" : ""}`,
    );
  star.tabIndex = -1;
  star.setAttribute(
    "aria-label",
    `${item.favorite ? "Unfavorite" : "Favorite"} ${item.title}`,
  );
  star.append(icon("star"));
  const name = el("strong", item.title);
  name.title = item.title;
  info.append(name);
  const rating = item.rating ? "★".repeat(item.rating) : "",
    chips = tags.chips(item, layout === "list" ? 2 : 3);
  if (layout === "list") {
    if (chips) info.append(chips);
    const state_ = needsAttention(item)
      ? el("span", item.fileState || "changed", "cell file-state")
      : el("span", typeLabel(item), "cell");
    card.append(
      check,
      cover,
      info,
      state_,
      el("span", rating, "cell stars-mini"),
      el("span", `${formatOf(item)} · ${size(item.bytes)}`, "cell"),
      el("span", shortDate(item.acquiredAt), "cell"),
      star,
    );
  } else {
    const meta = el("div", "", "file-meta");
    meta.append(el("span", formatOf(item), "format"), el("span", size(item.bytes)));
    if (rating) meta.append(el("span", rating, "stars-mini"));
    if (needsAttention(item))
      meta.append(el("span", item.fileState || "changed", "file-state"));
    // Tags share the format line, so every card has the same height.
    if (chips) meta.append(chips);
    info.append(meta);
    card.append(check, cover, info, star);
  }
  return card;
}
function renderLibrary() {
  tags.sync();
  views.sync(view === "library" && folder === null);
  if (folder !== null && !folderUI.byId(folder)) folder = null;
  const here = folder !== null ? folderUI.byId(folder) : null;
  const { items, scope, terms } = filtered(),
    query = terms.join(" ");
  visibleIds = items.map((i) => i.id);
  // Source and format choices follow what is being browsed.
  const known = facts(folder || "all", scope),
    sourceFilter = $("#source-filter"),
    currentSource = sourceFilter.value;
  sourceFilter.replaceChildren(new Option("Any source", ""), ...known.providers.map((p) => new Option(p, p)));
  sourceFilter.value = known.providers.includes(currentSource) ? currentSource : "";
  const typeFilter = $("#type-filter"),
    chosenType = typeFilter.value,
    typeChoices = groups.filter(([id]) => known.groups.has(id));
  typeFilter.replaceChildren(new Option("Any format", ""), ...typeChoices.map(([id, label]) => new Option(label, id)));
  typeFilter.value = typeChoices.some(([id]) => id === chosenType) ? chosenType : "";
  typeFilter.hidden = typeChoices.length < 2 && !typeFilter.value;
  $("#favorite-filter").setAttribute("aria-pressed", String(favoritesOnly));
  $("#favorite-filter").classList.toggle("on", favoritesOnly);
  for (const id of filters) $(id).classList.toggle("on", !!$(id).value);
  const filtering = narrowing();
  const active = filters.filter((id) => $(id).value).length + (favoritesOnly ? 1 : 0);
  // The row opens itself whenever something is narrowing the view.
  $("#filter-bar").hidden = !(filtersOpen || filtering);
  $("#toggle-filters").setAttribute("aria-expanded", String(!$("#filter-bar").hidden));
  $("#toggle-filters").classList.toggle("on", active > 0);
  $("#toggle-filters .count").textContent = active || "";
  views.summary({ query });
  // Always in the same place; only enabled while something narrows the view.
  $("#clear-filters").disabled = !filtering;
  const favoritesView = favoritesOnly && folder === null && views.current === "all";
  document
    .querySelector('[data-quick="favorites"]')
    .classList.toggle("active", favoritesView && view === "library");
  // The header: the folder's path, icon, name and size, and what can be done with it.
  $("#library-heading").textContent = here ? here.name : favoritesView ? "Favorites" : views.title;
  const crumbs = $("#folder-crumbs");
  crumbs.replaceChildren(...(here && here.parent ? [folderUI.crumbs(folder)] : []));
  crumbs.hidden = !here?.parent;
  const glyph = $("#folder-glyph");
  glyph.hidden = !here;
  if (here) glyph.replaceChildren(folderUI.glyph(here));
  $("#folder-actions").hidden = !here;
  $("#new-subfolder").hidden = !here;
  $("#import-files").querySelector("span").textContent = "Add content";
  $("#import-files").title = here
    ? `Add files to ${here.name}, or save things from the internet`
    : "Add files from this computer, or save things from the internet";
  const subfolders = here ? folderUI.children(folder) : [];
  const empty = $("#library-empty"),
    hint = here && EMPTY_HINTS[here.name.toLowerCase()];
  empty.replaceChildren();
  empty.append(
    icon(filtering ? "search" : here ? "folder" : "import"),
    el("h2", filtering ? "No matching files" : here ? "This folder is empty" : "Your library will appear here"),
    el("p", filtering ? "Try another search or clear your filters." : hint || "Drop files here to add them."),
  );
  if (!filtering) {
    const actions = el("div", "", "empty-actions");
    actions.append(button(here ? "Add files" : "Add content", () => (here ? quickImport({ folderId: folder }) : openImport()), "secondary"));
    if (here) actions.append(button("New folder", () => folderUI.create(folder), "secondary"));
    empty.append(actions);
  }
  $("#library-summary").textContent = [
    `${items.length.toLocaleString()} ${items.length === 1 ? "file" : "files"}`,
    items.length ? size(items.reduce((n, i) => n + i.bytes, 0)) : "",
    subfolders.length && !filtering ? `${subfolders.length} ${subfolders.length === 1 ? "folder" : "folders"}` : "",
  ]
    .filter(Boolean)
    .join(" · ");
  $("#grid-view").classList.toggle("active", layout === "grid");
  $("#list-view").classList.toggle("active", layout === "list");
  const focused = document.activeElement?.closest?.(".file-card")?.dataset.id,
    host = $("#library");
  host.className = `file-grid${layout === "list" ? " list" : ""}`;
  $("#list-head")?.remove();
  $("#folder-trail").replaceChildren();
  // Folders inside this one come first, while browsing it plainly.
  folderUI.renderTiles($("#folder-list"), filtering ? null : folder);
  $("#folder-list").hidden = !$("#folder-list").childElementCount;
  // Between the folders and the files: whether files inside the folders show too.
  $("#files-bar").hidden = !subfolders.length || filtering;
  $("#include-subfolders").checked = includeSub;
  $("#files-count").textContent = items.length ? items.length.toLocaleString() : "None";
  if (layout === "list" && items.length) {
    const head = el("div", "", "list-head"),
      sort = $("#sort").value;
    const column = (label, primary, secondary) => {
      if (!primary) return el("span", label);
      const b = button(label, () => {
        $("#sort").value = sort === primary && secondary ? secondary : primary;
        $("#sort").onchange();
      });
      if ([primary, secondary].includes(sort)) b.className = "on";
      return b;
    };
    head.append(
      el("span"),
      column("Name", "title", "title-desc"),
      column("Format", "type"),
      column("Rating", "rating"),
      column("Size", "size", "size-asc"),
      column("Added", "recent", "oldest"),
    );
    head.id = "list-head";
    host.before(head);
  }
  shown = items;
  mounted.clear();
  host.replaceChildren();
  paintWindow(true);
  // A folder holding only folders shows them, not an "empty" message.
  empty.hidden = items.length > 0 || (!!subfolders.length && !filtering);
  if (focused) cardFor(focused)?.focus({ preventScroll: true });
  updatePreviewNavigation();
  syncSelection();
  renderSidebarTags();
}
/*
 * Only the cards near the visible part of the grid exist; padding above and below
 * stands in for the rest. Cards are reused while they stay in range, so scrolling
 * builds a few new ones per frame however large the library is.
 */
let shown = [],
  geometry = null,
  range = "";
const mounted = new Map(),
  OVERSCAN = 3;
function measure() {
  const host = $("#library"),
    area = $("#file-area"),
    style = getComputedStyle(host),
    width = host.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight),
    tile = parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--tile-size")) || 195,
    gap = parseFloat(style.rowGap) || 0,
    columns = layout === "list" ? 1 : Math.max(1, Math.floor((width + gap) / (tile + gap))),
    key = `${layout}:${width}:${tile}`;
  if (geometry?.key === key && geometry.row) return geometry;
  // The fullest possible card (long title, tags, rating) sets one height for every card.
  let row = 0;
  if (shown.length) {
    const probe = buildCard({ ...shown[0], title: "Title ".repeat(40), tags: ["tag"], rating: 5 });
    probe.style.cssText = `visibility:hidden;position:absolute;height:auto;width:${(width - gap * (columns - 1)) / columns}px`;
    host.append(probe);
    row = Math.ceil(probe.getBoundingClientRect().height) + gap;
    probe.remove();
    host.style.setProperty("--card-height", `${row - gap}px`);
  }
  geometry = { key, columns, row, gap, area };
  return geometry;
}
function paintWindow(force = false) {
  const host = $("#library");
  if (!shown.length) {
    host.style.paddingTop = host.style.paddingBottom = "";
    host.replaceChildren();
    mounted.clear();
    range = "";
    return;
  }
  if (force) geometry = null;
  const { columns, row, gap, area } = measure();
  if (!row) return;
  const rows = Math.ceil(shown.length / columns),
    offset = host.getBoundingClientRect().top - area.getBoundingClientRect().top + area.scrollTop,
    top = area.scrollTop - offset,
    first = Math.max(0, Math.floor(top / row) - OVERSCAN),
    last = Math.min(rows, Math.ceil((top + area.clientHeight) / row) + OVERSCAN),
    key = `${first}:${last}:${columns}`;
  if (!force && key === range) return;
  range = key;
  host.style.paddingTop = `${first * row}px`;
  host.style.paddingBottom = `${Math.max(0, (rows - last) * row - (last < rows ? 0 : gap))}px`;
  const cards = [],
    keep = new Map();
  for (const item of shown.slice(first * columns, last * columns)) {
    const card = mounted.get(item.id) || buildCard(item);
    keep.set(item.id, card);
    cards.push(card);
  }
  // Moving nodes that are already in place is skipped, so images never reload.
  let at = host.firstElementChild;
  for (const card of cards) {
    if (card === at) at = at.nextElementSibling;
    else host.insertBefore(card, at);
  }
  while (at) {
    const next = at.nextElementSibling;
    at.remove();
    at = next;
  }
  mounted.clear();
  for (const [id, card] of keep) mounted.set(id, card);
}
let scrollFrame = 0;
$("#file-area").addEventListener(
  "scroll",
  () => {
    if (!scrollFrame)
      scrollFrame = requestAnimationFrame(() => {
        scrollFrame = 0;
        paintWindow();
      });
  },
  { passive: true },
);
new ResizeObserver(() => paintWindow(true)).observe($("#file-area"));
$("#thumbnail-size").addEventListener("input", () => paintWindow(true));
/** Scrolls a file's row into view, creating its card if needed. */
function reveal(id, block = "nearest") {
  const at = shown.findIndex((i) => i.id === id);
  if (at < 0) return null;
  const { columns, row, area } = measure(),
    host = $("#library"),
    top =
      host.getBoundingClientRect().top - area.getBoundingClientRect().top + area.scrollTop +
      Math.floor(at / columns) * row,
    stuck = layout === "list" ? $("#list-head")?.offsetHeight || 0 : 0;
  if (block === "center") area.scrollTop = top - (area.clientHeight - row) / 2;
  else if (top - stuck < area.scrollTop) area.scrollTop = top - stuck;
  else if (top + row > area.scrollTop + area.clientHeight)
    area.scrollTop = top + row - area.clientHeight;
  paintWindow();
  return cardFor(id);
}
function narrow() {
  $("#file-area").scrollTop = 0;
  renderLibrary();
}
const library = $("#library");
library.addEventListener("click", (event) => {
  const card = event.target.closest(".file-card");
  if (!card) return;
  const id = card.dataset.id;
  if (event.target.closest(".card-favorite")) {
    void run(async () => {
      await desktop.updateMetadata(id, { favorite: !byId(id)?.favorite });
      await refresh();
      renderInspector(true);
    })();
    return;
  }
  if (event.target.closest(".file-select"))
    return select(id, { additive: true, range: event.shiftKey });
  select(id, {
    additive: event.metaKey || event.ctrlKey,
    range: event.shiftKey,
  });
});
// Dragging a card (or the selection it belongs to) onto a folder moves the files.
library.addEventListener("dragstart", (event) => {
  const card = event.target.closest(".file-card");
  if (!card) return;
  if (!selection.has(card.dataset.id)) select(card.dataset.id);
  folderUI.dragItems(event, [...selection]);
});
library.addEventListener("dblclick", (event) => {
  const card = event.target.closest(".file-card");
  if (card && !event.target.closest(".card-favorite, .file-select"))
    openViewer(card.dataset.id);
});
library.addEventListener("keydown", (event) => {
  const card = event.target.closest(".file-card");
  if (card && event.target === card && event.key === "Enter") {
    event.preventDefault();
    openViewer(card.dataset.id);
  }
});
library.addEventListener("focusin", (event) => {
  // Tabbing onto a card selects it, so the inspector follows the keyboard.
  const card = event.target.closest(".file-card");
  if (card && event.target === card && !selection.has(card.dataset.id) && card.matches(":focus-visible"))
    select(card.dataset.id);
});
$("#file-area").addEventListener("click", (event) => {
  if (!event.target.closest(".file-card, button, input")) clearSelection();
});

/* Context menu */
const menu = $("#context-menu");
function closeMenu() {
  menu.hidden = true;
}
/** A small menu dropped from a toolbar button. */
function dropMenu(anchor, entries) {
  menu.replaceChildren();
  for (const entry of entries) {
    if (!entry) {
      menu.append(el("hr"));
      continue;
    }
    const [label, name, fn] = entry,
      b = el("button");
    b.setAttribute("role", "menuitem");
    b.append(icon(name), el("span", label));
    b.onclick = () => {
      closeMenu();
      void run(fn)();
    };
    menu.append(b);
  }
  menu.hidden = false;
  const box = anchor.getBoundingClientRect(),
    own = menu.getBoundingClientRect();
  menu.style.left = `${Math.max(6, Math.min(box.right - own.width, innerWidth - own.width - 6))}px`;
  menu.style.top = `${Math.min(box.bottom + 6, innerHeight - own.height - 6)}px`;
  menu.querySelector("button")?.focus();
}
function openDiscover(source) {
  const type = { web: "web", wikipedia: "wikipedia", maps: "maps", podcasts: "podcasts", software: "software", video: "video" }[source];
  openImport(type);
}
/** One shape for every "nothing here yet" moment. */
function emptyState(name, title, text, action) {
  const box = el("div", "", "empty-state");
  box.append(icon(name), el("h2", title), el("p", text));
  if (action) box.append(button(action[0], action[1], "secondary"));
  return box;
}
function openMenu(x, y) {
  const items = selectedItems(),
    one = items.length === 1 ? items[0] : null;
  if (!items.length) return;
  menu.replaceChildren();
  const add = (label, name, fn, hint, cls = "") => {
    const b = el("button", "", cls);
    b.setAttribute("role", "menuitem");
    b.append(icon(name), el("span", label));
    if (hint) b.append(el("kbd", hint));
    b.onclick = () => {
      closeMenu();
      void run(fn)();
    };
    menu.append(b);
  };
  const rule = () => menu.append(el("hr"));
  if (one) {
    add("Open", "eye", () => openViewer(one.id), "Space");
    add(mac ? "Show in Finder" : "Show in folder", "folder", () =>
      desktop.reveal(one.id),
    );
    if (
      !one.filename.endsWith(".pmtiles") &&
      one.type !== "software"
    )
      add("Open in default app", "external", () => desktop.openExternal(one.id));
    rule();
  }
  add(
    items.every((i) => i.favorite) ? "Remove from favorites" : "Add to favorites",
    "star",
    favorite,
    "F",
  );
  const stars = el("div", "", "menu-stars"),
    row = el("div", "", "stars"),
    shared = items.every((i) => (i.rating || 0) === (items[0].rating || 0))
      ? items[0].rating || 0
      : 0;
  for (let n = 1; n <= 5; n++) {
    const b = el("button", "", n <= shared ? "on" : "");
    b.setAttribute("aria-label", `${n} star${n === 1 ? "" : "s"}`);
    b.append(icon("star"));
    b.onclick = (event) => {
      event.stopPropagation();
      closeMenu();
      rate(n === shared ? 0 : n);
    };
    row.append(b);
  }
  stars.append(el("span", "Rate"), row);
  menu.append(stars);
  add(one ? "Add tags" : "Edit tags…", "tag", () => {
    if (!one) return tags.open(items.map((i) => i.id));
    showInspector();
    inspector.focusTags();
  }, one ? "T" : "");
  if (one) {
    add("Rename", "pencil", () => {
      showInspector();
      inspector.focusTitle();
    });
    add("Change cover…", "cover", () => chooseCover(one.id));
    rule();
    add("Copy title", "copy", () => copyText(one.title));
    add("Copy path in archive", "copy", () => copyText(one.path));
    if (one.sha256) add("Copy SHA-256", "copy", () => copyText(one.sha256));
  }
  rule();
  add("Move to folder…", "folder", () => folderUI.moveItemsTo(items.map((i) => i.id)));
  add("Move to Trash", "trash", () => trash(), mac ? "⌘⌫" : "Del", "danger");
  menu.hidden = false;
  const box = menu.getBoundingClientRect();
  menu.style.left = `${Math.max(6, Math.min(x, innerWidth - box.width - 6))}px`;
  menu.style.top = `${Math.max(6, Math.min(y, innerHeight - box.height - 6))}px`;
}
library.addEventListener("contextmenu", (event) => {
  const card = event.target.closest(".file-card");
  if (!card) return;
  event.preventDefault();
  if (!selection.has(card.dataset.id)) select(card.dataset.id);
  openMenu(event.clientX, event.clientY);
});
document.addEventListener("pointerdown", (event) => {
  if (!menu.hidden && !menu.contains(event.target)) closeMenu();
});
window.addEventListener("blur", closeMenu);
$("#file-area").addEventListener("scroll", closeMenu);

/* Viewer */
function openViewer(id) {
  const item = byId(id);
  if (!item) return;
  if (!selection.has(id) || selection.size > 1) select(id);
  viewerId = id;
  $("#viewer").hidden = false;
  $("#preview-title").textContent = item.title;
  preview(item, toast, state, () => openDiscover("software"));
  updatePreviewNavigation();
}
function closeViewer() {
  if (!viewerId && $("#viewer").hidden) return;
  const last = viewerId;
  viewerId = null;
  $("#viewer").hidden = true;
  $("#viewer").classList.remove("expanded");
  clearPreview();
  reveal(last)?.focus({ preventScroll: true });
}
function updatePreviewNavigation() {
  const index = visibleIds.indexOf(viewerId),
    item = byId(viewerId);
  $("#previous-file").disabled = index <= 0;
  $("#next-file").disabled = index < 0 || index >= visibleIds.length - 1;
  $("#viewer-position").textContent =
    index >= 0 ? `${index + 1} of ${visibleIds.length}` : "";
  $("#favorite-item").classList.toggle("is-favorite", !!item?.favorite);
  $("#favorite-item").setAttribute(
    "aria-label",
    item?.favorite ? "Remove from favorites" : "Add to favorites",
  );
  if (item) $("#preview-title").textContent = item.title;
}
function step(offset) {
  const from = viewerId || selected,
    index = visibleIds.indexOf(from),
    id =
      index < 0
        ? visibleIds[0]
        : visibleIds[Math.max(0, Math.min(visibleIds.length - 1, index + offset))];
  if (!id || id === from) return;
  if (viewerId) openViewer(id);
  else {
    select(id);
    reveal(id)?.focus({ preventScroll: true });
  }
}
function columns() {
  return measure().columns;
}
$("#previous-file").onclick = () => step(-1);
$("#next-file").onclick = () => step(1);
$("#close-inspector").onclick = closeViewer;
$("#favorite-item").onclick = favorite;
$("#expand-preview").onclick = () => {
  const expanded = $("#viewer").classList.toggle("expanded");
  $("#expand-preview").setAttribute(
    "aria-label",
    expanded ? "Reduce preview" : "Expand preview",
  );
  // The inspector sits above a full-window reader only when asked for.
  $("#inspector").hidden = expanded || view !== "library" || !inspectorOn;
};
function showInspector() {
  inspectorOn = true;
  localStorage.setItem("inspector", "on");
  $("#viewer").classList.remove("expanded");
  syncInspector();
  renderInspector(true);
}
$("#preview-details").onclick = () => {
  inspectorOn = !inspectorOn;
  localStorage.setItem("inspector", inspectorOn ? "on" : "off");
  syncInspector();
};
$("#preview-title").title = "Double-click to rename";
$("#preview-title").ondblclick = () => {
  showInspector();
  inspector.focusTitle();
};

/* Other pages */
function renderJobs() {
  const host = $("#jobs");
  host.replaceChildren();
  const imports = state.imports || [],
    importsIn = (phases) => imports.filter((t) => phases.includes(t.phase)).map((task) => ({ task })),
    reading = state.reading,
    readingShown = reading && (reading.current || reading.run);
  if (readingShown) host.append(el("div", "Checking", "jobs-heading"), readingRow(reading));
  if (!state.jobs.length && !imports.length) {
    if (readingShown) return;
    host.append(
      emptyState(
        "download",
        "No downloads yet",
        "Downloads appear here.",
        ["Add content", () => openImport()],
      ),
    );
    return;
  }
  const live = ["queued", "downloading", "verifying", "pausing", "paused", "waiting"];
  // A collection's downloads are one row: hundreds of files would bury everything else.
  const groups = new Map();
  for (const job of state.jobs)
    if (job.group?.id) {
      if (!groups.has(job.group.id)) groups.set(job.group.id, []);
      groups.get(job.group.id).push(job);
    }
  const settled = (jobs) => jobs.every((j) => j.status === "complete" || (j.status === "failed" && ["gone", "changed"].includes(j.failure)));
  const loose = state.jobs.filter((j) => !j.group?.id),
    rows = (jobs, finished) => [
      ...[...groups].filter(([, g]) => settled(g) === finished).map(([id, g]) => ({ group: id, jobs: g })),
      ...jobs.map((job) => ({ job })),
    ];
  for (const [title, entries] of [
    ["In progress", [...importsIn(["waiting", "copying", "checking"]), ...rows(loose.filter((j) => live.includes(j.status)), false)]],
    ["Failed", [...importsIn(["failed"]), ...rows(loose.filter((j) => j.status === "failed"), null)]],
    ["Finished", [...importsIn(["complete"]), ...rows(loose.filter((j) => j.status === "complete"), true)]],
  ]) {
    if (!entries.length) continue;
    const heading = el("div", `${title} · ${entries.length}`, "jobs-heading");
    if (title === "Finished")
      heading.append(
        button("Clear", run(async () => {
          await desktop.transfer(null, "clear");
          await refresh();
          renderJobs();
        }), "text-button"),
      );
    host.append(heading);
    for (const entry of entries)
      host.append(entry.group ? groupRow(entry.group, entry.jobs) : entry.task ? importRow(entry.task) : jobRow(entry.job));
  }
}
// Which collections are opened up in Transfers, to show their files.
const openGroups = new Set();
/** One collection's downloads together: progress, what's holding it up, and controls. */
function groupRow(id, jobs) {
  const row = el("article", "", "job job-group"),
    top = el("div", "", "job-top"),
    title = el("h3", "");
  title.append(icon("layers"), document.createTextNode(jobs[0].group.title));
  top.append(title);
  const controls = el("div", "", "job-controls"),
    act = (label, action, cls = "secondary") =>
      button(label, run(async () => {
        await desktop.collectionTransfers(id, action);
        await refresh();
        renderJobs();
      }), cls);
  const by = (fn) => jobs.filter(fn).length,
    done = by((j) => j.status === "complete"),
    moving = by((j) => ["queued", "downloading", "verifying", "waiting", "pausing"].includes(j.status)),
    stopped = by((j) => ["paused", "failed"].includes(j.status) && !["gone", "changed"].includes(j.failure)),
    lost = by((j) => j.status === "failed" && ["gone", "changed"].includes(j.failure));
  if (moving) controls.append(act("Pause", "pause"));
  else if (stopped) controls.append(act("Resume", "resume"));
  const folderId = state.folders?.find((f) => f.source?.key === id)?.id;
  if (done && folderId)
    controls.append(button("Show in library", () => {
      openFolder(folderId);
    }, "secondary"));
  if (moving || stopped) controls.append(act("Cancel", "cancel", "text-button"));
  else controls.append(act("Clear", "clear", "text-button"));
  top.append(controls);
  const total = jobs.reduce((n, j) => n + (j.total || 0), 0),
    got = jobs.reduce((n, j) => n + (j.status === "complete" ? j.total || j.bytes : j.bytes || 0), 0),
    parts = [`${done} of ${jobs.length} saved`];
  if (total) parts.push(`${size(got)} of ${size(total)}`);
  if (lost) parts.push(`${lost} can't be saved`);
  row.append(top, el("p", parts.join(" · ")));
  if (moving || stopped) {
    const bar = el("div", "", "job-bar"),
      fill = el("i");
    fill.style.width = `${Math.min(100, (total ? got / total : done / jobs.length) * 100)}%`;
    bar.append(fill);
    row.append(bar);
  }
  // The same words as the collection's own page: waiting on a server, refused, out of space.
  const states = Object.fromEntries(jobs.map((j) => [j.id, { state: j.status, failure: j.failure, error: j.error, retryAt: j.retryAt }]));
  const hostOf = (jobId) => {
    try {
      return new URL(jobs.find((j) => j.id === jobId).url).hostname.replace(/^www\./, "");
    } catch {
      return "";
    }
  };
  for (const line of summarizeCollection(states, hostOf)) row.append(el("p", line.text, `job-note ${line.tone}`));
  const toggle = el("button", "", "text-button job-group-toggle");
  toggle.type = "button";
  toggle.append(icon(openGroups.has(id) ? "chevron-down" : "chevron-right"), document.createTextNode(openGroups.has(id) ? "Hide files" : "Show files"));
  toggle.onclick = () => {
    openGroups.has(id) ? openGroups.delete(id) : openGroups.add(id);
    renderJobs();
  };
  row.append(toggle);
  if (openGroups.has(id)) {
    const list = el("div", "", "job-group-files");
    // What needs attention first, then what's moving, then what's done.
    const rank = (j) => (j.status === "failed" ? 0 : j.status === "paused" ? 1 : j.status === "complete" ? 3 : 2);
    for (const job of [...jobs].sort((a, b) => rank(a) - rank(b))) list.append(jobRow(job));
    row.append(list);
  }
  return row;
}
/** Download speed, smoothed across the app's once-a-second refreshes. */
const rates = new Map();
function speedOf(job) {
  const now = Date.now(),
    last = rates.get(job.id);
  if (!last || job.bytes < last.bytes) {
    rates.set(job.id, { bytes: job.bytes, at: now, rate: 0 });
    return 0;
  }
  if (job.bytes !== last.bytes && now - last.at >= 900) {
    const sample = (job.bytes - last.bytes) / ((now - last.at) / 1000);
    last.rate = last.rate ? last.rate * 0.6 + sample * 0.4 : sample;
    last.bytes = job.bytes;
    last.at = now;
  } else if (now - last.at > 8000) last.rate = 0;
  return last.rate;
}
const duration = (seconds) =>
  seconds < 90 ? `${Math.max(1, Math.round(seconds))} s` : seconds < 5400 ? `${Math.round(seconds / 60)} min` : `${(seconds / 3600).toFixed(1)} h`;
/** Opens the library at one item. */
function showInLibrary(id) {
  views.reset();
  folder = null;
  resetFilters();
  setView("library");
  renderCollections();
  renderLibrary();
  select(id);
  reveal(id, "center");
}
// A file put in the library folder in Finder is added by itself, and said once.
const announced = new Set();
function announceAdded() {
  for (const task of state.imports || []) {
    if (!task.auto || announced.has(task.id) || !["complete", "failed"].includes(task.phase)) continue;
    announced.add(task.id);
    const item = byId(task.itemId),
      place = state.folders?.find((f) => f.id === item?.folderId)?.name;
    toast(task.phase === "failed" ? `Couldn’t add ${task.title}: ${task.error}` : `Added ${task.title}${place ? ` to ${place}` : ""}.`);
  }
}
/** A Verify contents run, reading one file at a time. */
function readingRow(r) {
  const row = el("article", "", "job"),
    top = el("div", "", "job-top"),
    controls = el("div", "", "job-controls"),
    act = (label, action, cls = "secondary") =>
      button(label, run(async () => {
        await desktop.reading(action);
        await refresh();
        renderJobs();
      }), cls);
  top.append(el("h3", "Verifying contents"), controls);
  controls.append(r.paused ? act("Resume", "resume") : act("Pause", "pause"));
  if (r.run) controls.append(act("Stop", "stopVerify", "text-button"));
  const c = r.current,
    share = c?.bytes ? Math.min(1, c.done / c.bytes) : null,
    rate = c ? speedOf({ id: `read:${c.id}`, bytes: c.done }) : 0,
    parts = r.paused ? ["Paused"] : c ? [c.title, `${size(c.done)} of ${size(c.bytes)}`, `${Math.floor(share * 100)}%`] : ["Waiting to start"];
  if (c && !r.paused && rate > 1024) parts.push(`${size(rate)}/s`, `about ${duration((c.bytes - c.done) / rate)} left`);
  row.append(top, el("p", parts.join(" · ")));
  const more = [];
  if (r.run) more.push(`${r.run.done.toLocaleString()} of ${r.total.toLocaleString()} files verified`, `${size(r.run.read)} of ${size(r.run.bytes)}`);
  if (more.length) row.append(el("p", more.join(" · ")));
  if (c && !r.paused) {
    const bar = el("div", "", "job-bar"),
      fill = el("i");
    bar.setAttribute("role", "progressbar");
    bar.setAttribute("aria-label", `Progress for ${c.title}`);
    bar.setAttribute("aria-valuenow", String(Math.round(share * 100)));
    fill.style.width = `${share * 100}%`;
    bar.append(fill);
    row.append(bar);
  }
  return row;
}
/** Verify contents on the Archive page: how much has been read and confirmed, and when. */
function renderVerify() {
  const r = state.reading,
    card = $("#verify-card");
  card.hidden = !r?.total;
  if (!r?.total) return;
  const unread = r.total - r.verified,
    copy = el("div");
  copy.append(
    el(
      "h2",
      r.run
        ? "Verifying contents"
        : unread
          ? `${unread.toLocaleString()} ${unread === 1 ? "file hasn’t" : "files haven’t"} been verified`
          : "Every file’s contents verified",
    ),
    el(
      "p",
      r.run
        ? `${r.run.done.toLocaleString()} of ${r.total.toLocaleString()} files read. It carries on in the background and after a restart.`
        : `Reads every file to catch damage that sizes and dates can’t show${r.oldest ? `. Oldest verification: ${shortDate(r.oldest)}` : ""}.`,
    ),
  );
  $("#verify-hero").className = `hero${r.damaged ? " warn" : !unread && !r.run ? " ok" : ""}`;
  $("#verify-hero").replaceChildren(icon(r.damaged ? "alert" : "check"), copy);
  $("#verify-contents").textContent = r.run ? "Stop verifying" : "Verify contents";
}
$("#verify-contents").onclick = run(async () => {
  await desktop.reading(state.reading?.run ? "stopVerify" : "verify");
  await refresh();
  renderVerify();
});
/** A file being added from this computer: copied in, then checked. */
function importRow(task) {
  const row = el("article", "", `job${task.phase === "failed" ? " error" : ""}`),
    top = el("div", "", "job-top"),
    controls = el("div", "", "job-controls");
  top.append(el("h3", task.title), controls);
  if (task.phase === "complete" && byId(task.itemId))
    controls.append(button("View in library", () => showInLibrary(task.itemId), "secondary"));
  const moving = ["copying", "checking"].includes(task.phase),
    known = moving && task.bytes > 0 && task.done > 0,
    share = known ? Math.min(1, task.done / task.bytes) : null,
    rate = moving ? speedOf({ id: task.id, bytes: task.done }) : 0,
    parts = [{ waiting: "Waiting to start", copying: "Copying", checking: "Checking the file", complete: "Added to library", failed: "Failed" }[task.phase]];
  if (known) parts.push(`${size(task.done)} of ${size(task.bytes)}`, `${Math.floor(share * 100)}%`);
  else if (task.bytes) parts.push(size(task.bytes));
  if (rate > 1024) parts.push(`${size(rate)}/s`, `about ${duration((task.bytes - task.done) / rate)} left`);
  row.append(top, el("p", parts.join(" · ")));
  if (moving || task.phase === "waiting") {
    const bar = el("div", "", `job-bar${known ? "" : " busy"}`),
      fill = el("i");
    bar.setAttribute("role", "progressbar");
    bar.setAttribute("aria-label", `Progress for ${task.title}`);
    if (known) {
      bar.setAttribute("aria-valuenow", String(Math.round(share * 100)));
      fill.style.width = `${share * 100}%`;
    }
    bar.append(fill);
    row.append(bar);
  }
  if (task.error) row.append(el("p", task.error));
  return row;
}
function jobRow(job) {
  const row = el("article", "", `job${job.status === "failed" ? " error" : ""}`),
    top = el("div", "", "job-top");
  top.append(el("h3", job.title));
  const controls = el("div", "", "job-controls");
  top.append(controls);
  if (["queued", "downloading", "failed", "paused", "waiting"].includes(job.status) && !["gone", "changed"].includes(job.failure)) {
    const action = ["queued", "downloading", "waiting"].includes(job.status)
      ? "pause"
      : "resume";
    controls.append(
      button(
        action === "pause"
          ? "Pause"
          : job.driver === "pmtiles"
            ? "Restart"
            : "Resume",
        run(async () => {
          await desktop.transfer(job.id, action);
          await refresh();
        }),
        "secondary",
      ),
    );
  } else if (job.status === "complete" && byId(job.itemId)) {
    controls.append(
      button(
        "View in library",
        () => showInLibrary(job.itemId),
        "secondary",
      ),
    );
  }
  // Anything not finished can be stopped and removed; what it downloaded is deleted.
  if (["queued", "downloading", "paused", "pausing", "failed", "waiting"].includes(job.status))
    controls.append(
      button(
        job.status === "failed" ? "Remove" : "Cancel",
        run(async () => {
          await desktop.transfer(job.id, "cancel");
          await refresh();
          renderJobs();
        }),
        "text-button",
      ),
    );
  const status =
    {
      complete: "Saved to library",
      downloading: "Downloading",
      verifying: "Checking the file",
      queued: "Waiting to start",
      // Retried by itself: say when, so nobody wonders whether it's stuck.
      waiting: `${job.failure === "busy" ? "The server asked to wait" : "Connection failed"}; trying again${job.retryAt ? ` at ${new Date(job.retryAt).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}` : " soon"}`,
      paused: "Paused",
      pausing: "Pausing",
      failed: "Failed",
    }[job.status] || job.status;
  const moving = ["queued", "downloading", "verifying"].includes(job.status),
    rate = job.status === "downloading" ? speedOf(job) : 0,
    known = job.total > 0,
    share = known ? Math.min(job.status === "downloading" ? 0.99 : 1, job.bytes / job.total) : null,
    // Nothing arriving for half a minute is worth saying; Pause and Resume usually clears it.
    stalled = job.status === "downloading" && rates.get(job.id) && Date.now() - rates.get(job.id).at > 30000,
    parts = [stalled ? "Stalled, no data for a while" : (job.status === "downloading" && job.phase) || status];
  // Some sources never say how big a file is; then the amount so far is the honest figure.
  if (job.status === "complete") parts.push(size(job.bytes));
  else if (job.bytes || known)
    parts.push(known ? `${size(job.bytes)} of ${size(job.total)}` : `${size(job.bytes)} so far`);
  if (known && job.status === "downloading") parts.push(`${Math.floor(share * 100)}%`);
  if (rate > 1024) {
    parts.push(`${size(rate)}/s`);
    if (known && job.total > job.bytes) parts.push(`about ${duration((job.total - job.bytes) / rate)} left`);
  }
  const when = (value) =>
    value
      ? new Date(value).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })
      : "";
  if (job.status === "complete") parts.push(when(job.updatedAt || job.createdAt));
  else if (job.createdAt) parts.push(`started ${when(job.createdAt)}`);
  row.append(top, el("p", parts.filter(Boolean).join(" · ")));
  if (moving) {
    const bar = el("div", "", `job-bar${known && job.status === "downloading" ? "" : " busy"}`),
      fill = el("i");
    bar.setAttribute("role", "progressbar");
    bar.setAttribute("aria-label", `Progress for ${job.title}`);
    if (known) {
      bar.setAttribute("aria-valuenow", String(Math.round(share * 100)));
      fill.style.width = `${share * 100}%`;
    }
    bar.append(fill);
    row.append(bar);
  }
  if (job.error && job.status !== "waiting") row.append(el("p", job.error));
  if (job.warning) row.append(el("p", job.warning));
  return row;
}
function renderTags() {
  const host = $("#tag-table"),
    counts = tags.counts();
  host.replaceChildren();
  $("#tags-summary").textContent =
    `${counts.length} ${counts.length === 1 ? "tag" : "tags"}`;
  if (!counts.length) {
    host.append(
      emptyState(
        "tag",
        "No tags yet",
        "Tags are how you find things again by subject. Select a file in the library and press T, or type into Tags in its details.",
        ["Go to the library", () => $(".primary-nav [data-view=library]").click()],
      ),
    );
    return;
  }
  const most = Math.max(...counts.map(([, n]) => n));
  for (const [tag, count] of counts) {
    const row = el("div", "", "tag-row"),
      name = button("", () => {
        views.reset();
        folder = null;
        resetFilters();
        tags.set(tag);
        setView("library");
        renderCollections();
        renderLibrary();
      }),
      rename = button("Rename", () => {
        const input = el("input");
        input.value = tag;
        input.maxLength = 50;
        input.setAttribute("aria-label", `New name for ${tag}`);
        name.replaceWith(input);
        input.focus();
        input.select();
        let done = false;
        const finish = async (save) => {
          if (done) return;
          done = true;
          const next = input.value.trim().toLowerCase();
          if (save && next && next !== tag)
            try {
              const changed = await desktop.renameTag(tag, next);
              toast(`Renamed on ${changed} ${changed === 1 ? "file" : "files"}.`);
              await refresh();
            } catch (e) {
              toast(e.message);
            }
          renderTags();
        };
        input.onblur = () => finish(true);
        input.onkeydown = (event) => {
          if (event.key === "Enter") input.blur();
          if (event.key === "Escape") {
            event.stopPropagation();
            void finish(false);
          }
        };
      }, "text-button"),
      remove = button("Remove", async () => {
        if (remove.dataset.armed !== "1") {
          remove.dataset.armed = "1";
          remove.textContent = `Remove from ${count} ${count === 1 ? "file" : "files"}?`;
          remove.classList.add("danger");
          setTimeout(() => renderTags(), 5000);
          return;
        }
        try {
          await desktop.renameTag(tag, "");
          await refresh();
        } catch (e) {
          toast(e.message);
        }
        renderTags();
      }, "text-button");
    const chip = el("span", "", "tag-chip"),
      bar = el("span", "", "tag-bar"),
      fill = el("i");
    chip.append(icon("tag"));
    // How much it is used, next to the most-used tag.
    fill.style.width = `${Math.max(4, (count / most) * 100)}%`;
    bar.append(fill);
    name.append(chip, el("span", tag));
    row.append(name, bar, el("small", `${count} ${count === 1 ? "file" : "files"}`), rename, remove);
    host.append(row);
  }
}
/** The Archive page: what is here, whether it is intact, and how well it is described. */
function renderArchive() {
  const items = state.items,
    total = items.reduce((n, i) => n + i.bytes, 0),
    flagged = items.filter(needsAttention).length,
    verified = items.filter((i) => i.integrity === "publisher-verified").length;
  renderVerify();
  $("#archive-title").textContent = state.name || "Library";
  $("#archive-where").textContent = state.archiveRoot || "";
  // Files in the folder that were never added, for example copied in with Finder.
  const loose = $("#archive-untracked"),
    count = (shownUntracked = state.untracked || 0);
  loose.hidden = !count;
  if (count) {
    const copy = el("div");
    copy.append(
      el("h2", `${count.toLocaleString()} ${count === 1 ? "file isn’t" : "files aren’t"} in the library yet`),
      el("p", "They are in this library’s folder but weren’t added through Obelisk, for example copied in with Finder.", "muted"),
    );
    const add = button("Review and add", () => importer.untracked().catch((e) => toast(e.message)), "primary");
    loose.replaceChildren(icon("folder"), copy, add);
  }
  // The drive: this archive, everything else on it, and what is left.
  const diskHost = $("#archive-disk"),
    disk = state.disk;
  diskHost.hidden = !disk?.total;
  if (disk?.total) {
    const bar = el("div", "", "disk-bar"),
      mine = el("i", "", "disk-archive"),
      others = el("i", "", "disk-other"),
      used = Math.max(0, disk.total - disk.free);
    mine.style.width = `${Math.max(0.4, (total / disk.total) * 100)}%`;
    others.style.width = `${Math.max(0, ((used - total) / disk.total) * 100)}%`;
    bar.append(mine, others);
    const legend = el("div", "", "disk-legend");
    legend.append(
      el("span", `${size(total)} in this archive`, "disk-key archive"),
      el("span", `${size(Math.max(0, used - total))} other files`, "disk-key other"),
      el("span", `${size(disk.free)} free of ${size(disk.total)}`, "disk-key free"),
    );
    diskHost.replaceChildren(bar, legend);
    diskHost.classList.toggle("low", disk.free < disk.total * 0.05);
  }
  const stats = $("#archive-stats");
  stats.replaceChildren();
  for (const [value, label] of [
    [items.length.toLocaleString(), items.length === 1 ? "file" : "files"],
    [size(total), "on disk"],
    [tags.counts().length.toLocaleString(), "tags"],
    [verified.toLocaleString(), "checked against the publisher"],
  ]) {
    const box = el("div");
    box.append(el("strong", value), el("span", label));
    stats.append(box);
  }
  // One bar for the whole library, one row per top-level folder.
  const shelvesHost = $("#archive-shelves"),
    meter = el("div", "", "archive-meter"),
    rows = el("div", "", "archive-rows"),
    { all } = folderUI.counts();
  const tops = folderUI
    .children(null)
    .map((f) => ({ f, count: all.get(f.id)?.files || 0, bytes: all.get(f.id)?.bytes || 0 }))
    .filter((x) => x.count)
    .sort((a, b) => b.bytes - a.bytes);
  for (const { f, count, bytes } of tops) {
    const slice = el("i");
    slice.style.flex = String(Math.max(bytes, total / 80));
    slice.title = `${f.name}: ${size(bytes)}`;
    meter.append(slice);
    const row = button("", () => openFolder(f.id));
    row.append(
      folderUI.glyph(f),
      el("span", f.name),
      el("small", `${count.toLocaleString()} ${count === 1 ? "file" : "files"}`),
      el("small", size(bytes)),
    );
    rows.append(row);
  }
  shelvesHost.replaceChildren(...(tops.length ? [meter, rows] : [emptyState("archive", "Nothing here yet", "Files you add appear here, in their folders.", ["Add content", () => openImport()])]));
  const hero = $("#health-hero"),
    copy = el("div");
  copy.append(
    el(
      "h2",
      flagged
        ? `${flagged} ${flagged === 1 ? "file needs" : "files need"} a look`
        : state.lastCheck
          ? "Every file is intact"
          : "Not checked yet this session",
    ),
    el(
      "p",
      flagged
        ? "Some files moved, changed, went missing or are damaged. See below."
        : state.lastCheck
          ? `Checked ${shortDate(state.lastCheck.checkedAt)}.`
          : "Finds files that moved, changed or went missing, from their sizes and dates.",
    ),
  );
  hero.className = `hero${flagged ? " warn" : state.lastCheck ? " ok" : ""}`;
  hero.replaceChildren(icon(flagged ? "alert" : "shield"), copy);
  const care = $("#archive-care"),
    undescribed = items.filter((i) => !i.description?.trim()).length,
    untagged = items.filter((i) => !i.tags?.length).length,
    unrated = items.filter((i) => !i.rating).length;
  care.replaceChildren();
  for (const [count, label, quick] of [
    [undescribed, "without a description", null],
    [untagged, "without tags", "needs-details"],
    [unrated, "not rated", null],
  ]) {
    const row = el(quick && count ? "button" : "div", "", "care-row");
    row.append(el("strong", count.toLocaleString()), el("span", `${count === 1 ? "file" : "files"} ${label}`));
    if (quick && count) {
      row.type = "button";
      row.onclick = () => document.querySelector(`[data-quick="${quick}"]`).click();
    }
    care.append(row);
  }
}
/*
 * The main process says when something changed; the window then fetches what it
 * needs. Calls that arrive while a fetch is running share one more fetch after it,
 * so whoever awaits `refresh()` always sees state from after their own change.
 */
let refreshing = null,
  queued = null,
  attentionCount = 0,
  shownUntracked = 0;
function refresh() {
  if (!refreshing) {
    refreshing = load().finally(() => (refreshing = null));
    return refreshing;
  }
  queued ||= refreshing.then(() => {
    queued = null;
    return refresh();
  });
  return queued;
}
async function load() {
  // An action in progress refreshes when it finishes; check again shortly in case it doesn't.
  if (busy) return void setTimeout(refresh, 300);
  try {
    // Items come back only when they changed since the revision we hold.
    const next = await desktop.state(state.revision),
      foldersChanged = JSON.stringify(next.folders) !== JSON.stringify(state.folders),
      changed = !!next.items || foldersChanged;
    if (next.items) index = new Map(next.items.map((i) => [i.id, i]));
    else next.items = state.items;
    // Folders unchanged keep their identity, so counts are not worked out again.
    if (!foldersChanged) next.folders = state.folders;
    state = next;
    document.body.classList.add(`platform-${state.platform}`);
    $("#archive-name").textContent = state.name;
    // The mark keeps a start-truncated path reading left to right.
    $("#archive-path").textContent = state.archiveRoot;
    $("#archive-path").title = state.archiveRoot;
    $("#archive-picker").title = `${state.archiveRoot}\nLibrary details`;
    // The badge counts what needs a decision: files with problems, and files not added yet.
    const attention = (changed ? state.items.filter(needsAttention).length : attentionCount) || 0;
    attentionCount = attention;
    $("#health-count").textContent = attention + (state.untracked || 0) || "";
    if (!changed && state.untracked !== shownUntracked && view === "health") renderArchive();
    if (view === "health") renderVerify();
    if (changed) {
      $("#library-count").textContent = state.items.length || "";
      $("#status-summary").textContent =
        `${state.items.length} files · ${size(state.items.reduce((n, i) => n + i.bytes, 0))}`;
    }
    const count =
      state.jobs.filter((j) => ["queued", "downloading", "verifying", "pausing", "waiting"].includes(j.status)).length +
      (state.imports || []).filter((t) => ["waiting", "copying", "checking"].includes(t.phase)).length +
      (state.reading?.current && !state.reading.paused ? 1 : 0);
    announceAdded();
    $("#transfer-count").textContent = count || "";
    if (view === "transfers" || count) renderJobs();
    if (view === "discover" && collectionsUI.open) collectionsUI.update();
    if (changed) {
      renderCollections();
      renderLibrary();
      if (!$("#page-software").hidden) software();
      if (view === "tags" && !$("#tag-table input")) renderTags();
      if (view === "health") {
        renderArchive();
        renderReport(state.lastCheck, desktop, toast, refresh, importer.untracked);
      }
      if (viewerId && !byId(viewerId)) closeViewer();
    } else renderInspector();
  } catch (e) {
    toast(e.message);
  }
}
/** ⌘O and the Add content page's buttons: pick files, review them, then import. */
const importTarget = () =>
  view === "library" && folder !== null ? folder : view === "discover" && importInto && folderUI.byId(importInto) ? importInto : null;
const quickImport = (options = {}) => importer.choose(importTarget() && !options.folderId ? { ...options, folderId: importTarget() } : options);
// From a folder with a default name (Maps, Websites…), Add content opens that importer.
$("#import-files").onclick = () => openImport(folder !== null ? importer.forFolder(folder) : null, { into: folder });
$("#new-subfolder").onclick = () => void run(() => folderUI.create(folder))();
$("#folder-glyph").onclick = () => void run(() => folderUI.edit(folder, "icon"))();
$("#library-heading").ondblclick = () => folder !== null && void run(() => folderUI.edit(folder, "name"))();
$("#folder-actions").onclick = () => {
  const box = $("#folder-actions").getBoundingClientRect();
  folderUI.folderMenu(folder, box.left, box.bottom + 4);
};
$("#include-subfolders").onchange = () => {
  includeSub = $("#include-subfolders").checked;
  localStorage.setItem("includeSubfolders", includeSub ? "1" : "0");
  renderLibrary();
};
let softwareTargetReady = false;
function software() {
  if (!softwareTargetReady) {
    $("#software-platform").value = state.platform;
    $("#software-arch").value = state.arch;
    softwareTargetReady = true;
  }
  renderSoftware(state, desktop, toast, refresh, async (fn) => {
    busy = true;
    try {
      return await fn();
    } finally {
      busy = false;
    }
  });
}
$("#software-platform").onchange = software;
$("#software-arch").onchange = software;
$("#scan-archive").onclick = run(async () => {
  const b = $("#scan-archive");
  b.disabled = true;
  b.textContent = "Checking…";
  try {
    const report = await desktop.checkArchive();
    renderReport(report, desktop, toast, refresh, importer.untracked);
    await refresh();
    renderArchive();
  } finally {
    b.disabled = false;
    b.textContent = "Check files";
  }
});
window.addEventListener("message", async (event) => {
  const frame = $("#preview iframe"),
    data = event.data;
  if (event.origin !== "obelisk://app" || event.source !== frame?.contentWindow)
    return;
  // Another saved map was picked inside the map viewer.
  if (data?.type === "map:open" && byId(data.id)) return void openViewer(data.id);
  if (data?.type !== "map:thumbnail" || data.id !== viewerId) return;
  try {
    await desktop.saveThumbnail(data.id, data.image);
    forgetThumbnail(data.id);
    renderLibrary();
    renderInspector(true);
  } catch {}
});
$("#show-folder").onclick = run(() => desktop.reveal());
$("#archive-reveal").onclick = run(() => desktop.reveal());
$("#archive-switch").onclick = () => onboarding.switchLibrary();
// Sidebar sections fold away from their headings; which ones are folded is remembered.
for (const toggle of document.querySelectorAll(".section-toggle")) {
  const section = $("#" + toggle.getAttribute("aria-controls")),
    key = `folded:${section.id}`;
  const fold = (folded) => {
    toggle.setAttribute("aria-expanded", String(!folded));
    section.hidden = folded;
    try {
      if (folded) localStorage.setItem(key, "1");
      else localStorage.removeItem(key);
    } catch {}
  };
  try {
    if (localStorage.getItem(key)) fold(true);
  } catch {}
  toggle.onclick = () => fold(toggle.getAttribute("aria-expanded") === "true");
}
function setTheme(theme) {
  if (theme) localStorage.setItem("theme", theme);
  window.applyTheme();
  const current = localStorage.getItem("theme") || "dark";
  for (const b of document.querySelectorAll("[data-theme-choice]")) {
    b.classList.toggle("active", b.dataset.themeChoice === current);
    b.setAttribute("aria-pressed", String(b.dataset.themeChoice === current));
  }
}
document
  .querySelectorAll("[data-theme-choice]")
  .forEach((b) => (b.onclick = () => setTheme(b.dataset.themeChoice)));
setTheme();
let filtersOpen = localStorage.getItem("filters") === "open";
$("#toggle-filters").onclick = () => {
  filtersOpen = !filtersOpen;
  localStorage.setItem("filters", filtersOpen ? "open" : "closed");
  renderLibrary();
};
$("#search").oninput = narrow;
for (const id of filters) $(id).onchange = narrow;
$("#clear-filters").onclick = () => {
  views.reset();
  resetFilters();
  setView("library");
  renderLibrary();
};
$("#favorite-filter").onclick = () => {
  favoritesOnly = !favoritesOnly;
  narrow();
};
$("#sort").value = localStorage.getItem("librarySort") || "recent";
if (!$("#sort").value) $("#sort").value = "recent";
$("#sort").onchange = () => {
  localStorage.setItem("librarySort", $("#sort").value);
  narrow();
};
for (const [id, value] of [
  ["#grid-view", "grid"],
  ["#list-view", "list"],
])
  $(id).onclick = () => {
    layout = value;
    localStorage.setItem("libraryLayout", value);
    renderLibrary();
  };
const onboarding = createOnboarding({
  desktop,
  toast,
  refresh,
  openImport,
  chooseFiles: () => quickImport({}),
  showShortcuts: () => $("#shortcuts-dialog").showModal(),
});
$("#show-shortcuts").onclick = () => onboarding.guide();
$("#viewer-details").onclick = () => {
  if ($("#viewer").classList.contains("expanded") && inspectorOn)
    return showInspector();
  $("#preview-details").click();
};
$("#close-shortcuts").onclick = () => $("#shortcuts-dialog").close();
document.addEventListener("keydown", (e) => {
  if (document.querySelector("dialog[open]")) return;
  if (onboarding.open) {
    if (e.key === "Escape" && !state.firstRun && !state.missingLibrary) onboarding.close();
    return;
  }
  const editing = e.target.closest("input,textarea,select,[contenteditable]"),
    command = e.metaKey || e.ctrlKey,
    key = e.key.toLowerCase();
  if (!menu.hidden && e.key === "Escape") return closeMenu();
  if (command && (key === "k" || key === "f")) {
    e.preventDefault();
    if (view !== "library") setView("library");
    closeViewer();
    $("#search").focus();
    $("#search").select();
    return;
  }
  if (command && key === "i" && view === "library") {
    e.preventDefault();
    return $("#preview-details").click();
  }
  if (editing) {
    if (e.key === "Escape") e.target.blur();
    return;
  }
  if (e.key === "?") return $("#shortcuts-dialog").showModal();
  if (view !== "library") return;
  if (e.key === "Escape") {
    if (exitMediaFullscreen() || document.fullscreenElement) return;
    e.preventDefault();
    if (viewerId) closeViewer();
    else clearSelection();
    return;
  }
  if (command && key === "a" && !viewerId) {
    e.preventDefault();
    return $("#select-visible").click();
  }
  if (command && e.key === "Backspace") {
    e.preventDefault();
    return void trash();
  }
  if (command || e.altKey) return;
  const control = e.target.closest("button, a, summary, video, audio");
  if (e.key === " " && !(control && !control.classList.contains("file-card"))) {
    e.preventDefault();
    if (viewerId) closeViewer();
    else if (selected) openViewer(selected);
    return;
  }
  const move = {
    ArrowLeft: -1,
    ArrowRight: 1,
    ArrowUp: viewerId ? 0 : -columns(),
    ArrowDown: viewerId ? 0 : columns(),
  }[e.key];
  if (move !== undefined) {
    if (!move || e.target.closest("video, audio")) return;
    e.preventDefault();
    return step(move);
  }
  if (e.key === "Delete") return void trash();
  if (!selection.size) return;
  if (/^[0-5]$/.test(e.key)) return void rate(Number(e.key));
  if (key === "f") return void favorite();
  if (key === "t") {
    e.preventDefault();
    if (selection.size > 1 && !inspectorOn) return tags.open([...selection]);
    showInspector();
    inspector.focusTags();
  }
});
const openSource = (name) => openDiscover(name);
$("#import-choose").onclick = run(() => quickImport({}));
$("#import-folder").onclick = run(() => quickImport({ folders: true }));
$("#back-discover").onclick = () => importer.home();
$("#link-form").onsubmit = async (event) => {
  event.preventDefault();
  const form = event.currentTarget,
    submit = form.querySelector(".primary");
  submit.disabled = true;
  try {
    const type = importer.current;
    await desktop.download({ url: form.elements.url.value, title: "" });
    form.reset();
    toast(`Downloading${type ? ` into ${type.label.toLowerCase()}` : ""}. You can follow it in Transfers.`);
    await refresh();
  } catch (error) {
    toast(error.message);
  } finally {
    submit.disabled = false;
  }
};
$("#paste-link").onsubmit = async (event) => {
  event.preventDefault();
  const form = event.currentTarget,
    submit = form.querySelector(".primary");
  submit.disabled = true;
  try {
    await desktop.download({ url: form.elements.url.value, title: "" });
    form.reset();
    toast("Downloading. You can follow it in Transfers.");
    await refresh();
  } catch (error) {
    toast(error.message);
  } finally {
    submit.disabled = false;
  }
};
$("#paste-video").onclick = async () => {
  const url = $("#paste-link").elements.url.value;
  await openVideo();
  if (url) $("#video-form").elements.url.value = url;
};
$("#paste-page").onclick = () => {
  const url = $("#paste-link").elements.url.value;
  openSource("web");
  const field = $("#web-form").elements.urls;
  if (url) field.value = url;
  field.dispatchEvent(new Event("input", { bubbles: true }));
  field.focus();
};
{
  const form = $("#web-form"),
    fields = form.elements,
    note = $("#web-result"),
    outcomes = $("#web-outcomes"),
    copies = $("#web-copies"),
    submit = $("#web-save");
  let found = null,
    busy = false;
  // One per line. Several on a line are split only when each looks like an address.
  const addresses = () => [
    ...new Set(
      fields.urls.value
        .split("\n")
        .flatMap((line) => {
          const parts = line.trim().split(/[\s,]+/).filter(Boolean);
          return parts.length > 1 && parts.every((part) => part.includes("."))
            ? parts
            : [line.trim()];
        })
        .filter(Boolean),
    ),
  ];
  const chosen = () =>
    [...copies.querySelectorAll("input:checked")].map((box) => box.value);
  const plural = (n, word) =>
    `${n} ${n === 1 ? word : word === "copy" ? "copies" : `${word}s`}`;
  function forget() {
    found = null;
    copies.hidden = true;
    copies.replaceChildren();
  }
  function sync() {
    const count = addresses().length,
      wayback = fields.from.value === "wayback";
    fields.urls.rows = Math.min(8, Math.max(1, fields.urls.value.split("\n").length));
    $("#web-wayback").hidden = !wayback;
    // A timeline is about one page; several addresses each get a single copy.
    const single = count <= 1;
    for (const control of $("#web-many").querySelectorAll("input, select"))
      control.disabled = !single;
    $("#web-many-note").textContent = single ? "" : "For one address at a time.";
    if (!single && fields.span.value === "many") fields.span.value = "one";
    const many = wayback && fields.span.value === "many";
    if (!many) forget();
    submit.disabled = busy || (many && found && !chosen().length);
    submit.textContent = many
      ? found
        ? `Save ${plural(chosen().length, "copy")}`
        : "Find copies"
      : wayback
        ? `Save ${count > 1 ? plural(count, "copy") : "copy"}`
        : `Save ${count > 1 ? plural(count, "page") : "page"}`;
  }
  form.addEventListener("input", (event) => {
    if (!copies.contains(event.target)) forget();
    // A pasted Wayback link already says which copy is wanted.
    if (event.target === fields.urls && /(^|\s)(https?:\/\/)?web\.archive\.org\/web\/\d/i.test(fields.urls.value))
      fields.from.value = "wayback";
    sync();
  });
  form.addEventListener("change", sync);
  fields.urls.onkeydown = (event) => {
    if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      form.requestSubmit();
    }
  };
  function listCopies(result) {
    found = result;
    const head = el("div", "", "web-copies-head"),
      all = el("button", "Select all", "text-button"),
      none = el("button", "Select none", "text-button"),
      grid = el("div", "", "web-copies-grid");
    const set = (on) => () => {
      for (const box of grid.querySelectorAll("input")) box.checked = on;
      sync();
    };
    all.type = none.type = "button";
    all.onclick = set(true);
    none.onclick = set(false);
    head.append(
      el(
        "span",
        `${plural(result.copies.length, "copy")} of ${result.url.replace(/^https?:\/\//, "").replace(/\/$/, "")}. The Archive holds it from ${shortDate(result.first.captured)} to ${shortDate(result.last.captured)}.${result.missed ? ` ${result.missed} lookups failed; try again for the rest.` : ""}`,
      ),
      all,
      none,
    );
    // Year headings only earn their space when a year holds several copies.
    const years = result.copies.map((copy) => copy.timestamp.slice(0, 4)),
      grouped = new Set(years).size < years.length;
    let year = "";
    for (const copy of result.copies) {
      if (grouped && copy.timestamp.slice(0, 4) !== year) {
        year = copy.timestamp.slice(0, 4);
        grid.append(el("span", year, "web-copies-year"));
      }
      const label = el("label"),
        box = el("input");
      box.type = "checkbox";
      box.checked = true;
      box.value = copy.timestamp;
      label.append(
        box,
        new Date(copy.captured).toLocaleDateString(undefined, {
          month: "short",
          day: "numeric",
          timeZone: "UTC",
          ...(grouped ? {} : { year: "numeric" }),
        }),
      );
      grid.append(label);
    }
    copies.replaceChildren(head, grid);
    copies.hidden = false;
  }
  form.onsubmit = async (event) => {
    event.preventDefault();
    if (busy) return;
    const list = addresses(),
      wayback = fields.from.value === "wayback",
      many = wayback && fields.span.value === "many";
    if (!list.length) return;
    busy = true;
    sync();
    outcomes.replaceChildren();
    note.textContent = "";
    const report = (address, text, failed) => {
      const row = el("li", "", failed ? "failed" : "");
      row.append(el("strong", address.replace(/^https?:\/\//, "")), ` ${text}`);
      outcomes.append(row);
    };
    try {
      if (many && !found) {
        note.textContent = "Looking through the years. This can take a minute…";
        listCopies(
          await desktop.waybackCopies(list[0], {
            from: fields.fromYear.value,
            to: fields.toYear.value,
            every: fields.every.value,
          }),
        );
        note.textContent = "";
        return;
      }
      let queued = 0,
        already = 0;
      const failed = [];
      const save = async (address, input, label) => {
        try {
          const copy =
            wayback && !many ? await desktop.waybackCopy(address, fields.date.value) : null;
          const job = await desktop.savePage(
            copy ? { url: copy.url, timestamp: copy.timestamp } : input,
          );
          if (job.duplicate) already++;
          else queued++;
          if (list.length > 1 || copy)
            report(
              address,
              job.duplicate
                ? "is already in your library."
                : copy
                  ? `copy from ${shortDate(copy.captured)} is being saved.`
                  : "is being saved.",
            );
        } catch (error) {
          failed.push(address);
          report(label || address, error.message, true);
        }
      };
      if (many)
        for (const timestamp of chosen())
          await save(
            found.url,
            { url: found.url, timestamp },
            shortDate(found.copies.find((c) => c.timestamp === timestamp)?.captured),
          );
      else for (const address of list) await save(address, { url: address });
      if (queued)
        toast(
          `Saving ${plural(queued, many || wayback ? "copy" : "page")}. You can follow ${queued === 1 ? "it" : "them"} in Transfers.`,
        );
      note.textContent = [
        queued && (many || list.length > 1) ? `${plural(queued, many || wayback ? "copy" : "page")} queued.` : "",
        already ? `${already} already in your library.` : "",
        failed.length ? `${failed.length} could not be saved; fix ${failed.length === 1 ? "it" : "them"} below and try again.` : "",
      ]
        .filter(Boolean)
        .join(" ");
      // Leave only what still needs attention in the box.
      if (!many) fields.urls.value = failed.join("\n");
      else if (!failed.length) forget();
      await refresh();
    } catch (error) {
      note.textContent = error.message;
    } finally {
      busy = false;
      sync();
    }
  };
  sync();
}
let depth = 0;
document.addEventListener("dragenter", (e) => {
  if (e.dataTransfer.types.includes("Files")) {
    e.preventDefault();
    depth++;
    $("#drop-overlay").hidden = false;
  }
});
document.addEventListener("dragleave", () => {
  if (--depth <= 0) $("#drop-overlay").hidden = true;
});
document.addEventListener("dragover", (e) => e.preventDefault());
document.addEventListener("drop", async (e) => {
  e.preventDefault();
  depth = 0;
  $("#drop-overlay").hidden = true;
  // Dropped on a type's drop zone: they belong there. Elsewhere they are filed by
  // what they are, and the shelf being browsed only claims what nothing else does.
  const zone = e.target.closest?.(".drop-zone"),
    onto = e.target.closest?.(".folder-row, .folder-tile")?.dataset.id;
  if (!e.dataTransfer.files.length) return;
  try {
    // Dropped on a folder, or while one is open: they go there.
    await importer.dropped(
      [...e.dataTransfer.files],
      onto
        ? { folderId: onto }
        : zone
          ? { type: zone.dataset.type }
          : importTarget()
            ? { folderId: importTarget() }
            : {},
    );
  } catch (error) {
    toast(error.message);
  }
});
desktop.onMenu?.((action, detail) => {
  if (action === "import") void run(() => quickImport())();
  if (action === "archive") onboarding.switchLibrary();
  if (action === "import-folder")
    void run(() => quickImport({ folders: true }))();
  if (action === "theme") setTheme(detail);
  if (action === "shortcuts" && !document.querySelector("dialog[open]"))
    $("#shortcuts-dialog").showModal();
});
const sources = initSources({ api: sourceApi, el, size, toast, onQueued: refresh });
const collectionsUI = createCollections({
  desktop,
  toast,
  getState: () => state,
  openImporter: (id) => (id ? importer.open(id) : openImport()),
  openFeed: (url) => sources.openFeed(url),
  openItem: (id) => showInLibrary(id),
  openFolder: (id) => openFolder(id),
  showTransfers: () => setView("transfers"),
});
importer.setCollections(collectionsUI);
hydrateIcons();
await refresh();
renderLibrary();
renderCollections();
setView("library");
onboarding.start(state);
desktop.onLibraryChange(refresh);
// Speeds, "stalled" and times move on even when no new data arrives.
setInterval(() => {
  if (
    view === "transfers" &&
    (state.jobs.some((j) => ["queued", "downloading", "verifying", "pausing"].includes(j.status)) ||
      (state.imports || []).some((t) => ["copying", "checking"].includes(t.phase)) ||
      state.reading?.current)
  )
    renderJobs();
}, 2000);
