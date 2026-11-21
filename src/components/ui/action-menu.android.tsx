import {
  DropdownMenu,
  DropdownMenuItem,
  Host,
  RNHostView,
  SelectableDropdownMenuItem,
  Text,
} from "@expo/ui/jetpack-compose";
import { useState } from "react";
import { Pressable, View } from "react-native";
import type { ActionMenuProps } from "./action-menu";
import { useTheme } from "@/theme";

const popupProperties = { clippingEnabled: true, focusable: true };

export function ActionMenu({
  label,
  value,
  style,
  actions,
  onSelect,
  children,
}: ActionMenuProps) {
  const { colors, theme } = useTheme();
  const [open, setOpen] = useState(false);

  return (
    <View style={style}>
      <Host matchContents colorScheme={theme} seedColor={colors.accent}>
        <DropdownMenu
          expanded={open}
          onDismissRequest={() => setOpen(false)}
          properties={popupProperties}
          color={colors.surface}
          cornerRadius={16}
        >
          <DropdownMenu.Trigger>
            <RNHostView matchContents>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={label}
                accessibilityValue={{ text: value }}
                accessibilityState={{ expanded: open }}
                onPress={() => setOpen(true)}
              >
                {children}
              </Pressable>
            </RNHostView>
          </DropdownMenu.Trigger>
          <DropdownMenu.Items>
            {actions.map(({ id, title, state, attributes }, index) => {
              const select = () => {
                setOpen(false);
                onSelect(id ?? title);
              };
              if (state !== undefined) {
                return (
                  <SelectableDropdownMenuItem
                    key={id ?? title}
                    selected={state === "on"}
                    shapes={{ index, count: actions.length }}
                    colors={{
                      textColor: colors.text,
                      containerColor: colors.surface,
                      selectedTextColor: colors.text,
                      selectedContainerColor: colors.accentSoft,
                    }}
                    onClick={select}
                  >
                    <SelectableDropdownMenuItem.Text>
                      <Text>{title}</Text>
                    </SelectableDropdownMenuItem.Text>
                    <SelectableDropdownMenuItem.SelectedLeadingIcon>
                      <Text>{"✓"}</Text>
                    </SelectableDropdownMenuItem.SelectedLeadingIcon>
                  </SelectableDropdownMenuItem>
                );
              }
              return (
                <DropdownMenuItem
                  key={id ?? title}
                  onClick={select}
                  elementColors={
                    attributes?.destructive
                      ? { textColor: colors.danger }
                      : undefined
                  }
                >
                  <DropdownMenuItem.Text>
                    <Text>{title}</Text>
                  </DropdownMenuItem.Text>
                </DropdownMenuItem>
              );
            })}
          </DropdownMenu.Items>
        </DropdownMenu>
      </Host>
    </View>
  );
}
