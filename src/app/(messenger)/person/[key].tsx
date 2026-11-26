import { Redirect, useLocalSearchParams } from "expo-router";
import { PersonProfile } from "@/components/people/profile";
import { parsePublicIdentity, parsePublicKey } from "@/core/identity/keys";
import { useLocal } from "@/services/local-context";

export default function PersonRoute() {
  const { identity } = useLocal();
  const { key, reference, profileMorph } = useLocalSearchParams<{
    key: string;
    reference?: string;
    profileMorph?: string;
  }>();
  const publicKey = typeof key === "string" ? parsePublicKey(key) : null;
  if (publicKey === identity.publicKey) return <Redirect href="/settings" />;
  const hint =
    typeof reference === "string" ? parsePublicIdentity(reference) : null;
  return (
    <PersonProfile
      publicKey={publicKey}
      hint={hint?.key === publicKey ? reference : undefined}
      morph={
        publicKey && profileMorph === `person:${publicKey}`
          ? profileMorph
          : undefined
      }
    />
  );
}
