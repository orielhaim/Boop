import { useState, useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";
import { View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { GlassInput } from "@/components/glassyui/glass-input";
import {
  SettingsDescription,
  ListGroup,
  ListRow,
  PreferenceToggle,
} from "@/components/ui/list-group";
import { Action, Icon, Ink } from "@/components/ui/kit";
import { useDialog } from "@/components/ui/dialog";
import { marmotRelays } from "@/core/marmot/native";
import type { RelayEdit } from "@/core/nostr/account-relays";
import { relayUrl } from "@/core/nostr/relays";
import { namespaces, resolveLanguage } from "@/i18n";
import { formatDateTime } from "@/i18n/format";
import { useLocal } from "@/services/local-context";
import { space, useTheme } from "@/theme";

const statusLabels = {
  connected: "connections:connected",
  connecting: "connections:connecting",
  offline: "connections:disconnected",
  unknown: "common:unknown",
} as const;

const editErrors = {
  InboxLimit: "connections:maxInbox",
  InboxVerification: "connections:inboxUnverified",
  RelayPolicy: "connections:relayPolicy",
  RelayRequired: "connections:generalRequired",
} as const;

function editError(error: unknown) {
  if (!(error instanceof Error)) return "connections:saveError";
  return (
    Object.entries(editErrors).find(([code]) => code === error.message)?.[1] ??
    "connections:saveError"
  );
}

const normalize = (url: string) => relayUrl.safeParse(url).data ?? url;

export function RelaySettings() {
  const { t, i18n } = useTranslation(namespaces);
  const dialog = useDialog();
  const { accountRelays, relays, marmotSession } = useLocal();
  const { colors } = useTheme();
  const {
    lists,
    discovery,
    incomingCalls,
    liveness: nativeStates,
  } = useSyncExternalStore(accountRelays.subscribe, accountRelays.snapshot);
  const signalStates = useSyncExternalStore(
    relays.subscribe,
    relays.getRelayStates,
  );
  const runtime = useSyncExternalStore(
    marmotSession.subscribe,
    marmotSession.status,
  );
  const [input, setInput] = useState("");
  const [inputError, setInputError] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [expanded, setExpanded] = useState<string>();
  const roles = {
    general: [...new Set(lists?.general.map(normalize))],
    inbox: [...new Set(lists?.inbox.map(normalize))],
    discovery,
  };
  const bootstrap = lists?.bootstrap.map(normalize) ?? [];
  const addresses = [
    ...new Set([
      ...roles.general,
      ...roles.inbox,
      ...discovery,
      ...bootstrap,
      ...nativeStates.map(({ url }) => normalize(url)),
      ...Object.keys(signalStates),
    ]),
  ].sort();
  const statusByUrl = new Map(
    nativeStates.map((state) => [normalize(state.url), state]),
  );

  async function change(edit: RelayEdit) {
    setBusy(true);
    setError("");
    try {
      await accountRelays.edit(edit);
      return true;
    } catch (failure) {
      setError(t(editError(failure)));
      return false;
    } finally {
      setBusy(false);
    }
  }

  function add() {
    if (busy || !lists) return;
    const result = relayUrl.safeParse(input.trim());
    if (!result.success) {
      setInputError(t("connections:invalidUrl"));
      return;
    }
    const url = result.data;
    void dialog.show({
      title: t("connections:add"),
      message: url,
      actions: [
        {
          label: t("connections:general"),
          tone: "neutral",
          onSelect: () => addTo("general"),
        },
        {
          label: t("connections:inbox"),
          tone: "neutral",
          onSelect: () => addTo("inbox"),
        },
        {
          label: t("connections:discovery"),
          tone: "neutral",
          onSelect: () => addTo("discovery"),
        },
      ],
    });

    function addTo(list: "general" | "inbox" | "discovery") {
      void (async () => {
        if (roles[list].includes(url)) {
          setInputError(t("connections:duplicate"));
          return;
        }
        if (await change({ list, url, enabled: true })) {
          setExpanded(url);
          setInput("");
        }
      })();
    }
  }

  function toggle(
    list: "general" | "inbox" | "discovery",
    url: string,
    enabled: boolean,
  ) {
    if (list === "inbox" && !enabled && roles.inbox.length === 1) {
      void dialog.show({
        title: t("connections:disableLast"),
        message: t("connections:disableLastHint"),
        dismissible: false,
        actions: [
          { label: t("common:cancel"), tone: "cancel" },
          {
            label: t("connections:disableInbox"),
            tone: "danger",
            onSelect: () =>
              void change({ list: "incomingCalls", enabled: false }),
          },
        ],
      });
    } else void change({ list, url, enabled });
  }

  async function reconnect(url?: string) {
    relays.reconnect(url);
    void accountRelays.refresh(true).catch(() => undefined);
    if (runtime === "failed") await marmotSession.retry();
    if (runtime !== "ready") return;
    const targets = url
      ? nativeStates.filter((row) => normalize(row.url) === url)
      : nativeStates;
    const outcomes = await Promise.allSettled(
      targets.map(({ url: target }) => marmotRelays.reconnect(target)),
    );
    if (outcomes.some((result) => result.status === "rejected"))
      setError(t("connections:reconnectError"));
  }

  return (
    <>
      <ListGroup title={t("connections:relays")}>
        <ListRow
          title={t("connections:marmot")}
          value={
            runtime === "ready" && nativeStates.length
              ? t("connections:connectionCount", {
                  connected: nativeStates.filter(
                    ({ status }) => status === "connected",
                  ).length,
                  total: nativeStates.length,
                })
              : t("common:unknown")
          }
        />
        <ListRow
          title={t("connections:independent")}
          value={
            Object.keys(signalStates).length
              ? t("connections:connectionCount", {
                  connected: Object.values(signalStates).filter(
                    (status) => status === "connected",
                  ).length,
                  total: Object.keys(signalStates).length,
                })
              : t("common:unknown")
          }
        />
        <ListRow
          title={t("connections:reconnect")}
          onPress={() => void reconnect()}
        />
      </ListGroup>
      <ListGroup title={t("connections:privateInbox")}>
        <ListRow
          title={t(
            roles.inbox.length
              ? "connections:inboxPublished"
              : "connections:noPublishedInbox",
          )}
          value={lists ? String(roles.inbox.length) : t("common:unknown")}
        />
        <PreferenceToggle
          title={t("connections:incomingCalls")}
          value={incomingCalls}
          onChange={(enabled) => {
            if (!busy) void change({ list: "incomingCalls", enabled });
          }}
        />
      </ListGroup>
      <SettingsDescription>{t("connections:rolesHelp")}</SettingsDescription>
      {error ? <SettingsDescription>{error}</SettingsDescription> : null}
      {busy ? (
        <SettingsDescription>{t("connections:saving")}</SettingsDescription>
      ) : null}
      <ListGroup title={t("connections:savedRelays")}>
        {addresses.map((url) => {
          const state = runtime === "ready" ? statusByUrl.get(url) : undefined;
          const independent = signalStates[url];
          const show = expanded === url;
          const enabled = (["general", "inbox", "discovery"] as const).filter(
            (role) => roles[role].includes(url),
          );
          const unavailable =
            lists &&
            enabled.some((role) => role !== "discovery") &&
            !lists.allowed.some((entry) => normalize(entry) === url);
          return (
            <View key={url}>
              <ListRow
                title={url}
                detail={[
                  ...enabled.map((role) => t(`connections:${role}`)),
                  ...(bootstrap.includes(url)
                    ? [t("connections:bootstrap")]
                    : []),
                ].join(" · ")}
                trailing={
                  <Icon
                    name={show ? "collapse" : "expand"}
                    size={18}
                    color={colors.muted}
                  />
                }
                expanded={show}
                onPress={() => setExpanded(show ? undefined : url)}
              />
              {show ? (
                <View style={[styles.detail, { borderTopColor: colors.line }]}>
                  <Ink kind="caption" muted selectable style={styles.address}>
                    {url}
                  </Ink>
                  <ListRow
                    title={t("connections:marmot")}
                    value={t(statusLabels[state?.status ?? "unknown"])}
                  />
                  <ListRow
                    title={t("connections:independent")}
                    value={t(statusLabels[independent ?? "unknown"])}
                  />
                  {state?.lastAttempt ? (
                    <SettingsDescription>
                      {t("connections:lastAttempt")}{" "}
                      {formatDateTime(
                        state.lastAttempt * 1_000,
                        resolveLanguage(i18n.resolvedLanguage),
                      )}
                    </SettingsDescription>
                  ) : null}
                  {state?.lastError ? (
                    <SettingsDescription>{state.lastError}</SettingsDescription>
                  ) : null}
                  {unavailable ? (
                    <SettingsDescription>
                      {t("connections:relayPolicy")}
                    </SettingsDescription>
                  ) : null}
                  {(["general", "inbox", "discovery"] as const).map((role) => (
                    <PreferenceToggle
                      key={role}
                      title={t(`connections:${role}`)}
                      value={roles[role].includes(url)}
                      onChange={(value) => {
                        if (!busy && lists) toggle(role, url, value);
                      }}
                    />
                  ))}
                  <ListRow
                    title={t("connections:reconnect")}
                    onPress={() => void reconnect(url)}
                  />
                </View>
              ) : null}
            </View>
          );
        })}
        {addresses.length === 0 ? (
          <ListRow title={t("connections:empty")} />
        ) : null}
      </ListGroup>
      <ListGroup title={t("connections:add")}>
        <View style={styles.input}>
          <GlassInput
            label={t("connections:address")}
            placeholder="wss://relay.example"
            value={input}
            onChangeText={(value) => {
              setInput(value);
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
            disabled={busy || !lists || !input.trim()}
            onPress={add}
          >
            {t("connections:addAction")}
          </Action>
          {inputError ? (
            <SettingsDescription>{inputError}</SettingsDescription>
          ) : null}
        </View>
      </ListGroup>
      <ListGroup>
        <ListRow
          title={t("connections:restoreDefaults")}
          onPress={() => {
            if (busy || !lists) return;
            void dialog.show({
              title: t("connections:restoreConfirm"),
              message: t("connections:restoreHint"),
              dismissible: false,
              actions: [
                { label: t("common:cancel"), tone: "cancel" },
                {
                  label: t("connections:restore"),
                  tone: "primary",
                  onSelect: () =>
                    void change({
                      list: "restore",
                    }),
                },
              ],
            });
          }}
        />
      </ListGroup>
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
});
