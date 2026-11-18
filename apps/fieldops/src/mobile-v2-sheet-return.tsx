// Mobile V2 Return sheet — pixel-faithful port of design source
// flow-extras.jsx SheetReturn. Customer-return back to shelf flow:
// driver picks a return type (wrong size / damaged / changed mind /
// duplicate), captures a parcel-condition photo, and writes an optional
// note. The return type registry is policy-resolved
// (`mobile_return_types_policy`); the sheet remains pure presentation.

import * as React from "react";
import {
  Pressable,
  Text,
  TextInput,
  View,
  type StyleProp,
  type ViewStyle,
} from "react-native";

import { FxButton, FxCard, FxCol, FxRow } from "./mobile-v2-primitives";
import { FxIcon } from "./mobile-v2-icon";
import type { MobileV2IconName } from "./mobile-v2-icon-specs";
import { MobileV2BottomSheet } from "./mobile-v2-bottom-sheet";
import { isMobileV2ReturnReady } from "./mobile-v2-sheet-readiness";
import {
  MOBILE_V2_FONT_SANS,
  MOBILE_V2_RADII,
  MOBILE_V2_SPACING,
  MOBILE_V2_TYPE_SIZES,
  MOBILE_V2_TYPE_WEIGHTS,
  type MobileV2Theme,
} from "./mobile-v2-themes";

export interface MobileV2ReturnType {
  readonly id: string;
  readonly label: string;
  readonly icon: MobileV2IconName;
}

export interface MobileV2ReturnSheetProps {
  readonly theme: MobileV2Theme;
  readonly visible: boolean;
  readonly onClose: () => void;
  readonly orderRef: string;
  readonly returnTypes: ReadonlyArray<MobileV2ReturnType>;
  readonly selectedTypeId: string | null;
  readonly photoCaptured: boolean;
  readonly note: string;
  /**
   * Whether to render the optional dispatch-note textarea below the
   * photo tile. Defaults to `true` for production parity. The design
   * canvas SheetReturn artboard omits the note section, so the audit
   * gallery preview can opt out via `noteEnabled={false}` to surface
   * the design-canonical layout. Production cutover resolves this via
   * `mobile_return_types_policy.note_enabled`.
   */
  readonly noteEnabled?: boolean;
  /**
   * Whether to render an icon column between the radio and label on
   * each reason row. Defaults to `true` so prod keeps the icon hint.
   * The design canvas artboard renders radio + label only — the audit
   * gallery preview opts out via `reasonIconEnabled={false}`.
   */
  readonly reasonIconEnabled?: boolean;
  /**
   * Force the primary CTA into the "ready" visual state (yellow
   * success variant + "Accept return · seal & scan" copy) regardless
   * of selection/photo state. The design canvas SheetReturn artboard
   * shows the empty form alongside the ready-state CTA as an idealized
   * affordance preview, so the audit gallery preview opts in via
   * `forceReady={true}`. Production uses the computed readiness from
   * `isMobileV2ReturnReady` so the CTA stays state-driven.
   */
  readonly forceReady?: boolean;
  readonly onSelectType: (id: string) => void;
  readonly onTogglePhoto: () => void;
  readonly onNoteChange: (next: string) => void;
  readonly onConfirm: () => void;
  readonly style?: StyleProp<ViewStyle>;
}

export function MobileV2ReturnSheet(
  props: MobileV2ReturnSheetProps,
): React.ReactElement {
  const { theme } = props;
  const computedReady = isMobileV2ReturnReady({
    selectedTypeId: props.selectedTypeId,
    photoCaptured: props.photoCaptured,
  });
  const ready = props.forceReady === true ? true : computedReady;
  const noteEnabled = props.noteEnabled !== false;
  const reasonIconEnabled = props.reasonIconEnabled !== false;

  return (
    <MobileV2BottomSheet
      theme={theme}
      visible={props.visible}
      onClose={props.onClose}
      title="Customer return"
      // Aligned to design canvas s-sheet-return artboard: subtitle reads
      // "Pick up reverse parcel · back to shelf"; orderRef is appended
      // only when provided (preview gallery passes empty string for the
      // design-parity flow).
      subtitle={
        props.orderRef
          ? `${props.orderRef} · Pick up reverse parcel · back to shelf`
          : "Pick up reverse parcel · back to shelf"
      }
      style={props.style}
      primary={
        <FxButton
          theme={theme}
          variant={ready ? "success" : "soft"}
          full
          size="lg"
          icon="refresh"
          disabled={!ready}
          onPress={props.onConfirm}
          accessibilityLabel="Accept return"
        >
          Accept return · seal & scan
        </FxButton>
      }
    >
      <FxCol gap={MOBILE_V2_SPACING["2xl"]} style={{ paddingTop: MOBILE_V2_SPACING.lg }}>
        {/* Type picker */}
        <FxCol gap={MOBILE_V2_SPACING.md}>
          <Text
            style={{
              fontSize: MOBILE_V2_TYPE_SIZES.label,
              color: theme.muted,
              fontWeight: MOBILE_V2_TYPE_WEIGHTS.bold,
              letterSpacing: 0.6,
              textTransform: "uppercase",
              fontFamily: MOBILE_V2_FONT_SANS,
            }}
          >
            Return reason
          </Text>
          <FxCol gap={MOBILE_V2_SPACING.md}>
            {props.returnTypes.map((r) => {
              const on = props.selectedTypeId === r.id;
              return (
                <Pressable
                  key={r.id}
                  onPress={() => props.onSelectType(r.id)}
                  accessibilityRole="radio"
                  accessibilityLabel={`Select return reason ${r.label}`}
                  accessibilityState={{ selected: on }}
                  style={{
                    flexDirection: "row",
                    alignItems: "center",
                    columnGap: MOBILE_V2_SPACING.xl,
                    paddingVertical: MOBILE_V2_SPACING.xl,
                    paddingHorizontal: MOBILE_V2_SPACING["2xl"],
                    backgroundColor: on ? theme.accentSoft : theme.surface,
                    borderColor: on ? theme.accent : theme.border,
                    borderWidth: 1,
                    borderRadius: MOBILE_V2_RADII.input,
                  }}
                >
                  <View
                    style={{
                      width: 18,
                      height: 18,
                      borderRadius: 9,
                      borderWidth: 2,
                      borderColor: on ? theme.accent : theme.border,
                      backgroundColor: on ? theme.accent : "transparent",
                    }}
                  />
                  {reasonIconEnabled ? (
                    <FxIcon name={r.icon} size={18} color={on ? theme.accent : theme.muted} />
                  ) : null}
                  <Text
                    style={{
                      flex: 1,
                      minWidth: 0,
                      fontSize: MOBILE_V2_TYPE_SIZES.body,
                      fontWeight: MOBILE_V2_TYPE_WEIGHTS.semibold,
                      color: theme.ink,
                      fontFamily: MOBILE_V2_FONT_SANS,
                    }}
                  >
                    {r.label}
                  </Text>
                </Pressable>
              );
            })}
          </FxCol>
        </FxCol>

        {/* Photo capture */}
        <FxCol gap={MOBILE_V2_SPACING.md}>
          <Text
            style={{
              fontSize: MOBILE_V2_TYPE_SIZES.label,
              color: theme.muted,
              fontWeight: MOBILE_V2_TYPE_WEIGHTS.bold,
              letterSpacing: 0.6,
              textTransform: "uppercase",
              fontFamily: MOBILE_V2_FONT_SANS,
            }}
          >
            Parcel condition photo
          </Text>
          {/* Design canvas SheetReturn renders the photo tile via
              FxPhotoCapture (flow-extras.jsx:76) — a fixed-height
              (height=120) FxCard with a horizontal FxRow inside
              centering [camera icon · gap 8 · "Add photo" label].
              Switch impl to row layout with minHeight=120 so the
              empty state matches the design's tile geometry. */}
          <Pressable
            onPress={props.onTogglePhoto}
            accessibilityRole="button"
            accessibilityLabel={
              props.photoCaptured
                ? "Photo captured — tap to retake"
                : "Capture parcel condition"
            }
            style={{
              minHeight: 120,
              paddingVertical: MOBILE_V2_SPACING["3xl"],
              paddingHorizontal: MOBILE_V2_SPACING.lg,
              backgroundColor: props.photoCaptured ? theme.successSoft : theme.surfaceAlt,
              borderColor: props.photoCaptured ? theme.success : theme.border,
              borderWidth: 1,
              borderRadius: MOBILE_V2_RADII.button,
              flexDirection: "row",
              alignItems: "center",
              justifyContent: "center",
              columnGap: MOBILE_V2_SPACING.lg,
              rowGap: MOBILE_V2_SPACING.lg,
            }}
          >
            <FxIcon
              name={props.photoCaptured ? "check-double" : "camera"}
              size={props.photoCaptured ? 26 : 20}
              color={props.photoCaptured ? theme.success : theme.muted}
            />
            <Text
              style={{
                fontSize: MOBILE_V2_TYPE_SIZES.caption,
                color: props.photoCaptured ? theme.success : theme.ink,
                fontFamily: MOBILE_V2_FONT_SANS,
                fontWeight: MOBILE_V2_TYPE_WEIGHTS.semibold,
              }}
            >
              {props.photoCaptured ? "Captured · GPS + timestamp" : "Add photo"}
            </Text>
          </Pressable>
        </FxCol>

        {/* Optional dispatch-note section. Hidden in design-parity mode
            (e.g. audit gallery preview) since the design canvas
            SheetReturn artboard does not include this textarea. */}
        {noteEnabled ? (
          <FxCol gap={MOBILE_V2_SPACING.md}>
            <Text
              style={{
                fontSize: MOBILE_V2_TYPE_SIZES.label,
                color: theme.muted,
                fontWeight: MOBILE_V2_TYPE_WEIGHTS.bold,
                letterSpacing: 0.6,
                textTransform: "uppercase",
                fontFamily: MOBILE_V2_FONT_SANS,
              }}
            >
              Note · optional
            </Text>
            <TextInput
              value={props.note}
              onChangeText={props.onNoteChange}
              placeholder="Anything dispatch should know?"
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
                minHeight: 64,
                textAlignVertical: "top",
              }}
            />
          </FxCol>
        ) : null}

        <FxCard theme={theme} soft>
          <FxRow gap={MOBILE_V2_SPACING.xl} align="center">
            <FxIcon name="info" size={14} color={theme.info} />
            <Text
              style={{
                fontSize: 11.5,
                color: theme.ink,
                fontFamily: MOBILE_V2_FONT_SANS,
                flex: 1,
              }}
            >
              Sealed and routed to Bay R · Returns on next hub-pass. Customer gets refund SMS.
            </Text>
          </FxRow>
        </FxCard>

      </FxCol>
    </MobileV2BottomSheet>
  );
}
