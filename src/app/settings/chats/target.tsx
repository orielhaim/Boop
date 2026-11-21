import { router } from "expo-router";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { ActivityIndicator, Alert } from "react-native";
import { GlassPanel } from "@/components/glassyui/glass-panel";
import {
  SettingsDescription,
  SettingsGroup,
  SettingsRow,
} from "@/components/settings/group";
import { useTranslationLanguages } from "@/components/settings/translation-languages";
import { Action, Ink, Screen, Search } from "@/components/ui/kit";
import {
  setTranslationPreferences,
  useTranslationPreferences,
} from "@/core/translation/preferences";
import { namespaces, resolveLanguage } from "@/i18n";
import { useLocal } from "@/services/local-context";
import { space } from "@/theme";

export default function TranslationTarget() {
  const { t, i18n } = useTranslation(namespaces);
  const { db } = useLocal();
  const preferences = useTranslationPreferences(
    db,
    resolveLanguage(i18n.resolvedLanguage),
  );
  const { catalog, downloaded, error, retry } = useTranslationLanguages();
  const [search, setSearch] = useState("");
  const query = search.trim().toLocaleLowerCase();
  const choices = catalog
    ?.filter(
      ({ code, name }) =>
        code.includes(query) || name.toLocaleLowerCase().includes(query),
    )
    .sort((a, b) => a.name.localeCompare(b.name, i18n.resolvedLanguage));
  const selected = catalog?.find(({ code }) => code === preferences.target);
  return (
    <Screen>
      {selected && !query && (
        <GlassPanel variant="card" style={{ gap: space.xs }}>
          <Ink kind="caption" muted>
            {t("translation:currentTarget")}
          </Ink>
          <Ink kind="heading">{selected.name}</Ink>
          {downloaded && (
            <Ink kind="caption" muted>
              {t(
                downloaded.includes(selected.code)
                  ? "common:ready"
                  : "translation:downloadRequired",
              )}
            </Ink>
          )}
        </GlassPanel>
      )}
      <Search
        value={search}
        onChangeText={setSearch}
        placeholder={t("translation:search")}
      />
      {error && (
        <>
          <SettingsDescription>{t(`translation:${error}`)}</SettingsDescription>
          <Action variant="soft" onPress={retry}>
            {t("common:retry")}
          </Action>
        </>
      )}
      {!catalog && !error && <ActivityIndicator />}
      {catalog && !choices?.length && (
        <SettingsDescription>
          {t("translation:noLanguages")}
        </SettingsDescription>
      )}
      {!!choices?.length && (
        <SettingsGroup title={t("translation:available")}>
          {choices.map(({ code, name }) => (
            <SettingsRow
              key={code}
              title={name}
              selected={code === preferences.target}
              detail={
                downloaded?.includes(code) ? t("common:ready") : undefined
              }
              onPress={() => {
                try {
                  setTranslationPreferences(db, {
                    ...preferences,
                    target: code,
                  });
                  router.back();
                } catch {
                  Alert.alert(t("translation:saveFailed"));
                }
              }}
            />
          ))}
        </SettingsGroup>
      )}
    </Screen>
  );
}
