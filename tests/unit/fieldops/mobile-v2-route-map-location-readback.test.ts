import * as React from "react";

import {
  parseMobileV2LocationPingReadback,
  type RecordFieldopsLocationPingInput,
} from "../../../apps/fieldops/src/mobile-v2-rpc-hooks";
import {
  buildMobileV2NativeDeviceRegistrationPayload,
  buildMobileV2RouteMapLocationError,
  buildMobileV2RouteMapReadback,
  buildMobileV2StopLocationReadback,
  formatMobileV2MapLocationChipLabel,
  formatMobileV2MapLocationCoordinateLine,
  formatMobileV2MapLocationIdentityLine,
  formatMobileV2MapStopCoordinateLine,
  formatMobileV2MapStopGeocodeLine,
  formatMobileV2MapStopShortAddress,
  formatMobileV2RouteMapLocationError,
  MOBILE_V2_ROUTE_MAP_LAST_KNOWN_POSITION_OPTIONS,
  normalizeMobileV2DeviceId,
  normalizeMobileV2LocationAccuracy,
  normalizeMobileV2LocationHeading,
  normalizeMobileV2LocationNumber,
  normalizeMobileV2RouteMapStopId,
  resolveMobileV2RouteMapGeocodeReadbackStop,
  resolveMobileV2NativeShellDeviceId,
  resolveMobileV2RouteMapPosition,
} from "../../../apps/fieldops/src/mobile-v2-route-map-location";
import type { MobileV2RouteStop } from "../../../apps/fieldops/src/mobile-v2-route-screen";
import type { MobileV2StopDetail } from "../../../apps/fieldops/src/mobile-v2-stop-screen";
import { MOBILE_V2_THEMES } from "../../../apps/fieldops/src/mobile-v2-themes";

function createReactNativeMock() {
  const ReactRuntime = require("react") as typeof React;
  const native = (name: string) =>
    function MockNativeComponent(props: { readonly children?: React.ReactNode }) {
      return ReactRuntime.createElement(name, props, props.children);
    };

  return {
    Pressable: native("Pressable"),
    ScrollView: native("ScrollView"),
    StyleSheet: {
      create: <T>(styles: T): T => styles,
      hairlineWidth: 1,
    },
    Text: native("Text"),
    View: native("View"),
  };
}

function createReactNativeSvgMock() {
  const ReactRuntime = require("react") as typeof React;
  const svg = (name: string) =>
    function MockSvgComponent(props: { readonly children?: React.ReactNode }) {
      return ReactRuntime.createElement(name, props, props.children);
    };

  return {
    __esModule: true,
    default: svg("Svg"),
    Circle: svg("Circle"),
    Defs: svg("Defs"),
    G: svg("G"),
    Path: svg("Path"),
    Pattern: svg("Pattern"),
    Rect: svg("Rect"),
    Text: svg("SvgText"),
  };
}

function mockMobileV2StopScreenNativeModules(): void {
  jest.doMock("react-native", createReactNativeMock);
  jest.doMock("../../../apps/fieldops/node_modules/react-native", createReactNativeMock, { virtual: true });
  jest.doMock("react-native-svg", createReactNativeSvgMock);
  try {
    jest.doMock(
      require.resolve("../../../apps/fieldops/node_modules/react-native"),
      createReactNativeMock,
    );
  } catch {
    // The app-local package is absent in clean CI installs; the module-name mock above covers that path.
  }
}

const DEVICE_ID = "4d1fbd36-6b6e-4c35-acc4-5e3ad9043830";
const ROUTE_RUN_ID = "22222222-2222-4222-8222-222222222222";
const ROUTE_STOP_ID = "33333333-3333-4333-8333-333333333333";
const PING_ID = "44444444-4444-4444-8444-444444444444";

function pingInput(): RecordFieldopsLocationPingInput["p_ping"] {
  return Object.freeze({
    device_id: DEVICE_ID,
    route_run_id: ROUTE_RUN_ID,
    route_stop_id: ROUTE_STOP_ID,
    lat: 24.71355,
    lng: 46.6753,
    accuracy_m: 12,
    speed_mps: null,
    heading_deg: null,
    captured_at: "2026-05-27T18:00:00.000Z",
    metadata: Object.freeze({ source: "unit" }),
  });
}

function collectRenderedText(node: React.ReactNode): string[] {
  if (node === null || node === undefined || typeof node === "boolean") return [];
  if (typeof node === "string" || typeof node === "number") return [String(node)];
  if (Array.isArray(node)) return node.flatMap(collectRenderedText);
  if (React.isValidElement<{ readonly children?: React.ReactNode }>(node)) {
    return collectRenderedText(node.props.children);
  }
  if (typeof node === "object" && "props" in node) {
    const props = (node as { readonly props?: { readonly children?: React.ReactNode } }).props;
    return collectRenderedText(props?.children);
  }
  return [];
}

describe("Mobile V2 route-map location ping readback", () => {
  test("parses canonical record_location_ping_v1 readback with route lineage", () => {
    expect(
      parseMobileV2LocationPingReadback(
        [{ location_ping_id: PING_ID, created: true }],
        pingInput(),
        "loc-key-1",
      ),
    ).toEqual({
      locationPingId: PING_ID,
      created: true,
      idempotencyKey: "loc-key-1",
      deviceId: DEVICE_ID,
      routeRunId: ROUTE_RUN_ID,
      routeStopId: ROUTE_STOP_ID,
      latitude: 24.71355,
      longitude: 46.6753,
      accuracyM: 12,
      capturedAt: "2026-05-27T18:00:00.000Z",
    });
  });

  test("preserves idempotent replay state from the backend", () => {
    expect(
      parseMobileV2LocationPingReadback(
        { location_ping_id: PING_ID, created: false },
        pingInput(),
        "loc-key-replay",
      ).created,
    ).toBe(false);
  });

  test("fails closed when the backend response lacks a location_ping_id", () => {
    expect(() =>
      parseMobileV2LocationPingReadback({ created: true }, pingInput(), "loc-key-bad"),
    ).toThrow(/unexpected location ping readback/);
  });

  test("formats the same-screen saved readback state without importing the TSX screen", () => {
    const readback = buildMobileV2RouteMapReadback(
      parseMobileV2LocationPingReadback(
        [{ location_ping_id: PING_ID, created: true }],
        pingInput(),
        "loc-key-ui",
      ),
      "Stop 2 - Route Customer",
    );

    expect(readback).toEqual({
      status: "saved",
      pingId: PING_ID,
      capturedAt: "2026-05-27T18:00:00.000Z",
      latitude: 24.71355,
      longitude: 46.6753,
      accuracyM: 12,
      routeStopLabel: "Stop 2 - Route Customer",
      message: "Location saved",
    });
    expect(formatMobileV2MapLocationChipLabel(readback)).toBe("Location saved");
    expect(formatMobileV2MapLocationIdentityLine(readback, 2)).toBe(
      "Stop 2 - Route Customer",
    );
    expect(formatMobileV2MapLocationCoordinateLine(readback)).toBe(
      "24.71355, 46.67530 - 12m",
    );
  });

  test("normalizes route-map ping input and error state fail-closed", () => {
    expect(normalizeMobileV2DeviceId("  ")).toBeNull();
    expect(normalizeMobileV2DeviceId(DEVICE_ID)).toBe(DEVICE_ID);
    expect(resolveMobileV2NativeShellDeviceId(` ${DEVICE_ID} `, null)).toBe(DEVICE_ID);
    expect(resolveMobileV2NativeShellDeviceId(null, ` ${DEVICE_ID} `)).toBe(DEVICE_ID);
    expect(resolveMobileV2NativeShellDeviceId(" ", " ")).toBeNull();
    expect(
      buildMobileV2NativeDeviceRegistrationPayload({
        deviceIdentifierSha256: "device-sha",
        platform: "android",
        deviceLabel: "MasarX FieldOps API34",
        appVersion: "0.1.0",
        osVersion: "14",
        expoSdk: "54.0.0",
        expoRuntime: null,
      }),
    ).toEqual({
      device_platform: "android",
      device_identifier_sha256: "device-sha",
      device_label: "MasarX FieldOps API34",
      push_token: null,
      app_version: "0.1.0",
      os_version: "14",
      metadata: {
        app: "fieldops",
        platform: "android",
        source: "mobile_v2_native_shell",
        expo_sdk: "54.0.0",
        expo_runtime: null,
      },
    });
    expect(normalizeMobileV2LocationNumber(Number.NaN)).toBeNull();
    expect(normalizeMobileV2LocationNumber(24.7)).toBe(24.7);
    expect(normalizeMobileV2LocationAccuracy(-5)).toBe(0);
    expect(normalizeMobileV2LocationHeading(361)).toBeNull();
    expect(normalizeMobileV2LocationHeading(359.6)).toBe(360);
    expect(normalizeMobileV2RouteMapStopId(null)).toBeNull();
    expect(
      normalizeMobileV2RouteMapStopId({
        id: `stop:${ROUTE_STOP_ID}`,
        seq: 2,
        customer: "Route Customer",
        address: "Route District",
        sla: "18:00",
        etaMin: 0,
        distanceKm: 0,
        cod: 0,
      }),
    ).toBe(ROUTE_STOP_ID);

    expect(formatMobileV2RouteMapLocationError(new Error("No GPS"))).toBe("No GPS");
    expect(buildMobileV2RouteMapLocationError("No GPS")).toEqual({
      status: "error",
      pingId: null,
      capturedAt: null,
      latitude: null,
      longitude: null,
      accuracyM: null,
      routeStopLabel: null,
      message: "No GPS",
    });
  });

  test("uses last known native location when current fix is unavailable", async () => {
    const lastKnown = {
      coords: {
        latitude: 24.7136,
        longitude: 46.6753,
        accuracy: 5,
        speed: null,
        heading: null,
      },
      timestamp: Date.parse("2026-05-27T18:05:00.000Z"),
    };

    await expect(
      resolveMobileV2RouteMapPosition({
        getCurrentPosition: async () => {
          throw new Error("current unavailable");
        },
        getLastKnownPosition: async () => lastKnown,
      }),
    ).resolves.toBe(lastKnown);
  });

  test("prefers last known native location before waiting on a fresh current fix", async () => {
    const lastKnown = {
      coords: {
        latitude: 24.713,
        longitude: 46.6766,
        accuracy: 5,
        speed: null,
        heading: null,
      },
      timestamp: Date.parse("2026-06-07T12:40:00.000Z"),
    };
    const getCurrentPosition = jest.fn(async () => {
      throw new Error("current lookup should not run when a valid last-known fix exists");
    });

    await expect(
      resolveMobileV2RouteMapPosition({
        getCurrentPosition,
        getLastKnownPosition: async () => lastKnown,
      }),
    ).resolves.toBe(lastKnown);
    expect(getCurrentPosition).not.toHaveBeenCalled();
  });

  test("uses a fresh current fix when no cached native location is available", async () => {
    const current = {
      coords: {
        latitude: 24.7134,
        longitude: 46.6769,
        accuracy: 7,
        speed: null,
        heading: null,
      },
      timestamp: Date.parse("2026-06-07T12:41:00.000Z"),
    };
    const getLastKnownPosition = jest.fn(async () => null);
    const getCurrentPosition = jest.fn(async () => current);

    await expect(
      resolveMobileV2RouteMapPosition({
        getCurrentPosition,
        getLastKnownPosition,
      }),
    ).resolves.toBe(current);
    expect(getLastKnownPosition).toHaveBeenCalledTimes(1);
    expect(getCurrentPosition).toHaveBeenCalledTimes(1);
  });

  test("documents Expo-enforced cached location freshness and accuracy boundary", () => {
    expect(MOBILE_V2_ROUTE_MAP_LAST_KNOWN_POSITION_OPTIONS).toEqual({
      maxAge: 120_000,
      requiredAccuracy: 100,
    });
  });

  test("falls back to last known native location when current fix times out", async () => {
    const lastKnown = {
      coords: {
        latitude: 24.7136,
        longitude: 46.6753,
        accuracy: 5,
        speed: null,
        heading: null,
      },
      timestamp: Date.parse("2026-05-27T18:05:00.000Z"),
    };

    await expect(
      resolveMobileV2RouteMapPosition({
        getCurrentPosition: async () => new Promise<never>(() => undefined),
        getLastKnownPosition: async () => lastKnown,
        currentTimeoutMs: 1,
      }),
    ).resolves.toBe(lastKnown);
  });

  test("fails closed when current fix times out and no last known location exists", async () => {
    await expect(
      resolveMobileV2RouteMapPosition({
        getCurrentPosition: async () => new Promise<never>(() => undefined),
        getLastKnownPosition: async () => null,
        currentTimeoutMs: 1,
      }),
    ).rejects.toThrow(/Current location is unavailable/);
  });

  test("selects a map geocode readback stop when an all-done route has no active stop", () => {
    const readbackStop = resolveMobileV2RouteMapGeocodeReadbackStop(null, [
      {
        id: "stop:done-1",
        seq: 1,
        customer: "Delivered Customer",
        address: "Olaya",
        sla: "18:00",
        etaMin: 0,
        distanceKm: 0,
        cod: 0,
        latitude: 24.713,
        longitude: 46.6766,
        accuracyM: 9,
        shortAddress: "TEST0000",
        geocodingStatus: "geocoded",
        geocodingAccuracy: "canonical_centroid",
        geocodingProvider: "canonical_lookup",
        geocodingMatch: "district_match",
      },
      {
        id: "stop:done-2",
        seq: 2,
        customer: "Delivered Customer 2",
        address: "Malaz",
        sla: "18:20",
        etaMin: 0,
        distanceKm: 0,
        cod: 0,
      },
    ]);

    expect(readbackStop?.id).toBe("stop:done-1");
    expect(readbackStop !== null ? formatMobileV2MapStopShortAddress(readbackStop) : null).toBe(
      "TEST0000",
    );
    expect(readbackStop !== null ? formatMobileV2MapStopCoordinateLine(readbackStop) : null).toBe(
      "24.71300, 46.67660 - +/-9 m",
    );
    expect(readbackStop !== null ? formatMobileV2MapStopGeocodeLine(readbackStop) : null).toBe(
      "Verified - Locality centroid - District match",
    );
  });

  test("builds stop-detail location readback from the same route stop geocode fields", () => {
    expect(
      buildMobileV2StopLocationReadback({
        latitude: 24.713,
        longitude: 46.6766,
        accuracyM: 9,
        shortAddress: "TEST0000",
        geocodingStatus: "geocoded",
        geocodingAccuracy: "canonical_centroid",
        geocodingProvider: "canonical_lookup",
        geocodingMatch: "district_match",
      }),
    ).toEqual({
      shortAddress: "TEST0000",
      coordinateLine: "24.71300, 46.67660 - +/-9 m",
      geocodeLine: "Verified - Locality centroid - District match",
    });

    expect(
      buildMobileV2StopLocationReadback({
        latitude: null,
        longitude: null,
        accuracyM: null,
        shortAddress: null,
        geocodingStatus: null,
        geocodingAccuracy: null,
        geocodingProvider: null,
        geocodingMatch: null,
      }),
    ).toBeNull();
  });

  test("skips invalid coordinate-only stops before selecting geocode readback", () => {
    const readbackStop = resolveMobileV2RouteMapGeocodeReadbackStop(null, [
      {
        id: "stop:invalid-coordinate",
        seq: 1,
        customer: "Invalid Coordinate Customer",
        address: "Unknown",
        sla: "18:00",
        etaMin: 0,
        distanceKm: 0,
        cod: 0,
        latitude: Number.NaN,
        longitude: 46.6766,
      },
      {
        id: "stop:readback",
        seq: 2,
        customer: "Readback Customer",
        address: "Olaya",
        sla: "18:15",
        etaMin: 0,
        distanceKm: 0,
        cod: 0,
        latitude: 24.713,
        longitude: 46.6766,
        shortAddress: "TEST0000",
        geocodingStatus: "geocoded",
      },
    ]);

    expect(readbackStop?.id).toBe("stop:readback");
    expect(readbackStop !== null ? formatMobileV2MapStopCoordinateLine(readbackStop) : null).toBe(
      "24.71300, 46.67660",
    );
  });

  test("renders active backend route-row location readback on the stop detail screen", () => {
    mockMobileV2StopScreenNativeModules();
    const { MobileV2StopScreen } =
      require("../../../apps/fieldops/src/mobile-v2-stop-screen") as typeof import("../../../apps/fieldops/src/mobile-v2-stop-screen");
    const activeStopTaskId = `stop:${ROUTE_STOP_ID}`;
    const routeRows: ReadonlyArray<MobileV2RouteStop> = Object.freeze([
      Object.freeze({
        id: "stop:99999999-9999-4999-8999-999999999999",
        seq: 1,
        customer: "Stale Customer",
        address: "Stale address",
        sla: "17:30",
        status: "pending",
        cod: 0,
        fragile: false,
        attempts: 1,
        latitude: 20,
        longitude: 40,
        accuracyM: 25,
        shortAddress: "STALE1234",
        geocodingStatus: "stale",
        geocodingAccuracy: "stale_accuracy",
        geocodingProvider: "stale_provider",
        geocodingMatch: "stale_match",
      }),
      Object.freeze({
        id: activeStopTaskId,
        seq: 2,
        customer: "Route Customer",
        address: "Olaya District",
        sla: "18:00",
        status: "current",
        cod: 0,
        fragile: false,
        attempts: 1,
        latitude: 24.713,
        longitude: 46.6766,
        accuracyM: 9,
        shortAddress: "TEST0000",
        geocodingStatus: "geocoded",
        geocodingAccuracy: "canonical_centroid",
        geocodingProvider: "canonical_lookup",
        geocodingMatch: "district_match",
      }),
    ]);
    const activeRouteRow = routeRows.find((row) => row.id === activeStopTaskId) ?? null;
    const locationReadback = buildMobileV2StopLocationReadback(activeRouteRow);
    const stop: MobileV2StopDetail = {
      id: ROUTE_STOP_ID,
      seq: 2,
      customerInitials: "RC",
      customerName: "Route Customer",
      customerPhone: "+12025550123",
      trackingCode: "MX-READBACK-001",
      stopType: "delivery",
      hazards: [],
      etaMinutes: 0,
      distanceKm: 0,
      window: "18:00",
      addressLines: ["Olaya District"],
      parcels: [],
      proofChecklist: [],
      timeline: [],
    };

    expect(locationReadback).toEqual({
      shortAddress: "TEST0000",
      coordinateLine: "24.71300, 46.67660 - +/-9 m",
      geocodeLine: "Verified - Locality centroid - District match",
    });

    const tree = MobileV2StopScreen({
      theme: MOBILE_V2_THEMES.hivis,
      stop,
      locationReadback,
    });
    const text = collectRenderedText(tree);

    expect(text).toContain("Verified location");
    expect(text).toContain("TEST0000");
    expect(text).toContain("24.71300, 46.67660 - +/-9 m");
    expect(text).toContain("Verified - Locality centroid - District match");
    expect(text).not.toContain("STALE1234");
    expect(text.join(" ")).not.toMatch(
      /mobile-v2-proof-geocoder|sa_short_code|canonical_centroid|canonical_lookup|district_match|stale_provider|stale_match/,
    );
  });

  test("formats raw backend geocoder provenance into driver-friendly stop text", () => {
    const readback = buildMobileV2StopLocationReadback({
      latitude: 24.713,
      longitude: 46.6766,
      accuracyM: 9,
      shortAddress: "TEST0000",
      geocodingStatus: "geocoded",
      geocodingAccuracy: "canonical_centroid",
      geocodingProvider: "mobile-v2-proof-geocoder",
      geocodingMatch: "sa_short_code",
    });

    expect(readback).toEqual({
      shortAddress: "TEST0000",
      coordinateLine: "24.71300, 46.67660 - +/-9 m",
      geocodeLine: "Verified - Locality centroid - Short address match",
    });
    expect(
      [
        readback?.shortAddress,
        readback?.coordinateLine,
        readback?.geocodeLine,
      ].join(" "),
    ).not.toMatch(
      /mobile-v2-proof-geocoder|sa_short_code|canonical_centroid|canonical_lookup|district_match/,
    );
  });
});
