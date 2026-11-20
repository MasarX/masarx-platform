import type { MobileAttestationPolicy } from "./mobile-attestation-policy";
import { shouldEnforceAttestationForRpc } from "./mobile-attestation-policy";

export type MobileAttestationRuntimePlatform = "android" | "ios" | "web" | string;

export type MobileAttestationRuntimeGate = {
  shouldBuild: boolean;
  enforce: boolean;
  reason:
    | "not_required"
    | "background_allowed"
    | "required"
    | "offline"
    | "native_required"
    | "device_required"
    | "platform_unsupported"
    | "integrity_unavailable"
    | "android_project_missing"
    | "ios_unsupported";
  failureMessage: string | null;
};

function normalizePositiveNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) return value;
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  const next = Number(trimmed);
  return Number.isFinite(next) && next > 0 ? next : null;
}

function skip(reason: MobileAttestationRuntimeGate["reason"]): MobileAttestationRuntimeGate {
  return {
    shouldBuild: false,
    enforce: false,
    reason,
    failureMessage: null,
  };
}

function fail(
  reason: MobileAttestationRuntimeGate["reason"],
  message: string,
): MobileAttestationRuntimeGate {
  return {
    shouldBuild: false,
    enforce: true,
    reason,
    failureMessage: message,
  };
}

function normalizePlatform(value: MobileAttestationRuntimePlatform): string {
  return String(value ?? "").trim().toLowerCase();
}

export function resolveMobileAttestationRuntimeGate(input: {
  policy: MobileAttestationPolicy;
  rpcName: string;
  source?: string | null;
  online: boolean;
  platform: MobileAttestationRuntimePlatform;
  isDevice: boolean;
  appIntegrityAvailable: boolean;
  iosAppAttestSupported?: boolean | null;
}): MobileAttestationRuntimeGate {
  const enforce = input.policy.mode === "enforce";
  const platform = normalizePlatform(input.platform);
  if (!shouldEnforceAttestationForRpc(input.policy, input.rpcName)) {
    return skip("not_required");
  }
  if (input.source === "mobile_background" && input.policy.allowBackgroundWithoutAttestation) {
    return skip("background_allowed");
  }

  if (!input.online) {
    return enforce
      ? fail("offline", "Attestation requires an online connection.")
      : skip("offline");
  }
  if (platform === "web") {
    return enforce
      ? fail("native_required", "Attestation requires a native device build.")
      : skip("native_required");
  }
  if (!input.isDevice) {
    return enforce
      ? fail("device_required", "Attestation requires a physical device.")
      : skip("device_required");
  }
  if (platform !== "android" && platform !== "ios") {
    return enforce
      ? fail("platform_unsupported", "Attestation policy is enabled for an unsupported platform.")
      : skip("platform_unsupported");
  }
  if (!input.appIntegrityAvailable) {
    return enforce
      ? fail(
          "integrity_unavailable",
          "Attestation requires a development build with Expo App Integrity enabled.",
        )
      : skip("integrity_unavailable");
  }
  if (
    platform === "android" &&
    normalizePositiveNumber(input.policy.androidCloudProjectNumber) == null
  ) {
    return enforce
      ? fail("android_project_missing", "Attestation policy requires android_cloud_project_number.")
      : skip("android_project_missing");
  }
  if (platform === "ios" && input.iosAppAttestSupported === false) {
    return enforce
      ? fail("ios_unsupported", "App Attest is not supported on this iOS device.")
      : skip("ios_unsupported");
  }

  return {
    shouldBuild: true,
    enforce,
    reason: "required",
    failureMessage: null,
  };
}
