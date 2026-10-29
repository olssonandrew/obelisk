/** The Add content page: every kind of thing the library holds, from this computer or online. */
import {el, size} from "./bridge.js";
import {icon, hydrateIcons} from "./icons.js";

/**
 * Each type says which shelf it fills, which online source (if any) feeds it, and
 * whether people mostly bring it from their own computer. Maps cannot be imported:
 * a map file is only useful when it was made for the viewer, so they are downloaded.
 */
export const importTypes = [
  {
    id: "web",
    label: "Web pages",
    icon: "browser",
    shelf: "reference",
    kind: "website",
    online: "web",
    blurb: "Save a page as it is now, or from the Wayback Machine.",
    localNote: "Have WACZ or WARC files?",
  },
  {
    id: "wikipedia",
    label: "Wikipedia",
    icon: "encyclopedia",
    shelf: "reference",
    kind: "encyclopedia",
    online: "wikipedia",
    blurb: "Offline editions, from one topic to all of it.",
    localNote: "Have ZIM files?",
  },
  {
    id: "maps",
    label: "Maps",
    icon: "map",
    shelf: "map",
    online: "maps",
    local: false,
    blurb: "Street maps of any area, for offline use.",
  },
  {
    id: "video",
    label: "Video",
    icon: "video",
    shelf: "video",
    online: "video",
    blurb: "Download from a link, or add your own.",
    localNote: "Have videos on this computer?",
  },
  {
    id: "podcasts",
    label: "Podcasts",
    icon: "podcast",
    shelf: "audio",
    kind: "podcast",
    online: "podcasts",
    blurb: "Search for shows and save episodes.",
    localNote: "Have episodes on this computer?",
  },
  {
    id: "audio",
    label: "Music and audio",
    icon: "audio",
    shelf: "audio",
    online: "link",
    localFirst: true,
    blurb: "Music, audiobooks and recordings.",
  },
  {
    id: "documents",
    label: "Books and documents",
    icon: "book",
    shelf: "document",
    online: "link",
    localFirst: true,
    blurb: "Books, papers, manuals, notes and personal records.",
  },
  {
    id: "images",
    label: "Images",
    icon: "image",
    shelf: "image",
    online: "link",
    localFirst: true,
    blurb: "Photos, art and scans.",
  },
  {
    id: "software",
    label: "Software and AI",
    icon: "software",
    shelf: "software",
    online: "software",
    blurb: "Installers, readers and AI models.",
    localNote: "Have installers or model files?",
  },
  {
    id: "other",
    label: "Anything else",
    icon: "file",
    shelf: "other",
    online: "link",
    localFirst: true,
    blurb: "Data, compressed archives and other files.",
  },
];
// Second spellings of a format already listed.
const alias = new Set(["markdown", "jpeg", "oga", "m4v", "yml", "htm"]);
const onlinePages = [
  "web",
  "wikipedia",
  "maps",
  "video",
  "podcasts",
  "software",
  "link",
];

export function createImporter({
  desktop,
  toast,
  refresh,
  getState,
  showImport,
  onPage,
  folders,
}) {
  const $ = (s) => document.querySelector(s);
  const shelves = () => getState().shelves || [];
  const shelfOf = (id) => shelves().find((s) => s.id === id);
  let current = null,
    collections = null;
  /** Collections on Import's front page and on each importer page. */
  function setCollections(ui) {
    collections = ui;
  }
  // Collections arrive after the page is drawn; a page left meanwhile isn't filled.
  async function fill(target, make, still) {
    target.replaceChildren();
    const made = await make?.().catch(() => null);
    if (made && still()) {
      target.replaceChildren(made);
      hydrateIcons(target);
    }
  }

  // Collections appear and disappear as the connection comes and goes.
  function refill() {
    if (current === null) void fill($("#collections-home"), collections?.homeRow, () => current === null);
    else {
      const type = current;
      void fill($("#type-collections"), collections && (() => collections.strip(type.id)), () => current === type);
    }
  }
  addEventListener("online", refill);
  addEventListener("offline", refill);

  /** The type page that best fits a shelf (and kind) being browsed in the library. */
  function forShelf(shelf, kind) {
    if (shelf === "reference")
      return kind === "website"
        ? "web"
        : kind === "encyclopedia"
          ? "wikipedia"
          : null;
    if (shelf === "audio") return kind === "podcast" ? "podcasts" : "audio";
    return importTypes.find((t) => t.shelf === shelf && !t.kind)?.id || null;
  }

  function home() {
    current = null;
    collections?.close();
    refill();
    const tiles = $("#discover-home");
    tiles.replaceChildren();
    for (const type of importTypes) {
      const tile = el("button");
      tile.type = "button";
      tile.dataset.type = type.id;
      const art = el("span", "", "tile-art");
      art.append(icon(type.icon));
      tile.append(art, el("strong", type.label), el("small", type.blurb));
      tile.onclick = () => open(type.id);
      tiles.append(tile);
    }
    $("#view-discover > .page-header").hidden = false;
    $(".import-quick").hidden = false;
    $("#view-discover > .section-label").hidden = false;
    $("#collections-home").hidden = false;
    tiles.hidden = false;
    $("#source-content").hidden = true;
  }

  async function importLocal(type, kind, whole = false) {
    await choose({ type, ...(kind ? { kind } : {}), ...(whole ? { folders: true } : {}) });
  }
  /** Picks files, then lists them for review. Nothing is copied until "Add". */
  async function choose(options = {}) {
    review(await desktop.chooseImport(options));
  }
  async function dropped(files, options = {}) {
    review(await desktop.prepareDrop(files, options));
  }

  /** "Drop files here", with a choice of kind where the shelf has kinds. */
  function localBlock(type, big) {
    const zone = el("div", "", `drop-zone${big ? " big" : ""}`),
      shelf = shelfOf(type.shelf);
    zone.dataset.type = type.shelf;
    if (type.kind) zone.dataset.kind = type.kind;
    const choose = el("button", "Choose files", big ? "primary" : "secondary"),
      folder = el("button", "Choose a folder", "secondary");
    choose.type = folder.type = "button";
    choose.onclick = () =>
      importLocal(type.shelf, zone.dataset.kind, false).catch((e) =>
        toast(e.message),
      );
    folder.onclick = () =>
      importLocal(type.shelf, zone.dataset.kind, true).catch((e) =>
        toast(e.message),
      );
    const text = el("div", "", "drop-text");
    if (big) {
      const art = el("span", "", "drop-art");
      art.append(icon("import"));
      text.append(art, el("strong", "Drop files here"));
    } else
      text.append(
        el("strong", type.localNote || "Have files on this computer?"),
        el("span", "Drop them here.", "muted"),
      );
    const buttons = el("div", "", "drop-buttons");
    buttons.append(choose, folder);
    zone.append(text, buttons);
    // Which formats open here; anything else is still kept.
    const opens =
      (type.kind
        ? shelf?.kinds.find((k) => k.id === type.kind)?.opens
        : shelf?.opens) || [];
    zone.append(
      el(
        "p",
        opens.length
          ? `Opens here: ${opens
              .filter((e) => !alias.has(e))
              .map((e) => e.toUpperCase())
              .join(", ")}. Other file formats accepted and categorized.`
          : "Any format. Common formats are automatically categorized.",
        "drop-formats",
      ),
    );
    return zone;
  }

  /** Which importer setting a page uses: its online tool, else files of its kind. */
  const destinationKey = (type) =>
    ["web", "wikipedia", "maps", "podcasts", "video", "software"].includes(type.online) ? type.online : `files:${type.shelf}`;
  /**
   * "Save to": where this importer puts what it saves. Remembered by folder, so it
   * survives renames and moves; if its folder was deleted, it asks for another.
   */
  function saveTo(type) {
    const key = destinationKey(type),
      wrap = el("label", "", "save-to"),
      select = el("select");
    const draw = () => {
      const state = getState(),
        current = state.destinations?.[key];
      const known = state.folders?.some((f) => f.id === current);
      folders.folderOptions(select, { value: known ? current : null, blank: known ? null : "Choose a folder…" });
      wrap.classList.toggle("missing", !known);
    };
    draw();
    select.setAttribute("aria-label", `Save ${type.label.toLowerCase()} to`);
    select.onchange = () =>
      select.value &&
      desktop
        .setDestination(key, select.value)
        .then(refresh)
        .then(draw)
        .catch((e) => toast(e.message));
    wrap.append(icon("folder"), el("span", "Save to"), select);
    return wrap;
  }

  function open(id) {
    const type = importTypes.find((t) => t.id === id);
    if (!type) return home();
    current = type;
    collections?.close();
    showImport();
    refill();
    $("#view-discover > .page-header").hidden = true;
    $(".import-quick").hidden = true;
    $("#view-discover > .section-label").hidden = true;
    $("#collections-home").hidden = true;
    $("#discover-home").hidden = true;
    $("#source-content").hidden = false;
    const intro = $("#type-intro"),
      art = el("span", "", "type-art");
    art.append(icon(type.icon));
    const words = el("div");
    words.append(el("h1", type.label), el("p", type.blurb, "muted"));
    intro.replaceChildren(art, words, saveTo(type));
    const local = $("#type-local");
    local.replaceChildren();
    if (type.local !== false) local.append(localBlock(type, type.localFirst));
    // Where the computer comes first, the link to a file comes after it.
    local.classList.toggle("after", !type.localFirst);
    $("#type-online-label").textContent =
      type.online === "link" ? "From a link" : "";
    $("#type-online-label").hidden = type.online !== "link";
    for (const page of onlinePages)
      $(`#page-${page}`).hidden = page !== type.online;
    const online = $(`#page-${type.online}`);
    // Order on the page: online first for downloadable things, local first otherwise.
    const content = $("#source-content");
    if (type.localFirst) content.append(local, $("#type-online-label"), online);
    else content.append(online, local);
    // Collections come last, after everything the page itself offers.
    content.append($("#type-collections"));
    content.prepend($("#back-discover"), intro);
    hydrateIcons(content);
    onPage(type.online);
    document.querySelector("#view-discover").scrollTop = 0;
  }

  /* Before importing: name, file and tag each file, then confirm. */
  const dialog = $("#review-dialog"),
    list = $("#review-list");
  let rows = [],
    token = null;
  const split = (text) => text.split(",").map((t) => t.trim()).filter(Boolean);
  const extension = (name) => (name.includes(".") ? name.split(".").pop().toUpperCase() : "FILE");

  function drawTags(row) {
    row.chips.replaceChildren();
    for (const tag of row.tags) {
      const chip = el("span", tag, "review-tag"),
        remove = el("button", "", "review-tag-remove");
      remove.type = "button";
      remove.setAttribute("aria-label", `Remove ${tag}`);
      remove.append(icon("x"));
      remove.onclick = () => {
        row.tags.delete(tag);
        drawTags(row);
      };
      chip.append(remove);
      row.chips.append(chip);
    }
    row.chips.append(row.tagInput);
  }

  function count() {
    // Big files on a library drive that can't share storage between copies: moving
    // them is the fast way in, so it is asked, once for all of them, not assumed.
    const movable = rows.filter((r) => r.file.movable).length;
    $("#review-move-label").hidden = $("#review-move-box").hidden = !movable;
    $("#review-move").required = !!movable;
    $("#review-move-label").textContent = movable > 1 ? `${movable} files on the library’s drive` : "On the library’s drive";
    const label = `Add ${rows.length} ${rows.length === 1 ? "file" : "files"}`;
    $("#review-title").textContent = label;
    $("#review-save").textContent = label;
    $("#review-save").disabled = !rows.length;
  }
  function review(listing) {
    if (!listing?.files?.length) return;
    token = listing.token;
    rows = [];
    list.replaceChildren();
    // One folder for all, or a different one per file.
    folders.folderOptions($("#review-folder"), { blank: "Each file’s own folder" });
    for (const file of listing.files) {
      const row = { file, tags: new Set() },
        line = el("div", "", "review-row"),
        main = el("div", "", "review-main"),
        top = el("div", "", "review-top"),
        filing = el("div", "", "review-filing"),
        remove = el("button", "", "icon-button review-remove");
      row.cover = el("div", "", "review-cover file-cover");
      row.title = el("input");
      row.title.value = file.title;
      row.title.setAttribute("aria-label", "Title");
      row.folder = el("select");
      row.folder.setAttribute("aria-label", `Folder for ${file.name}`);
      folders.folderOptions(row.folder, { value: file.folderId });
      row.cover.replaceChildren(icon(file.type));
      filing.append(icon("folder", "review-folder-icon"), row.folder);
      remove.type = "button";
      remove.title = "Leave out";
      remove.setAttribute("aria-label", `Leave out ${file.name}`);
      remove.append(icon("x"));
      remove.onclick = () => {
        line.remove();
        rows = rows.filter((r) => r !== row);
        count();
      };
      row.chips = el("div", "", "review-tags");
      row.tagInput = el("input");
      row.tagInput.placeholder = "Add tags";
      row.tagInput.setAttribute("aria-label", `Tags for ${file.name}`);
      const commit = () => {
        for (const tag of split(row.tagInput.value)) row.tags.add(tag);
        row.tagInput.value = "";
        drawTags(row);
        row.tagInput.focus();
      };
      row.tagInput.onkeydown = (event) => {
        if (event.key === "Enter" || event.key === ",") {
          event.preventDefault();
          commit();
        } else if (event.key === "Backspace" && !row.tagInput.value && row.tags.size) {
          row.tags.delete([...row.tags].pop());
          drawTags(row);
          row.tagInput.focus();
        }
      };
      row.tagInput.onblur = () => row.tagInput.value.trim() && commit();
      drawTags(row);
      top.append(row.title, filing);
      main.append(
        top,
        el("small", [extension(file.name), size(file.bytes), file.relative && `from ${file.relative}`].filter(Boolean).join(" · "), "muted"),
        row.chips,
      );
      line.append(row.cover, main, remove);
      list.append(line);
      rows.push(row);
    }
    $("#review-tags").value = "";
    $("#review-move").value = "";
    // When every file is headed to the same folder, say so at the top.
    const same = new Set(rows.map((r) => r.folder.value));
    if (same.size === 1) $("#review-folder").value = [...same][0];
    count();
    if (!dialog.open) dialog.showModal();
  }
  $("#review-folder").onchange = (event) => {
    if (event.target.value) for (const row of rows) row.folder.value = event.target.value;
  };
  const tagAll = () => {
    const tags = split($("#review-tags").value);
    if (!tags.length) return;
    for (const row of rows) {
      for (const tag of tags) row.tags.add(tag);
      drawTags(row);
    }
    $("#review-tags").value = "";
  };
  $("#review-tag-all").onclick = tagAll;
  $("#review-tags").onkeydown = (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      tagAll();
    }
  };
  $("#review-cancel").onclick = () => dialog.close();
  // Closing without importing (Cancel or Escape) forgets the list.
  dialog.addEventListener("close", () => {
    if (token) void desktop.cancelImport(token).catch(() => {});
    token = null;
  });
  $("#review-form").onsubmit = async (event) => {
    event.preventDefault();
    if (!token || !rows.length) return;
    const save = $("#review-save");
    save.disabled = true;
    save.textContent = "Adding…";
    const entries = rows.map((row) => {
      for (const tag of split(row.tagInput.value)) row.tags.add(tag);
      return {
        index: row.file.index,
        title: row.title.value,
        folderId: row.folder.value,
        tags: [...row.tags],
        move: !!row.file.movable && $("#review-move").value === "move",
      };
    });
    const sent = token,
      bytes = rows.reduce((n, row) => n + (row.file.bytes || 0), 0);
    token = null;
    // Big files take a while; they carry on in Transfers with the dialog closed.
    const adding = desktop.commitImport(sent, entries);
    dialog.close();
    save.disabled = false;
    if (bytes > 1e9) toast("Adding. You can follow it in Transfers.");
    try {
      await finish(await adding);
    } catch (e) {
      toast(e.message);
    }
  };

  /** Says what an import did. */
  async function finish(results) {
    if (!results?.length) return [];
    const errors = results.filter((r) => r.error),
      duplicates = results.filter((r) => r.duplicate),
      added = results.filter((r) => r.item && !r.duplicate);
    await refresh();
    toast(
      [
        `${added.length} added.`,
        duplicates.length ? `${duplicates.length} already in your library.` : "",
        errors.length ? `${errors.length} failed: ${errors[0].error}` : "",
      ]
        .filter(Boolean)
        .join(" "),
    );
    return added;
  }

  /** Files found in the archive folder that are not in the library yet. */
  async function untracked() {
    const listing = await desktop.reviewUntracked();
    if (listing) review(listing);
    else toast("These files are no longer there. Check again.");
  }

  // Folders keeping the name they were made with go to their importer. A renamed
  // folder may mean something else now, so it gets the general Add content page.
  const DEFAULT_NAMES = {
    websites: "web",
    wikipedia: "wikipedia",
    maps: "maps",
    podcasts: "podcasts",
    video: "video",
    software: "software",
    audio: "audio",
    music: "audio",
    audiobooks: "audio",
    documents: "documents",
    books: "documents",
    images: "images",
    photos: "images",
  };
  function forFolder(id) {
    const folder = getState().folders?.find((f) => f.id === id);
    if (!folder) return null;
    // A podcast show's own folder belongs to podcasts whatever it is called.
    if (folder.source?.key?.startsWith("podcast:")) return "podcasts";
    return DEFAULT_NAMES[folder.name.trim().toLowerCase()] || null;
  }
  return {
    home,
    open,
    setCollections,
    forShelf,
    forFolder,
    choose,
    dropped,
    untracked,
    get current() {
      return current;
    },
  };
}
