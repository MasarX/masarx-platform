// Pure style resolvers for the Mobile V2 primitives kit (FxButton, FxCard,
// FxChip, FxAvatar, FxMetric, FxSectionHead, FxStatusDot, FxStickyAction,
// FxRow, FxCol). Separated from the .tsx components so the colour/sizing
// mappings can be tested directly without rendering JSX.
//
// Source: design bundle project/screens/_kit.jsx FxButton/FxChip/FxCard/
// FxAvatar/FxMetric/FxSectionHead/FxStatusDot/FxStickyAction. Token names and
// values match the source verbatim.

import {
  MOBILE_V2_FONT_MONO,
  MOBILE_V2_FONT_SANS,
  MOBILE_V2_RADII,
  MOBILE_V2_SPACING,
  MOBILE_V2_TYPE_LETTER_SPACING,
  MOBILE_V2_TYPE_SIZES,
  MOBILE_V2_TYPE_WEIGHTS,
  type MobileV2Theme,
} from "./mobile-v2-themes";

// ---------------------------------------------------------------------------
// FxChip
// ---------------------------------------------------------------------------

export type FxChipTone =
  | "neutral"
  | "accent"
  | "success"
  | "warning"
  | "danger"
  | "info"
  | "chrome";

export interface FxChipColors {
  readonly background: string;
  readonly foreground: string;
  readonly border: string;
}

export function resolveFxChipColors(theme: MobileV2Theme, tone: FxChipTone): FxChipColors {
  // Toned chips render a flat soft fill with no visible ring: the design
  // `_kit.jsx` FxChip tone map sets `bd: 'transparent'` for every toned
  // case. Only `neutral` carries a real 1px `border` hairline.
  switch (tone) {
    case "accent":
      return { background: theme.accentSoft, foreground: theme.accent, border: "transparent" };
    case "success":
      return { background: theme.successSoft, foreground: theme.success, border: "transparent" };
    case "warning":
      return { background: theme.warningSoft, foreground: theme.warning, border: "transparent" };
    case "danger":
      return { background: theme.dangerSoft, foreground: theme.danger, border: "transparent" };
    case "info":
      return { background: theme.infoSoft, foreground: theme.info, border: "transparent" };
    case "chrome":
      return { background: theme.chrome, foreground: theme.onChrome, border: "transparent" };
    case "neutral":
    default:
      return { background: theme.surfaceAlt, foreground: theme.inkSoft, border: theme.border };
  }
}

export interface FxChipTypography {
  readonly fontSize: number;
  readonly fontWeight: "400" | "500" | "600" | "700";
  readonly letterSpacing: number;
  readonly fontFamily: string;
  readonly paddingHorizontal: number;
  readonly paddingVertical: number;
  readonly minHeight: number;
}

export function resolveFxChipTypography(input: {
  readonly dense?: boolean;
  readonly mono?: boolean;
}): FxChipTypography {
  const dense = input.dense === true;
  return {
    fontSize: dense ? MOBILE_V2_TYPE_SIZES.chipDense : MOBILE_V2_TYPE_SIZES.chip,
    fontWeight: MOBILE_V2_TYPE_WEIGHTS.semibold,
    letterSpacing: MOBILE_V2_TYPE_LETTER_SPACING.chip,
    fontFamily: input.mono === true ? MOBILE_V2_FONT_MONO : MOBILE_V2_FONT_SANS,
    paddingHorizontal: dense ? MOBILE_V2_SPACING.lg : MOBILE_V2_SPACING.xl,
    paddingVertical: dense ? MOBILE_V2_SPACING.xs : MOBILE_V2_SPACING.sm,
    minHeight: dense ? 18 : 22,
  };
}

// ---------------------------------------------------------------------------
// FxButton
// ---------------------------------------------------------------------------

export type FxButtonVariant =
  | "primary"
  | "chrome"
  | "ghost"
  | "soft"
  | "danger"
  | "success"
  // Transparent bg + accent border + accent text — an outlined accent
  // treatment for any low-emphasis chip-style inline CTA whose design
  // canvas shows an accent outline rather than the neutral `soft` fill.
  | "outline-accent"
  // Transparent bg + danger border + danger text — for low-emphasis
  // destructive CTAs (e.g. "Cannot pick up" in pickup-detail) where the
  // design canvas shows a flat danger-toned text+icon button rather than
  // the filled "danger" variant.
  | "outline-danger";
export type FxButtonSize = "sm" | "md" | "lg";

export interface FxButtonColors {
  readonly background: string;
  readonly foreground: string;
  readonly border: string;
}

export function resolveFxButtonColors(
  theme: MobileV2Theme,
  variant: FxButtonVariant,
): FxButtonColors {
  switch (variant) {
    case "primary":
      return { background: theme.accent, foreground: theme.accentInk, border: theme.accent };
    case "chrome":
      return { background: theme.chrome, foreground: theme.onChrome, border: theme.chrome };
    case "soft":
      // U-m: the design `soft` variant (_kit.jsx:281) is a low-emphasis
      // NEUTRAL button — `{ bg: surfaceAlt, fg: ink, bd: transparent }`.
      // It is the design's "not-ready"/secondary treatment (e.g.
      // `variant={ready?'danger':'soft'}`), distinct from `primary`. A
      // prior accentSoft/accent (yellow-tinted) mapping collapsed the
      // design's primary/secondary contrast; this restores the neutral
      // design tokens so every `soft` call site matches the canvas.
      return { background: theme.surfaceAlt, foreground: theme.ink, border: "transparent" };
    case "outline-accent":
      return { background: "transparent", foreground: theme.accent, border: theme.accent };
    case "outline-danger":
      return { background: "transparent", foreground: theme.danger, border: theme.danger };
    case "danger":
      return { background: theme.danger, foreground: "#FFFFFF", border: theme.danger };
    case "success":
      return { background: theme.success, foreground: "#FFFFFF", border: theme.success };
    case "ghost":
    default:
      return {
        background: "transparent",
        foreground: theme.ink,
        border: theme.borderStrong,
      };
  }
}

export interface FxButtonGeometry {
  readonly height: number;
  readonly paddingHorizontal: number;
  readonly fontSize: number;
  readonly iconSize: number;
  readonly gap: number;
  readonly borderRadius: number;
}

export function resolveFxButtonGeometry(size: FxButtonSize): FxButtonGeometry {
  switch (size) {
    case "lg":
      return {
        height: 54,
        paddingHorizontal: MOBILE_V2_SPACING["4xl"],
        fontSize: MOBILE_V2_TYPE_SIZES.bodyStrong,
        iconSize: 20,
        gap: MOBILE_V2_SPACING.lg,
        borderRadius: MOBILE_V2_RADII.button,
      };
    case "sm":
      return {
        height: 36,
        paddingHorizontal: MOBILE_V2_SPACING["2xl"],
        fontSize: MOBILE_V2_TYPE_SIZES.body,
        iconSize: 16,
        gap: MOBILE_V2_SPACING.md,
        borderRadius: MOBILE_V2_RADII.button,
      };
    case "md":
    default:
      return {
        height: 46,
        paddingHorizontal: MOBILE_V2_SPACING["3xl"],
        fontSize: MOBILE_V2_TYPE_SIZES.bodyStrong,
        iconSize: 18,
        gap: MOBILE_V2_SPACING.lg,
        borderRadius: MOBILE_V2_RADII.button,
      };
  }
}

// ---------------------------------------------------------------------------
// FxCard
// ---------------------------------------------------------------------------

export interface FxCardStyle {
  readonly background: string;
  readonly border: string;
  readonly padding: number;
  readonly borderRadius: number;
}

export function resolveFxCardStyle(
  theme: MobileV2Theme,
  input: { readonly soft?: boolean; readonly accent?: boolean; readonly padding?: number } = {},
): FxCardStyle {
  return {
    background: input.soft === true ? theme.surfaceAlt : theme.surface,
    // U-p: the design `FxCard` (_kit.jsx:310) renders a full 1px border —
    // `border: 1px solid ${accent ? t.accent : t.border}` — so an accent
    // card carries the accent colour on ALL four sides, not a left strip.
    border: input.accent === true ? theme.accent : theme.border,
    padding: typeof input.padding === "number" && input.padding >= 0 ? input.padding : 14,
    borderRadius: MOBILE_V2_RADII.card,
  };
}

// ---------------------------------------------------------------------------
// FxAvatar
// ---------------------------------------------------------------------------

export type FxAvatarTone = "accent" | "neutral";

export interface FxAvatarStyle {
  readonly size: number;
  readonly background: string;
  readonly foreground: string;
  readonly initials: string;
}

export function resolveFxAvatarInitials(name: string | undefined): string {
  if (typeof name !== "string") return "AB";
  const trimmed = name.trim();
  if (trimmed.length === 0) return "AB";
  const parts = trimmed.split(/\s+/).filter((part) => part.length > 0);
  if (parts.length === 0) return "AB";
  if (parts.length === 1) {
    return (parts[0] ?? "").slice(0, 2).toUpperCase();
  }
  const first = parts[0]?.charAt(0) ?? "";
  const last = parts[parts.length - 1]?.charAt(0) ?? "";
  return `${first}${last}`.toUpperCase();
}

export function resolveFxAvatarStyle(
  theme: MobileV2Theme,
  input: { readonly name?: string; readonly size?: number; readonly tone?: FxAvatarTone } = {},
): FxAvatarStyle {
  // U-n: the design `FxAvatar` (_kit.jsx:428) defaults `tone='accent'`
  // (warm accentSoft disk + accent initials) — call sites that omit
  // `tone` must render the accent treatment, not gray. An explicit
  // `tone="neutral"` still opts into the surfaceAlt/inkSoft palette.
  const tone: FxAvatarTone = input.tone === "neutral" ? "neutral" : "accent";
  // U-o: the design `FxAvatar` (_kit.jsx:432-438) renders a flat filled
  // disk — only `background` + `color` are themed, there is no border.
  const palette =
    tone === "accent"
      ? { background: theme.accentSoft, foreground: theme.accent }
      : { background: theme.surfaceAlt, foreground: theme.inkSoft };
  return {
    size: typeof input.size === "number" && input.size > 0 ? input.size : 36,
    initials: resolveFxAvatarInitials(input.name),
    ...palette,
  };
}

// ---------------------------------------------------------------------------
// FxMetric
// ---------------------------------------------------------------------------

export type FxMetricTone = "default" | "success" | "warning" | "danger" | "accent";

export interface FxMetricStyle {
  readonly labelColor: string;
  readonly valueColor: string;
  readonly unitColor: string;
  readonly valueFontSize: number;
  readonly valueLetterSpacing: number;
  readonly valueFontFamily: string;
}

export function resolveFxMetricStyle(theme: MobileV2Theme, tone: FxMetricTone): FxMetricStyle {
  let valueColor: string;
  switch (tone) {
    case "success":
      valueColor = theme.success;
      break;
    case "warning":
      valueColor = theme.warning;
      break;
    case "danger":
      valueColor = theme.danger;
      break;
    case "accent":
      valueColor = theme.accent;
      break;
    case "default":
    default:
      valueColor = theme.ink;
      break;
  }
  return {
    labelColor: theme.muted,
    valueColor,
    unitColor: theme.mutedSoft,
    valueFontSize: MOBILE_V2_TYPE_SIZES.metricValue,
    valueLetterSpacing: MOBILE_V2_TYPE_LETTER_SPACING.metricValue,
    valueFontFamily: MOBILE_V2_FONT_MONO,
  };
}

// ---------------------------------------------------------------------------
// FxStatusDot
// ---------------------------------------------------------------------------

export type FxStatusDotKind = "done" | "current" | "pending" | "failed" | "sla";

export function resolveFxStatusDotColor(theme: MobileV2Theme, kind: FxStatusDotKind): string {
  switch (kind) {
    case "done":
      return theme.success;
    case "current":
      return theme.accent;
    case "pending":
      return theme.muted;
    case "failed":
      return theme.danger;
    case "sla":
      return theme.warning;
    default:
      return theme.muted;
  }
}

// ---------------------------------------------------------------------------
// FxSectionHead
// ---------------------------------------------------------------------------

export interface FxSectionHeadStyle {
  readonly color: string;
  readonly fontSize: number;
  readonly fontWeight: "400" | "500" | "600" | "700";
  readonly letterSpacing: number;
  readonly textTransform: "uppercase";
}

export function resolveFxSectionHeadStyle(theme: MobileV2Theme): FxSectionHeadStyle {
  return {
    color: theme.muted,
    fontSize: MOBILE_V2_TYPE_SIZES.sectionHead,
    fontWeight: MOBILE_V2_TYPE_WEIGHTS.bold,
    letterSpacing: MOBILE_V2_TYPE_LETTER_SPACING.sectionHead,
    textTransform: "uppercase",
  };
}

// ---------------------------------------------------------------------------
// FxStickyAction
// ---------------------------------------------------------------------------

export interface FxStickyActionStyle {
  readonly background: string;
  readonly borderTop: string;
  readonly subColor: string;
  readonly paddingHorizontal: number;
  readonly paddingTop: number;
  readonly paddingBottom: number;
}

export function resolveFxStickyActionStyle(theme: MobileV2Theme): FxStickyActionStyle {
  return {
    background: theme.bg,
    borderTop: theme.border,
    subColor: theme.muted,
    paddingHorizontal: MOBILE_V2_SPACING["4xl"],
    paddingTop: MOBILE_V2_SPACING["2xl"],
    paddingBottom: MOBILE_V2_SPACING["3xl"],
  };
}

// ---------------------------------------------------------------------------
// FxRow / FxCol — pure layout primitives (no theme dependence)
// ---------------------------------------------------------------------------

export interface FxFlexStyle {
  readonly flexDirection: "row" | "column";
  readonly gap: number;
  readonly alignItems?: "flex-start" | "center" | "flex-end" | "stretch";
  readonly justifyContent?:
    | "flex-start"
    | "center"
    | "flex-end"
    | "space-between"
    | "space-around"
    | "space-evenly";
  readonly flexWrap?: "wrap" | "nowrap";
}

export function resolveFxRowStyle(input: {
  readonly gap?: number;
  readonly align?: FxFlexStyle["alignItems"];
  readonly justify?: FxFlexStyle["justifyContent"];
  readonly wrap?: boolean;
} = {}): FxFlexStyle {
  return {
    flexDirection: "row",
    gap: typeof input.gap === "number" && input.gap >= 0 ? input.gap : MOBILE_V2_SPACING.lg,
    alignItems: input.align ?? "center",
    justifyContent: input.justify,
    flexWrap: input.wrap === true ? "wrap" : "nowrap",
  };
}

export function resolveFxColStyle(input: { readonly gap?: number } = {}): FxFlexStyle {
  return {
    flexDirection: "column",
    gap: typeof input.gap === "number" && input.gap >= 0 ? input.gap : MOBILE_V2_SPACING.lg,
  };
}
