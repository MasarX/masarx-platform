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
import { StatusTimeline } from "../../apps/fieldops/src/components/StatusTimeline";

test.each(["vertical", "horizontal"] as const)("labels lifecycle steps in %s order", orientation => {
  const tree = StatusTimeline({
    orientation,
    steps: [
      { key: "start", label: "Started", state: "complete", timestamp: "2030-01-01T10:00:00Z" },
      { key: "finish", label: "Finish", state: "skipped", failureReason: "Fixture reason" },
    ],
  });

  const [start, finish] = tree.props.children;
  expect(start.props.testID).toBe("status-timeline-step-start");
  expect(start.props.accessibilityLabel).toBe("Started, complete, 2030-01-01T10:00:00Z");
  expect(finish.props.accessibilityLabel).toBe("Finish, skipped, Fixture reason");
  expect(finish.props.style).toContainEqual({ opacity: 0.5 });

  const [, connector] = start.props.children[0].props.children;
  expect(connector.props.style).toContainEqual({ backgroundColor: getTokensForTheme("light").color.success });
  expect(finish.props.children[0].props.children[1]).toBeNull();
});

test("renders an empty list for no steps", () => {
  expect(StatusTimeline({ steps: [] }).props.children).toEqual([]);
});
