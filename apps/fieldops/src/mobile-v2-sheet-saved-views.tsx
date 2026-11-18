// Mobile V2 Saved Views sheet — pixel-faithful port of design source
// flow-tasks.jsx SheetTaskViews / flow-route.jsx SheetViews. One row per
// saved view: emoji glyph + name + "built-in" chip + a group/sort/filter
// summary line, with a check on the active view.
//
// Audit F8: the Tasks / Route app-bar title is a saved-view picker in the
// design (a <button> opening this sheet). The title was a dead <Text>;
// this sheet is the real picker it now opens.

import * as React from "react";
import { Pressable, Text, View, type StyleProp, type ViewStyle } from "react-native";

import { FxChip, FxCol, FxRow } from "./mobile-v2-primitives";
import { FxIcon } from "./mobile-v2-icon";
import { MobileV2BottomSheet } from "./mobile-v2-bottom-sheet";
import {
  MOBILE_V2_FONT_SANS,
  MOBILE_V2_SPACING,
  MOBILE_V2_TYPE_WEIGHTS,
  type MobileV2Theme,
} from "./mobile-v2-themes";

export interface MobileV2SavedViewRow {
  readonly id: string;
  readonly name: string;
  readonly emoji: string;
  readonly builtin: boolean;
  /** Secondary line — e.g. "Grouped by urgency · Sort smart". */
  readonly summary: string;
}

export interface MobileV2SavedViewsSheetProps {
  readonly theme: MobileV2Theme;
  readonly visible: boolean;
  readonly onClose: () => void;
  readonly views: ReadonlyArray<MobileV2SavedViewRow>;
  readonly activeId: string;
  readonly onPick: (id: string) => void;
  readonly style?: StyleProp<ViewStyle>;
}

export function MobileV2SavedViewsSheet(
  props: MobileV2SavedViewsSheetProps,
): React.ReactElement {
  const { theme } = props;
  return (
    <MobileV2BottomSheet
      theme={theme}
      visible={props.visible}
      onClose={props.onClose}
      title="Saved views"
      subtitle="Switch or pick a view to edit"
      style={props.style}
    >
      {/* Edge-to-edge stacked rows over a 1px border divider — design
          SheetTaskViews `FxCol gap=1, bg=border`. */}
      <View
        style={{
          backgroundColor: theme.border,
          rowGap: 1,
          marginHorizontal: -MOBILE_V2_SPACING["3xl"],
        }}
      >
        {props.views.map((v) => {
          const active = v.id === props.activeId;
          return (
            <Pressable
              key={v.id}
              onPress={() => props.onPick(v.id)}
              accessibilityRole="button"
              accessibilityLabel={`Saved view ${v.name}`}
              accessibilityState={{ selected: active }}
              style={{
                backgroundColor: theme.surface,
                paddingVertical: 12,
                paddingHorizontal: 16,
                flexDirection: "row",
                alignItems: "center",
                columnGap: MOBILE_V2_SPACING["2xl"],
              }}
            >
              <Text
                style={{
                  fontSize: 20,
                  width: 32,
                  textAlign: "center",
                  fontFamily: MOBILE_V2_FONT_SANS,
                }}
              >
                {v.emoji}
              </Text>
              <FxCol gap={2} style={{ flex: 1, minWidth: 0 }}>
                <FxRow gap={MOBILE_V2_SPACING.md} align="center">
                  <Text
                    style={{
                      fontSize: 14,
                      fontWeight: MOBILE_V2_TYPE_WEIGHTS.semibold,
                      color: theme.ink,
                      fontFamily: MOBILE_V2_FONT_SANS,
                    }}
                  >
                    {v.name}
                  </Text>
                  {v.builtin ? (
                    <FxChip theme={theme} dense>
                      built-in
                    </FxChip>
                  ) : null}
                </FxRow>
                <Text
                  style={{
                    fontSize: 11,
                    color: theme.muted,
                    fontFamily: MOBILE_V2_FONT_SANS,
                  }}
                  numberOfLines={1}
                >
                  {v.summary}
                </Text>
              </FxCol>
              {active ? <FxIcon name="check" size={18} color={theme.ink} /> : null}
            </Pressable>
          );
        })}
      </View>
    </MobileV2BottomSheet>
  );
}
