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
import { BottomSheet } from "../../apps/fieldops/src/components/BottomSheet";

test("locks backdrop dismissal while leaving both explicit close controls available", () => {
  const onDismiss = jest.fn();
  const modal = BottomSheet({
    visible: true, title: "Fixture sheet", children: "Body", onDismiss, dismissOnBackdrop: false,
  });
  const [backdrop, panel] = modal.props.children.props.children;
  const [, close] = panel.props.children[0].props.children;

  expect(modal.props).toMatchObject({
    visible: true, accessibilityRole: "dialog", accessibilityViewIsModal: true,
    accessibilityLabel: "Fixture sheet",
  });
  expect(backdrop.props.style.backgroundColor).toBe(getTokensForTheme("light").color.overlayScrim);
  backdrop.props.onPress();
  expect(onDismiss).not.toHaveBeenCalled();
  close.props.onPress();
  modal.props.onRequestClose();
  expect(onDismiss).toHaveBeenCalledTimes(2);
});

test("dismisses on backdrop press with the default policy", () => {
  const onDismiss = jest.fn();
  const modal = BottomSheet({ visible: true, children: null, onDismiss });
  modal.props.children.props.children[0].props.onPress();
  expect(onDismiss).toHaveBeenCalledTimes(1);
});

test.each([[undefined, 720], [0.5, 400], [2, 800], [0, 720]] as const)(
  "applies viewport height clamp for %s", (maxHeightPct, expected) => {
    const modal = BottomSheet({ visible: false, children: null, onDismiss: jest.fn(), maxHeightPct });
    const [, panel] = modal.props.children.props.children;
    expect(modal.props.visible).toBe(false);
    expect(panel.props.style).toContainEqual({ maxHeight: expected });
  },
);
