import "server-only";

import { revalidatePath } from "next/cache";
import { createUiServerClient } from "@masarx/api/server";
import { Badge } from "./badge";
import { ContextNotice } from "./context-notice";
import { EmptyState } from "./empty-state";
import { PageContainer } from "./page-container";
import { PageHeader } from "./page-header";
import { Section } from "./section";
import { loadPickupLookups } from "./pickup-lookups";
import { PickupMutationForm } from "./pickup-operations-form";
import type { PickupMutationFormState } from "./pickup-operations-form";
import {
  formatDateTime,
  formatDateTimeRange,
  formatPickupAddress,
  normalizeObject,
  parseJsonValue,
  stringValue,
} from "./pickup-operations-utils";
import {
  PickupPageNavigation,
  formatStatusBadge,
  loadPickupRequestRows,
  pickupErrorMessage,
  resolvePickupScopeFilters,
  renderFieldPairs,
} from "./pickup-page-shared";
import { buildTestId } from "./test-ids";
import { extractCapabilityDeniedKey, formatUiError } from "./utils";
import { hasCapability, resolveCapabilitySet } from "./capabilities";

type SearchParams = Record<string, string | string[] | undefined>;
type PickupRow = Record<string, unknown>;
type PickupUserContext = {
  org?: { id?: string | null } | null;
  access_scope?: {
    scope_type?: string | null;
    scope_id?: string | null;
  } | null;
  capabilities?: string[] | null;
  locale?: string | null;
  timezone?: string | null;
};

function resolveDeniedMessage(message: string) {
  const capability = extractCapabilityDeniedKey(message);
  if (capability) {
    return `Capability denied: ${capability}`;
  }
  return message;
}

export async function PickupRequestsPage({
  appKey,
  appBasePath,
  searchParams,
  testIdPrefix,
}: {
  appKey: "console" | "portal";
  appBasePath: string;
  searchParams: SearchParams;
  testIdPrefix: string;
}) {
  const ui = createUiServerClient();
  const meResult = await ui.me().catch(() => null);
  const me = normalizeObject(meResult) as PickupUserContext | null;
  const pickupScopeFilters = resolvePickupScopeFilters(me);
  const requestsResult = await loadPickupRequestRows<PickupRow>({
    clientId:
      pickupScopeFilters.find(([key]) => key === "client_id")?.[1] ?? null,
    senderId:
      pickupScopeFilters.find(([key]) => key === "sender_id")?.[1] ?? null,
    status: searchParams.status,
  });
  const capabilities = Array.isArray(me?.capabilities) ? me.capabilities : [];
  const canWrite = hasCapability(resolveCapabilitySet(capabilities), "shipments.write");
  let scopeClientId = pickupScopeFilters.find(([key]) => key === "client_id")?.[1];
  const scopeSenderId = pickupScopeFilters.find(([key]) => key === "sender_id")?.[1];
  let senderScopeError: string | null = null;
  if (canWrite && scopeSenderId) {
    try {
      const sender = await ui.getResource("senders", scopeSenderId);
      scopeClientId = stringValue(sender?.client_id) ?? undefined;
      if (!scopeClientId) senderScopeError = "Your sender has no visible client binding. Reload to retry.";
    } catch (error) {
      senderScopeError = formatUiError(error, "Your sender client could not be loaded. Reload to retry.");
    }
  }
  const lookups = canWrite ? await loadPickupLookups(me, "request") : null;
  const clientChoices = { options: lookups?.options.clients ?? [], error: lookups?.error ?? null };
  const senderChoices = { options: lookups?.options.senders ?? [], error: lookups?.error ?? null };
  const branchChoices = { options: lookups?.options.branches ?? [], error: lookups?.error ?? null };
  const activePath = `${appBasePath}/operations/pickups/requests`;

  async function submitPickupRequest(
    _prevState: PickupMutationFormState,
    formData: FormData,
  ): Promise<PickupMutationFormState> {
    "use server";
    const ui = createUiServerClient();
    const originAddressResult = parseJsonValue(
      String(formData.get("origin_address_json") ?? "{}"),
      {},
    );
    if (!originAddressResult.ok) {
      return { status: "error", message: originAddressResult.message };
    }
    const metadataResult = parseJsonValue(String(formData.get("metadata_json") ?? "{}"), {});
    if (!metadataResult.ok) {
      return { status: "error", message: metadataResult.message };
    }
    const parsedBoxCount = Number.parseInt(
      String(formData.get("box_count") ?? "1").trim() || "1",
      10,
    );

    const payload = {
      organization_id: String(formData.get("organization_id") ?? "").trim(),
      client_id: String(formData.get("client_id") ?? "").trim(),
      sender_id: String(formData.get("sender_id") ?? "").trim() || null,
      branch_id: String(formData.get("branch_id") ?? "").trim() || null,
      requested_window_start_at: String(formData.get("requested_window_start_at") ?? "").trim(),
      requested_window_end_at: String(formData.get("requested_window_end_at") ?? "").trim(),
      box_count: Number.isFinite(parsedBoxCount) && parsedBoxCount > 0 ? parsedBoxCount : 1,
      tracking_number: String(formData.get("tracking_number") ?? "").trim() || null,
      client_reference_number: String(formData.get("client_reference_number") ?? "").trim() || null,
      carrier_reference_number: String(formData.get("carrier_reference_number") ?? "").trim() || null,
      origin_address: normalizeObject(originAddressResult.value) ?? {},
      metadata: {
        source: `${appKey}.operations.pickups.requests.create`,
        ...(normalizeObject(metadataResult.value) ?? {}),
      },
    };

    try {
      const result = await ui.rpc("create_pickup_request_v1", {
        p_input: payload,
      });
      revalidatePath(activePath);
      revalidatePath(`${appBasePath}/operations/pickups/waves`);
      return {
        status: "success",
        message: `Pickup request ${stringValue((result as PickupRow)?.tracking_number) ?? "created"}.`,
      };
    } catch (error) {
      return {
        status: "error",
        message: formatUiError(error, "Pickup request creation failed."),
      };
    }
  }

  if (requestsResult.error) {
    return (
      <PageContainer className="space-y-6" data-testid={`${testIdPrefix}-ready`}>
        <PageHeader
          eyebrow="Operations / Pickup"
          title="Pickup requests"
          description="Capture first-mile pickup requests and review the canonical request ledger."
          actions={
            <div className="flex flex-wrap gap-2">
              <PickupPageNavigation appBasePath={appBasePath} activePath={activePath} />
            </div>
          }
        />
        <ContextNotice
          title="Pickup requests unavailable"
          action="Check the pickup request view and database read permissions."
          detail={pickupErrorMessage(requestsResult.error, "Unable to load pickup requests.")}
          testId={buildTestId(testIdPrefix, "error")}
        />
      </PageContainer>
    );
  }

  return (
    <PageContainer className="space-y-6" data-testid={`${testIdPrefix}-ready`}>
      <PageHeader
        eyebrow="Operations / Pickup"
        title="Pickup requests"
        description="Capture pickup requests, keep the requested window explicit, and read the live request ledger from the pickup_requests view."
        actions={
          <div className="flex flex-wrap gap-2">
            <PickupPageNavigation appBasePath={appBasePath} activePath={activePath} />
          </div>
        }
      />

      <Section title="Create pickup request" collapsible={false}>
        {senderScopeError || clientChoices.error || senderChoices.error || branchChoices.error ? (
          <ContextNotice title="Pickup choices unavailable" action="Reload to retry; your saved requests are unchanged."
            detail={senderScopeError || clientChoices.error || senderChoices.error || branchChoices.error || ""}
            testId={`${testIdPrefix}-lookup-error`} />
        ) : null}
        {!canWrite ? (
          <ContextNotice
            title="Pickup request creation is blocked"
            action="You can still review the pickup request ledger below."
            detail={resolveDeniedMessage(
              me ? "Capability denied: shipments.write" : "Your session could not be loaded.",
            )}
            testId={`${testIdPrefix}-blocked`}
          />
        ) : (
          <PickupMutationForm
            action={submitPickupRequest}
            submitLabel="Create pickup request"
            pendingLabel="Creating..."
            testIdPrefix={`${testIdPrefix}-create`}
            helperText="The form accepts structured pickup address data and optional idempotency metadata."
            fields={[
              {
                name: "organization_id",
                label: "Organization ID",
                kind: "text",
                defaultValue: stringValue(me?.org?.id) ?? "",
                required: true,
              },
              ...(scopeClientId ? [{ name: "client_id", kind: "hidden" as const, defaultValue: scopeClientId }]
                : [{ name: "client_id", label: "Client", kind: "relation" as const, required: true,
                    options: clientChoices.options.filter((option) => option.groupValue === stringValue(me?.org?.id)) }]),
              ...(scopeSenderId ? [{ name: "sender_id", kind: "hidden" as const, defaultValue: scopeSenderId }]
                : [{ name: "sender_id", label: "Sender", kind: "relation" as const, options: senderChoices.options,
                  ...(scopeClientId ? {} : { dependsOn: "client_id" }) }]),
              { name: "branch_id", label: "Branch", kind: "relation", options: branchChoices.options },
              {
                name: "requested_window_start_at",
                label: "Requested window start",
                kind: "datetime-local",
                required: true,
              },
              {
                name: "requested_window_end_at",
                label: "Requested window end",
                kind: "datetime-local",
                required: true,
              },
              {
                name: "box_count",
                label: "Box count",
                kind: "number",
                defaultValue: 1,
                min: 1,
              },
              {
                name: "tracking_number",
                label: "Tracking number",
                kind: "text",
                placeholder: "Optional tracking number",
              },
              {
                name: "client_reference_number",
                label: "Client reference number",
                kind: "text",
              },
              {
                name: "carrier_reference_number",
                label: "Carrier reference number",
                kind: "text",
              },
              {
                name: "origin_address_json",
                label: "Origin address JSON",
                kind: "textarea",
                layout: "full",
                rows: 8,
                required: true,
                defaultValue: JSON.stringify(
                  {
                    raw_input: "",
                    line1: "",
                    line2: "",
                    district: "",
                    city: "",
                    province: "",
                    postal_code: "",
                    country: "",
                    building_number: "",
                    additional_directions: "",
                  },
                  null,
                  2,
                ),
                helpText:
                  "Keep the payload dynamic. The pickup contract stores the address object exactly as submitted.",
              },
              {
                name: "metadata_json",
                label: "Metadata JSON",
                kind: "textarea",
                layout: "full",
                rows: 4,
                defaultValue: "{\n  \"source\": \"console.operations.pickups.requests.create\"\n}",
              },
            ]}
          />
        )}
      </Section>

      <Section
        title="Pickup request ledger"
        description={`Loaded from pickup_requests. ${requestsResult.rows.length} row(s) on this page.`}
        collapsible={false}
      >
        {requestsResult.rows.length === 0 ? (
          <EmptyState
            variant="card"
            title="No pickup requests yet"
            description="Create the first pickup request to seed the ledger."
          />
        ) : (
          <div className="grid gap-4 lg:grid-cols-2">
            {requestsResult.rows.map((row) => {
              const shipmentId = stringValue(row.shipment_id) ?? "shipment";
              const pickupRequest = normalizeObject(row.pickup_request);
              const originAddress = normalizeObject(row.origin_address) ?? {
                line1: row.origin_line1,
                line2: row.origin_line2,
                city: row.origin_city,
                province: row.origin_province,
                country: row.origin_country,
                additional_directions: row.origin_additional_directions,
              };
              return (
                <article
                  key={shipmentId}
                  className="rounded-2xl border border-ui-border bg-ui-surface/60 p-4 shadow-sm"
                >
                  <div className="flex flex-wrap items-center gap-2">
                    {formatStatusBadge(stringValue(row.status))}
                    {stringValue(row.tracking_number) ? (
                      <Badge>{stringValue(row.tracking_number) ?? ""}</Badge>
                    ) : null}
                    {stringValue(row.route_run_status) ? (
                      <Badge tone="info">{stringValue(row.route_run_status) ?? ""}</Badge>
                    ) : null}
                  </div>
                  <div className="mt-3 text-sm font-medium text-ui-ink">
                    {stringValue(row.client_reference_number) ??
                      stringValue(row.carrier_reference_number) ??
                      shipmentId}
                  </div>
                  <div className="mt-2 text-sm text-ui-muted">
                    {formatPickupAddress(originAddress) ?? "No origin address captured."}
                  </div>
                  <div className="mt-3 text-xs text-ui-muted">
                    {formatDateTimeRange(
                      row.requested_window_start_at,
                      row.requested_window_end_at,
                      me?.locale,
                      me?.timezone,
                    ) ?? "No requested window."}
                  </div>
                  <div className="mt-3">
                    {renderFieldPairs([
                      ["Client", stringValue(row.client_label) ?? stringValue(row.client_id)],
                      ["Sender", stringValue(row.sender_label) ?? stringValue(row.sender_id)],
                      ["Branch", stringValue(row.branch_label)],
                      ["Box count", row.box_count],
                      ["Route run", stringValue(row.route_run_id)],
                      ["Planned date", formatDateTime(row.planned_date, me?.locale, me?.timezone)],
                      ["Driver", stringValue(row.driver_label) ?? stringValue(row.driver_user_id)],
                      ["Vehicle", stringValue(row.vehicle_label) ?? stringValue(row.vehicle_id)],
                      ["Failed at", formatDateTime(row.failed_at, me?.locale, me?.timezone)],
                      ["Failure reason", stringValue(row.failure_reason)],
                    ])}
                  </div>
                  {pickupRequest ? (
                    <div className="mt-3">
                      <pre className="overflow-x-auto rounded-xl border border-ui-border bg-ui-surface/70 p-3 text-xs text-ui-muted">
                        {JSON.stringify(pickupRequest, null, 2)}
                      </pre>
                    </div>
                  ) : null}
                </article>
              );
            })}
          </div>
        )}
      </Section>
    </PageContainer>
  );
}
