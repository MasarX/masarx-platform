// #600 slice 4: Today, route currency and density, checklist defaults,
// device state, the incident type picker and the side menu header show
// loading, valid-empty or error in live mode, never fixture data. The
// showcase (no Supabase client) still renders the fixtures.

import * as React from "react";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  fieldopsSurfaceQuery,
  isMobileV2ListLoading,
  projectMobileV2TodaySummary,
  readFieldopsTaskList,
  type MobileV2RouteEnvelope,
} from "../../../apps/fieldops/src/mobile-v2-rpc-hooks";
import {
  deriveMobileV2TaskCodCurrency,
  parseMobileV2Task,
} from "../../../apps/fieldops/src/mobile-v2-tasks-types";
import { MOBILE_V2_UNKNOWN_CONNECTIVITY } from "../../../apps/fieldops/src/mobile-v2-connectivity";
import { resolveMobileV2GatedTabAccess } from "../../../apps/fieldops/src/mobile-v2-navigation";
import type { MobileV2RouteStop } from "../../../apps/fieldops/src/mobile-v2-route-screen";
import { MOBILE_V2_THEMES } from "../../../apps/fieldops/src/mobile-v2-themes";
import { EN_STRINGS } from "../../../apps/fieldops/src/i18n/strings-en";
import { AR_STRINGS } from "../../../apps/fieldops/src/i18n/strings-ar";
import {
  MOBILE_V2_PREVIEW_INCIDENT_TYPES,
  MOBILE_V2_PREVIEW_ROUTE,
  MOBILE_V2_PREVIEW_TODAY,
} from "../../../apps/fieldops/src/fixtures";

const SRC = resolve(__dirname, "../../../apps/fieldops/src");
const THEME = MOBILE_V2_THEMES.hivis;
const LIVE = EN_STRINGS.liveReads;
// Any non-null client means live mode; the reads below never touch it.
const LIVE_CLIENT = {} as unknown as NonNullable<Parameters<typeof fieldopsSurfaceQuery>[0]>;

function createReactNativeMock() {
  const ReactRuntime = require("react") as typeof React;
  const native = (name: string) =>
    function MockNativeComponent(props: { readonly children?: React.ReactNode }) {
      return ReactRuntime.createElement(name, props, props.children);
    };

  return {
    ActivityIndicator: native("ActivityIndicator"),
    Animated: { View: native("AnimatedView"), Value: class {}, timing: () => ({ start: () => undefined }) },
    BackHandler: { addEventListener: () => ({ remove: () => undefined }) },
    Easing: { out: () => 0, cubic: 0 },
    Platform: { OS: "ios", select: (options: { readonly ios?: unknown; readonly default?: unknown }) => options.ios ?? options.default },
    Pressable: native("Pressable"),
    ScrollView: native("ScrollView"),
    StyleSheet: {
      create: <T>(styles: T): T => styles,
      hairlineWidth: 1,
    },
    Text: native("Text"),
    TextInput: native("TextInput"),
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

function mockNativeModules(): void {
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

interface ShallowElement {
  readonly type: unknown;
  readonly props: { readonly children?: React.ReactNode } & Record<string, unknown>;
}

function isElement(node: unknown): node is ShallowElement {
  return node !== null && typeof node === "object" && "props" in node && "type" in node;
}

// Shallow walk: function components are not rendered, only their props and children.
function collectElements(node: React.ReactNode): ShallowElement[] {
  if (Array.isArray(node)) return node.flatMap(collectElements);
  if (!isElement(node)) return [];
  return [node, ...collectElements(node.props.children)];
}

function collectText(node: React.ReactNode): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(collectText).join("");
  if (isElement(node)) return `${collectText(node.props.children)}|`;
  return "";
}

function elementsNamed(tree: React.ReactNode, name: string): ShallowElement[] {
  return collectElements(tree).filter((el) => typeof el.type === "function" && el.type.name === name);
}

function routeStop(overrides: Partial<MobileV2RouteStop> & Pick<MobileV2RouteStop, "id" | "seq" | "status">): MobileV2RouteStop {
  return {
    customer: `Test Recipient ${overrides.seq}`,
    address: `Test Address ${overrides.seq}`,
    sla: "—",
    cod: 0,
    fragile: false,
    attempts: 0,
    ...overrides,
  };
}

const LIVE_ROWS: ReadonlyArray<MobileV2RouteStop> = [
  routeStop({ id: "stop:00000000-0000-4000-8000-000000000001", seq: 1, status: "done", cod: 90 }),
  routeStop({ id: "stop:00000000-0000-4000-8000-000000000002", seq: 2, status: "failed" }),
  routeStop({ id: "stop:00000000-0000-4000-8000-000000000003", seq: 3, status: "current", sla: "11:30", cod: 120, fragile: true }),
  routeStop({ id: "stop:00000000-0000-4000-8000-000000000004", seq: 4, status: "sla", sla: "12:10", cod: 30 }),
];

const RAW_TASK = {
  task_id: "stop:00000000-0000-4000-8000-000000000003",
  type: "delivery",
  title: "TEST-0001",
  sub: null,
  urgency: "now",
  cta: "Start",
  route: "/mobile/stop/00000000-0000-4000-8000-000000000003",
  eta_iso: null,
  priority: 50,
  area: null,
  code: "TEST-0001",
  action: "delivery",
  tone: "neutral",
  meta: {},
};

describe("FieldOps Today live read (#600 slice 4)", () => {
  test("the live projection counts the route rows and uses no fixture value", () => {
    const today = projectMobileV2TodaySummary(LIVE_ROWS, "AED");
    expect(today).toMatchObject({
      done: 1,
      failed: 1,
      total: 4,
      pending: 2,
      slaRisk: 1,
      etaFinish: "12:10",
      distanceKm: null,
      codExpected: 150,
      codCurrency: "AED",
    });
    expect(today.activeStop).toEqual({
      id: "stop:00000000-0000-4000-8000-000000000003",
      seq: 3,
      customer: "Test Recipient 3",
      address: "Test Address 3",
      sla: "11:30",
      cod: 120,
      fragile: true,
    });
    expect(today.activeStop?.parcels).toBeUndefined();
  });

  test("a valid empty route is a real empty day: zeros, no active stop, no ETA", () => {
    expect(projectMobileV2TodaySummary([], "SAR")).toEqual({
      done: 0,
      total: 0,
      pending: 0,
      failed: 0,
      slaRisk: 0,
      etaFinish: "",
      distanceKm: null,
      codExpected: 0,
      codCurrency: "SAR",
      activeStop: null,
    });
  });

  test("live loading: the route read seeds no fixture, so Today shows the loading state", () => {
    const query = fieldopsSurfaceQuery<MobileV2RouteEnvelope>(LIVE_CLIENT, routeFixture(), async () => routeFixture());
    expect(query.initialData).toBeUndefined();
    expect(isMobileV2ListLoading({ isLoading: true, data: query.initialData })).toBe(true);
  });

  test("live failed read: the route query rejects, so Today shows the error with a retry", async () => {
    const query = fieldopsSurfaceQuery<MobileV2RouteEnvelope>(LIVE_CLIENT, routeFixture(), async () => {
      throw new Error("mobile_v2_rpc:failed");
    });
    await expect(query.queryFn()).rejects.toThrow("mobile_v2_rpc:failed");
  });

  test.each([["not a list", "bad"], ["only invalid rows", [{ junk: true }]]])(
    "live malformed task payload (%s) rejects, never an empty or fixture route",
    async (_label, raw) => {
      const query = fieldopsSurfaceQuery<MobileV2RouteEnvelope>(LIVE_CLIENT, routeFixture(), async () => {
        readFieldopsTaskList(raw);
        return routeFixture();
      });
      await expect(query.queryFn()).rejects.toThrow(/resolve_fieldops_tasks_v1 malformed payload/);
    },
  );

  test("an empty task list is a valid empty day", () => {
    expect(readFieldopsTaskList([])).toEqual([]);
    expect(readFieldopsTaskList([RAW_TASK])).toHaveLength(1);
  });

  test("showcase: Today renders the fixture without a live read", async () => {
    const readLive = jest.fn(async () => routeFixture());
    const fixture = routeFixture();
    const query = fieldopsSurfaceQuery<MobileV2RouteEnvelope>(null, fixture, readLive);
    await expect(query.queryFn()).resolves.toBe(fixture);
    expect(query.initialData?.today).toBe(MOBILE_V2_PREVIEW_TODAY);
    expect(readLive).not.toHaveBeenCalled();
  });

  test("the route read goes through fieldopsSurfaceQuery and its strict task reader", () => {
    const hooks = readFileSync(resolve(SRC, "mobile-v2-rpc-hooks.ts"), "utf8");
    const start = hooks.indexOf("export function useFieldopsRouteRpc(");
    const body = hooks.slice(start, hooks.indexOf("\nexport ", start + 1));
    expect(start).toBeGreaterThan(-1);
    expect(body).toMatch(/\.\.\.fieldopsSurfaceQuery<MobileV2RouteEnvelope>\(ctx\.supabase, fallback,/);
    expect(body).toContain("readFieldopsTaskList(raw)");
    expect(body).toContain("today: projectMobileV2TodaySummary(rows, currency)");
  });

  test("the Today tab renders the route read, never the Today fixture fields", () => {
    const preview = readFileSync(resolve(SRC, "mobile-v2-preview-screen.tsx"), "utf8");
    expect(preview).toContain("{...routeRpc.data.today}");
    expect(preview).toContain("blockers={isShowcase ? MOBILE_V2_PREVIEW_TODAY.blockers : liveTodayBlockers}");
    expect(preview).not.toMatch(/MOBILE_V2_PREVIEW_TODAY\.(done|total|pending|failed|slaRisk|etaFinish|distanceKm|codExpected|codCurrency|activeStop)/);
  });
});

function routeFixture(): MobileV2RouteEnvelope {
  return {
    rows: MOBILE_V2_PREVIEW_ROUTE.rows,
    totalStops: MOBILE_V2_PREVIEW_ROUTE.totalStops,
    routeId: null,
    routeRunId: null,
    manifestSummary: null,
    currency: MOBILE_V2_PREVIEW_ROUTE.currency,
    today: MOBILE_V2_PREVIEW_TODAY,
  };
}

describe("FieldOps route currency, density and showcase-only defaults (#600 slice 4)", () => {
  const preview = readFileSync(resolve(SRC, "mobile-v2-preview-screen.tsx"), "utf8");

  test("route currency comes from the live task, else the app default SAR", () => {
    const task = parseMobileV2Task(RAW_TASK);
    const aed = parseMobileV2Task({ ...RAW_TASK, meta: { cod_currency: "AED" } });
    expect(task).not.toBeNull();
    expect(aed).not.toBeNull();
    expect(deriveMobileV2TaskCodCurrency(task!)).toBe("SAR");
    expect(deriveMobileV2TaskCodCurrency(aed!)).toBe("AED");
    expect(preview).not.toContain("currency={MOBILE_V2_PREVIEW_ROUTE.currency}");
    expect(preview.split("currency={routeRpc.data?.currency}")).toHaveLength(3);
  });

  test("live density starts from the driver's display preference", () => {
    expect(preview).toContain("React.useState(isShowcase ? MOBILE_V2_PREVIEW_ROUTE.density : ctx.density)");
  });

  test("live checklists start unanswered", () => {
    expect(preview).toContain("(isShowcase ? MOBILE_V2_PREVIEW_CLEANING.checkedIds : [])");
    expect(preview).toContain("isShowcase ? MOBILE_V2_PREVIEW_PRE_SHIFT.healthOk : false");
    expect(preview).toContain("(isShowcase ? MOBILE_V2_PREVIEW_CLEANING.photoStamp : undefined)");
  });

  test("live device state with no shell input is unknown, fail-closed offline", () => {
    expect(MOBILE_V2_UNKNOWN_CONNECTIVITY).toEqual({ online: false, queueCount: 0, syncing: false });
    expect(preview).toContain("(isShowcase ? MOBILE_V2_PREVIEW_CONNECTIVITY : MOBILE_V2_UNKNOWN_CONNECTIVITY)");
    expect(preview).toContain("(isShowcase ? MOBILE_V2_PREVIEW_MORE_OUTBOX : EMPTY_MOBILE_V2_OUTBOX)");
    expect(preview).toContain("(isShowcase ? MOBILE_V2_PREVIEW_SYNC_QUEUE.queue : EMPTY_MOBILE_V2_SYNC_QUEUE)");
    expect(preview).toContain("(isShowcase ? MOBILE_V2_PREVIEW_SYNC_QUEUE.lastSyncMs : null)");
  });

  test("new strings exist in English and Arabic", () => {
    for (const key of ["incidentTypesEmpty", "todayLoadFailed", "deviceStateUnknown"] as const) {
      expect(EN_STRINGS.liveReads[key].length).toBeGreaterThan(0);
      expect(AR_STRINGS.liveReads[key]).not.toBe(EN_STRINGS.liveReads[key]);
    }
  });
});

describe("FieldOps read-state renders (#600 slice 4)", () => {
  beforeEach(() => {
    jest.resetModules();
    mockNativeModules();
  });

  test("Today: the live projection shows dashes and live values, never fixture values", () => {
    const { MobileV2TodayScreen } =
      require("../../../apps/fieldops/src/mobile-v2-today-screen") as typeof import("../../../apps/fieldops/src/mobile-v2-today-screen");
    const text = collectText(MobileV2TodayScreen({ theme: THEME, blockers: [], ...projectMobileV2TodaySummary(LIVE_ROWS, "SAR") }));
    expect(text).toContain("Test Recipient 3");
    expect(text).toContain("—");
    expect(text).not.toContain(MOBILE_V2_PREVIEW_TODAY.etaFinish);
    expect(text).not.toContain(`${MOBILE_V2_PREVIEW_TODAY.distanceKm} km`);
    expect(text).not.toContain(MOBILE_V2_PREVIEW_TODAY.activeStop!.customer);
    expect(text).not.toContain("× parcel");
  });

  test("Today: the showcase still renders the fixture", () => {
    const { MobileV2TodayScreen } =
      require("../../../apps/fieldops/src/mobile-v2-today-screen") as typeof import("../../../apps/fieldops/src/mobile-v2-today-screen");
    const text = collectText(MobileV2TodayScreen({ theme: THEME, ...MOBILE_V2_PREVIEW_TODAY }));
    expect(text).toContain(MOBILE_V2_PREVIEW_TODAY.etaFinish);
    expect(text).toContain(`${MOBILE_V2_PREVIEW_TODAY.distanceKm} km`);
    expect(text).toContain(MOBILE_V2_PREVIEW_TODAY.activeStop!.customer);
  });

  test.each([
    ["loading", true, false, "Loading…"],
    ["failed", false, true, LIVE.todayLoadFailed],
  ])("Today list state: %s", (_label, isLoading, isError, expected) => {
    const { MobileV2ListStateView } =
      require("../../../apps/fieldops/src/mobile-v2-list-state-view") as typeof import("../../../apps/fieldops/src/mobile-v2-list-state-view");
    const onRetry = jest.fn();
    const tree = MobileV2ListStateView({
      theme: THEME,
      isLoading,
      isError,
      errorMessage: LIVE.todayLoadFailed,
      retryLabel: LIVE.retry,
      onRetry,
      children: "fixture-child",
    });
    const text = collectText(tree);
    expect(text).toContain(expected);
    expect(text).not.toContain("fixture-child");
    const retry = elementsNamed(tree, "FxButton");
    expect(retry.length).toBe(isError ? 1 : 0);
    if (isError) expect(retry[0].props.onPress).toBe(onRetry);
  });

  describe("profile card and side menu header", () => {
    const baseProps = {
      theme: THEME,
      activeThemeKey: "hivis" as const,
      availableThemeKeys: ["hivis" as const],
      onSelectTheme: () => undefined,
      activeRole: "driver",
      availableRoles: ["driver"],
      onSelectRole: () => undefined,
      capabilities: [],
      online: true,
      outbox: [],
      userName: "Test Driver",
      userBadge: "T-0001",
    };

    test("loading shows the loading label, not an identity", () => {
      const { MobileV2MoreScreen, resolveMobileV2DrawerIdentity } =
        require("../../../apps/fieldops/src/mobile-v2-more-screen") as typeof import("../../../apps/fieldops/src/mobile-v2-more-screen");
      const state = { kind: "loading" as const, label: "Loading profile" };
      const text = collectText(MobileV2MoreScreen({ ...baseProps, identityState: state }));
      expect(text).toContain("Loading profile");
      expect(text).not.toContain("T-0001");
      expect(resolveMobileV2DrawerIdentity("Test Driver", "T-0001", state)).toEqual({ name: "Loading profile" });
    });

    test("failed shows the error with a retry", () => {
      const { MobileV2MoreScreen, resolveMobileV2DrawerIdentity } =
        require("../../../apps/fieldops/src/mobile-v2-more-screen") as typeof import("../../../apps/fieldops/src/mobile-v2-more-screen");
      const onRetry = jest.fn();
      const state = { kind: "error" as const, message: "Unable to load profile", retryLabel: LIVE.retry, onRetry };
      const tree = MobileV2MoreScreen({ ...baseProps, identityState: state });
      expect(collectText(tree)).toContain("Unable to load profile");
      expect(elementsNamed(tree, "FxButton").some((b) => b.props.onPress === onRetry)).toBe(true);
      expect(resolveMobileV2DrawerIdentity("Test Driver", "T-0001", state)).toEqual({ name: "Unable to load profile" });
    });

    test("a loaded profile shows the identity", () => {
      const { MobileV2MoreScreen, resolveMobileV2DrawerIdentity } =
        require("../../../apps/fieldops/src/mobile-v2-more-screen") as typeof import("../../../apps/fieldops/src/mobile-v2-more-screen");
      const text = collectText(MobileV2MoreScreen(baseProps));
      expect(text).toContain("Test Driver");
      expect(text).toContain("Sync · Online");
      expect(resolveMobileV2DrawerIdentity("Test Driver", "T-0001", undefined)).toEqual({ name: "Test Driver", employeeId: "T-0001" });
    });

    test("unknown device state replaces sync and outbox values", () => {
      const { MobileV2MoreScreen } =
        require("../../../apps/fieldops/src/mobile-v2-more-screen") as typeof import("../../../apps/fieldops/src/mobile-v2-more-screen");
      const tree = MobileV2MoreScreen({ ...baseProps, online: false, deviceStateUnknownLabel: LIVE.deviceStateUnknown });
      const text = collectText(tree);
      expect(text).toContain(`Sync · ${LIVE.deviceStateUnknown}`);
      expect(text).toContain(`Outbox · ${LIVE.deviceStateUnknown}`);
      expect(text).not.toContain("Offline");
      expect(elementsNamed(tree, "FxStatusDot")[0].props.kind).toBe("pending");
    });
  });

  describe("incident type picker", () => {
    const sheetProps = {
      theme: THEME,
      visible: true,
      onClose: () => undefined,
      selectedTypeId: null,
      photoCaptured: false,
      statement: "",
      onSelectType: () => undefined,
      onTogglePhoto: () => undefined,
      onStatementChange: () => undefined,
      onSubmit: () => undefined,
    };
    const stateInput = {
      isLoading: false,
      isError: false,
      count: undefined as number | undefined,
      errorMessage: LIVE.incidentTypesLoadFailed,
      emptyMessage: LIVE.incidentTypesEmpty,
      retryLabel: LIVE.retry,
      onRetry: () => undefined,
    };

    function renderPicker(typesState: object | undefined, types = MOBILE_V2_PREVIEW_INCIDENT_TYPES) {
      const { MobileV2IncidentSheet } =
        require("../../../apps/fieldops/src/mobile-v2-sheet-incident") as typeof import("../../../apps/fieldops/src/mobile-v2-sheet-incident");
      const tree = MobileV2IncidentSheet({ ...sheetProps, types, typesState: typesState as never });
      return elementsNamed(tree, "MobileV2ListStateView")[0];
    }

    function resolveState(input: Partial<typeof stateInput>) {
      const { resolveMobileV2IncidentTypesState } =
        require("../../../apps/fieldops/src/mobile-v2-sheet-incident") as typeof import("../../../apps/fieldops/src/mobile-v2-sheet-incident");
      return resolveMobileV2IncidentTypesState({ ...stateInput, ...input });
    }

    test("loading shows the loading state", () => {
      const view = renderPicker(resolveState({ isLoading: true }), []);
      expect(view.props).toMatchObject({ isLoading: true, isError: false });
    });

    test("a failed read shows the error with a retry", () => {
      const view = renderPicker(resolveState({ isError: true }), []);
      expect(view.props).toMatchObject({ isError: true, errorMessage: LIVE.incidentTypesLoadFailed, retryLabel: LIVE.retry });
      expect(typeof view.props.onRetry).toBe("function");
    });

    test("a valid empty type list is an error with a retry", () => {
      const view = renderPicker(resolveState({ count: 0 }), []);
      expect(view.props).toMatchObject({ isError: true, errorMessage: LIVE.incidentTypesEmpty, retryLabel: LIVE.retry });
    });

    test("loaded types render the list", () => {
      const state = resolveState({ count: MOBILE_V2_PREVIEW_INCIDENT_TYPES.length });
      expect(state).toMatchObject({ isLoading: false, isError: false });
    });

    test("showcase renders the fixture types", () => {
      const view = renderPicker(undefined);
      expect(view.props).toMatchObject({ isLoading: false, isError: false });
      expect(collectText(view.props.children)).toContain(MOBILE_V2_PREVIEW_INCIDENT_TYPES[0].label);
    });
  });

  describe("pending gated tab", () => {
    const unsettled = { navigationSettled: false, cashDropAccessEnabled: false, walletAccessEnabled: false };

    test("a gated tab is pending until navigation settles, then denied", () => {
      expect(resolveMobileV2GatedTabAccess("mobile-wallet", unsettled)).toBe("pending");
      expect(resolveMobileV2GatedTabAccess("mobile-cash-drop", unsettled)).toBe("pending");
      expect(resolveMobileV2GatedTabAccess("mobile-wallet", { ...unsettled, navigationSettled: true })).toBe("denied");
      expect(resolveMobileV2GatedTabAccess("mobile-today", unsettled)).toBe("allowed");
    });

    test.each([
      ["loading", false, "Loading…"],
      ["failed", true, LIVE.accessLoadFailed],
    ])("pending %s renders its state, never the tab", (_label, isError, expected) => {
      const { MobileV2ListStateView } =
        require("../../../apps/fieldops/src/mobile-v2-list-state-view") as typeof import("../../../apps/fieldops/src/mobile-v2-list-state-view");
      const tree = MobileV2ListStateView({
        theme: THEME,
        isLoading: !isError,
        isError,
        errorMessage: LIVE.accessLoadFailed,
        retryLabel: LIVE.retry,
        onRetry: () => undefined,
        children: null,
      });
      expect(collectText(tree)).toContain(expected);
      expect(elementsNamed(tree, "FxButton").length).toBe(isError ? 1 : 0);
    });
  });
});
