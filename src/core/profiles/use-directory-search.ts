import { randomUUID } from "expo-crypto";
import { useEffect, useState, useSyncExternalStore } from "react";
import { marmotDirectory } from "../marmot/native";
import { nip05Address } from "../nostr/nip05";
import { useLocal } from "@/services/local-context";

type Result =
  | { query: string; exactKey: string }
  | {
      query: string;
      keys: string[];
      state: "loading" | "complete" | "unavailable";
    };

export function useDirectorySearch(input: string, enabled: boolean) {
  const { identity, lock, nip05, privacy, profiles, relays } = useLocal();
  const lockState = useSyncExternalStore(lock.subscribe, lock.getState);
  const active = enabled && lockState.active && !lockState.locked;
  const term = input.trim();
  const [result, setResult] = useState<Result>();
  useEffect(() => {
    if (
      !active ||
      term.length < 2 ||
      term.length > 1050 ||
      /[\r\n]/u.test(term)
    )
      return;
    const isReference =
      /^(?:nostr:|marmot:\/\/profile\/|npub1|nprofile1)|^[0-9a-f]{64}$/iu.test(
        term,
      );
    if (
      /^(?:nostr:)?(?:nsec1|ncryptsec1)/iu.test(term) ||
      (!isReference && term.length > 80)
    )
      return;
    const controller = new AbortController();
    const { signal } = controller;
    const keys = new Set<string>();
    const show = (state: "loading" | "complete" | "unavailable") => {
      if (!signal.aborted) setResult({ query: term, keys: [...keys], state });
    };
    const receive = (incoming: string[]) => {
      if (signal.aborted) return;
      for (const key of incoming) {
        if (keys.size >= 48) break;
        if (!privacy.isBlocked(key)) keys.add(key);
      }
      show("loading");
    };
    const acceptProjections = (
      rows: Awaited<ReturnType<typeof marmotDirectory.searchCached>>,
    ) => {
      if (signal.aborted) return;
      const allowed = rows.filter((row) => !privacy.isBlocked(row.key));
      profiles.presentSearch(allowed.flatMap((row) => row.profile ?? []));
      receive(allowed.map((row) => row.key));
    };
    show("loading");
    const timer = setTimeout(
      () => {
        void (async () => {
          if (isReference) {
            const key = await marmotDirectory.normalize(
              identity.publicKey,
              term,
            );
            if (!signal.aborted && key && !privacy.isBlocked(key)) {
              setResult({ query: term, exactKey: key });
              return;
            }
          } else if (term.includes("@")) {
            const key =
              nip05Address(term) && (await nip05.resolve(term, signal));
            if (key) receive([key]);
          } else {
            acceptProjections(
              await marmotDirectory
                .searchCached(identity.publicKey, term)
                .catch(() => []),
            );
            if (!signal.aborted) {
              const searches = [
                marmotDirectory.search(
                  identity.publicKey,
                  randomUUID(),
                  term,
                  signal,
                  acceptProjections,
                ),
              ];
              const targets = relays.discoveryRelays().slice(0, 4);
              if (targets.length) {
                searches.push(
                  relays.transport.discoverProfileKeys(
                    targets,
                    term,
                    (key) => receive([key]),
                    signal,
                  ),
                );
              }
              const outcomes = await Promise.allSettled(searches);
              if (
                outcomes.every((outcome) => outcome.status === "rejected") &&
                !keys.size
              ) {
                show("unavailable");
                return;
              }
            }
          }
          show("complete");
        })().catch(() => show(keys.size ? "complete" : "unavailable"));
      },
      isReference ? 0 : 350,
    );
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [active, identity.publicKey, nip05, privacy, profiles, relays, term]);

  const current = result?.query === term && active ? result : undefined;
  const exactKey =
    current && "exactKey" in current && !privacy.isBlocked(current.exactKey)
      ? current.exactKey
      : undefined;
  return {
    exactKey,
    current: current && "keys" in current ? current : undefined,
  };
}
