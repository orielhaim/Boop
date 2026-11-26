import { useState, useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";
import { ActivityIndicator, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { GlassInput } from "@/components/glassyui/glass-input";
import { useDialog } from "@/components/ui/dialog";
import { Action, Ink } from "@/components/ui/kit";
import { PreferenceToggle } from "@/components/ui/list-group";
import {
  validDeviceLabel,
  type DeviceLinkSnapshot,
} from "@/core/marmot/device-contract";
import { useTheme } from "@/theme";
import {
  DeviceBadge,
  DeviceCard,
  DeviceChange,
  DeviceError,
  DeviceHeading,
  DeviceHeroImage,
  formatActivity,
  type DeviceController,
} from "./presentation";

type Prompt = DeviceLinkSnapshot["prompts"][number];
type Joining = NonNullable<DeviceLinkSnapshot["newDevice"]>;
type Comparison = Extract<Joining, { kind: "comparing" }>["code"];

function EmojiComparison({ code }: { code: Comparison }) {
  const { t } = useTranslation("devices");
  return (
    <>
      <DeviceHeading title={t("compare")} detail={t("compareHelp")} />
      <View
        style={styles.emojiStrip}
        accessible
        accessibilityLabel={code.map((item) => item.description).join(", ")}
      >
        {code.map(({ emoji }, index) => (
          <Ink key={index} style={styles.emoji} importantForAccessibility="no">
            {emoji}
          </Ink>
        ))}
      </View>
    </>
  );
}

function PairingPrompt({
  prompt,
  controller,
  busy,
  onDone,
}: {
  prompt: Prompt;
  controller: DeviceController;
  busy: boolean;
  onDone?: () => void;
}) {
  const { t, i18n } = useTranslation(["devices", "common"]);
  const [label, setLabel] = useState("");
  const [allChats, setAllChats] = useState(true);
  const [history, setHistory] = useState(true);
  const [error, setError] = useState<unknown>();
  const state = prompt.state;
  if (state.kind === "comparing") {
    const code = state.code.map((item) => item.emoji);
    return (
      <DeviceCard center>
        <EmojiComparison code={state.code} />
        <GlassInput
          label={t("devices:name")}
          value={label}
          onChangeText={setLabel}
        />
        {label.trim() && !validDeviceLabel(label, false) && (
          <Ink muted>{t("devices:nameTooLong")}</Ink>
        )}
        <PreferenceToggle
          title={t("devices:addChats")}
          detail={t("devices:addChatsHelp")}
          value={allChats}
          onChange={setAllChats}
          disabled={busy}
        />
        <PreferenceToggle
          title={t("devices:history")}
          detail={t("devices:historyHelp")}
          value={allChats && history}
          onChange={setHistory}
          disabled={busy || !allChats}
        />
        <DeviceError error={error} />
        <Action
          size="lg"
          variant="prominent"
          disabled={busy || !validDeviceLabel(label, false)}
          onPress={() => {
            setError(undefined);
            void controller
              .linkDevice(
                prompt.promptId,
                code,
                label.trim(),
                allChats,
                history,
              )
              .catch(setError);
          }}
        >
          {t("devices:link")}
        </Action>
        <Action
          variant="ghost"
          disabled={busy}
          onPress={() =>
            void controller.declineLink(prompt.promptId).catch(setError)
          }
        >
          {t("devices:notNow")}
        </Action>
      </DeviceCard>
    );
  }
  let title: string;
  switch (state.kind) {
    case "preparing":
      title = t("devices:preparing");
      break;
    case "competingRequests":
      title = t("devices:competingRequests");
      break;
    case "rateLimited":
      title = t("devices:rateLimited", {
        date: formatActivity(state.retryAt, i18n.resolvedLanguage),
      });
      break;
    case "cannotLink":
      title = t("devices:cannotLink");
      break;
    case "tooManyDevices":
      title = t("devices:tooManyDevices");
      break;
    case "linking":
      title = t("devices:linking");
      break;
    case "linked":
      title = t("devices:linked");
      break;
    case "addedElsewhere":
      title = t("devices:addedElsewhere", {
        device: state.deviceLabel || t("devices:unknownDevice"),
        other: state.addedByLabel || t("devices:unknownDevice"),
      });
      break;
    case "ended":
      title = t(
        state.reason.kind === "unsupported" ? "unknown" : state.reason.kind,
      );
      break;
    default:
      title = t("devices:unknown");
  }
  return (
    <DeviceCard center hero>
      <View style={styles.badge}>
        <DeviceBadge
          size={66}
          mode={
            state.kind === "linked" || state.kind === "addedElsewhere"
              ? "success"
              : undefined
          }
        />
      </View>
      <DeviceHeading
        title={title}
        detail={state.kind === "linked" ? t("devices:linkedHelp") : undefined}
      />
      <DeviceError error={error} />
      {(state.kind === "preparing" || state.kind === "linking") && (
        <ActivityIndicator />
      )}
      {state.kind === "preparing" && (
        <Action
          variant="ghost"
          disabled={busy}
          onPress={() =>
            void controller.declineLink(prompt.promptId).catch(setError)
          }
        >
          {t("devices:notNow")}
        </Action>
      )}
      {onDone && (
        <Action variant="soft" onPress={onDone}>
          {t("common:close")}
        </Action>
      )}
    </DeviceCard>
  );
}

export function DevicePairing({
  controller,
  promptId,
  onDone,
  move,
  onPrompt,
}: {
  controller: DeviceController;
  promptId?: string;
  onDone?: () => void;
  move?: boolean;
  onPrompt?: (id: string) => void;
}) {
  const { t } = useTranslation(["devices", "common"]);
  const dialog = useDialog();
  const { colors } = useTheme();
  const {
    projections: { pairing, roster },
    operation,
  } = useSyncExternalStore(controller.subscribe, controller.getState);
  const [error, setError] = useState<unknown>();
  const [moveRequested, setMoveRequested] = useState(false);
  const busy = operation !== null;
  const state = pairing?.newDevice;

  if (promptId) {
    const prompt = pairing?.prompts.find((row) => row.promptId === promptId);
    return prompt ? (
      <PairingPrompt
        key={prompt.promptId}
        prompt={prompt}
        controller={controller}
        busy={busy}
        onDone={onDone}
      />
    ) : (
      <DeviceCard center>
        <DeviceHeading
          title={t(pairing ? "devices:pairingChanged" : "devices:loading")}
        />
      </DeviceCard>
    );
  }

  function cancel() {
    void dialog.show({
      title: t("devices:cancelLink"),
      message: t("devices:cancelLinkHelp"),
      actions: [
        { label: t("common:close"), tone: "cancel" },
        {
          label: t("devices:cancelLink"),
          tone: "danger",
          onSelect: () => void controller.cancelLink().catch(setError),
        },
      ],
    });
  }

  if (state?.kind === "comparing") {
    const code = state.code.map(({ emoji }) => emoji);
    return (
      <DeviceCard center>
        <EmojiComparison code={state.code} />
        <DeviceError error={error} />
        <Action
          size="lg"
          variant="prominent"
          disabled={busy}
          onPress={() => {
            setError(undefined);
            void controller.confirmMatch(code).catch(setError);
          }}
        >
          {t("devices:match")}
        </Action>
        <Action variant="ghost" disabled={busy} onPress={cancel}>
          {t("devices:mismatch")}
        </Action>
      </DeviceCard>
    );
  }

  const moving = move && !moveRequested;
  const canStart =
    pairing &&
    !pairing.deviceGroupStalled &&
    roster &&
    (move || roster.length === 0) &&
    (!state || state.kind === "ended" || (moving && state.kind === "linked"));
  const waiting =
    state?.kind === "waitingForAnswer" ||
    state?.kind === "waitingForOtherDevice" ||
    state?.kind === "joining";
  let title: string;
  let detail: string | undefined;
  switch (state?.kind) {
    case "waitingForAnswer":
      title = t("devices:waitForAnswer");
      detail = t("devices:waitForAnswerHelp");
      break;
    case "waitingForOtherDevice":
      title = t("devices:waitForOther");
      break;
    case "joining":
      title = t("devices:joining");
      break;
    case "linked":
      title = t(moving ? "devices:move" : "devices:linked");
      detail = t(moving ? "devices:moveHelp" : "devices:linkedHelp");
      break;
    case "ended":
      title = t(
        state.reason.kind === "unsupported" ? "unknown" : state.reason.kind,
      );
      break;
    case undefined:
      title = t(
        pairing?.deviceGroupStalled
          ? "devices:stalled"
          : pairing && roster
            ? moving
              ? "devices:move"
              : "devices:available"
            : "devices:loading",
      );
      detail =
        pairing && roster && !pairing.deviceGroupStalled
          ? t(moving ? "devices:moveHelp" : "devices:linkFromNewDevice")
          : undefined;
      break;
    default:
      title = t("devices:unknown");
  }
  return (
    <DeviceCard center hero>
      {state?.kind !== "linked" && <DeviceHeroImage />}
      {state?.kind === "linked" && (
        <DeviceChange>
          <View style={styles.badge}>
            <DeviceBadge size={76} mode="success" />
          </View>
        </DeviceChange>
      )}
      <DeviceHeading title={title} detail={detail} />
      <DeviceError error={error} />
      {(waiting || busy || !pairing) && (
        <ActivityIndicator color={colors.accent} />
      )}
      {canStart && (
        <Action
          size="lg"
          variant="prominent"
          disabled={busy}
          onPress={() => {
            setError(undefined);
            void controller.startLink().then(() => {
              if (move) setMoveRequested(true);
            }, setError);
          }}
        >
          {t(
            state?.kind === "ended"
              ? "devices:retry"
              : move
                ? "devices:link"
                : "devices:startHere",
          )}
        </Action>
      )}
      {waiting && (
        <Action variant="ghost" disabled={busy} onPress={cancel}>
          {t("devices:cancelLink")}
        </Action>
      )}
      {onPrompt &&
        pairing?.prompts
          .filter(
            ({ state: incoming }) =>
              incoming.kind === "preparing" || incoming.kind === "comparing",
          )
          .map((prompt) => (
            <Action
              key={prompt.promptId}
              variant="soft"
              onPress={() => onPrompt(prompt.promptId)}
            >
              {t("devices:request")}
            </Action>
          ))}
      {onDone && (
        <Action variant="soft" onPress={onDone}>
          {t("common:close")}
        </Action>
      )}
    </DeviceCard>
  );
}

const styles = StyleSheet.create((theme) => ({
  badge: { alignItems: "center", marginVertical: theme.space.md },
  emojiStrip: {
    direction: "ltr",
    flexDirection: "row",
    flexWrap: "wrap",
    justifyContent: "center",
    padding: theme.space.sm,
    gap: theme.space.sm,
    backgroundColor: theme.colors.recessed,
    borderRadius: theme.radius.input,
  },
  emoji: {
    fontSize: 30,
    lineHeight: 44,
    writingDirection: "ltr",
    textAlign: "center",
  },
}));
