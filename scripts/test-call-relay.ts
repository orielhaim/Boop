import { NDKPrivateKeySigner } from "@nostr-dev-kit/ndk";
import { mkdtemp, rm, rmdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { matchFilters } from "nostr-tools/filter";
import { z } from "zod";
import { createCallSignalingService } from "../src/core/calling/signaling-service";
import type { CallSignal, InviteSignal } from "../src/core/calling/signals";
import { verifiedEvent } from "../src/core/nostr/gift-wrap";
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

function client(seed: string) {
  const signer = new NDKPrivateKeySigner(seed.repeat(32));
  const state = new Map<string, string>();
  const relays = createRelayService({
    signer,
    readState: (key) => state.get(key) ?? null,
    writeState: (key, value) => {
      state.set(key, value);
    },
  });
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
    start(url: string) {
      signaling.start();
      relays.start({
        general: [url],
        inbox: [url],
        discovery: [],
        intent: "initial",
      });
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

async function runScenario(tls: string) {
  const events = new Map<string, Event>();
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
  const alice = client("01");
  const bob = client("02");
  try {
    const url = `wss://127.0.0.1:${relay.port}/`;
    alice.start(url);
    bob.start(url);
    await waitFor("inbox advertisements", () =>
      [alice, bob].every(
        ({ relays }) => relays.getInboxStatus() === "published",
      ),
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
    await relay.stop(true);
  }
}

const directory = process.argv[2];
if (directory) {
  await runScenario(directory);
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
