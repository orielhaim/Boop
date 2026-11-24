import { router } from "expo-router";
import { useTranslation } from "react-i18next";
import { useStore } from "zustand";
import { ScreenHeader } from "@/components/navigation/screen-header";
import { ListGroup, ListRow } from "@/components/ui/list-group";
import { SettingsMenuRow } from "@/components/settings/menu-row";
import { Screen } from "@/components/ui/kit";
import { speeds } from "@/core/audio/types";
import { useLocal } from "@/services/local-context";
import { useAudioActions } from "@/components/audio/actions";

export default function PlaybackSettings() {
  const { t } = useTranslation("audio");
  const { audio } = useLocal();
  const { pick } = useAudioActions();
  const prefs = useStore(audio.store, (state) => state.preferences);
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
      </ListGroup>
    </Screen>
  );
}
