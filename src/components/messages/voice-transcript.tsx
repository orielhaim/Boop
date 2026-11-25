import type { VoiceTranscriptionControl } from "@kesha-antonov/react-native-chat/lib/MessageAudio";
import * as Clipboard from "expo-clipboard";
import { useRouter } from "expo-router";
import {
  lazy,
  useCallback,
  Suspense,
  useEffect,
  useState,
  useSyncExternalStore,
} from "react";
import { useTranslation } from "react-i18next";
import { View } from "react-native";
import { useDialog } from "@/components/ui/dialog";
import { Action, Ink } from "@/components/ui/kit";
import { priority, type SpeechView } from "@/core/speech/scheduler";
import type { SpeechSource } from "@/core/speech/types";
import { useLocal } from "@/services/local-context";

const TimedText = lazy(() => import("./voice-transcript-text"));
const noTranscript: SpeechView = {};

export function useVoiceTranscript(
  source: SpeechSource | undefined,
  local: boolean,
  visible: boolean,
) {
  const dialog = useDialog();
  const { speech } = useLocal();
  const { t, i18n } = useTranslation("speech");
  const router = useRouter();
  const preferences = useSyncExternalStore(
    speech.subscribe,
    speech.getPreferences,
  );
  const available = useSyncExternalStore(speech.subscribe, speech.canPresent);
  const subscribe = useCallback(
    (listener: () => void) => speech.subscribeSource(source, listener),
    [source, speech],
  );
  const view = useSyncExternalStore(subscribe, () =>
    source ? speech.view(source) : noTranscript,
  );
  const [expanded, setExpanded] = useState(false);
  useEffect(() => {
    if (!source || !available || !local || preferences.mode === "off") return;
    speech.refresh(source);
    speech.availableLocally(
      source,
      visible && preferences.visibleFirst
        ? priority.visible
        : priority.retained,
    );
  }, [available, local, preferences, source, speech, visible]);
  if (!source || !available || !local || preferences.mode === "off")
    return undefined;
  const job = view.job;
  const state = view.unsupported ? "unsupported" : (job?.status ?? "available");
  const status =
    state === "completed" && !view.transcript ? "available" : state;
  const busy =
    state === "queued" || state === "preparing" || state === "transcribing";
  const invoke = (work: () => Promise<unknown>) => {
    void work().catch(() => dialog.show({ title: t("failed"), tone: "error" }));
  };
  function chooseLanguage() {
    invoke(async () => {
      const models = await speech.models();
      if (!models || !source) return;
      router.push({
        pathname: "/settings/language/voice-transcription/models",
        params: { request: speech.languageRequest(source) },
      });
    });
  }
  const control: VoiceTranscriptionControl = {
    isVisible: true,
    isOpen: expanded,
    isLoading: busy && !view.transcript,
    label: view.transcript?.text
      ? t(expanded ? "collapse" : "expand")
      : t(status),
    onPress() {
      if (expanded) setExpanded(false);
      else {
        setExpanded(true);
        if (status === "available") invoke(() => speech.request(source));
      }
    },
    render({ player, seek, color }) {
      const transcript = view.transcript;
      const timing = transcript?.words.some(
        (word) => word.timing === "estimated",
      );
      const resolved =
        transcript?.segments.find((part) => part.language)?.language ??
        transcript?.locale;
      return (
        <View style={{ gap: 5 }}>
          {transcript?.text ? (
            <Suspense
              fallback={
                <Ink selectable style={{ color }}>
                  {transcript.text}
                </Ink>
              }
            >
              <TimedText
                transcript={transcript}
                player={player}
                seek={seek}
                color={color}
                highlight={preferences.highlight}
              />
            </Suspense>
          ) : null}
          {resolved && transcript?.text && (
            <Ink kind="caption" style={{ color }}>
              {speechLocaleName(resolved, i18n.language)}
              {timing ? " · " + t("estimated") : ""}
            </Ink>
          )}
          {state !== "completed" && (
            <Ink kind="caption" style={{ color }}>
              {state === "transcribing" && view.progress !== undefined
                ? t("progress", {
                    percent: Math.round(
                      Math.max(0, Math.min(1, view.progress)) * 100,
                    ),
                  })
                : t(status)}
            </Ink>
          )}
          {job && busy && (
            <Action
              size="sm"
              variant="ghost"
              onPress={() => speech.cancel(job)}
            >
              {t("cancelJob")}
            </Action>
          )}
          {job &&
            (state === "failed" ||
              state === "cancelled" ||
              state === "waitingForPermission" ||
              state === "waitingForMedia") && (
              <Action
                size="sm"
                variant="ghost"
                onPress={() => invoke(() => speech.retry(job))}
              >
                {t(state === "waitingForPermission" ? "allowSpeech" : "retry")}
              </Action>
            )}
          {state === "waitingForModel" && (
            <Action
              size="sm"
              variant="ghost"
              onPress={() =>
                router.push("/settings/language/voice-transcription/models")
              }
            >
              {t("models")}
            </Action>
          )}
          {!busy && state !== "available" && !view.unsupported && (
            <Action size="sm" variant="ghost" onPress={chooseLanguage}>
              {t("otherLanguage")}
            </Action>
          )}
          {transcript?.text && (
            <Action
              size="sm"
              variant="ghost"
              onPress={() =>
                invoke(() => Clipboard.setStringAsync(transcript.text))
              }
            >
              {t("copy")}
            </Action>
          )}
          {job && !busy && (
            <Action
              size="sm"
              variant="ghost"
              onPress={() => {
                speech.clearSource(source);
                setExpanded(false);
              }}
            >
              {t("clearOne")}
            </Action>
          )}
        </View>
      );
    },
  };
  return { control, text: view.transcript?.text };
}

export function speechLocaleName(locale: string, displayLocale: string) {
  try {
    return (
      new Intl.DisplayNames([displayLocale], { type: "language" }).of(locale) ??
      locale
    );
  } catch {
    return locale;
  }
}
