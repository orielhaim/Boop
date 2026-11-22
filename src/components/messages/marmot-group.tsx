import { router, Stack } from "expo-router";
import type { File } from "expo-file-system";
import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";
import { Alert, StyleSheet, View } from "react-native";
import { useStore } from "zustand";
import { EditableAvatar } from "@/components/avatars/editable-avatar";
import { AvatarCropScreen, useAvatarPicker } from "@/components/avatars/picker";
import { GlassInput } from "@/components/glassyui/glass-input";
import { GlassAvatar } from "@/components/glassyui/glass-avatar";
import { Action, Avatar, Empty, Ink, Screen } from "@/components/ui/kit";

import { parsePublicKey } from "@/core/identity/keys";
import { blossomServer } from "@/core/media/blossom";
import {
  marmot,
  type MarmotGroupDetails,
  type MarmotMemberOutcome,
} from "@/core/marmot/native";
import { contacts } from "@/db/schema";
import { namespaces } from "@/i18n";
import { useLocal } from "@/services/local-context";
import { space } from "@/theme";
import { conversationRoute } from "./marmot-inbox";
import { marmotErrorCode, useMarmotWindow } from "./marmot-window";

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

function failureList(outcomes: MarmotMemberOutcome[]) {
  return outcomes
    .filter(
      (row) => row.status !== "selected" && row.status !== "already_member",
    )
    .map((row) => row.account)
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
  const translateError = useMarmotError();
  const [addresses, setAddresses] = useState("");
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [selected, setSelected] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [photo, setPhoto] = useState<File | null>(null);
  const picker = useAvatarPicker();
  useEffect(() => () => cleanImage(photo), [photo]);
  const saved = db
    .select()
    .from(contacts)
    .all()
    .filter((contact) => !privacy.isBlocked(contact.publicKey));

  async function create() {
    const keys = resolveAddresses(addresses, identity.publicKey);
    if (!keys) {
      setError(t("contacts:invalidAddress"));
      return;
    }
    const members = [...new Set([...keys, ...selected])];
    if (members.some(privacy.isBlocked)) {
      setError(t("messages:marmot.blocked"));
      return;
    }
    if (members.length < 2 || !name.trim()) return;
    setBusy(true);
    setError("");
    try {
      await marmotSession.ready();
      const result = await marmot.createGroup(
        name.trim(),
        description.trim() || null,
        members,
        photo ? imagePath(photo) : null,
      );
      const unavailable = failureList(result.members);
      if (!result.groupId) {
        setError(unavailable || t("messages:marmot.operationError"));
        return;
      }
      const group = result.groupId;
      if (unavailable)
        Alert.alert(t("messages:marmot.unavailableMembers"), unavailable, [
          {
            text: t("common:done"),
            onPress: () => router.replace(conversationRoute(group)),
          },
        ]);
      else router.replace(conversationRoute(group));
    } catch (reason) {
      setError(translateError(reason));
    } finally {
      setBusy(false);
    }
  }

  if (picker.image)
    return (
      <AvatarCropScreen
        source={picker.image}
        onCancel={picker.clear}
        onSave={(file) => {
          setPhoto(file);
          picker.clear();
        }}
      />
    );

  return (
    <Screen>
      <Stack.Screen options={{ title: t("messages:marmot.newGroup") }} />
      {!mediaSdk.configured("attachment").length && (
        <Ink>{t("messages:marmot.textOnlyGroup")}</Ink>
      )}
      <EditableAvatar
        disabled={busy || picker.busy}
        onPick={(source) => void picker.pick(source)}
        onRemove={photo ? () => setPhoto(null) : undefined}
      >
        <GlassAvatar
          name={name || t("messages:marmot.group")}
          src={photo?.uri}
          size="xl"
        />
      </EditableAvatar>
      {picker.error && <Ink>{picker.error}</Ink>}
      <GlassInput
        label={t("messages:marmot.groupName")}
        value={name}
        onChangeText={setName}
        maxLength={128}
      />
      <GlassInput
        label={t("messages:marmot.groupDescription")}
        value={description}
        onChangeText={setDescription}
        multiline
        maxLength={512}
      />
      <GlassInput
        label={t("messages:marmot.addresses")}
        value={addresses}
        onChangeText={setAddresses}
        multiline
        autoCapitalize="none"
      />
      {saved.map((contact) => (
        <Action
          key={contact.publicKey}
          variant={selected.includes(contact.publicKey) ? "prominent" : "soft"}
          onPress={() =>
            setSelected((value) =>
              value.includes(contact.publicKey)
                ? value.filter((key) => key !== contact.publicKey)
                : [...value, contact.publicKey],
            )
          }
        >
          {contact.name}
        </Action>
      ))}
      {error ? <Ink accessibilityLiveRegion="polite">{error}</Ink> : null}
      <Action
        disabled={busy || !name.trim()}
        variant="prominent"
        onPress={() => void create()}
      >
        {t("messages:marmot.create")}
      </Action>
    </Screen>
  );
}

export function MarmotGroupDetailsScreen({
  id,
  showCall = false,
}: {
  id: string;
  showCall?: boolean;
}) {
  const { t } = useTranslation(namespaces);
  const { identity, marmotSession, privacy, calling } = useLocal();
  const call = useStore(calling.store, (state) => state.call);
  const translateError = useMarmotError();
  const [details, setDetails] = useState<MarmotGroupDetails>();
  const [error, setError] = useState(false);
  const [busy, setBusy] = useState(false);
  const [selectPeer, setSelectPeer] = useState(showCall);
  const [image, setImage] = useState<{ hash: string; uri: string }>();
  const picker = useAvatarPicker();
  useSyncExternalStore(privacy.subscribe, privacy.revision);
  const mayViewPhoto =
    privacy.photoPolicy() !== "nobody" && details?.membership === "member";

  const load = useCallback(
    () => marmotSession.ready().then(() => marmot.groupDetails(id)),
    [id, marmotSession],
  );
  const watch = useCallback(() => marmot.openGroupState(id), [id]);
  const state = useMarmotWindow(watch);
  const revision = state.snapshot?.sequence;
  useEffect(() => {
    if (revision === undefined) return;
    let active = true;
    void load()
      .then((data) => {
        if (active) {
          setDetails(data);
          setError(false);
        }
      })
      .catch(() => {
        if (active) setError(true);
      });
    return () => {
      active = false;
    };
  }, [load, revision]);

  async function update(task: () => Promise<void>, leave = false) {
    if (busy) return;
    setBusy(true);
    try {
      await task();
      if (leave) router.back();
      else setDetails(await load());
    } catch (reason) {
      Alert.alert(translateError(reason));
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
    const hash = details?.image;
    if (!hash || !mayViewPhoto || busy) return;
    await update(async () => {
      const path = await marmot.groupImage(id, hash, true);
      if (path && privacy.photoPolicy() !== "nobody")
        setImage({ hash, uri: `file://${path}` });
    });
  }

  if (picker.image)
    return (
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
    );

  const imageUri =
    mayViewPhoto && image?.hash === details?.image ? image?.uri : undefined;
  const groupName = details?.name || t("messages:marmot.group");
  const canEditImage = details?.isAdmin && details.membership === "member";
  const activeCall =
    call?.groupId === id && call.phase !== "ended" ? call : undefined;

  return (
    <Screen>
      <Stack.Screen options={{ title: t("messages:marmot.details") }} />
      {error || state.error ? (
        <Empty detail="" icon="chat" title={t("messages:marmot.accountError")}>
          <Action onPress={state.retry}>{t("common:retry")}</Action>
        </Empty>
      ) : details ? (
        <>
          <EditableAvatar
            disabled={!canEditImage || busy || picker.busy}
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
            <GlassAvatar name={groupName} src={imageUri} size="xl" />
          </EditableAvatar>
          {picker.error && <Ink>{picker.error}</Ink>}
          {details.image && mayViewPhoto && !imageUri && (
            <Action size="sm" disabled={busy} onPress={() => void loadImage()}>
              {t("messages:marmot.viewGroupPhoto")}
            </Action>
          )}
          <Ink kind="title">{groupName}</Ink>
          {details.description ? <Ink>{details.description}</Ink> : null}
          {details.createdAt ? (
            <Ink kind="caption">
              {t("messages:marmot.createdAt", {
                date: new Date(details.createdAt * 1_000).toLocaleDateString(),
              })}
            </Ink>
          ) : null}
          {__DEV__ && (
            <Ink kind="caption">
              {t("messages:marmot.groupSession", {
                epoch: details.epoch,
                state: details.lifecycle,
              })}
            </Ink>
          )}
          {details.membership === "member" && (
            <View style={styles.actions}>
              <Action
                size="sm"
                onPress={() => router.push(conversationRoute(id, "search"))}
              >
                {t("messages:marmot.searchConversation")}
              </Action>
              <Action
                size="sm"
                onPress={() => router.push(conversationRoute(id, "media"))}
              >
                {t("messages:marmot.mediaAndFiles")}
              </Action>
              <Action
                size="sm"
                disabled={busy}
                onPress={() =>
                  void update(() => marmot.setMuted(id, !details.muted))
                }
              >
                {t(
                  details.muted
                    ? "messages:marmot.unmuteConversation"
                    : "messages:marmot.muteConversation",
                )}
              </Action>
              <Action
                size="sm"
                disabled={busy}
                onPress={() =>
                  void update(() => marmot.setArchived(id, !details.archived))
                }
              >
                {t(
                  details.archived
                    ? "messages:marmot.unarchiveConversation"
                    : "messages:marmot.archiveConversation",
                )}
              </Action>
              <Action
                size="sm"
                disabled={!activeCall && details.lifecycle !== "stable"}
                onPress={() => {
                  if (activeCall) {
                    router.push({
                      pathname: "/call/[key]",
                      params: {
                        key: activeCall.peerKey,
                        callId: activeCall.id,
                      },
                    });
                  } else {
                    setSelectPeer((previous) => !previous);
                  }
                }}
              >
                {t(
                  activeCall
                    ? "messages:marmot.returnToCall"
                    : "calls:startCall",
                )}
              </Action>
            </View>
          )}
          {selectPeer &&
            !activeCall &&
            details.membership === "member" &&
            details.lifecycle === "stable" && (
              <View>
                <Ink>{t("messages:marmot.chooseCallMember")}</Ink>
                {details.members
                  .filter(
                    (member) => !member.self && !privacy.isBlocked(member.id),
                  )
                  .map((member) => (
                    <Action
                      key={member.id}
                      size="sm"
                      onPress={() => {
                        router.push({
                          pathname: "/call/[key]",
                          params: { key: member.id, group: id },
                        });
                      }}
                    >
                      {member.name || member.npub}
                    </Action>
                  ))}
              </View>
            )}
          {details.commit ? (
            <Ink>{t("messages:marmot.pendingCommit")}</Ink>
          ) : null}
          {details.relayChangesOutstanding > 0 && (
            <Ink>{t("messages:marmot.groupRelayPending")}</Ink>
          )}
          {details.historyIncomplete && (
            <Ink>{t("messages:marmot.groupHistoryIncomplete")}</Ink>
          )}
          {details.unrecoverable && (
            <Ink>{t("messages:marmot.groupRecoveryRequired")}</Ink>
          )}
          {details.convergenceParked && !details.unrecoverable && (
            <Action
              disabled={busy}
              onPress={() => void update(() => marmot.retryConversation(id))}
            >
              {t("messages:marmot.retrySynchronization")}
            </Action>
          )}
          {details.isAdmin && details.membership === "member" && (
            <GroupProfileFields
              key={`${details.name}:${details.description}:${details.retention}`}
              details={details}
              busy={busy}
              update={update}
            />
          )}
          <Ink kind="title">
            {t("messages:marmot.members")} ({details.members.length})
          </Ink>
          {details.members.map((member) => (
            <View key={member.id} style={styles.member}>
              <GroupMemberName member={member} />
              {member.admin ? (
                <Ink kind="caption">{t("messages:marmot.admin")}</Ink>
              ) : null}
              <View style={styles.actions}>
                {member.canPromote && (
                  <Action
                    size="sm"
                    disabled={busy}
                    onPress={() =>
                      void update(() =>
                        marmot.changeMember(id, member.id, "promote"),
                      )
                    }
                  >
                    {t("messages:marmot.promote")}
                  </Action>
                )}
                {member.canDemote && (
                  <Action
                    size="sm"
                    disabled={busy}
                    onPress={() =>
                      confirm(t("messages:marmot.demote"), () =>
                        marmot.changeMember(id, member.id, "demote"),
                      )
                    }
                  >
                    {t("messages:marmot.demote")}
                  </Action>
                )}
                {member.canRemove && (
                  <Action
                    size="sm"
                    disabled={busy}
                    onPress={() =>
                      confirm(t("messages:marmot.remove"), () =>
                        marmot.changeMember(id, member.id, "remove"),
                      )
                    }
                  >
                    {t("messages:marmot.remove")}
                  </Action>
                )}
              </View>
            </View>
          ))}
          {details.canInvite && (
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
                  );
                  if (unavailable)
                    Alert.alert(
                      t("messages:marmot.unavailableMembers"),
                      unavailable,
                    );
                });
              }}
            />
          )}
          {details.relays.length > 0 && (
            <>
              <Ink kind="title">{t("messages:marmot.relayList")}</Ink>
              {details.relays.map((relay) => (
                <Ink key={relay} kind="caption">
                  {relay}
                </Ink>
              ))}
            </>
          )}
          {details.mediaV2 ? (
            <GroupMediaSettings
              key={details.mediaEndpoints.join(",")}
              details={details}
              editable={
                details.isAdmin &&
                details.membership === "member" &&
                details.lifecycle === "stable"
              }
              busy={busy}
              update={update}
            />
          ) : (
            <Ink kind="caption">
              {t("messages:marmot.mediaUnavailableForChat")}
            </Ink>
          )}
          {details.canLeave && (
            <Action
              disabled={busy}
              onPress={() =>
                confirm(
                  t("messages:marmot.leave"),
                  () => marmot.changeMembership(id, "leave"),
                  true,
                )
              }
            >
              {t("messages:marmot.leave")}
            </Action>
          )}
          {details.canCancelLeave && (
            <Action
              disabled={busy}
              onPress={() =>
                void update(() => marmot.changeMembership(id, "cancelLeave"))
              }
            >
              {t("messages:marmot.cancelLeave")}
            </Action>
          )}
          {details.canEnableDisbanding && (
            <Action
              disabled={busy}
              onPress={() =>
                confirm(t("messages:marmot.enableDisbanding"), () =>
                  marmot.changeMembership(id, "enableDisbanding"),
                )
              }
            >
              {t("messages:marmot.enableDisbanding")}
            </Action>
          )}
          {details.canDisband && (
            <Action
              disabled={busy}
              onPress={() =>
                confirm(
                  t("messages:marmot.disband"),
                  () => marmot.changeMembership(id, "disband"),
                  true,
                )
              }
            >
              {t("messages:marmot.disband")}
            </Action>
          )}
          {details.membership !== "member" && (
            <Action
              disabled={busy}
              onPress={() =>
                confirm(
                  t("messages:marmot.forgetGroup"),
                  () => marmot.changeMembership(id, "forget"),
                  true,
                )
              }
            >
              {t("messages:marmot.forgetGroup")}
            </Action>
          )}
        </>
      ) : null}
    </Screen>
  );
}

function GroupMediaSettings({
  details,
  editable,
  busy,
  update,
}: {
  details: MarmotGroupDetails;
  editable: boolean;
  busy: boolean;
  update: (task: () => Promise<void>) => Promise<void>;
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
    <View>
      <Ink kind="title">{t("messages:marmot.groupMediaServers")}</Ink>
      {editable ? (
        <>
          <GlassInput
            label={t("messages:marmot.groupMediaServers")}
            value={entry}
            onChangeText={setEntry}
            autoCapitalize="none"
            multiline
          />
          <Action
            size="sm"
            disabled={
              busy || !valid || entry === details.mediaEndpoints.join("\n")
            }
            onPress={() => {
              if (valid)
                void update(() =>
                  marmot.updateGroupMedia(details.id, [...new Set(origins)]),
                );
            }}
          >
            {t("messages:marmot.save")}
          </Action>
        </>
      ) : (
        details.mediaEndpoints.map((url) => (
          <Ink kind="caption" key={url}>
            {url}
          </Ink>
        ))
      )}
    </View>
  );
}

function GroupMemberName({
  member,
}: {
  member: MarmotGroupDetails["members"][number];
}) {
  const name = member.name || member.npub;
  return (
    <View style={styles.memberName}>
      <Avatar publicKey={member.id} name={name} size="sm" />
      <Ink>{name}</Ink>
    </View>
  );
}

function GroupProfileFields({
  details,
  busy,
  update,
}: {
  details: MarmotGroupDetails;
  busy: boolean;
  update: (task: () => Promise<void>) => Promise<void>;
}) {
  const { t } = useTranslation(namespaces);
  const [name, setName] = useState(details.name);
  const [description, setDescription] = useState(details.description);
  const [duration, setDuration] = useState(String(details.retention));
  return (
    <>
      <GlassInput
        label={t("messages:marmot.groupName")}
        value={name}
        onChangeText={setName}
        maxLength={128}
      />
      <GlassInput
        label={t("messages:marmot.groupDescription")}
        value={description}
        onChangeText={setDescription}
        multiline
        maxLength={512}
      />
      <Action
        disabled={
          busy ||
          !name.trim() ||
          (name === details.name && description === details.description)
        }
        onPress={() =>
          void update(() =>
            marmot.updateGroup(details.id, name.trim(), description.trim()),
          )
        }
      >
        {t("messages:marmot.save")}
      </Action>
      <GlassInput
        label={t("messages:marmot.retention")}
        value={duration}
        onChangeText={setDuration}
        keyboardType="number-pad"
        maxLength={10}
      />
      <Action
        disabled={
          busy ||
          !/^\d+$/.test(duration) ||
          Number(duration) === details.retention
        }
        onPress={() =>
          void update(() =>
            marmot.updateRetention(details.id, Number(duration)),
          )
        }
      >
        {t("messages:marmot.save")}
      </Action>
    </>
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
  const [addresses, setAddresses] = useState("");
  return (
    <>
      <GlassInput
        label={t("messages:marmot.addresses")}
        value={addresses}
        onChangeText={setAddresses}
        multiline
        autoCapitalize="none"
      />
      <Action
        disabled={busy || !addresses.trim()}
        onPress={() => invite(addresses)}
      >
        {t("messages:marmot.invite")}
      </Action>
    </>
  );
}

const styles = StyleSheet.create({
  member: { gap: space.xs, marginBottom: space.sm },
  memberName: { flexDirection: "row", alignItems: "center", gap: space.sm },
  actions: { flexDirection: "row", flexWrap: "wrap", gap: space.xs },
});
