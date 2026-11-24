import "server-only";

import { revalidatePath } from "next/cache";
import { createUiServerClient } from "@masarx/api/server";
import { Badge } from "./badge";
import { buildLookupFriendlyLabel } from "./lookup-friendly-label";
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
  loadPickupAssignmentOptions,
  pickupRelationshipLabel,
} from "./pickup-page-shared";
import { buildTestId } from "./test-ids";
import { extractCapabilityDeniedKey, formatUiError } from "./utils";
import { hasCapability, resolveCapabilitySet } from "./capabilities";
import { createUiTranslator } from "./i18n";

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

// Server actions cannot close over a translator function, so each one creates its own.
const wavesTranslator = () => createUiTranslator("ui.pickupWaves");

function resolveDeniedMessage(message: string, t: ReturnType<typeof wavesTranslator>) {
  const capability = extractCapabilityDeniedKey(message);
  if (capability) {
    return t("blocked.capabilityDenied", { capability });
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
  const t = wavesTranslator();
  const ui = createUiServerClient();
  const meResult = await ui.me().catch(() => null);
  const me = normalizeObject(meResult) as PickupUserContext | null;
  const scopeFilters = resolvePickupScopeFilters(me);
  const wavesResult = await loadPickupWaveRows<PickupWaveRow>({
    status: searchParams.status,
  });
  const capabilities = Array.isArray(me?.capabilities) ? me.capabilities : [];
  const canWrite = hasCapability(resolveCapabilitySet(capabilities), "fleet.write");
  const [assignmentChoices, lookups] = canWrite
    ? await Promise.all([
        loadPickupAssignmentOptions(stringValue(me?.org?.id) ?? ""),
        loadPickupLookups(me, "wave"),
      ])
    : [
        { options: { branches: [], drivers: [], vehicles: [], partners: [] }, error: null },
        { options: { branches: [], drivers: [], vehicles: [], shipments: [] }, error: null },
      ];
  const shipmentOptions = lookups.options.shipments;
  const activePath = `${appBasePath}/operations/pickups/waves`;

  async function submitPickupWave(
    _prevState: PickupMutationFormState,
    formData: FormData,
  ): Promise<PickupMutationFormState> {
    "use server";
    const t = wavesTranslator();
    const ui = createUiServerClient();
    const shipmentIds = parsePickupIdList(formData.getAll("shipment_ids").map(String).join(","));
    if (shipmentIds.length === 0) {
      return { status: "error", message: t("messages.shipmentRequired") };
    }

    const metadataResult = parseJsonValue(String(formData.get("metadata_json") ?? "{}"), {});
    if (!metadataResult.ok) {
      return { status: "error", message: t("messages.invalidJson") };
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
      const routeRunId = stringValue((result as PickupWaveRow)?.route_run_id);
      return {
        status: "success",
        message: routeRunId ? t("messages.created", { routeRunId }) : t("messages.createdFallback"),
      };
    } catch (error) {
      return {
        status: "error",
        message: formatUiError(error, t("messages.createFailed")),
      };
    }
  }

  async function assignInternalWave(
    _prevState: PickupMutationFormState,
    formData: FormData,
  ): Promise<PickupMutationFormState> {
    "use server";
    const t = wavesTranslator();
    const ui = createUiServerClient();
    const metadataResult = parseJsonValue(String(formData.get("metadata_json") ?? "{}"), {});
    if (!metadataResult.ok) {
      return { status: "error", message: t("messages.invalidJson") };
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
      return { status: "success", message: t("messages.assignmentUpdated") };
    } catch (error) {
      return {
        status: "error",
        message: formatUiError(error, t("messages.assignmentFailed")),
      };
    }
  }

  async function assignPartnerWave(
    _prevState: PickupMutationFormState,
    formData: FormData,
  ): Promise<PickupMutationFormState> {
    "use server";
    const t = wavesTranslator();
    const ui = createUiServerClient();
    const partnerResult = parseJsonValue(String(formData.get("partner_json") ?? "{}"), {});
    if (!partnerResult.ok) {
      return { status: "error", message: t("messages.invalidJson") };
    }
    const metadataResult = parseJsonValue(String(formData.get("metadata_json") ?? "{}"), {});
    if (!metadataResult.ok) {
      return { status: "error", message: t("messages.invalidJson") };
    }

    const selectedPartnerId = String(formData.get("partner_id") ?? "").trim();
    const selectedPartner = String(formData.get("organization_id") ?? "").trim() === stringValue(me?.org?.id)
      ? assignmentChoices.options.partners.find((option) => option.value === selectedPartnerId) : undefined;
    const payload = {
      route_run_id: String(formData.get("route_run_id") ?? "").trim(),
      organization_id: String(formData.get("organization_id") ?? "").trim(),
      partner: selectedPartnerId
        ? { ...(normalizeObject(partnerResult.value) ?? {}), partner_id: selectedPartnerId,
            ...(selectedPartner ? { partner_name: selectedPartner.label } : {}) }
        : normalizeObject(partnerResult.value) ?? {},
      reassignment_reason:
        String(formData.get("reassignment_reason") ?? "").trim() || null,
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
      return { status: "success", message: t("messages.partnerAssignmentUpdated") };
    } catch (error) {
      return {
        status: "error",
        message: formatUiError(error, t("messages.assignmentFailed")),
      };
    }
  }

  if (wavesResult.error) {
    return (
      <PageContainer className="space-y-6" data-testid={`${testIdPrefix}-ready`}>
        <PageHeader
          eyebrow={t("eyebrow")}
          title={t("title")}
          description={t("unavailable.description")}
          actions={
            <div className="flex flex-wrap gap-2">
              <PickupPageNavigation appBasePath={appBasePath} activePath={activePath} />
            </div>
          }
        />
        <ContextNotice
          title={t("unavailable.title")}
          action={t("unavailable.action")}
          detail={pickupErrorMessage(wavesResult.error, t("unavailable.fallback"))}
          testId={buildTestId(testIdPrefix, "error")}
        />
      </PageContainer>
    );
  }

  return (
    <PageContainer className="space-y-6" data-testid={`${testIdPrefix}-ready`}>
      <PageHeader
        eyebrow={t("eyebrow")}
        title={t("title")}
        description={t("description")}
        actions={
          <div className="flex flex-wrap gap-2">
            <PickupPageNavigation appBasePath={appBasePath} activePath={activePath} />
          </div>
        }
      />

      <Section title={t("create.title")} collapsible={false}>
        {assignmentChoices.error || lookups.error ? (
          <ContextNotice title={t("choicesUnavailable.title")} action={t("choicesUnavailable.action")}
            detail={assignmentChoices.error || lookups.error || ""} testId={`${testIdPrefix}-lookup-error`} />
        ) : null}
        {!canWrite ? (
          <ContextNotice
            title={t("blocked.title")}
            action={t("blocked.action")}
            detail={resolveDeniedMessage(
              me ? "Capability denied: fleet.write" : t("blocked.sessionUnavailable"),
              t,
            )}
            testId={`${testIdPrefix}-blocked`}
          />
        ) : (
          <PickupMutationForm
            action={submitPickupWave}
            submitLabel={t("create.submit")}
            pendingLabel={t("create.pending")}
            testIdPrefix={`${testIdPrefix}-create`}
            helperText={t("create.helper")}
            fields={[
              {
                name: "organization_id",
                label: t("fields.organizationId"),
                kind: "text",
                defaultValue: stringValue(me?.org?.id) ?? "",
                required: true,
              },
              { name: "branch_id", label: t("fields.branch"), kind: "relation", options: lookups.options.branches.length ? lookups.options.branches : assignmentChoices.options.branches },
              { name: "planned_date", label: t("fields.plannedDate"), kind: "date" },
              { name: "planned_start_at", label: t("fields.plannedStart"), kind: "datetime-local" },
              { name: "planned_end_at", label: t("fields.plannedEnd"), kind: "datetime-local" },
              {
                name: "shipment_ids",
                label: t("fields.pickupShipments"),
                kind: "relation",
                mode: "multi",
                options: shipmentOptions,
                layout: "full",
                required: true,
                placeholder: t("fields.shipmentsPlaceholder"),
              },
              { name: "idempotency_key", label: t("fields.idempotencyKey"), kind: "text", placeholder: t("fields.idempotencyPlaceholder") },
              {
                name: "metadata_json",
                label: t("fields.metadataJson"),
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
        title={t("ledger.title")}
        description={t("ledger.description", { count: wavesResult.rows.length })}
        collapsible={false}
      >
        {wavesResult.rows.length === 0 ? (
          <EmptyState
            variant="card"
            title={t("ledger.emptyTitle")}
            description={t("ledger.emptyDescription")}
          />
        ) : (
          <div className="grid gap-4">
            {wavesResult.rows.map((row) => {
              const rowChoices = stringValue(row.organization_id) === stringValue(me?.org?.id)
                ? assignmentChoices.options : { branches: [], drivers: [], vehicles: [], partners: [] };
              const routeRunId = stringValue(row.route_run_id) ?? "route-run";
              const shipments = Array.isArray(row.shipments) ? row.shipments : [];
              const pickupAssignment = recordValue(row.pickup_assignment);
              const pickupAssignmentMode = stringValue(pickupAssignment?.assignment_mode);
              const hasPickupOwnership =
                pickupAssignmentMode === "internal_driver" || pickupAssignmentMode === "partner";
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
                    <Badge tone="accent">{t("ledger.shipmentCount", { count: shipments.length })}</Badge>
                  </div>
                  <div className="mt-3 text-sm font-medium text-ui-ink">
                    {stringValue(row.name) ?? buildLookupFriendlyLabel(t("ledger.route"), routeRunId)}
                  </div>
                  <div className="mt-2 text-sm text-ui-muted">
                    {formatDateTimeRange(
                      row.planned_start_at,
                      row.planned_end_at,
                      me?.locale,
                      me?.timezone,
                    ) ?? t("ledger.noWindow")}
                  </div>
                  <div className="mt-3">
                    {renderFieldPairs([
                      [t("fields.branch"), stringValue(row.branch_label)],
                      [t("fields.driver"), stringValue(row.driver_label) ?? pickupRelationshipLabel(assignmentChoices.options.drivers, row.driver_user_id)],
                      [t("fields.vehicle"), stringValue(row.vehicle_label) ?? pickupRelationshipLabel(assignmentChoices.options.vehicles, row.vehicle_id)],
                      [t("ledger.pickupStops"), row.pickup_stop_count],
                      [t("ledger.totalBoxes"), row.total_box_count],
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
                              <div>{stringValue(shipmentRecord?.status) ?? createUiTranslator("ui.pickupOperations")("unknownStatus")}</div>
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
                      submitLabel={t("assign.driverSubmit")}
                      pendingLabel={t("assign.pending")}
                      testIdPrefix={`${testIdPrefix}-assign-driver-${routeRunId}`}
                      helperText={t("assign.driverHelper")}
                      fields={[
                        { name: "route_run_id", kind: "hidden", defaultValue: routeRunId },
                        {
                          name: "organization_id",
                          kind: "hidden",
                          defaultValue: stringValue(row.organization_id) ?? "",
                        },
                        {
                          name: "driver_user_id",
                          label: t("fields.driver"),
                          kind: "relation",
                          options: lookups.options.drivers.length ? lookups.options.drivers : rowChoices.drivers,
                          defaultValue: stringValue(row.driver_user_id) ?? "",
                        },
                        {
                          name: "vehicle_id",
                          label: t("fields.vehicle"),
                          kind: "relation",
                          options: lookups.options.vehicles.length ? lookups.options.vehicles : rowChoices.vehicles,
                          defaultValue: stringValue(row.vehicle_id) ?? "",
                        },
                        { name: "idempotency_key", label: t("fields.idempotencyKey"), kind: "text" },
                        {
                          name: "metadata_json",
                          label: t("fields.metadataJson"),
                          kind: "textarea",
                          layout: "full",
                          rows: 3,
                          defaultValue: "{\n  \"source\": \"console.operations.pickups.waves.assign.internal\"\n}",
                        },
                      ]}
                    />
                    <PickupMutationForm
                      action={assignPartnerWave}
                      submitLabel={t("assign.partnerSubmit")}
                      pendingLabel={t("assign.pending")}
                      testIdPrefix={`${testIdPrefix}-assign-partner-${routeRunId}`}
                      helperText={t("assign.partnerHelper")}
                      fields={[
                        { name: "route_run_id", kind: "hidden", defaultValue: routeRunId },
                        {
                          name: "organization_id",
                          kind: "hidden",
                          defaultValue: stringValue(row.organization_id) ?? "",
                        },
                        {
                          name: "partner_id", label: t("fields.partner"), kind: "relation",
                          options: [
                            ...rowChoices.partners,
                            ...(stringValue(recordValue(pickupAssignment?.partner)?.partner_id) &&
                              !rowChoices.partners.some((option) => option.value === stringValue(recordValue(pickupAssignment?.partner)?.partner_id))
                              ? [{ value: stringValue(recordValue(pickupAssignment?.partner)?.partner_id)!,
                                  label: stringValue(recordValue(pickupAssignment?.partner)?.partner_name) || stringValue(recordValue(pickupAssignment?.partner)?.partner_id)! }]
                              : []),
                          ],
                          helpText: t("fields.partnerHelp"),
                        },
                        {
                          name: "partner_json",
                          label: t("fields.partnerJson"),
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
                        {
                          name: "reassignment_reason",
                          label: t("fields.reassignmentReason"),
                          kind: "textarea",
                          layout: "full",
                          rows: 2,
                          required: hasPickupOwnership,
                          helpText: hasPickupOwnership
                            ? t("fields.reassignmentRequired")
                            : t("fields.reassignmentOptional"),
                        },
                        { name: "idempotency_key", label: t("fields.idempotencyKey"), kind: "text" },
                        {
                          name: "metadata_json",
                          label: t("fields.metadataJson"),
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
