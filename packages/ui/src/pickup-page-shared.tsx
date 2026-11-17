import "server-only";

import Link from "next/link";
import { createServerClient } from "@masarx/auth/server";
import { Badge } from "./badge";
import { Button } from "./button";
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

function firstValue(value: string | string[] | undefined | null) {
  if (Array.isArray(value)) return value[0];
  return value;
}

export async function loadPublicViewRows<T extends Record<string, unknown>>(
  viewName: string,
  queryOptions: {
    orderBy: string;
    descending?: boolean;
    filters?: Array<[string, string | string[] | undefined]>;
  },
): Promise<PickupViewResult<T>> {
  const client = createServerClient({ allowCookieSet: false });
  let query = client.from(viewName).select("*");

  queryOptions.filters?.forEach(([key, value]) => {
    const raw = firstValue(value);
    const trimmed = raw?.trim();
    if (!trimmed) return;
    if (trimmed.includes(",")) {
      const values = trimmed
        .split(",")
        .map((entry) => entry.trim())
        .filter(Boolean);
      if (values.length > 0) {
        query = query.in(key, values);
      }
      return;
    }
    query = query.eq(key, trimmed);
  });

  const { data, error } = await query
    .order(queryOptions.orderBy, {
      ascending: queryOptions.descending ? false : true,
      nullsFirst: false,
    })
    .limit(ROW_LIMIT);

  return {
    rows: Array.isArray(data) ? (data as T[]) : [],
    error: error ? formatUiError(error, `Unable to load ${viewName}.`) : null,
  };
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
  return {
    rows: Array.isArray(data) ? (data as T[]) : [],
    error: pickupListError(error, "Unable to load pickup_requests."),
  };
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
  return {
    rows: Array.isArray(data) ? (data as T[]) : [],
    error: pickupListError(error, "Unable to load pickup_waves."),
  };
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
  return {
    rows: Array.isArray(data) ? (data as T[]) : [],
    error: pickupListError(error, "Unable to load pickup_failures."),
  };
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

export function formatStatusBadge(status: string | null | undefined) {
  const value = (status ?? "").trim().toLowerCase();
  if (!value) return <Badge tone="neutral">unknown</Badge>;
  if (value.includes("failed")) return <Badge tone="danger">{value}</Badge>;
  if (value.includes("completed")) return <Badge tone="success">{value}</Badge>;
  if (value.includes("scheduled") || value.includes("planned")) {
    return <Badge tone="info">{value}</Badge>;
  }
  if (value.includes("active") || value.includes("in_progress")) {
    return <Badge tone="accent">{value}</Badge>;
  }
  return <Badge tone="neutral">{value}</Badge>;
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
