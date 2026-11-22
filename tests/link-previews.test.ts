import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { drizzle } from "drizzle-orm/bun-sqlite";
import {
  createLinkPreviews,
  extractPreview,
  firstPreviewUrl,
  previewPolicy,
  type LinkPreviewPolicy,
} from "../src/core/messaging/link-previews";
import { createPrivacy } from "../src/core/privacy";
import { createMarmotViewport } from "../src/core/marmot/viewport";
import { openLinkPreviewCache } from "../src/db/link-previews";
import { initializeTestDatabase } from "./db-fixture";
import * as schema from "../src/db/schema";

const page = "https://public.example.com/";
const html = `<html><head><title>Fallback</title>
  <meta content="News &amp; notes" property="og:title">
  <meta property="og:site_name" content="Gazette">
  <meta name="twitter:description" content="An article">
  <meta property="og:image" content="/banner.png"></head></html>`;
const own = "1".repeat(64);
const peer = "2".repeat(64);
const target = { peer, id: "visible", url: page };

function database(sqlite: Database) {
  initializeTestDatabase(sqlite);
  return drizzle(sqlite, { schema });
}

test("reads Open Graph, standard and Twitter metadata as inert text", () => {
  expect(extractPreview(html, page)).toEqual({
    title: "News & notes",
    siteName: "Gazette",
    description: "An article",
    imageUrl: "https://public.example.com/banner.png",
  });
  expect(
    extractPreview(
      '<title>Example</title><meta name="description" content="Summary">',
      page,
    ),
  ).toMatchObject({
    title: "Example",
    description: "Summary",
    siteName: "public.example.com",
  });
  expect(
    extractPreview(
      '<script>"<title>bad</title>"</script><!-- <title>bad</title> -->',
      page,
    ),
  ).toBeUndefined();
  expect(
    extractPreview(
      '<meta property="og:image" content="https://127.0.0.1/private">',
      page,
    ),
  ).toBeUndefined();
  for (const input of [
    "https://[::1]/",
    "http://public.example.com/",
    "https://a.internal/",
    "https://user:pass@public.example.com",
    "https://@public.example.com/",
    "https:///public.example.com/",
    "https://",
    "javascript:alert(1)",
    "hi@public.example.com",
  ]) {
    expect(firstPreviewUrl(input)).toBeUndefined();
  }
  expect(firstPreviewUrl("שלום (https://public.example.com/#section).")).toBe(
    page,
  );
});

test("Off and untouched On Demand dispatch zero HTTP requests and an explicit load persists a cached image", async () => {
  using sqlite = new Database(":memory:");
  const db = database(sqlite);
  let policy: LinkPreviewPolicy = previewPolicy(null);
  expect(policy).toBe("on-demand");
  const calls: string[] = [];
  const storage = openLinkPreviewCache(db, () => {});
  const deps = {
    policy: () => policy,
    authorize: () => true,
    html: async (url: string) => {
      calls.push(url);
      return html;
    },
    image: async (url: string) => {
      calls.push(url);
      return "download.jpg";
    },
    removeImage() {},
  };
  const previews = createLinkPreviews({ ...storage, ...deps });
  const permit = () => true;
  previews.request(target, false, permit);
  expect(previews.snapshot(page)).toBeUndefined();
  policy = "off";
  previews.revalidate();
  previews.request(target, true, permit);
  expect(calls).toEqual([]);
  policy = "on-demand";
  previews.revalidate();
  previews.request(target, true, permit);
  previews.request({ ...target, id: "same-url" }, true, permit);
  expect(previews.snapshot(page)).toBe("loading");
  await Bun.sleep(0);
  expect(calls).toEqual([page, "https://public.example.com/banner.png"]);
  using reopened = Database.deserialize(sqlite.serialize());
  const afterRestart = createLinkPreviews({
    ...openLinkPreviewCache(drizzle(reopened, { schema }), () => {}),
    ...deps,
  });
  expect(afterRestart.snapshot(page)).toMatchObject({
    title: "News & notes",
    image: "download.jpg",
  });
  afterRestart.request(target, true, permit);
  expect(calls).toHaveLength(2);
  policy = "off";
  afterRestart.revalidate();
  expect(afterRestart.snapshot(page)).toBeUndefined();
});

test("Always only loads visible accepted messages and rechecks block and lock state", async () => {
  using sqlite = new Database(":memory:");
  const db = database(sqlite);
  const privacy = createPrivacy(db, own);
  const blocked = "3".repeat(64);
  privacy.block(blocked);
  let unlocked = false;
  const viewport = createMarmotViewport(own, () => unlocked, privacy.isBlocked);
  const row = (id: string, text: string, sender = peer, eventKind = 9) => ({
    id,
    text,
    sender,
    eventKind,
    deleted: false,
    attachments: [],
  });
  const clear = viewport.update(peer, [
    row("visible", page),
    row("blocked", "https://blocked.example.com/", blocked),
    row("sealed", "https://hidden.example.com/", peer, 24881),
  ]);
  const calls: string[] = [];
  const previews = createLinkPreviews({
    ...openLinkPreviewCache(db, () => {}),
    policy: () => "always",
    authorize: viewport.authorizePreview,
    html: async (url) => {
      calls.push(url);
      return "<title>Accepted</title>";
    },
    image: async () => {
      throw new Error("Unexpected image");
    },
    removeImage() {},
  });
  const submit = (id: string, url: string) =>
    previews.request({ id, url, peer }, false, () => true);
  submit("visible", page);
  expect(calls).toEqual([]);
  unlocked = true;
  submit("blocked", "https://blocked.example.com/");
  submit("request", "https://pending.example.com/");
  submit("sealed", "https://hidden.example.com/");
  submit("visible", page);
  await Bun.sleep(0);
  expect(calls).toEqual([page]);
  clear();
  expect(viewport.authorizePreview(target)).toBe(false);
});

test("cancels running and queued work on policy change and ignores stale results", async () => {
  using sqlite = new Database(":memory:");
  const db = database(sqlite);
  let policy: LinkPreviewPolicy = "always";
  const calls: AbortSignal[] = [];
  const result = Promise.withResolvers<string>();
  const previews = createLinkPreviews({
    ...openLinkPreviewCache(db, () => {}),
    policy: () => policy,
    authorize: () => true,
    html: async (_url, signal) => {
      calls.push(signal);
      return result.promise;
    },
    image: async () => {
      throw new Error("Stale request reached image transfer");
    },
    removeImage() {},
  });
  for (let i = 0; i < 30; i++)
    previews.request({ ...target, url: `${page}${i}` }, false, () => true);
  expect(calls).toHaveLength(2);
  policy = "on-demand";
  previews.revalidate();
  expect(calls.every((signal) => signal.aborted)).toBe(true);
  result.resolve(html);
  await Bun.sleep(0);
  expect(calls).toHaveLength(2);
  expect(previews.snapshot(`${page}0`)).toBeUndefined();
  expect(db.select().from(schema.linkPreviewCache).all()).toEqual([]);
});

test("invalid destination, rejected redirects, oversized HTML and timeout fail without retries or cache", async () => {
  using sqlite = new Database(":memory:");
  const db = database(sqlite);
  const calls: string[] = [];
  const previews = createLinkPreviews({
    ...openLinkPreviewCache(db, () => {}),
    policy: () => "on-demand",
    authorize: () => true,
    async html(url) {
      calls.push(url);
      if (url.endsWith("/oversized")) return "x".repeat(512 * 1024 + 1);
      if (url.endsWith("/timeout"))
        throw new Error("Native transfer timed out");
      throw new Error("Native transfer rejected redirect");
    },
    image: async () => {
      throw new Error("Unexpected image");
    },
    removeImage() {},
  });
  for (const url of ["https://127.0.0.1/", "https://a.local/", "https://"]) {
    previews.request({ ...target, url }, true, () => true);
  }
  expect(calls).toEqual([]);
  for (const path of ["redirect", "oversized", "timeout"]) {
    const url = page + path;
    previews.request({ ...target, url }, true, () => true);
    await Bun.sleep(0);
    expect(previews.snapshot(url)).toBe("failed");
  }
  expect(calls).toHaveLength(3);
  expect(db.select().from(schema.linkPreviewCache).all()).toEqual([]);
});

test("expired and evicted previews release their local images", () => {
  using sqlite = new Database(":memory:");
  const db = database(sqlite);
  const removed: string[] = [];
  const cache = openLinkPreviewCache(db, (image) => removed.push(image));
  const now = Date.now();
  cache.save({
    url: page,
    siteName: "Gazette",
    image: "expired.jpg",
    fetchedAt: now - 1000,
    expiresAt: now - 1,
  });
  for (let i = 0; i < 97; i++) {
    cache.save({
      url: `${page}${i}`,
      siteName: "Gazette",
      image: `${i}.jpg`,
      fetchedAt: now + i,
      expiresAt: now + 60_000,
    });
  }
  expect(cache.cached(page)).toBeUndefined();
  expect(cache.cached(`${page}0`)).toBeUndefined();
  expect(removed).toEqual(["expired.jpg", "0.jpg"]);
  expect(db.select().from(schema.linkPreviewCache).all()).toHaveLength(96);
});
