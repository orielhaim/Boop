import { router, useFocusEffect, useLocalSearchParams } from "expo-router";
import { useCallback, useState, useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";
import { Platform, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { ScreenHeader } from "@/components/navigation/screen-header";
import { DevicePairing } from "@/components/devices/pairing";
import {
  DeviceCard,
  DeviceError,
  DeviceHeading,
  DeviceHeroImage,
  countSecurityItems,
} from "@/components/devices/presentation";
import {
  DeviceDanger,
  DeviceDetails,
  DeviceRow,
  RosterRow,
  useRemoveDevices,
} from "@/components/devices/roster";
import { DeviceSecurity, SignInReview } from "@/components/devices/security";
import { DeviceSynchronization } from "@/components/devices/synchronization";
import { CountBadge } from "@/components/kinetik/count-badge";
import { useDialog } from "@/components/ui/dialog";
import { Action, Ink, Screen } from "@/components/ui/kit";
import {
  ListGroup,
  ListRow,
  SettingsDescription,
} from "@/components/ui/list-group";
import { useChatsEnabled, useLocal } from "@/services/local-context";

function open(view: string, target?: string) {
  router.push({
    pathname: "/settings/devices",
    params: target ? { view, target } : { view },
  });
}

function back() {
  if (router.canGoBack()) router.back();
  else router.replace("/settings/devices");
}

export default function Devices() {
  const { t } = useTranslation(["devices", "common"]);
  const dialog = useDialog();
  const { view, target } = useLocalSearchParams<{
    view?: string;
    target?: string;
  }>();
  const local = useLocal();
  const { deviceController: controller } = local;
  const chats = useChatsEnabled();
  const state = useSyncExternalStore(controller.subscribe, controller.getState);
  useFocusEffect(
    useCallback(() => {
      if (chats) controller.refreshChatAvailability();
    }, [chats, controller]),
  );
  const {
    projections: {
      roster,
      pairing,
      keyHealth,
      startedFresh,
      history,
      closedChats,
      leftoverChats,
      recovery,
    },
    operation,
    failed,
    connection,
    removals,
  } = state;
  const current = roster?.find((row) => row.isThisDevice);
  const others = roster?.filter((row) => !row.isThisDevice) ?? [];
  const device = roster?.find((row) => row.slotIdHex === target);
  const signIn = state.projections.signIns?.find(
    (row) => row.slotIdHex === target,
  );
  const count = countSecurityItems(state);
  const busy = operation !== null || !chats;
  const [error, setError] = useState<unknown>();
  const remove = useRemoveDevices(controller, setError);
  const inProgress =
    pairing?.chatProgress.some((entry) => entry.remaining > 0) ||
    history?.some((entry) => entry.state.kind === "receiving");
  const link = pairing?.newDevice;
  const linkInProgress =
    link &&
    link.kind !== "linked" &&
    link.kind !== "ended" &&
    link.kind !== "unsupported";

  function accountAction(action: "signOut" | "wipe") {
    void dialog.show({
      title: t(action),
      message: t(action === "signOut" ? "signOutHelp" : "wipeHelp"),
      tone: "danger",
      dismissible: false,
      actions: [
        { label: t("common:cancel"), tone: "cancel" },
        {
          label: t(action),
          tone: "danger",
          onSelect: () => {
            const result =
              action === "signOut"
                ? local.signOutCurrentDevice(true)
                : local.removeCurrentDevice();
            void result.catch(setError);
          },
        },
      ],
    });
  }

  const localActions = (
    <ListGroup title={t("localAccount")}>
      <ListRow
        icon="lock"
        title={t("signOut")}
        disabled={operation !== null}
        onPress={() => accountAction("signOut")}
      />
      <DeviceDanger
        title={t("wipe")}
        disabled={operation !== null}
        onPress={() => accountAction("wipe")}
      />
    </ListGroup>
  );

  function repair() {
    void dialog.show({
      title: t("repair"),
      message: t("repairHelp"),
      tone: "danger",
      actions: [
        { label: t("common:cancel"), tone: "cancel" },
        {
          label: t("repair"),
          tone: "danger",
          onSelect: () => {
            void controller.repair().then(() => open("link"), setError);
          },
        },
      ],
    });
  }

  const title =
    view === "security" || view === "review"
      ? t("security")
      : view === "link" || view === "prompt" || view === "move"
        ? t("link")
        : view === "sync"
          ? t("sync")
          : view === "recovery"
            ? t("recovery")
            : t("title");
  let content: React.ReactNode;
  switch (view) {
    case "link":
    case "prompt":
    case "move":
      content = (
        <>
          {chats ? (
            <DevicePairing
              controller={controller}
              promptId={view === "prompt" ? target : undefined}
              move={view === "move"}
              onPrompt={(prompt) => open("prompt", prompt)}
              onDone={back}
            />
          ) : (
            <DeviceCard>
              <Ink>{t("pausedHelp")}</Ink>
            </DeviceCard>
          )}
          {link?.kind === "linked" && (
            <ListGroup>
              <ListRow
                icon="chat"
                title={t("sync")}
                onPress={() => open("sync")}
              />
            </ListGroup>
          )}
        </>
      );
      break;
    case "security":
      content = (
        <DeviceSecurity
          state={state}
          controller={controller}
          paused={!chats}
          onReview={(slot) => open("review", slot)}
          onPrompt={(prompt) => open("prompt", prompt)}
          onRoster={() => open("roster")}
          onReplaceKey={() => router.push("/settings/identity-keys")}
        />
      );
      break;
    case "review":
      content = signIn ? (
        <SignInReview
          key={signIn.slotIdHex}
          record={signIn}
          controller={controller}
          busy={busy}
          onDone={back}
        />
      ) : (
        <SettingsDescription>
          {t(roster ? "unknown" : "loading")}
        </SettingsDescription>
      );
      break;
    case "device":
      content = device ? (
        <DeviceDetails
          key={device.slotIdHex}
          device={device}
          roster={roster ?? []}
          controller={controller}
          busy={busy}
          localActions={localActions}
        />
      ) : (
        <SettingsDescription>
          {t(
            target &&
              Array.from(removals).some(
                ([slot, status]) => slot === target && status === "removed",
              )
              ? "removed"
              : roster
                ? "unavailable"
                : "loading",
          )}
        </SettingsDescription>
      );
      break;
    case "local":
      content = (
        <>
          <DeviceCard hero center>
            <DeviceHeroImage />
            <DeviceHeading title={t("current")} detail={t("currentLocal")} />
          </DeviceCard>
          {localActions}
        </>
      );
      break;
    case "sync":
      content = <DeviceSynchronization state={state} />;
      break;
    case "recovery":
      content = (
        <>
          {(keyHealth || pairing?.deviceGroupStalled) && (
            <DeviceCard>
              {pairing?.deviceGroupStalled && (
                <Ink kind="rowTitle">{t("stalled")}</Ink>
              )}
              {keyHealth && <Ink muted>{t("keyHealth")}</Ink>}
              <Action
                disabled={busy || !pairing?.deviceGroupStalled}
                variant="soft"
                onPress={repair}
              >
                {t("repair")}
              </Action>
            </DeviceCard>
          )}
          {!!current && (
            <ListGroup>
              <ListRow
                icon="devices"
                title={t("move")}
                detail={t("moveHelp")}
                disabled={busy}
                onPress={() => open("move")}
              />
            </ListGroup>
          )}
          <ListGroup>
            <ListRow
              icon="key"
              title={t("rotate")}
              detail={t("rotateHelp")}
              disabled={busy}
              onPress={() => void controller.rotateKeyPackage().catch(setError)}
            />
          </ListGroup>
          {pairing?.moves.map((move) => (
            <ListGroup
              key={move.moveId}
              title={t(
                move.state.kind === "joining"
                  ? "moveJoining"
                  : move.state.kind === "failed"
                    ? "moveFailed"
                    : move.state.kind === "unsupported"
                      ? "unknown"
                      : move.state.kind,
              )}
            >
              {move.oldSiblings
                .filter((sibling) => !sibling.questionSuppressed)
                .map((sibling) => (
                  <ListRow
                    key={sibling.slotIdHex}
                    title={t("oldSibling", {
                      name: sibling.label || t("unknownDevice"),
                    })}
                    detail={t("dismiss")}
                    disabled={busy}
                    onPress={() =>
                      void controller
                        .dismissMoveSibling(move.moveId, sibling.slotIdHex)
                        .catch(setError)
                    }
                  />
                ))}
            </ListGroup>
          ))}
          {chats && (
            <ListGroup>
              <ListRow
                icon="lock"
                title={t("backup")}
                detail={t("backupHelp")}
                onPress={() => router.push("/settings/identity/backup")}
              />
            </ListGroup>
          )}
        </>
      );
      break;
    default:
      content = (
        <>
          {count > 0 && (
            <ListGroup>
              <ListRow
                icon={state.projections.warnings?.length ? "warning" : "lock"}
                title={t(
                  state.projections.warnings?.length ? "warning" : "security",
                )}
                detail={t("attentionCount", { count })}
                trailing={<CountBadge count={count} size="compact" />}
                onPress={() => open("security")}
              />
            </ListGroup>
          )}
          <DeviceCard hero center>
            <DeviceHeroImage />
            <DeviceHeading title={t("hero")} detail={t("heroHelp")} />
            <Action
              variant="prominent"
              size="lg"
              disabled={!chats}
              onPress={() => open("link")}
            >
              {t(linkInProgress ? "resumeLink" : "link")}
            </Action>
          </DeviceCard>
          {!chats && (
            <ListGroup>
              <ListRow
                icon="connection"
                title={t("paused")}
                detail={t("pausedHelp")}
                detailLines={6}
                onPress={() => router.push("/settings/privacy")}
              />
            </ListGroup>
          )}
          {chats && (connection !== "observing" || failed.length > 0) ? (
            <ListGroup>
              <ListRow
                icon="connection"
                title={t(
                  connection === "reconnecting"
                    ? "reconnecting"
                    : failed.length
                      ? "unreadable"
                      : "loading",
                )}
                detail={t("retry")}
                onPress={controller.reconnect}
              />
            </ListGroup>
          ) : null}
          <ListGroup title={t("current")}>
            {current ? (
              <RosterRow
                device={current}
                onPress={() => open("device", current.slotIdHex)}
              />
            ) : roster || !chats || failed.includes("roster") ? (
              <DeviceRow
                platform={Platform.OS}
                title={t("currentLocal")}
                app={
                  Platform.OS === "ios"
                    ? "Boop · iOS"
                    : Platform.OS === "android"
                      ? "Boop · Android"
                      : "Boop"
                }
                status={t(
                  pairing?.deviceGroupStalled
                    ? "stalled"
                    : !chats
                      ? "paused"
                      : failed.includes("roster") || roster?.length
                        ? "unreadable"
                        : "localOnly",
                )}
                onPress={() => open("local")}
              />
            ) : (
              <View
                accessibilityLabel={t("loading")}
                accessible
                style={styles.skeleton}
              >
                <View style={styles.circledSkeleton} />
                <View style={styles.skeletonText}>
                  <View style={styles.skeletonLine} />
                  <View style={[styles.skeletonLine, styles.short]} />
                </View>
              </View>
            )}
          </ListGroup>
          <ListGroup title={t("others")}>
            {roster &&
              !others.length &&
              !failed.includes("roster") &&
              !pairing?.deviceGroupStalled &&
              connection === "observing" && (
                <SettingsDescription>{t("noOthers")}</SettingsDescription>
              )}
            {others.map((row) => (
              <RosterRow
                key={row.slotIdHex}
                device={row}
                onPress={() => open("device", row.slotIdHex)}
              />
            ))}
          </ListGroup>
          {!!others.length && (
            <DeviceDanger
              title={t("removeOthers")}
              disabled={busy || others.every((row) => row.removalPending)}
              onPress={() =>
                remove(
                  others
                    .filter((row) => !row.removalPending)
                    .map((row) => row.slotIdHex),
                  "removeOthers",
                )
              }
            />
          )}
          {!!removals.size && (
            <ListGroup>
              {Array.from(removals).map(([slot, status]) => (
                <ListRow
                  key={slot}
                  title={
                    roster?.find((row) => row.slotIdHex === slot)?.label ||
                    t("unknownDevice")
                  }
                  detail={t(status)}
                />
              ))}
            </ListGroup>
          )}
          {!count && (
            <ListGroup>
              <ListRow
                icon="lock"
                title={t("security")}
                onPress={() => open("security")}
              />
            </ListGroup>
          )}
          {inProgress ||
          history?.length ||
          closedChats ||
          leftoverChats ||
          link?.kind === "linked" ||
          recovery?.inboxCatchingUp ||
          recovery?.catchingUpGroupIdsHex.length ||
          recovery?.notices.length ? (
            <ListGroup>
              <ListRow
                icon="chat"
                title={t("sync")}
                onPress={() => open("sync")}
              />
            </ListGroup>
          ) : null}
          {startedFresh && (
            <SettingsDescription>{t("startedFresh")}</SettingsDescription>
          )}
          <ListGroup title={t("inactivity")}>
            <SettingsDescription>{t("inactivityHelp")}</SettingsDescription>
          </ListGroup>
          <ListGroup>
            <ListRow
              icon={
                keyHealth || pairing?.deviceGroupStalled
                  ? "warning"
                  : "connection"
              }
              title={t("recovery")}
              detail={t(
                pairing?.deviceGroupStalled
                  ? "stalled"
                  : keyHealth
                    ? "keyHealth"
                    : "backup",
              )}
              onPress={() => open("recovery")}
            />
          </ListGroup>
        </>
      );
  }

  return (
    <Screen compact navigationHeader={<ScreenHeader title={title} />}>
      <View style={styles.body}>
        {content}
        <DeviceError error={error} />
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create((theme) => ({
  body: {
    width: "100%",
    maxWidth: 570,
    alignSelf: "center",
    gap: theme.space.lg,
  },
  skeleton: {
    padding: theme.space.lg,
    minHeight: 76,
    gap: theme.space.md,
    flexDirection: "row",
    alignItems: "center",
  },
  circledSkeleton: {
    backgroundColor: theme.colors.recessed,
    borderRadius: 23,
    width: 46,
    height: 46,
  },
  skeletonText: { flex: 1, gap: theme.space.sm },
  skeletonLine: {
    height: 12,
    width: "58%",
    borderRadius: 6,
    backgroundColor: theme.colors.recessed,
  },
  short: { width: "37%" },
}));
