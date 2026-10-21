export const softwareCatalog = [
  {
    id: "kiwix",
    title: "Kiwix",
    description: "Read saved Wikipedia and other ZIM files.",
    website:
      "https://get.kiwix.org/en/solutions/applications/download-options/",
    needs:
      "Requires ZIM content. Full package; test on the target computer before going offline.",
    packages: [
      {
        platform: "darwin",
        arch: "universal",
        url: "https://download.kiwix.org/release/kiwix-macos/kiwix-macos.dmg",
        filename: "Kiwix-macOS-universal.dmg",
      },
      {
        platform: "win32",
        arch: "x64",
        url: "https://download.kiwix.org/release/kiwix-desktop/kiwix-desktop_windows_x64.zip",
        filename: "Kiwix-Windows-x64.zip",
      },
      {
        platform: "linux",
        arch: "x64",
        url: "https://download.kiwix.org/release/kiwix-desktop/kiwix-desktop_x86_64.appimage",
        filename: "Kiwix-Linux-x64.AppImage",
      },
    ],
  },
  {
    id: "lmstudio",
    title: "LM Studio",
    description: "Run language models on your computer.",
    website: "https://lmstudio.ai/download",
    needs:
      "Installer alone is not a complete backup. Save model weights and required inference runtimes, then test with networking disabled.",
    packages: [],
  },
];
export function softwarePlan(id, platform, arch) {
  const app = softwareCatalog.find((p) => p.id === id),
    pkg = app?.packages.find(
      (p) =>
        p.platform === platform && (p.arch === arch || p.arch === "universal"),
    );
  if (!pkg)
    throw new Error(
      "No preset package for that platform. Use the publisher website and import the complete installer.",
    );
  return {
    ...pkg,
    title: `${app.title} · ${platform} ${pkg.arch}`,
    type: "software",
    kind: "installer",
    software: {
      platform,
      arch: pkg.arch,
      offlineTested: false,
      needs: app.needs,
    },
    source: {
      adapter: "software",
      provider: app.title,
      url: pkg.url,
      seriesKey: `software:${id}:${platform}:${pkg.arch}`,
      version: new Date().toISOString().slice(0, 10),
    },
    rights:
      "Publisher license applies. Downloaded from the official distribution endpoint.",
  };
}
