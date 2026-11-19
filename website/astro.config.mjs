import { defineConfig } from "astro/config";
import fumadocs from "@fumadocs/astro";

import cloudflare from "@astrojs/cloudflare";

export default defineConfig({
  site: "https://boop.orielhaim.com",
  output: "static",
  trailingSlash: "never",
  build: { format: "file" },
  integrations: [fumadocs()],
  adapter: cloudflare(),
});
