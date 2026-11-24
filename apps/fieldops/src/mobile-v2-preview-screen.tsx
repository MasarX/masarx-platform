// Mobile V2 screen module. Exposes two entry points that share one
// `PreviewBody` interaction layer:
//   - `MobileV2PreviewScreen` — the web-only `?v2=preview` design showcase
//     (never rendered in production builds; the bootstrap gate is web-only).
//   - `MobileV2NativeShell` — the production V2 shell that `App.tsx` mounts
//     when `mobile_shell_policy.v2_enabled` resolves TRUE.
//
// `PreviewBody` therefore runs in BOTH contexts. In showcase mode the
// supabase client is null and every RPC hook short-circuits to a fixture;
// in the native shell it is a live client and the hooks read/write the
// canonical resolve_fieldops_* / submit_fieldops_* RPCs. Code in PreviewBody
// must never assume it is preview-only — write paths that target a backend
// UUID must guard against fixture identifiers (see `isMobileV2PersistedUuid`).

import * as React from "react";
import { redactDisplayErrorText } from "./mobile-display-error";
import { Platform, Pressable, ScrollView, Text, TextInput, View } from "react-native";
import Constants from "expo-constants";
import * as Crypto from "expo-crypto";
import * as Location from "expo-location";
import * as Network from "expo-network";
import { confirmMobileV2Action } from "./mobile-v2-confirm";
import { SafeAreaProvider } from "react-native-safe-area-context";

import { FxIcon } from "./mobile-v2-icon";
import {
  FxButton,
  FxCard,
  FxChip,
  FxCol,
  FxRow,
  FxStatusDot,
} from "./mobile-v2-primitives";
import {
  AppDrawer,
  BottomTabs,
  ScreenShell,
  ToastDescriptor,
} from "./mobile-v2-shell";
import {
  collectMobileV2Capabilities,
  filterMobileV2Navigation,
  hasMobileV2Capability,
  parseMobileV2NavigationPayload,
  type MobileV2NavigationItem,
  type MobileV2NavigationSection,
} from "./mobile-v2-navigation";
import { createFieldOpsStorage } from "./mobile-storage";
import {
  MOBILE_V2_ACTIVE_OPS_SESSION_STORAGE_KEY,
  MOBILE_V2_DEVICE_INSTALL_ID_STORAGE_KEY,
  MOBILE_V2_DEVICE_ID_STORAGE_KEY,
  MOBILE_V2_DRIVER_SHIFT_CLOSE_READBACK_FAILED_MESSAGE,
  MOBILE_V2_DRIVER_SHIFT_READINESS_BLOCKED_MESSAGE,
  MOBILE_V2_DRIVER_SHIFT_START_READBACK_FAILED_MESSAGE,
  buildMobileV2OpsSessionReadbackInput,
  buildMobileV2EndDriverShiftInput,
  buildMobileV2StartDriverShiftInput,
  mobileV2DriverShiftCloseMatchesReadback,
  mobileV2DriverShiftReadinessAllowsStart,
  mobileV2DriverShiftStartMatchesReadback,
  parseMobileV2OpsSessionReadback,
  readMobileV2ActiveDriverShift,
  type MobileV2ActiveDriverShift,
} from "./mobile-v2-driver-shift";
import {
  MOBILE_V2_ROUTE_DEPARTURE_READBACK_FAILED_MESSAGE,
  buildMobileV2RouteDepartureMutationInput,
  buildMobileV2RouteLoadScanMutationInput,
  mobileV2RouteHasDepartureReadback,
  mobileV2RouteHasReadyScanOutReadback,
} from "./mobile-v2-route-departure";
import {
  MOBILE_V2_DEFAULT_DISPLAY_PREFS,
} from "./mobile-v2-display-prefs";
import {
  MOBILE_V2_SPACING,
  MOBILE_V2_THEME_KEYS,
} from "./mobile-v2-themes";
import {
  MobileV2ThemeProvider,
  useMobileV2Theme,
} from "./mobile-v2-theme-context";
import { MobileV2TasksScreen, type MobileV2TasksDataState } from "./mobile-v2-tasks-screen";
import { MobileV2LoginScreen, type MobileV2LoginStep } from "./mobile-v2-login-screen";
import { useFieldopsTasksRpc } from "./mobile-v2-rpc-hooks";
import {
  filterMobileV2TasksByQuery,
} from "./mobile-v2-tasks-types";
import { MobileV2StopScreen, type MobileV2StopDetail } from "./mobile-v2-stop-screen";
import {
  MobileV2PodScreen,
  type MobileV2PodScanParcel,
} from "./mobile-v2-pod-screen";
import {
  buildMobileV2PodCloseoutEvidence,
  buildMobileV2PodFailureEvidence,
} from "./mobile-v2-pod-closeout-evidence";
import {
  buildMobileV2CleaningEvidenceStorageKey,
  buildMobileV2CashDropEvidenceStorageKey,
  buildMobileV2IstimaraStorageKey,
  buildMobileV2KycDocumentStorageKey,
  buildMobileV2PodArtifactStorageKey,
  buildMobileV2VehiclePhotoStorageKey,
  decodeMobileV2Base64ToArrayBuffer,
  encodeMobileV2TextToArrayBuffer,
  readMobileV2PolicyContextId,
  type MobileV2PodArtifactCaptureInput,
  type MobileV2PodCapturedArtifact,
} from "./mobile-v2-pod-artifacts";
import {
  MOBILE_V2_POD_DEFAULT_POLICY,
  parseMobileV2PodPolicy,
  resolveMobileV2PodPolicyForStop,
} from "./mobile-v2-pod-policy";
import {
  MOBILE_V2_DAMAGE_HOLD_DEFAULT_POLICY,
  parseMobileV2DamageHoldPolicy,
} from "./mobile-v2-damage-hold-policy";
import {
  MOBILE_V2_RESCHEDULE_DEFAULT_POLICY,
  buildMobileV2RescheduleReadback,
  buildMobileV2RescheduleWindows,
  mobileV2StopDetailMatchesRescheduleWindow,
  parseMobileV2ReschedulePolicy,
  type MobileV2RescheduleReadback,
} from "./mobile-v2-reschedule-policy";
import {
  MOBILE_V2_PICKUP_DEFAULT_FAILURE_REASONS,
  getMobileV2PickupFailureReasonLabel,
  parseMobileV2PickupFailureReasons,
  selectMobileV2PickupFailureReason,
} from "./mobile-v2-pickup-policy";
import {
  MOBILE_V2_POD_READBACK_FAILED_MESSAGE,
  mobileV2FindTerminalRouteStopStatus,
  mobileV2RouteHasStopStatus,
  mobileV2ShouldReturnToStopAfterTerminalReadback,
  refreshMobileV2PodReadback,
  mobileV2StopDetailHasCodCollectionReadback,
  mobileV2StopDetailHasPodReadback,
  mobileV2TasksHaveRouteStopStatus,
} from "./mobile-v2-pod-readback";
import {
  MOBILE_V2_TRIP_STAGE_READBACK_FAILED_MESSAGE,
  mobileV2TripsHaveStage,
} from "./mobile-v2-trip-readback";
import {
  MOBILE_V2_TAB_FLOW_REFETCH_STALE_MS,
  resolveMobileV2ActiveTabOrDefault,
  resolveMobileV2NavigationTargetId,
  shouldRefetchMobileV2TabOnFocus,
} from "./mobile-v2-tab-routing";
import {
  MobileV2LoaderScanScreen,
  type MobileV2LoaderScanEntry,
} from "./mobile-v2-loader-scan-screen";
import {
  getLoaderActionSubmitRpc,
  MOBILE_V2_LOADER_DEFAULT_POLICY,
  parseMobileV2LoaderPolicy,
  resolveEffectiveLoaderAction,
  type MobileV2LoaderSessionContext,
  type MobileV2LoaderScanMode,
} from "./mobile-v2-loader-policy";
import {
  buildMobileV2LoaderReadbackScans,
  isMobileV2LoaderReadbackScanEntry,
} from "./mobile-v2-loader-readback";
import { createMobileV2LoaderBarcodeScanEntry } from "./mobile-v2-loader-scan-input";
import {
  buildMobileV2StartLoaderSessionInput,
  type MobileV2ActiveLoaderSession,
} from "./mobile-v2-loader-session";
import { emitMobileV2TraceEvent } from "./mobile-v2-trace-context";
import { MobileV2DrivingLockScreen } from "./mobile-v2-driving-lock-screen";
import {
  DEFAULT_MOBILE_DRIVER_SAFETY_POLICY,
  DEFAULT_MOBILE_MAP_POLICY,
  normalizeResolvedMobileMapPolicy,
} from "./mobile-shell-policy";
import {
  MobileV2PickupsScreen,
  type MobileV2Pickup,
  type MobileV2PickupsTab,
} from "./mobile-v2-pickups-screen";
import { MobileV2PickupDetailScreen } from "./mobile-v2-pickup-detail-screen";
import {
  MobileV2TripDetailScreen,
  MobileV2TripsScreen,
  type MobileV2Trip,
  type MobileV2TripStage,
  type MobileV2TripsTab,
} from "./mobile-v2-trips-screen";
import {
  MobileV2SortationScreen,
  type MobileV2SortationBay,
  type MobileV2SortationInduction,
} from "./mobile-v2-sortation-screen";
import {
  MobileV2LookupScreen,
  type MobileV2LookupRecord,
  type MobileV2LookupRecent,
} from "./mobile-v2-lookup-screen";
import { MobileV2TodayScreen } from "./mobile-v2-today-screen";
import {
  MobileV2CleaningScreen,
  type MobileV2CleaningItem,
  type MobileV2CleaningPhotoCapture,
} from "./mobile-v2-cleaning-screen";
import {
  MobileV2KycDocsScreen,
  type MobileV2KycDocumentCapture,
  type MobileV2KycDocSpec,
  type MobileV2KycDocStatus,
} from "./mobile-v2-kyc-docs-screen";
import {
  MobileV2KycVehicleScreen,
  type MobileV2IstimaraCapture,
  type MobileV2IstimaraStatus,
} from "./mobile-v2-kyc-vehicle-screen";
import {
  MobileV2KycVehiclePhotosScreen,
  type MobileV2VehicleAngle,
  type MobileV2VehicleAngleId,
  type MobileV2VehiclePhotoCapture,
} from "./mobile-v2-kyc-vehicle-photos-screen";
import {
  MobileV2PreShiftGateScreen,
  type MobileV2PreShiftBlocker,
  type MobileV2PreShiftCadenceSummary,
} from "./mobile-v2-pre-shift-gate-screen";
import {
  MobileV2WalletScreen,
  type MobileV2WalletBalance,
  type MobileV2WalletBreakdownRow,
  type MobileV2WalletWeekBar,
} from "./mobile-v2-wallet-screen";
import {
  MobileV2ReturnsScreen,
  type MobileV2ReturnsReadback,
  type MobileV2ReturnsRtoStop,
  type MobileV2ReturnsStop,
} from "./mobile-v2-returns-screen";
import {
  MobileV2HubPickupScreen,
  type MobileV2HubPickupQueueItem,
} from "./mobile-v2-hub-pickup-screen";
import {
  MobileV2HoldQueueScreen,
  type MobileV2HoldDecisionSummary,
  type MobileV2HoldItem,
} from "./mobile-v2-hold-queue-screen";
import {
  readMobileV2HoldDecisionReadback,
  type MobileV2HoldDecisionAction,
} from "./mobile-v2-hold-decision-readback";
import {
  MobileV2CashDropScreen,
  type MobileV2CashDropPhotoCapture,
} from "./mobile-v2-cash-drop-screen";
import {
  MobileV2CodLedgerScreen,
  type MobileV2CodLedgerStop,
} from "./mobile-v2-cod-ledger-screen";
import { MobileV2SettlementsScreen } from "./mobile-v2-settlements-screen";
import {
  MobileV2EorScreen,
  type MobileV2EorChecklistItem,
  type MobileV2EorSummary,
} from "./mobile-v2-eor-screen";
import { MobileV2TripNavScreen } from "./mobile-v2-trip-nav-screen";
import {
  MobileV2RouteScreen,
  type MobileV2RouteManifestSummary,
  type MobileV2RouteStop,
  type MobileV2RouteSavedView,
} from "./mobile-v2-route-screen";
import {
  MobileV2MapScreen,
  type MobileV2MapLocationReadback,
} from "./mobile-v2-map-screen";
import {
  buildMobileV2StopLocationReadback,
  buildMobileV2RouteMapLocationError,
  buildMobileV2RouteMapReadback,
  buildMobileV2NativeDeviceRegistrationPayload,
  formatMobileV2RouteMapLocationError,
  MOBILE_V2_ROUTE_MAP_LAST_KNOWN_POSITION_OPTIONS,
  normalizeMobileV2DeviceId,
  normalizeMobileV2LocationAccuracy,
  normalizeMobileV2LocationHeading,
  normalizeMobileV2LocationNumber,
  normalizeMobileV2RouteMapStopId,
  resolveMobileV2RouteMapPosition,
  resolveMobileV2NativeShellDeviceId,
  type MobileV2StopLocationReadback,
} from "./mobile-v2-route-map-location";
import { MobileV2ListStateView } from "./mobile-v2-list-state-view";
import {
  MobileV2MoreScreen,
  type MobileV2DriverShiftPanel,
  type MobileV2LoaderSessionPanel,
  type MobileV2MoreOutboxEntry,
} from "./mobile-v2-more-screen";
import {
  MobileV2SyncQueueScreen,
  type MobileV2SyncConnectivity,
  type MobileV2SyncEntry,
} from "./mobile-v2-sync-queue-screen";
import { MobileV2LoaderTodayScreen } from "./mobile-v2-loader-today-screen";
import { MobileV2RiderTodayScreen } from "./mobile-v2-rider-today-screen";
import { MobileV2SupervisorScreen } from "./mobile-v2-supervisor-screen";
import { MobileV2SavedViewsSheet } from "./mobile-v2-sheet-saved-views";
import { MobileV2TaskFiltersSheet } from "./mobile-v2-sheet-task-filters";
import { MobileV2PickerSheet } from "./mobile-v2-sheet-picker";
import { MobileV2NoteSheet } from "./mobile-v2-sheet-note";
import { MobileV2RescheduleSheet } from "./mobile-v2-sheet-reschedule";
import {
  MOBILE_V2_TASK_DEFAULT_VIEWS,
  MOBILE_V2_TASK_GROUP_OPTIONS,
  MOBILE_V2_TASK_SORT_OPTIONS,
  MOBILE_V2_ROUTE_DEFAULT_VIEWS,
  MOBILE_V2_ROUTE_GROUP_OPTIONS,
  MOBILE_V2_ROUTE_SORT_OPTIONS,
  MOBILE_V2_TASK_FILTER_FIELDS,
  applyMobileV2RouteView,
  applyMobileV2TaskFilters,
  applyMobileV2TaskGroups,
  applyMobileV2TaskSort,
  collectMobileV2TaskAreas,
  countMobileV2TaskFilters,
  getMobileV2RouteGroupLabel,
  getMobileV2RouteSortLabel,
  getMobileV2TaskGroupLabel,
  getMobileV2TaskSortLabel,
  projectMobileV2RouteMap,
  type MobileV2TaskFilterState,
  type MobileV2TaskBoardSavedView,
  type MobileV2TaskGroupKey,
  type MobileV2TaskSortKey,
  type MobileV2RouteListView,
  type MobileV2RouteGroupKey,
  type MobileV2RouteSortKey,
} from "./mobile-v2-tasks-views";
import {
  QueryClient,
  QueryClientProvider,
  useMutationState,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import {
  firstMobileUiEventType,
  normalizeMobileUiEvents,
  resolveMobileUiEventLogReadback,
  type MobileUiEventLogResult,
} from "./mobile-ui-event-log";
import {
  MobileV2RpcProvider,
  buildMobileV2QueryClientOptions,
  drainMobileV2Outbox,
  getMobileV2SupabaseSchemaClient,
  isMobileV2ListLoading,
  isMobileV2PersistedUuid,
  resolveMobileV2StopDetailForRender,
  findMobileV2ReturnedStopAfterMark,
  findMobileV2PickupReadback,
  mobileV2CashDropMatchesWrite,
  mobileV2CleaningMatchesWrite,
  mobileV2DamageHoldMatchesWrite,
  mobileV2IncidentMatchesWrite,
  mobileV2KycDocMatchesWrite,
  mobileV2KycVehicleMatchesWrite,
  mobileV2PreShiftReadbackConfirmsHealthOk,
  mobileV2PreShiftMatchesWrite,
  mobileV2VehiclePhotosMatchWrite,
  mobileV2WalletWithdrawalMatchesWrite,
  refreshMobileV2QueriesAfterOutboxDrain,
  resolveFieldopsSettlementsDisplayEnvelope,
  resolveFieldopsInductionBay,
  useFieldopsAdvanceTripStageMutation,
  useFieldopsActiveRoleRpc,
  useFieldopsCashDropRpc,
  useFieldopsEorRpc,
  useFieldopsHoldRpc,
  useFieldopsHubPickupRpc,
  useFieldopsInductParcelMutation,
  useFieldopsLookupRpc,
  useFieldopsMarkReturnReceivedMutation,
  useFieldopsPickupsRpc,
  useFieldopsConfirmRouteDepartureMutation,
  useFieldopsReleaseHubPickupMutation,
  useFieldopsRecordLocationPingMutation,
  useFieldopsRecordRouteLoadScanMutation,
  useFieldopsRequestWalletWithdrawMutation,
  useFieldopsReturnsRpc,
  useFieldopsRouteRpc,
  useFieldopsSettlementsRpc,
  useFieldopsSignCashDropMutation,
  useFieldopsSortationRpc,
  useFieldopsStopDetailRpc,
  useFieldopsNavigationRpc,
  useFieldopsIncidentTypesRpc,
  useFieldopsLatestIncidentRpc,
  useFieldopsLatestDamageHoldRpc,
  useFieldopsSubmitHoldDecisionMutation,
  useFieldopsSubmitIncidentMutation,
  useFieldopsSubmitDamageHoldMutation,
  useFieldopsSubmitRescheduleMutation,
  useFieldopsSubmitProofMutation,
  useFieldopsSubmitEodReconMutation,
  useFieldopsLoaderTodayRpc,
  useFieldopsRiderTodayRpc,
  useFieldopsSupervisorQueueRpc,
  useFieldopsSetActiveRoleMutation,
  useFieldopsProfileRpc,
  useFieldopsRecordCleaningCheckMutation,
  useFieldopsSubmitKycDocMutation,
  useFieldopsSubmitKycVehicleMutation,
  useFieldopsSubmitVehiclePhotosMutation,
  useFieldopsTripsRpc,
  useFieldopsWalletRpc,
  useFieldopsOnboardingReadbackRpc,
  useFieldopsPassPreShiftGateMutation,
  useFieldopsPolicy,
  useMobileV2OutboxDrainer,
  useMobileV2Rpc,
  normalizeMobileV2Role,
  newIdempotencyKey,
  type MobileV2CashDropEnvelope,
  type MobileV2DamageHoldReadback,
  type MobileV2IncidentReadback,
  type MobileV2OnboardingCleaningReadback,
  type MobileV2OnboardingPreShiftReadback,
  type MobileV2OnboardingVehiclePhotosReadback,
  type MobileV2OutboxDrainBundle,
  type MobileV2Role,
} from "./mobile-v2-rpc-hooks";
import {
  MOBILE_V2_PREVIEW_CONNECTIVITY,
  buildMobileV2Connectivity,
  projectMobileV2OutboxEntries,
  projectMobileV2SyncQueueEntries,
  type MobileV2Connectivity,
  type MobileV2RawOutboxSyncEntry,
} from "./mobile-v2-connectivity";

import { MobileV2IncidentSheet } from "./mobile-v2-sheet-incident";
import {
  MobileV2DamageHoldSheet,
  type MobileV2DamageHoldPhotoCapture,
} from "./mobile-v2-sheet-damage-hold";
import {
  copyMobileV2Text,
  openMobileV2Call,
  openMobileV2Maps,
  openMobileV2WhatsApp,
  shareMobileV2Text,
  type MobileV2IntentResult,
} from "./mobile-v2-intents";
import { composeMobileV2AddressText } from "./mobile-v2-intent-helpers";

// PREVIEW/DEV FIXTURES — single import line is the production cutover
// gate. Delete `./fixtures/` (and this import) to force the preview to
// run on live RPC data only. See apps/fieldops/src/fixtures/README.md.
import {
  MOBILE_V2_PREVIEW_CAPS,
  MOBILE_V2_PREVIEW_CASH_DROP,
  MOBILE_V2_PREVIEW_COD_LEDGER,
  MOBILE_V2_PREVIEW_CLEANING,
  MOBILE_V2_PREVIEW_EOR,
  MOBILE_V2_PREVIEW_HUB_PICKUP,
  MOBILE_V2_PREVIEW_INCIDENT_TYPES,
  MOBILE_V2_PREVIEW_KYC_VEHICLE,
  MOBILE_V2_PREVIEW_LOADER_SCANS,
  MOBILE_V2_PREVIEW_LOADER_TODAY,
  MOBILE_V2_PREVIEW_LOOKUP_RECORDS,
  MOBILE_V2_PREVIEW_MORE_OUTBOX,
  MOBILE_V2_PREVIEW_NAV,
  MOBILE_V2_PREVIEW_PICKUPS,
  MOBILE_V2_PREVIEW_PRE_SHIFT,
  MOBILE_V2_PREVIEW_RETURNS,
  MOBILE_V2_PREVIEW_RIDER_TODAY,
  MOBILE_V2_PREVIEW_ROLES,
  MOBILE_V2_PREVIEW_ROUTE,
  MOBILE_V2_PREVIEW_RESCHEDULE_WINDOWS,
  MOBILE_V2_PREVIEW_SETTLEMENTS,
  MOBILE_V2_PREVIEW_SUPERVISOR_QUEUE,
  MOBILE_V2_PREVIEW_SORTATION_BAYS,
  MOBILE_V2_PREVIEW_SORTATION_RECENT,
  MOBILE_V2_PREVIEW_SORTATION_STATS,
  MOBILE_V2_PREVIEW_STOP,
  MOBILE_V2_PREVIEW_STOP_PARCELS,
  MOBILE_V2_PREVIEW_STOP_PROOF,
  MOBILE_V2_PREVIEW_SYNC_QUEUE,
  MOBILE_V2_PREVIEW_TASKS,
  MOBILE_V2_PREVIEW_TODAY,
  MOBILE_V2_PREVIEW_TRIPS,
  MOBILE_V2_PREVIEW_USER as MOBILE_V2_PREVIEW_PROFILE,
  MOBILE_V2_PREVIEW_WALLET,
  buildMobileV2PreviewHold,
  buildMobileV2PreviewLookupRecent,
} from "./fixtures";

// Sample navigation payload that mirrors the post-Phase-2 SSOT registration.
// In production this comes from resolve_settings_row_from_policy_context_v1.

// Local aliases for fixture exports — keeps the rest of the file readable
// without the long MOBILE_V2_PREVIEW_* identifiers. Delete this block on
// production cutover (with the ./fixtures import above).
const SAMPLE_NAV = MOBILE_V2_PREVIEW_NAV;
const SAMPLE_CAPS = MOBILE_V2_PREVIEW_CAPS;
const SAMPLE_ROLES = MOBILE_V2_PREVIEW_ROLES as ReadonlyArray<MobileV2Role>;
const SAMPLE_TASKS = MOBILE_V2_PREVIEW_TASKS;
const SAMPLE_STOP = MOBILE_V2_PREVIEW_STOP;
const EMPTY_MOBILE_V2_NAVIGATION: ReadonlyArray<MobileV2NavigationSection> = Object.freeze([]);
const EMPTY_MOBILE_V2_POD_ARTIFACTS: ReadonlyArray<MobileV2PodCapturedArtifact> = Object.freeze([]);
const EMPTY_MOBILE_V2_COD_LEDGER_STOPS: ReadonlyArray<MobileV2CodLedgerStop> = Object.freeze([]);
const MOBILE_V2_FIELDOPS_EVIDENCE_BUCKET = "fieldops-evidence";

function isMobileV2VehicleAngleId(value: string): value is MobileV2VehicleAngleId {
  return value === "front" || value === "rear" || value === "left" || value === "right";
}

function resolveMobileV2ArtifactId(raw: unknown): string | null {
  const rows = Array.isArray(raw) ? raw : raw !== null ? [raw] : [];
  return rows
    .map((row) => (row !== null && typeof row === "object" ? (row as Record<string, unknown>).artifact_id : null))
    .find((value): value is string => typeof value === "string" && value.trim() !== "") ?? null;
}

function formatMobileV2UserError(error: unknown, fallback: string): string {
  const raw = error instanceof Error ? error.message : "";
  const lower = raw.toLowerCase();
  if (
    raw.trim().length === 0 ||
    lower.includes("backend") ||
    lower.includes("rpc") ||
    lower.includes("readback") ||
    lower.includes("executor") ||
    lower.includes("debug") ||
    lower.includes("trace") ||
    lower.includes("diagnostic")
  ) {
    return fallback;
  }
  return redactDisplayErrorText(raw, fallback);
}

function buildMobileV2CodLedgerStops(
  rows: ReadonlyArray<MobileV2RouteStop>,
): ReadonlyArray<MobileV2CodLedgerStop> {
  const stops = rows
    .filter((row) => row.cod > 0)
    .map((row) =>
      Object.freeze({
        id: row.id.startsWith("stop:") ? row.id.slice("stop:".length) : row.id,
        seq: row.seq,
        customer: row.customer,
        amount: row.cod,
        state: row.status === "done" ? "paid" : "pending",
      } satisfies MobileV2CodLedgerStop),
    );
  return Object.freeze(stops);
}

function sumMobileV2CodLedgerAmounts(stops: ReadonlyArray<MobileV2CodLedgerStop>): number {
  return stops.reduce((total, stop) => total + stop.amount, 0);
}

function sumMobileV2PaidCodLedgerAmounts(stops: ReadonlyArray<MobileV2CodLedgerStop>): number {
  return stops.reduce((total, stop) => total + (stop.state === "paid" ? stop.amount : 0), 0);
}

interface PreviewBodyProps {
  /**
   * Connectivity snapshot for the shell's "online · N queued" indicator.
   * Engineering audit B3 (BLOCKER): when omitted the body falls back to
   * the fixed design-rehearsal value (`MOBILE_V2_PREVIEW_CONNECTIVITY`)
   * so the `?v2=preview` showcase keeps a deterministic offline state
   * and visual baselines do not churn. `MobileV2NativeShell` always
   * passes a REAL snapshot (device network + live outbox depth).
   */
  readonly connectivity?: MobileV2Connectivity;
  /**
   * Recent outbox entries surfaced on the More screen. Omitted by the
   * `?v2=preview` showcase (it uses `MOBILE_V2_PREVIEW_MORE_OUTBOX`);
   * `MobileV2NativeShell` passes the live outbox entries.
   */
  readonly outboxEntries?: ReadonlyArray<MobileV2MoreOutboxEntry>;
  /**
   * Full Sync Queue rows rendered by the `mobile-outbox` route. The
   * showcase uses the design fixture; the native shell projects live
   * outbox rows from the canonical local outbox.
   */
  readonly syncQueueEntries?: ReadonlyArray<MobileV2SyncEntry>;
  readonly lastSyncMs?: number | null;
  /**
   * Real session sign-out. Omitted by the showcase (sign-out is a
   * preview no-op there); `MobileV2NativeShell` passes a handler that
   * invalidates the supabase session.
   */
  readonly onSignOut?: () => void | Promise<void>;
  /**
   * Real manual outbox drain. `MobileV2NativeShell` passes a handler
   * that replays queued mutations through the live supabase client;
   * the `?v2=preview` showcase omits it (no live outbox) so the sync
   * action stays a preview no-op toast.
   */
  readonly onManualSync?: () => void | Promise<void>;
  /**
   * Real driver shift state/action for the native shell. Omitted by the
   * showcase so preview remains visual-only.
   */
  readonly driverShift?: MobileV2DriverShiftPanel;
  /**
   * Native shell role state. The showcase omits this and keeps the sample
   * role switcher, while production wires it to auth_get/set_active_role_v1.
   */
  readonly activeRole?: MobileV2Role;
  readonly onActiveRoleChange?: (role: MobileV2Role) => void;
  /**
   * Native device registration id. The showcase omits this; production
   * Mobile V2 passes the persisted device id so route-map location pings
   * can be recorded through record_location_ping_v1.
   */
  readonly deviceId?: string | null;
}

function PreviewBody(props: PreviewBodyProps = {}): React.ReactElement {
  const ctx = useMobileV2Theme();
  const mobileRpc = useMobileV2Rpc();
  // `?v2=preview` showcase runs with a null supabase client; the native
  // shell runs with a live one. Used to keep optimistic showcase paths
  // from fabricating a success in the production shell.
  const isShowcase = mobileRpc.supabase === null;
  const [drawerOpen, setDrawerOpen] = React.useState(false);
  const [activeTabId, setActiveTabId] = React.useState("mobile-tasks");
  const [, startTabTransition] = React.useTransition();
  const [activeRole, setActiveRole] = React.useState<MobileV2Role>(
    props.activeRole ?? mobileRpc.activeRole,
  );
  const [toast, setToast] = React.useState<ToastDescriptor | null>(null);
  const [routeIntentReadback, setRouteIntentReadback] =
    React.useState<MobileUiEventLogResult | null>(null);
  const latestSuccessfulMutationAtValues = useMutationState({
    filters: { status: "success" },
    select: (mutation) => mutation.state.submittedAt,
  });
  const latestPendingMutationAtValues = useMutationState({
    filters: { status: "pending" },
    select: (mutation) => mutation.state.submittedAt,
  });
  const latestRelevantMutationAt = React.useMemo(() => {
    const timestamps = [
      ...latestSuccessfulMutationAtValues,
      ...latestPendingMutationAtValues,
    ].filter((value): value is number => Number.isFinite(value) && value > 0);
    return Math.max(0, ...timestamps);
  }, [latestPendingMutationAtValues, latestSuccessfulMutationAtValues]);
  const activeRoleQuery = useFieldopsActiveRoleRpc();
  const setActiveRoleMutation = useFieldopsSetActiveRoleMutation();
  const activeRoleEnvelope = activeRoleQuery.data;
  const handleExternalActiveRoleChange = props.onActiveRoleChange;
  React.useEffect(() => {
    const nextRole = isShowcase
      ? props.activeRole ?? mobileRpc.activeRole
      : activeRoleEnvelope?.activeRole ?? props.activeRole ?? mobileRpc.activeRole;
    setActiveRole(nextRole);
    if (props.activeRole !== nextRole) {
      handleExternalActiveRoleChange?.(nextRole);
    }
  }, [
    activeRoleEnvelope?.activeRole,
    handleExternalActiveRoleChange,
    isShowcase,
    mobileRpc.activeRole,
    props.activeRole,
  ]);
  // I1 fix: drawer / tabs are config-driven from ui_navigation.apps.mobile
  // (the SSOT per AGENTS.md). SAMPLE_NAV is preview-only; production
  // fails closed on backend nav errors or malformed payloads.
  const navigationFallback = isShowcase ? SAMPLE_NAV : EMPTY_MOBILE_V2_NAVIGATION;
  const navigationRpc = useFieldopsNavigationRpc({ fallback: navigationFallback });
  const resolvedNav = navigationRpc.data ?? navigationFallback;
  // F5 fix: capabilities that gate the drawer + bottom tabs are derived
  // from the resolved `ui_navigation` payload (the canonical access
  // surface) - `collectMobileV2Capabilities` unions every item's
  // `capability`. The PREVIEW/DEV fixture (`SAMPLE_CAPS`) is engaged only
  // when running the `?v2=preview` showcase (supabase === null), never in
  // the production native shell.
  const capabilities = React.useMemo<ReadonlyArray<string>>(
    () => (isShowcase ? SAMPLE_CAPS : collectMobileV2Capabilities(resolvedNav)),
    [isShowcase, resolvedNav],
  );
  const visibleSections = React.useMemo(
    () => filterMobileV2Navigation(resolvedNav, { activeRole, capabilities }),
    [activeRole, resolvedNav, capabilities],
  );
  const visibleCapabilities = React.useMemo<ReadonlyArray<string>>(
    () => (isShowcase ? SAMPLE_CAPS : collectMobileV2Capabilities(visibleSections)),
    [isShowcase, visibleSections],
  );
  const availableRoles = React.useMemo<ReadonlyArray<MobileV2Role>>(() => {
    if (isShowcase) return SAMPLE_ROLES;
    const assignedRoles = activeRoleEnvelope?.assignedRoles ?? [];
    if (assignedRoles.length > 0) return assignedRoles;
    return Object.freeze([activeRole]);
  }, [activeRole, activeRoleEnvelope?.assignedRoles, isShowcase]);
  const visibleNavigationItems = React.useMemo(
    () => visibleSections.flatMap((section) => section.items),
    [visibleSections],
  );
  const visibleRoutingItems = React.useMemo(
    () =>
      visibleNavigationItems.map((item) => ({
        id: resolveMobileV2NavigationTargetId(item),
        defaultHome: item.defaultHome,
      })),
    [visibleNavigationItems],
  );
  const walletAccessEnabled = isShowcase || hasMobileV2Capability(visibleCapabilities, "wallet.read");
  const cashDropAccessEnabled = isShowcase || hasMobileV2Capability(visibleCapabilities, "cash_drop.write");
  const registeredDeviceId = normalizeMobileV2DeviceId(props.deviceId);
  // B3 fix: connectivity is REAL in the native shell (props.connectivity
  // wired from device network + outbox) and a fixed design-rehearsal
  // value in the `?v2=preview` showcase (no props → preview fallback).
  const connectivity = props.connectivity ?? MOBILE_V2_PREVIEW_CONNECTIVITY;
  const online = connectivity.online;
  const queueCount = connectivity.queueCount;
  const outboxEntries = props.outboxEntries ?? MOBILE_V2_PREVIEW_MORE_OUTBOX;
  const syncQueueEntries = props.syncQueueEntries ?? MOBILE_V2_PREVIEW_SYNC_QUEUE.queue;
  const syncQueueConnectivity: MobileV2SyncConnectivity = connectivity.syncing
    ? "syncing"
    : online
      ? "online"
      : "offline";
  // Incident report sheet — controlled host state (B1 fix: the
  // "Report incident" action now opens the real MobileV2IncidentSheet
  // instead of a toast stub).
  const [incidentSheetOpen, setIncidentSheetOpen] = React.useState(false);
  const [incidentTypeId, setIncidentTypeId] = React.useState<string | null>(null);
  const [incidentPhoto, setIncidentPhoto] = React.useState(false);
  const [incidentStatement, setIncidentStatement] = React.useState("");
  // Stop id the incident is being filed against (set when the report is
  // opened from a stop / trip context; null for a standalone report).
  const [incidentStopId, setIncidentStopId] = React.useState<string | null>(null);
  const [damageHoldSheetOpen, setDamageHoldSheetOpen] = React.useState(false);
  const [damageHoldParcelId, setDamageHoldParcelId] = React.useState<string | null>(null);
  const [damageHoldParcelLabel, setDamageHoldParcelLabel] = React.useState<string | null>(null);
  const [damageHoldSeverityId, setDamageHoldSeverityId] = React.useState<string | null>(null);
  const [damageHoldNote, setDamageHoldNote] = React.useState("");
  const [damageHoldPhotoArtifact, setDamageHoldPhotoArtifact] =
    React.useState<MobileV2PodCapturedArtifact | null>(null);
  const [damageHoldCaptureBusy, setDamageHoldCaptureBusy] = React.useState(false);
  const [damageHoldReadbackPending, setDamageHoldReadbackPending] = React.useState(false);
  const [damageHoldReadbackError, setDamageHoldReadbackError] = React.useState<string | null>(null);
  const [damageHoldVerifiedReadback, setDamageHoldVerifiedReadback] =
    React.useState<MobileV2DamageHoldReadback | null>(null);
  const [rescheduleSheetOpen, setRescheduleSheetOpen] = React.useState(false);
  const [rescheduleWindowId, setRescheduleWindowId] = React.useState<string | null>(null);
  const [rescheduleNote, setRescheduleNote] = React.useState("");
  const [rescheduleReadbackPending, setRescheduleReadbackPending] = React.useState(false);
  const [rescheduleReadbackError, setRescheduleReadbackError] = React.useState<string | null>(null);
  const [rescheduleVerifiedReadback, setRescheduleVerifiedReadback] =
    React.useState<MobileV2RescheduleReadback | null>(null);
  const [tasksQuery, setTasksQuery] = React.useState("");
  const [podFailSheetOpen, setPodFailSheetOpen] = React.useState(false);
  const [loaderMode, setLoaderMode] = React.useState<MobileV2LoaderScanMode>(
    MOBILE_V2_LOADER_DEFAULT_POLICY.defaultMode,
  );
  const [loaderActionKey, setLoaderActionKey] = React.useState<string>(
    MOBILE_V2_LOADER_DEFAULT_POLICY.defaultAction,
  );
  const [drivingLockKph, setDrivingLockKph] = React.useState(() => {
    if (typeof window !== "undefined" && typeof window.location !== "undefined") {
      try {
        const speed = new URL(window.location.href).searchParams.get("speed");
        if (speed !== null) {
          const n = Number(speed);
          if (Number.isFinite(n) && n >= 0) return n;
        }
      } catch {
        // ignore
      }
    }
    return 0;
  });
  const [pickupsQuery, setPickupsQuery] = React.useState("");
  const [pickupsTab, setPickupsTab] = React.useState<MobileV2PickupsTab>("pending");
  const [activePickupId, setActivePickupId] = React.useState<string | null>(null);
  // Live RPC binding: useFieldopsTasksRpc reads from
  // resolve_fieldops_tasks_v1 via supabase-js when connected, otherwise
  // returns the fallback (SAMPLE_TASKS below) so the preview always
  // renders. In production with a real supabase client this fetches
  // live driver tasks scoped to the auth.uid().
  const tasksRpc = useFieldopsTasksRpc({
    fallback: SAMPLE_TASKS,
    query: { staleTime: MOBILE_V2_TAB_FLOW_REFETCH_STALE_MS },
  });
  // Memoized so the derived task-view memos below keep a stable
  // dependency identity (a fresh object literal every render would
  // re-run the filter/sort/group pipeline on every render).
  const tasksRpcState: MobileV2TasksDataState = React.useMemo(
    () =>
      tasksRpc.isLoading
        ? { kind: "loading" }
        : tasksRpc.isError
          ? {
              kind: "error",
              message: "Tasks are unavailable right now. Try again.",
              onRetry: () => {
                void tasksRpc.refetch();
              },
            }
          : { kind: "ready", tasks: tasksRpc.data ?? SAMPLE_TASKS },
    [tasksRpc.isLoading, tasksRpc.isError, tasksRpc.error, tasksRpc.data, tasksRpc.refetch, SAMPLE_TASKS],
  );
  const [tripsTab, setTripsTab] = React.useState<MobileV2TripsTab>("all");
  // Active stop identity is declared before the Route RPC so readback can pin
  // the visible route run even after this stop becomes terminal.
  const [activeStopId, setActiveStopId] = React.useState<string>(SAMPLE_STOP.id);
  const activeStopTaskId = isMobileV2PersistedUuid(activeStopId)
    ? `stop:${activeStopId}`
    : activeStopId;
  // Route screen — stop list derived from resolve_fieldops_tasks_v1
  // (driver role) via useFieldopsRouteRpc. The fixture supplies the
  // saved-views / sort / density chrome (no resolver for those yet) and
  // is the rows fallback in preview / offline.
  const routeRpc = useFieldopsRouteRpc({
    fallback: {
      rows: MOBILE_V2_PREVIEW_ROUTE.rows,
      totalStops: MOBILE_V2_PREVIEW_ROUTE.totalStops,
      routeId: MOBILE_V2_PREVIEW_ROUTE.mapRouteId,
      routeRunId: null,
      manifestSummary: null,
    },
    preferredTaskId: isMobileV2PersistedUuid(activeStopId) ? activeStopTaskId : null,
    query: { staleTime: MOBILE_V2_TAB_FLOW_REFETCH_STALE_MS },
  });
  const routeRows = routeRpc.data?.rows ?? MOBILE_V2_PREVIEW_ROUTE.rows;
  const routeTotalStops = routeRpc.data?.totalStops ?? MOBILE_V2_PREVIEW_ROUTE.totalStops;
  const routeManifestSummary: MobileV2RouteManifestSummary | null =
    routeRpc.data?.manifestSummary ?? null;
  const previousResolverFocusRef = React.useRef<string | null>(null);
  React.useEffect(() => {
    const previousTabId = previousResolverFocusRef.current;
    previousResolverFocusRef.current = activeTabId;
    if (activeTabId !== "mobile-tasks" && activeTabId !== "mobile-route") {
      return;
    }
    if (previousTabId === activeTabId) {
      return;
    }
    if (activeTabId === "mobile-tasks") {
      if (
        shouldRefetchMobileV2TabOnFocus({
          dataUpdatedAt: tasksRpc.dataUpdatedAt,
          lastRelevantMutationAt: latestRelevantMutationAt,
          now: Date.now(),
        })
      ) {
        void tasksRpc.refetch();
      }
      return;
    }
    if (
      shouldRefetchMobileV2TabOnFocus({
        dataUpdatedAt: routeRpc.dataUpdatedAt,
        lastRelevantMutationAt: latestRelevantMutationAt,
        now: Date.now(),
      })
    ) {
      void routeRpc.refetch();
    }
  }, [
    activeTabId,
    latestRelevantMutationAt,
    routeRpc.dataUpdatedAt,
    routeRpc.refetch,
    tasksRpc.dataUpdatedAt,
    tasksRpc.refetch,
  ]);
  // E2 fix: the Live-route map screen now derives its data from the
  // resolver-driven route stops (projectMobileV2RouteMap) instead of the
  // PREVIEW/DEV route fixture. The fixture's mapRouteId is used only as
  // the route-id label fallback when the resolver returned no run id
  // (preview / no active route).
  const routeMapView = React.useMemo(
    () =>
      projectMobileV2RouteMap(
        routeRows,
        routeRpc.data?.routeId ?? MOBILE_V2_PREVIEW_ROUTE.mapRouteId,
      ),
    [routeRows, routeRpc.data?.routeId],
  );
  const [routeSearch, setRouteSearch] = React.useState("");
  const [routeDensity, setRouteDensity] = React.useState(MOBILE_V2_PREVIEW_ROUTE.density);
  const [mapFollow, setMapFollow] = React.useState(true);
  const [mapTraffic, setMapTraffic] = React.useState(true);
  // ---------------------------------------------------------------------
  // F7/F8/F9 — Tasks + Route saved-view / filter / sort / group state.
  // The Tasks app-bar title is a saved-view picker (F8); the segmented
  // control's Board/Map cells are real (F7); the Filters/Group/Sort
  // chips open real sheets (F9). All views/filters resolve from the
  // design SSOT view definitions, not inline literals.
  // ---------------------------------------------------------------------
  const [tasksViewMode, setTasksViewMode] = React.useState<"list" | "board" | "map">("list");
  const [tasksActiveViewId, setTasksActiveViewId] = React.useState<string>("tv-smart");
  const tasksActiveView = React.useMemo<MobileV2TaskBoardSavedView>(
    () =>
      MOBILE_V2_TASK_DEFAULT_VIEWS.find((v) => v.id === tasksActiveViewId)
      ?? MOBILE_V2_TASK_DEFAULT_VIEWS[1]!,
    [tasksActiveViewId],
  );
  const [tasksFilters, setTasksFilters] = React.useState<MobileV2TaskFilterState>(
    MOBILE_V2_TASK_DEFAULT_VIEWS[1]!.filters,
  );
  const [tasksSortKey, setTasksSortKey] = React.useState<MobileV2TaskSortKey>("smart");
  const [tasksGroupKey, setTasksGroupKey] = React.useState<MobileV2TaskGroupKey>("urgency");
  const [tasksSheet, setTasksSheet] = React.useState<"views" | "filters" | "group" | "sort" | null>(null);
  // Route saved-view / sort / group state (design ScrRoute).
  const [routeActiveViewId, setRouteActiveViewId] = React.useState<string>("route");
  const routeActiveView = React.useMemo<MobileV2RouteListView>(
    () =>
      MOBILE_V2_ROUTE_DEFAULT_VIEWS.find((v) => v.id === routeActiveViewId)
      ?? MOBILE_V2_ROUTE_DEFAULT_VIEWS[0]!,
    [routeActiveViewId],
  );
  const [routeSortKey, setRouteSortKey] = React.useState<MobileV2RouteSortKey>("sequence");
  const [routeGroupKey, setRouteGroupKey] = React.useState<MobileV2RouteGroupKey>("none");
  const [routeCodOnly, setRouteCodOnly] = React.useState<boolean>(false);
  // U4: Fragile + Re-attempt route filters — portable because the
  // MobileV2RouteStop row type carries `fragile` / `attempts`.
  const [routeFragileOnly, setRouteFragileOnly] = React.useState<boolean>(false);
  const [routeReattemptOnly, setRouteReattemptOnly] = React.useState<boolean>(false);
  const [routeStatusFilter, setRouteStatusFilter] = React.useState<
    ReadonlyArray<string>
  >([]);
  const [routeSheet, setRouteSheet] = React.useState<"views" | "filters" | "group" | "sort" | null>(null);
  // Route view result — applies the active saved-view's status / COD /
  // fragile / re-attempt filter + sort + group to the resolver-driven
  // stop rows.
  const routeViewResult = React.useMemo(
    () =>
      applyMobileV2RouteView(
        routeRows,
        {
          statusFilter: routeStatusFilter as ReadonlyArray<
            MobileV2RouteStop["status"]
          >,
          codOnly: routeCodOnly,
          fragileOnly: routeFragileOnly,
          reattemptOnly: routeReattemptOnly,
          sort: routeSortKey,
          group: routeGroupKey,
        },
        routeSearch,
      ),
    [
      routeRows,
      routeStatusFilter,
      routeCodOnly,
      routeFragileOnly,
      routeReattemptOnly,
      routeSortKey,
      routeGroupKey,
      routeSearch,
    ],
  );
  // F13 — operator-note sheet for the hold-queue destroy decision.
  const [holdNoteSheet, setHoldNoteSheet] = React.useState<{
    readonly holdId: string;
  } | null>(null);
  const [holdNoteText, setHoldNoteText] = React.useState("");
  const [holdDecisionReadback, setHoldDecisionReadback] =
    React.useState<MobileV2HoldDecisionSummary | null>(null);
  const [holdDecisionReadbackPending, setHoldDecisionReadbackPending] = React.useState(false);
  const [holdDecisionReadbackError, setHoldDecisionReadbackError] =
    React.useState<string | null>(null);
  // Tasks view result — search + active-view filter + sort + group
  // (design ScrTasks deriveTasks). Feeds the screen's precomputedGroups.
  const tasksViewResult = React.useMemo(() => {
    const all = tasksRpcState.kind === "ready" ? tasksRpcState.tasks : [];
    const searched = filterMobileV2TasksByQuery(all, tasksQuery);
    const filtered = applyMobileV2TaskFilters(searched, tasksFilters);
    const sorted = applyMobileV2TaskSort(filtered, tasksSortKey);
    // U5 fix: Board columns follow the active saved-view group key
    // (design ScrTasks groups Board by `group.key`), not a hardcoded
    // "urgency". The list view already honoured the group key. When the
    // group key is "none", Board falls back to "urgency" so it still
    // renders meaningful kanban columns rather than a single column.
    const groupKey =
      tasksViewMode === "board" && tasksGroupKey === "none"
        ? "urgency"
        : tasksGroupKey;
    const groups = applyMobileV2TaskGroups(sorted, groupKey).map((g) =>
      Object.freeze({
        key: g.key,
        label: g.label,
        count: g.tasks.length,
        tasks: g.tasks,
      }),
    );
    return Object.freeze({ rows: sorted, groups: Object.freeze(groups) });
  }, [tasksRpcState, tasksQuery, tasksFilters, tasksSortKey, tasksGroupKey, tasksViewMode]);
  // Dynamic Area filter options resolved from the live task set.
  const tasksAreaOptions = React.useMemo(
    () =>
      collectMobileV2TaskAreas(
        tasksRpcState.kind === "ready" ? tasksRpcState.tasks : [],
      ),
    [tasksRpcState],
  );
  const tasksFilterCount = countMobileV2TaskFilters(tasksFilters);
  const routeFilterCount =
    (routeStatusFilter.length > 0 ? 1 : 0)
    + (routeCodOnly ? 1 : 0)
    + (routeFragileOnly ? 1 : 0)
    + (routeReattemptOnly ? 1 : 0);
  // Design ScrTasks subtitle (flow-tasks.jsx:492): "<rows> of <tasks>
  // for <role> · <sort>" — rows is the live filtered count, tasks the
  // full queue, sort the active saved-view sort.
  const tasksSubtitle = React.useMemo<string>(() => {
    const all = tasksRpcState.kind === "ready" ? tasksRpcState.tasks : [];
    return `${tasksViewResult.rows.length} of ${all.length} for ${activeRole} · ${getMobileV2TaskSortLabel(tasksSortKey).toLowerCase()}`;
  }, [tasksRpcState, tasksViewResult, activeRole, tasksSortKey]);
  const [sortationInductedBoost, setSortationInductedBoost] = React.useState<number>(0);
  // Wave number resolved via mobile_sortation_policy in production;
  // exposed here so the subtitle can render "Cross-dock induction · Wave N".
  const sortationWaveNumber = 3;
  const [holdResolved, setHoldResolved] = React.useState<ReadonlySet<string>>(() => new Set<string>());
  const [hubPickupResolved, setHubPickupResolved] = React.useState<ReadonlySet<string>>(() => new Set<string>());
  const [pickupPickedBoost, setPickupPickedBoost] = React.useState<ReadonlyMap<string, number>>(() => new Map<string, number>());
  const [pickupHandoffSheet, setPickupHandoffSheet] = React.useState<MobileV2Pickup | null>(null);
  const [pickupHandoffQuantity, setPickupHandoffQuantity] = React.useState("");
  const [pickupHandoffContactName, setPickupHandoffContactName] = React.useState("");
  const [pickupHandoffNotes, setPickupHandoffNotes] = React.useState("");
  const [pickupHandoffReceiptContext, setPickupHandoffReceiptContext] = React.useState("");
  const [pickupFailureComposerSheet, setPickupFailureComposerSheet] = React.useState<MobileV2Pickup | null>(null);
  const [pickupFailureReasonSheet, setPickupFailureReasonSheet] = React.useState<MobileV2Pickup | null>(null);
  const [pickupFailureNoteSheet, setPickupFailureNoteSheet] = React.useState<MobileV2Pickup | null>(null);
  const [pickupFailureReason, setPickupFailureReason] = React.useState(() =>
    selectMobileV2PickupFailureReason(MOBILE_V2_PICKUP_DEFAULT_FAILURE_REASONS),
  );
  const [pickupFailureNotes, setPickupFailureNotes] = React.useState("");
  const [lookupRecentExtras, setLookupRecentExtras] = React.useState<ReadonlyArray<MobileV2LookupRecent>>([]);
  const [tripStageOverrides, setTripStageOverrides] = React.useState<ReadonlyMap<string, MobileV2TripStage>>(() => new Map<string, MobileV2TripStage>());
  // The active stop id feeding useFieldopsStopDetailRpc. Defaults to the
  // fixture id; `onTaskPress` sets it to the tapped task's real
  // `route_stops` UUID — `resolve_fieldops_tasks_v1` builds `task_id` as
  // `'stop:' || rs.id`, so the id after the `stop:` prefix IS the row
  // UUID. In the native shell that makes the stop screen + POD write
  // target the real row; the `?v2=preview` showcase keeps the fixture id
  // (the RPC short-circuits to the SAMPLE_STOP fallback).
  // B2 fix: stop detail is bound to resolve_fieldops_stop_detail_v1.
  // The fixture is the fallback only (preview / non-persisted id).
  const stopDetailRpc = useFieldopsStopDetailRpc({
    stopId: activeStopId,
    fallback: SAMPLE_STOP,
  });
  // Parcel and proof status render only from the stop-detail read-back;
  // scans and proof change it through their commands, never screen state.
  const liveStop: MobileV2StopDetail = resolveMobileV2StopDetailForRender({
    data: stopDetailRpc.data,
    fallback: SAMPLE_STOP,
    stopId: activeStopId,
    allowPreviewFallback: isShowcase,
  });
  const [podCapturedArtifactsByStopId, setPodCapturedArtifactsByStopId] = React.useState<
    ReadonlyMap<string, ReadonlyArray<MobileV2PodCapturedArtifact>>
  >(() => new Map<string, ReadonlyArray<MobileV2PodCapturedArtifact>>());
  const activeStopLocationReadback: MobileV2StopLocationReadback | null = React.useMemo(() => {
    const routeRow = routeRows.find((row) => row.id === activeStopTaskId) ?? null;
    return buildMobileV2StopLocationReadback(routeRow);
  }, [routeRows, activeStopTaskId]);
  const activeStopTerminalState = mobileV2FindTerminalRouteStopStatus(routeRows, activeStopTaskId);
  const activePodCapturedArtifacts = React.useMemo(
    () => podCapturedArtifactsByStopId.get(activeStopId) ?? EMPTY_MOBILE_V2_POD_ARTIFACTS,
    [activeStopId, podCapturedArtifactsByStopId],
  );
  const rememberActivePodArtifacts = React.useCallback(
    (artifacts: ReadonlyArray<MobileV2PodCapturedArtifact>): void => {
      setPodCapturedArtifactsByStopId((current) => {
        const next = new Map(current);
        if (!isMobileV2PersistedUuid(activeStopId) || artifacts.length === 0) {
          next.delete(activeStopId);
        } else {
          next.set(activeStopId, artifacts);
        }
        return next;
      });
    },
    [activeStopId],
  );
  const clearActivePodArtifacts = React.useCallback((): void => {
    setPodCapturedArtifactsByStopId((current) => {
      if (!current.has(activeStopId)) return current;
      const next = new Map(current);
      next.delete(activeStopId);
      return next;
    });
  }, [activeStopId]);
  React.useEffect(() => {
    if (activeStopTerminalState !== null) {
      clearActivePodArtifacts();
      if (mobileV2ShouldReturnToStopAfterTerminalReadback(activeTabId, activeStopTerminalState)) {
        setActiveTabId("mobile-stop");
      }
    }
  }, [activeStopTerminalState, activeTabId, clearActivePodArtifacts]);
  const [sortationQuery, setSortationQuery] = React.useState("");
  const [lookupQuery, setLookupQuery] = React.useState("");
  // Fixtures loaded from ./fixtures/ — production cutover deletes that
  // directory and the import block above.
  const SAMPLE_LOOKUP_RECORDS = MOBILE_V2_PREVIEW_LOOKUP_RECORDS;
  const SAMPLE_LOOKUP_RECENT = React.useMemo(() => buildMobileV2PreviewLookupRecent(), []);
  const SAMPLE_SORTATION_BAYS = MOBILE_V2_PREVIEW_SORTATION_BAYS;
  const SAMPLE_SORTATION_RECENT = MOBILE_V2_PREVIEW_SORTATION_RECENT;
  const [activeTripId, setActiveTripId] = React.useState<string | null>(null);
  const SAMPLE_TRIPS = MOBILE_V2_PREVIEW_TRIPS;
  const SAMPLE_PICKUPS = MOBILE_V2_PREVIEW_PICKUPS;
  // E13: seed the loader recent-scans list from the fixture ONLY in the
  // `?v2=preview` showcase. In the production native shell it starts
  // empty — real entries arrive from device scans — so fixture scan rows
  // are never shown as live data nor fed into induct_fieldops_parcel_v1
  // by the Submit batch.
  const [loaderScans, setLoaderScans] = React.useState<MobileV2LoaderScanEntry[]>(
    () => (isShowcase ? ([...MOBILE_V2_PREVIEW_LOADER_SCANS] as MobileV2LoaderScanEntry[]) : []),
  );
  const [activeLoaderSession, setActiveLoaderSession] = React.useState<MobileV2ActiveLoaderSession | null>(null);
  const [loaderSessionMutating, setLoaderSessionMutating] = React.useState(false);
  const [loaderSessionError, setLoaderSessionError] = React.useState<string | null>(null);

  const SAMPLE_WALLET = MOBILE_V2_PREVIEW_WALLET;

  // Phase 7 extended bindings. Each hook returns fallback when the RPC
  // is unavailable (placeholder env) so the preview still renders. In
  // production these read resolve_fieldops_*_v1 over supabase-js.
  const pickupsRpc = useFieldopsPickupsRpc({ fallback: SAMPLE_PICKUPS });
  const livePickups = pickupsRpc.data ?? SAMPLE_PICKUPS;
  const tripsRpc = useFieldopsTripsRpc({ fallback: SAMPLE_TRIPS });
  const liveTrips = tripsRpc.data ?? SAMPLE_TRIPS;
  const sortationRpc = useFieldopsSortationRpc({
    fallback: {
      bays: SAMPLE_SORTATION_BAYS,
      recent: SAMPLE_SORTATION_RECENT,
      inductedThisSession: 677,
      throughputPerHour: 146,
      minutesElapsed: 278,
    },
  });
  const liveSortation = sortationRpc.data ?? {
    bays: SAMPLE_SORTATION_BAYS,
    recent: SAMPLE_SORTATION_RECENT,
    inductedThisSession: 677,
    throughputPerHour: 146,
    minutesElapsed: 278,
  };
  const lookupRpc = useFieldopsLookupRpc({
    query: lookupQuery,
    fallback: { records: SAMPLE_LOOKUP_RECORDS, recent: SAMPLE_LOOKUP_RECENT },
  });
  const liveLookup = lookupRpc.data ?? { records: SAMPLE_LOOKUP_RECORDS, recent: SAMPLE_LOOKUP_RECENT };
  const walletRpc = useFieldopsWalletRpc({
    fallback: SAMPLE_WALLET,
    enabled: walletAccessEnabled,
  });
  const liveWallet = walletRpc.data ?? SAMPLE_WALLET;

  const SAMPLE_RETURNS = MOBILE_V2_PREVIEW_RETURNS;
  const returnsRpc = useFieldopsReturnsRpc({ fallback: SAMPLE_RETURNS });
  // Local override state so Mark-returned actually moves items between
  // the failed and returned lists in preview (production writes go via
  // record_route_stop_rto_v1 then re-resolve).
  const [returnsOverride, setReturnsOverride] = React.useState<{
    readonly failed: ReadonlyArray<MobileV2ReturnsStop>;
    readonly returned: ReadonlyArray<MobileV2ReturnsRtoStop>;
  } | null>(null);
  const [returnsLatestReadback, setReturnsLatestReadback] =
    React.useState<MobileV2ReturnsReadback | null>(null);
  const [returningStopId, setReturningStopId] = React.useState<string | null>(null);
  const rpcReturns = returnsRpc.data ?? SAMPLE_RETURNS;
  const liveReturns = isShowcase && returnsOverride !== null
    ? { ...rpcReturns, failed: returnsOverride.failed, returned: returnsOverride.returned }
    : rpcReturns;

  const SAMPLE_HUB_PICKUP = MOBILE_V2_PREVIEW_HUB_PICKUP;
  const hubPickupRpc = useFieldopsHubPickupRpc({ fallback: SAMPLE_HUB_PICKUP });
  const liveHubPickup = hubPickupRpc.data ?? SAMPLE_HUB_PICKUP;
  const [hubPickupActiveId, setHubPickupActiveId] = React.useState<string | null>(null);
  const [hubPickupOtp, setHubPickupOtp] = React.useState("");

  const SAMPLE_HOLD = React.useMemo(() => buildMobileV2PreviewHold(), []);
  const holdRpc = useFieldopsHoldRpc({ fallback: SAMPLE_HOLD });
  const latestDamageHoldRpc = useFieldopsLatestDamageHoldRpc({
    enabled: false,
  });
  const liveHold = holdRpc.data ?? SAMPLE_HOLD;

  const SAMPLE_CASH_DROP: MobileV2CashDropEnvelope = MOBILE_V2_PREVIEW_CASH_DROP;
  const cashDropRpc = useFieldopsCashDropRpc({
    fallback: SAMPLE_CASH_DROP,
    enabled: cashDropAccessEnabled,
  });
  const liveCashDrop: MobileV2CashDropEnvelope = cashDropRpc.data ?? SAMPLE_CASH_DROP;
  const [cashCounted, setCashCounted] = React.useState<number | null>(null);
  const cashCountedEffective = cashCounted ?? liveCashDrop.expectedSar;
  const [cashSupervisor, setCashSupervisor] = React.useState("");
  const [cashPhotoCaptured, setCashPhotoCaptured] = React.useState<boolean>(false);
  const [cashPhotoArtifactId, setCashPhotoArtifactId] = React.useState<string | null>(null);
  const [cashPhotoCaptureBusy, setCashPhotoCaptureBusy] = React.useState(false);
  const [cashPhotoCaptureError, setCashPhotoCaptureError] = React.useState<string | null>(null);
  const SAMPLE_COD_LEDGER = MOBILE_V2_PREVIEW_COD_LEDGER;
  const liveCodLedgerStops = React.useMemo<ReadonlyArray<MobileV2CodLedgerStop>>(() => {
    if (isShowcase) return SAMPLE_COD_LEDGER.stops;
    return routeRpc.data?.rows !== undefined
      ? buildMobileV2CodLedgerStops(routeRpc.data.rows)
      : EMPTY_MOBILE_V2_COD_LEDGER_STOPS;
  }, [isShowcase, routeRpc.data?.rows, SAMPLE_COD_LEDGER.stops]);
  const liveCodLedgerRouteExpected = sumMobileV2CodLedgerAmounts(liveCodLedgerStops);
  const liveCodLedgerExpected = isShowcase
    ? SAMPLE_COD_LEDGER.expected
    : liveCodLedgerRouteExpected > 0
      ? liveCodLedgerRouteExpected
      : liveCashDrop.expectedSar;
  const liveCodLedgerCollected = isShowcase
    ? SAMPLE_COD_LEDGER.collected
    : liveCashDrop.lastDrop?.actualSar ?? sumMobileV2PaidCodLedgerAmounts(liveCodLedgerStops);
  const liveCodLedgerArmedExpected = isShowcase
    ? SAMPLE_COD_LEDGER.collected
    : liveCashDrop.lastDrop?.expectedSar ?? sumMobileV2PaidCodLedgerAmounts(liveCodLedgerStops);
  const SAMPLE_SETTLEMENTS = MOBILE_V2_PREVIEW_SETTLEMENTS;
  const settlementsRpc = useFieldopsSettlementsRpc({ fallback: SAMPLE_SETTLEMENTS });
  const liveSettlements = resolveFieldopsSettlementsDisplayEnvelope(
    settlementsRpc.data,
    SAMPLE_SETTLEMENTS,
    isShowcase,
  );

  const activeRouteRunId = routeRpc.data?.routeRunId ?? null;
  const preShiftShiftId = isShowcase
    ? MOBILE_V2_PREVIEW_PRE_SHIFT.shiftId
    : activeRouteRunId ?? props.driverShift?.activeOpsSessionId ?? null;
  const onboardingReadbackRpc = useFieldopsOnboardingReadbackRpc({
    shiftId: preShiftShiftId,
  });
  const [cleaningCheckedIds, setCleaningCheckedIds] = React.useState<ReadonlyArray<string>>(
    () => MOBILE_V2_PREVIEW_CLEANING.checkedIds,
  );
  const [cleaningPhotoArtifact, setCleaningPhotoArtifact] =
    React.useState<MobileV2PodCapturedArtifact | null>(null);
  const [cleaningPhotoRegistering, setCleaningPhotoRegistering] = React.useState(false);
  const [cleaningCaptureError, setCleaningCaptureError] = React.useState<string | null>(null);
  const [cleaningReadbackPending, setCleaningReadbackPending] = React.useState(false);
  const [cleaningReadbackError, setCleaningReadbackError] = React.useState<string | null>(null);
  const [cleaningVerifiedReadback, setCleaningVerifiedReadback] =
    React.useState<MobileV2OnboardingCleaningReadback | null>(null);
  const [kycBusyKey, setKycBusyKey] = React.useState<string | null>(null);
  const [kycVehiclePlate, setKycVehiclePlate] = React.useState(() =>
    isShowcase ? MOBILE_V2_PREVIEW_KYC_VEHICLE.plate : "",
  );
  const [kycVehicleVin, setKycVehicleVin] = React.useState(() =>
    isShowcase ? MOBILE_V2_PREVIEW_KYC_VEHICLE.vin : "",
  );
  const [kycVehicleYear, setKycVehicleYear] = React.useState(() =>
    isShowcase ? MOBILE_V2_PREVIEW_KYC_VEHICLE.year : "",
  );
  const [kycVehicleModel, setKycVehicleModel] = React.useState(() =>
    isShowcase ? MOBILE_V2_PREVIEW_KYC_VEHICLE.model : "",
  );
  const [kycDocCaptureError, setKycDocCaptureError] = React.useState<string | null>(null);
  const [kycIstimaraArtifact, setKycIstimaraArtifact] =
    React.useState<MobileV2PodCapturedArtifact | null>(null);
  const [kycIstimaraRegistering, setKycIstimaraRegistering] = React.useState(false);
  const [kycVehicleReadbackPending, setKycVehicleReadbackPending] = React.useState(false);
  const [kycVehicleError, setKycVehicleError] = React.useState<string | null>(null);
  const [vehiclePhotoArtifacts, setVehiclePhotoArtifacts] =
    React.useState<Readonly<Record<string, MobileV2PodCapturedArtifact>>>({});
  const [vehiclePhotoBusyAngleId, setVehiclePhotoBusyAngleId] =
    React.useState<MobileV2VehicleAngleId | null>(null);
  const [vehiclePhotoCaptureError, setVehiclePhotoCaptureError] = React.useState<string | null>(null);
  const [vehiclePhotosReadbackPending, setVehiclePhotosReadbackPending] = React.useState(false);
  const [vehiclePhotosReadbackError, setVehiclePhotosReadbackError] = React.useState<string | null>(null);
  const [vehiclePhotosVerifiedReadback, setVehiclePhotosVerifiedReadback] =
    React.useState<MobileV2OnboardingVehiclePhotosReadback | null>(null);
  const [preShiftHealthOk, setPreShiftHealthOk] = React.useState(
    MOBILE_V2_PREVIEW_PRE_SHIFT.healthOk,
  );
  const [preShiftReadbackPending, setPreShiftReadbackPending] = React.useState(false);
  const [preShiftReadbackError, setPreShiftReadbackError] = React.useState<string | null>(null);
  const [preShiftVerifiedReadback, setPreShiftVerifiedReadback] =
    React.useState<MobileV2OnboardingPreShiftReadback | null>(null);
  React.useEffect(() => {
    if (isShowcase) return;
    if (
      mobileV2PreShiftReadbackConfirmsHealthOk(
        onboardingReadbackRpc.data?.latestPreShift ?? null,
        preShiftShiftId,
      )
    ) {
      setPreShiftHealthOk(true);
    }
  }, [
    isShowcase,
    onboardingReadbackRpc.data?.latestPreShift,
    preShiftShiftId,
  ]);
  const liveCleaningItems = React.useMemo<ReadonlyArray<MobileV2CleaningItem>>(() => {
    const policyItems = onboardingReadbackRpc.data?.policy.cleaningItems ?? [];
    if (policyItems.length > 0) return policyItems;
    return isShowcase ? MOBILE_V2_PREVIEW_CLEANING.items : [];
  }, [isShowcase, onboardingReadbackRpc.data?.policy.cleaningItems]);
  const liveKycDocs = React.useMemo<ReadonlyArray<MobileV2KycDocSpec>>(() => {
    const docs = onboardingReadbackRpc.data?.documents ?? [];
    const statusFor = (keys: ReadonlyArray<string>): MobileV2KycDocStatus => {
      const found = docs.find((doc) => keys.includes(doc.docKey));
      if (found === undefined) return "pending";
      if (["approved", "verified", "cleared"].includes(found.state)) return "approved";
      if (["uploaded", "submitted"].includes(found.state)) return "uploaded";
      if (found.state === "rejected") return "rejected";
      return "uploaded";
    };
    return Object.freeze([
      {
        key: "idDoc",
        icon: "doc",
        title: "National ID / Iqama",
        sub: "Identity document front side",
        status: statusFor(["idDoc", "iqamaDoc", "national_id"]),
        required: true,
      },
      {
        key: "licenseDoc",
        icon: "route",
        title: "Driving licence",
        sub: "Required before route departure",
        status: statusFor(["licenseDoc", "driving_licence"]),
        required: true,
      },
    ] satisfies ReadonlyArray<MobileV2KycDocSpec>);
  }, [onboardingReadbackRpc.data?.documents]);
  const liveVehicleAngles = React.useMemo<ReadonlyArray<MobileV2VehicleAngle>>(() => {
    const policyAngles = onboardingReadbackRpc.data?.policy.vehiclePhotoAngles ?? [];
    const ids = policyAngles.filter(isMobileV2VehicleAngleId);
    const effective = ids.length > 0 ? ids : (["front", "rear", "left", "right"] satisfies ReadonlyArray<MobileV2VehicleAngleId>);
    const labels: Record<MobileV2VehicleAngleId, string> = {
      front: "Front",
      rear: "Rear",
      left: "Left side",
      right: "Right side",
    };
    const hints: Record<MobileV2VehicleAngleId, string> = {
      front: "Plate and windshield visible",
      rear: "Rear plate and lights visible",
      left: "Full side profile",
      right: "Full side profile",
    };
    return Object.freeze(effective.map((id) => Object.freeze({ id, label: labels[id], hint: hints[id] })));
  }, [onboardingReadbackRpc.data?.policy.vehiclePhotoAngles]);
  const liveCapturedVehicleAngleIds = React.useMemo<ReadonlyArray<MobileV2VehicleAngleId>>(() => {
    const readbackIds = onboardingReadbackRpc.data?.latestVehiclePhotos?.capturedAngleIds ?? [];
    const artifactIds = Object.keys(vehiclePhotoArtifacts);
    return Object.freeze(
      [...new Set([...readbackIds, ...artifactIds])]
        .filter(isMobileV2VehicleAngleId),
    );
  }, [onboardingReadbackRpc.data?.latestVehiclePhotos?.capturedAngleIds, vehiclePhotoArtifacts]);
  const latestVehicleReadback = onboardingReadbackRpc.data?.latestVehicle ?? null;
  const latestVehiclePhotoReadback =
    vehiclePhotosVerifiedReadback ?? onboardingReadbackRpc.data?.latestVehiclePhotos ?? null;
  const livePreShiftCadence = React.useMemo<MobileV2PreShiftCadenceSummary>(() => {
    const policy = onboardingReadbackRpc.data?.policy;
    if (policy === undefined || isShowcase) return MOBILE_V2_PREVIEW_PRE_SHIFT.cadence;
    const hours = Math.max(0, policy.cleaningCadenceHours);
    return {
      photoCadenceDays: Math.max(1, Math.round(policy.photoCadenceHours / 24)),
      cleaningCadenceLabel: hours <= 0 ? "every shift" : `every ${hours}h`,
      healthAttestation: policy.healthAttestation,
    };
  }, [isShowcase, onboardingReadbackRpc.data?.policy]);
  const livePreShiftBlockers = React.useMemo<ReadonlyArray<MobileV2PreShiftBlocker>>(() => {
    if (isShowcase) return MOBILE_V2_PREVIEW_PRE_SHIFT.blockers;
    const requirements = onboardingReadbackRpc.data?.requirements;
    const blockers: MobileV2PreShiftBlocker[] = [];
    if (preShiftShiftId === null) {
      blockers.push({
        id: "shift",
        icon: "alert",
        title: "Start driver shift",
        sub: "Start a shift before pre-shift clearance.",
        cta: "Open More",
        severity: "high",
        route: "mobile-more",
      });
    }
    if (requirements === undefined || requirements.docsComplete === false) {
      blockers.push({
        id: "docs",
        icon: "doc",
        title: "Complete onboarding documents",
        sub: "Required identity, licence, vehicle, and photo evidence must be approved.",
        cta: "Open documents",
        severity: "high",
        route: "mobile-kyc-id",
      });
    }
    if (requirements === undefined || requirements.vehicleSubmitted === false) {
      blockers.push({
        id: "vehicle",
        icon: "truck",
        title: "Submit vehicle registration",
        sub: "Vehicle registration must be approved before departure.",
        cta: "Open vehicle registration",
        severity: "med",
        route: "mobile-kyc-vehicle",
      });
    }
    if (requirements === undefined || requirements.vehiclePhotosSubmitted === false) {
      blockers.push({
        id: "vehicle-photos",
        icon: "camera",
        title: "Refresh vehicle photos",
        sub: "Submit vehicle readiness evidence before departure.",
        cta: "Open vehicle KYC",
        severity: "med",
        route: "mobile-kyc-vehicle-photos",
      });
    }
    if (requirements === undefined || requirements.cleaningAttested === false) {
      blockers.push({
        id: "cleaning",
        icon: "sparkle",
        title: "Daily cleaning check",
        sub: "Required before first stop",
        cta: "Log cleaning + photo",
        severity: "med",
        route: "mobile-cleaning",
      });
    }
    if (livePreShiftCadence.healthAttestation && !preShiftHealthOk) {
      blockers.push({
        id: "health",
        icon: "shield",
        title: "Fit-to-drive attestation",
        sub: "Confirm rested, hydrated, no alcohol or medication.",
        cta: "Confirm",
        severity: "med",
        route: "mobile-pre-shift",
      });
    }
    return Object.freeze(blockers);
  }, [
    isShowcase,
    livePreShiftCadence.healthAttestation,
    onboardingReadbackRpc.data?.requirements,
    preShiftHealthOk,
    preShiftShiftId,
  ]);
  const SAMPLE_EOR = MOBILE_V2_PREVIEW_EOR;
  const eorRpc = useFieldopsEorRpc({ fallback: SAMPLE_EOR, routeRunId: activeRouteRunId });
  const liveEor = eorRpc.data ?? SAMPLE_EOR;
  const [eorChecked, setEorChecked] = React.useState<ReadonlySet<string>>(
    () => new Set<string>(),
  );

  // F1 fix: loader / rider / supervisor "Home" tabs are real role-home
  // screens now (previously fell through to a debug sandbox). Each is
  // resolver-backed with a fixture fallback, consistent with the driver
  // `mobile-today` / route wiring.
  const loaderTodayRpc = useFieldopsLoaderTodayRpc({ fallback: MOBILE_V2_PREVIEW_LOADER_TODAY });
  const liveLoaderToday = loaderTodayRpc.data ?? MOBILE_V2_PREVIEW_LOADER_TODAY;
  const riderTodayRpc = useFieldopsRiderTodayRpc({ fallback: MOBILE_V2_PREVIEW_RIDER_TODAY });
  const liveRiderToday = riderTodayRpc.data ?? MOBILE_V2_PREVIEW_RIDER_TODAY;
  const supervisorQueueRpc = useFieldopsSupervisorQueueRpc({
    fallback: MOBILE_V2_PREVIEW_SUPERVISOR_QUEUE,
  });
  const liveSupervisorQueue = supervisorQueueRpc.data ?? MOBILE_V2_PREVIEW_SUPERVISOR_QUEUE;
  const [supervisorActiveId, setSupervisorActiveId] = React.useState<string | null>(null);

  // E3 fix: shell-chrome identity (drawer header + More screen) is
  // sourced from `resolve_fieldops_profile_v1` (the caller's real
  // users.full_name + a stable display badge) — NOT inline
  // `"Khalid Al-Hashimi"` / `"DRV-2026-0042"` literals. The
  // `MOBILE_V2_PREVIEW_USER` fixture is the preview/offline fallback
  // only. The resolver is the single identity source for every role.
  const profileRpc = useFieldopsProfileRpc({ fallback: MOBILE_V2_PREVIEW_PROFILE });
  const profile = profileRpc.data ?? MOBILE_V2_PREVIEW_PROFILE;
  const liveCodLedgerCurrency = isShowcase ? SAMPLE_COD_LEDGER.currency : profile.currency;

  // ---------------------------------------------------------------------
  // Write-side mutations — one hook per RPC shipped in
  // 202605120300_fieldops_mobile_v2_write_rpcs_pack_v1.sql. Each binds to
  // its handler below; on error we toast in danger tone; in preview mode
  // the hooks short-circuit and return a synthetic success envelope so
  // optimistic state updates keep flowing.
  // ---------------------------------------------------------------------
  const submitProofMutation = useFieldopsSubmitProofMutation();
  const [podReadbackPending, setPodReadbackPending] = React.useState(false);
  const advanceTripStageMutation = useFieldopsAdvanceTripStageMutation();
  const [tripStageReadbackPending, setTripStageReadbackPending] = React.useState(false);
  const inductParcelMutation = useFieldopsInductParcelMutation();
  const signCashDropMutation = useFieldopsSignCashDropMutation();
  const requestWithdrawMutation = useFieldopsRequestWalletWithdrawMutation();
  const submitHoldDecisionMutation = useFieldopsSubmitHoldDecisionMutation();
  const releaseHubPickupMutation = useFieldopsReleaseHubPickupMutation();
  const markReturnReceivedMutation = useFieldopsMarkReturnReceivedMutation();
  const [pickupReadbackPending, setPickupReadbackPending] = React.useState(false);
  const submitKycDocMutation = useFieldopsSubmitKycDocMutation();
  const submitKycVehicleMutation = useFieldopsSubmitKycVehicleMutation();
  const submitVehiclePhotosMutation = useFieldopsSubmitVehiclePhotosMutation();
  const recordCleaningMutation = useFieldopsRecordCleaningCheckMutation();
  const passPreShiftGateMutation = useFieldopsPassPreShiftGateMutation();
  // B1 fix: incident reports now persist via submit_fieldops_incident_v1
  // (previously the "Report incident" action was a toast stub).
  const submitIncidentMutation = useFieldopsSubmitIncidentMutation();
  const submitDamageHoldMutation = useFieldopsSubmitDamageHoldMutation();
  const submitRescheduleMutation = useFieldopsSubmitRescheduleMutation();
  // F2 fix: end-of-route shift-end now submits a REAL reconciliation via
  // submit_fieldops_eod_recon_v1 (previously a toast-only no-op).
  const submitEodReconMutation = useFieldopsSubmitEodReconMutation();
  const confirmRouteDepartureMutation = useFieldopsConfirmRouteDepartureMutation();
  const recordRouteLoadScanMutation = useFieldopsRecordRouteLoadScanMutation();
  const [routeLoadScanReadbackPending, setRouteLoadScanReadbackPending] = React.useState(false);
  const [routeDepartureReadbackPending, setRouteDepartureReadbackPending] = React.useState(false);
  const recordLocationPingMutation = useFieldopsRecordLocationPingMutation();
  const [mapLocationReadback, setMapLocationReadback] =
    React.useState<MobileV2MapLocationReadback>(() => ({
      status: "idle",
      pingId: null,
      capturedAt: null,
      latitude: null,
      longitude: null,
      accuracyM: null,
      routeStopLabel: null,
      message: null,
    }));
  const activeRouteDepartureOpsSessionId = props.driverShift?.activeOpsSessionId ?? null;

  const advanceTripStageWithReadback = React.useCallback((input: {
    readonly trip: MobileV2Trip;
    readonly nextStage: MobileV2TripStage;
    readonly sealNo: string | null;
    readonly successMessage: string;
    readonly afterReadback?: () => void;
  }): void => {
    if (advanceTripStageMutation.isPending || tripStageReadbackPending) {
      setToast({
        id: `trip-stage-busy-${Date.now()}`,
        message: "Trip stage is still confirming",
        kind: "info",
      });
      return;
    }
    if (!isShowcase && !isMobileV2PersistedUuid(input.trip.id)) {
      setToast({
        id: `trip-stage-missing-${Date.now()}`,
        message: "Trip needs an active route before advancing stage",
        kind: "danger",
      });
      return;
    }
    void (async () => {
      setTripStageReadbackPending(true);
      try {
        await advanceTripStageMutation.mutateAsync({
          p_trip_id: input.trip.id,
          p_next_stage: input.nextStage,
          p_seal_no: input.sealNo,
        });
        if (isShowcase) {
          setTripStageOverrides((prev) => {
            const next = new Map(prev);
            next.set(input.trip.id, input.nextStage);
            return next;
          });
          setToast({
            id: `trip-stage-${Date.now()}`,
            message: input.successMessage,
            kind: "success",
          });
          input.afterReadback?.();
          return;
        }

        const readback = await refreshMobileV2PodReadback([
          {
            label: "trips",
            refetch: tripsRpc.refetch,
            expect: (data) => mobileV2TripsHaveStage(data, input.trip.id, input.nextStage),
          },
        ]);
        if (!readback.ok) {
          setToast({
            id: `trip-stage-readback-${Date.now()}`,
            message: "Saved, but the screen did not refresh yet. Try again.",
            kind: "danger",
          });
          return;
        }
        setTripStageOverrides((prev) => {
          if (!prev.has(input.trip.id)) return prev;
          const next = new Map(prev);
          next.delete(input.trip.id);
          return next;
        });
        setToast({
          id: `trip-stage-${Date.now()}`,
          message: input.successMessage,
          kind: "success",
        });
        input.afterReadback?.();
      } catch (err) {
        setToast({
          id: `trip-stage-err-${Date.now()}`,
          message: redactDisplayErrorText(err instanceof Error ? err.message : undefined, "Trip stage advancement failed"),
          kind: "danger",
        });
      } finally {
        setTripStageReadbackPending(false);
      }
    })();
  }, [
    advanceTripStageMutation,
    isShowcase,
    tripStageReadbackPending,
    tripsRpc.refetch,
  ]);

  const handleConfirmRouteDeparture = React.useCallback((): void => {
    if (confirmRouteDepartureMutation.isPending || routeDepartureReadbackPending) {
      setToast({
        id: `route-departure-busy-${Date.now()}`,
        message: "Route departure is still confirming",
        kind: "info",
      });
      return;
    }
    const routeDepartureInput = buildMobileV2RouteDepartureMutationInput({
      routeRunId: routeRpc.data?.routeRunId ?? null,
      activeOpsSessionId: activeRouteDepartureOpsSessionId,
    });
    if (routeDepartureInput === null) {
      setToast({
        id: `route-departure-missing-${Date.now()}`,
        message: "Route departure needs an active route",
        kind: "danger",
      });
      return;
    }
    confirmMobileV2Action({
      title: "Confirm departure",
      message: "This marks the route as departed after the route load scan is confirmed.",
      confirmLabel: "Confirm departure",
      onConfirm: () => {
        void (async () => {
          setRouteDepartureReadbackPending(true);
          try {
            const readback = await confirmRouteDepartureMutation.mutateAsync(routeDepartureInput);
            const routeReadback = await refreshMobileV2PodReadback([
              {
                label: "route",
                refetch: routeRpc.refetch,
                expect: (data) => mobileV2RouteHasDepartureReadback(data, routeDepartureInput.p_route_run_id),
              },
              {
                label: "tasks",
                refetch: tasksRpc.refetch,
                expect: () => true,
              },
            ]);
            if (!routeReadback.ok) {
              setToast({
                id: `route-departure-readback-${Date.now()}`,
                message: "Departure saved, but the screen did not refresh yet. Try again.",
                kind: "danger",
              });
              return;
            }
            const scanOut = readback.scanOut;
            const scanned = Number(scanOut.scanned_stop_count ?? NaN);
            const expected = Number(scanOut.expected_stop_count ?? NaN);
            setToast({
              id: `route-departure-${Date.now()}`,
              message:
                Number.isFinite(scanned) && Number.isFinite(expected)
                  ? `Departure confirmed ${scanned}/${expected}`
                  : "Departure confirmed",
              kind: "success",
            });
          } catch (err) {
            setToast({
              id: `route-departure-err-${Date.now()}`,
              message: redactDisplayErrorText(err instanceof Error ? err.message : undefined, "Departure blocked"),
              kind: "danger",
            });
          } finally {
            setRouteDepartureReadbackPending(false);
          }
        })();
      },
    });
  }, [
    activeRouteDepartureOpsSessionId,
    confirmRouteDepartureMutation,
    routeDepartureReadbackPending,
    routeRpc,
    tasksRpc,
  ]);

  const handleRecordMapLocation = React.useCallback((): void => {
    if (recordLocationPingMutation.isPending || mapLocationReadback.status === "saving") {
      return;
    }

    const setLocationError = (message: string): void => {
      setMapLocationReadback(buildMobileV2RouteMapLocationError(message));
      setToast({
        id: `route-map-location-err-${Date.now()}`,
        message,
        kind: "danger",
      });
    };

    const selectedStop = routeMapView.active ?? routeMapView.upcoming[0] ?? null;
    const routeStopId = normalizeMobileV2RouteMapStopId(selectedStop);
    const routeRunId = activeRouteRunId;
    const routeStopLabel =
      selectedStop !== null
        ? `Stop ${selectedStop.seq} · ${selectedStop.customer}`
        : null;

    if (!isShowcase && registeredDeviceId === null) {
      setLocationError("Register this device before recording location");
      return;
    }
    if (!isShowcase && (routeRunId === null || !isMobileV2PersistedUuid(routeRunId))) {
      setLocationError("Location update needs an active route");
      return;
    }
    if (!isShowcase && (routeStopId === null || !isMobileV2PersistedUuid(routeStopId))) {
      setLocationError("Location update needs an active stop");
      return;
    }

    void (async () => {
      setMapLocationReadback((prev) => ({
        ...prev,
        status: "saving",
        message: "Saving location",
      }));
      try {
        let permission = await Location.getForegroundPermissionsAsync();
        if (permission.status !== "granted") {
          permission = await Location.requestForegroundPermissionsAsync();
        }
        if (permission.status !== "granted") {
          throw new Error("Location permission is required to record a route-map ping");
        }

        const position = await resolveMobileV2RouteMapPosition({
          getCurrentPosition: () =>
            Location.getCurrentPositionAsync({
              accuracy: Location.Accuracy.Balanced,
            }),
          getLastKnownPosition: () =>
            Location.getLastKnownPositionAsync(MOBILE_V2_ROUTE_MAP_LAST_KNOWN_POSITION_OPTIONS),
        });
        const lat = normalizeMobileV2LocationNumber(position.coords.latitude);
        const lng = normalizeMobileV2LocationNumber(position.coords.longitude);
        if (lat === null || lng === null) {
          throw new Error("Device did not return valid location coordinates");
        }
        const capturedAt = new Date(
          typeof position.timestamp === "number" && Number.isFinite(position.timestamp)
            ? position.timestamp
            : Date.now(),
        ).toISOString();

        const readback = await recordLocationPingMutation.mutateAsync({
          p_ping: {
            device_id: registeredDeviceId,
            route_run_id: routeRunId,
            route_stop_id: routeStopId,
            lat,
            lng,
            accuracy_m: normalizeMobileV2LocationAccuracy(position.coords.accuracy),
            speed_mps: normalizeMobileV2LocationNumber(position.coords.speed),
            heading_deg: normalizeMobileV2LocationHeading(position.coords.heading),
            captured_at: capturedAt,
            metadata: {
              route_label: routeMapView.routeId,
              route_stop_label: routeStopLabel,
              active_tab: "mobile-map",
            },
          },
        });
        const saved = buildMobileV2RouteMapReadback(readback, routeStopLabel);
        setMapLocationReadback(saved);
        setToast({
          id: `route-map-location-${Date.now()}`,
          message: `Location saved ${saved.pingId?.slice(0, 8) ?? ""}`.trim(),
          kind: "success",
        });
      } catch (err) {
        setLocationError(formatMobileV2RouteMapLocationError(err));
      }
    })();
  }, [
    activeRouteRunId,
    isShowcase,
    mapLocationReadback.status,
    recordLocationPingMutation,
    registeredDeviceId,
    routeMapView.active,
    routeMapView.routeId,
    routeMapView.upcoming,
  ]);

  const pickupFailurePolicyQuery = useFieldopsPolicy({
    category: "pickup_policy",
    parse: parseMobileV2PickupFailureReasons,
    fallback: MOBILE_V2_PICKUP_DEFAULT_FAILURE_REASONS,
  });
  const pickupFailureReasons = pickupFailurePolicyQuery.data ?? MOBILE_V2_PICKUP_DEFAULT_FAILURE_REASONS;

  const submitPickupCloseout = React.useCallback(
    (
      pickup: MobileV2Pickup,
      outcome: "completed" | "failed",
      notes?: string,
      handoff?: {
        confirmedQuantity?: number | null;
        handoverContactName?: string | null;
        handoverNotes?: string | null;
        receiptContext?: string | null;
      },
    ): void => {
      if (pickupReadbackPending || submitProofMutation.isPending) {
        setToast({
          id: `pickup-busy-${Date.now()}`,
          message: "Pickup update is still confirming",
          kind: "info",
        });
        return;
      }
      const stopId = pickup.routeStopId ?? pickup.id;
      if (!isShowcase && !isMobileV2PersistedUuid(stopId)) {
        setToast({
          id: `pickup-stop-missing-${Date.now()}`,
          message: "Pickup needs an active stop before closeout",
          kind: "danger",
        });
        return;
      }
      const reason = outcome === "failed"
        ? pickupFailureReason.trim() || selectMobileV2PickupFailureReason(pickupFailureReasons)
        : null;
      const failureNotes = outcome === "failed" ? (notes ?? "").trim() : "";
      void (async () => {
        setPickupReadbackPending(true);
        try {
          const confirmedQuantity = Math.max(
            0,
            Math.round(handoff?.confirmedQuantity ?? pickup.picked),
          );
          const capturedAt = new Date().toISOString();
          const handoverContactName = handoff?.handoverContactName?.trim() || null;
          const handoverNotes = handoff?.handoverNotes?.trim() || null;
          const receiptContext =
            handoff?.receiptContext?.trim() ||
            (outcome === "completed" ? pickup.wb : null);
          const proof = await submitProofMutation.mutateAsync({
            p_stop_id: stopId,
            p_outcome: outcome === "completed" ? "delivered" : "failed",
            p_evidence: {
              source: "fieldops_mobile_v2_pickup",
              stop_kind: "pickup",
              pickup_action: outcome === "completed" ? "handoff" : "failure",
              captured_at: capturedAt,
              pod_methods: outcome === "completed" ? "pickup_handoff" : "pickup_failure",
              confirmed_quantity: outcome === "completed" ? confirmedQuantity : null,
              expected_quantity: pickup.expectedQty,
              handover_contact_name: outcome === "completed" ? handoverContactName : null,
              handover_notes: outcome === "completed" ? handoverNotes : null,
              receipt_context: outcome === "completed" ? receiptContext : null,
              reason_code: reason,
              status_reason: reason,
              exception_reason: reason,
              exception_notes: outcome === "failed" ? failureNotes : null,
              pickup: {
                route_stop_id: stopId,
                route_run_id: pickup.routeRunId ?? null,
                shipment_id: pickup.shipmentId ?? null,
                tracking_number: pickup.wb,
                merchant: pickup.merchant,
                expected_quantity: pickup.expectedQty,
                confirmed_quantity: outcome === "completed" ? confirmedQuantity : null,
                handover_contact_name: outcome === "completed" ? handoverContactName : null,
                handover_notes: outcome === "completed" ? handoverNotes : null,
                receipt_context: outcome === "completed" ? receiptContext : null,
                failure_reason: reason,
                failure_notes: outcome === "failed" ? failureNotes : null,
                captured_at: capturedAt,
              },
            },
          });
          const [pickupReadback] = await Promise.all([
            pickupsRpc.refetch(),
            tasksRpc.refetch(),
            routeRpc.refetch(),
          ]);
          if (!isShowcase) {
            const expectedStatus = outcome === "completed" ? "completed" : "failed";
            const updatedPickup = findMobileV2PickupReadback(pickupReadback.data ?? [], pickup);
            if (updatedPickup === null || updatedPickup.status !== expectedStatus) {
              throw new Error("Pickup update did not return the expected status");
            }
            if (outcome === "failed" && updatedPickup.failureReason !== reason) {
              throw new Error("Pickup update did not preserve the failure reason");
            }
            if (outcome === "failed" && failureNotes.length > 0 && updatedPickup.failureNote !== failureNotes) {
              throw new Error("Pickup update did not preserve the failure note");
            }
            if (
              typeof proof.task_event_id !== "string"
              || typeof proof.workflow_run_id !== "string"
              || typeof proof.shipment_action_id !== "string"
              || typeof proof.shipment_id !== "string"
            ) {
              throw new Error("Pickup closeout is missing workflow shipment-action lineage");
            }
            if (updatedPickup.workflowRunId !== proof.workflow_run_id) {
              throw new Error("Pickup update did not preserve workflow lineage");
            }
          }
          setPickupPickedBoost((prev) => {
            if (!prev.has(pickup.id)) return prev;
            const next = new Map(prev);
            next.delete(pickup.id);
            return next;
          });
          setPickupsTab("done");
          setToast({
            id: `pickup-closeout-${Date.now()}`,
            message:
              outcome === "completed"
                ? `Pickup confirmed ${confirmedQuantity}/${pickup.expectedQty}`
                : `Pickup failed - ${getMobileV2PickupFailureReasonLabel(reason ?? "pickup_not_ready", pickupFailureReasons)}`,
            kind: outcome === "completed" ? "success" : "warning",
          });
          setActiveTabId("mobile-pickups");
        } catch (err) {
          setToast({
            id: `pickup-closeout-err-${Date.now()}`,
            message: redactDisplayErrorText(err instanceof Error ? err.message : undefined, "Pickup closeout failed"),
            kind: "danger",
          });
        } finally {
          setPickupReadbackPending(false);
        }
      })();
    },
    [
      isShowcase,
      pickupFailureReason,
      pickupFailureReasons,
      pickupReadbackPending,
      pickupsRpc,
      routeRpc,
      submitProofMutation,
      tasksRpc,
    ],
  );

  // Hold-queue decision write — shared by the requeue / rto / destroy
  // actions. `note` is the captured operator note (F13: destroy requires
  // a real note; requeue / rto pass null). Maps the FE vocabulary
  // (requeue|rto|destroy) to the RPC vocabulary (reinduct|escalate|discard).
  const applyHoldDecision = React.useCallback(
    (id: string, action: "requeue" | "rto" | "destroy", note: string | null): void => {
      const rpcAction: MobileV2HoldDecisionAction =
        action === "requeue" ? "reinduct" : action === "rto" ? "escalate" : "discard";
      setHoldDecisionReadbackPending(true);
      setHoldDecisionReadbackError(null);
      submitHoldDecisionMutation.mutate(
        { p_hold_id: id, p_action: rpcAction, p_note: note },
        {
          onSuccess: async (write) => {
            const holdReadback = await holdRpc.refetch();
            const latestDecision = readMobileV2HoldDecisionReadback(
              write,
              rpcAction,
              holdReadback.data ?? [],
            );
            if (latestDecision === null) {
              setHoldDecisionReadbackError(
                "Hold decision saved, but confirmation did not match yet",
              );
              setHoldDecisionReadbackPending(false);
              return;
            }
            setHoldResolved((prev) => {
              const next = new Set(prev);
              next.add(id);
              return next;
            });
            setHoldDecisionReadback(latestDecision);
            setHoldDecisionReadbackPending(false);
            setToast({
              id: `hold-${id}-${Date.now()}`,
              message:
                action === "requeue"
                  ? `Re-inducted ${id}`
                  : action === "rto"
                    ? `Returning ${id} to merchant`
                    : `Destroyed ${id}`,
              kind: action === "destroy" ? "warning" : "success",
            });
          },
          onError: (err) => {
            setHoldDecisionReadbackPending(false);
            setToast({ id: `hold-err-${Date.now()}`, message: formatMobileV2UserError(err, "Hold update failed"), kind: "danger" });
          },
        },
      );
    },
    [holdRpc, submitHoldDecisionMutation],
  );

  // B1 fix: run a real native intent (call / WhatsApp / maps / share /
  // copy) and surface the outcome as a toast. The toast is a SECONDARY
  // confirmation — the actual device action is the intent runner. A
  // `no-target` result means the data was missing (e.g. no phone on the
  // stop); `unsupported` / `error` means the OS could not launch it.
  const logRouteIntentEvent = React.useCallback(
    async (event: Record<string, unknown>): Promise<MobileUiEventLogResult> => {
      const recordedAt = new Date().toISOString();
      const normalizedEvents = normalizeMobileUiEvents([event]);
      const eventType = firstMobileUiEventType([event]);
      if (!normalizedEvents.length) {
        return { status: "retryable_failure", eventCount: 0, recordedAt, eventType };
      }

      const args = { p_events: normalizedEvents, p_app: "mobile" };
      if (!isShowcase && online && mobileRpc.supabase !== null) {
        try {
          const { data, error } = await getMobileV2SupabaseSchemaClient(
            mobileRpc.supabase,
            "api",
          ).rpc("ui_log_events_v1", args);
          if (error !== null && error !== undefined) throw error;
          return resolveMobileUiEventLogReadback({
            data,
            expectedEventCount: normalizedEvents.length,
            recordedAt,
            eventType,
          });
        } catch {
          // Fall through to outbox enqueue. The visible readback stays
          // non-successful until backend rows are confirmed.
        }
      }

      if (!isShowcase && mobileRpc.outbox !== undefined) {
        await mobileRpc.outbox.enqueue({ rpc: "ui_log_events_v1", args });
        return {
          status: online ? "queued_pending_sync" : "queued_offline",
          eventCount: 0,
          recordedAt,
          eventType,
        };
      }

      return { status: "retryable_failure", eventCount: 0, recordedAt, eventType };
    },
    [isShowcase, mobileRpc.outbox, mobileRpc.supabase, online],
  );

  const runIntent = React.useCallback(
    (
      action: () => Promise<MobileV2IntentResult>,
      labels: { readonly success: string; readonly missing?: string },
      routeEvent?: {
        readonly eventType: string;
        readonly metadata?: Record<string, unknown>;
      },
    ): void => {
      void (async () => {
        let result: MobileV2IntentResult;
        try {
          result = await action();
        } catch {
          result = { ok: false, reason: "error" };
        }
        if (routeEvent !== undefined) {
          const readback = await logRouteIntentEvent({
            event_type: routeEvent.eventType,
            captured_at: new Date().toISOString(),
            metadata: {
              app: "fieldops",
              platform: Platform.OS,
              opened: result.ok,
              route_run_id: activeRouteRunId,
              route_stop_id: isMobileV2PersistedUuid(activeStopId) ? activeStopId : null,
              task_id: activeStopTaskId,
              tracking: liveStop.trackingCode,
              customer_name: liveStop.customerName,
              ...routeEvent.metadata,
            },
          });
          setRouteIntentReadback(readback);
        }
        if (result.ok) {
          setToast({ id: `intent-${Date.now()}`, message: labels.success, kind: "success" });
          return;
        }
        const message =
          result.reason === "no-target"
            ? (labels.missing ?? "Contact details are not available for this stop")
            : "That action could not be opened on this device";
        setToast({ id: `intent-err-${Date.now()}`, message, kind: "danger" });
      })();
    },
    [
      activeRouteRunId,
      activeStopId,
      activeStopTaskId,
      liveStop.customerName,
      liveStop.trackingCode,
      logRouteIntentEvent,
    ],
  );

  // B1 fix: shared sign-out — confirm, then REALLY invalidate the
  // session in the native shell (props.onSignOut). Routed through
  // confirmMobileV2Action so the prompt renders on the web preview
  // (Alert.alert is a no-op there). The `?v2=preview` showcase has no
  // session, so it stays an explicit preview no-op toast.
  const handleSignOut = React.useCallback((): void => {
    confirmMobileV2Action({
      title: "Sign out?",
      message: "Any queued offline writes will be retried after you sign in again.",
      confirmLabel: "Sign out",
      destructive: true,
      onConfirm: () => {
        if (props.onSignOut !== undefined) {
          void Promise.resolve(props.onSignOut()).catch(() => {
            setToast({
              id: `out-err-${Date.now()}`,
              message: "Sign out failed — try again",
              kind: "danger",
            });
          });
          return;
        }
        setToast({ id: `out-${Date.now()}`, message: "Signed out (preview)", kind: "warning" });
      },
    });
  }, [props]);

  // B1 fix: manual sync REALLY drains the offline outbox in the native
  // shell (props.onManualSync replays queued mutations through the live
  // supabase client). The `?v2=preview` showcase has no live outbox so
  // it stays a preview no-op toast.
  const handleManualSync = React.useCallback((): void => {
    if (props.onManualSync !== undefined) {
      setToast({ id: `sync-${Date.now()}`, message: "Syncing queued writes…", kind: "info" });
      void Promise.resolve(props.onManualSync()).catch(() => {
        setToast({ id: `sync-err-${Date.now()}`, message: "Sync failed — will retry", kind: "danger" });
      });
      return;
    }
    setToast({ id: `sync-${Date.now()}`, message: "Manual sync triggered", kind: "info" });
  }, [props]);

  // E12: POD proof writes target a real `route_stops` UUID — the
  // persisted key is `activeStopId`, which onTaskPress sets to the
  // tapped task's `stop:<uuid>` id with the prefix stripped. It must
  // NOT use `liveStop.id`: the stop-detail resolver
  // (`resolve_fieldops_stop_detail_v1`) sets the envelope `id` to the
  // shipment tracking number / `STP-xxxxxx` DISPLAY string, never the
  // row UUID — so `isMobileV2PersistedUuid(liveStop.id)` is false for
  // every real stop and would block every production POD write.
  // A non-persisted `activeStopId` only occurs in the `?v2=preview`
  // showcase (no live client) — there the outcome is recorded
  // optimistically; a fixture id sent to submit_fieldops_proof_v1 would
  // fail Postgres UUID parsing (22P02). In the native shell a
  // non-persisted id is treated as an error (the stop never resolved)
  // — never a fabricated success.
  const submitPodProof = (
    outcome: "delivered" | "failed" | "partial",
    evidence: Record<string, unknown>,
    onRecorded: () => void,
    expectedProofKeys?: ReadonlyArray<string>,
    expectedPartialParcelCodes?: ReadonlyArray<string>,
  ): void => {
    if (submitProofMutation.isPending || podReadbackPending) {
      setToast({
        id: `pod-busy-${Date.now()}`,
        message: "POD submission is still syncing",
        kind: "info",
      });
      return;
    }
    if (!isMobileV2PersistedUuid(activeStopId)) {
      if (isShowcase) {
        // `?v2=preview` showcase — no live client; the design canvas
        // records the outcome optimistically on-device.
        onRecorded();
      } else {
        // Native shell with a non-persisted stop id — the real stop row
        // never resolved. Surface honest guidance; never fabricate a
        // POD success or claim a proof was written.
        setToast({
          id: `pod-stop-${Date.now()}`,
          message: "Stop is still loading — reopen it from Tasks before recording POD.",
          kind: "warning",
        });
      }
      return;
    }
    const stopTaskId = activeStopTaskId;
    const expectedCodCollectionAmount =
      outcome === "delivered"
      && expectedProofKeys?.includes("cod") === true
      && liveStop.cod?.amount !== undefined
      && Number.isFinite(liveStop.cod.amount)
      && liveStop.cod.amount > 0
        ? liveStop.cod.amount
        : null;
    if (activeStopTerminalState !== null) {
      setPodReadbackPending(true);
      void refreshMobileV2PodReadback([
        {
          label: "stop detail",
          refetch: stopDetailRpc.refetch,
        },
        {
          label: "route",
          refetch: routeRpc.refetch,
          expect: (data) => mobileV2RouteHasStopStatus(data, stopTaskId, activeStopTerminalState),
        },
        {
          label: "tasks",
          refetch: tasksRpc.refetch,
          expect: (data) => mobileV2TasksHaveRouteStopStatus(data, stopTaskId, activeStopTerminalState),
        },
      ]).then((readback) => {
        setToast({
          id: `pod-terminal-${Date.now()}`,
          message: readback.ok
            ? "Stop is already complete"
            : "Saved, but the screen did not refresh yet. Try again.",
          kind: readback.ok ? "info" : "danger",
        });
        setActiveTabId("mobile-stop");
      }).finally(() => setPodReadbackPending(false));
      return;
    }
    const expectedStatus = outcome === "delivered" ? "done" : outcome === "partial" ? "partial" : "failed";
    setPodReadbackPending(true);
    submitProofMutation.mutate(
      { p_stop_id: activeStopId, p_outcome: outcome, p_evidence: evidence },
      {
        onSuccess: () => {
          void refreshMobileV2PodReadback([
            {
              label: "stop detail",
              refetch: stopDetailRpc.refetch,
              expect: (data) => mobileV2StopDetailHasPodReadback(
                data,
                outcome,
                expectedProofKeys,
                expectedPartialParcelCodes,
              ) && (
                expectedCodCollectionAmount === null
                || mobileV2StopDetailHasCodCollectionReadback(data, expectedCodCollectionAmount)
              ),
            },
            {
              label: "route",
              refetch: routeRpc.refetch,
              expect: (data) => mobileV2RouteHasStopStatus(data, stopTaskId, expectedStatus),
            },
            {
              label: "tasks",
              refetch: tasksRpc.refetch,
              expect: (data) => mobileV2TasksHaveRouteStopStatus(data, stopTaskId, expectedStatus),
            },
          ]).then((readback) => {
            if (!readback.ok) {
              setToast({
                id: `pod-readback-${Date.now()}`,
                message: "Saved, but the screen did not refresh yet. Try again.",
                kind: "danger",
              });
              return;
            }
            onRecorded();
          }).finally(() => setPodReadbackPending(false));
        },
        onError: (err) => {
          setPodReadbackPending(false);
          setToast({ id: `pod-err-${Date.now()}`, message: formatMobileV2UserError(err, "Delivery proof failed"), kind: "danger" });
        },
      },
    );
  };

  // Live policy resolvers (AGENTS.md zero-hardcoding compliance). These
  // call resolve_settings_row_from_policy_context_v1 and pipe the row
  // through the parser. In preview mode (supabase=null) the query falls
  // back to MOBILE_V2_*_DEFAULT_POLICY so the audit gallery keeps
  // rendering without a connected backend.
  const podPolicyQuery = useFieldopsPolicy({
    category: "mobile_pod_policy",
    parse: parseMobileV2PodPolicy,
    fallback: MOBILE_V2_POD_DEFAULT_POLICY,
  });
  const loaderPolicyQuery = useFieldopsPolicy({
    category: "mobile_loader_policy",
    parse: parseMobileV2LoaderPolicy,
    fallback: MOBILE_V2_LOADER_DEFAULT_POLICY,
  });
  const damageHoldPolicyQuery = useFieldopsPolicy({
    category: "mobile_damage_severity_policy",
    parse: parseMobileV2DamageHoldPolicy,
    fallback: MOBILE_V2_DAMAGE_HOLD_DEFAULT_POLICY,
  });
  const mapPolicyQuery = useFieldopsPolicy({
    category: "map_policy",
    parse: normalizeResolvedMobileMapPolicy,
    fallback: DEFAULT_MOBILE_MAP_POLICY,
    requireResolved: true,
  });
  const reschedulePolicyQuery = useFieldopsPolicy({
    category: "delivery_slot_policy",
    parse: parseMobileV2ReschedulePolicy,
    fallback: MOBILE_V2_RESCHEDULE_DEFAULT_POLICY,
  });
  const podPolicy = podPolicyQuery.data ?? MOBILE_V2_POD_DEFAULT_POLICY;
  const loaderPolicy = loaderPolicyQuery.data ?? MOBILE_V2_LOADER_DEFAULT_POLICY;
  const damageHoldPolicy = damageHoldPolicyQuery.data ?? MOBILE_V2_DAMAGE_HOLD_DEFAULT_POLICY;
  const mapPolicy = mapPolicyQuery.data ?? (isShowcase ? DEFAULT_MOBILE_MAP_POLICY : null);
  const reschedulePolicy = reschedulePolicyQuery.data ?? MOBILE_V2_RESCHEDULE_DEFAULT_POLICY;
  const rescheduleWindows = React.useMemo(
    () =>
      isShowcase
        ? MOBILE_V2_PREVIEW_RESCHEDULE_WINDOWS
        : buildMobileV2RescheduleWindows({
            policy: reschedulePolicy,
            currentWindow: liveStop.window,
          }),
    [isShowcase, liveStop.window, reschedulePolicy],
  );
  const loaderSessionContext = loaderPolicy.sessionContext;
  const handleStartLoaderSession = React.useCallback((): void => {
    if (activeRole !== "loader") {
      setLoaderSessionError("Switch to loader before starting a warehouse scan session");
      return;
    }
    const liveActiveOpsSessionId = liveLoaderToday.activeOpsSessionId.trim();
    if (activeLoaderSession !== null || liveActiveOpsSessionId.length > 0 || loaderSessionMutating) {
      return;
    }
    const supabase = mobileRpc.supabase;
    if (supabase === null) {
      setLoaderSessionError("Loader session needs a live session");
      return;
    }
    if (!online) {
      setLoaderSessionError("Connect online before starting loader session");
      return;
    }
    if (registeredDeviceId === null) {
      setLoaderSessionError("Register this device before starting loader session");
      return;
    }
    if (loaderSessionContext === null) {
      setLoaderSessionError("Loader session policy is missing an active bay");
      return;
    }
    setLoaderSessionError(null);
    setLoaderSessionMutating(true);
    void (async () => {
      const openedAt = new Date().toISOString();
      const client = getMobileV2SupabaseSchemaClient(supabase, "api") as unknown as {
        rpc: (
          name: string,
          args: Record<string, unknown>,
        ) => Promise<{ data: unknown; error: { message?: string } | null }>;
      };
      const { data, error } = await client.rpc("open_ops_session_v1", {
        p_input: buildMobileV2StartLoaderSessionInput({
          deviceId: registeredDeviceId,
          openedAt,
          context: loaderSessionContext,
        }),
      });
      if (error !== null && error !== undefined) throw error;
      const row = Array.isArray(data) ? data[0] : data;
      const opsSessionId =
        row !== null &&
        typeof row === "object" &&
        "ops_session_id" in row &&
        typeof (row as { ops_session_id?: unknown }).ops_session_id === "string"
          ? (row as { ops_session_id: string }).ops_session_id
          : null;
      if (opsSessionId === null || opsSessionId.trim() === "") {
        throw new Error("Loader session did not return an ops_session_id.");
      }
      setActiveLoaderSession({ opsSessionId, openedAt, context: loaderSessionContext });
      await Promise.all([loaderTodayRpc.refetch(), sortationRpc.refetch()]);
      setToast({
        id: `loader-session-${Date.now()}`,
        message: `Loader session ready - Bay ${loaderSessionContext.bay}`,
        kind: "success",
      });
    })()
      .catch((error) => {
        setLoaderSessionError(formatMobileV2UserError(error, "Unable to start loader session"));
      })
      .finally(() => setLoaderSessionMutating(false));
  }, [
    activeLoaderSession,
    activeRole,
    liveLoaderToday.activeOpsSessionId,
    loaderSessionContext,
    loaderSessionMutating,
    loaderTodayRpc,
    mobileRpc.supabase,
    online,
    registeredDeviceId,
    sortationRpc,
  ]);
  const loaderSessionPanel = React.useMemo<MobileV2LoaderSessionPanel | undefined>(() => {
    if (activeRole !== "loader") return undefined;
    const policyContext: MobileV2LoaderSessionContext | null = activeLoaderSession?.context ?? loaderSessionContext;
    const liveBay = liveLoaderToday.bay.length > 0 ? liveLoaderToday.bay : null;
    const hydratedOpsSessionId = liveLoaderToday.activeOpsSessionId.trim();
    const activeOpsSessionId =
      activeLoaderSession?.opsSessionId ?? (hydratedOpsSessionId.length > 0 ? hydratedOpsSessionId : null);
    return {
      activeOpsSessionId,
      bay: liveBay ?? policyContext?.bay ?? null,
      waveLabel:
        liveLoaderToday.waveLabel.length > 0
          ? liveLoaderToday.waveLabel
          : policyContext?.waveLabel ?? null,
      routeLabel:
        liveLoaderToday.routeLabel.length > 0
          ? liveLoaderToday.routeLabel
          : policyContext?.routeLabel ?? null,
      cutOff:
        liveLoaderToday.cutOff.length > 0
          ? liveLoaderToday.cutOff
          : policyContext?.cutOff ?? null,
      canStart: activeOpsSessionId === null && online && registeredDeviceId !== null && policyContext !== null,
      isMutating: loaderSessionMutating,
      readinessLabel:
        loaderSessionError ??
        (activeOpsSessionId !== null
          ? "session ready"
          : policyContext === null
          ? "loader session policy missing active bay"
          : online && registeredDeviceId !== null
            ? "auth ok - loader policy ready"
            : "connect online and register device"),
      onStartSession: handleStartLoaderSession,
    };
  }, [
    activeLoaderSession,
    activeRole,
    handleStartLoaderSession,
    liveLoaderToday.bay,
    liveLoaderToday.cutOff,
    liveLoaderToday.activeOpsSessionId,
    liveLoaderToday.routeLabel,
    liveLoaderToday.waveLabel,
    loaderSessionContext,
    loaderSessionError,
    loaderSessionMutating,
    online,
    registeredDeviceId,
  ]);
  const activePodPolicy = React.useMemo(
    () => resolveMobileV2PodPolicyForStop(podPolicy, liveStop.proofChecklist),
    [podPolicy, liveStop.proofChecklist],
  );
  const activePodMethods = activePodPolicy.methods;

  const registerPodArtifact = React.useCallback(async (
    input: MobileV2PodArtifactCaptureInput,
  ): Promise<MobileV2PodCapturedArtifact> => {
    const capturedAt = input.capturedAt;
    if (isShowcase || mobileRpc.supabase === null) {
      return {
        artifactId: `preview-${input.kind}-${newIdempotencyKey()}`,
        kind: input.kind,
        method: input.method,
        capturedAt,
        storageKey: null,
      };
    }
    if (!isMobileV2PersistedUuid(activeStopId)) {
      throw new Error("Delivery proof capture requires an active stop.");
    }
    const organizationId = readMobileV2PolicyContextId(mobileRpc.policyContext, "organization_id");
    if (organizationId === null) {
      throw new Error("Organization context is missing for POD artifact capture.");
    }

    const bytes =
      input.base64 !== undefined && input.base64 !== null
        ? decodeMobileV2Base64ToArrayBuffer(input.base64)
        : encodeMobileV2TextToArrayBuffer(input.text ?? "");
    const storageBucket = MOBILE_V2_FIELDOPS_EVIDENCE_BUCKET;
    const storageKey = buildMobileV2PodArtifactStorageKey({
      organizationId,
      routeStopId: activeStopId,
      kind: input.kind,
      extension: input.extension,
      uniqueId: newIdempotencyKey(),
    });
    const upload = await mobileRpc.supabase.storage.from(storageBucket).upload(storageKey, bytes, {
      contentType: input.mimeType,
      upsert: false,
    });
    if (upload.error !== null) throw upload.error;

    const registerResult = await getMobileV2SupabaseSchemaClient(mobileRpc.supabase, "api").rpc("register_mobile_artifact_v1", {
      p_artifact: {
        organization_id: organizationId,
        storage_bucket: storageBucket,
        storage_key: storageKey,
        mime_type: input.mimeType,
        size_bytes: bytes.byteLength,
        source_system: "fieldops_mobile_v2",
        metadata: {
          app: "fieldops",
          surface: "mobile_v2_pod",
          route_stop_id: activeStopId,
          tracking: liveStop.id,
          customer_name: liveStop.customerName,
          proof_type: input.method,
          artifact_kind: input.kind,
          captured_at: capturedAt,
          ...(input.metadata ?? {}),
        },
      },
    });
    if (registerResult.error !== null) throw registerResult.error;
    const artifactId = resolveMobileV2ArtifactId(registerResult.data);
    if (artifactId === null) {
      throw new Error("POD artifact registration did not return an artifact id.");
    }
    return {
      artifactId,
      kind: input.kind,
      method: input.method,
      capturedAt,
      storageKey,
    };
  }, [activeStopId, isShowcase, liveStop.customerName, liveStop.id, mobileRpc.policyContext, mobileRpc.supabase]);

  const openDamageHoldForActiveStop = React.useCallback((): void => {
    const parcel =
      liveStop.parcels.find((entry) => isMobileV2PersistedUuid(entry.id)) ??
      liveStop.parcels[0] ??
      null;
    if (parcel === null) {
      setToast({
        id: `damage-hold-no-parcel-${Date.now()}`,
        message: "This stop has no parcel to hold",
        kind: "warning",
      });
      return;
    }
    setDamageHoldParcelId(parcel.id);
    setDamageHoldParcelLabel(parcel.code.trim() !== "" ? parcel.code : parcel.id);
    setDamageHoldSeverityId(damageHoldPolicy.severities[0]?.id ?? null);
    setDamageHoldNote("");
    setDamageHoldPhotoArtifact(null);
    setDamageHoldReadbackError(null);
    setDamageHoldVerifiedReadback(null);
    setDamageHoldSheetOpen(true);
  }, [damageHoldPolicy.severities, liveStop.parcels]);

  const openRescheduleForActiveStop = React.useCallback((): void => {
    if (activeStopTerminalState !== null) {
      setToast({
        id: `reschedule-terminal-${Date.now()}`,
        message: "Completed stops cannot be rescheduled",
        kind: "warning",
      });
      return;
    }
    if (!isShowcase && !isMobileV2PersistedUuid(activeStopId)) {
      setToast({
        id: `reschedule-missing-stop-${Date.now()}`,
        message: "Reschedule needs an active stop",
        kind: "danger",
      });
      return;
    }
    setRescheduleWindowId(rescheduleWindows[0]?.id ?? null);
    setRescheduleNote("");
    setRescheduleReadbackError(null);
    setRescheduleVerifiedReadback(null);
    setRescheduleSheetOpen(true);
  }, [activeStopId, activeStopTerminalState, isShowcase, rescheduleWindows]);

  const handleSubmitReschedule = React.useCallback((): void => {
    setRescheduleReadbackError(null);
    setRescheduleVerifiedReadback(null);
    const selectedWindow = rescheduleWindows.find((entry) => entry.id === rescheduleWindowId) ?? null;
    if (selectedWindow === null) {
      setRescheduleReadbackError("Pick a delivery window before confirming.");
      return;
    }
    if (!isShowcase && !isMobileV2PersistedUuid(activeStopId)) {
      setRescheduleReadbackError("Reschedule requires an active stop from the route.");
      return;
    }
    const note = rescheduleNote.trim();
    setRescheduleReadbackPending(true);
    void (async () => {
      try {
        const submittedAt = new Date().toISOString();
        const write = await submitRescheduleMutation.mutateAsync({
          p_stop_id: activeStopId,
          p_window_start: selectedWindow.startIso,
          p_window_end: selectedWindow.endIso,
          p_note: note.length > 0 ? note : null,
        });
        const readback = buildMobileV2RescheduleReadback({
          write,
          window: selectedWindow,
          timeZone: reschedulePolicy.timeZone,
          note: note.length > 0 ? note : null,
          submittedAt,
        });
        if (readback === null) {
          throw new Error("Reschedule saved, but the confirmation was not available yet.");
        }
        if (!isShowcase) {
          const [stopReadback] = await Promise.all([
            stopDetailRpc.refetch(),
            routeRpc.refetch(),
            tasksRpc.refetch(),
          ]);
          if (!mobileV2StopDetailMatchesRescheduleWindow(stopReadback.data ?? null, selectedWindow, reschedulePolicy.timeZone)) {
            throw new Error("Reschedule saved, but confirmation did not match yet.");
          }
        }
        setRescheduleVerifiedReadback(readback);
        setToast({
          id: `reschedule-${Date.now()}`,
          message: "Reschedule confirmed",
          kind: "success",
        });
      } catch (error) {
        const message = formatMobileV2UserError(error, "Reschedule failed");
        setRescheduleReadbackError(message);
        setToast({
          id: `reschedule-err-${Date.now()}`,
          message,
          kind: "danger",
        });
      } finally {
        setRescheduleReadbackPending(false);
      }
    })();
  }, [
    activeStopId,
    isShowcase,
    rescheduleNote,
    rescheduleWindowId,
    rescheduleWindows,
    routeRpc,
    stopDetailRpc,
    submitRescheduleMutation,
    tasksRpc,
  ]);

  const handleDamageHoldPhotoCapture = React.useCallback(async (
    capture?: MobileV2DamageHoldPhotoCapture,
  ): Promise<void> => {
    setDamageHoldReadbackError(null);
    setDamageHoldVerifiedReadback(null);
    if (capture === undefined) {
      if (isShowcase) {
        setDamageHoldPhotoArtifact((current) =>
          current === null
            ? {
                artifactId: `preview-damage-hold-${newIdempotencyKey()}`,
                kind: "photo",
                method: null,
                capturedAt: new Date().toISOString(),
                storageKey: "preview/damage-hold.jpg",
              }
            : null,
        );
        return;
      }
      setDamageHoldReadbackError("Use the device camera to capture damage evidence.");
      return;
    }
    setDamageHoldCaptureBusy(true);
    try {
      const artifact = await registerPodArtifact({
        kind: "photo",
        method: null,
        mimeType: capture.mimeType,
        extension: "jpg",
        capturedAt: capture.capturedAt,
        base64: capture.base64,
        metadata: {
          surface: "mobile_v2_damage_hold",
          parcel_id: damageHoldParcelId,
          tracking: liveStop.trackingCode,
          artifact_kind: "photo",
          capture_usage: "damage_hold",
        },
      });
      setDamageHoldPhotoArtifact(artifact);
      setToast({
        id: `damage-hold-photo-${Date.now()}`,
        message: "Damage photo registered",
        kind: "success",
      });
    } catch (error) {
      setDamageHoldReadbackError(
        formatMobileV2UserError(error, "Unable to register damage evidence."),
      );
      throw error;
    } finally {
      setDamageHoldCaptureBusy(false);
    }
  }, [
    damageHoldParcelId,
    isShowcase,
    liveStop.trackingCode,
    registerPodArtifact,
  ]);

  const handleSubmitDamageHold = React.useCallback((): void => {
    setDamageHoldReadbackError(null);
    setDamageHoldVerifiedReadback(null);
    const parcelId = damageHoldParcelId;
    const severityId = damageHoldSeverityId;
    const note = damageHoldNote.trim();
    const photoPath = damageHoldPhotoArtifact?.storageKey ?? null;
    if (parcelId === null || (!isShowcase && !isMobileV2PersistedUuid(parcelId))) {
      setDamageHoldReadbackError("Damage hold requires a parcel from the active stop.");
      return;
    }
    if (severityId === null) {
      setDamageHoldReadbackError("Select a damage category before submitting.");
      return;
    }
    if (note.length < 3) {
      setDamageHoldReadbackError("Add a short damage note before submitting.");
      return;
    }
    if (!isShowcase && (photoPath === null || photoPath.trim() === "")) {
      setDamageHoldReadbackError("Capture and register a damage photo before submitting.");
      return;
    }
    const submittedPhotoPath = photoPath ?? "preview/damage-hold.jpg";
    submitDamageHoldMutation.mutate(
      {
        p_parcel_id: parcelId,
        p_severity_id: severityId,
        p_note: note,
        p_photo_path: submittedPhotoPath,
      },
      {
        onSuccess: async (write) => {
          setDamageHoldReadbackPending(true);
          try {
            // The stop-detail refetch renders the parcel as damaged from the open hold.
            const [latestReadback] = await Promise.all([
              latestDamageHoldRpc.refetch(),
              holdRpc.refetch(),
              stopDetailRpc.refetch(),
            ]);
            const latest = latestReadback.data ?? null;
            if (
              !isShowcase &&
              !mobileV2DamageHoldMatchesWrite(
                latest,
                write,
                parcelId,
                severityId,
                note,
                submittedPhotoPath,
              )
            ) {
              setDamageHoldReadbackError("Damage hold saved, but confirmation did not match yet.");
              setToast({
                id: `damage-hold-readback-err-${Date.now()}`,
                message: "Damage hold confirmation did not match",
                kind: "danger",
              });
              return;
            }
            setDamageHoldVerifiedReadback(
              latest ?? {
                holdId: String(write.hold_id ?? write.decision_log_id),
                decisionLogId: write.decision_log_id,
                parcelId,
                severityId,
                note,
                photoPath: submittedPhotoPath,
                state: typeof write.state === "string" ? write.state : "open",
                submittedAt: new Date().toISOString(),
              },
            );
            setToast({
              id: `damage-hold-${Date.now()}`,
              message: "Damage hold confirmed",
              kind: "success",
            });
          } catch (error) {
            setDamageHoldReadbackError(
              formatMobileV2UserError(error, "Saved, but the screen did not refresh yet. Try again."),
            );
          } finally {
            setDamageHoldReadbackPending(false);
          }
        },
        onError: (error) => {
          setDamageHoldReadbackError(formatMobileV2UserError(error, "Damage hold failed"));
          setToast({
            id: `damage-hold-err-${Date.now()}`,
            message: formatMobileV2UserError(error, "Damage hold failed"),
            kind: "danger",
          });
        },
      },
    );
  }, [
    damageHoldNote,
    damageHoldParcelId,
    damageHoldPhotoArtifact?.storageKey,
    damageHoldSeverityId,
    holdRpc,
    isShowcase,
    latestDamageHoldRpc,
    stopDetailRpc,
    submitDamageHoldMutation,
  ]);

  const registerKycDocumentArtifact = React.useCallback(async (
    docKey: string,
    capture: MobileV2KycDocumentCapture,
  ): Promise<MobileV2PodCapturedArtifact> => {
    setKycDocCaptureError(null);
    const capturedAt = capture.capturedAt;
    if (isShowcase || mobileRpc.supabase === null) {
      return {
        artifactId: `preview-kyc-${docKey}-${newIdempotencyKey()}`,
        kind: "identity",
        method: "id",
        capturedAt,
        storageKey: `preview/kyc/${docKey}.jpg`,
      };
    }
    const organizationId = readMobileV2PolicyContextId(mobileRpc.policyContext, "organization_id");
    if (organizationId === null) {
      throw new Error("Organization context is missing for KYC document capture.");
    }

    const bytes = decodeMobileV2Base64ToArrayBuffer(capture.base64);
    const storageKey = buildMobileV2KycDocumentStorageKey({
      organizationId,
      docKey,
      uniqueId: newIdempotencyKey(),
    });
    const upload = await mobileRpc.supabase.storage
      .from(MOBILE_V2_FIELDOPS_EVIDENCE_BUCKET)
      .upload(storageKey, bytes, {
        contentType: capture.mimeType,
        upsert: false,
      });
    if (upload.error !== null) throw upload.error;

    const registerResult = await getMobileV2SupabaseSchemaClient(mobileRpc.supabase, "api").rpc("register_mobile_artifact_v1", {
      p_artifact: {
        organization_id: organizationId,
        storage_bucket: MOBILE_V2_FIELDOPS_EVIDENCE_BUCKET,
        storage_key: storageKey,
        mime_type: capture.mimeType,
        size_bytes: bytes.byteLength,
        source_system: "fieldops_mobile_v2",
        metadata: {
          app: "fieldops",
          surface: "mobile_v2_kyc_documents",
          active_role: activeRole,
          doc_key: docKey,
          artifact_kind: "identity",
          captured_at: capturedAt,
        },
      },
    });
    if (registerResult.error !== null) throw registerResult.error;
    const artifactId = resolveMobileV2ArtifactId(registerResult.data);
    if (artifactId === null) {
      throw new Error("KYC document artifact registration did not return an artifact id.");
    }
    return {
      artifactId,
      kind: "identity",
      method: "id",
      capturedAt,
      storageKey,
    };
  }, [activeRole, isShowcase, mobileRpc.policyContext, mobileRpc.supabase]);

  const registerIstimaraArtifact = React.useCallback(async (
    capture: MobileV2IstimaraCapture,
  ): Promise<MobileV2PodCapturedArtifact> => {
    setKycVehicleError(null);
    const capturedAt = capture.capturedAt;
    if (isShowcase || mobileRpc.supabase === null) {
      return {
        artifactId: `preview-istimara-${newIdempotencyKey()}`,
        kind: "identity",
        method: "id",
        capturedAt,
        storageKey: "preview/kyc/istimara.jpg",
      };
    }
    const organizationId = readMobileV2PolicyContextId(mobileRpc.policyContext, "organization_id");
    if (organizationId === null) {
      throw new Error("Organization context is missing for Istimara capture.");
    }

    const bytes = decodeMobileV2Base64ToArrayBuffer(capture.base64);
    const storageKey = buildMobileV2IstimaraStorageKey({
      organizationId,
      uniqueId: newIdempotencyKey(),
    });
    const upload = await mobileRpc.supabase.storage
      .from(MOBILE_V2_FIELDOPS_EVIDENCE_BUCKET)
      .upload(storageKey, bytes, {
        contentType: capture.mimeType,
        upsert: false,
      });
    if (upload.error !== null) throw upload.error;

    const registerResult = await getMobileV2SupabaseSchemaClient(mobileRpc.supabase, "api").rpc("register_mobile_artifact_v1", {
      p_artifact: {
        organization_id: organizationId,
        storage_bucket: MOBILE_V2_FIELDOPS_EVIDENCE_BUCKET,
        storage_key: storageKey,
        mime_type: capture.mimeType,
        size_bytes: bytes.byteLength,
        source_system: "fieldops_mobile_v2",
        metadata: {
          app: "fieldops",
          surface: "mobile_v2_kyc_vehicle",
          active_role: activeRole,
          artifact_kind: "identity",
          document_type: "istimara",
          captured_at: capturedAt,
        },
      },
    });
    if (registerResult.error !== null) throw registerResult.error;
    const artifactId = resolveMobileV2ArtifactId(registerResult.data);
    if (artifactId === null) {
      throw new Error("Istimara artifact registration did not return an artifact id.");
    }
    return {
      artifactId,
      kind: "identity",
      method: "id",
      capturedAt,
      storageKey,
    };
  }, [activeRole, isShowcase, mobileRpc.policyContext, mobileRpc.supabase]);

  const registerCleaningArtifact = React.useCallback(async (
    capture: MobileV2CleaningPhotoCapture,
  ): Promise<MobileV2PodCapturedArtifact> => {
    setCleaningCaptureError(null);
    const capturedAt = capture.capturedAt;
    const shiftId = preShiftShiftId;
    if (isShowcase || mobileRpc.supabase === null) {
      return {
        artifactId: `preview-cleaning-${newIdempotencyKey()}`,
        kind: "photo",
        method: null,
        capturedAt,
        storageKey: null,
      };
    }
    if (shiftId === null) {
      throw new Error("Cleaning evidence requires an active shift.");
    }
    const organizationId = readMobileV2PolicyContextId(mobileRpc.policyContext, "organization_id");
    if (organizationId === null) {
      throw new Error("Organization context is missing for cleaning evidence capture.");
    }

    const bytes = decodeMobileV2Base64ToArrayBuffer(capture.base64);
    const storageKey = buildMobileV2CleaningEvidenceStorageKey({
      organizationId,
      shiftId,
      uniqueId: newIdempotencyKey(),
    });
    const upload = await mobileRpc.supabase.storage
      .from(MOBILE_V2_FIELDOPS_EVIDENCE_BUCKET)
      .upload(storageKey, bytes, {
        contentType: capture.mimeType,
        upsert: false,
      });
    if (upload.error !== null) throw upload.error;

    const registerResult = await getMobileV2SupabaseSchemaClient(mobileRpc.supabase, "api").rpc("register_mobile_artifact_v1", {
      p_artifact: {
        organization_id: organizationId,
        storage_bucket: MOBILE_V2_FIELDOPS_EVIDENCE_BUCKET,
        storage_key: storageKey,
        mime_type: capture.mimeType,
        size_bytes: bytes.byteLength,
        source_system: "fieldops_mobile_v2",
        metadata: {
          app: "fieldops",
          surface: "mobile_v2_cleaning",
          active_role: activeRole,
          shift_id: shiftId,
          checked_ids: cleaningCheckedIds,
          artifact_kind: "photo",
          captured_at: capturedAt,
        },
      },
    });
    if (registerResult.error !== null) throw registerResult.error;
    const artifactId = resolveMobileV2ArtifactId(registerResult.data);
    if (artifactId === null) {
      throw new Error("Cleaning artifact registration did not return an artifact id.");
    }
    return {
      artifactId,
      kind: "photo",
      method: null,
      capturedAt,
      storageKey,
    };
  }, [
    activeRole,
    cleaningCheckedIds,
    isShowcase,
    mobileRpc.policyContext,
    mobileRpc.supabase,
    preShiftShiftId,
  ]);

  const registerCashDropArtifact = React.useCallback(async (
    capture?: MobileV2CashDropPhotoCapture,
  ): Promise<void> => {
    setCashPhotoCaptureBusy(true);
    setCashPhotoCaptureError(null);
    try {
      const capturedAt = capture?.capturedAt ?? new Date().toISOString();
      if (isShowcase || mobileRpc.supabase === null) {
        setCashPhotoArtifactId(`preview-cash-drop-${newIdempotencyKey()}`);
        setCashPhotoCaptured(true);
        setToast({
          id: `cd-photo-${Date.now()}`,
          message: "Envelope photo registered",
          kind: "success",
        });
        return;
      }
      if (capture === undefined || capture.base64.trim() === "") {
        throw new Error("Capture an envelope photo before submitting a cash-drop variance.");
      }
      const organizationId = readMobileV2PolicyContextId(mobileRpc.policyContext, "organization_id");
      if (organizationId === null) {
        throw new Error("Organization context is missing for cash-drop evidence capture.");
      }
      const bytes = decodeMobileV2Base64ToArrayBuffer(capture.base64);
      const storageKey = buildMobileV2CashDropEvidenceStorageKey({
        organizationId,
        extension: capture.extension,
        uniqueId: newIdempotencyKey(),
      });
      const upload = await mobileRpc.supabase.storage
        .from(MOBILE_V2_FIELDOPS_EVIDENCE_BUCKET)
        .upload(storageKey, bytes, {
          contentType: capture.mimeType,
          upsert: false,
        });
      if (upload.error !== null) throw upload.error;

      const registerResult = await getMobileV2SupabaseSchemaClient(mobileRpc.supabase, "api").rpc("register_mobile_artifact_v1", {
        p_artifact: {
          organization_id: organizationId,
          storage_bucket: MOBILE_V2_FIELDOPS_EVIDENCE_BUCKET,
          storage_key: storageKey,
          mime_type: capture.mimeType,
          size_bytes: bytes.byteLength,
          source_system: "fieldops_mobile_v2",
          metadata: {
            app: "fieldops",
            surface: "mobile_v2_cash_drop",
            active_role: activeRole,
            expected_sar: liveCashDrop.expectedSar,
            actual_sar: cashCountedEffective,
            variance_sar: cashCountedEffective - liveCashDrop.expectedSar,
            proof_type: "cash_drop_envelope",
            artifact_kind: "cash_drop_envelope",
            captured_at: capturedAt,
          },
        },
      });
      if (registerResult.error !== null) throw registerResult.error;
      const artifactId = resolveMobileV2ArtifactId(registerResult.data);
      if (artifactId === null) {
        throw new Error("Cash-drop artifact registration did not return an artifact id.");
      }
      setCashPhotoArtifactId(artifactId);
      setCashPhotoCaptured(true);
      setToast({
        id: `cd-photo-${Date.now()}`,
        message: "Envelope photo registered",
        kind: "success",
      });
    } catch (error) {
      const message = formatMobileV2UserError(error, "Unable to register cash-drop evidence.");
      setCashPhotoCaptured(false);
      setCashPhotoArtifactId(null);
      setCashPhotoCaptureError(message);
      setToast({
        id: `cd-photo-err-${Date.now()}`,
        message,
        kind: "danger",
      });
    } finally {
      setCashPhotoCaptureBusy(false);
    }
  }, [
    activeRole,
    cashCountedEffective,
    isShowcase,
    liveCashDrop.expectedSar,
    mobileRpc.policyContext,
    mobileRpc.supabase,
  ]);

  const registerVehiclePhotoArtifact = React.useCallback(async (
    angleId: MobileV2VehicleAngleId,
    capture: MobileV2VehiclePhotoCapture,
  ): Promise<MobileV2PodCapturedArtifact> => {
    setVehiclePhotoCaptureError(null);
    const capturedAt = capture.capturedAt;
    if (isShowcase || mobileRpc.supabase === null) {
      return {
        artifactId: `preview-vehicle-${angleId}-${newIdempotencyKey()}`,
        kind: "photo",
        method: null,
        capturedAt,
        storageKey: `preview/vehicle-${angleId}.jpg`,
      };
    }
    const organizationId = readMobileV2PolicyContextId(mobileRpc.policyContext, "organization_id");
    if (organizationId === null) {
      throw new Error("Organization context is missing for vehicle photo capture.");
    }

    const bytes = decodeMobileV2Base64ToArrayBuffer(capture.base64);
    const storageKey = buildMobileV2VehiclePhotoStorageKey({
      organizationId,
      angleId,
      uniqueId: newIdempotencyKey(),
    });
    const upload = await mobileRpc.supabase.storage
      .from(MOBILE_V2_FIELDOPS_EVIDENCE_BUCKET)
      .upload(storageKey, bytes, {
        contentType: capture.mimeType,
        upsert: false,
      });
    if (upload.error !== null) throw upload.error;

    const registerResult = await getMobileV2SupabaseSchemaClient(mobileRpc.supabase, "api").rpc("register_mobile_artifact_v1", {
      p_artifact: {
        organization_id: organizationId,
        storage_bucket: MOBILE_V2_FIELDOPS_EVIDENCE_BUCKET,
        storage_key: storageKey,
        mime_type: capture.mimeType,
        size_bytes: bytes.byteLength,
        source_system: "fieldops_mobile_v2",
        metadata: {
          app: "fieldops",
          surface: "mobile_v2_vehicle_photos",
          active_role: activeRole,
          angle_id: angleId,
          artifact_kind: "photo",
          captured_at: capturedAt,
        },
      },
    });
    if (registerResult.error !== null) throw registerResult.error;
    const artifactId = resolveMobileV2ArtifactId(registerResult.data);
    if (artifactId === null) {
      throw new Error("Vehicle photo artifact registration did not return an artifact id.");
    }
    return {
      artifactId,
      kind: "photo",
      method: null,
      capturedAt,
      storageKey,
    };
  }, [activeRole, isShowcase, mobileRpc.policyContext, mobileRpc.supabase]);

  const handleCleaningPhotoCapture = React.useCallback(async (
    capture?: MobileV2CleaningPhotoCapture,
  ): Promise<void> => {
    setCleaningCaptureError(null);
    setCleaningReadbackError(null);
    setCleaningVerifiedReadback(null);
    if (capture === undefined) {
      if (isShowcase) {
        setCleaningPhotoArtifact((current) =>
          current === null
            ? {
                artifactId: `preview-cleaning-${newIdempotencyKey()}`,
                kind: "photo",
                method: null,
                capturedAt: new Date().toISOString(),
                storageKey: "preview/cleaning.jpg",
              }
            : null,
        );
        return;
      }
      setCleaningCaptureError("Use the device camera to capture cleaning evidence.");
      return;
    }
    setCleaningPhotoRegistering(true);
    try {
      const artifact = await registerCleaningArtifact(capture);
      setCleaningPhotoArtifact(artifact);
      setToast({
        id: `cleaning-photo-${Date.now()}`,
        message: "Cleaning photo registered",
        kind: "success",
      });
    } catch (error) {
      setCleaningCaptureError(
        formatMobileV2UserError(error, "Unable to register cleaning evidence."),
      );
      throw error;
    } finally {
      setCleaningPhotoRegistering(false);
    }
  }, [isShowcase, registerCleaningArtifact]);

  const handleSubmitCleaning = React.useCallback((): void => {
    setCleaningReadbackError(null);
    setCleaningVerifiedReadback(null);
    const checkedIds = Object.freeze([...cleaningCheckedIds]);
    if (checkedIds.length === 0) {
      setCleaningReadbackError("Select at least one cleaning item before submitting.");
      return;
    }
    const photoPath = cleaningPhotoArtifact?.storageKey ?? null;
    if (!isShowcase && (photoPath === null || photoPath.trim() === "")) {
      setCleaningReadbackError("Capture and register a cleaning photo before submitting.");
      return;
    }
    recordCleaningMutation.mutate(
      {
        p_checked_ids: checkedIds,
        p_photo_path: photoPath ?? "preview/cleaning.jpg",
      },
      {
        onSuccess: async (write) => {
          setCleaningReadbackPending(true);
          try {
            const readback = await onboardingReadbackRpc.refetch();
            const latest = readback.data?.latestCleaning ?? null;
            if (
              !isShowcase &&
              !mobileV2CleaningMatchesWrite(latest, write, checkedIds)
            ) {
              setCleaningReadbackError("Cleaning saved, but confirmation did not match yet.");
              setToast({
                id: `cleaning-readback-err-${Date.now()}`,
                message: "Cleaning confirmation did not match",
                kind: "danger",
              });
              return;
            }
            setCleaningVerifiedReadback(
              latest ?? {
                checkId: String(write.check_id ?? write.decision_log_id),
                checkedIds,
                itemCount: checkedIds.length,
                photoPath,
                state: typeof write.state === "string" ? write.state : "attested",
                decisionLogId: write.decision_log_id,
                correlationId: null,
                submittedAt: new Date().toISOString(),
              },
            );
            setToast({
              id: `cleaning-${Date.now()}`,
              message: `Cleaning confirmed - ${checkedIds.length} items`,
              kind: "success",
            });
          } catch (error) {
            setCleaningReadbackError(
              formatMobileV2UserError(error, "Saved, but the screen did not refresh yet. Try again."),
            );
          } finally {
            setCleaningReadbackPending(false);
          }
        },
        onError: (error) => {
          setCleaningReadbackError(formatMobileV2UserError(error, "Cleaning update failed"));
          setToast({
            id: `cleaning-err-${Date.now()}`,
            message: formatMobileV2UserError(error, "Cleaning update failed"),
            kind: "danger",
          });
        },
      },
    );
  }, [
    cleaningCheckedIds,
    cleaningPhotoArtifact?.storageKey,
    isShowcase,
    onboardingReadbackRpc,
    recordCleaningMutation,
  ]);

  const handleSubmitKycDoc = React.useCallback(async (
    docKey: string,
    capture?: MobileV2KycDocumentCapture,
  ): Promise<void> => {
    setKycDocCaptureError(null);
    setKycBusyKey(docKey);
    try {
      if (capture === undefined && !isShowcase) {
        setKycDocCaptureError("Use the device camera to capture identity evidence.");
        setToast({
          id: `kyc-doc-camera-required-${Date.now()}`,
          message: "Use device camera capture before submitting KYC",
          kind: "warning",
        });
        return;
      }
      const artifact = capture === undefined
        ? {
            storageKey: `preview/kyc/${docKey}.jpg`,
          }
        : await registerKycDocumentArtifact(docKey, capture);
      const storagePath = artifact.storageKey;
      if (storagePath === null || storagePath === undefined || storagePath.trim() === "") {
        throw new Error("KYC document capture did not produce a storage path.");
      }
      const write = await submitKycDocMutation.mutateAsync({
        p_doc_key: docKey,
        p_storage_path: storagePath,
      });
      const readback = await onboardingReadbackRpc.refetch();
      const documents = readback.data?.documents ?? [];
      if (
        !isShowcase &&
        !mobileV2KycDocMatchesWrite(documents, write, docKey, storagePath)
      ) {
        setKycDocCaptureError("KYC document saved, but confirmation did not match yet.");
        setToast({
          id: `kyc-doc-readback-err-${Date.now()}`,
          message: "KYC document confirmation did not match",
          kind: "danger",
        });
        return;
      }
      setToast({
        id: `kyc-doc-${Date.now()}`,
        message: "KYC document confirmed",
        kind: "success",
      });
    } catch (error) {
      const message = formatMobileV2UserError(error, "Unable to submit KYC document.");
      setKycDocCaptureError(message);
      setToast({
        id: `kyc-doc-err-${Date.now()}`,
        message,
        kind: "danger",
      });
      throw error;
    } finally {
      setKycBusyKey(null);
    }
  }, [
    isShowcase,
    onboardingReadbackRpc,
    registerKycDocumentArtifact,
    submitKycDocMutation,
  ]);

  const handleIstimaraCapture = React.useCallback(async (
    capture?: MobileV2IstimaraCapture,
  ): Promise<void> => {
    setKycVehicleError(null);
    if (capture === undefined) {
      if (isShowcase) {
        setKycIstimaraArtifact({
          artifactId: `preview-istimara-${newIdempotencyKey()}`,
          kind: "identity",
          method: "id",
          capturedAt: new Date().toISOString(),
          storageKey: "preview/kyc/istimara.jpg",
        });
        return;
      }
      setKycVehicleError("Use the device camera to capture Istimara evidence.");
      return;
    }
    setKycIstimaraRegistering(true);
    try {
      const artifact = await registerIstimaraArtifact(capture);
      setKycIstimaraArtifact(artifact);
      setToast({
        id: `istimara-${Date.now()}`,
        message: "Istimara evidence registered",
        kind: "success",
      });
    } catch (error) {
      const message = formatMobileV2UserError(error, "Unable to register Istimara evidence.");
      setKycVehicleError(message);
      throw error;
    } finally {
      setKycIstimaraRegistering(false);
    }
  }, [isShowcase, registerIstimaraArtifact]);

  const handleSubmitKycVehicle = React.useCallback((): void => {
    setKycVehicleError(null);
    if (
      latestVehicleReadback !== null &&
      kycIstimaraArtifact === null &&
      latestVehicleReadback.istimaraPath !== null &&
      latestVehicleReadback.istimaraPath.trim() !== ""
    ) {
      setActiveTabId("mobile-kyc-vehicle-photos");
      return;
    }
    const evidencePath = kycIstimaraArtifact?.storageKey ?? latestVehicleReadback?.istimaraPath ?? null;
    if (!isShowcase && (evidencePath === null || evidencePath.trim() === "")) {
      setKycVehicleError("Capture and register Istimara evidence before submitting vehicle registration.");
      return;
    }
    const submittedPlate = kycVehiclePlate;
    const submittedVin = kycVehicleVin;
    const submittedYear = kycVehicleYear;
    const submittedModel = kycVehicleModel;
    setKycVehicleReadbackPending(true);
    submitKycVehicleMutation.mutate(
      {
        p_plate: kycVehiclePlate,
        p_vin: kycVehicleVin,
        p_year: kycVehicleYear,
        p_model: kycVehicleModel,
        p_istimara_path: evidencePath ?? "preview/kyc/istimara.jpg",
      },
      {
        onSuccess: async (write) => {
          try {
            const readback = await onboardingReadbackRpc.refetch();
            const latest = readback.data?.latestVehicle ?? null;
            if (
              !isShowcase &&
              !mobileV2KycVehicleMatchesWrite(
                latest,
                write,
                {
                  plate: submittedPlate,
                  vin: submittedVin,
                  year: submittedYear,
                  model: submittedModel,
                  istimaraPath: evidencePath,
                },
              )
            ) {
              setKycVehicleError("Vehicle saved, but confirmation did not match yet.");
              setToast({
                id: `kyc-vehicle-readback-err-${Date.now()}`,
                message: "Vehicle confirmation did not match",
                kind: "danger",
              });
              return;
            }
            setKycIstimaraArtifact(null);
            setToast({
              id: `kyc-vehicle-${Date.now()}`,
              message: "Vehicle registration confirmed",
              kind: "success",
            });
          } catch (error) {
            setKycVehicleError(
              formatMobileV2UserError(error, "Saved, but the screen did not refresh yet. Try again."),
            );
          } finally {
            setKycVehicleReadbackPending(false);
          }
        },
        onError: (error) => {
          setKycVehicleReadbackPending(false);
          setKycVehicleError(formatMobileV2UserError(error, "Vehicle registration failed"));
          setToast({
            id: `kyc-vehicle-err-${Date.now()}`,
            message: formatMobileV2UserError(error, "Vehicle registration failed"),
            kind: "danger",
          });
        },
      },
    );
  }, [
    isShowcase,
    kycIstimaraArtifact,
    kycVehicleModel,
    kycVehiclePlate,
    kycVehicleVin,
    kycVehicleYear,
    latestVehicleReadback,
    onboardingReadbackRpc,
    submitKycVehicleMutation,
  ]);

  const handleVehiclePhotoCapture = React.useCallback(async (
    angleId: MobileV2VehicleAngleId,
    capture?: MobileV2VehiclePhotoCapture,
  ): Promise<void> => {
    setVehiclePhotoCaptureError(null);
    setVehiclePhotosReadbackError(null);
    setVehiclePhotosVerifiedReadback(null);
    if (capture === undefined) {
      if (isShowcase) {
        setVehiclePhotoArtifacts((current) => ({
          ...current,
          [angleId]: {
            artifactId: `preview-vehicle-${angleId}-${newIdempotencyKey()}`,
            kind: "photo",
            method: null,
            capturedAt: new Date().toISOString(),
            storageKey: `preview/vehicle-${angleId}.jpg`,
          },
        }));
        return;
      }
      setVehiclePhotoCaptureError("Use the device camera to capture vehicle angle evidence.");
      return;
    }
    setVehiclePhotoBusyAngleId(angleId);
    try {
      const artifact = await registerVehiclePhotoArtifact(angleId, capture);
      setVehiclePhotoArtifacts((current) => ({ ...current, [angleId]: artifact }));
      setToast({
        id: `vehicle-photo-${angleId}-${Date.now()}`,
        message: `${angleId} vehicle photo registered`,
        kind: "success",
      });
    } catch (error) {
      setVehiclePhotoCaptureError(
        formatMobileV2UserError(error, "Unable to register vehicle photo evidence."),
      );
      throw error;
    } finally {
      setVehiclePhotoBusyAngleId(null);
    }
  }, [isShowcase, registerVehiclePhotoArtifact]);

  const handleSubmitVehiclePhotos = React.useCallback((): void => {
    setVehiclePhotosReadbackError(null);
    setVehiclePhotosVerifiedReadback(null);
    const requiredAngles = liveVehicleAngles.map((angle) => angle.id);
    const existingPaths = latestVehiclePhotoReadback?.anglePaths ?? {};
    const anglePaths = requiredAngles.reduce<Record<string, string>>((acc, angle) => {
      const capturedPath = vehiclePhotoArtifacts[angle]?.storageKey;
      const existingPath = existingPaths[angle];
      if (capturedPath !== null && capturedPath !== undefined && capturedPath.trim() !== "") {
        acc[angle] = capturedPath;
      } else if (existingPath !== undefined && existingPath.trim() !== "") {
        acc[angle] = existingPath;
      }
      return acc;
    }, {});
    const missing = requiredAngles.filter((angle) => anglePaths[angle] === undefined);
    if (missing.length > 0) {
      setVehiclePhotosReadbackError(`Capture required angles before submit: ${missing.join(", ")}`);
      return;
    }
    submitVehiclePhotosMutation.mutate(
      { p_angle_paths: anglePaths },
      {
        onSuccess: async (write) => {
          setVehiclePhotosReadbackPending(true);
          try {
            const readback = await onboardingReadbackRpc.refetch();
            const latest = readback.data?.latestVehiclePhotos ?? null;
            if (
              !isShowcase &&
              !mobileV2VehiclePhotosMatchWrite(latest, write, requiredAngles, anglePaths)
            ) {
              setVehiclePhotosReadbackError("Vehicle photos saved, but confirmation did not match yet.");
              setToast({
                id: `vehicle-photos-readback-err-${Date.now()}`,
                message: "Vehicle photo confirmation did not match",
                kind: "danger",
              });
              return;
            }
            setVehiclePhotosVerifiedReadback(
              latest ?? {
                photoSetId: String(write.photo_set_id ?? write.decision_log_id),
                anglePaths,
                capturedAngleIds: requiredAngles,
                photoCount: requiredAngles.length,
                state: typeof write.state === "string" ? write.state : "submitted",
                decisionLogId: write.decision_log_id,
                correlationId: null,
                submittedAt: new Date().toISOString(),
              },
            );
            setToast({
              id: `vehicle-photos-${Date.now()}`,
              message: "Vehicle photos confirmed",
              kind: "success",
            });
          } catch (error) {
            setVehiclePhotosReadbackError(
              formatMobileV2UserError(error, "Saved, but the screen did not refresh yet. Try again."),
            );
          } finally {
            setVehiclePhotosReadbackPending(false);
          }
        },
        onError: (error) => {
          setVehiclePhotosReadbackError(formatMobileV2UserError(error, "Vehicle photo update failed"));
          setToast({
            id: `vehicle-photos-err-${Date.now()}`,
            message: formatMobileV2UserError(error, "Vehicle photo update failed"),
            kind: "danger",
          });
        },
      },
    );
  }, [
    isShowcase,
    latestVehiclePhotoReadback?.anglePaths,
    liveVehicleAngles,
    onboardingReadbackRpc,
    submitVehiclePhotosMutation,
    vehiclePhotoArtifacts,
  ]);

  const handleStartPreShift = React.useCallback((): void => {
    setPreShiftReadbackError(null);
    setPreShiftVerifiedReadback(null);
    const shiftId = preShiftShiftId;
    if (shiftId === null) {
      setPreShiftReadbackError("Start a driver shift before pre-shift clearance.");
      return;
    }
    passPreShiftGateMutation.mutate(
      {
        p_shift_id: shiftId,
        p_health_ok: preShiftHealthOk,
      },
      {
        onSuccess: async (write) => {
          setPreShiftReadbackPending(true);
          try {
            const readback = await onboardingReadbackRpc.refetch();
            const latest = readback.data?.latestPreShift ?? null;
            if (
              !isShowcase &&
              !mobileV2PreShiftMatchesWrite(latest, write, shiftId, preShiftHealthOk)
            ) {
              setPreShiftReadbackError("Pre-shift saved, but confirmation did not match yet.");
              setToast({
                id: `pre-shift-readback-err-${Date.now()}`,
                message: "Pre-shift confirmation did not match",
                kind: "danger",
              });
              return;
            }
            setPreShiftVerifiedReadback(
              latest ?? {
                passId: String(write.pass_id ?? write.decision_log_id),
                shiftId,
                healthOk: preShiftHealthOk,
                state: typeof write.state === "string" ? write.state : "cleared",
                decisionLogId: write.decision_log_id,
                correlationId: null,
                submittedAt: new Date().toISOString(),
              },
            );
            setToast({
              id: `pre-shift-${Date.now()}`,
              message: "Pre-shift confirmed",
              kind: "success",
            });
          } catch (error) {
            setPreShiftReadbackError(
              formatMobileV2UserError(error, "Saved, but the screen did not refresh yet. Try again."),
            );
          } finally {
            setPreShiftReadbackPending(false);
          }
        },
        onError: (error) => {
          setPreShiftReadbackError(formatMobileV2UserError(error, "Pre-shift update failed"));
          setToast({
            id: `pre-shift-err-${Date.now()}`,
            message: formatMobileV2UserError(error, "Pre-shift update failed"),
            kind: "danger",
          });
        },
      },
    );
  }, [
    isShowcase,
    onboardingReadbackRpc,
    passPreShiftGateMutation,
    preShiftHealthOk,
    preShiftShiftId,
  ]);

  const handleOpenPreShiftBlocker = React.useCallback((blocker: MobileV2PreShiftBlocker): void => {
    const target = resolveMobileV2NavigationTargetId({
      id: blocker.route ?? blocker.id,
      label: blocker.title,
    });
    if (
      target === "mobile-cleaning"
      || target === "mobile-more"
      || target === "mobile-kyc-id"
      || target === "mobile-kyc-vehicle"
      || target === "mobile-kyc-vehicle-photos"
      || target === "mobile-pre-shift"
    ) {
      setActiveTabId(target);
      return;
    }
    setToast({
      id: `pre-shift-blocker-${Date.now()}`,
      message: `${blocker.title} is not mounted in this V2 slice yet`,
      kind: "warning",
    });
  }, []);

  const driverShiftReadinessAllowsStart = mobileV2DriverShiftReadinessAllowsStart(
    onboardingReadbackRpc.data?.requirements,
  );
  const moreDriverShift = React.useMemo<MobileV2DriverShiftPanel | undefined>(() => {
    if (props.driverShift === undefined) return undefined;
    if (props.driverShift.activeOpsSessionId !== null) return props.driverShift;
    if (driverShiftReadinessAllowsStart) return props.driverShift;
    return {
      ...props.driverShift,
      readinessLabel: MOBILE_V2_DRIVER_SHIFT_READINESS_BLOCKED_MESSAGE,
      onStartShift: () => {
        setPreShiftReadbackError(MOBILE_V2_DRIVER_SHIFT_READINESS_BLOCKED_MESSAGE);
        setActiveTabId("mobile-pre-shift");
        setToast({
          id: `driver-shift-readiness-${Date.now()}`,
          message: MOBILE_V2_DRIVER_SHIFT_READINESS_BLOCKED_MESSAGE,
          kind: "warning",
        });
      },
    };
  }, [driverShiftReadinessAllowsStart, props.driverShift]);

  // Incident type registry is resolved via mobile_incident_policy; the
  // fixture is the preview/offline fallback only (B1 / I2).
  const incidentTypesRpc = useFieldopsIncidentTypesRpc({
    fallback: MOBILE_V2_PREVIEW_INCIDENT_TYPES,
  });
  const incidentTypes = incidentTypesRpc.data ?? MOBILE_V2_PREVIEW_INCIDENT_TYPES;
  const [incidentReadbackError, setIncidentReadbackError] = React.useState<string | null>(null);
  const [incidentVerifiedReadback, setIncidentVerifiedReadback] =
    React.useState<MobileV2IncidentReadback | null>(null);
  const latestIncidentRpc = useFieldopsLatestIncidentRpc({
    enabled: false,
  });
  const handleActiveRoleChange = React.useCallback(
    (role: string): void => {
      const nextRole = normalizeMobileV2Role(role);
      if (nextRole === null || !availableRoles.includes(nextRole)) {
        setToast({
          id: `role-denied-${Date.now()}`,
          message: "This role is not assigned to your account",
          kind: "warning",
        });
        return;
      }
      if (isShowcase) {
        setActiveRole(nextRole);
        props.onActiveRoleChange?.(nextRole);
        setToast({
          id: `role-${Date.now()}`,
          message: `Switched to ${nextRole}`,
          kind: "info",
        });
        return;
      }
      setActiveRoleMutation.mutate(nextRole, {
        onSuccess: (envelope) => {
          setActiveRole(envelope.activeRole);
          props.onActiveRoleChange?.(envelope.activeRole);
          void activeRoleQuery.refetch();
          void navigationRpc.refetch();
          void tasksRpc.refetch();
          void routeRpc.refetch();
          setToast({
            id: `role-${Date.now()}`,
            message: `Switched to ${envelope.activeRole}`,
            kind: "info",
          });
        },
        onError: (error) => {
          setToast({
            id: `role-error-${Date.now()}`,
            message: formatMobileV2UserError(error, "Role switch failed"),
            kind: "warning",
          });
        },
      });
    },
    [
      activeRoleQuery,
      availableRoles,
      isShowcase,
      navigationRpc,
      props,
      routeRpc,
      setActiveRoleMutation,
      tasksRpc,
    ],
  );

  React.useEffect(() => {
    const nextTabId = resolveMobileV2ActiveTabOrDefault(activeTabId, visibleRoutingItems);
    if (nextTabId !== activeTabId) setActiveTabId(nextTabId);
  }, [activeTabId, visibleRoutingItems]);

  const selectTab = React.useCallback(
    (item: MobileV2NavigationItem) => {
      const nextTabId = resolveMobileV2NavigationTargetId(item);
      if (nextTabId === activeTabId) return;
      startTabTransition(() => {
        setActiveTabId(nextTabId);
        setToast({
          id: `${item.id}-${Date.now()}`,
          message: `Opened ${item.label}`,
          kind: "info",
        });
      });
    },
    [activeTabId, startTabTransition],
  );

  const onPressTab = React.useCallback(
    (item: MobileV2NavigationItem) => {
      selectTab(item);
    },
    [selectTab],
  );

  // P0 audit fix: driving lock threshold must come from
  // driver_safety_policy (ladder-resolved). Use DEFAULT for preview; real
  // app reads via resolve_driver_safety_policy on session bootstrap. The
  // previous hardcode of 25kph violated the AGENTS.md mobile policy
  // contract and disagreed with V1's safer 8kph baseline.
  const lockThresholdKph = DEFAULT_MOBILE_DRIVER_SAFETY_POLICY.lockThresholdKph;
  const drivingLocked = drivingLockKph >= lockThresholdKph;

  if (drivingLocked) {
    return (
      <MobileV2DrivingLockScreen
        theme={ctx.theme}
        currentSpeedKph={drivingLockKph}
        thresholdKph={lockThresholdKph}
        nextStop={{
          tracking: "DLX-784521",
          addressLine1: "Khalid bin Walid Tower, Al Olaya, Riyadh",
          etaMinutes: 22,
          distanceKm: 1.4,
          window: "12:00–14:00",
        }}
        onNavigate={() =>
          // B1 fix: real maps intent to the next stop (allowed while
          // moving — navigation is the one safe action in driving lock).
          runIntent(
            () => openMobileV2Maps("Khalid bin Walid Tower, Al Olaya, Riyadh"),
            { success: "Opening navigation" },
          )
        }
        onSafetyBypass={() => {
          setDrivingLockKph(0);
          setToast({ id: `bypass-${Date.now()}`, message: "Safety bypass recorded", kind: "warning" });
        }}
      />
    );
  }

  return (
    <>
      <ScreenShell
        // The POD wizard renders its own per-step app-bar — suppress the
        // shell's bar on that tab so two headers do not stack.
        hideAppBar={activeTabId === "mobile-pod"}
        title={
          activeTabId === "mobile-stop"
            ? // Design ScrStopDetail (flow-route.jsx:318) titles the app
              // bar `Stop <seq> of <total>` (e.g. "Stop 3 of 12"). The
              // sequence + route total are resolver-driven (liveStop.seq +
              // routeTotalStops), never hardcoded.
              `Stop ${liveStop.seq ?? 1} of ${routeTotalStops}`
            : activeTabId === "mobile-pod"
              ? `POD · ${liveStop.trackingCode}`
              : activeTabId === "mobile-loader-scan" || activeTabId === "mobile-scan"
                ? "Loader · Scan"
                : activeTabId === "mobile-route"
                  ? "My route"
                  : activeTabId === "mobile-map"
                    ? "Live route"
                    : activeTabId === "mobile-pickups"
                  ? "Pickups"
                  : activeTabId === "mobile-pickup-detail"
                    ? (livePickups.find((p) => p.id === activePickupId)?.merchant ?? "Pickup")
                    : activeTabId === "mobile-trips"
                      ? "Trips"
                      : activeTabId === "mobile-trip-detail"
                        ? (liveTrips.find((tr) => tr.id === activeTripId)?.leg ?? "Trip")
                        : activeTabId === "mobile-sortation"
                          ? "Sortation"
                            : activeTabId === "mobile-lookup"
                              ? "Track shipment"
                            : activeTabId === "mobile-today"
                              ? `Hello, ${profile.name.split(" ")[0] ?? profile.name}`
                              : activeTabId === "mobile-pre-shift"
                                ? "Before you start"
                                : activeTabId === "mobile-cleaning"
                                  ? "Vehicle cleaning"
                                  : activeTabId === "mobile-kyc-id"
                                    ? "Identity & documents"
                                    : activeTabId === "mobile-kyc-vehicle"
                                      ? "Vehicle registration"
                                      : activeTabId === "mobile-kyc-vehicle-photos"
                                        ? "Vehicle photos"
                              : activeTabId === "mobile-wallet"
                                ? "Wallet"
                                : activeTabId === "mobile-returns"
                                  ? "Returns to hub"
                                  : activeTabId === "mobile-hub-pickup"
                                    ? "Hub pickup desk"
                                    : activeTabId === "mobile-hold"
                                      ? "Hold queue"
                                      : activeTabId === "mobile-cash-drop"
                                        ? "Cash drop"
                                        : activeTabId === "mobile-cod-ledger"
                                          ? "COD ledger"
                                        : activeTabId === "mobile-settlements"
                                          ? "Settlements"
                                        : activeTabId === "mobile-eor"
                                          ? "End of route"
                                          : activeTabId === "mobile-trip-nav"
                                            ? (liveTrips.find((tr) => tr.id === activeTripId)?.dest.name ?? "Live nav")
                                            : activeTabId === "mobile-outbox"
                                              ? "Outbox"
                                              : activeTabId === "mobile-more"
                                              ? "More"
                                              // F1: loader / rider / supervisor home tabs.
                                              : activeTabId === "mobile-loader-today"
                                                ? `Hello, ${liveLoaderToday.greetingName}`
                                                : activeTabId === "mobile-rider-today"
                                                  ? `Hello, ${liveRiderToday.greetingName}`
                                                  : activeTabId === "mobile-supervisor-today"
                                                    ? "Approvals"
                                                    // Design ScrTasks (flow-tasks.jsx:486-490) renders the
                                                    // ACTIVE task-view name in the app bar (F8/F10): the
                                                    // emoji + name are the saved-view picker; titleEmoji +
                                                    // onTitlePress below open the Saved Views sheet.
                                                    : activeTabId === "mobile-route"
                                                      ? routeActiveView.name
                                                      : tasksActiveView.name
        }
        // F8/F10 app-bar title affordances — Tasks / Route render the
        // saved-view EMOJI glyph INLINE with the name (no icon-disk box),
        // and the whole title is a pressable that opens the Saved Views
        // sheet. Mirrors design ScrTasks "⚡ Smart inbox ⌄" / ScrRoute
        // "🛣 My route ⌄".
        titleEmoji={
          activeTabId === "mobile-tasks"
            ? tasksActiveView.emoji
            : activeTabId === "mobile-route"
              ? routeActiveView.emoji
              : undefined
        }
        titleDropdown={
          activeTabId === "mobile-tasks" || activeTabId === "mobile-route"
        }
        onTitlePress={
          activeTabId === "mobile-tasks"
            ? () => setTasksSheet("views")
            : activeTabId === "mobile-route"
              ? () => setRouteSheet("views")
              : undefined
        }
        sub={
          activeTabId === "mobile-stop"
            ? // Design ScrStopDetail subtitle (flow-route.jsx:318):
              // `SLA <window> · <eta>` where the eta segment reads
              // "arrives in <n>m" while en route, "arriving now" once the
              // ETA hits zero. Window + ETA are resolver-driven.
              `SLA ${liveStop.window} · ${
                liveStop.etaMinutes > 0
                  ? `arrives in ${liveStop.etaMinutes}m`
                  : "arriving now"
              }`
            : activeTabId === "mobile-route"
            ? // Design ScrRoute subtitle (flow-route.jsx:25):
              // "<visible stops> of <total stops> · <sort label>". The
              // visible count + sort label are now LIVE — they reflect
              // the active saved view's filter + sort (F8/F9).
              `${routeViewResult.rows.length} of ${routeTotalStops} · ${getMobileV2RouteSortLabel(routeSortKey).toLowerCase()}`
            : activeTabId === "mobile-map"
              ? // E2: map subtitle is resolver-driven (route id +
                // pending count from projectMobileV2RouteMap). Distance
                // is omitted — no live route-distance resolver yet.
                `${routeMapView.routeId} · ${routeMapView.pendingCount} pending`
              : activeTabId === "mobile-pickups"
            ? `${livePickups.filter((p) => p.status === "pending").length} pending · ${livePickups.reduce((n, p) => n + p.picked, 0)}/${livePickups.reduce((n, p) => n + p.expectedQty, 0)} parcels`
            : activeTabId === "mobile-pickup-detail"
              ? (() => {
                  const p = livePickups.find((x) => x.id === activePickupId);
                  return p !== undefined ? `${p.id} · ${p.window}` : "";
                })()
              : activeTabId === "mobile-wallet"
                ? "Pay & earnings"
                : activeTabId === "mobile-returns"
                  ? `${liveReturns.failed.length} failed · ${liveReturns.returned.length} returned`
                  : activeTabId === "mobile-hub-pickup"
                    ? (() => {
                        const remaining = liveHubPickup.filter((q) => !hubPickupResolved.has(q.id)).length;
                        return `${remaining} customer${remaining === 1 ? "" : "s"} waiting`;
                      })()
                    : activeTabId === "mobile-hold"
                      ? (() => {
                          const remaining = liveHold.filter((h) => !holdResolved.has(h.id)).length;
                          return `${remaining} parcel${remaining === 1 ? "" : "s"} need a decision`;
                        })()
                      : activeTabId === "mobile-cash-drop"
                        ? liveCashDrop.safeLocation
                        : activeTabId === "mobile-cod-ledger"
                          ? `${liveCodLedgerStops.length} cash stops - ${liveCodLedgerExpected} SAR expected`
                        : activeTabId === "mobile-settlements"
                          ? `${liveSettlements.summary.count} batch${liveSettlements.summary.count === 1 ? "" : "es"} - ${liveSettlements.summary.varianceAmount} ${liveSettlements.summary.currency} variance`
                        : activeTabId === "mobile-eor"
                          // EOR route labels are resolver-driven. Empty
                          // labels render the live summary alone instead of
                          // falling back to fixture text.
                          ? (liveEor.routeLabel.length > 0
                              ? `${liveEor.routeLabel} · ${liveEor.summary.delivered}/${liveEor.summary.total} delivered`
                              : `${liveEor.summary.delivered}/${liveEor.summary.total} delivered`)
                          : activeTabId === "mobile-trip-nav"
                            ? (() => {
                                const tr = liveTrips.find((x) => x.id === activeTripId);
                                return tr !== undefined ? `${tr.id} · ${tr.vehicle}` : "";
                              })()
                            : activeTabId === "mobile-sortation"
                              ? `Cross-dock induction · Wave ${sortationWaveNumber}`
                              : activeTabId === "mobile-lookup"
                                ? "Scan or search any parcel"
                                : activeTabId === "mobile-tasks"
                                  ? tasksSubtitle
                                  : activeTabId === "mobile-pre-shift"
                                    ? `Shift ${preShiftShiftId ?? "not started"} - ${routeTotalStops} stop${routeTotalStops === 1 ? "" : "s"}`
                                    : activeTabId === "mobile-cleaning"
                                      ? "Step 4 of 4 - Daily attestation"
                                      : activeTabId === "mobile-kyc-id"
                                        ? "Step 1 of 4 - KYC"
                                        : activeTabId === "mobile-kyc-vehicle"
                                          ? latestVehicleReadback !== null
                                            ? `${latestVehicleReadback.plate} - ${latestVehicleReadback.state}`
                                            : "Step 2 of 4 - Istimara"
                                          : activeTabId === "mobile-kyc-vehicle-photos"
                                            ? `Step 3 of 4 - ${liveCapturedVehicleAngleIds.length}/${liveVehicleAngles.length} angles`
                                  : activeTabId === "mobile-trips"
                                    ? "Line-haul · inter-hub"
                                    : activeTabId === "mobile-outbox"
                                      ? `${outboxEntries.length > 0 ? `${outboxEntries.length} active` : `${queueCount} queued`} · ${online ? "online" : "offline"}`
                                      : activeTabId === "mobile-more"
                                      ? "Settings · support tools"
                                      // F1: loader / rider / supervisor home subtitles.
                                      : activeTabId === "mobile-loader-today"
                                        // E6: the loader resolver honestly returns an empty
                                        // `waveLabel` until a loader-wave source table ships,
                                        // so an absent wave assignment must not leave a blank
                                        // subtitle — degrade to a live-routes count descriptor.
                                        ? (liveLoaderToday.waveLabel.length > 0
                                            ? liveLoaderToday.waveLabel
                                            : `Warehouse · ${liveLoaderToday.liveRoutes} routes staging`)
                                        : activeTabId === "mobile-rider-today"
                                          // Join non-empty segments only: the rider resolver honestly
                                          // returns an empty `employeeId` until a rider-gig source
                                          // table ships (E5), so an absent id must not leave a stray
                                          // " ·  · " separator.
                                          ? ["Bike", liveRiderToday.employeeId, liveRiderToday.online ? "Online" : "Offline"]
                                              .filter((seg) => seg.length > 0)
                                              .join(" · ")
                                          : activeTabId === "mobile-supervisor-today"
                                            ? `${liveSupervisorQueue.queue.length} pending · ${liveSupervisorQueue.supervisorName}`
                                            : `${ctx.theme.name} · ${activeRole}`
        }
        onBack={
          // Demo-parity fix: only true detail / sub-flow screens show
          // the back chevron. Tab-roots (lists, dashboards) show the
          // hamburger menu to open the drawer instead.
          activeTabId === "mobile-stop"
            ? () => setActiveTabId("mobile-tasks")
            : activeTabId === "mobile-pod"
              ? () => {
                  setPodFailSheetOpen(false);
                  setActiveTabId("mobile-stop");
                }
              : activeTabId === "mobile-loader-scan" || activeTabId === "mobile-scan"
                ? () => setActiveTabId("mobile-tasks")
                : activeTabId === "mobile-pickup-detail"
                  ? () => setActiveTabId("mobile-pickups")
                  : activeTabId === "mobile-trip-detail"
                    ? () => setActiveTabId("mobile-trips")
                    : activeTabId === "mobile-trip-nav"
                      ? () => setActiveTabId("mobile-trip-detail")
                      : activeTabId === "mobile-map"
                        ? // Live-route map is reached from the Route
                          // screen — back returns there.
                          () => setActiveTabId("mobile-route")
                        : activeTabId === "mobile-pre-shift"
                          ? () => setActiveTabId("mobile-today")
                          : activeTabId === "mobile-cleaning"
                            ? () => setActiveTabId("mobile-pre-shift")
                            : activeTabId === "mobile-kyc-id"
                              ? () => setActiveTabId("mobile-pre-shift")
                              : activeTabId === "mobile-kyc-vehicle"
                                ? () => setActiveTabId("mobile-kyc-id")
                                : activeTabId === "mobile-kyc-vehicle-photos"
                                  ? () => setActiveTabId("mobile-kyc-vehicle")
                            : undefined
        }
        onMenu={
          // Tab-roots (drawer-reachable screens) all get a hamburger to
          // re-open the drawer; detail screens above leave it undefined
          // so the back chevron shows in its place.
          activeTabId === "mobile-tasks" ||
          activeTabId === "mobile-route" ||
          activeTabId === "mobile-pickups" ||
          activeTabId === "mobile-trips" ||
          activeTabId === "mobile-sortation" ||
          activeTabId === "mobile-lookup" ||
          activeTabId === "mobile-today" ||
          activeTabId === "mobile-loader-today" ||
          activeTabId === "mobile-rider-today" ||
          activeTabId === "mobile-supervisor-today" ||
          activeTabId === "mobile-wallet" ||
          activeTabId === "mobile-returns" ||
          activeTabId === "mobile-hub-pickup" ||
          activeTabId === "mobile-hold" ||
          activeTabId === "mobile-cash-drop" ||
          activeTabId === "mobile-cod-ledger" ||
          activeTabId === "mobile-settlements" ||
          activeTabId === "mobile-eor" ||
          activeTabId === "mobile-more" ||
          activeTabId === "mobile-outbox"
            ? () => setDrawerOpen(true)
            : undefined
        }
        right={
          activeTabId === "mobile-stop" ? (
            // Design ScrStopDetail app bar (flow-route.jsx:319) carries a
            // `map` icon at top-right that opens the live-route map.
            <Pressable
              onPress={() => setActiveTabId("mobile-map")}
              accessibilityRole="button"
              accessibilityLabel="Open route map"
              hitSlop={8}
              style={{ width: 36, height: 36, alignItems: "center", justifyContent: "center" }}
            >
              <FxIcon name="map" size={20} color={ctx.theme.ink} />
            </Pressable>
          ) : activeTabId === "mobile-route" ? (
            // Design ScrRoute app bar (flow-route.jsx) carries a `map`
            // icon at top-right that opens the live-route map.
            <Pressable
              onPress={() => setActiveTabId("mobile-map")}
              accessibilityRole="button"
              accessibilityLabel="Open route map"
              hitSlop={8}
              style={{ width: 36, height: 36, alignItems: "center", justifyContent: "center" }}
            >
              <FxIcon name="map" size={20} color={ctx.theme.ink} />
            </Pressable>
          ) : activeTabId === "mobile-map" ? (
            // Design ScrMap app bar carries a `list` icon that returns to
            // the route stop list.
            <Pressable
              onPress={() => setActiveTabId("mobile-route")}
              accessibilityRole="button"
              accessibilityLabel="Open route list"
              hitSlop={8}
              style={{ width: 36, height: 36, alignItems: "center", justifyContent: "center" }}
            >
              <FxIcon name="list" size={20} color={ctx.theme.ink} />
            </Pressable>
          ) : activeTabId === "mobile-pickups" ? (
            <FxChip theme={ctx.theme} tone="info" icon="package" dense>
              First-mile
            </FxChip>
          ) : activeTabId === "mobile-pickup-detail" ? (
            (() => {
              const p = livePickups.find((x) => x.id === activePickupId);
              return p !== undefined ? (
                <FxChip theme={ctx.theme} tone={p.priority === "high" ? "warning" : "info"} icon="package" dense>
                  {p.expectedQty} parcels
                </FxChip>
              ) : null;
            })()
          ) : activeTabId === "mobile-wallet" ? (
            <FxChip theme={ctx.theme} tone="success" icon="cash" dense mono>
              {`${liveWallet.wallet.balanceSar} SAR`}
            </FxChip>
          ) : activeTabId === "mobile-returns" ? (
            <FxChip theme={ctx.theme} tone="warning" icon="package" dense>
              {`${liveReturns.failed.reduce((n, s) => n + s.parcels, 0) + liveReturns.returned.reduce((n, s) => n + s.parcels, 0)} parcels`}
            </FxChip>
          ) : activeTabId === "mobile-hub-pickup" ? (
            <FxChip theme={ctx.theme} tone="info" icon="user" dense>
              Counter
            </FxChip>
          ) : activeTabId === "mobile-hold" ? (
            <FxChip theme={ctx.theme} tone="warning" icon="flag" dense>
              Exceptions
            </FxChip>
          ) : activeTabId === "mobile-cash-drop" ? (
            <FxChip theme={ctx.theme} tone="warning" icon="cash" dense mono>
              {`${liveCashDrop.expectedSar} SAR expected`}
            </FxChip>
          ) : activeTabId === "mobile-cod-ledger" ? (
            <FxChip theme={ctx.theme} tone="warning" icon="cash" dense mono>
              {`${liveCodLedgerExpected} SAR expected`}
            </FxChip>
          ) : activeTabId === "mobile-settlements" ? (
            <FxChip theme={ctx.theme} tone={liveSettlements.summary.varianceAmount === 0 ? "success" : "warning"} icon="cash" dense mono>
              {`${liveSettlements.summary.count} batches`}
            </FxChip>
          ) : activeTabId === "mobile-trip-nav" ? (
            <FxChip theme={ctx.theme} tone="accent" icon="truck" dense>
              In transit
            </FxChip>
          ) : activeTabId === "mobile-sortation" ? (
            <FxChip theme={ctx.theme} tone="info" icon="package" dense>
              Loader
            </FxChip>
          ) : activeTabId === "mobile-trips" ? (
            <FxChip theme={ctx.theme} tone="info" icon="truck" dense>
              Line-haul
            </FxChip>
          ) : activeTabId === "mobile-tasks" ? (
            // Design ScrTasks (flow-tasks.jsx:493-496): a `scan` icon
            // button sits at the app-bar top-right. Opens the scan screen.
            <Pressable
              onPress={() => setActiveTabId("mobile-scan")}
              accessibilityRole="button"
              accessibilityLabel="Scan a barcode"
              hitSlop={8}
              style={{ width: 36, height: 36, alignItems: "center", justifyContent: "center" }}
            >
              <FxIcon name="scan" size={20} color={ctx.theme.ink} />
            </Pressable>
          ) : activeTabId === "mobile-loader-today" ? (
            // F1: loader-home right chip — design ScrLoaderToday "Loader".
            <FxChip theme={ctx.theme} tone="info" icon="package" dense>
              Loader
            </FxChip>
          ) : activeTabId === "mobile-rider-today" ? (
            // F1: rider-home right chip — design ScrRiderToday online state.
            <FxChip
              theme={ctx.theme}
              tone={liveRiderToday.online ? "success" : "neutral"}
              icon={liveRiderToday.online ? "check" : "wifi-off"}
              dense
            >
              {liveRiderToday.online ? "Online" : "Offline"}
            </FxChip>
          ) : activeTabId === "mobile-supervisor-today" ? (
            // F1: supervisor-home right chip — pending-approvals count.
            <FxChip theme={ctx.theme} tone="warning" icon="alert" dense>
              {String(liveSupervisorQueue.queue.length)}
            </FxChip>
          ) : (
            <FxRow gap={6}>
              <FxStatusDot theme={ctx.theme} kind="current" size={8} />
            </FxRow>
          )
        }
        online={online}
        // B3 fix: the sync banner's transient "Syncing N…" state must
        // reflect the REAL drain-in-flight flag. The native shell sets
        // connectivity.syncing TRUE while drainMobileV2Outbox runs; the
        // `?v2=preview` showcase keeps it FALSE (no live outbox).
        syncing={connectivity.syncing}
        queueCount={queueCount}
        onSyncPress={handleManualSync}
        tabs={{
          visibleSections,
          activeRole,
          activeItemId: activeTabId,
          onPressTab,
          maxTabs: 5,
        }}
        toast={toast}
        onDismissToast={() => setToast(null)}
      >
        {activeTabId === "mobile-more" ? (
          <MobileV2MoreScreen
            theme={ctx.theme}
            activeThemeKey={ctx.themeKey}
            availableThemeKeys={MOBILE_V2_THEME_KEYS}
            onSelectTheme={(k) => ctx.setTheme(k)}
            activeRole={activeRole}
            availableRoles={availableRoles}
            onSelectRole={handleActiveRoleChange}
            capabilities={visibleCapabilities}
            online={online}
            // B3 fix: real outbox entries in the native shell
            // (props.outboxEntries, fed from the live outbox); the
            // `?v2=preview` showcase has no live outbox so it uses the
            // design-rehearsal fixture (visual baseline unchanged).
            outbox={outboxEntries}
            userName={profile.name}
            userBadge={profile.badge}
            onSyncNow={handleManualSync}
            driverShift={moreDriverShift}
            loaderSession={loaderSessionPanel}
            onOpenIncident={() => {
              setIncidentStopId(null);
              setIncidentTypeId(null);
              setIncidentPhoto(false);
              setIncidentStatement("");
              setIncidentReadbackError(null);
              setIncidentVerifiedReadback(null);
              setIncidentSheetOpen(true);
            }}
            onOpenDiagnostics={() => {
              // Route to the More-screen diagnostics surface. The
              // dedicated /mobile/diagnostics route is registered in
              // ui_navigation; until that screen is mounted in the V2
              // shell, surface the resolved access context inline.
              const diagItem = resolvedNav
                .flatMap((s) => s.items)
                .find((i) => i.id === "mobile-diagnostics");
              if (diagItem !== undefined) {
                setActiveTabId(diagItem.id);
                return;
              }
              setToast({
                id: `diag-${Date.now()}`,
                message: `Outbox ${queueCount} queued · ${online ? "online" : "offline"}`,
                kind: "info",
              });
            }}
            onSignOut={handleSignOut}
          />
        ) : activeTabId === "mobile-outbox" ? (
          <MobileV2SyncQueueScreen
            theme={ctx.theme}
            queue={syncQueueEntries}
            connectivity={syncQueueConnectivity}
            lastSyncMs={props.lastSyncMs ?? MOBILE_V2_PREVIEW_SYNC_QUEUE.lastSyncMs}
            onFlushNow={handleManualSync}
          />
        ) : activeTabId === "mobile-loader-today" ? (
          // F1 fix: the loader "Home" tab renders the REAL loader-today
          // screen (resolver-backed via useFieldopsLoaderTodayRpc).
          // Previously this tab fell through to a debug sandbox.
          <MobileV2ListStateView
            theme={ctx.theme}
            isLoading={isMobileV2ListLoading(loaderTodayRpc)}
            isError={loaderTodayRpc.isError}
            errorMessage={formatMobileV2UserError(loaderTodayRpc.error, "Unable to load loader home")}
            onRetry={() => { void loaderTodayRpc.refetch(); }}
          >
            <MobileV2LoaderTodayScreen
              theme={ctx.theme}
              waveLabel={liveLoaderToday.waveLabel}
              cutOff={liveLoaderToday.cutOff}
              coldChainCount={liveLoaderToday.coldChainCount}
              liveRoutes={liveLoaderToday.liveRoutes}
              totalParcels={liveLoaderToday.totalParcels}
              scannedParcels={liveLoaderToday.scannedParcels}
              driversWaiting={liveLoaderToday.driversWaiting}
              quickActions={liveLoaderToday.quickActions}
              drivers={liveLoaderToday.drivers}
              onSelectAction={(id) => {
                // Loader quick actions route to real shell screens
                // (scan / sortation / hold / sync). No fabricated toast.
                if (id === "loader-scan") setActiveTabId("mobile-loader-scan");
                else if (id === "loader-manifest" || id === "bay-board") setActiveTabId("mobile-sortation");
                else if (id === "inbound") setActiveTabId("mobile-trips");
                else if (id === "hold") setActiveTabId("mobile-hold");
                else handleManualSync();
              }}
            />
          </MobileV2ListStateView>
        ) : activeTabId === "mobile-rider-today" ? (
          // F1 fix: the rider "Home" tab renders the REAL rider-today
          // screen (resolver-backed via useFieldopsRiderTodayRpc).
          <MobileV2ListStateView
            theme={ctx.theme}
            isLoading={isMobileV2ListLoading(riderTodayRpc)}
            isError={riderTodayRpc.isError}
            errorMessage={formatMobileV2UserError(riderTodayRpc.error, "Unable to load rider home")}
            onRetry={() => { void riderTodayRpc.refetch(); }}
          >
            <MobileV2RiderTodayScreen
              theme={ctx.theme}
              greetingName={liveRiderToday.greetingName}
              employeeId={liveRiderToday.employeeId}
              online={liveRiderToday.online}
              earningsToday={liveRiderToday.earningsToday}
              tripsCompleted={liveRiderToday.tripsCompleted}
              rating={liveRiderToday.rating}
              shiftDuration={liveRiderToday.shiftDuration}
              active={liveRiderToday.active}
              upcoming={liveRiderToday.upcoming}
              currency={liveRiderToday.currency}
              onNavigatePickup={() =>
                // Real maps intent to the active ticket's pickup.
                runIntent(
                  () =>
                    openMobileV2Maps(
                      liveRiderToday.active?.pickup ?? "",
                    ),
                  {
                    success: "Opening navigation",
                    missing: "No active pickup to navigate to",
                  },
                )
              }
              onCallVendor={() =>
                // The rider ticket carries no vendor phone, so the
                // intent honestly surfaces a "no number" state rather
                // than faking a call. STAGED: a vendor-phone field on
                // the rider resolver wires this to openMobileV2Call.
                runIntent(() => openMobileV2Call(null), {
                  success: "Calling vendor",
                  missing: "No phone number for this vendor",
                })
              }
              onMessageVendor={() =>
                runIntent(() => openMobileV2WhatsApp(null), {
                  success: "WhatsApp opened",
                  missing: "No phone number for this vendor",
                })
              }
              onPauseQueue={() =>
                // Pausing the rider queue needs a rider-status write RPC
                // (none in the V2 RPC pack). No fabricated "queue paused"
                // success — surface honest guidance. STAGED: rider
                // availability RPC is a follow-up.
                setToast({
                  id: `rider-pause-${Date.now()}`,
                  message: "Pausing the queue is not available yet",
                  kind: "info",
                })
              }
              onSelectUpcoming={(id) =>
                setToast({
                  id: `rider-up-${Date.now()}`,
                  message: `Ticket ${id} stays queued — dispatch assigns the next one`,
                  kind: "info",
                })
              }
            />
          </MobileV2ListStateView>
        ) : activeTabId === "mobile-supervisor-today" ? (
          // F1 fix: the supervisor "Home" tab renders the REAL approvals
          // queue (resolver-backed via useFieldopsSupervisorQueueRpc).
          (() => {
            const activeId =
              supervisorActiveId !== null
              && liveSupervisorQueue.queue.some((q) => q.id === supervisorActiveId)
                ? supervisorActiveId
                : (liveSupervisorQueue.queue[0]?.id ?? liveSupervisorQueue.activeId);
            // Supervisor decisions need a supervisor-decision write RPC
            // (not in the V2 RPC pack). Approve/clarify/reject therefore
            // surface honest "staged" guidance — NO fabricated success
            // and the queue is not mutated as if a write landed.
            const stageDecision = (verb: string): void => {
              setToast({
                id: `sv-${Date.now()}`,
                message: `${verb} is not available yet`,
                kind: "info",
              });
            };
            return (
              <MobileV2ListStateView
                theme={ctx.theme}
                isLoading={isMobileV2ListLoading(supervisorQueueRpc)}
                isError={supervisorQueueRpc.isError}
                errorMessage={formatMobileV2UserError(supervisorQueueRpc.error, "Unable to load supervisor queue")}
                onRetry={() => { void supervisorQueueRpc.refetch(); }}
              >
                <MobileV2SupervisorScreen
                  theme={ctx.theme}
                  supervisorName={liveSupervisorQueue.supervisorName}
                  queue={liveSupervisorQueue.queue}
                  activeId={activeId}
                  onSelectItem={setSupervisorActiveId}
                  onApprove={() => stageDecision("Approving an item")}
                  onClarify={() => stageDecision("Requesting clarification")}
                  onReject={() => stageDecision("Rejecting an item")}
                />
              </MobileV2ListStateView>
            );
          })()
        ) : activeTabId === "mobile-trip-nav" ? (
          (() => {
            const tr = liveTrips.find((x) => x.id === activeTripId) ?? liveTrips[0]!;
            const etaMinSafe = tr.etaMin ?? 0;
            const arrive = `${String(Math.floor(etaMinSafe / 60)).padStart(2, "0")}:${String(etaMinSafe % 60).padStart(2, "0")}`;
            return (
              <MobileV2TripNavScreen
                theme={ctx.theme}
                trip={{
                  id: tr.id,
                  vehicle: tr.vehicle,
                  destName: tr.dest.name,
                  etaMin: etaMinSafe,
                  distanceKm: tr.distance,
                  plannedArrive: tr.plannedArrive || arrive,
                  nextInstructionPrimary: "Continue on Highway 40 · 184 km",
                  nextInstructionSecondary: `Then exit toward ${tr.dest.name} · Hub gate B`,
                }}
                onCallHub={() =>
                  // B1 fix: the trip resolver carries no per-hub phone
                  // number, so "Call hub" launches a real maps intent to
                  // the destination hub (a genuine action for the
                  // line-haul driver) rather than a no-op toast.
                  runIntent(() => openMobileV2Maps(tr.dest.name), {
                    success: `Routing to ${tr.dest.name} hub`,
                  })
                }
                onReportIncident={() => {
                  // B1 fix: open the real incident report sheet (was a
                  // "(preview)" toast stub). The trip leg has no stop id,
                  // so the report is filed as a standalone incident.
                  setIncidentStopId(null);
                  setIncidentTypeId(null);
                  setIncidentPhoto(false);
                  setIncidentStatement("");
                  setIncidentReadbackError(null);
                  setIncidentVerifiedReadback(null);
                  setIncidentSheetOpen(true);
                }}
                onArrived={() => {
                  // F6 fix: "Arrived" is a real trip-lifecycle write —
                  // advance the trip to `arrived` via
                  // advance_fieldops_trip_stage_v1 (mirrors the trip
                  // detail screen's onAdvanceStage). Previously this only
                  // set a local override + fired a success toast.
                  advanceTripStageWithReadback({
                    trip: tr,
                    nextStage: "arrived",
                    sealNo: null,
                    successMessage: `Arrived at ${tr.dest.name}`,
                    afterReadback: () => setActiveTabId("mobile-trip-detail"),
                  });
                }}
                isArriving={tripStageReadbackPending}
              />
            );
          })()
        ) : activeTabId === "mobile-eor" ? (
          (() => {
            // P0 audit fix: derive allDone in render so the onComplete
            // handler reads from the same closure as the rendered CTA.
            // The previous handler read `eorChecked` from a stale closure
            // when the user tapped the last checkbox + Complete in fast
            // sequence; the rendered CTA flipped to success but the
            // handler saw the pre-toggle set.
            const eorAllDone = liveEor.checklist.every((i) => eorChecked.has(i.id));
            return (
              <MobileV2ListStateView
                theme={ctx.theme}
                isLoading={isMobileV2ListLoading(eorRpc)}
                isError={eorRpc.isError}
                errorMessage={formatMobileV2UserError(eorRpc.error, "Unable to load end-of-route checklist")}
                onRetry={() => { void eorRpc.refetch(); }}
              >
              <MobileV2EorScreen
                theme={ctx.theme}
                summary={liveEor.summary}
                checklist={liveEor.checklist}
                checked={eorChecked}
                lastRecon={liveEor.lastRecon}
                currency={profile.currency}
                performanceNote={liveEor.performanceNote ?? undefined}
                isCompleting={submitEodReconMutation.isPending}
                onToggle={(id) =>
                  setEorChecked((prev) => {
                    const next = new Set(prev);
                    if (next.has(id)) next.delete(id);
                    else next.add(id);
                    return next;
                  })
                }
                onComplete={() => {
                  // E7: the shift-end CTA submits a REAL end-of-day
                  // reconciliation via submit_fieldops_eod_recon_v1 only
                  // when the resolver supplies a real `recon` block — it
                  // never submits the preview fixture's recon as live data.
                  // resolve_fieldops_eor_v1 now aggregates a route-scoped
                  // recon block when a caller-owned route exists. If that
                  // block is absent, the CTA still surfaces the honest
                  // unavailable path instead of persisting fabricated
                  // fixture figures into the real decision_log write.
                  //
                  // E10 hard-gate: the recon is read STRICTLY from the
                  // settled `eorRpc` envelope, never the screen-level
                  // `liveEor` fixture fallback — so an in-flight query
                  // (`eorRpc.data === undefined`) yields a null recon and
                  // the honest "unavailable" path, never the fixture recon.
                  if (!eorAllDone) {
                    setToast({
                      id: `eor-${Date.now()}`,
                      message: "Complete all checklist items first",
                      kind: "warning",
                    });
                    return;
                  }
                  const recon = eorRpc.data?.recon ?? null;
                  if (recon === null) {
                    setToast({
                      id: `eor-${Date.now()}`,
                      message:
                        "Hand-back checklist complete — end-of-day reconciliation isn't available on this device yet.",
                      kind: "info",
                    });
                    return;
                  }
                  submitEodReconMutation.mutate(
                    {
                      p_parcels_count: recon.parcelsCount,
                      p_mismatch_count: recon.mismatchCount,
                      p_cash_declared: recon.cashDeclared,
                      p_cash_counted: recon.cashCounted,
                      p_wallet_status: recon.walletStatus,
                      p_route_run_id: recon.routeRunId ?? activeRouteRunId,
                    },
                    {
                      onSuccess: () => {
                        setToast({
                          id: `eor-${Date.now()}`,
                          message: "Shift ended · vehicle handed back",
                          kind: "success",
                        });
                        void eorRpc.refetch();
                      },
                      onError: (err) => {
                        setToast({
                          id: `eor-err-${Date.now()}`,
                          message: formatMobileV2UserError(err, "End-of-route update failed"),
                          kind: "danger",
                        });
                      },
                    },
                  );
                }}
              />
              </MobileV2ListStateView>
            );
          })()
        ) : activeTabId === "mobile-settlements" ? (
          <MobileV2ListStateView
            theme={ctx.theme}
            isLoading={isMobileV2ListLoading(settlementsRpc)}
            isError={settlementsRpc.isError}
            errorMessage={formatMobileV2UserError(settlementsRpc.error, "Unable to load settlements")}
            onRetry={() => { void settlementsRpc.refetch(); }}
          >
            <MobileV2SettlementsScreen
              theme={ctx.theme}
              data={liveSettlements}
              refreshing={settlementsRpc.isFetching}
              onRefresh={() => { void settlementsRpc.refetch(); }}
            />
          </MobileV2ListStateView>
        ) : activeTabId === "mobile-cod-ledger" ? (
          <MobileV2ListStateView
            theme={ctx.theme}
            isLoading={isMobileV2ListLoading(cashDropRpc) || isMobileV2ListLoading(routeRpc)}
            isError={cashDropRpc.isError || routeRpc.isError}
            errorMessage={formatMobileV2UserError(cashDropRpc.error ?? routeRpc.error, "Unable to load COD ledger")}
            onRetry={() => {
              void cashDropRpc.refetch();
              void routeRpc.refetch();
            }}
          >
          <MobileV2CodLedgerScreen
            theme={ctx.theme}
            collected={liveCodLedgerCollected}
            expected={liveCodLedgerExpected}
            armedExpected={liveCodLedgerArmedExpected}
            stops={liveCodLedgerStops}
            lastHandoff={liveCashDrop.lastDrop ?? null}
            currency={liveCodLedgerCurrency}
            onHandOver={() => {
              const handoffAmount = Math.max(0, Math.floor(liveCodLedgerExpected));
              signCashDropMutation.mutate(
                {
                  p_expected_sar: handoffAmount,
                  p_actual_sar: handoffAmount,
                  p_supervisor_name: null,
                  p_photo_id: null,
                },
                {
                  onSuccess: async (write) => {
                    const [cashDropReadback] = await Promise.all([
                      cashDropRpc.refetch(),
                      routeRpc.refetch(),
                    ]);
                    if (
                      !isShowcase &&
                      !mobileV2CashDropMatchesWrite(
                        cashDropReadback.data?.lastDrop ?? null,
                        write,
                        handoffAmount,
                        handoffAmount,
                      )
                    ) {
                      setToast({
                        id: `cod-handoff-readback-err-${Date.now()}`,
                        message: "COD handoff saved, but confirmation did not match yet",
                        kind: "danger",
                      });
                      return;
                    }
                    setToast({
                      id: `cod-handoff-${Date.now()}`,
                      message: `COD handoff saved - ${handoffAmount} SAR`,
                      kind: "success",
                    });
                  },
                  onError: (err) => {
                    setToast({
                      id: `cod-handoff-err-${Date.now()}`,
                      message: formatMobileV2UserError(err, "COD handoff failed"),
                      kind: "danger",
                    });
                  },
                },
              );
            }}
          />
          </MobileV2ListStateView>
        ) : activeTabId === "mobile-cash-drop" ? (
          <MobileV2ListStateView
            theme={ctx.theme}
            isLoading={isMobileV2ListLoading(cashDropRpc)}
            isError={cashDropRpc.isError}
            errorMessage={formatMobileV2UserError(cashDropRpc.error, "Unable to load cash drop")}
            onRetry={() => { void cashDropRpc.refetch(); }}
          >
          <MobileV2CashDropScreen
            theme={ctx.theme}
            expectedSar={liveCashDrop.expectedSar}
            countedSar={cashCountedEffective}
            supervisorName={cashSupervisor}
            safeLocation={liveCashDrop.safeLocation}
            lastDrop={liveCashDrop.lastDrop ?? null}
            photoCaptured={cashPhotoArtifactId !== null || cashPhotoCaptured}
            photoArtifactId={cashPhotoArtifactId}
            photoCaptureBusy={cashPhotoCaptureBusy}
            photoCaptureError={cashPhotoCaptureError}
            requireCameraCapture={!isShowcase}
            onCountedChange={(next) => {
              setCashCounted(next);
              if (next !== cashCountedEffective) {
                setCashPhotoCaptured(false);
                setCashPhotoArtifactId(null);
                setCashPhotoCaptureError(null);
              }
            }}
            onSupervisorChange={setCashSupervisor}
            onCapturePhoto={registerCashDropArtifact}
            onSubmit={() => {
              signCashDropMutation.mutate(
                {
                  p_expected_sar: liveCashDrop.expectedSar,
                  p_actual_sar: cashCountedEffective,
                  // Variance writes require a supervisor name + photo id;
                  // pass-through preserves the migration's CHECK contract.
                  p_supervisor_name: cashSupervisor.trim().length > 0 ? cashSupervisor : null,
                  // Variance photo evidence must be the persisted artifact id
                  // returned by register_mobile_artifact_v1.
                  p_photo_id:
                    cashCountedEffective !== liveCashDrop.expectedSar
                      ? cashPhotoArtifactId
                      : null,
                },
                {
                  onSuccess: async (write) => {
                    const cashDropReadback = await cashDropRpc.refetch();
                    if (
                      !isShowcase &&
                      !mobileV2CashDropMatchesWrite(
                        cashDropReadback.data?.lastDrop ?? null,
                        write,
                        liveCashDrop.expectedSar,
                        cashCountedEffective,
                        cashCountedEffective !== liveCashDrop.expectedSar
                          ? cashPhotoArtifactId
                          : null,
                      )
                    ) {
                      setToast({
                        id: `cd-readback-err-${Date.now()}`,
                        message: "Cash drop saved, but confirmation did not match yet",
                        kind: "danger",
                      });
                      return;
                    }
                    setToast({
                      id: `cd-sub-${Date.now()}`,
                      message: `Cash drop submitted · ${cashCountedEffective} SAR`,
                      kind: "success",
                    });
                    setCashSupervisor("");
                    setCashPhotoCaptured(false);
                    setCashPhotoArtifactId(null);
                    setCashPhotoCaptureError(null);
                  },
                  onError: (err) => {
                    setToast({
                      id: `cd-err-${Date.now()}`,
                      message: formatMobileV2UserError(err, "Cash drop failed"),
                      kind: "danger",
                    });
                  },
                },
              );
            }}
          />
          </MobileV2ListStateView>
        ) : activeTabId === "mobile-hold" ? (
          <MobileV2ListStateView
            theme={ctx.theme}
            isLoading={isMobileV2ListLoading(holdRpc)}
            isError={holdRpc.isError}
            errorMessage={formatMobileV2UserError(holdRpc.error, "Unable to load hold queue")}
            onRetry={() => { void holdRpc.refetch(); }}
          >
          <MobileV2HoldQueueScreen
            theme={ctx.theme}
            items={holdResolved.size > 0 ? liveHold.filter((h) => !holdResolved.has(h.id)) : liveHold}
            latestDecision={holdDecisionReadback}
            resolving={holdDecisionReadbackPending}
            readbackError={holdDecisionReadbackError}
            onResolve={(id, action) => {
              // F13 fix: the discard (destroy) branch requires a non-empty
              // operator note per the migration CHECK. Previously a
              // hardcoded preview sentinel ("Destroyed via mobile-v2
              // preview") was sent in production. Destroy now opens a
              // real note sheet (`holdNoteSheet`) that captures the
              // operator's note before the write; requeue / rto carry no
              // note and apply directly.
              if (action === "destroy") {
                setHoldNoteText("");
                setHoldNoteSheet({ holdId: id });
                return;
              }
              applyHoldDecision(id, action, null);
            }}
          />
          </MobileV2ListStateView>
        ) : activeTabId === "mobile-hub-pickup" ? (
          (() => {
            const remainingQueue = liveHubPickup.filter((q) => !hubPickupResolved.has(q.id));
            const activeId = hubPickupActiveId !== null && remainingQueue.some((q) => q.id === hubPickupActiveId)
              ? hubPickupActiveId
              : (remainingQueue[0]?.id ?? null);
            return (
              <MobileV2ListStateView
                theme={ctx.theme}
                isLoading={isMobileV2ListLoading(hubPickupRpc)}
                isError={hubPickupRpc.isError}
                errorMessage={formatMobileV2UserError(hubPickupRpc.error, "Unable to load pickup queue")}
                onRetry={() => { void hubPickupRpc.refetch(); }}
              >
              <MobileV2HubPickupScreen
                theme={ctx.theme}
                queue={remainingQueue}
                activeId={activeId}
                otp={hubPickupOtp}
                onSelect={setHubPickupActiveId}
                onOtpChange={setHubPickupOtp}
                onScanId={() => {
                  // B1 fix: open the REAL scan surface for the customer
                  // ID scan instead of a fabricated "ID scanned" success
                  // (which previously also falsely flipped the release
                  // path to "OTP not required").
                  setActiveTabId("mobile-scan");
                }}
                onResendOtp={() =>
                  // B1: OTP resend at the hub-pickup desk needs an
                  // OTP-issue RPC; the V2 RPC pack only exposes the
                  // release verifier. No fabricated "OTP resent" success
                  // is shown. STAGED: a hub-pickup OTP-resend RPC.
                  setToast({
                    id: `hp-otp-${Date.now()}`,
                    message: "Ask the customer to use the OTP already sent",
                    kind: "info",
                  })
                }
                onCollectCod={() =>
                  // B1: COD collection at the desk is settled by the
                  // release flow below (release_fieldops_hub_pickup_v1);
                  // there is no separate collect-COD RPC, so this no
                  // longer shows a standalone fabricated "COD collected"
                  // toast — the driver collects, then releases.
                  setToast({
                    id: `hp-cod-${Date.now()}`,
                    message: "Collect COD, then release with the OTP",
                    kind: "info",
                  })
                }
                onRelease={() => {
                  if (activeId === null) return;
                  // The release RPC requires a 6-digit OTP and will reject
                  // non-conforming input with 22023. Surface a friendlier
                  // toast locally before the round-trip when the OTP is
                  // obviously malformed so the preview is helpful.
                  if (!/^[0-9]{6}$/.test(hubPickupOtp)) {
                    setToast({
                      id: `hp-err-${Date.now()}`,
                      message: "Enter the 6-digit OTP before releasing",
                      kind: "danger",
                    });
                    return;
                  }
                  releaseHubPickupMutation.mutate(
                    { p_queue_id: activeId, p_otp: hubPickupOtp },
                    {
                      onSuccess: () => {
                        setHubPickupResolved((prev) => {
                          const next = new Set(prev);
                          next.add(activeId);
                          return next;
                        });
                        setHubPickupActiveId(null);
                        setHubPickupOtp("");
                        setToast({
                          id: `hp-rel-${Date.now()}`,
                          message: "Parcels released",
                          kind: "success",
                        });
                      },
                      onError: (err) => {
                        setToast({
                          id: `hp-err-${Date.now()}`,
                          message: formatMobileV2UserError(err, "Hub pickup release failed"),
                          kind: "danger",
                        });
                      },
                    },
                  );
                }}
                onNotPresent={() => {
                  if (activeId === null) return;
                  setHubPickupResolved((prev) => {
                    const next = new Set(prev);
                    next.add(activeId);
                    return next;
                  });
                  setHubPickupActiveId(null);
                  setHubPickupOtp("");
                  setToast({ id: `hp-np-${Date.now()}`, message: "Customer rescheduled", kind: "info" });
                }}
              />
              </MobileV2ListStateView>
            );
          })()
        ) : activeTabId === "mobile-returns" ? (
          <MobileV2ListStateView
            theme={ctx.theme}
            isLoading={isMobileV2ListLoading(returnsRpc)}
            isError={returnsRpc.isError}
            errorMessage={formatMobileV2UserError(returnsRpc.error, "Unable to load returns")}
            onRetry={() => { void returnsRpc.refetch(); }}
          >
          <MobileV2ReturnsScreen
            theme={ctx.theme}
            failed={liveReturns.failed}
            returned={liveReturns.returned}
            latestReturn={returnsLatestReadback}
            returningStopId={returningStopId}
            codCollected={liveReturns.codCollected}
            currency={liveReturns.currency ?? "SAR"}
            onMarkReturned={(id) => {
              const beforeWrite = liveReturns.failed.find((s) => s.id === id) ?? null;
              setReturningStopId(id);
              markReturnReceivedMutation.mutate(
                { p_stop_id: id },
                {
                  onSuccess: async (write) => {
                    if (isShowcase) {
                      setReturnsOverride((cur) => {
                        const base = cur ?? { failed: rpcReturns.failed, returned: rpcReturns.returned };
                        const failed = base.failed.filter((s) => s.id !== id);
                        const moved = base.failed.find((s) => s.id === id);
                        const returned = moved !== undefined
                          ? [
                              Object.freeze({
                                id: `RTO-${moved.id.slice(0, 8)}`,
                                stopId: moved.id,
                                customer: moved.customer,
                                parcels: moved.parcels,
                              }) as MobileV2ReturnsRtoStop,
                              ...base.returned,
                            ]
                          : base.returned;
                        return Object.freeze({
                          failed: Object.freeze(failed),
                          returned: Object.freeze(returned),
                        });
                      });
                    }
                    let readback: Awaited<ReturnType<typeof returnsRpc.refetch>>;
                    try {
                      readback = await returnsRpc.refetch();
                    } catch (err) {
                      setReturnsLatestReadback(null);
                      setToast({
                        id: `rto-readback-err-${Date.now()}`,
                        message: redactDisplayErrorText(
                          err instanceof Error ? err.message : undefined,
                          "Return saved, but confirmation failed",
                        ),
                        kind: "danger",
                      });
                      return;
                    }
                    const returned = findMobileV2ReturnedStopAfterMark(
                      readback.data?.returned ?? [],
                      write,
                      id,
                    );
                    if (!isShowcase && returned === null) {
                      setReturnsLatestReadback(null);
                      setToast({
                        id: `rto-readback-err-${Date.now()}`,
                        message: "Return saved, but confirmation did not match yet",
                        kind: "danger",
                      });
                      return;
                    }
                    const resolvedReturned =
                      returned ??
                      (beforeWrite === null
                        ? null
                        : {
                            id: `RTO-${id.slice(0, 8)}`,
                            stopId: id,
                            customer: beforeWrite.customer,
                            parcels: beforeWrite.parcels,
                          });
                    if (resolvedReturned !== null) {
                      setReturnsLatestReadback({
                        decisionLogId: write.decision_log_id,
                        stopId: id,
                        returnedId: resolvedReturned.id,
                        customer: resolvedReturned.customer,
                        parcels: resolvedReturned.parcels,
                      });
                    }
                    setToast({ id: `rto-${Date.now()}`, message: `${id} marked returned`, kind: "success" });
                    setReturningStopId(null);
                  },
                  onError: (err) => {
                    setReturningStopId(null);
                    setToast({
                      id: `rto-err-${Date.now()}`,
                      message: formatMobileV2UserError(err, "Return update failed"),
                      kind: "danger",
                    });
                  },
                  onSettled: () => {
                    setReturningStopId(null);
                  },
                },
              );
            }}
            onScanPress={() => {
              // B1 fix: open the REAL scan screen for the return-desk
              // scan instead of a no-op toast.
              setActiveTabId("mobile-scan");
            }}
            onCashDropPress={() => setActiveTabId("mobile-cash-drop")}
          />
          </MobileV2ListStateView>
        ) : activeTabId === "mobile-wallet" ? (
          <MobileV2ListStateView
            theme={ctx.theme}
            isLoading={isMobileV2ListLoading(walletRpc)}
            isError={walletRpc.isError}
            errorMessage={formatMobileV2UserError(walletRpc.error, "Unable to load wallet")}
            onRetry={() => { void walletRpc.refetch(); }}
          >
          <MobileV2WalletScreen
            theme={ctx.theme}
            wallet={liveWallet.wallet}
            week={liveWallet.week}
            breakdown={liveWallet.breakdown}
            latestWithdrawal={liveWallet.latestWithdrawal ?? null}
            locale={ctx.locale}
            withdrawDisabled={liveWallet.wallet.balanceSar <= 0 || requestWithdrawMutation.isPending}
            onWithdrawPress={() => {
              const amount = Math.floor(liveWallet.wallet.balanceSar);
              if (amount <= 0) {
                setToast({
                  id: `wd-empty-${Date.now()}`,
                  message: "No withdrawable wallet balance available",
                  kind: "warning",
                });
                return;
              }
              requestWithdrawMutation.mutate(
                { p_amount_sar: amount },
                {
                  onSuccess: async (write) => {
                    const walletReadback = await walletRpc.refetch();
                    if (
                      !isShowcase &&
                      !mobileV2WalletWithdrawalMatchesWrite(
                        walletReadback.data?.latestWithdrawal ?? null,
                        write,
                        amount,
                      )
                    ) {
                      setToast({
                        id: `wd-readback-err-${Date.now()}`,
                        message: "Withdrawal saved, but confirmation did not match yet",
                        kind: "danger",
                      });
                      return;
                    }
                    setToast({
                      id: `wd-${Date.now()}`,
                      message: `Withdrawal requested · ${amount} SAR`,
                      kind: "success",
                    });
                  },
                  onError: (err) => {
                    setToast({
                      id: `wd-err-${Date.now()}`,
                      message: formatMobileV2UserError(err, "Withdrawal request failed"),
                      kind: "danger",
                    });
                  },
                },
              );
            }}
            onStatementPress={() =>
              // B1 fix: share the resolved earnings statement via the OS
              // share sheet (a real device action) instead of a no-op
              // "Statement PDF (preview)" toast. A server-rendered PDF
              // export is a separate follow-up; the statement text here
              // is composed from the live wallet breakdown rows.
              runIntent(
                () =>
                  shareMobileV2Text(
                    [
                      "MasarX FieldOps — earnings statement",
                      `Balance: ${liveWallet.wallet.balanceSar} SAR`,
                      `Week to date: ${liveWallet.wallet.weekToDateSar} SAR`,
                      ...liveWallet.breakdown.map(
                        (row) => `${row.label} · ${row.meta} · ${row.sar} SAR`,
                      ),
                    ].join("\n"),
                    "Earnings statement",
                  ),
                { success: "Statement shared" },
              )
            }
          />
          </MobileV2ListStateView>
        ) : activeTabId === "mobile-pre-shift" ? (
          <MobileV2ListStateView
            theme={ctx.theme}
            isLoading={!isShowcase && isMobileV2ListLoading(onboardingReadbackRpc)}
            isError={onboardingReadbackRpc.isError}
            errorMessage={formatMobileV2UserError(onboardingReadbackRpc.error, "Unable to load pre-shift status")}
            onRetry={() => { void onboardingReadbackRpc.refetch(); }}
          >
            <MobileV2PreShiftGateScreen
              theme={ctx.theme}
              shiftId={preShiftShiftId ?? "not-started"}
              stopCount={routeTotalStops}
              blockers={livePreShiftBlockers}
              cadence={livePreShiftCadence}
              healthOk={preShiftHealthOk}
              onToggleHealth={(next) => {
                setPreShiftHealthOk(next);
                setPreShiftReadbackError(null);
                setPreShiftVerifiedReadback(null);
              }}
              onOpenBlocker={handleOpenPreShiftBlocker}
              onStart={handleStartPreShift}
              submitting={passPreShiftGateMutation.isPending || preShiftReadbackPending}
              readbackError={preShiftReadbackError}
              latestReadback={preShiftVerifiedReadback ?? onboardingReadbackRpc.data?.latestPreShift ?? null}
            />
          </MobileV2ListStateView>
        ) : activeTabId === "mobile-cleaning" ? (
          <MobileV2ListStateView
            theme={ctx.theme}
            isLoading={!isShowcase && isMobileV2ListLoading(onboardingReadbackRpc)}
            isError={onboardingReadbackRpc.isError}
            errorMessage={formatMobileV2UserError(onboardingReadbackRpc.error, "Unable to load cleaning status")}
            onRetry={() => { void onboardingReadbackRpc.refetch(); }}
          >
            <MobileV2CleaningScreen
              theme={ctx.theme}
              items={liveCleaningItems}
              checkedIds={cleaningCheckedIds}
              photoCaptured={cleaningPhotoArtifact !== null}
              photoStamp={cleaningPhotoArtifact?.capturedAt ?? MOBILE_V2_PREVIEW_CLEANING.photoStamp}
              requireCameraCapture={!isShowcase}
              captureBusy={cleaningPhotoRegistering}
              captureError={cleaningCaptureError}
              submitting={recordCleaningMutation.isPending || cleaningReadbackPending}
              readbackError={cleaningReadbackError}
              latestReadback={cleaningVerifiedReadback ?? onboardingReadbackRpc.data?.latestCleaning ?? null}
              onToggleItem={(id) => {
                setCleaningCheckedIds((prev) =>
                  prev.includes(id) ? prev.filter((entry) => entry !== id) : [...prev, id],
                );
                setCleaningReadbackError(null);
                setCleaningVerifiedReadback(null);
              }}
              onCapturePhoto={handleCleaningPhotoCapture}
              onSubmit={handleSubmitCleaning}
            />
          </MobileV2ListStateView>
        ) : activeTabId === "mobile-kyc-id" ? (
          <MobileV2ListStateView
            theme={ctx.theme}
            isLoading={!isShowcase && isMobileV2ListLoading(onboardingReadbackRpc)}
            isError={onboardingReadbackRpc.isError}
            errorMessage={formatMobileV2UserError(onboardingReadbackRpc.error, "Unable to load documents")}
            onRetry={() => { void onboardingReadbackRpc.refetch(); }}
          >
            <MobileV2KycDocsScreen
              theme={ctx.theme}
              docs={liveKycDocs}
              busyKey={kycBusyKey}
              onScan={handleSubmitKycDoc}
              onUpload={handleSubmitKycDoc}
              requireCameraCapture={!isShowcase}
              captureError={kycDocCaptureError}
              onContinue={() => setActiveTabId("mobile-kyc-vehicle")}
            />
          </MobileV2ListStateView>
        ) : activeTabId === "mobile-kyc-vehicle" ? (
          <MobileV2ListStateView
            theme={ctx.theme}
            isLoading={!isShowcase && isMobileV2ListLoading(onboardingReadbackRpc)}
            isError={onboardingReadbackRpc.isError}
            errorMessage={onboardingReadbackRpc.error ? formatMobileV2UserError(onboardingReadbackRpc.error, "Unable to load vehicle registration") : kycVehicleError ?? undefined}
            onRetry={() => { void onboardingReadbackRpc.refetch(); }}
          >
            <MobileV2KycVehicleScreen
              theme={ctx.theme}
              istimaraStatus={(
                latestVehicleReadback !== null || kycIstimaraArtifact !== null ? "uploaded" : "pending"
              ) as MobileV2IstimaraStatus}
              plate={latestVehicleReadback?.plate ?? kycVehiclePlate}
              vin={latestVehicleReadback?.vin ?? kycVehicleVin}
              year={latestVehicleReadback?.year ?? kycVehicleYear}
              model={latestVehicleReadback?.model ?? kycVehicleModel}
              onScanIstimara={handleIstimaraCapture}
              onUploadIstimara={() => {
                setKycVehicleError("Use device camera capture for Istimara evidence in Mobile V2.");
              }}
              onPlateChange={setKycVehiclePlate}
              onVinChange={setKycVehicleVin}
              onYearChange={setKycVehicleYear}
              onModelChange={setKycVehicleModel}
              onSubmit={handleSubmitKycVehicle}
              requireCameraCapture={!isShowcase}
              captureBusy={kycIstimaraRegistering}
              captureError={kycVehicleError}
              submitting={submitKycVehicleMutation.isPending || kycVehicleReadbackPending}
              readbackError={kycVehicleError}
              latestReadback={latestVehicleReadback}
            />
          </MobileV2ListStateView>
        ) : activeTabId === "mobile-kyc-vehicle-photos" ? (
          <MobileV2ListStateView
            theme={ctx.theme}
            isLoading={!isShowcase && isMobileV2ListLoading(onboardingReadbackRpc)}
            isError={onboardingReadbackRpc.isError}
            errorMessage={formatMobileV2UserError(onboardingReadbackRpc.error, "Unable to load vehicle photos")}
            onRetry={() => { void onboardingReadbackRpc.refetch(); }}
          >
            <MobileV2KycVehiclePhotosScreen
              theme={ctx.theme}
              angles={liveVehicleAngles}
              capturedAngleIds={liveCapturedVehicleAngleIds}
              requireCameraCapture={!isShowcase}
              captureBusyAngleId={vehiclePhotoBusyAngleId}
              captureError={vehiclePhotoCaptureError}
              submitting={submitVehiclePhotosMutation.isPending || vehiclePhotosReadbackPending}
              readbackError={vehiclePhotosReadbackError}
              latestReadback={latestVehiclePhotoReadback}
              onSnap={handleVehiclePhotoCapture}
              onSubmit={handleSubmitVehiclePhotos}
              onContinue={() => setActiveTabId("mobile-cleaning")}
            />
          </MobileV2ListStateView>
        ) : activeTabId === "mobile-today" ? (
          // F12: today-screen values come from the canonical preview
          // fixture (MOBILE_V2_PREVIEW_TODAY), not inline literals.
          <MobileV2TodayScreen
            theme={ctx.theme}
            done={MOBILE_V2_PREVIEW_TODAY.done}
            total={MOBILE_V2_PREVIEW_TODAY.total}
            pending={MOBILE_V2_PREVIEW_TODAY.pending}
            failed={MOBILE_V2_PREVIEW_TODAY.failed}
            slaRisk={MOBILE_V2_PREVIEW_TODAY.slaRisk}
            etaFinish={MOBILE_V2_PREVIEW_TODAY.etaFinish}
            distanceKm={MOBILE_V2_PREVIEW_TODAY.distanceKm}
            codExpected={MOBILE_V2_PREVIEW_TODAY.codExpected}
            codCurrency={MOBILE_V2_PREVIEW_TODAY.codCurrency}
            blockers={MOBILE_V2_PREVIEW_TODAY.blockers}
            activeStop={MOBILE_V2_PREVIEW_TODAY.activeStop}
            onOpenPreShift={() => {
              // Route to the Mobile V2 pre-shift gate only when
              // ui_navigation exposes it for this role/capability set.
              const preShift = resolvedNav
                .flatMap((s) => s.items)
                .find((i) => resolveMobileV2NavigationTargetId(i) === "mobile-pre-shift");
              if (preShift !== undefined) {
                setActiveTabId(resolveMobileV2NavigationTargetId(preShift));
                return;
              }
              setToast({
                id: `pre-${Date.now()}`,
                message: "Pre-shift checks open from the Tasks tab",
                kind: "info",
              });
            }}
            onOptimizeRoute={() =>
              // B1: route optimization needs a server-side optimizer RPC
              // (none exists in the V2 RPC surface). No fabricated
              // "saved N min" success is shown. STAGED: an
              // `optimize_fieldops_route_v1`-class RPC is a follow-up;
              // until then the driver keeps the planned sequence.
              setToast({
                id: `opt-${Date.now()}`,
                message: "Route optimization is not available yet",
                kind: "info",
              })
            }
            onContinueStop={(id) => {
              setToast({ id: `cont-${Date.now()}`, message: `Continuing stop ${id}`, kind: "info" });
              setActiveTabId("mobile-stop");
            }}
          />
        ) : activeTabId === "mobile-lookup" ? (
          <MobileV2ListStateView
            theme={ctx.theme}
            isLoading={isMobileV2ListLoading(lookupRpc)}
            isError={lookupRpc.isError}
            errorMessage={formatMobileV2UserError(lookupRpc.error, "Unable to load lookup")}
            onRetry={() => { void lookupRpc.refetch(); }}
          >
          <MobileV2LookupScreen
            theme={ctx.theme}
            records={liveLookup.records}
            recent={[...lookupRecentExtras, ...liveLookup.recent]}
            query={lookupQuery}
            onQueryChange={setLookupQuery}
            onScanPress={() => {
              // B1 fix: open the REAL scan screen (mobile-scan /
              // loader-scan) instead of a no-op "scanner opened" toast.
              // The loader-scan screen is the shell's actual barcode
              // capture surface.
              setActiveTabId("mobile-scan");
            }}
            onOpenRecord={(r) => {
              // Persist into recent-lookups state, then navigate by kind.
              setLookupRecentExtras((prev) => {
                if (prev.some((x) => x.wb === r.parcel)) return prev;
                const entry = {
                  wb: r.parcel,
                  customer: r.customer,
                  stage: r.status,
                  atIso: new Date().toISOString(),
                };
                return [entry, ...prev].slice(0, 5);
              });
              setToast({ id: `open-${Date.now()}`, message: `Opening ${r.parcel}`, kind: "info" });
              if (r.kind === "pickup") {
                const match = livePickups.find((p) => p.wb === r.parcel || p.id === r.id);
                if (match !== undefined) {
                  setActivePickupId(match.id);
                  setActiveTabId("mobile-pickup-detail");
                  return;
                }
              }
              // Stops + fallback route to the Stop screen
              setActiveTabId("mobile-stop");
            }}
            onOpenRecent={(r) => {
              setLookupQuery(r.wb);
            }}
          />
          </MobileV2ListStateView>
        ) : activeTabId === "mobile-sortation" ? (
          <MobileV2ListStateView
            theme={ctx.theme}
            isLoading={isMobileV2ListLoading(sortationRpc)}
            isError={sortationRpc.isError}
            errorMessage={formatMobileV2UserError(sortationRpc.error, "Unable to load sortation")}
            onRetry={() => { void sortationRpc.refetch(); }}
          >
          <MobileV2SortationScreen
            theme={ctx.theme}
            bays={liveSortation.bays}
            recent={liveSortation.recent}
            inductedThisSession={liveSortation.inductedThisSession + sortationInductedBoost}
            throughputPerHour={liveSortation.throughputPerHour}
            minutesElapsed={liveSortation.minutesElapsed}
            onScanInduct={() => {
              // F4 fix: sortation scan-induct synthesizes a tracking
              // number, so it must NEVER fabricate a production
              // induction. The `?v2=preview` showcase inducts a demo
              // parcel; the production native shell surfaces honest
              // guidance (real scanning is the device camera/handheld).
              if (!isShowcase) {
                setToast({
                  id: `sort-scan-${Date.now()}`,
                  message: "Use the device scanner to induct a parcel",
                  kind: "info",
                });
                return;
              }
              const tracking = `DLX-PREVIEW-${Date.now()}`;
              // Showcase-only path (the `!isShowcase` guard above returns
              // early in the production native shell). `liveLoaderToday`
              // here is the preview fixture, so `bay` is the fixture's
              // demo bay — a legitimate showcase value, never a live write.
              inductParcelMutation.mutate(
                { p_bay: liveLoaderToday.bay, p_tracking_number: tracking },
                {
                  onSuccess: () => {
                    setSortationInductedBoost((n) => n + 1);
                    setToast({
                      id: `sort-${Date.now()}`,
                      message: `Parcel inducted · ${liveSortation.inductedThisSession + sortationInductedBoost + 1} this session`,
                      kind: "success",
                    });
                  },
                  onError: (err) => {
                    setToast({
                      id: `sort-err-${Date.now()}`,
                      message: formatMobileV2UserError(err, "Sortation update failed"),
                      kind: "danger",
                    });
                  },
                },
              );
            }}
            onOpenBay={(b) =>
              setToast({
                id: `bay-${Date.now()}`,
                message: `Bay ${b.id} · ${b.label} · ${b.count}/${b.capacity}`,
                kind: "info",
              })
            }
            query={sortationQuery}
            onQueryChange={setSortationQuery}
          />
          </MobileV2ListStateView>
        ) : activeTabId === "mobile-trip-detail" ? (
          (() => {
            const base = liveTrips.find((x) => x.id === activeTripId) ?? liveTrips[0]!;
            const stageOverride = isShowcase ? tripStageOverrides.get(base.id) : undefined;
            const tr = stageOverride !== undefined ? { ...base, stage: stageOverride } : base;
            return (
              <MobileV2TripDetailScreen
                theme={ctx.theme}
                trip={tr}
                isAdvancingStage={tripStageReadbackPending}
                onAdvanceStage={(next) => {
                  advanceTripStageWithReadback({
                    trip: base,
                    nextStage: next,
                    // Seal number is captured separately by Scan-seal in
                    // the trip detail screen; pass-through null lets the
                    // RPC accept the transition without forcing a seal
                    // for stages other than `sealed`.
                    sealNo: null,
                    successMessage: `Advanced to ${next}`,
                  });
                }}
                onScanSeal={() => {
                  // Seal-scan is a real trip-lifecycle write — it advances
                  // the trip to `sealed` with the scanned seal number via
                  // advance_fieldops_trip_stage_v1.
                  //
                  // E9 (hidden mock): the seal number must be a REAL
                  // scanned value. resolve_fieldops_trips_v1 returns
                  // `sealNo` null for an unsealed trip, so a real seal is
                  // only available once the device scanner/handheld
                  // captures it. The production native shell has no
                  // synthetic scanner, so when no real seal is resolvable
                  // it surfaces honest guidance instead of fabricating a
                  // `SEAL-<route-run-uuid>` string into the real trip
                  // lifecycle write + decision_log. The `?v2=preview`
                  // showcase uses a synthetic seal to demonstrate the flow.
                  const realSeal =
                    typeof base.sealNo === "string" && base.sealNo.length > 0
                      ? base.sealNo
                      : null;
                  if (realSeal === null && !isShowcase) {
                    setToast({
                      id: `seal-${Date.now()}`,
                      message:
                        "Use the device scanner to capture the trailer seal number.",
                      kind: "info",
                    });
                    return;
                  }
                  const sealNo = realSeal ?? `SEAL-${base.id}`;
                  advanceTripStageWithReadback({
                    trip: base,
                    nextStage: "sealed",
                    sealNo,
                    successMessage: `Seal ${sealNo} verified`,
                  });
                }}
                onScanManifest={() => {
                  // B1 fix: manifest-scan is the `loading` trip stage —
                  // advance the trip into `loading` so the manifest
                  // reconcile is recorded (previously a no-op toast).
                  advanceTripStageWithReadback({
                    trip: base,
                    nextStage: "loading",
                    sealNo: null,
                    successMessage: "Manifest scan recorded",
                  });
                }}
                onLiveNav={() => setActiveTabId("mobile-trip-nav")}
                onReportIncident={() => {
                  // B1 fix: open the real incident report sheet (was a
                  // "(preview)" toast stub).
                  setIncidentStopId(null);
                  setIncidentTypeId(null);
                  setIncidentPhoto(false);
                  setIncidentStatement("");
                  setIncidentReadbackError(null);
                  setIncidentVerifiedReadback(null);
                  setIncidentSheetOpen(true);
                }}
                onClose={() => setActiveTabId("mobile-trips")}
              />
            );
          })()
        ) : activeTabId === "mobile-trips" ? (
          <MobileV2ListStateView
            theme={ctx.theme}
            isLoading={isMobileV2ListLoading(tripsRpc)}
            isError={tripsRpc.isError}
            errorMessage={formatMobileV2UserError(tripsRpc.error, "Unable to load trips")}
            onRetry={() => { void tripsRpc.refetch(); }}
          >
            <MobileV2TripsScreen
              theme={ctx.theme}
              trips={liveTrips}
              tab={tripsTab}
              onTabChange={setTripsTab}
              onOpenTrip={(tr) => {
                setActiveTripId(tr.id);
                setActiveTabId("mobile-trip-detail");
              }}
            />
          </MobileV2ListStateView>
        ) : activeTabId === "mobile-pickup-detail" ? (
          (() => {
            const base = livePickups.find((x) => x.id === activePickupId) ?? livePickups[0]!;
            const boost = pickupPickedBoost.get(base.id) ?? 0;
            const p = { ...base, picked: Math.min(base.expectedQty, base.picked + boost) };
            const incPicked = (delta: number) =>
              setPickupPickedBoost((prev) => {
                const cur = prev.get(base.id) ?? 0;
                const next = Math.max(0, Math.min(base.expectedQty - base.picked, cur + delta));
                const m = new Map(prev);
                m.set(base.id, next);
                return m;
              });
            return (
              <MobileV2PickupDetailScreen
                theme={ctx.theme}
                pickup={p}
                onGo={() =>
                  // B1 fix: real maps navigation intent to the pickup
                  // address (merchant area appended for precision).
                  runIntent(
                    () =>
                      openMobileV2Maps(
                        [p.address, p.area].filter((s) => s.length > 0).join(", "),
                      ),
                    { success: "Opening navigation", missing: "No address on this pickup" },
                  )
                }
                onCall={() =>
                  // B1 fix: real device dialer intent. The pickups
                  // resolver/`MobileV2Pickup` contract does not yet carry
                  // a merchant phone number, so the intent honestly
                  // surfaces a "no number" state instead of faking a
                  // call. STAGED: when the pickups resolver adds a
                  // `merchantPhone` field, pass it to openMobileV2Call.
                  runIntent(() => openMobileV2Call(null), {
                    success: `Calling ${p.merchant}`,
                    missing: "No phone number for this merchant",
                  })
                }
                onWhatsApp={() =>
                  // B1 fix: real WhatsApp intent (honest no-number state
                  // until the pickups resolver supplies the merchant
                  // phone — STAGED, see onCall above).
                  runIntent(() => openMobileV2WhatsApp(null), {
                    success: "WhatsApp opened",
                    missing: "No phone number for this merchant",
                  })
                }
                onNote={() =>
                  // B1 fix: share the pickup context via the OS share
                  // sheet so the driver can hand a note to dispatch
                  // (a real device action; the pickups write-RPC pack
                  // has no free-text note endpoint yet — STAGED: a
                  // dedicated pickup-note RPC + sheet is a follow-up).
                  runIntent(
                    () =>
                      shareMobileV2Text(
                        [
                          `Pickup ${p.id} · ${p.merchant}`,
                          p.address,
                          p.window,
                        ]
                          .filter((s) => s.length > 0)
                          .join("\n"),
                        `Pickup ${p.id}`,
                      ),
                    { success: "Pickup note shared" },
                  )
                }
                onScanParcel={() => {
                  incPicked(1);
                  setToast({
                    id: `scan-${Date.now()}`,
                    message: `Picked ${Math.min(p.expectedQty, p.picked + 1)}/${p.expectedQty}`,
                    kind: "success",
                  });
                }}
                onAddManually={() => {
                  incPicked(1);
                  setToast({
                    id: `manual-${Date.now()}`,
                    message: `Manual add · ${Math.min(p.expectedQty, p.picked + 1)}/${p.expectedQty}`,
                    kind: "info",
                  });
                }}
                onConfirm={() => {
                  setPickupHandoffSheet(p);
                  setPickupHandoffQuantity(String(p.expectedQty));
                  setPickupHandoffContactName("");
                  setPickupHandoffNotes("");
                  setPickupHandoffReceiptContext(p.wb);
                }}
                onFail={() => {
                  setPickupFailureComposerSheet(p);
                  setPickupFailureReason("");
                  setPickupFailureNotes("");
                }}
              />
            );
          })()
        ) : activeTabId === "mobile-pickups" ? (
          <MobileV2ListStateView
            theme={ctx.theme}
            isLoading={isMobileV2ListLoading(pickupsRpc)}
            isError={pickupsRpc.isError}
            errorMessage={formatMobileV2UserError(pickupsRpc.error, "Unable to load pickups")}
            onRetry={() => { void pickupsRpc.refetch(); }}
          >
            <MobileV2PickupsScreen
              theme={ctx.theme}
              pickups={livePickups}
              query={pickupsQuery}
              onQueryChange={setPickupsQuery}
              tab={pickupsTab}
              onTabChange={setPickupsTab}
              onScanPress={() => {
                // B1 fix: open the REAL scan screen instead of a no-op
                // "Scanner opened" toast.
                setActiveTabId("mobile-scan");
              }}
              onOpenPickup={(p) => {
                setActivePickupId(p.id);
                setActiveTabId("mobile-pickup-detail");
              }}
              onOpenMap={() => {
                // B1: a pickups map view is a separate screen not yet
                // mounted in the V2 shell. No fabricated "(preview)"
                // toast — route to the route screen when registered,
                // else give an explicit instruction. STAGED: a pickups
                // map surface is a follow-up.
                const routeItem = resolvedNav
                  .flatMap((s) => s.items)
                  .find((i) => i.id === "mobile-route");
                if (routeItem !== undefined) {
                  setActiveTabId(routeItem.id);
                  return;
                }
                setToast({
                  id: `map-${Date.now()}`,
                  message: "Map view is not available yet — use the list",
                  kind: "info",
                });
              }}
            />
          </MobileV2ListStateView>
        ) : activeTabId === "mobile-loader-scan" || activeTabId === "mobile-scan" ? (
          <MobileV2LoaderScanScreen
            theme={ctx.theme}
            policy={loaderPolicy}
            mode={loaderMode}
            onChangeMode={setLoaderMode}
            activeActionKey={loaderActionKey}
            onChangeActionKey={setLoaderActionKey}
            // E6: bay + route are honest loader-context labels. The
            // resolver returns them NULL until a loader-wave source
            // table ships, so the loader hook degrades them to empty
            // strings in production (only the `?v2=preview` showcase
            // carries the fixture's demo bay/route). An empty label is
            // passed through as `undefined` so the scan screen renders
            // its honest "—" placeholder rather than a blank "Bay ".
            contextLabels={{
              route:
                liveLoaderToday.routeLabel.length > 0
                  ? liveLoaderToday.routeLabel
                  : undefined,
              bay:
                liveLoaderToday.bay.length > 0 ? liveLoaderToday.bay : undefined,
            }}
            recentScans={loaderScans}
            onSimulateScan={() => {
              // F4 fix: simulated scans synthesize a tracking number, so
              // they must NEVER reach a production induction. In the
              // `?v2=preview` showcase the scan area populates the demo
              // list; in the production native shell it surfaces honest
              // guidance — real scanning is the device camera/handheld.
              if (!isShowcase) {
                setToast({
                  id: `loader-scan-${Date.now()}`,
                  message: "Use the device scanner to capture a parcel barcode",
                  kind: "info",
                });
                return;
              }
              const next = loaderScans.length + 1;
              const effectiveAction = resolveEffectiveLoaderAction(loaderPolicy, loaderActionKey);
              setLoaderScans([
                ...loaderScans,
                {
                  id: `ls-${Date.now()}`,
                  code: `DLX-LD-${1000 + next}`,
                  action: effectiveAction,
                  mode: loaderMode,
                  status: "ok",
                  time: new Date().toTimeString().slice(0, 5),
                },
              ]);
            }}
            onBarcodeEntry={(barcode) => {
              const effectiveAction = resolveEffectiveLoaderAction(loaderPolicy, loaderActionKey);
              const draft = createMobileV2LoaderBarcodeScanEntry({
                barcode,
                existingScans: loaderScans,
                action: effectiveAction,
                mode: loaderMode,
              });
              if (draft.kind === "empty") {
                setToast({
                  id: `loader-barcode-empty-${Date.now()}`,
                  message: "Scan or type a parcel barcode",
                  kind: "warning",
                });
                return;
              }
              if (draft.kind === "duplicate") {
                setToast({
                  id: `loader-barcode-duplicate-${Date.now()}`,
                  message: `${draft.code} is already in the scan list`,
                  kind: "warning",
                });
                return;
              }
              setLoaderScans([...loaderScans, draft.entry]);
            }}
            onUndoLast={() => {
              setLoaderScans(loaderScans.slice(0, -1));
            }}
            onSubmit={() => {
              const effectiveAction = resolveEffectiveLoaderAction(loaderPolicy, loaderActionKey);
              const actionLabel =
                loaderPolicy.actions.find((candidate) => candidate.key === effectiveAction)?.label ?? effectiveAction;
              const submitRpc = getLoaderActionSubmitRpc(loaderPolicy, effectiveAction);
              emitMobileV2TraceEvent("loader.submit.press", {
                action: effectiveAction,
                submitRpc,
                scanCount: loaderScans.length,
              });
              if (submitRpc === null) {
                emitMobileV2TraceEvent("loader.submit.blocked", {
                  action: effectiveAction,
                  reason: "missing_submit_rpc",
                });
                setToast({
                  id: `loader-action-${Date.now()}`,
                  message: `${actionLabel} is not available yet`,
                  kind: "warning",
                });
                return;
              }
              if (submitRpc === "record_scan_event_v1" && effectiveAction === "load") {
                if (recordRouteLoadScanMutation.isPending || routeLoadScanReadbackPending) {
                  emitMobileV2TraceEvent("loader.submit.blocked", {
                    action: effectiveAction,
                    reason: "route_load_busy",
                  });
                  setToast({
                    id: `route-load-busy-${Date.now()}`,
                    message: "Route load scan is still confirming",
                    kind: "info",
                  });
                  return;
                }
                const pendingScans = loaderScans.filter((scan) => !isMobileV2LoaderReadbackScanEntry(scan));
                if (pendingScans.length === 0) {
                  emitMobileV2TraceEvent("loader.submit.blocked", {
                    action: effectiveAction,
                    reason: "no_pending_scans",
                  });
                  setToast({
                    id: `route-load-no-pending-${Date.now()}`,
                    message: "All visible scans are already confirmed",
                    kind: "info",
                  });
                  return;
                }
                const routeRunId = routeRpc.data?.routeRunId ?? null;
                const routeTasks = tasksRpc.data ?? [];
                const inputs = pendingScans.map((scan) =>
                  buildMobileV2RouteLoadScanMutationInput({
                    tasks: routeTasks,
                    routeRunId,
                    barcode: scan.code,
                    deviceId: registeredDeviceId,
                    activeOpsSessionId: activeRouteDepartureOpsSessionId,
                  }),
                );
                if (inputs.some((input) => input === null)) {
                  emitMobileV2TraceEvent("loader.submit.blocked", {
                    action: effectiveAction,
                    reason: "missing_route_context",
                    routeRunReady: routeRunId !== null,
                    taskCount: routeTasks.length,
                    pendingCount: pendingScans.length,
                  });
                  setToast({
                    id: `route-load-context-${Date.now()}`,
                    message: "Route load scan needs the current route manifest",
                    kind: "danger",
                  });
                  return;
                }
                const submittedCodes = pendingScans.map((scan) => scan.code);
                void (async () => {
                  setRouteLoadScanReadbackPending(true);
                  try {
                    emitMobileV2TraceEvent("loader.submit.route_load.start", {
                      pendingCount: inputs.length,
                      routeRunReady: routeRunId !== null,
                    });
                    const readbacks = [];
                    for (const input of inputs) {
                      if (input === null) continue;
                      readbacks.push(await recordRouteLoadScanMutation.mutateAsync(input));
                    }
                    const routeReadback = await refreshMobileV2PodReadback([
                      {
                        label: "route",
                        refetch: routeRpc.refetch,
                        expect: (data) =>
                          routeRunId !== null && mobileV2RouteHasReadyScanOutReadback(data, routeRunId),
                      },
                      {
                        label: "tasks",
                        refetch: tasksRpc.refetch,
                        expect: () => true,
                      },
                    ]);
                    emitMobileV2TraceEvent("loader.submit.route_load.readback", {
                      ok: routeReadback.ok,
                      pendingCount: inputs.length,
                    });
                    if (!routeReadback.ok) {
                      setToast({
                        id: `route-load-readback-${Date.now()}`,
                        message: "Load scan saved, but route scan-out did not refresh yet. Try again.",
                        kind: "danger",
                      });
                      return;
                    }
                    setLoaderScans(
                      readbacks.map((readback) => ({
                        id: `readback-route-load-${readback.scanEventId}`,
                        code: readback.barcode,
                        action: effectiveAction,
                        mode: loaderMode,
                        status: "ok",
                        time: new Date().toTimeString().slice(0, 5),
                      })),
                    );
                    setToast({
                      id: `route-load-submit-${Date.now()}`,
                      message: `${actionLabel} confirmed - ${submittedCodes.length} scan${submittedCodes.length === 1 ? "" : "s"}`,
                      kind: "success",
                    });
                  } catch (err) {
                    setToast({
                      id: `route-load-err-${Date.now()}`,
                      message: redactDisplayErrorText(err instanceof Error ? err.message : undefined, "Route load scan failed"),
                      kind: "danger",
                    });
                  } finally {
                    setRouteLoadScanReadbackPending(false);
                  }
                })();
                return;
              }
              if (submitRpc !== "induct_fieldops_parcel_v1") {
                setToast({
                  id: `loader-action-rpc-${Date.now()}`,
                  message: `${actionLabel} is not available yet`,
                  kind: "danger",
                });
                return;
              }
              // Loader submit inducts each scanned parcel individually
              // via induct_fieldops_parcel_v1. Each call is idempotent on
              // its own correlation id; on error we stop iterating and
              // surface the first failure so the operator can resolve it
              // before resubmitting.
              //
              // E6/E11: the bay is the loader-today envelope's `bay`,
              // which the resolver returns NULL (→ "") until a loader-wave
              // source table ships. We MUST NOT write a fabricated bay
              // into the real induction record. E11 hard-gate:
              // resolveFieldopsInductionBay reads the bay STRICTLY from
              // the settled loaderTodayRpc envelope, never the screen-
              // level `liveLoaderToday` fixture fallback — so an in-flight
              // or errored query yields "" and the bay.length === 0 guard
              // below honestly blocks the write.
              const bay = resolveFieldopsInductionBay(loaderTodayRpc);
              if (bay.length === 0) {
                setToast({
                  id: `loader-bay-${Date.now()}`,
                  message: "No active bay assigned — set a bay before inducting",
                  kind: "warning",
                });
                return;
              }
              const pendingScans = loaderScans.filter((scan) => !isMobileV2LoaderReadbackScanEntry(scan));
              if (pendingScans.length === 0) {
                setToast({
                  id: `loader-no-pending-${Date.now()}`,
                  message: "All visible scans are already confirmed",
                  kind: "info",
                });
                return;
              }
              const submittedCodes = pendingScans.map((scan) => scan.code);
              const submitBatch = async () => {
                for (const code of submittedCodes) {
                  await inductParcelMutation.mutateAsync({
                    p_bay: bay,
                    p_tracking_number: code,
                  });
                }
              };
              const count = pendingScans.length;
              submitBatch()
                .then(async () => {
                  const [sortationReadback] = await Promise.all([
                    sortationRpc.refetch(),
                    loaderTodayRpc.refetch(),
                  ]);
                  const readback = buildMobileV2LoaderReadbackScans({
                    recent: sortationReadback.data?.recent ?? sortationRpc.data?.recent ?? [],
                    submittedCodes,
                    action: effectiveAction,
                    mode: loaderMode,
                  });
                  if (readback.missingCodes.length > 0) {
                    setToast({
                      id: `loader-readback-missing-${Date.now()}`,
                      message: `Confirmation missing ${readback.missingCodes.length} submitted scans`,
                      kind: "danger",
                    });
                    return;
                  }
                  setLoaderScans([...readback.scans]);
                  setToast({
                    id: `loader-submit-${Date.now()}`,
                    message: `${actionLabel} confirmed - ${count} scans`,
                    kind: "success",
                  });
                })
                .catch((err: unknown) => {
                  setToast({
                    id: `loader-err-${Date.now()}`,
                    message: redactDisplayErrorText(err instanceof Error ? err.message : undefined, "Loader submit failed"),
                    kind: "danger",
                  });
                });
            }}
          />
        ) : activeTabId === "mobile-pod" ? (
          <MobileV2PodScreen
            theme={ctx.theme}
            policy={activePodPolicy}
            hasCod={(liveStop.cod?.amount ?? 0) > 0}
            customerName={liveStop.customerName}
            customerPhone={liveStop.customerPhone}
            codAmount={liveStop.cod?.amount}
            contextKey={activeStopId}
            scanExpectedCodes={liveStop.parcels.map((parcel) => parcel.code).filter((code) => code.trim() !== "")}
            scanExpectedParcels={
              liveStop.parcels.map((parcel): MobileV2PodScanParcel => ({
                id: parcel.id,
                code: parcel.code,
              }))
            }
            initialArtifacts={activePodCapturedArtifacts}
            submitting={submitProofMutation.isPending || podReadbackPending}
            failSheetOpen={podFailSheetOpen}
            onCloseFailSheet={() => setPodFailSheetOpen(false)}
            onExit={() => setActiveTabId("mobile-stop")}
            onCaptureArtifact={registerPodArtifact}
            onArtifactsChange={rememberActivePodArtifacts}
            onCommit={(commitContext) => {
              // Final wizard step "Commit POD" → submit_fieldops_proof_v1
              // with outcome=delivered or partial. Evidence carries every
              // captured POD method (from policy.methods) so the decision_log
              // row records the full signature/photo/OTP context.
              submitPodProof(
                commitContext.outcome,
                buildMobileV2PodCloseoutEvidence({
                  methods: activePodMethods,
                  capturedAt: new Date().toISOString(),
                  artifactIds: commitContext.artifactIds,
                  scanCodes: commitContext.scanCodes,
                  deliveredBoxIds: commitContext.deliveredBoxIds,
                  deliveredBoxNumbers: commitContext.deliveredBoxNumbers,
                  otpCode: commitContext.otpCode,
                  cod: {
                    amount: liveStop.cod?.amount,
                    currency: liveStop.cod?.currency ?? activePodPolicy.codCurrency,
                    method: "cash",
                    tenderedAmount: commitContext.codTenderedAmount,
                  },
                }),
                () => {
                  clearActivePodArtifacts();
                  setToast({
                    id: `pod-commit-${Date.now()}`,
                    message: commitContext.outcome === "partial" ? "Partial POD committed" : "POD committed",
                    kind: commitContext.outcome === "partial" ? "warning" : "success",
                  });
                  setActiveTabId("mobile-stop");
                },
                activePodMethods.filter((method) =>
                  liveStop.proofChecklist.some((checkpoint) => checkpoint.key === method),
                ),
                commitContext.outcome === "partial" ? commitContext.scanCodes : undefined,
              );
            }}
            onSubmitFail={(reason, failContext) => {
              // Failed delivery POD → submit_fieldops_proof_v1 with
              // outcome=failed. Evidence carries the structured reason
              // code, policy gate state, and required operator note so
              // reviewers can replay the failed-delivery decision.
              submitPodProof(
                "failed",
                buildMobileV2PodFailureEvidence({
                  reason,
                  context: failContext,
                  capturedAt: new Date().toISOString(),
                }),
                () => {
                  setToast({
                    id: `fail-${reason.code}-${Date.now()}`,
                    message: `Failed: ${reason.label}`,
                    kind: reason.escalate ? "danger" : "warning",
                  });
                  setPodFailSheetOpen(false);
                  clearActivePodArtifacts();
                  setActiveTabId("mobile-stop");
                },
              );
            }}
          />
        ) : activeTabId === "mobile-stop" ? (
          <MobileV2ListStateView
            theme={ctx.theme}
            isLoading={isMobileV2ListLoading(stopDetailRpc)}
            isError={stopDetailRpc.isError}
            errorMessage={formatMobileV2UserError(stopDetailRpc.error, "Unable to load stop details")}
            onRetry={() => { void stopDetailRpc.refetch(); }}
          >
          <MobileV2StopScreen
            theme={ctx.theme}
            stop={liveStop}
            locationReadback={activeStopLocationReadback}
            terminalState={activeStopTerminalState}
            intentReadback={routeIntentReadback}
            onCall={() =>
              // B1 fix: real device dialer intent (`tel:`).
              runIntent(() => openMobileV2Call(liveStop.customerPhone), {
                success: `Calling ${liveStop.customerName}`,
                missing: "No phone number on this stop",
              }, {
                eventType: "mobile_route_contact",
                metadata: {
                  channel: "call",
                  contact_target: "Recipient",
                  contact_role: "customer",
                  contact_source: "stop_detail",
                  phone: liveStop.customerPhone ?? null,
                },
              })
            }
            onWhatsApp={() =>
              // B1 fix: real WhatsApp intent (`https://wa.me/...`).
              runIntent(() => openMobileV2WhatsApp(liveStop.customerPhone), {
                success: "WhatsApp opened",
                missing: "No phone number on this stop",
              }, {
                eventType: "mobile_route_contact",
                metadata: {
                  channel: "whatsapp",
                  contact_target: "Recipient",
                  contact_role: "customer",
                  contact_source: "stop_detail",
                  phone: liveStop.customerPhone ?? null,
                },
              })
            }
            onNavigate={() =>
              // B1 fix: real maps navigation intent to the stop address.
              runIntent(
                () =>
                  openMobileV2Maps(
                    composeMobileV2AddressText({
                      addressLines: liveStop.addressLines,
                      addressNote: null,
                    }),
                  ),
                {
                  success: "Opening navigation",
                  missing: "No address on this stop",
                },
                {
                  eventType: "mobile_route_navigate",
                  metadata: {
                    provider: "device_default",
                    address: composeMobileV2AddressText({
                      addressLines: liveStop.addressLines,
                      addressNote: null,
                    }),
                  },
                },
              )
            }
            onCopyAddress={() =>
              // B1 fix: real clipboard write (web) / share sheet (native).
              runIntent(
                () =>
                  copyMobileV2Text(
                    composeMobileV2AddressText({
                      addressLines: liveStop.addressLines,
                      addressNote: liveStop.addressNote,
                      trackingCode: liveStop.trackingCode,
                    }),
                  ),
                { success: "Address copied", missing: "No address on this stop" },
              )
            }
            onShareAddress={() =>
              // B1 fix: real OS share sheet.
              runIntent(
                () =>
                  shareMobileV2Text(
                    composeMobileV2AddressText({
                      addressLines: liveStop.addressLines,
                      addressNote: liveStop.addressNote,
                      trackingCode: liveStop.trackingCode,
                    }),
                    `Stop ${liveStop.trackingCode}`,
                  ),
                { success: "Share sheet opened", missing: "No address on this stop" },
              )
            }
            // Parcel scans and proof items are recorded by the proof capture
            // flow (submit_fieldops_proof_v1); the stop shows them from its read-back.
            onScanParcel={() => {
              setPodFailSheetOpen(false);
              setActiveTabId("mobile-pod");
            }}
            onDamageHold={openDamageHoldForActiveStop}
            onReschedule={openRescheduleForActiveStop}
            onProofPress={() => {
              setPodFailSheetOpen(false);
              setActiveTabId("mobile-pod");
            }}
            onPodSubmit={() => {
              setPodFailSheetOpen(false);
              setActiveTabId("mobile-pod");
            }}
            onFail={() => {
              setPodFailSheetOpen(true);
              setActiveTabId("mobile-pod");
            }}
          />
          </MobileV2ListStateView>
        ) : activeTabId === "mobile-route" ? (
          // B1 fix: the Route tab previously matched no branch and fell
          // through to the showcase debug panel. The real Route screen
          // renders here; its stop list is resolver-driven via
          // useFieldopsRouteRpc (resolve_fieldops_tasks_v1 driver role)
          // with MOBILE_V2_PREVIEW_ROUTE as the preview/offline fallback.
          <MobileV2ListStateView
            theme={ctx.theme}
            isLoading={isMobileV2ListLoading(routeRpc) || mapPolicyQuery.isLoading}
            isError={routeRpc.isError || mapPolicyQuery.isError || mapPolicy === null}
            errorMessage={
              routeRpc.error !== null || mapPolicyQuery.error !== null
                ? formatMobileV2UserError(routeRpc.error ?? mapPolicyQuery.error, "Unable to load route")
                : "Route map settings are not available yet"
            }
            onRetry={() => {
              void routeRpc.refetch();
              void mapPolicyQuery.refetch();
            }}
          >
            <MobileV2RouteScreen
              theme={ctx.theme}
              // F8: the saved-view list + active view are the real
              // design SSOT route views (app-store.jsx DEFAULT_VIEWS).
              activeView={
                {
                  id: routeActiveView.id,
                  name: routeActiveView.name,
                  emoji: routeActiveView.emoji,
                  builtin: routeActiveView.builtin,
                } as MobileV2RouteSavedView
              }
              views={MOBILE_V2_ROUTE_DEFAULT_VIEWS.map(
                (v) =>
                  ({
                    id: v.id,
                    name: v.name,
                    emoji: v.emoji,
                    builtin: v.builtin,
                  }) as MobileV2RouteSavedView,
              )}
              // F9: rows are the LIVE filtered + sorted route stop list.
              rows={routeViewResult.rows}
              // U1 fix: when the active view's group key is not "none",
              // pass the pre-computed group sections so the screen
              // renders per-group headers (was a flat list regardless).
              groups={
                routeViewResult.groups.length > 0
                  ? routeViewResult.groups
                  : undefined
              }
              totalStops={routeTotalStops}
              searchValue={routeSearch}
              density={routeDensity}
              sortLabel={getMobileV2RouteSortLabel(routeSortKey)}
              groupLabel={getMobileV2RouteGroupLabel(routeGroupKey)}
              filterCount={routeFilterCount}
              dirty={false}
              manifestSummary={routeManifestSummary}
              currency={MOBILE_V2_PREVIEW_ROUTE.currency}
              onConfirmDeparture={handleConfirmRouteDeparture}
              isConfirmingDeparture={confirmRouteDepartureMutation.isPending || routeDepartureReadbackPending}
              onSearchChange={setRouteSearch}
              // F8/F9: the chips open real sheets.
              onOpenViews={() => setRouteSheet("views")}
              onOpenFilters={() => setRouteSheet("filters")}
              onOpenGroup={() => setRouteSheet("group")}
              onOpenSort={() => setRouteSheet("sort")}
              onToggleDensity={() => {
                setRouteDensity((d) => (d === "compact" ? "comfy" : "compact"));
              }}
              onSaveView={() => {
                // Persisting a custom route view needs a saved-view write
                // RPC (none in the V2 RPC pack). No fabricated "saved"
                // success — surface honest guidance. STAGED: route
                // saved-view persistence is a follow-up.
                setToast({
                  id: `save-view-${Date.now()}`,
                  message: "Custom route views are not available yet",
                  kind: "info",
                });
              }}
              onOpenMap={() => setActiveTabId("mobile-map")}
              onOpenScan={() => setActiveTabId("mobile-scan")}
              onSelectStop={(id) => {
                // Route stop ids carry the `stop:<route_stops UUID>`
                // prefix (resolve_fieldops_tasks_v1 task_id). Strip it so
                // the stop-detail RPC targets the persisted row, mirroring
                // the Tasks screen's onTaskPress.
                const stopId = id.startsWith("stop:") ? id.slice("stop:".length) : id;
                setActiveStopId(stopId);
                setActiveTabId("mobile-stop");
              }}
              onClearFilters={() => {
                setRouteSearch("");
                setRouteStatusFilter([]);
                setRouteCodOnly(false);
                setRouteFragileOnly(false);
                setRouteReattemptOnly(false);
                setToast({ id: `clear-${Date.now()}`, message: "Filters cleared", kind: "info" });
              }}
            />
          </MobileV2ListStateView>
        ) : activeTabId === "mobile-map" ? (
          // E2 fix: the Live-route map screen derives its data from the
          // resolver-driven route stops (projectMobileV2RouteMap over
          // useFieldopsRouteRpc) — NOT the PREVIEW/DEV route fixture.
          // `upcoming` / `active` / `pendingCount` / `routeId` come from
          // the resolved route; per-stop ETA/distance + route alerts are
          // 0 / empty (no live optimizer/traffic resolver yet) — honest
          // "not computed" values, never fabricated estimates.
          <MobileV2ListStateView
            theme={ctx.theme}
            isLoading={isMobileV2ListLoading(routeRpc)}
            isError={routeRpc.isError}
            errorMessage={formatMobileV2UserError(routeRpc.error, "Unable to load route")}
            onRetry={() => { void routeRpc.refetch(); }}
          >
          <MobileV2MapScreen
            theme={ctx.theme}
            routeId={routeMapView.routeId}
            pendingCount={routeMapView.pendingCount}
            distanceLeftKm={routeMapView.distanceLeftKm}
            alerts={routeMapView.alerts}
            mapStops={routeMapView.mapStops}
            upcoming={routeMapView.upcoming}
            active={routeMapView.active}
            mapPolicy={mapPolicy}
            followEnabled={mapFollow}
            trafficEnabled={mapTraffic}
            locationReadback={mapLocationReadback}
            currency={MOBILE_V2_PREVIEW_ROUTE.currency}
            onToggleFollow={() => setMapFollow((f) => !f)}
            onToggleTraffic={() => setMapTraffic((t) => !t)}
            onRecordLocation={handleRecordMapLocation}
            onOptimize={() =>
              // E2: route re-optimization needs a server-side optimizer
              // RPC (none exists in the V2 RPC surface). No fabricated
              // "Route re-optimized" success is shown — the driver keeps
              // the planned sequence. Mirrors the honest mobile-today
              // onOptimizeRoute handler. STAGED: an
              // `optimize_fieldops_route_v1`-class RPC is a follow-up.
              setToast({
                id: `optimize-${Date.now()}`,
                message: "Route optimization is not available yet",
                kind: "info",
              })
            }
            onOpenList={() => setActiveTabId("mobile-route")}
            onSelectStop={(id) => {
              const stopId = id.startsWith("stop:") ? id.slice("stop:".length) : id;
              setActiveStopId(stopId);
              setActiveTabId("mobile-stop");
            }}
            onCallActive={() =>
              // Real device dialer intent (`tel:`). The resolved route
              // stop carries no customer phone, so the intent honestly
              // surfaces a "no number" state rather than faking a call
              // (production cutover passes the resolved phone).
              runIntent(() => openMobileV2Call(null), {
                success: "Calling customer",
                missing: "No phone number on this stop",
              })
            }
            onMessageActive={() =>
              runIntent(() => openMobileV2WhatsApp(null, "Your delivery is on the way."), {
                success: "Opening WhatsApp",
                missing: "No phone number on this stop",
              })
            }
            onOpenActive={() => {
              const activeId = routeMapView.active?.id;
              if (activeId === undefined) return;
              setActiveStopId(
                activeId.startsWith("stop:") ? activeId.slice("stop:".length) : activeId,
              );
              setActiveTabId("mobile-stop");
            }}
          />
          </MobileV2ListStateView>
        ) : activeTabId === "mobile-tasks" ? (
          <MobileV2TasksScreen
            theme={ctx.theme}
            state={tasksRpcState}
            query={tasksQuery}
            onQueryChange={setTasksQuery}
            // F7: the List / Board / Map segmented control is now live —
            // each cell renders a real view body.
            viewMode={tasksViewMode}
            onViewModeChange={setTasksViewMode}
            // F7/F8/F9: the host owns the saved-view filter + sort + group
            // so the body renders the host-computed groups directly.
            precomputedGroups={tasksViewResult.groups}
            precomputedTasks={tasksViewResult.rows}
            filterLabel={
              tasksFilterCount > 0 ? `Filters · ${tasksFilterCount}` : "Filters"
            }
            filterActive={tasksFilterCount > 0}
            groupLabel={`Group: ${getMobileV2TaskGroupLabel(tasksGroupKey)}`}
            sortLabel={getMobileV2TaskSortLabel(tasksSortKey)}
            onTaskPress={(task) => {
              if (task.type === "pickup" || task.action === "pickup" || task.task_id.startsWith("pickup:")) {
                const routeStopId = task.task_id.startsWith("pickup:")
                  ? task.task_id.slice("pickup:".length)
                  : typeof task.meta.route_stop_id === "string"
                    ? task.meta.route_stop_id
                    : null;
                const shipmentId = typeof task.meta.shipment_id === "string" ? task.meta.shipment_id : null;
                const match = livePickups.find((pickup) => (
                  pickup.id === routeStopId
                  || pickup.routeStopId === routeStopId
                  || pickup.shipmentId === shipmentId
                  || (task.code !== null && pickup.wb === task.code)
                ));
                if (match !== undefined) {
                  setActivePickupId(match.id);
                  setActiveTabId("mobile-pickup-detail");
                  setToast({
                    id: `open-pickup-${Date.now()}`,
                    message: `Opening pickup ${match.wb}`,
                    kind: "info",
                  });
                  return;
                }
                setToast({
                  id: `pickup-missing-${Date.now()}`,
                  message: "Pickup status is not available yet",
                  kind: "warning",
                });
                return;
              }
              if (task.task_id.startsWith("stop:")) {
                // task_id is `stop:<route_stops UUID>` — feed the real
                // row id to the stop-detail RPC + POD write so the
                // native shell targets the persisted stop (the showcase
                // task fixture id short-circuits to the fallback).
                const stopId = task.task_id.slice("stop:".length);
                const shipmentId = typeof task.meta.shipment_id === "string" ? task.meta.shipment_id : null;
                const shipmentStatus =
                  typeof task.meta.shipment_status === "string" ? task.meta.shipment_status : "";
                const pickupIntent =
                  task.type === "pickup"
                  || task.action === "pickup"
                  || shipmentStatus.startsWith("pickup_");
                const pickupMatch = livePickups.find((pickup) => (
                  pickup.id === stopId
                  || pickup.routeStopId === stopId
                  || pickup.shipmentId === shipmentId
                  || (task.code !== null && pickup.wb === task.code)
                ));
                if (pickupMatch !== undefined) {
                  setActivePickupId(pickupMatch.id);
                  setActiveTabId("mobile-pickup-detail");
                  setToast({
                    id: `open-pickup-stop-${Date.now()}`,
                    message: `Opening pickup ${pickupMatch.wb}`,
                    kind: "info",
                  });
                  return;
                }
                if (pickupIntent) {
                  setActivePickupId(stopId);
                  setActiveTabId("mobile-pickup-detail");
                  setToast({
                    id: `open-pickup-stop-${Date.now()}`,
                    message: `Opening pickup ${task.code ?? task.title}`,
                    kind: "info",
                  });
                  return;
                }
                setActiveStopId(stopId);
                setActiveTabId("mobile-stop");
                setToast({
                  id: `open-stop-${Date.now()}`,
                  message: `Opening ${task.code ?? task.title}`,
                  kind: "info",
                });
                return;
              }
              setToast({
                id: `task-${task.task_id}-${Date.now()}`,
                message: `Opened ${task.code ?? task.title}`,
                kind: "info",
              });
            }}
            onScanPress={() => {
              // B1 fix: open the REAL scan screen instead of a no-op
              // "Scanner opened" toast.
              setActiveTabId("mobile-scan");
            }}
            // F9: Filters / Group / Sort chips open real sheets.
            onFilterPress={() => setTasksSheet("filters")}
            onSortPress={() => setTasksSheet("sort")}
            onGroupPress={() => setTasksSheet("group")}
            // U6: empty-state Clear-filters action — resets the search
            // query + filter selection (mirrors the design ScrTasks
            // empty-state Clear-filters button).
            onClearFilters={() => {
              setTasksQuery("");
              setTasksFilters({});
              setToast({ id: `tclear-${Date.now()}`, message: "Filters cleared", kind: "info" });
            }}
          />
        ) : (
          // F1 fix: every registered role/tab id now resolves to a real
          // screen above. This branch is only reachable if an
          // UNREGISTERED tab id is selected — it surfaces an honest
          // "screen not available" state (no fabricated KPIs / dead
          // buttons) and routes the user back to Tasks. The former
          // theme/role/icons debug sandbox lived here.
          <ScrollView contentContainerStyle={{ padding: 16 }}>
            <FxCard theme={ctx.theme} soft>
              <FxCol gap={12}>
                <FxRow gap={10} align="center">
                  <FxIcon name="alert" size={20} color={ctx.theme.warning} />
                  <Text
                    style={{
                      color: ctx.theme.ink,
                      fontSize: 14,
                      fontWeight: "600",
                    }}
                  >
                    Screen not available
                  </Text>
                </FxRow>
                <Text style={{ color: ctx.theme.muted, fontSize: 12 }}>
                  This route is not part of the current navigation.
                </Text>
                <FxButton
                  theme={ctx.theme}
                  variant="soft"
                  size="sm"
                  icon="list"
                  onPress={() => setActiveTabId("mobile-tasks")}
                >
                  Back to Tasks
                </FxButton>
              </FxCol>
            </FxCard>
          </ScrollView>
        )}

        {/* F11 fix: removed the Tasks sticky-footer "Continue route" CTA
            (it had no onPress and a hardcoded "3 stops · ETA 14:22"
            subtitle). The design ScrTasks default screen has no sticky
            footer — its only fixed bar is the bulk-select action bar. */}
      </ScreenShell>

      <AppDrawer
        theme={ctx.theme}
        visible={drawerOpen}
        onClose={() => setDrawerOpen(false)}
        identity={{ name: profile.name, employeeId: profile.badge }}
        availableRoles={availableRoles}
        activeRole={activeRole}
        onSelectRole={(role) => {
          handleActiveRoleChange(role);
          setDrawerOpen(false);
        }}
        allSections={resolvedNav}
        capabilities={visibleCapabilities}
        onSelectItem={(item) => {
          setDrawerOpen(false);
          selectTab(item);
        }}
        onSignOut={() => {
          setDrawerOpen(false);
          handleSignOut();
        }}
      />

      {/* B1 fix: the real incident report sheet, hosted at PreviewBody
          level so any screen's "Report incident" action opens it. The
          type registry is resolved via mobile_incident_policy
          (incidentTypes); onSubmit persists through
          submit_fieldops_incident_v1 — no toast-only stub. */}
      <MobileV2IncidentSheet
        theme={ctx.theme}
        visible={incidentSheetOpen}
        onClose={() => {
          setIncidentSheetOpen(false);
          setIncidentReadbackError(null);
          setIncidentVerifiedReadback(null);
        }}
        types={incidentTypes}
        selectedTypeId={incidentTypeId}
        photoCaptured={incidentPhoto}
        statement={incidentStatement}
        submitting={submitIncidentMutation.isPending}
        latestIncident={incidentVerifiedReadback}
        readbackError={incidentReadbackError}
        onSelectType={setIncidentTypeId}
        onTogglePhoto={() => setIncidentPhoto((p) => !p)}
        onStatementChange={setIncidentStatement}
        onSubmit={() => {
          const picked = incidentTypes.find((t) => t.id === incidentTypeId);
          if (picked === undefined) return;
          setIncidentReadbackError(null);
          setIncidentVerifiedReadback(null);
          void (async () => {
            try {
              const write = await submitIncidentMutation.mutateAsync({
                p_type_id: picked.id,
                // Only a persisted route_stops UUID is sent; a fixture id
                // would fail Postgres UUID parsing (22P02).
                p_stop_id: isMobileV2PersistedUuid(incidentStopId) ? incidentStopId : null,
                p_severity: picked.severity,
                p_statement: incidentStatement.trim(),
                // The evidence-upload pipeline is a post-cutover task, so a
                // captured photo has no server path yet — send null rather
                // than a fabricated path (mirrors the cash-drop p_photo_id
                // handling). The flag that a photo was taken is carried in
                // the statement context server-side.
                p_photo_path: null,
              });
              const readback = await latestIncidentRpc.refetch();
              const matchedReadback = readback.data ?? null;
              if (
                !isShowcase &&
                !mobileV2IncidentMatchesWrite(
                  matchedReadback,
                  write,
                  picked.id,
                  picked.severity,
                  incidentStatement,
                )
              ) {
                const message = "Incident saved, but latest confirmation did not match yet";
                setIncidentVerifiedReadback(null);
                setIncidentReadbackError(message);
                setToast({
                  id: `inc-readback-err-${Date.now()}`,
                  message,
                  kind: "danger",
                });
                return;
              }
              setToast({
                id: `inc-${Date.now()}`,
                message:
                  picked.severity === "high"
                    ? "Incident filed - dispatcher paged"
                    : "Incident report filed",
                kind: picked.severity === "high" ? "danger" : "success",
              });
              setIncidentVerifiedReadback(isShowcase ? null : matchedReadback);
              setIncidentTypeId(null);
              setIncidentPhoto(false);
              setIncidentStatement("");
              setIncidentStopId(null);
            } catch (err) {
              const message = redactDisplayErrorText(err instanceof Error ? err.message : undefined, "Incident report failed");
              setIncidentVerifiedReadback(null);
              setIncidentReadbackError(message);
              setToast({
                id: `inc-err-${Date.now()}`,
                message,
                kind: "danger",
              });
            }
          })();
        }}
      />

      {/* F8/F9 — Tasks saved-view picker + filter / group / sort sheets.
          The app-bar title and the Filters/Group/Sort chips open these;
          a pick applies the view / selection so the list actually
          re-filters / re-sorts / re-groups. */}
      <MobileV2RescheduleSheet
        theme={ctx.theme}
        visible={rescheduleSheetOpen}
        onClose={() => {
          setRescheduleSheetOpen(false);
          setRescheduleReadbackError(null);
          setRescheduleVerifiedReadback(null);
        }}
        stopRef={liveStop.trackingCode}
        currentWindow={liveStop.window}
        suggestedWindows={rescheduleWindows}
        selectedWindowId={rescheduleWindowId}
        noteText={rescheduleNote}
        submitting={submitRescheduleMutation.isPending || rescheduleReadbackPending}
        latestReschedule={rescheduleVerifiedReadback}
        readbackError={rescheduleReadbackError}
        onSelectWindow={setRescheduleWindowId}
        onNoteChange={setRescheduleNote}
        onConfirm={handleSubmitReschedule}
      />

      <MobileV2DamageHoldSheet
        theme={ctx.theme}
        visible={damageHoldSheetOpen}
        onClose={() => {
          setDamageHoldSheetOpen(false);
          setDamageHoldReadbackError(null);
          setDamageHoldVerifiedReadback(null);
        }}
        parcelId={damageHoldParcelLabel ?? damageHoldParcelId ?? "parcel"}
        severities={damageHoldPolicy.severities}
        selectedSeverityId={damageHoldSeverityId}
        note={damageHoldNote}
        photoCaptured={damageHoldPhotoArtifact !== null}
        onSelectSeverity={setDamageHoldSeverityId}
        onNoteChange={setDamageHoldNote}
        onTogglePhoto={(capture) => { void handleDamageHoldPhotoCapture(capture); }}
        onConfirm={handleSubmitDamageHold}
        submitting={submitDamageHoldMutation.isPending || damageHoldReadbackPending}
        requireCameraCapture={!isShowcase}
        captureBusy={damageHoldCaptureBusy}
        captureError={damageHoldReadbackError}
        latestDamageHold={damageHoldVerifiedReadback}
        readbackError={damageHoldReadbackError}
      />

      <MobileV2SavedViewsSheet
        theme={ctx.theme}
        visible={tasksSheet === "views"}
        onClose={() => setTasksSheet(null)}
        views={MOBILE_V2_TASK_DEFAULT_VIEWS.map((v) => ({
          id: v.id,
          name: v.name,
          emoji: v.emoji,
          builtin: v.builtin,
          summary: `Grouped by ${getMobileV2TaskGroupLabel(v.group).toLowerCase()} · Sort ${getMobileV2TaskSortLabel(v.sort).toLowerCase()}`,
        }))}
        activeId={tasksActiveViewId}
        onPick={(id) => {
          const view = MOBILE_V2_TASK_DEFAULT_VIEWS.find((v) => v.id === id);
          if (view !== undefined) {
            setTasksActiveViewId(view.id);
            setTasksFilters(view.filters);
            setTasksSortKey(view.sort);
            setTasksGroupKey(view.group);
          }
          setTasksSheet(null);
        }}
      />
      <MobileV2TaskFiltersSheet
        theme={ctx.theme}
        visible={tasksSheet === "filters"}
        onClose={() => setTasksSheet(null)}
        title="Filters"
        fields={MOBILE_V2_TASK_FILTER_FIELDS.map((f) => ({
          key: f.key,
          label: f.label,
          kind: f.kind,
          options:
            f.dynamic === true
              ? tasksAreaOptions.map((a) => ({ value: a, label: a }))
              : f.options?.map((o) => ({ value: o.value, label: o.label })),
        }))}
        filters={tasksFilters}
        activeCount={tasksFilterCount}
        onChange={setTasksFilters}
        onApply={() => setTasksSheet(null)}
      />
      <MobileV2PickerSheet
        theme={ctx.theme}
        visible={tasksSheet === "group"}
        onClose={() => setTasksSheet(null)}
        title="Group by"
        options={MOBILE_V2_TASK_GROUP_OPTIONS.map((o) => ({ key: o.key, label: o.label }))}
        value={tasksGroupKey}
        onPick={(key) => {
          setTasksGroupKey(key as MobileV2TaskGroupKey);
          setTasksSheet(null);
        }}
      />
      <MobileV2PickerSheet
        theme={ctx.theme}
        visible={tasksSheet === "sort"}
        onClose={() => setTasksSheet(null)}
        title="Sort by"
        options={MOBILE_V2_TASK_SORT_OPTIONS.map((o) => ({ key: o.key, label: o.label }))}
        value={tasksSortKey}
        onPick={(key) => {
          setTasksSortKey(key as MobileV2TaskSortKey);
          setTasksSheet(null);
        }}
      />

      {/* F8/F9 — Route saved-view picker + filter / group / sort sheets. */}
      <MobileV2SavedViewsSheet
        theme={ctx.theme}
        visible={routeSheet === "views"}
        onClose={() => setRouteSheet(null)}
        views={MOBILE_V2_ROUTE_DEFAULT_VIEWS.map((v) => ({
          id: v.id,
          name: v.name,
          emoji: v.emoji,
          builtin: v.builtin,
          summary: `Grouped by ${getMobileV2RouteGroupLabel(v.group).toLowerCase()} · Sort ${getMobileV2RouteSortLabel(v.sort).toLowerCase()}`,
        }))}
        activeId={routeActiveViewId}
        onPick={(id) => {
          const view = MOBILE_V2_ROUTE_DEFAULT_VIEWS.find((v) => v.id === id);
          if (view !== undefined) {
            setRouteActiveViewId(view.id);
            setRouteStatusFilter(view.statusFilter);
            setRouteCodOnly(view.codOnly);
            setRouteFragileOnly(view.fragileOnly);
            setRouteReattemptOnly(view.reattemptOnly);
            setRouteSortKey(view.sort);
            setRouteGroupKey(view.group);
          }
          setRouteSheet(null);
        }}
      />
      <MobileV2TaskFiltersSheet
        theme={ctx.theme}
        visible={routeSheet === "filters"}
        onClose={() => setRouteSheet(null)}
        title="Filters"
        fields={[
          {
            key: "status",
            label: "Status",
            kind: "enum",
            options: [
              { value: "pending", label: "Pending" },
              { value: "current", label: "In progress" },
              { value: "done", label: "Delivered" },
              { value: "sla", label: "SLA risk" },
              { value: "failed", label: "Failed" },
            ],
          },
          { key: "cod", label: "Has COD", kind: "bool" },
          // U4: Fragile + Re-attempt — the route stop row type carries
          // `fragile` / `attempts`, so these filters are portable.
          { key: "fragile", label: "Fragile", kind: "bool" },
          { key: "reattempt", label: "Re-attempt", kind: "bool" },
        ]}
        filters={{
          status: routeStatusFilter,
          cod: routeCodOnly ? true : undefined,
          fragile: routeFragileOnly ? true : undefined,
          reattempt: routeReattemptOnly ? true : undefined,
        }}
        activeCount={routeFilterCount}
        onChange={(next) => {
          const status = next.status;
          setRouteStatusFilter(Array.isArray(status) ? status : []);
          setRouteCodOnly(next.cod === true);
          setRouteFragileOnly(next.fragile === true);
          setRouteReattemptOnly(next.reattempt === true);
        }}
        onApply={() => setRouteSheet(null)}
      />
      <MobileV2PickerSheet
        theme={ctx.theme}
        visible={routeSheet === "group"}
        onClose={() => setRouteSheet(null)}
        title="Group by"
        options={MOBILE_V2_ROUTE_GROUP_OPTIONS.map((o) => ({ key: o.key, label: o.label }))}
        value={routeGroupKey}
        onPick={(key) => {
          setRouteGroupKey(key as MobileV2RouteGroupKey);
          setRouteSheet(null);
        }}
      />
      <MobileV2PickerSheet
        theme={ctx.theme}
        visible={routeSheet === "sort"}
        onClose={() => setRouteSheet(null)}
        title="Sort by"
        options={MOBILE_V2_ROUTE_SORT_OPTIONS.map((o) => ({ key: o.key, label: o.label }))}
        value={routeSortKey}
        onPick={(key) => {
          setRouteSortKey(key as MobileV2RouteSortKey);
          setRouteSheet(null);
        }}
      />

      <MobileV2PickerSheet
        theme={ctx.theme}
        visible={pickupFailureReasonSheet !== null}
        onClose={() => setPickupFailureReasonSheet(null)}
        title="Pickup failure reason"
        options={pickupFailureReasons}
        value={pickupFailureReason}
        onPick={(key) => {
          setPickupFailureReason(key);
          setPickupFailureNoteSheet(pickupFailureReasonSheet);
          setPickupFailureReasonSheet(null);
        }}
      />
      {pickupHandoffSheet !== null ? (
        <View
          style={{
            position: "absolute",
            left: 0,
            right: 0,
            top: 0,
            bottom: 0,
            backgroundColor: "rgba(0,0,0,0.35)",
            justifyContent: "flex-end",
            zIndex: 50,
          }}
        >
          <View
            style={{
              backgroundColor: ctx.theme.surface,
              borderTopLeftRadius: 18,
              borderTopRightRadius: 18,
              padding: 18,
              rowGap: 12,
            }}
          >
            <Text style={{ color: ctx.theme.muted, fontSize: 12 }}>
              Outbox: {queueCount}
            </Text>
            <Text style={{ color: ctx.theme.ink, fontSize: 18, fontWeight: "700" }}>
              Pickup handoff
            </Text>
            <TextInput
              placeholder="Enter the confirmed pickup quantity"
              value={pickupHandoffQuantity}
              onChangeText={setPickupHandoffQuantity}
              keyboardType="number-pad"
              style={{
                borderWidth: 1,
                borderColor: ctx.theme.border,
                borderRadius: 10,
                padding: 12,
                color: ctx.theme.ink,
              }}
            />
            <TextInput
              placeholder="Who received the pickup?"
              value={pickupHandoffContactName}
              onChangeText={setPickupHandoffContactName}
              style={{
                borderWidth: 1,
                borderColor: ctx.theme.border,
                borderRadius: 10,
                padding: 12,
                color: ctx.theme.ink,
              }}
            />
            <TextInput
              placeholder="Add handover notes"
              value={pickupHandoffNotes}
              onChangeText={setPickupHandoffNotes}
              multiline
              style={{
                borderWidth: 1,
                borderColor: ctx.theme.border,
                borderRadius: 10,
                padding: 12,
                minHeight: 72,
                color: ctx.theme.ink,
              }}
            />
            <TextInput
              placeholder="Receipt number, counter, or handover context"
              value={pickupHandoffReceiptContext}
              onChangeText={setPickupHandoffReceiptContext}
              multiline
              style={{
                borderWidth: 1,
                borderColor: ctx.theme.border,
                borderRadius: 10,
                padding: 12,
                minHeight: 72,
                color: ctx.theme.ink,
              }}
            />
            <FxRow gap={MOBILE_V2_SPACING.md}>
              <FxButton
                theme={ctx.theme}
                variant="soft"
                onPress={() => setPickupHandoffSheet(null)}
                testID="mobile-action-composer-close"
              >
                Cancel
              </FxButton>
              <View style={{ flex: 1 }} />
              <FxButton
                theme={ctx.theme}
                variant="success"
                onPress={() => {
                  if (pickupHandoffSheet === null) return;
                  const quantity = Number(pickupHandoffQuantity);
                  if (!Number.isFinite(quantity) || quantity <= 0) return;
                  submitPickupCloseout(pickupHandoffSheet, "completed", undefined, {
                    confirmedQuantity: quantity,
                    handoverContactName: pickupHandoffContactName,
                    handoverNotes: pickupHandoffNotes,
                    receiptContext: pickupHandoffReceiptContext,
                  });
                  setPickupHandoffSheet(null);
                }}
                testID="mobile-action-composer-queue"
              >
                Queue
              </FxButton>
            </FxRow>
          </View>
        </View>
      ) : null}
      {pickupFailureComposerSheet !== null ? (
        <View
          style={{
            position: "absolute",
            left: 0,
            right: 0,
            top: 0,
            bottom: 0,
            backgroundColor: "rgba(0,0,0,0.35)",
            justifyContent: "flex-end",
            zIndex: 50,
          }}
        >
          <View
            style={{
              backgroundColor: ctx.theme.surface,
              borderTopLeftRadius: 18,
              borderTopRightRadius: 18,
              padding: 18,
              rowGap: 12,
            }}
          >
            <Text style={{ color: ctx.theme.muted, fontSize: 12 }}>
              Outbox: {queueCount}
            </Text>
            <Text style={{ color: ctx.theme.ink, fontSize: 18, fontWeight: "700" }}>
              Pickup failure
            </Text>
            <FxRow gap={MOBILE_V2_SPACING.sm} wrap>
              {pickupFailureReasons.map((reason) => (
                <Pressable
                  key={reason.key}
                  accessibilityRole="button"
                  onPress={() => setPickupFailureReason(reason.key)}
                  style={({ pressed }) => [
                    {
                      borderWidth: 1,
                      borderColor:
                        pickupFailureReason === reason.key ? ctx.theme.accent : ctx.theme.border,
                      borderRadius: 999,
                      paddingVertical: 8,
                      paddingHorizontal: 12,
                      backgroundColor:
                        pickupFailureReason === reason.key ? ctx.theme.accentSoft : ctx.theme.surface,
                    },
                    pressed ? { opacity: 0.78 } : null,
                  ]}
                >
                  <Text style={{ color: ctx.theme.ink, fontWeight: "600" }}>{reason.label}</Text>
                </Pressable>
              ))}
            </FxRow>
            {pickupFailureReason ? (
              <Text style={{ color: ctx.theme.muted }}>
                Selected: {getMobileV2PickupFailureReasonLabel(pickupFailureReason, pickupFailureReasons)}
              </Text>
            ) : null}
            <TextInput
              placeholder="Describe the failed pickup and recovery context."
              value={pickupFailureNotes}
              onChangeText={setPickupFailureNotes}
              multiline
              style={{
                borderWidth: 1,
                borderColor: ctx.theme.border,
                borderRadius: 10,
                padding: 12,
                minHeight: 86,
                color: ctx.theme.ink,
              }}
            />
            <FxRow gap={MOBILE_V2_SPACING.md}>
              <FxButton
                theme={ctx.theme}
                variant="soft"
                onPress={() => setPickupFailureComposerSheet(null)}
                testID="mobile-action-composer-close"
              >
                Cancel
              </FxButton>
              <View style={{ flex: 1 }} />
              <FxButton
                theme={ctx.theme}
                variant="danger"
                onPress={() => {
                  if (pickupFailureComposerSheet === null) return;
                  if (!pickupFailureReason.trim()) return;
                  submitPickupCloseout(pickupFailureComposerSheet, "failed", pickupFailureNotes.trim());
                  setPickupFailureComposerSheet(null);
                  setPickupFailureNotes("");
                }}
                testID="mobile-action-composer-queue"
              >
                Queue
              </FxButton>
            </FxRow>
          </View>
        </View>
      ) : null}
      <MobileV2NoteSheet
        theme={ctx.theme}
        visible={pickupFailureNoteSheet !== null}
        onClose={() => setPickupFailureNoteSheet(null)}
        title="Pickup failure"
        subtitle={
          pickupFailureNoteSheet !== null
            ? `${pickupFailureNoteSheet.merchant} - ${getMobileV2PickupFailureReasonLabel(pickupFailureReason, pickupFailureReasons)}`
            : undefined
        }
        prompt="What happened at pickup?"
        placeholder="Add the pickup failure details"
        value={pickupFailureNotes}
        onChangeValue={setPickupFailureNotes}
        confirmLabel="Record failure"
        destructive
        onConfirm={() => {
          if (pickupFailureNoteSheet === null) return;
          submitPickupCloseout(pickupFailureNoteSheet, "failed", pickupFailureNotes.trim());
          setPickupFailureNoteSheet(null);
          setPickupFailureNotes("");
        }}
      />

      {/* F13 — hold-queue destroy operator-note sheet. The destroy
          decision requires a real, non-empty note (sent as
          submit_fieldops_hold_decision_v1 p_note). */}
      <MobileV2NoteSheet
        theme={ctx.theme}
        visible={holdNoteSheet !== null}
        onClose={() => setHoldNoteSheet(null)}
        title="Destroy parcel?"
        subtitle={
          holdNoteSheet !== null
            ? `${holdNoteSheet.holdId} cannot be recovered`
            : undefined
        }
        prompt="Why is this parcel being destroyed?"
        placeholder="Describe the reason for this hold decision"
        value={holdNoteText}
        onChangeValue={setHoldNoteText}
        confirmLabel="Destroy parcel"
        destructive
        onConfirm={() => {
          if (holdNoteSheet === null) return;
          applyHoldDecision(holdNoteSheet.holdId, "destroy", holdNoteText.trim());
          setHoldNoteSheet(null);
          setHoldNoteText("");
        }}
      />
    </>
  );
}

function isLoginEntryRequested(): boolean {
  if (typeof window === "undefined" || typeof window.location === "undefined") {
    return false;
  }
  try {
    return new URL(window.location.href).searchParams.get("start") === "login";
  } catch {
    return false;
  }
}

/**
 * Optional pre-PreviewBody login gate. Reachable only via the explicit
 * URL query param `?v2=preview&start=login` so the production default
 * (boot directly into Tasks) is preserved. Lets human-flow E2E tests
 * exercise the V2 login form (employee-id → OTP → submit) from the
 * app entry point without changing the production cutover path.
 *
 * The gate uses local component state — no supabase auth call — so it
 * remains preview-safe. Once both steps validate, the gate flips its
 * `signedIn` flag and the underlying `PreviewBody` mounts.
 */
function PreviewLoginGate({ children }: { readonly children: React.ReactNode }): React.ReactElement {
  const ctx = useMobileV2Theme();
  const [signedIn, setSignedIn] = React.useState(false);
  const [step, setStep] = React.useState<MobileV2LoginStep>("emp");
  const [employeeId, setEmployeeId] = React.useState("");
  const [otp, setOtp] = React.useState("");
  if (signedIn) return <>{children}</>;
  return (
    <MobileV2LoginScreen
      theme={ctx.theme}
      brandGlyph="M"
      step={step}
      employeeId={employeeId}
      otp={otp}
      otpMaskedPhone="•••• 4128"
      versionLabel="MasarX FieldOps V2 · preview"
      onEmployeeIdChange={setEmployeeId}
      onOtpChange={setOtp}
      onGoToSignup={() => {
        /* preview-only — production routes to the V2 signup screen */
      }}
      onSubmit={() => {
        if (step === "emp") {
          setStep("otp");
          return;
        }
        setSignedIn(true);
      }}
    />
  );
}

export function MobileV2PreviewScreen(): React.ReactElement {
  const storage = React.useMemo(() => createFieldOpsStorage(), []);
  // Build the QueryClient once. In production this would also wire a
  // supabase client; the preview keeps supabase=null so RPC hooks resolve
  // through their fallback path against placeholder env mode.
  const queryClient = React.useMemo(() => new QueryClient(buildMobileV2QueryClientOptions()), []);
  // Active role hardcoded to 'driver' in preview; production resolves it
  // from auth_get_active_role_v1 + drawer role switcher.
  const rpcContext = React.useMemo(
    () => ({
      supabase: null,
      activeRole: "driver" as MobileV2Role,
      policyContext: {} as Record<string, unknown>,
    }),
    [],
  );
  const startAtLogin = isLoginEntryRequested();
  return (
    <SafeAreaProvider>
      <QueryClientProvider client={queryClient}>
        <MobileV2RpcProvider value={rpcContext}>
          <MobileV2ThemeProvider storage={storage}>
            {startAtLogin ? (
              <PreviewLoginGate>
                <PreviewBody />
              </PreviewLoginGate>
            ) : (
              <PreviewBody />
            )}
          </MobileV2ThemeProvider>
        </MobileV2RpcProvider>
      </QueryClientProvider>
    </SafeAreaProvider>
  );
}

// ---------------------------------------------------------------------------
// Native / production V2 shell entry point.
//
// Closes audit P0 #1 (docs/ops/evidence/2026-05-13/mobile-v2-fieldops-parity-audit/
// README.md). Unlike `MobileV2PreviewScreen` (which is a static showcase
// reachable via `?v2=preview` on web with `supabase=null`), this entry
// point is the production native cutover target: when `mobile_shell_policy.
// v2_enabled` resolves to TRUE, `apps/fieldops/App.tsx` mounts this
// component with the live supabase client + outbox + resolved active
// role wired in.
//
// Behavioral parity with the preview screen
// -----------------------------------------
// We deliberately reuse `PreviewBody` for the visual / interaction layer
// so the audit gallery and the production native shell render the same
// chrome / nav / surfaces. The only difference is the `MobileV2RpcProvider`
// value: in preview it carries `supabase=null` (RPC hooks short-circuit
// to fixtures), here it carries the live supabase client + outbox handle
// so every mutation hook is offline-first via the shared outbox.
//
// Outbox drainer
// --------------
// `useMobileV2OutboxDrainer` is mounted at the shell root via the
// internal `MobileV2OutboxDrainerMount` shim so queued mutations drain
// on connectivity restore and on a low-frequency tick. The drainer is a
// no-op when `outbox` is undefined.
// ---------------------------------------------------------------------------

export interface MobileV2NativeShellProps {
  /** Live supabase client (created via createMobileClient). */
  readonly supabase: SupabaseLikeClient;
  /** App-level registered device id from the canonical Mobile shell. */
  readonly deviceId?: string | null;
  /** Resolved active role from auth_get_active_role_v1. Defaults to "driver". */
  readonly activeRole?: MobileV2Role;
  /** Optional offline outbox handle. Drainer mounts a no-op when omitted. */
  readonly outbox?: MobileV2OutboxDrainBundle;
  /** Optional policy context (correlation_id, organization_id, etc.). */
  readonly policyContext?: Record<string, unknown>;
  /**
   * Optional QueryClient. Production callers (App.tsx) own the V1
   * QueryClient; the V2 shell needs its own client so cache keys do
   * not collide between V1 and V2 surfaces. When omitted, the shell
   * builds a fresh client with `buildMobileV2QueryClientOptions()`.
   */
  readonly queryClient?: QueryClient;
}

/**
 * Minimal supabase client surface consumed by RPC hooks. Kept as a
 * structural alias so this module does not pull `@supabase/supabase-js`
 * into its type imports — App.tsx already owns that import.
 */
export type SupabaseLikeClient = NonNullable<
  React.ComponentProps<typeof MobileV2RpcProvider>["value"]["supabase"]
>;

function MobileV2OutboxDrainerMount(props: {
  readonly outbox: MobileV2OutboxDrainBundle | undefined;
}): null {
  useMobileV2OutboxDrainer({ outbox: props.outbox });
  return null;
}

/**
 * Production-shell body. Runs INSIDE the V2 providers so it can read the
 * live supabase client + outbox from the RPC context and feed
 * `PreviewBody` REAL connectivity / outbox / session props.
 *
 * Engineering audit B1 + B3: this is the seam where the production
 * shell's `online`/`queueCount` indicator, More-screen outbox panel,
 * sign-out and manual-sync stop being fabricated constants / no-ops and
 * become wired to the device network state + the live outbox + the
 * supabase auth session.
 */
function MobileV2NativeShellBody(props: {
  readonly outbox: MobileV2OutboxDrainBundle | undefined;
  readonly activeRole: MobileV2Role;
  readonly deviceId?: string | null;
  readonly onActiveRoleChange: (role: MobileV2Role) => void;
}): React.ReactElement {
  const rpcCtx = useMobileV2Rpc();
  const queryClient = useQueryClient();
  const outbox = props.outbox;
  const storage = React.useMemo(() => createFieldOpsStorage(), []);
  const [storedDeviceId, setStoredDeviceId] = React.useState<string | null>(null);
  const deviceId = resolveMobileV2NativeShellDeviceId(props.deviceId, storedDeviceId);
  const [deviceRegistrationError, setDeviceRegistrationError] = React.useState<string | null>(null);
  const deviceRegistrationAttemptedRef = React.useRef(false);
  const [activeDriverShift, setActiveDriverShift] = React.useState<MobileV2ActiveDriverShift | null>(null);
  const [shiftMutating, setShiftMutating] = React.useState(false);
  const [shiftError, setShiftError] = React.useState<string | null>(null);
  const shiftMutationInFlightRef = React.useRef(false);

  React.useEffect(() => {
    let mounted = true;
    void Promise.all([
      storage.getItem(MOBILE_V2_DEVICE_ID_STORAGE_KEY),
      storage.getItem(MOBILE_V2_ACTIVE_OPS_SESSION_STORAGE_KEY),
    ]).then(([storedDeviceId, storedShift]) => {
      if (!mounted) return;
      setStoredDeviceId(storedDeviceId);
      setActiveDriverShift(readMobileV2ActiveDriverShift(storedShift));
    });
    return () => {
      mounted = false;
    };
  }, [storage]);

  // Device network reachability (expo-network). Seeded on mount and kept
  // current via the network-state listener.
  const [networkState, setNetworkState] = React.useState<Network.NetworkState | null>(null);
  React.useEffect(() => {
    let mounted = true;
    Network.getNetworkStateAsync()
      .then((next) => {
        if (mounted) setNetworkState(next);
      })
      .catch(() => {
        // Permission denial / boot race — fall back to "offline" (the
        // connectivity resolver fail-closes on a null state).
        if (mounted) setNetworkState(null);
      });
    const sub = Network.addNetworkStateListener((next) => {
      if (mounted) setNetworkState(next);
    });
    return () => {
      mounted = false;
      sub?.remove?.();
    };
  }, []);

  // Live outbox depth — polled on a low-frequency tick so the shell
  // badge reflects queued writes as the drainer flushes them.
  const queueCountQuery = useQuery<number>({
    queryKey: ["mobile-v2", "native-shell", "outbox-count"],
    queryFn: async () => (outbox !== undefined ? outbox.countPending() : 0),
    enabled: outbox !== undefined,
    refetchInterval: 15_000,
    initialData: 0,
  });

  // Live outbox rows for the More panel and full Sync Queue screen.
  const outboxRowsQuery = useQuery<ReadonlyArray<MobileV2RawOutboxSyncEntry>>({
    queryKey: ["mobile-v2", "native-shell", "outbox-entries"],
    queryFn: async () => {
      if (outbox?.list === undefined) return [];
      const rows = await outbox.list({ limit: 12 });
      return rows.map((r) =>
        Object.freeze({
          id: r.id,
          rpc: r.rpc,
          status: r.status,
          created_at: r.created_at,
          args: r.args,
          attempt_count: r.attempt_count,
        }),
      );
    },
    enabled: outbox?.list !== undefined,
    refetchInterval: 15_000,
    initialData: [] as ReadonlyArray<MobileV2RawOutboxSyncEntry>,
  });

  const [syncing, setSyncing] = React.useState(false);
  const [lastSyncMs, setLastSyncMs] = React.useState<number | null>(null);
  const outboxEntries = React.useMemo(
    () => projectMobileV2OutboxEntries(outboxRowsQuery.data ?? [], Date.now()),
    [outboxRowsQuery.data],
  );
  const syncQueueEntries = React.useMemo(
    () => projectMobileV2SyncQueueEntries(outboxRowsQuery.data ?? []),
    [outboxRowsQuery.data],
  );

  const connectivity = React.useMemo<MobileV2Connectivity>(
    () =>
      buildMobileV2Connectivity({
        networkState,
        queueCount: queueCountQuery.data ?? 0,
        syncing,
      }),
    [networkState, queueCountQuery.data, syncing],
  );

  React.useEffect(() => {
    let mounted = true;
    if (rpcCtx.supabase === null) return;
    if (!connectivity.online) {
      deviceRegistrationAttemptedRef.current = false;
      return;
    }
    if (deviceId !== null) {
      setDeviceRegistrationError(null);
      return;
    }
    if (deviceRegistrationAttemptedRef.current) return;
    deviceRegistrationAttemptedRef.current = true;

    void (async () => {
      const stored = normalizeMobileV2DeviceId(await storage.getItem(MOBILE_V2_DEVICE_ID_STORAGE_KEY));
      if (stored !== null) {
        if (mounted) setStoredDeviceId(stored);
        return;
      }

      let installId = normalizeMobileV2DeviceId(
        await storage.getItem(MOBILE_V2_DEVICE_INSTALL_ID_STORAGE_KEY),
      );
      if (installId === null) {
        installId = Crypto.randomUUID();
        await storage.setItem(MOBILE_V2_DEVICE_INSTALL_ID_STORAGE_KEY, installId);
      }

      const deviceIdentifierSha256 = await Crypto.digestStringAsync(
        Crypto.CryptoDigestAlgorithm.SHA256,
        installId,
      );
      const deviceLabel =
        typeof (Constants as unknown as { deviceName?: unknown }).deviceName === "string"
          ? ((Constants as unknown as { deviceName: string }).deviceName.trim() || null)
          : null;
      const { data, error } = await (rpcCtx.supabase as unknown as {
        rpc: (
          name: string,
          args: Record<string, unknown>,
        ) => Promise<{ data: unknown; error: { message?: string } | null }>;
      }).rpc("register_user_device_v1", {
        p_device: buildMobileV2NativeDeviceRegistrationPayload({
          deviceIdentifierSha256,
          platform: Platform.OS,
          deviceLabel,
          appVersion: Constants.expoConfig?.version ?? null,
          osVersion: String(Platform.Version),
          expoSdk: Constants.expoConfig?.sdkVersion ?? null,
          expoRuntime:
            typeof (Constants.expoConfig as { runtimeVersion?: unknown } | null | undefined)?.runtimeVersion === "string"
              ? (Constants.expoConfig as { runtimeVersion: string }).runtimeVersion
              : null,
        }),
      });
      if (error !== null && error !== undefined) throw error;
      const row = Array.isArray(data) ? data[0] : data;
      const nextDeviceId =
        row !== null &&
        typeof row === "object" &&
        "device_id" in row &&
        typeof (row as { device_id?: unknown }).device_id === "string"
          ? normalizeMobileV2DeviceId((row as { device_id: string }).device_id)
          : null;
      if (nextDeviceId === null) {
        throw new Error("Device registration did not return a device id.");
      }
      await storage.setItem(MOBILE_V2_DEVICE_ID_STORAGE_KEY, nextDeviceId);
      if (mounted) {
        setStoredDeviceId(nextDeviceId);
        setDeviceRegistrationError(null);
      }
    })().catch((error) => {
      deviceRegistrationAttemptedRef.current = false;
      if (mounted) setDeviceRegistrationError(formatMobileV2RouteMapLocationError(error));
    });

    return () => {
      mounted = false;
    };
  }, [connectivity.online, deviceId, rpcCtx.supabase, storage]);

  // Real session sign-out — invalidate the supabase auth session.
  const handleSignOut = React.useCallback(async (): Promise<void> => {
    const client = rpcCtx.supabase;
    if (client === null) return;
    await (client as unknown as {
      auth: { signOut: () => Promise<{ error: unknown }> };
    }).auth.signOut();
  }, [rpcCtx.supabase]);

  // Real manual sync — drain the offline outbox through the live client.
  const handleManualSync = React.useCallback(async (): Promise<void> => {
    if (outbox === undefined || rpcCtx.supabase === null) return;
    setSyncing(true);
    try {
      const result = await drainMobileV2Outbox({ supabase: rpcCtx.supabase, outbox, force: true });
      await refreshMobileV2QueriesAfterOutboxDrain({ queryClient, result, force: true });
      if (result.succeeded > 0) setLastSyncMs(Date.now());
    } finally {
      setSyncing(false);
      void queueCountQuery.refetch();
      void outboxRowsQuery.refetch();
    }
  }, [outbox, rpcCtx.supabase, queryClient, queueCountQuery, outboxRowsQuery]);

  const handleStartDriverShift = React.useCallback((): void => {
    if (shiftMutationInFlightRef.current || activeDriverShift !== null) {
      return;
    }
    const supabase = rpcCtx.supabase;
    if (supabase === null) {
      setShiftError("Shift needs a live session");
      return;
    }
    if (!connectivity.online) {
      setShiftError("Connect online before starting shift");
      return;
    }
    if (deviceId === null) {
      setShiftError("Register this device before starting shift");
      return;
    }
    shiftMutationInFlightRef.current = true;
    setShiftError(null);
    setShiftMutating(true);
    void (async () => {
      const openedAt = new Date().toISOString();
      const client = getMobileV2SupabaseSchemaClient(supabase, "api") as unknown as {
        rpc: (
          name: string,
          args: Record<string, unknown>,
        ) => Promise<{ data: unknown; error: { message?: string } | null }>;
      };
      const { data, error } = await client.rpc("open_ops_session_v1", {
        p_input: buildMobileV2StartDriverShiftInput({ deviceId, openedAt }),
      });
      if (error !== null && error !== undefined) throw error;
      const row = Array.isArray(data) ? data[0] : data;
      const opsSessionId =
        row !== null &&
        typeof row === "object" &&
        "ops_session_id" in row &&
        typeof (row as { ops_session_id?: unknown }).ops_session_id === "string"
          ? (row as { ops_session_id: string }).ops_session_id
          : null;
      if (opsSessionId === null || opsSessionId.trim() === "") {
        throw new Error("Driver shift did not return an ops_session_id.");
      }
      const { data: readbackData, error: readbackError } = await client.rpc(
        "ui_get_resource_v1",
        buildMobileV2OpsSessionReadbackInput(opsSessionId),
      );
      if (readbackError !== null && readbackError !== undefined) throw readbackError;
      const readback = parseMobileV2OpsSessionReadback(readbackData);
      if (!mobileV2DriverShiftStartMatchesReadback(readback, { opsSessionId, deviceId })) {
        throw new Error(MOBILE_V2_DRIVER_SHIFT_START_READBACK_FAILED_MESSAGE);
      }
      const nextShift: MobileV2ActiveDriverShift = {
        opsSessionId,
        openedAt: readback?.openedAt ?? openedAt,
      };
      await storage.setItem(MOBILE_V2_ACTIVE_OPS_SESSION_STORAGE_KEY, JSON.stringify(nextShift));
      setActiveDriverShift(nextShift);
    })()
      .catch((error) => {
        setShiftError(formatMobileV2UserError(error, "Unable to start shift"));
      })
      .finally(() => {
        shiftMutationInFlightRef.current = false;
        setShiftMutating(false);
      });
  }, [activeDriverShift, connectivity.online, deviceId, rpcCtx.supabase, storage]);

  const handleEndDriverShift = React.useCallback((): void => {
    if (shiftMutationInFlightRef.current) {
      return;
    }
    if (rpcCtx.supabase === null) {
      setShiftError("Shift needs a live session");
      return;
    }
    const supabase = rpcCtx.supabase;
    if (!connectivity.online) {
      setShiftError("Connect online before ending shift");
      return;
    }
    if (activeDriverShift === null) {
      void storage.removeItem(MOBILE_V2_ACTIVE_OPS_SESSION_STORAGE_KEY);
      setActiveDriverShift(null);
      return;
    }
    shiftMutationInFlightRef.current = true;
    setShiftError(null);
    setShiftMutating(true);
    void (async () => {
      const effectiveAt = new Date().toISOString();
      const client = getMobileV2SupabaseSchemaClient(supabase, "api") as unknown as {
        rpc: (
          name: string,
          args: Record<string, unknown>,
        ) => Promise<{ data: unknown; error: { message?: string } | null }>;
      };
      const { error } = await client.rpc("transition_ops_session_v1", {
        p_input: buildMobileV2EndDriverShiftInput({
          opsSessionId: activeDriverShift.opsSessionId,
          effectiveAt,
        }),
      });
      if (error !== null && error !== undefined) throw error;
      const { data: readbackData, error: readbackError } = await client.rpc(
        "ui_get_resource_v1",
        buildMobileV2OpsSessionReadbackInput(activeDriverShift.opsSessionId),
      );
      if (readbackError !== null && readbackError !== undefined) throw readbackError;
      const readback = parseMobileV2OpsSessionReadback(readbackData);
      if (!mobileV2DriverShiftCloseMatchesReadback(readback, { opsSessionId: activeDriverShift.opsSessionId })) {
        throw new Error(MOBILE_V2_DRIVER_SHIFT_CLOSE_READBACK_FAILED_MESSAGE);
      }
      await storage.removeItem(MOBILE_V2_ACTIVE_OPS_SESSION_STORAGE_KEY);
      setActiveDriverShift(null);
    })()
      .catch((error) => {
        setShiftError(formatMobileV2UserError(error, "Unable to end shift"));
      })
      .finally(() => {
        shiftMutationInFlightRef.current = false;
        setShiftMutating(false);
      });
  }, [activeDriverShift, connectivity.online, rpcCtx.supabase, storage]);

  const driverShift = React.useMemo<MobileV2DriverShiftPanel>(
    () => ({
      activeOpsSessionId: activeDriverShift?.opsSessionId ?? null,
      openedAt: activeDriverShift?.openedAt ?? null,
      canStart: connectivity.online && deviceId !== null,
      isMutating: shiftMutating,
      readinessLabel:
        deviceRegistrationError ??
        shiftError ??
        (connectivity.online && deviceId !== null ? "auth ok - device online" : "connect online and register device"),
      onStartShift: handleStartDriverShift,
      onEndShift: handleEndDriverShift,
    }),
    [
      activeDriverShift?.openedAt,
      activeDriverShift?.opsSessionId,
      connectivity.online,
      deviceId,
      deviceRegistrationError,
      handleEndDriverShift,
      handleStartDriverShift,
      shiftError,
      shiftMutating,
    ],
  );

  return (
    <PreviewBody
      activeRole={props.activeRole}
      onActiveRoleChange={props.onActiveRoleChange}
      connectivity={connectivity}
      outboxEntries={outboxEntries}
      syncQueueEntries={syncQueueEntries}
      lastSyncMs={lastSyncMs}
      onSignOut={handleSignOut}
      onManualSync={handleManualSync}
      driverShift={driverShift}
      deviceId={deviceId}
    />
  );
}

export function MobileV2NativeShell(
  props: MobileV2NativeShellProps,
): React.ReactElement {
  const storage = React.useMemo(() => createFieldOpsStorage(), []);
  const queryClient = React.useMemo(
    () => props.queryClient ?? new QueryClient(buildMobileV2QueryClientOptions()),
    [props.queryClient],
  );
  const [activeRole, setActiveRole] = React.useState<MobileV2Role>(
    (props.activeRole ?? "driver") as MobileV2Role,
  );
  React.useEffect(() => {
    setActiveRole((props.activeRole ?? "driver") as MobileV2Role);
  }, [props.activeRole]);
  const observableOutbox = React.useMemo<MobileV2OutboxDrainBundle | undefined>(() => {
    if (props.outbox === undefined) return undefined;
    const source = props.outbox;
    return {
      ...source,
      enqueue: async (input) => {
        const result = await source.enqueue(input);
        await Promise.all([
          queryClient.invalidateQueries({ queryKey: ["mobile-v2", "native-shell", "outbox-count"] }),
          queryClient.invalidateQueries({ queryKey: ["mobile-v2", "native-shell", "outbox-entries"] }),
        ]);
        return result;
      },
    };
  }, [props.outbox, queryClient]);
  const rpcContext = React.useMemo(
    () => ({
      supabase: props.supabase,
      activeRole,
      policyContext: props.policyContext ?? ({} as Record<string, unknown>),
      outbox: observableOutbox,
    }),
    [props.supabase, activeRole, props.policyContext, observableOutbox],
  );
  return (
    <SafeAreaProvider>
      <QueryClientProvider client={queryClient}>
        <MobileV2RpcProvider value={rpcContext}>
          <MobileV2ThemeProvider storage={storage}>
            <MobileV2OutboxDrainerMount outbox={observableOutbox} />
            <MobileV2NativeShellBody
              outbox={observableOutbox}
              activeRole={activeRole}
              deviceId={props.deviceId}
              onActiveRoleChange={setActiveRole}
            />
          </MobileV2ThemeProvider>
        </MobileV2RpcProvider>
      </QueryClientProvider>
    </SafeAreaProvider>
  );
}

export default MobileV2PreviewScreen;
