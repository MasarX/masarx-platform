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
        const {
          testID,
          children,
          style,
          accessibilityLabel,
          accessibilityRole,
          ...rest
        } = props ?? {};
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

    const Pressable = ReactMod.forwardRef<HTMLButtonElement, any>(
      function Pressable(props, ref) {
        const {
          testID,
          children,
          style,
          onPress,
          accessibilityRole,
          ...rest
        } = props ?? {};
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

    return {
      View: createHostView("View"),
      Text: createHostView("Text"),
      Pressable,
      Animated: {
        Value: class {
          constructor(_v: number) {}
        },
        View: createHostView("Animated.View"),
        timing: () => ({ start: () => {}, stop: () => {} }),
        sequence: () => ({ start: () => {}, stop: () => {} }),
        loop: () => ({ start: () => {}, stop: () => {} }),
      },
      StyleSheet: {
        create: <T extends Record<string, unknown>>(styles: T): T => styles,
        flatten: (style: unknown) => style,
      },
      Platform: { OS: "web", select: (o: any) => o.web ?? o.default },
    };
  },
  { virtual: true }
);

import { fireEvent, render as renderDom } from "@testing-library/react";
import { EmptyState } from "../../../apps/fieldops/src/components/EmptyState";

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

describe("EmptyState", () => {
  test("renders the title", () => {
    const { getByTestId } = render(
      <EmptyState title="No stops scheduled" />
    );
    expect(getByTestId("empty-state")).toBeTruthy();
    expect(getByTestId("empty-state-title").textContent).toBe(
      "No stops scheduled"
    );
  });

  test("renders description when provided", () => {
    const { getByTestId } = render(
      <EmptyState
        title="Nothing here"
        description="Your route is clear for now."
      />
    );
    expect(getByTestId("empty-state-description").textContent).toBe(
      "Your route is clear for now."
    );
  });

  test("does not render description block when not provided", () => {
    const { queryByTestId } = render(<EmptyState title="Empty" />);
    expect(queryByTestId("empty-state-description")).toBeNull();
  });

  test("renders icon when provided", () => {
    const { getByTestId } = render(
      <EmptyState
        title="Empty"
        icon={<span data-testid="empty-icon">i</span>}
      />
    );
    expect(getByTestId("empty-state-icon")).toBeTruthy();
    expect(getByTestId("empty-icon")).toBeTruthy();
  });

  test("renders action button and fires onPress when clicked", () => {
    const onPress = jest.fn();
    const { getByTestId } = render(
      <EmptyState
        title="Empty"
        action={{ label: "Refresh", onPress, testID: "refresh-btn" }}
      />
    );
    const btn = getByTestId("refresh-btn");
    expect(btn).toBeTruthy();
    fireEvent.click(btn);
    expect(onPress).toHaveBeenCalledTimes(1);
  });

  test("omits the action button when action prop is not provided", () => {
    const { queryByTestId } = render(<EmptyState title="Empty" />);
    expect(queryByTestId("empty-state-action")).toBeNull();
  });
});
