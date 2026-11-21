import { router, Stack, useFocusEffect } from "expo-router";
import { useCallback, useState } from "react";
import { useTranslation } from "react-i18next";
import { Alert, StyleSheet, View } from "react-native";
import { GlassInput } from "@/components/glassyui/glass-input";
import { Action, Empty, Ink, Screen } from "@/components/ui/kit";
import { parsePublicKey } from "@/core/identity/keys";
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
import { marmotErrorCode } from "./marmot-window";

export function useMarmotError() {
  const { t } = useTranslation(namespaces);
  return (error: unknown) => {
    const code = marmotErrorCode(error);
    if (code === "GroupCommitPending")
      return t("messages:marmot.pendingCommit");
    if (code === "NoUsableRelay" || code === "Publish")
      return t("messages:marmot.relayError");
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

export function NewMarmotGroup() {
  const { t } = useTranslation(namespaces);
  const { db, identity, marmotSession, privacy } = useLocal();
  const translateError = useMarmotError();
  const [addresses, setAddresses] = useState("");
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [selected, setSelected] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const saved = db
    .select()
    .from(contacts)
    .all()
    .filter((contact) => !privacy.isBlocked(contact.publicKey));

  async function create() {
    const keys = resolveAddresses(addresses, identity.publicKey);
    if (!keys || keys.some(privacy.isBlocked)) {
      setError(t("contacts:invalidAddress"));
      return;
    }
    const members = [...new Set([...keys, ...selected])];
    if (members.length < 2 || !name.trim()) return;
    setBusy(true);
    setError("");
    try {
      await marmotSession.ready();
      const result = await marmot.createGroup(
        name.trim(),
        description.trim() || null,
        members,
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

  return (
    <Screen>
      <Stack.Screen options={{ title: t("messages:marmot.newGroup") }} />
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

export function MarmotGroupDetailsScreen({ id }: { id: string }) {
  const { t } = useTranslation(namespaces);
  const { identity, marmotSession, privacy } = useLocal();
  const translateError = useMarmotError();
  const [details, setDetails] = useState<MarmotGroupDetails>();
  const [error, setError] = useState(false);
  const [busy, setBusy] = useState(false);

  const load = useCallback(
    () => marmotSession.ready().then(() => marmot.groupDetails(id)),
    [id, marmotSession],
  );
  useFocusEffect(
    useCallback(() => {
      let active = true;
      void load()
        .then((data) => {
          if (active) setDetails(data);
        })
        .catch(() => {
          if (active) setError(true);
        });
      return () => {
        active = false;
      };
    }, [load]),
  );

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

  return (
    <Screen>
      <Stack.Screen options={{ title: t("messages:marmot.details") }} />
      {error ? (
        <Empty
          detail=""
          icon="chat"
          title={t("messages:marmot.accountError")}
        />
      ) : details ? (
        <>
          <Ink kind="title">{details.name || t("messages:marmot.group")}</Ink>
          {details.description ? <Ink>{details.description}</Ink> : null}
          {details.commit ? (
            <Ink>{t("messages:marmot.pendingCommit")}</Ink>
          ) : null}
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
              <Ink>{member.name || member.npub}</Ink>
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
        </>
      ) : null}
    </Screen>
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
  actions: { flexDirection: "row", flexWrap: "wrap", gap: space.xs },
});
