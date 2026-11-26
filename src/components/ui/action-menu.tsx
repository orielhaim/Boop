import { MenuView, type MenuAction } from "@expo/ui/community/menu";
import type { ReactNode } from "react";
import { type StyleProp, View, type ViewStyle } from "react-native";
import type { IconName } from "@/components/ui/icon";
import { useTheme } from "@/theme";

export type ActionMenuProps = {
  label: string;
  value?: string;
  style?: StyleProp<ViewStyle>;
  actions: (MenuAction & { icon?: IconName })[];
  onSelect: (id: string) => void;
  children: ReactNode;
};

export function ActionMenu({
  label,
  value,
  style,
  actions,
  onSelect,
  children,
}: ActionMenuProps) {
  const { theme } = useTheme();
  return (
    <MenuView
      style={style}
      colorScheme={theme}
      actions={actions.map(({ icon: _icon, ...action }) => action)}
      onPressAction={({ nativeEvent }) => onSelect(nativeEvent.event)}
    >
      <View
        accessible
        accessibilityRole="button"
        accessibilityLabel={label}
        accessibilityValue={{ text: value }}
      >
        {children}
      </View>
    </MenuView>
  );
}
