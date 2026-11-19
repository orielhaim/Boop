import { reloadAppAsync } from "expo";
import { CameraView, useCameraPermissions } from "expo-camera";
import { randomUUID } from "expo-crypto";
import { getDocumentAsync } from "expo-document-picker";
import { File, Paths } from "expo-file-system";
import * as Authentication from "expo-local-authentication";
import { Stack, useFocusEffect, useLocalSearchParams } from "expo-router";
import * as ScreenCapture from "expo-screen-capture";
import { shareAsync } from "expo-sharing";
import { useCallback, useId, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  ActivityIndicator,
  Alert,
  AppState,
  Platform,
  View,
} from "react-native";
import { GlassInput } from "@/components/glassyui/glass-input";
import { Action, Ink, layout, Screen } from "@/components/ui/kit";
import { exportIdentity, stageIdentity } from "@/core/identity";
import { backupKind, readBackup } from "@/core/identity/backup";
import { namespaces } from "@/i18n";
import { useLocal } from "@/services/local";

const paint = () => new Promise<void>((resolve) => setTimeout(resolve, 32));
const secretInput = {
  secureTextEntry: true,
  autoCapitalize: "none",
  autoCorrect: false,
  spellCheck: false,
  maxLength: 512,
} as const;

export default function DigitalSim() {
  const { t } = useTranslation(namespaces);
  const { mode } = useLocalSearchParams<{ mode?: string }>();
  const exporting = mode === "export";
  const { db, identity, calling, lock } = useLocal();
  const protection = useId();
  const [protectedWindow, setProtectedWindow] = useState(false);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");
  const [input, setInput] = useState("");
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [candidate, setCandidate] = useState<ReturnType<
    typeof readBackup
  > | null>(null);
  const [scan, setScan] = useState(false);
  const [permission, requestPermission] = useCameraPermissions();
  const focus = useRef(0);
  const working = useRef(false);
  useFocusEffect(
    useCallback(() => {
      const token = ++focus.current;
      let applied = false;
      let blurApplied = false;
      const clear = () => {
        setInput("");
        setPassword("");
        setConfirmation("");
        setCandidate(null);
        setScan(false);
      };
      const release = () => {
        if (applied)
          void ScreenCapture.allowScreenCaptureAsync(protection).catch(
            () => undefined,
          );
        if (blurApplied && !lock.getState().enabled)
          void ScreenCapture.disableAppSwitcherProtectionAsync().catch(
            () => undefined,
          );
      };
      void (async () => {
        try {
          await ScreenCapture.preventScreenCaptureAsync(protection);
          applied = true;
          if (Platform.OS === "ios" && !lock.getState().enabled) {
            await ScreenCapture.enableAppSwitcherProtectionAsync(1);
            blurApplied = true;
          }
          if (focus.current === token) setProtectedWindow(true);
          else release();
        } catch {
          release();
          if (focus.current === token) setStatus(t("security:backupFailed"));
        }
      })();
      const state = AppState.addEventListener("change", (next) => {
        if (next !== "active") clear();
      });
      return () => {
        focus.current++;
        setProtectedWindow(false);
        clear();
        state.remove();
        release();
      };
    }, [lock, protection, t]),
  );

  async function perform(action: (live: () => boolean) => Promise<void>) {
    if (working.current || !protectedWindow) return;
    working.current = true;
    setBusy(true);
    setStatus("");
    const token = focus.current;
    const current = () => focus.current === token;
    const live = () =>
      current() &&
      AppState.currentState === "active" &&
      !lock.getState().locked;
    try {
      await action(live);
    } catch (error) {
      if (current())
        setStatus(
          t(
            error instanceof Error && error.message === "backup-cost"
              ? "security:backupCost"
              : "security:backupFailed",
          ),
        );
    } finally {
      working.current = false;
      setBusy(false);
    }
  }

  function share() {
    if (password.normalize("NFKC").length < 16 || password !== confirmation) {
      setStatus(t("security:passwordsMismatch"));
      return;
    }
    void perform(async (live) => {
      const level = await Authentication.getEnrolledLevelAsync();
      if (level !== Authentication.SecurityLevel.NONE) {
        const confirmed = await lock.confirmSensitive(async () => {
          const result = await Authentication.authenticateAsync({
            promptMessage: t("security:exportSim"),
            biometricsSecurityLevel: "strong",
            cancelLabel: t("common:cancel"),
          });
          return result.success;
        });
        if (!confirmed) return;
      }
      await paint();
      if (!live()) return;
      const backup = await exportIdentity(db, password);
      setPassword("");
      setConfirmation("");
      if (!live()) return;
      const file = new File(Paths.cache, `boop-${randomUUID()}.ncryptsec.txt`);
      try {
        file.create();
        file.write(backup);
        await shareAsync(file.uri, {
          mimeType: "text/plain",
          UTI: "public.plain-text",
          dialogTitle: t("security:shareBackup"),
        });
      } finally {
        if (file.exists) file.delete();
      }
    });
  }

  function chooseFile() {
    void perform(async (live) => {
      const picked = await getDocumentAsync({
        type: "*/*",
        copyToCacheDirectory: false,
      });
      if (picked.canceled) return;
      const asset = picked.assets[0];
      if (!asset) return;
      const file = new File(asset.uri);
      const size = asset.size ?? file.size;
      if (size > 512) throw new Error("invalid-backup");
      const handle = file.open();
      try {
        const bytes = await handle.readBytes(513);
        try {
          if (bytes.length === 0 || bytes.length > 512)
            throw new Error("invalid-backup");
          if (live())
            setInput(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
        } finally {
          bytes.fill(0);
        }
      } finally {
        handle.close();
      }
    });
  }

  function check() {
    void perform(async (live) => {
      await paint();
      if (!live()) return;
      const imported = readBackup(input, password);
      setInput("");
      setPassword("");
      if (imported.identity.publicKey === identity.publicKey) {
        await stageIdentity(db, imported.secret);
        if (live()) setStatus(t("security:sameIdentity"));
      } else setCandidate(imported);
    });
  }

  function replace() {
    if (!candidate) return;
    Alert.alert(
      t("security:replaceIdentity"),
      t("security:replacementWarning"),
      [
        { text: t("common:cancel"), style: "cancel" },
        {
          text: t("security:replaceIdentity"),
          style: "destructive",
          onPress: () => {
            void perform(async (live) => {
              if (!live()) return;
              await stageIdentity(db, candidate.secret);
              setCandidate(null);
              setStatus(t("security:restartForSim"));
              calling.end();
              await reloadAppAsync("Activate staged Digital SIM").catch(
                () => undefined,
              );
            });
          },
        },
      ],
    );
  }

  return (
    <Screen>
      <Stack.Screen
        options={{
          title: t(exporting ? "security:exportSim" : "security:importSim"),
        }}
      />
      <Ink>{t("security:backupScope")}</Ink>
      <Ink kind="label">{t("security:currentIdentity")}</Ink>
      <Ink kind="caption" selectable>
        {identity.npub}
      </Ink>
      {protectedWindow &&
        (exporting ? (
          <>
            <Ink muted>{t("security:passwordHint")}</Ink>
            <GlassInput
              {...secretInput}
              value={password}
              onChangeText={setPassword}
              label={t("security:backupPassword")}
              editable={!busy}
            />
            <GlassInput
              {...secretInput}
              value={confirmation}
              onChangeText={setConfirmation}
              label={t("security:confirmPassword")}
              editable={!busy}
            />
            <Action variant="prominent" disabled={busy} onPress={share}>
              {t("security:shareBackup")}
            </Action>
          </>
        ) : candidate ? (
          <>
            <Ink kind="label">{t("security:importedIdentity")}</Ink>
            <Ink kind="caption" selectable>
              {candidate.identity.npub}
            </Ink>
            <Ink muted>{t("security:replacementWarning")}</Ink>
            <View style={layout.row}>
              <Action disabled={busy} onPress={() => setCandidate(null)}>
                {t("common:cancel")}
              </Action>
              <Action variant="prominent" disabled={busy} onPress={replace}>
                {t("security:replaceIdentity")}
              </Action>
            </View>
          </>
        ) : (
          <>
            <GlassInput
              {...secretInput}
              value={input}
              onChangeText={setInput}
              label={t("security:backupInput")}
              editable={!busy}
            />
            {backupKind(input) === "encrypted" && (
              <GlassInput
                {...secretInput}
                value={password}
                onChangeText={setPassword}
                label={t("security:backupPassword")}
                editable={!busy}
              />
            )}
            <View style={layout.row}>
              <Action disabled={busy} onPress={chooseFile}>
                {t("security:backupFile")}
              </Action>
              <Action
                disabled={busy}
                onPress={() => {
                  void requestPermission()
                    .then((result) => {
                      setScan(result.granted);
                      if (!result.granted)
                        setStatus(t("contacts:cameraAccess"));
                    })
                    .catch(() => setStatus(t("security:backupFailed")));
                }}
              >
                {t("contacts:scanTitle")}
              </Action>
            </View>
            {scan && permission?.granted && (
              <CameraView
                style={{ aspectRatio: 1 }}
                barcodeScannerSettings={{ barcodeTypes: ["qr"] }}
                onBarcodeScanned={({ data }) => {
                  if (data.length > 512) return;
                  setScan(false);
                  setInput(data);
                }}
              />
            )}
            <Action
              variant="prominent"
              disabled={busy || !input.trim()}
              onPress={check}
            >
              {t("security:checkIdentity")}
            </Action>
          </>
        ))}
      {busy && <ActivityIndicator />}
      {status ? <Ink accessibilityLiveRegion="polite">{status}</Ink> : null}
    </Screen>
  );
}
