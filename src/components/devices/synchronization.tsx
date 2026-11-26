import { router } from "expo-router";
import { useTranslation } from "react-i18next";
import { View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { Ink } from "@/components/ui/kit";
import {
  ListGroup,
  ListRow,
  SettingsDescription,
} from "@/components/ui/list-group";
import { conversationRoute } from "@/components/messages/marmot-inbox";
import { useChatsEnabled } from "@/services/local-context";
import { useTheme } from "@/theme";
import {
  DeviceCard,
  formatActivity,
  type DeviceController,
} from "./presentation";

export function DeviceSynchronization({
  state,
}: {
  state: ReturnType<DeviceController["getState"]>;
}) {
  const { t, i18n } = useTranslation("devices");
  const { colors } = useTheme();
  const chatsEnabled = useChatsEnabled();
  const {
    projections: {
      pairing,
      history,
      closedChats,
      leftoverChats,
      roster,
      recovery,
    },
  } = state;
  const progress = pairing?.chatProgress;

  return (
    <>
      <DeviceCard>
        <Ink kind="heading" accessibilityRole="header">
          {t("sync")}
        </Ink>
        {!progress?.length && <Ink muted>{t("noProgress")}</Ink>}
        {progress?.map((entry) => {
          const device = roster?.find(
            (row) => row.slotIdHex === entry.slotIdHex,
          );
          const done = Math.max(0, entry.total - entry.remaining);
          return (
            <View
              key={`${entry.slotIdHex}-${entry.onNewDevice}`}
              style={styles.progress}
            >
              {device?.label && <Ink kind="rowTitle">{device.label}</Ink>}
              <Ink muted>
                {t(entry.onNewDevice ? "syncingNew" : "syncingOther", {
                  done,
                  total: entry.total,
                })}
              </Ink>
              {entry.total > 0 && (
                <View accessible={false} style={styles.track}>
                  <View
                    style={[
                      styles.fill,
                      {
                        width: `${(100 * done) / entry.total}%`,
                        backgroundColor: colors.accent,
                      },
                    ]}
                  />
                </View>
              )}
            </View>
          );
        })}
      </DeviceCard>
      <ListGroup title={t("history")}>
        {!history?.length && (
          <SettingsDescription>
            {t(history ? "noHistory" : "loading")}
          </SettingsDescription>
        )}
        {history?.map((entry) => {
          const stage = entry.state;
          const title =
            stage.kind === "imported"
              ? t("historyImported", {
                  date: formatActivity(stage.at, i18n.resolvedLanguage),
                })
              : stage.kind === "receiving"
                ? t(stage.retrying ? "historyRetrying" : "historyReceiving")
                : t("unknown");
          const source =
            stage.kind === "imported" && stage.from.deviceLabel
              ? t("historyFrom", { name: stage.from.deviceLabel })
              : undefined;
          return (
            <ListRow
              key={entry.groupIdHex}
              icon="chat"
              title={title}
              detail={source}
              onPress={
                chatsEnabled
                  ? () => router.push(conversationRoute(entry.groupIdHex))
                  : undefined
              }
            />
          );
        })}
      </ListGroup>
      {recovery &&
        (recovery.inboxCatchingUp ||
          recovery.catchingUpGroupIdsHex.length > 0 ||
          recovery.notices.length > 0) && (
          <DeviceCard>
            <Ink kind="rowTitle">{t("recovery")}</Ink>
            {recovery.inboxCatchingUp && <Ink muted>{t("recoveryInbox")}</Ink>}
            {recovery.catchingUpGroupIdsHex.length > 0 && (
              <Ink muted>
                {t("recoveryCatchingUp", {
                  count: recovery.catchingUpGroupIdsHex.length,
                })}
              </Ink>
            )}
            {recovery.notices.length > 0 && (
              <Ink muted>
                {t("recoveryIncomplete", { count: recovery.notices.length })}
              </Ink>
            )}
          </DeviceCard>
        )}
      {(Boolean(closedChats) || Boolean(leftoverChats)) && (
        <DeviceCard>
          {!!closedChats && (
            <Ink>{t("closedChats", { count: closedChats })}</Ink>
          )}
          {!!leftoverChats && (
            <>
              <Ink>{t("leftoverChats", { count: leftoverChats })}</Ink>
              <Ink muted>{t("leftoverHelp")}</Ink>
            </>
          )}
        </DeviceCard>
      )}
    </>
  );
}

const styles = StyleSheet.create((theme) => ({
  progress: { gap: theme.space.sm },
  track: {
    height: 5,
    backgroundColor: theme.colors.recessed,
    borderRadius: 5,
    overflow: "hidden",
  },
  fill: { height: "100%", borderRadius: 5 },
}));
