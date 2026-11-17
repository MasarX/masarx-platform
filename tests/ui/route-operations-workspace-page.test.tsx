jest.mock("next-intl", () => ({
  NextIntlClientProvider: ({ children }: { children: unknown }) => children,
  useTranslations:
    (namespace?: string) =>
    (key: string) =>
      namespace ? `${namespace}.${key}` : key,
  createTranslator:
    ({ namespace }: { namespace?: string } = {}) =>
    (key: string) =>
      namespace ? `${namespace}.${key}` : key,
}));

import type { ReactElement } from "react";
import { screen } from "@testing-library/react";
import { axe } from "jest-axe";
import { renderWithIntl } from "./test-utils";
import { RouteOperationsWorkspacePage } from "../../packages/ui/src/route-operations-workspace-page";
import { getVerifiedUser } from "@masarx/auth";
import { createUiServerClient } from "@masarx/api/server";

jest.mock("@masarx/auth", () => ({
  getVerifiedUser: jest.fn(),
}));

jest.mock("@masarx/api/server", () => ({
  createUiServerClient: jest.fn(),
}));

const mockedGetVerifiedUser = getVerifiedUser as jest.Mock;
const mockedCreateUiServerClient = createUiServerClient as jest.Mock;

function createAuthenticatedSession() {
  mockedGetVerifiedUser.mockResolvedValue({
    user: { id: "user-1", email: "gxhmruwnxrrgxpwtklhlhutg@example.invalid" },
    error: null,
  });
}

function createUiClientMock() {
  const commands = [
    {
      key: "routes.dispatch",
      label: "dispatch routes",
      schema_category: "resource:routes",
      capability: "routes.write",
      execution: { type: "workflow" },
    },
    {
      key: "shipments.resort",
      label: "re-sort shipment",
      schema_category: "resource:shipments",
      capability: "shipments.write",
      execution: { type: "rpc", rpc: "ui_execute_shipment_resort_v1" },
    },
    {
      key: "warehouse.scan",
      label: "warehouse scan",
      schema_category: "resource:scan_events",
      capability: "scan_events.write",
      execution: { type: "workflow" },
    },
    {
      key: "route_plans.solve_sequence",
      label: "optimize route sequence",
      schema_category: "resource:route_plans",
      capability: "route_plans.write",
      execution: { type: "rpc" },
    },
    {
      key: "route_plans.publish",
      label: "publish execution pack",
      schema_category: "resource:route_plans",
      capability: "route_plans.write",
      execution: { type: "rpc" },
    },
  ];
  return {
    context: jest.fn().mockResolvedValue({
      me: {
        user: { id: "user-1", email: "gxhmruwnxrrgxpwtklhlhutg@example.invalid", user_type: "ops_admin" },
        access_scope: {
          scope_type: "global",
          scope_id: "global",
          scope_label: "Global",
        },
      },
      navigation: {
        app: "console",
        sections: [
          {
            id: "operations",
            label: "Operations",
            items: [
              {
                id: "shipments",
                label: "Shipments",
                href: "/console/resources/shipments",
                resource: "shipments",
              },
              {
                id: "routes",
                label: "Routes",
                href: "/console/resources/routes",
                resource: "routes",
              },
              {
                id: "route-stops",
                label: "Route Stops",
                href: "/console/resources/route_stops",
                resource: "route_stops",
              },
              {
                id: "route-plans",
                label: "Route Plans",
                href: "/console/resources/route_plans",
                resource: "route_plans",
              },
              {
                id: "zones",
                label: "Zones",
                href: "/console/resources/zones",
                resource: "zones",
              },
              {
                id: "zone-districts",
                label: "Zone Districts",
                href: "/console/resources/zone_districts",
                resource: "zone_districts",
              },
              {
                id: "baskets",
                label: "Baskets",
                href: "/console/resources/baskets",
                resource: "baskets",
              },
              {
                id: "basket-items",
                label: "Basket Items",
                href: "/console/resources/basket_items",
                resource: "basket_items",
              },
              {
                id: "basket-transitions",
                label: "Basket Transitions",
                href: "/console/resources/basket_transitions",
                resource: "basket_transitions",
              },
              {
                id: "warehouse-transfers",
                label: "Warehouse Transfers",
                href: "/console/resources/warehouse_transfers",
                resource: "warehouse_transfers",
              },
              {
                id: "handling-units",
                label: "Handling Units",
                href: "/console/resources/handling_units",
                resource: "handling_units",
              },
              {
                id: "scan-events",
                label: "Scan Events",
                href: "/console/resources/scan_events",
                resource: "scan_events",
              },
            ],
          },
        ],
      },
    }),
    readRegistry: jest.fn().mockResolvedValue({
      resources: [
        { key: "shipments", label: "Shipments", capability_read: "shipments.read" },
        { key: "routes", label: "Routes", capability_read: "routes.read" },
        { key: "route_stops", label: "Route Stops", capability_read: "routes.read" },
        { key: "route_plans", label: "Route Plans", capability_read: "route_plans.read" },
        { key: "zones", label: "Zones", capability_read: "zones.read" },
        {
          key: "zone_districts",
          label: "Zone Districts",
          capability_read: "zone_districts.read",
        },
        { key: "baskets", label: "Baskets", capability_read: "baskets.read" },
        {
          key: "basket_items",
          label: "Basket Items",
          capability_read: "basket_items.read",
        },
        {
          key: "basket_transitions",
          label: "Basket Transitions",
          capability_read: "basket_transitions.read",
        },
        {
          key: "warehouse_transfers",
          label: "Warehouse Transfers",
          capability_read: "warehouse_transfers.read",
        },
        { key: "handling_units", label: "Handling Units", capability_read: "handling_units.read" },
        { key: "scan_events", label: "Scan Events", capability_read: "scan_events.read" },
      ],
    }),
    commandRegistry: jest.fn().mockResolvedValue({
      commands,
    }),
    dashboardMetrics: jest.fn().mockResolvedValue({
      metrics: [
        { resource: "shipments", total: 12 },
        { resource: "routes", total: 5 },
        { resource: "route_stops", total: 14 },
        { resource: "route_plans", total: 4 },
        { resource: "zones", total: 14 },
        { resource: "zone_districts", total: 28 },
        { resource: "baskets", total: 9 },
        { resource: "basket_items", total: 38 },
        { resource: "basket_transitions", total: 17 },
        { resource: "warehouse_transfers", total: 3 },
        { resource: "handling_units", total: 7 },
        { resource: "scan_events", total: 19 },
      ],
    }),
    listResource: jest.fn().mockResolvedValue({
      resource: "shipments",
      items: [],
      limit: 1,
      offset: 0,
      total: 0,
    }),
  };
}

describe("RouteOperationsWorkspacePage", () => {
  beforeEach(() => {
    jest.resetAllMocks();
  });

  it("returns null when there is no authenticated session", async () => {
    mockedGetVerifiedUser.mockResolvedValue({
      user: null,
      error: new Error("authenticated_user_required"),
    });

    const node = await RouteOperationsWorkspacePage({
      appBasePath: "/console",
      appKey: "console",
      testIdPrefix: "console-route-operations",
    });

    expect(node).toBeNull();
    expect(mockedCreateUiServerClient).not.toHaveBeenCalled();
  });

  it("renders route operation lanes when context is available", async () => {
    createAuthenticatedSession();
    const uiClient = createUiClientMock();
    mockedCreateUiServerClient.mockReturnValue(uiClient);

    const node = await RouteOperationsWorkspacePage({
      appBasePath: "/console",
      appKey: "console",
      testIdPrefix: "console-route-operations",
    });

    const { container } = renderWithIntl(node as ReactElement);

    expect(screen.getByText("ui.routeOperations.title")).toBeInTheDocument();
    expect(screen.getAllByText("Shipments").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Routes").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Route Stops").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Route Plans").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Zones").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Zone Districts").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Baskets").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Basket Items").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Basket Transitions").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Warehouse Transfers").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Handling Units").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Scan Events").length).toBeGreaterThan(0);
    expect(screen.getByText("ui.routeOperations.monitor.title")).toBeInTheDocument();
    expect(screen.getByText("ui.routeOperations.constraints.title")).toBeInTheDocument();
    expect(screen.getByText("ui.routeOperations.experience.title")).toBeInTheDocument();
    expect(screen.getByText("ui.routeOperations.board.title")).toBeInTheDocument();
    expect(
      screen.getByTestId("console-route-operations-dispatch-board")
    ).toBeInTheDocument();
    expect(
      screen.getByTestId("console-route-operations-constraint-matrix")
    ).toBeInTheDocument();
    expect(
      screen.getByTestId("console-route-operations-pod-customer-matrix")
    ).toBeInTheDocument();
    expect(screen.getAllByText("ui.routeOperations.lanes.openLaneCommands").length).toBeGreaterThan(0);
    const mapLaneLink = screen
      .getByText("ui.routeOperations.monitor.mapLane")
      .closest("a");
    expect(mapLaneLink).toHaveAttribute("href", "/console/operations/routes/route_plans");
    const zonesLaneLink = screen.getAllByText("ui.routeOperations.lanes.openLane").find((label) => {
      return label.closest("div")?.parentElement?.textContent?.includes("Zone Districts");
    })?.closest("a");
    expect(zonesLaneLink).toHaveAttribute("href", "/console/operations/routes/zone_districts");
    const shipmentCommandsLink = screen
      .getAllByText("ui.routeOperations.lanes.openLaneCommands")
      .find((label) => label.closest("div")?.parentElement?.textContent?.includes("Shipments"))
      ?.closest("a");
    expect(shipmentCommandsLink).toHaveAttribute(
      "href",
      "/console/commands?category=resource%3Ashipments&access=allowed"
    );
    const settingsRequestsLink = screen
      .getByText("ui.routeOperations.constraints.openSettingsRequests")
      .closest("a");
    expect(settingsRequestsLink).toHaveAttribute("href", "/console/settings/request");
    const trackingWorkspaceLink = screen
      .getByText("ui.routeOperations.experience.openTracking")
      .closest("a");
    expect(trackingWorkspaceLink).toBeNull();
    expect(screen.getByText("ui.routeOperations.selected.emptyTitle")).toBeInTheDocument();
    expect(uiClient.dashboardMetrics).toHaveBeenCalledWith(
      expect.arrayContaining([
        "shipments",
        "routes",
        "route_stops",
        "route_plans",
        "zones",
        "zone_districts",
        "baskets",
        "basket_items",
        "basket_transitions",
        "warehouse_transfers",
        "handling_units",
        "scan_events",
      ])
    );
    const results = await axe(container);
    expect(results).toHaveNoViolations();
  });

  it("shows invalid-lane notice when requested lane is not in workspace", async () => {
    createAuthenticatedSession();
    mockedCreateUiServerClient.mockReturnValue(createUiClientMock());

    const node = await RouteOperationsWorkspacePage({
      appBasePath: "/console",
      appKey: "console",
      resourceKey: "missing_lane",
      testIdPrefix: "console-route-operations",
    });

    renderWithIntl(node as ReactElement);

    expect(
      screen.getByText("ui.routeOperations.selected.invalidTitle")
    ).toBeInTheDocument();
    expect(
      screen.getByText("ui.routeOperations.selected.invalidDetail")
    ).toBeInTheDocument();
  });

  it("uses the portal base path for route lane navigation and command catalog links", async () => {
    createAuthenticatedSession();
    const uiClient = createUiClientMock();
    mockedCreateUiServerClient.mockReturnValue(uiClient);

    const node = await RouteOperationsWorkspacePage({
      appBasePath: "/portal",
      appKey: "portal",
      testIdPrefix: "portal-route-operations",
    });

    renderWithIntl(node as ReactElement);

    const mapLaneLink = screen
      .getByText("ui.routeOperations.monitor.mapLane")
      .closest("a");
    expect(mapLaneLink).toHaveAttribute("href", "/portal/operations/routes/route_plans");

    const routeLaneLink = screen
      .getAllByText("ui.routeOperations.lanes.openLane")
      .find((label) => label.closest("div")?.parentElement?.textContent?.includes("Routes"))
      ?.closest("a");
    expect(routeLaneLink).toHaveAttribute("href", "/portal/operations/routes/routes");

    const routeCommandsLink = screen
      .getAllByText("ui.routeOperations.lanes.openLaneCommands")
      .find((label) => label.closest("div")?.parentElement?.textContent?.includes("Routes"))
      ?.closest("a");
    expect(routeCommandsLink).toHaveAttribute(
      "href",
      "/portal/commands?category=resource%3Aroutes&access=allowed"
    );
  });

  it.each([
    { label: "prefixed Portal", base: "/portal", href: "/portal/tracking", expected: "/portal/tracking" },
    { label: "root Portal", base: "", href: "/portal/tracking", expected: "/tracking" },
    { label: "slash-root Portal", base: "/", href: "/tracking", expected: "/tracking" },
    { label: "root entry on prefixed Portal", base: "/portal", href: "/tracking?tracking_number=ABC%2F123#results", expected: "/portal/tracking?tracking_number=ABC%2F123#results" },
  ])("uses the registered tracking destination for $label", async ({ base, href, expected }) => {
    createAuthenticatedSession();
    const uiClient = createUiClientMock();
    const context = await uiClient.context();
    context.navigation.app = "portal";
    context.navigation.sections.push({
      id: "tracking", label: "Tracking", items: [{
        id: "group", label: "Group", disabled_reason: "group_route_unavailable",
        items: [{ id: "portal-tracking", label: "Tracking", href }],
      }],
    });
    mockedCreateUiServerClient.mockReturnValue(uiClient);
    const node = await RouteOperationsWorkspacePage({ appKey: "portal", appBasePath: base });
    renderWithIntl(node as ReactElement);
    expect(screen.getByText("ui.routeOperations.experience.openTracking").closest("a"))
      .toHaveAttribute("href", expected);
  });

  it.each([
    { label: "missing registration", entry: null },
    { label: "missing href", entry: { id: "portal-tracking" } },
    { label: "disabled tracking item", entry: { id: "portal-tracking", href: "/portal/tracking", disabled_reason: "missing_capability" } },
    { label: "other app identity", entry: { id: "console-tracking", href: "/portal/tracking" } },
    ...[
      "", "   ", "javascript:alert(1)", "https://evil.invalid/tracking",
      "//evil.invalid/tracking", "/console/tracking", "/portal/tracking-map",
      "/portal/../tracking", "/portal/%2e%2e/tracking", "/portal\\tracking",
      "/portal/tracking\n", "/portal/tracking?x=\u0001",
    ].map(href => ({ label: `unsafe or unsupported href ${JSON.stringify(href)}`, entry: { id: "portal-tracking", href } })),
  ])("keeps tracking non-clickable for $label", async ({ entry }) => {
    createAuthenticatedSession();
    const uiClient = createUiClientMock();
    const context = await uiClient.context();
    context.navigation.app = "portal";
    context.navigation.sections.push({
      id: "tracking", label: "Tracking",
      items: entry ? [{ label: "Tracking", ...entry }] : [],
    });
    mockedCreateUiServerClient.mockReturnValue(uiClient);
    const node = await RouteOperationsWorkspacePage({ appKey: "portal", appBasePath: "" });
    renderWithIntl(node as ReactElement);
    expect(screen.getByText("ui.routeOperations.experience.openTracking").closest("a")).toBeNull();
  });

  it("does not select an enabled duplicate over a disabled tracking registration", async () => {
    createAuthenticatedSession();
    const uiClient = createUiClientMock();
    const context = await uiClient.context();
    context.navigation.app = "portal";
    context.navigation.sections.push({
      id: "tracking", label: "Tracking", items: [
        { id: "portal-tracking", label: "Tracking", href: "/portal/tracking" },
        { id: "portal-tracking", label: "Tracking", href: "/portal/tracking", disabled_reason: "missing_capability" },
      ],
    });
    mockedCreateUiServerClient.mockReturnValue(uiClient);
    const node = await RouteOperationsWorkspacePage({ appKey: "portal", appBasePath: "" });
    renderWithIntl(node as ReactElement);
    expect(screen.getByText("ui.routeOperations.experience.openTracking").closest("a")).toBeNull();
  });

  it("renders fallback non-link actions when appBasePath is unsafe", async () => {
    createAuthenticatedSession();
    const uiClient = createUiClientMock();
    mockedCreateUiServerClient.mockReturnValue(uiClient);

    const node = await RouteOperationsWorkspacePage({
      appBasePath: "javascript:alert(1)",
      appKey: "console",
      testIdPrefix: "console-route-operations",
    });

    renderWithIntl(node as ReactElement);

    const unsafeActionLabels = [
      ...screen.queryAllByText("ui.routeOperations.monitor.commandCatalog"),
      ...screen.queryAllByText("ui.routeOperations.constraints.openSettingsRequests"),
      ...screen.queryAllByText("ui.routeOperations.constraints.commandCatalog"),
      ...screen.queryAllByText("ui.routeOperations.experience.openTracking"),
      ...screen.queryAllByText("ui.routeOperations.experience.commandCatalog"),
      ...screen.queryAllByText("ui.routeOperations.triage.commandCatalog"),
    ];

    expect(unsafeActionLabels.length).toBeGreaterThan(0);
    unsafeActionLabels.forEach((label) => {
      expect(label.closest("a")).toBeNull();
    });

    const laneActions = screen.getAllByText("ui.routeOperations.lanes.openLane");
    expect(laneActions.length).toBeGreaterThan(0);
    laneActions.forEach((label) => {
      expect(label.closest("a")).toBeNull();
    });
  });
});
