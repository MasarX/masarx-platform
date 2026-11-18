import type { OutboxEnqueueInput } from "@masarx/mobile-core";

export type RouteLoadParcelStatus = "scanned" | "pending" | "missing" | "extra";
export type RouteLoadAction = "mark_missing" | "undo_missing" | "report_discrepancy";
export type RouteLoadParcel = {
  key: string;
  routeStopId: string | null;
  parcelId: string | null;
  barcode: string;
  weightKg: number | null;
  cold: boolean | null;
  status: RouteLoadParcelStatus;
  reason: string | null;
};
export type RouteLoadActionInput = {
  action: RouteLoadAction;
  routeStopId?: string | null;
  parcelId?: string | null;
  note?: string;
};

export function parseRouteLoadManifest(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const source = value as Record<string, unknown>;
  if (!Array.isArray(source.parcels)) return null;
  const parcels: RouteLoadParcel[] = [];
  const keys = new Set<string>();
  for (const raw of source.parcels) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
    const row = raw as Record<string, unknown>;
    if (typeof row.barcode !== "string" || !row.barcode.trim() ||
      !["scanned", "pending", "missing", "extra"].includes(String(row.status))) return null;
    const routeStopId = typeof row.route_stop_id === "string" ? row.route_stop_id : null;
    const parcelId = typeof row.shipment_box_id === "string" ? row.shipment_box_id : null;
    if (row.status !== "extra" && (!routeStopId || !parcelId)) return null;
    const key = `${routeStopId ?? "extra"}:${parcelId ?? row.barcode}`;
    if (keys.has(key)) return null;
    keys.add(key);
    parcels.push({
      key, routeStopId, parcelId, barcode: row.barcode,
      weightKg: typeof row.weight_kg === "number" && Number.isFinite(row.weight_kg) && row.weight_kg >= 0
        ? row.weight_kg : null,
      cold: typeof row.cold_chain === "boolean" ? row.cold_chain : null,
      status: row.status as RouteLoadParcelStatus,
      reason: typeof row.reason === "string" ? row.reason : null,
    });
  }
  const expected = parcels.filter((parcel) => parcel.status !== "extra");
  const groups = [...new Set(parcels.map((parcel) => parcel.routeStopId))]
    .sort((a, b) => a === null ? 1 : b === null ? -1 : a.localeCompare(b))
    .map((routeStopId) => ({ routeStopId, parcels: parcels.filter((parcel) => parcel.routeStopId === routeStopId) }));
  return {
    canRecordActions: source.can_record_actions === true,
    parcels, groups,
    totals: {
      expected: expected.length,
      scanned: expected.filter((parcel) => parcel.status === "scanned").length,
      pending: expected.filter((parcel) => parcel.status === "pending").length,
      missing: expected.filter((parcel) => parcel.status === "missing").length,
      extra: parcels.length - expected.length,
      cold: expected.filter((parcel) => parcel.cold === true).length,
      unknownCold: expected.filter((parcel) => parcel.cold === null).length,
      weightKg: expected.reduce((total, parcel) => total + (parcel.weightKg ?? 0), 0),
      unknownWeight: expected.filter((parcel) => parcel.weightKg === null).length,
    },
    lastDiscrepancy: typeof source.last_discrepancy === "string" ? source.last_discrepancy : null,
  };
}

export function buildRouteLoadAction(
  input: RouteLoadActionInput,
  identity: { routeRunId: string; userId: string; organizationId: string; requestId: string },
): OutboxEnqueueInput {
  if (![identity.routeRunId, identity.userId, identity.organizationId, identity.requestId].every((value) => value.trim())) {
    throw new Error("route_load_identity_required");
  }
  if (!["mark_missing", "undo_missing", "report_discrepancy"].includes(input.action)) throw new Error("route_load_action_invalid");
  const note = input.note?.trim() ?? "";
  if (note.length > 1000) throw new Error("route_load_note_too_long");
  if (input.action === "report_discrepancy" && !note) throw new Error("route_load_note_required");
  if (input.action !== "report_discrepancy" && (!input.routeStopId || !input.parcelId)) throw new Error("route_load_parcel_required");
  return {
    id: identity.requestId,
    rpc: "ui_record_route_load_action_v1",
    args: { p_input: {
      route_run_id: identity.routeRunId,
      actor_user_id: identity.userId,
      organization_id: identity.organizationId,
      idempotency_key: identity.requestId,
      action: input.action,
      route_stop_id: input.action === "report_discrepancy" ? null : input.routeStopId,
      shipment_box_id: input.action === "report_discrepancy" ? null : input.parcelId,
      note: note || null,
    } },
  };
}
