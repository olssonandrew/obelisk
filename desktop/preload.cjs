const { contextBridge, ipcRenderer, webUtils } = require("electron");
// Only the trusted top-level application gets the narrow desktop bridge.
// Errors from the main process arrive wrapped in Electron's own wording; people
// should see only the sentence that was written for them.
const invoke = (...args) =>
  ipcRenderer.invoke(...args).catch((error) => {
    throw new Error(
      String(error?.message || error).replace(
        /^Error invoking remote method '[^']*': (?:[A-Za-z]*Error: )?/,
        "",
      ),
    );
  });
if (process.isMainFrame)
  contextBridge.exposeInMainWorld("obelisk", {
    onMenu: (callback) => {
      ipcRenderer.on("menu:import", () => callback("import"));
      ipcRenderer.on("menu:archive", () => callback("archive"));
      ipcRenderer.on("menu:import-folder", () => callback("import-folder"));
      ipcRenderer.on("menu:theme", (event, theme) => callback("theme", theme));
      ipcRenderer.on("menu:shortcuts", () => callback("shortcuts"));
    },
    videoFullscreen: (enabled) =>
      invoke("viewer:fullscreen", enabled),
    onVideoExit: (callback) => ipcRenderer.on("viewer:exit", callback),
    onLibraryChange: (callback) =>
      ipcRenderer.on("library:changed", () => callback()),
    videoStatus: () => invoke("video:status"),
    setupVideo: () => invoke("video:setup"),
    inspectVideo: (url) => invoke("video:inspect", url),
    downloadVideo: (input) => invoke("video:download", input),
    updateMetadata: (id, values) =>
      invoke("library:metadata", id, values),
    moveItems: (ids, folderId) => invoke("library:move", ids, folderId),
    createFolder: (parentId, name, icon) => invoke("folders:create", parentId, name, icon),
    renameFolder: (id, name) => invoke("folders:rename", id, name),
    setFolderIcon: (id, icon) => invoke("folders:icon", id, icon),
    moveFolder: (id, parentId) => invoke("folders:move", id, parentId),
    orderFolders: (parentId, ids) => invoke("folders:order", parentId, ids),
    removeFolder: (id, keep) => invoke("folders:remove", id, keep),
    setDestination: (key, id) => invoke("folders:destination", key, id),
    revealFolder: (id) => invoke("folders:reveal", id),
    trash: (ids) => invoke("library:trash", ids),
    renameTag: (from, to) => invoke("library:tag-rename", from, to),
    waveform: (id) => invoke("thumbnail:waveform", id),
    saveWaveform: (id, value) =>
      invoke("thumbnail:waveform-save", id, value),
    updateTags: (ids, tags, mode) =>
      invoke("library:tags", ids, tags, mode),
    thumbnail: (id) => invoke("thumbnail:get", id),
    saveThumbnail: (id, data) => invoke("thumbnail:save", id, data),
    chooseCover: (id) => invoke("thumbnail:choose", id),
    openZim: (id) => invoke("zim:open", id),
    closeZim: (token) => invoke("zim:close", token),
    state: (since) => invoke("library:state", since),
    setupDrives: () => invoke("setup:drives"),
    setupPick: (purpose) => invoke("setup:pick", purpose),
    setupCloud: (folder) => invoke("setup:cloud", folder),
    collections: () => invoke("collections:list"),
    saveCollection: (id, keys) => invoke("collections:save", id, keys ?? null),
    sawCollection: (id) => invoke("collections:seen", id),
    collectionTransfers: (id, action) => invoke("collections:group", id, action),
    setupCreate: (folder) => invoke("setup:create", folder),
    setupOpen: (folder) => invoke("setup:open", folder),
    setupFinish: () => invoke("setup:finish"),
    setupRetry: () => invoke("setup:retry"),
    importFiles: (options) => invoke("library:import", options),
    chooseImport: (options) => invoke("import:choose", options),
    prepareDrop: (files, options) =>
      invoke(
        "import:drop",
        files.map((file) => webUtils.getPathForFile(file)).filter(Boolean),
        options,
      ),
    commitImport: (token, entries) => invoke("import:commit", token, entries),
    reviewUntracked: () => invoke("import:untracked"),
    cancelImport: (token) => invoke("import:cancel", token),
    checkArchive: () => invoke("library:check"),
    acceptChange: (id) => invoke("library:accept", id),
    saveSoftwareNotes: (id, notes) =>
      invoke("software:notes", id, notes),
    downloadSoftware: (id, platform, arch) =>
      invoke("software:download", id, platform, arch),
    saveAppCopy: () => invoke("software:self"),
    importDropped: (files, options) =>
      invoke(
        "library:drop",
        files.map((file) => webUtils.getPathForFile(file)).filter(Boolean),
        options,
      ),
    reveal: (id) => invoke("library:reveal", id),
    openExternal: (id) => invoke("library:open", id),
    readText: (id) => invoke("library:text", id),
    source: (operation, input) =>
      invoke("source:call", operation, input),
    download: (input) => invoke("download:add", input),
    transfer: (id, action) => invoke("download:action", id, action),
    openWebsite: (url) => invoke("website:open", url),
    waybackCopy: (url, date) => invoke("web:wayback", url, date),
    waybackCopies: (url, span) =>
      invoke("web:wayback-series", url, span),
    savePage: (input) => invoke("web:save", input),
    openSavedPage: (id) => invoke("web:open", id),
    embedSavedPage: (id) => invoke("web:embed", id),
    placeSavedPage: (token, bounds) => invoke("web:place", token, bounds),
    savedPageCommand: (token, name) => invoke("web:command", token, name),
    closeSavedPage: (token) => invoke("web:close", token),
    onSavedPageState: (callback) =>
      ipcRenderer.on("saved:inline-state", (event, state) => callback(state)),
    onSavedPageEscape: (callback) =>
      ipcRenderer.on("saved:inline-escape", (event, token) => callback(token)),
    savedPageInfo: (id) => invoke("web:info", id),
    savedPageThumbnail: (id) => invoke("web:thumbnail", id),
  });
