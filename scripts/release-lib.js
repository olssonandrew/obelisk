/** What packaging, the release command and the release workflow agree on. */
import { execFileSync } from "node:child_process";

/**
 * Release files must be built from a commit, so the binaries and the source published
 * beside them are the same code. Refuses changed or new files that git would keep.
 */
export function assertCommitted(root) {
  const changed = execFileSync("git", ["status", "--porcelain"], { cwd: root, encoding: "utf8" }).trim();
  if (changed) throw new Error(`Commit these first, so the release matches its source:\n${changed}`);
}

// The download for each system, named as in the README's table.
export function assetName(platform, arch) {
  const system = { darwin: 'mac', win32: 'windows', linux: 'linux' }[platform];
  if (!system || !['arm64', 'x64'].includes(arch)) throw new Error(`No release build for ${platform} ${arch}.`);
  return `Obelisk-${system}-${arch}.zip`;
}

export const sourceAssetName = (version) => `Obelisk-${version}-source.tar`;

const SEMVER = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/;

export function parseVersion(value) {
  const match = SEMVER.exec(String(value).replace(/^v/, ''));
  if (!match) throw new Error(`“${value}” isn’t a version like 0.1.0 or 0.2.0-beta.1.`);
  return { text: match[0], parts: match.slice(1, 4).map(Number), pre: match[4] || '' };
}

/** Whether `next` may follow `current`: newer, or the same while it has no tag yet. */
export function compareVersions(a, b) {
  const x = parseVersion(a), y = parseVersion(b);
  for (let i = 0; i < 3; i++) if (x.parts[i] !== y.parts[i]) return x.parts[i] - y.parts[i];
  if (x.pre === y.pre) return 0;
  if (!x.pre) return 1;
  if (!y.pre) return -1;
  return x.pre.localeCompare(y.pre, 'en', { numeric: true });
}

/** The section of CHANGELOG.md headed `## <version>`, without its heading. */
export function changelogSection(changelog, version) {
  const lines = changelog.split(/\r?\n/), heading = new RegExp(`^## \\[?v?${version.replace(/\./g, '\\.')}\\]?(\\s|$)`);
  const start = lines.findIndex((line) => heading.test(line));
  if (start < 0) return '';
  const end = lines.findIndex((line, i) => i > start && /^## /.test(line));
  return lines.slice(start + 1, end < 0 ? undefined : end).join('\n').trim();
}

/** Release notes: the changelog section, then where the source is. */
export function releaseNotes(changelog, version) {
  const section = changelogSection(changelog, version);
  if (!section) throw new Error(`CHANGELOG.md has no notes under “## ${version}”.`);
  return `${section}

---

The Mac builds are signed and notarized by Apple. The Windows and Linux builds aren't signed yet; the README says how to open them the first time.

These builds include the OpenZIM Wikipedia reader and are distributed under GPL-3.0-or-later. The complete corresponding source, Obelisk's and the reader's with every library it's built from, is \`${sourceAssetName(version)}\` below.
`;
}
