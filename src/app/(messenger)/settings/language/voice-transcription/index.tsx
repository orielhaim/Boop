import type { SpeechAvailability } from "@hzblj/expo-speech";
import { router } from "expo-router";
import { useEffect, useState, useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";
import { Alert, Platform, TextInput, View } from "react-native";
import { speechLocaleName } from "@/components/messages/voice-transcript";
import { ScreenHeader } from "@/components/navigation/screen-header";
import {
  SettingsDescription,
  SettingsGroup,
  SettingsRow,
  SettingsToggle,
} from "@/components/settings/group";
import { SpeechStorage } from "@/components/settings/speech-storage";
import { Screen } from "@/components/ui/kit";
import { SaveButton } from "@/components/ui/save-button";
import type { SpeechPreferences } from "@/core/speech/types";
import { useLocal } from "@/services/local-context";
import { space, useTheme } from "@/theme";

export default function VoiceTranscriptionSettings() {
  const { speech } = useLocal();
  const { t, i18n } = useTranslation("speech");
  const { colors } = useTheme();
  useSyncExternalStore(speech.subscribe, speech.snapshot);
  const preferences = speech.getPreferences();
  const enabled = preferences.mode !== "off";
  const automatic = preferences.mode === "automatic";
  const [capability, setCapability] = useState<SpeechAvailability>();
  const [advanced, setAdvanced] = useState(false);
  const [vocabulary, setVocabulary] = useState(preferences.vocabulary);
  useEffect(() => {
    if (!enabled) return;
    let current = true;
    void speech
      .capabilities()
      .then((result) => {
        if (current) setCapability(result);
      })
      .catch(() => undefined);
    return () => {
      current = false;
    };
  }, [enabled, speech]);
  const save = (update: Partial<SpeechPreferences>) => {
    try {
      speech.setPreferences(update);
      return true;
    } catch {
      Alert.alert(t("failed"));
      return false;
    }
  };
  return (
    <Screen navigationHeader={<ScreenHeader title={t("title")} />}>
      <SettingsDescription>{t("privacy")}</SettingsDescription>
      <SettingsGroup>
        <SettingsToggle
          title={t("enabled")}
          value={enabled}
          onChange={(value) => save({ mode: value ? "demand" : "off" })}
        />
        {enabled && (
          <SettingsRow
            title={t("demand")}
            selected={!automatic}
            onPress={() => save({ mode: "demand" })}
          />
        )}
        {enabled && (
          <SettingsRow
            title={t("automatic")}
            detail={t("automaticDetail")}
            selected={automatic}
            onPress={() => save({ mode: "automatic" })}
          />
        )}
      </SettingsGroup>
      {enabled && (
        <SettingsGroup title={t("preferred")}>
          <SettingsRow
            title={t("preferred")}
            value={
              preferences.preferred
                ? speechLocaleName(preferences.preferred, i18n.language)
                : t("automatic")
            }
            onPress={() =>
              router.push("/settings/language/voice-transcription/models")
            }
          />
          <SettingsRow
            title={t("models")}
            onPress={() =>
              router.push("/settings/language/voice-transcription/models")
            }
          />
          <SettingsToggle
            title={t("highlight")}
            value={preferences.highlight}
            onChange={(highlight) => save({ highlight })}
          />
        </SettingsGroup>
      )}
      {automatic && (
        <SettingsGroup title={t("automatic")}>
          {(
            [
              "incoming",
              "outgoing",
              "downloaded",
              "visibleFirst",
              "charging",
              "respectLowPower",
            ] as const
          ).map((field) => (
            <SettingsToggle
              key={field}
              title={t(field)}
              value={preferences[field]}
              onChange={(value) => save({ [field]: value })}
            />
          ))}
          <SettingsRow
            title={t("duration")}
            value={t("seconds", { count: preferences.maxDuration })}
            onPress={() => {
              const lengths = [30, 60, 120, 300, 600];
              save({
                maxDuration:
                  lengths[
                    (lengths.indexOf(preferences.maxDuration) + 1) %
                      lengths.length
                  ],
              });
            }}
          />
        </SettingsGroup>
      )}
      {enabled && (
        <SettingsGroup title={t("modelDownloads")}>
          <SettingsRow
            title={t("manual")}
            selected={preferences.modelDownloads === "manual"}
            onPress={() => save({ modelDownloads: "manual" })}
          />
          <SettingsRow
            title={t("wifi")}
            detail={t("wifiDetail")}
            selected={preferences.modelDownloads === "wifi"}
            onPress={() => save({ modelDownloads: "wifi" })}
          />
        </SettingsGroup>
      )}
      {enabled && (
        <SettingsGroup>
          <SettingsRow
            title={t("advanced")}
            expanded={advanced}
            onPress={() => setAdvanced(!advanced)}
          />
          {advanced && (
            <SettingsRow
              title={t("onDevice")}
              value={
                capability?.fileTranscription && capability.onDevice
                  ? "✓"
                  : t("modelUnavailable")
              }
            />
          )}
          {advanced && capability && (
            <SettingsRow
              title={t("engine")}
              value={
                {
                  analyzer: "SpeechAnalyzer",
                  recognizer: "SFSpeechRecognizer",
                  android: "SpeechRecognizer",
                }[capability.engine]
              }
            />
          )}
          {advanced && capability?.fileTranscription && (
            <SettingsRow
              title={t("recognitionMode")}
              value={t(preferences.recognitionMode)}
              onPress={() =>
                save({
                  recognitionMode:
                    preferences.recognitionMode === "dictation"
                      ? "transcription"
                      : "dictation",
                })
              }
            />
          )}
          {advanced &&
            capability?.fileTranscription &&
            (capability.engine !== "analyzer" ||
              preferences.recognitionMode === "dictation") && (
              <SettingsToggle
                title={t("punctuation")}
                value={preferences.punctuation}
                onChange={(punctuation) => save({ punctuation })}
              />
            )}
          {advanced &&
            capability?.fileTranscription &&
            Platform.OS === "android" && (
              <SettingsToggle
                title={t("alternatives")}
                value={preferences.alternatives}
                onChange={(alternatives) => save({ alternatives })}
              />
            )}
          {advanced &&
            capability?.fileTranscription &&
            capability.engine !== "recognizer" && (
              <SettingsToggle
                title={t("masking")}
                value={preferences.masking}
                onChange={(masking) => save({ masking })}
              />
            )}
          {advanced &&
            capability?.fileTranscription &&
            (capability.engine !== "analyzer" ||
              preferences.recognitionMode === "dictation") && (
              <View style={{ gap: space.sm, padding: space.lg }}>
                <TextInput
                  value={vocabulary}
                  onChangeText={setVocabulary}
                  accessibilityLabel={t("vocabulary")}
                  placeholder={t("vocabularyHint")}
                  placeholderTextColor={colors.muted}
                  maxLength={1000}
                  multiline
                  style={{ color: colors.text, minHeight: 46 }}
                />
                <SaveButton
                  disabled={vocabulary === preferences.vocabulary}
                  label={t("save")}
                  onSave={() => save({ vocabulary })}
                />
              </View>
            )}
        </SettingsGroup>
      )}
      <SpeechStorage />
    </Screen>
  );
}
