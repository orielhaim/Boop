import { router, useFocusEffect } from "expo-router";
import { useCallback, useState } from "react";
import { useTranslation } from "react-i18next";
import { Alert } from "react-native";
import { SettingsGroup, SettingsRow } from "@/components/settings/group";
import { Screen } from "@/components/ui/kit";
import { marmot } from "@/core/marmot/native";
import { namespaces } from "@/i18n";
import { useLocal } from "@/services/local-context";

export default function MediaStorage() {
  const { marmotSession, mediaSdk } = useLocal();
  const { t, i18n } = useTranslation(namespaces);
  const [bytes, setBytes] = useState<number>();
  const load = useCallback(
    () => marmotSession.ready().then(marmot.storageUsage),
    [marmotSession],
  );
  useFocusEffect(
    useCallback(() => {
      let active = true;
      void load()
        .then((value) => {
          if (active) setBytes(value);
        })
        .catch(() => undefined);
      return () => {
        active = false;
      };
    }, [load]),
  );
  function clear() {
    Alert.alert(t("messages:mediaClear"), t("messages:mediaClearDetail"), [
      { text: t("common:cancel"), style: "cancel" },
      {
        text: t("messages:mediaClear"),
        style: "destructive",
        onPress: () => {
          void marmotSession
            .ready()
            .then(marmot.clearDownloads)
            .then(load)
            .then(setBytes)
            .catch(() => Alert.alert(t("messages:mediaClearError")));
        },
      },
    ]);
  }
  return (
    <Screen>
      <SettingsGroup>
        <SettingsRow
          title={t("messages:voiceUploadServer")}
          icon="connection"
          detail={
            mediaSdk.configured("attachment")[0]?.origin ??
            t("settings:mediaNoCompatible")
          }
          onPress={() => router.push("/settings/connections/media-storage")}
        />
      </SettingsGroup>
      <SettingsGroup>
        <SettingsRow
          title={t("messages:mediaUsage")}
          icon="storage"
          detail={
            bytes === undefined
              ? t("common:unavailable")
              : t("messages:mediaUsageValue", {
                  size: new Intl.NumberFormat(i18n.language, {
                    maximumFractionDigits: 2,
                  }).format(bytes / 1024 / 1024),
                })
          }
        />
        <SettingsRow
          title={t("messages:mediaClear")}
          icon="erase"
          onPress={clear}
        />
      </SettingsGroup>
    </Screen>
  );
}
