import type { MobileV2LoaderScanEntry } from "./mobile-v2-loader-scan-screen";
import type { MobileV2LoaderScanMode } from "./mobile-v2-loader-policy";
import type { MobileV2SortationInduction } from "./mobile-v2-sortation-screen";

function normalizeTracking(value: string): string {
  return value.trim().toUpperCase();
}

export interface MobileV2LoaderReadbackInput {
  readonly recent: ReadonlyArray<MobileV2SortationInduction>;
  readonly submittedCodes: ReadonlyArray<string>;
  readonly action: string;
  readonly mode: MobileV2LoaderScanMode;
}

export interface MobileV2LoaderReadbackResult {
  readonly scans: ReadonlyArray<MobileV2LoaderScanEntry>;
  readonly missingCodes: ReadonlyArray<string>;
}

export function isMobileV2LoaderReadbackScanEntry(
  entry: Pick<MobileV2LoaderScanEntry, "id">,
): boolean {
  return entry.id.startsWith("readback-");
}

/**
 * Rebuilds the loader scan log from the backend sortation resolver after
 * submit. The screen keeps operators in place and only marks submitted codes
 * successful when the resolver returns those exact tracking numbers.
 */
export function buildMobileV2LoaderReadbackScans(
  input: MobileV2LoaderReadbackInput,
): MobileV2LoaderReadbackResult {
  const recentByTracking = new Map<string, MobileV2SortationInduction>();
  for (const row of input.recent) {
    const key = normalizeTracking(row.parcel);
    if (key.length > 0 && !recentByTracking.has(key)) {
      recentByTracking.set(key, row);
    }
  }

  const scans: MobileV2LoaderScanEntry[] = [];
  const missingCodes: string[] = [];
  for (const code of input.submittedCodes) {
    const normalized = normalizeTracking(code);
    if (normalized.length === 0) continue;
    const row = recentByTracking.get(normalized);
    if (row === undefined) {
      missingCodes.push(code);
      continue;
    }
    scans.push({
      id: `readback-${row.id}`,
      code,
      action: input.action,
      mode: input.mode,
      status: "ok",
      time: row.at,
    });
  }

  return Object.freeze({
    scans: Object.freeze(scans),
    missingCodes: Object.freeze(missingCodes),
  });
}
