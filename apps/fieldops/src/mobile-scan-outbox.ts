import type { OutboxEnqueueInput } from "@masarx/mobile-core";
import type { MobileScanInputMode } from "./mobile-shell-scan-input";

export type MobileAttestationEnvelope = {
  provider: "android_play_integrity" | "ios_app_attest";
  challenge_id: string;
  challenge: string;
  generated_at: string;
  integrity_token?: string;
  key_id?: string;
  assertion?: string;
  attestation?: string;
};

export type MobileScanOutboxContext = {
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
};

function readTrimmed(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function requireTrimmed(value: unknown, label: string): string {
  const trimmed = readTrimmed(value);
  if (!trimmed) throw new Error(`Mobile scan outbox requires ${label}.`);
  return trimmed;
}

function nullableTrimmed(value: unknown): string | null {
  return readTrimmed(value);
}

export function buildMobileScanOutboxEntry(input: {
  id: string;
  deviceId: string;
  scanType: string;
  barcode: string;
  scanInputMode: MobileScanInputMode;
  capturedAt: string;
  scanContext?: MobileScanOutboxContext | null;
  activeOpsSessionId?: string | null;
  attestation?: MobileAttestationEnvelope | null;
}): OutboxEnqueueInput {
  const id = requireTrimmed(input.id, "id");
  const deviceId = requireTrimmed(input.deviceId, "device id");
  const scanType = requireTrimmed(input.scanType, "scan type").toLowerCase();
  const barcode = requireTrimmed(input.barcode, "barcode");
  const context = input.scanContext ?? null;
  const routeRunId = nullableTrimmed(context?.routeRunId);
  const routeStopId = nullableTrimmed(context?.routeStopId);
  const shipmentId = nullableTrimmed(context?.shipmentId);
  const clientId = nullableTrimmed(context?.clientId);
  const opsSessionId = nullableTrimmed(input.activeOpsSessionId) ?? nullableTrimmed(context?.opsSessionId);
  if ((shipmentId == null) !== (clientId == null)) {
    throw new Error("Mobile scan outbox requires shipment id and client id together.");
  }

  return {
    id,
    rpc: "record_scan_event_v1",
    args: {
      p_scan: {
        idempotency_key: id,
        scan_type: scanType,
        barcode,
        device_id: deviceId,
        ...(routeRunId ? { route_run_id: routeRunId } : {}),
        ...(routeStopId ? { route_stop_id: routeStopId } : {}),
        ...(shipmentId && clientId ? { shipment_id: shipmentId, client_id: clientId } : {}),
        ...(opsSessionId ? { ops_session_id: opsSessionId } : {}),
        captured_at: requireTrimmed(input.capturedAt, "captured timestamp"),
        metadata: {
          app: "fieldops",
          source: "mobile",
          scan_input_mode: input.scanInputMode,
          context: {
            label: nullableTrimmed(context?.label),
            task_id: nullableTrimmed(context?.taskId),
            resource_id: nullableTrimmed(context?.resourceId),
            route_run_id: routeRunId,
            route_stop_id: routeStopId,
            reference: nullableTrimmed(context?.reference),
            customer_name: nullableTrimmed(context?.customerName),
          },
          ...(input.attestation ? { attestation: input.attestation } : {}),
        },
      },
    },
  };
}
