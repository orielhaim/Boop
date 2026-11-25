import { router } from "expo-router";
import { useState, useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";
import { AppState } from "react-native";
import { useDialog } from "@/components/ui/dialog";
import { ListGroup, ListRow } from "@/components/ui/list-group";
import { useLocal } from "@/services/local-context";

export function SpeechStorage({
  onChange,
  showLink,
}: {
  onChange?: () => void;
  showLink?: boolean;
}) {
  const { speech, lock } = useLocal();
  const { t, i18n } = useTranslation(["speech", "common"]);
  const dialog = useDialog();
  useSyncExternalStore(speech.subscribe, speech.snapshot);
  const { bytes, saved, pending } = speech.stats();
  const [clearing, setClearing] = useState(false);
  const number = new Intl.NumberFormat(i18n.language);
  const size = new Intl.NumberFormat(i18n.language, {
    style: "unit",
    unit: "kilobyte",
    maximumFractionDigits: 1,
  });
  const clear = (temporary: boolean) => {
    const run = () => {
      if (
        AppState.currentState !== "active" ||
        lock.getState().locked ||
        clearing
      )
        return;
      setClearing(true);
      void (temporary ? speech.clearTemporary() : speech.clear())
        .catch(() => {
          void dialog.show({ title: t("failed"), tone: "error" });
        })
        .finally(() => {
          setClearing(false);
          onChange?.();
        });
    };
    if (temporary) run();
    else
      void dialog.show({
        title: t("clear"),
        message: t("clearConfirm"),
        tone: "danger",
        dismissible: false,
        actions: [
          { label: t("common:cancel"), tone: "cancel" },
          {
            label: t("clear"),
            tone: "danger",
            onSelect: run,
          },
        ],
      });
  };
  return (
    <ListGroup title={t("storage")}>
      <ListRow title={t("storage")} value={size.format(bytes / 1000)} />
      <ListRow title={t("saved")} value={number.format(saved)} />
      <ListRow title={t("pending")} value={number.format(pending)} />
      <ListRow
        title={t("clear")}
        disabled={clearing}
        onPress={() => clear(false)}
      />
      <ListRow
        title={t("clearTemporary")}
        disabled={clearing}
        onPress={() => clear(true)}
      />
      {showLink && (
        <ListRow
          title={t("title")}
          onPress={() => router.push("/settings/language/voice-transcription")}
        />
      )}
    </ListGroup>
  );
}
