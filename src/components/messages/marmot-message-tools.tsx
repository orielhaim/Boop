import { acceptedAttachments } from "@/core/marmot/message-projection";
import { randomUUID } from "expo-crypto";
import { sendMarmotAttachment } from "@/core/marmot/send-attachment";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Alert, ScrollView, StyleSheet, View } from "react-native";
import { Action, Ink, Row } from "@/components/ui/kit";
import {
  marmot,
  type MarmotEditHistory,
  type MarmotMessage,
  type MarmotSearchResult,
} from "@/core/marmot/native";
import { namespaces } from "@/i18n";
import { useLocal } from "@/services/local-context";
import { space } from "@/theme";
import { useMarmotError } from "./marmot-group";
import { useMarmotWindow } from "./marmot-window";
import type { useMentionMembers } from "./use-mention-members";

export function MentionMember({
  roster,
  query,
  onSelect,
}: {
  roster: ReturnType<typeof useMentionMembers>;
  query: string;
  onSelect(npub: string): void;
}) {
  const { t } = useTranslation(namespaces);
  const { privacy } = useLocal();
  const term = query.trim().toLowerCase();
  const members = (roster.members ?? []).filter(
    ({ self, id, label, npub }) =>
      !self &&
      !privacy.isBlocked(id) &&
      (label.toLowerCase().includes(term) || npub.includes(term)),
  );
  return (
    <View
      accessibilityLabel={t("messages:marmot.mentionSuggestions")}
      style={styles.mentions}
    >
      {roster.failed ? (
        <Action size="sm" onPress={roster.retry}>
          {t("common:retry")}
        </Action>
      ) : roster.members && !members.length ? (
        <Ink style={styles.mentionStatus}>{t("messages:marmot.noResults")}</Ink>
      ) : !roster.members ? (
        <Ink style={styles.mentionStatus}>{t("common:checking")}</Ink>
      ) : null}
      <ScrollView
        keyboardShouldPersistTaps="handled"
        style={styles.mentionResults}
      >
        {members.map(({ id, npub, label }) => (
          <Row
            key={id}
            title={label}
            onPress={() => {
              if (!privacy.isBlocked(id)) onSelect(npub);
            }}
          />
        ))}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  mentions: { marginHorizontal: space.sm },
  mentionResults: { maxHeight: 160 },
  mentionStatus: { padding: space.sm },
});

export function ConversationSearch({
  group,
  media,
  query,
  onSelect,
}: {
  group: string;
  media: boolean;
  query: string;
  onSelect(id: string, query: string): void;
}) {
  const { t } = useTranslation(namespaces);
  const { privacy, chatPreferences } = useLocal();
  const [result, setResult] = useState<{
    group: string;
    media: boolean;
    term: string;
    rows?: MarmotSearchResult[];
    failed?: boolean;
  }>();
  const term = query.trim();
  useEffect(() => {
    if (!term && !media) return;
    let active = true;
    const job = setTimeout(() => {
      void marmot
        .searchConversation(group, term || null, media)
        .then((rows) => {
          if (active) setResult({ group, media, term, rows });
        })
        .catch(() => {
          if (active) setResult({ group, media, term, failed: true });
        });
    }, 220);
    return () => {
      active = false;
      clearTimeout(job);
    };
  }, [group, media, term]);
  const hidden = new Set(chatPreferences.hidden(group));
  const latest =
    result?.group === group && result.media === media && result.term === term
      ? result
      : undefined;
  const visible = latest?.rows?.filter(
    (row) => !hidden.has(row.id) && !privacy.isBlocked(row.sender),
  );
  return (
    <View>
      {latest?.failed && <Ink>{t("messages:marmot.operationError")}</Ink>}
      {visible?.length === 0 && <Ink>{t("messages:marmot.noResults")}</Ink>}
      <ScrollView
        keyboardShouldPersistTaps="handled"
        style={{ maxHeight: 240 }}
      >
        {visible?.map((row) => (
          <Action
            key={row.id}
            size="sm"
            onPress={() => onSelect(row.id, query.trim())}
          >
            {row.text.trim().slice(0, 140) ||
              t("messages:marmot.mediaAndFiles")}
          </Action>
        ))}
      </ScrollView>
    </View>
  );
}

export function MessageEditHistory({
  group,
  message,
  onClose,
}: {
  group: string;
  message: string;
  onClose(): void;
}) {
  const { t } = useTranslation(namespaces);
  const [history, setHistory] = useState<MarmotEditHistory>();
  const [busy, setBusy] = useState(false);
  const load = useCallback(
    async (before?: { id: string; at: number }) => {
      setBusy(true);
      try {
        const page = await marmot.editHistory(group, message, before);
        setHistory((old) => ({
          versions:
            before && old ? [...old.versions, ...page.versions] : page.versions,
          more: page.more,
        }));
      } catch {
        Alert.alert(t("messages:editHistoryUnavailable"));
      } finally {
        setBusy(false);
      }
    },
    [group, message, t],
  );
  useEffect(() => {
    let active = true;
    void marmot
      .editHistory(group, message)
      .then((page) => {
        if (active) setHistory(page);
      })
      .catch(() => {
        if (active) Alert.alert(t("messages:editHistoryUnavailable"));
      });
    return () => {
      active = false;
    };
  }, [group, message, t]);
  const oldest = history?.versions.at(-1);
  return (
    <View style={{ padding: space.sm }}>
      <Ink kind="title">{t("messages:editHistory")}</Ink>
      <ScrollView style={{ maxHeight: 240 }}>
        {history?.versions.map((version) => (
          <View key={version.id} style={{ marginBottom: space.sm }}>
            <Ink kind="caption">
              {new Date(version.at * 1_000).toLocaleString()}
            </Ink>
            <Ink>{version.text}</Ink>
          </View>
        ))}
      </ScrollView>
      {history?.more && oldest && (
        <Action size="sm" disabled={busy} onPress={() => void load(oldest)}>
          {t("messages:marmot.loadMore")}
        </Action>
      )}
      <Action size="sm" onPress={onClose}>
        {t("common:close")}
      </Action>
    </View>
  );
}

export function ForwardMessage({
  group,
  row,
  canDispatch,
  onClose,
}: {
  group: string;
  row: MarmotMessage;
  canDispatch(): boolean;
  onClose(): void;
}) {
  const { t } = useTranslation(namespaces);
  const { privacy, mediaSdk } = useLocal();
  const open = useCallback(() => marmot.openChatList("chats"), []);
  const { snapshot, window, error } = useMarmotWindow(open);
  const [busy, setBusy] = useState(false);
  const translateError = useMarmotError();
  const attempt = useRef<AbortController>(undefined);
  const tokens = useRef(new Map<string, string>());
  useEffect(() => () => attempt.current?.abort(), []);
  async function send(destination: string, peer: string | null | undefined) {
    if (
      attempt.current ||
      busy ||
      !canDispatch() ||
      privacy.isBlocked(row.sender) ||
      (peer && privacy.isBlocked(peer))
    )
      return;
    const abort = new AbortController();
    attempt.current = abort;
    setBusy(true);
    const leases: string[] = [];
    try {
      const details = await marmot.groupAccess(destination);
      if (
        details.membership !== "member" ||
        details.pendingInvitation ||
        details.unrecoverable ||
        !canDispatch()
      )
        return;
      if (row.attachments.length && row.sourceId) {
        const files = [];
        for (const item of acceptedAttachments(row)) {
          if (!canDispatch() || privacy.isBlocked(row.sender)) return;
          const file = await marmot.openAttachment(
            group,
            row.id,
            row.sourceId,
            item.index,
          );
          if (!file) {
            Alert.alert(t("messages:marmot.downloadToForward"));
            return;
          }
          leases.push(file.lease);
          files.push({
            path: file.path,
            name: file.name,
            type: file.type,
            dimensions: item.dimensions ?? undefined,
            thumbhash: item.thumbhash ?? undefined,
            duration: item.duration == null ? undefined : String(item.duration),
            waveform: item.waveform?.join(","),
            presentation: item.round
              ? ("round" as const)
              : item.voice
                ? ("voice" as const)
                : undefined,
          });
        }
        const token = tokens.current.get(destination) ?? randomUUID();
        tokens.current.set(destination, token);
        if (
          canDispatch() &&
          !privacy.isBlocked(row.sender) &&
          !abort.signal.aborted
        )
          await sendMarmotAttachment({
            sdk: mediaSdk,
            group: destination,
            source: { kind: "files", files, saveDraft: false },
            caption: row.text || null,
            token,
            reply: null,
            allowed: () =>
              !abort.signal.aborted &&
              canDispatch() &&
              !privacy.isBlocked(row.sender) &&
              (!peer || !privacy.isBlocked(peer)),
            signal: abort.signal,
            progress: () => undefined,
            mirrorFailed: () => Alert.alert(t("messages:mediaMirrorFailed")),
          });
      } else if (row.eventKind === 24883) {
        await marmot.sendSpecial(destination, row.eventKind, row.text, null);
      } else if (row.eventKind === 9 || row.eventKind === 1111) {
        await marmot.sendText(destination, row.text, randomUUID(), null);
      } else {
        return;
      }
      onClose();
    } catch (reason) {
      if (!abort.signal.aborted) Alert.alert(translateError(reason));
    } finally {
      await Promise.allSettled(
        leases.map((lease) => marmot.releaseAttachment(lease)),
      );
      if (attempt.current === abort) attempt.current = undefined;
      setBusy(false);
    }
  }
  return (
    <View style={{ padding: space.sm }}>
      <Ink kind="title">{t("messages:marmot.forwardTo")}</Ink>
      {error && <Ink>{t("messages:marmot.accountError")}</Ink>}
      <ScrollView style={{ maxHeight: 240 }}>
        {snapshot?.rows
          .filter(
            (chat) =>
              chat.id !== group &&
              !chat.invited &&
              chat.membership === "member" &&
              !(chat.peer && privacy.isBlocked(chat.peer)),
          )
          .map((chat) => (
            <Action
              size="sm"
              disabled={busy}
              key={chat.id}
              onPress={() => void send(chat.id, chat.peer)}
            >
              {chat.title || chat.peer || t("messages:marmot.group")}
            </Action>
          ))}
      </ScrollView>
      {snapshot?.hasMoreAfter && (
        <Action
          size="sm"
          onPress={() => void window?.page("forward").catch(() => undefined)}
        >
          {t("messages:marmot.loadMore")}
        </Action>
      )}
      <Action size="sm" onPress={onClose}>
        {t("common:close")}
      </Action>
    </View>
  );
}
