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

import type { ThemeTokens } from "../../apps/fieldops/src/mobile-theme";
let mockRtl = false;
jest.mock("../../apps/fieldops/src/mobile-shell-rtl", () => ({ useIsRTL: () => mockRtl }));

import { Icon, ICON_MIRRORS_RTL } from "../../apps/fieldops/src/components/IconRegistry";

test("mirrors only directional affordances in right-to-left layouts", () => {
  expect([...ICON_MIRRORS_RTL].sort()).toEqual(["chevron-left", "chevron-right", "navigation", "route"]);
  mockRtl = true;
  try {
    expect(Icon({ name: "chevron-right" }).props.style[1].transform).toEqual([{ scaleX: -1 }]);
    expect(Icon({ name: "home" }).props.style[1].transform).toBeUndefined();
  } finally {
    mockRtl = false;
  }
  expect(Icon({ name: "chevron-right" }).props.style[1].transform).toBeUndefined();
});
