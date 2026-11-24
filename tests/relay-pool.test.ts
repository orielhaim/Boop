import { parseServerOrigins, serverListKind } from "../src/core/media/servers";
import { expect, spyOn, test } from "bun:test";
import {
  NDKEvent,
  NDKPrivateKeySigner,
  NDKRelayStatus,
} from "@nostr-dev-kit/ndk";
import { finalizeEvent } from "nostr-tools/pure";
import { createNostrRelays } from "../src/core/nostr/relays-transport";

test("removed relay callbacks cannot affect a replacement connection", () => {
  const error = spyOn(console, "error").mockImplementation(() => {});
  try {
    const transport = createNostrRelays(
      new NDKPrivateKeySigner("01".repeat(32)),
    );
    const address = "wss://relay.example/";
    const relay = transport.addConfigured(address, true);
    transport.unconfigure(relay);
    relay.emit("connect");
    expect(error).not.toHaveBeenCalled();
    const replacement = transport.addConfigured(address, true);
    expect(replacement).not.toBe(relay);
    transport.unconfigure(replacement);
  } finally {
    error.mockRestore();
  }
});

test("removing a relay during a handshake prevents an NDK redial", async () => {
  const firstRequest = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let requests = 0;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch() {
      requests++;
      firstRequest.resolve();
      await release.promise;
      return new Response(null, { status: 503 });
    },
  });
  const transport = createNostrRelays(new NDKPrivateKeySigner("01".repeat(32)));
  const relay = transport.addConfigured(
    `ws://127.0.0.1:${server.port}/`,
    false,
  );
  try {
    await relay.connect(40);
    await firstRequest.promise;
    transport.unconfigure(relay);
    await Bun.sleep(150);
    expect(requests).toBe(1);
  } finally {
    release.resolve();
    relay.connectivity.resetReconnectionState();
    relay.disconnect();
    await server.stop(true);
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
  const transport = createNostrRelays(signer);
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
  const transport = createNostrRelays(new NDKPrivateKeySigner("01".repeat(32)));
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

test("Blossom list publication uses acknowledged relay events", async () => {
  const signer = new NDKPrivateKeySigner("01".repeat(32));
  const author = signer.pubkey;
  const transport = createNostrRelays(signer);
  let subscriptionId: string | undefined;
  let accepts = true;
  const timestamp = Math.floor(Date.now() / 1000);
  let mediaList: unknown;
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
          const filters = frame[2];
          if (filters?.kinds?.[0] === serverListKind) {
            expect(filters).toMatchObject({
              kinds: [serverListKind],
              authors: [author],
            });
            if (mediaList)
              ws.send(JSON.stringify(["EVENT", subscriptionId, mediaList]));
          }
          ws.send(JSON.stringify(["EOSE", subscriptionId]));
        }
        if (frame[0] === "EVENT") {
          if (accepts && frame[1].kind === serverListKind) mediaList = frame[1];
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
  try {
    expect(await transport.connect(relay)).toBe(true);
    const origins = ["https://second.example.com", "https://first.example.com"];
    const published = await transport.publishServerList(
      origins.map((origin) => ["server", origin]),
      timestamp,
      [url],
      () => true,
    );
    const discovered = await transport.lookupLists(
      author,
      [relay],
      [serverListKind],
    );
    expect(discovered.complete).toBe(true);
    expect(discovered.general?.id).toBe(published?.id);
    expect(parseServerOrigins(discovered.general?.tags ?? [])).toEqual(origins);
  } finally {
    transport.unconfigure(relay);
    server.stop(true);
  }
});

test("off-graph relay search returns verified keys and suppresses later results on cancellation", async () => {
  const secret = Uint8Array.from({ length: 32 }, () => 2);
  const profile = finalizeEvent(
    {
      kind: 0,
      created_at: Math.floor(Date.now() / 1000),
      tags: [],
      content: JSON.stringify({ name: "Uncached user" }),
    },
    secret,
  );
  const late = finalizeEvent(
    {
      kind: 0,
      created_at: profile.created_at,
      tags: [],
      content: profile.content,
    },
    Uint8Array.from({ length: 32 }, () => 3),
  );
  const transport = createNostrRelays(new NDKPrivateKeySigner("01".repeat(32)));
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request, server) {
      return server.upgrade(request)
        ? undefined
        : new Response(null, { status: 400 });
    },
    websocket: {
      message(socket, data) {
        const [type, id, filter] = JSON.parse(String(data));
        if (type === "REQ") {
          expect(filter).toMatchObject({ kinds: [0], search: "Uncached" });
          socket.send(JSON.stringify(["EVENT", id, profile]));
          setTimeout(
            () => socket.send(JSON.stringify(["EVENT", id, late])),
            30,
          );
        }
      },
    },
  });
  const relay = transport.addConfigured(
    `ws://127.0.0.1:${server.port}/`,
    false,
  );
  const controller = new AbortController();
  const found: string[] = [];
  try {
    expect(await transport.connect(relay)).toBe(true);
    await transport.discoverProfileKeys(
      [relay],
      "Uncached",
      (key) => {
        found.push(key);
        controller.abort();
      },
      controller.signal,
    );
    await Bun.sleep(60);
    expect(found).toEqual([profile.pubkey]);
  } finally {
    controller.abort();
    transport.unconfigure(relay);
    server.stop(true);
  }
}, 9_000);
