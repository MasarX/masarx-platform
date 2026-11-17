export type MobileAttestationMode = "off" | "monitor" | "enforce";
export type MobileAttestationProvider = "android_play_integrity" | "ios_app_attest";

export type MobileAttestationPolicy = {
  enabled: boolean;
  mode: MobileAttestationMode;
  enforceRpcs: string[];
  allowedProviders: MobileAttestationProvider[];
  maxAgeSeconds: number;
  challengeTtlSeconds: number;
  allowBackgroundWithoutAttestation: boolean;
  androidCloudProjectNumber: string | null;
};

export const DEFAULT_MOBILE_ATTESTATION_POLICY: MobileAttestationPolicy = {
  enabled: false,
  mode: "off",
  enforceRpcs: [
    "register_user_device_v1",
    "record_location_ping_v1",
    "record_scan_event_v1",
    "open_ops_session_v1",
  ],
  allowedProviders: ["android_play_integrity", "ios_app_attest"],
  maxAgeSeconds: 300,
  challengeTtlSeconds: 120,
  allowBackgroundWithoutAttestation: false,
  androidCloudProjectNumber: null,
};

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function readBoolean(value: unknown, fallback: boolean): boolean {
  if (typeof value === "boolean") return value;
  return fallback;
}

function readString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function readBoundedInt(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  const normalized = Math.floor(value);
  if (normalized < min || normalized > max) return fallback;
  return normalized;
}

function normalizeMode(value: unknown, fallback: MobileAttestationMode): MobileAttestationMode {
  const next = readString(value)?.toLowerCase();
  if (next === "off" || next === "monitor" || next === "enforce") {
    return next;
  }
  return fallback;
}

function normalizeRpcArray(value: unknown, fallback: string[]): string[] {
  if (!Array.isArray(value)) return fallback;
  const out = value
    .map((entry) => (typeof entry === "string" ? entry.trim().toLowerCase() : ""))
    .filter((entry) => entry.length > 0);
  const unique = Array.from(new Set(out));
  return unique.length > 0 ? unique : fallback;
}

function normalizeProviderArray(
  value: unknown,
  fallback: MobileAttestationProvider[]
): MobileAttestationProvider[] {
  if (!Array.isArray(value)) return fallback;
  const out: MobileAttestationProvider[] = [];
  for (const entry of value) {
    const next = typeof entry === "string" ? entry.trim().toLowerCase() : "";
    if (next === "android_play_integrity" || next === "ios_app_attest") {
      if (!out.includes(next)) out.push(next);
    }
  }
  return out.length > 0 ? out : fallback;
}

export function normalizeMobileAttestationPolicy(value: unknown): MobileAttestationPolicy {
  const input = asRecord(value);
  const enabled = readBoolean(input.enabled, DEFAULT_MOBILE_ATTESTATION_POLICY.enabled);
  const mode = normalizeMode(
    input.mode,
    enabled ? DEFAULT_MOBILE_ATTESTATION_POLICY.mode : "off"
  );

  return {
    enabled,
    mode,
    enforceRpcs: normalizeRpcArray(input.enforce_rpcs, DEFAULT_MOBILE_ATTESTATION_POLICY.enforceRpcs),
    allowedProviders: normalizeProviderArray(
      input.allowed_providers,
      DEFAULT_MOBILE_ATTESTATION_POLICY.allowedProviders
    ),
    maxAgeSeconds: readBoundedInt(
      input.max_age_seconds,
      DEFAULT_MOBILE_ATTESTATION_POLICY.maxAgeSeconds,
      30,
      86_400
    ),
    challengeTtlSeconds: readBoundedInt(
      input.challenge_ttl_seconds,
      DEFAULT_MOBILE_ATTESTATION_POLICY.challengeTtlSeconds,
      30,
      900
    ),
    allowBackgroundWithoutAttestation: readBoolean(
      input.allow_background_without_attestation,
      DEFAULT_MOBILE_ATTESTATION_POLICY.allowBackgroundWithoutAttestation
    ),
    androidCloudProjectNumber: readString(input.android_cloud_project_number),
  };
}

export function shouldEnforceAttestationForRpc(
  policy: MobileAttestationPolicy,
  rpcName: string
): boolean {
  if (!policy.enabled) return false;
  if (policy.mode === "off") return false;
  const next = rpcName.trim().toLowerCase();
  if (!next) return false;
  if (policy.enforceRpcs.length === 0) return true;
  return policy.enforceRpcs.includes(next);
}
