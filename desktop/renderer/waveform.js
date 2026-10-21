import { fileURL } from "./bridge.js";

const BARS = 80,
  known = new Map();
const rms = (samples, from = 0, to = samples.length) => {
  let sum = 0;
  for (let i = from; i < to; i++) sum += samples[i] * samples[i];
  return to > from ? Math.sqrt(sum / (to - from)) : 0;
};
const scaled = (levels) => {
  const max = Math.max(...levels, 0.00001);
  return levels.map((level) => Math.round((level / max) * 100) / 100);
};
const duration = (url) =>
  new Promise((resolve, reject) => {
    const audio = document.createElement("audio"),
      done = (fn, value) => {
        clearTimeout(timer);
        audio.removeAttribute("src");
        audio.load();
        fn(value);
      },
      timer = setTimeout(() => done(reject, new Error("No duration")), 4000);
    audio.preload = "metadata";
    audio.onloadedmetadata = () => done(resolve, audio.duration);
    audio.onerror = () => done(reject, new Error("No audio"));
    audio.src = url;
  });
/**
 * Used when the bundled decoder is not set up. Short files are decoded whole;
 * long MP3s are sampled by reading a small slice at each of 80 points, which
 * works because MP3 frames can be decoded from the middle of a file.
 */
async function listen(item) {
  const url = fileURL(item),
    context = new OfflineAudioContext(1, 1, 8000);
  if (item.bytes <= 8 * 1024 ** 2) {
    const buffer = await context.decodeAudioData(
        await (await fetch(url)).arrayBuffer(),
      ),
      samples = buffer.getChannelData(0),
      per = Math.max(1, Math.floor(samples.length / BARS));
    return {
      peaks: scaled(
        Array.from({ length: BARS }, (_, i) => rms(samples, i * per, (i + 1) * per)),
      ),
      seconds: buffer.duration,
    };
  }
  if (!/\.mp3$/i.test(item.filename)) return null;
  const seconds = await duration(url),
    slice = 24 * 1024,
    levels = [];
  for (let i = 0; i < BARS; i++) {
    const start = Math.floor(((i + 0.5) / BARS) * item.bytes - slice / 2);
    try {
      const response = await fetch(url, {
        headers: { Range: `bytes=${start}-${start + slice - 1}` },
      });
      const buffer = await context.decodeAudioData(await response.arrayBuffer());
      levels.push(rms(buffer.getChannelData(0)));
    } catch {
      levels.push(null);
    }
  }
  if (levels.filter((level) => level !== null).length < BARS / 2) return null;
  return {
    peaks: scaled(levels.map((level, i) => level ?? levels[i - 1] ?? 0)),
    seconds,
  };
}
/** Loudness at 80 evenly spaced points. Worked out once per file, then remembered. */
export function peaksFor(item) {
  const key = `${item.id}:${item.sha256}`;
  if (!known.has(key)) {
    if (known.size >= 400) known.delete(known.keys().next().value);
    known.set(
      key,
      (async () => {
        let result = await window.obelisk.waveform(item.id).catch(() => null);
        if (!result && !["missing", "modified", "ambiguous"].includes(item.fileState)) {
          result = await listen(item).catch(() => null);
          if (result)
            result = await window.obelisk
              .saveWaveform(item.id, result)
              .catch(() => result);
        }
        if (!result) known.delete(key);
        return result;
      })(),
    );
  }
  return known.get(key);
}
/** One path, coloured by CSS, so it follows the theme and stays sharp at any size. */
export function drawWave(peaks) {
  const ns = "http://www.w3.org/2000/svg",
    svg = document.createElementNS(ns, "svg"),
    path = document.createElementNS(ns, "path");
  svg.setAttribute("viewBox", `0 0 ${peaks.length * 4} 100`);
  svg.setAttribute("preserveAspectRatio", "none");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("class", "wave");
  path.setAttribute(
    "d",
    peaks
      .map((peak, i) => {
        const height = Math.max(3, Math.sqrt(peak) * 92);
        return `M${i * 4 + 0.9} ${50 - height / 2}h2.2v${height}h-2.2z`;
      })
      .join(""),
  );
  svg.append(path);
  return svg;
}
export const clock = (seconds) => {
  const s = Math.max(0, Math.floor(seconds || 0)),
    h = Math.floor(s / 3600),
    m = Math.floor((s % 3600) / 60);
  return `${h ? h + ":" + String(m).padStart(2, "0") : m}:${String(s % 60).padStart(2, "0")}`;
};
