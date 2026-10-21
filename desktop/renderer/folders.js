import { el, size } from "./bridge.js";
import { icon } from "./icons.js";

/*
 * Folders in the window: the sidebar tree (two levels), folder tiles and the path
 * above a folder's files, the folder menu, the edit dialog (name, icon, place), the
 * delete choice, a folder picker, and dragging files and folders onto folders.
 */
export const FOLDER_ICONS = [
  "folder", "inbox", "star", "heart", "flag", "book", "text", "file", "graduation",
  "audio", "headphones", "podcast", "album", "video", "film", "image", "camera", "palette",
  "map", "encyclopedia", "browser", "software", "code", "model", "archive",
  "briefcase", "home", "users", "calendar", "leaf", "lock",
];
const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });
const OPEN_KEY = "openFolders";

export function createFolderUI({ desktop, toast, refresh, getState, openFolder, currentFolder, selectedIds }) {
  const menu = document.querySelector("#context-menu");
  let expanded = new Set();
  try {
    expanded = new Set(JSON.parse(localStorage.getItem(OPEN_KEY) || "[]"));
  } catch {}
  const remember = () => {
    try {
      localStorage.setItem(OPEN_KEY, JSON.stringify([...expanded]));
    } catch {}
  };
  const run = (fn) => Promise.resolve().then(fn).catch((e) => toast(e.message));

  /* The tree */
  const folders = () => getState().folders || [];
  const byId = (id) => folders().find((f) => f.id === id) || null;
  const inbox = () => getState().inbox;
  // Folders dragged into place come first, in that order; the rest follow by name.
  const place = (folder) => (Number.isInteger(folder.position) ? folder.position : 1e9);
  function children(parent) {
    return folders()
      .filter((f) => (f.parent || null) === (parent || null))
      .sort((a, b) => (b.id === inbox()) - (a.id === inbox()) || place(a) - place(b) || collator.compare(a.name, b.name));
  }
  /** The folder and everything inside it. */
  function within(id) {
    const ids = new Set([id]);
    for (let grew = true; grew; ) {
      grew = false;
      for (const f of folders()) if (f.parent && ids.has(f.parent) && !ids.has(f.id)) ids.add(f.id), (grew = true);
    }
    return ids;
  }
  /** Root to folder. */
  function pathTo(id) {
    const out = [];
    for (let at = byId(id); at; at = byId(at.parent)) out.unshift(at);
    return out;
  }
  // File counts and sizes, worked out once per change.
  let counted = { items: null, folders: null, direct: new Map(), all: new Map() };
  function counts() {
    const state = getState();
    if (counted.items === state.items && counted.folders === state.folders) return counted;
    const direct = new Map();
    for (const item of state.items) {
      const key = item.folderId || inbox(),
        at = direct.get(key) || { files: 0, bytes: 0 };
      at.files++;
      at.bytes += item.bytes || 0;
      direct.set(key, at);
    }
    const all = new Map();
    const total = (id) => {
      if (all.has(id)) return all.get(id);
      const own = direct.get(id) || { files: 0, bytes: 0 },
        sum = { files: own.files, bytes: own.bytes };
      for (const child of children(id)) {
        const inner = total(child.id);
        sum.files += inner.files;
        sum.bytes += inner.bytes;
      }
      all.set(id, sum);
      return sum;
    };
    for (const f of folders()) total(f.id);
    counted = { items: state.items, folders: state.folders, direct, all };
    return counted;
  }
  const glyph = (folder) => icon(folder?.icon || "folder");

  /* Dragging files and folders onto folders */
  let dragging = null; // { items: [...] } or { folder: id }
  function dragItems(event, ids) {
    dragging = { items: ids };
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("application/x-obelisk-items", ids.join(","));
    const tag = el("div", ids.length === 1 ? "1 file" : `${ids.length} files`, "drag-tag");
    document.body.append(tag);
    event.dataTransfer.setDragImage(tag, 12, 12);
    setTimeout(() => tag.remove());
  }
  function dragFolder(event, id) {
    dragging = { folder: id };
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("application/x-obelisk-folder", id);
  }
  document.addEventListener("dragend", () => {
    dragging = null;
    unmarkAll();
  });
  const MARKS = ["drop-on", "drop-before", "drop-after"];
  const unmark = (node) => node.classList.remove(...MARKS);
  // One drop mark at a time: a row stops the drag reaching the list behind it, so the
  // list can't clear its own mark when the pointer moves back onto a row.
  const unmarkAll = () => document.querySelectorAll(MARKS.map((m) => "." + m).join()).forEach(unmark);
  /**
   * Makes `node` accept files and folders. `target` is a folder id, or null for the
   * top level. With `beside` (the parent of the row's folder), a folder dragged near
   * the row's top or bottom edge lands next to that folder instead of inside it. With
   * `first` (the first subfolder showing under an open folder), the bottom edge means
   * inside, ahead of it: below an open folder is the start of its contents.
   */
  function dropTarget(node, target, { beside, first, foldersOnly = false } = {}) {
    const where = (event) => {
      if (beside === undefined || !dragging?.folder) return { to: target };
      const box = node.getBoundingClientRect(),
        y = event.clientY - box.top,
        edge = Math.min(10, box.height * 0.3);
      if (y < edge) return { to: beside, mark: "drop-before", anchor: target };
      if (y > box.height - edge)
        return first ? { to: target, mark: "drop-after", anchor: first, before: true } : { to: beside, mark: "drop-after", anchor: target };
      return { to: target };
    };
    const accepts = (to, anchor) => {
      if (dragging?.items) return !foldersOnly;
      if (dragging?.folder) {
        const moving = byId(dragging.folder);
        if (!moving || anchor === dragging.folder) return false;
        // Beside another folder it can stay with the same parent: that only reorders.
        if (!anchor && (moving.parent || null) === (to || null)) return false;
        return !to || !within(dragging.folder).has(to);
      }
      return false;
    };
    node.addEventListener("dragover", (event) => {
      const { to, mark = "drop-on", anchor } = where(event);
      // A row never lets the drag fall through to the list behind it.
      if (beside !== undefined) event.stopPropagation();
      unmarkAll();
      if (!accepts(to, anchor)) return;
      event.preventDefault();
      event.stopPropagation();
      event.dataTransfer.dropEffect = "move";
      node.classList.add(mark);
    });
    node.addEventListener("dragleave", (event) => {
      if (!node.contains(event.relatedTarget)) unmark(node);
    });
    node.addEventListener("drop", (event) => {
      const { to, mark, anchor, before = mark === "drop-before" } = where(event);
      unmarkAll();
      if (!accepts(to, anchor)) return;
      event.preventDefault();
      event.stopPropagation();
      const was = dragging;
      dragging = null;
      void run(async () => {
        if (was.items) {
          const moved = await desktop.moveItems(was.items, to || inbox());
          await refresh();
          if (moved.length) toast(`${moved.length === 1 ? "1 file" : `${moved.length} files`} moved to ${byId(to || inbox())?.name || "Inbox"}.`);
        } else if (was.folder) {
          const moving = was.folder,
            changed = (byId(moving)?.parent || null) !== (to || null);
          if (changed) await desktop.moveFolder(moving, to);
          if (anchor) {
            // The new order of its siblings, with it next to the folder it was dropped by.
            const order = children(to).map((f) => f.id).filter((id) => id !== moving);
            order.splice(order.indexOf(anchor) + (before ? 0 : 1), 0, moving);
            await desktop.orderFolders(to, order);
          }
          if (to) expanded.add(to);
          remember();
          await refresh();
          if (changed) toast(`Moved to ${to ? byId(to)?.name : "the top level"}.`);
        }
      });
    });
  }

  /* Sidebar */
  function row(folder, depth) {
    const current = currentFolder(),
      kids = depth === 0 ? children(folder.id) : [],
      open = expanded.has(folder.id),
      { all } = counts(),
      item = el("div", "", `folder-row${depth ? " sub" : ""}`),
      main = el("button", "", "folder-main");
    item.dataset.id = folder.id;
    main.type = "button";
    if (folder.id === current) item.classList.add("active");
    else if (current && within(folder.id).has(current)) item.classList.add("open");
    const twisty = el("span", "", `folder-twisty${kids.length ? "" : " none"}${open ? " open" : ""}`);
    twisty.append(icon("chevron-right"));
    twisty.onclick = (event) => {
      event.stopPropagation();
      if (!kids.length) return;
      if (open) expanded.delete(folder.id);
      else expanded.add(folder.id);
      remember();
      renderSidebar();
    };
    const count = all.get(folder.id)?.files || 0;
    main.append(twisty, glyph(folder), el("span", folder.name, "folder-name"), el("small", count ? count.toLocaleString() : "", folder.id === inbox() && count ? "badge" : ""));
    main.onclick = () => {
      if (kids.length) {
        expanded.add(folder.id);
        remember();
      }
      openFolder(folder.id);
    };
    main.ondblclick = () => edit(folder.id);
    const more = el("button", "", "folder-more icon-button");
    more.type = "button";
    more.title = "Folder actions";
    more.setAttribute("aria-label", `Actions for ${folder.name}`);
    more.append(icon("more-horizontal"));
    more.onclick = (event) => {
      event.stopPropagation();
      const box = more.getBoundingClientRect();
      folderMenu(folder.id, box.left, box.bottom + 4);
    };
    item.append(main, more);
    item.addEventListener("contextmenu", (event) => {
      event.preventDefault();
      folderMenu(folder.id, event.clientX, event.clientY);
    });
    if (folder.id !== inbox()) {
      item.draggable = true;
      item.addEventListener("dragstart", (event) => dragFolder(event, folder.id));
    }
    const out = [item];
    // Subfolders show while the folder is open, or while something inside it is.
    const showing = kids.length && (open || (current && within(folder.id).has(current) && current !== folder.id));
    dropTarget(item, folder.id, { beside: folder.parent || null, first: showing ? kids[0].id : undefined });
    item.classList.toggle("showing-kids", !!showing);
    if (showing) for (const kid of kids) out.push(...row(kid, depth + 1));
    return out;
  }
  function renderSidebar() {
    const host = document.querySelector("#folder-tree");
    if (!host) return;
    const current = currentFolder();
    // Opening a folder opens the way to it.
    if (current) for (const f of pathTo(current).slice(0, -1)) expanded.add(f.id);
    host.replaceChildren(...children(null).flatMap((f) => row(f, 0)));
  }

  /* Inside a folder: path, tiles, actions */
  function crumbs(id) {
    const trail = el("nav", "", "folder-crumbs");
    trail.setAttribute("aria-label", "Folder path");
    const library = el("button", "Library", "crumb");
    library.type = "button";
    library.onclick = () => openFolder(null);
    dropTarget(library, null);
    trail.append(library);
    for (const folder of pathTo(id).slice(0, -1)) {
      const b = el("button", folder.name, "crumb");
      b.type = "button";
      b.onclick = () => openFolder(folder.id);
      dropTarget(b, folder.id);
      trail.append(icon("chevron-right", "crumb-sep"), b);
    }
    return trail;
  }
  function renderTiles(host, id) {
    host.replaceChildren();
    if (!id) return;
    const { all } = counts();
    for (const folder of children(id)) {
      const tile = el("button", "", "folder-tile"),
        art = el("span", "", "folder-tile-art"),
        inside = all.get(folder.id) || { files: 0, bytes: 0 },
        subs = children(folder.id).length;
      tile.type = "button";
      tile.dataset.id = folder.id;
      art.append(glyph(folder));
      tile.append(
        art,
        el("strong", folder.name),
        el("small", [inside.files ? `${inside.files.toLocaleString()} ${inside.files === 1 ? "file" : "files"}` : "Empty", subs ? `${subs} ${subs === 1 ? "folder" : "folders"}` : ""].filter(Boolean).join(" · ")),
      );
      tile.onclick = () => openFolder(folder.id);
      tile.addEventListener("contextmenu", (event) => {
        event.preventDefault();
        folderMenu(folder.id, event.clientX, event.clientY);
      });
      tile.draggable = true;
      tile.addEventListener("dragstart", (event) => dragFolder(event, folder.id));
      dropTarget(tile, folder.id);
      host.append(tile);
    }
  }
  /** The folder's size line, e.g. "12 files · 94 MB · 3 folders". */
  function summary(id) {
    const { direct } = counts(),
      own = direct.get(id) || { files: 0, bytes: 0 },
      subs = children(id).length;
    return [
      `${own.files.toLocaleString()} ${own.files === 1 ? "file" : "files"}`,
      own.files ? size(own.bytes) : "",
      subs ? `${subs} ${subs === 1 ? "folder" : "folders"}` : "",
    ]
      .filter(Boolean)
      .join(" · ");
  }

  /* Menu */
  function showMenu(entries, x, y) {
    menu.replaceChildren();
    for (const entry of entries) {
      if (!entry) {
        menu.append(el("hr"));
        continue;
      }
      const [label, name, fn, cls = ""] = entry,
        b = el("button", "", cls);
      b.setAttribute("role", "menuitem");
      b.append(icon(name), el("span", label));
      b.onclick = () => {
        menu.hidden = true;
        void run(fn);
      };
      menu.append(b);
    }
    menu.hidden = false;
    const box = menu.getBoundingClientRect();
    menu.style.left = `${Math.max(6, Math.min(x, innerWidth - box.width - 6))}px`;
    menu.style.top = `${Math.max(6, Math.min(y, innerHeight - box.height - 6))}px`;
    menu.querySelector("button")?.focus();
  }
  function folderMenu(id, x, y) {
    const folder = byId(id);
    if (!folder) return;
    const isInbox = id === inbox(),
      mac = navigator.platform.includes("Mac");
    showMenu(
      [
        ["Open", "eye", () => openFolder(id)],
        ["New folder inside", "folder-plus", () => create(id)],
        null,
        ["Rename…", "pencil", () => edit(id, "name")],
        ["Change icon…", "palette", () => edit(id, "icon")],
        !isInbox && !!folder.parent && ["Move up", "corner-left-up", () => moveUp(id)],
        !isInbox && ["Move to…", "folder", () => moveFolderTo(id)],
        [mac ? "Show in Finder" : "Show in folder", "external", () => desktop.revealFolder(id)],
        !isInbox && null,
        !isInbox && ["Delete…", "trash", () => confirmDelete(id), "danger"],
      ].filter((e) => e !== false),
      x,
      y,
    );
  }

  /* Dialogs */
  const dialog = el("dialog", "", "folder-dialog");
  dialog.setAttribute("aria-labelledby", "folder-dialog-title");
  document.body.append(dialog);
  let settle = null;
  dialog.addEventListener("close", () => {
    settle?.(null);
    settle = null;
  });
  function show(content) {
    dialog.replaceChildren(content);
    if (!dialog.open) dialog.showModal();
    return new Promise((resolve) => (settle = resolve));
  }
  function finish(value) {
    const done = settle;
    settle = null;
    dialog.close();
    done?.(value);
  }
  /** "Inside" choices: top level, then every folder, indented, minus `exclude`. */
  function folderOptions(select, { value = null, exclude = null, top = null, blank = null } = {}) {
    const banned = exclude ? within(exclude) : new Set();
    select.replaceChildren();
    if (blank) select.append(new Option(blank, ""));
    if (top) select.append(new Option(top, ""));
    const add = (parent, depth) => {
      for (const f of children(parent)) {
        if (banned.has(f.id)) continue;
        select.append(new Option(`${"  ".repeat(depth)}${f.name}`, f.id));
        add(f.id, depth + 1);
      }
    };
    add(null, 0);
    select.value = value || "";
    if (select.value !== (value || "")) select.value = "";
  }
  function heading(text) {
    const h = el("h2", text);
    h.id = "folder-dialog-title";
    return h;
  }
  function footer(...buttons) {
    const foot = el("div", "", "dialog-actions");
    foot.append(...buttons);
    return foot;
  }
  const action = (label, cls, fn) => {
    const b = el("button", label, cls);
    b.type = "button";
    b.onclick = fn;
    return b;
  };

  /** Create (parent given) or edit (id given): name, icon and where it sits. */
  async function editor({ id = null, parent = null, focus = "name" } = {}) {
    const folder = id ? byId(id) : null,
      form = el("form", "", "folder-form"),
      name = el("input"),
      where = el("select"),
      grid = el("div", "", "icon-grid"),
      preview = el("span", "", "folder-preview");
    let chosen = folder?.icon || "folder";
    name.value = folder?.name || "";
    name.placeholder = "Folder name";
    name.required = true;
    name.maxLength = 120;
    name.setAttribute("aria-label", "Folder name");
    const paint = () => preview.replaceChildren(icon(chosen));
    for (const glyphName of FOLDER_ICONS) {
      const b = el("button", "", "icon-choice");
      b.type = "button";
      b.title = glyphName;
      b.setAttribute("aria-label", glyphName);
      b.setAttribute("aria-pressed", String(glyphName === chosen));
      b.append(icon(glyphName));
      b.onclick = () => {
        chosen = glyphName;
        grid.querySelectorAll(".icon-choice").forEach((c) => c.setAttribute("aria-pressed", String(c === b)));
        paint();
      };
      grid.append(b);
    }
    paint();
    folderOptions(where, { value: folder ? folder.parent : parent, exclude: id, top: "Top level" });
    const top = el("div", "", "folder-name-row");
    top.append(preview, name);
    const placeRow = el("label", "", "folder-field");
    placeRow.append(el("span", "Inside"), where);
    const iconLabel = el("div", "Icon", "folder-label");
    const isInbox = id && id === inbox();
    if (isInbox) placeRow.hidden = true;
    const save = el("button", folder ? "Save" : "Create folder", "primary");
    save.type = "submit";
    const left = el("span", "", "spacer");
    const buttons = [];
    if (folder && !isInbox) buttons.push(action("Delete…", "text-button danger", () => confirmDelete(id)));
    buttons.push(left, action("Cancel", "secondary", () => finish(null)), save);
    form.append(heading(folder ? "Edit folder" : "New folder"), top, iconLabel, grid, placeRow, footer(...buttons));
    form.onsubmit = (event) => {
      event.preventDefault();
      const text = name.value.trim();
      if (!text) return name.focus();
      save.disabled = true;
      void run(async () => {
        const target = where.value || null;
        if (!folder) {
          const made = await desktop.createFolder(target, text, chosen);
          if (target) expanded.add(target);
          remember();
          finish(made);
          await refresh();
          return;
        }
        if (text !== folder.name) await desktop.renameFolder(id, text);
        if (chosen !== (folder.icon || "folder")) await desktop.setFolderIcon(id, chosen);
        if (!isInbox && (target || null) !== (folder.parent || null)) await desktop.moveFolder(id, target);
        finish(byId(id));
        await refresh();
      }).finally(() => (save.disabled = false));
    };
    const shown = show(form);
    requestAnimationFrame(() => {
      if (focus === "icon") grid.querySelector('[aria-pressed="true"]')?.focus();
      else {
        name.focus();
        name.select();
      }
    });
    return shown;
  }
  const create = (parent = currentFolder()) => editor({ parent });
  const edit = (id, focus) => editor({ id, focus });

  /** Delete: move what is inside up a level, or send it all to the Trash. */
  async function confirmDelete(id) {
    const folder = byId(id);
    if (!folder) return;
    const { all } = counts(),
      inside = all.get(id) || { files: 0 },
      subs = within(id).size - 1,
      parent = byId(folder.parent),
      upTo = parent ? parent.name : "the top level",
      box = el("div", "", "folder-form"),
      what = [inside.files && `${inside.files.toLocaleString()} ${inside.files === 1 ? "file" : "files"}`, subs && `${subs} ${subs === 1 ? "folder" : "folders"}`].filter(Boolean);
    box.append(heading(`Delete “${folder.name}”?`));
    const remove = async (keep) => {
      await desktop.removeFolder(id, keep);
      finish(true);
      if (currentFolder() && within(id).has(currentFolder())) openFolder(keep ? folder.parent || null : folder.parent || null);
      await refresh();
      toast(keep ? `“${folder.name}” deleted. Its contents moved to ${upTo}.` : `“${folder.name}” moved to the Trash.`);
    };
    if (!what.length) {
      box.append(el("p", "This folder is empty.", "muted"));
      box.append(footer(el("span", "", "spacer"), action("Cancel", "secondary", () => finish(null)), action("Delete folder", "primary danger", () => run(() => remove(true)))));
    } else {
      box.append(
        el("p", `It holds ${what.join(" and ")}.`, "muted"),
        choice("folder", `Keep the contents`, `Move everything to ${upTo}, then delete the folder.`, () => run(() => remove(true))),
        choice("trash", "Delete everything", "Move the folder and everything in it to the Trash.", () => run(() => remove(false)), "danger"),
        footer(el("span", "", "spacer"), action("Cancel", "secondary", () => finish(null))),
      );
    }
    return show(box);
  }
  function choice(glyphName, title, text, fn, cls = "") {
    const b = el("button", "", `delete-choice ${cls}`);
    b.type = "button";
    const words = el("span");
    words.append(el("strong", title), el("small", text));
    b.append(icon(glyphName), words);
    b.onclick = fn;
    return b;
  }

  /** Picks a folder from the whole tree. Resolves to its id, or null. */
  function pick({ title = "Move to", confirm = "Move", exclude = null, value = null, top = false } = {}) {
    const box = el("form", "", "folder-form"),
      list = el("div", "", "folder-pick"),
      banned = exclude ? within(exclude) : new Set(),
      go = el("button", confirm, "primary");
    let chosen = value;
    go.type = "submit";
    function draw() {
      const { all } = counts();
      list.replaceChildren();
      const add = (parent, depth) => {
        for (const f of children(parent)) {
          const b = el("button", "", "pick-row");
          b.type = "button";
          b.style.paddingLeft = `${10 + depth * 18}px`;
          b.disabled = banned.has(f.id);
          b.setAttribute("aria-pressed", String(f.id === chosen));
          b.append(glyph(f), el("span", f.name), el("small", (all.get(f.id)?.files || "").toLocaleString()));
          b.onclick = () => {
            chosen = f.id;
            draw();
          };
          b.ondblclick = () => !b.disabled && finish(f.id);
          list.append(b);
          add(f.id, depth + 1);
        }
      };
      if (top) {
        const b = el("button", "", "pick-row");
        b.type = "button";
        b.setAttribute("aria-pressed", String(chosen === ""));
        b.append(icon("layers"), el("span", "Top level"));
        b.onclick = () => {
          chosen = "";
          draw();
        };
        b.ondblclick = () => finish("");
        list.append(b);
      }
      add(null, top ? 1 : 0);
      go.disabled = chosen == null;
    }
    // A new folder is made inside the one selected (or at the top level) and chosen.
    const fresh = el("div", "", "pick-new"),
      named = el("input"),
      make = action("Add folder", "secondary", () =>
        run(async () => {
          const text = named.value.trim();
          if (!text) return named.focus();
          const made = await desktop.createFolder(chosen || null, text, "folder");
          if (chosen) expanded.add(chosen);
          remember();
          await refresh();
          chosen = made.id;
          named.value = "";
          draw();
          list.querySelector('[aria-pressed="true"]')?.scrollIntoView({ block: "nearest" });
        }),
      );
    named.placeholder = "New folder name";
    named.setAttribute("aria-label", "New folder name");
    named.onkeydown = (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        make.click();
      }
    };
    fresh.append(named, make);
    draw();
    box.append(heading(title), list, fresh, footer(el("span", "", "spacer"), action("Cancel", "secondary", () => finish(null)), go));
    box.onsubmit = (event) => {
      event.preventDefault();
      if (chosen != null) finish(chosen);
    };
    const result = show(box);
    requestAnimationFrame(() => list.querySelector('[aria-pressed="true"]')?.scrollIntoView({ block: "center" }));
    return result;
  }
  async function moveFolderTo(id) {
    const folder = byId(id);
    const target = await pick({ title: `Move “${folder.name}” to`, exclude: id, value: folder.parent || "", top: true });
    if (target == null || target === (folder.parent || "")) return;
    await desktop.moveFolder(id, target || null);
    if (target) expanded.add(target);
    remember();
    await refresh();
  }
  /** One level up: next to the folder that holds it now. */
  async function moveUp(id) {
    const parent = byId(byId(id)?.parent);
    if (!parent) return;
    await desktop.moveFolder(id, parent.parent || null);
    if (parent.parent) expanded.add(parent.parent);
    remember();
    await refresh();
    toast(`Moved to ${parent.parent ? byId(parent.parent).name : "the top level"}.`);
  }
  async function moveItemsTo(ids) {
    const target = await pick({ title: ids.length === 1 ? "Move file to" : `Move ${ids.length} files to` });
    if (!target) return;
    const moved = await desktop.moveItems(ids, target);
    await refresh();
    toast(`${moved.length === 1 ? "1 file" : `${moved.length} files`} moved to ${byId(target)?.name || "folder"}.`);
  }

  document.querySelector("#new-folder")?.addEventListener("click", () => void run(() => create(null)));
  const heading_ = document.querySelector("#folders-heading");
  if (heading_) dropTarget(heading_, null);
  // Empty space below the folders is the top level.
  const tree_ = document.querySelector("#folder-tree");
  if (tree_) dropTarget(tree_, null, { foldersOnly: true });

  return {
    byId,
    children,
    within,
    pathTo,
    counts,
    renderSidebar,
    renderTiles,
    crumbs,
    summary,
    folderMenu,
    create,
    edit,
    confirmDelete,
    pick,
    moveItemsTo,
    folderOptions,
    dragItems,
    dropTarget,
    glyph,
  };
}
