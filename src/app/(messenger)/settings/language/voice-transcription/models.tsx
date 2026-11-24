import type { LocaleStatus } from "@hzblj/expo-speech";
import { router, useFocusEffect, useLocalSearchParams } from "expo-router";
import { useCallback, useState, useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";
import { Platform } from "react-native";
import { speechLocaleName } from "@/components/messages/voice-transcript";
import { ScreenHeader } from "@/components/navigation/screen-header";
import {
  SettingsDescription,
  ListGroup,
  ListRow,
  PreferenceToggle,
} from "@/components/ui/list-group";
import { Screen } from "@/components/ui/kit";
import { LoadingSkeleton } from "@/components/ui/loading-skeleton";
import { useLocal } from "@/services/local-context";

export default function SpeechModelsSettings() {
  const { request } = useLocalSearchParams<{ request?: string }>();
  const { speech } = useLocal();
  const { t, i18n } = useTranslation(["speech", "common"]);
  useSyncExternalStore(speech.subscribe, speech.snapshot);
  const preferences = speech.getPreferences();
  const [models, setModels] =
    useState<Awaited<ReturnType<typeof speech.models>>>();
  const [locale, select] = useState(preferences.preferred ?? undefined);
  const [status, setStatus] = useState<{
    locale: string;
    value: LocaleStatus;
  }>();
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<number>();
  const [error, setError] = useState(false);
  const enabled = preferences.mode !== "off";
  const hasLanguages =
    models && (models.available.length > 0 || models.installed.length > 0);
  const load = useCallback(async () => {
    if (!enabled) return;
    const result = await speech.models();
    setModels(result);
    void speech.resumeModels();
    if (locale && result)
      setStatus({ locale, value: await speech.modelStatus(locale) });
  }, [enabled, locale, speech]);
  useFocusEffect(
    useCallback(() => {
      setLoading(true);
      void load()
        .catch(() => setError(true))
        .finally(() => setLoading(false));
    }, [load]),
  );
  const name = (tag: string) => speechLocaleName(tag, i18n.language);
  const reserved = !!locale && models?.reserved.includes(locale);
  const activeStatus = !locale
    ? undefined
    : status?.locale === locale
      ? status.value
      : models?.installed.includes(locale)
        ? "installed"
        : undefined;
  const sort = (items: string[]) =>
    [...items].sort((a, b) => name(a).localeCompare(name(b), i18n.language));
  function run(work: () => Promise<unknown>) {
    if (busy) return;
    setBusy(true);
    setError(false);
    void work()
      .catch(() => setError(true))
      .finally(() => {
        setProgress(undefined);
        setBusy(false);
      });
  }
  return (
    <Screen
      navigationHeader={
        <ScreenHeader title={t(request ? "otherLanguage" : "models")} />
      }
    >
      {!enabled || (!loading && !hasLanguages) ? (
        <SettingsDescription>
          {t(enabled ? "unsupported" : "off")}
        </SettingsDescription>
      ) : null}
      {enabled && (
        <ListGroup>
          <ListRow
            title={t("reload")}
            disabled={busy}
            onPress={() => run(load)}
          />
          {!request && (
            <ListRow
              title={t("automatic")}
              selected={preferences.preferred === null}
              onPress={() => speech.setPreferences({ preferred: null })}
            />
          )}
          {models && (
            <ListRow
              title={t("engine")}
              value={
                {
                  analyzer: "SpeechAnalyzer",
                  recognizer: "SFSpeechRecognizer",
                  android: "SpeechRecognizer",
                }[models.capability.engine]
              }
            />
          )}
          {!!models?.limit && (
            <ListRow
              title={t("reserved")}
              value={`${models.reserved.length} / ${models.limit}`}
            />
          )}
        </ListGroup>
      )}
      {enabled && loading && !models && !error && (
        <LoadingSkeleton label={t("common:opening")} />
      )}
      {enabled && models && locale && (
        <ListGroup title={name(locale)}>
          <ListRow
            title={t("checkModel")}
            value={
              progress !== undefined
                ? `${Math.round(progress * 100)}%`
                : activeStatus === "unsupported"
                  ? t("modelUnavailable")
                  : t(activeStatus ?? "preparing")
            }
            disabled={busy}
            onPress={() => run(load)}
          />
          {request ? (
            <ListRow
              title={t("choose")}
              disabled={busy}
              onPress={() =>
                run(async () => {
                  if (await speech.chooseLanguage(request, locale))
                    router.back();
                })
              }
            />
          ) : (
            <ListRow
              title={t("selectPreferred")}
              selected={preferences.preferred === locale}
              onPress={() => speech.setPreferences({ preferred: locale })}
            />
          )}
          {!request && (
            <PreferenceToggle
              title={t("selectAdditional")}
              value={preferences.additional.includes(locale)}
              disabled={
                !preferences.additional.includes(locale) &&
                preferences.additional.length >= 4
              }
              onChange={(selected) =>
                speech.setPreferences({
                  additional: selected
                    ? [...preferences.additional, locale]
                    : preferences.additional.filter((item) => item !== locale),
                })
              }
            />
          )}
          {activeStatus === "supported" && (
            <ListRow
              title={t("install")}
              disabled={busy}
              onPress={() =>
                run(async () => {
                  await speech.install(locale, setProgress);
                  await load();
                })
              }
            />
          )}
          {!!models.limit && (reserved || activeStatus === "installed") && (
            <ListRow
              title={t(reserved ? "release" : "reserve")}
              disabled={
                busy || (!reserved && models.reserved.length >= models.limit)
              }
              onPress={() =>
                run(async () => {
                  if (!(await speech.reserve(locale, !reserved)))
                    throw new Error("Model reservation failed");
                  await load();
                })
              }
            />
          )}
        </ListGroup>
      )}
      {enabled && models && Platform.OS === "android" && (
        <SettingsDescription>{t("androidInstall")}</SettingsDescription>
      )}
      {error && <SettingsDescription>{t("installFailed")}</SettingsDescription>}
      {enabled &&
        models &&
        (["installed", "supported"] as const).map((group) => {
          const tags =
            group === "installed"
              ? models.installed
              : models.available.filter(
                  (tag) => !models.installed.includes(tag),
                );
          return (
            tags.length > 0 && (
              <ListGroup title={t(group)} key={group}>
                {sort(tags).map((tag) => (
                  <ListRow
                    key={tag}
                    title={name(tag)}
                    value={tag}
                    selected={locale === tag}
                    disabled={busy}
                    onPress={() => select(tag)}
                  />
                ))}
              </ListGroup>
            )
          );
        })}
    </Screen>
  );
}
