import { asc } from "drizzle-orm";
import { useLiveQuery } from "drizzle-orm/expo-sqlite";
import { randomUUID } from "expo-crypto";
import { useMemo, useState, useSyncExternalStore } from "react";
import { Alert, StyleSheet, View } from "react-native";
import { GlassInput } from "@/components/glassyui/glass-input";
import {
  SettingsDescription,
  SettingsGroup,
  SettingsRow,
  SettingsToggle,
} from "@/components/settings/group";
import { Action, Icon, Ink } from "@/components/ui/kit";
import type { RelayState } from "@/core/messaging/runtime";
import {
  configuredRelays,
  defaultRelays,
  type RelayChoice,
  sameRelays,
} from "@/core/nostr/config";
import { relayUrl } from "@/core/nostr/relays";
import { editRelays } from "@/db/relays";
import { relaySettings } from "@/db/schema";
import { useLocal } from "@/services/local";
import { space, useTheme } from "@/theme";

const statusLabels: Record<RelayState["status"], string> = {
  connected: "Connected",
  connecting: "Connecting…",
  disconnected: "Disconnected",
  "auth-required": "Authentication requested",
  rejected: "Authentication rejected",
  unavailable: "Unavailable",
};
const inboxLabels = {
  idle: "Inbox selected",
  validating: "Checking inbox relays…",
  published: "Inbox published",
  conflict: "Published inbox differs from your selection",
  unverified: "Could not verify every inbox relay",
  pending: "Waiting to publish inbox",
};

export function RelaySettings() {
  const { db, messaging } = useLocal();
  const { colors } = useTheme();
  const states = useSyncExternalStore(
    messaging.subscribeStatus,
    messaging.getRelayStates,
  );
  const inboxState = useSyncExternalStore(
    messaging.subscribeStatus,
    messaging.getInboxStatus,
  );
  const query = useMemo(
    () => db.select().from(relaySettings).orderBy(asc(relaySettings.url)),
    [db],
  );
  const { data: items } = useLiveQuery(query, [query]);
  const [input, setInput] = useState("");
  const [error, setError] = useState("");
  const [inputError, setInputError] = useState("");
  const [expanded, setExpanded] = useState<string | null>(null);
  const existing = configuredRelays(items, null);
  const enabled = items.filter((item) => item.enabled);
  const connected = enabled.filter(
    (item) => states[item.url]?.status === "connected",
  ).length;

  function update(
    changes: readonly { url: string; next: RelayChoice | null }[],
    forcePublish = false,
  ) {
    const modified = new Map(items.map((item) => [item.url, item]));
    for (const { url, next } of changes) {
      if (next) modified.set(url, next);
      else modified.delete(url);
    }
    const next = configuredRelays([...modified.values()], null);
    const inboxChanged = !sameRelays(existing.inbox, next.inbox);
    if (inboxChanged && next.inbox.length > 3) {
      setError("Choose up to three enabled inbox relays.");
      return;
    }
    function save() {
      try {
        editRelays(
          db,
          changes,
          forcePublish || inboxChanged ? randomUUID() : null,
        );
        setError("");
        return true;
      } catch {
        setError("Could not save the relay configuration.");
        return false;
      }
    }
    if (existing.inbox.length && !next.inbox.length) {
      Alert.alert(
        "Disable the last inbox relay?",
        "Private messages and call invitations may stop arriving. Your previously published address list can remain visible to other clients.",
        [
          { text: "Cancel", style: "cancel" },
          { text: "Disable inbox", style: "destructive", onPress: save },
        ],
      );
      return false;
    }
    return save();
  }

  function add() {
    const parsed = relayUrl.safeParse(input.trim());
    if (!parsed.success) {
      setInputError("Enter a valid wss:// relay address.");
      return;
    }
    const url = parsed.data;
    if (items.some((item) => relayUrl.safeParse(item.url).data === url)) {
      setInputError("That relay is already saved.");
      return;
    }
    if (
      !update([
        {
          url,
          next: {
            url,
            general: true,
            inbox: false,
            discovery: false,
            enabled: true,
          },
        },
      ])
    )
      return;
    setExpanded(url);
    setInput("");
    setInputError("");
  }

  return (
    <>
      <SettingsGroup title="Nostr relays">
        <SettingsRow
          title="Relay status"
          value={`${connected} of ${enabled.length} connected`}
          icon="connection"
        />
        <SettingsRow title="Reconnect relays" onPress={messaging.reconnect} />
      </SettingsGroup>
      <SettingsGroup title="Private inbox">
        <SettingsRow
          title={
            existing.inbox.length ? inboxLabels[inboxState] : "Inbox disabled"
          }
          detail={
            existing.inbox.length
              ? `${existing.inbox.length} selected`
              : "Select a relay to receive messages and calls."
          }
          icon="chat"
        />
        {existing.inbox.length > 0 &&
          existing.inbox.length <= 3 &&
          inboxState !== "published" && (
            <SettingsRow
              title="Publish inbox"
              onPress={() =>
                Alert.alert(
                  "Publish this inbox list?",
                  "People use this public relay list to reach you.",
                  [
                    { text: "Cancel", style: "cancel" },
                    { text: "Publish", onPress: () => update([], true) },
                  ],
                )
              }
            />
          )}
      </SettingsGroup>
      {error && <SettingsDescription>{error}</SettingsDescription>}
      <SettingsGroup title="Saved relays">
        {items.map((item) => {
          const state = states[item.url];
          const roles = [
            item.general && "General",
            item.inbox && "Inbox",
            item.discovery && "Discovery",
          ]
            .filter(Boolean)
            .join(" · ");
          const show = expanded === item.url;
          return (
            <View key={item.url}>
              <SettingsRow
                title={new URL(item.url).host}
                detail={`${item.enabled ? statusLabels[state?.status ?? "disconnected"] : "Disabled"} · ${roles || "No purpose"}`}
                trailing={
                  <Icon
                    name={show ? "collapse" : "expand"}
                    size={18}
                    color={colors.muted}
                  />
                }
                expanded={show}
                onPress={() => setExpanded(show ? null : item.url)}
              />
              {show && (
                <View style={[styles.detail, { borderTopColor: colors.line }]}>
                  <Ink kind="caption" muted selectable style={styles.address}>
                    {item.url}
                  </Ink>
                  {state?.lastConnected && (
                    <SettingsDescription>
                      Last connected{" "}
                      {new Date(state.lastConnected).toLocaleString()}
                    </SettingsDescription>
                  )}
                  {state?.lastWrite && (
                    <SettingsDescription>
                      {state.lastWrite === "accepted"
                        ? "Last write accepted"
                        : "Last write rejected"}
                    </SettingsDescription>
                  )}
                  {state?.inboxVerified !== undefined && (
                    <SettingsDescription>
                      {state.inboxVerified
                        ? "Inbox verified"
                        : "Inbox verification failed"}
                    </SettingsDescription>
                  )}
                  {(["enabled", "general", "inbox", "discovery"] as const).map(
                    (field) => (
                      <SettingsToggle
                        key={field}
                        title={
                          {
                            enabled: "Enabled",
                            general: "General",
                            inbox: "Private inbox",
                            discovery: "Discovery",
                          }[field]
                        }
                        value={item[field]}
                        onChange={(value) =>
                          update([
                            {
                              url: item.url,
                              next: { ...item, [field]: value },
                            },
                          ])
                        }
                      />
                    ),
                  )}
                  <Action
                    size="sm"
                    variant="ghost"
                    style={styles.remove}
                    onPress={() =>
                      Alert.alert("Remove relay?", item.url, [
                        { text: "Cancel", style: "cancel" },
                        {
                          text: "Remove",
                          style: "destructive",
                          onPress: () =>
                            update([{ url: item.url, next: null }]),
                        },
                      ])
                    }
                  >
                    Remove relay
                  </Action>
                </View>
              )}
            </View>
          );
        })}
        {items.length === 0 && <SettingsRow title="No relays added" />}
      </SettingsGroup>
      <SettingsGroup title="Add a relay">
        <View style={styles.input}>
          <GlassInput
            label="Relay address"
            placeholder="wss://relay.example"
            value={input}
            onChangeText={(text) => {
              setInput(text);
              setInputError("");
            }}
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="url"
            onSubmitEditing={add}
            maxLength={2048}
          />
          <Action
            variant="prominent"
            style={styles.add}
            disabled={!input.trim()}
            onPress={add}
          >
            Add relay
          </Action>
          {inputError && (
            <SettingsDescription>{inputError}</SettingsDescription>
          )}
        </View>
      </SettingsGroup>

      <SettingsGroup>
        <SettingsRow
          title="Restore recommended relays"
          onPress={() =>
            Alert.alert(
              "Restore recommended relays?",
              "This replaces your saved relays and updates your inbox.",
              [
                { text: "Cancel", style: "cancel" },
                {
                  text: "Restore",
                  style: "destructive",
                  onPress: () =>
                    update(
                      [
                        ...items
                          .filter(
                            (item) =>
                              !defaultRelays.some(
                                (relay) => relay.url === item.url,
                              ),
                          )
                          .map(({ url }) => ({ url, next: null })),
                        ...defaultRelays.map((next) => ({
                          url: next.url,
                          next,
                        })),
                      ],
                      true,
                    ),
                },
              ],
            )
          }
        />
      </SettingsGroup>
    </>
  );
}

const styles = StyleSheet.create({
  detail: {
    borderTopWidth: StyleSheet.hairlineWidth,
    paddingVertical: space.sm,
  },
  input: { padding: space.lg, gap: space.sm, alignItems: "stretch" },
  address: { paddingHorizontal: space.lg, writingDirection: "ltr" },
  add: { alignSelf: "flex-end" },
  remove: { marginHorizontal: space.lg },
});
