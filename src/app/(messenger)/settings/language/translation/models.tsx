import { LoadingSkeleton } from "@/components/ui/loading-skeleton";
import { ScreenHeader } from "@/components/navigation/screen-header";
import { useLocalSearchParams } from "expo-router";
import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useDialog } from "@/components/ui/dialog";
import {
  GlassSegmentedControl,
  GlassSegmentedControlItem,
} from "@/components/glassyui/glass-segmented-control";
import {
  SettingsDescription,
  ListGroup,
  ListRow,
} from "@/components/ui/list-group";
import { useTranslationLanguages } from "@/components/settings/translation-languages";
import { Action, Screen, Search } from "@/components/ui/kit";
import { namespaces } from "@/i18n";
import { useLocal } from "@/services/local-context";

export default function TranslationModels() {
  const { t, i18n } = useTranslation(namespaces);
  const dialog = useDialog();
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
      void dialog.show({
        title: t("translation:removeError"),
        tone: "error",
      });
    } finally {
      working.current = false;
      setBusy(undefined);
    }
  }

  function row({ code, name }: { code: string; name: string }) {
    const ready = downloaded?.includes(code);
    return (
      <ListRow
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
                  void dialog.show({
                    title: t("translation:remove", { language: name }),
                    tone: "danger",
                    dismissible: false,
                    actions: [
                      { label: t("common:cancel"), tone: "cancel" },
                      {
                        label: t("common:remove"),
                        tone: "danger",
                        onSelect: () => {
                          void remove(code);
                        },
                      },
                    ],
                  });
                } else {
                  void dialog.show({
                    title: t("translation:download", { language: name }),
                    dismissible: false,
                    actions: [
                      { label: t("common:cancel"), tone: "cancel" },
                      {
                        label: t("translation:cellular"),
                        tone: "neutral",
                        onSelect: () => {
                          void translation
                            .download(code, false)
                            .catch(() => undefined);
                        },
                      },
                      {
                        label: t("translation:wifi"),
                        tone: "primary",
                        onSelect: () => {
                          void translation
                            .download(code, true)
                            .catch(() => undefined);
                        },
                      },
                    ],
                  });
                }
              }
        }
      />
    );
  }

  return (
    <Screen
      navigationHeader={<ScreenHeader title={t("translation:manageModels")} />}
    >
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
      {(!catalog || !downloaded) && !error && (
        <LoadingSkeleton label={t("common:opening")} />
      )}
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
        <ListGroup title={t("translation:required")}>
          {requested.map(row)}
        </ListGroup>
      )}
      {!!installed?.length && (
        <ListGroup title={t("translation:downloaded")}>
          {installed.map(row)}
        </ListGroup>
      )}
      {filter === "all" && !!others?.length && (
        <ListGroup title={t("translation:available")}>
          {others.map(row)}
        </ListGroup>
      )}
    </Screen>
  );
}
