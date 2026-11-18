import * as React from "react";

import {
  parseMobileV2StopDetailEnvelope,
  resolveMobileV2StopDetailForRender,
} from "../../../apps/fieldops/src/mobile-v2-rpc-hooks";
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
    // Clean installs may not have an app-local package; the module-name mock covers that path.
  }
}

function collectAccessibilityLabels(node: React.ReactNode): string[] {
  if (node === null || node === undefined || typeof node === "boolean") return [];
  if (typeof node === "string" || typeof node === "number") return [];
  if (Array.isArray(node)) return node.flatMap(collectAccessibilityLabels);
  if (React.isValidElement<{ readonly children?: React.ReactNode; readonly accessibilityLabel?: string }>(node)) {
    const own = typeof node.props.accessibilityLabel === "string" ? [node.props.accessibilityLabel] : [];
    return own.concat(collectAccessibilityLabels(node.props.children));
  }
  if (typeof node === "object" && "props" in node) {
    const props = (node as {
      readonly props?: { readonly children?: React.ReactNode; readonly accessibilityLabel?: string };
    }).props;
    const own = typeof props?.accessibilityLabel === "string" ? [props.accessibilityLabel] : [];
    return own.concat(collectAccessibilityLabels(props?.children));
  }
  return [];
}

const fallbackStop: MobileV2StopDetail = Object.freeze({
  id: "fixture-stop",
  seq: 1,
  customerInitials: "PV",
  customerName: "Preview Recipient",
  customerPhone: "+966550000012",
  trackingCode: "FIXTURE-TRACKING",
  stopType: "delivery",
  hazards: [],
  etaMinutes: 0,
  distanceKm: 0,
  window: "10:00",
  addressLines: ["Preview address"],
  parcels: [],
  proofChecklist: [],
  timeline: [],
});

describe("parseMobileV2StopDetailEnvelope", () => {
  test("does not fabricate a preview phone when live backend stop detail omits customerPhone", () => {
    const parsed = parseMobileV2StopDetailEnvelope(
      {
        id: "MVT-FIRST-TASK-0606",
        seq: 1,
        customerInitials: "-",
        customerName: "-",
        trackingCode: "MVT-FIRST-TASK-0606",
        stopType: "delivery",
        hazards: [],
        etaMinutes: 0,
        distanceKm: 0,
        window: "10:00",
        addressLines: ["TEST0000 Olaya Riyadh", "Riyadh"],
        parcels: [],
        proofChecklist: [],
        timeline: [],
      },
      fallbackStop,
    );

    expect(parsed.customerPhone).toBeUndefined();
  });

  test("keeps backend-provided customerPhone when present", () => {
    const parsed = parseMobileV2StopDetailEnvelope(
      {
        id: "MVT-FIRST-TASK-0606",
        customerPhone: "+966555555555",
      },
      fallbackStop,
    );

    expect(parsed.customerPhone).toBe("+966555555555");
  });

  test("keeps backend COD collection readback for same-screen proof", () => {
    const parsed = parseMobileV2StopDetailEnvelope(
      {
        id: "MVT-COD-STOP",
        paymentCollection: {
          outcome: "collected",
          method: "cash",
          expectedAmount: 42.5,
          collectedAmount: 42.5,
          tenderedAmount: 50,
          changeDueAmount: 7.5,
          currency: "SAR",
          source: "shipment_action",
          shipmentActionId: "00000000-1111-4222-8333-444444444444",
        },
      },
      fallbackStop,
    );

    expect(parsed.paymentCollection).toEqual({
      outcome: "collected",
      method: "cash",
      expectedAmount: 42.5,
      collectedAmount: 42.5,
      tenderedAmount: 50,
      changeDueAmount: 7.5,
      currency: "SAR",
      source: "shipment_action",
      shipmentActionId: "00000000-1111-4222-8333-444444444444",
    });
  });

  test("omits blank backend customerPhone values", () => {
    const parsed = parseMobileV2StopDetailEnvelope(
      {
        id: "MVT-FIRST-TASK-0606",
        customerPhone: "   ",
      },
      fallbackStop,
    );

    expect(parsed.customerPhone).toBeUndefined();
  });
});

describe("resolveMobileV2StopDetailForRender", () => {
  test("does not expose preview contact fallback for persisted backend stops before detail data resolves", () => {
    const resolved = resolveMobileV2StopDetailForRender({
      data: undefined,
      fallback: fallbackStop,
      stopId: "50fa256f-58e9-4071-a8f8-54be6743210f",
      allowPreviewFallback: false,
    });

    expect(resolved.id).toBe("50fa256f-58e9-4071-a8f8-54be6743210f");
    expect(resolved.customerPhone).toBeUndefined();
  });
});

describe("MobileV2StopScreen contact actions", () => {
  beforeEach(() => {
    jest.resetModules();
    mockMobileV2StopScreenNativeModules();
  });

  test.each([undefined, "", "   "])(
    "does not render call or WhatsApp actions without a non-empty backend-backed customerPhone: %p",
    (customerPhone) => {
    const { MobileV2StopScreen } =
      require("../../../apps/fieldops/src/mobile-v2-stop-screen") as typeof import("../../../apps/fieldops/src/mobile-v2-stop-screen");
    const tree = MobileV2StopScreen({
      theme: MOBILE_V2_THEMES.hivis,
      stop: {
        ...fallbackStop,
        id: "50fa256f-58e9-4071-a8f8-54be6743210f",
        customerPhone,
      },
    });

    const labels = collectAccessibilityLabels(tree);

    expect(labels).not.toContain("Call");
    expect(labels).not.toContain("WhatsApp");
    },
  );

  test("keeps call and WhatsApp actions when backend customerPhone is present", () => {
    const { MobileV2StopScreen } =
      require("../../../apps/fieldops/src/mobile-v2-stop-screen") as typeof import("../../../apps/fieldops/src/mobile-v2-stop-screen");
    const tree = MobileV2StopScreen({
      theme: MOBILE_V2_THEMES.hivis,
      stop: {
        ...fallbackStop,
        customerPhone: "+966555555555",
      },
    });

    const labels = collectAccessibilityLabels(tree);

    expect(labels).toContain("Call");
    expect(labels).toContain("WhatsApp");
  });
});
