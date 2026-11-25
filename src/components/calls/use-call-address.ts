import { router } from "expo-router";
import { useRef } from "react";
import { parsePublicKey } from "@/core/identity/keys";
import { useLocal } from "@/services/local-context";

export function useCallAddress() {
  const { identity, lock, privacy } = useLocal();
  const submitted = useRef(false);

  return (address: string) => {
    if (submitted.current) return;
    const key = parsePublicKey(address);
    if (!key) return "contacts:invalidAddress";
    if (key === identity.publicKey) return "contacts:ownAddress";
    const { active, locked } = lock.getState();
    if (!active || locked || privacy.isBlocked(key)) return "calls:unavailable";

    submitted.current = true;
    router.replace({ pathname: "/call/[key]", params: { key } });
  };
}
