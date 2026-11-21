import { parseProfile } from "../src/core/avatars/protocol";
import { expect, spyOn, test } from "bun:test";
import {
  NDKEvent,
  NDKPrivateKeySigner,
  NDKRelayStatus,
} from "@nostr-dev-kit/ndk";
import { finalizeEvent } from "nostr-tools/pure";
import { createMessagingRelays } from "../src/core/nostr/messaging-relays";

test("late relay connections remain registered across configuration changes", () => {
  const error = spyOn(console, "error").mockImplementation(() => {});
  try {
    const transport = createMessagingRelays(
      new NDKPrivateKeySigner("01".repeat(32)),
    );
    const address = "wss://relay.example/";
    const relay = transport.addConfigured(address, true);
    transport.unconfigure(relay);
    relay.emit("connect");
    expect(error).not.toHaveBeenCalled();
    expect(transport.addConfigured(address, true)).toBe(relay);
    transport.unconfigure(relay);
  } finally {
    error.mockRestore();
  }
});

test("a responsive relay acknowledges call setup while another relay is still waiting", async () => {
  const secondWrite = Promise.withResolvers<void>();
  const firstAck = Promise.withResolvers<void>();
  function relay(hold?: Promise<void>) {
    return Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request, server) {
        if (server.upgrade(request)) return undefined;
        return new Response(null, { status: 400 });
      },
      websocket: {
        async message(ws, data) {
          const input: unknown = JSON.parse(String(data));
          if (!Array.isArray(input) || input[0] !== "EVENT") return;
          if (hold) {
            secondWrite.resolve();
            await hold;
          }
          ws.send(JSON.stringify(["OK", input[1].id, true, ""]));
          if (!hold) firstAck.resolve();
        },
      },
    });
  }
  const release = Promise.withResolvers<void>();
  const servers = [relay(), relay(release.promise)];
  const signer = new NDKPrivateKeySigner("01".repeat(32));
  const transport = createMessagingRelays(signer);
  const urls = servers.map((server) => `ws://127.0.0.1:${server.port}/`);
  try {
    const event = new NDKEvent(undefined, {
      kind: 1059,
      content: "test envelope",
    });
    await event.sign(signer);
    const result = transport.publish(event, urls, () => true);
    expect(
      await Promise.race([
        Promise.all([firstAck.promise, secondWrite.promise]).then(() => true),
        Bun.sleep(1_000).then(() => false),
      ]),
    ).toBe(true);
    expect(
      await Promise.race([result, Bun.sleep(150).then(() => "waiting")]),
    ).toBe(true);
    release.resolve();
    await result;
  } finally {
    release.resolve();
    transport.closePeerRelays();
    for (const server of servers) void server.stop(true);
  }
});

test("ringing and answer share an in-flight verified inbox lookup within one call", async () => {
  const target = "wss://relay.damus.io/";
  const peer = new NDKPrivateKeySigner("02".repeat(32));
  const list = finalizeEvent(
    {
      kind: 10050,
      content: "",
      tags: [["relay", target]],
      created_at: Math.floor(Date.now() / 1000),
    },
    Uint8Array.from({ length: 32 }, () => 2),
  );
  const release = Promise.withResolvers<void>();
  let requests = 0;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request, server) {
      if (server.upgrade(request)) return undefined;
      return new Response(null, { status: 400 });
    },
    websocket: {
      async message(ws, data) {
        const input: unknown = JSON.parse(String(data));
        if (!Array.isArray(input) || input[0] !== "REQ") return;
        requests++;
        await release.promise;
        ws.send(JSON.stringify(["EVENT", input[1], list]));
        ws.send(JSON.stringify(["EOSE", input[1]]));
      },
    },
  });
  const transport = createMessagingRelays(
    new NDKPrivateKeySigner("01".repeat(32)),
  );
  const relay = transport.addConfigured(
    `ws://127.0.0.1:${server.port}/`,
    false,
  );
  try {
    expect(await transport.connect(relay)).toBe(true);
    expect(relay.status).toBe(NDKRelayStatus.CONNECTED);
    const ringing = transport.findCallInbox("call-a", peer.pubkey, [relay]);
    const answer = transport.findCallInbox("call-a", peer.pubkey, [relay]);
    release.resolve();
    expect(await Promise.all([ringing, answer])).toEqual([[target], [target]]);
    expect(
      await transport.findCallInbox("call-a", peer.pubkey, [relay]),
    ).toEqual([target]);
    expect(requests).toBe(1);
    expect(
      await transport.findCallInbox("call-b", peer.pubkey, [relay]),
    ).toEqual([target]);
    expect(requests).toBe(2);
  } finally {
    release.resolve();
    transport.unconfigure(relay);
    transport.closePeerRelays();
    void server.stop(true);
  }
});

test("a signed profile publishes only after relay acknowledgment and is discovered live", async () => {
  const signer = new NDKPrivateKeySigner("01".repeat(32));
  const author = signer.pubkey;
  const watched = Promise.withResolvers<void>();
  const received = Promise.withResolvers<unknown>();
  const transport = createMessagingRelays(signer);
  let subscriptionId: string | undefined;
  let accepts = true;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request, server) {
      if (server.upgrade(request)) return;
      return new Response(null, { status: 400 });
    },
    websocket: {
      message(ws, data) {
        const frame: unknown = JSON.parse(String(data));
        if (!Array.isArray(frame)) return;
        if (frame[0] === "REQ" && typeof frame[1] === "string") {
          subscriptionId = frame[1];
          expect(frame[2]).toMatchObject({ kinds: [0], authors: [author] });
          ws.send(JSON.stringify(["EOSE", subscriptionId]));
        }
        if (frame[0] === "EVENT") {
          ws.send(
            JSON.stringify([
              "OK",
              frame[1].id,
              accepts,
              accepts ? "" : "blocked: test refusal",
            ]),
          );
          if (accepts && subscriptionId)
            ws.send(JSON.stringify(["EVENT", subscriptionId, frame[1]]));
        }
      },
    },
  });
  const url = `ws://127.0.0.1:${server.port}/`;
  const relay = transport.addConfigured(url, false);
  const content = JSON.stringify({
    picture: "https://media.example.com/a.jpg",
    about: "Preserved",
  });
  const timestamp = Math.floor(Date.now() / 1000);
  let close: (() => void) | undefined;
  try {
    expect(await transport.connect(relay)).toBe(true);
    close = transport.watchProfiles(
      [relay],
      [author],
      (event, key) => {
        expect(key).toBe(author);
        received.resolve(event);
      },
      watched.resolve,
    );
    await watched.promise;
    const event = await transport.publishProfile(
      content,
      timestamp,
      [url],
      () => true,
    );
    const remote = await received.promise;
    expect(parseProfile(event, author)?.fields).toEqual(JSON.parse(content));
    expect(parseProfile(remote, author)?.eventId).toBe(event?.id);
    accepts = false;
    expect(
      await transport.publishProfile("{}", timestamp + 1, [url], () => true),
    ).toBeNull();
  } finally {
    close?.();
    transport.unconfigure(relay);
    server.stop(true);
  }
});
