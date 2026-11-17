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
                id: "warehouse-transfers",
                label: "Warehouse Transfers",
                href: "/console/resources/warehouse_transfers",
                resource: "warehouse_transfers",
              },
              {
                id: "warehouse-transfer-items",
                label: "Warehouse Transfer Items",
                href: "/console/resources/warehouse_transfer_items",
                resource: "warehouse_transfer_items",
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
        {
          key: "warehouse_transfers",
          label: "Warehouse Transfers",
          capability_read: "warehouse_transfers.read",
        },
        {
          key: "warehouse_transfer_items",
          label: "Warehouse Transfer Items",
          capability_read: "warehouse_transfers.read",
        },
        { key: "handling_units", label: "Handling Units", capability_read: "handling_units.read" },
        { key: "scan_events", label: "Scan Events", capability_read: "scan_events.read" },
      ],
    }),
    commandRegistry: jest.fn().mockResolvedValue({
      commands: [
        {
          key: "warehouse.scan",
          label: "warehouse scan",
          schema_category: "resource:scan_events",
          capability: "scan_events.write",
          execution: { type: "workflow" },
        },
      ],
    }),
    dashboardMetrics: jest.fn().mockResolvedValue({
      metrics: [
        { resource: "shipments", total: 12 },
        { resource: "routes", total: 5 },
        { resource: "warehouse_transfers", total: 3 },
        { resource: "warehouse_transfer_items", total: 9 },
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

describe("RouteOperationsWorkspacePage transfer visibility", () => {
  beforeEach(() => {
    jest.resetAllMocks();
  });

  it("renders warehouse transfer manifest resources when navigation and registry expose them", async () => {
    createAuthenticatedSession();
    const uiClient = createUiClientMock();
    mockedCreateUiServerClient.mockReturnValue(uiClient);

    const node = await RouteOperationsWorkspacePage({
      appBasePath: "/console",
      appKey: "console",
      testIdPrefix: "console-route-operations-transfer-visibility",
    });

    const { container } = renderWithIntl(node as ReactElement);

    expect(screen.getAllByText("Warehouse Transfers").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Warehouse Transfer Items").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Handling Units").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Scan Events").length).toBeGreaterThan(0);
    expect(uiClient.dashboardMetrics).toHaveBeenCalledWith(
      expect.arrayContaining([
        "warehouse_transfers",
        "warehouse_transfer_items",
        "handling_units",
        "scan_events",
      ])
    );

    const results = await axe(container);
    expect(results).toHaveNoViolations();
  });
});
