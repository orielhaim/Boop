import { NDKEvent, NDKPrivateKeySigner } from "@nostr-dev-kit/ndk";
import { mkdtemp, rm, rmdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { matchFilters } from "nostr-tools/filter";
import { z } from "zod";
import {
  callReplyRelayTag,
  createCallSignalingService,
} from "../src/core/calling/signaling-service";
import {
  type CallSignal,
  type InviteSignal,
  type JoinSignal,
  callSignalKind,
} from "../src/core/calling/signals";
import { type CallHandoff, readCallHandoff } from "../src/core/nostr/config";
import { unsignedRumor, verifiedEvent } from "../src/core/nostr/gift-wrap";
import { createRelayService } from "../src/core/nostr/relay-service";

const filter = z.object({
  kinds: z.array(z.number()).optional(),
  authors: z.array(z.string()).optional(),
  ids: z.array(z.string()).optional(),
  "#p": z.array(z.string()).optional(),
  since: z.number().optional(),
  limit: z.number().optional(),
});
const requests = z.union([
  z.tuple([z.literal("REQ"), z.string()]).rest(filter),
  z.tuple([z.literal("CLOSE"), z.string()]),
  z.tuple([z.literal("EVENT"), z.unknown()]),
  z.tuple([z.literal("AUTH"), z.unknown()]),
]);
type Connection = {
  challenge: string;
  filters: Map<string, z.infer<typeof filter>[]>;
  auth?: string;
};
type Event = NonNullable<ReturnType<typeof verifiedEvent>>;

function client(
  seed: string,
  previous: CallHandoff = [],
  save?: (rows: CallHandoff) => void,
) {
  const signer = new NDKPrivateKeySigner(seed.repeat(32));
  const relays = createRelayService(signer, previous, save);
  const blocks = new Set<string>();
  const signaling = createCallSignalingService({
    signer,
    relays,
    isBlocked: (key) => blocks.has(key),
    canReceiveCall: () => true,
  });
  const received: CallSignal[] = [];
  signaling.subscribe((signal) => received.push(signal));
  return {
    key: signer.pubkey,
    relays,
    signaling,
    received,
    blocks,
    async publishJoin(
      signal: JoinSignal,
      destination: string,
      hints: string[],
    ) {
      const rumor = unsignedRumor({
        kind: callSignalKind,
        pubkey: signer.pubkey,
        content: JSON.stringify(signal),
        tags: [
          ["p", signal.recipientKey],
          ...hints.map((url) => [callReplyRelayTag, url]),
        ],
        created_at: signal.createdAt / 1_000,
      });
      const wrap = await relays.transport.wrap(rumor, signal.recipientKey);
      if (!(await relays.transport.publish(wrap, [destination], () => true)))
        throw new Error("Could not publish test join request");
    },
    async declaration(url: string) {
      const event = new NDKEvent(undefined, {
        kind: 10050,
        content: "",
        tags: [["relay", url]],
      });
      await event.sign(signer);
      const declared = verifiedEvent(event.rawEvent());
      if (!declared) throw new Error("Invalid relay declaration fixture");
      return declared;
    },
    configure(url: string, discovery: string[] = []) {
      relays.configure(
        { general: [url], write: [url], inbox: [url], discovery },
        true,
        [],
      );
    },
    start(url: string, discovery: string[] = []) {
      signaling.start();
      this.configure(url, discovery);
      relays.start();
    },
    stop() {
      signaling.stop();
      relays.stop();
    },
  };
}

async function waitFor(description: string, condition: () => boolean) {
  const until = Date.now() + 15_000;
  while (Date.now() < until) {
    if (condition()) return;
    await Bun.sleep(30);
  }
  throw new Error(`Timed out waiting for ${description}`);
}

function startRelay(tls: string) {
  const events = new Map<string, Event>();
  const lookups: string[] = [];
  let rejectedWrites = 0;
  let rejectRecipient: string | undefined;
  const sockets = new Set<Bun.ServerWebSocket<Connection>>();
  const relay = Bun.serve<Connection>({
    hostname: "127.0.0.1",
    port: 0,
    tls: {
      key: Bun.file(join(tls, "key.pem")),
      cert: Bun.file(join(tls, "cert.pem")),
    },
    fetch(request, server) {
      if (
        server.upgrade(request, {
          data: { challenge: crypto.randomUUID(), filters: new Map() },
        })
      )
        return;
      return new Response("Call relay fixture", { status: 400 });
    },
    websocket: {
      open(socket) {
        sockets.add(socket);
      },
      close(socket) {
        sockets.delete(socket);
      },
      message(socket, message) {
        let body: unknown;
        try {
          body = JSON.parse(String(message));
        } catch {
          return;
        }
        const parsed = requests.safeParse(body);
        if (!parsed.success) return;
        const [command, value] = parsed.data;
        const send = (body: unknown) => socket.send(JSON.stringify(body));
        if (command === "CLOSE") {
          socket.data.filters.delete(value);
          return;
        }
        if (command === "REQ") {
          const [_, id, ...filters] = parsed.data;
          for (const row of filters) {
            if (row.kinds?.includes(10050))
              lookups.push(...(row.authors ?? []));
          }
          if (
            filters.some(
              (row) =>
                row.kinds?.includes(1059) &&
                !row["#p"]?.includes(socket.data.auth ?? ""),
            )
          ) {
            send(["AUTH", socket.data.challenge]);
            send(["CLOSED", id, "auth-required: Authenticate for your inbox"]);
            return;
          }
          socket.data.filters.set(id, filters);
          for (const event of events.values()) {
            if (
              matchFilters(
                filters.filter((row) => row.limit !== 0),
                event,
              )
            )
              send(["EVENT", id, event]);
          }
          send(["EOSE", id]);
          return;
        }
        const signed = verifiedEvent(value);
        if (!signed) return;
        if (command === "AUTH") {
          const valid =
            signed.kind === 22242 &&
            signed.tags.some(
              ([tag, body]) =>
                tag === "challenge" && body === socket.data.challenge,
            );
          if (valid) socket.data.auth = signed.pubkey;
          send(["OK", signed.id, valid, valid ? "" : "invalid: challenge"]);
          return;
        }
        if (
          rejectRecipient &&
          signed.kind === 1059 &&
          signed.tags.some(
            ([tag, key]) => tag === "p" && key === rejectRecipient,
          )
        ) {
          rejectedWrites++;
          send(["OK", signed.id, false, "blocked: fixture route unavailable"]);
          return;
        }
        events.set(signed.id, signed);
        send(["OK", signed.id, true, ""]);
        for (const peer of sockets) {
          for (const [id, filters] of peer.data.filters) {
            if (matchFilters(filters, signed))
              peer.send(JSON.stringify(["EVENT", id, signed]));
          }
        }
      },
    },
  });
  return {
    events,
    lookups,
    url: `wss://127.0.0.1:${relay.port}/`,
    rejectCallsTo(key: string) {
      rejectRecipient = key;
    },
    rejectedWrites: () => rejectedWrites,
    withdrawInbox(key: string) {
      const records = [...events.values()].filter(
        (event) => event.kind === 10050 && event.pubkey === key,
      );
      for (const record of records) events.delete(record.id);
      return () => {
        for (const record of records) events.set(record.id, record);
      };
    },
    stop: () => relay.stop(true),
  };
}

async function runScenario(tls: string) {
  const relay = startRelay(tls);
  const alice = client("01");
  const bob = client("02");
  try {
    const { url, events } = relay;
    alice.start(url);
    bob.start(url);
    for (const client of [alice, bob]) {
      const event = await client.declaration(url);
      events.set(event.id, event);
    }
    await waitFor("inbox listeners", () =>
      [alice, bob].every(({ relays }) => relays.inboxRelays().length > 0),
    );
    const createdAt = Math.floor(Date.now() / 1_000) * 1_000;
    const opaque = "relayed opaque offer";
    const invitation: InviteSignal = {
      version: 1,
      type: "call.invite",
      callId: "ab".repeat(32),
      nonce: "01".repeat(32),
      roomId: "02".repeat(32),
      senderKey: alice.key,
      recipientKey: bob.key,
      createdAt,
      expiresAt: createdAt + 30_000,
      offer: { peerId: "A".repeat(20), offerId: "O".repeat(20), offer: opaque },
    };
    if (!(await alice.signaling.send(invitation, () => true)))
      throw new Error("Call publication failed");
    await waitFor("first-contact invitation", () =>
      bob.received.some((event) => event.nonce === invitation.nonce),
    );
    if (!(await alice.signaling.send(invitation, () => true)))
      throw new Error("Replay publication failed");
    const answer = "relayed opaque answer";
    if (
      !(await bob.signaling.send(
        {
          version: 1,
          type: "call.rtc",
          callId: invitation.callId,
          nonce: "03".repeat(32),
          senderKey: bob.key,
          recipientKey: alice.key,
          createdAt,
          expiresAt: invitation.expiresAt,
          payload: {
            peerId: "B".repeat(20),
            offerId: invitation.offer.offerId,
            answer,
          },
        },
        () => true,
      ))
    )
      throw new Error("RTC publication failed");
    await waitFor("RTC answer", () =>
      alice.received.some(
        (event) =>
          event.type === "call.rtc" &&
          "answer" in event.payload &&
          event.payload.answer === answer,
      ),
    );
    if (
      bob.received.filter((event) => event.nonce === invitation.nonce)
        .length !== 1
    )
      throw new Error("Replayed invitation reached listeners");
    if (
      [...events.values()].some(
        (event) =>
          (event.kind !== 10050 && event.kind !== 1059) ||
          event.content.includes(opaque) ||
          event.content.includes(answer),
      )
    ) {
      throw new Error("Relay saw unencrypted call data");
    }
    console.info(
      "Verified first-contact call signaling, replay suppression, and private RTC replies through a TLS relay.",
    );
  } finally {
    alice.stop();
    bob.stop();
    await relay.stop();
  }
}

async function runJoinScenario(tls: string) {
  const aliceInbox = startRelay(tls);
  const bobInbox = startRelay(tls);
  const alice = client("01");
  const bob = client("02");
  try {
    // The local fixture URLs are explicitly configured so the production
    // private-address policy accepts them. Each client watches only its inbox.
    alice.start(aliceInbox.url, [bobInbox.url]);
    bob.start(bobInbox.url, [aliceInbox.url]);
    for (const [client, inbox] of [
      [alice, aliceInbox],
      [bob, bobInbox],
    ] as const) {
      const event = await client.declaration(inbox.url);
      for (const relay of [aliceInbox, bobInbox])
        relay.events.set(event.id, event);
    }
    await waitFor("separate inbox listeners", () =>
      [alice, bob].every(({ relays }) => relays.inboxRelays().length > 0),
    );
    const createdAt = Math.floor(Date.now() / 1_000) * 1_000;
    const request: JoinSignal = {
      version: 1,
      type: "call.join",
      callId: "ac".repeat(32),
      nonce: "04".repeat(32),
      groupId: "06".repeat(32),
      senderKey: bob.key,
      recipientKey: alice.key,
      createdAt,
      expiresAt: createdAt + 30_000,
    };
    const bobLookups = () =>
      [...aliceInbox.lookups, ...bobInbox.lookups].filter(
        (key) => key === bob.key,
      ).length;
    async function reply(join: JoinSignal) {
      await alice.signaling.prepareRoute(join.callId, bob.key);
      const accepted = await alice.signaling.send(
        {
          version: 1,
          type: "call.invite",
          callId: join.callId,
          groupId: join.groupId,
          joinNonce: join.nonce,
          nonce: "05".repeat(32),
          roomId: "07".repeat(32),
          senderKey: alice.key,
          recipientKey: bob.key,
          createdAt,
          expiresAt: join.expiresAt,
          offer: {
            peerId: "A".repeat(20),
            offerId: "O".repeat(20),
            offer: "relayed group offer",
          },
        },
        () => true,
      );
      if (!accepted) throw new Error("Group join reply was not published");
      await waitFor("correlated group join reply", () =>
        bob.received.some(
          (event) =>
            event.type === "call.invite" && event.joinNonce === join.nonce,
        ),
      );
    }
    const baseline = bobLookups();
    const restoreAliceIndex = aliceInbox.withdrawInbox(bob.key);
    const restoreBobIndex = bobInbox.withdrawInbox(bob.key);
    if (!(await bob.signaling.send(request, () => true)))
      throw new Error("Group join was not published");
    await waitFor("join on Alice's inbox", () =>
      alice.received.some((event) => event.nonce === request.nonce),
    );
    await reply(request);
    if (bobLookups() !== baseline)
      throw new Error("A usable join reply hint triggered redundant discovery");
    restoreAliceIndex();
    restoreBobIndex();

    // The relay is trusted as a destination, but rejects this particular write.
    aliceInbox.rejectCallsTo(bob.key);
    const fallback = {
      ...request,
      callId: "ad".repeat(32),
      nonce: "08".repeat(32),
    };
    await bob.publishJoin(fallback, aliceInbox.url, [
      aliceInbox.url.replace("wss:", "ws:"),
      aliceInbox.url,
    ]);
    await waitFor("join with an unavailable reply route", () =>
      alice.received.some((event) => event.nonce === fallback.nonce),
    );
    await reply(fallback);
    if (aliceInbox.rejectedWrites() !== 1 || bobLookups() <= baseline)
      throw new Error(
        "Unavailable join reply route did not fall back to discovery",
      );
    const afterFallback = bobLookups();
    await alice.signaling.prepareRoute("af".repeat(32), bob.key);
    if (bobLookups() <= afterFallback)
      throw new Error("A join reply route leaked into another call");

    await bob.publishJoin(request, aliceInbox.url, [bobInbox.url]);
    await bob.publishJoin(
      { ...request, nonce: "09".repeat(32), senderKey: alice.key },
      aliceInbox.url,
      [bobInbox.url],
    );
    await bob.publishJoin(
      {
        ...request,
        nonce: "0a".repeat(32),
        createdAt: createdAt - 60_000,
        expiresAt: createdAt - 30_000,
      },
      aliceInbox.url,
      [bobInbox.url],
    );
    alice.blocks.add(bob.key);
    await bob.publishJoin(
      { ...request, nonce: "0b".repeat(32) },
      aliceInbox.url,
      [bobInbox.url],
    );
    await Bun.sleep(250);
    if (alice.received.length !== 2)
      throw new Error(
        "Replayed, forged, expired or blocked join reached listeners",
      );
    console.info(
      "Verified group join replies across separate TLS inboxes with authenticated hints and discovery fallback.",
    );
  } finally {
    alice.stop();
    bob.stop();
    await Promise.all([aliceInbox.stop(), bobInbox.stop()]);
  }
}

async function runHandoffScenario(tls: string) {
  const old = startRelay(tls);
  const next = startRelay(tls);
  const sender = client("03");
  let saved = "";
  const original = client("04", [], (rows) => {
    saved = JSON.stringify(rows);
  });
  const receiver = () => client("04", readCallHandoff(saved));
  let reopened: ReturnType<typeof receiver> | undefined;
  try {
    original.start(old.url);
    const event = await original.declaration(old.url);
    old.events.set(event.id, event);
    await waitFor(
      "old inbox",
      () => original.relays.inboxRelays().length === 1,
    );
    const release = await original.relays.prepareInbox(
      [next.url],
      [old.url],
      () => true,
    );
    if (!release)
      throw new Error("New authenticated inbox did not pass envelope readback");
    original.configure(next.url);
    release();
    original.stop();

    reopened = receiver();
    reopened.start(next.url);
    await waitFor(
      "old route restored after restart",
      () => reopened?.relays.inboxRelays().length === 2,
    );
    const replies = reopened.relays.replyRelays();
    if (replies.length !== 1 || replies[0]?.url !== next.url)
      throw new Error("Old inbox was offered as a new reply route");

    const createdAt = Math.floor(Date.now() / 1_000) * 1_000;
    const join: JoinSignal = {
      version: 1,
      type: "call.join",
      callId: "bb".repeat(32),
      nonce: "10".repeat(32),
      groupId: "11".repeat(32),
      senderKey: sender.key,
      recipientKey: original.key,
      createdAt,
      expiresAt: createdAt + 30_000,
    };
    await sender.publishJoin(join, old.url, []);
    await waitFor(
      "call arriving over a previously advertised inbox",
      () => reopened?.received[0]?.nonce === join.nonce,
    );
    if (
      [...old.events.values(), ...next.events.values()].filter(
        ({ kind }) => kind === 10050 || kind === 10002,
      ).length !== 1
    )
      throw new Error("Call transport published a relay declaration");
    console.info(
      "Verified authenticated inbox preparation, restart-safe handoff, and no NDK relay-list publication.",
    );
  } finally {
    sender.stop();
    original.stop();
    reopened?.stop();
    await Promise.all([old.stop(), next.stop()]);
  }
}

const directory = process.argv[2];
if (directory) {
  await runScenario(directory);
  await runJoinScenario(directory);
  await runHandoffScenario(directory);
  process.exit(0);
} else {
  const temp = await mkdtemp(join(tmpdir(), "boop-call-relay-"));
  const certificate = join(temp, "cert.pem");
  try {
    const certificateResult = Bun.spawnSync(
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
        join(temp, "key.pem"),
        "-out",
        certificate,
        "-subj",
        "/CN=127.0.0.1",
        "-addext",
        "subjectAltName=IP:127.0.0.1",
      ],
      { stderr: "ignore" },
    );
    if (!certificateResult.success)
      throw new Error("OpenSSL could not create the fixture certificate");
    const child = Bun.spawnSync([process.execPath, import.meta.path, temp], {
      env: { ...process.env, NODE_EXTRA_CA_CERTS: certificate },
      stdout: "inherit",
      stderr: "inherit",
    });
    if (!child.success) process.exitCode = child.exitCode || 1;
  } finally {
    await rm(join(temp, "key.pem"), { force: true });
    await rm(certificate, { force: true });
    await rmdir(temp);
  }
}
