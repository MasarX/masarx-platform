import * as React from "react";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { TrackingMap, type TrackingMapProps } from "../../packages/ui/src/tracking-map";

const mockMaps: any[] = [];
const mockSetWorkerUrl = jest.fn();
jest.mock("../../packages/ui/src/tracking-map-worker-url.mjs", () => ({
  __esModule: true, default: "http://localhost/_next/static/media/maplibre-worker.mjs",
}));
jest.mock("maplibre-gl/dist/maplibre-gl.css", () => ({}), { virtual: true });
jest.mock("maplibre-gl", () => ({ setWorkerUrl: mockSetWorkerUrl, Map: jest.fn((options: unknown) => {
  const handlers: Record<string, Array<() => void>> = {};
  const map = { options, handlers,
    on: jest.fn((name: string, fn: () => void) => { (handlers[name] ??= []).push(fn); return map; }),
    fire: (name: string) => { for (const fn of handlers[name] ?? []) fn(); },
    addSource: jest.fn(), addLayer: jest.fn(), loaded: jest.fn(() => true),
    isStyleLoaded: jest.fn(() => true), areTilesLoaded: jest.fn(() => true),
    getSource: jest.fn(() => ({})), isSourceLoaded: jest.fn(() => true), isMoving: jest.fn(() => false),
    jumpTo: jest.fn(), fitBounds: jest.fn(), triggerRepaint: jest.fn(), resize: jest.fn(), remove: jest.fn(),
  };
  mockMaps.push(map); return map;
}) }), { virtual: true });
const disconnect = jest.fn();
const originalObserver = globalThis.ResizeObserver;
beforeAll(() => { globalThis.ResizeObserver = class {
  observe() {} unobserve() {} disconnect() { disconnect(); }
} as typeof ResizeObserver; });
afterAll(() => { globalThis.ResizeObserver = originalObserver; });
afterEach(() => { cleanup(); mockMaps.length = 0; disconnect.mockClear(); jest.useRealTimers(); });
const props: TrackingMapProps = {
  identity: "actor-a/geocodes/0",
  pins: [
    { id: "geo/address-a", latitude: 24, longitude: 46, label: "<img src=x onerror=alert(1)>", status: "source-a" },
    { id: "geo/address-b", latitude: 25, longitude: 47, label: null, status: null },
  ],
  policy: { ok: true, style: { version: 8,
    sources: { tiles: { type: "raster", tiles: ["https://tiles.example.test/{z}/{x}/{y}"], tileSize: 256, attribution: "" } },
    layers: [{ id: "tiles", type: "raster", source: "tiles" }] },
    camera: { padding: { top: 16, right: 16, bottom: 16, left: 16 }, singlePointZoom: 10, maxZoom: 12 },
    attributionLabel: "OpenStreetMap", attributionUrl: "https://www.openstreetmap.org/copyright", loadTimeoutMs: 1000 },
  labels: { map: "Locations", loading: "Loading map", unavailable: "Map unavailable", empty: "No locations" },
};
async function mapAt(index = 0) {
  await waitFor(() => expect(mockMaps.length).toBeGreaterThan(index));
  return mockMaps[index];
}
test("renders all composite pins as geographic points; ready requires current loaded idle", async () => {
  const view = render(<TrackingMap {...props} />);
  const map = await mapAt();
  expect(mockSetWorkerUrl).toHaveBeenCalledWith("http://localhost/_next/static/media/maplibre-worker.mjs");
  const module = require("maplibre-gl");
  expect(mockSetWorkerUrl.mock.invocationCallOrder.at(-1)).toBeLessThan(module.Map.mock.invocationCallOrder.at(-1));
  expect(view.container.querySelector("figure")?.getAttribute("data-map-state")).toBe("loading");
  act(() => map.fire("load"));
  expect(map.addSource.mock.calls[0][1].data.features.map((f: any) => [f.id, f.geometry.coordinates]))
    .toEqual([["geo/address-a", [46, 24]], ["geo/address-b", [47, 25]]]);
  expect(map.fitBounds).toHaveBeenCalledWith([[46, 24], [47, 25]], expect.objectContaining({ duration: 0, maxZoom: 12 }));
  map.loaded.mockReturnValue(false); act(() => map.fire("idle"));
  expect(view.container.querySelector("figure")?.getAttribute("data-map-state")).toBe("loading");
  map.loaded.mockReturnValue(true); act(() => map.fire("idle"));
  expect(view.container.querySelector("figure")?.getAttribute("data-map-state")).toBe("ready");
});
test("labels are literal text, attribution is linked, and every pin has a semantic text alternative", async () => {
  const view = render(<TrackingMap {...props} />); await mapAt();
  expect(screen.getAllByRole("listitem")).toHaveLength(2);
  expect(screen.getAllByRole("listitem").map(item => item.textContent)).toEqual([
    "<img src=x onerror=alert(1)> 24, 46 — source-a", "25, 47",
  ]);
  expect(screen.getByText(props.pins[0].label!)).toBeTruthy();
  expect(view.container.querySelector("img")).toBeNull();
  expect(screen.getByRole("link", { name: "OpenStreetMap" }).getAttribute("href")).toBe("https://www.openstreetmap.org/copyright");
  expect(mockMaps[0].options.interactive).toBe(false);
  expect(mockMaps[0].options.attributionControl).toBe(false);
});
test("scope replacement removes previous map and ignores its late load/idle/error callbacks", async () => {
  const view = render(<TrackingMap {...props} />); const old = await mapAt();
  view.rerender(<TrackingMap {...props} identity="actor-b/addresses/0" pins={[{ ...props.pins[1], id: "new", label: "New scope" }]} />);
  expect(old.remove).toHaveBeenCalledTimes(1);
  expect(screen.queryByText(props.pins[0].label!)).toBeNull();
  act(() => { old.fire("load"); old.fire("idle"); old.fire("error"); });
  expect(old.addSource).not.toHaveBeenCalled();
  const current = await mapAt(1);
  expect(screen.queryByRole("alert")).toBeNull();
  act(() => { current.fire("load"); current.fire("idle"); });
  expect(current.jumpTo).toHaveBeenCalledWith({ center: [47, 25], zoom: 10 });
  view.unmount(); expect(current.remove).toHaveBeenCalledTimes(1);
  expect(disconnect).toHaveBeenCalledTimes(2);
});
test("equivalent prop objects do not recreate the map", async () => {
  const view = render(<TrackingMap {...props} />); await mapAt();
  view.rerender(<TrackingMap {...JSON.parse(JSON.stringify(props))} />);
  expect(mockMaps).toHaveLength(1); expect(mockMaps[0].remove).not.toHaveBeenCalled();
});
test("distinct pins at identical coordinates retain both points and use singleton camera", async () => {
  render(<TrackingMap {...props} pins={props.pins.map(pin => ({ ...pin, latitude: 24, longitude: 46 }))} />);
  const map = await mapAt(); act(() => map.fire("load"));
  expect(map.addSource.mock.calls[0][1].data.features).toHaveLength(2);
  expect(map.jumpTo).toHaveBeenCalledWith({ center: [46, 24], zoom: 10 });
  expect(map.fitBounds).not.toHaveBeenCalled();
});
test.each([-90, 90, -86, 86])("unprojectable latitude %s fails explicitly without clamping", latitude => {
  render(<TrackingMap {...props} pins={[{ ...props.pins[0], latitude }]} />);
  expect(screen.getByRole("alert").textContent).toBe("Map unavailable");
  expect(mockMaps).toHaveLength(0);
});
test("map error is terminal, cleans resources, and cannot become ready later", async () => {
  const view = render(<TrackingMap {...props} />); const map = await mapAt();
  act(() => { map.fire("load"); map.fire("error"); map.fire("idle"); });
  expect(screen.getByRole("alert").textContent).toBe("Map unavailable");
  expect(view.container.querySelector("figure")?.getAttribute("data-map-state")).toBe("error");
  expect(view.container.querySelector("figure")?.getAttribute("data-map-failure-cause")).toBe("event");
  expect(view.container.querySelector("figure")?.getAttribute("data-map-failure-stage")).toBe("waiting-idle");
  expect(map.remove).toHaveBeenCalledTimes(1); expect(disconnect).toHaveBeenCalledTimes(1);
  view.unmount(); expect(map.remove).toHaveBeenCalledTimes(1);
});
test("policy timeout fails visibly and removes an unready map", async () => {
  jest.useFakeTimers(); const view = render(<TrackingMap {...props} />);
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
  act(() => jest.advanceTimersByTime(1000));
  expect(screen.getByRole("alert").textContent).toBe("Map unavailable");
  for (const map of mockMaps) expect(map.remove).toHaveBeenCalledTimes(1);
  expect(view.container.querySelector("figure")?.getAttribute("data-map-failure-cause")).toBe("timeout");
});
test("timeout snapshots public readiness and bounded event counts without changing terminal failure", async () => {
  const view = render(<TrackingMap {...props} />);
  const map = await mapAt();
  jest.useFakeTimers();
  // Remount under the fake clock so the actual policy timer is controlled.
  view.rerender(<TrackingMap {...props} identity="diagnostic-clock" />);
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
  const current = mockMaps[1];
  expect(map.remove).toHaveBeenCalledTimes(1);
  act(() => { current.fire("load"); current.fire("render"); current.fire("sourcedata"); current.fire("resize"); });
  current.loaded.mockReturnValue(false);
  current.areTilesLoaded.mockReturnValue(false);
  current.isSourceLoaded.mockImplementation(() => { throw new Error("private-url-secret"); });
  act(() => jest.advanceTimersByTime(1000));
  const figure = view.container.querySelector("figure");
  expect(figure?.getAttribute("data-map-state")).toBe("error");
  expect(JSON.parse(figure?.getAttribute("data-map-readiness") || "{}")).toEqual({
    loaded: false, style: true, tiles: false, pins: null, moving: false,
    render: 1, idle: 0, sourcedata: 1, resize: 1,
  });
  expect(current.remove).toHaveBeenCalledTimes(1);
  expect(view.container.innerHTML).not.toContain("private-url-secret");
  act(() => current.fire("idle"));
  expect(figure?.getAttribute("data-map-state")).toBe("error");
});
test.each(["source", "camera"] as const)("categorizes %s exceptions without exposing error data", async stage => {
  const view = render(<TrackingMap {...props} />); const map = await mapAt();
  const action = stage === "source" ? map.addSource : map.fitBounds;
  action.mockImplementationOnce(() => { throw new Error("https://private.invalid/?secret=do-not-output"); });
  act(() => map.fire("load"));
  const figure = view.container.querySelector("figure");
  expect(figure?.getAttribute("data-map-state")).toBe("error");
  expect(figure?.getAttribute("data-map-failure-stage")).toBe(stage);
  expect(figure?.getAttribute("data-map-failure-cause")).toBe("exception");
  expect(view.container.innerHTML).not.toContain("private.invalid");
  expect(view.container.innerHTML).not.toContain("do-not-output");
});
test("cross-origin worker assets fail without changing CSP or constructing a map", async () => {
  const worker = require("../../packages/ui/src/tracking-map-worker-url.mjs");
  const previous = worker.default;
  worker.default = "https://other.example.test/maplibre-worker.mjs";
  try {
    render(<TrackingMap {...props} />);
    await waitFor(() => expect(screen.getByRole("alert")).toBeTruthy());
    expect(mockMaps).toHaveLength(0);
  } finally { worker.default = previous; }
});
test("unmount before lazy import settles creates no map", async () => {
  const view = render(<TrackingMap {...props} />); view.unmount();
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
  expect(mockMaps).toHaveLength(0);
});
test("invalid coordinates and duplicate composite identity fail without constructing a map", () => {
  const view = render(<TrackingMap {...props} pins={[{ ...props.pins[0], latitude: NaN }]} />);
  expect(screen.getByRole("alert")).toBeTruthy();
  view.rerender(<TrackingMap {...props} pins={[props.pins[0], props.pins[0]]} />);
  expect(screen.getByRole("alert")).toBeTruthy(); expect(mockMaps).toHaveLength(0);
});
test("unavailable policy is not empty success and empty valid datasets do not construct a map", () => {
  const view = render(<TrackingMap {...props} policy={{ ok: false, reason: "unconfigured" }} />);
  expect(screen.getByRole("alert")).toBeTruthy(); expect(screen.queryByText("No locations")).toBeNull();
  view.rerender(<TrackingMap {...props} pins={[]} />);
  expect(screen.getByText("No locations")).toBeTruthy(); expect(mockMaps).toHaveLength(0);
});
