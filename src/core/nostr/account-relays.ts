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

  async function validate(urls: readonly string[], active: () => boolean) {
    const policies = await source.classify(owner, urls);
    check(active);
    if (
      policies.length !== urls.length ||
      !policies.every((policy) => policy === "allowed") ||
      urls.some((url) => !relayUrl.safeParse(url).success)
    )
      throw new Error("RelayPolicy");
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
        ? store.getState().discovery
        : current[list].map(normalize);
    if (sameRelays(before, urls.map(normalize))) return;
    if (list === "general" && !urls.length) throw new Error("RelayRequired");
    if (list === "inbox" && urls.length > 3) throw new Error("InboxLimit");
    if (list === "inbox" && !urls.length)
      return saveLocal({ incomingCalls: false });
    await validate(urls, active);
    if (list === "discovery") return saveLocal({ discovery: urls });

    const release =
      list === "inbox"
        ? await prepareInbox(
            urls.map(normalize).filter((url) => !before.includes(url)),
            routes(current).inbox.filter(
              (url) => !urls.map(normalize).includes(url),
            ),
            active,
          )
        : undefined;
    try {
      check(active);
      if (release === null) throw new Error("InboxVerification");
      const outbox =
        list === "general"
          ? urls.filter(
              (url) =>
                !before.includes(url) ||
                current.write.map(normalize).includes(url),
            )
          : [];
      const bootstrap = secureRelays([
        ...outbox,
        ...initialAccountRelays.general,
      ]);
      await source.set(owner, list, urls, bootstrap);
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
        const urls = roles.filter((item) => item !== url);
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
