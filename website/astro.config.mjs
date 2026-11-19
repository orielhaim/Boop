import { defineConfig } from "astro/config";
import fumadocs from "@fumadocs/astro";

export default defineConfig({
  site: "https://boop.orielhaim.com",
  output: "static",
  trailingSlash: "never",
  build: { format: "file" },
  integrations: [fumadocs()],
});
