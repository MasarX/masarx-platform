export type MobileRouteScanContext = {
  label?: string | null;
  taskId?: string | null;
  resourceId?: string | null;
  routeRunId?: string | null;
  routeStopId?: string | null;
  shipmentId?: string | null;
  clientId?: string | null;
  opsSessionId?: string | null;
  reference?: string | null;
  customerName?: string | null;
  routeDepartureConfirmedAt?: string | null;
};

export type MobileRouteScanOutboxCommandInput = {
  id: string;
  scanType: string;
  barcode: string;
  deviceId: string;
  scanInputMode: string;
  capturedAt: string;
  scanContext?: MobileRouteScanContext | null;
  activeOpsSessionId?: string | null;
  attestation?: Record<string, unknown> | null;
};

export type MobileRouteScanOutboxCommand = {
  rpc: "record_scan_event_v1" | "ui_execute_route_run_scanout_v1";
  args: Record<string, unknown>;
};

export type MobileRouteDepartureCommandInput = {
  routeRunId: string;
  routeStopId?: string | null;
  taskId?: string | null;
  opsSessionId?: string | null;
  attestation?: Record<string, unknown> | null;
};

const asPlainRecord = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

const firstRouteScanoutReadbackRecord = (value: unknown): Record<string, unknown> | null => {
  if (Array.isArray(value)) {
    let fallback: Record<string, unknown> | null = null;
    for (const entry of value) {
      const record = asPlainRecord(entry);
      if (!record) continue;
      fallback ??= record;
      if (
        asPlainRecord(record.route_execution_manifest) ||
        asPlainRecord(record.scan_out) ||
        asPlainRecord(record.route_departure) ||
        trimOptional(record.route_run_id as string | null | undefined)
      ) {
        return record;
      }
    }
    return fallback;
  }
  return asPlainRecord(value);
};

const trimOptional = (value: string | null | undefined) => {
  const trimmed = typeof value === "string" ? value.trim() : "";
  return trimmed || null;
};

const toFiniteNumber = (value: unknown): number | null => {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
};

const isValidTimestamp = (value: string) => Number.isFinite(Date.parse(value));

function normalizeConfirmedRouteScanoutReadback(input: {
  scanOut: Record<string, unknown> | null;
  routeDeparture: Record<string, unknown> | null;
  current: Record<string, unknown> | null;
  resultManifest: Record<string, unknown> | null;
}): Record<string, unknown> | null {
  if (!trimOptional(input.routeDeparture?.confirmed_at as string | null | undefined)) {
    return input.scanOut;
  }

  const currentScanOut = asPlainRecord(input.current?.scan_out);
  const expectedStopCount =
    toFiniteNumber(input.scanOut?.expected_stop_count) ??
    toFiniteNumber(currentScanOut?.expected_stop_count) ??
    toFiniteNumber(input.resultManifest?.stop_count) ??
    toFiniteNumber(input.current?.stop_count);

  return {
    ...(input.scanOut ?? {}),
    ready_for_departure: true,
    ...(expectedStopCount != null ? { scanned_stop_count: expectedStopCount } : {}),
    missing_stop_count: 0,
    unexpected_scan_count: 0,
    duplicate_scan_count: 0,
    missing_route_stop_ids: [],
    unexpected_barcodes: [],
    duplicate_route_stop_ids: [],
  };
}

export function isRouteLoadScanoutContext(input: {
  scanType: string;
  scanContext?: MobileRouteScanContext | null;
}) {
  const scanType = input.scanType.trim().toLowerCase();
  return (
    scanType === "load" &&
    Boolean(trimOptional(input.scanContext?.routeRunId)) &&
    !trimOptional(input.scanContext?.routeStopId)
  );
}

export function buildMobileRouteScanOutboxCommand(
  input: MobileRouteScanOutboxCommandInput
): MobileRouteScanOutboxCommand {
  const scanType = input.scanType.trim().toLowerCase();
  const barcode = input.barcode.trim();
  const idempotencyKey = trimOptional(input.id);
  const capturedAt = trimOptional(input.capturedAt);
  const deviceId = trimOptional(input.deviceId);
  const scanInputMode = trimOptional(input.scanInputMode);
  const activeOpsSessionId =
    trimOptional(input.activeOpsSessionId) ?? trimOptional(input.scanContext?.opsSessionId);
  const context = {
    label: trimOptional(input.scanContext?.label),
    task_id: trimOptional(input.scanContext?.taskId),
    resource_id: trimOptional(input.scanContext?.resourceId),
    route_run_id: trimOptional(input.scanContext?.routeRunId),
    route_stop_id: trimOptional(input.scanContext?.routeStopId),
    shipment_id: trimOptional(input.scanContext?.shipmentId),
    client_id: trimOptional(input.scanContext?.clientId),
    ops_session_id: trimOptional(input.scanContext?.opsSessionId),
    reference: trimOptional(input.scanContext?.reference),
    customer_name: trimOptional(input.scanContext?.customerName),
    route_departure_confirmed_at: trimOptional(input.scanContext?.routeDepartureConfirmedAt),
  };
  const metadata = {
    app: "fieldops",
    source: "mobile",
    scan_input_mode: scanInputMode,
    context,
    ...(input.attestation ? { attestation: input.attestation } : {}),
  };

  if (isRouteLoadScanoutContext({ scanType, scanContext: input.scanContext })) {
    const routeRunId = trimOptional(input.scanContext?.routeRunId)!;
    if (trimOptional(input.scanContext?.routeDepartureConfirmedAt)) {
      throw new Error("route_departure_confirmed");
    }
    requireMobileScanEvidence({ idempotencyKey, barcode, deviceId, capturedAt, scanInputMode });
    return {
      rpc: "ui_execute_route_run_scanout_v1",
      args: {
        p_action_key: "routes.scan_load",
        p_resource_key: "routes",
        p_selection_ids: [routeRunId],
        p_selection_id: routeRunId,
        p_selection_count: 1,
        p_params: {
          idempotency_key: idempotencyKey,
          scan_type: scanType,
          barcode,
          device_id: deviceId,
          ...(activeOpsSessionId ? { ops_session_id: activeOpsSessionId } : {}),
          captured_at: capturedAt,
          metadata,
        },
      },
    };
  }

  requireMobileScanEvidence({ idempotencyKey, barcode, deviceId, capturedAt, scanInputMode });

  return {
    rpc: "record_scan_event_v1",
    args: {
      p_scan: {
        idempotency_key: idempotencyKey,
        scan_type: scanType,
        barcode,
        device_id: deviceId,
        ...(trimOptional(input.scanContext?.routeRunId)
          ? { route_run_id: trimOptional(input.scanContext?.routeRunId) }
          : {}),
        ...(trimOptional(input.scanContext?.routeStopId)
          ? { route_stop_id: trimOptional(input.scanContext?.routeStopId) }
          : {}),
        ...(trimOptional(input.scanContext?.shipmentId)
          ? {
              shipment_id: trimOptional(input.scanContext?.shipmentId),
              ...(trimOptional(input.scanContext?.clientId)
                ? { client_id: trimOptional(input.scanContext?.clientId) }
                : {}),
            }
          : {}),
        ...(activeOpsSessionId ? { ops_session_id: activeOpsSessionId } : {}),
        captured_at: capturedAt,
        metadata,
      },
    },
  };
}

function requireMobileScanEvidence(input: {
  idempotencyKey: string | null;
  barcode: string;
  deviceId: string | null;
  capturedAt: string | null;
  scanInputMode: string | null;
}) {
  if (!input.idempotencyKey) {
    throw new Error("idempotency_key_required");
  }
  if (!input.barcode) {
    throw new Error("barcode_required");
  }
  if (!input.deviceId) {
    throw new Error("device_id_required");
  }
  if (!input.capturedAt) {
    throw new Error("captured_at_required");
  }
  if (!isValidTimestamp(input.capturedAt)) {
    throw new Error("captured_at_invalid");
  }
  if (!input.scanInputMode) {
    throw new Error("scan_input_mode_required");
  }
}

export function buildMobileRouteDepartureCommand(
  input: MobileRouteDepartureCommandInput
): MobileRouteScanOutboxCommand {
  const routeRunId = trimOptional(input.routeRunId);
  const routeStopId = trimOptional(input.routeStopId);
  const taskId = trimOptional(input.taskId);
  const opsSessionId = trimOptional(input.opsSessionId);
  if (!routeRunId) {
    throw new Error("route_run_id_required");
  }
  const metadata = {
    app: "fieldops",
    source: "mobile",
    action_key: "routes.confirm_departure",
    context: {
      route_run_id: routeRunId,
      route_stop_id: routeStopId,
      task_id: taskId,
      ops_session_id: opsSessionId,
    },
    ...(input.attestation ? { attestation: input.attestation } : {}),
  };

  return {
    rpc: "ui_execute_route_run_scanout_v1",
    args: {
      p_action_key: "routes.confirm_departure",
      p_resource_key: "routes",
      p_selection_ids: [routeRunId],
      p_selection_id: routeRunId,
      p_selection_count: 1,
      p_params: {
        route_stop_id: routeStopId,
        task_id: taskId,
        ops_session_id: opsSessionId,
        metadata,
      },
    },
  };
}

export function mergeMobileRouteExecutionManifestReadback(input: {
  current?: unknown;
  result?: unknown;
  routeRunId?: string | null;
}): Record<string, unknown> | null {
  const current = asPlainRecord(input.current);
  const result = firstRouteScanoutReadbackRecord(input.result);
  if (!result) return current;

  const resultManifest = asPlainRecord(result.route_execution_manifest);
  const scanOut = asPlainRecord(result.scan_out);
  const routeDeparture = asPlainRecord(result.route_departure);
  const manifestScanOut = asPlainRecord(resultManifest?.scan_out);
  const manifestRouteDeparture = asPlainRecord(resultManifest?.route_departure);
  const mergedScanOut =
    manifestScanOut || scanOut ? { ...(scanOut ?? {}), ...(manifestScanOut ?? {}) } : null;
  const mergedRouteDeparture =
    manifestRouteDeparture || routeDeparture
      ? { ...(routeDeparture ?? {}), ...(manifestRouteDeparture ?? {}) }
      : null;
  const normalizedScanOut = normalizeConfirmedRouteScanoutReadback({
    scanOut: mergedScanOut,
    routeDeparture: mergedRouteDeparture,
    current,
    resultManifest,
  });
  const routeRunId = resolveMobileRouteExecutionManifestRouteRunId(input);

  if (!resultManifest && !scanOut && !routeDeparture && !routeRunId) {
    return current;
  }

  return {
    ...(current ?? {}),
    ...(resultManifest ?? {}),
    ...(routeRunId ? { route_run_id: routeRunId } : {}),
    ...(normalizedScanOut ? { scan_out: normalizedScanOut } : {}),
    ...(mergedRouteDeparture ? { route_departure: mergedRouteDeparture } : {}),
  };
}

export function resolveMobileRouteExecutionManifestRouteRunId(input: {
  current?: unknown;
  result?: unknown;
  routeRunId?: string | null;
}): string | null {
  const current = asPlainRecord(input.current);
  const result = firstRouteScanoutReadbackRecord(input.result);
  const resultManifest = asPlainRecord(result?.route_execution_manifest);

  return (
    trimOptional(input.routeRunId) ??
    trimOptional(result?.route_run_id as string | null | undefined) ??
    trimOptional(resultManifest?.route_run_id as string | null | undefined) ??
    trimOptional(current?.route_run_id as string | null | undefined)
  );
}
