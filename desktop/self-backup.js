import { spawn } from "node:child_process";
import { mkdir, stat, rm, realpath } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { importFile } from "../packages/core/archive.js";
export async function saveAppCopy(app, library, project) {
  if (library.busy())
    throw new Error("Wait for other archive operations to finish.");
  let source;
  if (process.platform === "darwin")
    source = app.isPackaged
      ? path.resolve(app.getPath("exe"), "../../..")
      : path.join(
          project,
          `dist/Obelisk-darwin-${process.arch}/Obelisk.app`,
        );
  else
    source = app.isPackaged
      ? path.dirname(app.getPath("exe"))
      : path.join(
          project,
          `dist/Obelisk-${process.platform}-${process.arch}`,
        );
  try {
    await stat(source);
  } catch {
    throw new Error("Package Obelisk first, then save its app copy.");
  }
  source = await realpath(source);
  // A packaged application only: never copy the development checkout or archive.
  if (
    !source.includes("Obelisk") ||
    source === project ||
    library.archiveRoot.startsWith(source + path.sep)
  )
    throw new Error("The app copy cannot contain your archive.");
  const directory = path.join(library.archiveRoot, ".obelisk", "exports");
  await mkdir(directory, { recursive: true });
  const ext = process.platform === "linux" ? "tar.gz" : "zip",
    temporaryPath = path.join(directory, randomUUID() + "." + ext);
  try {
    const executable =
      process.platform === "darwin"
        ? "/usr/bin/ditto"
        : process.platform === "win32"
          ? "powershell.exe"
          : "tar";
    const args =
      process.platform === "darwin"
        ? ["-c", "-k", "--sequesterRsrc", "--keepParent", source, temporaryPath]
        : process.platform === "win32"
          ? [
              "-NoProfile",
              "-NonInteractive",
              "-Command",
              "Compress-Archive -LiteralPath $env:OBELISK_COPY_SOURCE -DestinationPath $env:OBELISK_COPY_DESTINATION",
            ]
          : [
              "-czf",
              temporaryPath,
              "-C",
              path.dirname(source),
              path.basename(source),
            ];
    await new Promise((resolve, reject) => {
      const child = spawn(executable, args, {
        windowsHide: true,
        stdio: "ignore",
        env: {
          ...process.env,
          OBELISK_COPY_SOURCE: source,
          OBELISK_COPY_DESTINATION: temporaryPath,
        },
      });
      child.on("error", reject);
      child.on("close", (code) =>
        code === 0
          ? resolve()
          : reject(new Error("Could not create the app backup.")),
      );
    });
    return await importFile({
      catalog: library.catalog,
      archiveRoot: library.archiveRoot,
      temporaryPath,
      filename: `Obelisk-${app.getVersion()}-${process.platform}-${process.arch}.${ext}`,
      title: `Obelisk ${app.getVersion()} · ${process.platform} ${process.arch}`,
      type: "software",
      kind: "installer",
      software: {
        platform: process.platform,
        arch: process.arch,
        offlineTested: false,
        needs:
          "Complete desktop app. Unpack before running. This unsigned build may require OS approval. Optional source tools are platform-specific.",
      },
      source: {
        adapter: "self-backup",
        provider: "Obelisk",
        version: app.getVersion(),
      },
      rights: "GPL-3.0-or-later combined desktop distribution; Obelisk-authored code is MIT. See included licenses and docs/third-party.md.",
    });
  } finally {
    await rm(temporaryPath, { force: true });
  }
}
