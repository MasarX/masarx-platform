// PREVIEW/DEV FIXTURE — DO NOT IMPORT IN PRODUCTION.
// See ./README.md for the production cutover procedure.

import type {
  MobileV2SyncConnectivity,
  MobileV2SyncEntry,
} from "../mobile-v2-sync-queue-screen";

/** Builder so timestamps stay fresh on reload — production paths read
 * these from `public.resolve_fieldops_sync_queue_v1`. */
export function buildMobileV2PreviewSyncQueue(): ReadonlyArray<MobileV2SyncEntry> {
  const now = Date.now();
  return Object.freeze([
    Object.freeze({
      id: "sq-1",
      kind: "pod.commit" as const,
      stopId: "MX-2026-04421-001",
      atMs: now - 2 * 60_000,
      status: "queued" as const,
      retryCount: 0,
    }),
    Object.freeze({
      id: "sq-2",
      kind: "stop.update" as const,
      stopId: "MX-2026-04421-014",
      atMs: now - 7 * 60_000,
      status: "retrying" as const,
      retryCount: 2,
    }),
    Object.freeze({
      id: "sq-3",
      kind: "stop.failed" as const,
      stopId: "MX-2026-04421-018",
      atMs: now - 14 * 60_000,
      status: "queued" as const,
      retryCount: 0,
    }),
    Object.freeze({
      id: "sq-4",
      kind: "comm.send" as const,
      stopId: "MX-2026-04421-021",
      atMs: now - 30 * 60_000,
      status: "sent" as const,
      retryCount: 1,
    }),
  ]);
}

export const MOBILE_V2_PREVIEW_SYNC_QUEUE: {
  readonly queue: ReadonlyArray<MobileV2SyncEntry>;
  readonly connectivity: MobileV2SyncConnectivity;
  readonly lastSyncMs: number;
} = {
  queue: buildMobileV2PreviewSyncQueue(),
  connectivity: "online",
  lastSyncMs: Date.now() - 4 * 60_000,
};
