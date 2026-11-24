import "server-only";

import Link from "next/link";
import { createServerClient } from "@masarx/auth/server";
import { createUiServerClient } from "@masarx/api/server";
import type { PickupLookupOption } from "./pickup-operations-form";
import { Badge } from "./badge";
import { Button } from "./button";
import { buildLookupFriendlyLabel } from "./lookup-friendly-label";
import { createUiTranslator } from "./i18n";
import { formatUiError } from "./utils";
import { normalizeObject, stringValue } from "./pickup-operations-utils";

export type SearchParams = Record<string, string | string[] | undefined>;

export type PickupViewResult<T extends Record<string, unknown>> = {
  rows: T[];
  error: string | null;
};

export type PickupScopeContext = {
  access_scope?: {
    scope_type?: string | null;
    scope_id?: string | null;
  } | null;
};

const ROW_LIMIT = 25;

export type PickupAssignmentOptions = Record<"branches" | "drivers" | "vehicles" | "partners", PickupLookupOption[]>;

export async function loadPickupAssignmentOptions(organizationId: string): Promise<{
  options: PickupAssignmentOptions; error: string | null;
}> {
  try {
    const options = await createUiServerClient().rpc<PickupAssignmentOptions>("pickup_assignment_options_v1", {
      p_organization_id: organizationId, p_limit: 250,
    });
    return { options, error: null };
  } catch (error) {
    return { options: { branches: [], drivers: [], vehicles: [], partners: [] },
      error: formatUiError(error, "Pickup assignment choices could not be loaded. Reload to retry.") };
  }
}

export async function loadPickupRelationshipOptions(resource: "clients" | "senders" | "service_branch_directory", clientId?: string) {
  const ui = createUiServerClient();
  try {
    const result = await ui.listResource(resource, clientId ? { client_id: clientId } : {}, 200, 0);
    const options = result.items.map((row) => ({
      value: String(row.id), label: String(row.name || row.brand_name || row.slug || row.code || buildLookupFriendlyLabel("Reference", row.id)),
      groupValue: typeof row.client_id === "string" ? row.client_id : typeof row.organization_id === "string" ? row.organization_id : null,
    }));
    return { options, error: null };
  } catch (error) {
    return { options: [] as PickupLookupOption[],
      error: formatUiError(error, `Pickup ${resource} could not be loaded. Reload to retry.`) };
  }
}

export function pickupRelationshipLabel(options: PickupLookupOption[], value: unknown) {
  const id = stringValue(value);
  return options.find((option) => option.value === id)?.label ?? buildLookupFriendlyLabel("Reference", id);
}

export function buildPickupRequestOptions(rows: Record<string, unknown>[]): PickupLookupOption[] {
  return rows.flatMap((row) => {
    const value = stringValue(row.shipment_id);
    if (!value) return [];
    return [{ value, label: stringValue(row.tracking_number) || stringValue(row.client_reference_number) || stringValue(row.carrier_reference_number) || buildLookupFriendlyLabel("Shipment", value),
      searchText: [row.tracking_number, row.client_reference_number, row.carrier_reference_number].filter(Boolean).join(" ") }];
  });
}

async function withPickupLabels<T extends Record<string, unknown>>(rows: T[], kind: "shipment" | "route", error: unknown): Promise<PickupViewResult<T>> {
  if (error || rows.length === 0) return { rows, error: pickupListError(error, "Unable to load pickups.") };
  const key = kind === "shipment" ? "shipment_id" : "route_run_id";
  try {
    const labels = await createUiServerClient().rpc<Record<string, Record<string, string>>>("pickup_relationship_labels_v1", {
      p_shipment_ids: kind === "shipment" ? rows.map((row) => row[key]) : [],
      p_route_run_ids: kind === "route" ? rows.map((row) => row[key]) : [],
    });
    return { rows: rows.map((row) => ({ ...row, ...labels[`${kind}:${row[key]}`] })), error: null };
  } catch (labelError) {
    return { rows, error: formatUiError(labelError, "Pickup display labels could not be loaded. Reload to retry.") };
  }
}

function firstValue(value: string | string[] | undefined | null) {
  if (Array.isArray(value)) return value[0];
  return value;
}

export function resolvePickupScopeFilters(
  me: PickupScopeContext | null | undefined,
): Array<[string, string]> {
  const scope = normalizeObject(me?.access_scope);
  const scopeType = stringValue(scope?.scope_type)?.trim().toLowerCase() ?? "";
  const scopeId = stringValue(scope?.scope_id)?.trim() ?? "";
  if (!scopeId) return [];
  if (scopeType === "client") {
    return [["client_id", scopeId]];
  }
  if (scopeType === "sender") {
    return [["sender_id", scopeId]];
  }
  return [];
}

function pickupListError(error: unknown, fallback: string) {
  return error ? formatUiError(error, fallback) : null;
}

export async function loadPickupRequestRows<T extends Record<string, unknown>>(params: {
  clientId?: string | null;
  senderId?: string | null;
  status?: string | string[] | undefined;
  limit?: number;
}): Promise<PickupViewResult<T>> {
  const client = createServerClient({ allowCookieSet: false });
  const { data, error } = await client.rpc("pickup_requests_list_v1", {
    p_client_id: firstValue(params.clientId)?.trim() || null,
    p_sender_id: firstValue(params.senderId)?.trim() || null,
    p_status: firstValue(params.status)?.trim() || null,
    p_limit: params.limit ?? ROW_LIMIT,
  });
  return withPickupLabels(Array.isArray(data) ? (data as T[]) : [], "shipment", error);
}

export async function loadPickupWaveRows<T extends Record<string, unknown>>(params: {
  routeRunIds?: string[];
  status?: string | string[] | undefined;
  limit?: number;
}): Promise<PickupViewResult<T>> {
  const client = createServerClient({ allowCookieSet: false });
  const routeRunIds =
    Array.isArray(params.routeRunIds) && params.routeRunIds.length > 0
      ? params.routeRunIds
      : null;
  const { data, error } = await client.rpc("pickup_waves_list_v1", {
    p_route_run_ids: routeRunIds,
    p_status: firstValue(params.status)?.trim() || null,
    p_limit: params.limit ?? ROW_LIMIT,
  });
  return withPickupLabels(Array.isArray(data) ? (data as T[]) : [], "route", error);
}

export async function loadPickupFailureRows<T extends Record<string, unknown>>(params: {
  shipmentIds?: string[];
  clientId?: string | null;
  senderId?: string | null;
  status?: string | string[] | undefined;
  limit?: number;
}): Promise<PickupViewResult<T>> {
  const client = createServerClient({ allowCookieSet: false });
  const shipmentIds =
    Array.isArray(params.shipmentIds) && params.shipmentIds.length > 0
      ? params.shipmentIds
      : null;
  const { data, error } = await client.rpc("pickup_failures_list_v1", {
    p_shipment_ids: shipmentIds,
    p_client_id: firstValue(params.clientId)?.trim() || null,
    p_sender_id: firstValue(params.senderId)?.trim() || null,
    p_status: firstValue(params.status)?.trim() || null,
    p_limit: params.limit ?? ROW_LIMIT,
  });
  return withPickupLabels(Array.isArray(data) ? (data as T[]) : [], "shipment", error);
}

export function PickupPageNavigation({
  appBasePath,
  activePath,
}: {
  appBasePath: string;
  activePath: string;
}) {
  const routes = [
    { href: `${appBasePath}/operations/pickups/requests`, label: "Requests" },
    { href: `${appBasePath}/operations/pickups/waves`, label: "Waves" },
    { href: `${appBasePath}/operations/pickups/failures`, label: "Failures" },
  ];

  return (
    <>
      {routes.map((route) => (
        <Button
          key={route.href}
          asChild
          size="sm"
          variant={activePath === route.href ? "solid" : "ghost"}
        >
          <Link href={route.href}>{route.label}</Link>
        </Button>
      ))}
    </>
  );
}

// Values from the pickup_request_status and pickup_wave_status lookups and the wave assignment record.
const PICKUP_STATUSES = new Set([
  "pending", "pickup_requested", "scheduled", "pickup_scheduled", "planned", "assigned",
  "in_progress", "completed", "failed", "pickup_failed", "cancelled",
]);
const PICKUP_ASSIGNMENT_MODES = new Set(["internal_driver", "partner", "unassigned"]);

// Unlisted values show the translated "unknown" label so raw enum text never reaches the UI.
function pickupValueLabel(group: "statuses" | "assignmentModes", known: Set<string>, value: string) {
  const t = createUiTranslator("ui.pickupStatus");
  return known.has(value) ? t(`${group}.${value}`) : t("unknown");
}

export function pickupAssignmentModeLabel(mode: string | null | undefined) {
  return pickupValueLabel("assignmentModes", PICKUP_ASSIGNMENT_MODES, (mode ?? "").trim().toLowerCase());
}

export function formatStatusBadge(status: string | null | undefined) {
  const value = (status ?? "").trim().toLowerCase();
  const label = pickupValueLabel("statuses", PICKUP_STATUSES, value);
  if (!value) return <Badge tone="neutral">{label}</Badge>;
  if (value.includes("failed")) return <Badge tone="danger">{label}</Badge>;
  if (value.includes("completed")) return <Badge tone="success">{label}</Badge>;
  if (value.includes("scheduled") || value.includes("planned")) {
    return <Badge tone="info">{label}</Badge>;
  }
  if (value.includes("active") || value.includes("in_progress")) {
    return <Badge tone="accent">{label}</Badge>;
  }
  return <Badge tone="neutral">{label}</Badge>;
}

function displayValue(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed || null;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return null;
}

export function renderFieldPairs(entries: Array<[string, unknown]>) {
  const visible = entries
    .map(([label, value]) => [label, displayValue(value)] as const)
    .filter(([, value]) => Boolean(value));
  if (visible.length === 0) return null;

  return (
    <dl className="grid gap-2 text-sm sm:grid-cols-2">
      {visible.map(([label, value]) => (
        <div
          key={label}
          className="rounded-xl border border-ui-border bg-ui-surface/50 p-3"
        >
          <dt className="text-xs uppercase tracking-wide text-ui-muted">
            {label}
          </dt>
          <dd className="mt-1 text-ui-ink">{value}</dd>
        </div>
      ))}
    </dl>
  );
}

export function recordValue(value: unknown) {
  return normalizeObject(value);
}

export function pickupErrorMessage(error: unknown, fallback: string) {
  return formatUiError(error, fallback);
}
