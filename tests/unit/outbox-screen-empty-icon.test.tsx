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
import { EmptyState } from "../../apps/fieldops/src/components/EmptyState";
import { IllustrationOutboxClear } from "../../apps/fieldops/src/illustrations";

test("keeps the outbox illustration in the optional empty-state icon slot", () => {
  const icon = IllustrationOutboxClear();
  const props = { title: "Outbox is clear", testID: "outbox-empty" };
  const [slot, title] = EmptyState({ ...props, icon }).props.children;

  expect(slot.props).toMatchObject({ testID: "outbox-empty-icon", children: icon });
  expect(title.props.children).toBe(props.title);
  expect(icon.props).toMatchObject({
    testID: "outbox-clear-illustration", accessibilityRole: "image",
  });
  expect(EmptyState(props).props.children[0]).toBeNull();
});
