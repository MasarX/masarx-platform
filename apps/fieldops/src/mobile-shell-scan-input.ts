import type { MobilePlatform } from "./mobile-shell-policy";

export type MobileScanInputMode = "camera" | "scanner";

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function normalizeScanInputMode(value: unknown): MobileScanInputMode | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  if (normalized === "camera" || normalized === "scanner") return normalized;
  return null;
}

function normalizeUniqueModes(input: unknown): MobileScanInputMode[] {
  if (!Array.isArray(input)) return [];
  const out: MobileScanInputMode[] = [];
  for (const candidate of input) {
    const normalized = normalizeScanInputMode(candidate);
    if (normalized && !out.includes(normalized)) out.push(normalized);
  }
  return out;
}

export function defaultScanInputModeForPlatform(
  platform: MobilePlatform
): MobileScanInputMode {
  return platform === "scanner" ? "scanner" : "camera";
}

export function defaultScanInputModesForPlatform(
  platform: MobilePlatform
): MobileScanInputMode[] {
  if (platform === "scanner") return ["scanner"];
  return ["camera", "scanner"];
}

export function resolveAllowedScanInputModes(params: {
  policyValue: unknown;
  platform: MobilePlatform;
}): MobileScanInputMode[] {
  const value = asRecord(params.policyValue);
  const primary = normalizeUniqueModes(value.scan_input_modes);
  if (primary.length) return primary;
  const secondary = normalizeUniqueModes(value.accepted_input_modes);
  if (secondary.length) return secondary;
  return defaultScanInputModesForPlatform(params.platform);
}

export function resolveEffectiveScanInputMode(params: {
  storedMode: unknown;
  platform: MobilePlatform;
  allowedModes: MobileScanInputMode[];
}): MobileScanInputMode {
  const allowedModes = params.allowedModes.length
    ? params.allowedModes
    : defaultScanInputModesForPlatform(params.platform);
  const storedMode = normalizeScanInputMode(params.storedMode);
  if (storedMode && allowedModes.includes(storedMode)) return storedMode;
  const fallback = defaultScanInputModeForPlatform(params.platform);
  if (allowedModes.includes(fallback)) return fallback;
  return allowedModes[0] ?? fallback;
}
