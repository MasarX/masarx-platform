export const MOBILE_V2_DEVICE_ID_STORAGE_KEY = "fieldops_device_id_v1";
export const MOBILE_V2_DEVICE_INSTALL_ID_STORAGE_KEY = "fieldops_device_install_id_v1";
export const MOBILE_V2_ACTIVE_OPS_SESSION_STORAGE_KEY = "fieldops_active_ops_session_v1";
export const MOBILE_V2_OPS_SESSION_READBACK_RESOURCE = "ops_sessions";
export const MOBILE_V2_DRIVER_SHIFT_START_READBACK_FAILED_MESSAGE =
  "Driver shift did not confirm the open session";
export const MOBILE_V2_DRIVER_SHIFT_CLOSE_READBACK_FAILED_MESSAGE =
  "Driver shift did not confirm the closed session";
export const MOBILE_V2_DRIVER_SHIFT_READINESS_BLOCKED_MESSAGE =
  "Complete documents, vehicle, photos, cleaning, and pre-shift clearance before starting shift";

export interface MobileV2ActiveDriverShift {
  readonly opsSessionId: string;
  readonly openedAt: string | null;
}

export interface MobileV2OpsSessionReadback {
  readonly opsSessionId: string;
  readonly sessionType: string;
  readonly status: string;
  readonly deviceId: string | null;
  readonly actorUserId: string | null;
  readonly openedAt: string | null;
  readonly closedAt: string | null;
  readonly version: number | null;
}

export interface MobileV2DriverShiftReadinessRequirements {
  readonly docsComplete: boolean;
  readonly vehicleSubmitted: boolean;
  readonly vehiclePhotosSubmitted: boolean;
  readonly cleaningAttested: boolean;
  readonly cleaningRequired: boolean;
  readonly preShiftCleared: boolean;
}

export function readMobileV2ActiveDriverShift(raw: string | null): MobileV2ActiveDriverShift | null {
  if (raw === null || raw.trim() === "") return null;
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const opsSessionId =
      typeof parsed.opsSessionId === "string" && parsed.opsSessionId.trim() !== ""
        ? parsed.opsSessionId.trim()
        : null;
    if (opsSessionId === null) return null;
    return {
      opsSessionId,
      openedAt: typeof parsed.openedAt === "string" && parsed.openedAt.trim() !== "" ? parsed.openedAt : null,
    };
  } catch {
    return null;
  }
}

function readNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

function readFiniteNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

export function parseMobileV2OpsSessionReadback(raw: unknown): MobileV2OpsSessionReadback | null {
  const row = Array.isArray(raw)
    ? raw.find((candidate): candidate is Record<string, unknown> =>
        candidate !== null && typeof candidate === "object" && !Array.isArray(candidate),
      )
    : raw;
  if (row === null || typeof row !== "object" || Array.isArray(row)) return null;
  const record = row as Record<string, unknown>;
  const opsSessionId = readNonEmptyString(record.id) ?? readNonEmptyString(record.ops_session_id);
  const sessionType = readNonEmptyString(record.session_type);
  const status = readNonEmptyString(record.status);
  if (opsSessionId === null || sessionType === null || status === null) return null;
  return Object.freeze({
    opsSessionId,
    sessionType,
    status,
    deviceId: readNonEmptyString(record.device_id),
    actorUserId: readNonEmptyString(record.actor_user_id),
    openedAt: readNonEmptyString(record.opened_at),
    closedAt: readNonEmptyString(record.closed_at),
    version: readFiniteNumber(record.version),
  });
}

export function buildMobileV2OpsSessionReadbackInput(opsSessionId: string): Record<string, unknown> {
  return {
    p_resource: MOBILE_V2_OPS_SESSION_READBACK_RESOURCE,
    p_id: opsSessionId,
  };
}

export function mobileV2DriverShiftStartMatchesReadback(
  readback: MobileV2OpsSessionReadback | null,
  expected: {
    readonly opsSessionId: string;
    readonly deviceId?: string | null;
  },
): boolean {
  if (readback === null) return false;
  const expectedDeviceId = expected.deviceId?.trim() || null;
  return (
    readback.opsSessionId === expected.opsSessionId.trim() &&
    readback.sessionType === "driver_shift" &&
    readback.status === "open" &&
    readback.closedAt === null &&
    (expectedDeviceId === null || readback.deviceId === expectedDeviceId)
  );
}

export function mobileV2DriverShiftCloseMatchesReadback(
  readback: MobileV2OpsSessionReadback | null,
  expected: {
    readonly opsSessionId: string;
  },
): boolean {
  if (readback === null) return false;
  return (
    readback.opsSessionId === expected.opsSessionId.trim() &&
    readback.sessionType === "driver_shift" &&
    readback.status === "closed" &&
    readback.closedAt !== null
  );
}

export function mobileV2DriverShiftReadinessAllowsStart(
  requirements: MobileV2DriverShiftReadinessRequirements | null | undefined,
): boolean {
  if (requirements === null || requirements === undefined) return false;
  return (
    requirements.docsComplete === true &&
    requirements.vehicleSubmitted === true &&
    requirements.vehiclePhotosSubmitted === true &&
    (
      requirements.cleaningRequired === false ||
      requirements.cleaningAttested === true
    ) &&
    requirements.preShiftCleared === true
  );
}

export function buildMobileV2StartDriverShiftInput(input: {
  readonly deviceId: string;
  readonly openedAt: string;
}): Record<string, unknown> {
  return {
    session_type: "driver_shift",
    device_id: input.deviceId,
    opened_at: input.openedAt,
    idempotency_key: `driver-shift-${input.deviceId}-${input.openedAt}`,
    metadata: {
      app: "fieldops",
      surface: "mobile_v2_more",
      source: "mobile_v2_native_shell",
    },
  };
}

export function buildMobileV2EndDriverShiftInput(input: {
  readonly opsSessionId: string;
  readonly effectiveAt: string;
}): Record<string, unknown> {
  return {
    ops_session_id: input.opsSessionId,
    to_status: "closed",
    set_closed_at: true,
    effective_at: input.effectiveAt,
    idempotency_key: `driver-shift-close-${input.opsSessionId}-${input.effectiveAt}`,
    payload: {
      app: "fieldops",
      surface: "mobile_v2_more",
      source: "mobile_v2_native_shell",
    },
  };
}
