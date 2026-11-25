import { getStringAsync } from "expo-clipboard";
import { useNavigation } from "expo-router";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Keyboard } from "react-native";
import { useCallAddress } from "@/components/calls/use-call-address";
import { GlassInput } from "@/components/glassyui/glass-input";
import { ScreenHeader } from "@/components/navigation/screen-header";
import { Action, Ink, Screen } from "@/components/ui/kit";
import { namespaces } from "@/i18n";

export default function DialAddress() {
  const { t } = useTranslation(namespaces);
  const navigation = useNavigation();
  const callAddress = useCallAddress();
  const [address, setAddress] = useState("");
  const [error, setError] = useState("");

  function updateAddress(value: string) {
    setAddress(value);
    setError("");
  }

  function dial() {
    if (!navigation.isFocused()) return;
    const failure = callAddress(address);
    if (failure) setError(t(failure));
    else Keyboard.dismiss();
  }

  async function paste() {
    try {
      const value = await getStringAsync();
      if (!navigation.isFocused()) return;
      if (value.trim()) updateAddress(value.trim().slice(0, 1050));
      else setError(t("calls:clipboardEmpty"));
    } catch {
      if (navigation.isFocused()) setError(t("calls:clipboardUnavailable"));
    }
  }

  return (
    <Screen navigationHeader={<ScreenHeader title={t("calls:newCall")} />}>
      <GlassInput
        label={t("common:address")}
        placeholder={t("common:pasteAddress")}
        value={address}
        onChangeText={updateAddress}
        autoCapitalize="none"
        autoCorrect={false}
        maxLength={1050}
        style={{ writingDirection: "ltr", textAlign: "left" }}
        onSubmitEditing={dial}
      />
      {error ? (
        <Ink accessibilityRole="alert" accessibilityLiveRegion="polite">
          {error}
        </Ink>
      ) : null}
      <Action variant="prominent" onPress={dial}>
        {t("calls:call")}
      </Action>
      <Action variant="soft" onPress={() => void paste()}>
        {t("common:pasteAddress")}
      </Action>
    </Screen>
  );
}
