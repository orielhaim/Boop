import { defineConfig } from "cf/config";

export default defineConfig({
  accountId: "01cf4de37f8c8211c959157280096bac",
  worker: {
    name: "boop",
    compatibilityDate: "2026-11-19",
    domains: ["boop.orielhaim.com"],
    workersDev: false,
    previewUrls: false,
    assets: {
      htmlHandling: "drop-trailing-slash",
      notFoundHandling: "404-page",
    },
  },
});
