import { Bubble, type ChatProps } from "@kesha-antonov/react-native-chat";
import { memo, useCallback, useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";
import { ActivityIndicator, StyleSheet, View } from "react-native";
import { Action, Icon, Ink } from "@/components/ui/kit";
import { firstPreviewUrl } from "@/core/messaging/link-previews";
import { namespaces } from "@/i18n";
import { useLocal } from "@/services/local";
import { radius, space } from "@/theme";
import type { DetailMessage } from "./detail-adapter";

type BubbleProps = Parameters<
  NonNullable<ChatProps<DetailMessage>["renderBubble"]>
>[0];

export const MessageBubble = memo(function MessageBubble({
  bubble,
  peer,
  previewsAllowed,
  canRequest,
  ink,
}: {
  bubble: BubbleProps;
  peer: string;
  previewsAllowed: boolean;
  canRequest: () => boolean;
  ink: string;
}) {
  const { previews } = useLocal();
  const { t } = useTranslation(namespaces);
  const message = bubble.currentMessage;
  const url =
    previewsAllowed &&
    message &&
    !message.locked &&
    !message.media &&
    !message.location
      ? firstPreviewUrl(message.originalText ?? message.text)
      : undefined;
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
  const rich = typeof state === "object" ? state : undefined;
  const hostname = url ? new URL(url).hostname : undefined;
  const request = () => {
    if (message && url)
      previews.request({ peer, id: message._id, url }, true, canRequest);
  };
  const placeholder =
    message && url && policy !== "off" && !rich ? (
      <View style={styles.preview}>
        <Ink kind="caption" style={{ color: ink }} numberOfLines={1}>
          {hostname}
        </Ink>
        {state === "loading" ? (
          <View style={styles.loading}>
            <ActivityIndicator size="small" color={ink} />
            <Ink
              kind="caption"
              style={{ color: ink }}
              accessibilityLiveRegion="polite"
            >
              {t("messages:previewLoading")}
            </Ink>
          </View>
        ) : state === "failed" ? (
          <>
            <Ink
              kind="caption"
              style={{ color: ink }}
              accessibilityLiveRegion="polite"
            >
              {t("messages:previewUnavailable")}
            </Ink>
            <Action size="sm" variant="soft" onPress={request}>
              {t("common:retry")}
            </Action>
          </>
        ) : policy === "on-demand" ? (
          <Action size="sm" variant="soft" onPress={request}>
            {t("messages:previewLoad")}
          </Action>
        ) : null}
      </View>
    ) : null;
  const pinned = message?.isPinned ? (
    <View
      accessible
      accessibilityLabel={t("messages:pinnedMessage")}
      style={styles.pin}
    >
      <Icon name="pin" size={12} color={ink} />
    </View>
  ) : null;
  const customView =
    pinned || placeholder
      ? (props: BubbleProps) => (
          <>
            {bubble.renderCustomView?.(props)}
            {pinned}
            {placeholder}
          </>
        )
      : bubble.renderCustomView;
  return (
    <Bubble
      {...bubble}
      currentMessage={
        message && rich
          ? {
              ...message,
              linkPreview: {
                url: rich.url,
                siteName:
                  hostname && hostname !== rich.siteName.toLowerCase()
                    ? `${hostname} · ${rich.siteName}`
                    : rich.siteName,
                title: rich.title,
                description: rich.description,
                image: previews.imageUri(rich.image),
                imageSize: "small",
              },
            }
          : message
      }
      renderCustomView={customView}
      isCustomViewBottom={
        bubble.isCustomViewBottom ||
        (!bubble.renderCustomView && Boolean(placeholder || pinned))
      }
    />
  );
});

const styles = StyleSheet.create({
  preview: {
    margin: space.xs,
    paddingHorizontal: space.sm,
    paddingVertical: space.xs,
    borderRadius: radius.card,
    backgroundColor: "rgba(128,128,128,0.14)",
    minWidth: 124,
    gap: space.xs,
  },
  loading: { flexDirection: "row", gap: space.xs, alignItems: "center" },
  pin: {
    alignSelf: "flex-end",
    marginHorizontal: space.xs,
    marginVertical: 2,
    opacity: 0.72,
  },
});
