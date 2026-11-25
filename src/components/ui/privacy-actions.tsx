import { useState, useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";
import { useDialog } from "@/components/ui/dialog";
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
  const dialog = useDialog();
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
      dialog.show({ title: t("security:privacyWriteFailed"), tone: "error" });
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
        void dialog.show({
          title: t("security:blockConfirm"),
          message: t("security:blockHelp"),
          dismissible: false,
          actions: [
            { label: t("common:cancel"), tone: "cancel" },
            {
              label: t("security:block"),
              tone: "danger",
              onSelect: () => void change(),
            },
          ],
        });
    },
  };
}
