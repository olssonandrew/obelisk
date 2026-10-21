import { el, shortDate } from "./bridge.js";
import { icon } from "./icons.js";

// The page itself is drawn by the main process in an isolated view laid over `stage`.
// This file only draws the toolbar and keeps the view lined up with the stage.
let active = null;
window.obelisk.onSavedPageState?.((state) => active?.state(state));
window.obelisk.onSavedPageEscape?.((token) => {
  if (active?.token === token)
    document.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
    );
});

/** Opens a saved page inside `area`. Returns a function that closes it. */
export function showSavedPage(area, item, toast) {
  const page = el("div", "", "saved-page"),
    bar = el("div", "", "saved-bar"),
    stage = el("div", "", "saved-stage"),
    address = el("div", "", "saved-address"),
    badge = el("span", "Saved copy", "saved-badge"),
    url = el("span", "", "saved-url"),
    captured = el("span", "", "saved-date");
  const button = (name, label, glyph) => {
    const b = el("button", "", "icon-button");
    b.type = "button";
    b.setAttribute("aria-label", label);
    b.title = label;
    b.append(icon(glyph));
    b.onclick = () => run(name);
    return b;
  };
  const back = button("back", "Back", "chevron-left"),
    forward = button("forward", "Forward", "chevron-right"),
    home = button("home", "Back to the saved page", "refresh"),
    scripts = el("button", "Scripts on", "saved-scripts"),
    pop = el("button", "", "icon-button");
  back.disabled = forward.disabled = true;
  scripts.type = "button";
  scripts.onclick = () => run("scripts");
  pop.type = "button";
  pop.title = "Open in a new window";
  pop.setAttribute("aria-label", pop.title);
  pop.append(icon("external"));
  pop.onclick = () =>
    window.obelisk.openSavedPage(item.id).catch((e) => toast(e.message));
  address.append(badge, url);
  bar.append(back, forward, home, address, captured, scripts, pop);
  page.append(bar, stage);
  area.append(page);

  const me = { token: null, closed: false, frame: 0, last: "" };
  const run = (name) =>
    me.token &&
    window.obelisk
      .savedPageCommand(me.token, name)
      .catch((e) => toast(e.message));
  me.state = (state) => {
    if (state.token !== me.token) return;
    back.disabled = !state.back;
    forward.disabled = !state.forward;
    url.textContent = state.url.replace(/^https?:\/\//, "");
    url.title = state.url;
    badge.textContent = state.saved ? "Saved copy" : "Not saved";
    badge.classList.toggle("missing", !state.saved);
    const when = shortDate(state.captured);
    captured.textContent = when
      ? `${state.wayback ? "Wayback Machine," : "Saved"} ${when}`
      : "";
    captured.title = `${state.files} files in this copy`;
    scripts.textContent = state.scripts ? "Scripts on" : "Scripts off";
    scripts.setAttribute("aria-pressed", String(state.scripts));
    scripts.title = state.scripts
      ? "Turn off if the page misbehaves"
      : "Turn on if parts of the page are missing";
    page.classList.toggle("loading", state.loading);
  };

  // Anything drawn above the viewer (dialogs, menus, the toast) would otherwise sit
  // under the page, so the page steps out of the way or stops short of it.
  const where = () => {
    if (
      !stage.isConnected ||
      document.querySelector("dialog[open]") ||
      !document.querySelector("#context-menu")?.hidden
    )
      return null;
    const box = stage.getBoundingClientRect();
    if (!box.width || !box.height || !stage.checkVisibility()) return null;
    let bottom = box.bottom;
    const toast = document.querySelector("#toast");
    if (toast && !toast.hidden) {
      const t = toast.getBoundingClientRect();
      if (t.top < bottom && t.bottom > box.top && t.right > box.left && t.left < box.right)
        bottom = Math.max(box.top, t.top - 8);
    }
    return { x: box.left, y: box.top, width: box.width, height: bottom - box.top };
  };
  const follow = () => {
    if (me.closed) return;
    const box = where(),
      key = JSON.stringify(box);
    if (key !== me.last) {
      me.last = key;
      void window.obelisk.placeSavedPage(me.token, box).catch(() => {});
    }
    me.frame = requestAnimationFrame(follow);
  };

  window.obelisk.embedSavedPage(item.id).then(
    ({ token }) => {
      if (me.closed) return void window.obelisk.closeSavedPage(token);
      me.token = token;
      active = me;
      run("ready");
      follow();
    },
    (error) => {
      if (me.closed) return;
      stage.replaceChildren(el("p", error.message, "muted"));
    },
  );

  return () => {
    me.closed = true;
    cancelAnimationFrame(me.frame);
    if (active === me) active = null;
    if (me.token) void window.obelisk.closeSavedPage(me.token).catch(() => {});
  };
}
