import "server-only";

import Link from "next/link";
import { revalidatePath } from "next/cache";
import { createUiServerClient } from "@masarx/api/server";
import { Badge } from "./badge";
import { PageHeader } from "./page-header";
import { Section } from "./section";
import { MarketplaceActionForm, MarketplaceActionFormState } from "./marketplace-action-form";
import {
  jsonTextareaValue,
  normalizeArray,
  normalizeObject,
  parseJsonValue,
  stringValue,
} from "./marketplace-page-utils";
import { formatUiError } from "./utils";
import { labelFromKey } from "./resource-query";

type MarketplaceProviderWorkboardPageProps = {
  appBasePath: string;
  baseHref: string;
  testIdPrefix: string;
};

function parseProofRequirements(value: FormDataEntryValue | null) {
  return String(value ?? "").split(/[,\n]/u).map((entry) => entry.trim()).filter(Boolean);
}

export async function MarketplaceProviderWorkboardPage({
  appBasePath,
  baseHref,
  testIdPrefix,
}: MarketplaceProviderWorkboardPageProps) {
  const ui = createUiServerClient();
  const workboard = await ui.marketplaceProviderWorkboard().catch(() => null);
  const workboardRecord = normalizeObject(workboard);
  const provider = normalizeObject(workboardRecord?.participant_profile);
  const requests = normalizeArray(workboardRecord?.visible_requests);
  const awards = normalizeArray(workboardRecord?.awards);
  const contracts = normalizeArray(workboardRecord?.contracts);
  const workPackages = normalizeArray(workboardRecord?.work_packages);
  const availabilityWindows = normalizeArray(workboardRecord?.availability_windows);
  const lookupValues = async (category: string) =>
    (await ui.listLookupValues?.(category).catch(() => [])) ?? [];
  const [currencies, serviceLevels, rateBases] = await Promise.all([
    lookupValues("currency"),
    lookupValues("service_level"),
    lookupValues("marketplace_rate_basis"),
  ]);
  const hasOfferLookups = currencies.length > 0 && serviceLevels.length > 0 && rateBases.length > 0;

  function lookupSelect(name: string, label: string, rows: typeof currencies) {
    return {
      name, label, kind: "select" as const, required: true,
      options: rows.map(({ value, label }) => ({ value, label })),
      defaultValue: (rows.find((row) => row.is_default) ?? rows[0])?.value,
    };
  }

  async function upsertAvailability(
    _prevState: MarketplaceActionFormState,
    formData: FormData,
  ): Promise<MarketplaceActionFormState> {
    "use server";
    const capacityResult = parseJsonValue(String(formData.get("capacity_json") ?? "{}"), {});
    if (!capacityResult.ok) return { status: "error", message: capacityResult.message };
    try {
      const result = await createUiServerClient().marketplaceAvailabilityUpsert({
        startsAt: String(formData.get("starts_at") ?? ""),
        endsAt: String(formData.get("ends_at") ?? ""),
        availabilityStatus: String(formData.get("availability_status") ?? "available"),
        capacity: normalizeObject(capacityResult.value) ?? {},
        metadata: { source: "portal.marketplace.provider.availability" },
      });
      if (result.ok === false) {
        const error = normalizeObject(result.error);
        return {
          status: "error",
          message: stringValue(error?.message) ?? stringValue(error?.code) ?? "Availability update failed.",
        };
      }
    } catch (error) {
      return { status: "error", message: formatUiError(error, "Availability update failed.") };
    }
    return { status: "success", message: "Availability window saved." };
  }

  async function submitOffer(
    _prevState: MarketplaceActionFormState,
    formData: FormData,
  ): Promise<MarketplaceActionFormState> {
    "use server";
    const requestId = String(formData.get("request_id") ?? "").trim();
    const termsResult = parseJsonValue(String(formData.get("terms_json") ?? "{}"), {});
    if (!termsResult.ok) return { status: "error", message: termsResult.message };
    const pricingResult = parseJsonValue(String(formData.get("pricing_json") ?? "{}"), {});
    if (!pricingResult.ok) return { status: "error", message: pricingResult.message };
    let terms = normalizeObject(termsResult.value) ?? {};
    let pricing = normalizeObject(pricingResult.value) ?? {};
    if (formData.has("pricing_amount")) {
      const rawAmount = String(formData.get("pricing_amount") ?? "").trim();
      const amount = Number(rawAmount);
      const currency = String(formData.get("pricing_currency") ?? "").trim();
      const rateBasis = String(formData.get("rate_basis") ?? "").trim();
      const serviceLevel = String(formData.get("service_level") ?? "").trim();
      if (!rawAmount || !Number.isFinite(amount) || amount < 0) {
        return { status: "error", message: "Enter a valid non-negative price." };
      }
      if (!currencies.some((row) => row.value === currency) ||
          !rateBases.some((row) => row.value === rateBasis) ||
          !serviceLevels.some((row) => row.value === serviceLevel)) {
        return { status: "error", message: "Select a valid currency, rate basis, and service level." };
      }
      const requirements = parseProofRequirements(formData.get("proof_requirements"));
      const notes = String(formData.get("terms_notes") ?? "").trim();
      terms = {
        service_level: serviceLevel,
        ...(requirements.length ? { proof_requirements: requirements } : {}),
        ...(notes ? { notes } : {}),
      };
      pricing = { amount, currency, rate_basis: rateBasis };
    }
    try {
      const result = await createUiServerClient().marketplaceSubmitOffer({
        requestId,
        message: String(formData.get("message") ?? "").trim() || null,
        terms,
        pricing,
        metadata: { source: "portal.marketplace.provider.offer" },
      });
      if (result.ok === false) {
        const error = normalizeObject(result.error);
        return {
          status: "error",
          message: stringValue(error?.message) ?? stringValue(error?.code) ?? "Offer failed.",
        };
      }
    } catch (error) {
      return { status: "error", message: formatUiError(error, "Offer failed.") };
    }
    return { status: "success", message: "Offer submitted." };
  }

  async function respondToAward(
    _prevState: MarketplaceActionFormState,
    formData: FormData,
  ): Promise<MarketplaceActionFormState> {
    "use server";
    try {
      const result = await createUiServerClient().marketplaceRespondToAward({
        awardId: String(formData.get("award_id") ?? "").trim(),
        decision: String(formData.get("decision") ?? "").trim(),
        metadata: { source: "portal.marketplace.provider.award_response" },
      });
      if (result.ok === false) {
        const error = normalizeObject(result.error);
        return {
          status: "error",
          message: stringValue(error?.message) ?? stringValue(error?.code) ?? "Award response failed.",
        };
      }
    } catch (error) {
      return { status: "error", message: formatUiError(error, "Award response failed.") };
    }
    revalidatePath(`${appBasePath}/marketplace/contracts`);
    return { status: "success", message: "Award response recorded." };
  }

  async function completeWorkPackage(
    _prevState: MarketplaceActionFormState,
    formData: FormData,
  ): Promise<MarketplaceActionFormState> {
    "use server";
    const proofResult = parseJsonValue(String(formData.get("proof_json") ?? "{}"), {});
    if (!proofResult.ok) return { status: "error", message: proofResult.message };
    let proof = normalizeObject(proofResult.value) ?? {};
    if (formData.has("proof_quality") || formData.has("feedback_score")) {
      const quality = Number(String(formData.get("proof_quality") ?? "").trim());
      const feedback = Number(String(formData.get("feedback_score") ?? "").trim());
      if (!Number.isInteger(quality) || quality < 1 || quality > 5) {
        return { status: "error", message: quality > 5 ? "Proof quality score must be at most 5." : "Proof quality score must be between 1 and 5." };
      }
      if (!Number.isInteger(feedback) || feedback < 1 || feedback > 5) {
        return { status: "error", message: "Feedback score must be between 1 and 5." };
      }
      const requirements = parseProofRequirements(formData.get("proof_requirements"));
      const notes = String(formData.get("completion_notes") ?? "").trim();
      proof = {
        proof_quality: quality,
        feedback_score: feedback,
        ...(requirements.length ? { proof_requirements: requirements } : {}),
        ...(notes ? { notes } : {}),
      };
    }
    try {
      const result = await createUiServerClient().marketplaceCompleteWorkPackage({
        workPackageId: String(formData.get("work_package_id") ?? "").trim(),
        proof,
        metadata: { source: "portal.marketplace.provider.complete" },
      });
      if (result.ok === false) {
        const error = normalizeObject(result.error);
        return {
          status: "error",
          message: stringValue(error?.message) ?? stringValue(error?.code) ?? "Completion failed.",
        };
      }
    } catch (error) {
      return { status: "error", message: formatUiError(error, "Completion failed.") };
    }
    return { status: "success", message: "Work package completion recorded." };
  }

  return (
    <div className="space-y-6" data-testid={`${testIdPrefix}-ready`}>
      <PageHeader
        title={stringValue(provider?.display_name) ?? "Provider workboard"}
        description="Offers, pending awards, active work packages, and availability all stay on the same provider-facing marketplace surface."
      />

      <Section title="Availability" collapsible={false}>
        <div className="grid gap-4 lg:grid-cols-[1fr,1fr]">
          <MarketplaceActionForm
            action={upsertAvailability}
            submitLabel="Save availability"
            testIdPrefix={`${testIdPrefix}-availability`}
            fields={[
              { name: "starts_at", label: "Starts at", kind: "datetime-local", required: true },
              { name: "ends_at", label: "Ends at", kind: "datetime-local", required: true },
              {
                name: "availability_status",
                label: "Status",
                kind: "select",
                defaultValue: "available",
                options: [
                  { label: "Available", value: "available" },
                  { label: "Unavailable", value: "unavailable" },
                  { label: "Reserved", value: "reserved" },
                ],
              },
              { name: "capacity_json", label: "Capacity JSON", kind: "textarea", rows: 4, defaultValue: "{\"shipments\": 20}" },
            ]}
          />
          <div className="grid gap-3">
            {availabilityWindows.length === 0 ? (
              <div className="rounded-2xl border border-ui-border bg-ui-surface/60 p-4 text-sm text-ui-muted">
                No availability windows are published yet.
              </div>
            ) : (
              availabilityWindows.map((window) => (
                <div key={stringValue(window.id) ?? "availability"} className="rounded-2xl border border-ui-border bg-ui-surface/60 p-4 text-sm text-ui-muted">
                  <div className="flex flex-wrap gap-2 text-xs text-ui-muted">
                    <Badge>{labelFromKey(stringValue(window.availability_status) ?? "available")}</Badge>
                  </div>
                  <div className="mt-3">{stringValue(window.starts_at) ?? ""} - {stringValue(window.ends_at) ?? ""}</div>
                </div>
              ))
            )}
          </div>
        </div>
      </Section>

      <Section title="Visible requests" collapsible={false}>
        {requests.length === 0 ? (
          <div className="text-sm text-ui-muted">No visible marketplace requests are currently available for this provider.</div>
        ) : (
          <div className="grid gap-4">
            {requests.map((request) => {
              const requestId = stringValue(request.id) ?? "";
              return (
                <div key={requestId} className="grid gap-4 rounded-2xl border border-ui-border bg-ui-surface/60 p-4 lg:grid-cols-[1.1fr,0.9fr]">
                  <div className="space-y-3">
                    <div className="flex flex-wrap gap-2 text-xs text-ui-muted">
                      <Badge>{labelFromKey(stringValue(request.status) ?? "published")}</Badge>
                      {stringValue(request.request_kind_key) ? <Badge>{labelFromKey(String(request.request_kind_key))}</Badge> : null}
                    </div>
                    <div className="text-sm font-medium text-ui-ink">{stringValue(request.title) ?? requestId}</div>
                    <div className="text-sm text-ui-muted">{stringValue(request.summary) ?? "No summary recorded."}</div>
                  </div>
                  <MarketplaceActionForm
                    action={submitOffer}
                    submitLabel="Submit offer"
                    testIdPrefix={`${testIdPrefix}-offer-${requestId}`}
                    fields={[
                      { name: "request_id", kind: "hidden", defaultValue: requestId },
                      { name: "message", label: "Message", kind: "textarea", rows: 3, placeholder: "Coverage, SLA, and notes" },
                      ...(hasOfferLookups ? [
                        { name: "pricing_amount", label: "Amount", kind: "text" as const, required: true },
                        lookupSelect("pricing_currency", "Currency", currencies),
                        lookupSelect("rate_basis", "Rate basis", rateBases),
                        lookupSelect("service_level", "Service level", serviceLevels),
                        { name: "proof_requirements", label: "Proof requirements", kind: "textarea" as const },
                        { name: "terms_notes", label: "Terms notes", kind: "textarea" as const },
                      ] : [
                        { name: "terms_json", label: "Terms JSON", kind: "textarea" as const, rows: 4, defaultValue: jsonTextareaValue({ service_level: "same_day" }) },
                        { name: "pricing_json", label: "Pricing JSON", kind: "textarea" as const, rows: 4, defaultValue: jsonTextareaValue({ amount: 0, currency: "SAR" }) },
                      ]),
                    ]}
                  />
                </div>
              );
            })}
          </div>
        )}
      </Section>

      <Section title="Pending awards" collapsible={false}>
        {awards.length === 0 ? (
          <div className="text-sm text-ui-muted">No awards are waiting for provider response.</div>
        ) : (
          <div className="grid gap-4 md:grid-cols-2">
            {awards.map((award) => {
              const awardId = stringValue(award.id) ?? "";
              return (
                <div key={awardId} className="rounded-2xl border border-ui-border bg-ui-surface/60 p-4">
                  <div className="flex flex-wrap gap-2 text-xs text-ui-muted">
                    <Badge>{labelFromKey(stringValue(award.status) ?? "pending_acceptance")}</Badge>
                  </div>
                  <div className="mt-3 text-sm text-ui-muted">{stringValue(award.award_reason) ?? "No award reason provided."}</div>
                  <div className="mt-4 grid gap-3 md:grid-cols-2">
                    <MarketplaceActionForm
                      action={respondToAward}
                      submitLabel="Accept"
                      testIdPrefix={`${testIdPrefix}-award-accept-${awardId}`}
                      fields={[
                        { name: "award_id", kind: "hidden", defaultValue: awardId },
                        { name: "decision", kind: "hidden", defaultValue: "accepted" },
                      ]}
                    />
                    <MarketplaceActionForm
                      action={respondToAward}
                      submitLabel="Reject"
                      testIdPrefix={`${testIdPrefix}-award-reject-${awardId}`}
                      fields={[
                        { name: "award_id", kind: "hidden", defaultValue: awardId },
                        { name: "decision", kind: "hidden", defaultValue: "rejected" },
                      ]}
                    />
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </Section>

      <Section title="Contracts and active work" collapsible={false}>
        <div className="grid gap-4 lg:grid-cols-2">
          <div className="grid gap-3">
            {contracts.length === 0 ? (
              <div className="rounded-2xl border border-ui-border bg-ui-surface/60 p-4 text-sm text-ui-muted">
                No marketplace contracts are active for this provider.
              </div>
            ) : (
              contracts.map((contract) => {
                const contractId = stringValue(contract.id) ?? "";
                return (
                  <div key={contractId} className="rounded-2xl border border-ui-border bg-ui-surface/60 p-4">
                    <div className="flex flex-wrap gap-2 text-xs text-ui-muted">
                      <Badge>{labelFromKey(stringValue(contract.status) ?? "active")}</Badge>
                    </div>
                    <div className="mt-3">
                      <Link className="text-sm font-medium text-ui-ink underline-offset-4 hover:underline" href={`${appBasePath}/marketplace/contracts/${contractId}`}>
                        Open contract room
                      </Link>
                    </div>
                  </div>
                );
              })
            )}
          </div>
          <div className="grid gap-4">
            {workPackages.length === 0 ? (
              <div className="rounded-2xl border border-ui-border bg-ui-surface/60 p-4 text-sm text-ui-muted">
                No active work packages have been materialized yet.
              </div>
            ) : (
              workPackages.map((workPackage) => {
                const workPackageId = stringValue(workPackage.id) ?? "";
                return (
                  <div key={workPackageId} className="rounded-2xl border border-ui-border bg-ui-surface/60 p-4">
                    <div className="flex flex-wrap gap-2 text-xs text-ui-muted">
                      <Badge>{labelFromKey(stringValue(workPackage.status) ?? "ready")}</Badge>
                    </div>
                    <div className="mt-4">
                      <MarketplaceActionForm
                        action={completeWorkPackage}
                        submitLabel="Mark complete"
                        testIdPrefix={`${testIdPrefix}-complete-${workPackageId}`}
                        fields={[
                          { name: "work_package_id", kind: "hidden", defaultValue: workPackageId },
                          ...(hasOfferLookups ? [
                            { name: "proof_requirements", label: "Proof requirements", kind: "textarea" as const },
                            { name: "proof_quality", label: "Proof quality", defaultValue: "5", required: true },
                            { name: "feedback_score", label: "Feedback score", defaultValue: "5", required: true },
                            { name: "completion_notes", label: "Completion notes", kind: "textarea" as const },
                          ] : [
                            { name: "proof_json", label: "Proof JSON", kind: "textarea" as const, rows: 4, defaultValue: jsonTextareaValue({ proof_quality: 5, feedback_score: 5 }) },
                          ]),
                        ]}
                      />
                    </div>
                  </div>
                );
              })
            )}
          </div>
        </div>
      </Section>
    </div>
  );
}
