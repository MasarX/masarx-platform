import "server-only";

import { revalidatePath } from "next/cache";
import { createUiServerClient } from "@masarx/api/server";
import { Badge } from "./badge";
import { ContextNotice } from "./context-notice";
import { EmptyState } from "./empty-state";
import { PageContainer } from "./page-container";
import { PageHeader } from "./page-header";
import { Section } from "./section";
import { PickupMutationForm } from "./pickup-operations-form";
import type { PickupMutationFormState } from "./pickup-operations-form";
import {
  formatDateTime,
  formatDateTimeRange,
  normalizeObject,
  parseJsonValue,
  parsePickupIdList,
  stringValue,
} from "./pickup-operations-utils";
import {
  PickupPageNavigation,
  formatStatusBadge,
  loadPickupWaveRows,
  pickupErrorMessage,
  recordValue,
  resolvePickupScopeFilters,
  renderFieldPairs,
} from "./pickup-page-shared";
import { buildTestId } from "./test-ids";
import { extractCapabilityDeniedKey, formatUiError } from "./utils";
import { hasCapability, resolveCapabilitySet } from "./capabilities";

type SearchParams = Record<string, string | string[] | undefined>;
type PickupWaveRow = Record<string, unknown>;
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

export async function PickupWavesPage({
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
  const scopeFilters = resolvePickupScopeFilters(me);
  const wavesResult = await loadPickupWaveRows<PickupWaveRow>({
    status: searchParams.status,
  });
  const capabilities = Array.isArray(me?.capabilities) ? me.capabilities : [];
  const canWrite = hasCapability(resolveCapabilitySet(capabilities), "fleet.write");
  const activePath = `${appBasePath}/operations/pickups/waves`;

  async function submitPickupWave(
    _prevState: PickupMutationFormState,
    formData: FormData,
  ): Promise<PickupMutationFormState> {
    "use server";
    const ui = createUiServerClient();
    const shipmentIds = parsePickupIdList(String(formData.get("shipment_ids") ?? ""));
    if (shipmentIds.length === 0) {
      return { status: "error", message: "Provide at least one shipment id." };
    }

    const metadataResult = parseJsonValue(String(formData.get("metadata_json") ?? "{}"), {});
    if (!metadataResult.ok) {
      return { status: "error", message: metadataResult.message };
    }

    const payload = {
      organization_id: String(formData.get("organization_id") ?? "").trim(),
      branch_id: String(formData.get("branch_id") ?? "").trim() || null,
      planned_date: String(formData.get("planned_date") ?? "").trim() || null,
      planned_start_at: String(formData.get("planned_start_at") ?? "").trim() || null,
      planned_end_at: String(formData.get("planned_end_at") ?? "").trim() || null,
      idempotency_key: String(formData.get("idempotency_key") ?? "").trim() || null,
      shipment_ids: shipmentIds,
      metadata: {
        source: `${appKey}.operations.pickups.waves.create`,
        ...(normalizeObject(metadataResult.value) ?? {}),
      },
    };

    try {
      const result = await ui.rpc("create_pickup_wave_v1", {
        p_input: payload,
      });
      revalidatePath(activePath);
      revalidatePath(`${appBasePath}/operations/pickups/requests`);
      return {
        status: "success",
        message: `Pickup wave ${stringValue((result as PickupWaveRow)?.route_run_id) ?? "created"}.`,
      };
    } catch (error) {
      return {
        status: "error",
        message: formatUiError(error, "Pickup wave creation failed."),
      };
    }
  }

  async function assignInternalWave(
    _prevState: PickupMutationFormState,
    formData: FormData,
  ): Promise<PickupMutationFormState> {
    "use server";
    const ui = createUiServerClient();
    const metadataResult = parseJsonValue(String(formData.get("metadata_json") ?? "{}"), {});
    if (!metadataResult.ok) {
      return { status: "error", message: metadataResult.message };
    }

    const payload = {
      route_run_id: String(formData.get("route_run_id") ?? "").trim(),
      organization_id: String(formData.get("organization_id") ?? "").trim(),
      driver_user_id: String(formData.get("driver_user_id") ?? "").trim() || null,
      vehicle_id: String(formData.get("vehicle_id") ?? "").trim() || null,
      idempotency_key: String(formData.get("idempotency_key") ?? "").trim() || null,
      metadata: {
        source: `${appKey}.operations.pickups.waves.assign.internal`,
        ...(normalizeObject(metadataResult.value) ?? {}),
      },
    };

    try {
      await ui.rpc("assign_pickup_wave_v1", { p_input: payload });
      revalidatePath(activePath);
      revalidatePath(`${appBasePath}/operations/pickups/requests`);
      revalidatePath(`${appBasePath}/operations/pickups/failures`);
      return { status: "success", message: "Pickup wave assignment updated." };
    } catch (error) {
      return {
        status: "error",
        message: formatUiError(error, "Pickup wave assignment failed."),
      };
    }
  }

  async function assignPartnerWave(
    _prevState: PickupMutationFormState,
    formData: FormData,
  ): Promise<PickupMutationFormState> {
    "use server";
    const ui = createUiServerClient();
    const partnerResult = parseJsonValue(String(formData.get("partner_json") ?? "{}"), {});
    if (!partnerResult.ok) {
      return { status: "error", message: partnerResult.message };
    }
    const metadataResult = parseJsonValue(String(formData.get("metadata_json") ?? "{}"), {});
    if (!metadataResult.ok) {
      return { status: "error", message: metadataResult.message };
    }

    const payload = {
      route_run_id: String(formData.get("route_run_id") ?? "").trim(),
      organization_id: String(formData.get("organization_id") ?? "").trim(),
      partner: normalizeObject(partnerResult.value) ?? {},
      idempotency_key: String(formData.get("idempotency_key") ?? "").trim() || null,
      metadata: {
        source: `${appKey}.operations.pickups.waves.assign.partner`,
        ...(normalizeObject(metadataResult.value) ?? {}),
      },
    };

    try {
      await ui.rpc("assign_pickup_wave_v1", { p_input: payload });
      revalidatePath(activePath);
      revalidatePath(`${appBasePath}/operations/pickups/requests`);
      revalidatePath(`${appBasePath}/operations/pickups/failures`);
      return { status: "success", message: "Pickup partner assignment updated." };
    } catch (error) {
      return {
        status: "error",
        message: formatUiError(error, "Pickup wave assignment failed."),
      };
    }
  }

  if (wavesResult.error) {
    return (
      <PageContainer className="space-y-6" data-testid={`${testIdPrefix}-ready`}>
        <PageHeader
          eyebrow="Operations / Pickup"
          title="Pickup waves"
          description="Plan pickup waves and assign them to drivers, vehicles, or partners."
          actions={
            <div className="flex flex-wrap gap-2">
              <PickupPageNavigation appBasePath={appBasePath} activePath={activePath} />
            </div>
          }
        />
        <ContextNotice
          title="Pickup waves unavailable"
          action="Check the pickup wave view and database read permissions."
          detail={pickupErrorMessage(wavesResult.error, "Unable to load pickup waves.")}
          testId={buildTestId(testIdPrefix, "error")}
        />
      </PageContainer>
    );
  }

  return (
    <PageContainer className="space-y-6" data-testid={`${testIdPrefix}-ready`}>
      <PageHeader
        eyebrow="Operations / Pickup"
        title="Pickup waves"
        description="Group pickup requests into waves, then assign the wave to a driver, vehicle, or partner using the pickup_waves projection."
        actions={
          <div className="flex flex-wrap gap-2">
            <PickupPageNavigation appBasePath={appBasePath} activePath={activePath} />
          </div>
        }
      />

      <Section title="Create pickup wave" collapsible={false}>
        {!canWrite ? (
          <ContextNotice
            title="Pickup wave creation is blocked"
            action="You can still review the pickup wave ledger below."
            detail={resolveDeniedMessage(
              me ? "Capability denied: fleet.write" : "Your session could not be loaded.",
            )}
            testId={`${testIdPrefix}-blocked`}
          />
        ) : (
          <PickupMutationForm
            action={submitPickupWave}
            submitLabel="Create pickup wave"
            pendingLabel="Creating..."
            testIdPrefix={`${testIdPrefix}-create`}
            helperText="Paste shipment ids from the request ledger as comma-separated values or a JSON array."
            fields={[
              {
                name: "organization_id",
                label: "Organization ID",
                kind: "text",
                defaultValue: stringValue(me?.org?.id) ?? "",
                required: true,
              },
              { name: "branch_id", label: "Branch ID", kind: "text" },
              { name: "planned_date", label: "Planned date", kind: "date" },
              { name: "planned_start_at", label: "Planned start", kind: "datetime-local" },
              { name: "planned_end_at", label: "Planned end", kind: "datetime-local" },
              {
                name: "shipment_ids",
                label: "Shipment IDs",
                kind: "textarea",
                layout: "full",
                rows: 4,
                required: true,
                placeholder: "UUID-1, UUID-2",
                helpText: "Comma, newline, or JSON array input is accepted.",
              },
              { name: "idempotency_key", label: "Idempotency key", kind: "text", placeholder: "Optional retry key" },
              {
                name: "metadata_json",
                label: "Metadata JSON",
                kind: "textarea",
                layout: "full",
                rows: 4,
                defaultValue: "{\n  \"source\": \"console.operations.pickups.waves.create\"\n}",
              },
            ]}
          />
        )}
      </Section>

      <Section
        title="Pickup wave ledger"
        description={`Loaded from pickup_waves. ${wavesResult.rows.length} row(s) on this page.`}
        collapsible={false}
      >
        {wavesResult.rows.length === 0 ? (
          <EmptyState
            variant="card"
            title="No pickup waves yet"
            description="Create the first pickup wave to start sequencing requests into a route run."
          />
        ) : (
          <div className="grid gap-4">
            {wavesResult.rows.map((row) => {
              const routeRunId = stringValue(row.route_run_id) ?? "route-run";
              const shipments = Array.isArray(row.shipments) ? row.shipments : [];
              const pickupAssignment = recordValue(row.pickup_assignment);
              return (
                <article
                  key={routeRunId}
                  className="rounded-2xl border border-ui-border bg-ui-surface/60 p-4 shadow-sm"
                >
                  <div className="flex flex-wrap items-center gap-2">
                    {formatStatusBadge(stringValue(row.status))}
                    {stringValue(row.planned_date) ? (
                      <Badge tone="info">{stringValue(row.planned_date) ?? ""}</Badge>
                    ) : null}
                    {stringValue(pickupAssignment?.assignment_mode) ? (
                      <Badge>{stringValue(pickupAssignment?.assignment_mode) ?? ""}</Badge>
                    ) : null}
                    <Badge tone="accent">{`${shipments.length} shipment${shipments.length === 1 ? "" : "s"}`}</Badge>
                  </div>
                  <div className="mt-3 text-sm font-medium text-ui-ink">
                    {routeRunId}
                  </div>
                  <div className="mt-2 text-sm text-ui-muted">
                    {formatDateTimeRange(
                      row.planned_start_at,
                      row.planned_end_at,
                      me?.locale,
                      me?.timezone,
                    ) ?? "No planned window."}
                  </div>
                  <div className="mt-3">
                    {renderFieldPairs([
                      ["Driver", stringValue(row.driver_user_id)],
                      ["Vehicle", stringValue(row.vehicle_id)],
                      ["Pickup stops", row.pickup_stop_count],
                      ["Total boxes", row.total_box_count],
                    ])}
                  </div>
                  <div className="mt-3 space-y-3">
                    {shipments.length > 0 ? (
                      <div className="grid gap-2 md:grid-cols-2">
                        {shipments.map((shipment) => {
                          const shipmentRecord = recordValue(shipment);
                          const shipmentId = stringValue(shipmentRecord?.shipment_id) ?? "shipment";
                          return (
                            <div
                              key={shipmentId}
                              className="rounded-xl border border-ui-border bg-ui-surface/50 p-3 text-sm text-ui-muted"
                            >
                              <div className="font-medium text-ui-ink">
                                {stringValue(shipmentRecord?.tracking_number) ?? shipmentId}
                              </div>
                              <div>{stringValue(shipmentRecord?.status) ?? "unknown"}</div>
                            </div>
                          );
                        })}
                      </div>
                    ) : null}
                    {pickupAssignment ? (
                      <pre className="overflow-x-auto rounded-xl border border-ui-border bg-ui-surface/70 p-3 text-xs text-ui-muted">
                        {JSON.stringify(pickupAssignment, null, 2)}
                      </pre>
                    ) : null}
                  </div>
                  <div className="mt-4 grid gap-4 xl:grid-cols-2">
                    <PickupMutationForm
                      action={assignInternalWave}
                      submitLabel="Assign driver"
                      pendingLabel="Assigning..."
                      testIdPrefix={`${testIdPrefix}-assign-driver-${routeRunId}`}
                      helperText="Internal assignments can set driver and vehicle together."
                      fields={[
                        { name: "route_run_id", kind: "hidden", defaultValue: routeRunId },
                        {
                          name: "organization_id",
                          kind: "hidden",
                          defaultValue: stringValue(row.organization_id) ?? "",
                        },
                        {
                          name: "driver_user_id",
                          label: "Driver user ID",
                          kind: "text",
                          placeholder: "UUID",
                        },
                        {
                          name: "vehicle_id",
                          label: "Vehicle ID",
                          kind: "text",
                          placeholder: "UUID",
                        },
                        { name: "idempotency_key", label: "Idempotency key", kind: "text" },
                        {
                          name: "metadata_json",
                          label: "Metadata JSON",
                          kind: "textarea",
                          layout: "full",
                          rows: 3,
                          defaultValue: "{\n  \"source\": \"console.operations.pickups.waves.assign.internal\"\n}",
                        },
                      ]}
                    />
                    <PickupMutationForm
                      action={assignPartnerWave}
                      submitLabel="Assign partner"
                      pendingLabel="Assigning..."
                      testIdPrefix={`${testIdPrefix}-assign-partner-${routeRunId}`}
                      helperText="Partner assignment accepts a dynamic partner object with partner_id or partner_name."
                      fields={[
                        { name: "route_run_id", kind: "hidden", defaultValue: routeRunId },
                        {
                          name: "organization_id",
                          kind: "hidden",
                          defaultValue: stringValue(row.organization_id) ?? "",
                        },
                        {
                          name: "partner_json",
                          label: "Partner JSON",
                          kind: "textarea",
                          layout: "full",
                          rows: 6,
                          defaultValue: JSON.stringify(
                            pickupAssignment?.partner ?? {
                              partner_id: "",
                              partner_name: "",
                              capacity_boxes: 100,
                            },
                            null,
                            2,
                          ),
                        },
                        { name: "idempotency_key", label: "Idempotency key", kind: "text" },
                        {
                          name: "metadata_json",
                          label: "Metadata JSON",
                          kind: "textarea",
                          layout: "full",
                          rows: 3,
                          defaultValue: "{\n  \"source\": \"console.operations.pickups.waves.assign.partner\"\n}",
                        },
                      ]}
                    />
                  </div>
                </article>
              );
            })}
          </div>
        )}
      </Section>
    </PageContainer>
  );
}
