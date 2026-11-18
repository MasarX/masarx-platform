jest.mock("react-native", () => ({
  View: "View",
  Text: "Text",
  Pressable: "Pressable",
  TextInput: "TextInput",
  Modal: "Modal",
  Dimensions: { get: () => ({ height: 800 }) },
  StyleSheet: { create: (styles: object) => styles, absoluteFillObject: {} },
}), { virtual: true });
jest.mock("../../apps/fieldops/src/mobile-theme-context", () => {
  const { getTokensForTheme } = jest.requireActual("../../apps/fieldops/src/mobile-theme");
  return {
    useTheme: () => ({ tokens: getTokensForTheme("light") }),
    useThemedStyles: (factory: (tokens: ThemeTokens) => unknown) => factory(getTokensForTheme("light")),
  };
});

import { getTokensForTheme, type ThemeTokens } from "../../apps/fieldops/src/mobile-theme";
import { ShellPill, type ShellPillTone } from "../../apps/fieldops/src/components/ShellPill";

const colors = getTokensForTheme("light").color;

test.each<[ShellPillTone, string, string, string]>([
  ["neutral", colors.cardBg, colors.border, colors.metaFg],
  ["positive", colors.successSoft, colors.success, colors.successFg],
  ["warning", colors.warningSoft, colors.warning, colors.warningFg],
  ["offline", colors.dangerSoft, colors.danger, colors.dangerFg],
])("uses the %s palette", (tone, backgroundColor, borderColor, color) => {
  const pill = ShellPill({ label: "Connection", tone, dot: true, testID: "fixture-pill" });
  const [dot, label] = pill.props.children;
  expect(pill.props.accessibilityLabel).toBe("Connection");
  expect(pill.props.style).toContainEqual({ backgroundColor, borderColor });
  expect(dot.props.testID).toBe("fixture-pill-dot");
  expect(label.props.style).toContainEqual({ color });
});

test("omits the dot by default and preserves the explicit announcement", () => {
  const pill = ShellPill({ label: "Connection", accessibilityLabel: "Connection status" });
  expect(pill.props.children[0]).toBeNull();
  expect(pill.props.accessibilityLabel).toBe("Connection status");
});
