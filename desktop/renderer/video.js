import { el } from "./bridge.js";
export function initVideo(desktop, toast, onQueued, show) {
  const form = document.querySelector("#video-form"),
    url = form.elements.url,
    setup = document.querySelector("#video-setup"),
    check = document.querySelector("#video-check"),
    save = document.querySelector("#video-save"),
    result = document.querySelector("#video-result");
  let checked = null,
    working = false;
  async function status() {
    const state = await desktop.videoStatus();
    setup.hidden = state.ready;
    check.disabled = !state.ready || working;
    setup.textContent = state.installing
      ? "Setting up…"
      : "Set up video downloader";
    setup.disabled = state.installing;
  }
  const perform = async (fn) => {
    if (working) return;
    working = true;
    setup.disabled = check.disabled = save.disabled = true;
    url.disabled = true;
    try {
      await fn();
    } catch (e) {
      result.textContent = e.message;
    } finally {
      working = false;
      url.disabled = false;
      save.disabled = !checked;
      await status();
    }
  };
  setup.onclick = () =>
    perform(async () => {
      result.textContent =
        "Downloading yt-dlp from its official release and checking its checksum…";
      await desktop.setupVideo();
      result.textContent = "Ready. Paste a video link to begin.";
    });
  url.oninput = () => {
    checked = null;
    save.disabled = true;
    result.replaceChildren();
  };
  form.onsubmit = (e) => {
    e.preventDefault();
    void perform(async () => {
      checked = null;
      result.textContent = "Checking video…";
      checked = await desktop.inspectVideo(url.value);
      result.replaceChildren(
        el("h3", checked.title),
        el(
          "p",
          [
            checked.creator,
            checked.duration
              ? `${Math.round(checked.duration / 60)} min`
              : null,
          ]
            .filter(Boolean)
            .join(" · "),
        ),
      );
    });
  };
  save.onclick = () =>
    perform(async () => {
      if (!checked) return;
      await desktop.downloadVideo({
        key: checked.key,
        quality: form.elements.quality.value,
      });
      form.reset();
      result.replaceChildren();
      checked = null;
      toast("Video added to transfers.");
      await onQueued();
    });
  // The form lives on Add content → Video; opening it means going there.
  return async () => {
    show();
    try {
      await status();
    } catch (e) {
      result.textContent = e.message;
    }
  };
}
