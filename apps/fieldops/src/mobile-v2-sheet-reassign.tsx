// Mobile V2 Reassign sheet — pixel-faithful port of design source
// flow-extras.jsx SheetReassign. Hands a stop to another driver. Candidate
// list is policy/dispatch-resolved (`mobile_reassign_candidates_v1`); the
// sheet shows ETA delta, free capacity, and great-circle distance. A free-
// text reason field is required so dispatch can audit.

import * as React from "react";
import {
  Pressable,
  Text,
  TextInput,
  View,
  type StyleProp,
  type ViewStyle,
} from "react-native";

import { FxAvatar, FxButton, FxChip, FxCol, FxRow } from "./mobile-v2-primitives";
import { FxIcon } from "./mobile-v2-icon";
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

export interface MobileV2ReassignCandidate {
  readonly id: string;
  readonly name: string;
  /** Additional ETA the candidate adds vs current driver (minutes). */
  readonly etaMin: number;
  /** Capacity left on the candidate's route (stops). */
  readonly capacityLeft: number;
  /** Great-circle distance from candidate to the stop in km. */
  readonly distanceKm: number;
}

export interface MobileV2ReassignSheetProps {
  readonly theme: MobileV2Theme;
  readonly visible: boolean;
  readonly onClose: () => void;
  readonly stopRef: string;
  readonly candidates: ReadonlyArray<MobileV2ReassignCandidate>;
  readonly selectedDriverId: string | null;
  readonly reasonText: string;
  readonly onSelectDriver: (id: string) => void;
  readonly onReasonChange: (next: string) => void;
  readonly onConfirm: () => void;
  /**
   * Overrides the auto-composed `<stopRef> · pick a nearby driver`
   * subtitle. Used by the design-parity preview to lead with the
   * customer name.
   */
  readonly subtitle?: string;
  /** When false, hides the reason-for-reassignment field. Defaults true. */
  readonly showReason?: boolean;
  readonly style?: StyleProp<ViewStyle>;
}

function avatarInitials(name: string): string {
  return name
    .split(" ")
    .map((x) => x[0] ?? "")
    .join("")
    .slice(0, 2)
    .toUpperCase();
}

export function MobileV2ReassignSheet(
  props: MobileV2ReassignSheetProps,
): React.ReactElement {
  const { theme, candidates } = props;
  const showReason = props.showReason !== false;
  // When the reason field is hidden (design-parity flow), the CTA is gated
  // on driver selection alone — dispatch captures the reason post-handoff.
  const ready =
    props.selectedDriverId !== null &&
    (!showReason || props.reasonText.trim().length > 2);
  const subtitle = props.subtitle ?? `${props.stopRef} · pick a nearby driver`;

  return (
    <MobileV2BottomSheet
      theme={theme}
      visible={props.visible}
      onClose={props.onClose}
      title="Reassign stop"
      subtitle={subtitle}
      style={props.style}
      primary={
        // Design SheetReassign (flow-extras.jsx:505) keeps the CTA label
        // fixed at "Send request to dispatch" — only the variant flips
        // (soft → primary) once a driver is picked. The disabled gate is
        // an additive safeguard; it does not change the label.
        <FxButton
          theme={theme}
          variant={ready ? "primary" : "soft"}
          full
          size="lg"
          icon="user"
          disabled={!ready}
          onPress={props.onConfirm}
          accessibilityLabel="Send reassignment to dispatch"
        >
          Send request to dispatch
        </FxButton>
      }
    >
      <FxCol gap={MOBILE_V2_SPACING.md} style={{ paddingVertical: MOBILE_V2_SPACING.lg }}>
        {candidates.map((d) => {
          const on = props.selectedDriverId === d.id;
          return (
            <Pressable
              key={d.id}
              onPress={() => props.onSelectDriver(d.id)}
              accessibilityRole="button"
              accessibilityLabel={`Select driver ${d.name}`}
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
              <FxAvatar theme={theme} name={avatarInitials(d.name)} size={36} />
              <FxCol gap={2} style={{ flex: 1, minWidth: 0 }}>
                <Text
                  style={{
                    fontSize: MOBILE_V2_TYPE_SIZES.body,
                    fontWeight: MOBILE_V2_TYPE_WEIGHTS.semibold,
                    color: theme.ink,
                    fontFamily: MOBILE_V2_FONT_SANS,
                  }}
                >
                  {d.name}
                </Text>
                <Text
                  style={{
                    fontSize: MOBILE_V2_TYPE_SIZES.label,
                    color: theme.muted,
                    fontFamily: MOBILE_V2_FONT_MONO,
                  }}
                >
                  {d.id} · {d.distanceKm.toFixed(1)} km away · {d.capacityLeft} stops
                </Text>
              </FxCol>
              <FxChip theme={theme} dense tone="info">
                ETA +{d.etaMin}m
              </FxChip>
            </Pressable>
          );
        })}

        {showReason ? (
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
              Reason for reassignment
            </Text>
            <TextInput
              value={props.reasonText}
              onChangeText={props.onReasonChange}
              placeholder="Why are you handing this off?"
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

      {/* Dispatch-approval hint is rendered alongside the reason field
          (developer / full-flow view). The design canvas s-sheet-reassign
          artboard omits it; suppressed when the reason field is hidden. */}
      {showReason ? (
        <View
          style={{
            flexDirection: "row",
            alignItems: "center",
            columnGap: MOBILE_V2_SPACING.md,
            marginTop: MOBILE_V2_SPACING.md,
          }}
        >
          <FxIcon name="info" size={12} color={theme.muted} />
          <Text
            style={{
              fontSize: MOBILE_V2_TYPE_SIZES.label,
              color: theme.muted,
              fontFamily: MOBILE_V2_FONT_SANS,
              flex: 1,
            }}
          >
            Dispatch must approve before the customer is notified.
          </Text>
        </View>
      ) : null}
    </MobileV2BottomSheet>
  );
}
