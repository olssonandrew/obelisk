import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import path from "node:path";

export const BARS = 80;
const RATE = 8000,
  WINDOW = 0.25,
  PER = RATE * WINDOW;

function run(executable, args, limit) {
  return new Promise((resolve) => {
    const child = spawn(executable, args, {
      windowsHide: true,
      stdio: ["ignore", "pipe", "ignore"],
    });
    const chunks = [];
    let length = 0,
      finished = false;
    const finish = (result) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(null);
    }, 20000);
    child.on("error", () => finish(null));
    child.stdout.on("data", (chunk) => {
      length += chunk.length;
      if (length > limit) {
        child.kill("SIGKILL");
        finish(null);
      } else chunks.push(chunk);
    });
    child.on("close", (code) =>
      finish(code || !length ? null : Buffer.concat(chunks)),
    );
  });
}
/** Loudness (RMS) of each of `BARS` equal slices, scaled so the loudest is 1. */
export function loudness(samples, bars = BARS) {
  const count = Math.floor(samples.length / 4),
    per = Math.max(1, Math.floor(count / bars)),
    levels = [];
  for (let bar = 0; bar < bars; bar++) {
    let sum = 0,
      used = 0;
    for (let i = bar * per; i < Math.min(count, (bar + 1) * per); i++) {
      const value = samples.readFloatLE(i * 4);
      if (Number.isFinite(value)) {
        sum += value * value;
        used++;
      }
    }
    levels.push(used ? Math.sqrt(sum / used) : 0);
  }
  const max = Math.max(...levels, 0.00001);
  return levels.map((level) => Math.round((level / max) * 100) / 100);
}
/**
 * Listens to a quarter second at 80 evenly spaced points instead of decoding the
 * whole file, so a three-hour recording costs about the same as a three-minute one.
 */
export async function audioPeaks(filename, tools) {
  const exe = (name) =>
    path.join(tools, process.platform === "win32" ? `${name}.exe` : name);
  try {
    await access(exe("ffmpeg"));
    await access(exe("ffprobe"));
  } catch {
    return null;
  }
  const probed = await run(
    exe("ffprobe"),
    ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", filename],
    200,
  );
  const seconds = Number(probed?.toString().trim());
  if (!(seconds > 0)) return null;
  const common = ["-v", "error", "-nostdin", "-protocol_whitelist", "file,pipe"],
    format = `aresample=${RATE},aformat=sample_fmts=flt:channel_layouts=mono`;
  let args;
  if (seconds <= BARS * WINDOW * 3)
    args = [...common, "-i", filename, "-vn", "-af", format, "-f", "f32le", "pipe:1"];
  else {
    args = [...common];
    const graph = [];
    for (let i = 0; i < BARS; i++) {
      const at = ((i + 0.5) / BARS) * seconds - WINDOW / 2;
      args.push("-ss", at.toFixed(3), "-t", String(WINDOW), "-i", filename);
      graph.push(
        `[${i}:a:0]${format},apad=whole_len=${PER},atrim=end_sample=${PER}[a${i}]`,
      );
    }
    graph.push(
      `${graph.map((_, i) => `[a${i}]`).join("")}concat=n=${BARS}:v=0:a=1[out]`,
    );
    args.push("-filter_complex", graph.join(";"), "-map", "[out]", "-f", "f32le", "pipe:1");
  }
  const samples = await run(exe("ffmpeg"), args, 4_000_000);
  return samples ? { peaks: loudness(samples), seconds } : null;
}
