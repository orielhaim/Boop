import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Modal, ScrollView, View } from "react-native";
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
  const { t } = useTranslation(["settings", "common"]);
  const [rtl, setRtl] = useState(false);
  return (
    <Modal onRequestClose={close} animationType="none">
      <Screen compact topInset>
        <View style={styles.header}>
          <Ink kind="screenTitle" accessibilityRole="header">
            {t("settings:designLab")}
          </Ink>
          <IconButton label={t("common:close")} icon="close" onPress={close} />
        </View>
        <ListGroup>
          <PreferenceToggle title="RTL" value={rtl} onChange={setRtl} />
        </ListGroup>
        <View style={[styles.catalog, rtl && styles.rtl]}>
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
    </Modal>
  );
}

function isTypeRole(role: string): role is keyof typeof themes.light.type {
  return Object.hasOwn(themes.light.type, role);
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
  rtl: { direction: "rtl" },
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
