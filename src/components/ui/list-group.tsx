import { Children, type ComponentProps, type ReactNode } from "react";
import { Platform, Pressable, Switch, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { Icon, Ink, Section, tapFeedback } from "@/components/ui/kit";
import { useTheme } from "@/theme";

type Dividers = "none" | "inset" | "full";

export function ListGroup({
  title,
  children,
  dividers = "inset",
}: {
  title?: string;
  children: ReactNode;
  dividers?: Dividers;
}) {
  return (
    <View style={styles.group}>
      {title && <Section>{title}</Section>}
      <View style={styles.card}>
        {Children.map(Children.toArray(children), (child, index) => (
          <>
            {index > 0 && dividers !== "none" && (
              <View
                style={[
                  styles.divider,
                  dividers === "inset"
                    ? styles.insetDivider
                    : styles.fullDivider,
                ]}
              />
            )}
            {child}
          </>
        ))}
      </View>
    </View>
  );
}

export function SettingsDescription({ children }: { children: ReactNode }) {
  return (
    <Ink
      kind="description"
      muted
      style={styles.description}
      accessibilityLiveRegion="polite"
    >
      {children}
    </Ink>
  );
}

export function ListRow({
  title,
  detail,
  value,
  icon,
  onPress,
  onTitlePress,
  selected,
  selectionRole = "radio",
  expanded,
  disabled = false,
  leading,
  trailing,
  showChevron = true,
}: {
  title: string;
  detail?: string;
  value?: string;
  icon?: ComponentProps<typeof Icon>["name"];
  onPress?: () => void;
  onTitlePress?: () => void;
  selected?: boolean;
  selectionRole?: "radio" | "checkbox";
  expanded?: boolean;
  disabled?: boolean;
  leading?: ReactNode;
  trailing?: ReactNode;
  showChevron?: boolean;
}) {
  const { colors } = useTheme();
  const label = (
    <>
      <Ink kind="rowTitle">{title}</Ink>
      {detail && (
        <Ink kind="description" muted numberOfLines={2}>
          {detail}
        </Ink>
      )}
    </>
  );
  const content = (
    <>
      {leading ??
        (icon && (
          <View style={styles.icon}>
            <Icon name={icon} size={19} />
          </View>
        ))}
      {onTitlePress ? (
        <Pressable
          accessibilityRole="button"
          style={[styles.label, styles.titleTrigger]}
          onPress={() => {
            tapFeedback();
            onTitlePress();
          }}
        >
          {label}
        </Pressable>
      ) : (
        <View style={styles.label}>{label}</View>
      )}
      {value && (
        <Ink kind="control" muted style={styles.value}>
          {value}
        </Ink>
      )}
      {selected ? (
        <Icon name="check" size={18} />
      ) : (
        (trailing ??
        (onPress && showChevron && selected === undefined ? (
          <Icon name="next" size={17} color={colors.muted} />
        ) : null))
      )}
    </>
  );
  return onPress ? (
    <Pressable
      disabled={disabled}
      accessibilityRole={selected === undefined ? "button" : selectionRole}
      accessibilityState={{ disabled, expanded, checked: selected }}
      onPress={() => {
        tapFeedback();
        onPress();
      }}
      style={({ pressed }) => [
        styles.row,
        disabled && styles.disabled,
        selected && { backgroundColor: colors.selected },
        pressed && !disabled && { backgroundColor: colors.pressed },
      ]}
    >
      {content}
    </Pressable>
  ) : (
    <View style={styles.row}>{content}</View>
  );
}

export function PreferenceToggle({
  title,
  detail,
  value,
  onChange,
  disabled,
  icon,
  onTitlePress,
}: {
  title: string;
  detail?: string;
  value: boolean;
  onChange: (value: boolean) => void;
  disabled?: boolean;
  icon?: ComponentProps<typeof Icon>["name"];
  onTitlePress?: () => void;
}) {
  const { colors } = useTheme();
  return (
    <ListRow
      title={title}
      detail={detail}
      icon={icon}
      onTitlePress={onTitlePress}
      trailing={
        <Switch
          accessibilityLabel={title}
          value={value}
          onValueChange={onChange}
          disabled={disabled}
          trackColor={{ false: colors.line, true: colors.accent }}
          thumbColor={
            Platform.OS === "android"
              ? value
                ? colors.onAccent
                : colors.raised
              : undefined
          }
        />
      }
    />
  );
}

const styles = StyleSheet.create((theme) => ({
  group: { gap: theme.space.sm },
  card: {
    backgroundColor: theme.colors.grouped,
    borderRadius: theme.radius.group,
    overflow: "hidden",
  },
  divider: {
    height: StyleSheet.hairlineWidth,
    backgroundColor: theme.colors.line,
  },
  insetDivider: { marginHorizontal: theme.space.lg },
  fullDivider: { marginHorizontal: 0 },
  row: {
    minHeight: 68,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.space.md,
    paddingHorizontal: theme.space.lg,
    paddingVertical: theme.space.sm,
  },
  disabled: { opacity: 0.5 },
  icon: {
    backgroundColor: theme.colors.selected,
    width: 38,
    height: 38,
    borderRadius: theme.radius.control,
    alignItems: "center",
    justifyContent: "center",
  },
  label: { flex: 1, gap: theme.space.xs },
  titleTrigger: { minHeight: 44, justifyContent: "center" },
  value: { flexShrink: 1, maxWidth: "48%" },
  description: { marginHorizontal: theme.space.sm },
}));
