import * as React from "react";
import { StyleSheet, Text, TextInput, View } from "react-native";

import { useThemedStyles } from "../mobile-theme-context";
import type { ThemeTokens } from "../mobile-theme";

import type { FormFieldProps } from "./FormField.types";

// Re-export the type surface from the JSX module so existing callers can
// `import { FormField, type FormFieldProps } from ".../FormField"` without
// remembering the sibling `.types` file. The canonical declaration still
// lives in `FormField.types.ts` so non-rendering consumers do not pull JSX.
export type { FormFieldProps } from "./FormField.types";

// Keep the touch target at least 44 density-independent pixels.
const MIN_TOUCH_TARGET = 44 as const;

/**
 * Stylesheet factory — invoked through `useThemedStyles` so styles refresh
 * whenever the active tokens change (theme mode swap, density swap, etc.).
 * Keeps the component body focused on layout + state wiring and lets the
 * theme system stay the single source of truth for visual values.
 *
 * Tone resolution per element:
 *  - input bg     → tokens.color.control       (canonical input fill, both modes)
 *  - input border → tokens.color.border        (default, swapped to danger on error)
 *  - label text   → tokens.color.text          (default, swapped to dangerFg on error)
 *  - hint text    → tokens.color.textMuted     (canonical "supporting text" tone)
 *  - error text   → tokens.color.dangerFg      (matches StatusChip/EmptyState pattern)
 *  - disabled     → opacity 0.5 overlay (mirrors AppButton inert-state styling)
 */
export function buildFormFieldStyles(tokens: ThemeTokens) {
  return StyleSheet.create({
    container: {
      // Vertical stack: label | row | supporting text. Aligned to the start so
      // multi-line wraps stay left-anchored even when the parent stretches.
      flexDirection: "column",
      alignItems: "stretch",
      // Inter-element gap — spacing.xs keeps the label/input/supporting trio
      // visually grouped while still giving each row its own band.
      gap: tokens.spacing.xs,
    },
    label: {
      fontFamily: tokens.font.sans,
      fontSize: tokens.font.scale.sm,
      fontWeight: "600",
      letterSpacing: 0.2,
      color: tokens.color.text,
    },
    labelError: {
      // Override applied on top of `label` when error is present.
      color: tokens.color.dangerFg,
    },
    row: {
      flexDirection: "row",
      alignItems: "center",
      borderWidth: 1,
      borderStyle: "solid",
      borderColor: tokens.color.border,
      borderRadius: tokens.radius.md,
      backgroundColor: tokens.color.control,
      paddingHorizontal: tokens.spacing.md,
      // Gap between adornments and the input — same spacing tier as
      // AppButton's icon/label gap so primitives stay rhythmically aligned.
      gap: tokens.spacing.sm,
      // WCAG 2.5.5 floor for the input row regardless of single/multi line.
      minHeight: MIN_TOUCH_TARGET,
    },
    rowError: {
      // Override applied on top of `row` when error is present. The danger
      // tone is reused from the StatusChip/AppButton palette so the tone is
      // consistent across primitives (single token swap).
      borderColor: tokens.color.danger,
    },
    rowDisabled: {
      // Mute opacity matches AppButton.disabled (0.5) so the inert visual
      // language is uniform across primitives.
      opacity: 0.5,
    },
    input: {
      // flex:1 lets the input claim all remaining horizontal space inside
      // the row after the adornments are laid out.
      flex: 1,
      paddingVertical: tokens.spacing.sm,
      fontFamily: tokens.font.sans,
      fontSize: tokens.font.scale.lg,
      color: tokens.color.controlText,
      // includeFontPadding is Android-only; without it Android adds extra
      // space around the glyph baseline and the row visually appears taller
      // than iOS for the same content.
      includeFontPadding: false,
    },
    adornment: {
      // Slot wrapper exists so the gap rule above always sees a sibling
      // (an empty fragment would not get gapped).
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "center",
    },
    hint: {
      fontFamily: tokens.font.sans,
      fontSize: tokens.font.scale.xs,
      color: tokens.color.textMuted,
    },
    error: {
      fontFamily: tokens.font.sans,
      fontSize: tokens.font.scale.xs,
      color: tokens.color.dangerFg,
      fontWeight: "600",
    },
  });
}

/**
 * Compose the accessibilityHint string from supporting text. Error supersedes
 * hint visually AND in the announcement so screen-reader users get the same
 * priority signal as sighted users. Returns `undefined` when there is no
 * supporting text so the hint prop is omitted (avoids announcing an empty
 * string on iOS).
 */
function resolveAccessibilityHint(
  hint: string | undefined,
  error: string | null | undefined,
): string | undefined {
  if (error) return error;
  if (hint) return hint;
  return undefined;
}

/**
 * FormField — the canonical primitive. See module header for invariants.
 */
export function FormField(props: FormFieldProps): React.JSX.Element {
  const {
    label,
    value,
    onChangeText,
    placeholder,
    hint,
    error = null,
    disabled = false,
    secureTextEntry = false,
    autoComplete,
    keyboardType,
    autoCapitalize,
    autoCorrect,
    spellCheck,
    maxLength,
    multiline = false,
    numberOfLines,
    leftAdornment,
    rightAdornment,
    testID = "form-field",
    accessibilityLabel,
  } = props;

  const styles = useThemedStyles(buildFormFieldStyles);

  // Error supersedes hint when both are present. We keep both props in
  // scope so toggling error off restores the hint without forcing the
  // caller to re-pass it.
  const hasError = Boolean(error);

  // Inert when disabled. Mirrors AppButton's inert-press gate — callers do
  // not need to defensively no-op `onChangeText` themselves.
  const handleChangeText = (next: string): void => {
    if (disabled) return;
    onChangeText(next);
  };

  // a11y: derive the supporting hint announcement once so the container View
  // and the underlying TextInput stay in sync (TextInput's own
  // accessibilityHint would only fire on focus; the container hint announces
  // alongside the label discovery).
  const a11yHint = resolveAccessibilityHint(hint, error);

  return (
    <View
      testID={testID}
      accessibilityLabel={accessibilityLabel ?? label}
      accessibilityHint={a11yHint}
      style={styles.container}
    >
      <Text
        testID={`${testID}-label`}
        style={[styles.label, hasError ? styles.labelError : null]}
        numberOfLines={1}
      >
        {label}
      </Text>
      <View
        style={[
          styles.row,
          hasError ? styles.rowError : null,
          disabled ? styles.rowDisabled : null,
        ]}
      >
        {leftAdornment ? (
          <View testID={`${testID}-adornment-left`} style={styles.adornment}>
            {leftAdornment}
          </View>
        ) : null}
        <TextInput
          testID={`${testID}-input`}
          value={value}
          onChangeText={handleChangeText}
          placeholder={placeholder}
          editable={!disabled}
          // Avoid selecting the entire value on password inputs to keep sensitive text out of the selection UI.
          secureTextEntry={secureTextEntry}
          autoComplete={autoComplete}
          keyboardType={keyboardType}
          autoCapitalize={autoCapitalize}
          autoCorrect={autoCorrect}
          spellCheck={spellCheck}
          maxLength={maxLength}
          multiline={multiline}
          numberOfLines={numberOfLines}
          style={styles.input}
          // The TextInput surfaces its own a11y label so screen readers can
          // discover it independently inside the row (e.g. when swiping
          // through controls). The container View label still anchors the
          // group announcement.
          accessibilityLabel={accessibilityLabel ?? label}
        />
        {rightAdornment ? (
          <View testID={`${testID}-adornment-right`} style={styles.adornment}>
            {rightAdornment}
          </View>
        ) : null}
      </View>
      {hasError ? (
        <Text testID={`${testID}-error`} style={styles.error}>
          {error}
        </Text>
      ) : hint ? (
        <Text testID={`${testID}-hint`} style={styles.hint}>
          {hint}
        </Text>
      ) : null}
    </View>
  );
}
