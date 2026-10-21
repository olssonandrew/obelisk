const { contextBridge, ipcRenderer } = require("electron");
// Toolbar of the saved-page window only. The saved page itself gets no bridge at all.
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
  contextBridge.exposeInMainWorld("savedPage", {
    command: (name) => invoke("saved:command", name),
    onState: (callback) =>
      ipcRenderer.on("saved:state", (event, state) => callback(state)),
  });
