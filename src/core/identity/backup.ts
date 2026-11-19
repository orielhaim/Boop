import { decode } from "nostr-tools/nip19";
import { decrypt, encrypt } from "nostr-tools/nip49";
import { deriveIdentity } from "./keys";

const alphabet = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";

export function backupKind(input: string) {
  const value = input
    .trim()
    .replace(/^nostr:/i, "")
    .toLowerCase();
  return value.startsWith("ncryptsec1") ? "encrypted" : "raw";
}

export function readBackup(input: string, password: string) {
  const value = input.trim().replace(/^nostr:/i, "");
  if (value.length > 162 || password.length > 512)
    throw new Error("invalid-backup");
  let secret: string;
  if (/^[0-9a-f]{64}$/i.test(value)) {
    secret = value.toLowerCase();
  } else if (backupKind(value) === "encrypted") {
    if (!/^ncryptsec1[qpzry9x8gf2tvdw0s3jn54khce6mua7l]{152}$/.test(value))
      throw new Error("invalid-backup");
    const header =
      Array.from(value.slice(10, 14)).reduce(
        (bits, letter) => bits * 32 + alphabet.indexOf(letter),
        0,
      ) >> 4;
    const cost = header & 255;
    if (header >> 8 !== 2 || cost < 1 || cost > 16)
      throw new Error("backup-cost");
    const bytes = decrypt(value, password);
    try {
      secret = Array.from(bytes, (byte) =>
        byte.toString(16).padStart(2, "0"),
      ).join("");
    } finally {
      bytes.fill(0);
    }
  } else {
    const decoded = decode(value);
    if (decoded.type !== "nsec" || decoded.data.length !== 32)
      throw new Error("invalid-backup");
    try {
      secret = Array.from(decoded.data, (byte) =>
        byte.toString(16).padStart(2, "0"),
      ).join("");
    } finally {
      decoded.data.fill(0);
    }
  }
  return { secret, identity: deriveIdentity(secret) };
}

export function encryptBackup(secret: string, password: string) {
  deriveIdentity(secret);
  if (password.normalize("NFKC").length < 16 || password.length > 512)
    throw new Error("invalid-password");
  const bytes = Uint8Array.from({ length: 32 }, (_, index) =>
    Number.parseInt(secret.slice(index * 2, index * 2 + 2), 16),
  );
  try {
    return encrypt(bytes, password);
  } finally {
    bytes.fill(0);
  }
}
