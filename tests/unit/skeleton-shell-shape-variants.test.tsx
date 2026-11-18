import { dirname } from "node:path";
import type { ReactElement, ReactNode } from "react";
import type { SkeletonProps, SkeletonVariant } from "../../apps/fieldops/src/components/Skeleton";

jest.mock("react-native", () => ({
  Animated: { Value: class {}, View: "AnimatedView" },
  StyleSheet: { create: (styles: object) => styles },
  View: "View",
}), { virtual: true });

jest.mock("../../apps/fieldops/src/mobile-theme-context", () => {
  const { getTokensForTheme } = jest.requireActual("../../apps/fieldops/src/mobile-theme");
  return { useThemedStyles: (factory: (tokens: unknown) => unknown) => factory(getTokensForTheme("light")) };
});

const skeletonModule = "../../apps/fieldops/src/components/Skeleton";
const reactPath = require.resolve("react", { paths: [dirname(require.resolve(skeletonModule))] });
jest.doMock(reactPath, () => ({
  ...jest.requireActual(reactPath),
  useRef: (initial: unknown) => ({ current: initial }),
  useEffect: jest.fn(),
}));

const { Skeleton } = require(skeletonModule) as typeof import("../../apps/fieldops/src/components/Skeleton");

type ShapeElement = ReactElement<{
  testID?: string;
  children?: ReactNode;
  style?: unknown;
}>;

function shapeIds(node: ReactNode): string[] {
  if (Array.isArray(node)) return node.flatMap(shapeIds);
  if (!node || typeof node !== "object" || !("props" in node)) return [];
  const { props } = node as ShapeElement;
  return [...(props.testID ? [props.testID] : []), ...shapeIds(props.children)];
}

test("preserves the legacy single-pill dimensions and loading announcement", () => {
  const skeleton = Skeleton({ width: 120, height: 16, radius: 8 });
  expect(skeleton.props).toMatchObject({
    testID: "skeleton", accessibilityRole: "progressbar", accessibilityLabel: "Loading",
  });
  expect(skeleton.props.style).toContainEqual(expect.objectContaining({
    width: 120, height: 16, borderRadius: 8,
  }));
  expect(skeleton.props.children).toBeUndefined();
});

test.each<[Exclude<SkeletonVariant, "pill">, string[]]>([
  ["task-card", ["shape", "avatar", "rows", "row-0", "row-1", "meta"]],
  ["outbox-row", ["shape", "icon", "row-0", "chip"]],
  ["stop-card", ["shape", "rows", "row-0", "row-1", "row-2", "action"]],
  ["chip", ["shape"]],
  ["banner", ["shape"]],
])("keeps the %s placeholder shape and scoped selectors", (variant, suffixes) => {
  const props: SkeletonProps = { variant, testID: "fixture-loading" };
  const skeleton = Skeleton(props);
  const shape = skeleton.props.children;
  expect(shapeIds(shape.type(shape.props))).toEqual(
    suffixes.map(suffix => "fixture-loading-" + suffix)
  );
});
