import { contextBridge, ipcRenderer } from "electron";

const savedTheme = ipcRenderer.sendSync("theme:get-sync") as unknown;

contextBridge.exposeInMainWorld("fluxMonitorDesktop", {
    isDesktop: true,
    platform: process.platform,
    savedTheme,
    saveThemeConfig: (snapshot: unknown) => void ipcRenderer.invoke("theme:save", snapshot)
});
