import { expect, test } from "bun:test";
import { getPublicKey } from "nostr-tools/pure";
import { createBlockedUsers } from "../src/core/marmot/blocked-users";

const key = (n: number) => getPublicKey(new Uint8Array(32).fill(n));
const owner = key(1);
const peer = key(2);
const other = key(3);

type Snapshot = { revision: string; keys: string[] };

function fixture() {
  const subscriptions: {
    owner: string;
    receive: (snapshot: Snapshot) => void;
    end: () => void;
    cancelled: boolean;
  }[] = [];
  const mutations: {
    owner: string;
    key: string;
    blocked: boolean;
    reply: ReturnType<typeof Promise.withResolvers<Snapshot>>;
  }[] = [];
  const source = {
    observe(
      owner: string,
      receive: (snapshot: Snapshot) => void,
      ended: (error: unknown) => void,
    ) {
      const subscription = {
        owner,
        receive,
        end: () => ended(new Error("Closed")),
        cancelled: false,
      };
      subscriptions.push(subscription);
      return () => {
        subscription.cancelled = true;
      };
    },
    set(owner: string, key: string, blocked: boolean) {
      const reply = Promise.withResolvers<Snapshot>();
      mutations.push({ owner, key, blocked, reply });
      return reply.promise;
    },
  };
  return { source, subscriptions, mutations };
}

test("permissions fail closed until the initial MDK snapshot and on stream failure", async () => {
  const { source, subscriptions, mutations } = fixture();
  const list = createBlockedUsers(owner, source);
  expect(list.isBlocked(peer)).toBe(true);
  expect(list.has(peer)).toBe(false);
  await expect(list.block(peer)).rejects.toThrow("BlockListUnavailable");
  expect(mutations).toHaveLength(0);
  list.start();
  list.start();
  expect(subscriptions).toHaveLength(1);
  const [stream] = subscriptions;
  expect(stream!.owner).toBe(owner);
  stream!.receive({ revision: "0", keys: [] });
  for (let i = 0; i < 100; i++) expect(list.isBlocked(peer)).toBe(false);
  expect(subscriptions).toHaveLength(1);
  expect(mutations).toHaveLength(0);
  stream!.end();
  expect(list.snapshot().status).toBe("unavailable");
  expect(list.isBlocked(peer)).toBe(true);
});

test("concurrent mutations and native events keep the highest exact revision", async () => {
  const { source, subscriptions, mutations } = fixture();
  const list = createBlockedUsers(owner, source);
  list.start();
  const [stream] = subscriptions;
  stream!.receive({ revision: "9007199254740992", keys: [] });
  const block = list.block(peer);
  const unblock = list.unblock(peer);
  expect(list.isBlocked(peer)).toBe(false);
  await Promise.resolve();
  expect(
    mutations.map(({ owner, key, blocked }) => [owner, key, blocked]),
  ).toEqual([[owner, peer, true]]);
  stream!.receive({ revision: "9007199254740993", keys: [peer] });
  expect(list.isBlocked(peer)).toBe(true);
  mutations[0]!.reply.resolve({ revision: "9007199254740993", keys: [peer] });
  await block;
  expect(
    mutations.map(({ owner, key, blocked }) => [owner, key, blocked]),
  ).toEqual([
    [owner, peer, true],
    [owner, peer, false],
  ]);
  mutations[1]!.reply.resolve({ revision: "9007199254740994", keys: [] });
  await unblock;
  stream!.receive({ revision: "9007199254740993", keys: [peer] });
  expect(list.isBlocked(peer)).toBe(false);
  stream!.receive({ revision: "9007199254740995", keys: [other] });
  expect(list.isBlocked(other)).toBe(true);

  const failed = list.unblock(other);
  await Promise.resolve();
  mutations[2]!.reply.reject(new Error("BlockPublicationUncertain"));
  await expect(failed).rejects.toThrow("BlockPublicationUncertain");
  expect(list.isBlocked(other)).toBe(true);
});

test("stopping invalidates pending writes and callbacks across runtime and account replacement", async () => {
  const { source, subscriptions, mutations } = fixture();
  const list = createBlockedUsers(owner, source);
  list.start();
  const [old] = subscriptions;
  old!.receive({ revision: "8", keys: [] });
  const pending = list.block(peer);
  await Promise.resolve();
  const queued = list.unblock(other).catch((error: unknown) => error);
  list.stop();
  expect(old!.cancelled).toBe(true);
  list.start();
  subscriptions[1]!.receive({ revision: "0", keys: [other] });
  old!.receive({ revision: "9", keys: [peer] });
  old!.end();
  mutations[0]!.reply.resolve({ revision: "9", keys: [peer] });
  await expect(pending).rejects.toThrow("AccountClosed");
  expect(await queued).toMatchObject({ message: "AccountClosed" });
  expect(mutations).toHaveLength(1);
  expect(list.isBlocked(peer)).toBe(false);
  expect(list.isBlocked(other)).toBe(true);

  const anotherAccount = createBlockedUsers(other, source);
  anotherAccount.start();
  expect(subscriptions[2]!.owner).toBe(other);
  subscriptions[2]!.receive({ revision: "0", keys: [owner] });
  expect(anotherAccount.isBlocked(owner)).toBe(true);
  expect(list.isBlocked(owner)).toBe(false);
});
