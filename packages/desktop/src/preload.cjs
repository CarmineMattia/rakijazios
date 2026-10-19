const { contextBridge } = require("electron");

contextBridge.exposeInMainWorld("rakijaziosDesktop", {
  platform: process.platform,
  isDesktop: true,
  version: "0.1.0-parity",
});
