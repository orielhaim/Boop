import { File } from "expo-file-system";
import { router, useLocalSearchParams, usePathname } from "expo-router";
import { useEffect, useRef, useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";
import { audioFile } from "@/core/audio/types";
import { openLocalVideo } from "@/core/video/open";
import { videoFile } from "@/core/video/types";
import { useLocal } from "@/services/local-context";
import { useWindowDialog } from "@/components/ui/dialog";

export default function IncomingFileRoute() {
  const dialog = useWindowDialog();
  const { uri: parameter } = useLocalSearchParams<{ uri?: string }>();
  const uri = typeof parameter === "string" ? parameter : undefined;
  const { lock } = useLocal();
  const lockState = useSyncExternalStore(lock.subscribe, lock.getState);
  const opened = useRef<string | undefined>(undefined);
  const pendingVideo = useRef<
    { uri: string; name?: string; type: string } | undefined
  >(undefined);
  const pathname = usePathname();
  const { t } = useTranslation("video");

  useEffect(() => {
    if (!uri || lockState.locked || !lockState.active || opened.current === uri)
      return;
    opened.current = uri;
    try {
      const file = new File(uri);
      const type = file.type;
      const name = file.name || undefined;
      if (audioFile(name ?? "", type)) {
        router.replace({
          pathname: "/audio-player",
          params: { incomingAudio: uri },
        });
        return;
      }
      if (!videoFile(name ?? "", type)) {
        void dialog.show({ title: t("settings.openFailed"), tone: "error" });
        router.replace("/profile");
        return;
      }
      pendingVideo.current = { uri, name, type };
      router.replace("/profile");
    } catch {
      void dialog.show({ title: t("settings.openFailed"), tone: "error" });
      router.replace("/profile");
    }
  }, [dialog, lockState.active, lockState.locked, t, uri]);

  useEffect(() => {
    const pending = pendingVideo.current;
    if (!pending || pathname !== "/profile") return;
    pendingVideo.current = undefined;
    void openLocalVideo(pending.uri, pending.name, pending.type)
      .then((success) => {
        if (!success)
          void dialog.show({ title: t("settings.openFailed"), tone: "error" });
      })
      .catch(() =>
        dialog.show({ title: t("settings.openFailed"), tone: "error" }),
      );
  }, [dialog, pathname, t]);

  return null;
}
