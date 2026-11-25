import { File } from "expo-file-system";
import { router, useLocalSearchParams, usePathname } from "expo-router";
import { useEffect, useRef, useSyncExternalStore } from "react";
import { Alert } from "react-native";
import { useTranslation } from "react-i18next";
import { audioFile } from "@/core/audio/types";
import { openLocalVideo } from "@/core/video/open";
import { videoFile } from "@/core/video/types";
import { useLocal } from "@/services/local-context";

export default function IncomingFileRoute() {
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
        Alert.alert(t("settings.openFailed"));
        router.replace("/profile");
        return;
      }
      pendingVideo.current = { uri, name, type };
      router.replace("/profile");
    } catch {
      Alert.alert(t("settings.openFailed"));
      router.replace("/profile");
    }
  }, [lockState.active, lockState.locked, t, uri]);

  useEffect(() => {
    const pending = pendingVideo.current;
    if (!pending || pathname !== "/profile") return;
    pendingVideo.current = undefined;
    void openLocalVideo(pending.uri, pending.name, pending.type)
      .then((success) => {
        if (!success) Alert.alert(t("settings.openFailed"));
      })
      .catch(() => Alert.alert(t("settings.openFailed")));
  }, [pathname, t]);

  return null;
}
