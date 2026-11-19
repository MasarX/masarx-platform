// Mobile V2 SwitchLang sheet — pixel-faithful port of design source
// flow-extras.jsx SheetSwitchLang. App-wide language switcher with
// LTR/RTL preview. Languages list comes from policy
// (`mobile_locale_policy`); current selection is resolver state.

import * as React from "react";
import { Pressable, Text, View } from "react-native";

import { FxChip, FxCol } from "./mobile-v2-primitives";
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

export type MobileV2LangDir = "ltr" | "rtl";

export interface MobileV2LangOption {
  readonly id: string;
  /** English/canonical label, e.g. "Arabic". */
  readonly label: string;
  /** Native rendering label, e.g. "العربية". */
  readonly nativeLabel: string;
  readonly dir: MobileV2LangDir;
}

export interface MobileV2SwitchLangSheetProps {
  readonly theme: MobileV2Theme;
  readonly visible: boolean;
  readonly onClose: () => void;
  readonly currentLangId: string;
  readonly languages: ReadonlyArray<MobileV2LangOption>;
  readonly onSelect: (id: string) => void;
}

export function MobileV2SwitchLangSheet(
  props: MobileV2SwitchLangSheetProps,
): React.ReactElement {
  const { theme } = props;
  return (
    <MobileV2BottomSheet
      theme={theme}
      visible={props.visible}
      onClose={props.onClose}
      title="Language"
      subtitle="Applies app-wide · matches your phone if changed"
    >
      <FxCol gap={MOBILE_V2_SPACING.md} style={{ paddingVertical: MOBILE_V2_SPACING.lg }}>
        {props.languages.map((l) => {
          const on = props.currentLangId === l.id;
          return (
            <Pressable
              key={l.id}
              onPress={() => props.onSelect(l.id)}
              accessibilityRole="button"
              accessibilityLabel={`Select language ${l.label}`}
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
              <FxIcon name="globe" size={18} color={on ? theme.accent : theme.muted} />
              <View
                style={{
                  flex: 1,
                  minWidth: 0,
                  flexDirection: "column",
                  rowGap: 2,
                  alignItems: l.dir === "rtl" ? "flex-end" : "flex-start",
                }}
              >
                <Text
                  style={{
                    fontSize: MOBILE_V2_TYPE_SIZES.bodyStrong,
                    fontWeight: MOBILE_V2_TYPE_WEIGHTS.semibold,
                    color: theme.ink,
                    fontFamily: MOBILE_V2_FONT_SANS,
                    writingDirection: l.dir,
                  }}
                >
                  {l.nativeLabel}
                </Text>
                {/* Caption mirrors design SSOT `flow-extras.jsx` SheetSwitchLang
                    line 749 which renders `{l.id} · {l.dir.toUpperCase()}` in
                    the mono caption — the locale id (en-SA / ar-SA / ur-PK) is
                    what's shown beneath the native-script label, not the
                    English label. Keeping mono font matches FX_MONO usage. */}
                <Text
                  style={{
                    fontSize: 10.5,
                    color: theme.muted,
                    fontFamily: MOBILE_V2_FONT_MONO,
                  }}
                >
                  {l.id} · {l.dir.toUpperCase()}
                </Text>
              </View>
              {on ? (
                <FxChip theme={theme} tone="accent" dense>
                  Current
                </FxChip>
              ) : null}
            </Pressable>
          );
        })}
      </FxCol>
    </MobileV2BottomSheet>
  );
}
