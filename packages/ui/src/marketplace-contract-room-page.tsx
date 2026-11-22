import "server-only";

import { revalidatePath } from "next/cache";
import { createUiServerClient } from "@masarx/api/server";
import { Badge } from "./badge";
import { resolveLookupOptionLabel } from "./lookup-friendly-label";
import { PageHeader } from "./page-header";
import { Section } from "./section";
import { MarketplaceActionForm, MarketplaceActionFormState } from "./marketplace-action-form";
import { normalizeArray, normalizeObject, stringValue } from "./marketplace-page-utils";
import { formatReferenceValue } from "./resource-utils";
import { formatUiError } from "./utils";

type MarketplaceContractRoomPageProps = {
  appBasePath: string;
  contractId: string;
  contractsHref: string;
  testIdPrefix: string;
};

function renderJson(value: unknown) {
  return (
    <pre className="overflow-x-auto rounded-xl border border-ui-border bg-ui-surface/60 p-3 text-xs text-ui-muted">
      {JSON.stringify(value ?? {}, null, 2)}
    </pre>
  );
}

export async function MarketplaceContractRoomPage({
  appBasePath,
  contractId,
  contractsHref,
  testIdPrefix,
}: MarketplaceContractRoomPageProps) {
  const ui = createUiServerClient();
  const room = await ui.marketplaceContractRoom({ contractId }).catch(() => null);
  const roomRecord = normalizeObject(room);
  const roomError = normalizeObject(roomRecord?.error);
  const contract = normalizeObject(roomRecord?.contract);
  const request = normalizeObject(roomRecord?.request);
  const award = normalizeObject(roomRecord?.award);
  const offer = normalizeObject(roomRecord?.offer);
  const workPackages = normalizeArray(roomRecord?.work_packages);
  const disputes = normalizeArray(roomRecord?.disputes);
  const settlements = normalizeArray(roomRecord?.settlements);
  const financeEvents = normalizeArray(roomRecord?.finance_events);

  async function openDispute(
    _prevState: MarketplaceActionFormState,
    formData: FormData,
  ): Promise<MarketplaceActionFormState> {
    "use server";
    try {
      const result = await createUiServerClient().marketplaceOpenDispute({
        contractId,
        workPackageId: String(formData.get("work_package_id") ?? "").trim() || null,
        title: String(formData.get("title") ?? "").trim() || null,
        description: String(formData.get("description") ?? "").trim() || null,
        category: String(formData.get("category") ?? "").trim() || "general",
        metadata: { source: "portal.marketplace.contract_room.dispute" },
      });
      if (result.ok === false) {
        const error = normalizeObject(result.error);
        return {
          status: "error",
          message: stringValue(error?.message) ?? stringValue(error?.code) ?? "Dispute creation failed.",
        };
      }
    } catch (error) {
      return { status: "error", message: formatUiError(error, "Dispute creation failed.") };
    }
    return { status: "success", message: "Dispute opened." };
  }

  async function finalizeSettlement(
    _prevState: MarketplaceActionFormState,
    formData: FormData,
  ): Promise<MarketplaceActionFormState> {
    "use server";
    try {
      const result = await createUiServerClient().marketplaceSettlementFinalize({
        contractId,
        workPackageId: String(formData.get("work_package_id") ?? "").trim() || null,
        metadata: { source: "portal.marketplace.contract_room.finalize" },
      });
      if (result.ok === false) {
        const error = normalizeObject(result.error);
        return {
          status: "error",
          message: stringValue(error?.message) ?? stringValue(error?.code) ?? "Settlement finalization failed.",
        };
      }
    } catch (error) {
      return { status: "error", message: formatUiError(error, "Settlement finalization failed.") };
    }
    revalidatePath(contractsHref);
    return { status: "success", message: "Settlement finalized." };
  }

  async function reverseSettlement(
    _prevState: MarketplaceActionFormState,
    formData: FormData,
  ): Promise<MarketplaceActionFormState> {
    "use server";
    try {
      const result = await createUiServerClient().marketplaceSettlementReverse({
        workPackageId: String(formData.get("work_package_id") ?? "").trim(),
        reason: String(formData.get("reason") ?? "").trim() || null,
        metadata: { source: "portal.marketplace.contract_room.reverse" },
      });
      if (result.ok === false) {
        const error = normalizeObject(result.error);
        return {
          status: "error",
          message: stringValue(error?.message) ?? stringValue(error?.code) ?? "Settlement reversal failed.",
        };
      }
    } catch (error) {
      return { status: "error", message: formatUiError(error, "Settlement reversal failed.") };
    }
    return { status: "success", message: "Settlement reversal recorded." };
  }

  if (!roomRecord || roomRecord.ok === false || !contract) {
    return (
      <div className="space-y-6" data-testid={`${testIdPrefix}-ready`}>
        <PageHeader
          title="Marketplace contract room"
          description="The contract room could not be loaded for this contract."
        />
        <Section title="Unavailable" collapsible={false}>
          <div className="rounded-2xl border border-ui-border bg-ui-surface/80 p-4 text-sm text-ui-muted">
            {stringValue(roomError?.message) ?? stringValue(roomError?.code) ?? "Contract room unavailable."}
          </div>
        </Section>
      </div>
    );
  }

  return (
    <div className="space-y-6" data-testid={`${testIdPrefix}-ready`}>
      <PageHeader
        title={stringValue(request?.title) ?? contractId}
        description="Commercial terms, disputes, settlement, and work-package evidence stay attached to the canonical marketplace contract."
      />

      <Section title="Contract summary" collapsible={false}>
        <div className="flex flex-wrap gap-2 text-xs text-ui-muted">
          <Badge>{stringValue(contract.status) ?? "active"}</Badge>
          {stringValue(contract.ownership_mode_key) ? <Badge>{stringValue(contract.ownership_mode_key)}</Badge> : null}
          {stringValue(contract.settlement_mode_key) ? <Badge>{stringValue(contract.settlement_mode_key)}</Badge> : null}
        </div>
        <div className="mt-4 grid gap-4 lg:grid-cols-2">
          <div className="space-y-3">
            <div className="text-sm text-ui-muted">{stringValue(award?.award_reason) ?? "No award reason provided."}</div>
            {renderJson(offer?.pricing)}
          </div>
          <div className="space-y-3">{renderJson(contract.terms)}</div>
        </div>
      </Section>

      <Section title="Work packages and settlement actions" collapsible={false}>
        {workPackages.length === 0 ? (
          <div className="text-sm text-ui-muted">No work packages exist for this contract.</div>
        ) : (
          <div className="grid gap-4">
            {workPackages.map((workPackage) => {
              const workPackageId = stringValue(workPackage.id) ?? "";
              return (
                <div key={workPackageId} className="grid gap-4 rounded-2xl border border-ui-border bg-ui-surface/60 p-4 lg:grid-cols-[1fr,0.8fr,0.8fr]">
                  <div className="space-y-3">
                    <div className="flex flex-wrap gap-2 text-xs text-ui-muted">
                      <Badge>{resolveLookupOptionLabel(workPackage.status, workPackage.status_label) || "Ready"}</Badge>
                      {stringValue(workPackage.materializer_key) ? <Badge>{resolveLookupOptionLabel(workPackage.materializer_key, workPackage.materializer_label)}</Badge> : null}
                    </div>
                    {renderJson(workPackage.summary)}
                  </div>
                  <MarketplaceActionForm
                    action={finalizeSettlement}
                    submitLabel="Finalize settlement"
                    testIdPrefix={`${testIdPrefix}-finalize-${workPackageId}`}
                    fields={[{ name: "work_package_id", kind: "hidden", defaultValue: workPackageId }]}
                  />
                  <MarketplaceActionForm
                    action={reverseSettlement}
                    submitLabel="Reverse settlement"
                    testIdPrefix={`${testIdPrefix}-reverse-${workPackageId}`}
                    fields={[
                      { name: "work_package_id", kind: "hidden", defaultValue: workPackageId },
                      { name: "reason", label: "Reason", kind: "textarea", rows: 3, placeholder: "Reason for reversing the settlement state" },
                    ]}
                  />
                </div>
              );
            })}
          </div>
        )}
      </Section>

      <Section title="Disputes" collapsible={false}>
        <div className="grid gap-4 lg:grid-cols-[1fr,0.9fr]">
          <div className="grid gap-3">
            {disputes.length === 0 ? (
              <div className="rounded-2xl border border-ui-border bg-ui-surface/60 p-4 text-sm text-ui-muted">
                No disputes are attached to this contract.
              </div>
            ) : (
              disputes.map((dispute) => (
                <div key={stringValue(dispute.id) ?? "dispute"} className="rounded-2xl border border-ui-border bg-ui-surface/60 p-4 text-sm text-ui-muted">
                  <div className="flex flex-wrap gap-2 text-xs text-ui-muted">
                    <Badge>{stringValue(dispute.status) ?? "open"}</Badge>
                    {stringValue(dispute.category) ? <Badge>{stringValue(dispute.category)}</Badge> : null}
                  </div>
                  <div className="mt-3 font-medium text-ui-ink">{stringValue(dispute.title) ?? "Untitled dispute"}</div>
                  <div className="mt-2">{stringValue(dispute.description) ?? "No dispute description recorded."}</div>
                </div>
              ))
            )}
          </div>
          <MarketplaceActionForm
            action={openDispute}
            submitLabel="Open dispute"
            testIdPrefix={`${testIdPrefix}-dispute`}
            fields={[
              { name: "work_package_id", kind: "hidden", defaultValue: stringValue(workPackages[0]?.id) ?? "" },
              { name: "title", label: "Title", placeholder: "Proof, pricing, or SLA issue" },
              {
                name: "category",
                label: "Category",
                kind: "select",
                defaultValue: "general",
                options: [
                  { label: "General", value: "general" },
                  { label: "Proof", value: "proof" },
                  { label: "Capacity", value: "capacity" },
                  { label: "Pricing", value: "pricing" },
                ],
              },
              { name: "description", label: "Description", kind: "textarea", rows: 5, placeholder: "What happened, what evidence exists, and what outcome is requested?" },
            ]}
          />
        </div>
      </Section>

      <Section title="Settlement ledger" collapsible={false}>
        <div className="grid gap-4 lg:grid-cols-2">
          <div className="space-y-3">
            <div className="text-xs uppercase tracking-wide text-ui-muted">Settlement batches</div>
            {settlements.length === 0 ? (
              <div className="text-sm text-ui-muted">No settlement batches exist yet.</div>
            ) : (
              settlements.map((settlement) => (
                <div key={stringValue(settlement.id) ?? "settlement"} className="rounded-2xl border border-ui-border bg-ui-surface/60 p-4 text-sm text-ui-muted">
                  <div className="flex flex-wrap gap-2 text-xs text-ui-muted">
                    <Badge>{stringValue(settlement.status) ?? "posted"}</Badge>
                    {stringValue(settlement.kind) ? <Badge>{stringValue(settlement.kind)}</Badge> : null}
                  </div>
                  <div className="mt-3">
                    {stringValue(settlement.organization_name) ??
                      (stringValue(settlement.organization_id)
                        ? formatReferenceValue(stringValue(settlement.organization_id)!)
                        : "")}
                  </div>
                </div>
              ))
            )}
          </div>
          <div className="space-y-3">
            <div className="text-xs uppercase tracking-wide text-ui-muted">Finance events</div>
            {financeEvents.length === 0 ? (
              <div className="text-sm text-ui-muted">No finance events exist yet.</div>
            ) : (
              financeEvents.map((event) => (
                <div key={stringValue(event.id) ?? "finance"} className="rounded-2xl border border-ui-border bg-ui-surface/60 p-4">
                  {renderJson(event)}
                </div>
              ))
            )}
          </div>
        </div>
      </Section>
    </div>
  );
}
