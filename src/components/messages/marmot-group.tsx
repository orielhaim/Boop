import { router, Stack, useIsFocused, usePreventRemove } from "expo-router";
import type { File } from "expo-file-system";
import { asc } from "drizzle-orm";
import {
  type ReactNode,
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { useTranslation } from "react-i18next";
import {
  Alert,
  AppState,
  FlatList,
  Pressable,
  ScrollView,
  StyleSheet,
  View,
} from "react-native";
import { EditableAvatar } from "@/components/avatars/editable-avatar";
import { usePerson } from "@/components/people/use-person";
import { PersonAvatar } from "@/components/people/person-avatar";
import { AvatarCropScreen, useAvatarPicker } from "@/components/avatars/picker";
import { GlassInput } from "@/components/glassyui/glass-input";
import { GlassAvatar } from "@/components/glassyui/glass-avatar";
import { SettingsGroup, SettingsRow } from "@/components/settings/group";
import { ActionMenu } from "@/components/ui/action-menu";
import { backButtonSize, GlassBackButton } from "@/components/ui/back-button";
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

import { parsePublicKey, toNpub } from "@/core/identity/keys";
import { blossomServer } from "@/core/media/blossom";
import {
  marmot,
  type MarmotGroupDetails,
  type MarmotMemberOutcome,
} from "@/core/marmot/native";
import { contactByKey } from "@/db/queries";
import { contacts } from "@/db/schema";
import { namespaces } from "@/i18n";
import { useLocal } from "@/services/local-context";
import { space, useTheme } from "@/theme";
import { conversationRoute } from "./marmot-inbox";
import { groupPreview, loadGroupDetails } from "./group-details-cache";
import { marmotErrorCode, useMarmotWindow } from "./marmot-window";
import {
  GroupShortcut,
  GroupShortcuts,
  MarmotActiveCall,
} from "./marmot-active-call";
import { useMarmotGroupAvatar } from "./use-marmot-group-avatar";

export function useMarmotError() {
  const { t } = useTranslation(namespaces);
  return (error: unknown) => {
    const code = marmotErrorCode(error);
    if (code === "GroupCommitPending")
      return t("messages:marmot.pendingCommit");
    if (code === "NoUsableRelay" || code === "Publish")
      return t("messages:marmot.relayError");
    if (code === "IdentityMismatch" || code === "SecretNotFound")
      return t("messages:marmot.identityMismatch");
    if (code === "GroupRemoved" || code === "AccountSignedOut")
      return t("messages:marmot.noLongerMember");
    if (code === "GroupInviteNotPending")
      return t("messages:marmot.inviteGone");
    if (code === "MissingMemberInboxRoute")
      return t("messages:marmot.missingInboxRoute");
    if (code === "DirectoryLookupIncomplete")
      return t("messages:marmot.temporarilyUnavailable");
    if (code === "MediaNotConfigured")
      return t("messages:marmot.mediaUnavailableForChat");
    if (
      code === "MediaAttachmentRejected" ||
      code === "MediaUnfetchable" ||
      code === "MediaUnavailable"
    )
      return t("messages:marmot.mediaReferenceUnavailable");
    if (code.includes("KeyPackage")) return t("messages:marmot.missingPackage");
    return t("messages:marmot.operationError");
  };
}

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

function InviteeAvailability({ keys }: { keys: string[] }) {
  const { t } = useTranslation(namespaces);
  const { db, marmotSession, privacy, lock } = useLocal();
  const focused = useIsFocused();
  const locked = useSyncExternalStore(
    lock.subscribe,
    () => lock.getState().locked,
  );
  const [foreground, setForeground] = useState(
    AppState.currentState === "active",
  );
  useEffect(() => {
    const listener = AppState.addEventListener("change", (state) =>
      setForeground(state === "active"),
    );
    return () => listener.remove();
  }, []);
  const privacyRevision = useSyncExternalStore(
    privacy.subscribe,
    privacy.revision,
  );
  const translateError = useMarmotError();
  const roster = keys.slice().sort().join(" ");
  const [results, setResults] = useState(
    new Map<string, { error?: unknown }>(),
  );
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (!focused || !foreground || locked || !roster) return;
    let active = true;
    const timer = setTimeout(() => {
      setResults(new Map());
      void (async () => {
        for (const key of roster.split(" ")) {
          if (!active || AppState.currentState !== "active") break;
          if (privacy.isBlocked(key)) continue;
          let result: { error?: unknown } = {};
          try {
            await marmotSession.ready();
            if (
              !active ||
              AppState.currentState !== "active" ||
              lock.getState().locked
            )
              break;
            if (privacy.isBlocked(key)) continue;
            await marmot.checkInvitee(key);
          } catch (error) {
            result = { error };
          }
          if (active)
            setResults((current) => new Map(current).set(key, result));
        }
      })();
    }, 350);
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [
    attempt,
    focused,
    foreground,
    locked,
    lock,
    marmotSession,
    privacy,
    privacyRevision,
    roster,
  ]);
  if (!keys.length) return null;
  return (
    <View style={styles.member}>
      {keys.map((key) => {
        const result = results.get(key);
        const name = contactByKey(db, key).get()?.name ?? toNpub(key);
        const status = privacy.isBlocked(key)
          ? t("messages:marmot.blocked")
          : !result
            ? t("common:checking")
            : result.error
              ? translateError(result.error)
              : t("messages:marmot.inviteeAvailable");
        return (
          <Ink key={key}>
            {name} · {status}
          </Ink>
        );
      })}
      {keys.some((key) => results.get(key)?.error) && (
        <Action size="sm" onPress={() => setAttempt((value) => value + 1)}>
          {t("messages:marmot.checkAgain")}
        </Action>
      )}
    </View>
  );
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
  const { db, identity, marmotSession, privacy, mediaSdk } = useLocal();
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
  const selecting = step === "people" && eligible.length > 0;
  const canReturnToPeople = !selecting && eligible.length > 0;
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
    if (busy) return;
    if (canReturnToPeople) setStep("people");
    else if (router.canGoBack()) router.back();
    else router.replace("/");
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
      const openGroup = () => {
        setStatus("created");
        disablePrevention();
        router.replace(conversationRoute(group));
      };
      if (unavailable) {
        Alert.alert(t("messages:marmot.unavailableMembers"), unavailable, [
          { text: t("common:done"), onPress: openGroup },
        ]);
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
          {!busy && <GlassBackButton onPress={back} elevation="none" />}
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
            data={eligible}
            keyExtractor={({ publicKey }) => publicKey}
            contentContainerStyle={groupSetupStyles.people}
            renderItem={({ item: { publicKey } }) => (
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
              onPress={() => {
                tapFeedback();
                setError("");
                setStep("details");
              }}
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
                    { backgroundColor: colors.accentSoft },
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
          <InviteeAvailability keys={selected} />
          {error ? <Ink accessibilityLiveRegion="polite">{error}</Ink> : null}
          <Action
            disabled={busy || picker.busy || !name.trim()}
            variant="prominent"
            onPress={() => void create()}
          >
            {t(
              busy ? "messages:marmot.creatingGroup" : "messages:marmot.create",
            )}
          </Action>
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
        (selected || pressed) && { backgroundColor: colors.accentSoft },
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
}: {
  id: string;
  editing?: boolean;
}) {
  const { t } = useTranslation(namespaces);
  const { colors } = useTheme();
  const { db, identity, marmotSession, privacy } = useLocal();
  const translateError = useMarmotError();
  const [initial] = useState(() => groupPreview(marmotSession, id));
  const [details, setDetails] = useState(initial?.details);
  const [error, setError] = useState(false);
  const [busy, setBusy] = useState(false);
  const [loadedPhoto, setLoadedPhoto] = useState<{
    hash: string;
    uri: string;
  }>();
  const [showRelays, setShowRelays] = useState(false);
  const [showMediaServers, setShowMediaServers] = useState(false);
  const [showMembers, setShowMembers] = useState(false);
  const [showInvite, setShowInvite] = useState(false);
  const [profileDraft, setProfileDraft] = useState<{
    name?: string;
    description?: string;
  }>({});
  const picker = useAvatarPicker();
  const watch = useCallback(() => marmot.openGroupState(id), [id]);
  const state = useMarmotWindow(watch);
  const { generation, sequence } = state.snapshot ?? {};
  const load = useCallback(
    () => loadGroupDetails(marmotSession, id),
    [id, marmotSession],
  );
  useSyncExternalStore(privacy.subscribe, privacy.revision);

  useEffect(() => {
    if (generation === undefined || sequence === undefined) return;
    let live = true;
    void load().then(
      (data) => {
        if (!live) return;
        setDetails(data);
        setError(false);
      },
      () => {
        if (live) setError(true);
      },
    );
    return () => {
      live = false;
    };
  }, [generation, load, sequence]);

  const member = details?.membership === "member" && !details.pendingInvitation;
  const canEdit = Boolean(
    member && details?.canEdit && generation !== undefined,
  );
  const isGroup = details?.kind !== "direct";
  const photo =
    member && privacy.photoPolicy() !== "nobody" ? details?.image : undefined;
  const cachedPhoto = useMarmotGroupAvatar(id, photo);
  const imageUri =
    photo && loadedPhoto?.hash === photo
      ? loadedPhoto.uri
      : (cachedPhoto ??
        (photo && initial?.photo?.hash === photo
          ? initial.photo.uri
          : undefined));
  const editTitle = t(
    isGroup ? "messages:marmot.editGroup" : "messages:marmot.editConversation",
  );
  const back = () =>
    router.canGoBack() ? router.back() : router.replace(conversationRoute(id));

  async function update(task: () => Promise<void>, leave = false) {
    if (busy) return false;
    setBusy(true);
    try {
      await task();
      if (leave) router.back();
      else setDetails(await load());
      return true;
    } catch (reason) {
      Alert.alert(translateError(reason));
      return false;
    } finally {
      setBusy(false);
    }
  }

  function confirm(title: string, task: () => Promise<void>, leave = false) {
    Alert.alert(title, undefined, [
      { text: t("common:cancel"), style: "cancel" },
      {
        text: title,
        style: "destructive",
        onPress: () => void update(task, leave),
      },
    ]);
  }

  async function loadImage() {
    if (!photo || busy) return;
    setBusy(true);
    try {
      const path = await marmot.groupImage(id, photo, true);
      if (path && privacy.photoPolicy() !== "nobody")
        setLoadedPhoto({ hash: photo, uri: `file://${path}` });
    } catch (reason) {
      Alert.alert(translateError(reason));
    } finally {
      setBusy(false);
    }
  }

  if (editing && canEdit && picker.image)
    return (
      <>
        <Stack.Screen
          options={{
            headerShown: true,
            title: t("settings:photoChange"),
            headerRight: undefined,
          }}
        />
        <AvatarCropScreen
          source={picker.image}
          onCancel={picker.clear}
          onSave={(file) => {
            picker.clear();
            void update(async () => {
              try {
                await marmot.updateGroupImage(id, imagePath(file));
              } finally {
                cleanImage(file);
              }
            });
          }}
        />
      </>
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

  if (
    error ||
    state.error ||
    !details ||
    details.pendingInvitation ||
    (editing && !canEdit)
  )
    return (
      <Screen topInset={!editing && !details?.pendingInvitation}>
        <Stack.Screen
          options={{
            headerShown: editing || !!details?.pendingInvitation,
            title: editing || details?.pendingInvitation ? title : "",
          }}
        />
        {!editing && !details?.pendingInvitation && (
          <GroupProfileHeader
            name={initial?.title ?? details?.name}
            avatar={
              initial?.title ? (
                <GlassAvatar
                  name={initial.title}
                  size="xl"
                  src={
                    !details && privacy.photoPolicy() !== "nobody"
                      ? initial.photo?.uri
                      : imageUri
                  }
                />
              ) : undefined
            }
            back={back}
          />
        )}
        {error || state.error ? (
          <Empty
            detail=""
            icon="chat"
            title={t("messages:marmot.accountError")}
          >
            <Action onPress={state.retry}>{t("common:retry")}</Action>
          </Empty>
        ) : !details ||
          generation === undefined ? null : details.pendingInvitation ? (
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

  const peer = isGroup
    ? undefined
    : details.members.find((person) => !person.self);
  const groupName = peer
    ? contactByKey(db, peer.id).get()?.name || peer.name || peer.npub
    : details.name || t("messages:marmot.group");
  const avatar = <GlassAvatar name={groupName} src={imageUri} size="xl" />;
  const roster = (
    <SettingsGroup title={t("messages:marmot.members")}>
      {editing && details.canInvite && (
        <SettingsRow
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
                Alert.alert(t("contacts:invalidAddress"));
                return;
              }
              void update(async () => {
                const unavailable = failureList(
                  await marmot.inviteMembers(id, keys),
                  t,
                );
                if (unavailable)
                  Alert.alert(
                    t("messages:marmot.unavailableMembers"),
                    unavailable,
                  );
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
            <GroupMemberIdentity publicKey={person.id} />
            {person.admin && (
              <Ink
                kind="caption"
                style={[
                  styles.role,
                  { backgroundColor: colors.accentSoft, color: colors.accent },
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
    </SettingsGroup>
  );

  const warnings = [
    details.commit ? t("messages:marmot.pendingCommit") : null,
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
    details.lifecycle === "disbanded"
      ? t("messages:marmot.eventDisbanded")
      : null,
    details.membership === "removed" || details.membership === "device_removed"
      ? t("messages:marmot.noLongerMember")
      : null,
    details.relayChangesOutstanding > 0
      ? t("messages:marmot.groupRelayPending")
      : null,
    details.historyIncomplete
      ? t("messages:marmot.groupHistoryIncomplete")
      : null,
    details.unrecoverable ? t("messages:marmot.groupRecoveryRequired") : null,
  ].filter((value) => value !== null);
  const canRetry = details.convergenceParked && !details.unrecoverable;

  const notice = (warnings.length > 0 || canRetry) && (
    <Card style={styles.notice}>
      {warnings.map((warning) => (
        <Ink key={warning} kind="caption">
          {warning}
        </Ink>
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
  const shortcuts = (
    <>
      <GroupShortcut
        icon="media"
        label={t("messages:marmot.shortcutMedia")}
        description={t("messages:marmot.mediaAndFiles")}
        onPress={() => router.push(conversationRoute(id, "media"))}
      />
      <GroupShortcut
        icon={details.muted ? "bellOff" : "bell"}
        label={t(details.muted ? "calls:unmute" : "calls:mute")}
        description={t(
          details.muted
            ? "messages:marmot.unmuteConversation"
            : "messages:marmot.muteConversation",
        )}
        disabled={busy}
        onPress={() => void update(() => marmot.setMuted(id, !details.muted))}
      />
    </>
  );
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

  function saveProfile() {
    if (!canSaveProfile) return;
    void update(() =>
      marmot.updateGroup(id, changedName, changedDescription),
    ).then((saved) => {
      if (saved) setProfileDraft({});
    });
  }

  return (
    <Screen topInset={!editing}>
      <Stack.Screen
        options={{
          headerShown: editing,
          title: editing ? title : "",
          headerShadowVisible: false,
          headerRight:
            editing && isGroup
              ? () => (
                  <Action
                    size="sm"
                    disabled={!canSaveProfile}
                    onPress={saveProfile}
                  >
                    {t("messages:marmot.save")}
                  </Action>
                )
              : undefined,
        }}
      />
      {editing ? (
        <>
          {isGroup && (
            <SettingsGroup>
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
            </SettingsGroup>
          )}
          {notice}
          {isGroup && (
            <SettingsGroup>
              <SettingsRow
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
            </SettingsGroup>
          )}
          {isGroup && showMembers && roster}
          {(details.relays.length > 0 || details.mediaV2) && (
            <SettingsGroup title={t("messages:marmot.groupConnections")}>
              {details.relays.length > 0 && (
                <SettingsRow
                  title={t("messages:marmot.relayList")}
                  icon="connection"
                  value={String(details.relays.length)}
                  expanded={showRelays}
                  onPress={() => setShowRelays((value) => !value)}
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
              {details.mediaV2 && (
                <SettingsRow
                  title={t("messages:marmot.groupMediaServers")}
                  icon="storage"
                  value={String(details.mediaEndpoints.length)}
                  expanded={showMediaServers}
                  onPress={() => setShowMediaServers((value) => !value)}
                  trailing={
                    <Icon
                      name={showMediaServers ? "collapse" : "expand"}
                      size={18}
                      color={colors.muted}
                    />
                  }
                />
              )}
              {details.mediaV2 &&
                showMediaServers &&
                (details.lifecycle === "stable" ? (
                  <GroupMediaSettings
                    key={details.mediaEndpoints.join(",")}
                    details={details}
                    busy={busy}
                    update={update}
                  />
                ) : (
                  <EndpointList urls={details.mediaEndpoints} />
                ))}
            </SettingsGroup>
          )}
          {(details.canEnableDisbanding || details.canDisband) && (
            <SettingsGroup title={t("messages:marmot.groupLifecycle")}>
              {details.canEnableDisbanding && (
                <SettingsRow
                  title={t("messages:marmot.enableDisbanding")}
                  disabled={busy}
                  onPress={() =>
                    confirm(t("messages:marmot.enableDisbanding"), () =>
                      marmot.changeMembership(id, "enableDisbanding"),
                    )
                  }
                />
              )}
              {details.canDisband && (
                <SettingsRow
                  title={t("messages:marmot.disband")}
                  disabled={busy}
                  onPress={() =>
                    confirm(
                      t("messages:marmot.disband"),
                      () => marmot.changeMembership(id, "disband"),
                      true,
                    )
                  }
                />
              )}
            </SettingsGroup>
          )}
        </>
      ) : (
        <>
          <GroupProfileHeader
            name={groupName}
            count={isGroup ? details.members.length : undefined}
            description={details.description}
            back={back}
            edit={
              canEdit
                ? () => router.push(conversationRoute(id, "edit"))
                : undefined
            }
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
              ) : photo && !imageUri ? (
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={t("messages:marmot.viewGroupPhoto")}
                  disabled={busy}
                  onPress={() => void loadImage()}
                >
                  {avatar}
                  <View
                    style={[
                      styles.photoBadge,
                      {
                        backgroundColor: colors.accentSoft,
                        borderColor: colors.background,
                      },
                    ]}
                  >
                    <Icon name="download" size={14} />
                  </View>
                </Pressable>
              ) : (
                avatar
              )
            }
          />
          {member &&
            (isGroup ? (
              <MarmotActiveCall
                group={id}
                canStart={details.lifecycle === "stable"}
                members={details.members}
                profileActions={shortcuts}
              />
            ) : (
              <GroupShortcuts>{shortcuts}</GroupShortcuts>
            ))}
          {isGroup && roster}
          {notice}
          <SettingsGroup
            title={isGroup ? t("messages:marmot.groupInformation") : undefined}
          >
            {details.createdAt ? (
              <SettingsRow
                title={t("messages:marmot.createdAt", {
                  date: new Date(
                    details.createdAt * 1_000,
                  ).toLocaleDateString(),
                })}
              />
            ) : null}
            {details.relays.length > 0 && (
              <SettingsRow
                icon="connection"
                title={t("messages:marmot.relayList")}
                value={String(details.relays.length)}
                expanded={showRelays}
                trailing={
                  <Icon
                    name={showRelays ? "collapse" : "expand"}
                    size={18}
                    color={colors.muted}
                  />
                }
                onPress={() => setShowRelays((value) => !value)}
              />
            )}
            {showRelays && details.relays.length > 0 && (
              <EndpointList urls={details.relays} />
            )}
            <SettingsRow
              icon="storage"
              title={t("messages:marmot.groupMediaServers")}
              detail={
                details.mediaV2
                  ? undefined
                  : t("messages:marmot.mediaUnavailableForChat")
              }
              value={
                details.mediaV2
                  ? String(details.mediaEndpoints.length)
                  : undefined
              }
              expanded={
                details.mediaEndpoints.length ? showMediaServers : undefined
              }
              trailing={
                details.mediaEndpoints.length ? (
                  <Icon
                    name={showMediaServers ? "collapse" : "expand"}
                    size={18}
                    color={colors.muted}
                  />
                ) : undefined
              }
              onPress={
                details.mediaEndpoints.length
                  ? () => setShowMediaServers((value) => !value)
                  : undefined
              }
            />
            {showMediaServers && details.mediaEndpoints.length > 0 && (
              <EndpointList urls={details.mediaEndpoints} />
            )}
          </SettingsGroup>
          {(member || details.canLeave || details.canCancelLeave) && (
            <SettingsGroup title={t("messages:marmot.conversationActions")}>
              {member && (
                <SettingsRow
                  title={t(
                    details.archived
                      ? "messages:marmot.unarchiveConversation"
                      : "messages:marmot.archiveConversation",
                  )}
                  disabled={busy}
                  onPress={() =>
                    void update(() => marmot.setArchived(id, !details.archived))
                  }
                />
              )}
              {details.canCancelLeave && (
                <SettingsRow
                  title={t("messages:marmot.cancelLeave")}
                  disabled={busy}
                  onPress={() =>
                    void update(() =>
                      marmot.changeMembership(id, "cancelLeave"),
                    )
                  }
                />
              )}
              {details.canLeave && (
                <SettingsRow
                  title={t("messages:marmot.leave")}
                  disabled={busy}
                  onPress={() =>
                    confirm(
                      t("messages:marmot.leave"),
                      () => marmot.changeMembership(id, "leave"),
                      true,
                    )
                  }
                />
              )}
            </SettingsGroup>
          )}
          {!member && (
            <SettingsGroup>
              <SettingsRow
                title={t("messages:marmot.forgetGroup")}
                disabled={busy}
                onPress={() =>
                  confirm(
                    t("messages:marmot.forgetGroup"),
                    () => marmot.changeMembership(id, "forget"),
                    true,
                  )
                }
              />
            </SettingsGroup>
          )}
        </>
      )}
    </Screen>
  );
}

function GroupMemberIdentity({ publicKey }: { publicKey: string }) {
  const { t } = useTranslation(namespaces);
  const { name } = usePerson(publicKey);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={t("contacts:openProfile", { name })}
      style={[styles.rosterRow, styles.grow]}
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
  name,
  avatar,
  count,
  description,
  back,
  edit,
  editTitle,
}: {
  name?: string;
  avatar?: ReactNode;
  count?: number;
  description?: string;
  back: () => void;
  edit?: () => void;
  editTitle?: string;
}) {
  const { t } = useTranslation(namespaces);
  const { colors } = useTheme();
  const surface = { backgroundColor: colors.accentSoft };
  return (
    <View style={styles.profileHeader}>
      <View style={styles.profileAvatar}>
        <GlassBackButton onPress={back} style={styles.profileBack} />
        {avatar}
        {edit && (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={editTitle}
            onPress={() => {
              tapFeedback();
              edit();
            }}
            style={[styles.iconTarget, styles.profileEdit, surface]}
          >
            <Icon name="edit" size={20} />
          </Pressable>
        )}
      </View>
      {name && (
        <Ink
          kind="heading"
          accessibilityRole="header"
          style={styles.profileName}
          numberOfLines={3}
        >
          {name}
        </Ink>
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
  update: (task: () => Promise<void>) => Promise<boolean>;
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
      <Action
        size="sm"
        disabled={busy || !valid || entry === details.mediaEndpoints.join("\n")}
        onPress={() => {
          if (valid)
            void update(() =>
              marmot.updateGroupMedia(details.id, [...new Set(origins)]),
            );
        }}
      >
        {t("messages:marmot.save")}
      </Action>
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
  const { identity } = useLocal();
  const [addresses, setAddresses] = useState("");
  const parsed = resolveAddresses(addresses, identity.publicKey);
  return (
    <>
      <GlassInput
        label={t("messages:marmot.addresses")}
        value={addresses}
        onChangeText={setAddresses}
        multiline
        autoCapitalize="none"
      />
      <InviteeAvailability keys={parsed ?? []} />
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
  member: { gap: space.xs, marginBottom: space.sm },
  grow: { flex: 1, minWidth: 0, gap: 3 },
  profileHeader: { alignItems: "center", gap: space.xs },
  profileAvatar: {
    alignSelf: "stretch",
    minHeight: 80,
    alignItems: "center",
    justifyContent: "center",
  },
  profileBack: { position: "absolute", top: 0, start: 0 },
  profileEdit: { position: "absolute", top: 0, end: 0, borderRadius: 22 },
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
    paddingHorizontal: space.lg,
    paddingVertical: space.xs,
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
