import { ScreenHeader } from "@/components/navigation/screen-header";
import { Redirect, router, useIsFocused } from "expo-router";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { GlassInput } from "@/components/glassyui/glass-input";
import { Action, Ink, Row, Screen } from "@/components/ui/kit";
import { usePublicProfile } from "@/components/people/use-person";
import { nameOrAddress } from "@/db/contacts";
import { useDirectorySearch } from "@/core/profiles/use-directory-search";
import { parsePublicKey } from "@/core/identity/keys";
import { namespaces } from "@/i18n";
import { useChatsEnabled, useLocal } from "@/services/local-context";

export default function Connect() {
  const { t } = useTranslation(namespaces);
  const { identity } = useLocal();
  const [address, setAddress] = useState("");
  const [error, setError] = useState("");
  const chatsEnabled = useChatsEnabled();
  const focused = useIsFocused();
  const { exactKey, current } = useDirectorySearch(
    address,
    focused && chatsEnabled,
  );
  if (!chatsEnabled) return <Redirect href="/" />;

  function connect(key = exactKey ?? parsePublicKey(address)) {
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
    <Screen navigationHeader={<ScreenHeader title={t("messages:newChat")} />}>
      <GlassInput
        label={t("common:address")}
        placeholder={t("messenger:searchHint")}
        value={address}
        onChangeText={(value) => {
          setAddress(value);
          setError("");
        }}
        autoCapitalize="none"
        style={{ writingDirection: "ltr", textAlign: "left" }}
        autoCorrect={false}
        maxLength={1050}
        onSubmitEditing={() => connect()}
      />
      {error ? <Ink accessibilityLiveRegion="polite">{error}</Ink> : null}
      {current?.keys
        .filter((key) => key !== identity.publicKey)
        .map((key) => (
          <ConnectResult
            key={key}
            publicKey={key}
            onPress={() => connect(key)}
          />
        ))}
      <Action variant="prominent" onPress={() => connect()}>
        {t("messages:startChat")}
      </Action>
    </Screen>
  );
}

function ConnectResult({
  publicKey,
  onPress,
}: {
  publicKey: string;
  onPress: () => void;
}) {
  const profile = usePublicProfile(publicKey, true);
  return (
    <Row title={nameOrAddress(profile?.name, publicKey)} onPress={onPress} />
  );
}
