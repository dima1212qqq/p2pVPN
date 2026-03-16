const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("desktopUi", {
  pickFile: () => ipcRenderer.invoke("dialog:pick-file"),
  connect: (options) => ipcRenderer.invoke("agent:connect", options),
  disconnect: () => ipcRenderer.invoke("agent:disconnect"),
  onAgentEvent: (listener) => {
    const wrapped = (_event, payload) => listener(payload);
    ipcRenderer.on("agent:event", wrapped);
    return () => ipcRenderer.off("agent:event", wrapped);
  }
});
