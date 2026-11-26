import { useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Pressable, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { GlassInput } from "@/components/glassyui/glass-input";
import { useDialog } from "@/components/ui/dialog";
import { Action, Icon, Ink, tapFeedback } from "@/components/ui/kit";
import {
  ListGroup,
  ListRow,
  PreferenceToggle,
} from "@/components/ui/list-group";
import {
  validDeviceLabel,
  type DeviceSlot,
  type LinkedDevice,
} from "@/core/marmot/device-contract";
import { useTheme } from "@/theme";
import {
  DeviceBadge,
  DeviceCard,
  DeviceChange,
  DeviceError,
  DeviceHeading,
  formatActivity,
  type DeviceController,
} from "./presentation";

export function DeviceRow({
  platform,
  title,
  app,
  status,
  activity,
  onPress,
}: {
  platform?: string;
  title: string;
  app?: string;
  status: string;
  activity?: string;
  onPress?: () => void;
}) {
  const { colors } = useTheme();
  const content = (
    <>
      <DeviceBadge platform={platform} />
      <View style={styles.rowText}>
        <Ink kind="rowTitle">{title}</Ink>
        {app && (
          <Ink kind="description" muted>
            {app}
          </Ink>
        )}
        <Ink kind="caption" muted>
          {activity ? `${status} · ${activity}` : status}
        </Ink>
      </View>
      {onPress && <Icon name="next" color={colors.muted} size={17} />}
    </>
  );
  return (
    <DeviceChange>
      {onPress ? (
        <Pressable
          accessibilityRole="button"
          onPress={() => {
            tapFeedback();
            onPress();
          }}
          style={({ pressed }) => [styles.row, pressed && styles.pressed]}
        >
          {content}
        </Pressable>
      ) : (
        <View style={styles.row}>{content}</View>
      )}
    </DeviceChange>
  );
}

export function RosterRow({
  device,
  onPress,
}: {
  device: LinkedDevice;
  onPress: () => void;
}) {
  const { t, i18n } = useTranslation("devices");
  return (
    <DeviceRow
      platform={device.platform}
      title={
        device.label || t(device.isThisDevice ? "current" : "unknownDevice")
      }
      app={[device.client, device.platform].filter(Boolean).join(" · ")}
      status={
        device.removalPending
          ? t("pending")
          : device.isThisDevice
            ? t("current")
            : t(
                device.status.kind === "unsupported"
                  ? "unknown"
                  : device.status.kind,
              )
      }
      activity={
        device.lastActiveAt == null
          ? t("lastUnknown")
          : t("lastSeen", {
              date: formatActivity(device.lastActiveAt, i18n.resolvedLanguage),
            })
      }
      onPress={onPress}
    />
  );
}

export function useRemoveDevices(
  controller: DeviceController,
  catchError: (error: unknown) => void,
) {
  const dialog = useDialog();
  const { t } = useTranslation(["devices", "common"]);
  return (targets: DeviceSlot[], title: "remove" | "removeOthers") => {
    if (!targets.length) return;
    void dialog.show({
      title: t(title),
      message: t("removeHelp"),
      tone: "danger",
      dismissible: false,
      actions: [
        { label: t("common:cancel"), tone: "cancel" },
        {
          label: t(title),
          tone: "danger",
          onSelect: () =>
            void controller.removeDevices(targets).catch(catchError),
        },
      ],
    });
  };
}

export function DeviceDetails({
  device,
  roster,
  controller,
  busy,
  localActions,
}: {
  device: LinkedDevice;
  roster: LinkedDevice[];
  controller: DeviceController;
  busy: boolean;
  localActions?: ReactNode;
}) {
  const { t, i18n } = useTranslation(["devices", "common"]);
  const [name, setName] = useState<string>();
  const [error, setError] = useState<unknown>();
  const remove = useRemoveDevices(controller, setError);
  const { colors } = useTheme();
  const disabled =
    busy ||
    device.removalPending ||
    device.status.kind === "leaving" ||
    device.status.kind === "moved" ||
    device.status.kind === "unsupported";
  const linkedBy = roster.find(
    (row) => row.slotIdHex === device.linkedBySlotIdHex,
  );
  const update = (patch: Parameters<DeviceController["updateDevice"]>[1]) => {
    setError(undefined);
    void controller.updateDevice(device.slotIdHex, patch).catch(setError);
  };
  return (
    <>
      <DeviceCard center hero>
        <View style={styles.detailBadge}>
          <DeviceBadge platform={device.platform} size={76} />
        </View>
        <DeviceHeading
          title={
            device.label || t(device.isThisDevice ? "current" : "unknownDevice")
          }
          detail={
            [device.client, device.platform].filter(Boolean).join(" · ") ||
            undefined
          }
        />
        <View style={styles.metadata}>
          <Ink
            kind="rowTitle"
            style={{
              color: device.removalPending ? colors.warning : colors.accent,
            }}
          >
            {t(
              device.removalPending
                ? "pending"
                : device.status.kind === "unsupported"
                  ? "unknown"
                  : device.status.kind,
            )}
          </Ink>
          {device.isThisDevice && <Ink muted>{t("current")}</Ink>}
          <Ink muted>
            {t("linkedOn", {
              date: formatActivity(device.linkedAt, i18n.resolvedLanguage),
            })}
          </Ink>
          {device.linkedBySlotIdHex && (
            <Ink muted>
              {t("linkedBy", {
                name:
                  linkedBy?.label || linkedBy?.platform || t("unknownDevice"),
              })}
            </Ink>
          )}
          <Ink muted>
            {device.lastActiveAt == null
              ? t("lastUnknown")
              : t("lastSeen", {
                  date: formatActivity(
                    device.lastActiveAt,
                    i18n.resolvedLanguage,
                  ),
                })}
          </Ink>
          {device.inactive && <Ink muted>{t("onDeviceInactive")}</Ink>}
        </View>
      </DeviceCard>
      {name === undefined ? (
        <ListGroup>
          <ListRow
            title={t("rename")}
            icon="edit"
            disabled={disabled}
            onPress={() => setName(device.label)}
          />
        </ListGroup>
      ) : (
        <DeviceCard>
          <GlassInput label={t("name")} value={name} onChangeText={setName} />
          <Ink muted kind="description">
            {t("nameHelp")}
          </Ink>
          <Action
            disabled={disabled || !validDeviceLabel(name, true)}
            onPress={() => {
              setError(undefined);
              void controller
                .renameDevice(device.slotIdHex, name.trim())
                .then(() => setName(undefined), setError);
            }}
          >
            {t("save")}
          </Action>
          <Action variant="ghost" onPress={() => setName(undefined)}>
            {t("common:cancel")}
          </Action>
        </DeviceCard>
      )}
      <ListGroup title={t("deviceSettings")}>
        <PreferenceToggle
          title={t("addChats")}
          detail={t("addChatsHelp")}
          value={device.addToAllChats}
          onChange={(addToAllChats) => update({ addToAllChats })}
          disabled={disabled}
        />
        <PreferenceToggle
          title={t("history")}
          detail={t("historyHelp")}
          value={device.bringHistory}
          onChange={(bringHistory) => update({ bringHistory })}
          disabled={disabled}
        />
        <PreferenceToggle
          title={t("keep")}
          detail={t("keepHelp")}
          value={device.keepWhileInactive}
          onChange={(keepWhileInactive) => update({ keepWhileInactive })}
          disabled={disabled}
        />
      </ListGroup>
      <DeviceError error={error} />
      {device.isThisDevice ? (
        localActions
      ) : (
        <DeviceDanger
          title={t("remove")}
          disabled={disabled}
          onPress={() => remove([device.slotIdHex], "remove")}
        />
      )}
    </>
  );
}

export function DeviceDanger({
  title,
  onPress,
  disabled,
}: {
  title: string;
  onPress: () => void;
  disabled?: boolean;
}) {
  const { colors } = useTheme();
  return (
    <Pressable
      accessibilityRole="button"
      disabled={disabled}
      accessibilityState={{ disabled }}
      onPress={() => {
        tapFeedback();
        onPress();
      }}
      style={({ pressed }) => [
        styles.danger,
        pressed && styles.pressed,
        disabled && styles.disabled,
      ]}
    >
      <Icon name="warning" size={20} color={colors.danger} />
      <Ink kind="rowTitle" style={{ color: colors.danger }}>
        {title}
      </Ink>
    </Pressable>
  );
}

const styles = StyleSheet.create((theme) => ({
  row: {
    minHeight: 76,
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: theme.space.lg,
    paddingVertical: theme.space.md,
    gap: theme.space.md,
  },
  rowText: { flex: 1, gap: 2 },
  detailBadge: { alignItems: "center", marginBottom: theme.space.sm },
  metadata: {
    padding: theme.space.md,
    gap: theme.space.xs,
    backgroundColor: theme.colors.grouped,
    borderRadius: theme.radius.input,
  },
  danger: {
    minHeight: 50,
    padding: theme.space.lg,
    gap: theme.space.md,
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: theme.colors.grouped,
    borderRadius: theme.radius.group,
  },
  pressed: { backgroundColor: theme.colors.pressed },
  disabled: { opacity: 0.55 },
}));
