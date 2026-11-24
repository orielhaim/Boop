import { useIsFocused } from "expo-router";
import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { useAvatar } from "@/core/avatars/use-avatar";
import { useContact, nameOrAddress } from "@/db/contacts";
import { useLocal } from "@/services/local-context";

export function usePublicProfile(key: string, refresh = false) {
  const { profiles } = useLocal();
  const focused = useIsFocused();
  useEffect(() => {
    if (refresh && focused) return profiles.watch(key);
  }, [focused, key, profiles, refresh]);
  return useSyncExternalStore(
    useCallback(
      (listener) => profiles.subscribe(key, listener),
      [key, profiles],
    ),
    () => profiles.profile(key),
  );
}

export function usePersonIdentity(key: string) {
  const row = useContact(key);
  const contact = row?.publicKey === key ? row : undefined;
  const profile = usePublicProfile(key);
  const { identity, initialProfile } = useLocal();
  const initialName =
    key === identity.publicKey ? initialProfile.name : undefined;
  return {
    contact,
    profile,
    name: key
      ? nameOrAddress(
          contact?.name || (profile ? profile.name : initialName),
          key,
        )
      : "",
  };
}

export function usePresentedName(key: string, displayName?: string | null) {
  const row = useContact(key);
  const localName = row?.publicKey === key ? row.name : undefined;
  return key ? nameOrAddress(localName || displayName, key) : "";
}

export function usePresentedPerson(
  key: string,
  displayName?: string | null,
  visible = true,
) {
  const name = usePresentedName(key, displayName);
  const photo = useAvatar(key, visible);
  return { name, photo };
}

export function usePerson(key: string, autoLoad = true) {
  const identity = usePersonIdentity(key);
  const photo = useAvatar(key, autoLoad);
  return { ...identity, photo };
}

export function useProjectedNames(keys: readonly string[]) {
  const { profiles } = useLocal();
  const scope = [...new Set(keys)].sort().join(",");
  useSyncExternalStore(
    useCallback(
      (notify) => {
        const stops = scope
          .split(",")
          .filter(Boolean)
          .flatMap((key) => [
            profiles.subscribe(key, notify),
            profiles.watch(key),
          ]);
        return () => stops.forEach((stop) => stop());
      },
      [profiles, scope],
    ),
    () =>
      scope
        .split(",")
        .map((key) => profiles.profile(key)?.name ?? "")
        .join("\0"),
  );
  return profiles.profile;
}

export function useVerifiedIdentifier(
  identifier: string | undefined,
  key: string,
) {
  const { nip05, lock } = useLocal();
  const state = useSyncExternalStore(lock.subscribe, lock.getState);
  const eligible = state.active && !state.locked;
  const focused = useIsFocused();
  const [verified, setVerified] = useState("");
  useEffect(() => {
    if (!focused || !identifier || !eligible) return;
    const job = new AbortController();
    void nip05
      .resolve(identifier, job.signal)
      .then((result) => {
        if (!job.signal.aborted)
          setVerified(result === key ? `${key}:${identifier}` : "");
      })
      .catch(() => undefined);
    return () => {
      job.abort();
    };
  }, [eligible, focused, identifier, key, nip05]);
  return Boolean(identifier && verified === `${key}:${identifier}`);
}
