import type { MobileDevicePolicy, MobilePlatform } from "./mobile-shell-policy";

function normalizePlatform(value: unknown): MobilePlatform | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  if (normalized === "android" || normalized === "ios" || normalized === "scanner") {
    return normalized;
  }
  return null;
}

function normalizeUniquePlatforms(input: unknown): MobilePlatform[] {
  if (!Array.isArray(input)) return [];
  const out: MobilePlatform[] = [];
  for (const candidate of input) {
    const normalized = normalizePlatform(candidate);
    if (normalized && !out.includes(normalized)) out.push(normalized);
  }
  return out;
}

export function resolveRuntimeMobilePlatform(platformOs: string): MobilePlatform {
  return platformOs === "ios" ? "ios" : "android";
}

export function resolveAllowedMobilePlatforms(policy: MobileDevicePolicy): MobilePlatform[] {
  const allowed = normalizeUniquePlatforms(policy.allowedPlatforms);
  if (allowed.length > 0) return allowed;
  const fallback = normalizePlatform(policy.defaultPlatform);
  return fallback ? [fallback] : ["android"];
}

export function resolveNormalizedPlatformOverride(params: {
  storedOverride: unknown;
  allowedPlatforms: MobilePlatform[];
}): MobilePlatform | null {
  const normalized = normalizePlatform(params.storedOverride);
  if (!normalized) return null;
  if (!params.allowedPlatforms.includes(normalized)) return null;
  return normalized;
}

export function resolveEffectiveMobilePlatform(params: {
  policy: MobileDevicePolicy;
  runtimePlatform: MobilePlatform;
  storedOverride: unknown;
}): MobilePlatform {
  const allowedPlatforms = resolveAllowedMobilePlatforms(params.policy);
  const override = resolveNormalizedPlatformOverride({
    storedOverride: params.storedOverride,
    allowedPlatforms,
  });
  if (override) return override;
  if (allowedPlatforms.includes(params.runtimePlatform)) return params.runtimePlatform;
  if (allowedPlatforms.includes(params.policy.defaultPlatform)) return params.policy.defaultPlatform;
  return allowedPlatforms[0] ?? params.runtimePlatform;
}
