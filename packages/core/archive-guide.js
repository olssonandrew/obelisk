import { writeFile } from "node:fs/promises";
import path from "node:path";
export async function writeArchiveGuide(root) {
  const text = `YOUR OBELISK ARCHIVE

These are ordinary files. You can copy this entire folder to another disk,
open its files in other applications, and keep using it without Obelisk.

Documents/   Books, papers, manuals, notes, and personal records
Audio/       Music, recordings, audiobooks, and podcast shows with their episodes
Video/       Films, talks, and clips
Images/      Photos, art, and scans
Maps/        Offline map files
Reference/   Offline encyclopedias (ZIM, read in Obelisk) and saved websites
Software/    Installers, readers you save, and AI model files
Other/       Data files, compressed archives, and anything unrecognized

Folders appear as you add content. Item folders use the title and an ID to
avoid name collisions. Inside each: the original file and item.json, which
records its source, date, checksum, and relative location. Keep item.json
with the file so Obelisk can rebuild its library. If you reorganize files
by hand, use Check archive in Obelisk to relink moved files and review edits.
Modified files retain the original checksum until you accept the current file.
Missing files are flagged, never silently deleted from the index. Checksums are
not versioned copies: keep a second backup to recover an earlier file.
Personal files are not encrypted by Obelisk. Use encrypted storage when needed.

.obelisk/ holds the app index, source cache, and incomplete downloads.
Completed downloads always go to this archive, not your Downloads folder.

READERS
Obelisk includes PDF, EPUB, Markdown, text, image, audio, and video viewers.
Support varies by encoding; protected EPUBs need a compatible external reader.
Read Wikipedia ZIM files inside Obelisk. An alternative reader is Kiwix: https://get.kiwix.org/
A ZIM is content, not an application. Save a suitable Kiwix installer in
Software/ before going offline. An installer still needs to be installed;
readers and AI runtimes must match the target computer's operating system.

OPENING THIS ARCHIVE ON ANOTHER COMPUTER
Obelisk keeps a copy of itself in Software/, in a folder named for its version
and the kind of computer that saved it. It works without internet. Unzip it and
open Obelisk, then open this folder. On a Mac, the first time, choose Open
Anyway in System Settings > Privacy & Security.
`;
  try {
    await writeFile(path.join(root, "ABOUT THIS ARCHIVE.txt"), text, {
      flag: "wx",
    });
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
  }
}
