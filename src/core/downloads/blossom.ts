import { parseBlossomURI } from "blossom-client-sdk/helpers/blossom-uri";
import { blossomServer } from "../media/blossom";
import { publicMediaUrl } from "../media/url";
import { blossomSource, type BlossomDownload } from "./types";

const hashPattern = /^[a-f0-9]{64}$/u;
const types: Readonly<Record<string, string>> = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
  gif: "image/gif",
  mp4: "video/mp4",
  webm: "video/webm",
  mp3: "audio/mpeg",
  m4a: "audio/mp4",
  ogg: "audio/ogg",
  pdf: "application/pdf",
  txt: "text/plain",
  zip: "application/zip",
};

function address(input: string) {
  const url = publicMediaUrl(input);
  if (!url || url.search) return;
  const match = /\/([a-f0-9]{64})(?:\.([a-z0-9]{1,8}))?$/iu.exec(url.pathname);
  if (match)
    return {
      url: url.href,
      hash: match[1].toLowerCase(),
      ext: match[2]?.toLowerCase(),
    };
}

export function blossomDownload(
  input: string,
  hints: {
    hash?: string;
    total?: number;
    name?: string;
    type?: string;
    author?: string;
  } = {},
): BlossomDownload | undefined {
  if (input.length > 2048 || /[\s\\\p{Cc}]/u.test(input)) return;
  let hash: string;
  let ext: string;
  let urls: string[];
  let authors = hints.author ? [hints.author] : [];
  let total = hints.total ?? null;
  if (input.startsWith("blossom:")) {
    try {
      const uri = parseBlossomURI(input);
      hash = uri.sha256.toLowerCase();
      ext = uri.ext.toLowerCase();
      if (!/^[a-z0-9]{1,8}$/u.test(ext)) return;
      urls = blossomCandidates(hash, uri.servers.slice(0, 8));
      authors = [...authors, ...uri.authors];
      if (total !== null && uri.size !== undefined && total !== uri.size)
        return;
      total ??= uri.size ?? null;
    } catch {
      return;
    }
  } else {
    const resource = address(input);
    if (!resource) return;
    ({ hash } = resource);
    ext = resource.ext ?? "bin";
    urls = [resource.url];
  }
  if (hints.hash && hints.hash.toLowerCase() !== hash) return;
  const name = hints.name
    ?.replace(/[\\/:\p{Cc}\p{Cf}]/gu, "_")
    .trim()
    .slice(0, 128);
  const type = hints.type?.toLowerCase();
  const parsed = blossomSource.safeParse({
    kind: "http",
    artifact: "blossom",
    hash,
    total,
    expectedSize: total,
    name: name && name !== "." && name !== ".." ? name : `${hash}.${ext}`,
    type:
      type && /^[a-z0-9.+-]+\/[a-z0-9.+-]+$/u.test(type)
        ? type
        : (types[ext] ?? "application/octet-stream"),
    urls,
    authors: [
      ...new Set(authors.filter((author) => hashPattern.test(author))),
    ].slice(0, 3),
    expiresAt: null,
  });
  return parsed.success ? parsed.data : undefined;
}

export function blossomCandidates(hash: string, origins: readonly string[]) {
  return [
    ...new Set(
      origins.flatMap((hint) => {
        const origin = blossomServer(
          hint.includes("://") ? hint : `https://${hint}`,
        );
        return origin ? [`${origin}/${hash}`] : [];
      }),
    ),
  ].slice(0, 8);
}

export function checkedBlossomUrls(source: BlossomDownload) {
  return source.urls.filter((url) => address(url)?.hash === source.hash);
}

export function firstBlossomDownload(body: string, author: string) {
  for (const match of body.matchAll(
    /(?:^|[\s([{])((?:https:\/\/|blossom:)[^\s<>"']+)/gu,
  )) {
    const source = blossomDownload(match[1].replace(/[.,;!?)}\]]+$/u, ""), {
      author,
    });
    if (source) return source;
  }
}

export async function tryBlossomOrigins(
  urls: readonly string[],
  discover: () => Promise<string[]>,
  attempt: (url: string) => Promise<string>,
  signal: AbortSignal,
) {
  let result = "unavailable";
  const seen = new Set<string>();
  const take = async (candidates: readonly string[]) => {
    for (const url of candidates) {
      if (signal.aborted) return "interrupted";
      if (seen.has(url)) continue;
      if (seen.size >= 12) break;
      seen.add(url);
      const state = await attempt(url);
      if (state === "ready" || state === "storage_blocked") return state;
      if (
        state === "interrupted" ||
        (state === "integrity" && result === "unavailable")
      )
        result = state;
    }
  };
  return (
    (await take(urls)) ??
    (signal.aborted
      ? "interrupted"
      : ((await take(await discover())) ?? result))
  );
}
