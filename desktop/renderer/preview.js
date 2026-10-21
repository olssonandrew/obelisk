import { attachThumbnail } from "./thumbnails.js";
import { el, fileURL } from "./bridge.js";
import { icon } from "./icons.js";
import { peaksFor, drawWave } from "./waveform.js";
import { showSavedPage } from "./saved-page.js";
/** The recording's shape, filled in as it plays. Click or drag to jump. */
function scrubber(sound, media) {
  const bar = el("div", "", "wave-scrubber"),
    played = el("div", "", "wave-played");
  played.append(drawWave(sound.peaks));
  bar.append(drawWave(sound.peaks), played);
  const length = () =>
    Number.isFinite(media.duration) && media.duration
      ? media.duration
      : sound.seconds;
  const show = () =>
    bar.style.setProperty(
      "--played",
      `${Math.min(100, (media.currentTime / length()) * 100)}%`,
    );
  const seek = (event) => {
    const box = bar.getBoundingClientRect();
    media.currentTime =
      Math.min(1, Math.max(0, (event.clientX - box.left) / box.width)) *
      length();
    show();
  };
  bar.onpointerdown = (event) => {
    bar.setPointerCapture(event.pointerId);
    seek(event);
    bar.onpointermove = seek;
  };
  bar.onpointerup = bar.onpointercancel = () => (bar.onpointermove = null);
  media.addEventListener("timeupdate", show);
  media.addEventListener("seeked", show);
  return bar;
}
let generation = 0,
  zimToken = null,
  closeWeb = null;
export function exitMediaFullscreen() {
  const area = document.querySelector("#preview");
  if (!area.classList.contains("video-full")) return false;
  area.classList.remove("video-full");
  document.body.classList.remove("video-full");
  const button = area.querySelector(".video-fullscreen");
  if (button) button.textContent = "Full screen";
  void window.obelisk.videoFullscreen(false).catch(() => {});
  return true;
}
window.obelisk.onVideoExit?.(() => exitMediaFullscreen());
export function clearPreview() {
  if (zimToken) {
    void window.obelisk.closeZim(zimToken).catch(() => {});
    zimToken = null;
  }
  closeWeb?.();
  closeWeb = null;
  exitMediaFullscreen();
  generation++;
  document.querySelector("#preview").replaceChildren();
}
/** Fills the viewer with the bundled reader or player for one file. */
export async function preview(
  item,
  toast,
  state = { items: [] },
  openSoftware = () => {},
) {
  clearPreview();
  const current = generation;
  const area = document.querySelector("#preview"),
    url = fileURL(item),
    ext = item.filename.split(".").pop().toLowerCase();
  const action = (label, fn) => {
    const b = el("button", label, "secondary");
    b.onclick = () =>
      Promise.resolve()
        .then(fn)
        .catch((e) => toast(e.message));
    return b;
  };
  if (item.fileState === "missing" || item.fileState === "ambiguous") {
    area.append(
      el("p", "File unavailable. Click the library name, then Check files, to look for it.", "muted"),
    );
  } else if (ext === "zim") {
    const notice = el("div", "", "reader-notice");
    notice.setAttribute("role", "status");
    notice.append(el("p", "Opening archive…", "muted"));
    area.append(notice);
    try {
      const info = await window.obelisk.openZim(item.id);
      if (current !== generation) {
        await window.obelisk.closeZim(info.token);
        return;
      }
      zimToken = info.token;
      const frame = el("iframe");
      frame.title = "ZIM reader";
      frame.src = `zim/index.html?${new URLSearchParams({ token: info.token, home: info.home || "", title: info.title })}`;
      area.replaceChildren(frame);
    } catch (error) {
      if (current !== generation) return;
      notice.replaceChildren(
        el("h2", "Couldn’t open this archive"),
        el("p", error.message),
      );
      notice.append(
        action("Try again", () => preview(item, toast, state, openSoftware)),
        action("Open in another reader", () =>
          window.obelisk.openExternal(item.id),
        ),
      );
    }
  } else if (item.media === "image") {
    const image = el("img");
    image.src = url;
    image.alt = item.title;
    area.append(image);
  } else if (["audio", "video"].includes(item.media)) {
    const media = el(item.media);
    media.controls = true;
    if (item.media === "video") {
      media.controlsList.add("nofullscreen");
      const full = action("Full screen", async () => {
        if (exitMediaFullscreen()) return;
        await window.obelisk.videoFullscreen(true);
        area.classList.add("video-full");
        // The sidebar and details panel sit above the viewer; they step aside.
        document.body.classList.add("video-full");
        full.textContent = "Exit full screen";
      });
      full.classList.add("video-fullscreen");
      area.append(full);
    }
    if (item.media !== "video") {
      const art = el("div", "", "audio-preview-art");
      art.append(el("span", item.title, "cover-title"));
      area.append(art);
      attachThumbnail(art, item);
    }
    media.preload = "metadata";
    media.src = url;
    media.addEventListener("error", () =>
      toast("This media format needs an external player."),
    );
    area.append(media);
    if (item.media === "audio")
      void peaksFor(item).then((sound) => {
        if (sound && current === generation)
          media.before(scrubber(sound, media));
      });
  } else if (item.media === "web") {
    closeWeb = showSavedPage(area, item, toast);
  } else if (ext === "pmtiles") {
    const frame = el("iframe");
    // The viewer is an atlas: this map in focus, every other saved map around it.
    const maps = state.items
      .filter(
        (i) =>
          /\.pmtiles$/i.test(i.filename) &&
          !["missing", "ambiguous"].includes(i.fileState),
      )
      .slice(0, 60)
      .map((i) => ({ id: i.id, title: i.title }));
    frame.src = `map/index.html?item=${encodeURIComponent(item.id)}&maps=${encodeURIComponent(JSON.stringify(maps))}`;
    frame.title = "Map";
    area.append(frame);
  } else if (["pdf", "epub", "md", "txt"].includes(ext)) {
    const frame = el("iframe");
    frame.src = `reader/index.html?item=${encodeURIComponent(item.id)}&ext=${ext}`;
    frame.title = "Document reader";
    area.append(frame);
  } else if (item.media === "text") {
    const text = el("pre", "Loading…");
    area.append(text);
    try {
      const content = await window.obelisk.readText(item.id);
      if (current === generation) text.textContent = content;
    } catch (e) {
      if (current === generation) text.textContent = e.message;
    }
  } else {
    const fallback = el("div", "", "preview-icon");
    fallback.append(
      icon(item.type),
      el(
        "p",
        item.accessNote || "No built-in preview for this format.",
        "muted",
      ),
    );
    if (item.type !== "software")
      fallback.append(
        action("Open in default app", () =>
          window.obelisk.openExternal(item.id),
        ),
      );
    area.append(fallback);
  }
}
