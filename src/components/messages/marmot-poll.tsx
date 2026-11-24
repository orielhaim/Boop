import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Alert, Modal, View } from "react-native";
import { GlassInput } from "@/components/glassyui/glass-input";
import { PreferenceToggle } from "@/components/ui/list-group";
import { Action, Ink, Screen } from "@/components/ui/kit";
import { marmot, type MarmotMessage } from "@/core/marmot/native";
import { namespaces } from "@/i18n";
import { space } from "@/theme";
import { useMarmotError } from "./marmot-group";

export function MarmotPollComposer({
  group,
  cancel,
  canSend,
}: {
  group: string;
  cancel: () => void;
  canSend: () => boolean;
}) {
  const { t } = useTranslation(namespaces);
  const error = useMarmotError();
  const [question, setQuestion] = useState("");
  const [options, setOptions] = useState("");
  const [hours, setHours] = useState("");
  const [multiple, setMultiple] = useState(false);
  const [working, setWorking] = useState(false);
  async function create() {
    const labels = [
      ...new Set(
        options
          .split("\n")
          .map((label) => label.trim())
          .filter(Boolean),
      ),
    ];
    if (
      working ||
      !canSend() ||
      !question.trim() ||
      labels.length < 2 ||
      labels.length > 10 ||
      (hours && !/^\d{1,4}$/.test(hours))
    )
      return;
    const expires =
      hours && Number(hours) > 0
        ? Math.floor(Date.now() / 1_000) + Number(hours) * 3_600
        : null;
    setWorking(true);
    try {
      await marmot.createPoll(
        group,
        question.trim(),
        labels,
        multiple,
        expires,
      );
      cancel();
    } catch (reason) {
      Alert.alert(error(reason));
    } finally {
      setWorking(false);
    }
  }
  return (
    <Modal
      animationType="slide"
      presentationStyle="pageSheet"
      onRequestClose={cancel}
    >
      <Screen>
        <Ink kind="title">{t("messages:marmot.newPoll")}</Ink>
        <GlassInput
          label={t("messages:marmot.pollQuestion")}
          value={question}
          onChangeText={setQuestion}
          maxLength={500}
        />
        <GlassInput
          label={t("messages:marmot.pollOptions")}
          value={options}
          onChangeText={setOptions}
          multiline
          maxLength={1500}
        />
        <GlassInput
          label={t("messages:marmot.pollExpires")}
          value={hours}
          onChangeText={setHours}
          keyboardType="number-pad"
          maxLength={4}
        />
        <PreferenceToggle
          title={t("messages:marmot.pollMultiple")}
          value={multiple}
          onChange={setMultiple}
        />
        <Action
          onPress={() => void create()}
          disabled={
            working || !question.trim() || options.trim().split("\n").length < 2
          }
        >
          {t("messages:marmot.newPoll")}
        </Action>
        <Action variant="ghost" onPress={cancel} disabled={working}>
          {t("common:cancel")}
        </Action>
      </Screen>
    </Modal>
  );
}

export function MarmotPoll({
  group,
  row,
  canSend,
}: {
  group: string;
  row: MarmotMessage;
  canSend: () => boolean;
}) {
  const { t } = useTranslation(namespaces);
  const error = useMarmotError();
  const [busy, setBusy] = useState(false);
  const poll = row.poll;
  if (!poll) return null;
  async function vote(id: string) {
    if (!poll || !poll.open || !row.sourceId || !canSend() || busy) return;
    const selected = poll.multiple
      ? poll.selected.includes(id)
        ? poll.selected.filter((item) => item !== id)
        : [...poll.selected, id]
      : [id];
    if (!selected.length) return;
    setBusy(true);
    try {
      await marmot.vote(group, row.sourceId, selected);
    } catch (reason) {
      Alert.alert(error(reason));
    } finally {
      setBusy(false);
    }
  }
  return (
    <View style={{ padding: space.sm, gap: space.xs }}>
      <Ink>{poll.question}</Ink>
      {poll.options.map((option) => (
        <Action
          key={option.id}
          size="sm"
          variant={poll.selected.includes(option.id) ? "prominent" : "soft"}
          disabled={!poll.open || !row.sourceId || busy || !canSend()}
          onPress={() => void vote(option.id)}
        >
          {option.name} · {option.votes}
        </Action>
      ))}
      {!poll.open && (
        <Ink kind="caption">{t("messages:marmot.pollClosed")}</Ink>
      )}
    </View>
  );
}
