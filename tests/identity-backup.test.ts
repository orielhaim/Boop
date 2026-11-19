import { expect, test } from "bun:test";
import { nsecEncode } from "nostr-tools/nip19";
import { encryptBackup, readBackup } from "../src/core/identity/backup";
import { deriveIdentity } from "../src/core/identity/keys";

const vector =
  "ncryptsec1qgg9947rlpvqu76pj5ecreduf9jxhselq2nae2kghhvd5g7dgjtcxfqtd67p9m0w57lspw8gsq6yphnm8623nsl8xn9j4jdzz84zm3frztj3z7s35vpzmqf6ksu8r89qk5z2zxfmu5gv8th8wclt0h4p";
const vectorKey =
  "3501454135014541350145413501453fefb02227e449e57cf4d3a3ce05378683";

test("opens the NIP-49 vector and rejects a wrong password and malformed input", () => {
  expect(readBackup(vector, "nostr").secret).toBe(vectorKey);
  expect(() => readBackup(vector, "wrong")).toThrow();
  expect(() => readBackup(`${vector}x`, "nostr")).toThrow();
});

test("exports a standard encrypted backup and imports advanced raw formats", () => {
  const secret = "23".repeat(32);
  const expected = deriveIdentity(secret);
  const password = "synthetic test passphrase";
  expect(
    readBackup(encryptBackup(secret, password), password).identity,
  ).toEqual(expected);
  expect(
    readBackup(nsecEncode(new Uint8Array(32).fill(0x23)), "").identity,
  ).toEqual(expected);
  expect(readBackup(secret, "").identity).toEqual(expected);
  expect(() => readBackup("00".repeat(32), "")).toThrow();
});
