import { ScreenHeader } from "@/components/navigation/screen-header";
import { ProfileElement } from "@/components/navigation/profile-elements";
import { SharedMediaLibrary } from "@/components/shared-media/library";
import {
  ProfileTabs,
  type ProfileTab,
} from "@/components/shared-media/profile-tabs";
import { router, useIsFocused, usePreventRemove } from "expo-router";
import type { File } from "expo-file-system";
import { asc } from "drizzle-orm";
import {
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { useTranslation } from "react-i18next";
import { AppState, FlatList, Pressable, ScrollView, View } from "react-native";
import { useDialog } from "@/components/ui/dialog";
import { StyleSheet } from "react-native-unistyles";
import { EditableAvatar } from "@/components/avatars/editable-avatar";
import { usePerson, usePresentedName } from "@/components/people/use-person";
import { PersonAvatar } from "@/components/people/person-avatar";
import { AvatarCropScreen, useAvatarPicker } from "@/components/avatars/picker";
import { GlassInput } from "@/components/glassyui/glass-input";
import { GlassAvatar } from "@/components/glassyui/glass-avatar";
import { ListGroup, ListRow } from "@/components/ui/list-group";
import { ActionMenu } from "@/components/ui/action-menu";
import { SaveButton } from "@/components/ui/save-button";
import {
  backButtonSize,
  ChatProfileBackButton,
  GlassBackButton,
} from "@/components/ui/back-button";
import {
  Action,
  Avatar,
  Card,
  Empty,
  Icon,
  Ink,
  Screen,
  tapFeedback,
} from "@/components/ui/kit";
import type { MenuAction } from "@expo/ui/community/menu";

import { useAvatarVisibility } from "@/core/avatars/use-avatar";
import { useDirectorySearch } from "@/core/profiles/use-directory-search";
import { parsePublicKey, toNpub } from "@/core/identity/keys";
import { blossomServer } from "@/core/media/blossom";
import { isChatMuted } from "@/core/marmot/chat-mute";
import {
  marmot,
  type MarmotGroupDetails,
  type MarmotGroupDiagnostics,
  type MarmotGroupDisposition,
  type MarmotMemberOutcome,
} from "@/core/marmot/native";
import type { AccountDevicesActivation } from "@/core/marmot/device-contract";
import { contactByKey } from "@/db/queries";
import { contacts } from "@/db/schema";
import { namespaces, resolveLanguage } from "@/i18n";
import { formatDateTime, isolateText } from "@/i18n/format";
import { useLocal } from "@/services/local-context";
import { space, useTheme } from "@/theme";
import { conversationRoute } from "./marmot-inbox";
import { useChatClock, useMuteDuration } from "./chat-mute";
import { useMarmotError } from "./use-marmot-error";
import { useMarmotWindow } from "./marmot-window";
import {
  GroupShortcut,
  GroupShortcuts,
  MarmotActiveCall,
} from "./marmot-active-call";
import { usePreparedGroupAvatar } from "./use-prepared-group-avatar";

function resolveAddresses(addresses: string, own: string) {
  const items = addresses
    .trim()
    .split(/[\s,]+/u)
    .filter(Boolean);
  const keys = new Set<string>();
  for (const item of items) {
    const key = parsePublicKey(item);
    if (!key || key === own) return null;
    keys.add(key);
  }
  return [...keys];
}

type Translate = ReturnType<typeof useTranslation<typeof namespaces>>["t"];

function failureList(outcomes: MarmotMemberOutcome[], t: Translate) {
  return outcomes
    .filter(
      (row) => row.status !== "selected" && row.status !== "already_member",
    )
    .map((row) => {
      const key = parsePublicKey(row.account);
      const name = key ? toNpub(key) : row.account;
      const reason =
        row.status === "missing_inbox_route"
          ? t("messages:marmot.missingInboxRoute")
          : row.status === "incomplete"
            ? t("messages:marmot.temporarilyUnavailable")
            : t("messages:marmot.missingPackage");
      return `${name}\n${reason}`;
    })
    .join("\n");
}

function imagePath(file: File) {
  if (!file.uri.startsWith("file:///")) throw new Error("InvalidMediaPath");
  return decodeURIComponent(file.uri.slice(7));
}

function cleanImage(file: File | null) {
  try {
    file?.delete();
  } catch {
    // A cache file can already have been reclaimed by the OS.
  }
}

export function NewMarmotGroup() {
  const { t } = useTranslation(namespaces);
  const dialog = useDialog();
  const {
    db,
    identity,
    marmotSession,
    privacy,
    mediaSdk,
    lock,
    isCurrent,
    chatPreferences,
  } = useLocal();
  const { colors } = useTheme();
  const translateError = useMarmotError();
  const [saved] = useState(() =>
    db.select().from(contacts).orderBy(asc(contacts.name)).all(),
  );
  useSyncExternalStore(privacy.subscribe, privacy.revision);
  const eligible = saved.filter(
    ({ publicKey }) =>
      publicKey !== identity.publicKey && !privacy.isBlocked(publicKey),
  );
  const [step, setStep] = useState(eligible.length ? "people" : "details");
  const focused = useIsFocused();
  const [query, setQuery] = useState("");
  const { exactKey, current: results } = useDirectorySearch(
    query,
    focused && step === "people",
  );
  const candidates = query.trim()
    ? [
        ...new Set([
          ...(exactKey ? [exactKey] : (results?.keys ?? [])),
          ...eligible
            .filter(
              ({ name, publicKey }) =>
                name
                  .toLocaleLowerCase()
                  .includes(query.trim().toLocaleLowerCase()) ||
                toNpub(publicKey).startsWith(query.trim().toLowerCase()),
            )
            .map(({ publicKey }) => publicKey),
        ]),
      ]
    : eligible.map(({ publicKey }) => publicKey);
  const avatarVisibility = useAvatarVisibility<string>(
    (key) => key,
    focused && step === "people",
  );
  const invitees = candidates.filter(
    (key) => key !== identity.publicKey && !privacy.isBlocked(key),
  );
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [selected, setSelected] = useState<string[]>([]);
  const [status, setStatus] = useState<"idle" | "creating" | "created">("idle");
  const [error, setError] = useState("");
  const [photo, setPhoto] = useState<File | null>(null);
  const creating = useRef(false);
  const picker = useAvatarPicker();
  useEffect(() => () => cleanImage(photo), [photo]);

  const busy = status !== "idle";
  const selecting = step === "people";
  const canReturnToPeople =
    !selecting && (eligible.length > 0 || selected.length > 0);
  const disablePrevention = usePreventRemove(
    status !== "created" &&
      (busy || Boolean(picker.image) || canReturnToPeople),
    () => {
      if (creating.current) return;
      if (picker.image) picker.clear();
      else setStep("people");
    },
  );

  function back() {
    if (status === "creating") return;
    if (status === "idle" && canReturnToPeople) setStep("people");
    else if (router.canGoBack()) router.back();
    else router.replace("/");
  }

  function openDetails() {
    tapFeedback();
    setError("");
    setStep("details");
    if (!selected.length) return;
    void marmotSession
      .ready()
      .then(() => {
        if (
          !isCurrent() ||
          lock.getState().locked ||
          AppState.currentState !== "active"
        )
          return;
        const members = selected.filter((key) => !privacy.isBlocked(key));
        if (members.length) return marmot.prewarmInvitees(members);
      })
      .catch(() => undefined);
  }

  async function create() {
    const groupName = name.trim();
    if (!groupName || creating.current) return;
    if (selected.some(privacy.isBlocked)) {
      setError(t("messages:marmot.blocked"));
      return;
    }
    creating.current = true;
    setStatus("creating");
    setError("");
    let created = false;
    try {
      await marmotSession.ready();
      if (
        !isCurrent() ||
        lock.getState().locked ||
        AppState.currentState !== "active"
      )
        return;
      if (selected.some(privacy.isBlocked)) {
        setError(t("messages:marmot.blocked"));
        return;
      }
      const result = await marmot.createGroup(
        groupName,
        description.trim() || null,
        selected,
        photo ? imagePath(photo) : null,
      );
      const unavailable = failureList(result.members, t);
      const group = result.groupId;
      if (!group) {
        setError(unavailable || t("messages:marmot.operationError"));
        return;
      }
      created = true;
      if (!isCurrent()) return;
      if (result.createdAt)
        chatPreferences.recordGroupCreation(group, result.createdAt);
      setStatus("created");
      const openGroup = () => {
        if (!isCurrent()) return;
        disablePrevention();
        router.replace(conversationRoute(group));
      };
      if (unavailable) {
        void dialog.show({
          title: t("messages:marmot.unavailableMembers"),
          message: unavailable,
          dismissible: false,
          actions: [{ label: t("common:done"), onSelect: openGroup }],
        });
      } else {
        openGroup();
      }
    } catch (reason) {
      setError(translateError(reason));
    } finally {
      if (!created) {
        creating.current = false;
        setStatus("idle");
      }
    }
  }

  if (picker.image)
    return (
      <AvatarCropScreen
        topInset
        source={picker.image}
        onCancel={picker.clear}
        onSave={(file) => {
          setPhoto(file);
          picker.clear();
        }}
      />
    );

  return (
    <Screen scroll={false} topInset>
      <View style={groupSetupStyles.header}>
        <View style={groupSetupStyles.back}>
          {status !== "creating" && (
            <GlassBackButton onPress={back} elevation="none" />
          )}
        </View>
        <Ink
          kind="heading"
          accessibilityRole="header"
          numberOfLines={1}
          style={groupSetupStyles.title}
        >
          {t(
            selecting
              ? "messages:marmot.selectGroupPeople"
              : "messages:marmot.newGroup",
          )}
        </Ink>
      </View>
      {selecting ? (
        <>
          <FlatList
            data={invitees}
            {...avatarVisibility}
            ListHeaderComponent={
              <GlassInput
                label={t("messenger:searchHint")}
                autoCapitalize="none"
                value={query}
                onChangeText={setQuery}
              />
            }
            keyExtractor={(publicKey) => publicKey}
            contentContainerStyle={groupSetupStyles.people}
            renderItem={({ item: publicKey }) => (
              <GroupInviteeRow
                publicKey={publicKey}
                selected={selected.includes(publicKey)}
                onToggle={() =>
                  setSelected((keys) =>
                    keys.includes(publicKey)
                      ? keys.filter((key) => key !== publicKey)
                      : [...keys, publicKey],
                  )
                }
              />
            )}
          />
          <View style={groupSetupStyles.footer}>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={t("messages:marmot.continueToGroupDetails")}
              onPress={openDetails}
              style={({ pressed }) => [
                groupSetupStyles.continue,
                {
                  backgroundColor: colors.outgoing,
                  opacity: pressed ? 0.72 : 1,
                },
              ]}
            >
              <Icon name="continue" size={24} color={colors.outgoingInk} />
            </Pressable>
          </View>
        </>
      ) : (
        <ScrollView
          contentContainerStyle={groupSetupStyles.form}
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="on-drag"
        >
          <View style={groupSetupStyles.identityFields}>
            <EditableAvatar
              disabled={busy || picker.busy}
              showEditBadge={Boolean(photo)}
              onPick={(source) => void picker.pick(source)}
              onRemove={photo ? () => setPhoto(null) : undefined}
            >
              {photo ? (
                <GlassAvatar name={name} src={photo.uri} size="lg" />
              ) : (
                <View
                  style={[
                    groupSetupStyles.photoPlaceholder,
                    { backgroundColor: colors.selected },
                  ]}
                >
                  <Icon name="photo" size={24} />
                </View>
              )}
            </EditableAvatar>
            <View style={groupSetupStyles.nameField}>
              <GlassInput
                compact
                label={t("messages:marmot.groupName")}
                value={name}
                onChangeText={setName}
                maxLength={128}
                editable={!busy}
              />
            </View>
          </View>
          <GlassInput
            compact
            label={t("messages:marmot.groupDescriptionOptional")}
            value={description}
            onChangeText={setDescription}
            multiline
            textAlignVertical="top"
            style={groupSetupStyles.description}
            maxLength={512}
            editable={!busy}
          />
          {picker.error && (
            <Ink accessibilityLiveRegion="polite">{picker.error}</Ink>
          )}
          {!mediaSdk.configured("attachment").length && (
            <Ink kind="caption" muted>
              {t("messages:marmot.textOnlyGroup")}
            </Ink>
          )}
          {!canReturnToPeople && (
            <Action onPress={() => setStep("people")}>
              {t("messages:marmot.selectGroupPeople")}
            </Action>
          )}
          {error ? <Ink accessibilityLiveRegion="polite">{error}</Ink> : null}
          {status === "created" ? (
            <Action variant="prominent" onPress={back}>
              {t("common:done")}
            </Action>
          ) : (
            <Action
              disabled={busy || picker.busy || !name.trim()}
              variant="prominent"
              onPress={() => void create()}
            >
              {t(
                busy
                  ? "messages:marmot.creatingGroup"
                  : "messages:marmot.create",
              )}
            </Action>
          )}
        </ScrollView>
      )}
    </Screen>
  );
}

function GroupInviteeRow({
  publicKey,
  selected,
  onToggle,
}: {
  publicKey: string;
  selected: boolean;
  onToggle: () => void;
}) {
  const { colors } = useTheme();
  const { contact, profile, photo, name } = usePerson(publicKey, false);
  return (
    <Pressable
      accessibilityLabel={name}
      accessibilityRole="checkbox"
      accessibilityState={{ checked: selected }}
      onPress={() => {
        tapFeedback();
        onToggle();
      }}
      style={({ pressed }) => [
        groupSetupStyles.person,
        (selected || pressed) && { backgroundColor: colors.selected },
      ]}
    >
      <PersonAvatar
        publicKey={publicKey}
        name={name}
        photo={photo}
        hasName={Boolean(contact?.name || profile?.name)}
      />
      <Ink kind="label" numberOfLines={1} style={groupSetupStyles.personName}>
        {name}
      </Ink>
      <View
        style={[
          groupSetupStyles.check,
          {
            borderColor: selected ? colors.outgoing : colors.line,
            backgroundColor: selected ? colors.outgoing : undefined,
          },
        ]}
      >
        {selected && <Icon name="check" size={15} color={colors.outgoingInk} />}
      </View>
    </Pressable>
  );
}

const groupSetupStyles = StyleSheet.create({
  header: {
    minHeight: backButtonSize,
    justifyContent: "center",
    marginHorizontal: space.lg,
    marginBottom: space.sm,
  },
  back: { position: "absolute", start: 0, zIndex: 1 },
  title: { textAlign: "center", marginHorizontal: backButtonSize + space.sm },
  people: { paddingHorizontal: space.lg, paddingBottom: space.sm },
  person: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.md,
    minHeight: 56,
    paddingHorizontal: space.sm,
    borderRadius: 14,
  },
  personName: { flex: 1 },
  check: {
    width: 23,
    height: 23,
    borderWidth: 1,
    borderRadius: 12,
    alignItems: "center",
    justifyContent: "center",
  },
  footer: {
    alignItems: "flex-end",
    paddingHorizontal: space.lg,
    paddingTop: space.sm,
    paddingBottom: space.md,
  },
  continue: {
    width: 52,
    height: 52,
    borderRadius: 26,
    alignItems: "center",
    justifyContent: "center",
  },
  form: {
    gap: space.md,
    paddingHorizontal: space.lg,
    paddingTop: space.xs,
    paddingBottom: space.xxl,
  },
  identityFields: { flexDirection: "row", gap: space.md, alignItems: "center" },
  photoPlaceholder: {
    width: 56,
    height: 56,
    borderRadius: 28,
    alignItems: "center",
    justifyContent: "center",
  },
  nameField: { flex: 1, minWidth: 0 },
  description: { minHeight: 112 },
});

export function MarmotGroupDetailsScreen({
  id,
  editing = false,
  morph,
}: {
  id: string;
  editing?: boolean;
  morph?: string;
}) {
  const { t, i18n } = useTranslation(namespaces);
  const dialog = useDialog();
  const chooseMuteDuration = useMuteDuration();
  const { colors } = useTheme();
  const {
    db,
    identity,
    privacy,
    lock,
    isCurrent,
    chatPreferences,
    conversations,
    deviceController,
  } = useLocal();
  const translateError = useMarmotError();
  const [busy, setBusy] = useState(false);
  const [loadedPhoto, setLoadedPhoto] = useState<{
    hash: string;
    uri: string;
  }>();
  const [showRelays, setShowRelays] = useState(false);
  const [showMediaServers, setShowMediaServers] = useState(false);
  const [showMembers, setShowMembers] = useState(false);
  const [profileTab, setProfileTab] = useState<"info" | "members" | "media">(
    "info",
  );
  const focused = useIsFocused();
  const deviceControllerState = useSyncExternalStore(
    deviceController.subscribe,
    deviceController.getState,
  );
  const [deviceActivation, setDeviceActivation] =
    useState<AccountDevicesActivation>();
  const [deviceActivationError, setDeviceActivationError] = useState(false);
  const sharedMediaScrollPosition = useRef(0);
  const [showInvite, setShowInvite] = useState(false);
  const [profileDraft, setProfileDraft] = useState<{
    name?: string;
    description?: string;
  }>({});
  const picker = useAvatarPicker();
  const watch = useCallback(() => marmot.openGroupState(id), [id]);
  const state = useMarmotWindow(watch);
  const { details } = state.snapshot ?? {};
  const muteDeadline = details?.mutedUntilMs;
  const deadlines = useMemo(
    () => (muteDeadline == null ? [] : [muteDeadline]),
    [muteDeadline],
  );
  const now = useChatClock(deadlines, Boolean(details));
  const muted = details != null && isChatMuted(details, now);
  const muteStatus = muted
    ? muteDeadline == null
      ? t("messages:chatMute.mutedForever")
      : t("messages:chatMute.mutedUntil", {
          date: isolateText(
            formatDateTime(
              muteDeadline,
              resolveLanguage(i18n.resolvedLanguage),
            ),
          ),
        })
    : undefined;
  const [chatHeader] = useState(() => {
    const snapshot = morph ? conversations.get(id)?.snapshot : undefined;
    if (snapshot && !snapshot.invited)
      return {
        title: snapshot.title,
        asset: snapshot.image ? snapshot.avatarAsset : undefined,
      };
  });
  const [observation, setObservation] = useState<{
    snapshot: typeof state.snapshot;
    value: MarmotGroupDiagnostics;
  }>();
  useEffect(() => {
    if (editing || !state.snapshot || state.snapshot.details.pendingInvitation)
      return;
    const snapshot = state.snapshot;
    let active = true;
    void marmot
      .groupDiagnostics(id)
      .then((value) => {
        if (active) setObservation({ snapshot, value });
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, [editing, id, state.snapshot]);
  const diagnostics =
    observation?.snapshot === state.snapshot ? observation?.value : undefined;
  useSyncExternalStore(privacy.subscribe, privacy.revision);

  const member = details?.membership === "member" && !details.pendingInvitation;
  const canEdit = Boolean(member && details?.canEdit);
  const isGroup = details?.kind !== "direct";
  const canReadDeviceActivation = Boolean(
    focused &&
    !editing &&
    member &&
    isGroup &&
    deviceControllerState.connection === "observing" &&
    !lock.getState().locked &&
    AppState.currentState === "active",
  );
  useEffect(() => {
    if (!canReadDeviceActivation) return;
    let active = true;
    void deviceController
      .accountDevicesActivation(id)
      .then((value) => {
        if (active && isCurrent() && !lock.getState().locked) {
          setDeviceActivation(value);
          setDeviceActivationError(false);
        }
      })
      .catch(() => {
        if (active && isCurrent() && !lock.getState().locked)
          setDeviceActivationError(true);
      });
    return () => {
      active = false;
    };
  }, [canReadDeviceActivation, deviceController, details, id, isCurrent, lock]);
  const photo =
    member && privacy.photoPolicy() !== "nobody" ? details?.image : undefined;
  const cachedPhoto = usePreparedGroupAvatar(
    details ? (photo ? details.avatarAsset : undefined) : chatHeader?.asset,
    true,
    Boolean(morph),
  );
  const imageUri =
    photo && loadedPhoto?.hash === photo ? loadedPhoto.uri : cachedPhoto;
  const editTitle = t(
    isGroup ? "messages:marmot.editGroup" : "messages:marmot.editConversation",
  );
  const back = () =>
    router.canGoBack() ? router.back() : router.replace(conversationRoute(id));

  async function update(
    task: () => Promise<void | MarmotGroupDisposition | null>,
    leave = false,
    refresh = false,
  ) {
    if (
      busy ||
      !isCurrent() ||
      lock.getState().locked ||
      AppState.currentState !== "active"
    )
      return false;
    setBusy(true);
    try {
      const result = await task();
      if (!isCurrent() || lock.getState().locked) return false;
      if (result === "accepted_pending" || result === "completion_unknown") {
        dialog.show({
          title: t("messages:marmot.pendingCommit"),
          tone: "info",
        });
      } else if (leave) router.back();
      else if (refresh) state.retry();
      return true;
    } catch (reason) {
      dialog.show({ title: translateError(reason), tone: "error" });
      return false;
    } finally {
      setBusy(false);
    }
  }

  function confirm(
    title: string,
    task: () => Promise<void | MarmotGroupDisposition | null>,
    leave = false,
    description?: string,
  ) {
    void dialog.show({
      title,
      message: description,
      dismissible: false,
      actions: [
        { label: t("common:cancel"), tone: "cancel" },
        {
          label: title,
          tone: "danger",
          onSelect: () => void update(task, leave),
        },
      ],
    });
  }

  function deleteSharedGroup() {
    confirm(
      t("messages:marmot.disband"),
      () => marmot.changeMembership(id, "disband"),
      false,
      t("messages:marmot.deleteGroupConfirmation"),
    );
  }

  async function loadImage() {
    if (!photo || busy) return;
    setBusy(true);
    try {
      const uri = await marmot.viewGroupImage(id, photo);
      if (privacy.photoPolicy() !== "nobody")
        setLoadedPhoto({ hash: photo, uri });
    } catch (reason) {
      dialog.show({ title: translateError(reason), tone: "error" });
    } finally {
      setBusy(false);
    }
  }

  if (editing && canEdit && picker.image)
    return (
      <AvatarCropScreen
        navigationHeader={
          <ScreenHeader
            title={t("settings:photoChange")}
            onBack={picker.clear}
          />
        }
        source={picker.image}
        onCancel={picker.clear}
        onSave={(file) => {
          picker.clear();
          void update(async () => {
            try {
              return await marmot.updateGroupImage(id, imagePath(file));
            } finally {
              cleanImage(file);
            }
          });
        }}
      />
    );

  const title = details?.pendingInvitation
    ? t("messages:marmot.invitations")
    : editing
      ? editTitle
      : t(
          isGroup
            ? "messages:marmot.details"
            : "messages:marmot.conversationDetails",
        );

  const peer = isGroup
    ? undefined
    : details?.members.find((person) => !person.self);
  const groupName = peer
    ? contactByKey(db, peer.id).get()?.name || peer.name || peer.npub
    : details?.name || chatHeader?.title || t("messages:marmot.group");
  const avatar = (
    <GlassAvatar
      identityKey={peer?.id ?? id}
      name={groupName}
      src={imageUri}
      size="xl"
      animateArrival={!morph}
    />
  );
  const canLoadImage = Boolean(photo && !imageUri);
  const editProfile = canEdit
    ? () => router.push(conversationRoute(id, "edit"))
    : undefined;
  const profileHeader = (active: boolean, showActions = true) =>
    !editing &&
    !details?.pendingInvitation && (
      <GroupProfileHeader
        morph={active ? morph : undefined}
        name={details || morph ? groupName : undefined}
        count={isGroup ? details?.members.length : undefined}
        description={details?.description}
        back={showActions && !morph ? back : undefined}
        edit={showActions && !isGroup ? editProfile : undefined}
        editTitle={editTitle}
        avatar={
          peer ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={t("contacts:openProfile", {
                name: groupName,
              })}
              onPress={() =>
                router.push({
                  pathname: "/person/[key]",
                  params: { key: peer.id },
                })
              }
            >
              <Avatar publicKey={peer.id} name={groupName} size="xl" />
            </Pressable>
          ) : details || morph ? (
            <Pressable
              accessible={canLoadImage}
              accessibilityRole={canLoadImage ? "button" : undefined}
              accessibilityLabel={
                canLoadImage ? t("messages:marmot.viewGroupPhoto") : undefined
              }
              disabled={canLoadImage && busy}
              onPress={canLoadImage ? () => void loadImage() : undefined}
            >
              {avatar}
              {canLoadImage && (
                <View
                  style={[
                    styles.photoBadge,
                    {
                      backgroundColor: colors.selected,
                      borderColor: colors.background,
                    },
                  ]}
                >
                  <Icon name="download" size={14} />
                </View>
              )}
            </Pressable>
          ) : undefined
        }
      />
    );

  if (
    state.error ||
    !details ||
    details.pendingInvitation ||
    (editing && !canEdit)
  )
    return (
      <Screen
        topInset
        navigationHeader={
          editing || details?.pendingInvitation ? (
            <ScreenHeader title={title} onBack={back} />
          ) : morph ? (
            <ChatProfileBackButton onPress={back} />
          ) : undefined
        }
      >
        {profileHeader(true)}
        {state.error ? (
          <Empty
            detail=""
            icon="chat"
            title={t("messages:marmot.accountError")}
          >
            <Action onPress={state.retry}>{t("common:retry")}</Action>
          </Empty>
        ) : !details ? null : details.pendingInvitation ? (
          <Empty
            detail=""
            icon="invitations"
            title={t("messages:marmot.inviteRequired")}
          >
            <Action onPress={() => router.replace(conversationRoute(id))}>
              {t("messages:marmot.reviewInvitation")}
            </Action>
          </Empty>
        ) : (
          <Empty
            detail=""
            icon="lock"
            title={t("messages:marmot.groupEditUnavailable")}
          />
        )}
      </Screen>
    );

  const roster = (
    <ListGroup title={t("messages:marmot.members")}>
      {editing && details.canInvite && (
        <ListRow
          title={t("messages:marmot.invite")}
          icon="addPerson"
          expanded={showInvite}
          trailing={
            <Icon
              name={showInvite ? "collapse" : "expand"}
              size={18}
              color={colors.muted}
            />
          }
          onPress={() => setShowInvite((value) => !value)}
        />
      )}
      {editing && details.canInvite && showInvite && (
        <View style={styles.form}>
          <InviteMemberField
            busy={busy}
            invite={(addresses) => {
              const keys = resolveAddresses(addresses, identity.publicKey);
              if (!keys?.length || keys.some(privacy.isBlocked)) {
                dialog.show({
                  title: t("contacts:invalidAddress"),
                  tone: "error",
                });
                return;
              }
              void update(async () => {
                const { members, disposition } = await marmot.inviteMembers(
                  id,
                  keys,
                );
                const unavailable = failureList(members, t);
                if (unavailable) {
                  const pending =
                    disposition === "accepted_pending" ||
                    disposition === "completion_unknown";
                  dialog.show({
                    title: t("messages:marmot.unavailableMembers"),
                    message: pending
                      ? unavailable + "\n" + t("messages:marmot.pendingCommit")
                      : unavailable,
                    tone: pending ? "info" : undefined,
                  });
                }
                return unavailable ? undefined : disposition;
              });
            }}
          />
        </View>
      )}
      {details.members.map((person) => {
        const name =
          contactByKey(db, person.id).get()?.name || person.name || person.npub;
        const actions: MenuAction[] = [];
        if (editing && !busy) {
          if (person.canPromote)
            actions.push({
              id: "promote",
              title: t("messages:marmot.promote"),
            });
          if (
            person.self &&
            details.canStepDown &&
            details.lifecycle === "stable" &&
            !details.disbanding
          )
            actions.push({
              id: "stepDown",
              title: t("messages:marmot.stepDown"),
            });
          if (person.canDemote)
            actions.push({ id: "demote", title: t("messages:marmot.demote") });
          if (person.canRemove)
            actions.push({
              id: "remove",
              title: t("messages:marmot.remove"),
              attributes: { destructive: true },
            });
        }
        return (
          <View key={person.id} style={styles.rosterRow}>
            <GroupMemberIdentity
              publicKey={person.id}
              displayName={person.name}
            />
            {person.admin && (
              <Ink
                kind="caption"
                style={[
                  styles.role,
                  { backgroundColor: colors.selected, color: colors.accent },
                ]}
              >
                {t("messages:marmot.admin")}
              </Ink>
            )}
            {actions.length > 0 && (
              <ActionMenu
                label={t("messages:marmot.memberActions", { name })}
                actions={actions}
                onSelect={(action) => {
                  if (action === "promote" && person.canPromote)
                    void update(() =>
                      marmot.changeMember(id, person.id, action),
                    );
                  if (action === "demote" && person.canDemote)
                    confirm(t("messages:marmot.demote"), () =>
                      marmot.changeMember(id, person.id, action),
                    );
                  if (
                    action === "stepDown" &&
                    person.self &&
                    details.canStepDown
                  )
                    confirm(t("messages:marmot.stepDown"), () =>
                      marmot.changeMember(id, person.id, action),
                    );
                  if (action === "remove" && person.canRemove)
                    confirm(t("messages:marmot.remove"), () =>
                      marmot.changeMember(id, person.id, action),
                    );
                }}
              >
                <View style={styles.iconTarget}>
                  <Icon name="more" size={20} />
                </View>
              </ActionMenu>
            )}
          </View>
        );
      })}
    </ListGroup>
  );

  const editMedia =
    editing &&
    details.mediaV2 &&
    details.lifecycle === "stable" &&
    !details.disbanding;
  const mediaExpandable =
    details.mediaV2 && (editing || details.mediaEndpoints.length > 0);
  const connections = (
    <>
      {details.relays.length > 0 && (
        <ListRow
          title={t("messages:marmot.relayList")}
          icon="connection"
          value={String(details.relays.length)}
          expanded={showRelays}
          onPress={() => setShowRelays(!showRelays)}
          trailing={
            <Icon
              name={showRelays ? "collapse" : "expand"}
              size={18}
              color={colors.muted}
            />
          }
        />
      )}
      {showRelays && details.relays.length > 0 && (
        <EndpointList urls={details.relays} />
      )}
      {(!editing || details.mediaV2) && (
        <ListRow
          title={t("messages:marmot.groupMediaServers")}
          icon="storage"
          detail={
            details.mediaV2
              ? undefined
              : t("messages:marmot.mediaUnavailableForChat")
          }
          value={
            details.mediaV2 ? String(details.mediaEndpoints.length) : undefined
          }
          expanded={mediaExpandable ? showMediaServers : undefined}
          onPress={
            mediaExpandable
              ? () => setShowMediaServers(!showMediaServers)
              : undefined
          }
          trailing={
            mediaExpandable ? (
              <Icon
                name={showMediaServers ? "collapse" : "expand"}
                size={18}
                color={colors.muted}
              />
            ) : undefined
          }
        />
      )}
      {mediaExpandable &&
        showMediaServers &&
        (editMedia ? (
          <GroupMediaSettings
            key={details.mediaEndpoints.join(",")}
            details={details}
            busy={busy}
            update={update}
          />
        ) : (
          <EndpointList urls={details.mediaEndpoints} />
        ))}
    </>
  );
  const warnings = [
    diagnostics?.commit === "stuck"
      ? t("messages:marmot.groupCommitUnconfirmed")
      : diagnostics?.commit || details.lifecycle === "pending_publish"
        ? t("messages:marmot.pendingCommit")
        : null,
    details.pendingLeave
      ? t(
          details.leaveBlocked
            ? "messages:marmot.leaveBlocked"
            : "messages:marmot.leavePending",
        )
      : null,
    details.lifecycle === "recovering" || details.lifecycle === "merging"
      ? t("messages:marmot.synchronizingGroup")
      : null,
    details.disbanding ? t("messages:marmot.disbanding") : null,
    details.lifecycle === "disbanded"
      ? t("messages:marmot.eventDisbanded")
      : null,
    details.membership === "removed" || details.membership === "device_removed"
      ? t("messages:marmot.noLongerMember")
      : null,
    diagnostics?.historyIncomplete
      ? t("messages:marmot.groupHistoryIncomplete")
      : null,
    details.unrecoverable ? t("messages:marmot.groupRecoveryRequired") : null,
  ].filter((value) => value !== null);
  const canRetry =
    (details.convergenceParked || diagnostics?.automaticRecoveryFailed) &&
    !details.unrecoverable;

  const rejoinOffers =
    diagnostics?.rejoinOffers.filter(
      ({ inviter }) => !privacy.isBlocked(inviter),
    ) ?? [];
  const notice = (warnings.length > 0 ||
    canRetry ||
    rejoinOffers.length > 0) && (
    <Card style={styles.notice}>
      {warnings.map((warning) => (
        <Ink key={warning} kind="caption">
          {warning}
        </Ink>
      ))}
      {rejoinOffers.map(({ welcome, inviter, token }) => (
        <View key={welcome}>
          <Ink kind="caption">
            {t("messages:marmot.rejoinOffer", {
              name: contactByKey(db, inviter).get()?.name || toNpub(inviter),
            })}
          </Ink>
          <Action
            size="sm"
            disabled={busy}
            onPress={() =>
              confirm(t("messages:marmot.confirmRejoin"), async () => {
                if (privacy.isBlocked(inviter)) return;
                await marmot.respondToRejoin(welcome, token);
                state.retry();
              })
            }
          >
            {t("messages:marmot.rejoin")}
          </Action>
          <Action
            size="sm"
            disabled={busy}
            onPress={() =>
              void update(
                () => marmot.respondToRejoin(welcome, null),
                false,
                true,
              )
            }
          >
            {t("messages:marmot.decline")}
          </Action>
        </View>
      ))}
      {canRetry && (
        <Action
          size="sm"
          disabled={busy}
          onPress={() => void update(() => marmot.retryConversation(id))}
        >
          {t("messages:marmot.retrySynchronization")}
        </Action>
      )}
    </Card>
  );
  const muteShortcut = (
    <GroupShortcut
      icon={muted ? "bellOff" : "bell"}
      label={t(muted ? "calls:unmute" : "calls:mute")}
      description={t(
        muted
          ? "messages:marmot.unmuteConversation"
          : "messages:marmot.muteConversation",
      )}
      disabled={busy}
      onPress={() => {
        if (muted) void update(() => marmot.clearChatMuted(id), false, true);
        else chooseMuteDuration([id], state.retry);
      }}
    />
  );
  const showMembershipActions = !isGroup || details.members.length > 1;
  const canLeave = details.canLeave && showMembershipActions;
  const canLeaveFromInfo = canLeave && (!isGroup || !member || canEdit);
  const leaveGroup = () =>
    confirm(
      t("messages:marmot.leave"),
      () => marmot.changeMembership(id, "leave"),
      true,
    );
  const canDeleteLocal = !member || (isGroup && !details.canDisband);
  const showActions =
    (showMembershipActions && member) ||
    canLeaveFromInfo ||
    details.canCancelLeave ||
    canDeleteLocal;
  const editedName = profileDraft.name ?? details.name;
  const editedDescription = profileDraft.description ?? details.description;
  const changedName =
    profileDraft.name !== undefined && editedName.trim() !== details.name.trim()
      ? editedName.trim()
      : null;
  const changedDescription =
    profileDraft.description !== undefined &&
    editedDescription.trim() !== details.description.trim()
      ? editedDescription.trim()
      : null;
  const canSaveProfile =
    !busy &&
    !picker.busy &&
    !!editedName.trim() &&
    (changedName !== null || changedDescription !== null);

  async function saveProfile() {
    if (!canSaveProfile) return false;
    const saved = await update(() =>
      marmot.updateGroup(id, changedName, changedDescription),
    );
    if (saved) setProfileDraft({});
    return saved;
  }

  const groupTabs: ProfileTab<"info" | "members" | "media">[] = [
    { key: "info", label: t("messages:sharedMedia.info") },
    { key: "members", label: t("messages:marmot.members") },
    { key: "media", label: t("messages:marmot.shortcutMedia") },
  ];
  const groupTabBar = (
    <ProfileTabs value={profileTab} onChange={setProfileTab} tabs={groupTabs} />
  );
  const ownGroupMember = details.members.find((person) => person.self);
  const activationKind =
    deviceActivation?.kind === "eligible" && !ownGroupMember?.admin
      ? "notAdmin"
      : deviceActivation?.kind;
  const activationDetail = (() => {
    if (deviceActivationError) return t("messages:marmot.accountError");
    switch (activationKind) {
      case "eligible":
        return t("devices:eligible");
      case "notAdmin":
        return t("devices:notAdmin");
      case "alreadyEnabled":
        return t("devices:alreadyEnabled");
      case "legacyGroup":
        return t("devices:legacyGroup");
      case "membersNeedUpdate":
        return t("devices:membersNeedUpdate");
      case "devicesNeedReplacement":
        return t("devices:devicesNeedReplacement");
      case "deviceLimitExceeded":
        return t("devices:deviceLimitExceeded");
      case "unsupported":
        return t("messages:marmot.accountError");
      default:
        return undefined;
    }
  })();
  const accountDevices = member &&
    isGroup &&
    !editing &&
    (deviceActivation || deviceActivationError) && (
      <ListGroup title={t("devices:groupSupport")}>
        <ListRow
          title={
            activationKind === "eligible" && ownGroupMember?.admin
              ? t("devices:groupEnable")
              : (activationDetail ?? t("devices:groupSupport"))
          }
          detail={
            activationKind === "eligible" && ownGroupMember?.admin
              ? t("devices:groupEnableHelp")
              : undefined
          }
          icon="connection"
          disabled={
            busy ||
            deviceControllerState.operation !== null ||
            !canReadDeviceActivation ||
            activationKind !== "eligible" ||
            !ownGroupMember?.admin
          }
          onPress={() =>
            void dialog.show({
              title: t("devices:groupEnable"),
              message: t("devices:groupEnableHelp"),
              tone: "danger",
              dismissible: false,
              actions: [
                { label: t("common:cancel"), tone: "cancel" },
                {
                  label: t("devices:groupEnable"),
                  tone: "danger",
                  onSelect: () =>
                    void update(async () => {
                      await deviceController.enableAccountDevices(id);
                      const current =
                        await deviceController.accountDevicesActivation(id);
                      if (
                        isCurrent() &&
                        !lock.getState().locked &&
                        AppState.currentState === "active"
                      )
                        setDeviceActivation(current);
                    }),
                },
              ],
            })
          }
        />
      </ListGroup>
    );
  const groupInfoContent = (callStatus?: ReactNode) => (
    <>
      {callStatus}
      {member && muteStatus && (
        <Ink kind="caption" muted style={styles.profileCaption}>
          {muteStatus}
        </Ink>
      )}
      {notice}
      {accountDevices}
      <ListGroup title={t("messages:marmot.groupInformation")}>
        {details.createdAt ? (
          <ListRow
            title={t("messages:marmot.createdAt", {
              date: new Date(details.createdAt * 1_000).toLocaleDateString(),
            })}
          />
        ) : null}
        {connections}
      </ListGroup>
      {showActions && (
        <ListGroup title={t("messages:marmot.conversationActions")}>
          {member && showMembershipActions && (
            <ListRow
              title={t(
                details.archived
                  ? "messages:marmot.unarchiveConversation"
                  : "messages:marmot.archiveConversation",
              )}
              disabled={busy}
              onPress={() =>
                void update(
                  () => marmot.setArchived(id, !details.archived),
                  false,
                  true,
                )
              }
            />
          )}
          {details.canCancelLeave && (
            <ListRow
              title={t("messages:marmot.cancelLeave")}
              disabled={busy}
              onPress={() =>
                void update(() => marmot.changeMembership(id, "cancelLeave"))
              }
            />
          )}
          {canLeaveFromInfo && (
            <ListRow
              title={t("messages:marmot.leave")}
              disabled={busy}
              onPress={leaveGroup}
            />
          )}
          {canDeleteLocal && (
            <ListRow
              title={t("messages:marmot.forgetGroup")}
              disabled={busy || details.disbanding}
              onPress={() =>
                confirm(
                  t("messages:marmot.forgetGroup"),
                  async () => {
                    await state.window?.close();
                    try {
                      await marmot.changeMembership(id, "deleteLocal");
                    } catch (error) {
                      state.retry();
                      throw error;
                    }
                    if (isCurrent()) {
                      chatPreferences.clearGroupCreation(id);
                      if (!lock.getState().locked) router.dismissTo("/");
                    }
                  },
                  false,
                  t("messages:marmot.deleteLocalGroupConfirmation"),
                )
              }
            />
          )}
        </ListGroup>
      )}
    </>
  );

  function renderGroupProfile(shortcut?: ReactNode, status?: ReactNode) {
    const actions = member && (
      <GroupShortcuts>
        {shortcut}
        {muteShortcut}
        {editProfile ? (
          <GroupShortcut
            icon="edit"
            label={t("messages:marmot.shortcutEdit")}
            description={editTitle}
            disabled={busy}
            onPress={editProfile}
          />
        ) : (
          <GroupShortcut
            icon="leave"
            label={t("messages:marmot.shortcutLeave")}
            description={t("messages:marmot.leave")}
            disabled={busy || !canLeave}
            onPress={leaveGroup}
          />
        )}
      </GroupShortcuts>
    );
    function overview(tab: typeof profileTab) {
      return (
        <View style={styles.groupOverview}>
          {profileHeader(profileTab === tab, false)}
          {actions}
        </View>
      );
    }

    return (
      <View style={styles.groupStack}>
        <View
          pointerEvents={profileTab === "info" ? "auto" : "none"}
          accessibilityElementsHidden={profileTab !== "info"}
          importantForAccessibility={
            profileTab === "info" ? "auto" : "no-hide-descendants"
          }
          style={[
            styles.groupPage,
            profileTab !== "info" && styles.groupPageHidden,
          ]}
        >
          <ScrollView
            style={styles.groupProfileScroll}
            contentContainerStyle={styles.groupProfileBody}
            stickyHeaderIndices={[1]}
            keyboardShouldPersistTaps="handled"
          >
            {overview("info")}
            {groupTabBar}
            {groupInfoContent(status)}
          </ScrollView>
        </View>
        <View
          pointerEvents={profileTab === "members" ? "auto" : "none"}
          accessibilityElementsHidden={profileTab !== "members"}
          importantForAccessibility={
            profileTab === "members" ? "auto" : "no-hide-descendants"
          }
          style={[
            styles.groupPage,
            profileTab !== "members" && styles.groupPageHidden,
          ]}
        >
          <ScrollView
            style={styles.groupProfileScroll}
            contentContainerStyle={styles.groupProfileBody}
            stickyHeaderIndices={[1]}
            keyboardShouldPersistTaps="handled"
          >
            {overview("members")}
            {groupTabBar}
            {roster}
          </ScrollView>
        </View>
        <View
          pointerEvents={profileTab === "media" ? "auto" : "none"}
          accessibilityElementsHidden={profileTab !== "media"}
          importantForAccessibility={
            profileTab === "media" ? "auto" : "no-hide-descendants"
          }
          style={[
            styles.groupPage,
            profileTab !== "media" && styles.groupPageHidden,
          ]}
        >
          <SharedMediaLibrary
            scope={{ kind: "group", group: id }}
            header={
              <View style={styles.groupMediaHeader}>{overview("media")}</View>
            }
            tabs={groupTabBar}
            scrollPositionRef={sharedMediaScrollPosition}
            active={profileTab === "media"}
          />
        </View>
      </View>
    );
  }

  return (
    <Screen
      topInset
      scroll={editing || !isGroup}
      navigationHeader={
        editing ? (
          <ScreenHeader
            title={title}
            onBack={back}
            action={
              isGroup ? (
                <SaveButton
                  size="sm"
                  disabled={!canSaveProfile}
                  label={t("messages:marmot.save")}
                  onSave={saveProfile}
                />
              ) : undefined
            }
          />
        ) : isGroup ? (
          <View style={styles.groupNavigation}>
            <GlassBackButton
              onPress={back}
              style={styles.profileBack}
              elevation={morph ? "none" : undefined}
              dimOnPress={!morph}
            />
          </View>
        ) : morph ? (
          <ChatProfileBackButton onPress={back} />
        ) : undefined
      }
    >
      {editing ? (
        <>
          {isGroup && (
            <ListGroup>
              <View style={styles.profileFields}>
                <View style={styles.editorIdentity}>
                  <EditableAvatar
                    showLabel
                    disabled={busy || picker.busy}
                    onPick={(source) => void picker.pick(source)}
                    onRemove={
                      details.image
                        ? () =>
                            confirm(t("settings:photoRemove"), () =>
                              marmot.updateGroupImage(id, null),
                            )
                        : undefined
                    }
                  >
                    <GlassAvatar
                      identityKey={peer?.id ?? id}
                      name={editedName || groupName}
                      src={imageUri}
                      size="lg"
                    />
                  </EditableAvatar>
                  <View style={styles.grow}>
                    <GlassInput
                      label={t("messages:marmot.groupName")}
                      value={editedName}
                      onChangeText={(name) =>
                        setProfileDraft((draft) => ({ ...draft, name }))
                      }
                      maxLength={128}
                      editable={!busy}
                    />
                  </View>
                </View>
                {picker.busy && (
                  <Ink kind="caption" muted accessibilityLiveRegion="polite">
                    {t("settings:photoProcessing")}
                  </Ink>
                )}
                {picker.error && (
                  <Ink kind="caption" accessibilityRole="alert">
                    {picker.error}
                  </Ink>
                )}
              </View>
              <View style={styles.profileFields}>
                <GlassInput
                  label={t("messages:marmot.groupDescription")}
                  value={editedDescription}
                  onChangeText={(description) =>
                    setProfileDraft((draft) => ({ ...draft, description }))
                  }
                  multiline
                  maxLength={512}
                  editable={!busy}
                />
              </View>
            </ListGroup>
          )}
          {notice}
          {isGroup && (
            <ListGroup>
              <ListRow
                title={t("messages:marmot.manageMembers")}
                icon="person"
                value={String(details.members.length)}
                expanded={showMembers}
                onPress={() => setShowMembers((value) => !value)}
                trailing={
                  <Icon
                    name={showMembers ? "collapse" : "expand"}
                    size={18}
                    color={colors.muted}
                  />
                }
              />
            </ListGroup>
          )}
          {isGroup && showMembers && roster}
          {(details.relays.length > 0 || details.mediaV2) && (
            <ListGroup title={t("messages:marmot.groupConnections")}>
              {connections}
            </ListGroup>
          )}
          {details.canEnableDisbanding && (
            <ListGroup title={t("messages:marmot.groupLifecycle")}>
              <ListRow
                title={t("messages:marmot.enableDisbanding")}
                disabled={busy}
                onPress={() =>
                  confirm(t("messages:marmot.enableDisbanding"), () =>
                    marmot.changeMembership(id, "enableDisbanding"),
                  )
                }
              />
            </ListGroup>
          )}
          {details.canDisband && (
            <Action
              variant="ghost"
              size="lg"
              disabled={busy}
              style={[
                styles.deleteGroupButton,
                { backgroundColor: colors.danger },
              ]}
              onPress={deleteSharedGroup}
            >
              <Ink kind="label" style={{ color: colors.onDanger }}>
                {t("messages:marmot.disband")}
              </Ink>
            </Action>
          )}
        </>
      ) : isGroup ? (
        member ? (
          <MarmotActiveCall
            group={id}
            members={details.members}
            canStart={
              details.lifecycle === "stable" &&
              !details.pendingLeave &&
              !details.disbanding
            }
            profile={({ shortcut, status }) =>
              renderGroupProfile(shortcut, status)
            }
          />
        ) : (
          renderGroupProfile()
        )
      ) : (
        <>
          {profileHeader(true)}
          {member && (
            <GroupShortcuts>
              <GroupShortcut
                icon="media"
                label={t("messages:marmot.shortcutMedia")}
                description={t("messages:marmot.mediaAndFiles")}
                onPress={() =>
                  router.push({
                    pathname: "/shared-media",
                    params: { group: id, scope: "direct" },
                  })
                }
              />
              {muteShortcut}
            </GroupShortcuts>
          )}
          {member && muteStatus && (
            <Ink kind="caption" muted style={styles.profileCaption}>
              {muteStatus}
            </Ink>
          )}
          {isGroup && roster}
          {notice}
          <ListGroup
            title={isGroup ? t("messages:marmot.groupInformation") : undefined}
          >
            {details.createdAt ? (
              <ListRow
                title={t("messages:marmot.createdAt", {
                  date: new Date(
                    details.createdAt * 1_000,
                  ).toLocaleDateString(),
                })}
              />
            ) : null}
            {connections}
          </ListGroup>
          {showActions && (
            <ListGroup title={t("messages:marmot.conversationActions")}>
              {member && showMembershipActions && (
                <ListRow
                  title={t(
                    details.archived
                      ? "messages:marmot.unarchiveConversation"
                      : "messages:marmot.archiveConversation",
                  )}
                  disabled={busy}
                  onPress={() =>
                    void update(
                      () => marmot.setArchived(id, !details.archived),
                      false,
                      true,
                    )
                  }
                />
              )}
              {details.canCancelLeave && (
                <ListRow
                  title={t("messages:marmot.cancelLeave")}
                  disabled={busy}
                  onPress={() =>
                    void update(() =>
                      marmot.changeMembership(id, "cancelLeave"),
                    )
                  }
                />
              )}
              {canLeave && (
                <ListRow
                  title={t("messages:marmot.leave")}
                  disabled={busy}
                  onPress={leaveGroup}
                />
              )}
              {canDeleteLocal && (
                <ListRow
                  title={t("messages:marmot.forgetGroup")}
                  disabled={busy || details.disbanding}
                  onPress={() =>
                    confirm(
                      t("messages:marmot.forgetGroup"),
                      async () => {
                        await state.window?.close();
                        try {
                          await marmot.changeMembership(id, "deleteLocal");
                        } catch (error) {
                          state.retry();
                          throw error;
                        }
                        if (isCurrent()) {
                          chatPreferences.clearGroupCreation(id);
                          if (!lock.getState().locked) router.dismissTo("/");
                        }
                      },
                      false,
                      t("messages:marmot.deleteLocalGroupConfirmation"),
                    )
                  }
                />
              )}
            </ListGroup>
          )}
        </>
      )}
    </Screen>
  );
}

function GroupMemberIdentity({
  publicKey,
  displayName,
}: {
  publicKey: string;
  displayName?: string | null;
}) {
  const { t } = useTranslation(namespaces);
  const name = usePresentedName(publicKey, displayName);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={t("contacts:openProfile", { name })}
      style={styles.memberIdentity}
      onPress={() =>
        router.push({ pathname: "/person/[key]", params: { key: publicKey } })
      }
    >
      <Avatar publicKey={publicKey} name={name} size="md" />
      <Ink kind="label" numberOfLines={1} style={styles.grow}>
        {name}
      </Ink>
    </Pressable>
  );
}

function GroupProfileHeader({
  morph,
  name,
  avatar,
  count,
  description,
  back,
  edit,
  editTitle,
}: {
  morph?: string;
  name?: string;
  avatar?: ReactNode;
  count?: number;
  description?: string;
  back?: () => void;
  edit?: () => void;
  editTitle?: string;
}) {
  const { t } = useTranslation(namespaces);
  return (
    <View style={styles.profileHeader}>
      <View style={styles.profileAvatar}>
        {back && <GlassBackButton onPress={back} style={styles.profileBack} />}
        <ProfileElement profile={morph} part="avatar">
          {avatar}
        </ProfileElement>
        {edit && <GroupProfileEditButton onPress={edit} label={editTitle} />}
      </View>
      {name && (
        <ProfileElement
          profile={morph}
          part="name"
          style={styles.profileNameSlot}
        >
          <Ink
            kind="heading"
            accessibilityRole="header"
            style={styles.profileName}
            numberOfLines={3}
          >
            {name}
          </Ink>
        </ProfileElement>
      )}
      {count !== undefined && (
        <Ink kind="caption" muted style={styles.profileCaption}>
          {t("messages:marmot.memberCount", { count })}
        </Ink>
      )}
      {description ? (
        <Ink muted style={styles.description}>
          {description}
        </Ink>
      ) : null}
    </View>
  );
}

function GroupProfileEditButton({
  onPress,
  label,
}: {
  onPress: () => void;
  label?: string;
}) {
  const { colors } = useTheme();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={() => {
        tapFeedback();
        onPress();
      }}
      style={[
        styles.iconTarget,
        styles.profileEdit,
        { backgroundColor: colors.selected },
      ]}
    >
      <Icon name="edit" size={20} />
    </Pressable>
  );
}

function EndpointList({ urls }: { urls: string[] }) {
  return (
    <View style={styles.endpoints}>
      {urls.map((url) => (
        <Ink key={url} kind="caption" muted style={styles.endpoint}>
          {url}
        </Ink>
      ))}
    </View>
  );
}
function GroupMediaSettings({
  details,
  busy,
  update,
}: {
  details: MarmotGroupDetails;
  busy: boolean;
  update: (
    task: () => Promise<void | MarmotGroupDisposition | null>,
  ) => Promise<boolean>;
}) {
  const { t } = useTranslation(namespaces);
  const [entry, setEntry] = useState(details.mediaEndpoints.join("\n"));
  const origins = entry
    .split(/[\s,]+/u)
    .filter(Boolean)
    .map(blossomServer);
  const valid =
    origins.length <= 8 &&
    origins.every((origin): origin is string => origin !== null);
  return (
    <View style={styles.form}>
      <GlassInput
        label={t("messages:marmot.blossomOrigins")}
        value={entry}
        onChangeText={setEntry}
        autoCapitalize="none"
        multiline
      />
      <SaveButton
        size="sm"
        disabled={busy || !valid || entry === details.mediaEndpoints.join("\n")}
        label={t("messages:marmot.save")}
        onSave={() =>
          valid &&
          update(() =>
            marmot.updateGroupMedia(details.id, [...new Set(origins)]),
          )
        }
      />
    </View>
  );
}

function InviteMemberField({
  busy,
  invite,
}: {
  busy: boolean;
  invite: (addresses: string) => void;
}) {
  const { t } = useTranslation(namespaces);
  const { identity, privacy } = useLocal();
  const focused = useIsFocused();
  const [addresses, setAddresses] = useState("");
  const last = addresses.split(/[\s,]+/u).at(-1) ?? "";
  const { exactKey, current } = useDirectorySearch(last, focused && !busy);
  const parsed = resolveAddresses(addresses, identity.publicKey);
  const suggestions = (
    exactKey && !parsePublicKey(last) ? [exactKey] : (current?.keys ?? [])
  )
    .filter((key) => key !== identity.publicKey && !privacy.isBlocked(key))
    .slice(0, 5);
  return (
    <>
      <GlassInput
        label={t("messages:marmot.addresses")}
        value={addresses}
        onChangeText={setAddresses}
        multiline
        autoCapitalize="none"
      />
      {suggestions.map((key) => (
        <GroupInviteeRow
          key={key}
          publicKey={key}
          selected={false}
          onToggle={() =>
            setAddresses(
              (value) =>
                value.slice(0, value.length - last.length) + key + "\n",
            )
          }
        />
      ))}
      <Action
        disabled={busy || !parsed?.length}
        onPress={() => invite(addresses)}
      >
        {t("messages:marmot.invite")}
      </Action>
    </>
  );
}

const styles = StyleSheet.create({
  groupStack: { flex: 1 },
  grow: { flex: 1, minWidth: 0, gap: 3 },
  groupPage: {
    position: "absolute",
    top: 0,
    start: 0,
    end: 0,
    bottom: 0,
    zIndex: 1,
  },
  groupPageHidden: { opacity: 0, zIndex: 0 },
  groupNavigation: {
    marginHorizontal: space.lg,
    height: 44,
  },
  groupMediaHeader: { paddingHorizontal: space.lg, paddingBottom: space.lg },
  groupOverview: { gap: space.lg },
  groupProfileScroll: { flex: 1 },
  groupProfileBody: {
    gap: space.lg,
    paddingHorizontal: space.lg,
    paddingBottom: space.xxl,
  },
  profileHeader: { alignItems: "center", gap: space.xs },
  profileAvatar: {
    alignSelf: "stretch",
    minHeight: 80,
    alignItems: "center",
    justifyContent: "center",
  },
  profileBack: { position: "absolute", top: 0, start: 0 },
  profileEdit: { position: "absolute", top: 0, end: 0, borderRadius: 22 },
  profileNameSlot: { maxWidth: "100%" },
  profileName: {
    fontSize: 25,
    letterSpacing: -0.55,
    textAlign: "center",
    marginTop: space.xs,
  },
  profileCaption: { textAlign: "center" },
  description: {
    textAlign: "center",
    marginTop: space.xs,
    paddingHorizontal: space.md,
  },
  photoBadge: {
    position: "absolute",
    end: 0,
    bottom: 0,
    width: 26,
    height: 26,
    borderRadius: 13,
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 2,
  },
  rosterRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.md,
    minHeight: 54,
    paddingHorizontal: space.md,
    paddingVertical: space.xs,
  },
  deleteGroupButton: {
    alignSelf: "stretch",
    borderRadius: 28,
    marginTop: space.sm,
  },
  memberIdentity: {
    flex: 1,
    minWidth: 0,
    flexDirection: "row",
    alignItems: "center",
    gap: space.md,
  },
  role: {
    fontWeight: "600",
    borderRadius: 12,
    paddingHorizontal: space.sm,
    paddingVertical: 2,
  },
  iconTarget: {
    width: 44,
    height: 44,
    alignItems: "center",
    justifyContent: "center",
  },
  notice: { padding: space.md, gap: space.xs },
  form: { padding: space.lg, gap: space.md },
  profileFields: { padding: space.lg, gap: space.sm },
  editorIdentity: { flexDirection: "row", alignItems: "center", gap: space.md },
  endpoints: {
    gap: space.xs,
    paddingHorizontal: space.lg,
    paddingVertical: space.sm,
  },
  endpoint: { writingDirection: "ltr" },
});
