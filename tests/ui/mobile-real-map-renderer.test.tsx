import * as React from "react";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { buildMobileRealMapModel } from "../../apps/fieldops/src/mobile-real-map-model";
import { MobileRealMapRenderer as WebRenderer } from "../../apps/fieldops/src/mobile-real-map-renderer.web";
import { MobileRealMapRenderer as NativeRenderer } from "../../apps/fieldops/src/mobile-real-map-renderer.native";
import type { MobileRasterMapStyle } from "../../apps/fieldops/src/mobile-real-map-renderer.types";

const mockMaps: any[] = [];
const mockSetWorkerUrl = jest.fn();
let mockNativeMap: any;
let mockNativeSource: any;
const mockSetStop = jest.fn(async (_options: unknown) => undefined);
jest.mock("maplibre-gl/dist/maplibre-gl.css", () => ({}), { virtual: true });
jest.mock("maplibre-gl", () => ({
  setWorkerUrl: mockSetWorkerUrl,
  Map: jest.fn((options: unknown) => {
    const handlers: Record<string, Set<(...args: any[]) => void>> = {};
    const sources: Record<string, any> = {};
    const instance = {
      options, handlers, sources,
      on: jest.fn((name: string, ...args: any[]) => {
        (handlers[name] ??= new Set()).add(args[args.length - 1]); return instance;
      }),
      off: jest.fn((name: string, handler: (...args: any[]) => void) => {
        handlers[name]?.delete(handler); return instance;
      }),
      fire: (name: string, payload?: unknown) => { for (const fn of [...(handlers[name] ?? [])]) fn(payload); },
      addSource: jest.fn((id: string) => { sources[id] = { setData: jest.fn(async (_data: unknown) => undefined) }; }),
      getSource: jest.fn((id: string) => sources[id]),
      addLayer: jest.fn(),
      setMaxZoom: jest.fn(),
      fitBounds: jest.fn(),
      jumpTo: jest.fn(),
      loaded: jest.fn(() => true),
      triggerRepaint: jest.fn(),
      resize: jest.fn(),
      remove: jest.fn(),
    };
    mockMaps.push(instance);
    return instance;
  }),
}), { virtual: true });
jest.mock("@maplibre/maplibre-react-native", () => {
  const React = require("react");
  return {
    Map: (props: any) => { mockNativeMap = props; return React.createElement("div", null, props.children); },
    Camera: React.forwardRef((_props: any, ref: any) => {
      React.useImperativeHandle(ref, () => ({ setStop: mockSetStop })); return null;
    }),
    GeoJSONSource: (props: any) => {
      if (props.id === "fieldops-stops") mockNativeSource = props;
      return React.createElement("div", null, props.children);
    },
    Layer: () => null,
  };
}, { virtual: true });

const style: MobileRasterMapStyle = {
  version: 8,
  sources: { tiles: { type: "raster", tiles: ["https://tiles.example.test/{z}/{x}/{y}.png"], tileSize: 256, attribution: "Test attribution" } },
  layers: [{ id: "tiles", type: "raster", source: "tiles" }],
};
const camera = { padding: { top: 80, right: 48, bottom: 220, left: 48 }, singlePointZoom: 11, maxZoom: 18 };
function model(active = "one", count = 2) {
  return buildMobileRealMapModel(["one", "two"].slice(0, count).map((id, index) => ({
    id, title: id, sequence: index + 1, active: id === active,
    address: { validation_status: "valid", line1: "Approved address", coordinates: { latitude: 24 + index, longitude: 46 + index } },
  })));
}
const previousObserver = globalThis.ResizeObserver;
const disconnect = jest.fn();
beforeAll(() => {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() { disconnect(); }
  } as typeof ResizeObserver;
});
afterAll(() => { globalThis.ResizeObserver = previousObserver; });
afterEach(() => {
  cleanup();
  mockMaps.length = 0;
  mockSetStop.mockReset().mockResolvedValue(undefined);
  disconnect.mockClear();
});
async function loadWeb() {
  await waitFor(() => expect(mockMaps).toHaveLength(1));
  const map = mockMaps[0];
  await act(async () => { map.fire("load"); });
  await waitFor(() => expect(map.fitBounds).toHaveBeenCalled());
  return map;
}

test.each(["", "/fieldops"])("web configures the staged same-origin worker before Map for base %s", async base => {
  const previous = process.env.EXPO_BASE_URL;
  process.env.EXPO_BASE_URL = base;
  try {
    render(<WebRenderer model={model()} style={style} camera={camera} onState={jest.fn()} onSelect={jest.fn()} />);
    await loadWeb();
    expect(mockSetWorkerUrl).toHaveBeenLastCalledWith(window.location.origin + base + "/maplibre-gl-worker.mjs");
    const module = require("maplibre-gl");
    expect(mockSetWorkerUrl.mock.invocationCallOrder.at(-1)).toBeLessThan(module.Map.mock.invocationCallOrder.at(-1));
  } finally {
    if (previous === undefined) delete process.env.EXPO_BASE_URL; else process.env.EXPO_BASE_URL = previous;
  }
});
test("web fits current points, preserves one map on selection change, and removes it on unmount", async () => {
  const onState = jest.fn(), onSelect = jest.fn();
  const first = model();
  const view = render(<WebRenderer model={first} style={style} camera={camera} onState={onState} onSelect={onSelect} />);
  const map = await loadWeb();
  act(() => map.fire("idle"));
  expect(onState).toHaveBeenLastCalledWith({ modelId: first.id, status: "ready" });
  expect(map.fitBounds).toHaveBeenCalledWith([first.bounds!.southwest, first.bounds!.northeast], { padding: camera.padding, duration: 0, maxZoom: 18 });
  act(() => map.fire("click", { features: [{ properties: { id: "two" } }] }));
  expect(onSelect).toHaveBeenCalledWith("two");
  const next = model("two");
  view.rerender(<WebRenderer model={next} style={{ ...style }} camera={camera} onState={onState} onSelect={onSelect} />);
  await waitFor(() => expect(map.sources["fieldops-stops"].setData).toHaveBeenLastCalledWith(next.points));
  expect(mockMaps).toHaveLength(1);
  act(() => map.fire("idle"));
  expect(onState).toHaveBeenLastCalledWith({ modelId: next.id, status: "ready" });
  const staleError = [...map.handlers.error][0] as () => void;
  view.unmount();
  const calls = onState.mock.calls.length;
  staleError();
  expect(onState).toHaveBeenCalledTimes(calls);
  expect(map.remove).toHaveBeenCalledTimes(1);
  expect(disconnect).toHaveBeenCalledTimes(1);
});

test("web error is terminal for its map instance and cannot be overwritten by idle", async () => {
  const onState = jest.fn();
  render(<WebRenderer model={model()} style={style} camera={camera} onState={onState} onSelect={jest.fn()} />);
  const map = await loadWeb();
  act(() => { map.fire("error"); map.fire("idle"); });
  expect(onState).toHaveBeenLastCalledWith({ modelId: model().id, status: "error" });
});

test("web singleton uses center/zoom instead of degenerate bounds", async () => {
  const one = model("one", 1);
  render(<WebRenderer model={one} style={style} camera={camera} onState={jest.fn()} onSelect={jest.fn()} />);
  await waitFor(() => expect(mockMaps).toHaveLength(1));
  await act(async () => mockMaps[0].fire("load"));
  await waitFor(() => expect(mockMaps[0].jumpTo).toHaveBeenCalledWith({ center: one.points.features[0].geometry.coordinates, zoom: 11 }));
  expect(mockMaps[0].fitBounds).not.toHaveBeenCalled();
});

test("native waits for current camera completion and a rendering event, and preserves selection", async () => {
  const onState = jest.fn(), onSelect = jest.fn();
  const first = model();
  const view = render(<NativeRenderer model={first} style={style} camera={camera} onState={onState} onSelect={onSelect} />);
  await act(async () => mockNativeMap.onDidFinishLoadingMap());
  expect(mockSetStop).toHaveBeenCalledWith({ bounds: [46, 24, 47, 25], padding: camera.padding, duration: 0 });
  act(() => mockNativeMap.onDidFinishRenderingMapFully());
  expect(onState).toHaveBeenLastCalledWith({ modelId: first.id, status: "ready" });
  act(() => mockNativeSource.onPress({ nativeEvent: { features: [{ properties: { id: "two" } }] } }));
  expect(onSelect).toHaveBeenCalledWith("two");
  const next = model("two");
  view.rerender(<NativeRenderer model={next} style={style} camera={camera} onState={onState} onSelect={onSelect} />);
  expect(onState).toHaveBeenLastCalledWith({ modelId: next.id, status: "loading" });
  await act(async () => mockNativeMap.onDidFinishLoadingMap());
  act(() => mockNativeMap.onDidFinishRenderingMapFully());
  expect(onState).toHaveBeenLastCalledWith({ modelId: next.id, status: "ready" });
});

test("native stale camera resolution and failure cannot manufacture current readiness", async () => {
  let release!: () => void;
  mockSetStop.mockImplementationOnce(() => new Promise<undefined>(resolve => { release = () => resolve(undefined); }));
  const onState = jest.fn();
  const view = render(<NativeRenderer model={model()} style={style} camera={camera} onState={onState} onSelect={jest.fn()} />);
  await act(async () => mockNativeMap.onDidFinishLoadingMap());
  act(() => mockNativeMap.onDidFailLoadingMap());
  await act(async () => release());
  act(() => mockNativeMap.onDidFinishRenderingMapFully());
  expect(onState).toHaveBeenLastCalledWith({ modelId: model().id, status: "error" });
  const staleRender = mockNativeMap.onDidFinishRenderingMapFully;
  view.unmount();
  const calls = onState.mock.calls.length;
  staleRender();
  expect(onState).toHaveBeenCalledTimes(calls);
});

test("native singleton uses configured center zoom", async () => {
  const one = model("one", 1);
  render(<NativeRenderer model={one} style={style} camera={camera} onState={jest.fn()} onSelect={jest.fn()} />);
  await act(async () => mockNativeMap.onDidFinishLoadingMap());
  expect(mockSetStop).toHaveBeenCalledWith({ center: one.points.features[0].geometry.coordinates, zoom: 11, duration: 0 });
});

test("web style replacement disposes old async callbacks before creating a new map", async () => {
  const onState = jest.fn(), first = model();
  const view = render(<WebRenderer model={first} style={style} camera={camera} onState={onState} onSelect={jest.fn()} />);
  await waitFor(() => expect(mockMaps).toHaveLength(1));
  const old = mockMaps[0];
  const next = { ...first, id: first.id + ":new-approved-style" };
  const nextStyle = { ...style, sources: { tiles: { ...style.sources.tiles, attribution: "Updated approved attribution" } } };
  view.rerender(<WebRenderer model={next} style={nextStyle} camera={camera} onState={onState} onSelect={jest.fn()} />);
  await waitFor(() => expect(mockMaps).toHaveLength(2));
  expect(old.remove).toHaveBeenCalledTimes(1);
  const calls = onState.mock.calls.length;
  act(() => { old.fire("load"); old.fire("error"); old.fire("idle"); });
  expect(onState).toHaveBeenCalledTimes(calls);
});

test("native an older model camera rejection cannot overwrite a newer ready model", async () => {
  let reject!: (error: Error) => void;
  mockSetStop.mockImplementationOnce(() => new Promise<undefined>((_resolve, rejectPromise) => { reject = rejectPromise; }));
  const onState = jest.fn();
  const view = render(<NativeRenderer model={model()} style={style} camera={camera} onState={onState} onSelect={jest.fn()} />);
  await act(async () => mockNativeMap.onDidFinishLoadingMap());
  const next = model("two");
  view.rerender(<NativeRenderer model={next} style={style} camera={camera} onState={onState} onSelect={jest.fn()} />);
  await act(async () => mockNativeMap.onDidFinishLoadingMap());
  act(() => mockNativeMap.onDidFinishRenderingMapFully());
  expect(onState).toHaveBeenLastCalledWith({ modelId: next.id, status: "ready" });
  const calls = onState.mock.calls.length;
  await act(async () => reject(new Error("obsolete camera")));
  expect(onState).toHaveBeenCalledTimes(calls);
});

test("web source absence fails closed without a non-null assertion", async () => {
  const onState = jest.fn();
  render(<WebRenderer model={model()} style={style} camera={camera} onState={onState} onSelect={jest.fn()} />);
  await waitFor(() => expect(mockMaps).toHaveLength(1));
  const map = mockMaps[0];
  map.getSource.mockReturnValue(undefined);
  await act(async () => map.fire("load"));
  await waitFor(() => expect(onState).toHaveBeenLastCalledWith({ modelId: model().id, status: "error" }));
  act(() => map.fire("idle"));
  expect(onState).toHaveBeenLastCalledWith({ modelId: model().id, status: "error" });
  expect(map.fitBounds).not.toHaveBeenCalled();
});

test.each(["render-first", "camera-first"] as const)("native settles both lifecycle orders once: %s", async (order) => {
  let release!: () => void;
  mockSetStop.mockImplementationOnce(() => new Promise<undefined>(resolve => { release = () => resolve(undefined); }));
  const onState = jest.fn(), first = model();
  render(<NativeRenderer model={first} style={style} camera={camera} onState={onState} onSelect={jest.fn()} />);
  // Pre-dispatch frames cannot count toward camera readiness.
  act(() => mockNativeMap.onDidFinishRenderingMapFully());
  await act(async () => mockNativeMap.onDidFinishLoadingMap());
  if (order === "render-first") {
    act(() => mockNativeMap.onDidFinishRenderingMapFully());
    expect(onState).not.toHaveBeenCalledWith({ modelId: first.id, status: "ready" });
    await act(async () => release());
  } else {
    await act(async () => release());
    expect(onState).not.toHaveBeenCalledWith({ modelId: first.id, status: "ready" });
    act(() => mockNativeMap.onDidFinishRenderingMapFully());
  }
  expect(onState).toHaveBeenLastCalledWith({ modelId: first.id, status: "ready" });
  act(() => mockNativeMap.onDidFinishRenderingMapFully());
  expect(onState.mock.calls.filter(([state]) => state.status === "ready")).toHaveLength(1);
});

test("native isolates stale render and camera acceptance from the replacement model scene", async () => {
  let releaseOld!: () => void;
  mockSetStop.mockImplementationOnce(() => new Promise<undefined>(resolve => { releaseOld = () => resolve(undefined); }));
  const onState = jest.fn(), first = model(), next = model("two");
  const view = render(<NativeRenderer model={first} style={style} camera={camera} onState={onState} onSelect={jest.fn()} />);
  await act(async () => mockNativeMap.onDidFinishLoadingMap());
  const oldScene = mockNativeMap;
  view.rerender(<NativeRenderer model={next} style={style} camera={camera} onState={onState} onSelect={jest.fn()} />);
  await act(async () => mockNativeMap.onDidFinishLoadingMap());
  const calls = onState.mock.calls.length;
  act(() => { oldScene.onDidFinishRenderingMapFully(); oldScene.onDidFailLoadingMap(); oldScene.onDidFinishLoadingMap(); });
  await act(async () => releaseOld());
  expect(onState).toHaveBeenCalledTimes(calls);
  expect(onState).not.toHaveBeenCalledWith({ modelId: next.id, status: "ready" });
  act(() => mockNativeMap.onDidFinishRenderingMapFully());
  expect(onState).toHaveBeenLastCalledWith({ modelId: next.id, status: "ready" });
});
