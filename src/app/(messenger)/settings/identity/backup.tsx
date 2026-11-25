import { ScreenHeader } from "@/components/navigation/screen-header";
import { useFocusEffect } from "expo-router";
import {
  allowScreenCaptureAsync,
  disableAppSwitcherProtectionAsync,
  enableAppSwitcherProtectionAsync,
  preventScreenCaptureAsync,
} from "expo-screen-capture";
import { useCallback, useId, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { AppState, Platform } from "react-native";
import { useDialog } from "@/components/ui/dialog";
import { GlassInput } from "@/components/glassyui/glass-input";
import {
  SettingsDescription,
  ListGroup,
  ListRow,
} from "@/components/ui/list-group";
import { Action, Ink, Screen } from "@/components/ui/kit";
import {
  marmot,
  type MarmotBackupState,
  type MarmotRecoveryWords,
} from "@/core/marmot/native";
import { namespaces } from "@/i18n";
import { useLocal } from "@/services/local-context";

export default function MarmotBackups() {
  const { t } = useTranslation(namespaces);
  const dialog = useDialog();
  const { lock, marmotSession } = useLocal();
  const id = useId();
  const [state, setState] = useState<MarmotBackupState>();
  const [setup, setSetup] = useState<MarmotRecoveryWords>();
  const [first, setFirst] = useState("");
  const [second, setSecond] = useState("");
  const [restore, setRestore] = useState("");
  const [protectedScreen, setProtectedScreen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const screen = useRef<object>(null);
  const job = useRef(false);
  const clear = useCallback(() => {
    setFirst("");
    setSecond("");
    setRestore("");
    setSetup(undefined);
  }, []);

  useFocusEffect(
    useCallback(() => {
      const token = {};
      screen.current = token;
      let timer: ReturnType<typeof setTimeout>;
      let blurred = false;
      async function unprotect() {
        if (blurred)
          await disableAppSwitcherProtectionAsync().catch(() => undefined);
        await allowScreenCaptureAsync(id).catch(() => undefined);
      }
      void (async () => {
        try {
          await preventScreenCaptureAsync(id);
          if (Platform.OS === "ios" && !lock.getState().enabled) {
            await enableAppSwitcherProtectionAsync(1);
            blurred = true;
          }
          if (screen.current === token) setProtectedScreen(true);
          else await unprotect();
        } catch {
          if (screen.current === token) setProtectedScreen(false);
          await unprotect();
        }
      })();
      async function refresh() {
        try {
          await marmotSession.ready();
          const next = await marmot.backupState();
          if (screen.current === token) setState(next);
        } catch {
          if (screen.current === token)
            setNotice(t("messages:marmot.accountError"));
        }
        if (screen.current === token)
          timer = setTimeout(() => void refresh(), 2_000);
      }
      const cancelSecret = () => {
        clear();
        void marmot.backupAction("cancel").catch(() => undefined);
      };
      const app = AppState.addEventListener("change", (next) => {
        if (next !== "active") cancelSecret();
      });
      const locked = lock.subscribe(() => {
        if (lock.getState().locked) cancelSecret();
      });
      void refresh();
      return () => {
        screen.current = null;
        clearTimeout(timer);
        app.remove();
        locked();
        setProtectedScreen(false);
        cancelSecret();
        void unprotect();
      };
    }, [clear, id, lock, marmotSession, t]),
  );

  async function perform(work: (available: () => boolean) => Promise<void>) {
    const token = screen.current;
    const available = () =>
      token &&
      screen.current === token &&
      AppState.currentState === "active" &&
      !lock.getState().locked;
    if (job.current || !available()) return;
    job.current = true;
    setBusy(true);
    setNotice("");
    try {
      await work(() => Boolean(available()));
      const next = await marmot.backupState();
      if (available()) setState(next);
    } catch {
      if (available()) setNotice(t("messages:marmot.operationError"));
    } finally {
      job.current = false;
      setBusy(false);
    }
  }

  return (
    <Screen
      navigationHeader={<ScreenHeader title={t("messages:marmot.backups")} />}
    >
      <SettingsDescription>
        {t("messages:marmot.backupScope")}
      </SettingsDescription>
      <SettingsDescription>
        {t("messages:marmot.backupConsent")}
      </SettingsDescription>
      {state && (
        <ListGroup>
          <ListRow
            title={t("messages:marmot.backups")}
            value={t(state.enabled ? "common:on" : "common:off")}
          />
          {state.enabled && (
            <ListRow
              title={t("messages:marmot.backupWriter")}
              value={t(state.thisDeviceWrites ? "common:on" : "common:off")}
            />
          )}
        </ListGroup>
      )}
      {protectedScreen && state && !setup && !state.enabled && (
        <Action
          disabled={busy}
          onPress={() =>
            void perform(async (available) => {
              const words = await marmot.beginBackup();
              if (available()) setSetup(words);
              else await marmot.backupAction("cancel");
            })
          }
        >
          {t("messages:marmot.beginBackup")}
        </Action>
      )}
      {protectedScreen && setup && (
        <ListGroup>
          <Ink>{t("messages:marmot.keepRecoveryWords")}</Ink>
          <Ink style={{ writingDirection: "ltr" }}>{setup.words.join(" ")}</Ink>
          <GlassInput
            label={t("messages:marmot.confirmRecoveryWord", {
              position: setup.positions[0],
            })}
            value={first}
            onChangeText={setFirst}
            autoCapitalize="none"
            autoCorrect={false}
          />
          <GlassInput
            label={t("messages:marmot.confirmRecoveryWord", {
              position: setup.positions[1],
            })}
            value={second}
            onChangeText={setSecond}
            autoCapitalize="none"
            autoCorrect={false}
          />
          <Action
            disabled={busy || !first.trim() || !second.trim()}
            onPress={() =>
              void perform(async () => {
                const words = [first.trim(), second.trim()];
                setFirst("");
                setSecond("");
                await marmot.backupAction("confirm", words);
                clear();
              })
            }
          >
            {t("messages:marmot.enableBackups")}
          </Action>
          <Action
            disabled={busy}
            onPress={() => {
              clear();
              void perform(async () => marmot.backupAction("cancel"));
            }}
          >
            {t("common:cancel")}
          </Action>
        </ListGroup>
      )}
      {state?.enabled && (
        <>
          <Action
            disabled={busy || !state.thisDeviceWrites}
            onPress={() =>
              void perform(async (available) => {
                const result = await marmot.backupNow();
                if (available())
                  setNotice(
                    t(
                      result === "finished_attempt"
                        ? "messages:marmot.backupAttemptFinished"
                        : "messages:marmot.backupNotDue",
                    ),
                  );
              })
            }
          >
            {t("messages:marmot.backupNow")}
          </Action>
          <Action
            disabled={busy}
            onPress={() =>
              void dialog.show({
                title: t("messages:marmot.disableBackups"),
                message: t("messages:marmot.previousBackupsRemain"),
                tone: "danger",
                dismissible: false,
                actions: [
                  { label: t("common:cancel"), tone: "cancel" },
                  {
                    label: t("common:done"),
                    tone: "danger",
                    onSelect: () =>
                      void perform(async () => marmot.backupAction("disable")),
                  },
                ],
              })
            }
          >
            {t("messages:marmot.disableBackups")}
          </Action>
        </>
      )}
      {protectedScreen && !setup && state && (
        <ListGroup title={t("messages:marmot.restoreBackup")}>
          <SettingsDescription>
            {t("messages:marmot.restoreScope")}
          </SettingsDescription>
          {state.operation &&
          (state.phase === "discovering" || state.phase === "restoring") ? (
            <Action
              disabled={busy}
              onPress={() => {
                const operation = state.operation;
                if (operation)
                  void perform(async () =>
                    marmot.backupAction("cancelRestore", [operation]),
                  );
              }}
            >
              {t("common:cancel")}
            </Action>
          ) : (
            <>
              <GlassInput
                label={t("messages:marmot.recoveryWords")}
                value={restore}
                onChangeText={setRestore}
                secureTextEntry
                autoCapitalize="none"
                autoCorrect={false}
              />
              <Action
                disabled={busy || !restore.trim()}
                onPress={() =>
                  void perform(async () => {
                    const value = restore.trim();
                    setRestore("");
                    await marmot.backupAction("restore", [value]);
                  })
                }
              >
                {t("messages:marmot.restoreBackup")}
              </Action>
            </>
          )}
          {state.phase !== "idle" && (
            <Ink accessibilityLiveRegion="polite">
              {t(`messages:marmot.backup_${state.phase}`, {
                count: state.imported,
              })}
            </Ink>
          )}
        </ListGroup>
      )}
      {notice && <Ink accessibilityLiveRegion="polite">{notice}</Ink>}
    </Screen>
  );
}
