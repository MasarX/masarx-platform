/** @jest-environment jsdom */
import * as React from "react";
import { getFieldOpsStrings } from "../../apps/fieldops/src/i18n";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MobileRealMap } from "../../apps/fieldops/src/mobile-real-map";
import { normalizeMobileOpenMapPolicy } from "../../apps/fieldops/src/mobile-open-map-policy";
import { buildMobileRealMapModel } from "../../apps/fieldops/src/mobile-real-map-model";

const mockOpenURL = jest.fn().mockResolvedValue(undefined);
let mockRendererProps: any;
jest.mock("react-native", () => {
  const React = require("react");
  return {
    Platform: { OS: "web" },
    Linking: { openURL: (...args: unknown[]) => mockOpenURL(...args) },
    View: ({ children, testID, pointerEvents, accessibilityState, accessibilityRole, accessibilityLabel }: any) =>
      React.createElement("div", { "data-testid": testID, "data-pointer-events": pointerEvents,
        "aria-busy": accessibilityState?.busy, "aria-disabled": accessibilityState?.disabled,
        role: accessibilityRole, "aria-label": accessibilityLabel }, children),
    Text: ({ children, accessibilityRole, accessibilityLiveRegion }: any) =>
      React.createElement("span", { role: accessibilityRole, "aria-live": accessibilityLiveRegion }, children),
    Pressable: ({ children, disabled, onPress, accessibilityRole, accessibilityLabel, testID, accessibilityState }: any) =>
      React.createElement("button", { disabled, onClick: onPress, role: accessibilityRole, "aria-label": accessibilityLabel, "data-testid": testID, "aria-pressed": accessibilityState?.selected }, children),
  };
}, { virtual: true });
jest.mock("../../apps/fieldops/src/mobile-real-map-renderer", () => ({
  MobileRealMapRenderer: (props: any) => {
    mockRendererProps = props;
    return require("react").createElement("div", { "data-testid": "fake-engine" });
  },
}));
const strings = {
  points: "Plotted items", eta: "ETA (minutes)", status: "Status", unknownStatus: "Unavailable",
  title: "Geographic map", loading: "Loading", empty: "No points", error: "Map failed",
  blocked: "Map blocked", retry: "Retry map", excluded: (count: number) => "Excluded " + count,
};
const policy = normalizeMobileOpenMapPolicy({ tile_provider: {
  url_template: "https://tile.openstreetmap.org/{z}/{x}/{y}.png",
  allowed_hosts: ["tile.openstreetmap.org"], usage_tier: "local_dev_light",
  cache_required: false, attribution_label: "OpenStreetMap contributors",
  attribution_url: "https://www.openstreetmap.org/copyright", load_timeout_ms: 1000,
} });
const model = (id = "stop-a") => buildMobileRealMapModel([{
  id, title: id, sequence: 1, active: true,
  address: { validation_status: "valid", line1: "Address", coordinates: { latitude: 24, longitude: 46 } },
}]);
beforeEach(() => { jest.useFakeTimers(); mockRendererProps = undefined; mockOpenURL.mockClear(); });
afterEach(() => { cleanup(); jest.useRealTimers(); });

test("unconfigured policy never mounts the engine", () => {
  render(<MobileRealMap model={model()} policy={normalizeMobileOpenMapPolicy(null)} strings={strings} onSelect={jest.fn()} />);
  expect(screen.queryByTestId("fake-engine")).toBeNull();
  expect(screen.getByRole("alert").textContent).toBe(strings.blocked);
});
test("valid empty model remains empty without a loading timer or engine", () => {
  render(<MobileRealMap model={buildMobileRealMapModel([])} policy={policy} strings={strings} onSelect={jest.fn()} />);
  expect(screen.getByText(strings.empty)).toBeTruthy();
  expect(screen.queryByTestId("fake-engine")).toBeNull();
  act(() => jest.advanceTimersByTime(2000));
  expect(screen.queryByRole("alert")).toBeNull();
});
test("bounded timeout exits busy; retry creates a new loading identity", () => {
  render(<MobileRealMap model={model()} policy={policy} strings={strings} onSelect={jest.fn()} />);
  const prior = mockRendererProps;
  expect(screen.getByTestId("fake-engine").parentElement?.getAttribute("aria-busy")).toBe("true");
  act(() => jest.advanceTimersByTime(1000));
  expect(screen.getByRole("alert").textContent).toContain(strings.error);
  expect(screen.queryByTestId("fake-engine")).toBeNull();
  expect(screen.queryByText(strings.loading)).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: strings.retry }));
  expect(screen.getByTestId("fake-engine")).toBeTruthy();
  expect(mockRendererProps.model.id).not.toBe(prior.model.id);
  act(() => prior.onState({ modelId: prior.model.id, status: "ready" }));
  expect(screen.getByText(strings.loading)).toBeTruthy();
});
test("late state from replaced model cannot settle current loading", () => {
  const select = jest.fn();
  const view = render(<MobileRealMap model={model()} policy={policy} strings={strings} onSelect={select} />);
  const prior = mockRendererProps;
  view.rerender(<MobileRealMap model={model("stop-b")} policy={policy} strings={strings} onSelect={select} />);
  act(() => prior.onState({ modelId: prior.model.id, status: "ready" }));
  expect(screen.getByText(strings.loading)).toBeTruthy();
  expect(screen.queryByRole("link")).toBeNull();
  act(() => prior.onSelect("stop-a"));
  expect(select).not.toHaveBeenCalled();
});
test("failed engine ignores late ready and ready state opens only approved attribution", () => {
  render(<MobileRealMap model={model()} policy={policy} strings={strings} onSelect={jest.fn()} />);
  const failed = mockRendererProps;
  act(() => failed.onState({ modelId: failed.model.id, status: "error" }));
  act(() => failed.onState({ modelId: failed.model.id, status: "ready" }));
  expect(screen.getByRole("alert")).toBeTruthy();
  expect(screen.queryByRole("link")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: strings.retry }));
  const current = mockRendererProps;
  act(() => current.onState({ modelId: current.model.id, status: "ready" }));
  expect(screen.queryByText(strings.loading)).toBeNull();
  expect(screen.getByTestId("fake-engine").parentElement?.getAttribute("aria-busy")).toBe("false");
  fireEvent.click(screen.getByRole("link", { name: "OpenStreetMap contributors" }));
  expect(mockOpenURL).toHaveBeenCalledWith("https://www.openstreetmap.org/copyright");
  act(() => jest.advanceTimersByTime(2000));
  expect(screen.queryByRole("alert")).toBeNull();
});
test("interaction lock blocks pointers, direct renderer selection and retry", () => {
  const select = jest.fn();
  render(<MobileRealMap model={model()} policy={policy} strings={strings} onSelect={select} interactionLocked />);
  expect(screen.getByTestId("fake-engine").parentElement?.getAttribute("data-pointer-events")).toBe("none");
  act(() => mockRendererProps.onSelect("stop-a"));
  expect(select).not.toHaveBeenCalled();
  act(() => jest.advanceTimersByTime(1000));
  const retry = screen.getByRole("button", { name: strings.retry }) as HTMLButtonElement;
  expect(retry.disabled).toBe(true);
  fireEvent.click(retry);
  expect(screen.queryByTestId("fake-engine")).toBeNull();
});

test("co-located geographic points retain visible context and independent accessible selection", () => {
  const address = { validation_status: "valid", line1: "Address", coordinates: { latitude: 24, longitude: 46 } };
  const crowded = buildMobileRealMapModel([
    { id: "a", title: "Stop A", status: "completed", etaMinutes: 0, sequence: 1, active: false, address },
    { id: "b", title: "Stop B", status: "failed", sequence: 2, active: false, address },
  ]);
  const onSelect = jest.fn();
  const { rerender } = render(<MobileRealMap model={crowded} policy={policy} strings={strings} onSelect={onSelect} />);
  expect(screen.queryByTestId("mobile-map-point-a")).toBeNull();
  act(() => mockRendererProps.onState({ modelId: mockRendererProps.model.id, status: "ready" }));
  expect(screen.getByText("Plotted items: 2")).toBeTruthy();
  expect(screen.getByRole("button", { name: "Stop A · Status: completed · ETA (minutes): 0" })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Stop B · Status: failed" }));
  expect(onSelect).toHaveBeenLastCalledWith("b");
  act(() => mockRendererProps.onSelect("not-in-model"));
  expect(onSelect).toHaveBeenCalledTimes(1);
  rerender(<MobileRealMap model={crowded} policy={policy} strings={strings} onSelect={onSelect} interactionLocked />);
  fireEvent.click(screen.getByTestId("mobile-map-point-a"));
  expect(onSelect).toHaveBeenCalledTimes(1);
});

test.each(["en", "ar"] as const)("renders map point context in %s without inventing ETA or status", (locale) => {
  const copy = getFieldOpsStrings(locale).realMap;
  const onSelect = jest.fn();
  render(<MobileRealMap model={model()} policy={policy} strings={copy} onSelect={onSelect} />);
  act(() => mockRendererProps.onState({ modelId: mockRendererProps.model.id, status: "ready" }));
  const button = screen.getByRole("button", { name: `stop-a · ${copy.status}: ${copy.unknownStatus}` });
  expect(button.textContent).not.toContain(copy.eta);
  fireEvent.click(button);
  expect(onSelect).toHaveBeenCalledWith("stop-a");
});
