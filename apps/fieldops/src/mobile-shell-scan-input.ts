import type { MobilePlatform } from "./mobile-shell-policy";

export type MobileScanInputMode = "camera" | "scanner";

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
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
  const modes = value.scan_input_modes;
  if (!Array.isArray(modes) || modes.length === 0 ||
      modes.some((mode) => mode !== "camera" && mode !== "scanner") ||
      new Set(modes).size !== modes.length) return [];
  const platformModes = defaultScanInputModesForPlatform(params.platform);
  return (modes as MobileScanInputMode[]).filter((mode) => platformModes.includes(mode));
}

export function resolveEffectiveScanInputMode(params: {
  storedMode: unknown;
  platform: MobilePlatform;
  allowedModes: MobileScanInputMode[];
}): MobileScanInputMode | null {
  const allowedModes = params.allowedModes;
  if (!allowedModes.length) return null;
  const storedMode = typeof params.storedMode === "string" ? params.storedMode : "";
  if ((storedMode === "camera" || storedMode === "scanner") &&
      allowedModes.includes(storedMode)) return storedMode;
  const fallback = defaultScanInputModeForPlatform(params.platform);
  if (allowedModes.includes(fallback)) return fallback;
  return allowedModes[0];
}
