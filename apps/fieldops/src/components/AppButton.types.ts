/** Shared button variants and props are available to non-rendering callers without importing React Native or theme context. */

import type * as React from "react";

/**
 * Visual + tonal surface for the button. Each variant maps to a distinct
 * background/foreground/border triple resolved through `useTheme()` inside
 * the component (see `buildAppButtonStyles`). Adding a new variant requires
 * extending `buildAppButtonStyles` so the exhaustive switch keeps holding.
 */
export type AppButtonVariant =
  | "primary"
  | "secondary"
  | "ghost"
  | "destructive"
  | "swipe-cta";

/**
 * Density preset. Drives height, horizontal padding, and label font size.
 * The component clamps the rendered height to a 44dp minimum regardless of
 * the requested size so the WCAG 2.5.5 target-size policy is honored even
 * when callers request the visually compact `sm` preset.
 */
export type AppButtonSize = "sm" | "md" | "lg";

/** Icon-only buttons require an accessible label. Use the shared Icon component for token-driven glyphs. */
export type AppButtonProps = {
  /** Visible button text. Always supplied so the bare component carries semantic meaning. */
  label: string;
  /** Visual + tonal surface. Defaults to `primary`. */
  variant?: AppButtonVariant;
  /** Density preset. Defaults to `md` (44dp WCAG-aligned). */
  size?: AppButtonSize;
  /** Press handler. Skipped when `disabled` or `loading` is true. */
  onPress: () => void;
  /** Visually mute the button + skip onPress + announce `disabled` to a11y. */
  disabled?: boolean;
  /** Replace the label with a loading indicator + announce `busy` to a11y. */
  loading?: boolean;
  /** Optional leading glyph. Prefer the shared Icon component. */
  leftIcon?: React.ReactNode;
  /** Optional trailing glyph. Prefer the shared Icon component. */
  rightIcon?: React.ReactNode;
  /** Override the default `app-button` testID. Suffixed for nested nodes. */
  testID?: string;
  /** Override the default a11y label (defaults to the visible `label`). */
  accessibilityLabel?: string;
  /** Stretch the button to fill its parent's width. */
  fullWidth?: boolean;
};
