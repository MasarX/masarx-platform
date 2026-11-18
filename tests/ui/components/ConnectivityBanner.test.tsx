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

    return {
      View: createHostView("View"),
      Text: createHostView("Text"),
      Pressable: createHostView("Pressable"),
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

import { render as renderDom } from "@testing-library/react";
import { ConnectivityBanner } from "../../../apps/fieldops/src/components/ConnectivityBanner";

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

describe("ConnectivityBanner", () => {
  test("renders offline variant with title", () => {
    const { getByTestId } = render(
      <ConnectivityBanner variant="offline" title="Offline" />
    );
    expect(getByTestId("connectivity-banner")).toBeTruthy();
    expect(getByTestId("connectivity-banner-title").textContent).toBe(
      "Offline"
    );
  });

  test("renders degraded variant with title and message", () => {
    const { getByTestId } = render(
      <ConnectivityBanner
        variant="degraded"
        title="Degraded"
        message="Intermittent sync"
      />
    );
    expect(getByTestId("connectivity-banner-title").textContent).toBe(
      "Degraded"
    );
    expect(getByTestId("connectivity-banner-message").textContent).toBe(
      "Intermittent sync"
    );
  });

  test("offline variant renders a different background color than degraded", () => {
    const { getByTestId: getOffline } = render(
      <ConnectivityBanner
        variant="offline"
        title="Offline"
        testID="offline-banner"
      />
    );
    const offlineStyle =
      getOffline("offline-banner").getAttribute("data-style") ?? "";

    const { getByTestId: getDegraded } = render(
      <ConnectivityBanner
        variant="degraded"
        title="Degraded"
        testID="degraded-banner"
      />
    );
    const degradedStyle =
      getDegraded("degraded-banner").getAttribute("data-style") ?? "";

    expect(offlineStyle).not.toEqual(degradedStyle);
    expect(offlineStyle).toContain(tokens.color.dangerSoft);
    expect(degradedStyle).toContain(tokens.color.warningSoft);
  });

  test("omits the message node when message is not provided", () => {
    const { queryByTestId } = render(
      <ConnectivityBanner variant="offline" title="Offline" />
    );
    expect(queryByTestId("connectivity-banner-message")).toBeNull();
  });

  test("exposes combined accessibility label when message is present", () => {
    const { getByTestId } = render(
      <ConnectivityBanner
        variant="degraded"
        title="Degraded"
        message="Sync delayed"
        testID="a11y-banner"
      />
    );
    const banner = getByTestId("a11y-banner");
    expect(banner.getAttribute("aria-label")).toBe("Degraded. Sync delayed");
    expect(banner.getAttribute("role")).toBe("alert");
  });
});
