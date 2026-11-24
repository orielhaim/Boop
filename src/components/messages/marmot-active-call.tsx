import { router } from "expo-router";
import {
  type ComponentProps,
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { useTranslation } from "react-i18next";
import { Alert, Pressable, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { useStore } from "zustand";
import {
  Action,
  Card,
  Icon,
  IconButton,
  Ink,
  tapFeedback,
} from "@/components/ui/kit";
import { discoverGroupCall } from "@/core/calling/group-presence";
import { marmot } from "@/core/marmot/native";
import { useMarmotWindow } from "./marmot-window";
import { namespaces } from "@/i18n";
import { useLocal } from "@/services/local-context";
import { space, useTheme } from "@/theme";

type GroupCallStart = { disabled: boolean; onPress: () => void };
const GroupCallStartContext = createContext<GroupCallStart | null>(null);

export function GroupCallHeaderButton({
  canDispatch,
}: {
  canDispatch: () => boolean;
}) {
  const { t } = useTranslation(namespaces);
  const start = useContext(GroupCallStartContext);
  return (
    <IconButton
      icon="phone"
      tone="plain"
      label={t("messages:marmot.startGroupCall")}
      disabled={!start || start.disabled}
      onPress={() => {
        if (!start || start.disabled || !canDispatch()) return;
        Alert.alert(
          t("messages:marmot.confirmGroupCall"),
          t("messages:marmot.confirmGroupCallHint"),
          [
            { text: t("common:cancel"), style: "cancel" },
            {
              text: t("calls:startCall"),
              onPress: () => {
                if (canDispatch()) start.onPress();
              },
            },
          ],
          { cancelable: true },
        );
      }}
    />
  );
}

export function MarmotActiveCall({
  group,
  members,
  canStart,
  profileActions,
  header,
}: {
  group: string;
  members?: readonly { id: string; name?: string | null; label?: string }[];
  canStart: boolean;
  profileActions?: ReactNode;
  header?: ReactNode;
}) {
  const { t } = useTranslation(namespaces);
  const { colors } = useTheme();
  const { calling, privacy, lock } = useLocal();
  const state = useStore(calling.store);
  const lockState = useSyncExternalStore(lock.subscribe, lock.getState);
  const open = useCallback(() => marmot.openGroupCall(group), [group]);
  const discovery = useMarmotWindow(
    open,
    !lockState.locked && lockState.active,
  );
  const announcements = discovery.snapshot?.announcements;
  const privacyRevision = useSyncExternalStore(
    privacy.subscribe,
    privacy.revision,
  );
  const current =
    state.call?.groupId === group && state.call.phase !== "ended"
      ? state.call
      : undefined;
  const pending = useRef<string>(undefined);
  const unavailable = state.unavailableGroupCall;
  const lobby =
    state.groupLobby?.groupId === group ? state.groupLobby : undefined;
  const [discovered, setDiscovered] =
    useState<ReturnType<typeof discoverGroupCall>>();
  const roster = useMemo(
    () =>
      new Map(
        members?.map((member) => [member.id, member.label || member.name]),
      ),
    [members],
  );
  useEffect(() => {
    let active = true;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    function update() {
      if (!active) return;
      const next =
        !lockState.locked && lockState.active
          ? discoverGroupCall(
              announcements ?? [],
              (key) => roster.has(key) && !privacy.isBlocked(key),
            )
          : undefined;
      setDiscovered(next);
      if (next)
        timeout = setTimeout(update, Math.max(1, next.expiresAt - Date.now()));
    }
    queueMicrotask(update);
    return () => {
      active = false;
      clearTimeout(timeout);
    };
  }, [
    lockState.active,
    lockState.locked,
    announcements,
    privacy,
    privacyRevision,
    roster,
  ]);

  useEffect(() => {
    if (!current || current.id !== pending.current || lockState.locked) return;
    pending.current = undefined;
    router.push({
      pathname: "/call/[key]",
      params: { key: current.peerKey, callId: current.id },
    });
  }, [current, lockState.locked]);
  useEffect(() => {
    if (!unavailable || pending.current !== unavailable.callId) return;
    pending.current = undefined;
    if (!lockState.locked)
      Alert.alert(t("messages:marmot.groupCallUnavailable"));
  }, [lockState.locked, t, unavailable]);

  const startGroupCall = useCallback(() => {
    const window = discovery.window?.getState();
    const currentLock = lock.getState();
    if (currentLock.locked || !currentLock.active || window?.status !== "ready")
      return;
    const latest = discoverGroupCall(
      window.snapshot.announcements,
      (key) => roster.has(key) && !privacy.isBlocked(key),
    );
    const unavailable = calling.store.getState().unavailableGroupCall;
    if (
      latest &&
      (unavailable?.callId !== latest.call || unavailable.at < latest.updatedAt)
    )
      return;
    void calling.startGroup(group).then((started) => {
      if (started)
        pending.current = calling.store.getState().groupLobby?.callId;
      else Alert.alert(t("messages:marmot.groupCallStartFailed"));
    });
  }, [calling, discovery.window, group, lock, privacy, roster, t]);

  if (lockState.locked) return null;
  const active =
    discovered &&
    (unavailable?.callId !== discovered.call ||
      unavailable.at < discovered.updatedAt)
      ? discovered
      : undefined;
  const full =
    active &&
    state.fullGroupCall?.callId === active.call &&
    state.fullGroupCall.at >= active.updatedAt;
  const isJoining = state.joining?.groupId === group;
  if (!current && !lobby && !active && !isJoining) {
    if (!canStart)
      return (
        <>
          <GroupCallStartContext.Provider value={null}>
            {header}
          </GroupCallStartContext.Provider>
          {profileActions && <GroupShortcuts>{profileActions}</GroupShortcuts>}
        </>
      );
    const start: GroupCallStart = {
      disabled:
        !announcements ||
        Boolean(
          state.groupLobby ||
          state.joining ||
          (state.call && state.call.phase !== "ended"),
        ),
      onPress: startGroupCall,
    };
    if (header)
      return (
        <>
          <GroupCallStartContext.Provider value={start}>
            {header}
          </GroupCallStartContext.Provider>
        </>
      );
    if (profileActions)
      return (
        <GroupShortcuts>
          <GroupShortcut
            icon="phone"
            label={t("messages:marmot.shortcutCall")}
            description={t("calls:startCall")}
            {...start}
          />
          {profileActions}
        </GroupShortcuts>
      );
    return (
      <View style={styles.row}>
        <Action size="sm" {...start}>
          {t("calls:startCall")}
        </Action>
      </View>
    );
  }
  const names = (
    current
      ? state.participants.map(({ key }) => key)
      : active
        ? active.members
        : []
  )
    .map((key) => roster.get(key))
    .filter(Boolean);
  return (
    <>
      <GroupCallStartContext.Provider value={null}>
        {header}
      </GroupCallStartContext.Provider>
      {profileActions && <GroupShortcuts>{profileActions}</GroupShortcuts>}
      <View
        style={[
          styles.row,
          Boolean(profileActions) && styles.profileRow,
          { backgroundColor: colors.selected },
        ]}
      >
        <Icon name="audio" color={colors.accent} />
        <View style={styles.label}>
          <Ink>{t("messages:marmot.activeGroupCall")}</Ink>
          {names.length > 0 && (
            <Ink kind="caption" numberOfLines={1}>
              {names.join(", ")}
            </Ink>
          )}
        </View>
        <Action
          size="sm"
          disabled={
            !current &&
            (isJoining ||
              !!full ||
              Boolean(state.groupLobby && !lobby) ||
              Boolean(state.call && state.call.phase !== "ended"))
          }
          onPress={() => {
            if (current) {
              router.push({
                pathname: "/call/[key]",
                params: { key: current.peerKey, callId: current.id },
              });
            } else if (lobby) {
              calling.end();
            } else if (
              active &&
              active.expiresAt > Date.now() &&
              !lock.getState().locked
            ) {
              pending.current = active.call;
              void calling.join(group, active.call, active.routes);
            }
          }}
        >
          {current
            ? t("messages:marmot.returnToCall")
            : lobby
              ? t("calls:end")
              : full
                ? t("messages:marmot.groupCallFull")
                : isJoining
                  ? t("messages:marmot.joiningGroupCall")
                  : t("messages:marmot.joinGroupCall")}
        </Action>
      </View>
    </>
  );
}

export function GroupShortcut({
  icon,
  label,
  description,
  disabled,
  onPress,
}: {
  icon: ComponentProps<typeof Icon>["name"];
  label: string;
  description: string;
  disabled?: boolean;
  onPress: () => void;
}) {
  const { colors } = useTheme();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={description}
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={() => {
        tapFeedback();
        onPress();
      }}
      style={({ pressed }) => [
        styles.shortcut,
        pressed && { backgroundColor: colors.selected },
        disabled && { opacity: 0.5 },
      ]}
    >
      <Icon name={icon} size={22} />
      <Ink kind="caption" style={styles.shortcutLabel}>
        {label}
      </Ink>
    </Pressable>
  );
}

export function GroupShortcuts({ children }: { children: ReactNode }) {
  return <Card style={styles.shortcuts}>{children}</Card>;
}
const styles = StyleSheet.create({
  shortcuts: { flexDirection: "row" },
  shortcut: {
    flex: 1,
    minHeight: 60,
    alignItems: "center",
    justifyContent: "center",
    gap: space.xs,
    padding: space.sm,
  },
  shortcutLabel: { fontWeight: "600", textAlign: "center" },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingVertical: 6,
    paddingHorizontal: 12,
    margin: 8,
    borderRadius: 14,
  },
  label: { flex: 1, minWidth: 0 },
  profileRow: { margin: 0 },
});
