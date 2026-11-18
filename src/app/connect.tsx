import { router, Stack, useLocalSearchParams } from "expo-router";
import { useState } from "react";
import { GlassInput } from "@/components/glassyui/glass-input";
import { Action, Ink, Screen } from "@/components/ui/kit";
import { parsePublicKey } from "@/core/identity/keys";
import { useLocal } from "@/services/local";

export default function Connect() {
  const { mode } = useLocalSearchParams<{ mode?: string }>();
  const { identity } = useLocal();
  const [address, setAddress] = useState("");
  const [error, setError] = useState("");
  const isCall = mode === "call";

  function connect() {
    const key = parsePublicKey(address);
    if (!key) {
      setError("Enter a valid Boop address.");
      return;
    }
    if (key === identity.publicKey) {
      setError("Enter someone else’s address.");
      return;
    }
    router.replace({
      pathname: isCall ? "/call/[key]" : "/chat/[key]",
      params: { key },
    });
  }

  return (
    <Screen>
      <Stack.Screen options={{ title: isCall ? "New call" : "New chat" }} />
      <GlassInput
        label="Boop address"
        placeholder="Paste an address"
        value={address}
        onChangeText={(value) => {
          setAddress(value);
          setError("");
        }}
        autoCapitalize="none"
        autoCorrect={false}
        maxLength={128}
        onSubmitEditing={connect}
      />
      {error ? <Ink accessibilityLiveRegion="polite">{error}</Ink> : null}
      <Action variant="prominent" onPress={connect}>
        {isCall ? "Start call" : "Start chat"}
      </Action>
    </Screen>
  );
}
