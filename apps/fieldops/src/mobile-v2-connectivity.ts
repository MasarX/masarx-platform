// Mobile V2 connectivity model — the SSOT for the shell's "online ·
// N queued" indicator.
//
// Engineering audit B3 (BLOCKER): `PreviewBody` previously held
// `const [online] = React.useState(false)` and
// `const [queueCount] = React.useState(3)` — constants that were never
// wired to anything. In the production native shell every driver saw a
// permanent fabricated "offline · 3 queued" banner regardless of the
// real device network state or the real outbox depth.
//
// This module defines the typed connectivity envelope `PreviewBody`
// consumes via its optional `connectivity` prop. Two producers exist:
//
//   - `MobileV2NativeShell` (production): wires REAL values — device
//     network reachability + `outbox.countPending()` — through the
//     `useMobileV2ShellConnectivity` hook below.
//   - `MobileV2PreviewScreen` (the `?v2=preview` design showcase):
//     passes the fixed design-rehearsal value
//     `MOBILE_V2_PREVIEW_CONNECTIVITY` so the visual baselines and the
//     design-parity offline state never churn.
//
// All functions here are pure / React-free so the jest unit runner can
// cover them without rendering a React Native tree.

/**
 * Connectivity snapshot consumed by the V2 shell. `online` reflects the
 * real device network reachability; `queueCount` is the count of
 * mutations durably queued in the offline outbox awaiting replay;
 * `syncing` is true while a drain pass is in flight.
 */
export interface MobileV2Connectivity {
  /** True when the device has a usable network path to the backend. */
  readonly online: boolean;
  /** Count of pending (not-yet-replayed) outbox entries. */
  readonly queueCount: number;
  /** True while the outbox drainer is actively replaying entries. */
  readonly syncing: boolean;
}

/**
 * Fixed design-rehearsal connectivity used ONLY by the `?v2=preview`
 * showcase. The showcase is a static design-parity surface with
 * `supabase=null`; it has no device network state and no real outbox,
 * so it rehearses the "offline · 3 queued" banner deterministically.
 * Visual baselines are recorded against this exact state — do not
 * change it without re-recording the affected snapshots.
 */
export const MOBILE_V2_PREVIEW_CONNECTIVITY: MobileV2Connectivity = Object.freeze({
  online: false,
  queueCount: 3,
  syncing: false,
});

/**
 * Minimal shape of an `expo-network` state object. Kept structural so
 * this module does not import `expo-network` (which is native-only and
 * would break the RN-free jest unit runner). `MobileV2NativeShell`
 * passes the real `Network.getNetworkStateAsync()` result; tests pass a
 * plain object.
 */
export interface MobileV2NetworkStateLike {
  readonly isConnected?: boolean | null;
  readonly isInternetReachable?: boolean | null;
}

/**
 * Resolve a boolean "online" verdict from an `expo-network` state.
 *
 * Fail-closed on a null/absent state (boot phase, permission denial):
 * an unknown network state is treated as offline so the shell shows the
 * offline banner rather than optimistically claiming connectivity.
 *
 * `isInternetReachable` is only a hard offline signal when it is
 * explicitly `false`; `null`/`undefined` means "not yet probed" and we
 * fall back to `isConnected` so a freshly-mounted shell with a live
 * radio is not painted offline while reachability is still resolving.
 */
export function resolveMobileV2OnlineFromNetworkState(
  state: MobileV2NetworkStateLike | null | undefined,
): boolean {
  if (state === null || state === undefined) return false;
  if (state.isConnected !== true) return false;
  if (state.isInternetReachable === false) return false;
  return true;
}

/**
 * Clamp a raw outbox count into a safe non-negative integer for the
 * shell badge. Guards against `NaN` / negative / fractional values that
 * a future outbox implementation drift could surface.
 */
export function normalizeMobileV2QueueCount(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return 0;
  return Math.max(0, Math.floor(value));
}

/**
 * Build a `MobileV2Connectivity` envelope from raw inputs. Centralized
 * so the native shell hook and any future producer agree on the
 * normalization rules.
 */
export function buildMobileV2Connectivity(input: {
  readonly networkState: MobileV2NetworkStateLike | null | undefined;
  readonly queueCount: unknown;
  readonly syncing?: boolean;
}): MobileV2Connectivity {
  return Object.freeze({
    online: resolveMobileV2OnlineFromNetworkState(input.networkState),
    queueCount: normalizeMobileV2QueueCount(input.queueCount),
    syncing: input.syncing === true,
  });
}

// ---------------------------------------------------------------------------
// Outbox entry projection — maps canonical outbox entries to the More
// screen's display shape.
// ---------------------------------------------------------------------------

/**
 * Display shape of a single outbox row on the Mobile V2 More screen.
 * Mirrors `MobileV2MoreOutboxEntry` (re-declared here to keep this
 * RN-free module independent of the screen component).
 */
export interface MobileV2OutboxDisplayEntry {
  readonly id: string;
  readonly label: string;
  readonly status: "queued" | "in-flight" | "failed";
  readonly ageMin: number;
}

/**
 * Minimal canonical outbox entry shape consumed by the projector — a
 * structural subset of `packages/mobile-core` `OutboxEntry` and of the
 * RPC layer's `MobileV2OutboxEntryView`.
 */
export interface MobileV2RawOutboxEntry {
  readonly id: string;
  readonly rpc: string;
  readonly status: "queued" | "in_flight" | "succeeded" | "failed" | "dead";
  readonly created_at: string;
}

/**
 * Project canonical outbox entries onto the More screen's display rows.
 *
 * - `succeeded` entries are dropped (they are no longer pending work).
 * - `dead` entries collapse to the `failed` display status (both are a
 *   stuck write the driver must notice).
 * - `in_flight` maps to the `in-flight` display token.
 * - The label is operator-facing copy, not the transport or RPC name.
 * - `ageMin` is whole minutes since `created_at`, floored at 0.
 *
 * Pure + RN-free so the jest unit runner covers it directly.
 */
export function projectMobileV2OutboxEntries(
  entries: ReadonlyArray<MobileV2RawOutboxEntry>,
  nowMs: number = Date.now(),
): ReadonlyArray<MobileV2OutboxDisplayEntry> {
  const out: MobileV2OutboxDisplayEntry[] = [];
  const labelForRpc = (rpc: string): string => {
    const normalized = rpc.trim().toLowerCase();
    if (normalized.includes("proof") || normalized.includes("pod")) return "Proof upload";
    if (normalized.includes("cash") || normalized.includes("settlement")) return "Cash update";
    if (normalized.includes("route") || normalized.includes("stop") || normalized.includes("trip")) return "Route update";
    if (normalized.includes("incident") || normalized.includes("hold")) return "Exception update";
    if (normalized.includes("pickup")) return "Pickup update";
    if (normalized.includes("kyc") || normalized.includes("vehicle") || normalized.includes("cleaning") || normalized.includes("shift")) {
      return "Profile update";
    }
    return "Queued update";
  };
  for (const e of entries) {
    if (e.status === "succeeded") continue;
    const status: MobileV2OutboxDisplayEntry["status"] =
      e.status === "in_flight" ? "in-flight" : e.status === "queued" ? "queued" : "failed";
    const createdMs = Date.parse(e.created_at);
    const ageMin =
      Number.isFinite(createdMs) && nowMs > createdMs
        ? Math.max(0, Math.floor((nowMs - createdMs) / 60_000))
        : 0;
    out.push(
      Object.freeze({
        id: e.id,
        label: labelForRpc(e.rpc),
        status,
        ageMin,
      }),
    );
  }
  return Object.freeze(out);
}

// ---------------------------------------------------------------------------
// Sync Queue screen projection.
// ---------------------------------------------------------------------------

export type MobileV2SyncQueueEntryKind =
  | "stop.update"
  | "pod.commit"
  | "stop.failed"
  | "cash.drop"
  | "comm.send"
  | "other";

export type MobileV2SyncQueueEntryStatus = "queued" | "retrying" | "sent" | "failed";

export interface MobileV2SyncQueueDisplayEntry {
  readonly id: string;
  readonly kind: MobileV2SyncQueueEntryKind;
  readonly stopId: string;
  readonly atMs: number;
  readonly status: MobileV2SyncQueueEntryStatus;
  readonly retryCount: number;
}

export interface MobileV2RawOutboxSyncEntry extends MobileV2RawOutboxEntry {
  readonly args?: Record<string, unknown>;
  readonly attempt_count?: number;
}

function readObject(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function readStringField(source: Record<string, unknown>, key: string): string | null {
  const value = source[key];
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

function readNumericLabelField(source: Record<string, unknown>, key: string): string | null {
  const value = source[key];
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return /^-?\d+(\.\d+)?$/.test(trimmed) ? trimmed : null;
}

function resolveOutboxStopLabel(
  args: Record<string, unknown> | undefined,
  rpc: string,
): string {
  if (rpc.trim().toLowerCase() === "sign_fieldops_cash_drop_v1") {
    const expected = args === undefined ? null : readNumericLabelField(args, "p_expected_sar");
    const actual = args === undefined ? null : readNumericLabelField(args, "p_actual_sar");
    if (expected !== null || actual !== null) {
      return `cash-drop ${actual ?? "?"}/${expected ?? "?"} SAR`;
    }
    return "cash-drop";
  }
  if (args === undefined) return "pending-write";
  const direct =
    readStringField(args, "p_stop_id") ??
    readStringField(args, "p_route_stop_id") ??
    readStringField(args, "p_parcel_id") ??
    readStringField(args, "p_trip_id") ??
    readStringField(args, "p_queue_id");
  if (direct !== null) return direct;

  const input = readObject(args.p_input);
  if (input === null) return "pending-write";
  return (
    readStringField(input, "route_stop_id") ??
    readStringField(input, "stop_id") ??
    readStringField(input, "task_id") ??
    readStringField(input, "route_run_id") ??
    "pending-write"
  );
}

function resolveOutboxKind(entry: MobileV2RawOutboxSyncEntry): MobileV2SyncQueueEntryKind {
  const rpc = entry.rpc.trim().toLowerCase();
  const args = entry.args;
  if (rpc === "sign_fieldops_cash_drop_v1") {
    return "cash.drop";
  }
  if (rpc === "submit_fieldops_proof_v1") {
    const outcome = typeof args?.p_outcome === "string" ? args.p_outcome.trim().toLowerCase() : "";
    const action = typeof args?.p_action === "string" ? args.p_action.trim().toLowerCase() : "";
    if (outcome === "failed" || action === "failure") return "stop.failed";
    return "pod.commit";
  }
  if (rpc.includes("communication") || rpc.includes("message") || rpc.includes("support")) {
    return "comm.send";
  }
  if (
    rpc.includes("route") ||
    rpc.includes("stop") ||
    rpc.includes("pickup") ||
    rpc.includes("reschedule") ||
    rpc.includes("reassign")
  ) {
    return "stop.update";
  }
  return "other";
}

function resolveOutboxSyncStatus(
  status: MobileV2RawOutboxSyncEntry["status"],
): MobileV2SyncQueueEntryStatus | null {
  if (status === "succeeded") return "sent";
  if (status === "queued") return "queued";
  if (status === "in_flight" || status === "failed") return "retrying";
  if (status === "dead") return "failed";
  return null;
}

export function projectMobileV2SyncQueueEntries(
  entries: ReadonlyArray<MobileV2RawOutboxSyncEntry>,
): ReadonlyArray<MobileV2SyncQueueDisplayEntry> {
  const out: MobileV2SyncQueueDisplayEntry[] = [];
  for (const entry of entries) {
    const status = resolveOutboxSyncStatus(entry.status);
    if (status === null) continue;
    const createdMs = Date.parse(entry.created_at);
    out.push(
      Object.freeze({
        id: entry.id,
        kind: resolveOutboxKind(entry),
        stopId: resolveOutboxStopLabel(entry.args, entry.rpc),
        atMs: Number.isFinite(createdMs) ? createdMs : Date.now(),
        status,
        retryCount:
          typeof entry.attempt_count === "number" && Number.isFinite(entry.attempt_count)
            ? Math.max(0, Math.floor(entry.attempt_count))
            : 0,
      }),
    );
  }
  return Object.freeze(out);
}
