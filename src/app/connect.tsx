import { Redirect, router, Stack } from "expo-router";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { GlassInput } from "@/components/glassyui/glass-input";
import { Action, Ink, Screen } from "@/components/ui/kit";
import { parsePublicKey } from "@/core/identity/keys";
import { namespaces } from "@/i18n";
import { useChatsEnabled, useLocal } from "@/services/local-context";

export default function Connect() {
  const { t } = useTranslation(namespaces);
  const { identity } = useLocal();
  const [address, setAddress] = useState("");
  const [error, setError] = useState("");
  const chatsEnabled = useChatsEnabled();
  if (!chatsEnabled) return <Redirect href="/" />;

  function connect() {
    const key = parsePublicKey(address);
    if (!key) {
      setError(t("contacts:invalidAddress"));
      return;
    }
    if (key === identity.publicKey) {
      setError(t("contacts:ownAddress"));
      return;
    }
    router.replace({
      pathname: "/chat/[key]",
      params: { key },
    });
  }

  return (
    <Screen>
      <Stack.Screen options={{ title: t("messages:newChat") }} />
      <GlassInput
        label={t("common:address")}
        placeholder={t("common:pasteAddress")}
        value={address}
        onChangeText={(value) => {
          setAddress(value);
          setError("");
        }}
        autoCapitalize="none"
        style={{ writingDirection: "ltr", textAlign: "left" }}
        autoCorrect={false}
        maxLength={128}
        onSubmitEditing={connect}
      />
      {error ? <Ink accessibilityLiveRegion="polite">{error}</Ink> : null}
      <Action variant="prominent" onPress={connect}>
        {t("messages:startChat")}
      </Action>
    </Screen>
  );
}
