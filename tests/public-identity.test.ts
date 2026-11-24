import { getPublicKey } from "nostr-tools/pure";
import { expect, test } from "bun:test";
import { nprofileEncode } from "nostr-tools/nip19";
import { toNpub, parsePublicIdentity } from "../src/core/identity/keys";
import { nip05Address, nip05Key } from "../src/core/nostr/nip05";

const secret = "01".repeat(32);
const publicKey = getPublicKey(Buffer.from(secret, "hex"));
const npub = toNpub(publicKey);

test("public address inputs resolve the same key and keep only bounded public relay hints", () => {
  const profile = nprofileEncode({
    pubkey: publicKey,
    relays: ["wss://relay.damus.io", "ws://relay.damus.io", "wss://127.0.0.1"],
  });
  expect(parsePublicIdentity(`nostr:${profile}`)).toEqual({
    key: publicKey,
    relays: ["wss://relay.damus.io/"],
  });
  for (const value of [publicKey.toUpperCase(), npub, `nostr:${npub}`])
    expect(parsePublicIdentity(value)).toEqual({ key: publicKey, relays: [] });
  expect(parsePublicIdentity(`look up ${npub}`)).toBeNull();
});

test("NIP-05 resolves the exact requested mapping and validates the public key", () => {
  const identifier = nip05Address("alice@example.com");
  expect(identifier).toEqual({
    name: "alice",
    url: "https://example.com/.well-known/nostr.json?name=alice",
  });
  expect(nip05Key({ names: { alice: publicKey } }, "alice")).toBe(publicKey);
  expect(nip05Key({ names: { someone: publicKey } }, "alice")).toBeNull();
  expect(nip05Key({ names: { alice: "00".repeat(32) } }, "alice")).toBeNull();
  expect(nip05Address("alice@127.0.0.1")).toBeNull();
  expect(nip05Address("alice@example.com/info")).toBeNull();
});
