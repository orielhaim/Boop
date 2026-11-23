import { LoadingSkeleton } from "@/components/ui/loading-skeleton";
import { ScreenHeader } from "@/components/navigation/screen-header";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Alert } from "react-native";
import {
  SettingsDescription,
  SettingsGroup,
  SettingsRow,
} from "@/components/settings/group";
import { useTranslationLanguages } from "@/components/settings/translation-languages";
import { Action, Screen, Search } from "@/components/ui/kit";
import {
  toggleExcludedSource,
  useTranslationPreferences,
} from "@/core/translation/preferences";
import { languageCode } from "@/core/translation/service";
import { namespaces, resolveLanguage } from "@/i18n";
import { useLocal } from "@/services/local-context";

export default function ExcludedLanguages() {
  const { t, i18n } = useTranslation(namespaces);
  const { db } = useLocal();
  const language = resolveLanguage(i18n.resolvedLanguage);
  const { excludedSources } = useTranslationPreferences(db, language);
  const { catalog, error, retry } = useTranslationLanguages();
  const [search, setSearch] = useState("");
  const term = search.trim().toLocaleLowerCase();
  const choices = catalog
    ?.filter(
      ({ code, name }) =>
        code.includes(term) || name.toLocaleLowerCase().includes(term),
    )
    .sort((left, right) => left.name.localeCompare(right.name, language));

  return (
    <Screen
      navigationHeader={<ScreenHeader title={t("translation:excluded")} />}
    >
      <SettingsDescription>{t("translation:excludedHelp")}</SettingsDescription>
      <Search
        accessibilityLabel={t("translation:search")}
        value={search}
        onChangeText={setSearch}
        placeholder={t("translation:search")}
      />
      {!catalog &&
        (error ? (
          <>
            <SettingsDescription>
              {t(`translation:${error}`)}
            </SettingsDescription>
            <Action variant="soft" onPress={retry}>
              {t("common:retry")}
            </Action>
          </>
        ) : (
          <LoadingSkeleton label={t("common:opening")} />
        ))}
      {choices?.length === 0 && (
        <SettingsDescription>
          {t("translation:noLanguages")}
        </SettingsDescription>
      )}
      {!!choices?.length && (
        <SettingsGroup>
          {choices.map(({ code, name }) => (
            <SettingsRow
              key={code}
              title={name}
              selected={excludedSources.includes(languageCode(code))}
              selectionRole="checkbox"
              onPress={() => {
                try {
                  toggleExcludedSource(db, language, code);
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
