import type { ReactElement } from "react";
import { screen, within } from "@testing-library/react";
import { createUiServerClient } from "@masarx/api/server";
import { MarketplaceProviderWorkboardPage } from "../../packages/ui/src/marketplace-provider-workboard-page";
import { renderWithIntl } from "./test-utils";

jest.mock("@masarx/api/server", () => ({
  createUiServerClient: jest.fn(),
}));

jest.mock("next/cache", () => ({
  revalidatePath: jest.fn(),
}));

jest.mock("../../packages/ui/src/marketplace-action-form", () => ({
  MarketplaceActionForm: jest.fn(({
    testIdPrefix,
    fields = [],
  }: {
    testIdPrefix: string;
    fields?: Array<{
      name: string;
      label?: string;
      kind?: string;
      defaultValue?: string;
      options?: Array<{ label: string; value: string }>;
    }>;
  }) => (
    <div data-testid={testIdPrefix}>
      {fields.map((field) => {
        if (field.kind === "hidden") return null;
        if (field.kind === "select") {
          return (
          <label key={field.name}>
            {field.label ?? field.name}
            <select
              aria-label={field.label ?? field.name}
              defaultValue={field.defaultValue}
              name={field.name}
            >
              {field.options?.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>
          );
        }
        return (
          <label key={field.name}>
            {field.label ?? field.name}
            {field.kind === "textarea" ? (
              <textarea
                aria-label={field.label ?? field.name}
                defaultValue={field.defaultValue}
                name={field.name}
              />
            ) : (
              <input
                aria-label={field.label ?? field.name}
                defaultValue={field.defaultValue}
                name={field.name}
              />
            )}
          </label>
        );
      })}
    </div>
  )),
}));

const mockedCreateUiServerClient = createUiServerClient as jest.Mock;
const mockedMarketplaceActionForm = jest.requireMock(
  "../../packages/ui/src/marketplace-action-form",
).MarketplaceActionForm as jest.Mock;

function createMarketplaceClientMock(
  workboard: Record<string, unknown> | null,
  lookupRows:
    | Array<Record<string, unknown>>
    | Record<string, Array<Record<string, unknown>>> = [],
) {
  const rowsByCategory = Array.isArray(lookupRows)
    ? { marketplace_availability_status: lookupRows }
    : lookupRows;
  return {
    marketplaceProviderWorkboard: jest.fn().mockResolvedValue(workboard),
    listLookupValues: jest.fn().mockImplementation(async (category: string) => {
      return rowsByCategory[category] ?? [];
    }),
    marketplaceSubmitOffer: jest.fn().mockResolvedValue({ ok: true }),
    marketplaceCompleteWorkPackage: jest.fn().mockResolvedValue({ ok: true }),
  };
}

describe("MarketplaceProviderWorkboardPage", () => {
  beforeEach(() => {
    mockedCreateUiServerClient.mockReset();
    mockedMarketplaceActionForm.mockClear();
  });


  it("humanizes availability and request-kind badges when canonical availability lookup labels are unavailable", async () => {
    mockedCreateUiServerClient.mockReturnValue(
      createMarketplaceClientMock({
        participant_profile: {
          display_name: "Rush Logistics",
        },
        visible_requests: [
          {
            id: "request-1",
            status: "pending_review",
            request_kind_key: "capacity_block",
            title: "Riyadh overflow capacity",
            summary: "Same-day overflow request.",
          },
        ],
        awards: [
          {
            id: "award-1",
            status: "pending_acceptance",
            award_reason: "Preferred capacity match",
          },
        ],
        contracts: [
          {
            id: "contract-1",
            status: "pending_signature",
          },
        ],
        work_packages: [
          {
            id: "wp-1",
            status: "awaiting_dispatch",
          },
        ],
        availability_windows: [
          {
            id: "availability-1",
            availability_status: "reserved_capacity",
            starts_at: "2026-04-19T08:00:00+03:00",
            ends_at: "2026-04-19T12:00:00+03:00",
          },
        ],
      }),
    );

    const node = await MarketplaceProviderWorkboardPage({
      appBasePath: "/portal",
      baseHref: "/portal/marketplace/provider",
      testIdPrefix: "portal-marketplace-provider-workboard",
    });

    renderWithIntl(node as ReactElement);

    expect(
      screen.getByTestId("portal-marketplace-provider-workboard-ready"),
    ).toBeInTheDocument();
    expect(screen.getByText("Rush Logistics")).toBeInTheDocument();
    expect(screen.getByText("Reserved Capacity")).toBeInTheDocument();
    expect(screen.getByText("Pending Review")).toBeInTheDocument();
    expect(screen.getByText("Capacity Block")).toBeInTheDocument();
    expect(screen.getByText("Pending Acceptance")).toBeInTheDocument();
    expect(screen.getByText("Pending Signature")).toBeInTheDocument();
    expect(screen.getByText("Awaiting Dispatch")).toBeInTheDocument();
    expect(
      screen.queryByText("reserved_capacity"),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByText("pending_review"),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByText("capacity_block"),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByText("pending_acceptance"),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByText("pending_signature"),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByText("awaiting_dispatch"),
    ).not.toBeInTheDocument();
  });

  it("uses structured marketplace offer and proof forms while submitting canonical JSON payloads", async () => {
    const client = createMarketplaceClientMock(
      {
        participant_profile: {
          display_name: "Rush Logistics",
        },
        visible_requests: [
          {
            id: "request-1",
            status: "published",
            request_kind_key: "capacity_block",
            title: "Riyadh overflow capacity",
            summary: "Same-day overflow request.",
          },
        ],
        awards: [],
        contracts: [],
        work_packages: [
          {
            id: "work-package-1",
            status: "ready",
          },
        ],
        availability_windows: [],
      },
      {
        marketplace_availability_status: [
          { value: "available", label: "Available", is_default: true },
        ],
        service_level: [
          { value: "standard", label: "Standard", is_default: true },
          { value: "express", label: "Express" },
        ],
        currency: [
          { value: "SAR", label: "Saudi Riyal", is_default: true },
          { value: "AED", label: "UAE Dirham" },
        ],
        marketplace_rate_basis: [
          { value: "route", label: "Route", is_default: true },
          { value: "stop", label: "Stop" },
        ],
      },
    );
    mockedCreateUiServerClient.mockReturnValue(client);

    const node = await MarketplaceProviderWorkboardPage({
      appBasePath: "/portal",
      baseHref: "/portal/marketplace/provider",
      testIdPrefix: "portal-marketplace-provider-workboard",
    });

    renderWithIntl(node as ReactElement);

    const offerFormCall = mockedMarketplaceActionForm.mock.calls.find(
      ([props]) =>
        props.testIdPrefix ===
        "portal-marketplace-provider-workboard-offer-request-1",
    );
    expect(offerFormCall).toBeTruthy();
    const offerFields = offerFormCall?.[0]?.fields ?? [];
    expect(offerFields.map((field: { name: string }) => field.name)).toEqual([
      "request_id",
      "message",
      "pricing_amount",
      "pricing_currency",
      "rate_basis",
      "service_level",
      "proof_requirements",
      "terms_notes",
    ]);
    expect(offerFields.map((field: { label?: string }) => field.label)).not.toContain(
      "Terms JSON",
    );
    expect(offerFields.map((field: { label?: string }) => field.label)).not.toContain(
      "Pricing JSON",
    );
    expect(
      screen.getByRole("combobox", { name: "Currency" }),
    ).toHaveDisplayValue("Saudi Riyal");
    expect(
      screen.getByRole("combobox", { name: "Service level" }),
    ).toHaveDisplayValue("Standard");
    expect(
      screen.getByRole("combobox", { name: "Rate basis" }),
    ).toHaveDisplayValue("Route");
    const currencySelect = screen.getByRole("combobox", { name: "Currency" });
    const serviceLevelSelect = screen.getByRole("combobox", { name: "Service level" });
    const rateBasisSelect = screen.getByRole("combobox", { name: "Rate basis" });
    expect(within(currencySelect).getByRole("option", { name: "Saudi Riyal" })).toHaveValue("SAR");
    expect(within(serviceLevelSelect).getByRole("option", { name: "Express" })).toHaveValue("express");
    expect(within(rateBasisSelect).getByRole("option", { name: "Route" })).toHaveValue("route");
    expect(within(currencySelect).queryByRole("option", { name: "SAR" })).toBeNull();
    expect(within(serviceLevelSelect).queryByRole("option", { name: "express" })).toBeNull();
    expect(within(rateBasisSelect).queryByRole("option", { name: "route" })).toBeNull();
    expect(currencySelect).not.toHaveDisplayValue("SAR");
    expect(serviceLevelSelect).not.toHaveDisplayValue("standard");
    expect(rateBasisSelect).not.toHaveDisplayValue("route");

    const offerFormData = new FormData();
    offerFormData.set("request_id", "request-1");
    offerFormData.set("message", "Express overflow coverage.");
    offerFormData.set("pricing_amount", "2450.75");
    offerFormData.set("pricing_currency", "SAR");
    offerFormData.set("rate_basis", "route");
    offerFormData.set("service_level", "express");
    offerFormData.set(
      "proof_requirements",
      "Photo proof\nRecipient signature",
    );
    offerFormData.set("terms_notes", "Doorstep COD coverage included.");

    await offerFormCall?.[0]?.action({ status: "idle" }, offerFormData);

    expect(client.marketplaceSubmitOffer).toHaveBeenCalledWith({
      requestId: "request-1",
      message: "Express overflow coverage.",
      terms: {
        service_level: "express",
        proof_requirements: ["Photo proof", "Recipient signature"],
        notes: "Doorstep COD coverage included.",
      },
      pricing: {
        amount: 2450.75,
        currency: "SAR",
        rate_basis: "route",
      },
      metadata: { source: "portal.marketplace.provider.offer" },
    });

    const proofFormCall = mockedMarketplaceActionForm.mock.calls.find(
      ([props]) =>
        props.testIdPrefix ===
        "portal-marketplace-provider-workboard-complete-work-package-1",
    );
    expect(proofFormCall).toBeTruthy();
    const proofFields = proofFormCall?.[0]?.fields ?? [];
    expect(proofFields.map((field: { name: string }) => field.name)).toEqual([
      "work_package_id",
      "proof_requirements",
      "proof_quality",
      "feedback_score",
      "completion_notes",
    ]);
    expect(proofFields.map((field: { label?: string }) => field.label)).not.toContain(
      "Proof JSON",
    );

    const proofFormData = new FormData();
    proofFormData.set("work_package_id", "work-package-1");
    proofFormData.set("proof_requirements", "Scan confirmation, POD photo");
    proofFormData.set("proof_quality", "4");
    proofFormData.set("feedback_score", "5");
    proofFormData.set("completion_notes", "Proof packet complete.");

    await proofFormCall?.[0]?.action({ status: "idle" }, proofFormData);

    expect(client.marketplaceCompleteWorkPackage).toHaveBeenCalledWith({
      workPackageId: "work-package-1",
      proof: {
        proof_requirements: ["Scan confirmation", "POD photo"],
        proof_quality: 4,
        feedback_score: 5,
        notes: "Proof packet complete.",
      },
      metadata: { source: "portal.marketplace.provider.complete" },
    });

    const invalidProofData = new FormData();
    invalidProofData.set("work_package_id", "work-package-1");
    invalidProofData.set("proof_quality", "6");
    invalidProofData.set("feedback_score", "5");

    await expect(
      proofFormCall?.[0]?.action({ status: "idle" }, invalidProofData),
    ).resolves.toMatchObject({
      status: "error",
      message: "Proof quality score must be at most 5.",
    });
  });
});
