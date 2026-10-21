import path from "node:path";
import os from "node:os";
import { existsSync } from "node:fs";

/**
 * The sync service a folder is inside (iCloud Drive, Dropbox, …), or null. Synced
 * folders can change files while the library is open and copy them between computers
 * at the same time, which a library isn't built for.
 */
export function cloudService(folder, { home = os.homedir(), env = process.env, exists = existsSync } = {}) {
  const at = path.resolve(folder),
    under = (dir) => !!dir && (at === dir || at.startsWith(dir + path.sep)),
    icloud = path.join(home, "Library", "Mobile Documents");
  if (under(icloud)) return "iCloud Drive";
  // With "Desktop & Documents Folders" turned on, those two sync to iCloud as well.
  for (const name of ["Desktop", "Documents"])
    if (under(path.join(home, name)) && exists(path.join(icloud, "com~apple~CloudDocs", name))) return "iCloud Drive";
  const storage = path.join(home, "Library", "CloudStorage");
  if (under(storage)) {
    const provider = path.relative(storage, at).split(path.sep)[0];
    return PROVIDERS.find(([prefix]) => provider.startsWith(prefix))?.[1] || "a cloud drive";
  }
  for (const dir of [env.OneDrive, env.OneDriveConsumer, env.OneDriveCommercial]) if (under(dir)) return "OneDrive";
  for (const [name, service] of [["Dropbox", "Dropbox"], ["Google Drive", "Google Drive"], ["iCloudDrive", "iCloud Drive"], ["OneDrive", "OneDrive"], ["Box", "Box"]])
    if (under(path.join(home, name))) return service;
  return null;
}
const PROVIDERS = [["Dropbox", "Dropbox"], ["GoogleDrive", "Google Drive"], ["OneDrive", "OneDrive"], ["Box", "Box"], ["pCloud", "pCloud"]];
