import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { Buffer } from "node:buffer";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import {
  openLaterDraftKey,
  purgeExpiredOpenedMessages,
  readOpenedMessage,
  readOpenLaterSubmission,
  removeOpenedMessage,
  removeOpenLaterSubmission,
  saveOpenedMessage,
  saveOpenLaterSubmission,
} from "../src/db/open-later";
import { setPreference } from "../src/db/queries";
import * as schema from "../src/db/schema";
import { initializeTestDatabase } from "./db-fixture";
import {
  createOpenLaterResolver,
  type OpenLaterState,
} from "../src/core/messaging/special-messages/open-conversation";
import {
  createTimeLockOpener,
  encryptTimeLock,
  maxTimeLockDate,
  parseTimeLock,
  scheduleUnlock,
  TimeLockError,
} from "../src/core/messaging/special-messages/timelock";

// Generated with official tle v1.2.0: -e -f -a -r 1000000
const body = "Boop Quicknet שלום 🌙";
const ciphertext = `-----BEGIN AGE ENCRYPTED FILE-----
YWdlLWVuY3J5cHRpb24ub3JnL3YxCi0+IHRsb2NrIDEwMDAwMDAgNTJkYjliYTcw
ZTBjYzBmNmVhZjc4MDNkZDA3NDQ3YTFmNTQ3NzczNWZkM2Y2NjE3OTJiYTk0NjAw
Yzg0ZTk3MQpqN3hUaGdScHppRjA1cmpqNmxJb3dpNm1pWHFFbzNqamh4ZGtIWXor
WmtkcVRQOWhLTEFJa0pVRFZiVFM3OEQ0CkZsdjhxQXg1K3d1aXpRTHpxeE9VMkxi
a2NtN3VsdGcrQWt4ck9QTHQxNnQ0OGZQa29mZDFzeUpSQ3ZDUjUwYjcKZUxNd1ZZ
NTVZSFVVU1laVExaSm1nSWNWYWJxYzNTYUUvdm5NTHdXYzc3MAotLS0gYU5PNG8r
SDZNWnFjaVJveVB5UDE1QWZONW5GZy9aL0txWVJxeE9HWHU3MAoTuWijZw094rcg
J6YxT2JqdGxI+hGFvpEA3ZGbJOBmCqnCbFod3fy/TqJmZro3zXU2jXfgTykSvA7k
aA==
-----END AGE ENCRYPTED FILE-----
`;
const beacon = {
  round: 1_000_000,
  randomness:
    "b22aad4794f7451896f7a371aa46106fd84d919f3f569acd5b2fddf1d1440af3",
  signature:
    "83ad29e4c409f9470fc2ef02f90214df49e02b441a1a241a82d622d9f608ef98fd8b11a029f1bee9d9e83b45088abe72",
};
// The round timestamp is calculated directly from drand's genesis.
const roundTime = 1_695_803_364_000;
function decodeArmor(armor: string) {
  return atob(armor.trim().split("\n").slice(1, -1).join(""));
}

function encodeArmor(binary: string) {
  const lines = btoa(binary)
    .match(/.{1,64}/g)
    ?.join("\n");
  return `-----BEGIN AGE ENCRYPTED FILE-----\n${lines}\n-----END AGE ENCRYPTED FILE-----\n`;
}

const historical = (() => {
  const content = parseTimeLock({
    type: "timelock",
    v: 1,
    ciphertext,
    ...scheduleUnlock(roundTime),
  });
  if (!content) throw new Error("Go Quicknet fixture did not parse");
  return content;
})();

test("opened plaintext survives a SQLite reopen and is removed on delete or expiration", () => {
  const directory = mkdtempSync(join(tmpdir(), "boop-open-later-"));
  const path = join(directory, "cache.db");
  try {
    {
      using sqlite = new Database(path);
      initializeTestDatabase(sqlite);
      const db = drizzle(sqlite, { schema });
      saveOpenedMessage(db, "opened", body);
      setPreference(
        db,
        "marmot.opened.expired",
        JSON.stringify({ body, expiresAt: 1 }),
      );
    }
    using sqlite = new Database(path);
    const db = drizzle(sqlite, { schema });
    expect(readOpenedMessage(db, "opened")).toBe(body);
    expect(readOpenedMessage(db, "expired")).toBeNull();
    removeOpenedMessage(db, "opened");
    purgeExpiredOpenedMessages(db);
    expect(sqlite.query("SELECT key FROM settings").all()).toEqual([]);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("an uncertain send reuses the same ciphertext and client token after reopening the account", () => {
  const directory = mkdtempSync(join(tmpdir(), "boop-open-later-send-"));
  const path = join(directory, "account.db");
  const group = "test-group";
  const target = "test-reply";
  const draftKey = openLaterDraftKey(body, target);
  const submission = {
    draftKey,
    time: historical.requestedAt,
    body: JSON.stringify(historical),
    token: randomUUID(),
  };
  try {
    {
      using sqlite = new Database(path);
      initializeTestDatabase(sqlite);
      saveOpenLaterSubmission(drizzle(sqlite, { schema }), group, submission);
    }
    using sqlite = new Database(path);
    const db = drizzle(sqlite, { schema });
    expect(readOpenLaterSubmission(db, group, draftKey)).toEqual(submission);
    expect(
      readOpenLaterSubmission(db, group, openLaterDraftKey(body, null)),
    ).toBeNull();
    expect(readOpenLaterSubmission(db, "other-group", draftKey)).toBeNull();
    expect(
      JSON.stringify(sqlite.query("SELECT value FROM settings").all()),
    ).not.toContain(body);
    removeOpenLaterSubmission(db, group, randomUUID());
    expect(readOpenLaterSubmission(db, group, draftKey)?.token).toBe(
      submission.token,
    );
    removeOpenLaterSubmission(db, group, submission.token);
    expect(readOpenLaterSubmission(db, group, draftKey)).toBeNull();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("conversation open resolves every due loaded message, adds pages, and reopens cached messages offline", async () => {
  let clock = roundTime - 1;
  const text = JSON.stringify(historical);
  const cache = new Map<string, string>();
  const states = new Map<string, OpenLaterState>();
  let fetches = 0;
  const open = createTimeLockOpener(undefined, async () => {
    fetches++;
    return beacon;
  });
  const options = {
    now: () => clock,
    read: ({ id }: { id: string }) => cache.get(id) ?? null,
    save: ({ id }: { id: string }, decoded: string) => {
      cache.set(id, decoded);
    },
    allowed: () => true,
    publish: (next: ReadonlyMap<string, OpenLaterState>) => {
      states.clear();
      for (const [id, state] of next) states.set(id, state);
    },
  };
  const recent = [
    { id: "offscreen", text },
    { id: "visible", text },
  ];
  const locked = createOpenLaterResolver({ ...options, open });
  locked.scan(recent);
  locked.scan(recent);
  expect(fetches).toBe(0);
  expect(states.get("offscreen")?.kind).toBe("locked");
  locked.stop();

  clock = roundTime;
  const opened = createOpenLaterResolver({ ...options, open });
  opened.scan(recent);
  opened.scan([...recent, { id: "older", text }]);
  await waitFor(() => cache.size === 3);
  expect(cache.get("offscreen")).toBe(body);
  expect(cache.get("older")).toBe(body);
  expect(fetches).toBe(1);
  opened.stop();

  const reopened = createOpenLaterResolver({
    ...options,
    open: async () => {
      throw new Error("Offline");
    },
  });
  reopened.scan([
    ...recent,
    { id: "older", text },
    { id: "expired", text, expiresAt: roundTime / 1000 },
  ]);
  expect(states.get("offscreen")).toEqual({ kind: "opened", text: body });
  expect(states.has("expired")).toBe(false);
  reopened.stop();
});

test("an open conversation wakes at the beacon round without a new message", async () => {
  let allowed = true;
  let state: OpenLaterState | undefined;
  let fetches = 0;
  const startsAt = performance.now() + 30;
  const clock = () => Math.floor(roundTime + performance.now() - startsAt);
  const message = { id: "group-locked", text: JSON.stringify(historical) };
  const resolver = createOpenLaterResolver({
    now: clock,
    read: () => null,
    save: (_, decoded) => expect(decoded).toBe(body),
    allowed: () => allowed,
    publish: (states) => {
      state = states.get(message.id);
    },
    open: createTimeLockOpener(undefined, async () => {
      expect(clock()).toBeGreaterThanOrEqual(roundTime);
      fetches++;
      return beacon;
    }),
  });
  try {
    resolver.scan([message]);
    expect(state?.kind).toBe("locked");
    expect(fetches).toBe(0);
    await waitFor(() => state?.kind === "opened");
    expect(state).toEqual({ kind: "opened", text: body });
    expect(fetches).toBe(1);
    allowed = false;
    resolver.scan([message]);
    expect(state).toBeUndefined();
  } finally {
    resolver.stop();
  }
});

test("leaving a conversation or losing access before its deadline prevents a beacon fetch", async () => {
  let allowed = true;
  let calls = 0;
  let state: OpenLaterState | undefined;
  let now = roundTime - 30;
  const options = {
    now: () => now,
    read: () => null,
    save: () => {},
    allowed: () => allowed,
    publish: (states: ReadonlyMap<string, OpenLaterState>) => {
      state = states.get("locked");
    },
    open: async () => {
      calls++;
      return body;
    },
  };
  const leaving = createOpenLaterResolver(options);
  const revoked = createOpenLaterResolver(options);
  const rows = [{ id: "locked", text: JSON.stringify(historical) }];
  try {
    leaving.scan(rows);
    leaving.stop();
    revoked.scan(rows);
    expect(state?.kind).toBe("locked");
    allowed = false;
    now = roundTime;
    await waitFor(() => state === undefined);
    expect(calls).toBe(0);
  } finally {
    leaving.stop();
    revoked.stop();
  }
});

test("Open Later errors wait for explicit retry and authorization loss discards completions", async () => {
  let allowed = true;
  let attempts = 0;
  let writes = 0;
  const message = { id: "pending", text: JSON.stringify(historical) };
  let resolveUnlock: ((result: string) => void) | undefined;
  let state: OpenLaterState | undefined;
  const resolver = createOpenLaterResolver({
    now: () => roundTime,
    read: () => null,
    save: () => {
      writes++;
    },
    allowed: () => allowed,
    open: async () => {
      if (++attempts === 1) throw new TimeLockError("network");
      return new Promise((resolve) => {
        resolveUnlock = resolve;
      });
    },
    publish: (states) => {
      state = states.get(message.id);
    },
  });
  resolver.scan([message]);
  await waitFor(() => state?.kind === "failed");
  resolver.scan([message]);
  expect(attempts).toBe(1);
  resolver.retry(message.id);
  expect(attempts).toBe(2);
  allowed = false;
  resolver.scan([]);
  resolveUnlock?.(body);
  await Promise.resolve();
  expect(writes).toBe(0);
  expect(state).toBeUndefined();
  resolver.stop();
});

async function waitFor(condition: () => boolean) {
  for (let i = 0; i < 100 && !condition(); i++) await Bun.sleep(2);
  expect(condition()).toBe(true);
}

test("chooses the first scheduled round at or after UTC instants", () => {
  const genesis = 1_692_803_367_000;
  expect(scheduleUnlock(genesis)).toMatchObject({
    unlockRound: 1,
    roundTime: genesis,
  });
  expect(scheduleUnlock(roundTime).unlockRound).toBe(beacon.round);
  expect(scheduleUnlock(roundTime - 1).roundTime).toBe(roundTime);
  expect(scheduleUnlock(roundTime + 1).roundTime).toBe(roundTime + 3_000);
  expect(scheduleUnlock(maxTimeLockDate).roundTime).toBeGreaterThanOrEqual(
    maxTimeLockDate,
  );
  expect(() => scheduleUnlock(Number.NaN)).toThrow();
  expect(() => scheduleUnlock(maxTimeLockDate + 1)).toThrow();

  const first = Date.parse("2025-11-02T01:30:00-04:00");
  const second = Date.parse("2025-11-02T01:30:00-05:00");
  expect(
    scheduleUnlock(second).unlockRound - scheduleUnlock(first).unlockRound,
  ).toBe(1_200);
  expect(scheduleUnlock(second)).toEqual(
    scheduleUnlock(Date.parse("2025-11-02T06:30:00Z")),
  );
});

test("binds metadata and the AGE recipient to the pinned chain and round", () => {
  expect(parseTimeLock(historical)).toEqual(historical);
  expect(
    parseTimeLock({ ...historical, chainHash: "ab".repeat(32) }),
  ).toBeNull();
  expect(
    parseTimeLock({ ...historical, requestedAt: roundTime + 1 }),
  ).toBeNull();
  expect(
    parseTimeLock({ ...historical, ciphertext: "A".repeat(18_000) }),
  ).toBeNull();
  expect(
    parseTimeLock({ ...historical, ...scheduleUnlock(roundTime + 1) }),
  ).toBeNull();
  expect(
    parseTimeLock({
      ...historical,
      ciphertext: encodeArmor(
        decodeArmor(ciphertext).replace(historical.chainHash, "ab".repeat(32)),
      ),
    }),
  ).toBeNull();
  expect(
    parseTimeLock({
      ...historical,
      ciphertext: encodeArmor(
        decodeArmor(ciphertext).replace(
          "\n--- ",
          "\n-> other-recipient\nAA\n--- ",
        ),
      ),
    }),
  ).toBeNull();
});

test("encrypts future UTF-8 locally and stays sealed without a beacon", async () => {
  let fetched = false;
  const open = createTimeLockOpener(undefined, async () => {
    fetched = true;
    return beacon;
  });
  const sealed = await encryptTimeLock(body, Date.now() + 60_000);
  expect(sealed.ciphertext).not.toContain(body);
  await expect(open(sealed)).rejects.toMatchObject({ code: "not-ready" });
  expect(fetched).toBe(false);
  await expect(encryptTimeLock(" ", Date.now() + 10_000)).rejects.toThrow(
    "invalid-message",
  );
  await expect(
    encryptTimeLock("a".repeat(4_001), Date.now() + 10_000),
  ).rejects.toThrow("invalid-message");
  await expect(encryptTimeLock(body, Date.now() - 1)).rejects.toThrow(
    "unlock-time",
  );
});

test("opens the Go fixture once the authentic Quicknet beacon is available, including offline cache reload", async () => {
  let fetches = 0;
  let stored: unknown;
  const cache = {
    read: () => stored,
    store: (entry: unknown) => {
      stored = entry;
    },
  };
  const open = createTimeLockOpener(cache, async () => {
    fetches++;
    return beacon;
  });
  expect(await Promise.all([open(historical), open(historical)])).toEqual([
    body,
    body,
  ]);
  expect(fetches).toBe(1);
  const offline = createTimeLockOpener(cache, async () => {
    throw new Error("Unexpected network request");
  });
  expect(await offline(historical)).toBe(body);
  const age = decodeArmor(ciphertext);
  await expect(
    open({
      ...historical,
      ciphertext: encodeArmor(
        age.slice(0, -1) +
          String.fromCharCode(age.charCodeAt(age.length - 1) ^ 1),
      ),
    }),
  ).rejects.toMatchObject({ code: "decryption" });
});

test("rejects wrong rounds and signatures before using the decryption key", async () => {
  let cached = false;
  const cache = {
    read: () => undefined,
    store: () => {
      cached = true;
    },
  };
  const wrongRound = createTimeLockOpener(cache, async () => ({
    ...beacon,
    round: beacon.round + 1,
  }));
  await expect(wrongRound(historical)).rejects.toMatchObject({
    code: "verification",
  });
  const signature = `93${beacon.signature.slice(2)}`;
  const digest = await crypto.subtle.digest(
    "SHA-256",
    Uint8Array.from(Buffer.from(signature, "hex")),
  );
  const wrongSignature = createTimeLockOpener(cache, async () => ({
    ...beacon,
    signature,
    randomness: Buffer.from(digest).toString("hex"),
  }));
  await expect(wrongSignature(historical)).rejects.toMatchObject({
    code: "verification",
  });
  const wrongRandomness = createTimeLockOpener(cache, async () => ({
    ...beacon,
    randomness: "00".repeat(32),
  }));
  await expect(wrongRandomness(historical)).rejects.toMatchObject({
    code: "verification",
  });
  expect(cached).toBe(false);
  const offline = createTimeLockOpener(undefined, async () => {
    throw new TimeLockError("network");
  });
  await expect(offline(historical)).rejects.toMatchObject({ code: "network" });
});
