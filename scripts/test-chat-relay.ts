import { Database } from "bun:sqlite";
import { mkdtemp, rm, rmdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NDKEvent, NDKPrivateKeySigner } from "@nostr-dev-kit/ndk";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { type Filter, matchFilters } from "nostr-tools/filter";
import type { Event } from "nostr-tools/pure";
import { z } from "zod";
import type { CallSignal } from "../src/core/calling/signals";
import { verifiedEvent } from "../src/core/messaging/nip17";
import { createMessagingService } from "../src/core/messaging/runtime";
import { createMessagingRepository } from "../src/db/messaging";
import migrations from "../src/db/migrations/bundle";
import { preference, setPreference } from "../src/db/queries";
import * as schema from "../src/db/schema";

const encode = (value: unknown) => JSON.stringify(value);
const filtersSchema = z.object({
  kinds: z.array(z.number()).optional(),
  authors: z.array(z.string()).optional(),
  "#p": z.array(z.string()).optional(),
  since: z.number().optional(),
  limit: z.number().optional(),
});
const relayRequest = z.union([
  z.tuple([z.literal("REQ"), z.string()]).rest(filtersSchema),
  z.tuple([z.literal("CLOSE"), z.string()]),
  z.tuple([z.literal("EVENT"), z.unknown()]),
  z.tuple([z.literal("AUTH"), z.unknown()]),
]);
type RelayConnection = {
  challenge: string;
  authorized: string | null;
  subscriptions: Map<string, Filter[]>;
};

function client(seed: string) {
  const sqlite = new Database(":memory:");
  sqlite.exec("PRAGMA foreign_keys = ON");
  for (const migration of Object.values(migrations.migrations))
    sqlite.exec(migration);
  const db = drizzle(sqlite, { schema });
  const chat = createMessagingRepository(db);
  const signer = new NDKPrivateKeySigner(seed.repeat(32));
  const service = createMessagingService({
    signer,
    chat,
    createId: () => crypto.randomUUID(),
    readState: (key) => preference(db, key),
    writeState: (key, value) => setPreference(db, key, value),
  });
  function start(urls: string[], intent: string | null = "initial") {
    service.start({
      general: urls,
      inbox: urls,
      discovery: [],
      intent,
    });
  }
  return {
    service: { ...service, start },
    chat,
    key: signer.pubkey,
    signer,
    sqlite,
  };
}

async function wait(label: string, condition: () => boolean) {
  const expires = Date.now() + 12_000;
  while (!condition()) {
    if (Date.now() >= expires)
      throw new Error(`Timed out waiting for ${label}`);
    await Bun.sleep(20);
  }
}

async function runScenario(tlsDirectory: string) {
  const events = new Map<string, Event>();
  let refuseMessages = false;
  const sockets = new Set<Bun.ServerWebSocket<RelayConnection>>();
  const relay = Bun.serve<RelayConnection>({
    hostname: "127.0.0.1",
    port: 0,
    tls: {
      key: Bun.file(join(tlsDirectory, "key.pem")),
      cert: Bun.file(join(tlsDirectory, "cert.pem")),
    },
    fetch(request, server) {
      if (
        server.upgrade(request, {
          data: {
            subscriptions: new Map(),
            challenge: crypto.randomUUID(),
            authorized: null,
          },
        })
      )
        return;
      return new Response(null, { status: 404 });
    },
    websocket: {
      open(socket) {
        sockets.add(socket);
        socket.send(encode(["AUTH", socket.data.challenge]));
      },
      close(socket) {
        sockets.delete(socket);
      },
      message(socket, payload) {
        const message = relayRequest.parse(JSON.parse(payload.toString()));
        if (message[0] === "REQ") {
          const [, id, ...filters] = message;
          if (
            filters.some(({ kinds }) => kinds?.includes(1059)) &&
            !socket.data.authorized
          ) {
            socket.send(encode(["CLOSED", id, "auth-required: inbox read"]));
            return;
          }
          socket.data.subscriptions.set(id, filters);
          for (const event of events.values()) {
            if (matchFilters(filters, event))
              socket.send(encode(["EVENT", id, event]));
          }
          socket.send(encode(["EOSE", id]));
        } else if (message[0] === "CLOSE") {
          socket.data.subscriptions.delete(message[1]);
        } else {
          const event = verifiedEvent(message[1]);
          if (!event) throw new Error("Relay received an invalid signed event");
          if (message[0] === "AUTH") {
            if (
              event.kind !== 22242 ||
              !event.tags.some(
                ([key, value]) =>
                  key === "challenge" && value === socket.data.challenge,
              )
            ) {
              throw new Error(
                "Relay received an invalid auth challenge signature",
              );
            }
            socket.data.authorized = event.pubkey;
            socket.send(encode(["OK", event.id, true, ""]));
            return;
          }
          if (refuseMessages && event.kind === 1059) {
            socket.send(
              encode(["OK", event.id, false, "blocked: test write refusal"]),
            );
            return;
          }
          if (event.kind === 10050) {
            for (const [key, previous] of events) {
              if (
                previous.kind === event.kind &&
                previous.pubkey === event.pubkey
              )
                events.delete(key);
            }
          }
          events.set(event.id, event);
          socket.send(encode(["OK", event.id, true, ""]));
          for (const peer of sockets) {
            for (const [sub, active] of peer.data.subscriptions) {
              if (matchFilters(active, event))
                peer.send(encode(["EVENT", sub, event]));
            }
          }
        }
      },
    },
  });

  const alice = client("01");
  const bob = client("02");
  const charlie = client("03");
  const url = `wss://127.0.0.1:${relay.port}/`;
  const text = "Encrypted Hello / שלום 🔐";
  try {
    alice.chat.saveDraft(bob.key, text, null);
    const outgoing = await alice.service.send({
      peerKey: bob.key,
      body: text,
      replyTo: null,
    });
    await wait(
      "offline optimistic pending",
      () => alice.chat.message(bob.key, outgoing)?.status === "pending",
    );
    if (alice.chat.conversation(bob.key)?.draft)
      throw new Error("Draft was not cleared");

    bob.service.start([url]);
    await wait("Bob's advertised inbox", () =>
      [...events.values()].some(
        ({ pubkey, kind }) => pubkey === bob.key && kind === 10050,
      ),
    );
    alice.service.start([url]);
    await wait("signed relay authentication", () =>
      [alice.key, bob.key].every((key) =>
        [...sockets].some(({ data }) => data.authorized === key),
      ),
    );
    await wait(
      "recipient relay acceptance",
      () => alice.chat.message(bob.key, outgoing)?.status === "sent",
    );
    await wait(
      "live recipient message",
      () => bob.chat.history(alice.key).messages[0]?.body === text,
    );
    await wait("sender's encrypted copy", () =>
      [...events.values()].some(
        ({ kind, tags }) =>
          kind === 1059 &&
          !tags.some(([tag]) => tag === "expiration") &&
          tags.some(([tag, key]) => tag === "p" && key === alice.key),
      ),
    );
    if (alice.chat.history(bob.key).messages.length !== 1)
      throw new Error("Sender copy duplicated the outgoing message");

    const original = bob.chat.history(alice.key).messages[0];
    await wait("Alice's advertised inbox", () =>
      [...events.values()].some(
        ({ pubkey, kind }) => pubkey === alice.key && kind === 10050,
      ),
    );
    bob.service.toggleReaction({
      peerKey: alice.key,
      messageId: original.id,
      emoji: "❤️",
    });
    await wait(
      "encrypted reaction",
      () => alice.chat.message(bob.key, outgoing)?.reactions[0]?.emoji === "❤️",
    );
    alice.service.stop();
    const reply = await bob.service.send({
      peerKey: alice.key,
      body: "Reply while offline",
      replyTo: original.id,
    });
    await wait(
      "reply relay acceptance",
      () => bob.chat.message(alice.key, reply)?.status === "sent",
    );
    alice.service.start([url]);
    await wait(
      "catch-up after reconnect",
      () => alice.chat.history(bob.key).messages.length === 2,
    );
    const replies = alice.chat.history(bob.key).messages;
    if (
      !replies.some(
        (row) =>
          row.body === "Reply while offline" &&
          row.replyTo === original.eventId,
      )
    ) {
      throw new Error("Reply reference was lost");
    }
    if (alice.chat.conversation(bob.key)?.unread !== 1)
      throw new Error("Incorrect unread count");

    const callSignals: CallSignal[] = [];
    const stopCalls = bob.service.subscribeCalls((signal) =>
      callSignals.push(signal),
    );
    const stamp = Math.floor(Date.now() / 1000) * 1000;
    const signal = {
      type: "call.invite",
      version: 1,
      callId: "ab".repeat(32),
      nonce: "01".repeat(32),
      roomId: "02".repeat(32),
      offer: {
        peerId: "A".repeat(20),
        offerId: "O".repeat(20),
        offer: "opaque",
      },
      senderKey: alice.key,
      recipientKey: bob.key,
      createdAt: stamp,
      expiresAt: stamp + 30_000,
    } satisfies CallSignal;
    if (!(await alice.service.sendCall(signal, () => true))) {
      throw new Error("Relay rejected the call invitation");
    }
    await wait("encrypted call invitation", () =>
      callSignals.some(
        (event) =>
          event.type === "call.invite" &&
          event.roomId === signal.roomId &&
          event.offer.offerId === signal.offer.offerId,
      ),
    );
    const answers: CallSignal[] = [];
    const stopAnswers = alice.service.subscribeCalls((message) =>
      answers.push(message),
    );
    const rtcAnswer = "private-rtc-description".repeat(220);
    const accepted = await bob.service.sendCall(
      {
        type: "call.rtc",
        version: 1,
        callId: signal.callId,
        nonce: "03".repeat(32),
        senderKey: bob.key,
        recipientKey: alice.key,
        createdAt: stamp,
        expiresAt: signal.expiresAt,
        payload: {
          peerId: "B".repeat(20),
          offerId: signal.offer.offerId,
          answer: rtcAnswer,
        },
      },
      () => true,
    );
    if (!accepted) throw new Error("Relay rejected the encrypted RTC answer");
    await wait("encrypted RTC answer", () =>
      answers.some(
        (event) =>
          event.type === "call.rtc" &&
          "answer" in event.payload &&
          event.payload.answer === rtcAnswer,
      ),
    );
    stopAnswers();
    stopCalls();
    if (bob.chat.history(alice.key).messages.length !== 2) {
      throw new Error("Call signaling leaked into chat history");
    }
    if (
      [...events.values()].some(
        ({ kind, content }) =>
          kind !== 10050 &&
          (kind !== 1059 ||
            content.includes(text) ||
            content.includes(rtcAnswer)),
      )
    ) {
      throw new Error("Relay received plaintext or public reactions");
    }

    for (const socket of sockets) socket.close(1012, "Test reconnect");
    await wait(
      "relay disconnect",
      () =>
        alice.service.getStatus() === "offline" &&
        bob.service.getStatus() === "offline",
    );
    await wait(
      "automatic reconnect",
      () =>
        alice.service.getStatus() === "online" &&
        bob.service.getStatus() === "online",
    );
    const afterReconnect = await alice.service.send({
      peerKey: bob.key,
      body: "After reconnect",
      replyTo: null,
    });
    await wait(
      "after-reconnect relay acknowledgment",
      () => alice.chat.message(bob.key, afterReconnect)?.status === "sent",
    );
    await wait("after-reconnect live message", () =>
      bob.chat
        .history(alice.key)
        .messages.some(({ body }) => body === "After reconnect"),
    );

    const noInbox = await alice.service.send({
      peerKey: charlie.key,
      body: "Wait for an inbox",
      replyTo: null,
    });
    await wait(
      "missing inbox failure",
      () => alice.chat.message(charlie.key, noInbox)?.failure === "no-inbox",
    );
    const canonical = alice.chat.message(charlie.key, noInbox)?.eventId;
    if (!canonical) throw new Error("Failed message lost its canonical ID");
    if (
      [...events.values()].some(({ tags }) =>
        tags.some(([tag, key]) => tag === "p" && key === charlie.key),
      )
    ) {
      throw new Error("The client published without a recipient inbox");
    }
    charlie.service.start([url]);
    await wait("Charlie's advertised inbox", () =>
      [...events.values()].some(
        ({ pubkey, kind }) => pubkey === charlie.key && kind === 10050,
      ),
    );
    alice.service.retry(charlie.key, noInbox);
    await wait(
      "failed message retry",
      () => alice.chat.message(charlie.key, noInbox)?.status === "sent",
    );
    await wait(
      "retried message received",
      () => charlie.chat.history(alice.key).messages[0]?.eventId === canonical,
    );

    refuseMessages = true;
    const refused = await alice.service.send({
      peerKey: bob.key,
      body: "Rejected by this relay",
      replyTo: null,
    });
    await wait(
      "relay refusal",
      () => alice.chat.message(bob.key, refused)?.failure === "relay-rejected",
    );
    if (
      bob.chat
        .history(alice.key)
        .messages.some(({ body }) => body === "Rejected by this relay")
    )
      throw new Error("A rejected event reached the inbox");
    refuseMessages = false;

    charlie.service.stop();
    const existing = new NDKEvent(undefined, {
      kind: 10050,
      tags: [],
      created_at: Math.floor(Date.now() / 1000) + 10,
    });
    await existing.sign(charlie.signer);
    const signed = verifiedEvent(existing.rawEvent());
    if (!signed) throw new Error("External inbox list was not signed");
    for (const [id, event] of events)
      if (event.pubkey === charlie.key && event.kind === 10050)
        events.delete(id);
    events.set(signed.id, signed);
    charlie.service.start([url], null);
    await wait(
      "external inbox conflict",
      () => charlie.service.getInboxStatus() === "conflict",
    );
    if (!events.has(signed.id))
      throw new Error("The client replaced a published list without approval");
    charlie.service.start([url], "explicit-test-change");
    await wait(
      "explicit inbox reconciliation",
      () => charlie.service.getInboxStatus() === "published",
    );
    if (events.has(signed.id))
      throw new Error("The relay did not replace the old inbox list");

    console.log(
      "TLS relay verified encrypted messaging and call invitations, NIP-42 inbox reads, write refusal, inbox publication and reconciliation, sender deduplication, catch-up, reconnect, and stable retries.",
    );
  } finally {
    alice.service.stop();
    bob.service.stop();
    charlie.service.stop();
    await relay.stop(true);
    alice.sqlite.close();
    bob.sqlite.close();
    charlie.sqlite.close();
  }
}

async function runWithTemporaryCertificate() {
  const dir = await mkdtemp(join(tmpdir(), "boop-chat-relay-"));
  try {
    const cert = join(dir, "cert.pem");
    const { success } = Bun.spawnSync(
      [
        "openssl",
        "req",
        "-x509",
        "-newkey",
        "rsa:2048",
        "-noenc",
        "-days",
        "1",
        "-keyout",
        join(dir, "key.pem"),
        "-out",
        cert,
        "-subj",
        "/CN=127.0.0.1",
        "-addext",
        "subjectAltName=IP:127.0.0.1",
      ],
      { stderr: "ignore" },
    );
    if (!success)
      throw new Error("OpenSSL could not create the loopback TLS certificate");
    const check = Bun.spawnSync([process.execPath, import.meta.path, dir], {
      env: { ...process.env, NODE_EXTRA_CA_CERTS: cert },
      stdout: "inherit",
      stderr: "inherit",
    });
    if (!check.success) process.exitCode = check.exitCode || 1;
  } finally {
    await Promise.all(
      ["key.pem", "cert.pem"].map((name) =>
        rm(join(dir, name), { force: true }),
      ),
    );
    await rmdir(dir);
  }
}

const tlsDirectory = process.argv[2];
if (tlsDirectory) {
  await runScenario(tlsDirectory);
  // NDK 3.0.3 keeps its relay validation timers alive after disconnect.
  process.exit(0);
} else {
  await runWithTemporaryCertificate();
}
