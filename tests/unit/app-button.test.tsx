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
import { AppButton } from "../../apps/fieldops/src/components/AppButton";

test("uses the active palette and keeps a compact action at the touch target minimum", () => {
  const onPress = jest.fn();
  const tokens = getTokensForTheme("light");
  const button = AppButton({ label: "Apply", size: "sm", onPress, fullWidth: true });

  expect(button.props.accessibilityLabel).toBe("Apply");
  expect(button.props.style({ pressed: false })).toContainEqual(expect.objectContaining({
    backgroundColor: tokens.color.accent,
    minHeight: 44,
    paddingHorizontal: tokens.spacing.md,
    width: "100%",
  }));
  expect(button.props.children[1].props.style).toContainEqual(expect.objectContaining({
    color: tokens.color.accentText,
  }));
  button.props.onPress();
  expect(onPress).toHaveBeenCalledTimes(1);
});

test.each(["loading", "disabled"] as const)("blocks presses while %s", state => {
  const onPress = jest.fn();
  const button = AppButton({ label: "Apply", onPress, [state]: true });

  expect(button.props.disabled).toBe(true);
  expect(button.props.accessibilityState[state === "loading" ? "busy" : "disabled"]).toBe(true);
  expect(button.props.children[1].props.testID).toBe(state === "loading"
    ? "app-button-loading"
    : "app-button-label");
  button.props.onPress();
  expect(onPress).not.toHaveBeenCalled();
});
