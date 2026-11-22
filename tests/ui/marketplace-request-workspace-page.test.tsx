import type { ReactElement } from "react";
import { renderWithIntl } from "./test-utils";
import { screen } from "@testing-library/react";
import { MarketplaceRequestWorkspacePage } from "../../packages/ui/src/marketplace-request-workspace-page";
import { createUiServerClient } from "@masarx/api/server";

jest.mock("@masarx/api/server", () => ({
  createUiServerClient: jest.fn(),
}));

jest.mock("../../packages/ui/src/marketplace-action-form", () => ({
  MarketplaceActionForm: jest.fn(({ testIdPrefix }: { testIdPrefix: string }) => (
    <div data-testid={`${testIdPrefix}-form`} />
  )),
}));

const mockedCreateUiServerClient = createUiServerClient as jest.Mock;
const mockedMarketplaceActionForm = jest.requireMock(
  "../../packages/ui/src/marketplace-action-form",
).MarketplaceActionForm as jest.Mock;

describe("MarketplaceRequestWorkspacePage", () => {
  beforeEach(() => {
    jest.resetAllMocks();
  });

  it("renders friendly lookup labels and removes raw IDs from request workspace cards", async () => {
    const listLookupValues = jest.fn().mockImplementation(async (category: string) => {
      if (category !== "marketplace_request_release_state") {
        throw new Error(`Unexpected lookup category ${category}`);
      }
      return [
        { value: "private_pool", label: "Private pool", is_default: true },
        { value: "curated_network", label: "Curated network" },
        { value: "public", label: "Public" },
      ];
    });
    const marketplaceRequestRelease = jest.fn().mockResolvedValue({ ok: true });
    const marketplaceOfferCounter = jest.fn().mockResolvedValue({ ok: true });
    const marketplaceAwardOffer = jest.fn().mockResolvedValue({ ok: true });
    mockedCreateUiServerClient.mockReturnValue({
      listLookupValues,
      marketplaceRequestRelease,
      marketplaceOfferCounter,
      marketplaceAwardOffer,
      marketplaceRequestWorkspace: jest.fn().mockResolvedValue({
        ok: true,
        request: {
          id: "request-1",
          title: "Preferred supplier request",
          status: "draft",
          request_kind_key: "capacity_block",
          release_state: "private_pool",
          summary: "Private pool only.",
          request_details: {},
        },
        private_pool_memberships: [
          {
            supplier_organization_id: "org-fast",
            supplier_display_name: "Fast Fleet",
            supplier_organization_slug: "fast-fleet",
          },
        ],
        offers: [
          {
            id: "offer-1",
            status: "submitted",
            supplier_organization_id: "org-fast",
            supplier_display_name: "Fast Fleet",
            supplier_organization_slug: "fast-fleet",
            pricing: { amount: 1450, currency: "SAR" },
          },
        ],
        contracts: [
          {
            id: "contract-1",
            status: "pending_signature",
            settlement_mode_key: "net_settlement",
          },
        ],
        work_packages: [
          {
            id: "00000000-0000-4000-8000-000000001111",
            status: "awaiting_dispatch",
            materializer_key: "shipment_batch",
            summary: {
              title: "Riyadh north bundle",
            },
          },
          {
            id: "00000000-0000-4000-8000-000000002222",
            status: "ready",
            materializer_key: "manual_bridge",
          },
        ],
        disputes: [
          {
            id: "dispute-1",
            status: "under_review",
            category: "sla_breach",
            title: "SLA breach review",
            description: "Investigating route miss.",
          },
        ],
      }),
    });

    const node = await MarketplaceRequestWorkspacePage({
      appBasePath: "/portal",
      requestsHref: "/portal/marketplace/requests",
      requestId: "request-1",
      testIdPrefix: "portal-marketplace-request-workspace",
    });

    renderWithIntl(node as ReactElement);

    expect(listLookupValues).toHaveBeenCalledWith("marketplace_request_release_state");
    expect(screen.getAllByText("Fast Fleet | fast-fleet").length).toBeGreaterThanOrEqual(2);
    expect(screen.getByText("Draft")).toBeInTheDocument();
    expect(screen.getByText("Capacity Block")).toBeInTheDocument();
    expect(screen.getAllByText("Private pool").length).toBeGreaterThanOrEqual(2);
    expect(screen.getByText("Pending Signature")).toBeInTheDocument();
    expect(screen.getByText("Net Settlement")).toBeInTheDocument();
    expect(screen.getByText("Awaiting Dispatch")).toBeInTheDocument();
    expect(screen.getByText("Shipment Batch")).toBeInTheDocument();
    expect(screen.getByText("Ready")).toBeInTheDocument();
    expect(screen.getByText("Manual Bridge")).toBeInTheDocument();
    expect(screen.getByText("Riyadh north bundle")).toBeInTheDocument();
    expect(screen.getByText("Work Package REF-00002222")).toBeInTheDocument();
    expect(screen.getByText("Under Review")).toBeInTheDocument();
    expect(screen.getByText("Sla Breach")).toBeInTheDocument();
    expect(screen.queryByText("org-fast")).not.toBeInTheDocument();
    expect(screen.queryByText("capacity_block")).not.toBeInTheDocument();
    expect(screen.queryByText("private_pool")).not.toBeInTheDocument();
    expect(screen.queryByText("pending_signature")).not.toBeInTheDocument();
    expect(screen.queryByText("net_settlement")).not.toBeInTheDocument();
    expect(screen.queryByText("awaiting_dispatch")).not.toBeInTheDocument();
    expect(screen.queryByText("shipment_batch")).not.toBeInTheDocument();
    expect(screen.queryByText("under_review")).not.toBeInTheDocument();
    expect(screen.queryByText("sla_breach")).not.toBeInTheDocument();
    expect(
      screen.queryByText("00000000-0000-4000-8000-000000001111"),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByText("00000000-0000-4000-8000-000000002222"),
    ).not.toBeInTheDocument();

    const releaseFormCall = mockedMarketplaceActionForm.mock.calls.find(
      ([props]) => props.testIdPrefix === "portal-marketplace-request-workspace-release",
    );
    expect(releaseFormCall).toBeTruthy();
    expect(releaseFormCall?.[0]?.fields).toEqual([
      {
        name: "release_state",
        label: "Release state",
        kind: "select",
        defaultValue: "private_pool",
        options: [
          { label: "Private pool", value: "private_pool" },
          { label: "Curated network", value: "curated_network" },
          { label: "Public", value: "public" },
        ],
      },
    ]);
  });

  it("uses the configured action source prefix for console request workspace actions", async () => {
    const marketplaceRequestRelease = jest.fn().mockResolvedValue({ ok: true });
    mockedCreateUiServerClient.mockReturnValue({
      listLookupValues: jest.fn().mockResolvedValue([
        { value: "private_pool", label: "Private pool", is_default: true },
      ]),
      marketplaceRequestRelease,
      marketplaceOfferCounter: jest.fn().mockResolvedValue({ ok: true }),
      marketplaceAwardOffer: jest.fn().mockResolvedValue({ ok: true }),
      marketplaceRequestWorkspace: jest.fn().mockResolvedValue({
        ok: true,
        request: {
          id: "request-1",
          title: "Console request",
          status: "draft",
          request_kind_key: "capacity_block",
          release_state: "private_pool",
          summary: "Console request.",
          request_details: {},
        },
        private_pool_memberships: [],
        offers: [],
        contracts: [],
        work_packages: [],
        disputes: [],
      }),
    });

    const node = await MarketplaceRequestWorkspacePage({
      appBasePath: "/console",
      requestsHref: "/console/marketplace/requests",
      requestId: "request-1",
      testIdPrefix: "console-marketplace-request-workspace",
      actionSourcePrefix: "console.marketplace.request_workspace",
    });

    renderWithIntl(node as ReactElement);
    const releaseFormCall = mockedMarketplaceActionForm.mock.calls.find(
      ([props]) => props.testIdPrefix === "console-marketplace-request-workspace-release",
    );
    expect(releaseFormCall).toBeTruthy();

    const formData = new FormData();
    formData.set("release_state", "private_pool");
    await releaseFormCall?.[0]?.action({ status: "idle" }, formData);

    expect(marketplaceRequestRelease).toHaveBeenCalledWith(
      expect.objectContaining({
        requestId: "request-1",
        releaseState: "private_pool",
        metadata: {
          source: "console.marketplace.request_workspace.release",
        },
      }),
    );
  });
});
