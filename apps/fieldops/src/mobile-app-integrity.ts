type ExpoAppIntegrityModule = {
  isSupported?: boolean;
  generateKeyAsync: () => Promise<string>;
  attestKeyAsync: (keyId: string, challenge: string) => Promise<string>;
  generateAssertionAsync: (keyId: string, challenge: string) => Promise<string>;
  prepareIntegrityTokenProviderAsync: (cloudProjectNumber: number) => Promise<void>;
  requestIntegrityCheckAsync: (requestHash: string) => Promise<string>;
};

let cachedModule: ExpoAppIntegrityModule | null | undefined;

const APP_INTEGRITY_UNAVAILABLE_ERROR =
  "Expo App Integrity native module is unavailable in this runtime (Expo Go). Use a development build for native attestation.";

function resolveAppIntegrityModule(): ExpoAppIntegrityModule | null {
  if (cachedModule !== undefined) return cachedModule;
  try {
    // Dynamic require keeps Expo Go from crashing when the native module is unavailable.
    // eslint-disable-next-line @typescript-eslint/no-var-requires, global-require
    cachedModule = require("@expo/app-integrity") as ExpoAppIntegrityModule;
  } catch {
    cachedModule = null;
  }
  return cachedModule;
}

function requireAppIntegrityModule(): ExpoAppIntegrityModule {
  const resolved = resolveAppIntegrityModule();
  if (!resolved) {
    throw new Error(APP_INTEGRITY_UNAVAILABLE_ERROR);
  }
  return resolved;
}

export function isExpoAppIntegrityAvailable(): boolean {
  return resolveAppIntegrityModule() != null;
}

export function isIosAppIntegritySupported(): boolean {
  const moduleRef = resolveAppIntegrityModule();
  return moduleRef?.isSupported === true;
}

export async function generateIosAttestationKeyAsync(): Promise<string> {
  return requireAppIntegrityModule().generateKeyAsync();
}

export async function attestIosKeyAsync(keyId: string, challenge: string): Promise<string> {
  return requireAppIntegrityModule().attestKeyAsync(keyId, challenge);
}

export async function generateIosAssertionAsync(keyId: string, challenge: string): Promise<string> {
  return requireAppIntegrityModule().generateAssertionAsync(keyId, challenge);
}

export async function prepareAndroidIntegrityTokenProviderAsync(
  cloudProjectNumber: number
): Promise<void> {
  return requireAppIntegrityModule().prepareIntegrityTokenProviderAsync(cloudProjectNumber);
}

export async function requestAndroidIntegrityCheckAsync(requestHash: string): Promise<string> {
  return requireAppIntegrityModule().requestIntegrityCheckAsync(requestHash);
}

export function __resetAppIntegrityModuleForTests(): void {
  cachedModule = undefined;
}
