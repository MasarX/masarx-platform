// Mobile V2 NotifPrefs sheet — pixel-faithful port of design source
// flow-extras.jsx SheetNotifPrefs. Lists notification channels with
// per-channel toggle. The category registry comes from
// `mobile_notification_prefs_policy`; critical channels (alerts, dispatch
// chat) may be marked non-mutable upstream (orchestrator passes an
// already-disabled toggle — sheet doesn't decide which can be muted, it
// just renders the current state and emits onToggle).

import * as React from "react";
import { Pressable, Text, View, type StyleProp, type ViewStyle } from "react-native";

import { FxCol, FxRow } from "./mobile-v2-primitives";
import { FxIcon } from "./mobile-v2-icon";
import { MobileV2BottomSheet } from "./mobile-v2-bottom-sheet";
import {
  MOBILE_V2_DIMENSIONS,
  MOBILE_V2_FONT_SANS,
  MOBILE_V2_RADII,
  MOBILE_V2_SPACING,
  MOBILE_V2_TYPE_SIZES,
  MOBILE_V2_TYPE_WEIGHTS,
  type MobileV2Theme,
} from "./mobile-v2-themes";

export interface MobileV2NotifChannel {
  readonly id: string;
  readonly label: string;
  readonly description: string;
  readonly enabled: boolean;
}

export interface MobileV2NotifPrefsSheetProps {
  readonly theme: MobileV2Theme;
  readonly visible: boolean;
  readonly onClose: () => void;
  readonly channels: ReadonlyArray<MobileV2NotifChannel>;
  readonly onToggle: (id: string) => void;
  readonly style?: StyleProp<ViewStyle>;
}

export function MobileV2NotifPrefsSheet(
  props: MobileV2NotifPrefsSheetProps,
): React.ReactElement {
  const { theme } = props;

  return (
    <MobileV2BottomSheet
      theme={theme}
      visible={props.visible}
      onClose={props.onClose}
      title="Notification preferences"
      subtitle="Critical alerts can't be muted"
      style={props.style}
    >
      <View
        style={{
          backgroundColor: theme.border,
          borderTopWidth: 1,
          borderBottomWidth: 1,
          borderColor: theme.border,
          rowGap: 1,
        }}
      >
        {props.channels.map((c) => (
          <View
            key={c.id}
            style={{
              backgroundColor: theme.surface,
              paddingVertical: MOBILE_V2_SPACING["3xl"],
              paddingHorizontal: MOBILE_V2_SPACING["3xl"],
              flexDirection: "row",
              alignItems: "center",
              columnGap: MOBILE_V2_SPACING["2xl"],
            }}
          >
            <FxCol gap={2} style={{ flex: 1, minWidth: 0 }}>
              <Text
                style={{
                  fontSize: MOBILE_V2_TYPE_SIZES.rowLabel,
                  fontWeight: MOBILE_V2_TYPE_WEIGHTS.semibold,
                  color: theme.ink,
                  fontFamily: MOBILE_V2_FONT_SANS,
                }}
              >
                {c.label}
              </Text>
              <Text
                style={{
                  fontSize: MOBILE_V2_TYPE_SIZES.label,
                  color: theme.muted,
                  fontFamily: MOBILE_V2_FONT_SANS,
                }}
              >
                {c.description}
              </Text>
            </FxCol>
            <Pressable
              onPress={() => props.onToggle(c.id)}
              accessibilityRole="switch"
              accessibilityLabel={`Toggle ${c.label}`}
              accessibilityState={{ checked: c.enabled }}
              style={{
                width: MOBILE_V2_DIMENSIONS.toggleTrackWidth,
                height: MOBILE_V2_DIMENSIONS.toggleTrackHeight,
                borderRadius: 14,
                backgroundColor: c.enabled ? theme.success : theme.surfaceAlt,
                justifyContent: "center",
                paddingHorizontal: 3,
                borderWidth: 1,
                borderColor: c.enabled ? theme.success : theme.border,
              }}
            >
              <View
                style={{
                  width: MOBILE_V2_DIMENSIONS.toggleKnob,
                  height: MOBILE_V2_DIMENSIONS.toggleKnob,
                  borderRadius: MOBILE_V2_DIMENSIONS.toggleKnob / 2,
                  backgroundColor: "#FFFFFF",
                  alignSelf: c.enabled ? "flex-end" : "flex-start",
                }}
              />
            </Pressable>
          </View>
        ))}
      </View>

      <FxRow gap={MOBILE_V2_SPACING.md} align="center">
        <FxIcon name="info" size={12} color={theme.muted} />
        <Text
          style={{
            fontSize: MOBILE_V2_TYPE_SIZES.label,
            color: theme.muted,
            fontFamily: MOBILE_V2_FONT_SANS,
            flex: 1,
          }}
        >
          Changes apply immediately and sync to all your devices.
        </Text>
      </FxRow>

      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          justifyContent: "center",
          columnGap: MOBILE_V2_SPACING.sm,
          paddingTop: MOBILE_V2_SPACING.sm,
          borderTopWidth: 1,
          borderTopColor: theme.border,
          marginTop: MOBILE_V2_SPACING.md,
        }}
      >
        <Pressable
          onPress={props.onClose}
          accessibilityRole="button"
          accessibilityLabel="Done editing preferences"
          style={{
            paddingVertical: MOBILE_V2_SPACING.xl,
            paddingHorizontal: MOBILE_V2_SPACING["4xl"],
            borderRadius: MOBILE_V2_RADII.button,
            backgroundColor: theme.accentSoft,
          }}
        >
          <Text
            style={{
              fontSize: MOBILE_V2_TYPE_SIZES.body,
              fontFamily: MOBILE_V2_FONT_SANS,
              fontWeight: MOBILE_V2_TYPE_WEIGHTS.semibold,
              color: theme.accent,
            }}
          >
            Done
          </Text>
        </Pressable>
      </View>
    </MobileV2BottomSheet>
  );
}
