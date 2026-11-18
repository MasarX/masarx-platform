export const MOBILE_V2_POD_READBACK_FAILED_MESSAGE =
  "POD saved, but the stop did not refresh";

export interface MobileV2PodReadbackRefetcher {
  readonly label: string;
  readonly refetch: () => Promise<unknown>;
  readonly expect?: (data: unknown) => boolean;
}

export interface MobileV2PodReadbackResult {
  readonly ok: boolean;
  readonly failedLabels: ReadonlyArray<string>;
}

export interface MobileV2PodReadbackOptions {
  readonly attempts?: number;
  readonly delayMs?: number;
}

export type MobileV2TerminalStopStatus = "done" | "failed" | "partial";

const DEFAULT_MOBILE_V2_POD_READBACK_ATTEMPTS = 5;
const DEFAULT_MOBILE_V2_POD_READBACK_DELAY_MS = 600;

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isErroredQueryResult(value: unknown): boolean {
  if (value === null || typeof value !== "object") return false;
  const candidate = value as { readonly isError?: unknown; readonly error?: unknown };
  return candidate.isError === true || candidate.error instanceof Error;
}

function queryResultData(value: unknown): unknown {
  if (value === null || typeof value !== "object") return value;
  if (!("data" in value)) return value;
  return (value as { readonly data?: unknown }).data;
}

export async function refreshMobileV2PodReadback(
  refetchers: ReadonlyArray<MobileV2PodReadbackRefetcher>,
  options: MobileV2PodReadbackOptions = {},
): Promise<MobileV2PodReadbackResult> {
  const attempts = Math.max(
    1,
    Math.floor(options.attempts ?? DEFAULT_MOBILE_V2_POD_READBACK_ATTEMPTS),
  );
  const delayMs = Math.max(
    0,
    Math.floor(options.delayMs ?? DEFAULT_MOBILE_V2_POD_READBACK_DELAY_MS),
  );
  let failedLabels: ReadonlyArray<string> = Object.freeze([]);

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const results = await Promise.all(
      refetchers.map(async (entry) => {
        try {
          const result = await entry.refetch();
          const data = queryResultData(result);
          const expectationFailed = entry.expect !== undefined && !entry.expect(data);
          return { label: entry.label, result, rejected: false, expectationFailed };
        } catch {
          return { label: entry.label, result: null, rejected: true, expectationFailed: false };
        }
      }),
    );
    failedLabels = Object.freeze(results.flatMap((result) =>
      result.rejected || isErroredQueryResult(result.result) || result.expectationFailed
        ? [result.label]
        : [],
    ));
    if (failedLabels.length === 0) {
      return Object.freeze({ ok: true, failedLabels });
    }
    if (attempt < attempts && delayMs > 0) {
      await wait(delayMs);
    }
  }

  return Object.freeze({ ok: false, failedLabels });
}

export function mobileV2StopDetailHasPodReadback(
  data: unknown,
  outcome: "delivered" | "failed" | "partial",
  expectedProofKeys?: ReadonlyArray<string>,
  expectedPartialParcelCodes?: ReadonlyArray<string>,
): boolean {
  if (data === null || typeof data !== "object") return false;
  const record = data as {
    readonly parcels?: unknown;
    readonly proofChecklist?: unknown;
    readonly timeline?: unknown;
  };
  if (outcome === "delivered" || outcome === "partial") {
    if (!Array.isArray(record.proofChecklist) || record.proofChecklist.length === 0) {
      return false;
    }
    const proofChecklist = record.proofChecklist;
    const proofReady = expectedProofKeys !== undefined && expectedProofKeys.length > 0
      ? expectedProofKeys.every((key) =>
        proofChecklist.some((entry: unknown) => {
          if (entry === null || typeof entry !== "object") return false;
          const item = entry as { readonly key?: unknown; readonly status?: unknown };
          return item.key === key && item.status === "done";
        }),
      )
      : proofChecklist.every((entry: unknown) => {
      if (entry === null || typeof entry !== "object") return false;
      return (entry as { readonly status?: unknown }).status === "done";
    });
    if (!proofReady) return false;
    if (outcome !== "partial") return true;
    return mobileV2StopDetailHasPartialParcelSubset(record, expectedPartialParcelCodes);
  }
  if (!Array.isArray(record.timeline) || record.timeline.length === 0) return false;
  return record.timeline.some((entry) => {
    if (entry === null || typeof entry !== "object") return false;
    const item = entry as { readonly tone?: unknown; readonly icon?: unknown };
    return item.tone === "danger" || item.icon === "alert";
  });
}

export function mobileV2StopDetailHasCodCollectionReadback(
  data: unknown,
  expectedAmount: number,
): boolean {
  if (!Number.isFinite(expectedAmount) || expectedAmount <= 0) return false;
  if (data === null || typeof data !== "object") return false;
  const paymentCollection = (data as { readonly paymentCollection?: unknown }).paymentCollection;
  if (
    paymentCollection === null
    || typeof paymentCollection !== "object"
    || Array.isArray(paymentCollection)
  ) {
    return false;
  }
  const record = paymentCollection as {
    readonly outcome?: unknown;
    readonly expectedAmount?: unknown;
    readonly collectedAmount?: unknown;
  };
  const expected = typeof record.expectedAmount === "number" && Number.isFinite(record.expectedAmount)
    ? record.expectedAmount
    : null;
  const collected = typeof record.collectedAmount === "number" && Number.isFinite(record.collectedAmount)
    ? record.collectedAmount
    : null;
  return record.outcome === "collected"
    && expected === expectedAmount
    && collected === expectedAmount;
}

export function mobileV2StopDetailHasPartialParcelSubset(
  data: unknown,
  expectedScannedCodes?: ReadonlyArray<string>,
): boolean {
  if (data === null || typeof data !== "object") return false;
  const parcels = (data as { readonly parcels?: unknown }).parcels;
  if (!Array.isArray(parcels) || parcels.length < 2) return false;
  const scannedCodes = new Set<string>();
  let scannedCount = 0;
  let pendingCount = 0;
  for (const parcel of parcels) {
    if (parcel === null || typeof parcel !== "object") continue;
    const item = parcel as { readonly code?: unknown; readonly status?: unknown };
    const code = typeof item.code === "string" ? item.code.trim() : "";
    if (item.status === "scanned" || item.status === "delivered") {
      scannedCount += 1;
      if (code !== "") scannedCodes.add(code);
    } else if (item.status === "pending") {
      pendingCount += 1;
    }
  }
  if (scannedCount < 1 || pendingCount < 1 || scannedCount >= parcels.length) {
    return false;
  }
  if (expectedScannedCodes === undefined || expectedScannedCodes.length === 0) {
    return true;
  }
  const expected = new Set(expectedScannedCodes.map((code) => code.trim()).filter(Boolean));
  if (expected.size === 0 || scannedCodes.size !== expected.size) return false;
  for (const code of expected) {
    if (!scannedCodes.has(code)) return false;
  }
  return true;
}

export function mobileV2RouteHasStopStatus(
  data: unknown,
  stopTaskId: string,
  expectedStatus: MobileV2TerminalStopStatus,
): boolean {
  if (data === null || typeof data !== "object") return false;
  const rows = (data as { readonly rows?: unknown }).rows;
  if (!Array.isArray(rows)) return false;
  return rows.some((entry) => {
    if (entry === null || typeof entry !== "object") return false;
    const row = entry as { readonly id?: unknown; readonly status?: unknown };
    return row.id === stopTaskId && row.status === expectedStatus;
  });
}

export function mobileV2FindTerminalRouteStopStatus(
  rows: unknown,
  stopTaskId: string,
): MobileV2TerminalStopStatus | null {
  if (!Array.isArray(rows)) return null;
  const row = rows.find((entry) => {
    if (entry === null || typeof entry !== "object") return false;
    return (entry as { readonly id?: unknown }).id === stopTaskId;
  });
  if (row === null || row === undefined || typeof row !== "object") return null;
  const status = (row as { readonly status?: unknown }).status;
  return status === "done" || status === "failed" || status === "partial" ? status : null;
}

export function mobileV2ShouldReturnToStopAfterTerminalReadback(
  activeTabId: string,
  terminalState: MobileV2TerminalStopStatus | null,
): boolean {
  return activeTabId === "mobile-pod" && terminalState !== null;
}

export function mobileV2TasksHaveRouteStopStatus(
  data: unknown,
  stopTaskId: string,
  expectedStatus: MobileV2TerminalStopStatus,
): boolean {
  if (!Array.isArray(data)) return false;
  return data.some((entry) => {
    if (entry === null || typeof entry !== "object") return false;
    const task = entry as {
      readonly task_id?: unknown;
      readonly meta?: unknown;
    };
    if (task.task_id !== stopTaskId || task.meta === null || typeof task.meta !== "object") {
      return false;
    }
    return (task.meta as { readonly route_stop_status?: unknown }).route_stop_status === expectedStatus;
  });
}
