import type { Embed } from "@/core/plugins/host";

const base32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
const maxUriLength = 4096;

export type Magnet = {
  infoHash: string;
  uri: string;
};

export type TorrentEmbed = Embed<"torrent", Magnet>;

function btih(value: string) {
  if (/^[a-f0-9]{40}$/iu.test(value)) return value.toLowerCase();
  if (!/^[a-z2-7]{32}$/iu.test(value)) return;
  let hex = "";
  let bits = 0;
  let accumulator = 0;
  for (const character of value.toUpperCase()) {
    accumulator = (accumulator << 5) | base32.indexOf(character);
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      hex += ((accumulator >>> bits) & 255).toString(16).padStart(2, "0");
    }
  }
  return hex;
}

export function parseMagnet(uri: string): Magnet | undefined {
  if (
    uri.length > maxUriLength ||
    !/^magnet:\?/iu.test(uri) ||
    /[\s\\#<>]/u.test(uri)
  )
    return;
  let hash: string | undefined;
  const trackers = new Set<string>();
  for (const parameter of uri.slice(8).split("&")) {
    const delimiter = parameter.indexOf("=");
    if (delimiter < 1) continue;
    const key = parameter.slice(0, delimiter).toLowerCase();
    if (key !== "xt" && key !== "tr") continue;
    let value: string;
    try {
      value = decodeURIComponent(parameter.slice(delimiter + 1));
    } catch {
      continue;
    }
    if (key === "xt" && /^urn:btih:/iu.test(value)) {
      const candidate = btih(value.slice(9));
      if (!candidate || (hash && hash !== candidate)) return;
      hash = candidate;
    }
    if (key === "tr" && trackers.size < 8 && value.length <= 1024) {
      if (/^(?:udp|https):\/\/[^/?#@\s\\]+(?:[/?][^#\s\\]*)?$/iu.test(value)) {
        trackers.add(value);
      }
    }
  }
  if (!hash) return;
  let canonical = `magnet:?xt=urn:btih:${hash}`;
  for (const tracker of trackers) {
    const hint = `&tr=${encodeURIComponent(tracker)}`;
    if (canonical.length + hint.length <= maxUriLength) canonical += hint;
  }
  return { infoHash: hash, uri: canonical };
}

export function matchTorrents(content: string): TorrentEmbed[] {
  const matches = new Map<string, TorrentEmbed>();
  let fence: { marker: string; length: number } | undefined;
  let inline = 0;
  let quote = false;
  for (const line of content.split(/\r?\n/u)) {
    const marker = /^ {0,3}(`{3,}|~{3,})(.*)$/u.exec(line);
    if (fence) {
      if (
        marker &&
        marker[1][0] === fence.marker &&
        marker[1].length >= fence.length &&
        !marker[2].trim()
      )
        fence = undefined;
      continue;
    }
    if (/^ {0,3}>/u.test(line)) {
      quote = true;
      continue;
    }
    if (marker) {
      fence = { marker: marker[1][0], length: marker[1].length };
      inline = 0;
      quote = false;
      continue;
    }
    if (!line.trim()) {
      inline = 0;
      quote = false;
    }
    if (quote) continue;
    if (/^(?: {4}|\t)/u.test(line)) continue;
    for (const token of line.matchAll(
      /`+|(?:^|[\s([<])((?:magnet:\?)[^\s<>\[\]`"']+)/giu,
    )) {
      if (token[0][0] === "`") {
        if (inline === token[0].length) inline = 0;
        else if (!inline) inline = token[0].length;
        continue;
      }
      if (inline) continue;
      const end = token.index + token[0].length;
      if (line.startsWith("](", end)) continue;
      const magnet = parseMagnet(token[1].replace(/[.,;!?)]+$/u, ""));
      if (!magnet || matches.has(magnet.infoHash)) continue;
      matches.set(magnet.infoHash, {
        id: magnet.infoHash,
        renderer: "torrent",
        payload: magnet,
      });
      if (matches.size === 6) return [...matches.values()];
    }
  }
  return [...matches.values()];
}
