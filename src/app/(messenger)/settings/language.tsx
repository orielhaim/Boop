import { ScreenHeader } from "@/components/navigation/screen-header";
import { type FlagCode, FlagView } from "@hzblj/expo-flags-kit";
import { useLocales } from "expo-localization";
import { router } from "expo-router";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Alert } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import {
  SettingsDescription,
  ListGroup,
  ListRow,
} from "@/components/ui/list-group";
import { Screen } from "@/components/ui/kit";
import {
  type LanguagePreference,
  languageChoices,
  namespaces,
  preferredLanguage,
  resolveLanguage,
} from "@/i18n";
import {
  readLanguagePreference,
  saveLanguagePreference,
} from "@/i18n/preference";
import { useChatsEnabled, useLocal } from "@/services/local-context";

const names = {
  en: "settings:languageEnglish",
  he: "settings:languageHebrew",
  auto: "settings:languageAuto",
} as const;

const flags = {
  en: "GB",
  he: "IL",
} satisfies Record<Exclude<LanguagePreference, "auto">, FlagCode>;

export default function LanguageSettings() {
  const { i18n, t } = useTranslation(namespaces);
  const { db, calling } = useLocal();
  const chatsEnabled = useChatsEnabled();
  const deviceLanguage = useLocales()[0]?.languageCode;
  const detected = preferredLanguage("auto", deviceLanguage);
  const current = resolveLanguage(i18n.resolvedLanguage);
  const [selected, setSelected] = useState(() => readLanguagePreference(db));
  const [saveFailed, setSaveFailed] = useState(false);
  const hasCall = () => {
    const call = calling.store.getState().call;
    return call && call.phase !== "ended";
  };

  function select(preference: LanguagePreference) {
    const save = () => {
      try {
        saveLanguagePreference(db, preference);
        setSelected(preference);
        setSaveFailed(false);
      } catch {
        setSaveFailed(true);
      }
    };
    if (preferredLanguage(preference, deviceLanguage) === current) {
      if (selected !== preference) save();
      return;
    }
    const defer = hasCall();
    Alert.alert(
      t("settings:language"),
      t(defer ? "settings:languageAfterCall" : "settings:languageRestart"),
      [
        { text: t("common:cancel"), style: "cancel" },
        {
          text: t(
            defer
              ? "settings:applyAfterCall"
              : "settings:languageRestartButton",
          ),
          onPress: save,
        },
      ],
    );
  }

  return (
    <Screen navigationHeader={<ScreenHeader title={t("settings:language")} />}>
      <ListGroup>
        {languageChoices.map((choice) => (
          <ListRow
            key={choice}
            title={t(names[choice])}
            icon={choice === "auto" ? "language" : undefined}
            leading={
              choice === "auto" ? undefined : (
                <FlagView code={flags[choice]} style={styles.flag} />
              )
            }
            value={choice === "auto" ? t(names[detected]) : undefined}
            selected={selected === choice}
            onPress={() => select(choice)}
          />
        ))}
      </ListGroup>
      {chatsEnabled && (
        <ListGroup>
          <ListRow
            icon="language"
            title={t("translation:title")}
            onPress={() => router.push("/settings/language/translation")}
          />
          <ListRow
            icon="language"
            title={t("speech:title")}
            onPress={() =>
              router.push("/settings/language/voice-transcription")
            }
          />
        </ListGroup>
      )}
      {saveFailed ? (
        <SettingsDescription>
          {t("settings:languageSaveError")}
        </SettingsDescription>
      ) : preferredLanguage(selected, deviceLanguage) !== current &&
        hasCall() ? (
        <SettingsDescription>
          {t("settings:languageAfterCall")}
        </SettingsDescription>
      ) : null}
    </Screen>
  );
}

const styles = StyleSheet.create({
  flag: { width: 30, borderRadius: 4 },
});
