jest.mock("@masarx/api/server", () => ({
  createUiServerClient: jest.fn(),
}));

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

jest.mock("next/navigation", () => ({
  useRouter: () => ({ replace: jest.fn(), push: jest.fn() }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => "/",
  useParams: () => ({}),
}));

jest.mock("../../packages/ui/src/resource-page", () => ({
  ResourcePage: ({ headerActions }: { headerActions?: unknown }) => (
    <div data-testid="resource-page">
      {headerActions as any}
    </div>
  ),
}));

import { screen } from "@testing-library/react";
import { createUiServerClient } from "@masarx/api/server";
import { WarehouseTransferResourcePage } from "../../packages/ui/src/warehouse-transfer-resource-page";
import { renderWithIntl } from "./test-utils";

const mockedCreateUiServerClient = createUiServerClient as unknown as jest.Mock;

describe("WarehouseTransferResourcePage", () => {
  beforeEach(() => {
    jest.resetAllMocks();
  });

  it("renders a create action when write capability is available", async () => {
    mockedCreateUiServerClient.mockReturnValue({
      me: jest.fn().mockResolvedValue({
        org: { id: "org-1" },
        capabilities: ["warehouse_transfers.write", "warehouse_transfers.read"],
      }),
      readRegistry: jest.fn().mockResolvedValue({
        resources: [
          {
            key: "warehouse_transfers",
            label: "Warehouse Transfers",
            relation: "public.warehouse_transfers",
            id_column: "id",
            capability_read: "warehouse_transfers.read",
            capability_write: "warehouse_transfers.write",
            select: ["id", "transfer_code", "status"],
          },
        ],
      }),
      settingsPreview: jest.fn().mockResolvedValue(null),
      filterOperators: jest.fn().mockResolvedValue(null),
      tableViews: jest.fn().mockResolvedValue(null),
      commandRegistry: jest.fn().mockResolvedValue({ commands: [] }),
      listResource: jest.fn().mockResolvedValue({
        resource: "warehouse_transfers",
        items: [],
        limit: 50,
        offset: 0,
        total: 0,
      }),
      resourceMetrics: jest.fn().mockResolvedValue({}),
    });

    const node = await WarehouseTransferResourcePage({
      appKey: "console",
      appBasePath: "/console",
      searchParams: {},
      testIdPrefix: "console-resource",
    });

    renderWithIntl(node);

    expect(
      screen.getByRole("link", { name: "Create transfer manifest" })
    ).toHaveAttribute(
      "href",
      "/console/resources/warehouse_transfers/new?return_to=%2Fconsole%2Fresources%2Fwarehouse_transfers"
    );
  });

  it("omits the create action when write capability is unavailable", async () => {
    mockedCreateUiServerClient.mockReturnValue({
      me: jest.fn().mockResolvedValue({
        org: { id: "org-1" },
        capabilities: ["warehouse_transfers.read"],
      }),
      readRegistry: jest.fn().mockResolvedValue({
        resources: [
          {
            key: "warehouse_transfers",
            label: "Warehouse Transfers",
            relation: "public.warehouse_transfers",
            id_column: "id",
            capability_read: "warehouse_transfers.read",
            capability_write: "warehouse_transfers.write",
            select: ["id", "transfer_code", "status"],
          },
        ],
      }),
      settingsPreview: jest.fn().mockResolvedValue(null),
      filterOperators: jest.fn().mockResolvedValue(null),
      tableViews: jest.fn().mockResolvedValue(null),
      commandRegistry: jest.fn().mockResolvedValue({ commands: [] }),
      listResource: jest.fn().mockResolvedValue({
        resource: "warehouse_transfers",
        items: [],
        limit: 50,
        offset: 0,
        total: 0,
      }),
      resourceMetrics: jest.fn().mockResolvedValue({}),
    });

    const node = await WarehouseTransferResourcePage({
      appKey: "portal",
      appBasePath: "/portal",
      searchParams: {},
      testIdPrefix: "portal-resource",
    });

    renderWithIntl(node);

    expect(
      screen.queryByRole("link", { name: "Create transfer manifest" })
    ).not.toBeInTheDocument();
  });
});
