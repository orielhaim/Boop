import { useLocalSearchParams } from "expo-router";
import { PersonProfile } from "@/components/people/profile";
import { parsePublicIdentity, parsePublicKey } from "@/core/identity/keys";

export default function PersonRoute() {
  const { key, reference } = useLocalSearchParams<{
    key: string;
    reference?: string;
  }>();
  const publicKey = typeof key === "string" ? parsePublicKey(key) : null;
  const hint =
    typeof reference === "string" ? parsePublicIdentity(reference) : null;
  return (
    <PersonProfile
      publicKey={publicKey}
      hint={hint?.key === publicKey ? reference : undefined}
    />
  );
}
