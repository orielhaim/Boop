import { router } from "expo-router";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Alert, Linking } from "react-native";
import { GlassPanel } from "@/components/glassyui/glass-panel";
import {
  SettingsDescription,
  SettingsGroup,
  SettingsRow,
  SettingsToggle,
} from "@/components/settings/group";
import { TranslationAttribution } from "@/components/settings/translation-attribution";
import { useTranslationLanguages } from "@/components/settings/translation-languages";
import { Action, Icon, Ink, Screen } from "@/components/ui/kit";
import {
  setTranslationPreferences,
  useTranslationPreferences,
} from "@/core/translation/preferences";
import { namespaces, resolveLanguage } from "@/i18n";
import { useLocal } from "@/services/local-context";
import { space } from "@/theme";

export default function TranslationSettings() {
  const { i18n, t } = useTranslation(namespaces);
  const { db, translation } = useLocal();
  const preferences = useTranslationPreferences(
    db,
    resolveLanguage(i18n.resolvedLanguage),
  );
  const { catalog, downloaded, error, retry } = useTranslationLanguages();
  const [notice, setNotice] = useState<string>();
  const target = catalog?.find(({ code }) => code === preferences.target);

  function clear() {
    Alert.alert(t("translation:clear"), t("translation:clearConfirm"), [
      { text: t("common:cancel"), style: "cancel" },
      {
        text: t("translation:clear"),
        style: "destructive",
        onPress: () => {
          try {
            translation.clear();
            setNotice(t("translation:cleared"));
          } catch {
            setNotice(t("translation:saveFailed"));
          }
        },
      },
    ]);
  }

  return (
    <Screen>
      <GlassPanel variant="card" style={{ gap: space.sm }}>
        <Icon name="language" size={24} />
        <Ink kind="heading">{t("translation:onDevice")}</Ink>
        <Ink kind="caption" muted>
          {t("translation:privacy")}
        </Ink>
      </GlassPanel>
      <SettingsGroup>
        <SettingsToggle
          title={t("translation:automatic")}
          value={preferences.automatic}
          disabled={!target && !preferences.automatic}
          onChange={(automatic) => {
            try {
              setTranslationPreferences(db, { ...preferences, automatic });
              setNotice(undefined);
            } catch {
              setNotice(t("translation:saveFailed"));
            }
          }}
        />
        <SettingsRow
          title={t("translation:target")}
          value={target?.name ?? preferences.target}
          onPress={
            catalog
              ? () => router.push("/settings/language/translation/target")
              : undefined
          }
        />
        <SettingsRow
          title={t("translation:excluded")}
          value={new Intl.NumberFormat(i18n.resolvedLanguage).format(
            preferences.excludedSources.length,
          )}
          onPress={() => router.push("/settings/language/translation/excluded")}
        />
        <SettingsRow
          title={t("translation:manageModels")}
          detail={
            target && downloaded && !downloaded.includes(target.code)
              ? t("translation:downloadRequired")
              : undefined
          }
          onPress={() => router.push("/settings/language/translation/models")}
        />
      </SettingsGroup>
      <SettingsGroup>
        <SettingsRow title={t("translation:clear")} onPress={clear} />
      </SettingsGroup>
      {error && (
        <>
          <SettingsDescription>{t(`translation:${error}`)}</SettingsDescription>
          <Action variant="soft" onPress={retry}>
            {t("common:retry")}
          </Action>
        </>
      )}
      {notice && <SettingsDescription>{notice}</SettingsDescription>}
      <TranslationAttribution />
      <Action
        size="sm"
        variant="ghost"
        onPress={() => {
          void Linking.openURL(
            "https://developers.google.com/ml-kit/language/translation",
          ).catch(() => undefined);
        }}
      >
        {t("translation:learnMore")}
      </Action>
      <SettingsDescription>{t("translation:disclaimer")}</SettingsDescription>
    </Screen>
  );
}
