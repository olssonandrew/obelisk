import { el } from "./bridge.js";
/** Tag filter options, suggestions, and the bulk tag dialog. */
export function tagControls(api, getState, refresh, toast) {
  const filter = document.querySelector("#tag-filter");
  const dialog = document.querySelector("#tags-dialog"),
    input = dialog.querySelector("input"),
    mode = dialog.querySelector("select");
  let editing = [];
  const counts = () => {
    const map = new Map();
    for (const item of getState().items)
      for (const tag of item.tags || []) map.set(tag, (map.get(tag) || 0) + 1);
    return [...map].sort((a, b) => a[0].localeCompare(b[0]));
  };
  function open(ids) {
    if (!ids.length) return;
    editing = ids;
    const single = ids.length === 1;
    dialog.querySelector("h2").textContent = single
      ? "Edit tags"
      : `Tag ${ids.length} files`;
    mode.value = single ? "replace" : "add";
    input.value = single
      ? (getState().items.find((i) => i.id === ids[0])?.tags || []).join(", ")
      : "";
    dialog.querySelector("#tag-error").textContent = "";
    dialog.showModal();
    input.focus();
  }
  document.querySelector("#close-tags").onclick = () => dialog.close();
  dialog.querySelector("form").onsubmit = async (event) => {
    event.preventDefault();
    const save = dialog.querySelector("[type=submit]");
    save.disabled = true;
    try {
      await api.updateTags(editing, input.value.split(","), mode.value);
      dialog.close();
      await refresh();
      toast("Tags saved");
    } catch (error) {
      dialog.querySelector("#tag-error").textContent = error.message;
    } finally {
      save.disabled = false;
    }
  };
  return {
    open,
    counts,
    get value() {
      return filter.value;
    },
    set(tag) {
      filter.value = tag ? "tag:" + tag : "";
    },
    sync() {
      const current = filter.value,
        tags = counts().map(([tag]) => tag);
      filter.replaceChildren(
        new Option("All tags", ""),
        new Option("Untagged", "__untagged"),
        ...tags.map((t) => new Option(t, "tag:" + t)),
      );
      filter.value = [...filter.options].some((o) => o.value === current)
        ? current
        : "";
      document
        .querySelector("#tag-suggestions")
        .replaceChildren(...tags.map((t) => new Option(t)));
    },
    matches(item) {
      return (
        !filter.value ||
        (filter.value === "__untagged"
          ? !(item.tags || []).length
          : (item.tags || []).includes(filter.value.slice(4)))
      );
    },
    chips(item, limit = 3) {
      if (!item.tags?.length) return null;
      const row = el("div", "", "tag-chips");
      for (const tag of item.tags.slice(0, limit)) row.append(el("span", tag));
      if (item.tags.length > limit)
        row.append(el("span", `+${item.tags.length - limit}`));
      return row;
    },
  };
}
