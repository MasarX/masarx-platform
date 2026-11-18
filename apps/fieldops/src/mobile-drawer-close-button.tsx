import React from "react";
import { Pressable, Text, type StyleProp, type TextStyle, type ViewStyle } from "react-native";
import { getFieldOpsStrings } from "./i18n";
import type { MobileLocaleMode } from "./mobile-shell-display";
import { FIELDOPS_NATIVE_E2E_TEST_IDS } from "./mobile-native-e2e-test-ids";

export function FieldOpsDrawerCloseButton({ locale, onClose, style, textStyle }: {
  locale: MobileLocaleMode; onClose: () => void; style: StyleProp<ViewStyle>; textStyle: StyleProp<TextStyle>;
}) {
  return <Pressable accessibilityRole="button" accessibilityLabel={getFieldOpsStrings(locale).more.closeModulesMenu}
    testID={FIELDOPS_NATIVE_E2E_TEST_IDS.menuClose} onPress={onClose}
    style={({ pressed }) => [style, { width: 44, height: 44, borderRadius: 22 }, pressed && { opacity: 0.8 }]}>
    <Text style={textStyle}>{"\u00D7"}</Text>
  </Pressable>;
}
