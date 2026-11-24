import { createStore } from "zustand/vanilla";
import type {
  MarmotRelayLists,
  MarmotRelayLiveness,
  marmotRelays,
} from "../marmot/native";
import {
  initialAccountRelays,
  type RelayConfiguration,
  sameRelays,
} from "./config";
import { relayUrl, secureRelays } from "./relays";

type AccountList = "general" | "inbox";
type RelayRole = AccountList | "discovery";
type Preferences = { discovery: string[]; incomingCalls: boolean };
export type RelayEdit =
  | { list: RelayRole; url: string; enabled: boolean }
  | { list: "restore" }
  | { list: "incomingCalls"; enabled: boolean };

const normalize = (url: string) => relayUrl.safeParse(url).data ?? url;

export function createAccountRelays({
  owner,
  source,
  initial,
  save,
  eligibility,
  configure,
  prepareInbox,
}: {
  owner: string;
  source: Pick<typeof marmotRelays, "read" | "classify" | "refresh" | "set">;
  initial: Preferences;
  save: (preferences: Partial<Preferences>) => void;
  eligibility: () => number | null;
  configure: (
    routes: RelayConfiguration,
    incomingCalls: boolean,
    retiredHosts: readonly string[],
  ) => void;
  prepareInbox: (
    additions: readonly string[],
    previous: readonly string[],
    active: () => boolean,
  ) => Promise<(() => void) | null>;
}) {
  const store = createStore<
    Preferences & { lists?: MarmotRelayLists; liveness: MarmotRelayLiveness[] }
  >(() => ({
    ...initial,
    liveness: [],
  }));
  let pending = Promise.resolve();

  function enqueue<T>(work: (active: () => boolean) => Promise<T>) {
    const epoch = eligibility();
    const active = () => epoch !== null && eligibility() === epoch;
    const result = pending.then(() => work(active));
    pending = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  function check(active: () => boolean) {
    if (!active()) throw new Error("AccountClosed");
  }

  function routes(lists: MarmotRelayLists) {
    const allowed = new Set(secureRelays(lists.allowed));
    const filter = (urls: string[]) =>
      secureRelays(urls).filter((url) => allowed.has(url));
    return {
      general: filter(lists.general),
      write: filter(lists.write),
      inbox: filter(lists.inbox),
    };
  }

  function apply(change: Partial<Preferences> & { lists?: MarmotRelayLists }) {
    const { lists, discovery, incomingCalls } = {
      ...store.getState(),
      ...change,
    };
    if (lists)
      configure(
        { ...routes(lists), discovery },
        incomingCalls,
        lists.retiredHosts,
      );
    store.setState(change);
  }

  async function read(active: () => boolean) {
    check(active);
    const lists = await source.read(owner);
    check(active);
    apply({ lists });
    return lists;
  }

  function saveLocal(change: Partial<Preferences>) {
    save(change);
    apply(change);
  }

  async function replace(
    list: RelayRole,
    urls: string[],
    current: MarmotRelayLists,
    active: () => boolean,
  ) {
    const before =
      list === "discovery"
        ? store.getState().discovery.map(normalize)
        : current[list].map(normalize);
    if (sameRelays(before, urls.map(normalize))) return;
    if (list === "inbox" && !urls.length)
      return saveLocal({ incomingCalls: false });
    const policies = urls.length ? await source.classify(owner, urls) : [];
    check(active);
    if (policies.length !== urls.length) throw new Error("RelayPolicy");
    const safeUrls = urls.filter((url, index) => {
      if (policies[index] === "allowed" && relayUrl.safeParse(url).success)
        return true;
      // Imported lists can contain endpoints that have since been retired or
      // blocked. Clean those entries during edits and reject new unsafe URLs.
      if (!before.includes(normalize(url))) throw new Error("RelayPolicy");
      return false;
    });
    const safeNormalized = safeUrls.map(normalize);
    if (list === "general" && !safeUrls.length)
      throw new Error("RelayRequired");
    if (list === "inbox" && safeUrls.length > 3) throw new Error("InboxLimit");
    if (list === "inbox" && !safeUrls.length)
      return saveLocal({ incomingCalls: false });
    if (list === "discovery") return saveLocal({ discovery: safeUrls });

    const release =
      list === "inbox"
        ? await prepareInbox(
            safeUrls.filter((url) => !before.includes(normalize(url))),
            routes(current).inbox.filter(
              (url) => !safeNormalized.includes(normalize(url)),
            ),
            active,
          )
        : undefined;
    try {
      check(active);
      if (release === null) throw new Error("InboxVerification");
      const outbox =
        list === "general"
          ? safeUrls.filter(
              (url) =>
                !before.includes(normalize(url)) ||
                current.write.map(normalize).includes(normalize(url)),
            )
          : [];
      const bootstrap = secureRelays([
        ...outbox,
        ...initialAccountRelays.general,
      ]);
      await source.set(owner, list, safeUrls, bootstrap);
      await read(active);
    } finally {
      release?.();
    }
  }

  return {
    snapshot: store.getState,
    subscribe: store.subscribe,
    setLiveness: (liveness: MarmotRelayLiveness[]) =>
      store.setState({ liveness }),
    refresh: (network = false) =>
      enqueue(async (active) => {
        const lists = await read(active);
        if (!network) return;
        const relays = secureRelays([
          ...routes(lists).general,
          ...store.getState().discovery,
          ...initialAccountRelays.general,
        ]).slice(0, 12);
        await source.refresh(owner, relays);
        await read(active);
      }),
    edit: (edit: RelayEdit) =>
      enqueue(async (active) => {
        check(active);
        if (edit.list === "incomingCalls")
          return saveLocal({ incomingCalls: edit.enabled });

        const current = await read(active);
        if (edit.list === "restore") {
          await replace(
            "general",
            initialAccountRelays.general,
            current,
            active,
          );
          await replace(
            "inbox",
            initialAccountRelays.inbox,
            store.getState().lists ?? current,
            active,
          );
          await replace(
            "discovery",
            initialAccountRelays.discovery,
            current,
            active,
          );
          return;
        }
        const roles =
          edit.list === "discovery"
            ? store.getState().discovery
            : current[edit.list];
        const url = normalize(edit.url);
        const urls = roles.filter((item) => normalize(item) !== url);
        if (edit.enabled) urls.push(url);
        await replace(edit.list, urls, current, active);
        if (
          edit.list === "inbox" &&
          edit.enabled &&
          !store.getState().incomingCalls
        )
          saveLocal({ incomingCalls: true });
      }),
  };
}
