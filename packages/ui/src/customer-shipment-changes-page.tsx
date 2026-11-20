import "server-only";

import { createUiServerClient } from "@masarx/api/server";
import { Badge } from "./badge";
import { Button } from "./button";
import { ResourcePage } from "./resource-page";
import { Section } from "./section";
import {
  CustomerShipmentChangeReviewForm,
} from "./customer-shipment-change-review-form";
import { formatUiError } from "./utils";
import { hasCapability, resolveCapabilitySet } from "./capabilities";
import { buildHref } from "./url";

type SearchParams = Record<string, string | string[] | undefined>;

type CustomerShipmentChangesPageProps = {
  appKey: "console" | "portal";
  searchParams: SearchParams;
  appBasePath: string;
  baseHref: string;
  testIdPrefix: string;
  description?: string;
  defaultOutcome?: "pending_review" | "applied" | "rejected" | "all";
};

type DetailRecord = Record<string, unknown>;
type Snapshot = Record<string, unknown>;

const FILTER_KEYS = [
  "request_source",
  "request_outcome",
  "status",
  "id",
  "detail_open",
  "detail_layout",
] as const;

const FIELD_LABELS: Record<string, string> = {
  promised_delivery_date: "Promised delivery date",
  "address.raw_input": "Requested address",
  "address.short_national_address": "Short national address",
  "address.landmark": "Landmark",
  landmark: "Landmark",
  "address.drop_point": "Drop-point details",
  drop_point: "Drop-point details",
  "address.map_pin": "Map pin",
  notes: "Customer notes",
};

function firstValue(value: string | string[] | undefined) {
  if (Array.isArray(value)) return value[0];
  return value;
}

function stringValue(value: unknown) {
  return typeof value === "string" ? value : null;
}

function recordValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function stringArrayValue(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry) => stringValue(entry)?.trim() ?? "")
    .filter(Boolean);
}

function resolveOutcome(value: string | null) {
  if (value === "applied") return { label: "Applied", tone: "success" as const };
  if (value === "rejected") return { label: "Rejected", tone: "danger" as const };
  return { label: "Needs review", tone: "warning" as const };
}

function resolveRequestTypeLabel(value: string | null) {
  if (value === "reschedule_date") return "Reschedule date";
  if (value === "location_change") return "Location change";
  return "Shipment change";
}

function normalizeChangedFields(fields: string[]) {
  const out: string[] = [];
  let addedMapPin = false;
  fields.forEach((field) => {
    const value = field.trim();
    if (!value) return;
    if (value.startsWith("address.map_pin.")) {
      if (!addedMapPin) {
        out.push("address.map_pin");
        addedMapPin = true;
      }
      return;
    }
    if (!out.includes(value)) out.push(value);
  });
  return out;
}

function pathValue(snapshot: Snapshot | null, field: string) {
  if (!snapshot) return null;
  if (field === "address.map_pin") {
    const address = recordValue(snapshot.address);
    const pin = recordValue(address?.map_pin);
    if (!pin) return null;
    const lat = stringValue(pin.lat) ?? String(pin.lat ?? "").trim();
    const lng = stringValue(pin.lng) ?? String(pin.lng ?? "").trim();
    if (!lat && !lng) return null;
    return [lat, lng].filter(Boolean).join(", ");
  }
  return field.split(".").reduce<unknown>((current, key) => {
    if (!current || typeof current !== "object" || Array.isArray(current)) return null;
    return (current as Record<string, unknown>)[key];
  }, snapshot);
}

function formatSnapshotValue(value: unknown): string {
  if (value === null || value === undefined) return "Not available";
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return "Not available";
    return trimmed;
  }
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) {
    const items: string[] = value
      .map((entry) => formatSnapshotValue(entry))
      .filter((entry) => entry !== "Not available");
    return items.length ? items.join(", ") : "Not available";
  }
  try {
    return JSON.stringify(value);
  } catch {
    return "Not available";
  }
}

function buildSnapshotRows(snapshot: Snapshot | null, fields: string[]) {
  return fields.map((field) => ({
    key: field,
    label: FIELD_LABELS[field] ?? field.replaceAll(".", " -> "),
    value: formatSnapshotValue(pathValue(snapshot, field)),
  }));
}

function buildTabHref(
  baseHref: string,
  searchParams: SearchParams,
  outcome: "pending_review" | "applied" | "rejected" | "all",
) {
  const params = new URLSearchParams();
  Object.entries(searchParams).forEach(([key, value]) => {
    if (FILTER_KEYS.includes(key as (typeof FILTER_KEYS)[number])) return;
    if (Array.isArray(value)) {
      value.forEach((entry) => params.append(key, entry));
    } else if (typeof value === "string" && value.trim()) {
      params.set(key, value);
    }
  });

  params.set("request_source", "public_tracking");
  if (outcome === "all") {
    params.delete("request_outcome");
    params.delete("status");
  } else {
    params.set("request_outcome", outcome);
    params.set("status", outcome === "pending_review" ? "open" : "resolved");
  }
  return buildHref(baseHref, params);
}

/**
 * Console/portal workspace for customer shipment changes from public tracking.
 */
export async function CustomerShipmentChangesPage({
  appKey,
  searchParams,
  appBasePath,
  baseHref,
  testIdPrefix,
  description,
  defaultOutcome = "all",
}: CustomerShipmentChangesPageProps) {
  const ui = createUiServerClient();
  let meError: string | null = null;
  let capabilities: string[] = [];

  try {
    const me = await ui.me();
    capabilities = me?.capabilities ?? [];
  } catch (error) {
    meError = formatUiError(error, "Unable to load current reviewer profile.");
  }

  const canReview = hasCapability(
    resolveCapabilitySet(capabilities ?? null),
    "manual_review.resolve",
  );

  const outcomeFilter = firstValue(searchParams.request_outcome);
  const selectedOutcome =
    outcomeFilter === "pending_review" ||
    outcomeFilter === "applied" ||
    outcomeFilter === "rejected" ||
    outcomeFilter === "all"
      ? outcomeFilter
      : defaultOutcome;
  const effectiveSearchParams = {
    request_source: "public_tracking",
    ...(defaultOutcome === "all"
      ? {}
      : {
          request_outcome: defaultOutcome,
          status: defaultOutcome === "pending_review" ? "open" : "resolved",
        }),
    ...searchParams,
  };

  const filterTabs = [
    {
      key: "pending_review",
      label: "Needs review",
      active: selectedOutcome === "pending_review",
      href: buildTabHref(baseHref, searchParams, "pending_review"),
    },
    {
      key: "applied",
      label: "Applied",
      active: selectedOutcome === "applied",
      href: buildTabHref(baseHref, searchParams, "applied"),
    },
    {
      key: "rejected",
      label: "Rejected",
      active: selectedOutcome === "rejected",
      href: buildTabHref(baseHref, searchParams, "rejected"),
    },
    {
      key: "all",
      label: "All",
      active: selectedOutcome === "all",
      href: buildTabHref(baseHref, searchParams, "all"),
    },
  ];

  return (
    <ResourcePage
      appKey={appKey}
      resourceKey="customer_shipment_changes"
      searchParams={effectiveSearchParams}
      appBasePath={appBasePath}
      baseHref={baseHref}
      description={
        description ??
        "Review customer-requested shipment changes, compare before/requested/current values, and apply or reject them."
      }
      testIdPrefix={testIdPrefix}
      headerActions={
        <div className="flex flex-wrap gap-2">
          {filterTabs.map((tab) => (
            <Button
              key={tab.key}
              asChild
              variant={tab.active ? "solid" : "soft"}
              size="sm"
            >
              <a href={tab.href}>{tab.label}</a>
            </Button>
          ))}
        </div>
      }
      renderDetailFooter={({ detail, detailError, detailId }) => {
        if (!detail || detailError) return null;

        const metadata = recordValue(detail.metadata);
        const requestType = stringValue(detail.request_type_key) ?? stringValue(metadata?.request_type);
        const requestOutcome =
          stringValue(detail.request_outcome) ??
          stringValue(metadata?.request_outcome) ??
          (stringValue(detail.status) === "resolved" && stringValue(detail.status_reason) === "applied"
            ? "applied"
            : "pending_review");
        const outcomeBadge = resolveOutcome(requestOutcome);
        const requestTypeLabel = resolveRequestTypeLabel(requestType);
        const requesterChannel = stringValue(detail.requester_channel) ?? stringValue(metadata?.requester_channel);
        const changeSummary = stringValue(detail.change_summary) ?? stringValue(metadata?.change_summary);
        const beforeSnapshot = recordValue(metadata?.before_snapshot);
        const requestedSnapshot = recordValue(metadata?.requested_snapshot);
        const currentSnapshot = recordValue(metadata?.current_snapshot);
        const lastApplyError = recordValue(metadata?.last_apply_error);
        const reviewReason = stringValue(metadata?.review_reason);
        const changedFields = normalizeChangedFields(
          stringArrayValue(detail.changed_fields ?? metadata?.changed_fields),
        );
        const beforeRows = buildSnapshotRows(beforeSnapshot, changedFields);
        const requestedRows = buildSnapshotRows(requestedSnapshot, changedFields);
        const currentRows = buildSnapshotRows(currentSnapshot, changedFields);

        let blockedMessage: string | undefined;
        if (!canReview) {
          blockedMessage = meError
            ? `Reviewer context unavailable: ${meError}`
            : "Your account is missing manual_review.resolve capability.";
        } else if (stringValue(detail.status) === "resolved") {
          blockedMessage = "This shipment change is already resolved.";
        }

        return (
          <div className="space-y-4">
            <Section
              title="Change review"
              description="Compare what the customer requested against the original and current shipment state."
              collapsible
              collapseKey="customer-shipment-changes.review"
            >
              <div className="space-y-4">
                <div className="flex flex-wrap items-center gap-2 text-sm text-ui-muted">
                  <Badge tone={outcomeBadge.tone}>{outcomeBadge.label}</Badge>
                  <Badge tone="info">{requestTypeLabel}</Badge>
                  {requesterChannel ? <Badge tone="neutral">{requesterChannel}</Badge> : null}
                  {stringValue(detail.shipment_status_snapshot) ? (
                    <span className="text-xs">
                      Shipment status: {stringValue(detail.shipment_status_snapshot)}
                    </span>
                  ) : null}
                </div>

                {changeSummary ? (
                  <div className="rounded-xl border border-ui-border bg-ui-surface/80 p-3 text-sm text-ui-ink">
                    {changeSummary}
                  </div>
                ) : null}

                {changedFields.length ? (
                  <div className="flex flex-wrap gap-2">
                    {changedFields.map((field) => (
                      <Badge key={field} tone="accent">
                        {FIELD_LABELS[field] ?? field}
                      </Badge>
                    ))}
                  </div>
                ) : null}

                <div className="grid gap-4 lg:grid-cols-3">
                  <div className="rounded-xl border border-ui-border bg-ui-surface/70 p-4">
                    <div className="mb-3 text-sm font-semibold text-ui-ink">Before</div>
                    <div className="space-y-3 text-sm text-ui-muted">
                      {beforeRows.map((row) => (
                        <div key={`before-${row.key}`} className="space-y-1">
                          <div className="text-xs uppercase tracking-wide text-ui-muted/80">{row.label}</div>
                          <div className="rounded-lg bg-ui-paper/70 px-3 py-2 text-ui-ink">{row.value}</div>
                        </div>
                      ))}
                    </div>
                  </div>

                  <div className="rounded-xl border border-ui-border bg-ui-surface/70 p-4">
                    <div className="mb-3 text-sm font-semibold text-ui-ink">Requested</div>
                    <div className="space-y-3 text-sm text-ui-muted">
                      {requestedRows.map((row) => (
                        <div key={`requested-${row.key}`} className="space-y-1">
                          <div className="text-xs uppercase tracking-wide text-ui-muted/80">{row.label}</div>
                          <div className="rounded-lg bg-ui-paper/70 px-3 py-2 text-ui-ink">{row.value}</div>
                        </div>
                      ))}
                    </div>
                  </div>

                  <div className="rounded-xl border border-ui-border bg-ui-surface/70 p-4">
                    <div className="mb-3 text-sm font-semibold text-ui-ink">
                      {requestOutcome === "applied" ? "Current / Applied" : "Current"}
                    </div>
                    <div className="space-y-3 text-sm text-ui-muted">
                      {currentRows.map((row) => (
                        <div key={`current-${row.key}`} className="space-y-1">
                          <div className="text-xs uppercase tracking-wide text-ui-muted/80">{row.label}</div>
                          <div className="rounded-lg bg-ui-paper/70 px-3 py-2 text-ui-ink">{row.value}</div>
                        </div>
                      ))}
                    </div>
                  </div>
                </div>

                {lastApplyError ? (
                  <div className="rounded-xl border border-ui-border bg-ui-surface/80 p-3 text-xs text-ui-muted">
                    Last apply error
                    {stringValue(lastApplyError.code) ? ` (${stringValue(lastApplyError.code)})` : ""}
                    {stringValue(lastApplyError.message)
                      ? `: ${stringValue(lastApplyError.message)}`
                      : "."}
                  </div>
                ) : null}

                {reviewReason ? (
                  <div className="rounded-xl border border-ui-border bg-ui-surface/80 p-3 text-xs text-ui-muted">
                    Review reason: {reviewReason}
                  </div>
                ) : null}
              </div>
            </Section>

            <Section
              title="Reviewer action"
              description="Approve to apply the canonical shipment change or reject it with context."
              collapsible
              collapseKey="customer-shipment-changes.resolve"
            >
              <CustomerShipmentChangeReviewForm
                supportCaseId={detailId}
                decisionOptions={[
                  { value: "approved", label: "Approve and apply change" },
                  { value: "rejected", label: "Reject customer change" },
                ]}
                disabled={Boolean(blockedMessage)}
                disabledMessage={blockedMessage}
                testIdPrefix={`${testIdPrefix}-review`}
              />
            </Section>
          </div>
        );
      }}
    />
  );
}
