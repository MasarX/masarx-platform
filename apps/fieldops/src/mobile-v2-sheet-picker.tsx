// Mobile V2 single-select picker sheet — pixel-faithful port of design
// source flow-tasks.jsx SheetPickerLite / flow-route.jsx SheetPicker.
// One stacked row per option, a check on the active value.
//
// Audit F9: the Tasks / Route "Group" + "Sort" chips were toast-only
// stubs. They now open this sheet and the selection actually re-sorts /
// re-groups the list.

import * as React from "react";
import { Pressable, Text, View, type StyleProp, type ViewStyle } from "react-native";

import { FxIcon } from "./mobile-v2-icon";
import { MobileV2BottomSheet } from "./mobile-v2-bottom-sheet";
import {
  MOBILE_V2_FONT_SANS,
  MOBILE_V2_SPACING,
  MOBILE_V2_TYPE_WEIGHTS,
  type MobileV2Theme,
} from "./mobile-v2-themes";

export interface MobileV2PickerOption {
  readonly key: string;
  readonly label: string;
}

export interface MobileV2PickerSheetProps {
  readonly theme: MobileV2Theme;
  readonly visible: boolean;
  readonly onClose: () => void;
  readonly title: string;
  readonly options: ReadonlyArray<MobileV2PickerOption>;
  readonly value: string;
  readonly onPick: (key: string) => void;
  readonly style?: StyleProp<ViewStyle>;
}

export function MobileV2PickerSheet(
  props: MobileV2PickerSheetProps,
): React.ReactElement {
  const { theme } = props;
  return (
    <MobileV2BottomSheet
      theme={theme}
      visible={props.visible}
      onClose={props.onClose}
      title={props.title}
      style={props.style}
    >
      <View
        style={{
          backgroundColor: theme.border,
          rowGap: 1,
          marginHorizontal: -MOBILE_V2_SPACING["3xl"],
        }}
      >
        {props.options.map((o) => {
          const active = o.key === props.value;
          return (
            <Pressable
              key={o.key}
              onPress={() => props.onPick(o.key)}
              accessibilityRole="button"
              accessibilityLabel={o.label}
              accessibilityState={{ selected: active }}
              style={{
                backgroundColor: theme.surface,
                paddingVertical: 14,
                paddingHorizontal: 16,
                flexDirection: "row",
                alignItems: "center",
                justifyContent: "space-between",
              }}
            >
              <Text
                style={{
                  fontSize: 14,
                  fontWeight: MOBILE_V2_TYPE_WEIGHTS.semibold,
                  color: theme.ink,
                  fontFamily: MOBILE_V2_FONT_SANS,
                }}
              >
                {o.label}
              </Text>
              {active ? <FxIcon name="check" size={18} color={theme.ink} /> : null}
            </Pressable>
          );
        })}
      </View>
    </MobileV2BottomSheet>
  );
}
