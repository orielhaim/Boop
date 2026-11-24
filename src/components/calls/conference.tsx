import { router } from "expo-router";
import { useCallback, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Pressable, ScrollView, Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import Animated, {
  FadeIn,
  LinearTransition,
  ReduceMotion,
} from "react-native-reanimated";
import { useStore } from "zustand";
import {
  GlassSheet,
  GlassSheetContent,
  GlassSheetTitle,
} from "@/components/glassyui/glass-sheet";
import { Action, Avatar, Icon, Ink, Row, Search } from "@/components/ui/kit";
import {
  callCapacity,
  type InvitationPhase,
  type Participant,
  watchedVideoLimit,
} from "@/core/calling/conference";
import type { VideoState } from "@/core/calling/video";
import { toNpub } from "@/core/identity/keys";
import { GlassAvatar } from "@/components/glassyui/glass-avatar";
import { useMarmotWindow } from "@/components/messages/marmot-window";
import { marmot } from "@/core/marmot/native";
import { useDirectorySearch } from "@/core/profiles/use-directory-search";
import {
  useProjectedNames,
  usePublicProfile,
} from "@/components/people/use-person";
import { nameOrAddress, useContacts } from "@/db/contacts";
import { useLocal } from "@/services/local-context";
import { VideoTile } from "./video-stage";

type Camera = NonNullable<VideoState["conference"]>["cameras"][string];
type Member = Participant & {
  name: string;
  camera?: Camera;
};

const phaseKeys = {
  inviting: "inviting",
  ringing: "ringing",
  connecting: "connectingPrivate",
  declined: "rejected",
  busy: "peerBusy",
  unavailable: "inviteUnavailable",
  "timed-out": "unanswered",
  cancelled: "callCancelled",
} as const satisfies Record<InvitationPhase, string>;

export function InvitationStatus({ onPress }: { onPress: () => void }) {
  const { t } = useTranslation("calls");
  const { calling } = useLocal();
  const latest = useStore(calling.store, (state) => state.invitations.at(-1));
  if (!latest) return null;
  return (
    <Pressable accessibilityRole="button" onPress={onPress}>
      <Text accessibilityLiveRegion="polite" style={styles.invitationStatus}>
        {t(phaseKeys[latest.phase])}
      </Text>
    </Pressable>
  );
}

export function useConferencePeers(video: VideoState | null) {
  const { calling } = useLocal();
  const participants = useStore(calling.store, (state) => state.participants);
  const contacts = useContacts();
  const profile = useProjectedNames(participants.map(({ key }) => key));
  const byKey = useMemo(
    () => new Map(contacts.map((contact) => [contact.publicKey, contact])),
    [contacts],
  );
  return {
    byKey,
    contacts,
    members: participants.map((peer) => {
      const contact = byKey.get(peer.key);
      return {
        ...peer,
        name: nameOrAddress(contact?.name || profile(peer.key)?.name, peer.key),
        camera: video?.conference?.cameras[peer.key],
      };
    }),
  };
}

export function ConferenceSheet({
  mode,
  open,
  setOpen,
  peers,
  activeVideo,
}: {
  mode: "add" | "roster";
  open: boolean;
  setOpen: (open: boolean) => void;
  peers: ReturnType<typeof useConferencePeers>;
  activeVideo: VideoState | null;
}) {
  const { t } = useTranslation(["calls", "common", "contacts", "video"]);
  const { calling, identity, privacy } = useLocal();
  const invitations = useStore(calling.store, (state) => state.invitations);
  const profile = useProjectedNames(
    open && mode !== "add" ? invitations.map(({ key }) => key) : [],
  );
  const group = useStore(calling.store, (state) => state.call?.groupId);
  const [query, setQuery] = useState("");
  const watchRoster = useCallback(
    () => marmot.openGroupRoster(group ?? ""),
    [group],
  );
  const { snapshot } = useMarmotWindow(
    watchRoster,
    open && Boolean(group) && mode === "add",
  );
  const roster = snapshot?.details;
  const pending = invitations.some(
    ({ phase }) =>
      phase === "inviting" || phase === "ringing" || phase === "connecting",
  );
  const occupied = pending || peers.members.length + 1 >= callCapacity;
  const matching = query.trim().toLocaleLowerCase();
  const { exactKey: key, current } = useDirectorySearch(
    query,
    open && !group && mode === "add" && !occupied,
  );
  const found =
    current?.keys.filter((key) => !peers.byKey.has(key)).slice(0, 12) ?? [];
  const candidates = group
    ? roster?.membership === "member"
      ? roster.members
          .filter((member) => !member.self)
          .map((member) => ({
            publicKey: member.id,
            name: member.name || member.npub,
          }))
      : []
    : peers.contacts;
  const contacts = candidates.filter(
    (contact) =>
      !privacy.isBlocked(contact.publicKey) &&
      (!matching ||
        contact.name.toLocaleLowerCase().includes(matching) ||
        toNpub(contact.publicKey).startsWith(matching)),
  );
  const unavailable = (key: string) =>
    key === identity.publicKey ||
    occupied ||
    peers.members.some((member) => member.key === key);
  const invite = (key: string) => {
    if (unavailable(key) || privacy.isBlocked(key)) return;
    setQuery("");
    setOpen(false);
    void calling.invite(key);
  };
  const watched = peers.members.filter(
    (member) => member.camera?.watching,
  ).length;
  return (
    <GlassSheet open={open} onOpenChange={setOpen}>
      <GlassSheetContent>
        <GlassSheetTitle>
          {t(mode === "add" ? "calls:addParticipant" : "calls:participants")}
        </GlassSheetTitle>
        <ScrollView
          keyboardShouldPersistTaps="handled"
          style={styles.sheet}
          contentContainerStyle={styles.sheetContent}
        >
          {mode === "add" ? (
            <>
              <Search
                autoCapitalize="none"
                value={query}
                onChangeText={setQuery}
                accessibilityLabel={t("calls:findParticipant")}
                placeholder={t("calls:findParticipant")}
              />
              {occupied && (
                <Ink kind="caption">
                  {t(
                    pending
                      ? "calls:invitationInProgress"
                      : "calls:conferenceFull",
                  )}
                </Ink>
              )}
              {!group && key && !peers.byKey.has(key) && !unavailable(key) && (
                <Action variant="prominent" onPress={() => invite(key)}>
                  {t("calls:inviteAddress")}
                </Action>
              )}
              {found
                .filter((key) => !unavailable(key) && !privacy.isBlocked(key))
                .map((key) => (
                  <DirectoryInvitee key={key} publicKey={key} invite={invite} />
                ))}
              {contacts.map((contact) => {
                const joined = peers.members.some(
                  (member) => member.key === contact.publicKey,
                );
                const sent = invitations.some(
                  (item) =>
                    item.key === contact.publicKey &&
                    (item.phase === "inviting" ||
                      item.phase === "ringing" ||
                      item.phase === "connecting"),
                );
                return (
                  <Row
                    key={contact.publicKey}
                    title={contact.name}
                    detail={
                      joined
                        ? t("calls:inCall")
                        : sent
                          ? t("calls:inviting")
                          : undefined
                    }
                    leading={
                      <Avatar
                        name={contact.name}
                        publicKey={contact.publicKey}
                      />
                    }
                    trailing={
                      !unavailable(contact.publicKey) ? (
                        <Icon name="add" />
                      ) : undefined
                    }
                    onPress={
                      unavailable(contact.publicKey)
                        ? undefined
                        : () => invite(contact.publicKey)
                    }
                  />
                );
              })}
            </>
          ) : (
            <>
              {peers.members.map((member) => (
                <View key={member.key} style={styles.rosterRow}>
                  <Row
                    title={member.name}
                    detail={
                      member.muted ? t("calls:micMuted") : t("calls:inCall")
                    }
                    leading={
                      <Avatar name={member.name} publicKey={member.key} />
                    }
                    onPress={() => {
                      setOpen(false);
                      router.push({
                        pathname: "/person/[key]",
                        params: { key: member.key },
                      });
                    }}
                  />
                  <View style={styles.actions}>
                    <Action
                      onPress={() =>
                        calling.silence(member.key, !member.silenced)
                      }
                    >
                      {t(
                        member.silenced
                          ? "calls:restoreAudio"
                          : "calls:silence",
                      )}
                    </Action>
                    <Action
                      onPress={() =>
                        calling.volume(
                          member.key,
                          member.volume === 100
                            ? 50
                            : member.volume === 50
                              ? 25
                              : 100,
                        )
                      }
                    >
                      {t("calls:volumePercent", { count: member.volume })}
                    </Action>
                    {member.camera &&
                      (member.camera.watching ||
                        watched < watchedVideoLimit) && (
                        <Action
                          onPress={() =>
                            void calling
                              .video()
                              ?.watch?.(member.key, !member.camera?.watching)
                          }
                        >
                          {t(
                            member.camera.watching
                              ? "calls:stopWatching"
                              : "calls:watch",
                          )}
                        </Action>
                      )}
                  </View>
                </View>
              ))}
              {invitations.map((item) => {
                const contact = peers.byKey.get(item.key);
                const name = nameOrAddress(
                  contact?.name || profile(item.key)?.name,
                  item.key,
                );
                return (
                  <Row
                    key={item.id}
                    title={name}
                    detail={t(`calls:${phaseKeys[item.phase]}`)}
                    leading={<Avatar name={name} publicKey={item.key} />}
                  />
                );
              })}
              {pending && (
                <Action onPress={calling.cancelInvitation}>
                  {t("calls:cancelInvitation")}
                </Action>
              )}
              {activeVideo?.conference && (
                <View style={styles.actions}>
                  <Action
                    onPress={() => {
                      calling
                        .video()
                        ?.mode?.(
                          activeVideo.conference?.mode === "grid"
                            ? "focus"
                            : "grid",
                        );
                      setOpen(false);
                    }}
                  >
                    {t(
                      activeVideo.conference.mode === "grid"
                        ? "calls:focusView"
                        : "calls:gridView",
                    )}
                  </Action>
                  <Action
                    onPress={() => {
                      calling.video()?.focus?.(null);
                      setOpen(false);
                    }}
                  >
                    {t("calls:automaticFocus")}
                  </Action>
                </View>
              )}
            </>
          )}
        </ScrollView>
      </GlassSheetContent>
    </GlassSheet>
  );
}

export function ConferenceTiles({
  members,
  mode,
  focus,
  systemVideoUrl,
  onFocus,
  onWatch,
  muted,
}: {
  members: Member[];
  mode: "audio" | "rail" | "grid";
  focus?: string | null;
  systemVideoUrl?: string | null;
  onFocus?: (key: string) => void;
  onWatch?: (key: string) => void;
  muted?: boolean;
}) {
  const { t } = useTranslation("calls");
  const { identity } = useLocal();
  const visible =
    mode === "grid"
      ? members.filter((member) => !!member.camera?.url)
      : members;
  const tiles = visible.map((member) => {
    const active = focus === member.key;
    const videoUrl =
      mode !== "audio" && !(mode === "rail" && active)
        ? member.camera?.url
        : undefined;
    const open = member.camera?.url
      ? onFocus && (() => onFocus(member.key))
      : member.camera && !member.camera.watching && onWatch
        ? () => onWatch(member.key)
        : undefined;
    return (
      <Animated.View
        key={member.key}
        entering={FadeIn.reduceMotion(ReduceMotion.System)}
        layout={LinearTransition.reduceMotion(ReduceMotion.System)}
        style={[
          styles.tile,
          styles[mode],
          (member.speaking || active) && styles.highlight,
        ]}
      >
        <Pressable
          accessibilityRole={open ? "button" : undefined}
          onPress={open}
          style={styles.tileContents}
        >
          {videoUrl ? (
            <VideoTile
              url={videoUrl}
              systemPip={mode === "grid" && videoUrl === systemVideoUrl}
            />
          ) : (
            <Avatar
              name={member.name}
              publicKey={member.key}
              size={mode === "audio" ? "lg" : undefined}
            />
          )}
          <View style={[styles.tileLabel, videoUrl && styles.labelScrim]}>
            <Text numberOfLines={1} style={styles.name}>
              {member.name}
            </Text>
            {(member.muted || member.silenced) && (
              <Icon name="mic" size={15} color="#CFD7EF" />
            )}
          </View>
          {mode === "audio" && (
            <Text style={styles.secondary}>
              {t(
                member.camera?.watching
                  ? "videoLoading"
                  : member.camera
                    ? "cameraAvailable"
                    : "inCall",
              )}
            </Text>
          )}
        </Pressable>
      </Animated.View>
    );
  });
  return mode === "rail" ? (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      contentContainerStyle={styles.railContents}
    >
      {tiles}
    </ScrollView>
  ) : (
    <View style={mode === "grid" ? styles.videoGrid : styles.audioGrid}>
      {mode === "audio" && (
        <View style={[styles.tile, styles.audio, styles.self]}>
          <GlassAvatar
            name={t("myCallTile")}
            identityKey={identity.publicKey}
            size="lg"
            importantForAccessibility="no"
          />
          <Text style={styles.name}>{t("myCallTile")}</Text>
          <Text style={styles.secondary}>
            {t(muted ? "micMuted" : "inCall")}
          </Text>
        </View>
      )}
      {tiles}
    </View>
  );
}

function DirectoryInvitee({
  publicKey,
  invite,
}: {
  publicKey: string;
  invite: (key: string) => void;
}) {
  const profile = usePublicProfile(publicKey, true);
  const name = nameOrAddress(profile?.name, publicKey);
  return (
    <Row
      title={name}
      leading={<Avatar name={name} publicKey={publicKey} />}
      trailing={<Icon name="add" />}
      onPress={() => invite(publicKey)}
    />
  );
}

const styles = StyleSheet.create({
  sheet: { maxHeight: 430 },
  sheetContent: { gap: 8, paddingBottom: 8 },
  rosterRow: { gap: 3, paddingBottom: 6 },
  actions: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 8,
    paddingHorizontal: 6,
  },
  audioGrid: {
    flexDirection: "row",
    flexWrap: "wrap",
    justifyContent: "center",
    gap: 10,
    width: "100%",
  },
  videoGrid: {
    flex: 1,
    flexDirection: "row",
    flexWrap: "wrap",
    alignContent: "center",
    justifyContent: "center",
    gap: 10,
    padding: 12,
    backgroundColor: "#121A30",
  },
  railContents: { gap: 7, paddingHorizontal: 4, paddingVertical: 6 },
  tile: {
    borderWidth: 1,
    borderColor: "#CDD9FF38",
    borderRadius: 20,
    overflow: "hidden",
    backgroundColor: "#222D49",
  },
  audio: { width: "45%", minHeight: 126 },
  rail: { width: 80, height: 80, borderRadius: 14 },
  grid: { width: "47%", height: "35%" },
  highlight: { borderColor: "#77D6B7", backgroundColor: "#283E54" },
  tileContents: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
    gap: 5,
    padding: 5,
  },
  tileLabel: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    maxWidth: "100%",
  },
  labelScrim: {
    position: "absolute",
    bottom: 4,
    start: 4,
    end: 4,
    paddingHorizontal: 6,
    borderRadius: 9,
    backgroundColor: "#121A30BB",
  },
  name: { color: "#F0F4FF", fontSize: 13, fontWeight: "600", flexShrink: 1 },
  secondary: { color: "#BECBE9", fontSize: 11 },
  self: { alignItems: "center", justifyContent: "center", gap: 5 },
  invitationStatus: {
    color: "#DCE5FC",
    fontSize: 13,
    textAlign: "center",
    padding: 5,
  },
});
