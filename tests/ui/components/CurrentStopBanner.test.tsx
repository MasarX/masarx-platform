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
import {
  CurrentStopBanner,
  type CurrentStopBannerStop,
  type CurrentStopBannerStrings,
} from "../../../apps/fieldops/src/components/CurrentStopBanner";

function makeStrings(
  overrides?: Partial<CurrentStopBannerStrings>
): CurrentStopBannerStrings {
  return {
    empty_label: "No active stop",
    open_cta: "Open",
    navigate_cta: "Navigate",
    eta_minutes: (n) => `ETA ${n}m`,
    sequence_prefix: (n) => `#${n}`,
    ...overrides,
  };
}

const STOP: CurrentStopBannerStop = {
  stopId: "stop-42",
  sequence: 7,
  customerName: "Sample Store",
  addressSummary: "10 Example Road",
  etaMinutes: 9,
  statusLabel: "ARRIVED",
};

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

describe("CurrentStopBanner", () => {
  test("renders muted empty state when stop is null (no CTAs)", () => {
    const onOpenStop = jest.fn();
    const onNavigateStop = jest.fn();
    const { getByTestId, queryByTestId } = render(
      <CurrentStopBanner
        stop={null}
        onOpenStop={onOpenStop}
        onNavigateStop={onNavigateStop}
        strings={makeStrings()}
      />
    );
    expect(getByTestId("current-stop-banner-empty")).toBeTruthy();
    expect(
      getByTestId("current-stop-banner-empty-label").textContent
    ).toBe("No active stop");
    expect(queryByTestId("current-stop-banner-navigate-cta")).toBeNull();
    expect(queryByTestId("current-stop-banner-open-cta")).toBeNull();
    expect(onOpenStop).not.toHaveBeenCalled();
    expect(onNavigateStop).not.toHaveBeenCalled();
  });

  test("renders stop with sequence, customer, address, eta, statusLabel", () => {
    const strings = makeStrings();
    const seqSpy = jest.spyOn(strings, "sequence_prefix");
    const etaSpy = jest.spyOn(strings, "eta_minutes");
    const { getByTestId } = render(
      <CurrentStopBanner
        stop={STOP}
        onOpenStop={() => undefined}
        onNavigateStop={() => undefined}
        strings={strings}
      />
    );
    expect(getByTestId("current-stop-banner-sequence").textContent).toBe(
      "#7"
    );
    expect(getByTestId("current-stop-banner-customer").textContent).toBe(
      "Sample Store"
    );
    expect(getByTestId("current-stop-banner-address").textContent).toBe(
      "10 Example Road"
    );
    expect(getByTestId("current-stop-banner-eta").textContent).toBe("ETA 9m");
    expect(
      getByTestId("current-stop-banner-status-label").textContent
    ).toBe("ARRIVED");
    expect(seqSpy).toHaveBeenCalledWith(7);
    expect(etaSpy).toHaveBeenCalledWith(9);
  });

  test("Open and Navigate CTAs fire with the correct stopId", () => {
    const onOpenStop = jest.fn();
    const onNavigateStop = jest.fn();
    const { getByTestId } = render(
      <CurrentStopBanner
        stop={STOP}
        onOpenStop={onOpenStop}
        onNavigateStop={onNavigateStop}
        strings={makeStrings()}
      />
    );
    fireEvent.click(getByTestId("current-stop-banner-navigate-cta"));
    fireEvent.click(getByTestId("current-stop-banner-open-cta"));
    expect(onNavigateStop).toHaveBeenCalledWith("stop-42");
    expect(onOpenStop).toHaveBeenCalledWith("stop-42");
  });

  test("omits sequence when stop.sequence is null but still renders ETA when provided", () => {
    const { queryByTestId, getByTestId } = render(
      <CurrentStopBanner
        stop={{ ...STOP, sequence: null }}
        onOpenStop={() => undefined}
        onNavigateStop={() => undefined}
        strings={makeStrings()}
      />
    );
    expect(queryByTestId("current-stop-banner-sequence")).toBeNull();
    expect(getByTestId("current-stop-banner-eta").textContent).toBe("ETA 9m");
  });

  test("omits ETA when stop.etaMinutes is null and omits address/customer when null", () => {
    const { queryByTestId } = render(
      <CurrentStopBanner
        stop={{
          ...STOP,
          etaMinutes: null,
          customerName: null,
          addressSummary: null,
        }}
        onOpenStop={() => undefined}
        onNavigateStop={() => undefined}
        strings={makeStrings()}
      />
    );
    expect(queryByTestId("current-stop-banner-eta")).toBeNull();
    expect(queryByTestId("current-stop-banner-customer")).toBeNull();
    expect(queryByTestId("current-stop-banner-address")).toBeNull();
  });
});
