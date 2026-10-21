import {el, size} from "./bridge.js";
import {icon} from "./icons.js";

/*
 * First-run setup and the guide. Setup walks through four pages: what Obelisk is,
 * where the library lives, how it works, and a first thing to save. The guide (from
 * the help button) is the "how it works" page on its own.
 */
const STEPS = ["welcome", "place", "tour", "first"];
const CONTINUE = "onboardingContinue";
const SAMPLE = "en.wikipedia.org/wiki/Library_of_Obelisk";

export function createOnboarding({
  desktop,
  toast,
  refresh,
  openImport,
  chooseFiles,
  showShortcuts,
}) {
  const host = document.querySelector("#onboarding");
  let step = "welcome",
    guide = false,
    drives = null,
    // Which drive is selected, and the folder on it the library goes in (the drive
    // itself unless another location was chosen).
    chosen = null,
    folder = null,
    missing = null,
    // Opened from "Switch library" rather than first-run setup.
    switching = false,
    name = "Obelisk";
  const problem = el("p", "", "onboarding-error");
  problem.setAttribute("role", "alert");

  const button = (label, fn, cls = "secondary") => {
    const b = el("button", label, cls);
    b.type = "button";
    b.onclick = () =>
      Promise.resolve()
        .then(fn)
        .catch((e) => toast(e.message));
    return b;
  };
  const card = (glyph, title, text) => {
    const box = el("div", "", "guide-card");
    box.append(icon(glyph), el("h3", title), el("p", text));
    return box;
  };
  function frame(body, actions) {
    const panel = el("div", "", "onboarding-panel"),
      top = el("div", "", "onboarding-top"),
      foot = el("div", "", "onboarding-foot");
    if (!guide) {
      const dots = el("div", "", "onboarding-dots");
      for (const each of STEPS)
        dots.append(
          el(
            "i",
            "",
            each === step
              ? "on"
              : STEPS.indexOf(each) < STEPS.indexOf(step)
                ? "done"
                : "",
          ),
        );
      top.append(dots);
    }
    foot.append(...actions);
    panel.append(top, el("div", "", "onboarding-body"), foot);
    panel.querySelector(".onboarding-body").append(...body);
    host.replaceChildren(panel);
    panel.querySelector(".onboarding-foot .primary")?.focus();
  }
  const go = (next) => {
    step = next;
    render();
  };

  function welcome() {
    const logo = el("img", "", "onboarding-logo");
    logo.src = "favicon.svg";
    logo.alt = "";
    const pillars = el("div", "", "guide-grid three");
    pillars.append(
      card(
        "import",
        "Save",
        "Download web pages, Wikipedia, maps, videos and podcasts, or add files from this computer.",
      ),
      card(
        "grid",
        "Organize",
        "Files are sorted by type. Add tags, ratings, dates and notes, and search everything.",
      ),
      card(
        "shield",
        "Keep",
        "Everything is stored as ordinary files in one folder you own. It works without the internet.",
      ),
    );
    frame(
      [
        logo,
        el("h1", "Welcome to Obelisk"),
        el(
          "p",
          "A library you keep: the things you want to hold on to, saved to your own drive and readable offline.",
          "onboarding-lede",
        ),
        pillars,
      ],
      [
        el("span", "", "spacer"),
        button("Set up my library", () => go("place"), "primary big"),
      ],
    );
  }

  async function place() {
    frame(
      [
        el("h1", "Where should your library live?"),
        el("p", "Finding drives…", "muted"),
      ],
      [],
    );
    try {
      drives = await desktop.setupDrives();
    } catch (e) {
      drives = [];
      toast(e.message);
    }
    if (step !== "place") return;
    // An external drive with the most room is the usual home for a large library.
    if (!drives.some((d) => d.path === chosen)) {
      chosen =
        (
          drives.find((d) => d.existing) ||
          [...drives].sort(
            (a, b) => b.external - a.external || b.free - a.free,
          )[0]
        )?.path || null;
      folder = chosen;
    }
    const list = el("div", "", "drive-list");
    for (const drive of drives) {
      const row = el("label", "", "drive"),
        pick = el("input");
      pick.type = "radio";
      pick.name = "drive";
      pick.checked = drive.path === chosen;
      pick.onchange = () => {
        chosen = folder = drive.path;
        update();
      };
      const bar = el("span", "", "drive-bar"),
        fill = el("i");
      fill.style.width = `${Math.min(100, ((drive.total - drive.free) / drive.total) * 100)}%`;
      bar.append(fill);
      const text = el("span", "", "drive-text");
      text.append(
        el("strong", drive.name),
        el("small", `${size(drive.free)} free of ${size(drive.total)}`),
        bar,
      );
      row.append(pick, icon(drive.external ? "archive" : "monitor"), text);
      if (drive.existing)
        row.append(el("span", "Library found", "drive-found"));
      list.append(row);
    }
    const field = el("input");
    field.value = name;
    field.setAttribute("aria-label", "Folder name");
    field.oninput = () => {
      name = field.value;
      update();
    };
    const naming = el("label", "", "onboarding-name");
    naming.append(el("span", "Folder name"), field);
    const where = el("div", "", "onboarding-where"),
      path_ = el("span", "", "onboarding-path selectable");
    where.append(
      path_,
      button(
        "Change…",
        async () => {
          const picked = await desktop.setupPick("create");
          if (!picked) return;
          // A folder that is already a library opens as it is.
          if (picked.existing) return open(picked.path);
          // The drive it is on stays selected; only the folder changes.
          const on = [...drives]
            .sort((a, b) => b.path.length - a.path.length)
            .find(
              (d) =>
                d.external &&
                (picked.path + "/").startsWith(d.path.replace(/\/$/, "") + "/"),
            );
          chosen = (
            on ||
            drives.find((d) => !d.external) || {path: picked.path}
          ).path;
          folder = picked.path;
          place();
        },
        "text-button",
      ),
    );
    problem.textContent = "";
    const cloud = el("p", "", "onboarding-warning");
    if (folder)
      desktop.setupCloud(folder).then(
        (service) => {
          cloud.textContent = service
            ? `This folder syncs with ${service}. It is not recommended to use Obelisk on a cloud folder that syncs with other devices.`
            : "";
        },
        () => {},
      );
    const go_ = button("Create library", () => create(target()), "primary");
    const target = () => {
      if (!folder) return null;
      return `${folder.replace(/[\\/]+$/, "")}${folder.includes("\\") ? "\\" : "/"}${name.trim()}`;
    };
    function update() {
      const path = target(),
        existing =
          folder === chosen &&
          drives.find((d) => d.path === chosen)?.existing &&
          name.trim() === "Obelisk";
      path_.textContent = path || "";
      problem.textContent = "";
      go_.textContent = existing ? "Open library" : "Create library";
      go_.disabled = !path || !name.trim() || /[\\/:*?"<>|]/.test(name);
    }
    update();
    frame(
      [
        el("h1", "Where should your library live?"),
        el(
          "p",
          "Everything you save goes into one folder. Pick a drive with room to grow; you can move the folder later.",
          "onboarding-lede",
        ),
        drives.length ? list : el("p", "No drives found.", "muted"),
        naming,
        where,
        cloud,
        problem,
        el(
          "p",
          "For scale: a book is a few MB, a city map about 100 MB, a country map a few GB, and English Wikipedia with images about 110 GB.",
          "onboarding-note",
        ),
      ],
      [
        switching
          ? button("Cancel", hide)
          : button("Back", () => go("welcome")),
        button("Open existing library", async () => {
          const picked = await desktop.setupPick("open");
          if (picked) await open(picked.path);
        }),
        el("span", "", "spacer"),
        go_,
      ],
    );
  }

  /** The library chosen earlier is not where it was. */
  function lost() {
    frame(
      [
        el("h1", "Your library isn’t there"),
        el(
          "p",
          "Obelisk can’t find the folder it was using. If it’s on an external drive, connect the drive and try again. If you moved it, locate it.",
          "onboarding-lede",
        ),
        el("p", missing, "onboarding-path selectable"),
        problem,
      ],
      [
        el("span", "", "spacer"),
        button("Create a new library", () => {
          guide = false;
          missing = null;
          go("place");
        }),
        button("Locate it…", async () => {
          const picked = await desktop.setupPick("open");
          if (picked) await open(picked.path);
        }),
        button(
          "Try again",
          async () => {
            await desktop.setupRetry();
            location.reload();
          },
          "primary",
        ),
      ],
    );
  }

  /** Makes the library (or opens the one already there), then carries on with setup. */
  function create(path) {
    return enter(() => desktop.setupCreate(path), !switching);
  }
  /** Opens a library someone already has. */
  function open(path) {
    return enter(() => desktop.setupOpen(path), !missing && !switching);
  }
  async function enter(action, carryOn) {
    host.classList.add("working");
    problem.textContent = "";
    try {
      await action();
      // The window reloads onto the library; setup carries on from here.
      try {
        if (carryOn) sessionStorage.setItem(CONTINUE, "tour");
      } catch {}
      location.reload();
    } catch (e) {
      // Shown where it happened when the page has room for it.
      if (problem.isConnected) problem.textContent = e.message;
      else toast(e.message);
    } finally {
      host.classList.remove("working");
    }
  }

  function tour() {
    const grid = el("div", "", "guide-grid");
    grid.append(
      card(
        "grid",
        "Shelves",
        "Files sort themselves by type: documents, audio, video, images, maps, reference and software.",
      ),
      card(
        "add",
        "Add content",
        "Copy in files from your computer, or save web pages, Wikipedia, maps, videos and podcasts.",
      ),
      card(
        "panel",
        "Details",
        "Select a file to tag, rate, describe or date it. Search covers all of it.",
      ),
      card(
        "eye",
        "Offline",
        "Pages, books, maps, Wikipedia and media open here with no connection.",
      ),
      card(
        "folder",
        "Plain folders",
        "Each file sits in its own folder with an item.json. Nothing is locked inside the app.",
      ),
      card(
        "shield",
        "Health check",
        "Click the library name for space used, file checks and files added outside the app.",
      ),
    );
    frame(
      [el("h1", "How Obelisk works"), grid],
      guide
        ? [
            button(
              "Keyboard shortcuts",
              () => {
                hide();
                showShortcuts();
              },
              "text-button",
            ),
            el("span", "", "spacer"),
            button("Done", hide, "primary"),
          ]
        : [
            el("span", "", "spacer"),
            button("Next", () => go("first"), "primary"),
          ],
    );
  }

  function first() {
    const tiles = el("div", "", "first-grid");
    // The one that finishes in seconds and shows the most: a saved web page.
    const page = el("div", "", "first-tile wide"),
      address = el("input"),
      status = el("p", "", "muted");
    address.value = SAMPLE;
    address.setAttribute("aria-label", "Web page address");
    const save = button(
      "Save page",
      async () => {
        save.disabled = true;
        await desktop.savePage({url: address.value.trim()});
        status.textContent = "Saving. It appears in your library in a moment.";
        save.textContent = "Saved";
        refresh();
      },
      "primary",
    );
    const row = el("div", "", "first-row");
    row.append(address, save);
    page.append(
      icon("browser"),
      el("h3", "Save a web page"),
      el(
        "p",
        "The complete page, kept as it looks today. Try this one, or paste any address.",
      ),
      row,
      status,
    );
    const tile = (glyph, title, text, label, fn) => {
      const box = el("div", "", "first-tile");
      box.append(
        icon(glyph),
        el("h3", title),
        el("p", text),
        button(label, fn),
      );
      return box;
    };
    tiles.append(
      page,
      tile(
        "map",
        "A map of your area",
        "Streets and place names for offline use.",
        "Choose an area",
        () => finish(() => openImport("maps")),
      ),
      tile(
        "encyclopedia",
        "Wikipedia",
        "All of it, or a smaller edition, readable offline.",
        "See editions",
        () => finish(() => openImport("wikipedia")),
      ),
      tile(
        "folder",
        "Your own files",
        "Photos, documents or whole folders from this computer.",
        "Choose files",
        () => finish(chooseFiles),
      ),
    );
    frame(
      [
        el("h1", "Save your first thing"),
        el(
          "p",
          "Saving runs in the background; progress shows under Transfers.",
          "onboarding-lede",
        ),
        tiles,
      ],
      [
        button("Back", () => go("tour")),
        el("span", "", "spacer"),
        button("Open my library", () => finish(), "primary"),
      ],
    );
  }

  async function finish(then) {
    await desktop.setupFinish();
    hide();
    await refresh();
    await then?.();
  }
  function hide() {
    host.hidden = true;
    document.body.classList.remove("onboarding");
  }
  function render() {
    host.hidden = false;
    document.body.classList.add("onboarding");
    ({welcome, place, tour, first, lost})[step]();
  }

  return {
    /** Shows setup on first launch, or carries on after the library was created. */
    start(state) {
      let resume = null;
      try {
        resume = sessionStorage.getItem(CONTINUE);
        sessionStorage.removeItem(CONTINUE);
      } catch {}
      missing = state.missingLibrary || null;
      if (missing) {
        guide = true; // no step dots: this is not setup
        go("lost");
      } else if (resume) {
        guide = false;
        go(resume);
      } else if (state.firstRun) {
        guide = false;
        go("welcome");
      }
    },
    /** Opens another library, or makes a new one, from the library settings. */
    switchLibrary() {
      guide = switching = true;
      missing = null;
      go("place");
    },
    /** How it works, on its own. */
    guide() {
      guide = true;
      go("tour");
    },
    get open() {
      return !host.hidden;
    },
    close: hide,
  };
}
