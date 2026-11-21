import { Parser } from "htmlparser2";
import { publicMediaUrl } from "@/core/media/url";
import type { Privacy } from "@/core/privacy";
import type { MessagingRepository } from "@/db/messaging";

export type LinkPreviewPolicy = "off" | "on-demand" | "always";
export const linkPreviewPolicies = ["off", "on-demand", "always"] as const;

export function previewPolicy(
  value: string | null | undefined,
): LinkPreviewPolicy {
  return value === "off" || value === "always" ? value : "on-demand";
}

function normalizePreviewUrl(input: string) {
  if (
    !/^https:\/\/[a-z0-9]/iu.test(input) ||
    /^https:\/\/[^/?#]*@/iu.test(input)
  )
    return null;
  return publicMediaUrl(input);
}

export function firstPreviewUrl(text: string) {
  // Only explicit HTTPS links qualify for network access.
  for (const match of text.matchAll(
    /(?:^|[\s([{"\u200e\u200f])(https:\/\/[^\s<>"\u200e\u200f]+)/giu,
  )) {
    const url = normalizePreviewUrl(match[1].replace(/[.,;:!?)}\]'»]+$/u, ""));
    if (url) return url.href;
  }
}

export function extractPreview(html: string, url: string) {
  const meta = new Map<string, string>();
  let title = "";
  let inTitle = false;
  let inBody = false;
  const clean = (text: string | undefined, limit: number) =>
    text
      ?.replace(/\p{Cc}+/gu, " ")
      .replace(/\s+/gu, " ")
      .trim()
      .slice(0, limit) || undefined;
  const keys = new Set([
    "og:site_name",
    "og:title",
    "og:description",
    "og:image",
    "og:image:secure_url",
    "twitter:title",
    "twitter:description",
    "twitter:image",
    "description",
  ]);
  new Parser({
    onopentag(name, attrs) {
      if (name === "body") inBody = true;
      if (inBody) return;
      if (name === "title" && !title) inTitle = true;
      if (name !== "meta") return;
      const key = (attrs.property ?? attrs.name)?.toLowerCase();
      if (key && keys.has(key) && !meta.has(key) && attrs.content)
        meta.set(key, attrs.content);
    },
    ontext(text) {
      if (inTitle && title.length < 512)
        title += text.slice(0, 512 - title.length);
    },
    onclosetag(name) {
      if (name === "title") inTitle = false;
    },
  }).end(html);
  const name = clean(meta.get("og:site_name"), 100);
  const pageTitle = clean(
    meta.get("og:title") ?? meta.get("twitter:title") ?? title,
    240,
  );
  const description = clean(
    meta.get("og:description") ??
      meta.get("twitter:description") ??
      meta.get("description"),
    420,
  );
  const image = clean(
    meta.get("og:image:secure_url") ??
      meta.get("og:image") ??
      meta.get("twitter:image"),
    2049,
  );
  if (!name && !pageTitle && !description && !image) return;
  let imageUrl: string | undefined;
  if (image && !image.includes("\\")) {
    try {
      const absolute = image.startsWith("//")
        ? `https:${image}`
        : /^[a-z][a-z0-9+.-]*:/iu.test(image)
          ? image
          : new URL(image, url).href;
      imageUrl = normalizePreviewUrl(absolute)?.href;
    } catch {
      // An invalid image URL still allows a text preview.
    }
  }
  if (!name && !pageTitle && !description && !imageUrl) return;
  return {
    siteName: name ?? new URL(url).hostname,
    title: pageTitle,
    description,
    imageUrl,
  };
}

export type CachedPreview = {
  url: string;
  siteName: string;
  title?: string;
  description?: string;
  image?: string;
  fetchedAt: number;
  expiresAt: number;
};

type Target = { peer: string; id: string; url: string };

export function authorizePreview(
  { peer, id, url }: Target,
  chat: Pick<MessagingRepository, "previewMessage">,
  privacy: Pick<Privacy, "isBlocked" | "request" | "messagePermission">,
) {
  if (privacy.isBlocked(peer) || privacy.request(peer).length) return false;
  const row = chat.previewMessage(peer, id);
  return (
    !!row &&
    (row.direction === "outgoing" ||
      privacy.messagePermission(peer) === "allow") &&
    firstPreviewUrl(row.body) === url
  );
}
type Job = {
  target: Target;
  explicit: boolean;
  permit: () => boolean;
  abort: AbortController;
};

type Dependencies = {
  policy: () => LinkPreviewPolicy;
  authorize: (target: Target) => boolean;
  html: (url: string, signal: AbortSignal) => Promise<string>;
  image: (url: string, signal: AbortSignal) => Promise<string>;
  save: (preview: CachedPreview) => void;
  removeImage: (image: string) => void;
  cached: (url: string) => CachedPreview | undefined;
};

const expiration = 7 * 24 * 60 * 60_000;
const failureDelay = 5 * 60_000;
const concurrency = 2;
const pendingLimit = 24;

export function createLinkPreviews(deps: Dependencies) {
  let policy = deps.policy();
  let running = 0;
  const active = new Map<string, Job>();
  const queue = new Map<string, Job>();
  const failures = new Map<string, number>();
  const listeners = new Map<string, Set<() => void>>();
  const notify = (url: string) => {
    for (const listener of listeners.get(url) ?? []) listener();
  };
  function valid(job: Job) {
    try {
      const current = deps.policy();
      return (
        !job.abort.signal.aborted &&
        (current === "always" || (current === "on-demand" && job.explicit)) &&
        job.permit() &&
        deps.authorize(job.target)
      );
    } catch {
      return false;
    }
  }
  function pump() {
    while (running < concurrency && queue.size > 0) {
      const job = queue.values().next().value;
      if (!job) break;
      const { url } = job.target;
      queue.delete(url);
      if (!valid(job)) {
        notify(url);
        continue;
      }
      active.set(url, job);
      running++;
      void load(job).finally(() => {
        running--;
        if (active.get(url) === job) active.delete(url);
        notify(url);
        pump();
      });
    }
  }
  async function load(job: Job) {
    const { signal } = job.abort;
    const { url } = job.target;
    let image: string | undefined;
    let timedOut = false;
    const deadline = setTimeout(() => {
      timedOut = true;
      job.abort.abort();
    }, 24_000);
    try {
      const html = await deps.html(url, signal);
      if (!valid(job)) return;
      if (html.length > 512 * 1024) throw new Error("preview-size");
      const metadata = extractPreview(html, url);
      if (!metadata) throw new Error("preview-metadata");
      const { imageUrl, ...fields } = metadata;
      if (imageUrl && valid(job)) {
        try {
          image = await deps.image(imageUrl, signal);
        } catch {
          // An unreachable or invalid image is optional.
        }
      }
      if (!valid(job)) return;
      const fetchedAt = Date.now();
      deps.save({
        ...fields,
        url,
        image,
        fetchedAt,
        expiresAt: fetchedAt + expiration,
      });
      image = undefined;
      failures.delete(url);
    } catch {
      if (valid(job)) rememberFailure(url);
    } finally {
      clearTimeout(deadline);
      if (image) deps.removeImage(image);
      if (timedOut && active.get(url) === job && deps.policy() === policy)
        rememberFailure(url);
    }
  }
  function rememberFailure(url: string) {
    if (failures.size >= 128) {
      const first = failures.keys().next().value;
      if (first) failures.delete(first);
    }
    failures.set(url, Date.now() + failureDelay);
  }
  function revalidate() {
    const next = deps.policy();
    const changed = next !== policy;
    policy = next;
    for (const jobs of [queue, active]) {
      for (const [url, job] of jobs) {
        if (!changed && valid(job)) continue;
        jobs.delete(url);
        job.abort.abort();
        if (!changed) notify(url);
      }
    }
    if (changed) for (const url of listeners.keys()) notify(url);
    pump();
  }
  const snapshot = (
    url: string,
  ): CachedPreview | "loading" | "failed" | undefined =>
    deps.policy() === "off"
      ? undefined
      : (deps.cached(url) ??
        (queue.has(url) || active.has(url)
          ? "loading"
          : (failures.get(url) ?? 0) > Date.now()
            ? "failed"
            : undefined));
  return {
    policy: deps.policy,
    snapshot,
    revalidate,
    subscribe(url: string, listener: () => void) {
      const group = listeners.get(url) ?? new Set();
      listeners.set(url, group);
      group.add(listener);
      return () => {
        group.delete(listener);
        if (!group.size) listeners.delete(url);
      };
    },
    request(target: Target, explicit: boolean, permit: () => boolean) {
      const { url } = target;
      const state = snapshot(url);
      if (
        normalizePreviewUrl(url)?.href !== url ||
        queue.size >= pendingLimit ||
        (state && !(explicit && state === "failed"))
      )
        return;
      const job = { target, explicit, permit, abort: new AbortController() };
      if (!valid(job)) return;
      queue.set(url, job);
      notify(url);
      pump();
    },
  };
}
