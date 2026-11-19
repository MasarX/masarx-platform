// Mobile V2 Filters sheet — pixel-faithful port of design source
// flow-tasks.jsx SheetTaskFilters / flow-route.jsx SheetFilters. One
// section per filter field: enum fields render a wrap of toggle chips,
// bool fields render a label + switch. Apply (primary) + Clear
// (secondary) live in the FxSheet footer band.
//
// Audit F9: the Tasks "Filters" chip + Route "Filters" chip were
// toast-only stubs. They now open this sheet, and the selections
// actually filter the list.

import * as React from "react";
import { Pressable, Text, View, type StyleProp, type ViewStyle } from "react-native";

import { FxButton, FxChip, FxRow } from "./mobile-v2-primitives";
import { FxIcon } from "./mobile-v2-icon";
import { MobileV2BottomSheet } from "./mobile-v2-bottom-sheet";
import {
  MOBILE_V2_FONT_SANS,
  MOBILE_V2_SPACING,
  MOBILE_V2_TYPE_WEIGHTS,
  type MobileV2Theme,
} from "./mobile-v2-themes";

export interface MobileV2FilterEnumOption {
  readonly value: string;
  readonly label: string;
}

export interface MobileV2FilterFieldSpec {
  readonly key: string;
  readonly label: string;
  readonly kind: "enum" | "bool";
  /** Enum option list. For dynamic fields the host supplies the resolved list. */
  readonly options?: ReadonlyArray<MobileV2FilterEnumOption>;
}

/** Per-key filter selection — enum keys hold a value array, bool keys hold true. */
export type MobileV2FilterState = Readonly<
  Record<string, ReadonlyArray<string> | boolean | undefined>
>;

export interface MobileV2TaskFiltersSheetProps {
  readonly theme: MobileV2Theme;
  readonly visible: boolean;
  readonly onClose: () => void;
  readonly title?: string;
  readonly fields: ReadonlyArray<MobileV2FilterFieldSpec>;
  readonly filters: MobileV2FilterState;
  readonly activeCount: number;
  readonly onChange: (next: MobileV2FilterState) => void;
  /** Apply CTA — host closes the sheet (the filter state is already live). */
  readonly onApply: () => void;
  readonly style?: StyleProp<ViewStyle>;
}

export function MobileV2TaskFiltersSheet(
  props: MobileV2TaskFiltersSheetProps,
): React.ReactElement {
  const { theme, filters } = props;

  const toggleEnum = (key: string, value: string): void => {
    const cur = filters[key];
    const arr = Array.isArray(cur) ? cur : [];
    const next = arr.includes(value)
      ? arr.filter((x) => x !== value)
      : [...arr, value];
    props.onChange({
      ...filters,
      [key]: next.length > 0 ? Object.freeze(next) : undefined,
    });
  };

  const toggleBool = (key: string): void => {
    props.onChange({
      ...filters,
      [key]: filters[key] === true ? undefined : true,
    });
  };

  return (
    <MobileV2BottomSheet
      theme={theme}
      visible={props.visible}
      onClose={props.onClose}
      title={props.title ?? "Filters"}
      subtitle={`${props.activeCount} active`}
      style={props.style}
      secondary={
        <FxButton
          theme={theme}
          variant="ghost"
          full
          onPress={() => props.onChange({})}
          accessibilityLabel="Clear all filters"
        >
          Clear
        </FxButton>
      }
      primary={
        <FxButton
          theme={theme}
          variant="primary"
          full
          icon="check"
          onPress={props.onApply}
          accessibilityLabel="Apply filters"
        >
          Apply
        </FxButton>
      }
    >
      <View style={{ marginHorizontal: -MOBILE_V2_SPACING["3xl"] }}>
        {props.fields.map((field) => (
          <View
            key={field.key}
            style={{
              paddingTop: MOBILE_V2_SPACING.lg,
              paddingBottom: MOBILE_V2_SPACING["3xl"],
              paddingHorizontal: 16,
              borderBottomWidth: 1,
              borderBottomColor: theme.border,
            }}
          >
            <Text
              style={{
                fontSize: 11,
                color: theme.muted,
                fontWeight: MOBILE_V2_TYPE_WEIGHTS.bold,
                letterSpacing: 0.6,
                textTransform: "uppercase",
                marginBottom: MOBILE_V2_SPACING.lg,
                fontFamily: MOBILE_V2_FONT_SANS,
              }}
            >
              {field.label}
            </Text>
            {field.kind === "enum" ? (
              <FxRow gap={MOBILE_V2_SPACING.md} wrap>
                {(field.options ?? []).map((o) => {
                  const cur = filters[field.key];
                  const on = Array.isArray(cur) && cur.includes(o.value);
                  return (
                    <Pressable
                      key={o.value}
                      onPress={() => toggleEnum(field.key, o.value)}
                      accessibilityRole="button"
                      accessibilityLabel={`${field.label} ${o.label}`}
                      accessibilityState={{ selected: on }}
                    >
                      <FxChip
                        theme={theme}
                        tone={on ? "accent" : "neutral"}
                        dense
                        icon={on ? "check" : undefined}
                      >
                        {o.label}
                      </FxChip>
                    </Pressable>
                  );
                })}
                {(field.options ?? []).length === 0 ? (
                  <Text
                    style={{
                      fontSize: 12,
                      color: theme.muted,
                      fontFamily: MOBILE_V2_FONT_SANS,
                    }}
                  >
                    No options
                  </Text>
                ) : null}
              </FxRow>
            ) : (
              <FxRow justify="space-between" align="center">
                <FxRow gap={MOBILE_V2_SPACING.md} align="center">
                  <FxIcon name="cash" size={16} color={theme.muted} />
                  <Text
                    style={{
                      fontSize: 13,
                      fontWeight: MOBILE_V2_TYPE_WEIGHTS.semibold,
                      color: theme.ink,
                      fontFamily: MOBILE_V2_FONT_SANS,
                    }}
                  >
                    {field.label}
                  </Text>
                </FxRow>
                {/* Switch — design SheetTaskFilters bool toggle (44×26 track). */}
                <Pressable
                  onPress={() => toggleBool(field.key)}
                  accessibilityRole="switch"
                  accessibilityLabel={field.label}
                  accessibilityState={{ checked: filters[field.key] === true }}
                  style={{
                    width: 44,
                    height: 26,
                    borderRadius: 13,
                    backgroundColor:
                      filters[field.key] === true ? theme.accent : theme.surfaceAlt,
                    justifyContent: "center",
                  }}
                >
                  <View
                    style={{
                      position: "absolute",
                      top: 3,
                      left: filters[field.key] === true ? 21 : 3,
                      width: 20,
                      height: 20,
                      borderRadius: 10,
                      backgroundColor: "#FFFFFF",
                    }}
                  />
                </Pressable>
              </FxRow>
            )}
          </View>
        ))}
      </View>
    </MobileV2BottomSheet>
  );
}
