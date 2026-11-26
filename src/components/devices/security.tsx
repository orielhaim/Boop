import { useState } from "react";
import { useTranslation } from "react-i18next";
import { View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { useDialog } from "@/components/ui/dialog";
import { Action, Ink } from "@/components/ui/kit";
import {
  ListGroup,
  ListRow,
  SettingsDescription,
} from "@/components/ui/list-group";
import type {
  CompromiseWarning,
  DeviceSlot,
  UnrecognizedSignIn,
} from "@/core/marmot/device-contract";
import {
  DeviceBadge,
  DeviceCard,
  DeviceError,
  DeviceHeading,
  formatActivity,
  type DeviceController,
} from "./presentation";

export function DeviceSecurity({
  state,
  controller,
  paused,
  onReview,
  onPrompt,
  onRoster,
  onReplaceKey,
}: {
  state: ReturnType<DeviceController["getState"]>;
  controller: DeviceController;
  paused: boolean;
  onReview: (slot: DeviceSlot) => void;
  onPrompt: (prompt: string) => void;
  onRoster: () => void;
  onReplaceKey: () => void;
}) {
  const { t, i18n } = useTranslation(["devices", "common", "security"]);
  const dialog = useDialog();
  const [error, setError] = useState<unknown>();
  const {
    projections: { warnings, signIns, pairing },
    operation,
    discovery,
  } = state;
  const busy = operation !== null || paused;

  function acknowledge() {
    void dialog.show({
      title: t("warningAcknowledge"),
      message: t("warningAcknowledgeHelp"),
      actions: [
        { label: t("common:cancel"), tone: "cancel" },
        {
          label: t("warningAcknowledge"),
          onSelect: () => void controller.acknowledgeWarning().catch(setError),
        },
      ],
    });
  }

  function warningReason({ reason }: CompromiseWarning) {
    if (reason.kind === "rejectedSignIn") return t("warningRejected");
    if (reason.kind === "foreignOwnSlotKeyPackage") return t("warningForeign");
    return t("warningUnknown");
  }

  return (
    <>
      {!!warnings?.length && (
        <DeviceCard center>
          <View style={styles.badge}>
            <DeviceBadge mode="warning" size={64} />
          </View>
          <DeviceHeading title={t("warning")} detail={t("warningHelp")} />
          {warnings.map((warning) => (
            <View
              key={`${warning.slotIdHex}/${warning.occurredAt}/${warning.keyPackageRefHex}`}
              style={styles.evidence}
            >
              <Ink kind="rowTitle">{warningReason(warning)}</Ink>
              <Ink muted kind="description">
                {formatActivity(warning.occurredAt, i18n.resolvedLanguage)}
              </Ink>
              <Ink muted kind="caption" selectable numberOfLines={2}>
                {warning.keyPackageRefHex ?? warning.slotIdHex}
              </Ink>
            </View>
          ))}
          <Action variant="soft" onPress={onRoster}>
            {t("others")}
          </Action>
          <Action variant="ghost" onPress={onReplaceKey}>
            {t("security:importIdentityKey")}
          </Action>
          <Action variant="ghost" disabled={busy} onPress={acknowledge}>
            {t("warningAcknowledge")}
          </Action>
        </DeviceCard>
      )}
      {!!pairing?.prompts.length && (
        <ListGroup title={t("requests")}>
          {pairing.prompts.map((prompt) => (
            <ListRow
              key={prompt.promptId}
              icon="devices"
              title={t("request")}
              detail={formatActivity(prompt.requestedAt, i18n.resolvedLanguage)}
              onPress={() => onPrompt(prompt.promptId)}
            />
          ))}
        </ListGroup>
      )}
      <ListGroup title={t("signIns")}>
        {!signIns?.length && (
          <SettingsDescription>
            {t(
              paused
                ? "pausedHelp"
                : state.failed.includes("signIns")
                  ? "unreadable"
                  : state.connection === "reconnecting"
                    ? "reconnecting"
                    : signIns
                      ? "noSignIns"
                      : "loading",
            )}
          </SettingsDescription>
        )}
        {signIns?.map((record) => (
          <ListRow
            key={record.slotIdHex}
            icon="devices"
            title={record.client || t("unknownClient")}
            detail={
              record.state.kind === "notNow"
                ? t("deferred")
                : record.state.kind === "linkedElsewhere"
                  ? t("linkedElsewhere")
                  : record.state.kind === "rejectedElsewhere"
                    ? t("rejectedElsewhere")
                    : t(record.beforeThisDevice ? "signInOlder" : "signInNew")
            }
            onPress={() => onReview(record.slotIdHex)}
          />
        ))}
        <ListRow
          icon="search"
          title={t("check")}
          disabled={busy}
          onPress={() => {
            setError(undefined);
            void controller.checkSignIns().catch(setError);
          }}
        />
      </ListGroup>
      {discovery === "failed" ? (
        <SettingsDescription>{t("checkFailed")}</SettingsDescription>
      ) : (
        <DeviceError error={error} />
      )}
    </>
  );
}

export function SignInReview({
  record,
  controller,
  busy,
  onDone,
}: {
  record: UnrecognizedSignIn;
  controller: DeviceController;
  busy: boolean;
  onDone: () => void;
}) {
  const { t, i18n } = useTranslation(["devices", "common"]);
  const dialog = useDialog();
  const [error, setError] = useState<unknown>();
  const decided =
    record.state.kind === "rejectedElsewhere" ||
    record.state.kind === "linkedElsewhere";
  const reviewable =
    record.state.kind === "prompt" || record.state.kind === "notNow";
  const answer = (
    response: Parameters<DeviceController["answerSignIn"]>[1],
  ) => {
    setError(undefined);
    void controller
      .answerSignIn(record.slotIdHex, response)
      .then(onDone, setError);
  };
  return (
    <DeviceCard center>
      <View style={styles.badge}>
        <DeviceBadge size={72} />
      </View>
      <DeviceHeading
        title={t(
          record.state.kind === "linkedElsewhere"
            ? "linkedElsewhere"
            : record.state.kind === "rejectedElsewhere"
              ? "rejectedElsewhere"
              : record.state.kind === "unsupported"
                ? "unknown"
                : record.beforeThisDevice
                  ? "signInOlder"
                  : "signInNew",
        )}
        detail={t("signInHelp")}
      />
      <View style={styles.evidence}>
        <Ink kind="rowTitle">
          {t("reportedClient", { name: record.client || t("unknownClient") })}
        </Ink>
        <Ink muted>
          {t("firstSeen", {
            date: formatActivity(record.appearedAt, i18n.resolvedLanguage),
          })}
        </Ink>
        <Ink muted>
          {t("lastSeen", {
            date: formatActivity(record.lastSeenAt, i18n.resolvedLanguage),
          })}
        </Ink>
        <Ink muted>{t(record.signedIn ? "signedIn" : "signedOut")}</Ink>
        {record.previouslyLinkedHere && <Ink muted>{t("knownBefore")}</Ink>}
      </View>
      <DeviceError error={error} />
      {reviewable && (
        <>
          <Action
            size="lg"
            variant="prominent"
            disabled={busy}
            onPress={() =>
              void dialog.show({
                title: t("wasMe"),
                message: t("wasMeHelp"),
              })
            }
          >
            {t("wasMe")}
          </Action>
          <Action
            variant="soft"
            disabled={busy}
            onPress={() =>
              void dialog.show({
                title: t("reject"),
                message: t("rejectHelp"),
                tone: "danger",
                actions: [
                  { label: t("common:cancel"), tone: "cancel" },
                  {
                    label: t("reject"),
                    tone: "danger",
                    onSelect: () => answer("reject"),
                  },
                ],
              })
            }
          >
            {t("notMe")}
          </Action>
          {record.state.kind === "prompt" && (
            <Action
              variant="ghost"
              disabled={busy}
              onPress={() => answer("notNow")}
            >
              {t("notNow")}
            </Action>
          )}
        </>
      )}
      {decided && (
        <Action
          variant="soft"
          disabled={busy}
          onPress={() => answer("dismiss")}
        >
          {t("dismiss")}
        </Action>
      )}
    </DeviceCard>
  );
}

const styles = StyleSheet.create((theme) => ({
  badge: { alignItems: "center", marginBottom: theme.space.sm },
  evidence: {
    backgroundColor: theme.colors.recessed,
    borderRadius: theme.radius.input,
    padding: theme.space.md,
    gap: theme.space.xs,
  },
}));
