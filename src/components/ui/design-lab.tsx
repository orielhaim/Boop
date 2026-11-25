import { useState } from "react";
import { useTranslation } from "react-i18next";
import { ScrollView, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { GlassAvatar } from "@/components/glassyui/glass-avatar";
import { GlassSurface } from "@/components/glassyui/glass-surface";
import {
  GlassBackdropProvider,
  GlassBackdropTarget,
  useGlassBackdropTarget,
} from "@/components/glassyui/lib/glass-backdrop";
import {
  ListGroup,
  ListRow,
  PreferenceToggle,
} from "@/components/ui/list-group";
import {
  CategoryIcon,
  settingsCategories,
} from "@/components/ui/category-icon";
import { Icon, iconNames } from "@/components/ui/icon";
import { DialogModal, useDialog } from "@/components/ui/dialog";
import { CountBadge } from "@/components/kinetik/count-badge";
import {
  Action,
  Empty,
  IconButton,
  Ink,
  Screen,
  Search,
  Section,
} from "@/components/ui/kit";
import { themes, type ThemeName } from "@/theme/tokens";

export default function DesignLabEntry() {
  const { t } = useTranslation("settings");
  const [open, setOpen] = useState(false);
  return (
    <>
      <Action onPress={() => setOpen(true)}>{t("designLab")}</Action>
      {open && <DesignLab close={() => setOpen(false)} />}
    </>
  );
}

function DesignLab({ close }: { close: () => void }) {
  const { t, i18n } = useTranslation(["settings", "common"]);
  const [rtl, setRtl] = useState(i18n.dir() === "rtl");
  return (
    <DialogModal onRequestClose={close} animationType="none">
      <Screen compact topInset>
        <View style={styles.header}>
          <Ink kind="screenTitle" accessibilityRole="header">
            {t("settings:designLab")}
          </Ink>
          <IconButton label={t("common:close")} icon="close" onPress={close} />
        </View>
        <View style={[styles.catalog, { direction: rtl ? "rtl" : "ltr" }]}>
          <ListGroup>
            <PreferenceToggle
              title="RTL"
              value={rtl}
              onChange={setRtl}
              rtl={rtl}
            />
          </ListGroup>
          <InteractionDemo rtl={rtl} />
          <CountBadgeDemo />
          {(["light", "dark"] satisfies ThemeName[]).map((theme) => (
            <View key={theme} style={styles.catalog}>
              <Section>{t(`settings:${theme}`)}</Section>
              <View style={styles.tiles}>
                {Object.entries(themes[theme].colors).map(([name, color]) => (
                  <View key={name} style={styles.tile}>
                    <View style={[styles.swatch, { backgroundColor: color }]} />
                    <Ink kind="meta">{name}</Ink>
                    <Ink kind="meta" muted>
                      {color}
                    </Ink>
                  </View>
                ))}
              </View>
            </View>
          ))}
          <Section>{t("settings:designLabType")}</Section>
          {Object.keys(themes.light.type)
            .filter(isTypeRole)
            .map((role) => (
              <Ink key={role} kind={role}>
                {role}
              </Ink>
            ))}
          <Section>{t("settings:designLabIcons")}</Section>
          <View style={styles.tiles}>
            {settingsCategories.map((category) => (
              <CategoryIcon key={category} category={category} />
            ))}
          </View>
          <View style={styles.tiles}>
            {iconNames.map((name) => (
              <View key={name} style={styles.tile}>
                <Icon name={name} />
                <Ink kind="meta">{name}</Ink>
              </View>
            ))}
          </View>
          <View style={styles.tiles}>
            {(["sm", "md", "lg", "xl"] as const).map((size) => (
              <GlassAvatar
                key={size}
                name="Boop"
                identityKey={size}
                size={size}
              />
            ))}
          </View>
          <ListGroup title={t("settings:designLabControls")}>
            <ListRow title={t("settings:appearance")} onPress={() => {}} />
            <ListRow
              title={t("settings:privacy")}
              disabled
              onPress={() => {}}
            />
          </ListGroup>
          <Search placeholder={t("settings:designLabControls")} />
          <Search placeholder={t("settings:designLabControls")} invalid />
          <Empty
            icon="info"
            title={t("settings:designLab")}
            detail={t("settings:designLabControls")}
          />
          <GlassBackdropProvider>
            <MaterialDemo />
          </GlassBackdropProvider>
          <Action variant="soft" onPress={close}>
            {t("common:close")}
          </Action>
        </View>
      </Screen>
    </DialogModal>
  );
}

function InteractionDemo({ rtl }: { rtl: boolean }) {
  const { t } = useTranslation(["settings", "common"]);
  const dialog = useDialog();
  const [value, setValue] = useState(true);
  return (
    <>
      <ListGroup title={t("settings:designLabSwitches")}>
        <PreferenceToggle
          title={t("settings:designLabSwitchControlled")}
          value={value}
          onChange={setValue}
          rtl={rtl}
        />
        <PreferenceToggle
          title={t("settings:designLabSwitchDisabled")}
          value={!value}
          onChange={setValue}
          disabled
          rtl={rtl}
        />
        <ListRow
          title={t("settings:designLabSwitchExternal")}
          onPress={() => setValue((previous) => !previous)}
        />
      </ListGroup>
      <ListGroup title={t("settings:designLabDialogs")}>
        <ListRow
          title={t("settings:designLabDialogQueue")}
          onPress={() => {
            void dialog.show({
              title: t("settings:designLabDialogs"),
              message: t("settings:designLabDialogQueueDetail"),
            });
            void dialog.show({ title: t("settings:designLabDialogNext") });
          }}
        />
        <ListRow
          title={t("settings:designLabDialogConfirm")}
          onPress={() =>
            void dialog.show({
              title: t("settings:designLabDialogConfirm"),
              message: t("settings:designLabDialogConfirmDetail"),
              dismissible: false,
              actions: [
                { label: t("common:cancel"), tone: "cancel" },
                { label: t("common:remove"), tone: "danger" },
              ],
            })
          }
        />
        <ListRow
          title={t("settings:designLabDialogFailure")}
          onPress={() =>
            void dialog.show({
              title: t("settings:designLabDialogFailure"),
              tone: "error",
              actions: [
                { label: t("common:cancel"), tone: "cancel" },
                {
                  label: t("common:retry"),
                  async run() {
                    await new Promise((resolve) => setTimeout(resolve, 700));
                    throw new Error("Design Lab simulated a failed action");
                  },
                },
              ],
            })
          }
        />
      </ListGroup>
    </>
  );
}

function isTypeRole(role: string): role is keyof typeof themes.light.type {
  return Object.hasOwn(themes.light.type, role);
}

function CountBadgeDemo() {
  const { t } = useTranslation(["settings", "messages"]);
  const [count, setCount] = useState(0);
  return (
    <ListGroup title={t("settings:designLabBadge")}>
      <ListRow
        title={t("settings:designLabBadgeAdd")}
        detail={t("messages:unreadCount", { count })}
        leading={
          <CountBadge count={count} size="compact">
            <Icon name="chat" size={26} />
          </CountBadge>
        }
        onPress={() => setCount((value) => value + 1)}
      />
      <ListRow
        title={t("settings:designLabBadgeClear")}
        disabled={count === 0}
        onPress={() => setCount(0)}
      />
    </ListGroup>
  );
}

function MaterialDemo() {
  const { t } = useTranslation("settings");
  const target = useGlassBackdropTarget();
  const [blur, setBlur] = useState(true);
  return (
    <View style={styles.catalog}>
      <ListGroup dividers="none">
        <PreferenceToggle
          title={t("designLabGlass")}
          value={blur}
          onChange={setBlur}
        />
      </ListGroup>
      <View style={styles.material}>
        <GlassBackdropTarget>
          <ScrollView
            horizontal
            contentContainerStyle={styles.materialContents}
          >
            {Array.from({ length: 18 }, (_, index) => (
              <CategoryIcon
                key={index}
                category={settingsCategories[index % settingsCategories.length]}
              />
            ))}
          </ScrollView>
        </GlassBackdropTarget>
        <View pointerEvents="none" style={styles.glassOverlay}>
          <GlassSurface
            blurTarget={blur ? (target ?? undefined) : undefined}
            style={styles.glassLabel}
          >
            <Ink kind="control">{t("designLabGlass")}</Ink>
          </GlassSurface>
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create(({ space, radius }) => ({
  header: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    gap: space.md,
  },
  catalog: { gap: space.md },
  tile: { minWidth: 72, gap: space.xs, alignItems: "center" },
  tiles: { flexDirection: "row", flexWrap: "wrap", gap: space.md },
  swatch: { height: 36, width: 60, borderRadius: radius.small },
  material: { height: 112 },
  materialContents: { alignItems: "center", gap: space.sm },
  glassOverlay: {
    ...StyleSheet.absoluteFill,
    alignItems: "center",
    justifyContent: "center",
  },
  glassLabel: { padding: space.lg, borderRadius: radius.round },
}));
