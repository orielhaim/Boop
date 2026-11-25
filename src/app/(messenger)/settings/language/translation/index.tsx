import { ScreenHeader } from "@/components/navigation/screen-header";
import { router } from "expo-router";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Linking } from "react-native";
import { useDialog } from "@/components/ui/dialog";
import { GlassPanel } from "@/components/glassyui/glass-panel";
import {
  SettingsDescription,
  ListGroup,
  ListRow,
  PreferenceToggle,
} from "@/components/ui/list-group";
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
  const dialog = useDialog();
  const { db, translation } = useLocal();
  const preferences = useTranslationPreferences(
    db,
    resolveLanguage(i18n.resolvedLanguage),
  );
  const { catalog, downloaded, error, retry } = useTranslationLanguages();
  const [notice, setNotice] = useState<string>();
  const target = catalog?.find(({ code }) => code === preferences.target);

  function clear() {
    void dialog.show({
      title: t("translation:clear"),
      message: t("translation:clearConfirm"),
      tone: "danger",
      dismissible: false,
      actions: [
        { label: t("common:cancel"), tone: "cancel" },
        {
          label: t("translation:clear"),
          tone: "danger",
          onSelect: () => {
            try {
              translation.clear();
              setNotice(t("translation:cleared"));
            } catch {
              setNotice(t("translation:saveFailed"));
            }
          },
        },
      ],
    });
  }

  return (
    <Screen navigationHeader={<ScreenHeader title={t("translation:title")} />}>
      <GlassPanel variant="card" style={{ gap: space.sm }}>
        <Icon name="language" size={24} />
        <Ink kind="heading">{t("translation:onDevice")}</Ink>
        <Ink kind="caption" muted>
          {t("translation:privacy")}
        </Ink>
      </GlassPanel>
      <ListGroup>
        <PreferenceToggle
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
        <ListRow
          title={t("translation:target")}
          value={target?.name ?? preferences.target}
          onPress={
            catalog
              ? () => router.push("/settings/language/translation/target")
              : undefined
          }
        />
        <ListRow
          title={t("translation:excluded")}
          value={new Intl.NumberFormat(i18n.resolvedLanguage).format(
            preferences.excludedSources.length,
          )}
          onPress={() => router.push("/settings/language/translation/excluded")}
        />
        <ListRow
          title={t("translation:manageModels")}
          detail={
            target && downloaded && !downloaded.includes(target.code)
              ? t("translation:downloadRequired")
              : undefined
          }
          onPress={() => router.push("/settings/language/translation/models")}
        />
      </ListGroup>
      <ListGroup>
        <ListRow title={t("translation:clear")} onPress={clear} />
      </ListGroup>
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
