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
import { renderWithIntl } from "./test-utils";
import { MarketplacePrivatePoolsPage } from "../../packages/ui/src/marketplace-private-pools-page";
import { createUiServerClient } from "@masarx/api/server";

jest.mock("@masarx/api/server", () => ({
  createUiServerClient: jest.fn(),
}));

const mockedCreateUiServerClient = createUiServerClient as jest.Mock;

function createMarketplaceClientMock(workspace: Record<string, unknown> | null) {
  return {
    marketplacePrivatePoolsWorkspace: jest.fn().mockResolvedValue(workspace),
  };
}

describe("MarketplacePrivatePoolsPage", () => {
  beforeEach(() => {
    jest.resetAllMocks();
  });

  it("renders visible private-pool memberships with summary counts and request links", async () => {
    mockedCreateUiServerClient.mockReturnValue(
      createMarketplaceClientMock({
        summary: {
          request_count: 1,
          membership_count: 2,
        },
        private_pools: [
          {
            request_id: "request-1",
            supplier_organization_id: "supplier-1",
            status: "awarded",
            release_state: "private_pool",
            request_kind_key: "shipment_batch",
            request_title: "Express overflow Riyadh North",
            requester_organization_name: "Acme Retail",
            supplier_organization_name: "Rush Pool Logistics",
          },
        ],
      })
    );

    const node = await MarketplacePrivatePoolsPage({
      appBasePath: "/portal",
      testIdPrefix: "portal-marketplace-private-pools",
    });

    renderWithIntl(node as ReactElement);

    expect(
      screen.getByTestId("portal-marketplace-private-pools-ready")
    ).toBeInTheDocument();
    expect(screen.getByText("Private pools")).toBeInTheDocument();
    expect(
      screen.getByText(
        "Private-pool memberships are projected from canonical marketplace requests and stay visible to eligible tenant and platform users."
      )
    ).toBeInTheDocument();
    expect(screen.getByText("Requests with private pools")).toBeInTheDocument();
    expect(screen.getByText("Private-pool memberships")).toBeInTheDocument();
    expect(screen.getByText("1")).toBeInTheDocument();
    expect(screen.getByText("2")).toBeInTheDocument();
    expect(screen.getByText("Express overflow Riyadh North")).toBeInTheDocument();
    expect(screen.getByText(/Rush Pool Logistics/)).toBeInTheDocument();
    expect(screen.getByText(/Acme Retail/)).toBeInTheDocument();

    const requestLink = screen.getByRole("link", {
      name: "Open request workspace",
    });
    expect(requestLink).toHaveAttribute(
      "href",
      "/portal/marketplace/requests/request-1"
    );
  });

  it("renders the empty-state copy when the current scope has no private-pool memberships", async () => {
    mockedCreateUiServerClient.mockReturnValue(
      createMarketplaceClientMock({
        summary: {
          request_count: 0,
          membership_count: 0,
        },
        private_pools: [],
      })
    );

    const node = await MarketplacePrivatePoolsPage({
      appBasePath: "/portal",
      testIdPrefix: "portal-marketplace-private-pools",
    });

    renderWithIntl(node as ReactElement);

    expect(
      screen.getByText("No private-pool memberships are visible for the current scope.")
    ).toBeInTheDocument();
  });
});
