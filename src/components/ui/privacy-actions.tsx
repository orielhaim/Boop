import { useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";
import { Alert } from "react-native";
import { namespaces } from "@/i18n";
import { useLocal } from "@/services/local";

export function usePrivacy() {
  const { privacy } = useLocal();
  const revision = useSyncExternalStore(privacy.subscribe, privacy.revision);
  return { ...privacy, revision };
}

export function useBlockAction(key: string, onBlocked?: () => void) {
  const privacy = usePrivacy();
  const { t } = useTranslation(namespaces);
  const blocked = privacy.isBlocked(key);
  return {
    blocked,
    label: blocked ? t("security:unblock") : t("security:block"),
    onPress() {
      const change = (mutate: () => void) => {
        try {
          mutate();
        } catch {
          Alert.alert(t("security:privacyWriteFailed"));
        }
      };
      if (blocked) change(() => privacy.unblock(key));
      else
        Alert.alert(
          t("security:blockConfirm"),
          t("security:blockHelp"),
          [
            { text: t("common:cancel"), style: "cancel" },
            {
              text: t("security:block"),
              style: "destructive",
              onPress: () =>
                change(() => {
                  privacy.block(key);
                  onBlocked?.();
                }),
            },
          ],
          { cancelable: false },
        );
    },
  };
}
