// Issue #602: stop parcel and proof status render only from the stop-detail
// read-back. Taps route to the scan and proof capture commands; they never
// mark a parcel scanned or a proof item done on screen.
import * as fs from "fs";
import * as path from "path";
import * as React from "react";

import { parseMobileV2StopDetailEnvelope } from "../../../apps/fieldops/src/mobile-v2-rpc-hooks";
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

type NodeProps = {
  readonly children?: React.ReactNode;
  readonly accessibilityLabel?: string;
  readonly accessibilityRole?: string;
  readonly accessibilityState?: { readonly checked?: boolean };
  readonly onPress?: () => void;
};

function collectNodeProps(node: React.ReactNode): NodeProps[] {
  if (node === null || node === undefined || typeof node === "boolean") return [];
  if (typeof node === "string" || typeof node === "number") return [];
  if (Array.isArray(node)) return node.flatMap(collectNodeProps);
  if (typeof node === "object" && "props" in node) {
    const props = (node as { readonly props?: NodeProps }).props;
    if (props === undefined) return [];
    return [props, ...collectNodeProps(props.children)];
  }
  return [];
}

const STOP_ID = "50fa256f-58e9-4071-a8f8-54be6743210f";

const fallbackStop: MobileV2StopDetail = Object.freeze({
  id: "fixture-stop",
  seq: 1,
  customerInitials: "PV",
  customerName: "Preview Recipient",
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

function readback(parcelStatus: string, photoStatus: string): MobileV2StopDetail {
  return parseMobileV2StopDetailEnvelope(
    {
      id: STOP_ID,
      parcels: [{ id: "box-1", code: "TEST-BOX-01", status: parcelStatus }],
      proofChecklist: [{ key: "photo", label: "Capture photo at door", status: photoStatus }],
    },
    fallbackStop,
  );
}

function renderStop(
  stop: MobileV2StopDetail,
  handlers: { onScanParcel?: () => void; onProofPress?: (key: string) => void; locale?: string } = {},
) {
  const { MobileV2StopScreen } =
    require("../../../apps/fieldops/src/mobile-v2-stop-screen") as typeof import("../../../apps/fieldops/src/mobile-v2-stop-screen");
  return collectNodeProps(MobileV2StopScreen({ theme: MOBILE_V2_THEMES.hivis, stop, ...handlers }));
}

// A proof tap opens capture, so the row is a button whose label carries the read-back status.
function proofRow(nodes: NodeProps[]): NodeProps | undefined {
  return nodes.find((n) => n.accessibilityLabel?.startsWith("Capture photo at door, ") === true);
}

describe("MobileV2StopScreen parcel and proof status (#602)", () => {
  beforeEach(() => {
    jest.resetModules();
    mockMobileV2StopScreenNativeModules();
  });

  test("shows pending parcel and proof until the server read-back reports them", () => {
    const nodes = renderStop(readback("pending", "pending"));

    expect(nodes.map((n) => n.accessibilityLabel)).toContain("Parcel TEST-BOX-01 pending");
    expect(proofRow(nodes)).toMatchObject({ accessibilityRole: "button", accessibilityLabel: "Capture photo at door, Pending" });
    expect(proofRow(nodes)?.accessibilityState?.checked).toBeUndefined();
  });

  test("shows scanned parcel and done proof from the server read-back", () => {
    const nodes = renderStop(readback("scanned", "done"));

    expect(nodes.map((n) => n.accessibilityLabel)).toContain("Parcel TEST-BOX-01 scanned");
    expect(proofRow(nodes)).toMatchObject({ accessibilityRole: "button", accessibilityLabel: "Capture photo at door, Done" });
    expect(proofRow(nodes)?.accessibilityState?.checked).toBeUndefined();
  });

  test("proof row status in the accessible label follows the locale", () => {
    const { AR_STRINGS } = require("../../../apps/fieldops/src/i18n") as typeof import("../../../apps/fieldops/src/i18n");
    const labels = (status: string) =>
      renderStop(readback("pending", status), { locale: "ar-SA" }).map((n) => n.accessibilityLabel);

    expect(labels("pending")).toContain(`Capture photo at door, ${AR_STRINGS.home.counter_pending}`);
    expect(labels("done")).toContain(`Capture photo at door, ${AR_STRINGS.home.counter_done}`);
  });

  test("parcel rows are buttons without a checked state", () => {
    const parcel = renderStop(readback("scanned", "done")).find((n) => n.accessibilityLabel === "Parcel TEST-BOX-01 scanned");

    expect(parcel?.accessibilityRole).toBe("button");
    expect(parcel?.accessibilityState?.checked).toBeUndefined();
  });

  test("a proof tap hands the key to the capture path and leaves status to the read-back", () => {
    const onProofPress = jest.fn();
    const stop = readback("pending", "pending");
    const row = proofRow(renderStop(stop, { onProofPress }));

    row?.onPress?.();

    expect(onProofPress).toHaveBeenCalledWith("photo");
    expect(proofRow(renderStop(stop, { onProofPress }))?.accessibilityLabel).toBe("Capture photo at door, Pending");
  });
});

describe("FieldOps preview screen scan and proof routing (#602)", () => {
  const source = fs.readFileSync(
    path.join(__dirname, "../../../apps/fieldops/src/mobile-v2-preview-screen.tsx"),
    "utf8",
  );

  test("keeps no local parcel or proof status state", () => {
    expect(source).not.toMatch(/parcelStatusOverrides|proofStatusOverrides/);
    expect(source).not.toMatch(/handheld jam workaround/i);
    expect(source).not.toContain("Parcel status toggled");
  });

  test.each(["onScanParcel", "onProofPress"])("routes the stop %s tap to proof capture", (handler) => {
    expect(source).toMatch(
      new RegExp(`${handler}=\\{\\(\\) => \\{\\s*setPodFailSheetOpen\\(false\\);\\s*setActiveTabId\\("mobile-pod"\\);\\s*\\}\\}`),
    );
  });
});
