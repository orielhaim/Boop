import { router } from "expo-router";
import { File, Paths } from "expo-file-system";
import { getDocumentAsync } from "expo-document-picker";
import { useDialog } from "@/components/ui/dialog";
import { useTranslation } from "react-i18next";
import { useStore } from "zustand";
import { Platform } from "react-native";
import { ScreenHeader } from "@/components/navigation/screen-header";
import {
  ListGroup,
  ListRow,
  PreferenceToggle,
} from "@/components/ui/list-group";
import { SettingsMenuRow } from "@/components/settings/menu-row";
import { Screen } from "@/components/ui/kit";
import { openLocalVideo } from "@/core/video/open";
import { readSelectedSubtitles } from "@/core/video/subtitle-files";
import { speeds } from "@/core/audio/types";
import { pipModes, seekIntervals, videoFile } from "@/core/video/types";
import { useLocal } from "@/services/local-context";
import { useAudioActions } from "@/components/audio/actions";

export default function PlaybackSettings() {
  const { t } = useTranslation("audio");
  const dialog = useDialog();
  const { audio, video } = useLocal();
  const { pick } = useAudioActions();
  const prefs = useStore(audio.store, (state) => state.preferences);
  const videoPrefs = useStore(video.store, (state) => state.preferences);
  const { t: videoT } = useTranslation("video");
  async function pickVideo() {
    try {
      const scopedSelection = Platform.OS === "android";
      const result = await getDocumentAsync({
        type: scopedSelection
          ? [
              "video/*",
              "text/*",
              "application/x-subrip",
              "application/x-ass",
              "application/octet-stream",
            ]
          : ["video/*"],
        multiple: scopedSelection,
        copyToCacheDirectory: !scopedSelection,
      });
      if (result.canceled) return;
      const file = result.assets.find((asset) =>
        videoFile(asset.name, asset.mimeType ?? ""),
      );
      if (!file) {
        void dialog.show({
          title: videoT("settings.openFailed"),
          tone: "error",
        });
        return;
      }
      const selected = new File(file.uri);
      const cachePrefix = Paths.cache.uri.endsWith("/")
        ? Paths.cache.uri
        : `${Paths.cache.uri}/`;
      const pickerCopy = file.uri.startsWith(cachePrefix);
      try {
        const opened = await openLocalVideo(
          file.uri,
          file.name,
          file.mimeType ?? undefined,
          scopedSelection && result.assets.length > 1
            ? (signal) =>
                readSelectedSubtitles(result.assets, {
                  relatedTo: file.name,
                  signal,
                })
            : undefined,
        );
        if (!opened)
          void dialog.show({
            title: videoT("settings.openFailed"),
            tone: "error",
          });
      } finally {
        if (pickerCopy && selected.exists) selected.delete();
      }
    } catch {
      void dialog.show({ title: videoT("settings.openFailed"), tone: "error" });
    }
  }
  return (
    <Screen navigationHeader={<ScreenHeader title={t("settings")} />}>
      <ListGroup>
        <SettingsMenuRow
          title={t("openWith")}
          value={prefs.external ? "external" : "internal"}
          options={[
            { value: "internal", label: t("internal") },
            { value: "external", label: t("externalApp") },
          ]}
          onChange={(value) =>
            audio.preferences({ external: value === "external" })
          }
        />
        <SettingsMenuRow
          title={t("voiceSpeed")}
          value={prefs.voiceSpeed}
          options={speeds.map((value) => ({
            value,
            label: t("rate", { speed: value }),
          }))}
          onChange={(voiceSpeed) => audio.preferences({ voiceSpeed })}
        />
      </ListGroup>
      <ListGroup title={videoT("settings.title")}>
        <SettingsMenuRow
          title={videoT("settings.openWith")}
          value={videoPrefs.external ? "external" : "internal"}
          options={[
            { value: "internal", label: videoT("settings.internal") },
            { value: "external", label: videoT("settings.externalApp") },
          ]}
          onChange={(value) =>
            video.preferences({ external: value === "external" })
          }
        />
        <SettingsMenuRow
          title={videoT("settings.seekInterval")}
          value={videoPrefs.seekInterval}
          options={seekIntervals.map((value) => ({
            value,
            label: videoT("settings.seconds", { count: value }),
          }))}
          onChange={(seekInterval) => video.preferences({ seekInterval })}
        />
        <SettingsMenuRow
          title={videoT("settings.pip.title")}
          value={videoPrefs.pipMode}
          options={pipModes.map((value) => ({
            value,
            label: videoT(`settings.pip.${value}`),
          }))}
          onChange={(pipMode) => video.preferences({ pipMode })}
        />
        <PreferenceToggle
          title={videoT("settings.advancedGestures")}
          value={videoPrefs.advancedGestures}
          onChange={(advancedGestures) =>
            video.preferences({ advancedGestures })
          }
        />
        <PreferenceToggle
          title={videoT("settings.rememberPosition")}
          value={videoPrefs.rememberPosition}
          onChange={(rememberPosition) =>
            video.preferences({ rememberPosition })
          }
        />
        <PreferenceToggle
          title={videoT("settings.allowBackground")}
          value={videoPrefs.allowBackground}
          onChange={(allowBackground) => video.preferences({ allowBackground })}
        />
      </ListGroup>
      <ListGroup>
        <ListRow
          icon="audio"
          title={t("nowPlaying")}
          onPress={() => router.navigate("/audio-player")}
        />
        <ListRow
          icon="file"
          title={t("openDevice")}
          onPress={() => void pick()}
        />
        <ListRow
          icon="camera"
          title={videoT("settings.openDevice")}
          onPress={() => void pickVideo()}
        />
      </ListGroup>
    </Screen>
  );
}
