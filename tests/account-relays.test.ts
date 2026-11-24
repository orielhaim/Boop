import { expect, test } from "bun:test";
import { createAccountRelays } from "../src/core/nostr/account-relays";
import type { MarmotRelayLists } from "../src/core/marmot/native";

const old = "wss://old.example.com/";
const next = "wss://new.example.com/";
const other = "wss://another.example.com/";
const indexer = "wss://discovery.example.com/";

function fixture() {
  let lists: MarmotRelayLists = {
    general: [old],
    write: [old],
    inbox: [old],
    bootstrap: [old],
    allowed: [old, next, other],
    retiredHosts: [],
  };
  let generation = 0;
  const publications: { list: "general" | "inbox"; urls: string[] }[] = [];
  let hold: Promise<void> | undefined;
  let publishError = false;
  let probe: Promise<boolean> = Promise.resolve(true);
  const policies = new Map<string, "allowed" | "retired" | "unsafe">();
  const probeStarted = Promise.withResolvers<void>();
  let releases = 0;
  const configurations: { inbox: readonly string[]; allowed: boolean }[] = [];
  const relays = createAccountRelays({
    owner: "fixture",
    source: {
      async read() {
        return lists;
      },
      async refresh() {},
      async classify(_, urls) {
        return urls.map(
          (url) => policies.get(url.replace(/\/$/, "")) ?? "allowed",
        );
      },
      async set(_, list, urls) {
        publications.push({ list, urls: [...urls] });
        await hold;
        if (publishError) throw new Error("NoAcknowledgements");
        lists = { ...lists, [list]: [...urls] };
      },
    },
    initial: { discovery: [indexer], incomingCalls: true },
    save() {},
    async prepareInbox() {
      probeStarted.resolve();
      return (await probe)
        ? () => {
            releases++;
          }
        : null;
    },
    eligibility: () => generation,
    configure(routes, allowed) {
      configurations.push({ inbox: routes.inbox, allowed });
    },
  });
  return {
    relays,
    publications,
    configurations,
    probeStarted: probeStarted.promise,
    replaceObserved: (observed: MarmotRelayLists) => {
      lists = observed;
    },
    classifyAs: (url: string, policy: "allowed" | "retired" | "unsafe") => {
      policies.set(url.replace(/\/$/, ""), policy);
    },
    holdPublication: (waiting: Promise<void>) => {
      hold = waiting;
    },
    failPublication: (fail: boolean) => {
      publishError = fail;
    },
    holdProbe: (waiting: Promise<boolean>) => {
      probe = waiting;
    },
    suspend: () => {
      generation++;
    },
    released: () => releases,
  };
}

test("refresh consumes imported and changed declarations without publishing either", async () => {
  const { relays, publications, replaceObserved } = fixture();
  await relays.refresh(true);
  const account = relays.snapshot().lists;
  expect(account?.inbox).toEqual([old]);
  if (!account) throw new Error("Expected MDK state");
  replaceObserved({ ...account, inbox: [next] });
  await relays.refresh(true);
  expect(relays.snapshot().lists?.inbox).toEqual([next]);
  await relays.edit({ list: "discovery", url: other, enabled: true });
  expect(relays.snapshot().discovery).toEqual([indexer, other]);
  expect(publications).toEqual([]);
});

test("concurrent edits read MDK again after the preceding edit commits", async () => {
  const { relays, publications, holdPublication } = fixture();
  const release = Promise.withResolvers<void>();
  holdPublication(release.promise);
  const addOne = relays.edit({ list: "general", url: next, enabled: true });
  const addTwo = relays.edit({ list: "general", url: other, enabled: true });
  release.resolve();
  await Promise.all([addOne, addTwo]);
  expect(publications).toEqual([
    { list: "general", urls: [old, next] },
    { list: "general", urls: [old, next, other] },
  ]);
});

test("editing a general list preserves the exact URLs MDK uses to match NIP-65 roles", async () => {
  const { relays, publications, replaceObserved } = fixture();
  await relays.refresh();
  const lists = relays.snapshot().lists;
  if (!lists) throw new Error("Expected MDK state");
  const readOnly = "wss://readonly.example.com";
  replaceObserved({
    ...lists,
    general: [readOnly, old],
    allowed: [readOnly, old, next],
  });
  await relays.edit({ list: "general", url: next, enabled: true });
  expect(publications[0]).toEqual({
    list: "general",
    urls: [readOnly, old, next],
  });
});

test("removing an imported unsafe relay prunes other unsafe entries and preserves allowed roles", async () => {
  const { relays, publications, replaceObserved, classifyAs } = fixture();
  const retired = "wss://retired.example.com";
  const unsafe = "wss://unsafe.example.com";
  const readonly = "wss://readonly.example.com";
  await relays.refresh();
  const current = relays.snapshot().lists;
  if (!current) throw new Error("Expected MDK state");
  classifyAs(retired, "retired");
  classifyAs(unsafe, "unsafe");
  replaceObserved({
    ...current,
    general: [readonly, retired, old, unsafe],
    write: [old],
    allowed: [readonly, old, next, other],
  });

  await relays.edit({ list: "general", url: unsafe, enabled: false });

  expect(publications).toEqual([{ list: "general", urls: [readonly, old] }]);
  expect(relays.snapshot().lists?.general).toEqual([readonly, old]);
});

test("removing an imported relay works when the inbox also contains retired and unsafe relays", async () => {
  const { relays, publications, replaceObserved, classifyAs } = fixture();
  const retired = "wss://retired.example.com";
  const unsafe = "wss://unsafe.example.com";
  await relays.refresh();
  const current = relays.snapshot().lists;
  if (!current) throw new Error("Expected MDK state");
  classifyAs(retired, "retired");
  classifyAs(unsafe, "unsafe");
  replaceObserved({
    ...current,
    inbox: [old, retired, unsafe],
    allowed: [old, next, other],
  });

  await relays.edit({ list: "inbox", url: retired, enabled: false });

  expect(publications).toEqual([{ list: "inbox", urls: [old] }]);
  expect(relays.snapshot().lists?.inbox).toEqual([old]);
});

test("a newly added unsafe relay fails without committing any changes", async () => {
  const { relays, publications, classifyAs } = fixture();
  const unsafe = "wss://unsafe.example.com";
  classifyAs(unsafe, "unsafe");
  await expect(
    relays.edit({ list: "general", url: unsafe, enabled: true }),
  ).rejects.toThrow("RelayPolicy");
  expect(publications).toEqual([]);
  expect(relays.snapshot().lists?.general).toEqual([old]);
});

test("an unverified inbox or failed MDK publication leaves the old routes intact", async () => {
  const {
    relays,
    publications,
    holdProbe,
    failPublication,
    configurations,
    released,
  } = fixture();
  holdProbe(Promise.resolve(false));
  const add = () => relays.edit({ list: "inbox", url: next, enabled: true });
  await expect(add()).rejects.toThrow("InboxVerification");
  expect(publications).toEqual([]);
  holdProbe(Promise.resolve(true));
  failPublication(true);
  await expect(add()).rejects.toThrow("NoAcknowledgements");
  expect(configurations.at(-1)?.inbox).toEqual([old]);
  expect(released()).toBe(1);
  failPublication(false);
  await add();
  expect(configurations.at(-1)?.inbox).toEqual([old, next]);
  expect(released()).toBe(2);
});

test("a pending inbox probe cannot publish into a new transport session", async () => {
  const { relays, publications, holdProbe, probeStarted, suspend, released } =
    fixture();
  const release = Promise.withResolvers<boolean>();
  holdProbe(release.promise);
  const saving = relays.edit({ list: "inbox", url: next, enabled: true });
  await probeStarted;
  suspend();
  release.resolve(true);
  await expect(saving).rejects.toThrow("AccountClosed");
  expect(publications).toEqual([]);
  expect(released()).toBe(1);
});
