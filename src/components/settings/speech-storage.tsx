import { router } from "expo-router";
import { useState, useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";
import { Alert, AppState } from "react-native";
import { SettingsGroup, SettingsRow } from "@/components/settings/group";
import { useLocal } from "@/services/local-context";

export function SpeechStorage({
  onChange,
  showLink,
}: {
  onChange?: () => void;
  showLink?: boolean;
}) {
  const { speech, lock } = useLocal();
  const { t, i18n } = useTranslation(["speech", "common"]);
  useSyncExternalStore(speech.subscribe, speech.snapshot);
  const { bytes, saved, pending } = speech.stats();
  const [clearing, setClearing] = useState(false);
  const number = new Intl.NumberFormat(i18n.language);
  const size = new Intl.NumberFormat(i18n.language, {
    style: "unit",
    unit: "kilobyte",
    maximumFractionDigits: 1,
  });
  const clear = (temporary: boolean) => {
    const run = () => {
      if (
        AppState.currentState !== "active" ||
        lock.getState().locked ||
        clearing
      )
        return;
      setClearing(true);
      void (temporary ? speech.clearTemporary() : speech.clear())
        .catch(() => Alert.alert(t("failed")))
        .finally(() => {
          setClearing(false);
          onChange?.();
        });
    };
    if (temporary) run();
    else
      Alert.alert(t("clear"), t("clearConfirm"), [
        { text: t("common:cancel"), style: "cancel" },
        { text: t("clear"), style: "destructive", onPress: run },
      ]);
  };
  return (
    <SettingsGroup title={t("storage")}>
      <SettingsRow title={t("storage")} value={size.format(bytes / 1000)} />
      <SettingsRow title={t("saved")} value={number.format(saved)} />
      <SettingsRow title={t("pending")} value={number.format(pending)} />
      <SettingsRow
        title={t("clear")}
        disabled={clearing}
        onPress={() => clear(false)}
      />
      <SettingsRow
        title={t("clearTemporary")}
        disabled={clearing}
        onPress={() => clear(true)}
      />
      {showLink && (
        <SettingsRow
          title={t("title")}
          onPress={() => router.push("/settings/language/voice-transcription")}
        />
      )}
    </SettingsGroup>
  );
}
