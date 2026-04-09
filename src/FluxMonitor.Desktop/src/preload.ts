import { contextBridge } from "electron";

contextBridge.exposeInMainWorld("fluxMonitorDesktop", {
    isDesktop: true,
    platform: process.platform
});
