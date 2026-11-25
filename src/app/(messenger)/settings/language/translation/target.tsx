import { LoadingSkeleton } from "@/components/ui/loading-skeleton";
import { ScreenHeader } from "@/components/navigation/screen-header";
import { router } from "expo-router";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useDialog } from "@/components/ui/dialog";
import { GlassPanel } from "@/components/glassyui/glass-panel";
import {
  SettingsDescription,
  ListGroup,
  ListRow,
} from "@/components/ui/list-group";
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
  const dialog = useDialog();
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
    <Screen navigationHeader={<ScreenHeader title={t("translation:target")} />}>
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
      {!catalog && !error && <LoadingSkeleton label={t("common:opening")} />}
      {catalog && !choices?.length && (
        <SettingsDescription>
          {t("translation:noLanguages")}
        </SettingsDescription>
      )}
      {!!choices?.length && (
        <ListGroup title={t("translation:available")}>
          {choices.map(({ code, name }) => (
            <ListRow
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
                  void dialog.show({
                    title: t("translation:saveFailed"),
                    tone: "error",
                  });
                }
              }}
            />
          ))}
        </ListGroup>
      )}
    </Screen>
  );
}
