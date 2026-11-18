// Mobile V2 RPC hooks — @tanstack/react-query bindings against the
// resolve_fieldops_*_v1 aggregator RPCs shipped in Phases 0–6.
//
// Per AGENTS.md Mobile Field Ops Policy Contract, every list surface
// reads through resolver functions; this module is the canonical FE
// entrypoint. Each hook returns the typed envelope expected by the V2
// screens (tasks / pickups / trips / sortation / lookup / today /
// returns / hub-pickup / hold / cash-drop / wallet / eor).
//
// Hooks accept a typed fixture `fallback`. The fallback is a legitimate
// showcase/offline sample and is returned ONLY in preview mode
// (`supabase === null`) or when the resolver RPC is genuinely absent
// (`isMissingRpcError`). Against a live resolver the hooks map the real
// envelope honestly — a resolver-NULL business field degrades to a
// neutral empty/zero/null value, never to fixture business data.

import * as React from "react";
import {
  useMutation,
  useQuery,
  useQueryClient,
  type QueryClient,
  type UseMutationOptions,
  type UseMutationResult,
  type UseQueryOptions,
  type UseQueryResult,
} from "@tanstack/react-query";
import type { SupabaseClient } from "@supabase/supabase-js";

import {
  emitMobileV2TraceEvent,
  newMobileV2TraceContext,
} from "./mobile-v2-trace-context";

import {
  type MobileV2Pickup,
} from "./mobile-v2-pickups-screen";
import {
  type MobileV2Trip,
} from "./mobile-v2-trips-screen";
import {
  type MobileV2LookupRecord,
  type MobileV2LookupRecent,
} from "./mobile-v2-lookup-screen";
import {
  type MobileV2SortationBay,
  type MobileV2SortationInduction,
} from "./mobile-v2-sortation-screen";
import {
  type MobileV2WalletBalance,
  type MobileV2WalletBreakdownRow,
  type MobileV2WalletWithdrawal,
  type MobileV2WalletWeekBar,
} from "./mobile-v2-wallet-screen";
import {
  type MobileV2ReturnsRtoStop,
  type MobileV2ReturnsStop,
} from "./mobile-v2-returns-screen";
import {
  type MobileV2HubPickupQueueItem,
} from "./mobile-v2-hub-pickup-screen";
import {
  type MobileV2HoldItem,
} from "./mobile-v2-hold-queue-screen";
import {
  type MobileV2CashDropLastDrop,
} from "./mobile-v2-cash-drop-screen";
import {
  type MobileV2SettlementLedgerEnvelope,
  type MobileV2SettlementLedgerReadback,
  type MobileV2SettlementLedgerRow,
  type MobileV2SettlementLedgerSummary,
} from "./mobile-v2-settlements-screen";
import {
  type MobileV2EorChecklistItem,
  type MobileV2EorSummary,
} from "./mobile-v2-eor-screen";
import {
  type MobileV2LoaderDriverQueueEntry,
  type MobileV2LoaderQuickAction,
} from "./mobile-v2-loader-today-screen";
import {
  type MobileV2RiderTicket,
} from "./mobile-v2-rider-today-screen";
import {
  type MobileV2SupervisorItem,
} from "./mobile-v2-supervisor-screen";
import {
  type MobileV2StopDetail,
  type MobileV2StopPaymentCollection,
} from "./mobile-v2-stop-screen";
import {
  type MobileV2RouteManifestSummary,
  type MobileV2RouteStop,
  type MobileV2RouteStopStatus,
} from "./mobile-v2-route-screen";
import {
  parseMobileV2NavigationPayload,
  type MobileV2NavigationSection,
} from "./mobile-v2-navigation";
import {
  parseMobileV2IncidentTypeList,
  type MobileV2IncidentType,
} from "./mobile-v2-incident-types";

export interface MobileV2CashDropEnvelope {
  readonly expectedSar: number;
  readonly safeLocation: string;
  readonly lastDrop?: MobileV2CashDropLastDrop | null;
}

/** End-of-day reconciliation inputs for submit_fieldops_eod_recon_v1. */
export interface MobileV2EorRecon {
  /** Parcels handled this shift (delivered + failed + returned). */
  readonly parcelsCount: number;
  /** Parcels that did not reconcile (mis-scan / missing). */
  readonly mismatchCount: number;
  /** COD cash the driver declares handing back. */
  readonly cashDeclared: number;
  /** COD cash the hub desk counted. */
  readonly cashCounted: number;
  /** Wallet posting status string for the recon row. */
  readonly walletStatus: string;
  /** Backend route run that supplied these inputs, when available. */
  readonly routeRunId?: string;
}

export interface MobileV2EorLastRecon {
  readonly decisionLogId: string;
  readonly state: string;
  readonly routeRunId?: string;
  readonly parcelsCount: number;
  readonly mismatchCount: number;
  readonly cashDeclared: number;
  readonly cashCounted: number;
  readonly cashVariance: number;
  readonly walletStatus: string;
  readonly submittedAt: string | null;
}

export interface MobileV2EorEnvelope {
  readonly summary: MobileV2EorSummary;
  readonly checklist: ReadonlyArray<MobileV2EorChecklistItem>;
  readonly performanceNote: string | null;
  /**
   * Route id label for the EOR app-bar subtitle. `resolve_fieldops_eor_v1`
   * does not surface a route label, so in the production native shell
   * this honestly degrades to "" (the app-bar then renders the live
   * summary alone). A non-empty value is the preview showcase sample.
   */
  readonly routeLabel: string;
  /** End-of-day reconciliation inputs for submit_fieldops_eod_recon_v1. */
  readonly recon: MobileV2EorRecon | null;
  /** Latest backend-confirmed EOD reconciliation submitted by this device/user. */
  readonly lastRecon: MobileV2EorLastRecon | null;
}

/** Loader-home aggregator envelope (resolve_fieldops_loader_today_v1). */
export interface MobileV2LoaderTodayEnvelope {
  /** Loader's display name for the "Hello, <name>" app-bar title. */
  readonly greetingName: string;
  readonly activeOpsSessionId: string;
  readonly waveLabel: string;
  /** Active bay id the loader is working — induction writes target this. */
  readonly bay: string;
  /** Active route label surfaced in the loader scan context chips. */
  readonly routeLabel: string;
  readonly cutOff: string;
  readonly coldChainCount: number;
  readonly liveRoutes: number;
  readonly totalParcels: number;
  readonly scannedParcels: number;
  readonly driversWaiting: number;
  readonly quickActions: ReadonlyArray<MobileV2LoaderQuickAction>;
  readonly drivers: ReadonlyArray<MobileV2LoaderDriverQueueEntry>;
}

/** Rider-home aggregator envelope (resolve_fieldops_rider_today_v1). */
export interface MobileV2RiderTodayEnvelope {
  readonly greetingName: string;
  readonly employeeId: string;
  readonly online: boolean;
  readonly earningsToday: number;
  readonly tripsCompleted: number;
  readonly rating: number;
  readonly shiftDuration: string;
  readonly currency: string;
  readonly active: MobileV2RiderTicket | null;
  readonly upcoming: ReadonlyArray<MobileV2RiderTicket>;
}

/** Supervisor-queue aggregator envelope (resolve_fieldops_supervisor_queue_v1). */
export interface MobileV2SupervisorQueueEnvelope {
  readonly supervisorName: string;
  readonly queue: ReadonlyArray<MobileV2SupervisorItem>;
  readonly activeId: string;
}

export interface MobileV2IncidentReadback {
  readonly incidentId: string;
  readonly decisionLogId: string;
  readonly typeId: string;
  readonly severity: string;
  readonly statement: string | null;
  readonly stopId: string | null;
  readonly photoPath: string | null;
  readonly submittedAt: string | null;
}

export interface MobileV2OnboardingDocReadback {
  readonly docId: string;
  readonly docKey: string;
  readonly status: string;
  readonly state: string;
  readonly decisionLogId: string;
  readonly storagePath: string | null;
  readonly correlationId: string | null;
  readonly submittedAt: string | null;
}

export interface MobileV2OnboardingVehicleReadback {
  readonly vehicleId: string;
  readonly plate: string;
  readonly vin: string;
  readonly year: string;
  readonly model: string;
  readonly status: string;
  readonly state: string;
  readonly decisionLogId: string;
  readonly istimaraPath: string | null;
  readonly correlationId: string | null;
  readonly submittedAt: string | null;
}

export interface MobileV2OnboardingVehiclePhotosReadback {
  readonly photoSetId: string;
  readonly anglePaths: Readonly<Record<string, string>>;
  readonly capturedAngleIds: ReadonlyArray<string>;
  readonly photoCount: number;
  readonly state: string;
  readonly decisionLogId: string;
  readonly correlationId: string | null;
  readonly submittedAt: string | null;
}

export interface MobileV2OnboardingCleaningReadback {
  readonly checkId: string;
  readonly checkedIds: ReadonlyArray<string>;
  readonly itemCount: number;
  readonly photoPath: string | null;
  readonly state: string;
  readonly decisionLogId: string;
  readonly correlationId: string | null;
  readonly submittedAt: string | null;
}

export interface MobileV2OnboardingPreShiftReadback {
  readonly passId: string;
  readonly shiftId: string;
  readonly healthOk: boolean;
  readonly state: string;
  readonly decisionLogId: string;
  readonly correlationId: string | null;
  readonly submittedAt: string | null;
}

export interface MobileV2OnboardingPolicy {
  readonly photoCadenceHours: number;
  readonly cleaningCadenceHours: number;
  readonly healthAttestation: boolean;
  readonly requiredDocuments: ReadonlyArray<string>;
  readonly vehiclePhotoAngles: ReadonlyArray<string>;
  readonly cleaningItems: ReadonlyArray<{
    readonly id: string;
    readonly label: string;
    readonly sub: string;
  }>;
}

export interface MobileV2OnboardingRequirements {
  readonly docsUploadedCount: number;
  readonly requiredDocumentsCount: number;
  readonly requiredDocumentsSatisfiedCount: number;
  readonly docsComplete: boolean;
  readonly vehicleSubmitted: boolean;
  readonly vehiclePhotosSubmitted: boolean;
  readonly requiredVehiclePhotoCount: number;
  readonly cleaningAttested: boolean;
  readonly preShiftCleared: boolean;
  readonly cleaningRequired: boolean;
}

export interface MobileV2OnboardingReadbackEnvelope {
  readonly activeRole: string;
  readonly organizationId: string | null;
  readonly userId: string | null;
  readonly shiftId: string | null;
  readonly documents: ReadonlyArray<MobileV2OnboardingDocReadback>;
  readonly latestDoc: MobileV2OnboardingDocReadback | null;
  readonly latestVehicle: MobileV2OnboardingVehicleReadback | null;
  readonly latestVehiclePhotos: MobileV2OnboardingVehiclePhotosReadback | null;
  readonly latestCleaning: MobileV2OnboardingCleaningReadback | null;
  readonly latestPreShift: MobileV2OnboardingPreShiftReadback | null;
  readonly policy: MobileV2OnboardingPolicy;
  readonly requirements: MobileV2OnboardingRequirements;
}

/**
 * Shell-chrome identity envelope (resolve_fieldops_profile_v1) — the
 * driver / loader / rider name + badge rendered in the drawer header and
 * More screen. Engineering re-audit E3: this replaced a hardcoded
 * `MOBILE_V2_PREVIEW_USER` fixture in the production native shell.
 */
export interface MobileV2ProfileEnvelope {
  readonly name: string;
  readonly badge: string;
  readonly currency?: string;
}
import {
  parseMobileV2TaskList,
  type MobileV2Task,
} from "./mobile-v2-tasks-types";

// ---------------------------------------------------------------------------
// Shared types
// ---------------------------------------------------------------------------

export type MobileV2Role = "driver" | "loader" | "rider" | "supervisor";

const MOBILE_V2_ROLE_KEYS: ReadonlySet<string> = new Set([
  "driver",
  "loader",
  "rider",
  "supervisor",
]);

export interface MobileV2ActiveRoleEnvelope {
  readonly activeRole: MobileV2Role;
  readonly assignedRoles: ReadonlyArray<MobileV2Role>;
  readonly organizationId?: string | null;
  readonly switchedAt?: string | null;
}

export function normalizeMobileV2Role(value: unknown): MobileV2Role | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  return MOBILE_V2_ROLE_KEYS.has(normalized) ? (normalized as MobileV2Role) : null;
}

function normalizeMobileV2RoleList(value: unknown): ReadonlyArray<MobileV2Role> {
  if (!Array.isArray(value)) return [];
  const seen = new Set<MobileV2Role>();
  for (const item of value) {
    const role = normalizeMobileV2Role(item);
    if (role !== null) seen.add(role);
  }
  return Object.freeze([...seen]);
}

export function parseMobileV2ActiveRoleEnvelope(
  raw: unknown,
  fallbackRole: MobileV2Role,
): MobileV2ActiveRoleEnvelope {
  const record = raw !== null && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const assignedRoles = normalizeMobileV2RoleList(record.assigned_roles);
  const activeRole =
    normalizeMobileV2Role(record.active_role) ??
    (assignedRoles.includes(fallbackRole) || assignedRoles.length === 0 ? fallbackRole : assignedRoles[0]);
  const roles = assignedRoles.length > 0 ? assignedRoles : Object.freeze([activeRole]);
  return Object.freeze({
    activeRole,
    assignedRoles: roles,
    organizationId:
      typeof record.organization_id === "string" && record.organization_id.trim() !== ""
        ? record.organization_id
        : null,
    switchedAt:
      typeof record.switched_at === "string" && record.switched_at.trim() !== ""
        ? record.switched_at
        : null,
  });
}

/**
 * Optional outbox handle injected via context. When provided, mutation
 * hooks call `enqueue(rpc, args)` after a retryable network failure so
 * the work survives connectivity loss. The mutation still throws so the
 * UI surfaces the failure; the outbox drains on a separate channel
 * (`useMobileV2OutboxDrainer`) when the network recovers.
 *
 * Audit fix (2026-05-13 engineering/security P0 #2): V2 mutation hooks
 * previously threw on RPC failure with no offline-outbox enqueue,
 * violating AGENTS.md "offline-first explicit" contract. Drivers
 * losing connectivity mid-flow (proof submit, hold decision, cash
 * drop, KYC upload, EOD recon, reschedule, reassign) lost their work.
 */
export interface MobileV2OutboxHandle {
  readonly enqueue: (
    input: { rpc: string; args: Record<string, unknown> },
  ) => Promise<unknown>;
}

export interface MobileV2RpcContext {
  /** Active supabase client (createMobileClient output). May be null while booting. */
  readonly supabase: SupabaseClient | null;
  /** Active role for role-aware aggregators. */
  readonly activeRole: MobileV2Role;
  /** Optional policy resolver context (passed verbatim to each RPC). */
  readonly policyContext?: Record<string, unknown>;
  /**
   * Optional offline outbox. When supplied, mutation hooks enqueue
   * retryable network failures so the work can be replayed by a
   * drainer worker after connectivity returns. Production native
   * shell wires this from `createSqliteOutboxStore` in `App.tsx`;
   * gallery preview omits it (preview mode short-circuits before
   * any RPC call anyway).
   */
  readonly outbox?: MobileV2OutboxHandle;
}

const MobileV2RpcContextValue = React.createContext<MobileV2RpcContext | null>(null);

export interface MobileV2RpcProviderProps {
  readonly value: MobileV2RpcContext;
  readonly children: React.ReactNode;
}

export function MobileV2RpcProvider(props: MobileV2RpcProviderProps): React.ReactElement {
  return React.createElement(
    MobileV2RpcContextValue.Provider,
    { value: props.value },
    props.children,
  );
}

export function useMobileV2Rpc(): MobileV2RpcContext {
  const ctx = React.useContext(MobileV2RpcContextValue);
  if (ctx === null) {
    throw new Error(
      "useMobileV2Rpc must be used inside <MobileV2RpcProvider value={{ supabase, activeRole, ... }}>",
    );
  }
  return ctx;
}

export function useFieldopsActiveRoleRpc(): UseQueryResult<MobileV2ActiveRoleEnvelope, Error> {
  const ctx = useMobileV2Rpc();
  const fallback = React.useMemo(
    () => parseMobileV2ActiveRoleEnvelope(null, ctx.activeRole),
    [ctx.activeRole],
  );
  const previewMode = isPreviewMode(ctx.supabase);
  return useQuery<MobileV2ActiveRoleEnvelope, Error>({
    queryKey: ["mobile-v2", "active-role", ctx.activeRole],
    queryFn: async () => {
      if (previewMode) return fallback;
      const client = getMobileV2SupabaseSchemaClient(ctx.supabase, "api");
      const { data, error } = await client.rpc("auth_get_active_role_v1", {});
      if (error !== null && error !== undefined) {
        throw new Error(`mobile_v2_rpc:auth_get_active_role_v1 failed - ${error.message ?? "unknown"}`);
      }
      return parseMobileV2ActiveRoleEnvelope(data, ctx.activeRole);
    },
    placeholderData: fallback,
    staleTime: previewMode ? Infinity : 0,
  });
}

export function useFieldopsSetActiveRoleMutation(
  options?: UseMutationOptions<MobileV2ActiveRoleEnvelope, Error, MobileV2Role>,
): UseMutationResult<MobileV2ActiveRoleEnvelope, Error, MobileV2Role> {
  const ctx = useMobileV2Rpc();
  return useMutation<MobileV2ActiveRoleEnvelope, Error, MobileV2Role>({
    ...(options ?? {}),
    mutationFn: async (role) => {
      if (isPreviewMode(ctx.supabase)) {
        return parseMobileV2ActiveRoleEnvelope(
          { active_role: role, assigned_roles: [role] },
          role,
        );
      }
      const client = getMobileV2SupabaseSchemaClient(ctx.supabase, "api");
      const { data, error } = await client.rpc("auth_set_active_role_v1", {
        p_role_key: role,
      });
      if (error !== null && error !== undefined) {
        throw new Error(`mobile_v2_rpc:auth_set_active_role_v1 failed - ${error.message ?? "unknown"}`);
      }
      return parseMobileV2ActiveRoleEnvelope(data, role);
    },
  });
}

// ---------------------------------------------------------------------------
// Internal: thin RPC caller
// ---------------------------------------------------------------------------

interface RpcCallInput<TParams extends Record<string, unknown>> {
  readonly supabase: SupabaseClient | null;
  readonly name: string;
  readonly params: TParams;
  readonly schema?: "public" | "api";
}

export type MobileV2SupabaseSchemaClient = Pick<
  SupabaseClient<any, any, any, any, any>,
  "rpc"
>;

export function getMobileV2SupabaseSchemaClient(
  supabase: SupabaseClient<any, any, any, any, any>,
  schema: "public" | "api",
): MobileV2SupabaseSchemaClient {
  if (schema === "public") return supabase;
  const schemaClientFactory = (supabase as unknown as {
    schema?: (s: "api") => MobileV2SupabaseSchemaClient;
  }).schema;
  if (typeof schemaClientFactory !== "function") {
    throw new Error("Mobile V2 API RPCs require a Supabase client with schema('api') support.");
  }
  return schemaClientFactory.call(supabase, schema);
}

async function callRpc<TParams extends Record<string, unknown>>(
  input: RpcCallInput<TParams>,
): Promise<unknown> {
  if (input.supabase === null) {
    throw new Error(`mobile_v2_rpc:${input.name} requires a connected supabase client`);
  }
  // Trace-context per call. supabase-js v2 has no per-rpc HTTP header hook,
  // so we publish via two channels:
  //   - mutation hooks pass p_idempotency_key in the body; the server side
  //     maps that to decision_log.correlation_id (see
  //     202605120300_fieldops_mobile_v2_write_rpcs_pack_v1.sql:245).
  //   - rpc.start / rpc.end events into the local log stream so external
  //     aggregators can group by traceId across surfaces.
  const trace = newMobileV2TraceContext();
  const startedAt = typeof performance !== "undefined" && typeof performance.now === "function"
    ? performance.now()
    : Date.now();
  emitMobileV2TraceEvent("rpc.start", {
    rpc: input.name,
    schema: input.schema ?? "public",
    correlationId: trace.correlationId,
    traceparent: trace.traceparent,
  });
  const schema = input.schema ?? "public";
  // supabase-js exposes the schema-scoped client via .schema(...) which
  // returns a typed builder; .rpc() is the universal entry point either way.
  const client = getMobileV2SupabaseSchemaClient(input.supabase, schema);
  const { data, error } = await client.rpc(input.name, input.params);
  const durationMs =
    (typeof performance !== "undefined" && typeof performance.now === "function"
      ? performance.now()
      : Date.now()) - startedAt;
  if (error !== null && error !== undefined) {
    emitMobileV2TraceEvent("rpc.error", {
      rpc: input.name,
      correlationId: trace.correlationId,
      durationMs: Math.round(durationMs),
      message: error.message ?? "unknown",
    });
    throw new Error(`mobile_v2_rpc:${input.name} failed — ${error.message ?? "unknown"}`);
  }
  emitMobileV2TraceEvent("rpc.end", {
    rpc: input.name,
    correlationId: trace.correlationId,
    durationMs: Math.round(durationMs),
    ok: true,
  });
  return data;
}

function withFallback<T>(value: T | null | undefined, fallback: T): T {
  if (value === null || value === undefined) return fallback;
  return value;
}

/**
 * True when an RPC error is a "function does not exist" failure — i.e.
 * the resolver has not been migrated onto the connected database yet.
 * PostgREST returns SQLSTATE `PGRST202` with a "Could not find the
 * function" / "schema cache" message for an unknown RPC, and Postgres
 * surfaces a true missing-function as `42883`.
 *
 * Engineering re-audit E1: the loader / rider / supervisor role-home
 * hooks called resolver RPCs that did not exist in any migration. In
 * production that threw → react-query `isError` → a permanent
 * "Couldn't reach the server" card. The role-home hooks now use this
 * classifier to degrade to the typed fixture fallback ONLY for a
 * genuinely-absent resolver (so a not-yet-migrated DB still renders an
 * honest screen), while every other failure — RLS denial, network
 * fault, shape drift — still surfaces as an error. It is never used to
 * mask a live RLS / connectivity problem behind fixture-as-live data.
 */
export function isMissingRpcError(error: unknown): boolean {
  if (!error) return false;
  const message =
    error instanceof Error
      ? error.message
      : typeof error === "string"
        ? error
        : "";
  const lc = message.toLowerCase();
  return (
    lc.includes("pgrst202") ||
    lc.includes("42883") ||
    lc.includes("could not find the function") ||
    (lc.includes("function") && lc.includes("does not exist")) ||
    // PostgREST schema-cache miss phrasing for an unknown RPC.
    (lc.includes("schema cache") && lc.includes("function"))
  );
}

/**
 * Classify whether an RPC error is retryable. Retryable failures are
 * network/transport faults — connectivity loss, timeouts, transient
 * gateway errors — that may succeed if replayed later. Non-retryable
 * failures are deterministic — RLS denials (42501), validation errors
 * (22xxx), authorization failures, schema drift, business-rule
 * rejections — that will recur on every replay and must surface to
 * the user instead of being silently queued.
 *
 * The classifier is heuristic by necessity: Supabase wraps Postgres
 * errors as Error instances with the SQLSTATE embedded in the message
 * (e.g. "...failed — 42501: row level security..."), and network
 * failures appear as generic `TypeError: Network request failed` or
 * `AbortError`. We err on the side of "retryable" for ambiguous cases
 * because the cost of an extra outbox replay is small (idempotency
 * keys dedupe at the DB), while the cost of dropping a driver's work
 * on a transient hiccup is high.
 */
export function isRetryableRpcError(error: unknown): boolean {
  if (!error) return false;
  const message =
    error instanceof Error
      ? error.message
      : typeof error === "string"
        ? error
        : "";
  const lc = message.toLowerCase();
  // Network / transport faults — retry.
  if (
    lc.includes("network request failed") ||
    lc.includes("failed to fetch") ||
    lc.includes("aborterror") ||
    lc.includes("timeout") ||
    lc.includes("timed out") ||
    lc.includes("etimedout") ||
    lc.includes("econnreset") ||
    lc.includes("econnrefused") ||
    lc.includes("enetunreach") ||
    lc.includes("ehostunreach") ||
    lc.includes("offline")
  ) {
    return true;
  }
  // Deterministic business-rule failures. These are usually raised by
  // workflow/RPC guards without a SQLSTATE in the client-facing message.
  if (
    lc.includes("mobile v2 api rpcs require a supabase client with schema('api') support") ||
    lc.includes("terminal state") ||
    lc.includes("already terminal") ||
    lc.includes("already completed") ||
    lc.includes("already done") ||
    lc.includes("route_stop_execute task required")
  ) {
    return false;
  }
  // Deterministic Postgres errors (SQLSTATE 42xxx authorization, 22xxx
  // data exception, 23xxx integrity, 28xxx invalid auth, P0xxx
  // PL/pgSQL raise) — do NOT retry. The driver will see the failure
  // and must adjust input or escalate.
  // The class-22 (data exception) subclasses include both numeric codes
  // (22001, 22023) and `P`-suffixed ones — notably 22P02
  // (invalid_text_representation, the bad-UUID/enum error). All are
  // deterministic, so match `22(\d{3}|P\d{2})`, not just `22\d{3}`.
  if (/\b(42\d{3}|22(?:\d{3}|P\d{2})|23\d{3}|28\d{3}|P0\d{3})\b/.test(message)) {
    return false;
  }
  // Bare HTTP 5xx — treat as retryable; HTTP 4xx — do not retry.
  if (/\b5\d{2}\b/.test(message) && !/\b4\d{2}\b/.test(message)) return true;
  if (/\b4\d{2}\b/.test(message)) return false;
  // Default: retry. The DB-side idempotency key dedupes any duplicate
  // success path; the worst case is one extra no-op RPC.
  return true;
}

/**
 * Wraps `callRpc` with offline-outbox semantics. On retryable network
 * failure, enqueues `{ rpc, args }` to the injected outbox (if any)
 * before re-throwing so the mutation surface still surfaces the
 * failure. Non-retryable failures (RLS denial, validation, etc.)
 * skip the enqueue — they would never succeed on replay.
 *
 * The enqueue is awaited before the failure is re-thrown so the work
 * is durably queued even if the JS context is torn down immediately
 * after. Idempotency keys in `args.p_idempotency_key` make replay safe.
 *
 * Exported for integration testing — `mobile-v2-rpc-outbox-chain.test.ts`
 * drives the offline-enqueue / deterministic-no-enqueue / drain-replay
 * chain directly through this wrapper (rendering the RN hooks in root
 * Jest is not possible: the Expo app pins React 19 while the root test
 * env runs React 18).
 */
export async function callRpcOrEnqueue(
  ctx: MobileV2RpcContext,
  rpcName: string,
  params: Record<string, unknown>,
): Promise<unknown> {
  try {
    return await callRpc({
      supabase: ctx.supabase,
      schema: "api",
      name: rpcName,
      params,
    });
  } catch (error) {
    const outbox = ctx.outbox;
    if (outbox !== undefined && isRetryableRpcError(error)) {
      // Await the enqueue so the work is durably queued BEFORE the
      // failure surfaces to the caller. A crash / RN context teardown
      // in the window between RPC failure and enqueue must never lose
      // a driver's write (AGENTS.md offline-first contract). The outbox
      // write is a cheap local KV/SQLite insert; an outbox failure is
      // logged but never masks the original RPC error.
      try {
        await outbox.enqueue({ rpc: rpcName, args: params });
        emitMobileV2TraceEvent("rpc.outbox.enqueued", { rpc: rpcName });
      } catch (enqueueError) {
        emitMobileV2TraceEvent("rpc.outbox.enqueue_failed", {
          rpc: rpcName,
          message:
            enqueueError instanceof Error
              ? enqueueError.message
              : String(enqueueError),
        });
      }
    }
    throw error;
  }
}

/**
 * Drain the outbox by replaying queued RPCs through the active
 * supabase client. Called by `useMobileV2OutboxDrainer` on
 * connectivity restore and on a low-frequency tick. The drainer
 * relies on the outbox's own backoff + idempotency-key semantics
 * (see `packages/mobile-core/src/outbox.ts`) so duplicates are
 * server-side no-ops.
 *
 * The caller is expected to supply the full outbox bundle (not just
 * `enqueue`) when they want drain functionality. `MobileV2OutboxHandle`
 * deliberately exposes only `enqueue` because most mutation surfaces
 * never need to read or replay — they only ever enqueue.
 */
/**
 * A single outbox entry as exposed for observability surfaces (the
 * Mobile V2 More screen's outbox panel). A structural subset of
 * `packages/mobile-core` `OutboxEntry` — kept minimal so this module
 * does not depend on the mobile-core package types.
 */
export interface MobileV2OutboxEntryView {
  readonly id: string;
  readonly rpc: string;
  readonly args?: Record<string, unknown>;
  readonly status: "queued" | "in_flight" | "succeeded" | "failed" | "dead";
  readonly created_at: string;
  readonly attempt_count?: number;
  readonly last_error?: string | null;
}

export interface MobileV2OutboxDrainBundle extends MobileV2OutboxHandle {
  readonly sync: (
    executor: (
      rpc: string,
      args: Record<string, unknown>,
    ) => Promise<unknown>,
    options?: { limit?: number; force?: boolean; shouldRetry?: (error: unknown) => boolean },
  ) => Promise<MobileV2OutboxDrainResult>;
  readonly countPending: () => Promise<number>;
  /**
   * Optional entry listing for observability UIs. The production native
   * outbox (`packages/mobile-core` `createOutbox`) supplies it; callers
   * that omit it (gallery preview) simply get no live entry list.
   */
  readonly list?: (params?: {
    status?: ReadonlyArray<MobileV2OutboxEntryView["status"]>;
    limit?: number;
  }) => Promise<ReadonlyArray<MobileV2OutboxEntryView>>;
}

export interface MobileV2OutboxDrainResult {
  readonly attempted: number;
  readonly succeeded: number;
  readonly failed: number;
  readonly dead: number;
}

export async function drainMobileV2Outbox(params: {
  readonly supabase: SupabaseClient | null;
  readonly outbox: MobileV2OutboxDrainBundle;
  readonly limit?: number;
  readonly force?: boolean;
}): Promise<MobileV2OutboxDrainResult> {
  const { supabase, outbox, limit, force } = params;
  if (supabase === null) {
    // No client — drain is impossible. Caller should re-invoke once
    // the client is connected.
    return { attempted: 0, succeeded: 0, failed: 0, dead: 0 };
  }
  emitMobileV2TraceEvent("rpc.outbox.drain.start", { limit: limit ?? null, force: force === true });
  try {
    const result = await outbox.sync(
      async (rpc, args) => {
        return await callRpc({ supabase, schema: "api", name: rpc, params: args });
      },
      { limit: limit ?? 25, force: force === true, shouldRetry: isRetryableRpcError },
    );
    emitMobileV2TraceEvent("rpc.outbox.drain.end", {
      attempted: result.attempted,
      succeeded: result.succeeded,
      failed: result.failed,
      dead: result.dead,
    });
    return result;
  } catch (error) {
    emitMobileV2TraceEvent("rpc.outbox.drain.error", {
      message: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}

export async function refreshMobileV2QueriesAfterOutboxDrain(params: {
  readonly queryClient: QueryClient;
  readonly result: MobileV2OutboxDrainResult;
  readonly force?: boolean;
}): Promise<void> {
  if (params.force !== true && params.result.succeeded <= 0) return;
  await params.queryClient.invalidateQueries({
    queryKey: ["mobile-v2"],
    refetchType: "active",
  });
}

/**
 * React hook that drains the outbox on a low-frequency tick plus
 * whenever the device transitions to online. Mount once at the V2
 * shell root so it survives screen changes. No-op when `outbox` is
 * absent (preview mode) or `supabase` is null (boot phase).
 */
export function useMobileV2OutboxDrainer(params: {
  readonly outbox?: MobileV2OutboxDrainBundle;
  readonly tickMs?: number;
}): void {
  const ctx = useMobileV2Rpc();
  const queryClient = useQueryClient();
  const outbox = params.outbox;
  const tickMs = params.tickMs ?? 30_000;
  React.useEffect(() => {
    if (outbox === undefined || ctx.supabase === null) return undefined;
    let cancelled = false;
    const run = async () => {
      if (cancelled) return;
      try {
        const result = await drainMobileV2Outbox({ supabase: ctx.supabase, outbox });
        await refreshMobileV2QueriesAfterOutboxDrain({ queryClient, result });
      } catch {
        /* drain errors are emitted via trace; no re-throw */
      }
    };
    // Initial drain on mount (when there's already a connected client
    // we may have queued entries from a previous offline run).
    void run();
    const interval = setInterval(() => {
      void run();
    }, Math.max(5_000, tickMs));
    // Online event triggers an immediate drain — most browsers/native
    // emit the event before reconnect-dependent React-query refetches.
    const onlineHandler = () => void run();
    if (typeof globalThis !== "undefined" && typeof (globalThis as { addEventListener?: unknown }).addEventListener === "function") {
      (globalThis as unknown as {
        addEventListener: (e: string, h: () => void) => void;
      }).addEventListener("online", onlineHandler);
    }
    return () => {
      cancelled = true;
      clearInterval(interval);
      if (typeof globalThis !== "undefined" && typeof (globalThis as { removeEventListener?: unknown }).removeEventListener === "function") {
        (globalThis as unknown as {
          removeEventListener: (e: string, h: () => void) => void;
        }).removeEventListener("online", onlineHandler);
      }
    };
  }, [outbox, ctx.supabase, queryClient, tickMs]);
}

/**
 * P1 audit fix: distinguish "preview mode (no supabase client)" from
 * "RPC failed (RLS denial / network error / shape drift)". Previously
 * every hook silently swallowed every error and returned its sample
 * fallback, which hid 42501 RLS denials behind seemingly-fresh data.
 *
 * Pattern:
 *   - supabase === null  → fallback (preview, never an error)
 *   - supabase connected → let the queryFn throw, react-query surfaces
 *     isError to the caller; callers can render a retry chip and the
 *     RPC layer keeps its strict error semantics.
 */
function isPreviewMode(supabase: SupabaseClient | null): supabase is null {
  return supabase === null;
}

/**
 * Re-audit E10: a list/detail surface must show its loading skeleton
 * while its resolver query has not yet produced ANY envelope. The gate
 * keys off the query result itself (`data === undefined`) — NEVER a
 * screen-level `liveXxx = rpc.data ?? FIXTURE` value, because that value
 * is the non-empty preview fixture during the entire initial production
 * fetch window. A gate that inspected `liveXxx.<field>.length` would
 * therefore evaluate false, suppress the skeleton, and render the fixture
 * as live data. Once a real envelope (or, in preview mode, the
 * fixture-as-data) has settled, the surface renders it; a background
 * refetch keeps the settled data visible with no skeleton flash because
 * `data` is then defined.
 */
export function isMobileV2ListLoading(
  rpc: { readonly isLoading: boolean; readonly data: unknown },
): boolean {
  return rpc.isLoading && rpc.data === undefined;
}

/**
 * Re-audit E11: the loader induction bay must be sourced ONLY from a
 * settled `resolve_fieldops_loader_today_v1` envelope — never the
 * screen-level `liveLoaderToday = loaderTodayRpc.data ?? FIXTURE`
 * fallback. An in-flight or errored loader-today query (`data ===
 * undefined`) yields "" so the caller's empty-bay guard blocks the
 * `induct_fieldops_parcel_v1` write, instead of persisting the preview
 * fixture's demo bay ("B-04") into the real induction + decision_log.
 * A settled envelope's `bay` is already honest (mapFieldopsLoaderToday-
 * Envelope degrades a resolver-NULL bay to "").
 */
export function resolveFieldopsInductionBay(
  rpc: { readonly data: MobileV2LoaderTodayEnvelope | undefined },
): string {
  return rpc.data?.bay ?? "";
}

// ---------------------------------------------------------------------------
// Tasks — resolve_fieldops_tasks_v1
// ---------------------------------------------------------------------------

export interface UseFieldopsTasksOptions {
  /**
   * Preview/offline showcase sample. Returned ONLY in preview mode
   * (`supabase === null`). Against a live resolver an empty task list is
   * an honest empty task day and passes through as `[]` — the fixture is
   * never substituted for a real driver's empty day (re-audit E8).
   */
  readonly fallback?: ReadonlyArray<MobileV2Task>;
  /** Pass-through useQuery overrides. */
  readonly query?: Omit<UseQueryOptions<ReadonlyArray<MobileV2Task>, Error>, "queryKey" | "queryFn">;
}

export function useFieldopsTasksRpc(
  options: UseFieldopsTasksOptions = {},
): UseQueryResult<ReadonlyArray<MobileV2Task>, Error> {
  const ctx = useMobileV2Rpc();
  const fallback = options.fallback ?? [];
  return useQuery<ReadonlyArray<MobileV2Task>, Error>({
    queryKey: ["mobile-v2", "tasks", ctx.activeRole, ctx.policyContext ?? null],
    queryFn: async () => {
      // Preview/showcase mode: the fixture is a legitimate sample.
      if (isPreviewMode(ctx.supabase)) return fallback;
      const raw = await callRpc({
        supabase: ctx.supabase,
        name: "resolve_fieldops_tasks_v1",
        params: {
          p_active_role: ctx.activeRole,
          p_context: ctx.policyContext ?? {},
        },
      });
      // E8 (hidden mock): a live resolver returning an empty list is an
      // honest empty task day — pass it through as []. The fixture is
      // NEVER substituted here, so the Tasks screen renders its real
      // "All clear" empty state instead of fabricated jobs. (Genuine RPC
      // errors still throw → react-query isError surfaces the retry card.)
      return parseMobileV2TaskList(raw);
    },
    ...options.query,
  });
}

// ---------------------------------------------------------------------------
// Route — derived from resolve_fieldops_tasks_v1 (driver role)
//
// The Route screen renders the driver's stop list. There is no dedicated
// route resolver: `resolve_fieldops_tasks_v1` already returns the driver's
// `route_stops` (joined to shipments) as its driver-role task envelope —
// the same canonical source the Tasks screen consumes. This hook calls
// that RPC and projects each `stop:` task into the `MobileV2RouteStop`
// shape the screen expects, so route data stays resolver-driven (no
// hardcoded route list, no parallel migration).
// ---------------------------------------------------------------------------

/** HH:MM extraction from an ISO timestamp; "—" when absent / unparseable. */
function isoToHhMm(iso: string | null): string {
  if (iso === null) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/**
 * Map one driver task (a `stop:<route_stops UUID>` row from
 * `resolve_fieldops_tasks_v1`) to a `MobileV2RouteStop`. Status is
 * derived from canonical route-stop status first, then shipment status,
 * then task urgency/tone signals; `cod` reads `meta.cod_amount`.
 */
export function mapMobileV2TaskToRouteStop(
  task: MobileV2Task,
  index: number,
): MobileV2RouteStop {
  const meta = task.meta;
  const seqRaw = meta.sequence_order;
  const seq =
    typeof seqRaw === "number" && Number.isFinite(seqRaw)
      ? Math.max(0, Math.round(seqRaw))
      : index + 1;
  const codRaw = meta.cod_amount;
  const cod =
    typeof codRaw === "number" && Number.isFinite(codRaw) && codRaw > 0
      ? codRaw
      : 0;
  const routeStopStatus =
    typeof meta.route_stop_status === "string" ? meta.route_stop_status.toLowerCase() : "";
  const shipmentStatus =
    typeof meta.shipment_status === "string" ? meta.shipment_status.toLowerCase() : "";
  let status: MobileV2RouteStopStatus;
  if (
    routeStopStatus === "done"
    || routeStopStatus === "delivered"
    || shipmentStatus === "delivered"
    || shipmentStatus === "completed"
  ) {
    status = "done";
  } else if (routeStopStatus === "partial") {
    status = "partial";
  } else if (
    routeStopStatus === "failed"
    || shipmentStatus === "failed"
    || shipmentStatus === "returned"
    || shipmentStatus === "cancelled"
  ) {
    status = "failed";
  } else if (task.tone === "danger" || task.tone === "warning") {
    status = "sla";
  } else if (task.urgency === "now") {
    status = "current";
  } else {
    status = "pending";
  }
  return Object.freeze({
    id: task.task_id,
    seq,
    customer: task.title,
    address: task.sub ?? task.area ?? "",
    sla: isoToHhMm(task.eta_iso),
    status,
    cod,
    fragile: false,
    attempts: 1,
    latitude: readRouteStopMetaNumber(meta, [
      "latitude",
      "lat",
      "destination_latitude",
      "dest_latitude",
      "stop_latitude",
    ]),
    longitude: readRouteStopMetaNumber(meta, [
      "longitude",
      "lng",
      "lon",
      "destination_longitude",
      "dest_longitude",
      "stop_longitude",
    ]),
    accuracyM: readRouteStopMetaNumber(meta, [
      "accuracy_m",
      "accuracyM",
      "location_accuracy_m",
      "geocoding_accuracy_m",
    ]),
    shortAddress: readRouteStopMetaString(meta, [
      "short_address",
      "shortAddress",
      "short_national_address",
      "national_short_address",
      "national_address",
      "short_code",
    ]),
    geocodingStatus: readRouteStopMetaString(meta, [
      "geocoding_status",
      "geocode_status",
      "address_validation_status",
      "review_status",
    ]),
    geocodingAccuracy: readRouteStopMetaString(meta, [
      "geocoding_accuracy",
      "geocode_accuracy",
      "match_accuracy",
      "address_accuracy",
    ]),
    geocodingProvider: readRouteStopMetaString(meta, [
      "geocoding_provider",
      "geocode_provider",
      "provider",
      "provider_name",
    ]),
    geocodingMatch: readRouteStopMetaString(meta, [
      "geocoding_match_strategy",
      "match_strategy",
      "match_type",
      "match_source",
    ]),
  });
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function asNonEmpty(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function asFiniteNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function asJsonNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function routeStopGeoRecords(meta: Readonly<Record<string, unknown>>): Record<string, unknown>[] {
  const records: Record<string, unknown>[] = [meta as Record<string, unknown>];
  for (const key of [
    "address",
    "delivery_address",
    "recipient_address",
    "location",
    "coordinates",
    "coordinate",
    "geo",
    "geocode",
    "geocoding",
    "destination",
    "stop_location",
  ]) {
    const nested = asRecord(meta[key]);
    if (nested !== null) records.push(nested);
  }
  return records;
}

function readRouteStopMetaString(
  meta: Readonly<Record<string, unknown>>,
  keys: ReadonlyArray<string>,
): string | null {
  for (const record of routeStopGeoRecords(meta)) {
    for (const key of keys) {
      const value = asNonEmpty(record[key]);
      if (value !== null) return value;
    }
  }
  return null;
}

function readRouteStopMetaNumber(
  meta: Readonly<Record<string, unknown>>,
  keys: ReadonlyArray<string>,
): number | null {
  for (const record of routeStopGeoRecords(meta)) {
    for (const key of keys) {
      const value = asFiniteNumber(record[key]);
      if (value !== null) return value;
    }
  }
  return null;
}

function humanizeMobileV2Token(value: string | null): string | null {
  if (value === null) return null;
  return value
    .replace(/[_-]+/g, " ")
    .trim()
    .replace(/\s+/g, " ")
    .replace(/^./, (first) => first.toUpperCase());
}

export function parseMobileV2RouteManifestSummary(
  raw: unknown,
  routeLabelFallback: string | null,
): MobileV2RouteManifestSummary | null {
  const manifest = asRecord(raw);
  if (manifest === null) return null;
  const routeRunId = asNonEmpty(manifest.route_run_id);
  const routeLabel = asNonEmpty(routeLabelFallback) ?? (routeRunId ? `RT-${routeRunId.slice(0, 8)}` : null);
  if (routeLabel === null) return null;

  const assignment = asRecord(manifest.route_assignment) ?? {};
  const assignmentStatus = humanizeMobileV2Token(asNonEmpty(assignment.assignment_status));
  const assignmentMode = humanizeMobileV2Token(asNonEmpty(assignment.assignment_mode));
  const assignmentLabel = assignmentStatus
    ? `Assignment ${assignmentStatus}`
    : assignmentMode
      ? `Assignment ${assignmentMode}`
      : "Assignment pending";

  const scanOut = asRecord(manifest.scan_out) ?? {};
  const expectedStops = Math.max(0, Math.round(asFiniteNumber(scanOut.expected_stop_count) ?? 0));
  const scannedStops = Math.max(0, Math.round(asFiniteNumber(scanOut.scanned_stop_count) ?? 0));
  const missingStops = Math.max(0, Math.round(asFiniteNumber(scanOut.missing_stop_count) ?? 0));
  const unexpectedScans = Math.max(0, Math.round(asFiniteNumber(scanOut.unexpected_scan_count) ?? 0));
  const readyForDeparture = scanOut.ready_for_departure === true;
  const scanOutLabel = readyForDeparture
    ? `Scan-out ready ${scannedStops}/${expectedStops}`
    : unexpectedScans > 0
      ? `Scan-out exception ${unexpectedScans}`
      : `Scan-out missing ${missingStops}/${expectedStops}`;

  const routeDeparture = asRecord(manifest.route_departure);
  const departed = routeDeparture !== null && asNonEmpty(routeDeparture.confirmed_at) !== null;
  const departureLabel = departed
    ? "Departed"
    : readyForDeparture
      ? "Ready to depart"
      : "Departure gated";

  return Object.freeze({
    routeLabel,
    assignmentLabel,
    scanOutLabel,
    departureLabel,
    readyForDeparture,
    departed,
  });
}

async function fetchMobileV2RouteManifestSummary(
  supabase: SupabaseClient,
  routeRunId: string,
  routeLabel: string | null,
): Promise<MobileV2RouteManifestSummary | null> {
  try {
    const raw = await callRpc({
      supabase,
      schema: "api",
      name: "ui_route_run_execution_manifest_v1",
      params: { p_route_run_id: routeRunId },
    });
    return parseMobileV2RouteManifestSummary(raw, routeLabel);
  } catch (error) {
    if (isMissingRpcError(error)) return null;
    throw error;
  }
}

export interface MobileV2RouteTaskSelection {
  readonly stopTasks: ReadonlyArray<MobileV2Task>;
  readonly routeRunId: string | null;
  readonly routeId: string | null;
}

function isMobileV2RouteTaskActionable(task: MobileV2Task): boolean {
  const routeStopStatus = asNonEmpty(task.meta.route_stop_status)?.toLowerCase() ?? null;
  if (
    routeStopStatus !== null
    && ["done", "failed", "partial", "completed", "cancelled", "canceled"].includes(routeStopStatus)
  ) {
    return false;
  }
  const cta = asNonEmpty(task.cta)?.toLowerCase() ?? null;
  return cta === null || !["done", "failed", "partial"].includes(cta);
}

export function selectMobileV2RouteTasks(
  tasks: ReadonlyArray<MobileV2Task>,
  preferredTaskId: string | null = null,
  preferredRouteRunId: string | null = null,
): MobileV2RouteTaskSelection {
  const byRouteRun = new Map<string, MobileV2Task[]>();
  let preferredTaskRouteRunId: string | null = null;
  for (const task of tasks) {
    if (!task.task_id.startsWith("stop:")) continue;
    const routeRunId = asNonEmpty(task.meta.route_run_id);
    if (routeRunId === null) continue;
    if (preferredTaskId !== null && task.task_id === preferredTaskId) {
      preferredTaskRouteRunId = routeRunId;
    }
    const existing = byRouteRun.get(routeRunId);
    if (existing) {
      existing.push(task);
    } else {
      byRouteRun.set(routeRunId, [task]);
    }
  }

  let routeRunId: string | undefined;
  if (preferredRouteRunId !== null && byRouteRun.has(preferredRouteRunId)) {
    routeRunId = preferredRouteRunId;
  }
  if (routeRunId === undefined && preferredTaskRouteRunId !== null && byRouteRun.has(preferredTaskRouteRunId)) {
    routeRunId = preferredTaskRouteRunId;
  }
  for (const [candidateRouteRunId, routeTasks] of byRouteRun.entries()) {
    if (routeRunId !== undefined) break;
    if (routeTasks.some(isMobileV2RouteTaskActionable)) {
      routeRunId = candidateRouteRunId;
      break;
    }
  }
  routeRunId ??= byRouteRun.keys().next().value as string | undefined;
  if (!routeRunId) {
    return Object.freeze({
      stopTasks: Object.freeze([]),
      routeRunId: null,
      routeId: null,
    });
  }

  return Object.freeze({
    stopTasks: Object.freeze([...(byRouteRun.get(routeRunId) ?? [])]),
    routeRunId,
    routeId: `RT-${routeRunId.slice(0, 8)}`,
  });
}

export interface MobileV2RouteEnvelope {
  readonly rows: ReadonlyArray<MobileV2RouteStop>;
  readonly totalStops: number;
  /**
   * Route-run id label for the Live-route map header. Resolved from the
   * first stop task's `meta.route_run_id` (resolve_fieldops_tasks_v1) so
   * the map screen renders a real run id, not a fixture constant. `null`
   * when the resolver returned no stops (no active route).
   */
  readonly routeId: string | null;
  readonly routeRunId: string | null;
  readonly manifestSummary: MobileV2RouteManifestSummary | null;
}

export interface MobileV2RouteDepartureConfirmation {
  readonly routeRunId: string;
  readonly status: string | null;
  readonly startedAt: string | null;
  readonly scanOut: Record<string, unknown>;
  readonly routeDeparture: Record<string, unknown>;
}

export function parseMobileV2RouteDepartureConfirmation(
  raw: unknown,
): MobileV2RouteDepartureConfirmation {
  const record = asRecord(raw);
  const routeRunId = asNonEmpty(record?.route_run_id);
  if (routeRunId === null) {
    throw new Error(`mobile_v2_rpc: unexpected route departure response ${JSON.stringify(raw)}`);
  }
  return Object.freeze({
    routeRunId,
    status: asNonEmpty(record?.status),
    startedAt: asNonEmpty(record?.started_at),
    scanOut: Object.freeze(asRecord(record?.scan_out) ?? {}),
    routeDeparture: Object.freeze(asRecord(record?.route_departure) ?? {}),
  });
}

export interface ConfirmFieldopsRouteDepartureInput {
  readonly p_route_run_id: string;
  readonly p_route_stop_id?: string | null;
  readonly p_task_id?: string | null;
  readonly p_ops_session_id?: string | null;
}

export function buildConfirmFieldopsRouteDepartureRpcInput(
  input: ConfirmFieldopsRouteDepartureInput,
): {
  readonly route_run_id: string;
  readonly route_stop_id: string | null;
  readonly task_id: string | null;
  readonly ops_session_id: string | null;
} {
  const routeRunId = input.p_route_run_id.trim();
  if (!isMobileV2PersistedUuid(routeRunId)) {
    throw new Error("mobile_v2_rpc: route departure requires a persisted route_run_id");
  }
  return Object.freeze({
    route_run_id: routeRunId,
    route_stop_id: asNonEmpty(input.p_route_stop_id) ?? null,
    task_id: asNonEmpty(input.p_task_id) ?? null,
    ops_session_id: asNonEmpty(input.p_ops_session_id) ?? null,
  });
}

export function useFieldopsConfirmRouteDepartureMutation(
  options?: Omit<
    UseMutationOptions<
      MobileV2RouteDepartureConfirmation,
      Error,
      ConfirmFieldopsRouteDepartureInput
    >,
    "mutationFn"
  >,
): UseMutationResult<
  MobileV2RouteDepartureConfirmation,
  Error,
  ConfirmFieldopsRouteDepartureInput
> {
  const ctx = useMobileV2Rpc();
  return useMutation<
    MobileV2RouteDepartureConfirmation,
    Error,
    ConfirmFieldopsRouteDepartureInput
  >({
    ...(options ?? {}),
    mutationFn: async (input) => {
      const pInput = buildConfirmFieldopsRouteDepartureRpcInput(input);
      if (isPreviewMode(ctx.supabase)) {
        return parseMobileV2RouteDepartureConfirmation({
          route_run_id: pInput.route_run_id,
          status: "in_progress",
          started_at: new Date().toISOString(),
          scan_out: { ready_for_departure: true },
          route_departure: { confirmed_at: new Date().toISOString() },
        });
      }
      const raw = await callRpcOrEnqueue(ctx, "ui_confirm_route_run_departure_v1", {
        p_input: pInput,
      });
      return parseMobileV2RouteDepartureConfirmation(raw);
    },
  });
}

export interface RecordFieldopsRouteLoadScanInput {
  readonly p_scan: {
    readonly route_run_id: string;
    readonly route_stop_id: string;
    readonly shipment_id: string;
    readonly client_id: string;
    readonly branch_id?: string | null;
    readonly barcode: string;
    readonly scan_type: "load";
    readonly device_id?: string | null;
    readonly ops_session_id?: string | null;
    readonly captured_at: string;
    readonly metadata?: Record<string, unknown>;
  };
}

export interface MobileV2RouteLoadScanReadback {
  readonly scanEventId: string;
  readonly created: boolean;
  readonly idempotencyKey: string;
  readonly routeRunId: string;
  readonly routeStopId: string;
  readonly barcode: string;
}

function readRouteLoadScanRow(raw: unknown): Record<string, unknown> | null {
  if (Array.isArray(raw)) {
    const first = raw[0];
    return first !== null && typeof first === "object" && !Array.isArray(first)
      ? (first as Record<string, unknown>)
      : null;
  }
  return raw !== null && typeof raw === "object" && !Array.isArray(raw)
    ? (raw as Record<string, unknown>)
    : null;
}

export function parseMobileV2RouteLoadScanReadback(
  raw: unknown,
  input: RecordFieldopsRouteLoadScanInput["p_scan"],
  idempotencyKey: string,
): MobileV2RouteLoadScanReadback {
  const row = readRouteLoadScanRow(raw);
  const scanEventId = asNonEmpty(row?.scan_event_id);
  if (scanEventId === null) {
    throw new Error(`mobile_v2_rpc: unexpected route load scan readback ${JSON.stringify(raw)}`);
  }
  return Object.freeze({
    scanEventId,
    created: row?.created === true,
    idempotencyKey,
    routeRunId: input.route_run_id,
    routeStopId: input.route_stop_id,
    barcode: input.barcode,
  });
}

export function useFieldopsRecordRouteLoadScanMutation(
  options?: Omit<
    UseMutationOptions<
      MobileV2RouteLoadScanReadback,
      Error,
      RecordFieldopsRouteLoadScanInput
    >,
    "mutationFn"
  >,
): UseMutationResult<
  MobileV2RouteLoadScanReadback,
  Error,
  RecordFieldopsRouteLoadScanInput
> {
  const ctx = useMobileV2Rpc();
  return useMutation<
    MobileV2RouteLoadScanReadback,
    Error,
    RecordFieldopsRouteLoadScanInput
  >({
    ...(options ?? {}),
    mutationFn: async (input) => {
      const key = newIdempotencyKey();
      const scan = {
        ...input.p_scan,
        idempotency_key: `mobile-v2-route-load-${input.p_scan.route_run_id}-${input.p_scan.route_stop_id}-${key}`,
        metadata: {
          ...(input.p_scan.metadata ?? {}),
          source: "fieldops_mobile_v2_route_scan_out",
          mobile_v2_only: true,
        },
      };
      if (isPreviewMode(ctx.supabase)) {
        return parseMobileV2RouteLoadScanReadback(
          [{ scan_event_id: `preview-${key}`, created: true }],
          scan,
          key,
        );
      }
      const raw = await callRpcOrEnqueue(ctx, "record_scan_event_v1", { p_scan: scan });
      return parseMobileV2RouteLoadScanReadback(raw, scan, key);
    },
  });
}

export interface UseFieldopsRouteOptions {
  /** Fallback envelope when the RPC errors / preview mode. */
  readonly fallback: MobileV2RouteEnvelope;
  readonly preferredTaskId?: string | null;
  readonly preferredRouteRunId?: string | null;
  readonly query?: Omit<UseQueryOptions<MobileV2RouteEnvelope, Error>, "queryKey" | "queryFn">;
}

export function useFieldopsRouteRpc(
  options: UseFieldopsRouteOptions,
): UseQueryResult<MobileV2RouteEnvelope, Error> {
  const ctx = useMobileV2Rpc();
  const fallback = options.fallback;
  return useQuery<MobileV2RouteEnvelope, Error>({
    queryKey: [
      "mobile-v2",
      "route",
      ctx.activeRole,
      ctx.policyContext ?? null,
      options.preferredTaskId ?? null,
      options.preferredRouteRunId ?? null,
    ],
    queryFn: async () => {
      if (isPreviewMode(ctx.supabase)) return fallback;
      const raw = await callRpc({
        supabase: ctx.supabase,
        name: "resolve_fieldops_tasks_v1",
        params: {
          p_active_role: ctx.activeRole,
          p_context: ctx.policyContext ?? {},
        },
      });
      const tasks = parseMobileV2TaskList(raw);
      // Route rows are scoped to one backend route run so pickup cards
      // and stale stops cannot render under the selected manifest.
      const routeSelection = selectMobileV2RouteTasks(
        tasks,
        options.preferredTaskId ?? null,
        options.preferredRouteRunId ?? null,
      );
      const { stopTasks, routeRunId, routeId } = routeSelection;
      if (stopTasks.length === 0) {
        return Object.freeze({
          rows: Object.freeze([]),
          totalStops: 0,
          routeId: null,
          routeRunId: null,
          manifestSummary: null,
        });
      }
      const rows = stopTasks
        .map((t, i) => mapMobileV2TaskToRouteStop(t, i))
        .slice()
        .sort((a, b) => a.seq - b.seq);
      const manifestSummary = routeRunId
        ? await fetchMobileV2RouteManifestSummary(ctx.supabase, routeRunId, routeId)
        : null;
      return Object.freeze({
        rows: Object.freeze(rows),
        totalStops: rows.length,
        routeId,
        routeRunId,
        manifestSummary,
      });
    },
    ...options.query,
  });
}

// ---------------------------------------------------------------------------
// Pickups — resolve_fieldops_pickups_v1
// ---------------------------------------------------------------------------

export interface UseFieldopsPickupsOptions {
  readonly fallback?: ReadonlyArray<MobileV2Pickup>;
  readonly query?: Omit<UseQueryOptions<ReadonlyArray<MobileV2Pickup>, Error>, "queryKey" | "queryFn">;
}

function asMetaRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function readStringField(
  row: Record<string, unknown>,
  meta: Record<string, unknown>,
  keys: ReadonlyArray<string>,
): string | null {
  for (const key of keys) {
    const rowValue = row[key];
    if (typeof rowValue === "string" && rowValue.trim().length > 0) return rowValue.trim();
    const metaValue = meta[key];
    if (typeof metaValue === "string" && metaValue.trim().length > 0) return metaValue.trim();
  }
  return null;
}

function readNumberField(
  row: Record<string, unknown>,
  meta: Record<string, unknown>,
  keys: ReadonlyArray<string>,
): number | null {
  for (const key of keys) {
    const rowValue = row[key];
    if (typeof rowValue === "number" && Number.isFinite(rowValue)) return rowValue;
    const metaValue = meta[key];
    if (typeof metaValue === "number" && Number.isFinite(metaValue)) return metaValue;
    if (typeof rowValue === "string" && rowValue.trim().length > 0) {
      const parsed = Number(rowValue);
      if (Number.isFinite(parsed)) return parsed;
    }
    if (typeof metaValue === "string" && metaValue.trim().length > 0) {
      const parsed = Number(metaValue);
      if (Number.isFinite(parsed)) return parsed;
    }
  }
  return null;
}

function parsePickupStatus(raw: unknown): MobileV2Pickup["status"] {
  const status = typeof raw === "string" ? raw.trim().toLowerCase() : "";
  if (["completed", "done", "in_transit", "picked_up"].includes(status)) return "completed";
  if (["failed", "pickup_failed", "exception"].includes(status)) return "failed";
  return "pending";
}

export function parsePickupList(raw: unknown, fallback: ReadonlyArray<MobileV2Pickup>): ReadonlyArray<MobileV2Pickup> {
  // P0 audit fix: previously fabricated `expectedQty` and `priority`
  // from the task `priority` numeric (e.g. priority 88 -> 9 parcels)
  // which invented business data. Now we read shape-correct fields only:
  // a row supplies expected_qty / picked / status / priority directly
  // (production: resolve_fieldops_pickups_v1 ships those fields), or
  // we report a truthful empty (expectedQty=0, status="pending",
  // priority="normal", sealRequired=false) until they exist.
  // 2nd-pass audit fix: empty array is a legitimate "no pickups today"
  // state — only fall back when payload is malformed (not an array).
  if (!Array.isArray(raw)) return fallback;
  if (raw.length === 0) return Object.freeze([]);
  const out: MobileV2Pickup[] = [];
  for (const r of raw) {
    if (r === null || typeof r !== "object") continue;
    const row = r as Record<string, unknown>;
    const meta = asMetaRecord(row.meta);
    const routeStopId = readStringField(row, meta, ["route_stop_id", "stop_id"]);
    const idRaw = routeStopId ?? row.id ?? row.code ?? row.task_id ?? row.title;
    if (typeof idRaw !== "string" || idRaw.length === 0) continue;
    const routeStopTaskId = readStringField(row, meta, ["route_stop_task_id", "task_uuid"]);
    const shipmentId = readStringField(row, meta, ["shipment_id"]);
    const routeRunId = readStringField(row, meta, ["route_run_id"]);
    const workflowRunId = readStringField(row, meta, ["workflow_run_id"]);
    const expectedQtyRaw = readNumberField(row, meta, ["expected_qty", "box_count"]);
    const expectedQty =
      expectedQtyRaw !== null
        ? Math.max(0, Math.round(expectedQtyRaw))
        : 0;
    const rawStatus = readStringField(row, meta, ["status", "pickup_status", "route_stop_status", "shipment_status"]);
    const status = parsePickupStatus(rawStatus);
    const pickedRaw = readNumberField(row, meta, ["picked", "picked_qty", "confirmed_quantity"]);
    const picked =
      pickedRaw !== null
        ? Math.max(0, Math.min(expectedQty, Math.round(pickedRaw)))
        : status === "completed"
          ? expectedQty
          : 0;
    const priorityScore = readNumberField(row, meta, ["priority", "priority_score"]);
    const priorityIn = typeof row.priority === "string" ? row.priority : priorityScore !== null && priorityScore >= 75 ? "high" : "normal";
    const failureReason = readStringField(row, meta, ["failure_reason", "status_reason", "reason_code"]);
    const failureNote = readStringField(row, meta, ["failure_note", "failure_notes", "exception_notes"]);
    out.push(
      Object.freeze({
        id: idRaw,
        routeStopId,
        routeStopTaskId,
        shipmentId,
        routeRunId,
        workflowRunId,
        failureReason,
        failureNote,
        wb: readStringField(row, meta, ["wb", "code", "tracking_number"]) ?? idRaw,
        merchant: readStringField(row, meta, ["merchant", "sender_name", "title"]) ?? idRaw,
        address: readStringField(row, meta, ["address", "origin_address", "area"]) ?? "",
        area: readStringField(row, meta, ["area"]) ?? "",
        window: readStringField(row, meta, ["window", "planned_window", "sub"]) ?? "",
        instructions: readStringField(row, meta, ["instructions"]) ?? undefined,
        expectedQty,
        picked,
        status,
        priority: priorityIn === "high" ? "high" : "normal",
        sealRequired: row.seal_required === true || meta.seal_required === true,
      }),
    );
  }
  return out.length > 0 ? Object.freeze(out) : fallback;
}

export function findMobileV2PickupReadback(
  rows: ReadonlyArray<MobileV2Pickup>,
  reference: Pick<MobileV2Pickup, "id" | "routeStopId" | "routeStopTaskId" | "shipmentId" | "workflowRunId">,
): MobileV2Pickup | null {
  const refs = new Set(
    [reference.id, reference.routeStopId, reference.routeStopTaskId, reference.shipmentId, reference.workflowRunId]
      .filter((value): value is string => typeof value === "string" && value.trim().length > 0),
  );
  if (refs.size === 0) return null;
  return rows.find((row) => (
    refs.has(row.id)
    || (typeof row.routeStopId === "string" && refs.has(row.routeStopId))
    || (typeof row.routeStopTaskId === "string" && refs.has(row.routeStopTaskId))
    || (typeof row.shipmentId === "string" && refs.has(row.shipmentId))
    || (typeof row.workflowRunId === "string" && refs.has(row.workflowRunId))
  )) ?? null;
}

export function useFieldopsPickupsRpc(
  options: UseFieldopsPickupsOptions = {},
): UseQueryResult<ReadonlyArray<MobileV2Pickup>, Error> {
  const ctx = useMobileV2Rpc();
  const fallback = options.fallback ?? [];
  return useQuery<ReadonlyArray<MobileV2Pickup>, Error>({
    queryKey: ["mobile-v2", "pickups", ctx.activeRole],
    queryFn: async () => {
      if (isPreviewMode(ctx.supabase)) return fallback;
      const raw = await callRpc({
        supabase: ctx.supabase,
        name: "resolve_fieldops_pickups_v1",
        params: { p_active_role: ctx.activeRole, p_context: ctx.policyContext ?? {} },
      });
      return parsePickupList(raw, fallback);
    },
    ...options.query,
  });
}

// ---------------------------------------------------------------------------
// Trips — backed by `resolve_fieldops_trips_v1` (migration
// `202605120100_resolve_fieldops_trips_v1_audit_fixup.sql`). Parses the
// returned row set with `parseTripList` for shape-drift safety.
// ---------------------------------------------------------------------------

export interface UseFieldopsTripsOptions {
  readonly fallback?: ReadonlyArray<MobileV2Trip>;
  readonly query?: Omit<UseQueryOptions<ReadonlyArray<MobileV2Trip>, Error>, "queryKey" | "queryFn">;
}

export function parseTripList(raw: unknown, fallback: ReadonlyArray<MobileV2Trip>): ReadonlyArray<MobileV2Trip> {
  // P0 audit fix #1: shape-validate so a future migration drift doesn't
  // render `undefined.name` in the UI.
  // P0 audit fix #2 (2nd pass): only fall back when payload is NOT a
  // valid array (truly malformed). An empty array is a legitimate empty
  // state from the backend; returning fallback there would mask "no
  // trips today" with sample data for an authenticated driver.
  if (!Array.isArray(raw)) return fallback;
  if (raw.length === 0) return Object.freeze([]);
  const out: MobileV2Trip[] = [];
  for (const r of raw) {
    if (r === null || typeof r !== "object") continue;
    const row = r as Record<string, unknown>;
    if (typeof row.id !== "string" || row.id.length === 0) continue;
    const origin = row.origin as Record<string, unknown> | undefined;
    const dest = row.dest as Record<string, unknown> | undefined;
    if (!origin || typeof origin.id !== "string" || typeof origin.name !== "string") continue;
    if (!dest || typeof dest.id !== "string" || typeof dest.name !== "string") continue;
    const validStages = new Set([
      "assigned",
      "gate-in",
      "loading",
      "sealed",
      "in-transit",
      "arrived",
      "gate-out",
      "reconciled",
    ]);
    const stage = typeof row.stage === "string" && validStages.has(row.stage) ? row.stage : "assigned";
    out.push(
      Object.freeze({
        id: row.id,
        leg: typeof row.leg === "string" ? row.leg : `${origin.name} → ${dest.name}`,
        driver: typeof row.driver === "string" ? row.driver : "—",
        vehicle: typeof row.vehicle === "string" ? row.vehicle : "—",
        stage: stage as MobileV2Trip["stage"],
        origin: Object.freeze({ id: origin.id, name: origin.name }),
        dest: Object.freeze({ id: dest.id, name: dest.name }),
        plannedDepart: typeof row.plannedDepart === "string" ? row.plannedDepart : "",
        plannedArrive: typeof row.plannedArrive === "string" ? row.plannedArrive : "",
        // 2nd-pass audit P2: default to null (not 0) so the FE renders
        // "—" for unknown ETAs instead of misleadingly showing "0m" /
        // "Now". MobileV2Trip.etaMin is typed `number | null`.
        etaMin: typeof row.etaMin === "number" && Number.isFinite(row.etaMin) ? row.etaMin : null,
        distance: typeof row.distance === "number" && Number.isFinite(row.distance) ? row.distance : 0,
        totalParcels:
          typeof row.totalParcels === "number" && Number.isFinite(row.totalParcels) ? row.totalParcels : 0,
        scanned: typeof row.scanned === "number" && Number.isFinite(row.scanned) ? row.scanned : 0,
        sealNo: typeof row.sealNo === "string" ? row.sealNo : null,
        manifest: Array.isArray(row.manifest) ? Object.freeze(row.manifest as ReadonlyArray<MobileV2Trip["manifest"][number]>) : Object.freeze([]),
      }) as MobileV2Trip,
    );
  }
  return out.length > 0 ? Object.freeze(out) : fallback;
}

export function useFieldopsTripsRpc(
  options: UseFieldopsTripsOptions = {},
): UseQueryResult<ReadonlyArray<MobileV2Trip>, Error> {
  const ctx = useMobileV2Rpc();
  const fallback = options.fallback ?? [];
  return useQuery<ReadonlyArray<MobileV2Trip>, Error>({
    queryKey: ["mobile-v2", "trips", ctx.activeRole],
    queryFn: async () => {
      if (isPreviewMode(ctx.supabase)) return fallback;
      const raw = await callRpc({
        supabase: ctx.supabase,
        name: "resolve_fieldops_trips_v1",
        params: { p_active_role: ctx.activeRole, p_context: ctx.policyContext ?? {} },
      });
      return parseTripList(raw, fallback);
    },
    ...options.query,
  });
}

// ---------------------------------------------------------------------------
// Sortation — bays + recent. Stubbed until aggregator lands; returns fallback.
// ---------------------------------------------------------------------------

export interface UseFieldopsSortationOptions {
  readonly fallback: {
    readonly bays: ReadonlyArray<MobileV2SortationBay>;
    readonly recent: ReadonlyArray<MobileV2SortationInduction>;
    readonly inductedThisSession: number;
    readonly throughputPerHour: number;
    readonly minutesElapsed: number;
  };
}

export function useFieldopsSortationRpc(
  options: UseFieldopsSortationOptions,
): UseQueryResult<UseFieldopsSortationOptions["fallback"], Error> {
  const ctx = useMobileV2Rpc();
  return useQuery<UseFieldopsSortationOptions["fallback"], Error>({
    queryKey: ["mobile-v2", "sortation"],
    queryFn: async () => {
      if (isPreviewMode(ctx.supabase)) return options.fallback;
      const raw = await callRpc({
        supabase: ctx.supabase,
        schema: "api",
        name: "resolve_fieldops_sortation_v1",
        params: { p_active_role: ctx.activeRole, p_context: ctx.policyContext ?? {} },
      });
      if (raw === null || typeof raw !== "object") return options.fallback;
      const r = raw as Record<string, unknown>;
      return Object.freeze({
        bays: withFallback(r.bays as ReadonlyArray<MobileV2SortationBay> | undefined, options.fallback.bays),
        recent: withFallback(r.recent as ReadonlyArray<MobileV2SortationInduction> | undefined, options.fallback.recent),
        inductedThisSession: withFallback(r.inducted as number | undefined, options.fallback.inductedThisSession),
        throughputPerHour: withFallback(r.throughput_per_hour as number | undefined, options.fallback.throughputPerHour),
        minutesElapsed: withFallback(r.minutes_elapsed as number | undefined, options.fallback.minutesElapsed),
      });
    },
  });
}

// ---------------------------------------------------------------------------
// Lookup — search results + recent
// ---------------------------------------------------------------------------

export interface UseFieldopsLookupOptions {
  readonly query: string;
  readonly fallback: {
    readonly records: ReadonlyArray<MobileV2LookupRecord>;
    readonly recent: ReadonlyArray<MobileV2LookupRecent>;
  };
}

export function useFieldopsLookupRpc(
  options: UseFieldopsLookupOptions,
): UseQueryResult<UseFieldopsLookupOptions["fallback"], Error> {
  const ctx = useMobileV2Rpc();
  return useQuery<UseFieldopsLookupOptions["fallback"], Error>({
    queryKey: ["mobile-v2", "lookup", options.query],
    queryFn: async () => {
      if (isPreviewMode(ctx.supabase)) return options.fallback;
      const raw = await callRpc({
        supabase: ctx.supabase,
        name: "resolve_fieldops_lookup_v1",
        params: {
          p_active_role: ctx.activeRole,
          p_context: ctx.policyContext ?? {},
          p_query: options.query,
        },
      });
      if (raw === null || typeof raw !== "object") return options.fallback;
      const r = raw as Record<string, unknown>;
      return Object.freeze({
        records: withFallback(
          r.records as ReadonlyArray<MobileV2LookupRecord> | undefined,
          options.fallback.records,
        ),
        recent: withFallback(
          r.recent as ReadonlyArray<MobileV2LookupRecent> | undefined,
          options.fallback.recent,
        ),
      });
    },
  });
}

// ---------------------------------------------------------------------------
// Wallet — driver pay/earnings aggregator. Stubbed until
// resolve_fieldops_wallet_v1 lands; returns fallback so the preview
// renders against placeholder env.
// ---------------------------------------------------------------------------

export interface UseFieldopsWalletOptions {
  readonly fallback: MobileV2WalletEnvelope;
  readonly enabled?: boolean;
}

export interface MobileV2WalletEnvelope {
  readonly wallet: MobileV2WalletBalance;
  readonly week: ReadonlyArray<MobileV2WalletWeekBar>;
  readonly breakdown: ReadonlyArray<MobileV2WalletBreakdownRow>;
  readonly latestWithdrawal?: MobileV2WalletWithdrawal | null;
}

export function useFieldopsWalletRpc(
  options: UseFieldopsWalletOptions,
): UseQueryResult<MobileV2WalletEnvelope, Error> {
  const ctx = useMobileV2Rpc();
  const enabled = options.enabled ?? true;
  return useQuery<MobileV2WalletEnvelope, Error>({
    queryKey: ["mobile-v2", "wallet", ctx.activeRole],
    queryFn: async () => {
      if (!enabled) return options.fallback;
      if (isPreviewMode(ctx.supabase)) return options.fallback;
      const raw = await callRpc({
        supabase: ctx.supabase,
        name: "resolve_fieldops_wallet_v1",
        params: { p_active_role: ctx.activeRole, p_context: ctx.policyContext ?? {} },
      });
      return mapFieldopsWalletEnvelope(raw, options.fallback);
    },
    enabled,
  });
}

function parseWalletWithdrawal(raw: unknown): MobileV2WalletWithdrawal | null {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const decisionLogId = typeof r.decision_log_id === "string" ? r.decision_log_id.trim() : "";
  const requestId = typeof r.request_id === "string" ? r.request_id.trim() : "";
  if (decisionLogId.length === 0 || requestId.length === 0) return null;
  return Object.freeze({
    decisionLogId,
    requestId,
    state: typeof r.state === "string" && r.state.trim().length > 0 ? r.state : "requested",
    amountSar: parseFiniteNumber(r.amount_sar) ?? 0,
    requestedAt:
      typeof r.requested_at === "string" && r.requested_at.trim().length > 0
        ? r.requested_at
        : null,
  });
}

export function mapFieldopsWalletEnvelope(
  raw: unknown,
  fallback: MobileV2WalletEnvelope,
): MobileV2WalletEnvelope {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return fallback;
  const r = raw as Record<string, unknown>;
  const w = r.wallet !== null && typeof r.wallet === "object" && !Array.isArray(r.wallet)
    ? (r.wallet as Record<string, unknown>)
    : undefined;
  const wallet: MobileV2WalletBalance =
    w !== undefined
      ? Object.freeze({
          balanceSar: parseFiniteNumber(w.balance_sar) ?? fallback.wallet.balanceSar,
          weekToDateSar: parseFiniteNumber(w.week_to_date_sar) ?? fallback.wallet.weekToDateSar,
          postsToBankLabel:
            typeof w.posts_to_bank_label === "string" && w.posts_to_bank_label.trim().length > 0
              ? w.posts_to_bank_label
              : fallback.wallet.postsToBankLabel,
        })
      : fallback.wallet;
  return Object.freeze({
    wallet,
    week: withFallback(r.week as ReadonlyArray<MobileV2WalletWeekBar> | undefined, fallback.week),
    breakdown: withFallback(
      r.breakdown as ReadonlyArray<MobileV2WalletBreakdownRow> | undefined,
      fallback.breakdown,
    ),
    latestWithdrawal: parseWalletWithdrawal(r.latest_withdrawal),
  });
}

export function mobileV2WalletWithdrawalMatchesWrite(
  latestWithdrawal: MobileV2WalletWithdrawal | null | undefined,
  write: MobileV2WriteEnvelope,
  amountSar: number,
): boolean {
  if (latestWithdrawal === null || latestWithdrawal === undefined) return false;
  const requestId = typeof write.request_id === "string" ? write.request_id : null;
  return (
    latestWithdrawal.decisionLogId === write.decision_log_id &&
    (requestId === null || latestWithdrawal.requestId === requestId) &&
    latestWithdrawal.amountSar === amountSar
  );
}

export function mobileV2CashDropMatchesWrite(
  latestDrop: MobileV2CashDropLastDrop | null | undefined,
  write: MobileV2WriteEnvelope,
  expectedSar: number,
  actualSar: number,
  photoId?: string | null,
): boolean {
  if (latestDrop === null || latestDrop === undefined) return false;
  const expectedPhotoId =
    typeof photoId === "string" && photoId.trim().length > 0 ? photoId.trim() : null;
  return (
    latestDrop.decisionLogId === write.decision_log_id &&
    latestDrop.expectedSar === expectedSar &&
    latestDrop.actualSar === actualSar &&
    latestDrop.varianceSar === actualSar - expectedSar &&
    (
      expectedPhotoId === null ||
      (
        latestDrop.photoId === expectedPhotoId &&
        latestDrop.photoArtifactRegistered === true
      )
    )
  );
}

// ---------------------------------------------------------------------------
// Returns — driver returns failed/RTO stops to hub. Stubbed against
// resolve_fieldops_returns_v1; returns fallback envelope otherwise.
// ---------------------------------------------------------------------------

export interface UseFieldopsReturnsOptions {
  readonly fallback: {
    readonly failed: ReadonlyArray<MobileV2ReturnsStop>;
    readonly returned: ReadonlyArray<MobileV2ReturnsRtoStop>;
    /** Cash collected today (currency-agnostic raw amount). */
    readonly codCollected: number;
    /** ISO currency code (default SAR if absent). */
    readonly currency?: string;
  };
}

export type MobileV2ReturnsEnvelope = UseFieldopsReturnsOptions["fallback"];

function parseMobileV2ReturnsFailedStop(row: unknown): MobileV2ReturnsStop | null {
  if (row === null || typeof row !== "object" || Array.isArray(row)) return null;
  const r = row as Record<string, unknown>;
  const id = asNonEmpty(r.id);
  const customer = asNonEmpty(r.customer);
  if (id === null || customer === null) return null;
  return Object.freeze({
    id,
    seq: asJsonNumber(r.seq) ?? 0,
    customer,
    addr: asNonEmpty(r.addr) ?? "",
    parcels: asJsonNumber(r.parcels) ?? 1,
    failReason: asNonEmpty(r.failReason ?? r.fail_reason) ?? "Return required",
  });
}

function parseMobileV2ReturnsReturnedStop(row: unknown): MobileV2ReturnsRtoStop | null {
  if (row === null || typeof row !== "object" || Array.isArray(row)) return null;
  const r = row as Record<string, unknown>;
  const id = asNonEmpty(r.id);
  const customer = asNonEmpty(r.customer);
  if (id === null || customer === null) return null;
  const stopId = asNonEmpty(r.stopId ?? r.stop_id);
  const base = {
    id,
    customer,
    parcels: asJsonNumber(r.parcels) ?? 1,
  };
  return Object.freeze(stopId === null ? base : { ...base, stopId });
}

function parseMobileV2ReturnsFailedList(
  value: unknown,
  fallback: ReadonlyArray<MobileV2ReturnsStop>,
): ReadonlyArray<MobileV2ReturnsStop> {
  if (!Array.isArray(value)) return fallback;
  if (value.length === 0) return Object.freeze([]);
  const out = value
    .map(parseMobileV2ReturnsFailedStop)
    .filter((item): item is MobileV2ReturnsStop => item !== null);
  return Object.freeze(out);
}

function parseMobileV2ReturnsReturnedList(
  value: unknown,
  fallback: ReadonlyArray<MobileV2ReturnsRtoStop>,
): ReadonlyArray<MobileV2ReturnsRtoStop> {
  if (!Array.isArray(value)) return fallback;
  if (value.length === 0) return Object.freeze([]);
  const out = value
    .map(parseMobileV2ReturnsReturnedStop)
    .filter((item): item is MobileV2ReturnsRtoStop => item !== null);
  return Object.freeze(out);
}

export function mapFieldopsReturnsEnvelope(
  raw: unknown,
  fallback: MobileV2ReturnsEnvelope,
): MobileV2ReturnsEnvelope {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return fallback;
  const r = raw as Record<string, unknown>;
  return Object.freeze({
    failed: parseMobileV2ReturnsFailedList(r.failed, fallback.failed),
    returned: parseMobileV2ReturnsReturnedList(r.returned, fallback.returned),
    codCollected: parseFiniteNumber(r.cod_collected ?? r.cod_collected_sar) ?? fallback.codCollected,
    currency:
      typeof r.currency === "string" && r.currency.length > 0
        ? r.currency
        : fallback.currency,
  });
}

export function findMobileV2ReturnedStopAfterMark(
  returned: ReadonlyArray<MobileV2ReturnsRtoStop>,
  write: MobileV2WriteEnvelope,
  stopId: string,
): MobileV2ReturnsRtoStop | null {
  const returnedId = `RTO-${stopId.slice(0, 8)}`;
  const writeStopId =
    typeof write.stop_id === "string" && write.stop_id.trim().length > 0
      ? write.stop_id
      : null;
  if (writeStopId !== null && writeStopId !== stopId) return null;
  return (
    returned.find((row) => row.stopId === stopId || row.id === returnedId) ?? null
  );
}

export function useFieldopsReturnsRpc(
  options: UseFieldopsReturnsOptions,
): UseQueryResult<UseFieldopsReturnsOptions["fallback"], Error> {
  const ctx = useMobileV2Rpc();
  return useQuery<UseFieldopsReturnsOptions["fallback"], Error>({
    queryKey: ["mobile-v2", "returns", ctx.activeRole],
    queryFn: async () => {
      if (isPreviewMode(ctx.supabase)) return options.fallback;
      const raw = await callRpc({
        supabase: ctx.supabase,
        name: "resolve_fieldops_returns_v1",
        params: { p_active_role: ctx.activeRole, p_context: ctx.policyContext ?? {} },
      });
      return mapFieldopsReturnsEnvelope(raw, options.fallback);
    },
  });
}

// ---------------------------------------------------------------------------
// Hub pickup — counter staff queue. Stubbed against
// resolve_fieldops_hub_pickup_v1; returns fallback queue otherwise.
// ---------------------------------------------------------------------------

export interface UseFieldopsHubPickupOptions {
  readonly fallback: ReadonlyArray<MobileV2HubPickupQueueItem>;
}

function parseHubPickupList(
  raw: unknown,
  fallback: ReadonlyArray<MobileV2HubPickupQueueItem>,
): ReadonlyArray<MobileV2HubPickupQueueItem> {
  // P0 audit fix: shape-validate RPC payload before exposing to UI.
  // Empty array is a legitimate "queue empty" state — only fall back
  // when payload is malformed (not an array).
  if (!Array.isArray(raw)) return fallback;
  if (raw.length === 0) return Object.freeze([]);
  const out: MobileV2HubPickupQueueItem[] = [];
  for (const r of raw) {
    if (r === null || typeof r !== "object") continue;
    const row = r as Record<string, unknown>;
    if (typeof row.id !== "string" || row.id.length === 0) continue;
    if (typeof row.customer !== "string") continue;
    out.push(
      Object.freeze({
        id: row.id,
        customer: row.customer,
        phone: typeof row.phone === "string" ? row.phone : "—",
        parcels: typeof row.parcels === "number" && Number.isFinite(row.parcels) ? Math.max(0, Math.round(row.parcels)) : 0,
        codSar: typeof row.codSar === "number" && Number.isFinite(row.codSar) ? Math.max(0, row.codSar) : 0,
        heldDays: typeof row.heldDays === "number" && Number.isFinite(row.heldDays) ? Math.max(0, Math.round(row.heldDays)) : 0,
        priority: row.priority === "high" ? "high" : "normal",
      }) as MobileV2HubPickupQueueItem,
    );
  }
  return out.length > 0 ? Object.freeze(out) : fallback;
}

export function useFieldopsHubPickupRpc(
  options: UseFieldopsHubPickupOptions,
): UseQueryResult<ReadonlyArray<MobileV2HubPickupQueueItem>, Error> {
  const ctx = useMobileV2Rpc();
  return useQuery<ReadonlyArray<MobileV2HubPickupQueueItem>, Error>({
    queryKey: ["mobile-v2", "hub-pickup", ctx.activeRole],
    queryFn: async () => {
      if (isPreviewMode(ctx.supabase)) return options.fallback;
      const raw = await callRpc({
        supabase: ctx.supabase,
        name: "resolve_fieldops_hub_pickup_v1",
        params: { p_active_role: ctx.activeRole, p_context: ctx.policyContext ?? {} },
      });
      return parseHubPickupList(raw, options.fallback);
    },
  });
}

// ---------------------------------------------------------------------------
// Hold queue — exceptions awaiting decision. Stubbed against
// resolve_fieldops_hold_v1; returns fallback list otherwise.
// ---------------------------------------------------------------------------

export interface UseFieldopsHoldOptions {
  readonly fallback: ReadonlyArray<MobileV2HoldItem>;
}

function parseHoldList(
  raw: unknown,
  fallback: ReadonlyArray<MobileV2HoldItem>,
): ReadonlyArray<MobileV2HoldItem> {
  // P0 audit fix: shape-validate RPC payload before exposing to UI.
  // Empty array is a legitimate "no exceptions" state.
  if (!Array.isArray(raw)) return fallback;
  if (raw.length === 0) return Object.freeze([]);
  const validReasons = new Set(["addr", "damage", "wrong_route", "other"]);
  const out: MobileV2HoldItem[] = [];
  for (const r of raw) {
    if (r === null || typeof r !== "object") continue;
    const row = r as Record<string, unknown>;
    const id = asNonEmpty(row.id ?? row.hold_id);
    const parcel = asNonEmpty(row.parcel ?? row.parcel_id);
    if (id === null || parcel === null) continue;
    const reason =
      typeof row.reason === "string" && validReasons.has(row.reason)
        ? (row.reason as MobileV2HoldItem["reason"])
        : "other";
    const atMs = asFiniteNumber(row.atMs ?? row.at_ms);
    out.push(
      Object.freeze({
        id,
        parcel,
        reason,
        note: typeof row.note === "string" ? row.note : "",
        atMs: atMs !== null ? atMs : Date.now(),
      }) as MobileV2HoldItem,
    );
  }
  return out.length > 0 ? Object.freeze(out) : fallback;
}

export function useFieldopsHoldRpc(
  options: UseFieldopsHoldOptions,
): UseQueryResult<ReadonlyArray<MobileV2HoldItem>, Error> {
  const ctx = useMobileV2Rpc();
  return useQuery<ReadonlyArray<MobileV2HoldItem>, Error>({
    queryKey: ["mobile-v2", "hold", ctx.activeRole],
    queryFn: async () => {
      if (isPreviewMode(ctx.supabase)) return options.fallback;
      const raw = await callRpc({
        supabase: ctx.supabase,
        schema: "api",
        name: "resolve_fieldops_hold_v1",
        params: { p_active_role: ctx.activeRole, p_context: ctx.policyContext ?? {} },
      });
      return parseHoldList(raw, options.fallback);
    },
  });
}

// ---------------------------------------------------------------------------
// Cash drop — driver drops collected COD at the hub. Stubbed against
// resolve_fieldops_cash_drop_v1; returns fallback envelope otherwise.
// expectedSar is policy-resolved via mobile_cash_policy upstream.
// ---------------------------------------------------------------------------

export interface UseFieldopsCashDropOptions {
  readonly fallback: MobileV2CashDropEnvelope;
  readonly enabled?: boolean;
}

export function useFieldopsCashDropRpc(
  options: UseFieldopsCashDropOptions,
): UseQueryResult<MobileV2CashDropEnvelope, Error> {
  const ctx = useMobileV2Rpc();
  const enabled = options.enabled ?? true;
  return useQuery<MobileV2CashDropEnvelope, Error>({
    queryKey: ["mobile-v2", "cash-drop", ctx.activeRole],
    queryFn: async () => {
      if (!enabled) return options.fallback;
      if (isPreviewMode(ctx.supabase)) return options.fallback;
      const raw = await callRpc({
        supabase: ctx.supabase,
        name: "resolve_fieldops_cash_drop_v1",
        params: { p_active_role: ctx.activeRole, p_context: ctx.policyContext ?? {} },
      });
      return mapFieldopsCashDropEnvelope(raw, options.fallback);
    },
    enabled,
  });
}

function parseFiniteNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string" || value.trim().length === 0) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseCashDropLastDrop(raw: unknown): MobileV2CashDropLastDrop | null {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const decisionLogId = typeof r.decision_log_id === "string" ? r.decision_log_id : null;
  if (decisionLogId === null || decisionLogId.trim().length === 0) return null;
  return Object.freeze({
    decisionLogId,
    state: typeof r.state === "string" && r.state.trim().length > 0 ? r.state : "submitted",
    expectedSar: parseFiniteNumber(r.expected_sar) ?? 0,
    actualSar: parseFiniteNumber(r.actual_sar) ?? 0,
    varianceSar: parseFiniteNumber(r.variance_sar) ?? 0,
    supervisorName:
      typeof r.supervisor_name === "string" && r.supervisor_name.trim().length > 0
        ? r.supervisor_name
        : null,
    submittedAt:
      typeof r.submitted_at === "string" && r.submitted_at.trim().length > 0
        ? r.submitted_at
        : null,
    photoId:
      typeof r.photo_id === "string" && r.photo_id.trim().length > 0
        ? r.photo_id
        : null,
    photoArtifactRegistered:
      typeof r.photo_artifact_registered === "boolean"
        ? r.photo_artifact_registered
        : null,
    photoStorageKey:
      typeof r.photo_storage_key === "string" && r.photo_storage_key.trim().length > 0
        ? r.photo_storage_key
        : null,
  });
}

export function mapFieldopsCashDropEnvelope(
  raw: unknown,
  fallback: MobileV2CashDropEnvelope,
): MobileV2CashDropEnvelope {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return fallback;
  const r = raw as Record<string, unknown>;
  return Object.freeze({
    expectedSar: parseFiniteNumber(r.expected_sar) ?? fallback.expectedSar,
    safeLocation:
      typeof r.safe_location === "string" && r.safe_location.trim().length > 0
        ? r.safe_location
        : fallback.safeLocation,
    lastDrop: parseCashDropLastDrop(r.latest_drop),
  });
}

// ---------------------------------------------------------------------------
// EOR — end-of-route hand-back. Reads resolve_fieldops_eor_v1.
//
// Engineering re-audit E7 (hidden mock): the previous mapper fell the
// `routeLabel` and the entire `recon` block through to the typed fixture
// per-field. That could present fixture route/cash data as LIVE shift
// data in the production native shell and feed fabricated reconciliation
// into the REAL `submit_fieldops_eod_recon_v1` decision_log write. That
// is a fixture masquerading as production data (AGENTS.md "never hide
// mocks as production").
//
// The honest contract is now binary, like the loader/rider hooks:
//   - Preview mode (`supabase === null`) OR a genuinely-absent resolver
//     (`isMissingRpcError`) → the typed fixture fallback (a legitimate
//     showcase/offline sample).
//   - A real resolver envelope → `summary` / `checklist` / `performance_
//     note` / `routeLabel` / `recon` / `lastRecon` pass through honestly. Missing business
//     fields degrade to empty/null, never fixture data.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Settlements - driver-visible settlement batches.
//
// Reads resolve_fieldops_settlements_v1 through the API schema. Preview mode
// returns the typed fixture, but live resolver responses map honestly: empty
// arrays stay empty and malformed business fields degrade to empty/zero/null
// instead of borrowing fixture settlement data.
// ---------------------------------------------------------------------------

export interface UseFieldopsSettlementsOptions {
  readonly fallback: MobileV2SettlementLedgerEnvelope;
}

export const EMPTY_FIELDOPS_SETTLEMENTS_ENVELOPE: MobileV2SettlementLedgerEnvelope = Object.freeze({
  settlements: Object.freeze([]),
  summary: Object.freeze({
    count: 0,
    expectedAmount: 0,
    collectedAmount: 0,
    remittedAmount: 0,
    varianceAmount: 0,
    currency: "SAR",
  }),
  readback: Object.freeze({
    source: "resolve_fieldops_settlements_v1",
    count: 0,
    resolvedAt: null,
  }),
});

function parseSettlementTimestamp(value: unknown): string | null {
  return asNonEmpty(value);
}

function formatSettlementWindowLabel(start: string | null, end: string | null): string {
  if (start === null && end === null) return "Window not set";
  if (start !== null && end !== null) return `${start.slice(0, 16)} to ${end.slice(0, 16)}`;
  return (start ?? end ?? "").slice(0, 16);
}

function parseSettlementRow(row: unknown): MobileV2SettlementLedgerRow | null {
  const r = asRecord(row);
  if (r === null) return null;
  const id = asNonEmpty(r.id ?? r.settlement_batch_id);
  if (id === null) return null;
  const kind = asNonEmpty(r.kind) ?? "settlement";
  const scopeType = asNonEmpty(r.scope_type ?? r.scopeType) ?? "driver_shift";
  const status = asNonEmpty(r.status) ?? "open";
  const currency = asNonEmpty(r.currency) ?? "SAR";
  const expectedAmount = asFiniteNumber(r.expected_amount ?? r.expectedAmount) ?? 0;
  const collectedAmount = asFiniteNumber(r.collected_amount ?? r.collectedAmount) ?? 0;
  const remittedAmount = asFiniteNumber(r.remitted_amount ?? r.remittedAmount) ?? 0;
  const varianceAmount =
    asFiniteNumber(r.variance_amount ?? r.varianceAmount) ?? collectedAmount - expectedAmount;
  const windowStart = parseSettlementTimestamp(r.window_start_at ?? r.windowStartAt);
  const windowEnd = parseSettlementTimestamp(r.window_end_at ?? r.windowEndAt);
  return Object.freeze({
    id,
    title: asNonEmpty(r.title) ?? `${kind} settlement ${id.slice(0, 8)}`,
    kind,
    scopeType,
    status,
    expectedAmount,
    collectedAmount,
    remittedAmount,
    varianceAmount,
    currency,
    windowLabel:
      asNonEmpty(r.window_label ?? r.windowLabel) ??
      formatSettlementWindowLabel(windowStart, windowEnd),
    updatedAt: parseSettlementTimestamp(r.updated_at ?? r.updatedAt),
  });
}

function parseSettlementSummary(
  value: unknown,
  rows: ReadonlyArray<MobileV2SettlementLedgerRow>,
): MobileV2SettlementLedgerSummary {
  const r = asRecord(value);
  const currency =
    asNonEmpty(r?.currency) ??
    rows.find((row) => row.currency.trim().length > 0)?.currency ??
    EMPTY_FIELDOPS_SETTLEMENTS_ENVELOPE.summary.currency;
  return Object.freeze({
    count: Math.max(
      0,
      Math.round(asFiniteNumber(r?.count) ?? rows.length),
    ),
    expectedAmount:
      asFiniteNumber(r?.expected_amount ?? r?.expectedAmount) ??
      rows.reduce((total, row) => total + row.expectedAmount, 0),
    collectedAmount:
      asFiniteNumber(r?.collected_amount ?? r?.collectedAmount) ??
      rows.reduce((total, row) => total + row.collectedAmount, 0),
    remittedAmount:
      asFiniteNumber(r?.remitted_amount ?? r?.remittedAmount) ??
      rows.reduce((total, row) => total + row.remittedAmount, 0),
    varianceAmount:
      asFiniteNumber(r?.variance_amount ?? r?.varianceAmount) ??
      rows.reduce((total, row) => total + row.varianceAmount, 0),
    currency,
  });
}

function parseSettlementReadback(
  value: unknown,
  rows: ReadonlyArray<MobileV2SettlementLedgerRow>,
): MobileV2SettlementLedgerReadback {
  const r = asRecord(value);
  return Object.freeze({
    source: asNonEmpty(r?.source) ?? EMPTY_FIELDOPS_SETTLEMENTS_ENVELOPE.readback.source,
    count: Math.max(0, Math.round(asFiniteNumber(r?.count) ?? rows.length)),
    resolvedAt: asNonEmpty(r?.resolved_at ?? r?.resolvedAt),
  });
}

export function mapFieldopsSettlementsEnvelope(
  raw: unknown,
): MobileV2SettlementLedgerEnvelope {
  const r = asRecord(raw);
  if (r === null) return EMPTY_FIELDOPS_SETTLEMENTS_ENVELOPE;
  const rows = Array.isArray(r.settlements)
    ? Object.freeze(
        r.settlements
          .map(parseSettlementRow)
          .filter((row): row is MobileV2SettlementLedgerRow => row !== null),
      )
    : Object.freeze([]);
  return Object.freeze({
    settlements: rows,
    summary: parseSettlementSummary(r.summary, rows),
    readback: parseSettlementReadback(r.readback, rows),
  });
}

export function resolveFieldopsSettlementsDisplayEnvelope(
  data: MobileV2SettlementLedgerEnvelope | undefined,
  fallback: MobileV2SettlementLedgerEnvelope,
  isShowcase: boolean,
): MobileV2SettlementLedgerEnvelope {
  if (data !== undefined) return data;
  return isShowcase ? fallback : EMPTY_FIELDOPS_SETTLEMENTS_ENVELOPE;
}

export function useFieldopsSettlementsRpc(
  options: UseFieldopsSettlementsOptions,
): UseQueryResult<MobileV2SettlementLedgerEnvelope, Error> {
  const ctx = useMobileV2Rpc();
  return useQuery<MobileV2SettlementLedgerEnvelope, Error>({
    queryKey: ["mobile-v2", "settlements", ctx.activeRole, ctx.policyContext ?? null],
    queryFn: async () => {
      if (isPreviewMode(ctx.supabase)) return options.fallback;
      const raw = await callRpc({
        supabase: ctx.supabase,
        schema: "api",
        name: "resolve_fieldops_settlements_v1",
        params: { p_active_role: ctx.activeRole, p_context: ctx.policyContext ?? {} },
      });
      return mapFieldopsSettlementsEnvelope(raw);
    },
  });
}

export interface UseFieldopsEorOptions {
  readonly fallback: MobileV2EorEnvelope;
  readonly routeRunId?: string | null;
}

/**
 * Pure mapper for the `resolve_fieldops_eor_v1` envelope. `raw` is the
 * resolver response; `fallback` supplies only the typed shape for the
 * shape-tolerant `summary` / `checklist` reads (the resolver always emits
 * those). Every other business field is read honestly — `routeLabel`
 * degrades to "" and `recon` / `lastRecon` to `null` when the resolver
 * omits them, NEVER to fixture business data. Exported for direct unit
 * testing of the E7 honest-degrade contract without a react-query harness.
 */
export function mapFieldopsEorEnvelope(
  raw: unknown,
  fallback: MobileV2EorEnvelope,
): MobileV2EorEnvelope {
  const r =
    raw !== null && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const reconRaw =
    r.recon !== null && typeof r.recon === "object"
      ? (r.recon as Record<string, unknown>)
      : null;
  const lastReconRaw = asRecord(r.last_recon);
  // A recon block is honoured only when the resolver supplies EVERY
  // numeric/string input. A partial object would mean fabricating the
  // rest, so it degrades to null instead of fixture values.
  const recon: MobileV2EorRecon | null =
    reconRaw !== null &&
    asJsonNumber(reconRaw.parcels_count) !== null &&
    asJsonNumber(reconRaw.mismatch_count) !== null &&
    asJsonNumber(reconRaw.cash_declared) !== null &&
    asJsonNumber(reconRaw.cash_counted) !== null &&
    typeof reconRaw.wallet_status === "string"
      ? (() => {
          const routeRunId = asNonEmpty(reconRaw.route_run_id);
          const base = {
            parcelsCount: asJsonNumber(reconRaw.parcels_count) ?? 0,
            mismatchCount: asJsonNumber(reconRaw.mismatch_count) ?? 0,
            cashDeclared: asJsonNumber(reconRaw.cash_declared) ?? 0,
            cashCounted: asJsonNumber(reconRaw.cash_counted) ?? 0,
            walletStatus: reconRaw.wallet_status,
          };
          return Object.freeze(routeRunId === null ? base : { ...base, routeRunId });
        })()
      : null;
  const lastRecon: MobileV2EorLastRecon | null =
    lastReconRaw !== null &&
    asNonEmpty(lastReconRaw.decision_log_id) !== null &&
    asNonEmpty(lastReconRaw.state) !== null &&
    asJsonNumber(lastReconRaw.parcels_count) !== null &&
    asJsonNumber(lastReconRaw.mismatch_count) !== null &&
    asJsonNumber(lastReconRaw.cash_declared) !== null &&
    asJsonNumber(lastReconRaw.cash_counted) !== null &&
    asJsonNumber(lastReconRaw.cash_variance) !== null &&
    asNonEmpty(lastReconRaw.wallet_status) !== null
      ? (() => {
          const routeRunId = asNonEmpty(lastReconRaw.route_run_id);
          const base = {
            decisionLogId: asNonEmpty(lastReconRaw.decision_log_id) ?? "",
            state: asNonEmpty(lastReconRaw.state) ?? "",
            parcelsCount: asJsonNumber(lastReconRaw.parcels_count) ?? 0,
            mismatchCount: asJsonNumber(lastReconRaw.mismatch_count) ?? 0,
            cashDeclared: asJsonNumber(lastReconRaw.cash_declared) ?? 0,
            cashCounted: asJsonNumber(lastReconRaw.cash_counted) ?? 0,
            cashVariance: asJsonNumber(lastReconRaw.cash_variance) ?? 0,
            walletStatus: asNonEmpty(lastReconRaw.wallet_status) ?? "",
            submittedAt: asNonEmpty(lastReconRaw.submitted_at),
          };
          return Object.freeze(routeRunId === null ? base : { ...base, routeRunId });
        })()
      : null;
  return Object.freeze({
    // summary / checklist are the resolver's real aggregation; the typed
    // fallback is kept only as a shape guard for a malformed payload.
    summary: (r.summary as MobileV2EorSummary | undefined) ?? fallback.summary,
    checklist: withFallback(
      r.checklist as ReadonlyArray<MobileV2EorChecklistItem> | undefined,
      fallback.checklist,
    ),
    // performanceNote: honest null when the resolver omits it.
    performanceNote:
      typeof r.performance_note === "string" ? r.performance_note : null,
    // routeLabel: honest "" when the resolver omits it — never the fixture.
    routeLabel: typeof r.route_label === "string" ? r.route_label : "",
    // recon: honest null when the resolver omits it — never the fixture.
    recon,
    lastRecon,
  });
}

export function useFieldopsEorRpc(
  options: UseFieldopsEorOptions,
): UseQueryResult<MobileV2EorEnvelope, Error> {
  const ctx = useMobileV2Rpc();
  return useQuery<MobileV2EorEnvelope, Error>({
    queryKey: ["mobile-v2", "eor", ctx.activeRole, options.routeRunId ?? null],
    queryFn: async () => {
      // Preview/showcase mode: the fixture is a legitimate sample.
      if (isPreviewMode(ctx.supabase)) return options.fallback;
      let raw: unknown;
      try {
        raw = await callRpc({
          supabase: ctx.supabase,
          name: "resolve_fieldops_eor_v1",
          params: {
            p_active_role: ctx.activeRole,
            p_context: {
              ...(ctx.policyContext ?? {}),
              ...(options.routeRunId ? { route_run_id: options.routeRunId } : {}),
            },
          },
        });
      } catch (error) {
        // Resolver not migrated onto this DB yet — degrade to the typed
        // fixture. Any other error (RLS denial, network fault) is
        // re-thrown for the error card.
        if (isMissingRpcError(error)) return options.fallback;
        throw error;
      }
      // A real resolver response — map it honestly.
      return mapFieldopsEorEnvelope(raw, options.fallback);
    },
  });
}

// ---------------------------------------------------------------------------
// Loader-home aggregator — resolve_fieldops_loader_today_v1.
//
// Audit F1 (BLOCKER): the loader "Home" tab fell through to a debug
// sandbox. The loader-today screen is now wired into PreviewBody and
// reads through this resolver; the fixture is the preview/offline
// fallback only.
//
// Engineering re-audit E1: `resolve_fieldops_loader_today_v1` now ships
// as a real RLS-safe resolver (migration 202605180000) that aggregates
// counts + the driver queue from route_runs + route_stops. Should the
// resolver be absent on a not-yet-migrated DB the hook degrades to the
// typed fixture fallback via `isMissingRpcError` instead of throwing a
// misleading server error. Genuine RLS / network failures still surface
// as an error.
//
// Engineering re-audit E6 (hidden mock): the previous per-field mapper
// fell each missing field through to the typed fixture value. Because
// the resolver ALWAYS returns `wave_label: NULL` / `bay: NULL` /
// `route_label: NULL` / `cut_off: NULL` (loader-wave assignment has no
// canonical source table by design), that per-field substitution
// unconditionally presented the fixture wave (`Bay B · Wave 3 · 06:40`),
// bay (`B-04`), route (`RT-2026-0502-A`) and cut-off (`07:30`) as LIVE
// loader-session data in the production native shell. Worse, the
// fabricated `bay` was fed into the REAL `induct_fieldops_parcel_v1`
// write as `p_bay`. That is a fixture masquerading as production data
// and violates the AGENTS.md "never hide mocks as production" contract.
//
// The honest contract is now binary, not per-field:
//   - Preview mode (`supabase === null`) OR a genuinely-absent resolver
//     (`isMissingRpcError`) → the typed fixture fallback, which is a
//     legitimate showcase/offline sample.
//   - A real resolver envelope in production → its real fields pass
//     through HONESTLY. Resolver-NULL `waveLabel` / `bay` / `routeLabel`
//     / `cutOff` degrade to neutral empty strings — NEVER fixture
//     business data. Counts default to 0; quick-action tiles (a row-
//     defined navigation surface) and the driver queue fall through to
//     [] when the resolver omits them. The loader screen / app-bar then
//     render their honest empty states, and the induction path surfaces
//     the missing bay honestly instead of writing a fabricated one.
// ---------------------------------------------------------------------------

export interface UseFieldopsLoaderTodayOptions {
  readonly fallback: MobileV2LoaderTodayEnvelope;
}

/**
 * Pure mapper for the `resolve_fieldops_loader_today_v1` envelope.
 *
 * `raw` is the resolver's JSON response. Every loader-session/business
 * field is read honestly: a missing/NULL field degrades to a neutral
 * empty/zero value, NEVER to fixture business data. `fallback` supplies
 * only the row-defined quick-action navigation tiles when the resolver
 * omits them. Exported for direct unit testing of the E6 honest-degrade
 * contract without a react-query harness.
 */
export function mapFieldopsLoaderTodayEnvelope(
  raw: unknown,
  fallback: MobileV2LoaderTodayEnvelope,
): MobileV2LoaderTodayEnvelope {
  const r =
    raw !== null && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  return Object.freeze({
    // Identity label resolves from the real resolver (users.full_name
    // first token). Absent → neutral empty string, not the fixture name.
    greetingName: typeof r.greeting_name === "string" ? r.greeting_name : "",
    activeOpsSessionId:
      typeof r.active_ops_session_id === "string" ? r.active_ops_session_id : "",
    // Loader-wave assignment fields — honest neutral empty defaults when
    // the resolver omits them (it does, until a loader-wave source table
    // ships). They must NOT inherit the fixture wave/bay/route/cut-off.
    waveLabel: typeof r.wave_label === "string" ? r.wave_label : "",
    bay: typeof r.bay === "string" ? r.bay : "",
    routeLabel: typeof r.route_label === "string" ? r.route_label : "",
    cutOff: typeof r.cut_off === "string" ? r.cut_off : "",
    // Live counts from route_runs + route_stops — honest zero when absent.
    coldChainCount:
      typeof r.cold_chain_count === "number" ? r.cold_chain_count : 0,
    liveRoutes: typeof r.live_routes === "number" ? r.live_routes : 0,
    totalParcels: typeof r.total_parcels === "number" ? r.total_parcels : 0,
    scannedParcels:
      typeof r.scanned_parcels === "number" ? r.scanned_parcels : 0,
    driversWaiting:
      typeof r.drivers_waiting === "number" ? r.drivers_waiting : 0,
    // Quick-action tiles are a row-defined navigation surface (not
    // tenant business data); the resolver always returns them, but if it
    // omits the key keep the fixture's identical navigation grid.
    quickActions: withFallback(
      r.quick_actions as ReadonlyArray<MobileV2LoaderQuickAction> | undefined,
      fallback.quickActions,
    ),
    // An absent `drivers` key → empty list (honest "no queue"); only
    // fall back to [] (never the fixture queue).
    drivers: Array.isArray(r.drivers)
      ? (r.drivers as ReadonlyArray<MobileV2LoaderDriverQueueEntry>)
      : [],
  });
}

export function buildNeutralFieldopsLoaderTodayEnvelope(
  fallback: MobileV2LoaderTodayEnvelope,
): MobileV2LoaderTodayEnvelope {
  return mapFieldopsLoaderTodayEnvelope(null, fallback);
}

export function useFieldopsLoaderTodayRpc(
  options: UseFieldopsLoaderTodayOptions,
): UseQueryResult<MobileV2LoaderTodayEnvelope, Error> {
  const ctx = useMobileV2Rpc();
  return useQuery<MobileV2LoaderTodayEnvelope, Error>({
    queryKey: ["mobile-v2", "loader-today", ctx.activeRole],
    queryFn: async () => {
      // Preview/showcase mode: the fixture is a legitimate sample.
      if (isPreviewMode(ctx.supabase)) return options.fallback;
      let raw: unknown;
      try {
        raw = await callRpc({
          supabase: ctx.supabase,
          schema: "api",
          name: "resolve_fieldops_loader_today_v1",
          params: { p_active_role: ctx.activeRole, p_context: ctx.policyContext ?? {} },
        });
      } catch (error) {
        // Resolver not migrated onto this DB yet — degrade to the typed
        // fixture so the loader home renders. Any other error (RLS
        // denial, network fault) is re-thrown for the error card.
        if (isMissingRpcError(error)) return buildNeutralFieldopsLoaderTodayEnvelope(options.fallback);
        throw error;
      }
      // A real resolver response — map it honestly. Resolver-NULL
      // wave/bay/route/cut-off degrade to "", never the fixture values.
      return mapFieldopsLoaderTodayEnvelope(raw, options.fallback);
    },
  });
}

// ---------------------------------------------------------------------------
// Rider-home aggregator — resolve_fieldops_rider_today_v1.
//
// Audit F1 (BLOCKER): the rider "Home" tab now renders the real
// rider-today screen, resolver-backed with a preview/offline fallback.
//
// Engineering re-audit E1: `resolve_fieldops_rider_today_v1` ships as a
// real resolver (migration 202605180000) — but rider gig tickets +
// per-shift earnings have NO canonical source table in the schema yet,
// so the resolver honestly returns the caller's resolved identity plus
// an empty/zero gig state.
//
// Engineering re-audit E5 (hidden mock): the previous per-field mapper
// fell each missing field through to the typed fixture value. Because
// the resolver ALWAYS returns `active: NULL` / `online: NULL` /
// `rating: NULL` / `shift_duration: NULL` (rider gig data has no source
// table by design), that per-field substitution unconditionally
// presented the fixture ticket (TK-7741 / Najd Coffee / +18 ﷼) as a
// LIVE delivery in the production native shell. That is a fixture
// masquerading as production data and violates the AGENTS.md
// "never hide mocks as production" contract.
//
// The honest contract is now binary, not per-field:
//   - Preview mode (`supabase === null`) OR a genuinely-absent resolver
//     (`isMissingRpcError`) → the typed fixture fallback, which is a
//     legitimate showcase/offline sample.
//   - A real resolver envelope in production → its real fields pass
//     through HONESTLY. `active: null` stays `null`; `online` / `rating`
//     / `shiftDuration` stay false/0/"" when the resolver omits them;
//     `earningsToday` / `tripsCompleted` stay 0. The rider screen then
//     renders its honest "No active ticket. Stand by…" empty state.
//     Business records are never substituted from the fixture behind a
//     live resolver response.
// `currency` is a locale formatting label (the ﷼ symbol source), not a
// business record — it keeps a defensible non-empty fallback so the
// earnings figure still renders a currency unit.
// ---------------------------------------------------------------------------

export interface UseFieldopsRiderTodayOptions {
  readonly fallback: MobileV2RiderTodayEnvelope;
}

/**
 * Pure mapper for the `resolve_fieldops_rider_today_v1` envelope.
 *
 * `raw` is the resolver's JSON response. Every gig/business field is
 * read honestly: a missing/NULL field degrades to a neutral empty/zero
 * value, NEVER to fixture business data. `fallback` supplies only the
 * locale currency label (cosmetic). Exported for direct unit testing of
 * the E5 honest-degrade contract without a react-query harness.
 */
export function mapFieldopsRiderTodayEnvelope(
  raw: unknown,
  fallback: MobileV2RiderTodayEnvelope,
): MobileV2RiderTodayEnvelope {
  const r =
    raw !== null && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  return Object.freeze({
    // Identity labels resolve from the real resolver (users.full_name /
    // employee id). Absent → neutral empty string, not the fixture name.
    greetingName: typeof r.greeting_name === "string" ? r.greeting_name : "",
    employeeId: typeof r.employee_id === "string" ? r.employee_id : "",
    // Gig/business state — honest neutral defaults when the resolver
    // omits them (it does, until a rider-gig source table ships).
    online: typeof r.online === "boolean" ? r.online : false,
    earningsToday: typeof r.earnings_today === "number" ? r.earnings_today : 0,
    tripsCompleted: typeof r.trips_completed === "number" ? r.trips_completed : 0,
    rating: typeof r.rating === "number" ? r.rating : 0,
    shiftDuration: typeof r.shift_duration === "string" ? r.shift_duration : "",
    // Cosmetic locale label: keep a defensible non-empty fallback.
    currency: typeof r.currency === "string" ? r.currency : fallback.currency,
    // `active: null` is a legitimate "no live ticket" state — preserve
    // it verbatim. Only an actual ticket object passes through.
    active:
      r.active !== undefined && r.active !== null
        ? (r.active as MobileV2RiderTicket)
        : null,
    // An absent `upcoming` key → empty list (honest "no queue"); only
    // fall back to [] (never the fixture queue).
    upcoming: Array.isArray(r.upcoming)
      ? (r.upcoming as ReadonlyArray<MobileV2RiderTicket>)
      : [],
  });
}

export function useFieldopsRiderTodayRpc(
  options: UseFieldopsRiderTodayOptions,
): UseQueryResult<MobileV2RiderTodayEnvelope, Error> {
  const ctx = useMobileV2Rpc();
  return useQuery<MobileV2RiderTodayEnvelope, Error>({
    queryKey: ["mobile-v2", "rider-today", ctx.activeRole],
    queryFn: async () => {
      // Preview/showcase mode: the fixture is a legitimate sample.
      if (isPreviewMode(ctx.supabase)) return options.fallback;
      let raw: unknown;
      try {
        raw = await callRpc({
          supabase: ctx.supabase,
          name: "resolve_fieldops_rider_today_v1",
          params: { p_active_role: ctx.activeRole, p_context: ctx.policyContext ?? {} },
        });
      } catch (error) {
        // Resolver not migrated onto this DB yet — degrade to the typed
        // fixture so the home screen renders. Any other error (RLS
        // denial, network fault) re-throws for the error card.
        if (isMissingRpcError(error)) return options.fallback;
        throw error;
      }
      // A real resolver response — map it honestly. `active: null` stays
      // null; the fixture never substitutes live gig business data.
      return mapFieldopsRiderTodayEnvelope(raw, options.fallback);
    },
  });
}

// ---------------------------------------------------------------------------
// Supervisor-queue aggregator — resolve_fieldops_supervisor_queue_v1.
//
// Audit F1 (BLOCKER): the supervisor "Home" tab now renders the real
// approvals-queue screen, resolver-backed with a preview/offline fallback.
//
// Engineering re-audit E1: `resolve_fieldops_supervisor_queue_v1` ships
// as a real RLS-safe resolver (migration 202605180000) that unions
// route_runs awaiting review + fieldops_v2_incidents — both canonical
// tables — into the approvals queue. An empty queue is a legitimate
// "no approvals" state and is preserved verbatim (NOT replaced by the
// fixture). If the resolver is absent on a not-yet-migrated DB the hook
// degrades to the typed fixture via `isMissingRpcError`; genuine RLS /
// network failures still surface as an error card.
// ---------------------------------------------------------------------------

export interface UseFieldopsSupervisorQueueOptions {
  readonly fallback: MobileV2SupervisorQueueEnvelope;
}

export function useFieldopsSupervisorQueueRpc(
  options: UseFieldopsSupervisorQueueOptions,
): UseQueryResult<MobileV2SupervisorQueueEnvelope, Error> {
  const ctx = useMobileV2Rpc();
  return useQuery<MobileV2SupervisorQueueEnvelope, Error>({
    queryKey: ["mobile-v2", "supervisor-queue", ctx.activeRole],
    queryFn: async () => {
      if (isPreviewMode(ctx.supabase)) return options.fallback;
      let raw: unknown;
      try {
        raw = await callRpc({
          supabase: ctx.supabase,
          name: "resolve_fieldops_supervisor_queue_v1",
          params: { p_active_role: ctx.activeRole, p_context: ctx.policyContext ?? {} },
        });
      } catch (error) {
        if (isMissingRpcError(error)) return options.fallback;
        throw error;
      }
      if (raw === null || typeof raw !== "object") return options.fallback;
      const r = raw as Record<string, unknown>;
      // An empty queue ([]) is a legitimate "no pending approvals"
      // state — keep it. Only fall back when `queue` is absent entirely.
      const queue = Array.isArray(r.queue)
        ? (r.queue as ReadonlyArray<MobileV2SupervisorItem>)
        : options.fallback.queue;
      return Object.freeze({
        supervisorName:
          typeof r.supervisor_name === "string"
            ? r.supervisor_name
            : options.fallback.supervisorName,
        queue,
        activeId:
          typeof r.active_id === "string"
            ? r.active_id
            : queue[0]?.id ?? options.fallback.activeId,
      });
    },
  });
}

// ---------------------------------------------------------------------------
// Shell-chrome identity — resolve_fieldops_profile_v1.
//
// Engineering re-audit E3: the V2 drawer header + More screen rendered a
// hardcoded `MOBILE_V2_PREVIEW_USER` ("Khalid Al-Hashimi" / "DRV-2026-0042")
// in the production native shell. This hook binds the chrome identity to
// `resolve_fieldops_profile_v1` (migration 202605180000), which returns
// the CALLER's real name (users.full_name) + a stable display badge.
// The fixture is the preview/offline fallback only; a not-yet-migrated
// DB degrades to it via `isMissingRpcError` rather than erroring.
// ---------------------------------------------------------------------------

export interface UseFieldopsProfileOptions {
  /** Fallback identity used in preview mode or when the resolver is absent. */
  readonly fallback: MobileV2ProfileEnvelope;
}

export function useFieldopsProfileRpc(
  options: UseFieldopsProfileOptions,
): UseQueryResult<MobileV2ProfileEnvelope, Error> {
  const ctx = useMobileV2Rpc();
  return useQuery<MobileV2ProfileEnvelope, Error>({
    queryKey: ["mobile-v2", "profile", ctx.activeRole],
    queryFn: async () => {
      if (isPreviewMode(ctx.supabase)) return options.fallback;
      let raw: unknown;
      try {
        raw = await callRpc({
          supabase: ctx.supabase,
          name: "resolve_fieldops_profile_v1",
          params: { p_active_role: ctx.activeRole, p_context: ctx.policyContext ?? {} },
        });
      } catch (error) {
        if (isMissingRpcError(error)) return options.fallback;
        throw error;
      }
      if (raw === null || typeof raw !== "object") return options.fallback;
      const r = raw as Record<string, unknown>;
      // Each field falls through to the fixture value when the resolver
      // returns null (caller has no users row / no org) — never an empty
      // chrome label.
      return Object.freeze({
        name: typeof r.name === "string" && r.name.length > 0 ? r.name : options.fallback.name,
        badge:
          typeof r.badge === "string" && r.badge.length > 0
            ? r.badge
            : options.fallback.badge,
        currency:
          typeof r.currency === "string" && r.currency.length > 0
            ? r.currency
            : options.fallback.currency,
      });
    },
  });
}

// ---------------------------------------------------------------------------
// Stop detail — resolve_fieldops_stop_detail_v1
//
// Engineering audit B2 (BLOCKER): the V2 stop screen rendered off a
// hardcoded `{...SAMPLE_STOP}` spread + inline parcel/proof literals
// that were never RPC-bound. `resolve_fieldops_stop_detail_v1` (migration
// 202605131300) returns a single JSONB envelope whose keys map 1:1 to
// `MobileV2StopDetail`; this hook binds the production shell to it, with
// the fixture engaged only as the preview/offline fallback.
// ---------------------------------------------------------------------------

export interface UseFieldopsStopDetailOptions {
  /**
   * Stop id to resolve. A canonical UUID is sent to the RPC; a fixture
   * id (e.g. `STP-003`) short-circuits to the fallback without a round
   * trip — the RPC rejects a non-UUID `p_stop_id` with SQLSTATE 22P02.
   * `null` also short-circuits to the fallback (no active stop yet).
   */
  readonly stopId: string | null;
  /** Fallback stop used in preview mode or when the id is not persisted. */
  readonly fallback: MobileV2StopDetail;
  /** Pass-through useQuery overrides. */
  readonly query?: Omit<UseQueryOptions<MobileV2StopDetail, Error>, "queryKey" | "queryFn">;
}

/**
 * Parse the `resolve_fieldops_stop_detail_v1` envelope into a
 * `MobileV2StopDetail`. The resolver builds the envelope key-for-key
 * against the interface, but a future migration drift must not render
 * `undefined` fields — so required scalars fall back to the fixture's
 * value and array fields default to `[]`.
 */
export function parseMobileV2StopDetailEnvelope(
  raw: unknown,
  fallback: MobileV2StopDetail,
): MobileV2StopDetail {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return fallback;
  const r = raw as Record<string, unknown>;
  const str = (key: string, fb: string): string =>
    typeof r[key] === "string" && (r[key] as string).length > 0 ? (r[key] as string) : fb;
  const num = (key: string, fb: number): number =>
    typeof r[key] === "number" && Number.isFinite(r[key]) ? (r[key] as number) : fb;
  const arr = <T,>(key: string): ReadonlyArray<T> =>
    Array.isArray(r[key]) ? Object.freeze(r[key] as ReadonlyArray<T>) : Object.freeze([]);
  const stopTypeRaw = r.stopType;
  const stopType: MobileV2StopDetail["stopType"] =
    stopTypeRaw === "pickup" || stopTypeRaw === "rto" || stopTypeRaw === "delivery"
      ? stopTypeRaw
      : fallback.stopType;
  const cod =
    r.cod !== null && typeof r.cod === "object" && !Array.isArray(r.cod)
      ? (() => {
          const c = r.cod as Record<string, unknown>;
          return typeof c.amount === "number" && Number.isFinite(c.amount)
            ? Object.freeze({
                amount: c.amount,
                currency: typeof c.currency === "string" && c.currency.length > 0 ? c.currency : "SAR",
              })
            : undefined;
        })()
      : undefined;
  const paymentCollection =
    r.paymentCollection !== null && typeof r.paymentCollection === "object" && !Array.isArray(r.paymentCollection)
      ? (() => {
          const p = r.paymentCollection as Record<string, unknown>;
          const expectedAmount =
            typeof p.expectedAmount === "number" && Number.isFinite(p.expectedAmount)
              ? p.expectedAmount
              : null;
          if (expectedAmount === null) return undefined;
          const collectedAmount =
            typeof p.collectedAmount === "number" && Number.isFinite(p.collectedAmount)
              ? p.collectedAmount
              : null;
          const tenderedAmount =
            typeof p.tenderedAmount === "number" && Number.isFinite(p.tenderedAmount)
              ? p.tenderedAmount
              : null;
          const changeDueAmount =
            typeof p.changeDueAmount === "number" && Number.isFinite(p.changeDueAmount)
              ? p.changeDueAmount
              : null;
          return Object.freeze({
            outcome: typeof p.outcome === "string" && p.outcome.length > 0 ? p.outcome : null,
            method: typeof p.method === "string" && p.method.length > 0 ? p.method : null,
            expectedAmount,
            collectedAmount,
            tenderedAmount,
            changeDueAmount,
            currency: typeof p.currency === "string" && p.currency.length > 0 ? p.currency : "SAR",
            source: typeof p.source === "string" && p.source.length > 0
              ? p.source
              : "resolve_fieldops_stop_detail_v1",
            shipmentActionId:
              typeof p.shipmentActionId === "string" && p.shipmentActionId.length > 0
                ? p.shipmentActionId
                : null,
          } satisfies MobileV2StopPaymentCollection);
        })()
      : undefined;
  return Object.freeze({
    id: str("id", fallback.id),
    seq: typeof r.seq === "number" && Number.isFinite(r.seq) ? r.seq : fallback.seq,
    customerInitials: str("customerInitials", fallback.customerInitials),
    customerName: str("customerName", fallback.customerName),
    customerPhone:
      typeof r.customerPhone === "string" && r.customerPhone.trim().length > 0
        ? r.customerPhone.trim()
        : undefined,
    trackingCode: str("trackingCode", fallback.trackingCode),
    stopType,
    hazards: arr<MobileV2StopDetail["hazards"][number]>("hazards"),
    etaMinutes: num("etaMinutes", fallback.etaMinutes),
    distanceKm: num("distanceKm", fallback.distanceKm),
    window: str("window", fallback.window),
    addressLines: arr<string>("addressLines"),
    addressNote:
      typeof r.addressNote === "string" && r.addressNote.length > 0
        ? r.addressNote
        : fallback.addressNote,
    parcels: arr<MobileV2StopDetail["parcels"][number]>("parcels"),
    parcelsTotalLabel:
      typeof r.parcelsTotalLabel === "string" && r.parcelsTotalLabel.length > 0
        ? r.parcelsTotalLabel
        : undefined,
    proofChecklist: arr<MobileV2StopDetail["proofChecklist"][number]>("proofChecklist"),
    timeline: arr<MobileV2StopDetail["timeline"][number]>("timeline"),
    cod,
    paymentCollection,
  }) as MobileV2StopDetail;
}

export interface ResolveMobileV2StopDetailRenderOptions {
  readonly data: MobileV2StopDetail | undefined;
  readonly fallback: MobileV2StopDetail;
  readonly stopId: string | null;
  readonly allowPreviewFallback: boolean;
}

export function resolveMobileV2StopDetailForRender(
  options: ResolveMobileV2StopDetailRenderOptions,
): MobileV2StopDetail {
  const { data, fallback, stopId, allowPreviewFallback } = options;
  if (data !== undefined) return data;
  if (allowPreviewFallback || !isMobileV2PersistedUuid(stopId)) return fallback;

  return Object.freeze({
    ...fallback,
    id: stopId,
    customerPhone: undefined,
    hazards: Object.freeze([]),
    parcels: Object.freeze([]),
    proofChecklist: Object.freeze([]),
    timeline: Object.freeze([]),
  }) as MobileV2StopDetail;
}

export function useFieldopsStopDetailRpc(
  options: UseFieldopsStopDetailOptions,
): UseQueryResult<MobileV2StopDetail, Error> {
  const ctx = useMobileV2Rpc();
  const { stopId, fallback } = options;
  return useQuery<MobileV2StopDetail, Error>({
    ...(options.query ?? {}),
    queryKey: ["mobile-v2", "stop-detail", stopId, ctx.activeRole],
    queryFn: async () => {
      // Preview mode OR a non-persisted fixture id -> fallback. Sending a
      // fixture id to the RPC would fail Postgres UUID parsing (22P02).
      if (isPreviewMode(ctx.supabase) || !isMobileV2PersistedUuid(stopId)) {
        return fallback;
      }
      const raw = await callRpc({
        supabase: ctx.supabase,
        name: "resolve_fieldops_stop_detail_v1",
        params: {
          p_stop_id: stopId,
          p_active_role: ctx.activeRole,
          p_context: ctx.policyContext ?? {},
        },
      });
      return parseMobileV2StopDetailEnvelope(raw, fallback);
    },
  });
}

// ---------------------------------------------------------------------------
// Navigation — ui_navigation_v1('mobile') over ui_navigation.apps.mobile (SSOT)
//
// Engineering audit I1 (IMPORTANT): the drawer / bottom tabs / role list
// were driven off the `SAMPLE_NAV` fixture. AGENTS.md mandates
// `ui_navigation.apps.mobile` as the SSOT. This hook reads that SSOT via
// `ui_navigation_v1('mobile')`, the existing backend-gated reader that marks
// denied items with `disabled_reason`. The fixture is engaged only as the
// preview/offline fallback.
// ---------------------------------------------------------------------------

export interface UseFieldopsNavigationOptions {
  /** Fallback navigation sections used in preview mode or on empty/failed resolve. */
  readonly fallback: ReadonlyArray<MobileV2NavigationSection>;
  /** Pass-through useQuery overrides. */
  readonly query?: Omit<
    UseQueryOptions<ReadonlyArray<MobileV2NavigationSection>, Error>,
    "queryKey" | "queryFn"
  >;
}

export function useFieldopsNavigationRpc(
  options: UseFieldopsNavigationOptions,
): UseQueryResult<ReadonlyArray<MobileV2NavigationSection>, Error> {
  const ctx = useMobileV2Rpc();
  const { fallback } = options;
  return useQuery<ReadonlyArray<MobileV2NavigationSection>, Error>({
    ...(options.query ?? {}),
    queryKey: ["mobile-v2", "navigation", ctx.activeRole, ctx.policyContext ?? null],
    queryFn: async () => {
      if (isPreviewMode(ctx.supabase)) return fallback;
      const raw = await callRpc({
        supabase: ctx.supabase,
        schema: "api",
        name: "ui_navigation_v1",
        params: { p_app: "mobile" },
      });
      const sections = parseMobileV2NavigationPayload(raw);
      // The caller owns fallback policy: preview supplies SAMPLE_NAV, while
      // production supplies [] so malformed live navigation fails closed.
      return sections.length > 0 ? sections : fallback;
    },
  });
}

// ---------------------------------------------------------------------------
// Incident type registry — mobile_incident_policy.types[]
//
// Engineering audit B1 / I2: the incident sheet's type registry was a
// PREVIEW/DEV fixture only. This hook resolves the `mobile_incident_policy`
// settings category through the standard ladder so the production shell
// drives the incident sheet from DB policy; the fixture is the
// preview/offline fallback.
// ---------------------------------------------------------------------------

export interface UseFieldopsIncidentTypesOptions {
  /** Fallback incident-type registry used in preview mode or on empty/failed resolve. */
  readonly fallback: ReadonlyArray<MobileV2IncidentType>;
  /** Pass-through useQuery overrides. */
  readonly query?: Omit<
    UseQueryOptions<ReadonlyArray<MobileV2IncidentType>, Error>,
    "queryKey" | "queryFn"
  >;
}

export function useFieldopsIncidentTypesRpc(
  options: UseFieldopsIncidentTypesOptions,
): UseQueryResult<ReadonlyArray<MobileV2IncidentType>, Error> {
  const ctx = useMobileV2Rpc();
  const { fallback } = options;
  return useQuery<ReadonlyArray<MobileV2IncidentType>, Error>({
    ...(options.query ?? {}),
    queryKey: ["mobile-v2", "incident-types", ctx.activeRole, ctx.policyContext ?? null],
    queryFn: async () => {
      if (isPreviewMode(ctx.supabase)) return fallback;
      const raw = await callRpc({
        supabase: ctx.supabase,
        schema: "api",
        name: "resolve_settings_row_from_policy_context_v1",
        params: {
          p_category: "mobile_incident_policy",
          p_context: ctx.policyContext ?? {},
        },
      });
      const row = Array.isArray(raw) ? raw[0] : raw;
      if (row === null || row === undefined || typeof row !== "object") return fallback;
      const value = (row as Record<string, unknown>).value;
      if (value === undefined || value === null) return fallback;
      const types = parseMobileV2IncidentTypeList(value);
      return types.length > 0 ? types : fallback;
    },
  });
}

// ---------------------------------------------------------------------------
// Onboarding/readiness readback - KYC, vehicle, cleaning, and pre-shift.
// Reconciles existing Mobile V2 write RPCs from backend state instead of
// trusting the write response alone.
// ---------------------------------------------------------------------------

const EMPTY_ONBOARDING_POLICY: MobileV2OnboardingPolicy = Object.freeze({
  photoCadenceHours: 24,
  cleaningCadenceHours: 24,
  healthAttestation: true,
  requiredDocuments: Object.freeze([]),
  vehiclePhotoAngles: Object.freeze([]),
  cleaningItems: Object.freeze([]),
});

const EMPTY_ONBOARDING_REQUIREMENTS: MobileV2OnboardingRequirements = Object.freeze({
  docsUploadedCount: 0,
  requiredDocumentsCount: 0,
  requiredDocumentsSatisfiedCount: 0,
  docsComplete: false,
  vehicleSubmitted: false,
  vehiclePhotosSubmitted: false,
  requiredVehiclePhotoCount: 0,
  cleaningAttested: false,
  preShiftCleared: false,
  cleaningRequired: true,
});

const EMPTY_ONBOARDING_READBACK: MobileV2OnboardingReadbackEnvelope = Object.freeze({
  activeRole: "driver",
  organizationId: null,
  userId: null,
  shiftId: null,
  documents: Object.freeze([]),
  latestDoc: null,
  latestVehicle: null,
  latestVehiclePhotos: null,
  latestCleaning: null,
  latestPreShift: null,
  policy: EMPTY_ONBOARDING_POLICY,
  requirements: EMPTY_ONBOARDING_REQUIREMENTS,
});

function asStringArray(value: unknown): ReadonlyArray<string> {
  if (!Array.isArray(value)) return Object.freeze([]);
  const out = value
    .map((item) => asNonEmpty(item))
    .filter((item): item is string => item !== null);
  return Object.freeze(out);
}

function parseOnboardingDoc(row: unknown): MobileV2OnboardingDocReadback | null {
  const r = asRecord(row);
  if (r === null) return null;
  const docId = asNonEmpty(r.doc_id ?? r.id);
  const docKey = asNonEmpty(r.doc_key);
  const decisionLogId = asNonEmpty(r.decision_log_id);
  const status = asNonEmpty(r.status);
  if (docId === null || docKey === null || decisionLogId === null || status === null) return null;
  return Object.freeze({
    docId,
    docKey,
    status,
    state: asNonEmpty(r.state) ?? status,
    decisionLogId,
    storagePath: asNonEmpty(r.storage_path),
    correlationId: asNonEmpty(r.correlation_id),
    submittedAt: asNonEmpty(r.submitted_at),
  });
}

function parseOnboardingVehicle(row: unknown): MobileV2OnboardingVehicleReadback | null {
  const r = asRecord(row);
  if (r === null) return null;
  const vehicleId = asNonEmpty(r.vehicle_id ?? r.id);
  const decisionLogId = asNonEmpty(r.decision_log_id);
  const plate = asNonEmpty(r.plate);
  const vin = asNonEmpty(r.vin);
  const year = asNonEmpty(r.year);
  const model = asNonEmpty(r.model);
  const status = asNonEmpty(r.status);
  if (
    vehicleId === null ||
    decisionLogId === null ||
    plate === null ||
    vin === null ||
    year === null ||
    model === null ||
    status === null
  ) {
    return null;
  }
  return Object.freeze({
    vehicleId,
    plate,
    vin,
    year,
    model,
    status,
    state: asNonEmpty(r.state) ?? status,
    decisionLogId,
    istimaraPath: asNonEmpty(r.istimara_path),
    correlationId: asNonEmpty(r.correlation_id),
    submittedAt: asNonEmpty(r.submitted_at),
  });
}

function parseOnboardingVehiclePhotos(
  row: unknown,
): MobileV2OnboardingVehiclePhotosReadback | null {
  const r = asRecord(row);
  if (r === null) return null;
  const photoSetId = asNonEmpty(r.photo_set_id ?? r.id);
  const decisionLogId = asNonEmpty(r.decision_log_id);
  const state = asNonEmpty(r.state);
  if (photoSetId === null || decisionLogId === null || state === null) return null;
  const rawPaths = asRecord(r.angle_paths);
  const anglePaths: Record<string, string> = {};
  if (rawPaths !== null) {
    for (const [angle, value] of Object.entries(rawPaths)) {
      const path = asNonEmpty(value);
      if (path !== null) anglePaths[angle] = path;
    }
  }
  return Object.freeze({
    photoSetId,
    anglePaths: Object.freeze(anglePaths),
    capturedAngleIds: asStringArray(r.captured_angle_ids),
    photoCount: Math.max(0, Math.round(asFiniteNumber(r.photo_count) ?? Object.keys(anglePaths).length)),
    state,
    decisionLogId,
    correlationId: asNonEmpty(r.correlation_id),
    submittedAt: asNonEmpty(r.submitted_at),
  });
}

function parseOnboardingCleaning(row: unknown): MobileV2OnboardingCleaningReadback | null {
  const r = asRecord(row);
  if (r === null) return null;
  const checkId = asNonEmpty(r.check_id ?? r.id);
  const decisionLogId = asNonEmpty(r.decision_log_id);
  const state = asNonEmpty(r.state);
  if (checkId === null || decisionLogId === null || state === null) return null;
  const checkedIds = asStringArray(r.checked_ids);
  return Object.freeze({
    checkId,
    checkedIds,
    itemCount: Math.max(0, Math.round(asFiniteNumber(r.item_count) ?? checkedIds.length)),
    photoPath: asNonEmpty(r.photo_path),
    state,
    decisionLogId,
    correlationId: asNonEmpty(r.correlation_id),
    submittedAt: asNonEmpty(r.submitted_at),
  });
}

function parseOnboardingPreShift(row: unknown): MobileV2OnboardingPreShiftReadback | null {
  const r = asRecord(row);
  if (r === null) return null;
  const passId = asNonEmpty(r.pass_id ?? r.id);
  const shiftId = asNonEmpty(r.shift_id);
  const decisionLogId = asNonEmpty(r.decision_log_id);
  const state = asNonEmpty(r.state);
  if (passId === null || shiftId === null || decisionLogId === null || state === null) return null;
  return Object.freeze({
    passId,
    shiftId,
    healthOk: r.health_ok === true,
    state,
    decisionLogId,
    correlationId: asNonEmpty(r.correlation_id),
    submittedAt: asNonEmpty(r.submitted_at),
  });
}

function parseOnboardingPolicy(raw: unknown): MobileV2OnboardingPolicy {
  const p = asRecord(raw) ?? {};
  const cleaningItems = Array.isArray(p.cleaning_items)
    ? p.cleaning_items
        .map((item) => {
          const row = asRecord(item);
          if (row === null) return null;
          const id = asNonEmpty(row.id);
          const label = asNonEmpty(row.label);
          if (id === null || label === null) return null;
          return Object.freeze({
            id,
            label,
            sub: asNonEmpty(row.sub) ?? "",
          });
        })
        .filter((item): item is { readonly id: string; readonly label: string; readonly sub: string } => item !== null)
    : [];
  return Object.freeze({
    photoCadenceHours: Math.max(1, Math.round(asFiniteNumber(p.photo_cadence_hours) ?? 24)),
    cleaningCadenceHours: Math.max(1, Math.round(asFiniteNumber(p.cleaning_cadence_hours) ?? 24)),
    healthAttestation: p.health_attestation !== false,
    requiredDocuments: asStringArray(p.required_documents),
    vehiclePhotoAngles: asStringArray(p.vehicle_photo_angles),
    cleaningItems: Object.freeze(cleaningItems),
  });
}

export function mapFieldopsOnboardingReadbackEnvelope(
  raw: unknown,
): MobileV2OnboardingReadbackEnvelope {
  const r = asRecord(raw);
  if (r === null) return EMPTY_ONBOARDING_READBACK;
  const docs = Array.isArray(r.documents)
    ? Object.freeze(r.documents.map(parseOnboardingDoc).filter((d): d is MobileV2OnboardingDocReadback => d !== null))
    : Object.freeze([]);
  const requirements = asRecord(r.requirements);
  return Object.freeze({
    activeRole: asNonEmpty(r.active_role) ?? EMPTY_ONBOARDING_READBACK.activeRole,
    organizationId: asNonEmpty(r.organization_id),
    userId: asNonEmpty(r.user_id),
    shiftId: asNonEmpty(r.shift_id),
    documents: docs,
    latestDoc: parseOnboardingDoc(r.latest_doc),
    latestVehicle: parseOnboardingVehicle(r.latest_vehicle),
    latestVehiclePhotos: parseOnboardingVehiclePhotos(r.latest_vehicle_photos),
    latestCleaning: parseOnboardingCleaning(r.latest_cleaning),
    latestPreShift: parseOnboardingPreShift(r.latest_pre_shift),
    policy: parseOnboardingPolicy(r.policy),
    requirements: Object.freeze({
      docsUploadedCount: Math.max(0, Math.round(asFiniteNumber(requirements?.docs_uploaded_count) ?? docs.length)),
      requiredDocumentsCount: Math.max(0, Math.round(asFiniteNumber(requirements?.required_documents_count) ?? 0)),
      requiredDocumentsSatisfiedCount: Math.max(
        0,
        Math.round(asFiniteNumber(requirements?.required_documents_satisfied_count) ?? 0),
      ),
      docsComplete: requirements?.docs_complete === true,
      vehicleSubmitted: requirements?.vehicle_submitted === true,
      vehiclePhotosSubmitted: requirements?.vehicle_photos_submitted === true,
      requiredVehiclePhotoCount: Math.max(
        0,
        Math.round(asFiniteNumber(requirements?.required_vehicle_photo_count) ?? 0),
      ),
      cleaningAttested: requirements?.cleaning_attested === true,
      preShiftCleared: requirements?.pre_shift_cleared === true,
      cleaningRequired: requirements?.cleaning_required !== false,
    }),
  });
}

export function mobileV2CleaningMatchesWrite(
  latestCleaning: MobileV2OnboardingCleaningReadback | null | undefined,
  write: MobileV2WriteEnvelope,
  checkedIds: ReadonlyArray<string>,
): boolean {
  if (latestCleaning === null || latestCleaning === undefined) return false;
  return (
    latestCleaning.decisionLogId === write.decision_log_id &&
    latestCleaning.itemCount === checkedIds.length &&
    latestCleaning.checkedIds.every((id) => checkedIds.includes(id))
  );
}

export function mobileV2KycDocMatchesWrite(
  documents: ReadonlyArray<MobileV2OnboardingDocReadback>,
  write: MobileV2WriteEnvelope,
  docKey: string,
  storagePath: string,
): boolean {
  const normalizedStoragePath = storagePath.trim();
  if (normalizedStoragePath.length === 0) return false;
  const acceptedKeys =
    docKey === "idDoc"
      ? ["idDoc", "iqamaDoc", "national_id"]
      : docKey === "licenseDoc"
        ? ["licenseDoc", "driving_licence"]
        : [docKey];
  return documents.some((doc) =>
    acceptedKeys.includes(doc.docKey) &&
    doc.decisionLogId === write.decision_log_id &&
    doc.storagePath === normalizedStoragePath &&
    ["uploaded", "submitted", "approved", "verified", "cleared"].includes(doc.state),
  );
}

export function mobileV2KycVehicleMatchesWrite(
  latestVehicle: MobileV2OnboardingVehicleReadback | null | undefined,
  write: MobileV2WriteEnvelope,
  expected: {
    readonly plate: string;
    readonly vin: string;
    readonly year: string;
    readonly model: string;
    readonly istimaraPath: string | null | undefined;
  },
): boolean {
  if (latestVehicle === null || latestVehicle === undefined) return false;
  const expectedIstimaraPath = expected.istimaraPath?.trim() ?? "";
  if (expectedIstimaraPath.length === 0) return false;
  const writeState = typeof write.state === "string" ? write.state : null;
  return (
    latestVehicle.decisionLogId === write.decision_log_id &&
    latestVehicle.plate === expected.plate &&
    latestVehicle.vin === expected.vin &&
    latestVehicle.year === expected.year &&
    latestVehicle.model === expected.model &&
    latestVehicle.istimaraPath === expectedIstimaraPath &&
    ["submitted", "uploaded", "approved", "verified", "cleared"].includes(latestVehicle.state) &&
    (writeState === null || ["submitted", "uploaded", "approved", "verified", "cleared"].includes(writeState))
  );
}

export function mobileV2VehiclePhotosMatchWrite(
  latestPhotos: MobileV2OnboardingVehiclePhotosReadback | null | undefined,
  write: MobileV2WriteEnvelope,
  requiredAngles: ReadonlyArray<string>,
  expectedAnglePaths?: Readonly<Record<string, string>>,
): boolean {
  if (latestPhotos === null || latestPhotos === undefined) return false;
  const writeState = typeof write.state === "string" ? write.state : null;
  const required = requiredAngles.filter((angle) => angle.trim().length > 0);
  return (
    required.length > 0 &&
    latestPhotos.decisionLogId === write.decision_log_id &&
    ["submitted", "uploaded", "approved", "verified", "cleared"].includes(latestPhotos.state) &&
    (writeState === null || ["submitted", "uploaded", "approved", "verified", "cleared"].includes(writeState)) &&
    required.every((angle) => {
      const path = latestPhotos.anglePaths[angle];
      if (typeof path !== "string" || path.trim().length === 0) return false;
      const expectedPath = expectedAnglePaths?.[angle]?.trim();
      if (expectedAnglePaths !== undefined) {
        return expectedPath !== undefined && expectedPath.length > 0 && path.trim() === expectedPath;
      }
      return true;
    })
  );
}

export function mobileV2PreShiftMatchesWrite(
  latestPreShift: MobileV2OnboardingPreShiftReadback | null | undefined,
  write: MobileV2WriteEnvelope,
  shiftId: string,
  healthOk: boolean,
): boolean {
  if (latestPreShift === null || latestPreShift === undefined) return false;
  const writeState = typeof write.state === "string" ? write.state : null;
  return (
    healthOk === true &&
    latestPreShift.healthOk === true &&
    latestPreShift.state === "cleared" &&
    latestPreShift.decisionLogId === write.decision_log_id &&
    latestPreShift.shiftId === shiftId &&
    (writeState === null || writeState === "cleared")
  );
}

export function mobileV2PreShiftReadbackConfirmsHealthOk(
  latestPreShift: MobileV2OnboardingPreShiftReadback | null | undefined,
  shiftId: string | null | undefined,
): boolean {
  if (latestPreShift === null || latestPreShift === undefined) return false;
  if (typeof shiftId !== "string" || shiftId.trim().length === 0) return false;
  return (
    latestPreShift.shiftId === shiftId &&
    latestPreShift.healthOk === true &&
    latestPreShift.state === "cleared"
  );
}

export interface UseFieldopsOnboardingReadbackOptions {
  readonly enabled?: boolean;
  readonly shiftId?: string | null;
}

export function useFieldopsOnboardingReadbackRpc(
  options: UseFieldopsOnboardingReadbackOptions = {},
): UseQueryResult<MobileV2OnboardingReadbackEnvelope, Error> {
  const ctx = useMobileV2Rpc();
  const enabled = options.enabled ?? true;
  const shiftId = options.shiftId ?? null;
  return useQuery<MobileV2OnboardingReadbackEnvelope, Error>({
    queryKey: ["mobile-v2", "onboarding-readback", ctx.activeRole, shiftId, ctx.policyContext ?? null],
    queryFn: async () => {
      if (isPreviewMode(ctx.supabase)) return EMPTY_ONBOARDING_READBACK;
      const raw = await callRpc({
        supabase: ctx.supabase,
        schema: "api",
        name: "resolve_fieldops_onboarding_readback_v1",
        params: {
          p_active_role: ctx.activeRole,
          p_context: {
            ...(ctx.policyContext ?? {}),
            ...(shiftId ? { shift_id: shiftId } : {}),
          },
        },
      });
      return mapFieldopsOnboardingReadbackEnvelope(raw);
    },
    enabled,
  });
}

// ---------------------------------------------------------------------------
// Incident readback - latest incident filed by the active Mobile V2 caller.
// The sheet reconciles from this backend resolver after submit instead of
// treating the write response alone as visible proof.
// ---------------------------------------------------------------------------

export interface UseFieldopsLatestIncidentOptions {
  readonly enabled?: boolean;
}

export function parseMobileV2IncidentReadback(raw: unknown): MobileV2IncidentReadback | null {
  const envelope = asRecord(raw);
  const row = asRecord(envelope?.latest_incident ?? raw);
  if (row === null) return null;
  const incidentId = asNonEmpty(row.incident_id ?? row.id);
  const decisionLogId = asNonEmpty(row.decision_log_id);
  const typeId = asNonEmpty(row.type_id);
  const severity = asNonEmpty(row.severity);
  if (incidentId === null || decisionLogId === null || typeId === null || severity === null) {
    return null;
  }
  return Object.freeze({
    incidentId,
    decisionLogId,
    typeId,
    severity,
    statement: asNonEmpty(row.statement),
    stopId: asNonEmpty(row.stop_id),
    photoPath: asNonEmpty(row.photo_storage_path ?? row.photo_path),
    submittedAt: asNonEmpty(row.submitted_at ?? row.created_at),
  });
}

export function mapFieldopsLatestIncidentEnvelope(raw: unknown): MobileV2IncidentReadback | null {
  return parseMobileV2IncidentReadback(raw);
}

export function mobileV2IncidentMatchesWrite(
  latestIncident: MobileV2IncidentReadback | null | undefined,
  write: MobileV2WriteEnvelope,
  typeId: string,
  severity: string,
  statement: string,
): boolean {
  if (latestIncident === null || latestIncident === undefined) return false;
  const incidentId = typeof write.incident_id === "string" ? write.incident_id : null;
  const expectedStatement = statement.trim();
  const latestStatement = latestIncident.statement?.trim() ?? "";
  return (
    latestIncident.decisionLogId === write.decision_log_id &&
    (incidentId === null || latestIncident.incidentId === incidentId) &&
    latestIncident.typeId === typeId &&
    latestIncident.severity === severity &&
    latestStatement === expectedStatement
  );
}

export function useFieldopsLatestIncidentRpc(
  options: UseFieldopsLatestIncidentOptions = {},
): UseQueryResult<MobileV2IncidentReadback | null, Error> {
  const ctx = useMobileV2Rpc();
  const enabled = options.enabled ?? true;
  return useQuery<MobileV2IncidentReadback | null, Error>({
    queryKey: ["mobile-v2", "latest-incident", ctx.activeRole, ctx.policyContext ?? null],
    queryFn: async () => {
      if (isPreviewMode(ctx.supabase)) return null;
      const raw = await callRpc({
        supabase: ctx.supabase,
        schema: "api",
        name: "resolve_fieldops_latest_incident_v1",
        params: { p_active_role: ctx.activeRole, p_context: ctx.policyContext ?? {} },
      });
      return mapFieldopsLatestIncidentEnvelope(raw);
    },
    enabled,
  });
}

// ---------------------------------------------------------------------------
// Damage-hold readback - latest damaged parcel hold submitted by the active
// Mobile V2 caller. The damage-hold sheet uses this after submit so visible
// state reconciles from shipment_holds, not the write envelope alone.
// ---------------------------------------------------------------------------

export interface MobileV2DamageHoldReadback {
  readonly holdId: string;
  readonly decisionLogId: string;
  readonly parcelId: string;
  readonly severityId: string;
  readonly note: string | null;
  readonly photoPath: string | null;
  readonly state: string;
  readonly submittedAt: string | null;
}

export interface UseFieldopsLatestDamageHoldOptions {
  readonly enabled?: boolean;
}

export function parseMobileV2DamageHoldReadback(raw: unknown): MobileV2DamageHoldReadback | null {
  const envelope = asRecord(raw);
  const row = asRecord(envelope?.latest_damage_hold ?? raw);
  if (row === null) return null;
  const holdId = asNonEmpty(row.hold_id ?? row.id);
  const decisionLogId = asNonEmpty(row.decision_log_id);
  const parcelId = asNonEmpty(row.parcel_id);
  const severityId = asNonEmpty(row.severity_id);
  const state = asNonEmpty(row.state ?? row.status);
  if (
    holdId === null ||
    decisionLogId === null ||
    parcelId === null ||
    severityId === null ||
    state === null
  ) {
    return null;
  }
  return Object.freeze({
    holdId,
    decisionLogId,
    parcelId,
    severityId,
    note: asNonEmpty(row.note),
    photoPath: asNonEmpty(row.photo_storage_path ?? row.photo_path),
    state,
    submittedAt: asNonEmpty(row.submitted_at ?? row.created_at),
  });
}

export function mapFieldopsLatestDamageHoldEnvelope(raw: unknown): MobileV2DamageHoldReadback | null {
  return parseMobileV2DamageHoldReadback(raw);
}

export function mobileV2DamageHoldMatchesWrite(
  latestHold: MobileV2DamageHoldReadback | null | undefined,
  write: MobileV2WriteEnvelope,
  parcelId: string,
  severityId: string,
  note: string,
  photoPath: string,
): boolean {
  if (latestHold === null || latestHold === undefined) return false;
  const holdId = typeof write.hold_id === "string" ? write.hold_id : null;
  return (
    latestHold.decisionLogId === write.decision_log_id &&
    (holdId === null || latestHold.holdId === holdId) &&
    latestHold.parcelId === parcelId &&
    latestHold.severityId === severityId &&
    (latestHold.note?.trim() ?? "") === note.trim() &&
    latestHold.photoPath === photoPath &&
    latestHold.state === "open"
  );
}

export function useFieldopsLatestDamageHoldRpc(
  options: UseFieldopsLatestDamageHoldOptions = {},
): UseQueryResult<MobileV2DamageHoldReadback | null, Error> {
  const ctx = useMobileV2Rpc();
  const enabled = options.enabled ?? true;
  return useQuery<MobileV2DamageHoldReadback | null, Error>({
    queryKey: ["mobile-v2", "latest-damage-hold", ctx.activeRole, ctx.policyContext ?? null],
    queryFn: async () => {
      if (isPreviewMode(ctx.supabase)) return null;
      const raw = await callRpc({
        supabase: ctx.supabase,
        schema: "api",
        name: "resolve_fieldops_latest_damage_hold_v1",
        params: { p_active_role: ctx.activeRole, p_context: ctx.policyContext ?? {} },
      });
      return mapFieldopsLatestDamageHoldEnvelope(raw);
    },
    enabled,
  });
}

// ===========================================================================
// Write-side mutations — companion bindings against the
// fieldops_mobile_v2_write_rpcs_pack_v1 migration shipped 2026-05-12.
//
// Each hook:
//   - generates a fresh p_idempotency_key (crypto.randomUUID()) per call so
//     replay-safe writes are the default, never an opt-in
//   - returns a synthetic { ok: true, decision_log_id: "preview-<uuid>" }
//     envelope in preview mode (supabase === null) so the preview UI keeps
//     flowing even without a connected backend
//   - surfaces RPC errors via the useMutation result's `error`/`onError`
//     contract — callers must handle failure explicitly; the hook never
//     swallows backend errors
//
// RPC contracts mirror the migration verbatim. Do NOT rename params here —
// PostgREST resolves by exact param spelling.
// ---------------------------------------------------------------------------

/** Synthetic success envelope returned by every write mutation. Decision
 *  ids in preview mode are prefixed `preview-` so callers can recognize
 *  non-canonical ids in telemetry / outbox UIs. In production they are the
 *  real `decision_log.id` returned by the SECURITY DEFINER function. */
export interface MobileV2WriteEnvelope {
  readonly ok: true;
  readonly decision_log_id: string;
  readonly state?: string;
  readonly [extra: string]: unknown;
}

/** Exported for unit testing. Use crypto.randomUUID when available, fallback
 *  to a v4 byte-shuffle. */
export function newIdempotencyKey(): string {
  // crypto.randomUUID() ships in modern RN (Hermes >= 0.74) and all
  // evergreen web. The preview screen runs on Expo Web where it is
  // available by default; production RN paths share the polyfill via
  // `react-native-get-random-values` already loaded at app boot.
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  // Defensive fallback so the hook never throws if a host lacks
  // crypto.randomUUID — produces a v4-shaped id that still satisfies the
  // RPC's UUID parameter type when used in non-preview environments where
  // crypto is unexpectedly missing (e.g. older Jest jsdom).
  let bytes: Uint8Array;
  if (typeof crypto !== "undefined" && typeof crypto.getRandomValues === "function") {
    bytes = crypto.getRandomValues(new Uint8Array(16));
  } else {
    bytes = new Uint8Array(16);
    for (let i = 0; i < 16; i += 1) bytes[i] = Math.floor(Math.random() * 256);
  }
  // RFC 4122 v4 byte layout
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * True when `value` is a canonical RFC-4122 UUID — i.e. a real persisted
 * primary key returned by a backend RPC, not a fixture / showcase identifier
 * (`STP-003`, `TRIP-9913`, `preview-photo-…`). FieldOps V2 write RPCs that
 * take a UUID parameter (`p_stop_id`, `p_photo_id`, …) reject a non-UUID
 * argument with Postgres SQLSTATE `22P02`; callers use this guard to keep
 * fixture-backed showcase rows out of live RPC calls.
 */
export function isMobileV2PersistedUuid(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)
  );
}

/** Exported for unit testing. Build a synthetic write envelope used by every
 *  mutation hook when supabase is null (preview / offline). */
export function previewEnvelope(state: string, extra?: Record<string, unknown>): MobileV2WriteEnvelope {
  // Spread `extra` first so the typed contract fields are not clobbered
  // by overlapping keys the caller passes in.
  return Object.freeze({
    ...(extra ?? {}),
    ok: true as const,
    decision_log_id: `preview-${newIdempotencyKey()}`,
    state,
  }) as MobileV2WriteEnvelope;
}

/** Exported for unit testing. Validates the server's write response shape
 *  and throws when decision_log_id is missing — never fabricates a success id. */
export function parseWriteEnvelope(raw: unknown, fallbackState: string): MobileV2WriteEnvelope {
  if (raw !== null && typeof raw === "object") {
    const r = raw as Record<string, unknown>;
    const decisionId = typeof r.decision_log_id === "string" ? r.decision_log_id : null;
    if (decisionId !== null) {
      // Spread server fields first, then pin the typed `ok`/`decision_log_id`
      // shape and the resolved `state` last so they are not clobbered by
      // an unexpectedly-shaped server response.
      return Object.freeze({
        ...r,
        ok: true as const,
        decision_log_id: decisionId,
        state: typeof r.state === "string" ? r.state : fallbackState,
      }) as MobileV2WriteEnvelope;
    }
  }
  // Server returned an unexpected shape — surface that explicitly rather
  // than fabricating a success id.
  throw new Error(`mobile_v2_rpc: unexpected write envelope ${JSON.stringify(raw)}`);
}

type WriteMutationOptions<TInput> = Omit<
  UseMutationOptions<MobileV2WriteEnvelope, Error, TInput>,
  "mutationFn"
>;

// ---------------------------------------------------------------------------
// 1) submit_fieldops_proof_v1
// ---------------------------------------------------------------------------

export interface SubmitFieldopsProofInput {
  readonly p_stop_id: string;
  /** delivered | failed | partial */
  readonly p_outcome: "delivered" | "failed" | "partial";
  readonly p_evidence: Record<string, unknown>;
}

export function useFieldopsSubmitProofMutation(
  options?: WriteMutationOptions<SubmitFieldopsProofInput>,
): UseMutationResult<MobileV2WriteEnvelope, Error, SubmitFieldopsProofInput> {
  const ctx = useMobileV2Rpc();
  return useMutation<MobileV2WriteEnvelope, Error, SubmitFieldopsProofInput>({
    ...(options ?? {}),
    mutationFn: async (input) => {
      const key = newIdempotencyKey();
      if (isPreviewMode(ctx.supabase)) {
        return previewEnvelope(
          input.p_outcome === "delivered" ? "done" : input.p_outcome,
          { stop_id: input.p_stop_id },
        );
      }
      const raw = await callRpcOrEnqueue(ctx, "submit_fieldops_proof_v1", {
        ...input,
        p_idempotency_key: key,
      });
      return parseWriteEnvelope(raw, input.p_outcome);
    },
  });
}

// ---------------------------------------------------------------------------
// 2) advance_fieldops_trip_stage_v1
// ---------------------------------------------------------------------------

export interface AdvanceFieldopsTripStageInput {
  readonly p_trip_id: string;
  /** Canonical 8-step stage vocabulary (see mobile-v2-trips-screen.tsx). */
  readonly p_next_stage:
    | "assigned"
    | "gate-in"
    | "loading"
    | "sealed"
    | "in-transit"
    | "arrived"
    | "gate-out"
    | "reconciled";
  readonly p_seal_no: string | null;
}

export function useFieldopsAdvanceTripStageMutation(
  options?: WriteMutationOptions<AdvanceFieldopsTripStageInput>,
): UseMutationResult<MobileV2WriteEnvelope, Error, AdvanceFieldopsTripStageInput> {
  const ctx = useMobileV2Rpc();
  return useMutation<MobileV2WriteEnvelope, Error, AdvanceFieldopsTripStageInput>({
    ...(options ?? {}),
    mutationFn: async (input) => {
      const key = newIdempotencyKey();
      if (isPreviewMode(ctx.supabase)) {
        return previewEnvelope(input.p_next_stage, { trip_id: input.p_trip_id });
      }
      const raw = await callRpcOrEnqueue(ctx, "advance_fieldops_trip_stage_v1", {
        ...input,
        p_idempotency_key: key,
      });
      return parseWriteEnvelope(raw, input.p_next_stage);
    },
  });
}

// ---------------------------------------------------------------------------
// 3) induct_fieldops_parcel_v1
// ---------------------------------------------------------------------------

export interface InductFieldopsParcelInput {
  readonly p_bay: string;
  readonly p_tracking_number: string;
}

export function useFieldopsInductParcelMutation(
  options?: WriteMutationOptions<InductFieldopsParcelInput>,
): UseMutationResult<MobileV2WriteEnvelope, Error, InductFieldopsParcelInput> {
  const ctx = useMobileV2Rpc();
  return useMutation<MobileV2WriteEnvelope, Error, InductFieldopsParcelInput>({
    ...(options ?? {}),
    mutationFn: async (input) => {
      const key = newIdempotencyKey();
      if (isPreviewMode(ctx.supabase)) {
        return previewEnvelope("inducted", {
          bay: input.p_bay,
          tracking_number: input.p_tracking_number,
        });
      }
      const raw = await callRpcOrEnqueue(ctx, "induct_fieldops_parcel_v1", {
        ...input,
        p_idempotency_key: key,
      });
      return parseWriteEnvelope(raw, "inducted");
    },
  });
}

// ---------------------------------------------------------------------------
// 4) sign_fieldops_cash_drop_v1
// ---------------------------------------------------------------------------

export interface SignFieldopsCashDropInput {
  readonly p_expected_sar: number;
  readonly p_actual_sar: number;
  readonly p_supervisor_name: string | null;
  readonly p_photo_id: string | null;
}

export function useFieldopsSignCashDropMutation(
  options?: WriteMutationOptions<SignFieldopsCashDropInput>,
): UseMutationResult<MobileV2WriteEnvelope, Error, SignFieldopsCashDropInput> {
  const ctx = useMobileV2Rpc();
  return useMutation<MobileV2WriteEnvelope, Error, SignFieldopsCashDropInput>({
    ...(options ?? {}),
    mutationFn: async (input) => {
      const key = newIdempotencyKey();
      const variance = input.p_actual_sar - input.p_expected_sar;
      if (isPreviewMode(ctx.supabase)) {
        return previewEnvelope(variance === 0 ? "balanced" : "variance", {
          variance_sar: variance,
        });
      }
      const raw = await callRpcOrEnqueue(ctx, "sign_fieldops_cash_drop_v1", {
        ...input,
        p_idempotency_key: key,
      });
      return parseWriteEnvelope(raw, variance === 0 ? "balanced" : "variance");
    },
  });
}

// ---------------------------------------------------------------------------
// 5) request_fieldops_wallet_withdraw_v1
// ---------------------------------------------------------------------------

export interface RequestFieldopsWalletWithdrawInput {
  readonly p_amount_sar: number;
}

export function useFieldopsRequestWalletWithdrawMutation(
  options?: WriteMutationOptions<RequestFieldopsWalletWithdrawInput>,
): UseMutationResult<MobileV2WriteEnvelope, Error, RequestFieldopsWalletWithdrawInput> {
  const ctx = useMobileV2Rpc();
  return useMutation<MobileV2WriteEnvelope, Error, RequestFieldopsWalletWithdrawInput>({
    ...(options ?? {}),
    mutationFn: async (input) => {
      const key = newIdempotencyKey();
      if (isPreviewMode(ctx.supabase)) {
        return previewEnvelope("requested", { amount_sar: input.p_amount_sar });
      }
      const raw = await callRpcOrEnqueue(ctx, "request_fieldops_wallet_withdraw_v1", {
        ...input,
        p_idempotency_key: key,
      });
      return parseWriteEnvelope(raw, "requested");
    },
  });
}

// ---------------------------------------------------------------------------
// 6) submit_fieldops_hold_decision_v1
// ---------------------------------------------------------------------------

export interface SubmitFieldopsHoldDecisionInput {
  readonly p_hold_id: string;
  /** Canonical hold action vocabulary mirroring the migration CHECK. */
  readonly p_action: "reinduct" | "escalate" | "discard";
  readonly p_note: string | null;
}

export function useFieldopsSubmitHoldDecisionMutation(
  options?: WriteMutationOptions<SubmitFieldopsHoldDecisionInput>,
): UseMutationResult<MobileV2WriteEnvelope, Error, SubmitFieldopsHoldDecisionInput> {
  const ctx = useMobileV2Rpc();
  return useMutation<MobileV2WriteEnvelope, Error, SubmitFieldopsHoldDecisionInput>({
    ...(options ?? {}),
    mutationFn: async (input) => {
      const key = newIdempotencyKey();
      if (isPreviewMode(ctx.supabase)) {
        return previewEnvelope(input.p_action, { hold_id: input.p_hold_id });
      }
      const raw = await callRpcOrEnqueue(ctx, "submit_fieldops_hold_decision_v1", {
        ...input,
        p_idempotency_key: key,
      });
      return parseWriteEnvelope(raw, input.p_action);
    },
  });
}

// ---------------------------------------------------------------------------
// 7) release_fieldops_hub_pickup_v1
// ---------------------------------------------------------------------------

export interface ReleaseFieldopsHubPickupInput {
  readonly p_queue_id: string;
  /** Six-digit OTP. The migration validates `^[0-9]{6}$` server-side; we
   *  pass through as-is so callers see the same validation error path. */
  readonly p_otp: string;
}

export function useFieldopsReleaseHubPickupMutation(
  options?: WriteMutationOptions<ReleaseFieldopsHubPickupInput>,
): UseMutationResult<MobileV2WriteEnvelope, Error, ReleaseFieldopsHubPickupInput> {
  const ctx = useMobileV2Rpc();
  return useMutation<MobileV2WriteEnvelope, Error, ReleaseFieldopsHubPickupInput>({
    ...(options ?? {}),
    mutationFn: async (input) => {
      const key = newIdempotencyKey();
      if (isPreviewMode(ctx.supabase)) {
        return previewEnvelope("released", { queue_id: input.p_queue_id });
      }
      const raw = await callRpcOrEnqueue(ctx, "release_fieldops_hub_pickup_v1", {
        ...input,
        p_idempotency_key: key,
      });
      return parseWriteEnvelope(raw, "released");
    },
  });
}

// ---------------------------------------------------------------------------
// 8) mark_fieldops_return_received_v1
// ---------------------------------------------------------------------------

export interface MarkFieldopsReturnReceivedInput {
  readonly p_stop_id: string;
}

export function useFieldopsMarkReturnReceivedMutation(
  options?: WriteMutationOptions<MarkFieldopsReturnReceivedInput>,
): UseMutationResult<MobileV2WriteEnvelope, Error, MarkFieldopsReturnReceivedInput> {
  const ctx = useMobileV2Rpc();
  return useMutation<MobileV2WriteEnvelope, Error, MarkFieldopsReturnReceivedInput>({
    ...(options ?? {}),
    mutationFn: async (input) => {
      const key = newIdempotencyKey();
      if (isPreviewMode(ctx.supabase)) {
        return previewEnvelope("rto", { stop_id: input.p_stop_id });
      }
      const raw = await callRpcOrEnqueue(ctx, "mark_fieldops_return_received_v1", {
        ...input,
        p_idempotency_key: key,
      });
      return parseWriteEnvelope(raw, "rto");
    },
  });
}

// ---------------------------------------------------------------------------
// 9) record_location_ping_v1 — route-map location readback.
// ---------------------------------------------------------------------------

export interface RecordFieldopsLocationPingInput {
  readonly p_ping: {
    readonly device_id: string | null;
    readonly route_run_id?: string | null;
    readonly route_stop_id?: string | null;
    readonly lat: number;
    readonly lng: number;
    readonly accuracy_m?: number | null;
    readonly speed_mps?: number | null;
    readonly heading_deg?: number | null;
    readonly captured_at: string;
    readonly metadata?: Record<string, unknown>;
  };
}

export interface MobileV2LocationPingReadback {
  readonly locationPingId: string;
  readonly created: boolean;
  readonly idempotencyKey: string;
  readonly deviceId: string | null;
  readonly routeRunId: string | null;
  readonly routeStopId: string | null;
  readonly latitude: number;
  readonly longitude: number;
  readonly accuracyM: number | null;
  readonly capturedAt: string;
}

type LocationPingMutationOptions = Omit<
  UseMutationOptions<MobileV2LocationPingReadback, Error, RecordFieldopsLocationPingInput>,
  "mutationFn"
>;

function readLocationPingRow(raw: unknown): Record<string, unknown> | null {
  if (Array.isArray(raw)) {
    const first = raw[0];
    return first !== null && typeof first === "object" && !Array.isArray(first)
      ? (first as Record<string, unknown>)
      : null;
  }
  return raw !== null && typeof raw === "object" && !Array.isArray(raw)
    ? (raw as Record<string, unknown>)
    : null;
}

function readNullableNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function parseMobileV2LocationPingReadback(
  raw: unknown,
  input: RecordFieldopsLocationPingInput["p_ping"],
  idempotencyKey: string,
): MobileV2LocationPingReadback {
  const row = readLocationPingRow(raw);
  const locationPingId =
    typeof row?.location_ping_id === "string" && row.location_ping_id.trim() !== ""
      ? row.location_ping_id
      : null;
  if (locationPingId === null) {
    throw new Error(`mobile_v2_rpc: unexpected location ping readback ${JSON.stringify(raw)}`);
  }
  return Object.freeze({
    locationPingId,
    created: row?.created === true,
    idempotencyKey,
    deviceId: input.device_id ?? null,
    routeRunId: input.route_run_id ?? null,
    routeStopId: input.route_stop_id ?? null,
    latitude: input.lat,
    longitude: input.lng,
    accuracyM: readNullableNumber(input.accuracy_m),
    capturedAt: input.captured_at,
  });
}

export function useFieldopsRecordLocationPingMutation(
  options?: LocationPingMutationOptions,
): UseMutationResult<MobileV2LocationPingReadback, Error, RecordFieldopsLocationPingInput> {
  const ctx = useMobileV2Rpc();
  return useMutation<MobileV2LocationPingReadback, Error, RecordFieldopsLocationPingInput>({
    ...(options ?? {}),
    mutationFn: async (input) => {
      const key = newIdempotencyKey();
      const ping = {
        ...input.p_ping,
        idempotency_key: key,
        metadata: {
          ...(input.p_ping.metadata ?? {}),
          app: "fieldops",
          source: "fieldops_mobile_v2_route_map",
        },
      };
      if (isPreviewMode(ctx.supabase)) {
        return parseMobileV2LocationPingReadback(
          [{ location_ping_id: `preview-${key}`, created: true }],
          ping,
          key,
        );
      }
      const raw = await callRpcOrEnqueue(ctx, "record_location_ping_v1", { p_ping: ping });
      return parseMobileV2LocationPingReadback(raw, ping, key);
    },
  });
}

// ---------------------------------------------------------------------------
// Pack-v2 write mutations (auth + KYC + ops sheets)
// Engineering audit P0: every sheet's onConfirm goes nowhere without these
// FE bindings. Each follows the same pattern as 1-8:
//   - generates p_idempotency_key per call
//   - preview-mode envelope keeps the audit gallery interactive
//   - throws on RPC error; callers handle via react-query.isError
// ---------------------------------------------------------------------------

// 9) submit_fieldops_auth_otp_v1 — submit 6-digit OTP. The RPC verifies the
// OTP server-side via the policy-driven `verify_fieldops_otp_v1` (migration
// 202605131200_fieldops_auth_otp_verifier_v1), which fail-closes by default
// and dispatches per `mobile_auth_policy` provider (test / edge_fn). A failed
// OTP raises a SECURITY exception so the FE surfaces the retry path instead
// of a fabricated success.
export interface SubmitFieldopsAuthOtpInput {
  readonly p_employee_id: string;
  readonly p_otp: string;
}

export function useFieldopsSubmitAuthOtpMutation(
  options?: WriteMutationOptions<SubmitFieldopsAuthOtpInput>,
): UseMutationResult<MobileV2WriteEnvelope, Error, SubmitFieldopsAuthOtpInput> {
  const ctx = useMobileV2Rpc();
  return useMutation<MobileV2WriteEnvelope, Error, SubmitFieldopsAuthOtpInput>({
    ...(options ?? {}),
    mutationFn: async (input) => {
      const key = newIdempotencyKey();
      if (isPreviewMode(ctx.supabase)) {
        return previewEnvelope("authenticated", { employee_id: input.p_employee_id });
      }
      const raw = await callRpcOrEnqueue(ctx, "submit_fieldops_auth_otp_v1", {
        ...input,
        p_idempotency_key: key,
      });
      return parseWriteEnvelope(raw, "authenticated");
    },
  });
}

// 10) submit_fieldops_role_set_v1 — pick active role after multi-role sign-up.
export interface SubmitFieldopsRoleSetInput {
  readonly p_role_id: string;
}

export function useFieldopsSubmitRoleSetMutation(
  options?: WriteMutationOptions<SubmitFieldopsRoleSetInput>,
): UseMutationResult<MobileV2WriteEnvelope, Error, SubmitFieldopsRoleSetInput> {
  const ctx = useMobileV2Rpc();
  return useMutation<MobileV2WriteEnvelope, Error, SubmitFieldopsRoleSetInput>({
    ...(options ?? {}),
    mutationFn: async (input) => {
      const key = newIdempotencyKey();
      if (isPreviewMode(ctx.supabase)) {
        return previewEnvelope("role-set", { role_id: input.p_role_id });
      }
      const raw = await callRpcOrEnqueue(ctx, "submit_fieldops_role_set_v1", {
        ...input,
        p_idempotency_key: key,
      });
      return parseWriteEnvelope(raw, "role-set");
    },
  });
}

// 11) submit_fieldops_kyc_doc_v1 — upload one ID/license/iqama doc.
export interface SubmitFieldopsKycDocInput {
  readonly p_doc_key: string;
  readonly p_storage_path: string;
}

export function useFieldopsSubmitKycDocMutation(
  options?: WriteMutationOptions<SubmitFieldopsKycDocInput>,
): UseMutationResult<MobileV2WriteEnvelope, Error, SubmitFieldopsKycDocInput> {
  const ctx = useMobileV2Rpc();
  return useMutation<MobileV2WriteEnvelope, Error, SubmitFieldopsKycDocInput>({
    ...(options ?? {}),
    mutationFn: async (input) => {
      const key = newIdempotencyKey();
      if (isPreviewMode(ctx.supabase)) {
        return previewEnvelope("kyc-doc-saved", { doc_key: input.p_doc_key });
      }
      const raw = await callRpcOrEnqueue(ctx, "submit_fieldops_kyc_doc_v1", {
        ...input,
        p_idempotency_key: key,
      });
      return parseWriteEnvelope(raw, "kyc-doc-saved");
    },
  });
}

// 12) submit_fieldops_kyc_vehicle_v1 — vehicle registration + istimara photo.
export interface SubmitFieldopsKycVehicleInput {
  readonly p_plate: string;
  readonly p_vin: string;
  readonly p_year: string;
  readonly p_model: string;
  readonly p_istimara_path: string;
}

export function useFieldopsSubmitKycVehicleMutation(
  options?: WriteMutationOptions<SubmitFieldopsKycVehicleInput>,
): UseMutationResult<MobileV2WriteEnvelope, Error, SubmitFieldopsKycVehicleInput> {
  const ctx = useMobileV2Rpc();
  return useMutation<MobileV2WriteEnvelope, Error, SubmitFieldopsKycVehicleInput>({
    ...(options ?? {}),
    mutationFn: async (input) => {
      const key = newIdempotencyKey();
      if (isPreviewMode(ctx.supabase)) {
        return previewEnvelope("kyc-vehicle-saved", { plate: input.p_plate });
      }
      const raw = await callRpcOrEnqueue(ctx, "submit_fieldops_kyc_vehicle_v1", {
        ...input,
        p_idempotency_key: key,
      });
      return parseWriteEnvelope(raw, "kyc-vehicle-saved");
    },
  });
}

// 13) record_fieldops_cleaning_check_v1 — daily cabin+cargo cleaning attestation.
// 12b) submit_fieldops_vehicle_photos_v1 - vehicle angle photo evidence.
export interface SubmitFieldopsVehiclePhotosInput {
  readonly p_angle_paths: Readonly<Record<string, string>>;
}

export function useFieldopsSubmitVehiclePhotosMutation(
  options?: WriteMutationOptions<SubmitFieldopsVehiclePhotosInput>,
): UseMutationResult<MobileV2WriteEnvelope, Error, SubmitFieldopsVehiclePhotosInput> {
  const ctx = useMobileV2Rpc();
  return useMutation<MobileV2WriteEnvelope, Error, SubmitFieldopsVehiclePhotosInput>({
    ...(options ?? {}),
    mutationFn: async (input) => {
      const key = newIdempotencyKey();
      if (isPreviewMode(ctx.supabase)) {
        return previewEnvelope("vehicle-photos-saved", {
          photo_count: Object.keys(input.p_angle_paths).length,
        });
      }
      const raw = await callRpcOrEnqueue(ctx, "submit_fieldops_vehicle_photos_v1", {
        ...input,
        p_idempotency_key: key,
      });
      return parseWriteEnvelope(raw, "vehicle-photos-saved");
    },
  });
}

// 13) record_fieldops_cleaning_check_v1 - daily cabin+cargo cleaning attestation.
export interface RecordFieldopsCleaningCheckInput {
  readonly p_checked_ids: ReadonlyArray<string>;
  readonly p_photo_path: string;
}

export function useFieldopsRecordCleaningCheckMutation(
  options?: WriteMutationOptions<RecordFieldopsCleaningCheckInput>,
): UseMutationResult<MobileV2WriteEnvelope, Error, RecordFieldopsCleaningCheckInput> {
  const ctx = useMobileV2Rpc();
  return useMutation<MobileV2WriteEnvelope, Error, RecordFieldopsCleaningCheckInput>({
    ...(options ?? {}),
    mutationFn: async (input) => {
      const key = newIdempotencyKey();
      if (isPreviewMode(ctx.supabase)) {
        return previewEnvelope("cleaning-recorded", { checks: input.p_checked_ids.length });
      }
      const raw = await callRpcOrEnqueue(ctx, "record_fieldops_cleaning_check_v1", {
        ...input,
        p_idempotency_key: key,
      });
      return parseWriteEnvelope(raw, "cleaning-recorded");
    },
  });
}

// 14) pass_fieldops_pre_shift_gate_v1 — confirm shift readiness gate.
export interface PassFieldopsPreShiftGateInput {
  readonly p_shift_id: string;
  readonly p_health_ok: boolean;
}

export function useFieldopsPassPreShiftGateMutation(
  options?: WriteMutationOptions<PassFieldopsPreShiftGateInput>,
): UseMutationResult<MobileV2WriteEnvelope, Error, PassFieldopsPreShiftGateInput> {
  const ctx = useMobileV2Rpc();
  return useMutation<MobileV2WriteEnvelope, Error, PassFieldopsPreShiftGateInput>({
    ...(options ?? {}),
    mutationFn: async (input) => {
      const key = newIdempotencyKey();
      if (isPreviewMode(ctx.supabase)) {
        return previewEnvelope(input.p_health_ok ? "cleared" : "blocked", {
          shift_id: input.p_shift_id,
        });
      }
      const raw = await callRpcOrEnqueue(ctx, "pass_fieldops_pre_shift_gate_v1", {
        ...input,
        p_idempotency_key: key,
      });
      return parseWriteEnvelope(raw, input.p_health_ok ? "cleared" : "blocked");
    },
  });
}

// 15) submit_fieldops_incident_v1 — driver incident report with optional photo.
export interface SubmitFieldopsIncidentInput {
  readonly p_type_id: string;
  readonly p_stop_id: string | null;
  readonly p_severity: string;
  readonly p_statement: string;
  readonly p_photo_path: string | null;
}

export function useFieldopsSubmitIncidentMutation(
  options?: WriteMutationOptions<SubmitFieldopsIncidentInput>,
): UseMutationResult<MobileV2WriteEnvelope, Error, SubmitFieldopsIncidentInput> {
  const ctx = useMobileV2Rpc();
  return useMutation<MobileV2WriteEnvelope, Error, SubmitFieldopsIncidentInput>({
    ...(options ?? {}),
    mutationFn: async (input) => {
      const key = newIdempotencyKey();
      if (isPreviewMode(ctx.supabase)) {
        return previewEnvelope("incident-filed", { type_id: input.p_type_id });
      }
      const raw = await callRpcOrEnqueue(ctx, "submit_fieldops_incident_v1", {
        ...input,
        p_idempotency_key: key,
      });
      return parseWriteEnvelope(raw, "incident-filed");
    },
  });
}

// 16) submit_fieldops_reassign_v1 — escalate a stop to dispatch for reassign.
export interface SubmitFieldopsReassignInput {
  readonly p_stop_id: string;
  readonly p_target_driver_id: string;
  readonly p_reason: string;
}

export function useFieldopsSubmitReassignMutation(
  options?: WriteMutationOptions<SubmitFieldopsReassignInput>,
): UseMutationResult<MobileV2WriteEnvelope, Error, SubmitFieldopsReassignInput> {
  const ctx = useMobileV2Rpc();
  return useMutation<MobileV2WriteEnvelope, Error, SubmitFieldopsReassignInput>({
    ...(options ?? {}),
    mutationFn: async (input) => {
      const key = newIdempotencyKey();
      if (isPreviewMode(ctx.supabase)) {
        return previewEnvelope("requested", { stop_id: input.p_stop_id });
      }
      const raw = await callRpcOrEnqueue(ctx, "submit_fieldops_reassign_v1", {
        ...input,
        p_idempotency_key: key,
      });
      return parseWriteEnvelope(raw, "requested");
    },
  });
}

// 17) submit_fieldops_reschedule_v1 — propose a new delivery window.
export interface SubmitFieldopsRescheduleInput {
  readonly p_stop_id: string;
  readonly p_window_start: string;
  readonly p_window_end: string;
  readonly p_note: string | null;
}

export function useFieldopsSubmitRescheduleMutation(
  options?: WriteMutationOptions<SubmitFieldopsRescheduleInput>,
): UseMutationResult<MobileV2WriteEnvelope, Error, SubmitFieldopsRescheduleInput> {
  const ctx = useMobileV2Rpc();
  return useMutation<MobileV2WriteEnvelope, Error, SubmitFieldopsRescheduleInput>({
    ...(options ?? {}),
    mutationFn: async (input) => {
      const key = newIdempotencyKey();
      if (isPreviewMode(ctx.supabase)) {
        return previewEnvelope("rescheduled", { stop_id: input.p_stop_id });
      }
      const raw = await callRpcOrEnqueue(ctx, "submit_fieldops_reschedule_v1", {
        ...input,
        p_idempotency_key: key,
      });
      return parseWriteEnvelope(raw, "rescheduled");
    },
  });
}

// 18) submit_fieldops_damage_hold_v1 — flag a damaged parcel + photo.
export interface SubmitFieldopsDamageHoldInput {
  readonly p_parcel_id: string;
  readonly p_severity_id: string;
  readonly p_note: string | null;
  readonly p_photo_path: string;
}

export function useFieldopsSubmitDamageHoldMutation(
  options?: WriteMutationOptions<SubmitFieldopsDamageHoldInput>,
): UseMutationResult<MobileV2WriteEnvelope, Error, SubmitFieldopsDamageHoldInput> {
  const ctx = useMobileV2Rpc();
  return useMutation<MobileV2WriteEnvelope, Error, SubmitFieldopsDamageHoldInput>({
    ...(options ?? {}),
    mutationFn: async (input) => {
      const key = newIdempotencyKey();
      if (isPreviewMode(ctx.supabase)) {
        return previewEnvelope("damage-held", { parcel_id: input.p_parcel_id });
      }
      const raw = await callRpcOrEnqueue(ctx, "submit_fieldops_damage_hold_v1", {
        ...input,
        p_idempotency_key: key,
      });
      return parseWriteEnvelope(raw, "damage-held");
    },
  });
}

// 19) submit_fieldops_eod_recon_v1 — end-of-day reconciliation.
export interface SubmitFieldopsEodReconInput {
  readonly p_parcels_count: number;
  readonly p_mismatch_count: number;
  readonly p_cash_declared: number;
  readonly p_cash_counted: number;
  readonly p_wallet_status: string;
  readonly p_route_run_id?: string | null;
}

export function useFieldopsSubmitEodReconMutation(
  options?: WriteMutationOptions<SubmitFieldopsEodReconInput>,
): UseMutationResult<MobileV2WriteEnvelope, Error, SubmitFieldopsEodReconInput> {
  const ctx = useMobileV2Rpc();
  return useMutation<MobileV2WriteEnvelope, Error, SubmitFieldopsEodReconInput>({
    ...(options ?? {}),
    mutationFn: async (input) => {
      const key = newIdempotencyKey();
      const variance = input.p_cash_counted - input.p_cash_declared;
      if (isPreviewMode(ctx.supabase)) {
        return previewEnvelope(variance === 0 ? "eod-balanced" : "eod-variance", {
          variance,
        });
      }
      const raw = await callRpcOrEnqueue(ctx, "submit_fieldops_eod_recon_v1", {
        ...input,
        p_route_run_id: input.p_route_run_id ?? null,
        p_idempotency_key: key,
      });
      return parseWriteEnvelope(raw, variance === 0 ? "eod-balanced" : "eod-variance");
    },
  });
}

// ---------------------------------------------------------------------------
// Policy resolver — replace FE-side MOBILE_V2_*_DEFAULT_POLICY consumers
// with this hook so live screens read DB-driven policy via the existing
// resolve_settings_row_from_policy_context_v1 RPC. Falls back to the
// supplied default in preview mode (supabase === null). Non-critical callers
// may also use fallback for missing rows; production-critical callers set
// `requireResolved` to fail closed instead of rendering shadow defaults.
//
// AGENTS.md "zero hardcoding": parsers are config-driven via DB rows;
// this hook is the bridge that makes the parsers actually run against
// live data instead of FE constants.
// ---------------------------------------------------------------------------

export interface UseFieldopsPolicyOptions<T> {
  /** Settings ladder category, e.g. "mobile_pod_policy", "mobile_loader_policy". */
  readonly category: string;
  /** Parse the raw `value` jsonb into the typed policy shape. */
  readonly parse: (value: unknown) => T;
  /** Default policy used in preview mode, and for non-strict live fallback. */
  readonly fallback: T;
  /** When true, live backend mode fails closed instead of rendering fallback policy. */
  readonly requireResolved?: boolean;
  /** Pass-through useQuery overrides. */
  readonly query?: Omit<UseQueryOptions<T, Error>, "queryKey" | "queryFn">;
}

export async function resolveFieldopsPolicyValue<T>(params: {
  readonly ctx: Pick<MobileV2RpcContext, "supabase" | "policyContext">;
  readonly category: string;
  readonly parse: (value: unknown) => T;
  readonly fallback: T;
  readonly requireResolved?: boolean;
}): Promise<T> {
  if (isPreviewMode(params.ctx.supabase)) return params.fallback;
  const raw = await callRpc({
    supabase: params.ctx.supabase,
    // `public.resolve_settings_row_from_policy_context_v1` is
    // service_role-locked; `api.*` is the SECURITY DEFINER browser-safe
    // wrapper granted to `authenticated`.
    schema: "api",
    name: "resolve_settings_row_from_policy_context_v1",
    params: {
      p_category: params.category,
      p_context: params.ctx.policyContext ?? {},
    },
  });
  // The resolver RETURNS TABLE, so the RPC yields an array of ladder
  // rows ordered highest-precedence first. Take the top row's `value`.
  const row = Array.isArray(raw) ? raw[0] : raw;
  if (row === null || row === undefined || typeof row !== "object") {
    if (params.requireResolved === true) {
      throw new Error(`mobile_v2_policy: ${params.category} did not resolve a settings row`);
    }
    return params.fallback;
  }
  const value = (row as Record<string, unknown>).value;
  if (value === undefined || value === null) {
    if (params.requireResolved === true) {
      throw new Error(`mobile_v2_policy: ${params.category} resolved without a value`);
    }
    return params.fallback;
  }
  try {
    return params.parse(value);
  } catch (error) {
    if (params.requireResolved === true) {
      throw new Error(
        `mobile_v2_policy: ${params.category} value failed validation - ${
          error instanceof Error ? error.message : "invalid policy"
        }`,
      );
    }
    return params.fallback;
  }
}

export function useFieldopsPolicy<T>(
  options: UseFieldopsPolicyOptions<T>,
): UseQueryResult<T, Error> {
  const ctx = useMobileV2Rpc();
  return useQuery<T, Error>({
    ...(options.query ?? {}),
    queryKey: [
      "mobile-v2",
      "policy",
      options.category,
      ctx.activeRole,
      ctx.policyContext ?? null,
    ],
    queryFn: async () =>
      resolveFieldopsPolicyValue({
        ctx,
        category: options.category,
        parse: options.parse,
        fallback: options.fallback,
        requireResolved: options.requireResolved,
      }),
  });
}

// ---------------------------------------------------------------------------
// Query client helper — exported so the app can wire a single instance.
// Callers may import @tanstack/react-query QueryClientProvider directly
// with their own client; this is a convenience builder with sensible
// defaults for the V2 surfaces.
// ---------------------------------------------------------------------------

export function buildMobileV2QueryClientOptions(): NonNullable<ConstructorParameters<typeof QueryClient>[0]> {
  return {
    defaultOptions: {
      queries: {
        // Tasks/pickups list views update at most a few times per minute;
        // 30 s staleTime + 60 s gcTime gives a snappy UI without hammering
        // the RPC.
        staleTime: 30_000,
        gcTime: 60_000,
        // Always refetch on mount so a returning driver sees current state.
        refetchOnMount: "always",
        // Off by default — RN screens manage their own focus refresh.
        refetchOnWindowFocus: false,
        retry: 1,
      },
    },
  };
}
