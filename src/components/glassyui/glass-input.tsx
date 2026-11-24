import type { ComponentRef } from "react";
import { forwardRef, useCallback, useState } from "react";
import {
  Text,
  TextInput,
  View,
  type BlurEvent,
  type FocusEvent,
  type TextInputProps,
} from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { useGlassTheme } from "./glass-provider";

export type GlassInputProps = TextInputProps & {
  /** A line of muted text under the field. With `invalid` it turns the invalid colour. */
  hint?: string;
  /** Marks the value as wrong: the field's ring and its hint turn the invalid colour. */
  invalid?: boolean;
  /** Text above the field. It also names the field for screen readers. */
  label?: string;
  compact?: boolean;
};

/**
 * A recessed text field with an optional label above and hint below. It fills in while focused,
 * without a ring, and rings in the invalid colour while `invalid`; `editable={false}` dims it.
 */
export const GlassInput = forwardRef<
  ComponentRef<typeof TextInput>,
  GlassInputProps
>(
  (
    {
      editable = true,
      compact = false,
      hint,
      invalid = false,
      label,
      onBlur,
      onFocus,
      style,
      ...rest
    },
    ref,
  ) => {
    const { colors } = useGlassTheme();
    const [focused, setFocused] = useState(false);
    const variant = styles.useVariants({
      compact,
      state: invalid ? "invalid" : focused ? "focused" : "resting",
    });

    const handleFocus = useCallback(
      (event: FocusEvent) => {
        setFocused(true);
        onFocus?.(event);
      },
      [onFocus],
    );

    const handleBlur = useCallback(
      (event: BlurEvent) => {
        setFocused(false);
        onBlur?.(event);
      },
      [onBlur],
    );

    // The field carries the label and hint for screen readers, so the visible text is hidden
    // from them rather than read twice.
    return (
      <View style={variant.field}>
        {label ? (
          <Text
            accessibilityElementsHidden
            importantForAccessibility="no"
            style={variant.label}
          >
            {label}
          </Text>
        ) : null}
        <TextInput
          ref={ref}
          accessibilityHint={hint}
          accessibilityLabel={label}
          accessibilityState={{ disabled: !editable }}
          editable={editable}
          onBlur={handleBlur}
          onFocus={handleFocus}
          placeholderTextColor={colors.mutedForeground}
          underlineColorAndroid="transparent"
          style={[variant.input, !editable && variant.disabled, style]}
          {...rest}
        />
        {hint ? (
          <Text
            accessibilityElementsHidden
            importantForAccessibility="no"
            style={variant.hint}
          >
            {hint}
          </Text>
        ) : null}
      </View>
    );
  },
);

GlassInput.displayName = "GlassInput";

const styles = StyleSheet.create(({ glass, space, radius, type }) => ({
  disabled: { opacity: 0.45 },
  field: {
    alignSelf: "stretch",
    gap: space.sm,
    variants: { compact: { true: { gap: space.xs } } },
  },
  hint: {
    ...type.meta,
    color: glass.mutedForeground,
    variants: { state: { invalid: { color: glass.invalid } } },
  },
  input: {
    ...type.body,
    borderCurve: "continuous",
    borderRadius: radius.control,
    borderWidth: 1,
    borderColor: glass.border,
    color: glass.foreground,
    backgroundColor: glass.controlSurface,
    boxShadow: glass.wellShadow,
    minHeight: 44,
    paddingHorizontal: space.lg,
    paddingVertical: space.md,
    variants: {
      compact: {
        true: {
          paddingHorizontal: space.md,
          paddingVertical: space.sm,
          borderRadius: space.md,
        },
      },
      state: {
        resting: {},
        focused: {
          backgroundColor: glass.focusedSurface,
          borderColor: glass.focusRing,
        },
        invalid: { borderColor: glass.invalid },
      },
    },
    compoundVariants: [
      { compact: true, state: "focused", styles: { boxShadow: "none" } },
    ],
  },
  label: { ...type.description, color: glass.mutedForeground },
}));
