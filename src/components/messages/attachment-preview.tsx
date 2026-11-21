import type { PickedAttachment } from "@kesha-antonov/react-native-chat";
import { Image } from "expo-image";
import { File } from "expo-file-system";
import { useVideoPlayer, VideoView } from "expo-video";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Action, Icon } from "@/components/ui/kit";
import { validateAttachmentFile } from "@/core/media/file-format";
import { maxAttachmentBytes } from "@/core/media/protocol";
import { localPickerUri } from "@/core/media/prepare";
import { mediaLabels } from "./media-label";

export type MediaPick = Exclude<PickedAttachment, { type: "location" }>;

function VideoPreview({ uri }: { uri: string }) {
  const player = useVideoPlayer({ uri, useCaching: false });
  return (
    <VideoView
      player={player}
      style={styles.preview}
      nativeControls
      allowsPictureInPicture={false}
    />
  );
}

function SelectedVideo({ uri, color }: { uri: string; color: string }) {
  const { t } = useTranslation("messages");
  const [state, setState] = useState<"preparing" | "ready" | "failed">(
    "preparing",
  );
  useEffect(() => {
    let active = true;
    void (async () => {
      const file = new File(uri);
      if (
        !localPickerUri(uri) ||
        file.size <= 0 ||
        file.size > maxAttachmentBytes - 16
      )
        throw new Error("media-format");
      validateAttachmentFile(file, { kind: "video", mime: "video/mp4" });
      if (active) setState("ready");
    })().catch(() => {
      if (active) setState("failed");
    });
    return () => {
      active = false;
    };
  }, [uri]);
  if (state === "ready") return <VideoPreview uri={uri} />;
  return (
    <Text style={[styles.file, { color }]}>
      {t(state === "failed" ? "mediaOpenFailed" : "mediaVerifying")}
    </Text>
  );
}

export function AttachmentPreview({
  items,
  color,
  background,
  allowVideo,
  reducedMotion,
  onClose,
  onSend,
}: {
  items: readonly MediaPick[];
  color: string;
  background: string;
  allowVideo: boolean;
  reducedMotion: boolean;
  onClose: () => void;
  onSend: (caption: string) => void;
}) {
  const { t } = useTranslation(["common", "messages"]);
  const [caption, setCaption] = useState("");
  const [index, setIndex] = useState(0);
  const [playing, setPlaying] = useState(false);
  const inset = useSafeAreaInsets();
  const item = items[index];
  if (!item || !localPickerUri(item.uri)) return null;
  return (
    <Modal
      visible
      animationType={reducedMotion ? "none" : "fade"}
      onRequestClose={onClose}
    >
      <KeyboardAvoidingView
        behavior={Platform.OS === "ios" ? "padding" : undefined}
        style={[
          styles.container,
          {
            backgroundColor: background,
            paddingTop: inset.top + 12,
            paddingBottom: inset.bottom + 12,
          },
        ]}
      >
        <Text style={[styles.title, { color }]}>
          {t("messages:mediaPreview")}
        </Text>
        <View style={styles.stage}>
          {item.type === "image" ? (
            <Image
              source={{ uri: item.uri }}
              style={styles.preview}
              contentFit="contain"
              cachePolicy="none"
            />
          ) : item.type === "video" && playing && allowVideo ? (
            <SelectedVideo key={item.uri} uri={item.uri} color={color} />
          ) : (
            <Pressable
              disabled={item.type !== "video" || !allowVideo}
              onPress={() => setPlaying(true)}
              accessibilityRole={item.type === "video" ? "button" : undefined}
              accessibilityLabel={
                item.type === "video" ? t("messages:mediaPlay") : undefined
              }
              style={styles.file}
            >
              <Icon
                name={item.type === "video" ? "play" : "storage"}
                size={36}
                color={color}
              />
              <Text style={{ color }}>
                {item.type === "file" ? item.name : t("messages:mediaVideo")}
              </Text>
            </Pressable>
          )}
        </View>
        {items.length > 1 ? (
          <ScrollView
            horizontal
            style={styles.strip}
            keyboardShouldPersistTaps="handled"
          >
            {items.map((next, i) => (
              <Pressable
                key={next.uri}
                accessibilityRole="button"
                accessibilityLabel={`${t(mediaLabels[next.type])} ${i + 1}`}
                accessibilityState={{ selected: index === i }}
                style={[
                  styles.tile,
                  { borderColor: index === i ? color : "transparent" },
                ]}
                onPress={() => {
                  setPlaying(false);
                  setIndex(i);
                }}
              >
                {next.type === "image" && localPickerUri(next.uri) ? (
                  <Image
                    source={{ uri: next.uri }}
                    style={StyleSheet.absoluteFill}
                    cachePolicy="none"
                  />
                ) : (
                  <Icon
                    name={next.type === "video" ? "camera" : "storage"}
                    color={color}
                    size={22}
                  />
                )}
              </Pressable>
            ))}
          </ScrollView>
        ) : null}
        <TextInput
          value={caption}
          onChangeText={setCaption}
          maxLength={2000}
          multiline
          placeholder={t("messages:mediaCaption")}
          placeholderTextColor={color}
          accessibilityLabel={t("messages:mediaCaption")}
          style={[styles.caption, { color, borderColor: color }]}
        />
        <View style={styles.actions}>
          <Action onPress={onClose}>{t("common:cancel")}</Action>
          <Action onPress={() => onSend(caption)}>{t("messages:send")}</Action>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, paddingHorizontal: 16, gap: 12 },
  title: { fontSize: 20, fontWeight: "600" },
  stage: { flex: 1, minHeight: 120, justifyContent: "center" },
  preview: { width: "100%", height: "100%" },
  file: { alignItems: "center", gap: 12, padding: 18 },
  strip: { flexGrow: 0, height: 58 },
  tile: {
    width: 54,
    height: 54,
    marginEnd: 6,
    borderRadius: 10,
    borderWidth: 2,
    overflow: "hidden",
    alignItems: "center",
    justifyContent: "center",
  },
  caption: {
    minHeight: 44,
    maxHeight: 100,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 12,
    padding: 10,
    textAlign: "auto",
  },
  actions: { flexDirection: "row", justifyContent: "flex-end", gap: 8 },
});
