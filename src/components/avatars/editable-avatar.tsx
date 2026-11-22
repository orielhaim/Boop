import type { MenuAction } from "@expo/ui/community/menu";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { StyleSheet, View } from "react-native";
import { ActionMenu } from "@/components/ui/action-menu";
import { Icon, Ink, tapFeedback } from "@/components/ui/kit";
import { namespaces } from "@/i18n";
import { useTheme } from "@/theme";
import type { AvatarPhotoSource } from "./picker";

export function EditableAvatar({
  disabled = false,
  showLabel = false,
  onPick,
  onRemove,
  children,
}: {
  disabled?: boolean;
  showLabel?: boolean;
  onPick: (source: AvatarPhotoSource) => void;
  onRemove?: () => void;
  children: ReactNode;
}) {
  const { t } = useTranslation(namespaces);
  const { colors } = useTheme();
  const picture = (
    <View
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={showLabel ? styles.labeled : undefined}
    >
      <View>
        {children}
        {!disabled && (
          <View
            style={[
              styles.badge,
              {
                backgroundColor: colors.outgoing,
                borderColor: colors.background,
              },
            ]}
          >
            <Icon name="edit" size={13} color={colors.outgoingInk} />
          </View>
        )}
      </View>
      {showLabel && (
        <Ink
          kind="caption"
          style={[
            styles.caption,
            { color: disabled ? colors.muted : colors.accent },
          ]}
        >
          {t("settings:photoChange")}
        </Ink>
      )}
    </View>
  );
  if (disabled) return picture;
  const actions: MenuAction[] = [
    {
      id: "gallery",
      title: t("settings:photoGallery"),
      image: "photo.on.rectangle",
    },
    { id: "camera", title: t("settings:photoCamera"), image: "camera" },
  ];
  if (onRemove)
    actions.push({
      id: "remove",
      title: t("settings:photoRemove"),
      image: "trash",
      attributes: { destructive: true },
    });
  return (
    <ActionMenu
      label={t("settings:photoChange")}
      actions={actions}
      onSelect={(id) => {
        tapFeedback();
        if (id === "gallery" || id === "camera") onPick(id);
        if (id === "remove") onRemove?.();
      }}
    >
      {picture}
    </ActionMenu>
  );
}

const styles = StyleSheet.create({
  labeled: { alignItems: "center", gap: 4, maxWidth: 92 },
  caption: { textAlign: "center", fontWeight: "600" },
  badge: {
    position: "absolute",
    end: 0,
    bottom: 0,
    height: 27,
    width: 27,
    borderRadius: 14,
    borderWidth: 2,
    alignItems: "center",
    justifyContent: "center",
  },
});
