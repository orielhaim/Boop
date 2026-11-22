import { router } from "expo-router";
import {
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
import { callCapacity } from "@/core/calling/conference";
import {
  discoverGroupCall,
  groupCallKind,
} from "@/core/calling/group-presence";
import type { MarmotMessage } from "@/core/marmot/native";
import { namespaces } from "@/i18n";
import { useLocal } from "@/services/local-context";
import { useTheme } from "@/theme";

export function MarmotActiveCall({
  group,
  messages,
  members,
}: {
  group: string;
  messages?: readonly MarmotMessage[];
  members?: readonly { id: string; name?: string | null; label?: string }[];
}) {
  const { t } = useTranslation(namespaces);
  const { colors } = useTheme();
  const { calling, privacy, lock } = useLocal();
  const state = useStore(calling.store);
  const lockState = useSyncExternalStore(lock.subscribe, lock.getState);
  const privacyRevision = useSyncExternalStore(
    privacy.subscribe,
    privacy.revision,
  );
  const current =
    state.call?.groupId === group && state.call.phase !== "ended"
      ? state.call
      : undefined;
  const pending = useRef<string>(undefined);
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
              messages?.filter((row) => row.eventKind === groupCallKind) ?? [],
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
    messages,
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

  if ((!current && !discovered) || lockState.locked) return null;
  const names = (
    current
      ? state.participants.map(({ key }) => key)
      : discovered
        ? discovered.members
        : []
  )
    .map((key) => roster.get(key))
    .filter(Boolean);
  const isJoining = state.joining?.groupId === group;
  const full = discovered && discovered.members.length >= callCapacity;
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
            Boolean(state.call && state.call.phase !== "ended"))
        }
        onPress={() => {
          if (current) {
            router.push({
              pathname: "/call/[key]",
              params: { key: current.peerKey, callId: current.id },
            });
          } else if (
            discovered &&
            discovered.expiresAt > Date.now() &&
            !lock.getState().locked
          ) {
            pending.current = discovered.call;
            void calling
              .join(group, discovered.call, discovered.coordinator)
              .then((sent) => {
                if (!sent) {
                  pending.current = undefined;
                  Alert.alert(t("messages:marmot.groupCallUnavailable"));
                }
              });
          }
        }}
      >
        {current
          ? t("messages:marmot.returnToCall")
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
