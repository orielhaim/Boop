import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useDialog } from "@/components/ui/dialog";

export function usePluginAction() {
  const { t } = useTranslation("settings");
  const dialog = useDialog();
  const pending = useRef(false);
  const [busy, setBusy] = useState(false);
  async function run(action: () => Promise<unknown>) {
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    try {
      await action();
    } catch {
      void dialog.show({ title: t("pluginActionFailed"), tone: "error" });
    } finally {
      pending.current = false;
      setBusy(false);
    }
  }
  return { busy, run };
}
