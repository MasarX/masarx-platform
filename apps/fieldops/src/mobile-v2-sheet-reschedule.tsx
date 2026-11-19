// Mobile V2 Reschedule sheet — pixel-faithful port of design source
// flow-extras.jsx SheetReschedule. Move a stop to another delivery
// window. Suggested windows come from policy
// (`mobile_reschedule_suggest_v1`) with a fit indicator: "good" means
// customer was historically reachable, "ok" / "poor" are weaker matches.
// Note is free-text so dispatch / SMS template can include context.

import * as React from "react";
import {
  Pressable,
  Text,
  TextInput,
  type StyleProp,
  type ViewStyle,
} from "react-native";

import type { MobileV2RescheduleReadback } from "./mobile-v2-reschedule-policy";
import { FxButton, FxChip, FxCol } from "./mobile-v2-primitives";
import { FxIcon } from "./mobile-v2-icon";
import type { FxChipTone } from "./mobile-v2-primitives-styles";
import { MobileV2BottomSheet } from "./mobile-v2-bottom-sheet";
import {
  MOBILE_V2_FONT_MONO,
  MOBILE_V2_FONT_SANS,
  MOBILE_V2_RADII,
  MOBILE_V2_SPACING,
  MOBILE_V2_TYPE_SIZES,
  MOBILE_V2_TYPE_WEIGHTS,
  type MobileV2Theme,
} from "./mobile-v2-themes";

export type MobileV2RescheduleFit = "good" | "ok" | "poor";

export interface MobileV2RescheduleWindow {
  readonly id: string;
  readonly label: string;
  readonly startIso: string;
  readonly endIso: string;
  readonly fit: MobileV2RescheduleFit;
  /**
   * When set, replaces the ISO range sub-line and the right-side fit chip
   * with an inline success-tone reason ("Recommended · ...") — matches
   * the design canvas s-sheet-reschedule artboard. When omitted, the
   * developer-facing ISO + fit chip render unchanged.
   */
  readonly recommendedReason?: string;
}

export interface MobileV2RescheduleSheetProps {
  readonly theme: MobileV2Theme;
  readonly visible: boolean;
  readonly onClose: () => void;
  readonly stopRef: string;
  readonly currentWindow: string;
  readonly suggestedWindows: ReadonlyArray<MobileV2RescheduleWindow>;
  readonly selectedWindowId: string | null;
  readonly noteText: string;
  readonly submitting?: boolean;
  readonly latestReschedule?: MobileV2RescheduleReadback | null;
  readonly readbackError?: string | null;
  readonly onSelectWindow: (id: string) => void;
  readonly onNoteChange: (next: string) => void;
  readonly onConfirm: () => void;
  /**
   * Overrides the auto-composed `<stopRef> · currently <currentWindow>`
   * subtitle. Used by the design-parity preview to render the customer
   * name only.
   */
  readonly subtitle?: string;
  /** When false, hides the optional note-to-customer field. Defaults true. */
  readonly showNote?: boolean;
  /**
   * When true, hides the developer-facing ISO range sub-line and the
   * right-side fit chip for windows without a `recommendedReason`. The
   * row reduces to just its human label, matching the design canvas
   * s-sheet-reschedule artboard. Defaults false.
   */
  readonly compact?: boolean;
  /**
   * Force the primary CTA into the "ready" visual state (primary
   * variant + "Confirm new window · notify customer" copy) regardless
   * of selection state. The design canvas s-sheet-reschedule artboard
   * shows the empty form alongside the ready-state CTA as an idealized
   * affordance preview, so the audit gallery preview opts in via
   * `forceReady={true}`. Production keeps state-driven readiness so
   * the CTA stays selection-gated.
   */
  readonly forceReady?: boolean;
  readonly style?: StyleProp<ViewStyle>;
}

function chipToneForFit(f: MobileV2RescheduleFit): FxChipTone {
  return f === "good" ? "success" : f === "ok" ? "info" : "warning";
}

function fitLabel(f: MobileV2RescheduleFit): string {
  return f === "good" ? "Recommended" : f === "ok" ? "Available" : "Tight";
}

export function MobileV2RescheduleSheet(
  props: MobileV2RescheduleSheetProps,
): React.ReactElement {
  const { theme } = props;
  const computedReady = props.selectedWindowId !== null;
  const ready = props.forceReady === true ? true : computedReady;
  const showNote = props.showNote !== false;
  const compact = props.compact === true;
  const submitting = props.submitting === true;
  const subtitle =
    props.subtitle ?? `${props.stopRef} · currently ${props.currentWindow}`;

  return (
    <MobileV2BottomSheet
      theme={theme}
      visible={props.visible}
      onClose={props.onClose}
      title="Reschedule"
      subtitle={subtitle}
      style={props.style}
      primary={
        <FxButton
          theme={theme}
          variant={ready ? "chrome" : "soft"}
          full
          size="lg"
          icon="clock"
          disabled={!ready || submitting}
          onPress={props.onConfirm}
          accessibilityLabel="Confirm new window"
        >
          {submitting
            ? "Confirming"
            : ready
              ? "Confirm new window - notify customer"
              : "Pick a window"}
        </FxButton>
      }
    >
      <FxCol gap={MOBILE_V2_SPACING.md} style={{ paddingVertical: MOBILE_V2_SPACING.lg }}>
        {props.latestReschedule !== null && props.latestReschedule !== undefined ? (
          <FxCol
            gap={MOBILE_V2_SPACING.sm}
            style={{
              backgroundColor: theme.successSoft,
              borderColor: theme.success,
              borderWidth: 1,
              borderRadius: MOBILE_V2_RADII.button,
              paddingVertical: MOBILE_V2_SPACING.xl,
              paddingHorizontal: MOBILE_V2_SPACING["2xl"],
            }}
          >
            <Text
              style={{
                color: theme.success,
                fontFamily: MOBILE_V2_FONT_SANS,
                fontSize: MOBILE_V2_TYPE_SIZES.body,
                fontWeight: MOBILE_V2_TYPE_WEIGHTS.bold,
              }}
            >
              Reschedule confirmed
            </Text>
            <Text
              style={{
                color: theme.ink,
                fontFamily: MOBILE_V2_FONT_SANS,
                fontSize: MOBILE_V2_TYPE_SIZES.caption,
              }}
            >
              Window {props.latestReschedule.windowLabel} - {props.latestReschedule.state}
            </Text>
            <Text
              style={{
                color: theme.muted,
                fontFamily: MOBILE_V2_FONT_MONO,
                fontSize: MOBILE_V2_TYPE_SIZES.chip,
              }}
            >
              Request recorded
            </Text>
          </FxCol>
        ) : null}

        {props.readbackError !== null && props.readbackError !== undefined ? (
          <Text
            accessibilityRole="alert"
            style={{
              color: theme.danger,
              fontFamily: MOBILE_V2_FONT_SANS,
              fontSize: MOBILE_V2_TYPE_SIZES.caption,
              fontWeight: MOBILE_V2_TYPE_WEIGHTS.semibold,
            }}
          >
            {props.readbackError}
          </Text>
        ) : null}

        {props.suggestedWindows.length === 0 ? (
          <Text
            style={{
              color: theme.muted,
              fontFamily: MOBILE_V2_FONT_SANS,
              fontSize: MOBILE_V2_TYPE_SIZES.caption,
            }}
          >
            No delivery windows are available for this stop.
          </Text>
        ) : null}

        {props.suggestedWindows.map((s) => {
          const on = props.selectedWindowId === s.id;
          return (
            <Pressable
              key={s.id}
              onPress={() => props.onSelectWindow(s.id)}
              accessibilityRole="button"
              accessibilityLabel={`Select window ${s.label}`}
              accessibilityState={{ selected: on }}
              style={{
                flexDirection: "row",
                alignItems: "center",
                columnGap: MOBILE_V2_SPACING["2xl"],
                paddingVertical: MOBILE_V2_SPACING["2xl"],
                paddingHorizontal: MOBILE_V2_SPACING["3xl"],
                backgroundColor: on ? theme.accentSoft : theme.surface,
                borderColor: on ? theme.accent : theme.border,
                borderWidth: 1,
                borderRadius: MOBILE_V2_RADII.button,
              }}
            >
              <FxIcon name="clock" size={18} color={on ? theme.accent : theme.muted} />
              <FxCol gap={2} style={{ flex: 1, minWidth: 0 }}>
                <Text
                  style={{
                    fontSize: MOBILE_V2_TYPE_SIZES.body,
                    fontWeight: MOBILE_V2_TYPE_WEIGHTS.semibold,
                    color: theme.ink,
                    fontFamily: MOBILE_V2_FONT_SANS,
                  }}
                >
                  {s.label}
                </Text>
                {s.recommendedReason !== undefined ? (
                  <Text
                    numberOfLines={1}
                    style={{
                      fontSize: 10.5,
                      color: theme.success,
                      fontFamily: MOBILE_V2_FONT_SANS,
                      // Design canvas s-sheet-reschedule renders the
                      // recommended reason in regular weight.
                      fontWeight: MOBILE_V2_TYPE_WEIGHTS.regular,
                    }}
                  >
                    {s.recommendedReason}
                  </Text>
                ) : compact ? null : (
                  <Text
                    style={{
                      fontSize: 10.5,
                      color: theme.muted,
                      fontFamily: MOBILE_V2_FONT_MONO,
                    }}
                  >
                    {s.startIso} → {s.endIso}
                  </Text>
                )}
              </FxCol>
              {s.recommendedReason === undefined && !compact ? (
                <FxChip theme={theme} tone={chipToneForFit(s.fit)} dense>
                  {fitLabel(s.fit)}
                </FxChip>
              ) : null}
              {on ? <FxIcon name="check" size={18} color={theme.accent} /> : null}
            </Pressable>
          );
        })}

        {showNote ? (
          <FxCol gap={MOBILE_V2_SPACING.md}>
            <Text
              style={{
                fontSize: MOBILE_V2_TYPE_SIZES.label,
                color: theme.muted,
                fontWeight: MOBILE_V2_TYPE_WEIGHTS.semibold,
                letterSpacing: 0.4,
                textTransform: "uppercase",
                fontFamily: MOBILE_V2_FONT_SANS,
              }}
            >
              Note for customer · optional
            </Text>
            <TextInput
              value={props.noteText}
              onChangeText={props.onNoteChange}
              placeholder="What should the customer know?"
              placeholderTextColor={theme.muted}
              multiline
              numberOfLines={3}
              style={{
                borderColor: theme.border,
                borderWidth: 1,
                borderRadius: MOBILE_V2_RADII.button,
                backgroundColor: theme.surface,
                color: theme.ink,
                fontFamily: MOBILE_V2_FONT_SANS,
                fontSize: MOBILE_V2_TYPE_SIZES.body,
                padding: MOBILE_V2_SPACING["2xl"],
                minHeight: 72,
                textAlignVertical: "top",
              }}
            />
          </FxCol>
        ) : null}

      </FxCol>
    </MobileV2BottomSheet>
  );
}
