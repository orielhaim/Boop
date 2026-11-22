import { router } from "expo-router";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { useTranslation } from "react-i18next";
import { Alert, StyleSheet, View } from "react-native";
import { useStore } from "zustand";
import { Action, Icon, Ink } from "@/components/ui/kit";
import { discoverGroupCall } from "@/core/calling/group-presence";
import { marmot } from "@/core/marmot/native";
import { useMarmotWindow } from "./marmot-window";
import { namespaces } from "@/i18n";
import { useLocal } from "@/services/local-context";
import { useTheme } from "@/theme";

export function MarmotActiveCall({
  group,
  members,
  canStart,
}: {
  group: string;
  members?: readonly { id: string; name?: string | null; label?: string }[];
  canStart: boolean;
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
    if (!canStart) return null;
    return (
      <View style={styles.row}>
        <Action
          size="sm"
          disabled={
            !announcements ||
            Boolean(
              state.groupLobby ||
              state.joining ||
              (state.call && state.call.phase !== "ended"),
            )
          }
          onPress={() => {
            void calling.startGroup(group).then((started) => {
              if (started)
                pending.current = calling.store.getState().groupLobby?.callId;
              else Alert.alert(t("messages:marmot.groupCallStartFailed"));
            });
          }}
        >
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
    <View style={[styles.row, { backgroundColor: colors.accentSoft }]}>
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
  );
}

const styles = StyleSheet.create({
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
});
