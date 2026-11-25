import { useCallback } from "react";
import { useTranslation } from "react-i18next";
import { AccessibilityInfo, Platform, ToastAndroid } from "react-native";
import { useStore } from "zustand";
import { tapFeedback } from "@/components/ui/kit";
import { useDialog } from "@/components/ui/dialog";
import { useLocal } from "@/services/local-context";
import { opensExternally, trackId, type Track } from "@/core/audio/types";

export function useAudioActions() {
  const dialog = useDialog();
  const { audio, audioSources, lock } = useLocal();
  const { t } = useTranslation("audio");
  const report = useCallback(
    (error?: unknown) => {
      if (lock.getState().locked) return;
      const storage =
        error instanceof Error && error.message === "AudioStorageUnavailable";
      void dialog.show({
        title: t(storage ? "storageUnavailable" : "unavailable"),
        tone: "error",
      });
    },
    [dialog, lock, t],
  );
  const open = useCallback(
    async (track: Track, mode?: "internal" | "external", download = false) => {
      if (lock.getState().locked || audio.store.getState().blocked) return;
      if (
        opensExternally(
          track,
          audio.store.getState().preferences.external,
          mode,
        )
      ) {
        await audio
          .external(track, (signal) =>
            audioSources.external(track, signal, download),
          )
          .catch(report);
        return;
      }
      try {
        const ok = await audio.play(track, download);
        const current = audio.store.getState().current;
        if (
          !ok &&
          current?.phase === "error" &&
          trackId(current.track) === trackId(track)
        )
          report();
      } catch (error) {
        report(error);
      }
    },
    [audio, audioSources, lock, report],
  );
  const queue = useCallback(
    (track: Track, next = false) => {
      if (!audio.enqueue(track, next)) return;
      tapFeedback();
      const feedback = t(next ? "queuedNext" : "added");
      if (Platform.OS === "android")
        ToastAndroid.show(feedback, ToastAndroid.SHORT);
      else AccessibilityInfo.announceForAccessibility(feedback);
    },
    [audio, t],
  );
  const pick = useCallback(
    async (append = false) => {
      try {
        const track = await audioSources.pick();
        if (!track) return;
        if (append) queue(track);
        else await open(track, "internal");
      } catch (error) {
        report(error);
      }
    },
    [audioSources, open, queue, report],
  );
  return { open, pick, queue };
}

export function useAudioTrack(id: string) {
  const { audio, downloads } = useLocal();
  const current = useStore(audio.store, (state) =>
    state.current && trackId(state.current.track) === id
      ? state.current
      : undefined,
  );
  return { audio, downloads, current };
}
