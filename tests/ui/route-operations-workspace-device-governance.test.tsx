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
          scope_type: "tenant",
          scope_id: "tenant-1",
          scope_label: "Tenant 1",
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
                id: "routes",
                label: "Routes",
                href: "/console/resources/routes",
                resource: "routes",
              },
              {
                id: "user-devices",
                label: "User Devices",
                href: "/console/resources/user_devices",
                resource: "user_devices",
              },
            ],
          },
        ],
      },
    }),
    readRegistry: jest.fn().mockResolvedValue({
      resources: [
        { key: "routes", label: "Routes", capability_read: "routes.read" },
        {
          key: "user_devices",
          label: "User Devices",
          capability_read: "user_devices.read",
        },
      ],
    }),
    commandRegistry: jest.fn().mockResolvedValue({
      commands: [
        {
          key: "user_devices.revoke",
          label: "Revoke device",
          schema_category: "resource:user_devices",
          capability: "user_devices.write",
          execution: { type: "rpc", rpc: "ui_execute_user_device_revoke_v1" },
        },
      ],
    }),
    dashboardMetrics: jest.fn().mockResolvedValue({
      metrics: [
        { resource: "routes", total: 5 },
        { resource: "user_devices", total: 2 },
      ],
    }),
    listResource: jest.fn().mockResolvedValue({
      resource: "routes",
      items: [],
      limit: 1,
      offset: 0,
      total: 0,
    }),
  };
}

describe("RouteOperationsWorkspacePage device governance visibility", () => {
  beforeEach(() => {
    jest.resetAllMocks();
  });

  it("renders user device governance when navigation and registry expose the resource", async () => {
    createAuthenticatedSession();
    const uiClient = createUiClientMock();
    mockedCreateUiServerClient.mockReturnValue(uiClient);

    const node = await RouteOperationsWorkspacePage({
      appBasePath: "/console",
      appKey: "console",
      testIdPrefix: "console-route-operations-device-governance",
    });

    const { container } = renderWithIntl(node as ReactElement);

    expect(screen.getAllByText("User Devices").length).toBeGreaterThan(0);
    expect(uiClient.dashboardMetrics).toHaveBeenCalledWith(
      expect.arrayContaining(["user_devices"])
    );

    const results = await axe(container);
    expect(results).toHaveNoViolations();
  });
});
