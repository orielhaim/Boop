import { asc } from "drizzle-orm";
import { useLiveQuery } from "drizzle-orm/expo-sqlite";
import { randomUUID } from "expo-crypto";
import { useMemo, useState, useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";
import { Alert, StyleSheet, View } from "react-native";
import { GlassInput } from "@/components/glassyui/glass-input";
import {
  SettingsDescription,
  SettingsGroup,
  SettingsRow,
  SettingsToggle,
} from "@/components/settings/group";
import { Action, Icon, Ink } from "@/components/ui/kit";
import type { RelayState } from "@/core/nostr/relay-service";
import {
  configuredRelays,
  defaultRelays,
  type RelayChoice,
  sameRelays,
} from "@/core/nostr/config";
import { relayUrl } from "@/core/nostr/relays";
import { editRelays } from "@/db/relays";
import { relaySettings } from "@/db/schema";
import { namespaces, resolveLanguage } from "@/i18n";
import { formatDateTime, isolateText } from "@/i18n/format";
import { useLocal } from "@/services/local-context";
import { space, useTheme } from "@/theme";

const statusLabels = {
  connected: "connections:connected",
  connecting: "connections:connecting",
  disconnected: "connections:disconnected",
  "auth-required": "connections:authRequested",
  rejected: "connections:authRejected",
  unavailable: "common:unavailable",
} satisfies Record<
  RelayState["status"],
  `connections:${string}` | "common:unavailable"
>;
const inboxLabels = {
  idle: "connections:inboxSelected",
  validating: "connections:checkingInbox",
  published: "connections:inboxPublished",
  conflict: "connections:inboxConflict",
  unverified: "connections:inboxUnverified",
  pending: "connections:pendingInbox",
} as const;

export function RelaySettings() {
  const { t, i18n } = useTranslation(namespaces);
  const { db, relays } = useLocal();
  const { colors } = useTheme();
  const states = useSyncExternalStore(relays.subscribe, relays.getRelayStates);
  const inboxState = useSyncExternalStore(
    relays.subscribe,
    relays.getInboxStatus,
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
      setError(t("connections:maxInbox"));
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
        setError(t("connections:saveError"));
        return false;
      }
    }
    if (existing.inbox.length && !next.inbox.length) {
      Alert.alert(
        t("connections:disableLast"),
        t("connections:disableLastHint"),
        [
          { text: t("common:cancel"), style: "cancel" },
          {
            text: t("connections:disableInbox"),
            style: "destructive",
            onPress: save,
          },
        ],
      );
      return false;
    }
    return save();
  }

  function add() {
    const parsed = relayUrl.safeParse(input.trim());
    if (!parsed.success) {
      setInputError(t("connections:invalidUrl"));
      return;
    }
    const url = parsed.data;
    if (items.some((item) => relayUrl.safeParse(item.url).data === url)) {
      setInputError(t("connections:duplicate"));
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
      <SettingsGroup title={t("connections:relays")}>
        <SettingsRow
          title={t("connections:status")}
          value={t("connections:connectionCount", {
            connected,
            total: enabled.length,
          })}
          icon="connection"
        />
        <SettingsRow
          title={t("connections:reconnect")}
          onPress={relays.reconnect}
        />
      </SettingsGroup>
      <SettingsGroup title={t("connections:privateInbox")}>
        <SettingsRow
          title={
            existing.inbox.length
              ? t(inboxLabels[inboxState])
              : t("connections:inboxDisabled")
          }
          detail={
            existing.inbox.length
              ? t("connections:selected", { count: existing.inbox.length })
              : t("connections:selectInbox")
          }
          icon="chat"
        />
        {existing.inbox.length > 0 &&
          existing.inbox.length <= 3 &&
          inboxState !== "published" && (
            <SettingsRow
              title={t("connections:publishInbox")}
              onPress={() =>
                Alert.alert(
                  t("connections:publishConfirm"),
                  t("connections:publishHint"),
                  [
                    { text: t("common:cancel"), style: "cancel" },
                    {
                      text: t("connections:publish"),
                      onPress: () => update([], true),
                    },
                  ],
                )
              }
            />
          )}
      </SettingsGroup>
      {error && <SettingsDescription>{error}</SettingsDescription>}
      <SettingsGroup title={t("connections:savedRelays")}>
        {items.map((item) => {
          const state = states[item.url];
          const roles = [
            item.general && t("connections:general"),
            item.inbox && t("connections:inbox"),
            item.discovery && t("connections:discovery"),
          ]
            .filter(Boolean)
            .join(" · ");
          const show = expanded === item.url;
          return (
            <View key={item.url}>
              <SettingsRow
                title={new URL(item.url).host}
                detail={`${item.enabled ? t(statusLabels[state?.status ?? "disconnected"]) : t("connections:disabled")} · ${roles || t("connections:noPurpose")}`}
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
                      {t("connections:lastConnected")}{" "}
                      {formatDateTime(
                        state.lastConnected,
                        resolveLanguage(i18n.resolvedLanguage),
                      )}
                    </SettingsDescription>
                  )}
                  {state?.lastWrite && (
                    <SettingsDescription>
                      {state.lastWrite === "accepted"
                        ? t("connections:accepted")
                        : t("connections:rejected")}
                    </SettingsDescription>
                  )}
                  {state?.inboxVerified !== undefined && (
                    <SettingsDescription>
                      {state.inboxVerified
                        ? t("connections:verified")
                        : t("connections:verificationFailed")}
                    </SettingsDescription>
                  )}
                  {(["enabled", "general", "inbox", "discovery"] as const).map(
                    (field) => (
                      <SettingsToggle
                        key={field}
                        title={
                          {
                            enabled: t("connections:enabled"),
                            general: t("connections:general"),
                            inbox: t("connections:privateInbox"),
                            discovery: t("connections:discovery"),
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
                      Alert.alert(
                        t("connections:removeRelay"),
                        isolateText(item.url),
                        [
                          { text: t("common:cancel"), style: "cancel" },
                          {
                            text: t("common:remove"),
                            style: "destructive",
                            onPress: () =>
                              update([{ url: item.url, next: null }]),
                          },
                        ],
                      )
                    }
                  >
                    {t("connections:removeAction")}
                  </Action>
                </View>
              )}
            </View>
          );
        })}
        {items.length === 0 && <SettingsRow title={t("connections:empty")} />}
      </SettingsGroup>
      <SettingsGroup title={t("connections:add")}>
        <View style={styles.input}>
          <GlassInput
            label={t("connections:address")}
            placeholder="wss://relay.example"
            value={input}
            onChangeText={(text) => {
              setInput(text);
              setInputError("");
            }}
            autoCapitalize="none"
            style={{ writingDirection: "ltr", textAlign: "left" }}
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
            {t("connections:addAction")}
          </Action>
          {inputError && (
            <SettingsDescription>{inputError}</SettingsDescription>
          )}
        </View>
      </SettingsGroup>

      <SettingsGroup>
        <SettingsRow
          title={t("connections:restoreDefaults")}
          onPress={() =>
            Alert.alert(
              t("connections:restoreConfirm"),
              t("connections:restoreHint"),
              [
                { text: t("common:cancel"), style: "cancel" },
                {
                  text: t("connections:restore"),
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
