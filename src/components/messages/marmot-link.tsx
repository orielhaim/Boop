import { Image } from "expo-image";
import { useCallback, useEffect, useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";
import { AppState, Linking, View } from "react-native";
import { useDialog } from "@/components/ui/dialog";
import { StyleSheet } from "react-native-unistyles";
import { router } from "expo-router";
import { Action, Ink } from "@/components/ui/kit";
import { firstPreviewUrl } from "@/core/messaging/link-previews";
import { firstBlossomDownload } from "@/core/downloads/blossom";
import { namespaces } from "@/i18n";
import { useLocal } from "@/services/local-context";
import { space } from "@/theme";

export function MarmotLink({
  group,
  id,
  body,
  author,
  eligible,
}: {
  group: string;
  id: string;
  body: string;
  author: string;
  eligible: boolean;
}) {
  const { t } = useTranslation(namespaces);
  const dialog = useDialog();
  const { previews, lock, downloads } = useLocal();
  const blob = eligible ? firstBlossomDownload(body, author) : undefined;
  const url = eligible && !blob ? firstPreviewUrl(body) : undefined;
  const subscribe = useCallback(
    (listener: () => void) =>
      url ? previews.subscribe(url, listener) : () => {},
    [previews, url],
  );
  const snapshot = useCallback(
    () => (url ? previews.snapshot(url) : undefined),
    [previews, url],
  );
  const state = useSyncExternalStore(subscribe, snapshot);
  const policy = useSyncExternalStore(subscribe, previews.policy);
  const request = useCallback(
    (explicit: boolean) => {
      if (!url) return;
      previews.request(
        { peer: group, id, url },
        explicit,
        () => AppState.currentState === "active" && !lock.getState().locked,
      );
    },
    [group, id, lock, previews, url],
  );
  useEffect(() => {
    if (policy === "always" && !state) request(false);
  }, [policy, request, state]);
  if (blob)
    return (
      <Action
        size="sm"
        onPress={() => {
          if (AppState.currentState !== "active" || lock.getState().locked)
            return;
          try {
            downloads.enqueue(blob);
            router.push("/downloads");
          } catch {
            dialog.show({
              title: t("downloads:actionFailed"),
              tone: "error",
            });
          }
        }}
      >
        {t("messages:mediaDownload")}
      </Action>
    );
  if (!url || policy === "off") return null;
  if (typeof state !== "object") {
    return (
      <Action
        size="sm"
        disabled={state === "loading"}
        onPress={() => request(true)}
      >
        {state === "loading"
          ? t("messages:previewLoading")
          : state === "failed"
            ? t("common:retry")
            : t("messages:previewLoad")}
      </Action>
    );
  }
  const thumbnail = previews.imageUri(state.image);
  return (
    <View style={styles.card}>
      {thumbnail && (
        <Image source={thumbnail} style={styles.image} contentFit="cover" />
      )}
      <Ink kind="caption">{state.siteName}</Ink>
      {state.title && <Ink numberOfLines={2}>{state.title}</Ink>}
      {state.description && (
        <Ink kind="caption" numberOfLines={3}>
          {state.description}
        </Ink>
      )}
      <Action
        size="sm"
        onPress={() => {
          void Linking.openURL(url).catch(() => undefined);
        }}
      >
        {new URL(url).hostname}
      </Action>
    </View>
  );
}

const styles = StyleSheet.create({
  card: { margin: space.sm, gap: space.xs },
  image: { width: 96, height: 64 },
});
