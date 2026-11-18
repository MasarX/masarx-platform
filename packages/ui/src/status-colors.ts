/**
 * Shared status-to-CSS-color mapping for charts, maps, and badges.
 *
 * Colors reference CSS custom properties so they adapt to the active theme.
 * This module is the single source of truth for status color resolution;
 * callers should import from here instead of maintaining inline maps.
 *
 * Status-tone mappings are resolved from lookup_values metadata via
 * {@link resolveStatusConfig}; this module provides the tone-to-CSS-color
 * translation layer.
 */

import { resolveStatusIcon } from "./status-icon";

export const NEUTRAL_COLOR = "rgb(var(--ui-muted))";

/** Tone-to-CSS-color mapping using design-system custom properties. */
export const TONE_COLORS: Record<string, string> = {
  success: "rgb(var(--ui-success))",
  warning: "rgb(var(--ui-warning))",
  danger: "rgb(var(--ui-danger))",
  info: "rgb(var(--ui-info))",
  accent: "rgb(var(--ui-accent))",
  neutral: NEUTRAL_COLOR,
};

/**
 * Resolve a CSS color string for a status key by deriving the tone
 * from `resolveStatusIcon` and mapping it to the design-system palette.
 *
 * Returns a neutral fallback when the status is unrecognized.
 */
export function resolveStatusToneColor(status: string | null | undefined): string {
  const resolved = resolveStatusIcon(status);
  const tone = resolved?.tone ?? "neutral";
  return TONE_COLORS[tone] ?? NEUTRAL_COLOR;
}
