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
import {
  IllustrationDayComplete,
  IllustrationEmptyTasks,
  IllustrationLocationDenied,
  IllustrationOffline,
  IllustrationOutboxClear,
} from "../../apps/fieldops/src/illustrations";

test.each([
  IllustrationDayComplete, IllustrationEmptyTasks, IllustrationLocationDenied,
  IllustrationOffline, IllustrationOutboxClear,
])("%p exposes an accessible image and honors the requested size", Illustration => {
  const defaults = Illustration({});
  const resized = Illustration({ size: 96, testID: "fixture-illustration" });

  expect(defaults.props.style).toMatchObject({ width: 160, height: 160 });
  expect(resized.props).toMatchObject({
    accessible: true,
    accessibilityRole: "image",
    testID: "fixture-illustration",
    style: { width: 96, height: 96 },
  });
  expect(resized.props.accessibilityLabel).toEqual(expect.any(String));
  expect(resized.props.accessibilityLabel.trim()).not.toBe("");
  expect(Object.values(getTokensForTheme("light").color)).toContain(resized.props.style.backgroundColor);
});
