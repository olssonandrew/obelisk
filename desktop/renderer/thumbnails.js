import { fileURL, el, bumpCover } from "./bridge.js";
import { peaksFor, drawWave, clock } from "./waveform.js";
const cache = new Map(), jobs = [], observed = new Map();
let running = 0, renderer, sweeping = false;
const key = item => `${item.id}:${item.sha256}`;
export function forgetThumbnail(id) { bumpCover(id); for (const k of cache.keys()) if (k.startsWith(id + ":")) cache.delete(k); }
function paint(cover, data) {
  if (!data || !cover.isConnected) return;
  if (data.peaks) {
    const sound = el("div", "", "cover-wave");
    sound.append(drawWave(data.peaks), el("span", clock(data.seconds)));
    cover.replaceChildren(sound);
    return;
  }
  const image = el("img"); image.alt = ""; image.src = data;
  image.onload = () => cover.replaceChildren(image);
}
// A map's picture is drawn by the map viewer itself, in a frame nobody sees, one at a time.
let drawingMap = Promise.resolve();
function mapPicture(item) {
  const draw = () => new Promise((resolve) => {
    const frame = el("iframe", "", "map-thumbnail-frame");
    const done = (image) => {
      clearTimeout(timer);
      removeEventListener("message", listen);
      frame.remove();
      resolve(image);
    };
    const listen = (event) => {
      if (event.source === frame.contentWindow && event.data?.type === "map:thumbnail" && event.data.id === item.id) done(event.data.image);
    };
    const timer = setTimeout(() => done(null), 20000);
    addEventListener("message", listen);
    frame.setAttribute("aria-hidden", "true");
    frame.tabIndex = -1;
    frame.src = `map/index.html?item=${encodeURIComponent(item.id)}&maps=${encodeURIComponent(JSON.stringify([{ id: item.id, title: item.title }]))}`;
    document.body.append(frame);
  });
  return (drawingMap = drawingMap.then(draw, draw));
}
async function pump() {
  if (running >= 2 || !jobs.length) return;
  const {cover,item} = jobs.shift();
  if (!cover.isConnected) { void pump(); return; }
  running++;
  try {
    let data = cache.get(key(item));
    if (data === undefined) {
      data = await window.obelisk.thumbnail(item.id);
      if (!data && !["missing", "modified", "ambiguous"].includes(item.fileState)) {
        if (/\.pmtiles$/i.test(item.filename)) {
          data = await mapPicture(item);
          if (data) data = await window.obelisk.saveThumbnail(item.id, data);
        } else if (item.media === "web") {
          // The picture taken when the page was saved travels inside its file.
          data = await window.obelisk.savedPageThumbnail(item.id);
          if (data) data = await window.obelisk.saveThumbnail(item.id, data);
        } else {
        renderer ||= import("./reader/vendor/thumbnails.js");
        data = await (await renderer).renderThumbnail(item, fileURL(item));
        if (data) data = await window.obelisk.saveThumbnail(item.id, data);
        }
      }
      if (!data && item.media === "audio") data = await peaksFor(item);
      if (cache.size >= 200) cache.delete(cache.keys().next().value);
      cache.set(key(item), data || null);
    }
    paint(cover,data);
  } catch { cache.set(key(item), null); }
  finally { running--; void pump(); }
}
const observer = new IntersectionObserver(entries => {
  for (const entry of entries) if (entry.isIntersecting) {
    const item = observed.get(entry.target); observed.delete(entry.target); observer.unobserve(entry.target);
    if (item) jobs.push({cover:entry.target,item});
  }
  void pump(); void pump();
}, {rootMargin:"150px"});
export function attachThumbnail(cover,item) {
  // Drop covers that left the page. Cards are built in batches before they are
  // placed, so this waits until the batch is in.
  if (!sweeping) { sweeping = true; setTimeout(() => { sweeping = false; for (const node of observed.keys()) if (!node.isConnected) { observer.unobserve(node); observed.delete(node); } }); }
  if (["pdf","epub","audio"].includes(item.media)) cover.replaceChildren(el("span",item.title,"cover-title"));
  // A Wikipedia edition shows its subject, e.g. "Chemistry".
  if (item.media === "zim") cover.replaceChildren(el("span",item.title.split(" · ")[0].replace(/ by Wikipedia$/, ""),"cover-title"));
  if (cache.has(key(item))) { queueMicrotask(() => paint(cover,cache.get(key(item)))); return; }
  observed.set(cover,item); observer.observe(cover);
}
