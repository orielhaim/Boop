import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NDKPrivateKeySigner } from "@nostr-dev-kit/ndk";
import { generateSecretKey, verifyEvent } from "nostr-tools";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { createProfileEditor } from "../src/core/avatars/editor";
import { type AvatarDisk } from "../src/core/avatars/service";
import { initializeTestDatabase } from "./db-fixture";
import * as schema from "../src/db/schema";
import {
  type BlossomHttp,
  createBlossomClient,
} from "../src/core/media/blossom";
import { createMediaSettings } from "../src/core/media/servers";
import { createMediaUploads } from "../src/core/media/uploads";

const origin = "https://blossom.example.com";
const signer = new NDKPrivateKeySigner(generateSecretKey());
const photo = Uint8Array.from([
  0xff, 0xd8, 0xff, 0xc0, 0, 8, 8, 0, 2, 0, 2, 0, 0xff, 0xda, 0, 2, 80, 0xff,
  0xd9,
]);
const digest = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");
const sha256 = async (bytes: Uint8Array) => digest(bytes);
const hash = digest(photo);
const url = `${origin}/${hash}.jpg`;
const response = (overrides = {}) =>
  Response.json(
    {
      url,
      sha256: hash,
      size: photo.length,
      type: "image/jpeg",
      uploaded: 1,
      ...overrides,
    },
    { status: 201 },
  );

test("file-backed Blossom uses a raw signed PUT and verifies the returned descriptor", async () => {
  const directory = mkdtempSync(join(tmpdir(), "boop-blossom-"));
  const filename = join(directory, "ciphertext.bin");
  const bytes = Uint8Array.from({ length: 64 * 1024 + 16 }, (_, i) => i % 251);
  writeFileSync(filename, bytes);
  const ciphertextHash = digest(bytes);
  const blobUrl = `${origin}/${ciphertextHash}`;
  const methods: string[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      methods.push(request.method);
      expect(new URL(request.url).pathname).toBe("/upload");
      const auth = request.headers.get("Authorization") ?? "";
      expect(auth.startsWith("Nostr ")).toBe(true);
      const event = JSON.parse(
        Buffer.from(auth.slice(6), "base64url").toString("utf8"),
      );
      expect(verifyEvent(event)).toBe(true);
      expect(event.tags).toContainEqual(["x", ciphertextHash]);
      if (request.method === "HEAD") {
        expect(request.headers.get("X-Content-Length")).toBe(
          String(bytes.length),
        );
        return new Response(null, { status: 200 });
      }
      expect(request.method).toBe("PUT");
      expect(request.headers.get("Content-Type")).toBe(
        "application/octet-stream",
      );
      expect(request.headers.get("Content-Length")).toBe(String(bytes.length));
      expect(request.headers.get("X-SHA-256")).toBe(ciphertextHash);
      expect(digest(await request.bytes())).toBe(ciphertextHash);
      return Response.json(
        {
          url: blobUrl,
          sha256: ciphertextHash,
          size: bytes.length,
          type: "application/octet-stream",
          uploaded: 1,
        },
        { status: 201 },
      );
    },
  });
  try {
    const endpoint = new URL("/upload", server.url);
    const progress: unknown[] = [];
    const client = createBlossomClient(signer, {
      sha256,
      request: (_url, { method, headers, signal }) =>
        fetch(endpoint, { method, headers, signal }),
      async putFile({ url, uri, headers, signal, progress }) {
        expect(url).toBe(`${origin}/upload`);
        expect(uri).toBe(filename);
        progress?.(32768, bytes.length);
        const response = await fetch(endpoint, {
          method: "PUT",
          headers,
          signal,
          body: Bun.file(uri),
        });
        return { status: response.status, body: await response.text() };
      },
    });
    await expect(
      client.put(
        origin,
        {
          uri: filename,
          size: bytes.length,
          hash: ciphertextHash,
          mime: "application/octet-stream",
        },
        new AbortController().signal,
        {
          progress: (state) => progress.push(state),
        },
      ),
    ).resolves.toBe(blobUrl);
    expect(methods).toEqual(["HEAD", "PUT"]);
    expect(progress).toEqual(["checking", "uploading", 49, "validating"]);
  } finally {
    await server.stop(true);
    rmSync(directory, { recursive: true, force: true });
  }
});

const putAvatar = (
  signer: NDKPrivateKeySigner,
  origin: string,
  bytes: Uint8Array<ArrayBuffer>,
  signal: AbortSignal,
  http: BlossomHttp,
) =>
  createBlossomClient(signer, http).put(
    origin,
    { bytes, size: bytes.length, mime: "image/jpeg", hash: digest(bytes) },
    signal,
    { preflight: false },
  );

test("upload signs the exact host and hash, then reads the blob back without credentials", async () => {
  const paths: string[] = [];
  const result = await putAvatar(
    signer,
    origin,
    photo,
    new AbortController().signal,
    {
      sha256,
      async request(path, options) {
        paths.push(path);
        expect(options.credentials).toBe("omit");
        expect(options.redirect).toBe("error");
        if (options.method !== "PUT") {
          expect(options.headers).toBeUndefined();
          return new Response(photo);
        }
        expect(options.body).toEqual(photo);
        expect(options.headers?.["X-SHA-256"]).toBe(hash);
        const auth = options.headers?.Authorization;
        if (!auth) throw new Error("No authorization");
        expect(auth).toMatch(/^Nostr [A-Za-z0-9_-]+$/u);
        const event = JSON.parse(
          Buffer.from(auth.slice(6), "base64url").toString("utf8"),
        );
        expect(verifyEvent(event)).toBe(true);
        expect(event.kind).toBe(24242);
        expect(event.tags).toContainEqual(["t", "upload"]);
        expect(event.tags).toContainEqual(["x", hash]);
        expect(event.tags).toContainEqual(["server", "blossom.example.com"]);
        expect(
          Number(
            event.tags.find((tag: string[]) => tag[0] === "expiration")?.[1],
          ) - event.created_at,
        ).toBeLessThan(125);
        return response();
      },
    },
  );
  expect(result).toBe(url);
  expect(paths).toEqual([`${origin}/upload`, url]);
});

test("descriptor mismatch does not trigger a GET; a corrupt read-back cannot be published", async () => {
  const signal = new AbortController().signal;
  for (const descriptor of [
    { sha256: "f".repeat(64) },
    { url: "https://other.example.com/wrong.jpg" },
    { size: 1 },
  ]) {
    let calls = 0;
    await expect(
      putAvatar(signer, origin, photo, signal, {
        sha256,
        async request() {
          calls++;
          return response(descriptor);
        },
      }),
    ).rejects.toHaveProperty("code", "descriptor");
    expect(calls).toBe(1);
  }
  await expect(
    putAvatar(signer, origin, photo, signal, {
      sha256,
      async request(_path, options) {
        return options.method === "PUT" ? response() : new Response("wrong");
      },
    }),
  ).rejects.toHaveProperty("code", "descriptor");
});

test("timeout, offline, authentication and explicit cancellation stay distinct", async () => {
  const signal = new AbortController().signal;
  await expect(
    putAvatar(signer, origin, photo, signal, {
      sha256,
      timeoutMs: 10,
      request(_path, { signal }) {
        return new Promise((_done, reject) =>
          signal.addEventListener("abort", () => reject(new Error()), {
            once: true,
          }),
        );
      },
    }),
  ).rejects.toHaveProperty("code", "timeout");
  await expect(
    putAvatar(signer, origin, photo, signal, {
      sha256,
      async request() {
        throw new Error("Offline");
      },
    }),
  ).rejects.toHaveProperty("code", "network");
  await expect(
    putAvatar(signer, origin, photo, signal, {
      sha256,
      async request() {
        return new Response(null, { status: 401 });
      },
    }),
  ).rejects.toHaveProperty("code", "authorization");
  const cancelled = new AbortController();
  cancelled.abort();
  await expect(
    putAvatar(signer, origin, photo, cancelled.signal, {
      sha256,
      async request() {
        throw new Error("Network must not run");
      },
    }),
  ).rejects.toHaveProperty("code", "cancelled");
});

test("confirmed photos survive relay refusal and retry without a second upload", async () => {
  using sqlite = new Database(":memory:");
  initializeTestDatabase(sqlite);
  const db = drizzle(sqlite, { schema });
  const local = new Set<string>();
  const disk: AvatarDisk = {
    newId: randomUUID,
    cacheTarget: (name) => name,
    cached: () => undefined,
    local: (name) => (local.has(name) ? `file:///draft/${name}` : undefined),
    copyLocal: (_source, name) => {
      local.add(name);
    },
    removeCached: () => {},
    commitCached: () => {},
    authored: () => undefined,
    keepAuthored: () => {},
    removeLocal: (name) => {
      local.delete(name);
    },
    sweepLocal: () => {},
    pruneCache: () => {},
    clearCache: () => {},
  };
  let accepts = false;
  let publishAttempts = 0;
  let beforePublish: (() => Promise<void>) | undefined;
  const updates: Array<Record<string, string>> = [];
  const attempts: string[] = [];
  const backup = "https://backup.example.com";
  const prefs = new Map<string, string>();
  const settings = createMediaSettings({
    read: (key) => prefs.get(key) ?? null,
    write: (key, value) => {
      prefs.set(key, value);
    },
  });
  settings.save({
    mirror: true,
    servers: [origin, backup].map((server) => ({
      origin: server,
      enabled: true,
      roles: ["profile"],
    })),
  });
  const uploads = createMediaUploads(
    signer,
    {
      sha256,
      async request(path, options) {
        if (options.method === "HEAD")
          return new Response(null, { status: 200 });
        if (path.endsWith("/mirror")) {
          attempts.push(new URL(path).origin);
          return new Response(null, { status: 402 });
        }
        if (options.method === "PUT") {
          attempts.push(new URL(path).origin);
          return response();
        }
        return new Response(photo);
      },
    },
    settings,
    () => {},
  );
  const editor = createProfileEditor(
    db,
    disk,
    (_file, signal) => uploads.upload("profile", photo, { signal }),
    async (edits) => {
      publishAttempts++;
      await beforePublish?.();
      if (!accepts) throw new Error("Relay refused update");
      updates.push(edits);
    },
    () => {},
    () => true,
    async () => true,
  );
  const empty = editor.getSnapshot();
  expect(empty.draft).toBeNull();
  expect(editor.getSnapshot()).toBe(empty);
  const observed: ReturnType<typeof editor.getSnapshot>[] = [];
  const unsubscribe = editor.subscribe(() =>
    observed.push(editor.getSnapshot()),
  );
  editor.prepare("file:///cropped.jpg");
  expect(observed.at(-1)?.draft?.photo.kind).toBe("upload");
  expect(attempts).toEqual([]);
  const draft = editor.preview();
  expect(draft).toStartWith("file:///draft/");
  expect(await editor.publish()).toBe("relays");
  expect(publishAttempts).toBe(1);
  expect(attempts).toEqual([origin, backup]);
  expect(updates).toEqual([]);
  expect(editor.preview()).toBe(draft);
  accepts = true;
  expect(await editor.publish()).toBe("mirror");
  expect(attempts).toEqual([origin, backup]);
  expect(editor.draft()).toBeNull();
  expect(updates).toEqual([{ picture: url }]);
  editor.removeImage("photo");
  expect(await editor.publish()).toBe("published");
  expect(updates.at(-1)).toEqual({ picture: "" });
  expect(local.size).toBe(0);
  expect(observed.at(-1)).toMatchObject({ draft: null, stage: "idle" });
  const started = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  beforePublish = () => {
    started.resolve();
    return release.promise;
  };
  editor.editFields({ name: "First edit" });
  const first = editor.publish();
  await started.promise;
  editor.editFields({ name: "Latest edit" });
  release.resolve();
  expect(await first).toBe("cancelled");
  expect(editor.getSnapshot().draft?.name).toBe("Latest edit");
  beforePublish = undefined;
  expect(await editor.publish()).toBe("published");
  expect(updates.at(-1)).toEqual({ display_name: "Latest edit" });
  editor.editFields({ name: "Private draft" });
  expect(observed.at(-1)?.draft?.name).toBe("Private draft");
  editor.discard();
  expect(observed.at(-1)?.draft).toBeNull();
  unsubscribe();
});
