import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import migrations from "../src/db/migrations/bundle";
import * as schema from "../src/db/schema";
import { createMessagingRepository } from "../src/db/messaging";
import assert from "node:assert/strict";
import * as crypto from "node:crypto";
import {
  closeSync,
  existsSync,
  fstatSync,
  mkdtempSync,
  openSync,
  readSync,
  rmSync,
  statSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mock } from "bun:test";

const chunkSize = 64 * 1024;
const directory = mkdtempSync(join(tmpdir(), "boop-media-files-"));
let observe: (() => void) | undefined;
let interrupt: AbortController | undefined;
let fixedEntropy = true;

class DiskFile {
  constructor(readonly path: string) {}
  get exists() {
    return existsSync(this.path);
  }
  get size() {
    return statSync(this.path).size;
  }
  create() {
    writeFileSync(this.path, "", { flag: "wx" });
  }
  delete() {
    rmSync(this.path);
  }
  open(mode: "r" | "w") {
    const fd = openSync(this.path, mode === "r" ? "r" : "r+");
    return {
      offset: 0,
      get size() {
        return fstatSync(fd).size;
      },
      close() {
        closeSync(fd);
      },
      readBytesSync(length: number) {
        assert(length <= chunkSize);
        const buffer = new Uint8Array(length);
        const got = readSync(fd, buffer, 0, length, this.offset);
        this.offset += got;
        return buffer.subarray(0, got);
      },
      async readBytes(length: number) {
        const bytes = this.readBytesSync(length);
        observe?.();
        interrupt?.abort();
        interrupt = undefined;
        return bytes;
      },
      async writeBytes(bytes: Uint8Array) {
        assert(bytes.length <= chunkSize);
        this.offset += writeSync(fd, bytes, 0, bytes.length, this.offset);
        observe?.();
      },
    };
  }
}

mock.module("expo-file-system", () => ({
  File: DiskFile,
  Directory: DiskFile,
  FileMode: { ReadOnly: "r", WriteOnly: "w" },
  Paths: { availableDiskSpace: 1024 ** 3 },
}));
mock.module("expo-crypto", () => ({
  getRandomBytesAsync: async (length: number) =>
    fixedEntropy
      ? new Uint8Array(length)
      : Uint8Array.from(crypto.randomBytes(length)),
  randomUUID: crypto.randomUUID,
}));
mock.module("react-native", () => ({ Platform: { OS: "android" } }));
mock.module("react-native-quick-crypto", () => ({ ...crypto, Buffer }));

const { sealAttachment, openAttachment, hashAttachmentFile } =
  await import("../src/core/media/crypto");
const { File } = await import("expo-file-system");
const file = (name: string) => new File(join(directory, name));
const metadata = { kind: "file", mime: "application/octet-stream" } as const;
const source = file("source");
const ciphertext = file("ciphertext");
const clear = file("clear");
const path = (name: string) => join(directory, name);

try {
  const block = new Uint8Array(16);
  writeFileSync(path("source"), block);
  const sealed = await sealAttachment(source, ciphertext, metadata);
  const expected =
    "cea7403d4d606b6e074ec5d3baf39d18d0d1c8a799996bf0265b98b5d48ab919";
  const gcmVector = Buffer.from(expected, "hex");
  const hash = (bytes: Uint8Array) =>
    crypto.createHash("sha256").update(bytes).digest("hex");
  assert.equal(sealed.hash, hash(gcmVector));
  assert.equal(sealed.originalHash, hash(block));
  await openAttachment(ciphertext, clear, sealed);
  assert.equal(await hashAttachmentFile(clear), hash(block));
  clear.delete();

  for (const invalid of [
    { key: "01".repeat(32) },
    { nonce: "00" },
    { originalHash: "00".repeat(32) },
  ]) {
    await assert.rejects(
      openAttachment(ciphertext, clear, { ...sealed, ...invalid }),
      /media-integrity/u,
    );
    assert(!clear.exists);
  }
  const corrupted = Buffer.from(gcmVector);
  corrupted[0] ^= 1;
  writeFileSync(path("ciphertext"), corrupted);
  await assert.rejects(
    openAttachment(ciphertext, clear, { ...sealed, hash: hash(corrupted) }),
    /media-integrity/u,
  );
  assert(!clear.exists);
  writeFileSync(path("ciphertext"), gcmVector.subarray(0, -1));
  await assert.rejects(
    openAttachment(ciphertext, clear, sealed),
    /media-integrity/u,
  );
  writeFileSync(path("ciphertext"), gcmVector);
  interrupt = new AbortController();
  await assert.rejects(
    openAttachment(ciphertext, clear, sealed, interrupt.signal),
    /media-cancelled/u,
  );
  assert(!clear.exists);
  ciphertext.delete();
  interrupt = new AbortController();
  await assert.rejects(
    sealAttachment(source, ciphertext, metadata, interrupt.signal),
    /media-cancelled/u,
  );
  assert(!ciphertext.exists);
  console.info(
    "File AES-GCM vector, tag rejection, interruption and cleanup passed",
  );

  mock.module("expo", () => ({ requireOptionalNativeModule: () => null }));
  using sqlite = new Database(":memory:");
  sqlite.exec("PRAGMA foreign_keys = ON");
  for (const migration of Object.values(migrations.migrations))
    sqlite.exec(migration);
  const db = drizzle(sqlite, { schema });
  const owner = "a".repeat(64);
  const peer = "b".repeat(64);
  const origin = "https://media.example.com";
  const url = `${origin}/${sealed.hash}`;
  const chat = createMessagingRepository(db);
  const enqueued = chat.enqueue({
    id: "pending-file",
    peerKey: peer,
    eventId: null,
    sentAt: 1_710_000_000_000,
    attachment: sealed,
    replyTo: null,
    senderKey: owner,
    recipientKey: peer,
    direction: "outgoing",
    body: "",
  });
  assert(enqueued);
  const activeRow = {
    messageId: "pending-file",
    nativeId: "boop-put-current",
    owner,
    peer,
    hash: sealed.hash,
    source: "file:///ciphertext",
    origin,
    resultUrl: null,
  };
  db.insert(schema.attachmentUploads).values(activeRow).run();
  const acknowledgements: string[] = [];
  const stops: string[] = [];
  let present = true;
  const done = {
    id: activeRow.nativeId,
    state: "DONE",
    responseCode: 201,
    responseBody: JSON.stringify({
      url,
      sha256: sealed.hash,
      size: sealed.size,
      type: "application/octet-stream",
      uploaded: 1,
    }),
  };
  const orphan = {
    id: "boop-put-old-owner",
    state: "PAUSED",
    stop: async () => {
      stops.push(orphan.id);
    },
  };
  mock.module("@kesha-antonov/react-native-background-downloader", () => ({
    getExistingUploadTasks: async () => (present ? [done, orphan] : []),
    completeHandler: (id: string) => {
      const row = db.select().from(schema.attachmentUploads).get();
      assert.equal(row?.resultUrl, url);
      acknowledgements.push(id);
      present = false;
    },
    createUploadTask: () => {
      throw new Error("Completed file uploaded twice");
    },
  }));
  const { createAttachmentTransfers } =
    await import("../src/core/media/attachment-transfers");
  const recover = async () => {
    const transfers = createAttachmentTransfers(
      db,
      owner,
      (candidate) => candidate === origin,
    );
    transfers.reconcile((row) => row.owner === owner && row.peer === peer);
    return transfers.recover(
      { id: activeRow.messageId, peer },
      activeRow.source,
      sealed.hash,
      sealed.size ?? 0,
      new AbortController().signal,
      () => {},
    );
  };
  assert.equal(await recover(), url);
  assert.equal(await recover(), url);
  assert.deepEqual(stops, [orphan.id]);
  assert.deepEqual(acknowledgements, [activeRow.nativeId]);
  assert.equal(chat.pending(16, true).length, 1);
  console.info(
    "Verified upload receipt persisted before native acknowledgement and reused after restart",
  );

  if (process.argv.includes("--measure")) {
    fixedEntropy = false;
    const chunk = new Uint8Array(chunkSize);
    for (const mib of [1, 10, 31]) {
      const fd = openSync(path("source"), "w");
      for (let i = 0; i < mib * 16; i++) writeSync(fd, chunk);
      closeSync(fd);
      Bun.gc(true);
      const start = process.memoryUsage();
      let heap = 0,
        external = 0,
        rss = 0;
      observe = () => {
        const current = process.memoryUsage();
        heap = Math.max(heap, current.heapUsed - start.heapUsed);
        external = Math.max(external, current.external - start.external);
        rss = Math.max(rss, current.rss - start.rss);
      };
      const t0 = performance.now();
      const file = await sealAttachment(source, ciphertext, metadata);
      const t1 = performance.now();
      await openAttachment(ciphertext, clear, file);
      const t2 = performance.now();
      observe();
      observe = undefined;
      const diskBytes = source.size + ciphertext.size + clear.size;
      ciphertext.delete();
      clear.delete();
      const oneShot = await Bun.file(path("source")).bytes();
      const cipher = crypto.createCipheriv(
        "aes-256-gcm",
        Buffer.alloc(32),
        Buffer.alloc(12),
      );
      const oneShotOutput = Buffer.concat([
        cipher.update(oneShot),
        cipher.final(),
        cipher.getAuthTag(),
      ]);
      console.info(
        JSON.stringify({
          mib,
          hostPeakHeapDeltaBytes: heap,
          hostPeakExternalDeltaBytes: external,
          hostPeakRssDeltaBytes: rss,
          encryptMs: Math.round(t1 - t0),
          decryptMs: Math.round(t2 - t1),
          diskBytes,
          oneShotMaterializedBytes: oneShot.length + oneShotOutput.length,
        }),
      );
    }
  }
} finally {
  rmSync(directory, { force: true, recursive: true });
}
