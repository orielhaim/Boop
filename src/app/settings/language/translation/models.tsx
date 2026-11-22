import { useLocalSearchParams } from "expo-router";
import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { ActivityIndicator, Alert } from "react-native";
import {
  GlassSegmentedControl,
  GlassSegmentedControlItem,
} from "@/components/glassyui/glass-segmented-control";
import {
  SettingsDescription,
  SettingsGroup,
  SettingsRow,
} from "@/components/settings/group";
import { useTranslationLanguages } from "@/components/settings/translation-languages";
import { Action, Screen, Search } from "@/components/ui/kit";
import { namespaces } from "@/i18n";
import { useLocal } from "@/services/local-context";

export default function TranslationModels() {
  const { t, i18n } = useTranslation(namespaces);
  const { translation } = useLocal();
  const { needed } = useLocalSearchParams<{ needed?: string }>();
  const { catalog, downloaded, error, retry } = useTranslationLanguages();
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState("all");
  const [busy, setBusy] = useState<string>();
  const working = useRef(false);
  const { downloading, failedDownload } = translation.modelOperation();
  const query = search.trim().toLocaleLowerCase();
  const relevant = new Set(typeof needed === "string" ? needed.split(",") : []);
  const choices = catalog
    ?.filter(
      ({ code, name }) =>
        code.includes(query) || name.toLocaleLowerCase().includes(query),
    )
    .sort((a, b) => a.name.localeCompare(b.name, i18n.resolvedLanguage));
  const installed =
    downloaded && choices?.filter(({ code }) => downloaded.includes(code));
  const requested =
    downloaded &&
    choices?.filter(
      ({ code }) => relevant.has(code) && !downloaded.includes(code),
    );
  const others =
    downloaded &&
    choices?.filter(
      ({ code }) => !relevant.has(code) && !downloaded.includes(code),
    );

  async function remove(code: string) {
    if (working.current) return;
    working.current = true;
    setBusy(code);
    try {
      if (!(await translation.remove(code)))
        throw new Error("model-not-removed");
    } catch {
      Alert.alert(t("translation:removeError"));
    } finally {
      working.current = false;
      setBusy(undefined);
    }
  }

  function row({ code, name }: { code: string; name: string }) {
    const ready = downloaded?.includes(code);
    return (
      <SettingsRow
        key={code}
        title={name}
        detail={t(
          code === downloading
            ? "translation:downloading"
            : ready
              ? "common:ready"
              : code === failedDownload
                ? "translation:downloadFailed"
                : "translation:downloadRequired",
        )}
        onPress={
          busy || downloading || code === "en"
            ? undefined
            : () => {
                if (ready) {
                  Alert.alert(
                    t("translation:remove", { language: name }),
                    undefined,
                    [
                      { text: t("common:cancel"), style: "cancel" },
                      {
                        text: t("common:remove"),
                        style: "destructive",
                        onPress: () => {
                          void remove(code);
                        },
                      },
                    ],
                  );
                } else {
                  Alert.alert(
                    t("translation:download", { language: name }),
                    undefined,
                    [
                      { text: t("common:cancel"), style: "cancel" },
                      {
                        text: t("translation:cellular"),
                        onPress: () => {
                          void translation
                            .download(code, false)
                            .catch(() => undefined);
                        },
                      },
                      {
                        text: t("translation:wifi"),
                        onPress: () => {
                          void translation
                            .download(code, true)
                            .catch(() => undefined);
                        },
                      },
                    ],
                  );
                }
              }
        }
      />
    );
  }

  return (
    <Screen>
      <SettingsDescription>{t("translation:modelHelp")}</SettingsDescription>
      <GlassSegmentedControl
        value={filter}
        onValueChange={setFilter}
        accessibilityLabel={t("translation:manageModels")}
      >
        <GlassSegmentedControlItem value="all">
          {t("translation:allLanguages")}
        </GlassSegmentedControlItem>
        <GlassSegmentedControlItem value="downloaded">
          {t("translation:downloadedFilter")}
        </GlassSegmentedControlItem>
      </GlassSegmentedControl>
      <Search
        value={search}
        onChangeText={setSearch}
        placeholder={t("translation:search")}
      />
      {(!catalog || !downloaded) && !error && <ActivityIndicator />}
      {error && (
        <>
          <SettingsDescription>{t(`translation:${error}`)}</SettingsDescription>
          <Action variant="soft" onPress={retry}>
            {t("common:retry")}
          </Action>
        </>
      )}
      {downloaded &&
        catalog &&
        !(filter === "downloaded" ? installed?.length : choices?.length) && (
          <SettingsDescription>
            {t("translation:noLanguages")}
          </SettingsDescription>
        )}
      {filter === "all" && !!requested?.length && (
        <SettingsGroup title={t("translation:required")}>
          {requested.map(row)}
        </SettingsGroup>
      )}
      {!!installed?.length && (
        <SettingsGroup title={t("translation:downloaded")}>
          {installed.map(row)}
        </SettingsGroup>
      )}
      {filter === "all" && !!others?.length && (
        <SettingsGroup title={t("translation:available")}>
          {others.map(row)}
        </SettingsGroup>
      )}
    </Screen>
  );
}
