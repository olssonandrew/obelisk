import { el, size } from "./bridge.js";
const $ = (s) => document.querySelector(s);
const os = {
  darwin: "macOS",
  win32: "Windows",
  linux: "Linux",
  unknown: "Unknown OS",
};
const button = (label, fn) => {
  const b = el("button", label, "secondary");
  b.onclick = async () => {
    b.disabled = true;
    try {
      await fn();
    } finally {
      b.disabled = false;
    }
  };
  return b;
};
export function renderSoftware(state, desktop, toast, refresh, withBusy) {
  const platform = $("#software-platform").value,
    arch = $("#software-arch").value;
  $("#software-current").textContent =
    `This computer: ${os[state.platform]} · ${state.arch}`;
  const invoke = (fn) => async () => {
    try {
      await fn();
      await refresh();
    } catch (e) {
      toast(e.message);
    }
  };
  const host = $("#software-presets");
  host.replaceChildren();
  for (const app of state.softwareCatalog || []) {
    const card = el("article", "", "panel");
    card.append(
      el("h2", app.title),
      el("p", app.description),
      el("p", app.needs, "muted"),
    );
    const pkg = app.packages.find(
      (p) =>
        p.platform === platform && (p.arch === arch || p.arch === "universal"),
    );
    if (pkg)
      card.append(
        button(
          `Save ${os[platform]} package`,
          invoke(async () => {
            await desktop.downloadSoftware(app.id, platform, arch);
            toast("Added to transfers.");
          }),
        ),
      );
    else
      card.append(
        el(
          "p",
          app.id === "lmstudio"
            ? "Get the full installer from the publisher, then add it here."
            : "No preset package for this processor.",
          "muted",
        ),
      );
    card.append(
      button(
        "Publisher website",
        invoke(() => desktop.openWebsite(app.website)),
      ),
    );
    host.append(card);
  }
  const self = el("article", "", "panel software-self");
  const savedSelf = state.items.find(i => i.source?.adapter === "self-backup" && i.source.version === state.appVersion && i.software?.platform === state.platform && i.software?.arch === state.arch && !["missing", "ambiguous"].includes(i.fileState) && i.integrity !== "changed");
  self.append(
    el("h2", "Obelisk"),
    el("p", savedSelf ? "Included with your archive automatically." : "Obelisk keeps a copy of itself here when you use the packaged app."),
    el(
      "p",
      `This build is for ${os[state.platform]} · ${state.arch}. It includes the readers, not the files in your archive. Unpack before opening on another compatible computer.`,
      "muted",
    ),
    button(
      savedSelf ? "Save a fresh app copy" : "Save this app to archive",
      invoke(async () => {
        toast("Creating app copy…");
        await withBusy(() => desktop.saveAppCopy());
        toast("Obelisk saved in Software.");
      }),
    ),
  );
  if (state.appCopyError) self.append(el("p", `App backup needs attention: ${state.appCopyError}`, "error"));
  if (savedSelf) self.append(button("Show Obelisk backup", invoke(() => desktop.reveal(savedSelf.id))));
  host.prepend(self);
}
export function renderReport(report, desktop, toast, refresh, addUntracked) {
  const host = $("#archive-report");
  host.replaceChildren();
  // The summary above already says when nothing has been checked.
  host.hidden = !report;
  if (!report) {
    return;
  }
  host.append(
    el(
      "h2",
      report.changes.length
        ? `${report.changes.length} changes found`
        : "Tracked files are unchanged",
    ),
    el("p", `Checked ${new Date(report.checkedAt).toLocaleString()}`, "muted"),
  );
  for (const change of report.changes) {
    const row = el("div", "", "asset-row");
    row.append(
      el(
        "span",
        `${change.title} — ${change.status}${change.status === "moved" ? " (relinked)" : ""}`,
      ),
    );
    if (change.status === "modified")
      row.append(
        button("Accept current file", async () => {
          try {
            await desktop.acceptChange(change.id);
            row.replaceChildren(
              el(
                "span",
                `${change.title} — current file accepted; previous checksum retained`,
              ),
            );
            await refresh();
          } catch (e) {
            toast(e.message);
          }
        }),
      );
    host.append(row);
  }
  if (report.errors.length)
    host.append(
      el("p", `${report.errors.length} unreadable manifests were skipped.`),
    );
}
