import { ScreenHeader } from "@/components/navigation/screen-header";
import { useFocusEffect } from "expo-router";
import { useCallback, useState } from "react";
import { useTranslation } from "react-i18next";
import { AppState } from "react-native";
import { useDialog } from "@/components/ui/dialog";
import { GlassInput } from "@/components/glassyui/glass-input";
import { marmotErrorCode } from "@/core/marmot/errors";
import {
  SettingsDescription,
  ListGroup,
  ListRow,
  PreferenceToggle,
} from "@/components/ui/list-group";
import { Action, Ink, Screen } from "@/components/ui/kit";
import {
  marmot,
  type MarmotDeviceAction,
  type MarmotDeviceState,
} from "@/core/marmot/native";
import { namespaces } from "@/i18n";
import { useLocal } from "@/services/local-context";

export default function LinkedDevices() {
  const { t } = useTranslation(namespaces);
  const dialog = useDialog();
  const { marmotSession, lock } = useLocal();
  const [snapshot, setSnapshot] = useState<MarmotDeviceState>();
  const [error, setError] = useState(false);
  const [busy, setBusy] = useState(false);
  const [label, setLabel] = useState("");
  const [allChats, setAllChats] = useState(false);
  const [history, setHistory] = useState(false);
  const read = useCallback(
    () => marmotSession.ready().then(marmot.deviceState),
    [marmotSession],
  );

  useFocusEffect(
    useCallback(() => {
      let active = true;
      let timer: ReturnType<typeof setTimeout>;
      async function refresh() {
        if (AppState.currentState === "active" && !lock.getState().locked) {
          try {
            const next = await read();
            if (active) {
              setSnapshot(next);
              setError(false);
            }
          } catch {
            if (active) setError(true);
          }
        }
        if (active) timer = setTimeout(() => void refresh(), 1_500);
      }
      void refresh();
      return () => {
        active = false;
        clearTimeout(timer);
      };
    }, [read, lock]),
  );

  async function update(action: MarmotDeviceAction, target?: string) {
    if (busy || AppState.currentState !== "active" || lock.getState().locked)
      return;
    setBusy(true);
    try {
      await marmot.deviceAction(
        action,
        target,
        label.trim() || null,
        allChats,
        allChats && history,
      );
      setSnapshot(await read());
      setError(false);
    } catch (error) {
      void dialog.show({
        title: t(
          marmotErrorCode(error) === "DeviceLinkPending"
            ? "messages:marmot.deviceLinkPending"
            : "messages:marmot.linkFailed",
        ),
        tone: "error",
      });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Screen
      navigationHeader={<ScreenHeader title={t("messages:marmot.devices")} />}
    >
      <SettingsDescription>
        {t("messages:marmot.backupScope")}
      </SettingsDescription>
      {error ? (
        <Ink accessibilityLiveRegion="polite">
          {t("messages:marmot.accountError")}
        </Ink>
      ) : null}
      {snapshot && (
        <>
          <ListGroup title={t("messages:marmot.devices")}>
            {snapshot.devices.map((device) => (
              <ListRow
                key={device.slot}
                icon="connection"
                title={
                  device.label ||
                  device.platform ||
                  device.client ||
                  t("common:unknown")
                }
                detail={
                  device.current
                    ? t("messages:marmot.currentDevice")
                    : device.removalPending
                      ? t("messages:marmot.deviceRemoving")
                      : undefined
                }
                onPress={
                  device.current || device.removalPending
                    ? undefined
                    : () =>
                        void dialog.show({
                          title: t("messages:marmot.removeDevice"),
                          tone: "danger",
                          dismissible: false,
                          actions: [
                            { label: t("common:cancel"), tone: "cancel" },
                            {
                              label: t("common:remove"),
                              tone: "danger",
                              onSelect: () =>
                                void update("remove", device.slot),
                            },
                          ],
                        })
                }
              />
            ))}
          </ListGroup>
          {snapshot.progress
            .filter((entry) => entry.remaining > 0)
            .map((entry) => (
              <Ink key={entry.slot} kind="caption">
                {t("messages:marmot.linkProgress", {
                  done: entry.total - entry.remaining,
                  total: entry.total,
                })}
              </Ink>
            ))}
          {(snapshot.stalled || snapshot.state === "Ended") && (
            <Ink>{t("messages:marmot.linkFailed")}</Ink>
          )}
          {snapshot.code.length > 0 ? (
            <>
              <Ink>{t("messages:marmot.compareCode")}</Ink>
              <Ink kind="title" style={{ writingDirection: "ltr" }}>
                {snapshot.code.join("  ")}
              </Ink>
              <Action disabled={busy} onPress={() => void update("match")}>
                {t("messages:marmot.matchCode")}
              </Action>
            </>
          ) : null}
          {snapshot.state &&
          snapshot.state !== "Linked" &&
          snapshot.state !== "Ended" ? (
            <>
              {snapshot.code.length === 0 && (
                <Ink>{t("messages:marmot.linkWaiting")}</Ink>
              )}
              <Action
                disabled={busy}
                variant="ghost"
                onPress={() => void update("cancel")}
              >
                {t("common:cancel")}
              </Action>
            </>
          ) : (
            <Action disabled={busy} onPress={() => void update("start")}>
              {t("messages:marmot.startLink")}
            </Action>
          )}
          {snapshot.prompts.map((prompt) => (
            <ListGroup key={prompt.id}>
              {prompt.code.length > 0 ? (
                <>
                  <Ink>{t("messages:marmot.compareCode")}</Ink>
                  <Ink kind="title" style={{ writingDirection: "ltr" }}>
                    {prompt.code.join("  ")}
                  </Ink>
                  <GlassInput
                    label={t("messages:marmot.deviceLabel")}
                    value={label}
                    onChangeText={setLabel}
                    maxLength={60}
                  />
                  <PreferenceToggle
                    title={t("messages:marmot.addToChats")}
                    value={allChats}
                    onChange={setAllChats}
                  />
                  <PreferenceToggle
                    title={t("messages:marmot.bringHistory")}
                    value={allChats && history}
                    disabled={!allChats}
                    onChange={setHistory}
                  />
                  <Action
                    disabled={busy}
                    onPress={() => void update("link", prompt.id)}
                  >
                    {t("messages:marmot.matchCode")}
                  </Action>
                </>
              ) : (
                <Ink>{t("messages:marmot.linkWaiting")}</Ink>
              )}
              <Action
                disabled={busy}
                variant="ghost"
                onPress={() => void update("decline", prompt.id)}
              >
                {t("common:cancel")}
              </Action>
            </ListGroup>
          ))}
        </>
      )}
    </Screen>
  );
}
