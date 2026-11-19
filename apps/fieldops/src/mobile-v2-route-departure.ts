import type {
  ConfirmFieldopsRouteDepartureInput,
  RecordFieldopsRouteLoadScanInput,
} from "./mobile-v2-rpc-hooks";
import type { MobileV2RouteEnvelope } from "./mobile-v2-rpc-hooks";
import type { MobileV2Task } from "./mobile-v2-tasks-types";

export const MOBILE_V2_ROUTE_DEPARTURE_READBACK_FAILED_MESSAGE =
  "Route departure did not confirm the departed state";

export function buildMobileV2RouteDepartureMutationInput(input: {
  readonly routeRunId: string | null | undefined;
  readonly activeOpsSessionId: string | null | undefined;
}): ConfirmFieldopsRouteDepartureInput | null {
  const routeRunId = input.routeRunId?.trim() ?? "";
  if (!routeRunId) return null;
  const activeOpsSessionId = input.activeOpsSessionId?.trim() ?? "";
  return {
    p_route_run_id: routeRunId,
    p_ops_session_id: activeOpsSessionId || null,
  };
}

export function mobileV2RouteHasDepartureReadback(
  data: unknown,
  routeRunId: string,
): boolean {
  const expectedRouteRunId = routeRunId.trim();
  if (!expectedRouteRunId) return false;
  if (data === null || data === undefined || typeof data !== "object") return false;
  const route = data as Partial<MobileV2RouteEnvelope>;
  return (
    route.routeRunId === expectedRouteRunId
    && route.manifestSummary?.departed === true
    && route.manifestSummary.departureLabel === "Departed"
  );
}

function asNonEmptyText(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function isUuid(value: string | null): value is string {
  return (
    value !== null
    && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)
  );
}

function taskRouteStopId(task: MobileV2Task): string | null {
  return asNonEmptyText(task.meta.route_stop_id)
    ?? (task.task_id.startsWith("stop:") ? task.task_id.slice("stop:".length) : null);
}

function taskBarcode(task: MobileV2Task): string | null {
  return asNonEmptyText(task.code)
    ?? asNonEmptyText(task.title)
    ?? asNonEmptyText(task.meta.tracking_number)
    ?? asNonEmptyText(task.meta.shipment_tracking_number);
}

export function buildMobileV2RouteLoadScanMutationInput(input: {
  readonly tasks: ReadonlyArray<MobileV2Task>;
  readonly routeRunId: string | null | undefined;
  readonly barcode: string;
  readonly deviceId: string | null | undefined;
  readonly activeOpsSessionId: string | null | undefined;
}): RecordFieldopsRouteLoadScanInput | null {
  const routeRunId = asNonEmptyText(input.routeRunId);
  const barcode = asNonEmptyText(input.barcode);
  if (!isUuid(routeRunId) || barcode === null) return null;

  const task = input.tasks.find((candidate) => {
    const candidateRouteRunId = asNonEmptyText(candidate.meta.route_run_id);
    if (candidateRouteRunId !== routeRunId) return false;
    return taskBarcode(candidate) === barcode;
  });
  if (task === undefined) return null;

  const routeStopId = taskRouteStopId(task);
  const shipmentId = asNonEmptyText(task.meta.shipment_id);
  const clientId = asNonEmptyText(task.meta.client_id);
  const branchId = asNonEmptyText(task.meta.branch_id);
  if (
    !isUuid(routeStopId)
    || !isUuid(shipmentId)
    || !isUuid(clientId)
    || (branchId !== null && !isUuid(branchId))
  ) {
    return null;
  }

  const deviceId = asNonEmptyText(input.deviceId);
  const opsSessionId = asNonEmptyText(input.activeOpsSessionId);

  return {
    p_scan: {
      route_run_id: routeRunId,
      route_stop_id: routeStopId,
      shipment_id: shipmentId,
      client_id: clientId,
      branch_id: branchId,
      barcode,
      scan_type: "load",
      device_id: isUuid(deviceId) ? deviceId : null,
      ops_session_id: isUuid(opsSessionId) ? opsSessionId : null,
      captured_at: new Date().toISOString(),
      metadata: {
        source: "fieldops_mobile_v2_route_scan_out",
        mobile_v2_only: true,
      },
    },
  };
}

export function mobileV2RouteHasReadyScanOutReadback(
  data: unknown,
  routeRunId: string,
): boolean {
  const expectedRouteRunId = routeRunId.trim();
  if (!expectedRouteRunId) return false;
  if (data === null || data === undefined || typeof data !== "object") return false;
  const route = data as Partial<MobileV2RouteEnvelope>;
  return (
    route.routeRunId === expectedRouteRunId
    && route.manifestSummary?.readyForDeparture === true
    && route.manifestSummary.scanOutLabel.startsWith("Scan-out ready")
  );
}
