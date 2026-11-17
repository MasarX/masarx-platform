import * as fs from "node:fs";
import * as path from "node:path";
import * as ts from "typescript";
import { getFieldOpsStrings } from "../../../apps/fieldops/src/i18n";
import { mobileActionAccessibility, mobileSyncAccessibility } from "../../../apps/fieldops/src/mobile-action-accessibility";
import { extractAddressFields } from "../../../apps/fieldops/src/mobile-shell-surface-helpers";
import { StopAddressActions } from "../../../apps/fieldops/src/mobile-address-actions-controls";

jest.mock("react-native", () => jest.requireActual("react-native-web"));
// The extracted app component must share the static renderer's React instance.
jest.mock(require.resolve("react", { paths: [require("node:path").resolve(__dirname, "../../../apps/fieldops")] }), () => jest.requireActual("react"));

test.each([[false,false,false],[true,false,false],[false,true,false],[false,false,true]])(
  "actual queue host exposes disabled semantics for submitting=%s fetching=%s policy=%s",
  (composerSubmitting, fetching, policyDisabled) => {
    const React = require("react");
    const { Pressable, Text } = require("react-native-web");
    const render = require("react-dom/server").renderToStaticMarkup;
    const opening = find(app, node => ts.isJsxOpeningElement(node) &&
      node.attributes.properties.some(prop => ts.isJsxAttribute(prop) &&
        prop.name.getText(app) === "testID" && ts.isStringLiteral(prop.initializer!) &&
        prop.initializer.text === "mobile-action-composer-queue"));
    const code = ts.transpileModule("return (" + opening.parent.getText(app) + ");", {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.React },
    }).outputText;
    const element = Function("React", "Pressable", "Text", "composerSubmitting", "composerLookupQuery",
      "composerPodPolicyState", "styles", "strings", "submitComposer", code)(React, Pressable, Text,
      composerSubmitting, { isFetching: fetching }, { submitDisabled: policyDisabled }, {},
      getFieldOpsStrings("en"), jest.fn());
    const html = render(element);
    expect(html).toContain('role="button"');
    const disabled = composerSubmitting || fetching || policyDisabled;
    if (disabled) {
      expect(html).toContain('aria-disabled="true"');
      expect(html).toContain('tabindex="-1"');
    } else {
      expect(html).not.toContain('aria-disabled="true"');
      expect(html).toContain('tabindex="0"');
    }
  });
const app = ts.createSourceFile("App.tsx", fs.readFileSync(path.resolve(__dirname, "../../../apps/fieldops/App.tsx"), "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
function find(root: ts.Node, predicate: (node: ts.Node) => boolean): ts.Node {
  let found: ts.Node | undefined;
  function visit(node: ts.Node) {
    if (found) return;
    if (predicate(node)) { found = node; return; }
    ts.forEachChild(node, visit);
  }
  visit(root);
  if (!found) throw new Error("Actual App expression not found");
  return found;
}
function evaluate(expression: ts.Node, values: Record<string, unknown>) {
  const code = ts.transpileModule("return (" + expression.getText(app) + ");", {
    compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.React },
  }).outputText;
  return Function(...Object.keys(values), code)(...Object.values(values));
}
const scan = find(app, node => ts.isFunctionDeclaration(node) && node.name?.text === "ScanScreen");
test.each(["en", "ar"] as const)("shared action and sync helpers expose native and web busy state in %s", locale => {
  const React = require("react");
  const { Pressable, Text } = require("react-native-web");
  const render = require("react-dom/server").renderToStaticMarkup;
  const copy = getFieldOpsStrings(locale).actionAccessibility;
  for (const busy of [false, true]) for (const blocked of [false, true]) {
    for (const props of [
      mobileActionAccessibility(undefined, blocked, busy),
      mobileSyncAccessibility(copy, busy, !blocked, true, 2),
    ]) {
      expect(props["aria-busy"]).toBe(busy);
      expect(props.accessibilityState.busy).toBe(busy);
      const html = render(React.createElement(Pressable, {
        ...props, disabled: props.accessibilityState.disabled,
      }, React.createElement(Text, null, "Action")));
      expect(html).toContain('role="button"');
      expect(html.includes('aria-busy="true"')).toBe(busy);
      expect(html.includes('aria-disabled="true"')).toBe(props.accessibilityState.disabled);
    }
  }
});
test.each(["en", "ar"] as const)("actual camera controls retain names and state in %s", locale => {
  const React = require("react");
  const { Pressable, Text } = require("react-native-web");
  const render = require("react-dom/server").renderToStaticMarkup;
  const strings = getFieldOpsStrings(locale);
  for (const id of ["mobile-self-kyc-open-camera", "mobile-self-kyc-capture", "mobile-action-composer-open-proof-camera", "mobile-action-composer-capture-proof"]) {
    const opening = find(app, node => ts.isJsxOpeningElement(node) &&
      node.attributes.properties.some(prop => ts.isJsxAttribute(prop) && prop.name.getText(app) === "testID" &&
        ts.isStringLiteral(prop.initializer!) && prop.initializer.text === id));
    for (const [composerCameraOpen, composerSubmitting, isCapturingComposerArtifact, count] of [
      [false, false, false, 0], [true, false, false, 0], [true, true, false, 0],
      [true, false, true, 0], [true, false, false, 2],
    ] as const) {
      const capture = id.includes("capture");
      const kyc = id.includes("self-kyc");
      const disabled = capture
        ? !composerCameraOpen || composerSubmitting || isCapturingComposerArtifact || (kyc && count >= 2)
        : composerSubmitting || (kyc ? isCapturingComposerArtifact : count >= 2);
      const busy = composerSubmitting || isCapturingComposerArtifact;
      const element = evaluate(opening.parent, { React, Pressable, Text, strings, styles: {},
        mobileActionAccessibility, composerCameraOpen, composerSubmitting, isCapturingComposerArtifact,
        composerArtifacts: Array(count), composerArtifactMaxItems: 2,
        setComposerCameraOpen: jest.fn(), captureComposerArtifact: jest.fn() });
      expect(element.props.disabled).toBe(disabled);
      expect(element.props.accessibilityState).toEqual({ disabled, busy });
      const html = render(element);
      expect(html).toContain('role="button"');
      expect(html.includes('aria-disabled="true"')).toBe(disabled);
      expect(html.includes('aria-busy="true"')).toBe(busy);
      expect(html).toContain(capture
        ? isCapturingComposerArtifact ? strings.selfKyc.capturing : strings.selfKyc.capture
        : composerCameraOpen ? strings.selfKyc.closeCamera : strings.selfKyc.openCamera);
    }
  }
});

test.each(["en", "ar"] as const)("actual address card preserves configured rows and fallback in %s", locale => {
  const React = require("react");
  const { View, Text, Platform } = require("react-native-web");
  const render = require("react-dom/server").renderToStaticMarkup;
  const strings = getFieldOpsStrings(locale);
  const title = find(app, node => ts.isJsxElement(node) && node.openingElement.tagName.getText(app) === "Text" &&
    node.children.some(child => ts.isJsxExpression(child) && child.expression?.getText(app) === "strings.detail.address"));
  const card = title.parent;
  const summary = find(app, node => ts.isConditionalExpression(node) && node.condition.getText(app) === "stop.addressSummary");
  const labels = locale === "ar" ? ["المدينة", "الحي"] : ["City", "District"];
  for (const showAccuracy of [false, true]) {
    const addressPolicy = { fields: [{ key: "city", label: labels[0], required: true },
      { key: "district", label: labels[1], required: false }], showCoordinates: false, showAccuracy };
    const addressRows = extractAddressFields({ city: "Riyadh", district: "North" }, addressPolicy);
    const values = { React, View, Text, Platform, StopAddressActions, strings, styles: {}, addressPolicy, addressRows,
      addressActionStrings: strings.addressActions, interactionLocked: false, isExecutingRouteAction: false,
      withRouteActionLock: async (action: () => Promise<void>) => action(),
      stop: { fullAddress: null, addressSummary: null }, coordinates: { accuracyM: 2.5 }, diagnosticsEnabled: false };
    const html = render(evaluate(card, values));
    expect(html).toContain(strings.detail.addressIncomplete);
    expect(html).toContain(labels[0] + " *");
    expect(html.indexOf("Riyadh")).toBeLessThan(html.indexOf("North"));
    expect(html).toContain(labels[1]);
    expect(html.includes(strings.detail.accuracy(3))).toBe(showAccuracy);
    expect(render(evaluate(summary, values))).toContain(strings.detail.addressIncomplete);
    const populated = { ...values, stop: { fullAddress: "Full address", addressSummary: "Summary address" } };
    expect(render(evaluate(card, populated))).toContain("Full address");
    expect(render(evaluate(card, populated))).toContain(strings.addressActions.copy);
    expect(render(evaluate(card, { ...populated, interactionLocked: true }))).toContain('aria-disabled="true"');
    expect(render(evaluate(summary, populated))).toContain("Summary address");
  }
});

function initializer(name: string) {
  const node = find(scan, node => ts.isVariableDeclaration(node) && node.name.getText(app) === name) as ts.VariableDeclaration;
  return node.initializer!;
}
function scanInput(name: string) {
  return find(scan, node => ts.isJsxSelfClosingElement(node) && node.tagName.getText(app) === "TextInput" &&
    node.attributes.properties.some(prop => ts.isJsxAttribute(prop) && prop.name.getText(app) === "value" && prop.initializer?.getText(app) === "{" + name + "}")) as ts.JsxSelfClosingElement;
}
describe("actual scan policy input admission", () => {
  test.each([
    [false, false, false, true],
    [true, false, false, true],
    [true, true, true, true],
    [true, true, false, false],
  ])("loaded=%s enabled=%s driving=%s", (scanPolicyLoaded, scanEnabled, drivingModeLocked, expected) => {
    const scanReadOnly = evaluate(initializer("scanReadOnly"), { scanPolicyLoaded, scanEnabled, drivingModeLocked });
    expect(scanReadOnly).toBe(expected);
    for (const name of ["scanType", "barcode"]) {
      const attr = scanInput(name).attributes.properties.find(prop => ts.isJsxAttribute(prop) && prop.name.getText(app) === "editable") as ts.JsxAttribute;
      expect(evaluate((attr.initializer as ts.JsxExpression).expression!, { scanReadOnly })).toBe(!expected);
    }
  });
  test.each(["en", "ar"] as const)("policy hints use %s catalog", locale => {
    const strings = getFieldOpsStrings(locale);
    expect(evaluate(initializer("scanInputHint"), { strings, scanPolicyQuery: { isLoading: true }, scanPolicyUnavailable: false, scanEnabled: false, drivingModeLocked: false }))
      .toBe(strings.actionAccessibility.policyLoading);
  });
});
describe("action and sync accessibility", () => {
  test("does not announce stale disabled reasons for enabled actions", () => {
    expect(mobileActionAccessibility("blocked", false)).toMatchObject({ accessibilityHint: undefined, accessibilityState: { disabled: false, busy: false } });
  });
  test.each(["en", "ar"] as const)("truthful pending and disabled states in %s", locale => {
    const copy = getFieldOpsStrings(locale).actionAccessibility;
    for (const [syncing, online, policy, hint] of [
      [true, true, true, copy.syncBusy],
      [false, false, true, copy.syncOffline],
      [false, true, false, copy.syncPolicy],
      [false, true, true, copy.syncReady],
    ] as const) {
      const props = mobileSyncAccessibility(copy, syncing, online, policy, 3);
      expect(props.accessibilityState).toEqual({ disabled: syncing || !online || !policy, busy: syncing });
      expect(props.accessibilityHint).toBe(copy.pending(3) + " " + hint);
    }
    expect(mobileSyncAccessibility(copy, false, true, true, Number.NaN).accessibilityHint).toContain(copy.pending(0));
    expect(copy.routeLoad(2, 1, 3)).toContain("2");
  });
  test.each(["OutboxScreen", "ScanScreen", "LocationScreen"])("%s consumes the computed sync state", name => {
    const screen = find(app, node => ts.isFunctionDeclaration(node) && node.name?.text === name);
    const button = find(screen, node => ts.isJsxOpeningElement(node) && node.attributes.properties.some(prop => ts.isJsxAttribute(prop) && prop.name.getText(app) === "onPress" && prop.initializer?.getText(app) === "{onSync}")) as ts.JsxOpeningElement;
    expect(button.attributes.properties.some(prop => ts.isJsxSpreadAttribute(prop) && prop.expression.getText(app) === "syncAccessibility")).toBe(true);
    const disabled = button.attributes.properties.find(prop => ts.isJsxAttribute(prop) && prop.name.getText(app) === "disabled") as ts.JsxAttribute;
    expect(evaluate((disabled.initializer as ts.JsxExpression).expression!, { syncAccessibility: mobileSyncAccessibility(getFieldOpsStrings("en").actionAccessibility, false, false, true, 4) })).toBe(true);
  });
});

test("actual location capture skips a permanently denied prompt and offers settings", async () => {
  const location = find(app, node => ts.isFunctionDeclaration(node) && node.name?.text === "LocationScreen");
  const node = find(location, node => ts.isVariableDeclaration(node) && node.name.getText(app) === "captureLocation") as ts.VariableDeclaration;
  const requestForegroundPermissionsAsync = jest.fn();
  const openSystemSettingsSafe = jest.fn();
  const alert = jest.fn();
  const captureLocationRef = { current: false };
  const setStatus = jest.fn();
  const capture = evaluate(node.initializer!, {
    captureLocationRef, status: "idle", setStatus,
    trackingPolicyQuery: { isLoading: false }, trackingPolicyUnavailable: false, trackingEnabled: true,
    Location: { getForegroundPermissionsAsync: jest.fn(async () => ({ status: "denied", canAskAgain: false })), requestForegroundPermissionsAsync },
    Alert: { alert }, openSystemSettingsSafe,
  });
  await capture();
  expect(requestForegroundPermissionsAsync).not.toHaveBeenCalled();
  expect(alert).toHaveBeenCalledTimes(1);
  alert.mock.calls[0][2][1].onPress();
  expect(openSystemSettingsSafe).toHaveBeenCalledTimes(1);
  expect(captureLocationRef.current).toBe(false);
  expect(setStatus).toHaveBeenLastCalledWith("idle");
});

function backgroundRecoveryCallback() {
  const location = find(app, node => ts.isFunctionDeclaration(node) && node.name?.text === "LocationScreen");
  const button = find(location, node => ts.isJsxOpeningElement(node) &&
    node.attributes.properties.some(prop => ts.isJsxAttribute(prop) && prop.name.getText(app) === "accessibilityLabel" &&
      prop.initializer?.getText(app) === "{strings.actionAccessibility.recoverLocation}")) as ts.JsxOpeningElement;
  const attr = button.attributes.properties.find(prop => ts.isJsxAttribute(prop) && prop.name.getText(app) === "onPress") as ts.JsxAttribute;
  return (attr.initializer as ts.JsxExpression).expression!;
}
test("actual recovery cannot restart a changed policy/device after permission read settles", async () => {
  let release!: (value: { status: string; canAskAgain: boolean }) => void;
  const permission = new Promise<{ status: string; canAskAgain: boolean }>(resolve => { release = resolve; });
  const backgroundPolicyGenerationRef = { current: 1 };
  const syncBackgroundLocationTracking = jest.fn();
  const callback = evaluate(backgroundRecoveryCallback(), {
    backgroundRecoveryRef: { current: false }, backgroundSyncing: false, backgroundPolicyEnabled: true,
    backgroundPolicyGenerationRef, setBackgroundSyncing: jest.fn(),
    backgroundTracking: { reason: "foreground_permission_denied" },
    Location: { getForegroundPermissionsAsync: () => permission },
    syncBackgroundLocationTracking, openSystemSettingsSafe: jest.fn(), setBackgroundTracking: jest.fn(),
    deviceId: "old-device", locationPolicy: { enabled: true }, logDebugFailure: jest.fn(),
  });
  callback();
  backgroundPolicyGenerationRef.current += 1;
  release({ status: "granted", canAskAgain: true });
  await new Promise(resolve => setImmediate(resolve));
  expect(syncBackgroundLocationTracking).not.toHaveBeenCalled();
});

test("background recovery uses settings when policy forbids another OS prompt", async () => {
  const openSystemSettingsSafe = jest.fn();
  const syncBackgroundLocationTracking = jest.fn();
  const callback = evaluate(backgroundRecoveryCallback(), {
    backgroundRecoveryRef: { current: false }, backgroundSyncing: false, backgroundPolicyEnabled: true,
    backgroundPolicyGenerationRef: { current: 1 }, setBackgroundSyncing: jest.fn(),
    backgroundTracking: { reason: "background_permission_denied" },
    Location: { getBackgroundPermissionsAsync: async () => ({ status: "denied", canAskAgain: true }) },
    syncBackgroundLocationTracking, openSystemSettingsSafe, setBackgroundTracking: jest.fn(),
    deviceId: "device-1", locationPolicy: { enabled: true, requestBackgroundPermission: false }, logDebugFailure: jest.fn(),
  });
  callback();
  await new Promise(resolve => setImmediate(resolve));
  expect(openSystemSettingsSafe).toHaveBeenCalledTimes(1);
  expect(syncBackgroundLocationTracking).not.toHaveBeenCalled();
});
