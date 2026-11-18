// Mobile V2 Pre-shift Checklist screen — pixel-faithful port of design
// source flow-auth.jsx ScrChecklist. 2-min vehicle + safety check the
// driver works through before route start. Items are data-driven so
// per-tenant cadences can extend the list without UI changes.
//
// Stateless: parent owns the list, the checked-set, and the submit
// action. The CTA flips success ↔ soft based on completeness.

import * as React from "react";
import {
  Pressable,
  ScrollView,
  Text,
  View,
  type StyleProp,
  type ViewStyle,
} from "react-native";

import { FxButton, FxCard, FxCol, FxRow } from "./mobile-v2-primitives";
import { FxIcon } from "./mobile-v2-icon";
import {
  MOBILE_V2_FONT_SANS,
  MOBILE_V2_SPACING,
  MOBILE_V2_TYPE_WEIGHTS,
  type MobileV2Theme,
} from "./mobile-v2-themes";

export interface MobileV2ChecklistItem {
  readonly id: string;
  readonly label: string;
  readonly sub: string;
}

export interface MobileV2PreShiftChecklistScreenProps {
  readonly theme: MobileV2Theme;
  readonly items: ReadonlyArray<MobileV2ChecklistItem>;
  readonly checkedIds: ReadonlyArray<string>;
  readonly onToggle: (id: string) => void;
  readonly onConfirm: () => void;
  readonly onBack?: () => void;
  readonly style?: StyleProp<ViewStyle>;
}

export function MobileV2PreShiftChecklistScreen(
  props: MobileV2PreShiftChecklistScreenProps,
): React.ReactElement {
  const { theme, items, checkedIds } = props;
  const checkedSet = React.useMemo(() => new Set(checkedIds), [checkedIds]);
  const allChecked = items.length > 0 && items.every((i) => checkedSet.has(i.id));

  return (
    <View style={[{ flex: 1, backgroundColor: theme.bg }, props.style]}>
      {/* App bar is rendered by the gallery / host ScreenShell via FxAppBar
          (title "Pre-shift checklist", sub "2-min vehicle + safety check"). */}
      <ScrollView
        contentContainerStyle={{ paddingBottom: 140 }}
        keyboardShouldPersistTaps="handled"
      >
        {/* Rows with hairline dividers via background color trick */}
        <View style={{ backgroundColor: theme.border, rowGap: 1 }}>
          {items.map((i) => {
            const on = checkedSet.has(i.id);
            return (
              <Pressable
                key={i.id}
                onPress={() => props.onToggle(i.id)}
                accessibilityRole="checkbox"
                accessibilityState={{ checked: on }}
                accessibilityLabel={`${i.label} — ${i.sub}`}
                style={{
                  backgroundColor: theme.surface,
                  paddingHorizontal: 16,
                  paddingVertical: 14,
                  flexDirection: "row",
                  gap: 12,
                  alignItems: "center",
                }}
              >
                <View
                  style={{
                    width: 26,
                    height: 26,
                    borderRadius: 8,
                    backgroundColor: on ? theme.success : theme.surfaceAlt,
                    borderColor: on ? "transparent" : theme.border,
                    borderWidth: 1,
                    alignItems: "center",
                    justifyContent: "center",
                  }}
                >
                  {on ? <FxIcon name="check" size={16} color="#FFFFFF" stroke={2.5} /> : null}
                </View>
                <FxCol gap={2} style={{ flex: 1, minWidth: 0 }}>
                  <Text
                    style={{
                      fontSize: 14,
                      fontWeight: MOBILE_V2_TYPE_WEIGHTS.semibold,
                      color: theme.ink,
                      fontFamily: MOBILE_V2_FONT_SANS,
                    }}
                  >
                    {i.label}
                  </Text>
                  <Text
                    style={{
                      fontSize: 11.5,
                      color: theme.muted,
                      fontFamily: MOBILE_V2_FONT_SANS,
                    }}
                  >
                    {i.sub}
                  </Text>
                </FxCol>
              </Pressable>
            );
          })}
        </View>

        <View style={{ padding: 16 }}>
          <FxCard theme={theme} soft>
            <FxRow gap={10} align="flex-start">
              <FxIcon name="alert" size={18} color={theme.muted} />
              <FxCol gap={2} style={{ flex: 1, minWidth: 0 }}>
                <Text
                  style={{
                    fontSize: 13,
                    fontWeight: MOBILE_V2_TYPE_WEIGHTS.semibold,
                    color: theme.ink,
                    fontFamily: MOBILE_V2_FONT_SANS,
                  }}
                >
                  Why this matters
                </Text>
                <Text
                  style={{
                    fontSize: 12,
                    color: theme.muted,
                    fontFamily: MOBILE_V2_FONT_SANS,
                    lineHeight: 18,
                  }}
                >
                  Pre-shift checks prevent 80% of route blockers. Skipping is logged.
                </Text>
              </FxCol>
            </FxRow>
          </FxCard>
        </View>
      </ScrollView>

      <View
        style={{
          paddingHorizontal: 16,
          paddingTop: MOBILE_V2_SPACING["2xl"],
          paddingBottom: MOBILE_V2_SPACING["3xl"],
          borderTopColor: theme.border,
          borderTopWidth: 1,
          backgroundColor: theme.surface,
        }}
      >
        <FxButton
          theme={theme}
          variant={allChecked ? "success" : "soft"}
          full
          size="lg"
          icon={allChecked ? "check" : "alert"}
          disabled={!allChecked}
          onPress={() => allChecked && props.onConfirm()}
          accessibilityLabel={
            allChecked ? "Confirm and start shift" : "Tick all items to continue"
          }
        >
          {allChecked ? "Confirm & start shift" : "Tick all items to continue"}
        </FxButton>
      </View>
    </View>
  );
}
