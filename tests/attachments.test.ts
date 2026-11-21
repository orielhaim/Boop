import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { createDecipheriv } from "node:crypto";
import NDK, { NDKPrivateKeySigner } from "@nostr-dev-kit/ndk";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { toDetailMessage } from "../src/components/messages/detail-adapter";
import { toConversationListItem } from "../src/components/messages/conversation-item";
import { validateVoiceAudio } from "../src/core/media/audio-format";
import { createManualDownloads } from "../src/core/media/manual-download";
import {
  fileMessageKind,
  fileTags,
  maxAttachmentBytes,
  parseFileMessage,
  type VoiceAttachment,
} from "../src/core/media/protocol";
import {
  createRumor,
  unwrapPrivateEvent,
  wrapRumor,
} from "../src/core/messaging/nip17";
import { createInboxIngestion } from "../src/core/messaging/inbox-sync";
import { createPrivacy } from "../src/core/privacy";
import {
  createMessagingRepository,
  type MessageInput,
} from "../src/db/messaging";
import migrations from "../src/db/migrations/bundle";
import * as schema from "../src/db/schema";

const file: VoiceAttachment = {
  kind: "voice",
  mime: "audio/mp4",
  algorithm: "aes-gcm",
  url: "https://media.example.com/voice.bin",
  key: "00".repeat(32),
  nonce: "00".repeat(12),
  hash: "ab".repeat(32),
  durationMs: 28_100,
  size: 32,
  waveform: [2, 13, 78, 100, 15],
};

function database() {
  const sqlite = new Database(":memory:");
  sqlite.exec("PRAGMA foreign_keys = ON");
  for (const entry of Object.values(migrations.migrations)) sqlite.exec(entry);
  const db = drizzle(sqlite, { schema });
  return { sqlite, db, chat: createMessagingRepository(db) };
}

test("kind 15 keeps file metadata inside independently wrapped copies and validates tags", async () => {
  const sender = NDKPrivateKeySigner.generate();
  const recipient = NDKPrivateKeySigner.generate();
  const ndk = new NDK({ signer: sender });
  const author = sender.userSync.pubkey;
  const peer = recipient.userSync.pubkey;
  const quoted = "01".repeat(32);
  const rumor = createRumor({
    kind: fileMessageKind,
    created_at: 1_797_000_000,
    pubkey: author,
    content: file.url,
    tags: [["p", peer], ["e", quoted, "", "reply"], ...fileTags(file)],
  });
  // Use a past creation time independent of the machine's clock.
  const dated = createRumor({ ...rumor, created_at: 1_710_000_000 });
  for (const signer of [sender, recipient]) {
    const wrap = (
      await wrapRumor(ndk, dated, signer.userSync.pubkey, sender)
    ).rawEvent();
    expect(wrap.tags.map(([name]) => name)).toEqual(["p"]);
    expect(JSON.stringify(wrap)).not.toContain(file.url);
    expect(await unwrapPrivateEvent(wrap, signer)).toMatchObject({
      id: dated.id,
      type: "attachment",
      file,
      replyTo: quoted,
      senderKey: author,
    });
    expect(await unwrapPrivateEvent(wrap, signer, () => true)).toBeNull();
  }
  for (const changed of [
    { ...file, key: "12" },
    { ...file, nonce: "11" },
    { ...file, mime: "image/jpeg" },
    { ...file, size: maxAttachmentBytes + 1 },
    { ...file, waveform: Array(65).fill(1) },
    { ...file, durationMs: 300_001 },
    { ...file, algorithm: "aes-cbc" },
  ])
    expect(
      parseFileMessage(file.url, fileTags(changed as VoiceAttachment)),
    ).toBeNull();
  expect(
    parseFileMessage("http://media.example.com/file", fileTags(file)),
  ).toBeNull();
  expect(parseFileMessage("https://127.0.0.1/file", fileTags(file))).toBeNull();
  expect(
    parseFileMessage("https://box.internal/file", fileTags(file)),
  ).toBeNull();
  expect(
    parseFileMessage(file.url, [...fileTags(file), ["x", file.hash]]),
  ).toBeNull();
});

test("AES-256-GCM kind-15 bytes match GCM CIPHERTEXT || TAG and authenticate across implementations", async () => {
  const key = await crypto.subtle.importKey(
    "raw",
    Uint8Array.fromHex(file.key),
    "AES-GCM",
    false,
    ["encrypt", "decrypt"],
  );
  const iv = Uint8Array.fromHex(file.nonce);
  const plaintext = new Uint8Array(16);
  const encrypted = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, plaintext),
  );
  expect(encrypted.toHex()).toBe(
    "cea7403d4d606b6e074ec5d3baf39d18d0d1c8a799996bf0265b98b5d48ab919",
  );
  const decipher = createDecipheriv(
    "aes-256-gcm",
    Uint8Array.fromHex(file.key),
    iv,
  );
  decipher.setAuthTag(encrypted.slice(-16));
  expect([
    ...decipher.update(encrypted.slice(0, -16)),
    ...decipher.final(),
  ]).toEqual([...plaintext]);
  for (const position of [0, encrypted.length - 1]) {
    const invalid = encrypted.slice();
    invalid[position] ^= 1;
    await expect(
      crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, invalid),
    ).rejects.toThrow();
    expect(
      new Bun.CryptoHasher("sha256").update(invalid).digest("hex"),
    ).not.toBe(new Bun.CryptoHasher("sha256").update(encrypted).digest("hex"));
  }
  const secret = () => ({
    key: crypto.getRandomValues(new Uint8Array(32)).toHex(),
    nonce: crypto.getRandomValues(new Uint8Array(12)).toHex(),
  });
  const first = secret();
  const second = secret();
  expect(first.key).not.toBe(second.key);
  expect(first.nonce).not.toBe(second.nonce);
  expect(() => validateVoiceAudio(encrypted)).toThrow("media-format");
});

test("accepts large-size ISO BMFF boxes used by Android AAC and rejects truncation", () => {
  function box(type: string, parts: Uint8Array[], extended = false) {
    const header = extended ? 16 : 8;
    const bytes = new Uint8Array(
      header + parts.reduce((sum, part) => sum + part.length, 0),
    );
    const view = new DataView(bytes.buffer);
    view.setUint32(0, extended ? 1 : bytes.length);
    if (extended) view.setUint32(12, bytes.length);
    bytes.set(new TextEncoder().encode(type), 4);
    let offset = header;
    for (const part of parts) {
      bytes.set(part, offset);
      offset += part.length;
    }
    return bytes;
  }
  const audio = box("hdlr", [
    new Uint8Array(8),
    new TextEncoder().encode("soun"),
  ]);
  const codec = box("stsd", [
    new Uint8Array(8),
    box("mp4a", [new Uint8Array(28)]),
  ]);
  const movie = box("moov", [
    box("trak", [box("mdia", [audio, box("minf", [box("stbl", [codec])])])]),
  ]);
  const audioFile = Uint8Array.from([
    ...box("ftyp", [new TextEncoder().encode("M4A ")]),
    ...box("mdat", [Uint8Array.of(42)], true),
    ...movie,
  ]);
  expect(() => validateVoiceAudio(audioFile)).not.toThrow();
  expect(() => validateVoiceAudio(audioFile.slice(0, -1))).toThrow(
    "media-format",
  );
});

test("authenticated receipt, requests, history, quotes, previews, read and resume make zero media requests", async () => {
  const { sqlite, db, chat } = database();
  try {
    const recipient = NDKPrivateKeySigner.generate();
    const sender = NDKPrivateKeySigner.generate();
    const ndk = new NDK({ signer: sender });
    const owner = recipient.userSync.pubkey;
    const peer = sender.userSync.pubkey;
    const privacy = createPrivacy(db, chat, owner);
    privacy.set("requests", true);
    const toInput = (id: string): MessageInput => ({
      id,
      eventId: id,
      peerKey: peer,
      direction: "incoming",
      senderKey: peer,
      recipientKey: owner,
      body: "",
      replyTo: null,
      sentAt: 1_710_000_000_000,
      attachment: file,
    });
    let requests = 0;
    let finish: () => void = () => {};
    const manual = createManualDownloads({
      authorize(key, id) {
        const entry = chat.attachment(key, id);
        if (entry?.url && !privacy.isBlocked(key))
          return { ...entry.file, url: entry.url };
      },
      transfer: (_, signal) => {
        requests++;
        return new Promise<void>((resolve, reject) => {
          finish = resolve;
          signal.addEventListener(
            "abort",
            () => reject(new Error("cancelled")),
            { once: true },
          );
        });
      },
    });
    const rumor = createRumor({
      pubkey: peer,
      kind: fileMessageKind,
      created_at: 1_710_000_000,
      content: file.url,
      tags: [["p", owner], ...fileTags(file)],
    });
    const inbox = createInboxIngestion(
      (event) => unwrapPrivateEvent(event, recipient, privacy.isBlocked),
      (event) => {
        if (event.type !== "attachment") return;
        if (privacy.messagePermission(peer) === "request")
          privacy.queue(toInput(event.id));
        else chat.receive(toInput(event.id));
      },
    );
    for (let i = 0; i < 2; i++) {
      const wrapped = await wrapRumor(ndk, rumor, owner, sender);
      inbox.receive(
        wrapped.id,
        wrapped.rawEvent(),
        () => true,
        () => {},
        i === 1,
      );
    }
    await inbox.drained();
    expect(privacy.request(peer)).toHaveLength(1);
    expect(chat.history(peer).messages).toHaveLength(0);
    expect(requests).toBe(0);
    await expect(manual.download(peer, rumor.id)).rejects.toThrow(
      "media-unavailable",
    );
    expect(privacy.accept(peer)).toBe(true);
    expect(chat.history(peer).messages).toHaveLength(1);
    const row = chat.history(peer).messages[0];
    const recipients = { self: { _id: owner }, peer: { _id: peer } };
    expect(toDetailMessage(row, undefined, recipients, "")).toMatchObject({
      text: "",
      isMediaUnread: true,
      voice: { durationMs: 28_100 },
    });
    expect(
      toDetailMessage(row, undefined, recipients, "").audio,
    ).toBeUndefined();
    expect(chat.refs(peer, [rumor.id]).size).toBe(1);
    const summary = chat.conversations()[0];
    expect(
      toConversationListItem(
        summary,
        owner,
        undefined,
        undefined,
        () => "Voice message · 0:28",
      ).lastMessage?.text,
    ).toBe("Voice message · 0:28");
    const replyId = "cd".repeat(32);
    chat.receive({
      ...toInput(replyId),
      attachment: undefined,
      body: "Reply",
      replyTo: rumor.id,
    });
    const resumed = createMessagingRepository(db);
    const reply = resumed
      .history(peer)
      .messages.find(({ id }) => id === replyId);
    if (!reply) throw new Error("Missing quoted reply");
    expect(
      toDetailMessage(reply, row, recipients, "", "Locked", "Voice message")
        .replyMessage,
    ).toEqual({ _id: row.id, text: "Voice message", user: recipients.peer });
    chat.markRead(peer, [row.id]);
    expect(chat.conversation(peer)?.unread).toBe(1);
    expect(chat.history(peer).messages[0].voice?.listened).toBe(false);
    expect(chat.receive(toInput(rumor.id))).toBe(false);
    expect(requests).toBe(0);
    const download = manual.download(peer, rumor.id);
    expect(manual.download(peer, rumor.id)).toBe(download);
    await Promise.resolve();
    expect(requests).toBe(1);
    manual.cancel(peer, rumor.id);
    await expect(download).rejects.toThrow("cancelled");
    const retry = manual.download(peer, rumor.id);
    await Promise.resolve();
    expect(requests).toBe(2);
    finish();
    await retry;
    expect(chat.history(peer).messages[0].voice?.listened).toBe(false);
  } finally {
    sqlite.close();
  }
});

test("recovers a staged voice outbox row and keeps its ID through reconciliation and a sender replay", () => {
  const { sqlite, db, chat } = database();
  try {
    const peer = NDKPrivateKeySigner.generate().userSync.pubkey;
    const owner = NDKPrivateKeySigner.generate().userSync.pubkey;
    const id = "pending-voice";
    const { url, ...attachment } = file;
    const input: MessageInput = {
      id,
      peerKey: peer,
      senderKey: owner,
      recipientKey: peer,
      direction: "outgoing",
      body: "",
      sentAt: 1_710_000_000_000,
      replyTo: null,
      eventId: null,
      attachment,
    };
    expect(chat.enqueue(input)).toBe(true);
    const reopened = createMessagingRepository(db);
    expect(reopened.pending().map((item) => item.id)).toEqual([id]);
    const rumor = createRumor({
      kind: fileMessageKind,
      pubkey: owner,
      created_at: 1_710_000_000,
      content: url,
      tags: [["p", peer], ...fileTags(file)],
    });
    expect(
      reopened.finalizeAttachment(
        peer,
        id,
        rumor.id,
        url,
        JSON.stringify(rumor),
      ),
    ).toBe(true);
    expect(
      reopened.receive({
        ...input,
        attachment: file,
        id: rumor.id,
        eventId: rumor.id,
      }),
    ).toBe(false);
    expect(reopened.setStatus(id, "sent")).toBe(true);
    expect(reopened.pendingAttachmentCopies().map((item) => item.id)).toEqual([
      id,
    ]);
    reopened.finishAttachmentCopy(id);
    expect(reopened.pendingAttachmentCopies()).toHaveLength(0);
    expect(reopened.history(peer).messages.map((item) => item.id)).toEqual([
      id,
    ]);
  } finally {
    sqlite.close();
  }
});
