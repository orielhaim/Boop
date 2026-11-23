import { useIsFocused } from "expo-router";
import { useEffect, useState, useSyncExternalStore } from "react";
import { useAvatar } from "@/core/avatars/use-avatar";
import { useContact, nameOrAddress } from "@/db/contacts";
import { useLocal } from "@/services/local-context";

export function usePublicProfile(key: string) {
  const { avatars } = useLocal();
  const eventId = useSyncExternalStore(
    (listener) => avatars.subscribe(key, listener),
    () => avatars.profile(key)?.eventId,
  );
  return eventId ? avatars.profile(key) : undefined;
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

export function usePerson(key: string, autoLoad = true) {
  const identity = usePersonIdentity(key);
  const photo = useAvatar(key, autoLoad);
  return { ...identity, photo };
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
