import type { ReactElement } from "react";
import { renderWithIntl } from "./test-utils";
import { screen } from "@testing-library/react";
import { MarketplaceRequestWorkspacePage } from "../../packages/ui/src/marketplace-request-workspace-page";
import { createUiServerClient } from "@masarx/api/server";

jest.mock("@masarx/api/server", () => ({
  createUiServerClient: jest.fn(),
}));

jest.mock("next/cache", () => ({
  revalidatePath: jest.fn(),
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
      if (category === "marketplace_request_release_state") {
        return [
          { value: "private_pool", label: "Private pool", is_default: true },
          { value: "curated_network", label: "Curated network" },
          { value: "public", label: "Public" },
        ];
      }
      if (category === "service_level") {
        return [{ value: "standard", label: "Standard", is_default: true }];
      }
      if (category === "currency") {
        return [{ value: "SAR", label: "Saudi Riyal", is_default: true }];
      }
      if (category === "marketplace_rate_basis") {
        return [{ value: "route", label: "Route", is_default: true }];
      }
      throw new Error(`Unexpected lookup category ${category}`);
    });
    mockedCreateUiServerClient.mockReturnValue({
      listLookupValues,
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
    expect(screen.getByText("Submitted")).toBeInTheDocument();
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
    expect(screen.queryByText("submitted")).not.toBeInTheDocument();
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

  it("uses structured counter and award forms while submitting canonical JSON payloads", async () => {
    const marketplaceOfferCounter = jest.fn().mockResolvedValue({ ok: true });
    const marketplaceAwardOffer = jest.fn().mockResolvedValue({ ok: true });
    const listLookupValues = jest.fn().mockImplementation(async (category: string) => {
      if (category === "marketplace_request_release_state") {
        return [{ value: "private_pool", label: "Private pool", is_default: true }];
      }
      if (category === "service_level") {
        return [
          { value: "same_day", label: "Same Day" },
          { value: "standard", label: "Standard", is_default: true },
          { value: "express", label: "Express" },
        ];
      }
      if (category === "currency") {
        return [
          { value: "SAR", label: "Saudi Riyal", is_default: true },
          { value: "AED", label: "UAE Dirham" },
          { value: "USD", label: "US Dollar" },
        ];
      }
      if (category === "marketplace_rate_basis") {
        return [
          { value: "route", label: "Route", is_default: true },
          { value: "stop", label: "Stop" },
        ];
      }
      return [];
    });
    mockedCreateUiServerClient.mockReturnValue({
      listLookupValues,
      marketplaceOfferCounter,
      marketplaceAwardOffer,
      marketplaceRequestWorkspace: jest.fn().mockResolvedValue({
        ok: true,
        request: {
          id: "request-1",
          title: "Preferred supplier request",
          status: "published",
          request_kind_key: "capacity_block",
          release_state: "private_pool",
          summary: "Private pool only.",
          request_details: {},
        },
        private_pool_memberships: [],
        offers: [
          {
            id: "offer-1",
            status: "submitted",
            supplier_display_name: "Fast Fleet",
            pricing: {
              amount: 1450,
              currency: "USD",
              rate_basis: "route",
            },
            terms: {
              service_level: "same_day",
              proof_requirements: ["Photo proof", "Recipient signature"],
              notes: "Initial provider terms.",
            },
          },
        ],
        contracts: [],
        work_packages: [],
        disputes: [],
      }),
    });

    const node = await MarketplaceRequestWorkspacePage({
      appBasePath: "/portal",
      requestsHref: "/portal/marketplace/requests",
      requestId: "request-1",
      testIdPrefix: "portal-marketplace-request-workspace",
    });

    renderWithIntl(node as ReactElement);

    expect(listLookupValues).toHaveBeenCalledWith("service_level");

    const counterFormCall = mockedMarketplaceActionForm.mock.calls.find(
      ([props]) =>
        props.testIdPrefix ===
        "portal-marketplace-request-workspace-counter-offer-1",
    );
    expect(counterFormCall).toBeTruthy();
    const counterFields = counterFormCall?.[0]?.fields ?? [];
    expect(counterFields.map((field: { name: string }) => field.name)).toEqual([
      "offer_id",
      "message",
      "pricing_amount",
      "pricing_currency",
      "rate_basis",
      "service_level",
      "proof_requirements",
      "terms_notes",
    ]);
    expect(counterFields.map((field: { label?: string }) => field.label)).not.toContain(
      "Terms JSON",
    );
    expect(counterFields.map((field: { label?: string }) => field.label)).not.toContain(
      "Pricing JSON",
    );
    expect(counterFields).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "pricing_currency",
          label: "Currency",
          kind: "select",
          defaultValue: "USD",
          options: expect.arrayContaining([
            { value: "USD", label: "US Dollar" },
          ]),
        }),
        expect.objectContaining({
          name: "rate_basis",
          label: "Rate basis",
          kind: "select",
          defaultValue: "route",
          options: expect.arrayContaining([
            { value: "route", label: "Route", isDefault: true },
            { value: "stop", label: "Stop" },
          ]),
        }),
        expect.objectContaining({
          name: "service_level",
          label: "Service level",
          kind: "select",
          defaultValue: "same_day",
          options: expect.arrayContaining([
            { value: "same_day", label: "Same Day" },
          ]),
        }),
        expect.objectContaining({
          name: "proof_requirements",
          defaultValue: "Photo proof\nRecipient signature",
        }),
      ]),
    );
    const counterServiceLevelField = counterFields.find(
      (field: { name: string }) => field.name === "service_level",
    ) as { options?: Array<{ label: string; value: string }> } | undefined;
    const counterServiceLevelOptions = counterServiceLevelField?.options ?? [];
    expect(counterServiceLevelOptions.map((option) => option.label)).toEqual([
      "Same Day",
      "Standard",
      "Express",
    ]);
    expect(counterServiceLevelOptions.map((option) => option.value)).toEqual([
      "same_day",
      "standard",
      "express",
    ]);
    expect(counterServiceLevelOptions.map((option) => option.label)).not.toContain(
      "same_day",
    );

    const counterFormData = new FormData();
    counterFormData.set("offer_id", "offer-1");
    counterFormData.set("message", "Counter with tighter SLA.");
    counterFormData.set("pricing_amount", "1550");
    counterFormData.set("pricing_currency", "AED");
    counterFormData.set("rate_basis", "stop");
    counterFormData.set("service_level", "standard");
    counterFormData.set("proof_requirements", "Scan confirmation\nPOD photo");
    counterFormData.set("terms_notes", "Requester counter terms.");

    await counterFormCall?.[0]?.action({ status: "idle" }, counterFormData);

    expect(marketplaceOfferCounter).toHaveBeenCalledWith({
      offerId: "offer-1",
      message: "Counter with tighter SLA.",
      terms: {
        service_level: "standard",
        proof_requirements: ["Scan confirmation", "POD photo"],
        notes: "Requester counter terms.",
      },
      pricing: {
        amount: 1550,
        currency: "AED",
        rate_basis: "stop",
      },
      metadata: { source: "portal.marketplace.request_workspace.counter" },
    });

    const awardFormCall = mockedMarketplaceActionForm.mock.calls.find(
      ([props]) =>
        props.testIdPrefix ===
        "portal-marketplace-request-workspace-award-offer-1",
    );
    expect(awardFormCall).toBeTruthy();
    const awardFields = awardFormCall?.[0]?.fields ?? [];
    expect(awardFields.map((field: { name: string }) => field.name)).toEqual([
      "offer_id",
      "award_reason",
      "service_level",
      "proof_requirements",
      "terms_notes",
    ]);
    expect(awardFields.map((field: { label?: string }) => field.label)).not.toContain(
      "Award terms JSON",
    );
    const awardServiceLevelField = awardFields.find(
      (field: { name: string }) => field.name === "service_level",
    ) as { options?: Array<{ label: string; value: string }> } | undefined;
    const awardServiceLevelOptions = awardServiceLevelField?.options ?? [];
    expect(awardServiceLevelOptions.map((option) => option.label)).toEqual([
      "Same Day",
      "Standard",
      "Express",
    ]);
    expect(awardServiceLevelOptions.map((option) => option.value)).toEqual([
      "same_day",
      "standard",
      "express",
    ]);
    expect(awardServiceLevelOptions.map((option) => option.label)).not.toContain(
      "express",
    );

    const awardFormData = new FormData();
    awardFormData.set("offer_id", "offer-1");
    awardFormData.set("award_reason", "Best capacity and SLA.");
    awardFormData.set("service_level", "express");
    awardFormData.set("proof_requirements", "Recipient signature");
    awardFormData.set("terms_notes", "Final award terms.");

    await awardFormCall?.[0]?.action({ status: "idle" }, awardFormData);

    expect(marketplaceAwardOffer).toHaveBeenCalledWith({
      offerId: "offer-1",
      awardReason: "Best capacity and SLA.",
      awardTerms: {
        service_level: "express",
        proof_requirements: ["Recipient signature"],
        notes: "Final award terms.",
      },
      metadata: { source: "portal.marketplace.request_workspace.award" },
    });
  });
});
