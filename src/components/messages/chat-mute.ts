import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { AppState } from "react-native";
import { useDialog, type DialogAction } from "@/components/ui/dialog";
import { chatMuteDurations, muteChats } from "@/core/marmot/chat-mute";
import { marmot } from "@/core/marmot/native";
import { useLocal } from "@/services/local-context";

export function useMuteDuration() {
  const { t } = useTranslation(["messages", "common"]);
  const dialog = useDialog();
  const { isCurrent, lock } = useLocal();

  return (groups: readonly string[], onUpdated?: () => void) => {
    const options: DialogAction[] = chatMuteDurations.map(({ label, ms }) => ({
      label: t(`chatMute.${label}`),
      tone: "neutral",
      async run(signal) {
        if (
          signal.aborted ||
          !isCurrent() ||
          lock.getState().locked ||
          AppState.currentState !== "active"
        )
          return;
        await muteChats(groups, ms, marmot.setChatMuted);
        if (!signal.aborted && isCurrent() && !lock.getState().locked)
          onUpdated?.();
      },
    }));
    void dialog.show({
      title: t("chatMute.title", { count: groups.length }),
      actions: [{ label: t("common:cancel"), tone: "cancel" }, ...options],
    });
  };
}

/** Update mounted UI at the next deadline and recheck the wall clock on resume. */
export function useChatClock(deadlines: readonly number[], enabled: boolean) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (!enabled) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    function update() {
      clearTimeout(timer);
      const current = Date.now();
      setNow(current);
      if (AppState.currentState !== "active") return;
      const next = deadlines.reduce(
        (earliest, deadline) =>
          deadline > current ? Math.min(earliest, deadline) : earliest,
        Infinity,
      );
      if (Number.isFinite(next))
        timer = setTimeout(update, Math.min(next - current, 2_147_483_647));
    }
    update();
    const subscription = AppState.addEventListener("change", update);
    return () => {
      clearTimeout(timer);
      subscription.remove();
    };
  }, [deadlines, enabled]);
  return now;
}
