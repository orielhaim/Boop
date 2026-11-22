import { expect, test } from "bun:test";
import { nprofileEncode, nsecEncode } from "nostr-tools/nip19";
import { deriveIdentity, parsePublicIdentity } from "../src/core/identity/keys";
import { readBackup, encryptBackup } from "../src/core/identity/backup";
import { nip05Address, nip05Key } from "../src/core/nostr/nip05";
import {
  profileDetails,
  updateProfileFields,
} from "../src/core/avatars/protocol";

const secret = "01".repeat(32);
const { publicKey, npub } = deriveIdentity(secret);

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

test("key import handles hexadecimal, nsec and encrypted Digital SIM without accepting npub", () => {
  const password = "test passphrase for boop";
  const nsec = nsecEncode(new Uint8Array(32).fill(1));
  for (const value of [secret, nsec, encryptBackup(secret, password)])
    expect(readBackup(value, password).identity.publicKey).toBe(publicKey);
  expect(() => readBackup(npub, "")).toThrow();
  expect(() => readBackup(encryptBackup(secret, password), "wrong")).toThrow();
});

test("profile fields project safely while unrelated fields survive republishing", () => {
  const original = {
    name: "handle",
    display_name: "Display Name",
    banner: "https://profile.example.com/cover.jpg",
    website: "javascript:alert(1)",
    bot: true,
    custom: { color: "blue" },
  };
  const next = updateProfileFields(original, {
    displayName: "New",
    about: "Bio",
  });
  expect(next).toEqual({ ...original, display_name: "New", about: "Bio" });
  expect(profileDetails(next)).toMatchObject({
    name: "handle",
    about: "Bio",
    banner: original.banner,
    website: undefined,
    bot: true,
  });
  expect(updateProfileFields(undefined, { displayName: "First" })).toEqual({
    display_name: "First",
    name: "First",
  });
});
