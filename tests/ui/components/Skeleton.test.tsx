import * as React from "react";

jest.mock(
  "react-native",
  () => {
    const ReactMod = require("react") as typeof import("react");

    const createHostView = (displayName: string) => {
      const Comp = ReactMod.forwardRef<HTMLDivElement, any>(function HostView(
        props,
        ref
      ) {
        const { testID, children, style, accessibilityLabel, accessibilityRole, ...rest } = props ?? {};
        return ReactMod.createElement(
          "div",
          {
            ref,
            "data-testid": testID,
            "data-style": JSON.stringify(style ?? null),
            "aria-label": accessibilityLabel,
            role: accessibilityRole,
            ...rest,
          },
          children
        );
      });
      (Comp as any).displayName = displayName;
      return Comp;
    };

    const View = createHostView("View");
    const Text = createHostView("Text");
    const Pressable = ReactMod.forwardRef<HTMLButtonElement, any>(
      function Pressable(props, ref) {
        const { testID, children, style, onPress, accessibilityRole, ...rest } = props ?? {};
        const resolvedStyle =
          typeof style === "function" ? style({ pressed: false }) : style;
        return ReactMod.createElement(
          "button",
          {
            ref,
            "data-testid": testID,
            "data-style": JSON.stringify(resolvedStyle ?? null),
            onClick: onPress,
            role: accessibilityRole ?? "button",
            ...rest,
          },
          typeof children === "function"
            ? children({ pressed: false })
            : children
        );
      }
    );
    (Pressable as any).displayName = "Pressable";

    const Animated = {
      Value: class {
        _value: number;
        constructor(initial: number) {
          this._value = initial;
        }
        setValue(v: number) {
          this._value = v;
        }
      },
      View,
      timing: () => ({ start: () => {}, stop: () => {} }),
      sequence: () => ({ start: () => {}, stop: () => {} }),
      loop: () => ({ start: () => {}, stop: () => {} }),
    };

    const StyleSheet = {
      create: <T extends Record<string, unknown>>(styles: T): T => styles,
      flatten: (style: unknown) => style,
    };

    const Platform = { OS: "web", select: (opts: Record<string, unknown>) => opts.web ?? opts.default };

    const ActivityIndicator = createHostView("ActivityIndicator");

    return {
      View,
      Text,
      Pressable,
      Animated,
      StyleSheet,
      Platform,
      ActivityIndicator,
    };
  },
  { virtual: true }
);

import { render as renderDom } from "@testing-library/react";
import {
  Skeleton,
  SkeletonLines,
  SkeletonCard,
  SkeletonList,
} from "../../../apps/fieldops/src/components/Skeleton";

import { ThemeProvider } from "../../../apps/fieldops/src/mobile-theme-context";
import { getTokensForTheme } from "../../../apps/fieldops/src/mobile-theme";

const tokens = getTokensForTheme("light", "web");

function render(node: React.ReactElement) {
  return renderDom(
    <ThemeProvider value={{ tokens, appliedTheme: "light", mode: "light", setMode: () => {} }}>
      {node}
    </ThemeProvider>
  );
}

describe("Skeleton", () => {
  test("renders with default testID", () => {
    const { getByTestId } = render(<Skeleton />);
    expect(getByTestId("skeleton")).toBeTruthy();
  });

  test("accepts custom width, height, and radius without throwing", () => {
    const { getByTestId } = render(
      <Skeleton width={220} height={40} radius={12} testID="custom-skeleton" />
    );
    const node = getByTestId("custom-skeleton");
    expect(node).toBeTruthy();
    const raw = node.getAttribute("data-style") ?? "[]";
    expect(raw).toContain("220");
    expect(raw).toContain("40");
    expect(raw).toContain("12");
  });

  test("animation start/stop does not throw on mount/unmount", () => {
    const { unmount } = render(<Skeleton testID="anim-skeleton" />);
    expect(() => unmount()).not.toThrow();
  });
});

describe("SkeletonLines", () => {
  test("renders the default number of rows (3)", () => {
    const { getByTestId } = render(<SkeletonLines />);
    const wrap = getByTestId("skeleton-line");
    expect(wrap).toBeTruthy();
    expect(getByTestId("skeleton-line-0")).toBeTruthy();
    expect(getByTestId("skeleton-line-1")).toBeTruthy();
    expect(getByTestId("skeleton-line-2")).toBeTruthy();
  });

  test("renders N rows when lines is overridden", () => {
    const { getByTestId, queryByTestId } = render(
      <SkeletonLines lines={5} testID="lines" />
    );
    expect(getByTestId("lines")).toBeTruthy();
    expect(getByTestId("lines-0")).toBeTruthy();
    expect(getByTestId("lines-4")).toBeTruthy();
    expect(queryByTestId("lines-5")).toBeNull();
  });

  test("honors per-line widths", () => {
    const { getByTestId } = render(
      <SkeletonLines
        lines={2}
        widths={["42%", "11%"]}
        testID="widths"
      />
    );
    const first = getByTestId("widths-0");
    const second = getByTestId("widths-1");
    expect(first.getAttribute("data-style") ?? "").toContain("42%");
    expect(second.getAttribute("data-style") ?? "").toContain("11%");
  });
});

describe("SkeletonCard", () => {
  test("renders card container with title and two lines", () => {
    const { getByTestId } = render(<SkeletonCard />);
    expect(getByTestId("skeleton-card")).toBeTruthy();
    expect(getByTestId("skeleton-card-title")).toBeTruthy();
    expect(getByTestId("skeleton-card-line-1")).toBeTruthy();
    expect(getByTestId("skeleton-card-line-2")).toBeTruthy();
  });
});

describe("SkeletonList", () => {
  test("renders the requested number of cards", () => {
    const { getByTestId, queryByTestId } = render(
      <SkeletonList rows={4} testID="list" />
    );
    expect(getByTestId("list")).toBeTruthy();
    expect(getByTestId("list-card-0")).toBeTruthy();
    expect(getByTestId("list-card-3")).toBeTruthy();
    expect(queryByTestId("list-card-4")).toBeNull();
  });

  test("defaults to 3 cards when rows is not provided", () => {
    const { getByTestId, queryByTestId } = render(<SkeletonList />);
    expect(getByTestId("skeleton-list-card-0")).toBeTruthy();
    expect(getByTestId("skeleton-list-card-2")).toBeTruthy();
    expect(queryByTestId("skeleton-list-card-3")).toBeNull();
  });
});
