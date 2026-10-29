import {el, size, fileURL, formatOf, shortDate, copyText} from "./bridge.js";
import {icon} from "./icons.js";
import {attachThumbnail} from "./thumbnails.js";
import {needsAttention} from "./library-views.js";

const mac = window.navigator.platform.includes("Mac");

/**
 * The right-hand details pane. One file shows editable metadata that saves when
 * a field loses focus; several files show shared actions; none shows the archive.
 */
export function createInspector({
  host,
  desktop,
  getState,
  toast,
  refresh,
  actions,
}) {
  let signature = "",
    // Survives the re-render that follows a save.
    saved = {id: null, until: 0};
  const run = (fn) => async () => {
    try {
      await fn();
    } catch (e) {
      toast(e.message);
    }
  };
  const iconButton = (name, label, fn, cls = "secondary") => {
    const b = el("button", "", cls);
    b.type = "button";
    b.append(icon(name), el("span", label));
    b.onclick = run(fn);
    return b;
  };
  const section = (title, ...children) => {
    const node = el("section", "", "inspector-section");
    if (title) node.append(el("h3", title));
    node.append(...children);
    return node;
  };
  const property = (list, key, value, extra) => {
    if (!value) return;
    const row = el("div", "", "property"),
      dd = el("dd", value);
    if (extra) dd.append(extra);
    row.append(el("dt", key), dd);
    list.append(row);
  };
  const copyButton = (text, what) => {
    const b = el("button");
    b.type = "button";
    b.title = `Copy ${what}`;
    b.setAttribute("aria-label", `Copy ${what}`);
    b.append(icon("copy"));
    b.onclick = () =>
      toast(copyText(text) ? `Copied ${what}.` : "Could not copy.");
    return b;
  };

  function stars(items) {
    const row = el("div", "", "stars"),
      shared = items.every((i) => (i.rating || 0) === (items[0].rating || 0))
        ? items[0].rating || 0
        : 0;
    row.setAttribute("role", "group");
    row.setAttribute("aria-label", "Rating");
    for (let n = 1; n <= 5; n++) {
      const b = el("button", "", n <= shared ? "on" : "");
      b.type = "button";
      b.setAttribute("aria-label", `${n} star${n === 1 ? "" : "s"}`);
      b.setAttribute("aria-pressed", String(n === shared));
      b.append(icon("star"));
      b.onclick = () => actions.rate(n === shared ? 0 : n);
      row.append(b);
    }
    return row;
  }

  function tagEditor(items) {
    const ids = items.map((i) => i.id),
      box = el("div", "", "tag-editor"),
      input = el("input"),
      counts = new Map();
    for (const item of items)
      for (const tag of item.tags || [])
        counts.set(tag, (counts.get(tag) || 0) + 1);
    const change = async (tag, mode) => {
      try {
        await desktop.updateTags(ids, [tag], mode);
        await refresh();
        host.querySelector(".tag-editor input")?.focus();
      } catch (e) {
        toast(e.message);
      }
    };
    for (const [tag, count] of [...counts].sort((a, b) =>
      a[0].localeCompare(b[0]),
    )) {
      const chip = el(
          "span",
          tag,
          `chip${count < items.length ? " partial" : ""}`,
        ),
        remove = el("button");
      if (count < items.length)
        chip.title = `On ${count} of ${items.length} selected files`;
      remove.type = "button";
      remove.setAttribute("aria-label", `Remove tag ${tag}`);
      remove.append(icon("x"));
      remove.onclick = () => change(tag, "remove");
      chip.append(remove);
      box.append(chip);
    }
    input.setAttribute("list", "tag-suggestions");
    input.setAttribute("aria-label", "Add tag");
    input.placeholder = counts.size ? "Add tag" : "Add tags…";
    input.maxLength = 50;
    const commit = () => {
      const value = input.value.replace(/,/g, " ").trim();
      input.value = "";
      if (value) void change(value, "add");
    };
    input.onkeydown = (event) => {
      if (event.key === "Enter" || event.key === ",") {
        event.preventDefault();
        commit();
      } else if (event.key === "Backspace" && !input.value && counts.size) {
        void change([...counts.keys()].sort().at(-1), "remove");
      } else if (event.key === "Escape") {
        input.value = "";
        input.blur();
      }
    };
    // Choosing a suggestion fires `change` without a key press.
    input.onchange = commit;
    box.onclick = (event) => event.target === box && input.focus();
    box.append(input);
    return box;
  }

  function single(item, state) {
    const status = el("span", "", "edit-status");
    status.setAttribute("role", "status");
    const confirm = () => {
      const left = saved.id === item.id ? saved.until - Date.now() : 0;
      if (left <= 0) return;
      status.textContent = "Saved";
      setTimeout(() => {
        if (status.textContent === "Saved") status.textContent = "";
      }, left);
    };
    confirm();
    const save = async (patch) => {
      try {
        await desktop.updateMetadata(item.id, patch);
        Object.assign(item, patch);
        saved = {id: item.id, until: Date.now() + 2500};
        confirm();
        await refresh();
        return true;
      } catch (e) {
        status.textContent = "";
        toast(e.message);
        return false;
      }
    };
    const editable = (key, label, options = {}) => {
      const control = el(options.multiline ? "textarea" : "input", "", "ghost");
      control.name = key;
      control.value = item[key] || "";
      control.placeholder = options.placeholder || "";
      control.setAttribute("aria-label", options.name || label);
      if (options.max) control.maxLength = options.max;
      if (options.multiline) {
        const fit = () => {
          control.style.height = "auto";
          control.style.height = Math.min(control.scrollHeight + 2, 260) + "px";
        };
        control.rows = 2;
        control.addEventListener("input", fit);
        queueMicrotask(fit);
      }
      control.addEventListener("input", () => {
        status.textContent =
          control.value !== (item[key] || "") ? "Editing…" : "";
      });
      control.onblur = async () => {
        const value = options.multiline
          ? control.value.trim()
          : control.value.replace(/\s+/g, " ").trim();
        if (value === (item[key] || "")) {
          control.value = item[key] || "";
          if (status.textContent === "Editing…") status.textContent = "";
          return;
        }
        if (options.required && !value) {
          control.value = item[key] || "";
          status.textContent = "";
          return;
        }
        if (!(await save({[key]: value}))) control.value = item[key] || "";
      };
      control.onkeydown = (event) => {
        if (event.key === "Escape") {
          event.stopPropagation();
          control.value = item[key] || "";
          control.blur();
        } else if (
          event.key === "Enter" &&
          (!options.multiline || event.metaKey || event.ctrlKey)
        ) {
          event.preventDefault();
          control.blur();
        }
      };
      return control;
    };
    const field = (key, label, options) => {
      const wrap = el("div", "", "field");
      wrap.append(el("label", label), editable(key, label, options));
      return wrap;
    };
    const ext = formatOf(item).toLowerCase(),
      unavailable = ["missing", "ambiguous"].includes(item.fileState),
      nodes = [];

    const cover = el("button", "", `inspector-cover file-cover ${item.media}`);
    cover.type = "button";
    cover.setAttribute("aria-label", `Open ${item.title}`);
    cover.onclick = () => actions.open(item.id);
    if (item.media === "image" && !unavailable) {
      const image = el("img");
      image.src = fileURL(item);
      image.alt = "";
      cover.append(image);
    } else {
      cover.append(icon(item.type));
      attachThumbnail(cover, item);
    }
    const kind = el("div", "", "inspector-kind");
    kind.append(
      el(
        "span",
        `${actions.typeLabel(item)} · ${formatOf(item)} · ${size(item.bytes)}`,
      ),
      status,
    );
    const rating = el("div", "", "rating-row"),
      favorite = el("button", "", "icon-button");
    favorite.type = "button";
    favorite.id = "inspector-favorite";
    favorite.title = "Favorite (F)";
    favorite.setAttribute(
      "aria-label",
      item.favorite ? "Remove from favorites" : "Add to favorites",
    );
    favorite.classList.toggle("is-favorite", !!item.favorite);
    favorite.append(icon("star"));
    if (item.favorite) {
      favorite.style.color = "var(--star)";
      favorite.querySelector("svg").style.fill = "currentColor";
    }
    favorite.onclick = () => actions.favorite();
    rating.append(stars([item]), favorite);
    const tool = (name, label, fn, cls = "icon-button") => {
      const b = el("button", "", cls);
      b.type = "button";
      b.title = label;
      b.setAttribute("aria-label", label);
      b.append(icon(name));
      b.onclick = run(fn);
      return b;
    };
    const toolbar = el("div", "", "inspector-toolbar");
    toolbar.append(
      iconButton("eye", "Open", () => actions.open(item.id)),
      tool("folder", mac ? "Show in Finder" : "Show in folder", () =>
        desktop.reveal(item.id),
      ),
    );
    if (ext !== "pmtiles" && item.type !== "software")
      toolbar.append(
        tool(
          "external",
          ext === "zim" ? "Open in installed reader" : "Open in default app",
          () => desktop.openExternal(item.id),
        ),
      );
    const trash = tool(
      "trash",
      "Move to Trash",
      () => actions.trash([item.id]),
      "icon-button danger",
    );
    trash.id = "trash-item";
    toolbar.append(
      tool("cover", "Change cover", () => actions.chooseCover(item.id)),
      trash,
    );
    nodes.push(
      cover,
      editable("title", "File title", {max: 300, required: true}),
      kind,
      rating,
      toolbar,
    );
    nodes[1].classList.add("title");

    if (needsAttention(item)) {
      const note = el("div", "", "notice"),
        copy = el("span"),
        go = el("button", "Check files");
      go.type = "button";
      go.onclick = () => actions.goto("health");
      copy.append(
        document.createTextNode(
          item.fileState === "missing"
            ? "This file is missing from the archive folder. "
            : item.fileState === "ambiguous"
              ? "More than one file could be this one. "
              : item.fileState === "damaged"
                ? "This file is damaged. Its contents no longer match its checksum, though nothing saved over it. "
                : "This file no longer matches its recorded checksum. ",
        ),
        go,
      );
      note.append(icon("alert"), copy);
      nodes.push(note);
    }

    nodes.push(
      field("description", "Description", {
        name: "File description",
        multiline: true,
        max: 20000,
        placeholder: "",
      }),
    );
    const tagField = el("div", "", "field");
    tagField.append(el("label", "Tags"), tagEditor([item]));
    const original = [
      field("creator", "Creator", {
        max: 200,
        placeholder: "Author, artist, publisher",
      }),
      field("created", "Date", {
        name: "Date of original",
        max: 60,
        placeholder: "1969-07-20, c. 1850",
      }),
      field("rights", "Rights", {
        multiline: true,
        max: 500,
        placeholder: "License or permission",
      }),
    ];
    const choice = (label, options, value, onchange) => {
      const wrap = el("div", "", "field"),
        select = el("select", "", "ghost");
      select.setAttribute("aria-label", label);
      for (const [text, id] of options) select.add(new Option(text, id));
      select.value = value;
      select.onchange = () => onchange(select.value);
      wrap.append(el("label", label), select);
      return wrap;
    };
    // Where the file lives; clicking moves it to another folder.
    const place = el("div", "", "field inline folder-field"),
      where = el("button", "", "ghost folder-link");
    where.type = "button";
    where.title = "Move to another folder";
    where.append(el("span", actions.folderPath(item.folderId)));
    where.onclick = () => actions.moveTo();
    const go = el("button", "", "icon-button");
    go.type = "button";
    go.title = "Open this folder";
    go.setAttribute("aria-label", "Open this folder");
    go.append(icon("chevron-right"));
    go.onclick = () => actions.showFolder(item.folderId);
    place.append(el("label", "Folder"), where, go);
    original.unshift(place);
    for (const row of original) row.classList.add("inline");
    nodes.push(tagField, section("About this file", ...original));

    const properties = el("dl", "", "file-properties");
    property(properties, "File name", item.filename);
    property(properties, "Added", shortDate(item.acquiredAt));
    property(properties, "Edited", shortDate(item.metadataUpdatedAt));
    property(properties, "Collection", item.collection?.title);
    property(properties, "Source", item.source?.provider);
    const link = item.source?.url || item.source?.feedUrl;
    property(properties, "Source URL", link, link && copyButton(link, "URL"));
    property(
      properties,
      "Location",
      item.path.split("/").slice(0, -1).join("/"),
      copyButton(item.path, "path"),
    );
    property(properties, "Came from", item.source?.folder);
    if (item.source?.capturedAt)
      property(
        properties,
        item.source.capturedFrom === "wayback"
          ? "Wayback copy from"
          : "Page saved",
        shortDate(item.source.capturedAt),
      );
    nodes.push(section("Properties", properties));
    // The same page or file saved more than once, e.g. a site captured in different years.
    const key = (value) =>
      String(value || "")
        .replace(/^https?:\/\/(www\.)?/, "")
        .replace(/\/$/, "")
        .toLowerCase();
    const origin = key(item.source?.url || item.source?.feedUrl);
    const copies = origin
      ? state.items.filter(
          (other) =>
            other.id !== item.id &&
            key(other.source?.url || other.source?.feedUrl) === origin,
        )
      : [];
    if (copies.length) {
      const list = el("div", "", "other-copies");
      for (const other of copies.sort((a, b) =>
        String(a.source?.capturedAt || a.acquiredAt).localeCompare(
          String(b.source?.capturedAt || b.acquiredAt),
        ),
      )) {
        const b = el("button");
        b.type = "button";
        b.append(
          el("span", other.title),
          el("small", shortDate(other.source?.capturedAt || other.acquiredAt)),
        );
        b.onclick = () => actions.open(other.id);
        list.append(b);
      }
      nodes.push(section(`Other copies · ${copies.length}`, list));
    }
    if (item.type === "software") {
      // Whether this will actually run offline is something only a person knows.
      const meta = item.software || {},
        notes = (patch) =>
          run(async () => {
            await desktop.saveSoftwareNotes(item.id, {
              platform: meta.platform || "unknown",
              arch: meta.arch || "unknown",
              offlineTested: meta.offlineTested === true,
              ...patch,
            });
            await refresh();
          })(),
        tested = el("input"),
        label = el("label", "", "check");
      tested.type = "checkbox";
      tested.checked = meta.offlineTested === true;
      tested.onchange = () => {
        if (
          tested.checked &&
          [meta.platform, meta.arch].some((v) => !v || v === "unknown")
        ) {
          tested.checked = false;
          return toast(
            "Choose the system and processor it was tested on first.",
          );
        }
        notes({offlineTested: tested.checked});
      };
      label.append(
        tested,
        document.createTextNode(
          meta.offlineTested && meta.testedAt
            ? `Tested offline on ${shortDate(meta.testedAt)}`
            : "I tested this offline on that computer",
        ),
      );
      const rows = [
        choice(
          "Runs on",
          [
            ["Not sure", "unknown"],
            ["macOS", "darwin"],
            ["Windows", "win32"],
            ["Linux", "linux"],
          ],
          meta.platform || "unknown",
          (platform) => notes({platform, offlineTested: false}),
        ),
        choice(
          "Processor",
          [
            ["Not sure", "unknown"],
            ["Apple Silicon / ARM64", "arm64"],
            ["Intel / AMD 64-bit", "x64"],
            ["Universal", "universal"],
          ],
          meta.arch || "unknown",
          (arch) => notes({arch, offlineTested: false}),
        ),
      ];
      for (const row of rows) row.classList.add("inline");
      nodes.push(section("Will it run?", ...rows, label));
    }

    const preservation = el("dl", "", "file-properties"),
      badge = el("span", "", needsAttention(item) ? "badge-warn" : "badge-ok");
    badge.append(
      icon(needsAttention(item) ? "alert" : "check"),
      document.createTextNode(
        item.fileState === "missing"
          ? "File missing"
          : item.fileState === "ambiguous"
            ? "Needs review"
            : item.fileState === "damaged"
              ? "Damaged"
              : item.fileState === "modified" || item.integrity === "changed"
                ? "Changed since saved"
                : item.integrity === "pending"
                  ? "Not checked yet"
                  : item.integrity === "publisher-verified"
                    ? "Verified against publisher"
                    : "Checksum recorded",
      ),
    );
    const row = el("div", "", "property"),
      dd = el("dd");
    dd.append(badge);
    row.append(el("dt", "Integrity"), dd);
    preservation.append(row);
    if (item.sha256) {
      const sha = el("div", "", "property"),
        value = el("dd", `${item.sha256.slice(0, 16)}…`, "mono");
      value.title = item.sha256;
      value.append(copyButton(item.sha256, "SHA-256"));
      sha.append(el("dt", "SHA-256"), value);
      preservation.append(sha);
    }
    property(preservation, "Contents verified", shortDate(item.verifiedAt));
    property(
      preservation,
      "Original title",
      item.originalMetadata?.title !== item.title
        ? item.originalMetadata?.title
        : "",
    );
    property(preservation, "Original rights", item.originalMetadata?.rights);
    if (state.lastCheck)
      property(
        preservation,
        "Last check",
        shortDate(state.lastCheck.checkedAt),
      );
    nodes.push(section("Preservation", preservation));
    if (item.accessNote && !item.media)
      nodes.push(el("p", item.accessNote, "muted"));
    return nodes;
  }

  function many(items) {
    const stack = el("div", "", "inspector-stack");
    for (const item of items.slice(0, 6)) {
      const cover = el("div", "", `file-cover ${item.media}`);
      if (item.media === "image") {
        const image = el("img");
        image.src = fileURL(item);
        image.alt = "";
        cover.append(image);
      } else {
        cover.append(icon(item.type));
        attachThumbnail(cover, item);
      }
      stack.append(cover);
    }
    const title = el("h2", `${items.length} files selected`),
      kind = el(
        "div",
        `${size(items.reduce((n, i) => n + i.bytes, 0))} in total`,
        "inspector-kind",
      );
    title.style.margin = "0";
    const rating = el("div", "", "rating-row");
    rating.append(stars(items));
    const tagField = el("div", "", "field");
    tagField.append(el("label", "Tags on these files"), tagEditor(items));
    return [
      stack,
      title,
      kind,
      rating,
      tagField,
      el(
        "p",
        "Ratings and tags apply to every selected file. A dashed tag is on only some of them.",
        "muted",
      ),
    ];
  }

  /** Nothing selected: say how the panel works, and for a new archive, where to begin. */
  function overview(state) {
    const box = el("div", "", "inspector-empty");
    box.append(
      icon("panel"),
      el("h2", "No file selected"),
      el("p", "Select a file to see its details.", "muted"),
    );
    const nodes = [box];
    if (state.items.length <= 12) {
      const steps = el("div", "", "overview-bars");
      for (const [name, label, fn] of [
        ["import", "Add files", actions.add],
        ["archive", "Library details", () => actions.goto("health")],
      ]) {
        const b = el("button");
        b.type = "button";
        b.append(icon(name), el("span", label));
        b.onclick = fn;
        steps.append(b);
      }
      nodes.push(section("Start here", steps));
    }
    return nodes;
  }

  return {
    /** Re-renders only when what is shown would differ, never under a focused field. */
    render(items, force = false) {
      const state = getState(),
        next = JSON.stringify(
          items.length
            ? items.map((i) => [
                i.id,
                i.metadataUpdatedAt,
                i.fileState,
                i.integrity,
                i.sha256,
                i.kind,
                i.type,
                i.path,
                actions.folderPath(i.folderId),
              ])
            : [
                state.archiveRoot,
                state.items.length,
                state.lastCheck?.checkedAt,
                state.items.filter(needsAttention).length,
              ],
        );
      if (!force && next === signature) return;
      const active = document.activeElement;
      if (
        !force &&
        host.contains(active) &&
        active.matches("input.ghost, textarea.ghost")
      )
        return;
      // A tag half-typed while another one saves moves to the rebuilt field.
      const typing = host.contains(active) && active.closest(".tag-editor");
      const pending = typing ? active.value : "";
      if (typing) active.onchange = null;
      signature = next;
      const scroll = host.parentElement.scrollTop,
        same = host.dataset.ids === items.map((i) => i.id).join();
      host.dataset.ids = items.map((i) => i.id).join();
      host.replaceChildren(
        ...(items.length === 1
          ? single({...items[0]}, state)
          : items.length
            ? many(items)
            : overview(state)),
      );
      host.parentElement.scrollTop = same ? scroll : 0;
      const input = host.querySelector(".tag-editor input");
      if (typing && same && input) {
        input.value = pending;
        input.focus();
      }
    },
    focusTags() {
      host.querySelector(".tag-editor input")?.focus();
    },
    focusTitle() {
      const title = host.querySelector("[name=title]");
      title?.focus();
      title?.select();
    },
  };
}
