import { expect, test } from "bun:test";
import type { MarmotPublicProfile } from "../src/core/marmot/native";
import { createProfileDirectory } from "../src/core/profiles/directory";

const first = "11".repeat(32);
const second = "22".repeat(32);

function row(key: string, displayName: string): MarmotPublicProfile {
  return {
    key,
    displayName,
    name: "handle",
    picture: undefined,
    banner: undefined,
    about: undefined,
    nip05: undefined,
    lud16: undefined,
    website: undefined,
    bot: false,
  };
}

test("cached projections load as one batch even while a visible profile refresh waits", async () => {
  const pending = Promise.withResolvers<void>();
  const reads: string[][] = [];
  const refreshes: string[] = [];
  const directory = createProfileDirectory(
    {
      async read(keys) {
        reads.push(keys);
        return keys.map((key) => row(key, "Offline cache"));
      },
      refresh(key) {
        refreshes.push(key);
        return pending.promise;
      },
    },
    () => true,
    (key) => key === second,
    () => ["wss://relay.example.com/"],
  );
  directory.setActive(true);
  const release = directory.watch(first);
  const duplicate = directory.watch(first);
  const blocked = directory.watch(second);
  await Bun.sleep(0);
  expect(reads).toEqual([[first]]);
  expect(directory.profile(second)).toBeUndefined();
  expect(refreshes).toEqual([first]);
  expect(directory.profile(first)?.name).toBe("Offline cache");
  release();
  duplicate();
  blocked();
  pending.resolve();
  directory.setActive(false);
});

test("a delayed cache read cannot restore a retired account's presentation", async () => {
  const oldRead = Promise.withResolvers<MarmotPublicProfile[]>();
  const reader = { read: () => oldRead.promise, refresh: async () => {} };
  const previous = createProfileDirectory(
    reader,
    () => true,
    () => false,
    () => [],
  );
  previous.setActive(true);
  previous.read([first]);
  await Bun.sleep(0);
  previous.setActive(false);
  const next = createProfileDirectory(
    { ...reader, read: async () => [row(first, "Current account")] },
    () => true,
    () => false,
    () => [],
  );
  next.setActive(true);
  next.read([first]);
  oldRead.resolve([row(first, "Retired account")]);
  await Bun.sleep(0);
  expect(previous.profile(first)).toBeUndefined();
  expect(next.profile(first)?.name).toBe("Current account");
});

test("an acknowledged edit supersedes a previously started profile read", async () => {
  const read = Promise.withResolvers<MarmotPublicProfile[]>();
  let attempts = 0;
  const directory = createProfileDirectory(
    {
      read: () =>
        attempts++ === 0
          ? read.promise
          : Promise.resolve([row(first, "Published")]),
      refresh: async () => {},
    },
    () => true,
    () => false,
    () => [],
  );
  const observed: Array<string | undefined> = [];
  directory.subscribe(first, () =>
    observed.push(directory.profile(first)?.name),
  );
  directory.setActive(true);
  await Bun.sleep(0);
  directory.reload(first);
  read.resolve([row(first, "Stale")]);
  await Bun.sleep(0);
  expect(observed).toEqual(["Published"]);
});

test("blocking a peer suppresses its in-flight profile and preserves other profiles", async () => {
  const pendingRead = Promise.withResolvers<MarmotPublicProfile[]>();
  let blocked = false;
  const directory = createProfileDirectory(
    { read: () => pendingRead.promise, refresh: async () => {} },
    () => true,
    (key) => key === first && blocked,
    () => [],
  );
  directory.setActive(true);
  directory.read([first, second]);
  await Bun.sleep(0);
  blocked = true;
  directory.authorizationChanged();
  pendingRead.resolve([row(first, "Blocked"), row(second, "Visible")]);
  await Bun.sleep(0);
  expect(directory.profile(first)).toBeUndefined();
  expect(directory.profile(second)?.name).toBe("Visible");
});
