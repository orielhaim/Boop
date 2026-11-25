import type { Plugin } from "@/core/plugins/host";
import { matchTorrents, type TorrentEmbed } from "./magnets";

export const torrents = {
  descriptor: {
    id: "torrents",
    version: "1.0.0",
    contractVersion: 1,
    platforms: ["android"],
    deliveryModule: "torrents",
    settingsRoute: "/settings/plugins/torrents",
    downloadProvider: { id: "torrents", versions: [1] },
    capabilities: ["messageEmbed", "downloadTransport"],
  },
  content: { prefix: "magnet:?", match: matchTorrents },
} satisfies Plugin<TorrentEmbed>;
