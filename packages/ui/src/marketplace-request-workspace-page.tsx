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
  marketplaceOrganizationLabel,
  normalizeArray,
  normalizeObject,
  parseJsonValue,
  stringValue,
} from "./marketplace-page-utils";
import { labelFromKey } from "./resource-query";
import { formatReferenceValue } from "./resource-utils";
import { formatUiError } from "./utils";

type MarketplaceRequestWorkspacePageProps = {
  appBasePath: string;
  requestsHref: string;
  requestId: string;
  testIdPrefix: string;
  actionSourcePrefix?: string;
};

function renderJson(value: unknown) {
  return (
    <pre className="overflow-x-auto rounded-xl border border-ui-border bg-ui-surface/60 p-3 text-xs text-ui-muted">
      {JSON.stringify(value ?? {}, null, 2)}
    </pre>
  );
}

function friendlyLabel(value: unknown) {
  const raw = stringValue(value);
  return raw ? labelFromKey(raw) : null;
}

type LookupOption = { value: string; label: string; isDefault: boolean };

function normalizeLookupOptions(value: unknown): LookupOption[] {
  if (!Array.isArray(value)) return [];
  const options: LookupOption[] = [];
  const seen = new Set<string>();
  for (const entry of value) {
    const record = normalizeObject(entry);
    const optionValue = stringValue(record?.value);
    if (!optionValue || seen.has(optionValue)) continue;
    seen.add(optionValue);
    options.push({
      value: optionValue,
      label: stringValue(record?.label) ?? friendlyLabel(optionValue) ?? optionValue,
      isDefault: Boolean(record?.is_default),
    });
  }
  return options;
}

function resolveLookupLabel(options: LookupOption[], value: unknown) {
  const normalized = stringValue(value);
  if (!normalized) return null;
  return options.find((option) => option.value === normalized)?.label ?? friendlyLabel(normalized);
}

function buildReleaseStateOptions(options: LookupOption[], currentValue: string | null) {
  if (!currentValue || options.some((option) => option.value === currentValue)) {
    return options;
  }
  return [
    {
      value: currentValue,
      label: resolveLookupLabel(options, currentValue) ?? currentValue,
      isDefault: options.length === 0,
    },
    ...options,
  ];
}

function resolveReleaseStateValue(options: LookupOption[], currentValue: string | null) {
  if (currentValue) return currentValue;
  return options.find((option) => option.isDefault)?.value ?? options[0]?.value ?? "";
}

function supplierLabel(row: Record<string, unknown>) {
  return marketplaceOrganizationLabel(
    row.supplier_display_name, row.supplier_organization_name, row.supplier_organization_slug,
  );
}

function workPackageLabel(row: Record<string, unknown>) {
  const summary = normalizeObject(row.summary);
  const title = stringValue(row.label ?? row.title) ?? stringValue(summary?.title ?? summary?.label);
  const id = stringValue(row.id);
  return title ?? (id ? "Work Package " + formatReferenceValue(id) : "Work Package");
}

export async function MarketplaceRequestWorkspacePage({
  appBasePath,
  requestsHref,
  requestId,
  testIdPrefix,
  actionSourcePrefix = "portal.marketplace.request_workspace",
}: MarketplaceRequestWorkspacePageProps) {
  const ui = createUiServerClient();
  const [workspace, releaseStateLookupRows] = await Promise.all([
    ui.marketplaceRequestWorkspace({ requestId }).catch(() => null),
    ui.listLookupValues("marketplace_request_release_state").catch(() => []),
  ]);
  const workspaceRecord = normalizeObject(workspace);
  const workspaceError = normalizeObject(workspaceRecord?.error);
  const request = normalizeObject(workspaceRecord?.request);
  const requestKind = normalizeObject(workspaceRecord?.request_kind);
  const offers = normalizeArray(workspaceRecord?.offers);
  const contracts = normalizeArray(workspaceRecord?.contracts);
  const workPackages = normalizeArray(workspaceRecord?.work_packages);
  const disputes = normalizeArray(workspaceRecord?.disputes);
  const privatePool = normalizeArray(workspaceRecord?.private_pool_memberships);

  async function releaseRequest(
    _prevState: MarketplaceActionFormState,
    formData: FormData,
  ): Promise<MarketplaceActionFormState> {
    "use server";
    const releaseState = String(formData.get("release_state") ?? "").trim();
    try {
      const result = await createUiServerClient().marketplaceRequestRelease({
        requestId,
        releaseState,
        metadata: { source: `${actionSourcePrefix}.release` },
      });
      if (result.ok === false) {
        const error = normalizeObject(result.error);
        return {
          status: "error",
          message: stringValue(error?.message) ?? stringValue(error?.code) ?? "Release failed.",
        };
      }
    } catch (error) {
      return { status: "error", message: formatUiError(error, "Release failed.") };
    }
    revalidatePath(requestsHref);
    return { status: "success", message: `Release updated to ${releaseState}.` };
  }

  async function counterOffer(
    _prevState: MarketplaceActionFormState,
    formData: FormData,
  ): Promise<MarketplaceActionFormState> {
    "use server";
    const offerId = String(formData.get("offer_id") ?? "").trim();
    const termsResult = parseJsonValue(String(formData.get("terms_json") ?? "{}"), {});
    if (!termsResult.ok) return { status: "error", message: termsResult.message };
    const pricingResult = parseJsonValue(String(formData.get("pricing_json") ?? "{}"), {});
    if (!pricingResult.ok) return { status: "error", message: pricingResult.message };
    try {
      const result = await createUiServerClient().marketplaceOfferCounter({
        offerId,
        message: String(formData.get("message") ?? "").trim() || null,
        terms: normalizeObject(termsResult.value) ?? {},
        pricing: normalizeObject(pricingResult.value) ?? {},
        metadata: { source: `${actionSourcePrefix}.counter` },
      });
      if (result.ok === false) {
        const error = normalizeObject(result.error);
        return {
          status: "error",
          message: stringValue(error?.message) ?? stringValue(error?.code) ?? "Counter offer failed.",
        };
      }
    } catch (error) {
      return { status: "error", message: formatUiError(error, "Counter offer failed.") };
    }
    return { status: "success", message: "Counter offer submitted." };
  }

  async function awardOffer(
    _prevState: MarketplaceActionFormState,
    formData: FormData,
  ): Promise<MarketplaceActionFormState> {
    "use server";
    const offerId = String(formData.get("offer_id") ?? "").trim();
    const termsResult = parseJsonValue(String(formData.get("award_terms_json") ?? "{}"), {});
    if (!termsResult.ok) return { status: "error", message: termsResult.message };
    try {
      const result = await createUiServerClient().marketplaceAwardOffer({
        offerId,
        awardReason: String(formData.get("award_reason") ?? "").trim() || null,
        awardTerms: normalizeObject(termsResult.value) ?? {},
        metadata: { source: `${actionSourcePrefix}.award` },
      });
      if (result.ok === false) {
        const error = normalizeObject(result.error);
        return {
          status: "error",
          message: stringValue(error?.message) ?? stringValue(error?.code) ?? "Award failed.",
        };
      }
    } catch (error) {
      return { status: "error", message: formatUiError(error, "Award failed.") };
    }
    revalidatePath(`${appBasePath}/marketplace/contracts`);
    return { status: "success", message: "Offer awarded." };
  }

  if (!workspaceRecord || workspaceRecord.ok === false || !request) {
    return (
      <div className="space-y-6" data-testid={`${testIdPrefix}-ready`}>
        <PageHeader
          title="Marketplace request"
          description="The request workspace could not be loaded for this user and request."
        />
        <Section title="Unavailable" collapsible={false}>
          <div className="rounded-2xl border border-ui-border bg-ui-surface/80 p-4 text-sm text-ui-muted">
            {stringValue(workspaceError?.message) ?? stringValue(workspaceError?.code) ?? "Request workspace unavailable."}
          </div>
        </Section>
      </div>
    );
  }

  const title = stringValue(request.title) ?? requestId;
  const status = friendlyLabel(request.status) ?? "Unknown";
  const releaseStateLookupOptions = buildReleaseStateOptions(
    normalizeLookupOptions(releaseStateLookupRows),
    stringValue(request.release_state),
  );
  const releaseState = resolveReleaseStateValue(
    releaseStateLookupOptions,
    stringValue(request.release_state),
  );
  const releaseStateLabel = resolveLookupLabel(releaseStateLookupOptions, releaseState);
  const requestKindLabel = stringValue(requestKind?.label) ?? friendlyLabel(request.request_kind_key);

  return (
    <div className="space-y-6" data-testid={`${testIdPrefix}-ready`}>
      <PageHeader
        title={title}
        description="Offer comparison, release controls, contracts, and execution all stay on the canonical marketplace request."
      />

      <Section title="Request overview" collapsible={false}>
        <div className="flex flex-wrap gap-2 text-xs text-ui-muted">
          <Badge>{status}</Badge>
          {requestKindLabel ? <Badge>{requestKindLabel}</Badge> : null}
          {releaseStateLabel ? <Badge>{releaseStateLabel}</Badge> : null}
        </div>
        <div className="mt-4 grid gap-4 lg:grid-cols-2">
          <div className="space-y-3">
            <div className="text-sm text-ui-muted">{stringValue(request.summary) ?? "No summary recorded."}</div>
            {renderJson(request.request_details)}
          </div>
          <MarketplaceActionForm
            action={releaseRequest}
            submitLabel="Update release"
            testIdPrefix={`${testIdPrefix}-release`}
            fields={[
              {
                name: "release_state",
                label: "Release state",
                kind: "select",
                defaultValue: releaseState,
                options: releaseStateLookupOptions.map(({ label, value }) => ({ label, value })),
              },
            ]}
          />
        </div>
      </Section>

      <Section title="Private pool" collapsible={false}>
        {privatePool.length === 0 ? (
          <div className="text-sm text-ui-muted">No private-pool members are configured for this request.</div>
        ) : (
          <div className="grid gap-3 md:grid-cols-2">
            {privatePool.map((entry) => (
              <div key={`${requestId}-${stringValue(entry.supplier_organization_id) ?? "pool"}`} className="rounded-2xl border border-ui-border bg-ui-surface/60 p-4 text-sm text-ui-muted">
                <div className="font-medium text-ui-ink">Supplier organization</div>
                <div>{supplierLabel(entry) ?? "Unknown supplier"}</div>
              </div>
            ))}
          </div>
        )}
      </Section>

      <Section title="Offers" collapsible={false}>
        {offers.length === 0 ? (
          <div className="text-sm text-ui-muted">No offers have been submitted yet.</div>
        ) : (
          <div className="grid gap-4">
            {offers.map((offer) => {
              const offerId = stringValue(offer.id) ?? "offer";
              const supplier = supplierLabel(offer);
              return (
                <div key={offerId} className="grid gap-4 rounded-2xl border border-ui-border bg-ui-surface/60 p-4 lg:grid-cols-[1.1fr,0.9fr,0.9fr]">
                  <div className="space-y-3">
                    <div className="flex flex-wrap gap-2 text-xs text-ui-muted">
                      <Badge>{friendlyLabel(offer.status) ?? "submitted"}</Badge>
                      {supplier ? <Badge>{supplier}</Badge> : null}
                    </div>
                    <div className="text-sm text-ui-muted">{stringValue(offer.message) ?? "No offer message provided."}</div>
                    {renderJson(offer.pricing)}
                  </div>
                  <MarketplaceActionForm
                    action={counterOffer}
                    submitLabel="Counter offer"
                    testIdPrefix={`${testIdPrefix}-counter-${offerId}`}
                    fields={[
                      { name: "offer_id", kind: "hidden", defaultValue: offerId },
                      { name: "message", label: "Message", kind: "textarea", rows: 3, placeholder: "Counter terms" },
                      { name: "terms_json", label: "Terms JSON", kind: "textarea", rows: 4, defaultValue: jsonTextareaValue(offer.terms) },
                      { name: "pricing_json", label: "Pricing JSON", kind: "textarea", rows: 4, defaultValue: jsonTextareaValue(offer.pricing) },
                    ]}
                  />
                  <MarketplaceActionForm
                    action={awardOffer}
                    submitLabel="Award offer"
                    testIdPrefix={`${testIdPrefix}-award-${offerId}`}
                    fields={[
                      { name: "offer_id", kind: "hidden", defaultValue: offerId },
                      { name: "award_reason", label: "Award reason", placeholder: "Best SLA / preferred provider" },
                      { name: "award_terms_json", label: "Award terms JSON", kind: "textarea", rows: 4, defaultValue: jsonTextareaValue(offer.terms) },
                    ]}
                  />
                </div>
              );
            })}
          </div>
        )}
      </Section>

      <Section title="Contracts and execution" collapsible={false}>
        <div className="grid gap-4 lg:grid-cols-2">
          <div className="space-y-3">
            <div className="text-xs uppercase tracking-wide text-ui-muted">Contracts</div>
            {contracts.length === 0 ? (
              <div className="text-sm text-ui-muted">No contracts exist yet.</div>
            ) : (
              contracts.map((contract) => {
                const contractId = stringValue(contract.id) ?? "";
                return (
                  <div key={contractId} className="rounded-2xl border border-ui-border bg-ui-surface/60 p-4">
                    <div className="flex flex-wrap gap-2 text-xs text-ui-muted">
                      <Badge>{friendlyLabel(contract.status) ?? "pending"}</Badge>
                      {friendlyLabel(contract.settlement_mode_key) ? <Badge>{friendlyLabel(contract.settlement_mode_key)}</Badge> : null}
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
          <div className="space-y-3">
            <div className="text-xs uppercase tracking-wide text-ui-muted">Work packages</div>
            {workPackages.length === 0 ? (
              <div className="text-sm text-ui-muted">No work packages have been generated yet.</div>
            ) : (
              workPackages.map((workPackage) => (
                <div key={stringValue(workPackage.id) ?? "wp"} className="rounded-2xl border border-ui-border bg-ui-surface/60 p-4 text-sm text-ui-muted">
                  <div className="flex flex-wrap gap-2 text-xs text-ui-muted">
                    <Badge>{friendlyLabel(workPackage.status) ?? "unknown"}</Badge>
                    {friendlyLabel(workPackage.materializer_key) ? <Badge>{friendlyLabel(workPackage.materializer_key)}</Badge> : null}
                  </div>
                  <div className="mt-3">{workPackageLabel(workPackage)}</div>
                </div>
              ))
            )}
          </div>
        </div>
      </Section>

      <Section title="Disputes" collapsible={false}>
        {disputes.length === 0 ? (
          <div className="text-sm text-ui-muted">No disputes are attached to this request.</div>
        ) : (
          <div className="grid gap-3 md:grid-cols-2">
            {disputes.map((dispute) => (
              <div key={stringValue(dispute.id) ?? "dispute"} className="rounded-2xl border border-ui-border bg-ui-surface/60 p-4 text-sm text-ui-muted">
                <div className="flex flex-wrap gap-2 text-xs text-ui-muted">
                  <Badge>{friendlyLabel(dispute.status) ?? "open"}</Badge>
                  {friendlyLabel(dispute.category) ? <Badge>{friendlyLabel(dispute.category)}</Badge> : null}
                </div>
                <div className="mt-3 font-medium text-ui-ink">{stringValue(dispute.title) ?? "Untitled dispute"}</div>
                <div className="mt-2">{stringValue(dispute.description) ?? "No dispute description recorded."}</div>
              </div>
            ))}
          </div>
        )}
      </Section>
    </div>
  );
}
