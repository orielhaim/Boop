import { useState, useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";
import { Alert } from "react-native";
import { namespaces } from "@/i18n";
import { useLocal } from "@/services/local-context";

export function usePrivacy() {
  const { privacy } = useLocal();
  const revision = useSyncExternalStore(privacy.subscribe, privacy.revision);
  return { ...privacy, revision };
}

export function useBlockAction(key: string, onBlocked?: () => void) {
  const {
    privacy: { blocks },
  } = useLocal();
  const { t } = useTranslation(namespaces);
  const snapshot = useSyncExternalStore(blocks.subscribe, blocks.snapshot);
  const blocked = snapshot.status === "ready" && snapshot.keys.has(key);
  const [pending, setPending] = useState(false);
  const change = async () => {
    setPending(true);
    try {
      if (blocked) await blocks.unblock(key);
      else {
        await blocks.block(key);
        onBlocked?.();
      }
    } catch {
      Alert.alert(t("security:privacyWriteFailed"));
    } finally {
      setPending(false);
    }
  };
  return {
    blocked,
    label: blocked ? t("security:unblock") : t("security:block"),
    disabled: pending || snapshot.status !== "ready",
    onPress() {
      if (pending || snapshot.status !== "ready") return;
      if (blocked) void change();
      else
        Alert.alert(
          t("security:blockConfirm"),
          t("security:blockHelp"),
          [
            { text: t("common:cancel"), style: "cancel" },
            {
              text: t("security:block"),
              style: "destructive",
              onPress: () => void change(),
            },
          ],
          { cancelable: false },
        );
    },
  };
}
