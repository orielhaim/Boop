import { getDocumentAsync } from "expo-document-picker";
import { File } from "expo-file-system";
import {
  useEffect,
  useId,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { useTranslation } from "react-i18next";
import { AppState, Platform, StyleSheet, View } from "react-native";
import * as ScreenCapture from "expo-screen-capture";
import { GlassInput } from "@/components/glassyui/glass-input";
import { LockScreen } from "@/components/settings/lock-screen";
import { BoopLogo } from "@/components/ui/boop-logo";
import { Action, Ink, Screen } from "@/components/ui/kit";
import { createOrImportIdentity } from "@/core/identity";
import { backupKind, readBackup } from "@/core/identity/backup";
import { directionFor, namespaces, resolveLanguage } from "@/i18n";
import { finishOnboarding, type initializeLocal } from "@/services/local";
import { space } from "@/theme";

type Welcome = Extract<
  Awaited<ReturnType<typeof initializeLocal>>,
  { status: "welcome" }
>;

export function Onboarding({
  data,
  onComplete,
}: {
  data: Welcome;
  onComplete: () => void;
}) {
  const { lock } = data;
  const state = useSyncExternalStore(lock.subscribe, lock.getState);
  useEffect(() => {
    const update = (next: typeof AppState.currentState) =>
      lock.setActive(next === "active");
    update(AppState.currentState);
    const listener = AppState.addEventListener("change", update);
    return () => listener.remove();
  }, [lock]);
  if (!state.hasOpened || (state.enabled && (!state.active || state.locked)))
    return <LockScreen lock={lock} state={state} />;
  return <WelcomeForm data={data} onComplete={onComplete} />;
}

function WelcomeForm({
  data,
  onComplete,
}: {
  data: Welcome;
  onComplete: () => void;
}) {
  const { t, i18n } = useTranslation(namespaces);
  const direction = directionFor(resolveLanguage(i18n.resolvedLanguage));
  const [mode, setMode] = useState<"welcome" | "create" | "signIn">("welcome");
  const [name, setName] = useState("");
  const [about, setAbout] = useState("");
  const [input, setInput] = useState("");
  const [password, setPassword] = useState("");
  const [candidate, setCandidate] = useState<ReturnType<typeof readBackup>>();
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [protectedWindow, setProtectedWindow] = useState(false);
  const working = useRef(false);
  const protection = useId();
  useEffect(() => {
    if (mode !== "signIn") return;
    let live = true;
    const apply = async () => {
      await ScreenCapture.preventScreenCaptureAsync(protection);
      if (Platform.OS === "ios" && !data.lock.getState().enabled)
        await ScreenCapture.enableAppSwitcherProtectionAsync(1);
      if (live) setProtectedWindow(true);
    };
    const applied = apply().catch(() => {
      if (live) setNotice(t("security:backupFailed"));
    });
    const state = AppState.addEventListener("change", (next) => {
      if (next !== "active") {
        setInput("");
        setPassword("");
        setCandidate(undefined);
      }
    });
    return () => {
      live = false;
      state.remove();
      void applied
        .then(async () => {
          await ScreenCapture.allowScreenCaptureAsync(protection);
          if (Platform.OS === "ios" && !data.lock.getState().enabled)
            await ScreenCapture.disableAppSwitcherProtectionAsync();
        })
        .catch(() => undefined);
    };
  }, [data.lock, mode, protection, t]);

  function reset() {
    setInput("");
    setPassword("");
    setCandidate(undefined);
    setProtectedWindow(false);
    setNotice("");
    setMode("welcome");
  }

  async function install(
    details: Parameters<typeof createOrImportIdentity>[1],
  ) {
    if (
      working.current ||
      data.lock.getState().locked ||
      AppState.currentState !== "active"
    )
      return;
    working.current = true;
    setBusy(true);
    setNotice("");
    try {
      await createOrImportIdentity(data.db, details);
      finishOnboarding(data.db);
      onComplete();
    } catch {
      setNotice(t("messenger:saveFailed"));
    } finally {
      working.current = false;
      setBusy(false);
    }
  }

  async function chooseFile() {
    try {
      const selected = await getDocumentAsync({
        type: "*/*",
        copyToCacheDirectory: false,
      });
      if (selected.canceled) return;
      const asset = selected.assets[0];
      if (!asset || (asset.size ?? 0) > 512) throw new Error("Invalid backup");
      const file = new File(asset.uri);
      const handle = file.open();
      try {
        const bytes = await handle.readBytes(513);
        try {
          if (!bytes.length || bytes.length > 512)
            throw new Error("Invalid backup");
          const value = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
          if (backupKind(value) !== "encrypted")
            throw new Error("Invalid backup");
          if (
            AppState.currentState === "active" &&
            !data.lock.getState().locked
          )
            setInput(value);
        } finally {
          bytes.fill(0);
        }
      } finally {
        handle.close();
      }
    } catch {
      setNotice(t("messenger:invalidFile"));
    }
  }

  const secure = {
    secureTextEntry: true,
    autoCapitalize: "none",
    autoCorrect: false,
    spellCheck: false,
  } as const;
  return (
    <Screen compact topInset>
      <View style={[styles.content, { direction }]}>
        <View style={styles.brand}>
          <BoopLogo size={mode === "welcome" ? 56 : 44} />
        </View>
        <Ink kind="heading" accessibilityRole="header" style={styles.title}>
          {t(`messenger:${mode}`)}
        </Ink>
        {mode === "welcome" ? (
          <>
            <Ink muted style={styles.intro}>
              {t("messenger:welcomeBody")}
            </Ink>
            <View style={styles.welcomeActions}>
              <Action
                variant="prominent"
                style={styles.fullAction}
                onPress={() => setMode("create")}
              >
                {t("messenger:create")}
              </Action>
              <Action
                variant="soft"
                style={styles.fullAction}
                onPress={() => setMode("signIn")}
              >
                {t("messenger:signIn")}
              </Action>
            </View>
          </>
        ) : mode === "create" ? (
          <>
            <Ink muted>{t("messenger:publicIntro")}</Ink>
            <GlassInput
              compact
              label={t("messenger:publicName")}
              value={name}
              maxLength={128}
              onChangeText={setName}
              editable={!busy}
            />
            <GlassInput
              compact
              label={t("messenger:optionalAbout")}
              value={about}
              maxLength={1000}
              multiline
              onChangeText={setAbout}
              editable={!busy}
            />
            <Action
              variant="prominent"
              disabled={busy || !name.trim()}
              onPress={() => void install({ name, about })}
            >
              {t(busy ? "messenger:creating" : "messenger:create")}
            </Action>
          </>
        ) : candidate ? (
          <>
            <Ink kind="caption" selectable>
              {candidate.identity.npub}
            </Ink>
            <Action
              variant="prominent"
              disabled={busy}
              onPress={() => void install({ secret: candidate.secret })}
            >
              {t(busy ? "messenger:importing" : "messenger:confirmImport")}
            </Action>
          </>
        ) : protectedWindow ? (
          <>
            <Ink muted>{t("messenger:privateKeyHelp")}</Ink>
            <GlassInput
              compact
              {...secure}
              label={t("messenger:privateKey")}
              value={input}
              onChangeText={setInput}
              maxLength={168}
            />
            {backupKind(input) === "encrypted" && (
              <GlassInput
                compact
                {...secure}
                label={t("security:backupPassword")}
                value={password}
                maxLength={512}
                onChangeText={setPassword}
              />
            )}
            <Action
              variant="prominent"
              disabled={!input.trim()}
              onPress={() => {
                try {
                  const imported = readBackup(input, password);
                  setInput("");
                  setPassword("");
                  setNotice("");
                  setCandidate(imported);
                } catch {
                  setNotice(t("messenger:invalidKey"));
                }
              }}
            >
              {t("messenger:reviewIdentity")}
            </Action>
            <Action variant="soft" onPress={() => void chooseFile()}>
              {t("messenger:importFile")}
            </Action>
          </>
        ) : null}
        {notice ? <Ink accessibilityLiveRegion="polite">{notice}</Ink> : null}
        {notice === t("messenger:saveFailed") && (
          <Action
            onPress={() => {
              finishOnboarding(data.db);
              onComplete();
            }}
          >
            {t("common:retry")}
          </Action>
        )}
        {mode !== "welcome" && (
          <Action variant="soft" disabled={busy} onPress={reset}>
            {t("common:cancel")}
          </Action>
        )}
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  content: {
    width: "100%",
    maxWidth: 460,
    alignSelf: "center",
    gap: space.md,
    paddingHorizontal: space.sm,
    paddingVertical: space.xl,
  },
  brand: { marginBottom: space.sm, alignItems: "flex-start" },
  title: { fontSize: 28, letterSpacing: -0.6 },
  intro: { lineHeight: 22, maxWidth: 380 },
  welcomeActions: { gap: space.sm, marginTop: space.sm },
  fullAction: { alignSelf: "stretch" },
});
