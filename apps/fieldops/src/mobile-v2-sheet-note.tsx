// Mobile V2 operator-note sheet — a small free-text capture sheet used
// by destructive flows that need a real operator note on the canonical
// write (e.g. hold-queue "destroy" → submit_fieldops_hold_decision_v1
// p_note). Title + prompt are caller-supplied; the confirm CTA is
// disabled until the note has content.
//
// Audit F13: the hold-destroy path previously sent a hardcoded preview
// sentinel note ("Destroyed via mobile-v2 preview"). This sheet captures
// the real operator note so the decision_log row carries genuine
// context.

import * as React from "react";
import { Text, TextInput, View, type StyleProp, type ViewStyle } from "react-native";

import { FxButton, FxCol } from "./mobile-v2-primitives";
import { MobileV2BottomSheet } from "./mobile-v2-bottom-sheet";
import {
  MOBILE_V2_FONT_SANS,
  MOBILE_V2_RADII,
  MOBILE_V2_SPACING,
  MOBILE_V2_TYPE_SIZES,
  MOBILE_V2_TYPE_WEIGHTS,
  type MobileV2Theme,
} from "./mobile-v2-themes";

export interface MobileV2NoteSheetProps {
  readonly theme: MobileV2Theme;
  readonly visible: boolean;
  readonly onClose: () => void;
  readonly title: string;
  readonly subtitle?: string;
  /** Field label above the input (e.g. "Why is this parcel being destroyed?"). */
  readonly prompt: string;
  readonly placeholder?: string;
  readonly value: string;
  readonly onChangeValue: (next: string) => void;
  /** Confirm CTA label (e.g. "Destroy parcel"). */
  readonly confirmLabel: string;
  /** When true, the confirm CTA renders in danger tone. */
  readonly destructive?: boolean;
  /** Fires only when the note is non-empty. */
  readonly onConfirm: () => void;
  readonly style?: StyleProp<ViewStyle>;
}

export function MobileV2NoteSheet(
  props: MobileV2NoteSheetProps,
): React.ReactElement {
  const { theme } = props;
  const hasNote = props.value.trim().length > 0;
  return (
    <MobileV2BottomSheet
      theme={theme}
      visible={props.visible}
      onClose={props.onClose}
      title={props.title}
      subtitle={props.subtitle}
      style={props.style}
      primary={
        <FxButton
          theme={theme}
          variant={props.destructive === true ? "danger" : "primary"}
          full
          size="lg"
          icon="check"
          disabled={!hasNote}
          onPress={() => {
            if (hasNote) props.onConfirm();
          }}
          accessibilityLabel={props.confirmLabel}
        >
          {props.confirmLabel}
        </FxButton>
      }
    >
      <FxCol gap={MOBILE_V2_SPACING.md} style={{ paddingVertical: MOBILE_V2_SPACING.lg }}>
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
          {props.prompt}
        </Text>
        <TextInput
          value={props.value}
          onChangeText={props.onChangeValue}
          placeholder={props.placeholder ?? "Add a short note"}
          placeholderTextColor={theme.muted}
          multiline
          numberOfLines={3}
          accessibilityLabel={props.prompt}
          style={{
            borderColor: theme.border,
            borderWidth: 1,
            borderRadius: MOBILE_V2_RADII.button,
            backgroundColor: theme.surface,
            color: theme.ink,
            fontFamily: MOBILE_V2_FONT_SANS,
            fontSize: MOBILE_V2_TYPE_SIZES.body,
            padding: MOBILE_V2_SPACING["2xl"],
            minHeight: 84,
            textAlignVertical: "top",
          }}
        />
        {!hasNote ? (
          <View>
            <Text
              style={{
                fontSize: MOBILE_V2_TYPE_SIZES.caption,
                color: theme.muted,
                fontFamily: MOBILE_V2_FONT_SANS,
              }}
            >
              A note is required before this action can be recorded.
            </Text>
          </View>
        ) : null}
      </FxCol>
    </MobileV2BottomSheet>
  );
}
