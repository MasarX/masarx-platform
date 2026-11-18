// Mobile V2 primitives kit — RN ports of the design source FxButton/FxCard/
// FxChip/FxRow/FxCol/FxAvatar/FxMetric/FxSectionHead/FxStatusDot/
// FxStickyAction. Style mappings live in mobile-v2-primitives-styles so the
// resolver logic is unit-tested without rendering JSX. These components are
// thin renderers that consume the resolvers + theme tokens.

import * as React from "react";
import {
  Pressable,
  type PressableProps,
  StyleSheet,
  Text,
  View,
  type StyleProp,
  type ViewStyle,
  type TextStyle,
} from "react-native";

import { FxIcon } from "./mobile-v2-icon";
import type { MobileV2IconName } from "./mobile-v2-icon-specs";
import {
  MOBILE_V2_FONT_MONO,
  MOBILE_V2_FONT_SANS,
  MOBILE_V2_RADII,
  MOBILE_V2_SPACING,
  MOBILE_V2_TYPE_LINE_TIGHT,
  MOBILE_V2_TYPE_SIZES,
  MOBILE_V2_TYPE_WEIGHTS,
  type MobileV2Theme,
} from "./mobile-v2-themes";
import {
  type FxAvatarTone,
  type FxButtonSize,
  type FxButtonVariant,
  type FxChipTone,
  type FxMetricTone,
  type FxStatusDotKind,
  resolveFxAvatarStyle,
  resolveFxButtonColors,
  resolveFxButtonGeometry,
  resolveFxCardStyle,
  resolveFxChipColors,
  resolveFxChipTypography,
  resolveFxColStyle,
  resolveFxMetricStyle,
  resolveFxRowStyle,
  resolveFxSectionHeadStyle,
  resolveFxStatusDotColor,
  resolveFxStickyActionStyle,
} from "./mobile-v2-primitives-styles";

// ---------------------------------------------------------------------------
// FxButton
// ---------------------------------------------------------------------------

export interface FxButtonProps {
  readonly theme: MobileV2Theme;
  readonly variant?: FxButtonVariant;
  readonly size?: FxButtonSize;
  readonly icon?: MobileV2IconName;
  readonly iconRight?: MobileV2IconName;
  readonly mono?: boolean;
  readonly full?: boolean;
  readonly disabled?: boolean;
  readonly onPress?: PressableProps["onPress"];
  readonly children?: React.ReactNode;
  readonly accessibilityLabel?: string;
  /** Optional test handle — forwarded to the underlying Pressable so E2E /
   *  capture harnesses can locate the button by an exact element handle. */
  readonly testID?: string;
  readonly style?: StyleProp<ViewStyle>;
}

export function FxButton(props: FxButtonProps): React.ReactElement {
  const variant: FxButtonVariant = props.variant ?? "primary";
  const size: FxButtonSize = props.size ?? "md";
  const baseColors = resolveFxButtonColors(props.theme, variant);
  const geom = resolveFxButtonGeometry(size);
  const isDisabled = props.disabled === true;
  // Disabled remap: swap to explicit muted tokens (surfaceAlt bg +
  // muted fg + hairline border) so a disabled button stays legible
  // across themes instead of relying on opacity-only dimming.
  const colors = isDisabled
    ? {
        background: props.theme.surfaceAlt,
        foreground: props.theme.muted,
        border: props.theme.border,
      }
    : baseColors;

  const containerStyle: ViewStyle = {
    backgroundColor: colors.background,
    borderColor: colors.border,
    borderWidth:
      variant === "ghost" ||
      variant === "outline-accent" ||
      variant === "outline-danger" ||
      isDisabled
        ? 1
        : 0,
    borderRadius: geom.borderRadius,
    height: geom.height,
    paddingHorizontal: geom.paddingHorizontal,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    columnGap: geom.gap,
    alignSelf: props.full === true ? "stretch" : "flex-start",
  };

  const labelStyle: TextStyle = {
    color: colors.foreground,
    fontSize: geom.fontSize,
    fontFamily: props.mono === true ? MOBILE_V2_FONT_MONO : MOBILE_V2_FONT_SANS,
    fontWeight: MOBILE_V2_TYPE_WEIGHTS.semibold,
  };

  return (
    <Pressable
      onPress={props.onPress}
      disabled={isDisabled}
      accessibilityRole="button"
      accessibilityLabel={props.accessibilityLabel}
      accessibilityState={{ disabled: isDisabled }}
      testID={props.testID}
      style={[containerStyle, props.style]}
    >
      {props.icon !== undefined ? (
        <FxIcon name={props.icon} size={geom.iconSize} color={colors.foreground} />
      ) : null}
      {props.children !== undefined ? <Text style={labelStyle}>{props.children}</Text> : null}
      {props.iconRight !== undefined ? (
        <FxIcon name={props.iconRight} size={geom.iconSize} color={colors.foreground} />
      ) : null}
    </Pressable>
  );
}

// ---------------------------------------------------------------------------
// FxCard
// ---------------------------------------------------------------------------

export interface FxCardProps {
  readonly theme: MobileV2Theme;
  readonly soft?: boolean;
  readonly accent?: boolean;
  readonly padding?: number;
  readonly style?: StyleProp<ViewStyle>;
  readonly children?: React.ReactNode;
  /** Optional test handle — forwarded to the underlying View so capture
   *  harnesses can locate the card by an exact element bounding box. */
  readonly testID?: string;
}

export function FxCard(props: FxCardProps): React.ReactElement {
  const card = resolveFxCardStyle(props.theme, {
    soft: props.soft,
    accent: props.accent,
    padding: props.padding,
  });
  // U-p: the design `FxCard` (_kit.jsx:310) is a uniform 1px border whose
  // colour is the accent token when `accent` — resolveFxCardStyle folds
  // that into `card.border`, so all four sides paint identically.
  const baseStyle: ViewStyle = {
    backgroundColor: card.background,
    borderColor: card.border,
    borderWidth: 1,
    borderRadius: card.borderRadius,
    padding: card.padding,
  };
  return (
    <View style={[baseStyle, props.style]} testID={props.testID}>
      {props.children}
    </View>
  );
}

// ---------------------------------------------------------------------------
// FxChip
// ---------------------------------------------------------------------------

export interface FxChipProps {
  readonly theme: MobileV2Theme;
  readonly tone?: FxChipTone;
  readonly icon?: MobileV2IconName;
  readonly dense?: boolean;
  readonly mono?: boolean;
  readonly children?: React.ReactNode;
  readonly style?: StyleProp<ViewStyle>;
}

export function FxChip(props: FxChipProps): React.ReactElement {
  const tone: FxChipTone = props.tone ?? "neutral";
  const colors = resolveFxChipColors(props.theme, tone);
  const typo = resolveFxChipTypography({ dense: props.dense, mono: props.mono });
  const containerStyle: ViewStyle = {
    backgroundColor: colors.background,
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: 999,
    paddingHorizontal: typo.paddingHorizontal,
    paddingVertical: typo.paddingVertical,
    minHeight: typo.minHeight,
    flexDirection: "row",
    alignItems: "center",
    columnGap: MOBILE_V2_SPACING.sm,
    alignSelf: "flex-start",
  };
  const textStyle: TextStyle = {
    color: colors.foreground,
    fontSize: typo.fontSize,
    fontWeight: typo.fontWeight,
    letterSpacing: typo.letterSpacing,
    fontFamily: typo.fontFamily,
  };
  return (
    <View style={[containerStyle, props.style]}>
      {props.icon !== undefined ? (
        <FxIcon name={props.icon} size={typo.fontSize + 2} color={colors.foreground} />
      ) : null}
      {props.children !== undefined ? (
        // Pin chip text LTR: chips in this design always carry short LTR
        // content (counts, COD amounts, status words). Without this, a
        // chip whose body ends in the strong-RTL rial sign ﷼ (U+FDFC)
        // resolves RTL under RN-Web's `dir="auto"` and renders the COD
        // amount symbol-first. react-native-web forwards `dir` to the DOM
        // node; RN's TextProps omits it, hence the @ts-expect-error.
        // @ts-expect-error — `dir` is a valid RN-Web Text prop.
        <Text dir="ltr" style={textStyle}>{props.children}</Text>
      ) : null}
    </View>
  );
}

// ---------------------------------------------------------------------------
// FxChipButton — pressable pill for filter / sort / group toolbars. Port of
// the design `ChipBtn` (flow-route.jsx / flow-tasks.jsx): a rounded-999 pill
// with a leading icon. `active` swaps to the chrome fill; `accent` tone uses
// the soft accent fill. Distinct from `FxChip` (a static, non-pressable
// status pill) — this one carries an action.
// ---------------------------------------------------------------------------

export interface FxChipButtonProps {
  readonly theme: MobileV2Theme;
  readonly icon: MobileV2IconName;
  readonly label: string;
  readonly active?: boolean;
  readonly tone?: "accent" | "neutral";
  readonly onPress?: () => void;
  readonly accessibilityLabel: string;
}

export function FxChipButton(props: FxChipButtonProps): React.ReactElement {
  const t = props.theme;
  const isActive = props.active === true;
  const isAccent = props.tone === "accent";
  const bg = isActive ? t.chrome : isAccent ? t.accentSoft : t.surface;
  const fg = isActive ? t.onChrome : isAccent ? t.accent : t.ink;
  const bd = isActive ? "transparent" : isAccent ? "transparent" : t.border;
  return (
    <Pressable
      onPress={props.onPress}
      accessibilityRole="button"
      accessibilityLabel={props.accessibilityLabel}
      style={{
        flexDirection: "row",
        alignItems: "center",
        columnGap: MOBILE_V2_SPACING.md,
        paddingHorizontal: 11,
        paddingVertical: 7,
        borderRadius: 999,
        backgroundColor: bg,
        borderColor: bd,
        borderWidth: 1,
      }}
    >
      <FxIcon name={props.icon} size={13} color={fg} />
      <Text
        style={{
          color: fg,
          fontSize: 12,
          fontWeight: MOBILE_V2_TYPE_WEIGHTS.semibold,
          fontFamily: MOBILE_V2_FONT_SANS,
        }}
      >
        {props.label}
      </Text>
    </Pressable>
  );
}

// ---------------------------------------------------------------------------
// FxField — labelled form field wrapper. Port of the design `FxField`
// (flow-extras.jsx): an uppercase muted label, the control, and an optional
// muted hint line below.
// ---------------------------------------------------------------------------

export interface FxFieldProps {
  readonly theme: MobileV2Theme;
  readonly label: string;
  readonly hint?: string;
  readonly children: React.ReactNode;
}

export function FxField(props: FxFieldProps): React.ReactElement {
  const t = props.theme;
  return (
    <View style={{ rowGap: 6 }}>
      <Text
        style={{
          fontSize: 11,
          color: t.muted,
          fontWeight: MOBILE_V2_TYPE_WEIGHTS.bold,
          letterSpacing: 0.6,
          textTransform: "uppercase",
          fontFamily: MOBILE_V2_FONT_SANS,
        }}
      >
        {props.label}
      </Text>
      {props.children}
      {props.hint !== undefined && props.hint.length > 0 ? (
        <Text style={{ fontSize: 11, color: t.muted, fontFamily: MOBILE_V2_FONT_SANS }}>
          {props.hint}
        </Text>
      ) : null}
    </View>
  );
}

// ---------------------------------------------------------------------------
// FxNumberPad — on-screen numeric keypad. Port of the design `FxNumberPad`
// (flow-extras.jsx): a right-aligned mono amount readout above a 3-column
// grid of 1-9 / 00 / 0 / ⌫ keys. `value` is the digit string; `onChange`
// receives the next digit string.
// ---------------------------------------------------------------------------

const FX_NUMBER_PAD_KEYS: ReadonlyArray<string> = Object.freeze([
  "1", "2", "3", "4", "5", "6", "7", "8", "9", "00", "0", "del",
]);

export interface FxNumberPadProps {
  readonly theme: MobileV2Theme;
  readonly value: string;
  readonly onChange: (next: string) => void;
  /**
   * Trailing currency/unit label shown after the amount. Defaults to the
   * rial sign ﷼ (U+FDFC) — the FieldOps Mobile V2 design `FxNumberPad`
   * default (`suffix='﷼'`). Callers pass a policy-resolved symbol.
   */
  readonly suffix?: string;
}

export function FxNumberPad(props: FxNumberPadProps): React.ReactElement {
  const t = props.theme;
  const value = props.value;
  const suffix = props.suffix ?? "﷼";
  const tap = (k: string): void => {
    if (k === "del") {
      props.onChange(value.slice(0, -1) || "0");
    } else if (k === "00") {
      props.onChange((value === "0" ? "" : value) + "00");
    } else {
      props.onChange((value === "0" ? "" : value) + k);
    }
  };
  const numeric = Number(value || 0);
  return (
    <View style={{ rowGap: 10 }}>
      <View
        style={{
          backgroundColor: t.surfaceAlt,
          borderColor: t.border,
          borderWidth: 1,
          borderRadius: 12,
          paddingVertical: 14,
          paddingHorizontal: 16,
          flexDirection: "row",
          justifyContent: "flex-end",
          alignItems: "baseline",
        }}
      >
        <Text
          style={{
            fontSize: 30,
            fontWeight: MOBILE_V2_TYPE_WEIGHTS.bold,
            fontFamily: MOBILE_V2_FONT_MONO,
            color: t.ink,
            letterSpacing: -0.5,
          }}
        >
          {(Number.isFinite(numeric) ? numeric : 0).toLocaleString()}
        </Text>
        <Text style={{ fontSize: 14, color: t.muted, marginLeft: 8, fontFamily: MOBILE_V2_FONT_SANS }}>
          {suffix}
        </Text>
      </View>
      {/* Faithful port of the design `grid` with `gap:6` (flow-extras.jsx
          FxNumberPad): RN has no CSS grid, so a wrapping flex row with
          container `gap:6` + cells `flexBasis:"30%"`/`flexGrow:1` yields the
          same 3-up layout — 6px only BETWEEN cells, no outer inset. The
          earlier per-cell `padding:3` added a 3px outer inset that pushed
          the whole pad down 3px and 3px right of the readout above it. */}
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
        {FX_NUMBER_PAD_KEYS.map((k) => (
          <Pressable
            key={k}
            onPress={() => tap(k)}
            accessibilityRole="button"
            accessibilityLabel={k === "del" ? "Delete last digit" : `Enter ${k}`}
            style={{
              flexBasis: "30%",
              flexGrow: 1,
              paddingVertical: 12,
              alignItems: "center",
              backgroundColor: t.surface,
              borderColor: t.border,
              borderWidth: 1,
              borderRadius: 10,
            }}
          >
            <Text
              style={{
                fontSize: 18,
                fontWeight: MOBILE_V2_TYPE_WEIGHTS.semibold,
                fontFamily: MOBILE_V2_FONT_MONO,
                color: t.ink,
              }}
            >
              {k === "del" ? "⌫" : k}
            </Text>
          </Pressable>
        ))}
      </View>
    </View>
  );
}

// ---------------------------------------------------------------------------
// FxPhotoCapture — tap-to-capture evidence tile. Port of the design
// `FxPhotoCapture` (flow-extras.jsx): a bordered band that flips to the
// chrome fill once a photo is taken.
// ---------------------------------------------------------------------------

export interface FxPhotoCaptureProps {
  readonly theme: MobileV2Theme;
  readonly taken: boolean;
  readonly onCapture: () => void;
  readonly label?: string;
  readonly height?: number;
  readonly accessibilityLabel?: string;
}

export function FxPhotoCapture(props: FxPhotoCaptureProps): React.ReactElement {
  const t = props.theme;
  const taken = props.taken;
  const label = props.label ?? "Add photo";
  return (
    <Pressable
      onPress={props.onCapture}
      accessibilityRole="button"
      accessibilityLabel={
        props.accessibilityLabel ?? (taken ? "Photo captured — tap to retake" : label)
      }
    >
      <View
        style={{
          height: props.height ?? 120,
          borderRadius: MOBILE_V2_RADII.card,
          borderWidth: 1,
          borderColor: t.border,
          overflow: "hidden",
          backgroundColor: taken ? t.chrome : t.surfaceAlt,
          flexDirection: "row",
          alignItems: "center",
          justifyContent: "center",
          columnGap: 8,
        }}
      >
        <FxIcon
          name={taken ? "check-double" : "camera"}
          size={taken ? 26 : 20}
          color={taken ? t.onChrome : t.muted}
        />
        <Text
          style={{
            fontSize: 12,
            fontWeight: MOBILE_V2_TYPE_WEIGHTS.semibold,
            color: taken ? t.onChrome : t.muted,
            fontFamily: MOBILE_V2_FONT_SANS,
          }}
        >
          {taken ? "Captured · GPS + timestamp" : label}
        </Text>
      </View>
    </Pressable>
  );
}

// ---------------------------------------------------------------------------
// FxRow / FxCol — layout primitives
// ---------------------------------------------------------------------------

export interface FxRowProps {
  readonly gap?: number;
  readonly align?: "flex-start" | "center" | "flex-end" | "stretch";
  readonly justify?:
    | "flex-start"
    | "center"
    | "flex-end"
    | "space-between"
    | "space-around"
    | "space-evenly";
  readonly wrap?: boolean;
  readonly style?: StyleProp<ViewStyle>;
  readonly children?: React.ReactNode;
}

export function FxRow(props: FxRowProps): React.ReactElement {
  const flex = resolveFxRowStyle({
    gap: props.gap,
    align: props.align,
    justify: props.justify,
    wrap: props.wrap,
  });
  return (
    <View
      style={[
        {
          flexDirection: "row",
          // Design `_kit.jsx` FxRow uses CSS `gap`, which spaces BOTH
          // axes — so a wrapping row gets the same gap between wrapped
          // lines. Emitting columnGap only collapsed wrapped-row spacing.
          columnGap: flex.gap,
          rowGap: flex.gap,
          alignItems: flex.alignItems,
          justifyContent: flex.justifyContent,
          flexWrap: flex.flexWrap,
        },
        props.style,
      ]}
    >
      {props.children}
    </View>
  );
}

export interface FxColProps {
  readonly gap?: number;
  readonly style?: StyleProp<ViewStyle>;
  readonly children?: React.ReactNode;
}

export function FxCol(props: FxColProps): React.ReactElement {
  const flex = resolveFxColStyle({ gap: props.gap });
  return (
    <View style={[{ flexDirection: "column", rowGap: flex.gap }, props.style]}>
      {props.children}
    </View>
  );
}

// ---------------------------------------------------------------------------
// FxAvatar
// ---------------------------------------------------------------------------

export interface FxAvatarProps {
  readonly theme: MobileV2Theme;
  readonly name?: string;
  readonly size?: number;
  readonly tone?: FxAvatarTone;
  readonly style?: StyleProp<ViewStyle>;
}

export function FxAvatar(props: FxAvatarProps): React.ReactElement {
  const style = resolveFxAvatarStyle(props.theme, {
    name: props.name,
    size: props.size,
    tone: props.tone,
  });
  // U-o: the design `FxAvatar` (_kit.jsx:432-438) is a flat filled disk
  // with no border ring.
  const containerStyle: ViewStyle = {
    width: style.size,
    height: style.size,
    borderRadius: style.size / 2,
    backgroundColor: style.background,
    alignItems: "center",
    justifyContent: "center",
  };
  const textStyle: TextStyle = {
    color: style.foreground,
    // U-t: design `FxAvatar` (_kit.jsx:436-437) renders the initials at
    // `size * 0.36` in the mono family (FX_MONO), not sans.
    fontSize: Math.round(style.size * 0.36),
    fontWeight: MOBILE_V2_TYPE_WEIGHTS.bold,
    fontFamily: MOBILE_V2_FONT_MONO,
  };
  return (
    <View style={[containerStyle, props.style]}>
      <Text style={textStyle}>{style.initials}</Text>
    </View>
  );
}

// ---------------------------------------------------------------------------
// FxMetric
// ---------------------------------------------------------------------------

export interface FxMetricProps {
  readonly theme: MobileV2Theme;
  readonly label: string;
  readonly value: string | number;
  readonly unit?: string;
  readonly tone?: FxMetricTone;
  readonly style?: StyleProp<ViewStyle>;
}

export function FxMetric(props: FxMetricProps): React.ReactElement {
  const tone: FxMetricTone = props.tone ?? "default";
  const styleSet = resolveFxMetricStyle(props.theme, tone);
  const labelStyle: TextStyle = {
    color: styleSet.labelColor,
    fontSize: MOBILE_V2_TYPE_SIZES.chip,
    fontFamily: MOBILE_V2_FONT_SANS,
    fontWeight: MOBILE_V2_TYPE_WEIGHTS.medium,
  };
  const valueStyle: TextStyle = {
    color: styleSet.valueColor,
    fontSize: styleSet.valueFontSize,
    letterSpacing: styleSet.valueLetterSpacing,
    fontFamily: styleSet.valueFontFamily,
    fontWeight: MOBILE_V2_TYPE_WEIGHTS.bold,
    // design _kit.jsx FxMetric value sets lineHeight:1.1.
    lineHeight: styleSet.valueFontSize * MOBILE_V2_TYPE_LINE_TIGHT,
  };
  const unitStyle: TextStyle = {
    color: styleSet.unitColor,
    fontSize: MOBILE_V2_TYPE_SIZES.chip,
    fontFamily: MOBILE_V2_FONT_MONO,
    fontWeight: MOBILE_V2_TYPE_WEIGHTS.medium,
  };
  return (
    <View style={[{ flexDirection: "column", rowGap: MOBILE_V2_SPACING.xs }, props.style]}>
      <Text style={labelStyle}>{props.label}</Text>
      <View style={{ flexDirection: "row", alignItems: "baseline", columnGap: MOBILE_V2_SPACING.sm }}>
        <Text style={valueStyle}>{String(props.value)}</Text>
        {props.unit !== undefined ? <Text style={unitStyle}>{props.unit}</Text> : null}
      </View>
    </View>
  );
}

// ---------------------------------------------------------------------------
// FxSectionHead
// ---------------------------------------------------------------------------

export interface FxSectionHeadProps {
  readonly theme: MobileV2Theme;
  readonly label: string;
  readonly right?: React.ReactNode;
  readonly style?: StyleProp<ViewStyle>;
}

export function FxSectionHead(props: FxSectionHeadProps): React.ReactElement {
  const style = resolveFxSectionHeadStyle(props.theme);
  const labelStyle: TextStyle = {
    color: style.color,
    fontSize: style.fontSize,
    fontWeight: style.fontWeight,
    letterSpacing: style.letterSpacing,
    textTransform: style.textTransform,
    fontFamily: MOBILE_V2_FONT_SANS,
  };
  return (
    <View
      style={[
        {
          flexDirection: "row",
          alignItems: "center",
          justifyContent: "space-between",
          paddingVertical: MOBILE_V2_SPACING.sm,
        },
        props.style,
      ]}
    >
      <Text style={labelStyle}>{props.label}</Text>
      {props.right !== undefined ? <View>{props.right}</View> : null}
    </View>
  );
}

// ---------------------------------------------------------------------------
// FxStatusDot
// ---------------------------------------------------------------------------

export interface FxStatusDotProps {
  readonly theme: MobileV2Theme;
  readonly kind?: FxStatusDotKind;
  readonly size?: number;
}

export function FxStatusDot(props: FxStatusDotProps): React.ReactElement {
  const kind: FxStatusDotKind = props.kind ?? "pending";
  const color = resolveFxStatusDotColor(props.theme, kind);
  const size = typeof props.size === "number" && props.size > 0 ? props.size : 8;
  return (
    <View
      style={{
        width: size,
        height: size,
        borderRadius: size / 2,
        backgroundColor: color,
      }}
    />
  );
}

// ---------------------------------------------------------------------------
// FxStickyAction
// ---------------------------------------------------------------------------

export interface FxStickyActionProps {
  readonly theme: MobileV2Theme;
  readonly sub?: string;
  readonly children?: React.ReactNode;
  readonly style?: StyleProp<ViewStyle>;
}

export function FxStickyAction(props: FxStickyActionProps): React.ReactElement {
  const style = resolveFxStickyActionStyle(props.theme);
  const containerStyle: ViewStyle = {
    backgroundColor: style.background,
    borderTopColor: style.borderTop,
    borderTopWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: style.paddingHorizontal,
    paddingTop: style.paddingTop,
    paddingBottom: style.paddingBottom,
    rowGap: MOBILE_V2_SPACING.lg,
  };
  const subStyle: TextStyle = {
    color: style.subColor,
    fontSize: MOBILE_V2_TYPE_SIZES.chip,
    fontFamily: MOBILE_V2_FONT_SANS,
    fontWeight: MOBILE_V2_TYPE_WEIGHTS.medium,
  };
  return (
    <View style={[containerStyle, props.style]}>
      {props.children}
      {props.sub !== undefined ? <Text style={subStyle}>{props.sub}</Text> : null}
    </View>
  );
}
