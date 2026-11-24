import {
  type DriverHoursOfServiceRecord,
  liveBackendUnavailableError,
  liveMetadataCache,
  loadLiveDriverHoursOfService,
  liveRpc,
  normalizeDriverHoursOfServiceRecord,
  requireLiveResourceListReadback,
  requireLiveResourceReadback,
  seed,
} from '../data-source';
import { SEED_MODE_ENABLED } from '../seed-loader';
import { getSupabaseClient } from '../supabase';
import { asNonEmptyString } from './shared';

export async function read_driver_hours_of_service_v1(
  driver_id: string,
): Promise<DriverHoursOfServiceRecord | null> {
  const map = ((seed as Record<string, unknown>).driver_hours_of_service ?? {}) as Record<
    string,
    DriverHoursOfServiceRecord | undefined
  >;
  if (getSupabaseClient()) {
    const live = await loadLiveDriverHoursOfService(driver_id);
    liveMetadataCache.driverHoursOfService[driver_id] = live;
    return SEED_MODE_ENABLED ? live ?? map[driver_id] ?? null : live;
  }
  if (!SEED_MODE_ENABLED) throw liveBackendUnavailableError('RPC resolve_driver_hours_of_service_v1');
  const value = map[driver_id] ?? null;
  liveMetadataCache.driverHoursOfService[driver_id] = value;
  return value;
}

async function requireLiveVehicleReadback(
  vehicleId: string,
  rpcName: string,
): Promise<void> {
  // Fleet vehicle UI readback is intentionally through the registry-backed
  // directory projection. The raw `vehicles` resource is not exposed to
  // browser callers in live lanes.
  await requireLiveResourceReadback('vehicle_directory', vehicleId, rpcName);
}

async function requireLiveVehicleAssignmentReadback(
  rpcName: string,
  vehicleId: string,
  assignmentId?: string | null,
): Promise<void> {
  const normalizedAssignmentId = asNonEmptyString(assignmentId);
  if (normalizedAssignmentId) {
    await requireLiveResourceReadback('vehicle_assignments', normalizedAssignmentId, rpcName);
  } else {
    await requireLiveResourceListReadback('vehicle_assignments', { vehicle_id: vehicleId }, rpcName);
  }
}

async function requireLiveVehicleEventReadback(
  rpcName: string,
  vehicleId: string,
  eventId?: string | null,
): Promise<void> {
  const normalizedEventId = asNonEmptyString(eventId);
  if (normalizedEventId) {
    await requireLiveResourceReadback('vehicle_events', normalizedEventId, rpcName);
  } else {
    await requireLiveResourceListReadback('vehicle_events', { vehicle_id: vehicleId }, rpcName);
  }
}

async function requireLiveVehicleDocumentReadback(
  rpcName: string,
  vehicleDocumentId: string,
): Promise<void> {
  await requireLiveResourceReadback('vehicle_documents', vehicleDocumentId, rpcName);
}

async function requireLiveVehicleMaintenanceReadback(
  rpcName: string,
  maintenanceWindowId: string,
): Promise<void> {
  // Browser-facing Console reads maintenance windows through
  // `vehicle_maintenance_directory`. Some live lanes expose the projection in
  // `ui_read_registry` without exposing the raw SSOT table as a UI resource, so
  // attempt the raw table readback but do not let it mask the canonical browser
  // projection confirmation.
  await requireLiveResourceReadback('vehicle_maintenance_windows', maintenanceWindowId, rpcName)
    .catch(() => undefined);
  await requireLiveResourceReadback('vehicle_maintenance_directory', maintenanceWindowId, rpcName);
}

function resolveVehicleMaintenanceWindowId(
  rec: Record<string, unknown>,
  args: Record<string, unknown>,
): string | null {
  return asNonEmptyString(rec.vehicle_maintenance_window_id)
    ?? asNonEmptyString(rec.maintenance_window_id)
    ?? asNonEmptyString(rec.id)
    ?? asNonEmptyString(args.vehicle_maintenance_window_id)
    ?? asNonEmptyString(args.maintenance_window_id);
}

async function requireLiveDriverProfileReadback(
  driverProfileId: string,
  rpcName: string,
): Promise<void> {
  await requireLiveResourceReadback('driver_directory', driverProfileId, rpcName);
}

async function requireLiveDriverDocumentReadback(
  driverDocumentId: string,
  rpcName: string,
): Promise<void> {
  await requireLiveResourceReadback('driver_documents', driverDocumentId, rpcName);
}

async function requireLiveDriverComplianceEventReadback(
  driverComplianceEventId: string,
  rpcName: string,
): Promise<void> {
  await requireLiveResourceReadback('driver_compliance_events', driverComplianceEventId, rpcName);
}

async function requireLiveDriverHoursOfServiceReadback(
  driverProfileId: string,
  dutyStatus: string | null,
  rpcName: string,
  segmentId?: string | null,
): Promise<void> {
  const live = await liveRpc<unknown>('resolve_driver_hours_of_service_v1', {
    p_driver_id: driverProfileId,
  });
  if (!live) throw new Error(`${rpcName} hours-of-service readback requires a live backend`);
  const rec = normalizeDriverHoursOfServiceRecord(live.data);
  if (!rec) throw new Error(`${rpcName} backend readback missing driver hours-of-service:${driverProfileId}`);
  const hasDutyEvidence =
    rec.today.length > 0 ||
    Object.values(rec.week_total).some((value) => Number(value) > 0);
  if (!hasDutyEvidence) {
    throw new Error(`${rpcName} backend readback missing driver hours-of-service:${driverProfileId}`);
  }
  if (dutyStatus && rec.today.length > 0 && !rec.today.some((segment) => segment.type === dutyStatus)) {
    throw new Error(`${rpcName} backend readback did not include duty_status ${dutyStatus}`);
  }
  if (segmentId) {
    const segment = await requireLiveResourceReadback('driver_hours_of_service', segmentId, rpcName);
    if (asNonEmptyString(segment.driver_id) !== driverProfileId) {
      throw new Error(`${rpcName} backend readback segment driver mismatch:${segmentId}`);
    }
    if (dutyStatus && asNonEmptyString(segment.duty_status) !== dutyStatus) {
      throw new Error(`${rpcName} backend readback segment duty_status mismatch:${segmentId}`);
    }
    if (segment.segment_end != null) {
      throw new Error(`${rpcName} backend readback segment is not active/open:${segmentId}`);
    }
    const directory = await requireLiveResourceReadback('driver_directory', driverProfileId, rpcName);
    if (asNonEmptyString(directory.hos_active_segment_id) !== segmentId) {
      throw new Error(`${rpcName} backend readback did not project active HOS segment:${segmentId}`);
    }
    if (dutyStatus && asNonEmptyString(directory.hos_active_duty_status) !== dutyStatus) {
      throw new Error(`${rpcName} backend readback did not project active duty_status ${dutyStatus}`);
    }
    if (Number(directory.hos_segment_count_24h) < 1) {
      throw new Error(`${rpcName} backend readback missing HOS segment count:${driverProfileId}`);
    }
  }
}

export async function confirmVehicleCreation(
  args: Record<string, unknown>,
  result: Record<string, unknown>,
): Promise<void> {
  const vehicleId =
    asNonEmptyString(result.vehicle_id) ??
    asNonEmptyString(result.id) ??
    asNonEmptyString(args.vehicle_id);
  if (!vehicleId) throw new Error('create_vehicle_v1 did not return vehicle_id');
  await requireLiveVehicleReadback(vehicleId, 'create_vehicle_v1');
}

export async function confirmVehicleDocumentUpload(
  args: Record<string, unknown>,
  result: Record<string, unknown>,
): Promise<void> {
  const vehicleDocumentId =
    asNonEmptyString(result.vehicle_document_id) ??
    asNonEmptyString(result.document_id) ??
    asNonEmptyString(result.id);
  if (!vehicleDocumentId) throw new Error('upload_vehicle_document_v1 did not return vehicle_document_id');
  await requireLiveVehicleDocumentReadback('upload_vehicle_document_v1', vehicleDocumentId);
  const vehicleId = asNonEmptyString(result.vehicle_id) ?? asNonEmptyString(args.vehicle_id);
  if (vehicleId) await requireLiveVehicleReadback(vehicleId, 'upload_vehicle_document_v1');
}

export async function confirmVehicleAssignment(
  args: Record<string, unknown>,
  result: Record<string, unknown>,
): Promise<void> {
  const vehicleId =
    asNonEmptyString(result.vehicle_id) ??
    asNonEmptyString(args.vehicle_id);
  if (!vehicleId) throw new Error('assign_driver_to_vehicle_v1 did not return vehicle_id');
  const assignmentId =
    asNonEmptyString(result.vehicle_assignment_id) ??
    asNonEmptyString(result.assignment_id) ??
    asNonEmptyString(result.id);
  await requireLiveVehicleReadback(vehicleId, 'assign_driver_to_vehicle_v1');
  await requireLiveVehicleAssignmentReadback('assign_driver_to_vehicle_v1', vehicleId, assignmentId);
}

export async function confirmVehicleUnassignment(
  args: Record<string, unknown>,
  result: Record<string, unknown>,
): Promise<void> {
  const vehicleId =
    asNonEmptyString(result.vehicle_id) ??
    asNonEmptyString(args.vehicle_id);
  const assignmentId =
    asNonEmptyString(result.vehicle_assignment_id) ??
    asNonEmptyString(result.assignment_id) ??
    asNonEmptyString(args.vehicle_assignment_id) ??
    asNonEmptyString(args.assignment_id) ??
    asNonEmptyString(result.id);
  if (!vehicleId && !assignmentId) throw new Error('unassign_driver_v1 did not return vehicle assignment evidence');
  if (vehicleId) await requireLiveVehicleReadback(vehicleId, 'unassign_driver_v1');
  if (vehicleId || assignmentId) {
    await requireLiveVehicleAssignmentReadback('unassign_driver_v1', vehicleId ?? '', assignmentId);
  }
}

export async function confirmVehicleOutOfService(
  args: Record<string, unknown>,
  result: Record<string, unknown>,
): Promise<void> {
  const vehicleId =
    asNonEmptyString(result.vehicle_id) ??
    asNonEmptyString(result.id) ??
    asNonEmptyString(args.vehicle_id);
  if (!vehicleId) throw new Error('mark_vehicle_oos_v1 did not return vehicle_id');
  const eventId = asNonEmptyString(result.vehicle_event_id) ?? asNonEmptyString(result.event_id);
  await requireLiveVehicleReadback(vehicleId, 'mark_vehicle_oos_v1');
  await requireLiveVehicleEventReadback('mark_vehicle_oos_v1', vehicleId, eventId);
}

export async function confirmVehicleRestoration(
  args: Record<string, unknown>,
  result: Record<string, unknown>,
): Promise<void> {
  const vehicleId =
    asNonEmptyString(result.vehicle_id) ??
    asNonEmptyString(result.id) ??
    asNonEmptyString(args.vehicle_id);
  if (!vehicleId) throw new Error('restore_vehicle_v1 did not return vehicle_id');
  const eventId = asNonEmptyString(result.vehicle_event_id) ?? asNonEmptyString(result.event_id);
  await requireLiveVehicleReadback(vehicleId, 'restore_vehicle_v1');
  await requireLiveVehicleEventReadback('restore_vehicle_v1', vehicleId, eventId);
}

export async function confirmVehicleMaintenance(
  rpcName: string,
  args: Record<string, unknown>,
  result: Record<string, unknown>,
): Promise<void> {
  const maintenanceWindowId = resolveVehicleMaintenanceWindowId(result, args);
  if (!maintenanceWindowId) throw new Error(`${rpcName} did not return vehicle_maintenance_window_id`);
  await requireLiveVehicleMaintenanceReadback(rpcName, maintenanceWindowId);
  const vehicleId = asNonEmptyString(result.vehicle_id) ?? asNonEmptyString(args.vehicle_id);
  if (vehicleId) await requireLiveVehicleReadback(vehicleId, rpcName);
}

export async function confirmVehicleEvent(
  args: Record<string, unknown>,
  result: Record<string, unknown>,
): Promise<void> {
  const vehicleId =
    asNonEmptyString(result.vehicle_id) ??
    asNonEmptyString(args.vehicle_id);
  if (!vehicleId) throw new Error('record_vehicle_event_v1 did not return vehicle_id');
  const eventId = asNonEmptyString(result.vehicle_event_id) ?? asNonEmptyString(result.event_id) ?? asNonEmptyString(result.id);
  await requireLiveVehicleEventReadback('record_vehicle_event_v1', vehicleId, eventId);
  await requireLiveVehicleReadback(vehicleId, 'record_vehicle_event_v1');
}

export async function confirmDriverCreation(
  result: Record<string, unknown>,
): Promise<void> {
  const driverProfileId =
    asNonEmptyString(result.driver_profile_id) ??
    asNonEmptyString(result.driver_id) ??
    asNonEmptyString(result.id);
  if (!driverProfileId) throw new Error('create_driver_v1 did not return driver_profile_id');
  await requireLiveDriverProfileReadback(driverProfileId, 'create_driver_v1');
}

export async function confirmDriverDocumentUpload(
  result: Record<string, unknown>,
): Promise<void> {
  const driverDocumentId =
    asNonEmptyString(result.driver_document_id) ??
    asNonEmptyString(result.document_id) ??
    asNonEmptyString(result.id);
  if (!driverDocumentId) throw new Error('upload_driver_document_v1 did not return driver_document_id');
  await requireLiveDriverDocumentReadback(driverDocumentId, 'upload_driver_document_v1');
}

export async function confirmDriverStatus(
  rpcName: string,
  args: Record<string, unknown>,
  result: Record<string, unknown>,
): Promise<void> {
  const driverProfileId =
    asNonEmptyString(result.driver_profile_id) ??
    asNonEmptyString(result.driver_id) ??
    asNonEmptyString(result.id) ??
    asNonEmptyString(args.driver_profile_id) ??
    asNonEmptyString(args.driver_id);
  if (!driverProfileId) throw new Error(`${rpcName} did not return driver_profile_id`);
  await requireLiveDriverProfileReadback(driverProfileId, rpcName);
}

export async function confirmDriverDocumentStatus(
  rpcName: string,
  args: Record<string, unknown>,
  result: Record<string, unknown>,
): Promise<void> {
  const driverDocumentId =
    asNonEmptyString(result.driver_document_id) ??
    asNonEmptyString(result.document_id) ??
    asNonEmptyString(result.id) ??
    asNonEmptyString(args.driver_document_id) ??
    asNonEmptyString(args.document_id);
  if (!driverDocumentId) throw new Error(`${rpcName} did not return driver_document_id`);
  await requireLiveDriverDocumentReadback(driverDocumentId, rpcName);
  const driverProfileId =
    asNonEmptyString(result.driver_profile_id) ??
    asNonEmptyString(result.driver_id) ??
    asNonEmptyString(args.driver_profile_id) ??
    asNonEmptyString(args.driver_id);
  if (driverProfileId) await requireLiveDriverProfileReadback(driverProfileId, rpcName);
}

export async function confirmDriverComplianceEvent(
  args: Record<string, unknown>,
  result: Record<string, unknown>,
): Promise<void> {
  const eventId =
    asNonEmptyString(result.driver_compliance_event_id) ??
    asNonEmptyString(result.compliance_event_id) ??
    asNonEmptyString(result.id);
  if (!eventId) throw new Error('create_driver_compliance_event_v1 did not return driver_compliance_event_id');
  await requireLiveDriverComplianceEventReadback(eventId, 'create_driver_compliance_event_v1');
  const driverProfileId =
    asNonEmptyString(result.driver_profile_id) ??
    asNonEmptyString(result.driver_id) ??
    asNonEmptyString(args.driver_profile_id) ??
    asNonEmptyString(args.driver_id);
  if (driverProfileId) await requireLiveDriverProfileReadback(driverProfileId, 'create_driver_compliance_event_v1');
}

export async function confirmDriverHoursOfServiceSegment(
  args: Record<string, unknown>,
  result: Record<string, unknown>,
): Promise<void> {
  const driverProfileId =
    asNonEmptyString(result.driver_profile_id) ??
    asNonEmptyString(args.driver_profile_id) ??
    asNonEmptyString(args.driver_id);
  if (!driverProfileId) {
    throw new Error('record_hours_of_service_segment_v1 did not return driver_profile_id');
  }
  await requireLiveDriverHoursOfServiceReadback(
    driverProfileId,
    asNonEmptyString(result.duty_status ?? args.duty_status),
    'record_hours_of_service_segment_v1',
    asNonEmptyString(result.driver_hours_of_service_id ?? result.hours_of_service_id ?? result.id),
  );
}
