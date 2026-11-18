import { createPendingEvidence, encodeEvidenceBytes, handoffPendingEvidence, clearEvidenceLocalState, replaceEvidenceManagerAfterClear, type PendingEvidence, type EvidenceScope } from "./src/mobile-pending-evidence";
import { MobileRealMap } from "./src/mobile-real-map";
import { MobileTaskWorkspace } from "./src/mobile-task-workspace";
import { buildMobileMapListEntries, buildMobileRealMapModel } from "./src/mobile-real-map-model";
import { assertMobileCommandSelection, hasMobileCommandDisabledState, validateMobileComposerNumberValue,
  isMobileOutboxSyncBatchSuccessful, describeMobileActionReceiptStatus, formatMobileActionReceipt,
  describeMobileOutboxEntry, type MobileActionReceipt } from "./src/mobile-action-feedback";
import { redactOutboxErrorText, normalizeOutboxDisplay } from "@masarx/mobile-core";
import Constants from "expo-constants";
import * as Crypto from "expo-crypto";
import { CameraView, useCameraPermissions, type BarcodeScanningResult } from "expo-camera";
import * as Device from "expo-device";
import * as Location from "expo-location";
import * as Network from "expo-network";
import { StatusBar } from "expo-status-bar";
import React from "react";
import {
  Appearance,
  ActivityIndicator,
  Alert,
  AppState,
  FlatList,
  Linking,
  Modal,
  PanResponder,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  useColorScheme,
  View,
} from "react-native";
import { SafeAreaProvider, useSafeAreaInsets } from "react-native-safe-area-context";

import {
  QueryClient,
  QueryClientProvider,
  useMutation,
  useQuery,
  useQueryClient,
  type UseMutationResult,
} from "@tanstack/react-query";
import type {
  UiCommandDefinition,
  UiCommandInputSchema,
  UiMe,
  UiNavigation,
  UiNavigationItem,
  UiResourceList,
  UiTableView,
} from "@masarx/api";
import { isRetriableNetworkError, isRetriableSupabaseError } from "@masarx/api";
import { createMobileUiClient, normalizeNavigation } from "@masarx/api/mobile";
import { createMobileClient, createSupabaseExecutor } from "@masarx/auth/mobile";
import { createFieldOpsLocationExecutor, verifyRouteLocationContext, type RouteLocationContext } from "./src/mobile-location-context";
import { createRouteDepartureExecutor, enqueueRouteDeparture, routeDepartureQueueId, routeDepartureRequestState, ROUTE_DEPARTURE_RPC } from "./src/mobile-route-departure";
import type { MobileStorageAdapter } from "@masarx/auth/mobile";
import {
  createCacheKey,
  createOutbox,
  createOutboxId,
  stableStringify,
  type KeyValueStore,
  type OutboxStore,
  type OutboxSyncResult,
} from "@masarx/mobile-core";
import { createSqliteKeyValueStore, createSqliteOutboxStore } from "@masarx/mobile-core/sqlite";
import { syncCompletionOutbox, rememberCompletionReadback, latestCompletionReadback, verifyCompletionReadback, rememberIncidentReadback, forgetUnqueuedIncident, listIncidentReadbacks, incidentReadbackMatches, incidentReadbackDisplayState, activateCompletionReadbackScope, invalidateCompletionReadbacks, completionReadbackScopeVersion, completionReadbackScopeMatches, writeCompletionScopedValue, forgetUnqueuedCompletion, clearCompletionReadbacks, resolveVerifiedCompletionScope, completionScopeFromMe, rememberAcceptedReturnScan, rememberPendingReturnScan, listReturnScans, returnScanForQueue, forgetUnqueuedReturnScan, type CompletionReadbackRecord, type IncidentReadbackRecord } from "./src/mobile-completion-readback-storage";
import { submittedCompletionExpectation } from "./src/mobile-normalized-readback";
import { walletForm, walletStorageKey, walletScopeOrganization, readWalletDraft, readWalletSummary, readWalletReceipt } from "./src/mobile-wallet";
import { acceptedReturnScan, recoveredReturnScan, verifiedReturnScanReceipt } from "./src/mobile-return-scan";
import { MobileReturnActions } from "./src/mobile-return-actions";
import { parseFinancialTaskContext, resolveFinancialTaskSchema, financialTaskPayload, financialCompletionExpectation, financialEvidenceContract, type FinancialTaskContext } from "./src/mobile-financial-task-contract";
import { boundedCompletionRead } from "./src/mobile-completion-readback-storage";

import {
  getBackgroundLocationTrackingState,
  stopBackgroundLocationTracking,
  syncBackgroundLocationTracking,
} from "./src/mobile-background-location";
import {
  attestIosKeyAsync,
  generateIosAssertionAsync,
  generateIosAttestationKeyAsync,
  isExpoAppIntegrityAvailable,
  isIosAppIntegritySupported,
  prepareAndroidIntegrityTokenProviderAsync,
  requestAndroidIntegrityCheckAsync,
} from "./src/mobile-app-integrity";
import { normalizeMobileLocationTrackingPolicy } from "./src/mobile-location-policy";
import { normalizeMobileSyncPolicy } from "./src/mobile-sync-policy";
import { resolvePolicyRow } from "./src/mobile-policy-row";
import {
  POD_POLICY_UNAVAILABLE_MESSAGE,
  resolveComposerIdentityRequired,
  resolveComposerOtpRequired,
  resolveComposerPodPolicyState,
  resolveComposerSignatureRequired,
} from "./src/mobile-composer-pod";
import { openDriverSignup } from "./src/mobile-driver-signup";
import { getPublicConfigFromExpo, readExtraString, resolveExpoExtra, type ExpoExtra } from "./src/mobile-public-config";
import { createFieldOpsStorage } from "./src/mobile-storage";
import { StopAddressActions } from "./src/mobile-address-actions-controls";
import {
  normalizeMobileAttestationPolicy,
  shouldEnforceAttestationForRpc,
} from "./src/mobile-attestation-policy";
import {
  normalizeMobilePushPolicy,
  resolveExpoProjectIdFromConstants,
} from "./src/mobile-push-policy";
import {
  type AuthMethod,
  normalizeAuthEmail,
  normalizeAuthMethods,
  resolvePreferredAuthMethod,
} from "./src/mobile-auth-methods";
import { formatAuthErrorMessage } from "./src/mobile-auth-errors";
import {
  installGlobalCrashHandler,
  installUnhandledRejectionHandler,
  logDebugFailure,
  logMobileRequestTrace,
  normalizeDebugMessage,
} from "./src/mobile-debug";
import {
  addMobileNetworkFailureBreadcrumb,
  captureMobileException,
  initMobileCrashReporting,
  setMobileCrashReportingUser,
} from "./src/mobile-crash-reporting";
import { MobileErrorBoundary } from "./src/mobile-error-boundary";
import { OutboxEmptyState } from "./src/screens/OutboxScreen";
import { LocationCaptureStatus } from "./src/screens/LocationScreen";
import { clearMobileTelemetryEvents, flushMobileTelemetryEvents } from "./src/mobile-telemetry";
import {
  type MobileAddressPolicy,
  type MobileCommunicationPolicy,
  type MobileDiagnosticsPolicy,
  type MobileDevicePolicy,
  type MobileDriverSafetyPolicy,
  type MobileMapPolicy,
  type MobileNavigationPolicy,
  type MobilePlatform,
  type MobileUxSafetyPolicy,
  type MobileVisibilityPolicy,
  normalizeMobileAddressPolicy,
  normalizeMobileCommunicationPolicy,
  normalizeMobileDiagnosticsPolicy,
  normalizeMobileDevicePolicy,
  normalizeMobileDriverSafetyPolicy,
  normalizeMobileMapPolicy,
  normalizeMobileNavigationPolicy,
  normalizeMobileUxSafetyPolicy,
  normalizeMobileVisibilityPolicy,
} from "./src/mobile-shell-policy";
import {
  findNavItemById,
  resolveInitialSelectedNavItemId,
  parseMobileRouteFromHref,
  resolveMobileResourceSurface,
  type MobileRoute,
} from "./src/mobile-shell-navigation";
import {
  buildChannelUrl,
  buildNavigationUrl,
  extractAddressFields,
  extractCoordinates,
  extractCustomerName,
  extractFieldOpsActiveRoleSnapshot,
  fieldOpsLiveSourceResult,
  projectFieldOpsLiveOperations,
  selectFieldOpsLiveSources,
  extractOperationalContacts,
  extractOperationalStopSnapshot,
  extractPhoneNumber,
  extractRouteCardSnapshot,
  extractScanContext,
  extractSettlementSnapshot,
  extractTaskCardSnapshot,
  formatMoneyLabel,
} from "./src/mobile-shell-surface-helpers";
import { buildRouteMapModel } from "./src/mobile-shell-route-map";
import {
  type DrivingSafetyState,
  canNavigateWhileMoving,
  computeDrivingSafetyState,
  normalizeSpeedKph,
  speedMpsToKph,
} from "./src/mobile-shell-driving-safety";
import {
  type MobileScanInputMode,
  resolveAllowedScanInputModes,
  resolveEffectiveScanInputMode,
} from "./src/mobile-shell-scan-input";
import {
  resolveAllowedMobilePlatforms,
  resolveEffectiveMobilePlatform,
  resolveNormalizedPlatformOverride,
  resolveRuntimeMobilePlatform,
} from "./src/mobile-shell-platform";
import {
  formatMobileNavDisabledReason,
  hasMobileSettlementAccess,
  resolveAccessScopeSummary,
  resolveModuleLabelsFromSections,
} from "./src/mobile-shell-access";
import {
  type MobileConnectivityStatus,
  resolveConnectivitySnapshot,
} from "./src/mobile-shell-connectivity";
import {
  type MobileDisplayPolicy,
  type MobileDirectionMode,
  type MobileLocaleMode,
  type MobileThemeMode,
  normalizeMobileDisplayPolicy,
  resolveLocaleMode,
  resolveEffectiveDirection,
  resolveEffectiveLocale,
  resolveEffectiveTheme,
  toAppearanceColorScheme,
} from "./src/mobile-shell-display";
import {
  getFieldOpsThemeTokens,
  getTokensForTheme,
  resolveAppliedFieldOpsTheme,
  type FieldOpsThemeTokens,
} from "./src/mobile-theme";
import { ThemeProvider, type ThemeContextValue } from "./src/mobile-theme-context";
import { FieldOpsDrawerCloseButton } from "./src/mobile-drawer-close-button";
import { getFieldOpsStrings, type FieldOpsStrings } from "./src/i18n";
import { mobileActionAccessibility, mobileSyncAccessibility } from "./src/mobile-action-accessibility";
import { buildSignaturePdf } from "./src/mobile-signature-pdf";
import { resolveComposerEvidence, composerRetryArgs, buildComposerEvidenceMap, normalizeSelfKycFields, validateSelfKycFields } from "./src/mobile-composer-evidence";
import {
  resolveContentBottomPadding,
  resolveHeaderTopPadding,
  resolveNavModalBottomPadding,
} from "./src/mobile-shell-safe-area";
import {
  resolveMobileRoleCode,
  resolveMobileRoleLabel,
  resolveMobileShellHeaderTitle,
} from "./src/mobile-shell-header";
import { isJwtPrivilegedRole, resolveJwtRole } from "./src/mobile-jwt";
import { createWebKeyValueStore, createWebOutboxStore } from "./src/mobile-web-store";
import {
  buildRouteLoadAction,
  parseRouteLoadManifest,
  type RouteLoadActionInput,
} from "./src/mobile-route-load-manifest";
import {
  FIELDOPS_NATIVE_E2E_TEST_IDS,
  fieldOpsSignInMethodTestId,
} from "./src/mobile-native-e2e-test-ids";

const STORAGE_KEYS = {
  deviceInstallId: "fieldops_device_install_id_v1",
  deviceId: "fieldops_device_id_v1",
  attestationKeyId: "fieldops_attestation_key_id_v1",
} as const;

const KV_KEYS = {
  diagnosticsEnabled: "diagnostics_enabled_v1",
  visibilityMode: "visibility_mode_v1",
  routeView: "route_view_v1",
  scanInputMode: "scan_input_mode_v1",
  platformOverride: "platform_override_v1",
  localeMode: "locale_mode_v1",
  directionMode: "direction_mode_v1",
  themeMode: "theme_mode_v1",
  simulatedOffline: "simulated_offline_v1",
  simulatedSpeedKph: "simulated_speed_kph_v1",
  activeOpsSession: "fieldops_active_ops_session_v1",
} as const;

function readBootstrapExtraString(key: string): string | null {
  const extra = resolveExpoExtra();
  return readExtraString(extra, key) ?? null;
}

initMobileCrashReporting({
  dsn: readBootstrapExtraString("NEXT_PUBLIC_SENTRY_DSN"),
  environment:
    readBootstrapExtraString("NEXT_PUBLIC_SENTRY_ENVIRONMENT") ??
    (__DEV__ ? "development" : "production"),
  release: `fieldops@${Constants.expoConfig?.version ?? "unknown"}`,
});

function createQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: {
        retry: 1,
        refetchOnWindowFocus: false,
      },
    },
  });
}

function coerceHref(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function resolveCurrentWebHref(): string | null {
  if (Platform.OS !== "web") return null;
  const locationRecord = (
    globalThis as {
      location?: {
        href?: unknown;
        pathname?: unknown;
        search?: unknown;
        hash?: unknown;
      } | null;
    }
  ).location;
  if (!locationRecord) return null;
  const href = coerceHref(locationRecord.href);
  if (href) return href;
  const pathname = coerceHref(locationRecord.pathname);
  if (!pathname) return null;
  const search = typeof locationRecord.search === "string" ? locationRecord.search : "";
  const hash = typeof locationRecord.hash === "string" ? locationRecord.hash : "";
  return `${pathname}${search}${hash}`;
}

function resolveNavigationRoute(item: UiNavigationItem | null): MobileRoute {
  if (!item) return { kind: "home" };
  const resource = coerceHref(item.resource);
  if (resource) return { kind: "resource", resource };
  const href = coerceHref(item.href);
  if (!href) return { kind: "home" };
  return parseMobileRouteFromHref(href) ?? { kind: "unknown", href };
}

function resolveNavigationKey(item: UiNavigationItem | null): string {
  const route = resolveNavigationRoute(item);
  if (route.kind === "screen") return route.screen;
  if (route.kind === "resource") return route.resource.toLowerCase();
  const resourceSurface = resolveMobileResourceSurface(route);
  if (resourceSurface?.kind === "route") return "route";
  if (resourceSurface?.kind === "settlements") return "settlements";
  return "home";
}

function showMobileNotice(title: string, message: string) {
  const safeTitle = String(title ?? "").trim() || "Notice";
  const safeMessage = String(message ?? "").trim();

  const webAlert = (globalThis as unknown as { alert?: unknown }).alert;
  if (Platform.OS === "web" && typeof webAlert === "function") {
    (webAlert as (text: string) => void)(safeMessage ? `${safeTitle}\n\n${safeMessage}` : safeTitle);
    return;
  }

  Alert.alert(safeTitle, safeMessage ? safeMessage : undefined);
}

function formatUnknownError(error: unknown): string {
  if (!error) return "Unknown error";
  if (typeof error === "string") return error.trim() || "Unknown error";
  if (error instanceof Error) return error.message || "Unknown error";
  if (typeof error === "object") {
    const record = error as Record<string, unknown>;
    const message = coerceValueText(record.message);
    const details = coerceValueText(record.details);
    const hint = coerceValueText(record.hint);
    const code = coerceValueText(record.code);
    const parts = [message, details, hint].filter(Boolean) as string[];
    if (parts.length) {
      return code ? `[${code}] ${parts.join(" - ")}` : parts.join(" - ");
    }
    try {
      return JSON.stringify(record);
    } catch {
      return String(record);
    }
  }
  return String(error);
}

function resolveErrorCode(error: unknown): string | null {
  const record = asRecord(error);
  const code = coerceValueText(record.code);
  return code ? code.toUpperCase() : null;
}

function isUnsupportedResourceError(error: unknown, resourceKey: string) {
  const code = resolveErrorCode(error);
  if (code !== "P0001") return false;
  const message = formatUnknownError(error).toLowerCase();
  return message.includes("unknown resource") && message.includes(resourceKey.toLowerCase());
}

function createEmptyResourceList(
  resource: string,
  limit: number,
  offset: number
): UiResourceList {
  return {
    resource,
    keys: [],
    items: [],
    limit,
    offset,
    total: 0,
    total_strategy: "exact",
    total_is_estimate: false,
  };
}

async function openSystemSettingsSafe() {
  const openSettings = (Linking as unknown as { openSettings?: () => Promise<void> }).openSettings;
  if (typeof openSettings !== "function") {
    showMobileNotice(
      "Settings unavailable",
      "Opening system settings is not supported on this platform."
    );
    return false;
  }
  try {
    await openSettings();
    return true;
  } catch (error) {
    logDebugFailure("failed to open system settings", error);
    showMobileNotice(
      "Settings unavailable",
      "Could not open system settings right now."
    );
    return false;
  }
}

function confirmMobileAction(input: {
  title: string;
  message?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
}) {
  const title = String(input.title || "Confirm").trim() || "Confirm";
  const message = String(input.message || "").trim();

  const webConfirm = (globalThis as unknown as { confirm?: unknown }).confirm;
  if (Platform.OS === "web" && typeof webConfirm === "function") {
    const prompt = message ? `${title}\n\n${message}` : title;
    return Promise.resolve(Boolean((webConfirm as (text: string) => boolean)(prompt)));
  }

  return new Promise<boolean>((resolve) => {
    Alert.alert(
      title,
      message || undefined,
      [
        {
          text: input.cancelLabel ?? "Cancel",
          style: "cancel",
          onPress: () => resolve(false),
        },
        {
          text: input.confirmLabel ?? "Confirm",
          style: input.danger ? "destructive" : "default",
          onPress: () => resolve(true),
        },
      ]
    );
  });
}

const PRIMARY_MODULE_ORDER = ["tasks", "route", "scan", "location", "outbox", "more"] as const;
type PrimaryModuleKey = (typeof PRIMARY_MODULE_ORDER)[number] | "settlements";
type ComposerArtifactKind = "photo" | "signature";
type ComposerArtifactEntry = {
  artifactId: string;
  storageKey: string;
  capturedAt: string;
  kind: ComposerArtifactKind;
  mimeType: string;
  evidenceTag?: string;
};
type SignaturePoint = { x: number; y: number };
type SignatureStroke = SignaturePoint[];
type ActionSubmissionReceipt = MobileActionReceipt;
const TASK_ACTIONABLE_STATUSES = new Set(["open", "pending", "assigned", "in_progress"]);
const TASK_TERMINAL_STATUSES = new Set([
  "completed",
  "complete",
  "done",
  "closed",
  "cancelled",
  "canceled",
  "exception",
  "failed",
]);
const TASK_TERMINAL_REASONS = new Set([
  "completed",
  "complete",
  "done",
  "closed",
  "cancelled",
  "canceled",
  "exception",
  "failed",
  "rejected",
]);
const ROUTE_PROGRESS_COMMAND_KEYS = new Set(["tasks.en_route", "tasks.arrived"]);
function isCanonicalTaskActionable(detail: Record<string, unknown>): boolean {
  if (Object.keys(detail).length === 0) return false;
  const status = normalizeTaskStateToken(detail.status);
  const reason = normalizeTaskStateToken(detail.status_reason);
  const completedAt = coerceValueText(detail.completed_at);
  const canceledAt = coerceValueText(detail.canceled_at);
  if ((completedAt && completedAt !== "-") || (canceledAt && canceledAt !== "-") ||
      (status && TASK_TERMINAL_STATUSES.has(status)) || (reason && TASK_TERMINAL_REASONS.has(reason))) return false;
  return status ? TASK_ACTIONABLE_STATUSES.has(status) : false;
}

function selectDisplayedRouteTasks(
  items: ReadonlyArray<Record<string, unknown>>,
  preferredTaskId: string | null,
  preferredRouteRunId: string | null
): { items: Record<string, unknown>[]; routeRunId: string | null; routeRunIds: string[] } {
  const groups = new Map<string, Record<string, unknown>[]>();
  let taskRoute: string | null = null;
  for (const item of items) {
    const context = extractScanContext(item);
    if (!context.routeRunId || !context.routeStopId || !context.taskId) continue;
    if (context.taskId === preferredTaskId) taskRoute = context.routeRunId;
    const group = groups.get(context.routeRunId);
    if (group) group.push(item);
    else groups.set(context.routeRunId, [item]);
  }
  const explicit = preferredRouteRunId && groups.has(preferredRouteRunId) ? preferredRouteRunId : taskRoute;
  const routeRunId = explicit ??
    [...groups].find(([, group]) => group.some(isCanonicalTaskActionable))?.[0] ??
    groups.keys().next().value ?? null;
  return { items: routeRunId ? groups.get(routeRunId) ?? [] : [], routeRunId, routeRunIds: [...groups.keys()] };
}

const ROUTE_CLOSEOUT_COMMAND_KEYS = new Set(["tasks.close_route"]);

function resolvePrimaryModuleOrder(includeSettlements: boolean): PrimaryModuleKey[] {
  return includeSettlements
    ? ["tasks", "route", "scan", "location", "outbox", "settlements", "more"]
    : [...PRIMARY_MODULE_ORDER];
}

function resolveDrawerSections(
  sections: UiNavigation["sections"],
  options?: { includeSettlements?: boolean }
): Array<{ id: string; label: string; items: UiNavigationItem[] }> {
  const allItems = sections.flatMap((section) => flattenNavItems(section.items));
  const byKey = new Map<string, UiNavigationItem>();
  const moduleOrder = resolvePrimaryModuleOrder(Boolean(options?.includeSettlements));
  const primaryKeys = new Set(moduleOrder);

  for (const item of allItems) {
    const key = resolveNavigationKey(item);
    if (!moduleOrder.includes(key as PrimaryModuleKey)) continue;
    if (item.disabled_reason) continue;
    if (!byKey.has(key)) byKey.set(key, item);
  }

  const preferred = moduleOrder.map((key) => byKey.get(key)).filter(Boolean) as UiNavigationItem[];
  if (!preferred.length) return sections;

  const tasksItems = preferred.filter((item) => resolveNavigationKey(item) === "tasks");
  const moduleItems = preferred.filter((item) => resolveNavigationKey(item) !== "tasks");

  const out: Array<{ id: string; label: string; items: UiNavigationItem[] }> = [];
  if (tasksItems.length) out.push({ id: "primary_tasks", label: "Tasks", items: tasksItems });
  if (moduleItems.length) out.push({ id: "primary_modules", label: "Modules", items: moduleItems });

  const extraSections = sections
    .map((section) => {
      const items = flattenNavItems(section.items).filter((item) => {
        if (item.disabled_reason) return false;
        return !primaryKeys.has(resolveNavigationKey(item) as PrimaryModuleKey);
      });
      if (!items.length) return null;
      return {
        id: `${section.id}_extra`,
        label: section.label,
        items,
      };
    })
    .filter(Boolean) as Array<{ id: string; label: string; items: UiNavigationItem[] }>;

  if (extraSections.length) out.push(...extraSections);
  return out.length ? out : sections;
}

function findFirstEnabledNavItemByKey(
  sections: UiNavigation["sections"],
  key: string
): UiNavigationItem | null {
  const allItems = sections.flatMap((section) => flattenNavItems(section.items));
  for (const item of allItems) {
    if (item.disabled_reason) continue;
    if (resolveNavigationKey(item) === key) return item;
  }
  return null;
}

function buildPolicyContextFromMe(me: UiMe | null | undefined) {
  const ctx: Record<string, unknown> = {};
  if (!me) return ctx;

  if (me.org?.id) ctx.organization_id = me.org.id;
  if (me.user?.id) ctx.user_id = me.user.id;

  const scopeType = coerceHref(me.access_scope?.scope_type);
  const scopeId = coerceHref(me.access_scope?.scope_id);
  if (scopeType && scopeId) {
    const normalizedType = scopeType.trim().toLowerCase();
    if (normalizedType === "tenant" && !ctx.organization_id) ctx.organization_id = scopeId;
    else if (normalizedType === "client") ctx.client_id = scopeId;
    else if (normalizedType === "sender") ctx.sender_id = scopeId;
    else if (normalizedType === "source") ctx.webhook_source_id = scopeId;
    else if (normalizedType === "resource") ctx.resource_id = scopeId;
  }

  return ctx;
}

function isFieldOpsV2Authorized(query: { isSuccess: boolean; data: unknown }) {
  return query.isSuccess && asRecord(asRecord(query.data).value).v2_enabled === true;
}

function FieldOpsV2Gate({ enabled, disabled, children }: {
  enabled: boolean;
  disabled: React.ReactNode;
  children: React.ReactNode;
}) {
  return enabled ? children : disabled;
}

function buildDetailPolicyContext(
  baseContext: Record<string, unknown>,
  detailValue: Record<string, unknown> | null | undefined
) {
  const ctx: Record<string, unknown> = { ...baseContext };
  const detail = asRecord(detailValue);
  const metadata = asRecord(detail.metadata);
  const payload = asRecord(detail.payload);
  const routeStop = asRecord(detail.route_stop);
  const metadataRouteStop = asRecord(metadata.route_stop);
  const payloadRouteStop = asRecord(payload.route_stop);

  const branchId =
    coerceValueText(detail.branch_id) ??
    coerceValueText(metadata.branch_id) ??
    coerceValueText(payload.branch_id) ??
    coerceValueText(routeStop.branch_id) ??
    coerceValueText(metadataRouteStop.branch_id) ??
    coerceValueText(payloadRouteStop.branch_id);
  if (branchId) ctx.resource_id = branchId;

  const clientId =
    coerceValueText(detail.client_id) ??
    coerceValueText(metadata.client_id) ??
    coerceValueText(payload.client_id) ??
    coerceValueText(routeStop.client_id) ??
    coerceValueText(metadataRouteStop.client_id) ??
    coerceValueText(payloadRouteStop.client_id);
  if (clientId) ctx.client_id = clientId;

  const senderId =
    coerceValueText(detail.sender_id) ??
    coerceValueText(metadata.sender_id) ??
    coerceValueText(payload.sender_id);
  if (senderId) ctx.sender_id = senderId;

  return ctx;
}

function bytesToHex(bytes: Uint8Array) {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

async function getOrCreateDeviceInstallId(storage: MobileStorageAdapter) {
  const existing = await storage.getItem(STORAGE_KEYS.deviceInstallId);
  if (existing) return existing;

  const bytes = await Crypto.getRandomBytesAsync(32);
  const installId = bytesToHex(bytes);
  await storage.setItem(STORAGE_KEYS.deviceInstallId, installId);
  return installId;
}

async function getStoredDeviceId(storage: MobileStorageAdapter) {
  return storage.getItem(STORAGE_KEYS.deviceId);
}

async function setStoredDeviceId(storage: MobileStorageAdapter, deviceId: string) {
  await storage.setItem(STORAGE_KEYS.deviceId, deviceId);
}

async function clearStoredDeviceState(storage: MobileStorageAdapter) {
  await storage.removeItem(STORAGE_KEYS.deviceId);
  await storage.removeItem(STORAGE_KEYS.deviceInstallId);
  await storage.removeItem(STORAGE_KEYS.attestationKeyId);
}

function normalizePushToken(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function getExpoPushTokenData(value: unknown): string | null {
  if (!value || typeof value !== "object") return null;
  const tokenData = (value as { data?: unknown }).data;
  return normalizePushToken(tokenData);
}

function readContextId(
  context: Record<string, unknown>,
  key: "resource_id" | "organization_id" | "client_id" | "sender_id" | "webhook_source_id"
) {
  const value = context[key];
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function resolveBranchIdFromMe(me: UiMe | null | undefined): string | null {
  const accessScope = asRecord(me?.access_scope);
  const accessScopeType = coerceValueText(accessScope.scope_type)?.toLowerCase();
  const accessScopeId = coerceValueText(accessScope.scope_id);
  if (accessScopeType === "branch" && accessScopeId) return accessScopeId;

  const user = asRecord(me?.user);
  const userBranchId = coerceValueText(user.branch_id);
  return userBranchId ?? null;
}

type MobileAttestationEnvelope = {
  provider: "android_play_integrity" | "ios_app_attest";
  challenge_id: string;
  challenge: string;
  generated_at: string;
  integrity_token?: string;
  key_id?: string;
  assertion?: string;
  attestation?: string;
};

function toExpoLocationAccuracy(value: "lowest" | "low" | "balanced" | "high" | "highest") {
  if (value === "lowest") return Location.Accuracy.Lowest;
  if (value === "low") return Location.Accuracy.Low;
  if (value === "high") return Location.Accuracy.High;
  if (value === "highest") return Location.Accuracy.Highest;
  return Location.Accuracy.Balanced;
}

type NetworkState = Awaited<ReturnType<typeof Network.getNetworkStateAsync>>;

function computeOnline(state: NetworkState | null) {
  if (!state) return false;
  if (!state.isConnected) return false;
  if (state.isInternetReachable === false) return false;
  return true;
}

function useNetworkState() {
  const [state, setState] = React.useState<NetworkState | null>(null);

  React.useEffect(() => {
    let mounted = true;
    Network.getNetworkStateAsync()
      .then((next) => {
        if (!mounted) return;
        setState(next);
      })
      .catch((error) => {
        logDebugFailure("failed to read network state", error);
        if (!mounted) return;
        setState(null);
      });

    const subscription = Network.addNetworkStateListener((next) => {
      if (!mounted) return;
      setState(next);
    });

    return () => {
      mounted = false;
      subscription?.remove?.();
    };
  }, []);

  return { state, online: computeOnline(state) };
}

function useAuthSession(client: ReturnType<typeof createMobileClient>) {
  const [ready, setReady] = React.useState(false);
  const [revision, setRevision] = React.useState(0);
  const [session, setSession] = React.useState<
    Awaited<ReturnType<typeof client.auth.getSession>>["data"]["session"]
  >(null);

  React.useEffect(() => {
    let mounted = true;
    let authEventSeen = false;

    client.auth
      .getSession()
      .then((result) => {
        if (!mounted || authEventSeen) return;
        setSession(result.data.session);
        setReady(true);
      })
      .catch((error) => {
        logDebugFailure("failed to load auth session", error);
        if (!mounted || authEventSeen) return;
        setSession(null);
        setReady(true);
      });

    const { data } = client.auth.onAuthStateChange((_event, nextSession) => {
      if (!mounted) return;
      authEventSeen = true;
      setRevision((value) => value + 1);
      setSession(nextSession);
      setReady(true);
    });

    return () => {
      mounted = false;
      data.subscription.unsubscribe();
    };
  }, [client]);

  return { ready, session, revision };
}

function flattenNavItems(items: UiNavigationItem[] | null | undefined): UiNavigationItem[] {
  if (!Array.isArray(items)) return [];
  const out: UiNavigationItem[] = [];
  for (const item of items) {
    out.push(item);
    if (item.items?.length) out.push(...flattenNavItems(item.items));
  }
  return out;
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

type LookupOption = {
  value: string;
  label: string;
  description: string | null;
  metadata?: Record<string, unknown>;
};

const COMPOSER_READINESS_STAGES = ["evidence", "fields", "notes", "policy", "signature", "proof", "recipient", "exception", "partial"] as const;
type ComposerValidation = {
  error: string | null;
  empty: boolean;
  fields: CommandInputFieldRuntime[];
  partialDeliveryBoxNumbers: number[] | null;
  completionKind: string | null;
  checks: { key: typeof COMPOSER_READINESS_STAGES[number]; status: "ready" | "needed" | "pending" | "unchecked" | "optional" }[];
};

function ComposerReadiness({ result, pending, strings, styles }: {
  result: ComposerValidation;
  pending: boolean;
  strings: FieldOpsStrings;
  styles: FieldOpsStyles;
}) {
  if (result.empty) return null;
  const copy = strings.composerReadiness;
  return (
    <View testID="mobile-composer-readiness" style={styles.noticeCard}>
      <Text accessibilityRole="header" style={styles.noticeText}>{copy.title}</Text>
      <Text accessibilityLiveRegion="polite" style={styles.noticeSubtext}>
        {pending ? copy.pending : result.error ? copy.needed : copy.ready}
      </Text>
      {result.checks.map(check => (
        <Text key={check.key} testID={`mobile-composer-readiness-${check.key}`} style={styles.noticeSubtext}>
          {strings.composerReadinessLabels[check.key]}{": "}{strings.composerReadinessStates[pending ? "pending" : check.status]}
        </Text>
      ))}
      <Text style={styles.noticeSubtext}>{copy.boundary}</Text>
    </View>
  );
}

type CommandInputFieldRuntime = {
  key: string;
  label: string;
  type: "text" | "textarea" | "lookup" | "number";
  required: boolean;
  placeholder: string | null;
  lookupCategory: string | null;
  lookupRpc?: string | null;
  lookupSelectionParam?: string | null;
  defaultValue: string | null;
};

const PAYMENT_COLLECTION_FIELD_KEYS = new Set([
  "payment_outcome",
  "payment_method",
  "payment_amount",
  "payment_receipt_context",
]);

function isPaymentCollectionFieldKey(key: string) {
  return PAYMENT_COLLECTION_FIELD_KEYS.has(key);
}

function coerceCommandInputSchema(value: unknown): UiCommandInputSchema | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as UiCommandInputSchema;
}

function resolveCommandInputFields(
  command: UiCommandDefinition,
  stopSnapshot?: ReturnType<typeof extractOperationalStopSnapshot> | null
): CommandInputFieldRuntime[] {
  const schema = coerceCommandInputSchema(command.execution?.input_schema);
  const rawFields = Array.isArray(schema?.fields) ? schema.fields : [];
  const out: CommandInputFieldRuntime[] = [];
  const stopKind = String(stopSnapshot?.kind ?? "").trim().toLowerCase();
  const isPickupStop = stopKind === "pickup";
  const supportsCodPaymentCollection = !isPickupStop && (stopSnapshot?.codAmount ?? 0) > 0;

  for (const rawField of rawFields) {
    if (!rawField || typeof rawField !== "object") continue;
    const key = coerceValueText((rawField as Record<string, unknown>).key);
    if (!key) continue;
    if (
      command.key === "tasks.complete" &&
      isPaymentCollectionFieldKey(key) &&
      !supportsCodPaymentCollection
    ) {
      continue;
    }
    const label =
      coerceValueText((rawField as Record<string, unknown>).label) ?? formatKeyLabel(key);
    const typeRaw = coerceValueText((rawField as Record<string, unknown>).type)?.toLowerCase();
    const type: "text" | "textarea" | "lookup" | "number" =
      typeRaw === "lookup" || typeRaw === "textarea" || typeRaw === "number"
        ? typeRaw
        : "text";
    const required = Boolean((rawField as Record<string, unknown>).required);
    const placeholder = coerceValueText((rawField as Record<string, unknown>).placeholder);
    const lookupRpc = coerceValueText(rawField.lookup_rpc);
    const lookupSelectionParam = coerceValueText(rawField.lookup_selection_param);
    const lookupCategory = coerceValueText(rawField.lookup_category) ?? lookupRpc;
    const defaultValue = coerceValueText((rawField as Record<string, unknown>).default_value);
    const allowedMethodsLabel =
      stopSnapshot?.allowedMethods.length
        ? stopSnapshot.allowedMethods.map((method) => formatKeyLabel(method)).join(", ")
        : null;

    let resolvedLabel = label;
    let resolvedType: CommandInputFieldRuntime["type"] = type;
    let resolvedPlaceholder = placeholder;

    if (!isPickupStop && command.key === "tasks.complete") {
      if (key === "payment_outcome") {
        resolvedLabel = "Payment outcome";
        resolvedPlaceholder = resolvedPlaceholder ?? "Collected, shortfall, refused, or discrepancy.";
      } else if (key === "payment_method") {
        resolvedLabel = "Payment method";
        resolvedPlaceholder = resolvedPlaceholder ?? (allowedMethodsLabel ? `Accepted methods: ${allowedMethodsLabel}` : "Cash, card, or approved method.");
      } else if (key === "payment_amount") {
        resolvedLabel = "Collected amount";
        resolvedType = "number";
        resolvedPlaceholder =
          resolvedPlaceholder ??
          (stopSnapshot?.expectedAmount != null
            ? `Expected ${stopSnapshot.currency ?? "SAR"} ${stopSnapshot.expectedAmount}`
            : "Enter the collected COD amount.");
      } else if (key === "payment_receipt_context") {
        resolvedLabel = "Receipt context";
        resolvedType = "textarea";
        resolvedPlaceholder =
          resolvedPlaceholder ?? "Receipt number, card slip, or customer acknowledgement details.";
      }
    }

    out.push({
      key,
      label:
        isPickupStop && command.key === "tasks.complete" && key === "recipient_name"
          ? "Handover contact name"
          : isPickupStop && command.key === "tasks.complete" && key === "completion_notes"
            ? "Handover notes"
            : isPickupStop && command.key === "tasks.exception" && key === "exception_reason"
            ? "Pickup failure reason"
              : isPickupStop && command.key === "tasks.exception" && key === "exception_notes"
                ? "Pickup failure notes"
                : resolvedLabel,
      type:
        isPickupStop && command.key === "tasks.complete" && key === "recipient_name"
          ? "text"
          : resolvedType,
      required,
      placeholder: resolvedPlaceholder,
      lookupCategory,
      lookupRpc,
      lookupSelectionParam,
      defaultValue,
    });
  }

  if (isPickupStop && command.key === "tasks.complete") {
    const pickupDefaults = {
      confirmed_quantity:
        stopSnapshot?.packageCount != null ? String(Math.round(stopSnapshot.packageCount)) : null,
      handover_contact_name: stopSnapshot?.customerName ?? null,
      handover_notes: stopSnapshot?.notes ?? null,
      receipt_context: stopSnapshot?.reference ?? null,
    };
    return [
      {
        key: "confirmed_quantity",
        label: "Confirmed quantity",
        type: "number",
        required: true,
        placeholder: "Enter the confirmed pickup quantity",
        lookupCategory: null,
        defaultValue: pickupDefaults.confirmed_quantity,
      },
      {
        key: "handover_contact_name",
        label: "Handover contact name",
        type: "text",
        required: true,
        placeholder: "Who received the pickup?",
        lookupCategory: null,
        defaultValue: pickupDefaults.handover_contact_name,
      },
      {
        key: "handover_notes",
        label: "Handover notes",
        type: "textarea",
        required: false,
        placeholder: "Add handover notes, condition notes, or receipt details.",
        lookupCategory: null,
        defaultValue: pickupDefaults.handover_notes,
      },
      {
        key: "receipt_context",
        label: "Receipt context",
        type: "textarea",
        required: false,
        placeholder: "Receipt number, counter, or handover context.",
        lookupCategory: null,
        defaultValue: pickupDefaults.receipt_context,
      },
    ];
  }

  if (isPickupStop && command.key === "tasks.exception") {
    return out.map((field) => {
      if (field.key === "exception_reason") {
        return {
          ...field,
          label: "Pickup failure reason",
          required: true,
          placeholder: field.placeholder ?? "Choose the pickup failure reason.",
        };
      }
      if (field.key === "exception_notes") {
        return {
          ...field,
          label: "Pickup failure notes",
          placeholder: field.placeholder ?? "Describe the failed pickup and recovery context.",
        };
      }
      return field;
    });
  }

  return out;
}

function isPickupStopSnapshot(stopSnapshot: ReturnType<typeof extractOperationalStopSnapshot> | null) {
  return String(stopSnapshot?.kind ?? "").trim().toLowerCase() === "pickup";
}

function resolveComposerCommandCopy(
  command: UiCommandDefinition,
  stopSnapshot: ReturnType<typeof extractOperationalStopSnapshot> | null
) {
  if (command.key === "tasks.close_route") {
    return {
      label: "Route closeout",
      title: "Route closeout",
      description:
        "Confirm the route-end checklist, leftover stop count, and closeout notes before queueing route closeout.",
    };
  }

  if (!isPickupStopSnapshot(stopSnapshot)) {
    if (command.key === "tasks.complete") {
      return {
        label: "Delivery completion",
        title: "Delivery completion",
        description:
          (stopSnapshot?.codAmount ?? 0) > 0
            ? "Capture the handover details, COD collection details, and any partial-delivery box numbers before queueing completion."
            : "Capture the handover details and, when only some pieces were handed over, record the delivered box numbers before queueing completion.",
      };
    }

    return {
      label: command.label,
      title: command.label ?? "Action input",
      description: "Provide required details before queueing this action.",
    };
  }

  if (command.key === "tasks.complete") {
    return {
      label: "Pickup handoff",
      title: "Pickup handoff",
      description:
        "Confirm the pickup quantity and handover receipt details before queueing the completion.",
    };
  }

  if (command.key === "tasks.exception") {
    return {
      label: "Pickup failure",
      title: "Pickup failure",
      description:
        "Capture the failure reason, notes, and evidence before queueing the exception.",
    };
  }

  return {
    label: command.label,
    title: command.label ?? "Action input",
    description: "Provide required details before queueing this action.",
  };
}

function resolveComposerFieldDefaultValue(
  field: CommandInputFieldRuntime,
  stopSnapshot: ReturnType<typeof extractOperationalStopSnapshot> | null
) {
  if (field.defaultValue) return field.defaultValue;

  if (!stopSnapshot) return null;

  if (field.key === "recipient_name" || field.key === "handover_contact_name") {
    return stopSnapshot.customerName ?? null;
  }

  if (field.key === "completion_notes" || field.key === "handover_notes") {
    return stopSnapshot.notes ?? null;
  }

  if (field.key === "confirmed_quantity") {
    return stopSnapshot.packageCount != null ? String(Math.round(stopSnapshot.packageCount)) : null;
  }

  if (field.key === "receipt_context" || field.key === "payment_receipt_context") {
    return stopSnapshot.reference ?? null;
  }

  if (field.key === "payment_amount") {
    const amount = stopSnapshot.expectedAmount ?? stopSnapshot.codAmount;
    return amount != null ? String(amount) : null;
  }

  return null;
}

function parseComposerFieldValue(field: CommandInputFieldRuntime, rawValue: string): string | number | null {
  const value = String(rawValue ?? "").trim();
  if (!value) return null;
  if (field.type === "number") {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) {
      throw new Error(`${field.label} must be a valid number.`);
    }
    return validateMobileComposerNumberValue(field.key, field.label, parsed);
  }
  return value;
}

function sanitizeOtpCode(rawValue: unknown): string | null {
  const digits = String(rawValue ?? "").replace(/\D+/g, "");
  return digits ? digits : null;
}

function sanitizeIdentityLast4(rawValue: unknown): string | null {
  const normalized = String(rawValue ?? "").replace(/[^A-Za-z0-9]+/g, "").toUpperCase();
  return normalized ? normalized : null;
}

function parsePositiveIntegerList(rawValue: string): number[] {
  const tokens = String(rawValue ?? "")
    .split(/[,\s]+/g)
    .map((value) => value.trim())
    .filter(Boolean);
  const out: number[] = [];
  for (const token of tokens) {
    const parsed = Number.parseInt(token, 10);
    if (!Number.isInteger(parsed) || parsed <= 0) {
      throw new Error("Delivered box numbers must be positive integers like 1,2.");
    }
    if (!out.includes(parsed)) out.push(parsed);
  }
  return out;
}

function resolvePartialDeliveryBoxNumbers(input: {
  rawValue: string;
  packageCount: number | null | undefined;
}): number[] {
  const deliveredBoxNumbers = parsePositiveIntegerList(input.rawValue);
  if (deliveredBoxNumbers.length === 0) {
    throw new Error("Enter at least one delivered box number for partial delivery.");
  }
  const packageCount =
    input.packageCount != null && Number.isFinite(input.packageCount)
      ? Math.max(0, Math.round(input.packageCount))
      : null;
  if (packageCount != null) {
    if (packageCount < 2) {
      throw new Error("Partial delivery requires a multi-piece shipment.");
    }
    for (const boxNumber of deliveredBoxNumbers) {
      if (boxNumber > packageCount) {
        throw new Error(`Delivered box numbers must be between 1 and ${packageCount}.`);
      }
    }
    if (deliveredBoxNumbers.length >= packageCount) {
      throw new Error("Partial delivery must leave at least one box outstanding.");
    }
  }
  return deliveredBoxNumbers;
}

function formatConnectivityStatusLabel(status: MobileConnectivityStatus, strings: FieldOpsStrings): string {
  if (status === "online") return strings.shell.online;
  if (status === "degraded") return strings.shell.degraded;
  return strings.shell.offline;
}

function formatConnectivityReason(reason: string): string {
  switch (String(reason || "").trim().toLowerCase()) {
    case "network_unavailable":
      return "Network unavailable";
    case "sync_errors":
      return "Recent sync errors";
    case "queue_pressure":
      return "Queue pressure";
    case "stale_sync":
      return "Sync is stale";
    case "missing_sync_baseline":
      return "Sync baseline missing";
    default:
      return formatKeyLabel(reason);
  }
}

function formatConnectivitySummary(input: {
  status: MobileConnectivityStatus;
  reasons: string[];
  outboxCount: number;
  lastSyncSuccessAt: string | null;
}): string {
  if (input.status === "online") {
    if (!input.lastSyncSuccessAt) return "Healthy connection";
    const lastSyncMs = Date.parse(input.lastSyncSuccessAt);
    if (!Number.isFinite(lastSyncMs)) return "Healthy connection";
    const minutes = Math.max(0, Math.round((Date.now() - lastSyncMs) / 60_000));
    return minutes <= 1 ? "Synced just now" : `Last sync ${minutes}m ago`;
  }
  if (input.status === "offline") {
    return input.outboxCount > 0
      ? `${input.outboxCount} action${input.outboxCount === 1 ? "" : "s"} queued for retry`
      : "Actions will queue until connectivity returns";
  }
  const text = input.reasons.map(formatConnectivityReason).filter(Boolean).join(", ");
  return text || "Connection is degraded";
}

function pickFirstTextValue(values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value !== "string") continue;
    const trimmed = value.trim();
    if (trimmed) return trimmed;
  }
  return null;
}

function formatResourceItemTitle(item: Record<string, unknown>, keys?: string[] | null) {
  const metadata = asRecord(item.metadata);
  const metadataTitle = pickFirstTextValue([
    metadata.title,
    metadata.label,
    metadata.name,
    metadata.ref,
    metadata.task_label,
  ]);
  if (metadataTitle) return metadataTitle;

  const candidates = Array.isArray(keys) && keys.length ? keys : Object.keys(item);
  const picked = candidates.slice(0, 3);
  const parts = picked
    .map((key) => {
      const value = item[key];
      if (value == null) return null;
      if (typeof value === "string") return value;
      if (typeof value === "number" || typeof value === "boolean") return String(value);
      return null;
    })
    .filter(Boolean) as string[];

  return parts.join(" - ") || "(no display fields)";
}

function pickResourceId(item: Record<string, unknown>, keys?: string[] | null): string | null {
  const direct = item.id;
  if (typeof direct === "string" && direct.trim()) return direct.trim();

  const metadata = asRecord(item.metadata);
  const metadataId = pickFirstTextValue([
    metadata.id,
    metadata.task_id,
    metadata.resource_id,
    metadata.shipment_id,
    metadata.settlement_id,
  ]);
  if (metadataId) return metadataId;

  const candidates = Array.isArray(keys) && keys.length ? keys : Object.keys(item);
  for (const key of candidates) {
    const value = item[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }

  for (const key of candidates) {
    if (!/_id$/i.test(key)) continue;
    const value = item[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }

  return null;
}

type DriverScanContext = ReturnType<typeof extractScanContext>;

function formatKeyLabel(key: string) {
  return key
    .replace(/[_-]+/g, " ")
    .replace(/\b\w/g, (m) => m.toUpperCase());
}

function coerceValueText(value: unknown): string | null {
  if (value == null) return null;
  if (typeof value === "string") return value.trim() || null;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return null;
}

function coerceValueNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}



function clampSignaturePoint(value: number, max: number): number {
  return Math.max(0, Math.min(max, Number.isFinite(value) ? value : 0));
}

function createSignatureSegments(strokes: SignatureStroke[]): Array<{
  key: string;
  left: number;
  top: number;
  width: number;
  angle: string;
}> {
  const segments: Array<{ key: string; left: number; top: number; width: number; angle: string }> = [];
  strokes.forEach((stroke, strokeIndex) => {
    for (let index = 1; index < stroke.length; index += 1) {
      const start = stroke[index - 1];
      const end = stroke[index];
      if (!start || !end) continue;
      const dx = end.x - start.x;
      const dy = end.y - start.y;
      const width = Math.hypot(dx, dy);
      if (!Number.isFinite(width) || width < 1.25) continue;
      segments.push({
        key: `${strokeIndex}:${index}`,
        left: (start.x + end.x) / 2 - width / 2,
        top: (start.y + end.y) / 2 - 1.25,
        width,
        angle: `${Math.atan2(dy, dx)}rad`,
      });
    }
  });
  return segments;
}

function decodeBase64ToArrayBuffer(value: string): ArrayBuffer {
  // Expo web returns a JPEG data URL; native returns the base64 payload.
  const encoded = value.startsWith("data:image/jpeg;base64,")
    ? value.slice("data:image/jpeg;base64,".length) : value;
  if (!encoded || encoded.startsWith("data:")) {
    throw new Error("Invalid camera JPEG base64 data.");
  }
  const decoded = globalThis.atob(encoded);
  const bytes = new Uint8Array(decoded.length);
  for (let index = 0; index < decoded.length; index += 1) {
    bytes[index] = decoded.charCodeAt(index);
  }
  return bytes.buffer;
}

function normalizeReasonKey(value: string | null | undefined) {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_");
}

function renderKeyValueInline(key: string, value: unknown) {
  const text = coerceValueText(value);
  if (!text) return null;
  return `${formatKeyLabel(key)}: ${text}`;
}

function formatRouteViewLabel(mode: "list" | "orders_map", strings: FieldOpsStrings) {
  return mode === "orders_map" ? strings.route.viewMap : strings.route.viewList;
}

function formatOperationalTitle(input: {
  title: string;
  customerName?: string | null;
  reference?: string | null;
}) {
  if (input.customerName) return input.customerName;
  if (input.reference) return input.reference;
  return input.title;
}

function normalizeTaskStateToken(value: unknown) {
  return coerceValueText(value)?.trim().toLowerCase() ?? null;
}

function formatOperationalStatusChip(status: string | null | undefined, statusReason?: string | null) {
  const normalizedStatus = normalizeTaskStateToken(status);
  const normalizedReason = normalizeTaskStateToken(statusReason);

  if (normalizedStatus === "in_progress" && normalizedReason) {
    return formatKeyLabel(normalizedReason);
  }
  if (normalizedStatus) {
    return formatKeyLabel(normalizedStatus);
  }
  if (normalizedReason) {
    return formatKeyLabel(normalizedReason);
  }
  return null;
}

function isRouteStopExecutionTask(detailValue: unknown) {
  const detail = asRecord(detailValue);
  return (
    normalizeTaskStateToken(detail.resource_type) === "route_stop" &&
    normalizeTaskStateToken(detail.task_type_key) === "route_stop_execute"
  );
}

function pickCardChips(params: {
  item: Record<string, unknown>;
  keys: string[];
  exclude?: Set<string>;
  limit?: number;
}) {
  const exclude = params.exclude ?? new Set<string>();
  const limit = params.limit ?? 3;
  const chips: Array<{ key: string; value: string }> = [];

  for (const key of params.keys) {
    if (exclude.has(key)) continue;
    const text = coerceValueText(params.item[key]);
    if (!text) continue;
    if (text.length > 18) continue;
    chips.push({ key, value: text });
    if (chips.length >= limit) break;
  }

  return chips;
}

function SignInScreen({
  appName,
  client,
  methods,
  driverSignupUrl,
  locale,
}: {
  appName: string;
  client: ReturnType<typeof createMobileClient>;
  methods: string[];
  driverSignupUrl: string | null;
  locale: string;
}) {
  const styles = useFieldOpsStyles();
  const strings = getFieldOpsStrings(resolveLocaleMode(locale));
  const availableMethods = React.useMemo(() => normalizeAuthMethods(methods), [methods]);
  const [method, setMethod] = React.useState<AuthMethod>(
    resolvePreferredAuthMethod(availableMethods)
  );
  const [email, setEmail] = React.useState("");
  const [password, setPassword] = React.useState("");
  const [otpCode, setOtpCode] = React.useState("");
  const [otpSent, setOtpSent] = React.useState(false);
  const [status, setStatus] = React.useState<"idle" | "loading">("idle");
  const [errorMessage, setErrorMessage] = React.useState<string | null>(null);
  const isSubmittingRef = React.useRef(false);

  React.useEffect(() => {
    const next = resolvePreferredAuthMethod(availableMethods);
    if (!availableMethods.includes(method)) {
      setMethod(next);
    }
  }, [availableMethods, method]);

  const normalizedEmail = React.useMemo(() => normalizeAuthEmail(email), [email]);
  const hasEmail = normalizedEmail.length > 0;
  const hasPassword = password.trim().length > 0;
  const hasOtpCode = otpCode.trim().length > 0;
  const canSubmit =
    status !== "loading" &&
    !isSubmittingRef.current &&
    hasEmail &&
    (method !== "password" || hasPassword) &&
    (method !== "magic_link" || !otpSent || hasOtpCode);

  const reportSubmissionFailure = React.useCallback(
    (error: unknown) => {
      const nextMessage = formatAuthErrorMessage(error, normalizedEmail);
      setErrorMessage(nextMessage);
      logDebugFailure("failed to authenticate", error);
      Alert.alert(strings.auth.signInFailed, nextMessage);
    },
    [normalizedEmail]
  );

  const handleSendOtp = async () => {
    setErrorMessage(null);
    setStatus("loading");
    try {
      const { error } = await client.auth.signInWithOtp({
        email: normalizedEmail,
      });
      if (error) {
        const nextMessage = formatAuthErrorMessage(error, normalizedEmail);
        setErrorMessage(nextMessage);
        Alert.alert(strings.auth.signInFailed, nextMessage);
        return;
      }
      setOtpSent(true);
    } finally {
      setStatus("idle");
    }
  };

  const handleVerifyOtp = async () => {
    setErrorMessage(null);
    setStatus("loading");
    try {
      const { error } = await client.auth.verifyOtp({
        email: normalizedEmail,
        token: otpCode.trim(),
        type: "email",
      });
      if (error) {
        const nextMessage = formatAuthErrorMessage(error, normalizedEmail);
        setErrorMessage(nextMessage);
        Alert.alert(strings.auth.signInFailed, nextMessage);
        return;
      }
      setOtpSent(false);
      setOtpCode("");
    } finally {
      setStatus("idle");
    }
  };

  const handlePasswordSignIn = async () => {
    setErrorMessage(null);
    setStatus("loading");
    try {
      const { error } = await client.auth.signInWithPassword({
        email: normalizedEmail,
        password,
      });
      if (error) {
        const nextMessage = formatAuthErrorMessage(error, normalizedEmail);
        setErrorMessage(nextMessage);
        Alert.alert("Sign-in failed", nextMessage);
        return;
      }
    } finally {
      setStatus("idle");
    }
  };

  const submitAction = React.useCallback(() => {
    if (isSubmittingRef.current || status === "loading") return;
    if (!canSubmit) return;

    setErrorMessage(null);
    isSubmittingRef.current = true;
    const done = () => {
      isSubmittingRef.current = false;
    };
    const fail = (error: unknown) => {
      reportSubmissionFailure(error);
      done();
    };

    if (method === "password") {
      handlePasswordSignIn().then(done).catch(fail);
      return;
    }
    if (!otpSent) {
      handleSendOtp().then(done).catch(fail);
      return;
    }
    handleVerifyOtp().then(done).catch(fail);
  }, [canSubmit, handlePasswordSignIn, handleSendOtp, reportSubmissionFailure, handleVerifyOtp, method, otpSent, status]);

  const AuthFormContainer: React.ElementType = Platform.OS === "web" ? "form" : View;

  return (
    <View style={styles.container} testID={FIELDOPS_NATIVE_E2E_TEST_IDS.signInScreen}>
      <Text style={styles.title}>{appName}</Text>
      <Text style={styles.subtitle}>{strings.auth.subtitle}</Text>

      {availableMethods.length > 1 ? (
        <View style={styles.methodRow}>
          {availableMethods.map((candidate) => (
            <Pressable
              key={candidate}
              accessibilityRole="button"
              accessibilityLabel={candidate === "password" ? "Use password" : "Use email code"}
              accessibilityState={{ selected: candidate === method }}
              testID={fieldOpsSignInMethodTestId(candidate)}
              onPress={() => {
                setMethod(candidate);
                setOtpSent(false);
                setOtpCode("");
                setErrorMessage(null);
              }}
              style={({ pressed }) => [
                styles.methodChip,
                candidate === method && styles.methodChipActive,
                pressed && styles.navItemPressed,
              ]}
            >
              <Text style={styles.methodChipText}>
                {candidate === "password" ? strings.auth.passwordMethod : strings.auth.emailCodeMethod}
              </Text>
            </Pressable>
          ))}
        </View>
      ) : null}

      <AuthFormContainer
        style={styles.form}
        {...(Platform.OS === "web"
          ? {
              onSubmit: (event: unknown) => {
                const formEvent = event as { preventDefault?: () => void };
                formEvent.preventDefault?.();
                submitAction();
              },
            }
          : {})}
      >
        <TextInput
          accessibilityLabel="Email"
          testID={FIELDOPS_NATIVE_E2E_TEST_IDS.signInEmail}
          style={styles.input}
          value={email}
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="email-address"
          placeholder={strings.auth.emailPlaceholder}
          onChangeText={(nextEmail) => {
            setEmail(normalizeAuthEmail(nextEmail));
            setErrorMessage(null);
          }}
        />

        {method === "password" ? (
          <TextInput
            accessibilityLabel="Password"
            testID={FIELDOPS_NATIVE_E2E_TEST_IDS.signInPassword}
            style={styles.input}
            value={password}
            secureTextEntry
            placeholder={strings.auth.passwordPlaceholder}
            onChangeText={(nextPassword) => {
              setPassword(nextPassword);
              setErrorMessage(null);
            }}
          />
        ) : null}

        {method === "magic_link" && otpSent ? (
          <TextInput
            accessibilityLabel="Verification code"
            testID={FIELDOPS_NATIVE_E2E_TEST_IDS.signInOtp}
            style={styles.input}
            value={otpCode}
            placeholder={strings.auth.codePlaceholder}
            keyboardType="number-pad"
            onChangeText={(nextCode) => {
              setOtpCode(nextCode);
              setErrorMessage(null);
            }}
          />
        ) : null}

        <Pressable
          accessibilityRole="button"
          accessibilityState={{ disabled: !canSubmit }}
          testID={FIELDOPS_NATIVE_E2E_TEST_IDS.signInSubmit}
          disabled={!canSubmit}
          onPress={submitAction}
          style={({ pressed }) => [
            styles.primaryButton,
            !canSubmit && styles.primaryButtonDisabled,
            pressed && canSubmit && styles.primaryButtonPressed,
          ]}
        >
          <Text style={styles.primaryButtonText}>
            {status === "loading"
              ? strings.auth.working
              : method === "password"
                ? strings.auth.signIn
                : otpSent
                  ? strings.auth.verifyCode
                  : strings.auth.sendCode}
          </Text>
        </Pressable>
        <Pressable accessibilityRole="link" testID="fieldops-driver-signup"
          disabled={!driverSignupUrl || status === "loading"}
          accessibilityState={{ disabled: !driverSignupUrl || status === "loading" }}
          onPress={async () => {
            try { await openDriverSignup(driverSignupUrl, Linking); }
            catch { setErrorMessage(strings.auth.signupUnavailable); }
          }}>
          <Text style={styles.subtitle}>{strings.auth.signupBrowser}</Text>
        </Pressable>
        <Text style={styles.subtitle}>{driverSignupUrl ? strings.auth.signupPending : strings.auth.signupUnavailable}</Text>
        {errorMessage ? <Text style={styles.authError}>{errorMessage}</Text> : null}

        {status === "loading" ? (
          <View style={styles.loadingRow}>
            <ActivityIndicator />
            <Text style={styles.subtitle}>{strings.auth.pleaseWait}</Text>
          </View>
        ) : null}
      </AuthFormContainer>
    </View>
  );
}

function Bootstrap() {
  const styles = useFieldOpsStyles();
  const extra = React.useMemo(
    () => resolveExpoExtra((Constants.expoConfig?.extra ?? {}) as ExpoExtra),
    []
  );
  const publicConfig = React.useMemo(() => {
    try {
      return getPublicConfigFromExpo(extra);
    } catch {
      return null;
    }
  }, [extra]);
  const supabaseKeyRole = React.useMemo(() => {
    if (!publicConfig) return null;
    return resolveJwtRole(publicConfig.supabaseAnonKey);
  }, [publicConfig]);
  const storage = React.useMemo(() => createFieldOpsStorage(), []);

  if (!publicConfig) {
    return (
      <View style={styles.container} accessibilityRole="alert">
        <Text style={styles.title}>Fieldops</Text>
        <Text style={styles.error}>App setup required</Text>
        <Text style={styles.subtitle}>Ask your administrator to check the app setup.</Text>
      </View>
    );
  }

  if (isJwtPrivilegedRole(supabaseKeyRole)) {
    return (
      <View style={styles.container} accessibilityRole="alert">
        <Text style={styles.title}>{publicConfig.appName}</Text>
        <Text style={styles.error}>Invalid Supabase key</Text>
        <Text style={styles.subtitle}>
          This app cannot start with a privileged server key.
        </Text>
        <Text style={styles.mono}>
          Ask your administrator to configure a public client key and restart the app.
        </Text>
      </View>
    );
  }

  return <BootstrapConfigured publicConfig={publicConfig} storage={storage} />;
}

type BootstrapConfiguredProps = {
  publicConfig: ReturnType<typeof getPublicConfigFromExpo>;
  storage: MobileStorageAdapter;
};

function BootstrapConfigured({ publicConfig, storage }: BootstrapConfiguredProps) {
  const styles = useFieldOpsStyles();
  const strings = React.useMemo(
    () => getFieldOpsStrings(resolveLocaleMode(publicConfig.locale)), [publicConfig.locale]
  );
  const queryClient = useQueryClient();
  const safeAreaInsets = useSafeAreaInsets();

  const client = React.useMemo(
    () =>
      createMobileClient({
        supabaseUrl: publicConfig.supabaseUrl,
        supabaseAnonKey: publicConfig.supabaseAnonKey,
        storage,
        onRequestTrace: logMobileRequestTrace,
        onRequestFailure: (context) => {
          addMobileNetworkFailureBreadcrumb(context);
          const { method, url, status, statusText, correlationId, traceparent, error } = context;
          const transportError = error
            ? ` (${error})`
            : ` => ${status} ${statusText ?? ""}`;
          logDebugFailure(
            "mobile request failed",
            `${method} ${url}${transportError} [x-correlation-id=${correlationId}, traceparent=${traceparent}]`
          );
        },
      }),
    [publicConfig.supabaseUrl, publicConfig.supabaseAnonKey, storage]
  );
  const uiClient = React.useMemo(() => createMobileUiClient(client), [client]);
  const executor = React.useMemo(() => createFieldOpsLocationExecutor(
    createRouteDepartureExecutor(client, createSupabaseExecutor(client)),
    (resource, id) => uiClient.getResource(resource, id),
    async () => {
      const { data, error } = await client.auth.getUser();
      if (error) throw error;
      return data.user?.id ?? null;
    },
    async (expectedActorId) => {
      const { data, error } = await client.auth.getSession();
      if (error) throw error;
      const session = data.session;
      if (!session?.access_token || session.user.id !== expectedActorId) {
        throw new Error("Route location actor changed before dispatch.");
      }
      return async (rpc, args, transport = "rpc") => {
        if (transport !== "rpc") throw new Error("Route location requires RPC transport.");
        const result = await client.rpc(rpc as any, args as any)
          .setHeader("Authorization", `Bearer ${session.access_token}`);
        if (result.error) throw result.error;
        return result.data;
      };
    },
  ), [client, uiClient]);
  const auth = useAuthSession(client);
  const network = useNetworkState();

  const ctxQuery = useQuery({
    queryKey: ["ui", "context", "mobile", auth.session?.user?.id ?? null, Platform.OS === "web" ? auth.revision : null],
    queryFn: () => uiClient.context("mobile"),
    enabled: Boolean(auth.session),
  });
  const webOrganizationId = readContextId(buildPolicyContextFromMe(ctxQuery.data?.me), "organization_id");
  const webUserId = auth.session?.user?.id ?? null;
  const webScopeKey = webUserId && webOrganizationId && ctxQuery.data?.me.user?.id === webUserId
    ? JSON.stringify([webUserId, webOrganizationId]) : null;
  const currentWebScope = React.useRef(webScopeKey);
  currentWebScope.current = webScopeKey;
  const [boundWebScope, setBoundWebScope] = React.useState<string | null>(null);
  React.useEffect(() => {
    if (Platform.OS !== "web" || boundWebScope === webScopeKey) return;
    let cancelled = false;
    const predicate = (query: { queryKey: readonly unknown[] }) => !(query.queryKey[0] === "ui" && query.queryKey[1] === "context");
    void queryClient.cancelQueries({ predicate }).then(() => {
      if (cancelled) return;
      queryClient.removeQueries({ predicate });
      setBoundWebScope(webScopeKey);
    });
    return () => { cancelled = true; };
  }, [boundWebScope, webScopeKey, queryClient]);
  const webStoreScope = React.useMemo(() => webScopeKey && webUserId && webOrganizationId ? {
    userId: webUserId,
    organizationId: webOrganizationId,
    assertCurrent: async () => {
      const { data, error } = await client.auth.getSession();
      if (error || data.session?.user.id !== webUserId || currentWebScope.current !== webScopeKey) {
        throw new Error("Offline storage identity changed; reconnect before continuing.");
      }
    },
  } : null, [webScopeKey, webUserId, webOrganizationId, client]);

  React.useEffect(() => {
    if (!auth.ready) return;
    if (auth.session) return;
    if (Platform.OS === "web") return;

    stopBackgroundLocationTracking().catch((error) => {
      logDebugFailure("failed to stop background location tracking after session loss", error);
    });
  }, [auth.ready, auth.session]);
	
  const outboxStore = React.useMemo<OutboxStore>(
    () =>
      Platform.OS === "web"
        ? createWebOutboxStore(webStoreScope)
        : createSqliteOutboxStore({ databaseName: "fieldops.db", tableName: "outbox" }),
    [Platform.OS === "web" ? webStoreScope : null]
  );
  const outbox = React.useMemo(() => createOutbox(outboxStore), [outboxStore]);
  const cacheStore = React.useMemo<KeyValueStore>(
    () =>
      Platform.OS === "web"
        ? createWebKeyValueStore(webStoreScope)
        : createSqliteKeyValueStore({ databaseName: "fieldops.db", tableName: "kv_store" }),
    [Platform.OS === "web" ? webStoreScope : null]
  );

  const outboxInitQuery = useQuery({
    queryKey: ["outbox", "init", webScopeKey],
    queryFn: async () => {
      await outbox.init();
      return true;
    },
    staleTime: Infinity,
    enabled: Platform.OS !== "web" || Boolean(webScopeKey && boundWebScope === webScopeKey),
  });

  const cacheInitQuery = useQuery({
    queryKey: ["kv", "init", webScopeKey],
    queryFn: async () => {
      await cacheStore.init();
      return true;
    },
    staleTime: Infinity,
    enabled: Platform.OS !== "web" || Boolean(webScopeKey && boundWebScope === webScopeKey),
  });

  const outboxCountQuery = useQuery({
    queryKey: ["outbox", "count", webScopeKey],
    queryFn: () => outbox.countPending(),
    enabled: outboxInitQuery.isSuccess,
  });

  const [lastSyncSuccessAt, setLastSyncSuccessAt] = React.useState<string | null>(null);
  const [syncErrorCount, setSyncErrorCount] = React.useState(0);

  const syncMutation = useMutation({
    mutationFn: () =>
      syncCompletionOutbox(outbox, async (rpc, args) => {
        if (Platform.OS === "web") {
          if (!webStoreScope) throw new Error("Authenticated offline storage is not ready.");
          await webStoreScope.assertCurrent();
        }
        return executor(rpc, args);
      }, cacheStore, () => resolveVerifiedCompletionScope(client), {
        shouldRetry: (error) =>
          isRetriableNetworkError(error) || isRetriableSupabaseError(error),
        onSucceeded: async (entry, result) => {
          if (entry.rpc === ROUTE_DEPARTURE_RPC) {
            queryClient.invalidateQueries({ queryKey: ["route", "execution-manifest"] });
            queryClient.invalidateQueries({ queryKey: ["route", "departure-request"] });
          }
          if (entry.args.p_action_key === "tasks.report_incident")
            queryClient.invalidateQueries({ queryKey: ["incident-readback"] });
          const epoch = completionReadbackScopeVersion();
          const scope = await resolveVerifiedCompletionScope(client);
          const accepted = scope && acceptedReturnScan(entry, result, scope.actor);
          if (!scope || !accepted || epoch !== completionReadbackScopeVersion()) return;
          await rememberAcceptedReturnScan(cacheStore, scope, accepted);
          queryClient.invalidateQueries({ queryKey: ["accepted-return-scan"] });
          queryClient.invalidateQueries({ queryKey: ["return-scan-list"] });
        },
      }),
    onSuccess: (result) => {
      if (isMobileOutboxSyncBatchSuccessful(result)) {
        setLastSyncSuccessAt(new Date().toISOString());
        setSyncErrorCount(0);
      } else if (!(result?.attempted === 0 && result.succeeded === 0 && result.failed === 0 && result.dead === 0)) {
        setSyncErrorCount((previous) => Math.min(previous + 1, 20));
      }
      queryClient.invalidateQueries({ queryKey: ["outbox", "count"] });
      queryClient.invalidateQueries({ queryKey: ["outbox", "entries"] });
      queryClient.invalidateQueries({ queryKey: ["ui", "list"] });
      queryClient.invalidateQueries({ queryKey: ["ui", "detail"] });
      queryClient.invalidateQueries({ queryKey: ["return-scan-readback"] });
      queryClient.invalidateQueries({ queryKey: ["route", "execution-manifest"] });
      queryClient.invalidateQueries({ queryKey: ["route", "departure-request"] });
    },
    onError: () => {
      setSyncErrorCount((prev) => Math.min(prev + 1, 20));
    },
  });
  React.useEffect(() => {
    const subscription = AppState.addEventListener("change", state => {
      if (state === "active") queryClient.invalidateQueries({ queryKey: ["incident-readback"] });
    });
    return () => subscription.remove();
  }, [queryClient]);

  const mobileShellPolicyContext = React.useMemo(
    () => buildPolicyContextFromMe(ctxQuery.data?.me),
    [ctxQuery.data?.me]
  );
  const mobileShellPolicyQuery = useQuery({
    queryKey: ["policy", "mobile_shell_policy", stableStringify(mobileShellPolicyContext)],
    queryFn: () => resolvePolicyRow(client, "resolve_mobile_shell_policy", mobileShellPolicyContext),
    enabled: Boolean(ctxQuery.data?.me?.user?.id),
    staleTime: 60_000,
  });
  const fieldOpsV2Authorized = isFieldOpsV2Authorized(mobileShellPolicyQuery);

  const bootEventQueuedRef = React.useRef(false);
  React.useEffect(() => {
    if (!fieldOpsV2Authorized) return;
    if (!outboxInitQuery.isSuccess) return;
    if (!ctxQuery.data) return;
    if (bootEventQueuedRef.current) return;
    bootEventQueuedRef.current = true;

    outbox
      .enqueue({
        rpc: "ui_log_events_v1",
        args: {
          p_events: [
            {
              event_type: "mobile_boot",
              captured_at: new Date().toISOString(),
              metadata: {
                platform: "mobile",
                app: "fieldops",
              },
            },
          ],
          p_app: "mobile",
        },
      })
      .then(() => {
        queryClient.invalidateQueries({ queryKey: ["outbox", "count"] });
        queryClient.invalidateQueries({ queryKey: ["outbox", "entries"] });
      })
      .catch((error) => {
        logDebugFailure("failed to enqueue boot event", error);
      });
  }, [ctxQuery.data, fieldOpsV2Authorized, outbox, outboxInitQuery.isSuccess, queryClient]);

  if (!auth.ready) {
    return (
      <View style={styles.container}>
        <Text style={styles.title}>{publicConfig.appName}</Text>
        <Text style={styles.subtitle}>Loading session...</Text>
      </View>
    );
  }

  if (!auth.session) {
    return (
      <SignInScreen
        appName={publicConfig.appName}
        client={client}
        methods={publicConfig.authMethods}
        driverSignupUrl={publicConfig.driverSignupUrl}
        locale={publicConfig.locale}
      />
    );
  }

  if (ctxQuery.isLoading) {
    return (
      <View style={styles.container}>
        <Text style={styles.title}>{publicConfig.appName}</Text>
        <Text style={styles.subtitle}>Bootstrapping...</Text>
      </View>
    );
  }

  if (ctxQuery.isError) {
    return (
      <View style={styles.container}>
        <Text style={styles.title}>{publicConfig.appName}</Text>
        <Text style={styles.error}>Failed to load app context.</Text>
        <Text style={styles.mono}>{formatUnknownError(ctxQuery.error)}</Text>
      </View>
    );
  }

  if (Platform.OS === "web" && (!webScopeKey || boundWebScope !== webScopeKey)) {
    return <View style={styles.container}><Text style={!webScopeKey ? styles.error : styles.subtitle}>
      {!webScopeKey ? "Authenticated organization is unavailable. No offline action can be confirmed." : "Resolving authenticated offline storage..."}
    </Text></View>;
  }

  if (outboxInitQuery.isError || cacheInitQuery.isError) {
    return (
      <View style={styles.container}>
        <Text style={styles.title}>{publicConfig.appName}</Text>
        <Text style={styles.error}>Durable offline storage is unavailable. No queued action was confirmed.</Text>
        <Text style={styles.mono}>{formatUnknownError(outboxInitQuery.error ?? cacheInitQuery.error)}</Text>
        <Pressable onPress={() => { void outboxInitQuery.refetch(); void cacheInitQuery.refetch(); }} accessibilityRole="button">
          <Text>Retry storage</Text>
        </Pressable>
      </View>
    );
  }

  if (!ctxQuery.data) {
    return (
      <View style={styles.container}>
        <Text style={styles.title}>{publicConfig.appName}</Text>
        <Text style={styles.error}>Failed to load app context.</Text>
        <Text style={styles.mono}>No context payload was returned.</Text>
      </View>
    );
  }

  if (mobileShellPolicyQuery.isLoading) {
    return (
      <View style={styles.container}>
        <Text style={styles.title}>{publicConfig.appName}</Text>
        <Text style={styles.subtitle}>Bootstrapping...</Text>
      </View>
    );
  }

  return (
    <FieldOpsV2Gate
      enabled={fieldOpsV2Authorized}
      disabled={(
      <View style={styles.container}>
        <Text style={styles.title}>{publicConfig.appName}</Text>
        <Text style={styles.error}>{strings.bootstrap.v2Disabled}</Text>
      </View>
      )}
    >
    <BootstrapAuthed
      key={Platform.OS === "web" ? webScopeKey : undefined}
      ctx={ctxQuery.data}
      sessionUserId={auth.session.user.id}
      safeAreaInsets={safeAreaInsets}
      publicConfig={publicConfig}
      storage={storage}
      client={client}
      uiClient={uiClient}
      executor={executor}
      network={network}
      outboxStore={outboxStore}
      outbox={outbox}
      outboxInitSuccess={outboxInitQuery.isSuccess}
      cacheStore={cacheStore}
      cacheInitSuccess={cacheInitQuery.isSuccess}
      outboxCount={outboxCountQuery.data ?? 0}
      lastSyncSuccessAt={lastSyncSuccessAt}
      syncErrorCount={syncErrorCount}
      syncMutation={syncMutation}
    />
    </FieldOpsV2Gate>
  );
}

type BootstrapAuthedProps = {
  ctx: { me: UiMe; navigation: UiNavigation };
  sessionUserId: string;
  safeAreaInsets: ReturnType<typeof useSafeAreaInsets>;
  publicConfig: ReturnType<typeof getPublicConfigFromExpo>;
  storage: MobileStorageAdapter;
  client: ReturnType<typeof createMobileClient>;
  uiClient: ReturnType<typeof createMobileUiClient>;
  executor: ReturnType<typeof createSupabaseExecutor>;
  network: ReturnType<typeof useNetworkState>;
  outboxStore: ReturnType<typeof createSqliteOutboxStore>;
  outbox: ReturnType<typeof createOutbox>;
  outboxInitSuccess: boolean;
  cacheStore: ReturnType<typeof createSqliteKeyValueStore>;
  cacheInitSuccess: boolean;
  outboxCount: number;
  lastSyncSuccessAt: string | null;
  syncErrorCount: number;
  syncMutation: UseMutationResult<OutboxSyncResult, unknown, void, unknown>;
};

function BootstrapAuthed(props: BootstrapAuthedProps) {
  const queryClient = useQueryClient();
  const systemColorScheme = useColorScheme();
  const {
    ctx,
    sessionUserId,
    safeAreaInsets,
    publicConfig,
    storage,
    client,
    uiClient,
    executor,
    network,
    outboxStore,
    outbox,
    outboxInitSuccess,
    cacheStore,
    cacheInitSuccess,
    outboxCount,
    lastSyncSuccessAt,
    syncErrorCount,
    syncMutation,
  } = props;

  const { me } = ctx;
  React.useEffect(() => {
    const userRecord = asRecord(me?.user);
    const userIdRaw = userRecord.id;
    const userId =
      typeof userIdRaw === "string"
        ? userIdRaw.trim()
        : userIdRaw != null
          ? String(userIdRaw).trim()
          : "";
    if (!userId) return;
    const email = typeof userRecord.email === "string" ? userRecord.email.trim() || null : null;
    setMobileCrashReportingUser({ id: userId, ...(email ? { email } : {}) });
    return () => {
      setMobileCrashReportingUser(null);
    };
  }, [me]);
  const navigation = React.useMemo(
    () => normalizeNavigation(ctx.navigation),
    [ctx.navigation]
  );
  const [selectedId, setSelectedId] = React.useState<string | null>(null);
  const [currentWebHref, setCurrentWebHref] = React.useState<string | null>(() => resolveCurrentWebHref());
  const [displayedRoutePreference, setDisplayedRoutePreference] = React.useState<{ scope: string; routeRunId: string } | null>(null);
  const [selectedResourceId, setSelectedResourceId] = React.useState<string | null>(null);
  const [selectedResourceKey, setSelectedResourceKey] = React.useState<string | null>(null);
  const [selectedResourceTitle, setSelectedResourceTitle] = React.useState<string | null>(null);
  const [selectedViewId, setSelectedViewId] = React.useState<string | null>(null);
  const [navOpen, setNavOpen] = React.useState(false);
  const [viewPickerOpen, setViewPickerOpen] = React.useState(false);
  const [scanContext, setScanContext] = React.useState<DriverScanContext | null>(null);
  const [routeLocationContext, setRouteLocationContext] = React.useState<RouteLocationContext | null>(null);
  const routeLocationCurrent = React.useRef({ context: routeLocationContext, actor: me?.user?.id ?? null });
  routeLocationCurrent.current = { context: routeLocationContext, actor: me?.user?.id ?? null };
  const [observedSpeedKph, setObservedSpeedKph] = React.useState(0);

  React.useEffect(() => {
    if (Platform.OS !== "web") return;
    const windowRecord = (
      globalThis as {
        window?: {
          addEventListener?: (type: string, listener: () => void) => void;
          removeEventListener?: (type: string, listener: () => void) => void;
        } | null;
      }
    ).window;
    if (!windowRecord?.addEventListener || !windowRecord?.removeEventListener) return;
    const addWindowListener = windowRecord.addEventListener.bind(windowRecord);
    const removeWindowListener = windowRecord.removeEventListener.bind(windowRecord);
    const syncCurrentHref = () => {
      setCurrentWebHref(resolveCurrentWebHref());
    };
    syncCurrentHref();
    addWindowListener("popstate", syncCurrentHref);
    addWindowListener("hashchange", syncCurrentHref);
    return () => {
      removeWindowListener("popstate", syncCurrentHref);
      removeWindowListener("hashchange", syncCurrentHref);
    };
  }, []);

  React.useEffect(() => {
    const nextSelectedId = resolveInitialSelectedNavItemId(
      navigation.sections,
      selectedId,
      currentWebHref
    );
    if (!nextSelectedId || nextSelectedId === selectedId) return;
    setSelectedId(nextSelectedId);
  }, [navigation.sections, selectedId, currentWebHref]);

  const selectedItem = React.useMemo(() => {
    for (const section of navigation.sections) {
      const found = findNavItemById(section.items, selectedId);
      if (found) return found;
    }
    return null;
  }, [navigation.sections, selectedId]);

  const route = React.useMemo(() => resolveNavigationRoute(selectedItem), [selectedItem]);
  const activeScreen = route.kind === "screen" ? route.screen : null;
  React.useEffect(() => {
    if (activeScreen !== "location" || (routeLocationContext && routeLocationContext.actorId !== me?.user?.id)) {
      setRouteLocationContext(null);
    }
  }, [activeScreen, me?.user?.id, routeLocationContext]);
  const verifyLocationScope = async () => {
    const captured = routeLocationCurrent.current.context;
    if (!captured) return null;
    const current = await verifyRouteLocationContext(
      captured, (key, id) => uiClient.getResource(key, id), routeLocationCurrent.current.actor,
    );
    if (routeLocationCurrent.current.context !== captured || routeLocationCurrent.current.actor !== captured.actorId) {
      throw new Error(strings.scan.routeLocationChanged);
    }
    return current;
  };
  const resourceSurface = React.useMemo(
    () => resolveMobileResourceSurface(route),
    [route]
  );
  const resource = resourceSurface?.resource ?? null;
  const hasResourceView = Boolean(resource);
  const isRouteSurface = resourceSurface?.kind === "route";
  const isSettlementsSurface = resourceSurface?.kind === "settlements";
  const isTasksSurface = resource === "tasks" && !isRouteSurface && !isSettlementsSurface;
  const activeNavKey = React.useMemo(() => resolveNavigationKey(selectedItem), [selectedItem]);
  const isNavVisible = navOpen;
  const canReadTableViews = React.useMemo(() => {
    const capabilities = Array.isArray(me?.capabilities) ? me.capabilities : [];
    return capabilities.includes("settings.read");
  }, [me?.capabilities]);

  React.useEffect(() => {
    setSelectedResourceId(null);
    setSelectedResourceKey(null);
    setSelectedResourceTitle(null);
    setSelectedViewId(null);
    setViewPickerOpen(false);
  }, [resource, activeScreen]);

  const openModuleByKey = React.useCallback(
    (key: string) => {
      const item = findFirstEnabledNavItemByKey(navigation.sections, key);
      if (!item?.id) {
        Alert.alert("Module unavailable", "This module is not available for the current driver scope.");
        return;
      }
      setSelectedId(item.id);
      setNavOpen(false);
    },
    [navigation.sections]
  );

  const tableViewsQuery = useQuery({
    queryKey: [
      "ui",
      "table-views",
      resource,
      me?.access_scope?.scope_type ?? null,
      me?.access_scope?.scope_id ?? null,
    ],
    queryFn: () =>
      uiClient.tableViews(
        resource || "",
        me?.access_scope?.scope_type ?? null,
        me?.access_scope?.scope_id ?? null
      ),
    enabled: Boolean(resource && resource !== "settlements" && me?.user?.id && canReadTableViews),
  });

  const availableViews = React.useMemo<UiTableView[]>(() => {
    const views = tableViewsQuery.data?.views ?? null;
    if (!views || typeof views !== "object") return [];

    const out: UiTableView[] = [];
    for (const [id, view] of Object.entries(views as Record<string, UiTableView>)) {
      if (!view) continue;
      out.push({ ...view, id: view.id || id });
    }

    out.sort((a, b) => {
      const left = String(a.label || a.id);
      const right = String(b.label || b.id);
      return left.localeCompare(right);
    });

    return out;
  }, [tableViewsQuery.data?.views]);

  const resolvedViewId = React.useMemo(() => {
    if (selectedViewId && availableViews.some((view) => view.id === selectedViewId)) {
      return selectedViewId;
    }
    const defaultViewId = tableViewsQuery.data?.default_view_id ?? null;
    if (defaultViewId && availableViews.some((view) => view.id === defaultViewId)) {
      return defaultViewId;
    }
    return availableViews[0]?.id ?? null;
  }, [availableViews, selectedViewId, tableViewsQuery.data?.default_view_id]);

  const activeView = React.useMemo(() => {
    if (!resolvedViewId) return null;
    return availableViews.find((view) => view.id === resolvedViewId) ?? null;
  }, [availableViews, resolvedViewId]);

  const listFilters = React.useMemo(() => {
    const value = activeView?.filters ?? null;
    if (!value) return {};
    if (typeof value !== "object") return {};
    return value as Record<string, unknown>;
  }, [activeView?.filters]);

  const listSort = activeView?.sort ?? null;
  const capabilitiesSet = React.useMemo(
    () => new Set(me?.capabilities ?? []),
    [me?.capabilities]
  );
  const canReadSettlements = React.useMemo(
    () => hasMobileSettlementAccess(me?.capabilities),
    [me?.capabilities]
  );
  const listCacheKey = React.useMemo(() => {
    if (!resource) return null;
    return createCacheKey({
      v: 1,
      type: "ui_list_resource_v1",
      actor: me?.user?.id ?? null,
      scope: me?.access_scope ?? null,
      resource,
      view_id: resolvedViewId,
      filters: listFilters,
      limit: 50,
      offset: 0,
      sort: listSort,
    });
  }, [listFilters, listSort, resource, resolvedViewId, me?.user?.id, me?.access_scope]);

  const listQuery = useQuery({
    queryKey: [
      "ui",
      "list",
      listCacheKey ?? "missing",
      resource === "settlements" ? (canReadSettlements ? "settlements:enabled" : "settlements:disabled") : "resource",
    ],
    queryFn: async () => {
      if (resource === "settlements" && !canReadSettlements) {
        return {
          list: createEmptyResourceList("settlements", 50, 0),
          source: "network" as const,
          warning: "Settlements is not enabled for your access scope yet.",
        };
      }
      const cachedKey = listCacheKey;
      try {
        const list = await uiClient.listResource(resource || "", listFilters, 50, 0, listSort);
        if (cacheInitSuccess && cachedKey) {
          await cacheStore.set(cachedKey, { list, cached_at: new Date().toISOString() });
        }
        return { list, source: "network" as const, warning: null as string | null };
      } catch (error) {
        if (resource === "settlements" && isUnsupportedResourceError(error, "settlements")) {
          return {
            list: createEmptyResourceList("settlements", 50, 0),
            source: "network" as const,
            warning: "Settlements data is not configured for this workspace yet.",
          };
        }
        const retriable = isRetriableNetworkError(error) || isRetriableSupabaseError(error);
        if (!retriable || !cacheInitSuccess || !cachedKey) throw error;
        const cached = await cacheStore.get(cachedKey);
        if (
          cached &&
          typeof cached === "object" &&
          "list" in cached &&
          cached.list &&
          typeof cached.list === "object"
        ) {
          return {
            list: cached.list as UiResourceList,
            source: "cache" as const,
            warning: null as string | null,
          };
        }
        throw error;
      }
    },
    enabled: Boolean(resource),
  });
  const policyContext = React.useMemo(() => buildPolicyContextFromMe(me), [me]);

  const diagnosticsPolicyQuery = useQuery({
    queryKey: ["policy", "mobile_diagnostics_policy", stableStringify(policyContext)],
    queryFn: () => resolvePolicyRow(client, "resolve_mobile_diagnostics_policy", policyContext),
    enabled: Boolean(me?.user?.id),
    staleTime: 5 * 60_000,
  });

  const visibilityPolicyQuery = useQuery({
    queryKey: ["policy", "mobile_visibility_policy", stableStringify(policyContext)],
    queryFn: () => resolvePolicyRow(client, "resolve_mobile_visibility_policy", policyContext),
    enabled: Boolean(me?.user?.id),
    staleTime: 5 * 60_000,
  });

  const mapPolicyQuery = useQuery({
    queryKey: ["policy", "map_policy", stableStringify(policyContext)],
    queryFn: () => resolvePolicyRow(client, "resolve_map_policy", policyContext),
    enabled: Boolean(me?.user?.id),
    staleTime: 5 * 60_000,
  });

  const devicePolicyQuery = useQuery({
    queryKey: ["policy", "device_policy", stableStringify(policyContext)],
    queryFn: () => resolvePolicyRow(client, "resolve_device_policy", policyContext),
    enabled: Boolean(me?.user?.id),
    staleTime: 5 * 60_000,
  });

  const navigationPolicyQuery = useQuery({
    queryKey: ["policy", "navigation_policy", stableStringify(policyContext)],
    queryFn: () => resolvePolicyRow(client, "resolve_navigation_policy", policyContext),
    enabled: Boolean(me?.user?.id),
    staleTime: 5 * 60_000,
  });

  const driverSafetyPolicyQuery = useQuery({
    queryKey: ["policy", "driver_safety_policy", stableStringify(policyContext)],
    queryFn: () => resolvePolicyRow(client, "resolve_driver_safety_policy", policyContext),
    enabled: Boolean(me?.user?.id),
    staleTime: 5 * 60_000,
  });

  const uxSafetyPolicyQuery = useQuery({
    queryKey: ["policy", "ux_safety_policy", stableStringify(policyContext)],
    queryFn: () => resolvePolicyRow(client, "resolve_ux_safety_policy", policyContext),
    enabled: Boolean(me?.user?.id),
    staleTime: 5 * 60_000,
  });

  const communicationPolicyQuery = useQuery({
    queryKey: ["policy", "communication_policy", stableStringify(policyContext)],
    queryFn: () => resolvePolicyRow(client, "resolve_communication_policy", policyContext),
    enabled: Boolean(me?.user?.id),
    staleTime: 5 * 60_000,
  });

  const addressPolicyQuery = useQuery({
    queryKey: ["policy", "address_policy", stableStringify(policyContext)],
    queryFn: () => resolvePolicyRow(client, "resolve_address_policy", policyContext),
    enabled: Boolean(me?.user?.id),
    staleTime: 5 * 60_000,
  });

  const mobilePushPolicyQuery = useQuery({
    queryKey: ["policy", "mobile_push_policy", stableStringify(policyContext)],
    queryFn: () => resolvePolicyRow(client, "resolve_mobile_push_policy", policyContext),
    enabled: Boolean(me?.user?.id),
    staleTime: 5 * 60_000,
  });

  const mobileAttestationPolicyQuery = useQuery({
    queryKey: ["policy", "mobile_attestation_policy", stableStringify(policyContext)],
    queryFn: () => resolvePolicyRow(client, "resolve_mobile_attestation_policy", policyContext),
    enabled: Boolean(me?.user?.id),
    staleTime: 60_000,
  });

  const mobileSyncPolicyQuery = useQuery({
    queryKey: ["policy", "mobile_sync_policy", stableStringify(policyContext)],
    queryFn: () => resolvePolicyRow(client, "resolve_mobile_sync_policy", policyContext),
    enabled: Boolean(me?.user?.id),
    staleTime: 60_000,
  });

  const diagnosticsToggleQuery = useQuery({
    queryKey: ["kv", "get", KV_KEYS.diagnosticsEnabled],
    queryFn: async () => {
      const value = await cacheStore.get(KV_KEYS.diagnosticsEnabled);
      return typeof value === "boolean" ? value : null;
    },
    enabled: cacheInitSuccess,
    staleTime: Infinity,
  });

  const visibilityModeQuery = useQuery({
    queryKey: ["kv", "get", KV_KEYS.visibilityMode],
    queryFn: async () => {
      const value = await cacheStore.get(KV_KEYS.visibilityMode);
      return typeof value === "string" ? value : null;
    },
    enabled: cacheInitSuccess,
    staleTime: Infinity,
  });

  const routeViewQuery = useQuery({
    queryKey: ["kv", "get", KV_KEYS.routeView],
    queryFn: async () => {
      const value = await cacheStore.get(KV_KEYS.routeView);
      return typeof value === "string" ? value : null;
    },
    enabled: cacheInitSuccess,
    staleTime: Infinity,
  });
  const scanInputModeQuery = useQuery({
    queryKey: ["kv", "get", KV_KEYS.scanInputMode],
    queryFn: async () => {
      const value = await cacheStore.get(KV_KEYS.scanInputMode);
      return typeof value === "string" ? value : null;
    },
    enabled: cacheInitSuccess,
    staleTime: Infinity,
  });
  const platformOverrideQuery = useQuery({
    queryKey: ["kv", "get", KV_KEYS.platformOverride],
    queryFn: async () => {
      const value = await cacheStore.get(KV_KEYS.platformOverride);
      return typeof value === "string" ? value : null;
    },
    enabled: cacheInitSuccess,
    staleTime: Infinity,
  });

  const simulatedSpeedQuery = useQuery({
    queryKey: ["kv", "get", KV_KEYS.simulatedSpeedKph],
    queryFn: async () => {
      const value = await cacheStore.get(KV_KEYS.simulatedSpeedKph);
      return normalizeSpeedKph(value);
    },
    enabled: cacheInitSuccess,
    staleTime: Infinity,
  });
  const simulatedOfflineQuery = useQuery({
    queryKey: ["kv", "get", KV_KEYS.simulatedOffline],
    queryFn: async () => {
      const value = await cacheStore.get(KV_KEYS.simulatedOffline);
      return typeof value === "boolean" ? value : null;
    },
    enabled: cacheInitSuccess,
    staleTime: Infinity,
  });
  const localeModeQuery = useQuery({
    queryKey: ["kv", "get", KV_KEYS.localeMode],
    queryFn: async () => {
      const value = await cacheStore.get(KV_KEYS.localeMode);
      return typeof value === "string" ? value : null;
    },
    enabled: cacheInitSuccess,
    staleTime: Infinity,
  });
  const directionModeQuery = useQuery({
    queryKey: ["kv", "get", KV_KEYS.directionMode],
    queryFn: async () => {
      const value = await cacheStore.get(KV_KEYS.directionMode);
      return typeof value === "string" ? value : null;
    },
    enabled: cacheInitSuccess,
    staleTime: Infinity,
  });
  const themeModeQuery = useQuery({
    queryKey: ["kv", "get", KV_KEYS.themeMode],
    queryFn: async () => {
      const value = await cacheStore.get(KV_KEYS.themeMode);
      return typeof value === "string" ? value : null;
    },
    enabled: cacheInitSuccess,
    staleTime: Infinity,
  });
  const activeOpsSessionQuery = useQuery({
    queryKey: ["kv", "get", KV_KEYS.activeOpsSession],
    queryFn: async () => {
      const value = await cacheStore.get(KV_KEYS.activeOpsSession);
      return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
    },
    enabled: cacheInitSuccess,
    staleTime: Infinity,
  });
  const activeDriverShift = React.useMemo(() => {
    const value = activeOpsSessionQuery.data;
    if (!value) return null;
    const opsSessionId = coerceValueText(value.opsSessionId);
    if (!opsSessionId) return null;
    return {
      opsSessionId,
      sessionType: coerceValueText(value.sessionType) ?? "driver_shift",
      openedAt: coerceValueText(value.openedAt) ?? null,
      branchId: coerceValueText(value.branchId),
    };
  }, [activeOpsSessionQuery.data]);

  const diagnosticsPolicy = React.useMemo<MobileDiagnosticsPolicy>(
    () => normalizeMobileDiagnosticsPolicy(asRecord(diagnosticsPolicyQuery.data).value ?? null),
    [diagnosticsPolicyQuery.data]
  );
  const diagnosticsAllowToggle = diagnosticsPolicy.allowUserToggle;
  const diagnosticsDefaultOn = diagnosticsPolicy.defaultOn;
  const diagnosticsEnabled = React.useMemo(() => {
    if (!diagnosticsPolicy.enabled) return false;
    if (diagnosticsAllowToggle) {
      return diagnosticsToggleQuery.data ?? diagnosticsDefaultOn;
    }
    return diagnosticsDefaultOn;
  }, [diagnosticsAllowToggle, diagnosticsDefaultOn, diagnosticsPolicy.enabled, diagnosticsToggleQuery.data]);
  const mobileSyncPolicy = React.useMemo(
    () => normalizeMobileSyncPolicy((mobileSyncPolicyQuery.data as Record<string, unknown> | null)?.value ?? null),
    [mobileSyncPolicyQuery.data]
  );
  const connectivitySnapshot = React.useMemo(
    () =>
      resolveConnectivitySnapshot({
        networkOnline: network.online,
        diagnosticsEnabled,
        simulatedOffline: simulatedOfflineQuery.data,
        outboxPendingCount: outboxCount,
        lastSyncSuccessAt,
        syncErrorCount,
        degradedPendingThreshold: mobileSyncPolicy.degradedPendingThreshold,
        staleSyncAfterSeconds: mobileSyncPolicy.staleSyncAfterSeconds,
      }),
    [
      diagnosticsEnabled,
      network.online,
      simulatedOfflineQuery.data,
      outboxCount,
      lastSyncSuccessAt,
      syncErrorCount,
      mobileSyncPolicy.degradedPendingThreshold,
      mobileSyncPolicy.staleSyncAfterSeconds,
    ]
  );
  const effectiveOnline = connectivitySnapshot.effectiveOnline;
  const connectivityStatus = connectivitySnapshot.status;
  const connectivitySummary = React.useMemo(
    () =>
      formatConnectivitySummary({
        status: connectivityStatus,
        reasons: connectivitySnapshot.reasons,
        outboxCount,
        lastSyncSuccessAt,
      }),
    [connectivitySnapshot.reasons, connectivityStatus, lastSyncSuccessAt, outboxCount]
  );
  const shouldShowConnectivityBanner =
    connectivityStatus === "offline" ||
    (connectivityStatus === "degraded" && mobileSyncPolicy.showDegradedBanner);
  const displayPolicy = React.useMemo(
    () => normalizeMobileDisplayPolicy(asRecord(devicePolicyQuery.data).value ?? null),
    [devicePolicyQuery.data]
  );
  const selectedLocaleMode = React.useMemo<MobileLocaleMode>(
    () => resolveEffectiveLocale({ storedValue: localeModeQuery.data, policy: displayPolicy }),
    [displayPolicy, localeModeQuery.data]
  );
  const selectedDirectionMode = React.useMemo<MobileDirectionMode>(
    () =>
      resolveEffectiveDirection({
        storedValue: directionModeQuery.data,
        locale: selectedLocaleMode,
        policy: displayPolicy,
      }),
    [directionModeQuery.data, displayPolicy, selectedLocaleMode]
  );
  React.useEffect(() => {
    if (Platform.OS !== "web") return;
    const doc = globalThis.document;
    if (!doc?.documentElement) return;

    try {
      doc.documentElement.dir = selectedDirectionMode === "rtl" ? "rtl" : "ltr";
      doc.documentElement.lang = String(selectedLocaleMode || "");
    } catch (error) {
      logDebugFailure("failed to update document direction/locale", error);
    }
  }, [selectedDirectionMode, selectedLocaleMode]);
  const selectedThemeMode = React.useMemo<MobileThemeMode>(
    () => resolveEffectiveTheme({ storedValue: themeModeQuery.data, policy: displayPolicy }),
    [displayPolicy, themeModeQuery.data]
  );
  const appliedTheme = resolveAppliedFieldOpsTheme(selectedThemeMode, systemColorScheme);
  const themeTokens = React.useMemo(
    () => getFieldOpsThemeTokens(appliedTheme, Platform.OS === "web" ? "web" : "native"),
    [appliedTheme]
  );
  const styles = React.useMemo(() => createFieldOpsStyles(themeTokens), [themeTokens]);
  const setThemeMode = React.useCallback(async (next: MobileThemeMode) => {
    await cacheStore.set(KV_KEYS.themeMode, next);
    void queryClient.invalidateQueries({ queryKey: ["kv", "get", KV_KEYS.themeMode] });
  }, [cacheStore, queryClient]);
  const themeContextValue = React.useMemo<ThemeContextValue>(() => ({
    appliedTheme,
    tokens: getTokensForTheme(appliedTheme, Platform.OS === "web" ? "web" : "native"),
    mode: selectedThemeMode,
    setMode: setThemeMode,
  }), [appliedTheme, selectedThemeMode, setThemeMode]);
  const strings = React.useMemo(() => getFieldOpsStrings(selectedLocaleMode), [selectedLocaleMode]);
  const connectivityStatusLabel = formatConnectivityStatusLabel(connectivityStatus, strings);
  React.useEffect(() => {
    const setColorScheme = (Appearance as unknown as { setColorScheme?: (mode: "light" | "dark" | null) => void })
      .setColorScheme;
    if (typeof setColorScheme !== "function") return;
    try {
      setColorScheme(toAppearanceColorScheme(selectedThemeMode));
    } catch (error) {
      logDebugFailure("failed to apply color scheme", error);
    }
  }, [selectedThemeMode]);
  const mobilePushPolicy = React.useMemo(
    () => normalizeMobilePushPolicy(asRecord(mobilePushPolicyQuery.data).value ?? null),
    [mobilePushPolicyQuery.data]
  );
  const visibilityPolicy = React.useMemo(
    () => normalizeMobileVisibilityPolicy(asRecord(visibilityPolicyQuery.data).value ?? null),
    [visibilityPolicyQuery.data]
  );
  const mapPolicy = React.useMemo(
    () => normalizeMobileMapPolicy(asRecord(mapPolicyQuery.data).value ?? null),
    [mapPolicyQuery.data]
  );
  const devicePolicy = React.useMemo(
    () => normalizeMobileDevicePolicy(asRecord(devicePolicyQuery.data).value ?? null),
    [devicePolicyQuery.data]
  );
  const navigationPolicy = React.useMemo(
    () => normalizeMobileNavigationPolicy(asRecord(navigationPolicyQuery.data).value ?? null),
    [navigationPolicyQuery.data]
  );
  const driverSafetyPolicy = React.useMemo(
    () => normalizeMobileDriverSafetyPolicy(asRecord(driverSafetyPolicyQuery.data).value ?? null),
    [driverSafetyPolicyQuery.data]
  );
  const uxSafetyPolicy = React.useMemo(
    () => normalizeMobileUxSafetyPolicy(asRecord(uxSafetyPolicyQuery.data).value ?? null),
    [uxSafetyPolicyQuery.data]
  );
  const communicationPolicy = React.useMemo(
    () => normalizeMobileCommunicationPolicy(asRecord(communicationPolicyQuery.data).value ?? null),
    [communicationPolicyQuery.data]
  );
  const addressPolicy = React.useMemo(
    () => normalizeMobileAddressPolicy(asRecord(addressPolicyQuery.data).value ?? null),
    [addressPolicyQuery.data]
  );

  const selectedVisibilityMode = React.useMemo(() => {
    const candidate = visibilityModeQuery.data;
    const allowedCandidate =
      typeof candidate === "string"
        ? visibilityPolicy.allowedVisibility.find((value) => value === candidate)
        : undefined;
    if (allowedCandidate) return allowedCandidate;
    return visibilityPolicy.defaultVisibility;
  }, [visibilityModeQuery.data, visibilityPolicy.allowedVisibility, visibilityPolicy.defaultVisibility]);

  const selectedRouteView = React.useMemo<"list" | "orders_map">(() => {
    const candidate = routeViewQuery.data;
    if (
      (candidate === "list" || candidate === "orders_map") &&
      mapPolicy.routeViews.includes(candidate)
    ) {
      return candidate;
    }
    return mapPolicy.defaultRouteView;
  }, [mapPolicy.defaultRouteView, mapPolicy.routeViews, routeViewQuery.data]);
  const runtimeMobilePlatform = React.useMemo<MobilePlatform>(
    () => resolveRuntimeMobilePlatform(Platform.OS),
    []
  );
  const allowedMobilePlatforms = React.useMemo(
    () => resolveAllowedMobilePlatforms(devicePolicy),
    [devicePolicy]
  );
  const selectedPlatformOverride = React.useMemo(
    () =>
      resolveNormalizedPlatformOverride({
        storedOverride: platformOverrideQuery.data,
        allowedPlatforms: allowedMobilePlatforms,
      }),
    [allowedMobilePlatforms, platformOverrideQuery.data]
  );
  const effectiveMobilePlatform = React.useMemo<MobilePlatform>(
    () =>
      resolveEffectiveMobilePlatform({
        policy: devicePolicy,
        runtimePlatform: runtimeMobilePlatform,
        storedOverride: diagnosticsEnabled ? selectedPlatformOverride : null,
      }),
    [devicePolicy, diagnosticsEnabled, runtimeMobilePlatform, selectedPlatformOverride]
  );
  const effectiveSpeedKph = React.useMemo(() => {
    if (diagnosticsEnabled && simulatedSpeedQuery.data != null) {
      return simulatedSpeedQuery.data;
    }
    return observedSpeedKph;
  }, [diagnosticsEnabled, observedSpeedKph, simulatedSpeedQuery.data]);
  const drivingSafetyState = React.useMemo(
    () =>
      computeDrivingSafetyState({
        policy: driverSafetyPolicy,
        speedKph: effectiveSpeedKph,
      }),
    [driverSafetyPolicy, effectiveSpeedKph]
  );
  const drivingModeLocked = drivingSafetyState.locked;
  const navBlockedWhileDriving =
    drivingModeLocked && !canNavigateWhileMoving(drivingSafetyState, activeNavKey);
  const navigationItems = React.useMemo(
    () => navigation.sections.flatMap((section) => flattenNavItems(section.items)),
    [navigation.sections]
  );
  const moduleLabels = React.useMemo(
    () => resolveModuleLabelsFromSections(navigation.sections),
    [navigation.sections]
  );
  const accessScopeSummary = React.useMemo(
    () =>
      resolveAccessScopeSummary({
        scopeType: me?.access_scope?.scope_type,
        scopeId: me?.access_scope?.scope_id,
      }),
    [me?.access_scope?.scope_id, me?.access_scope?.scope_type]
  );
  const resourceDisplayMode = React.useMemo<"list" | "orders_map">(() => {
    if (resource !== "tasks") return "list";
    if (!isRouteSurface) return "list";
    return selectedRouteView;
  }, [isRouteSurface, resource, selectedRouteView]);

  React.useEffect(() => {
    if (!navBlockedWhileDriving) return;
    const fallback = navigationItems.find((item) => {
      if (item.disabled_reason) return false;
      return canNavigateWhileMoving(drivingSafetyState, resolveNavigationKey(item));
    });
    if (!fallback || fallback.id === selectedId) return;
    setSelectedId(fallback.id);
    setSelectedResourceId(null);
    setSelectedResourceKey(null);
    setSelectedResourceTitle(null);
    Alert.alert(strings.alerts.drivingLockedTitle, "Navigation is limited while moving.");
  }, [drivingSafetyState, navBlockedWhileDriving, navigationItems, selectedId, strings.alerts.drivingLockedTitle]);

  React.useEffect(() => {
    if (!drivingModeLocked || !selectedResourceId) return;
    setSelectedResourceId(null);
    setSelectedResourceKey(null);
    setSelectedResourceTitle(null);
  }, [drivingModeLocked, selectedResourceId]);
  React.useEffect(() => {
    const storedOverride = platformOverrideQuery.data;
    if (storedOverride == null) return;
    if (selectedPlatformOverride) return;
    cacheStore
      .remove(KV_KEYS.platformOverride)
      .then(() => {
        queryClient.invalidateQueries({ queryKey: ["kv", "get", KV_KEYS.platformOverride] });
      })
      .catch((error) => {
        logDebugFailure("failed to clear stale platform override", error);
      });
  }, [cacheStore, platformOverrideQuery.data, queryClient, selectedPlatformOverride]);

  const mobileAttestationPolicy = React.useMemo(
    () => normalizeMobileAttestationPolicy(asRecord(mobileAttestationPolicyQuery.data).value ?? null),
    [mobileAttestationPolicyQuery.data]
  );
  const iosAttestationKeyIdRef = React.useRef<string | null>(null);
  const androidAttestationPreparedForRef = React.useRef<string | null>(null);

  const getOrCreateIosAttestationKeyId = React.useCallback(async () => {
    const cached = iosAttestationKeyIdRef.current;
    if (cached) return cached;

    const stored = await storage.getItem(STORAGE_KEYS.attestationKeyId);
    if (stored && stored.trim()) {
      iosAttestationKeyIdRef.current = stored.trim();
      return stored.trim();
    }

    const next = await generateIosAttestationKeyAsync();
    await storage.setItem(STORAGE_KEYS.attestationKeyId, next);
    iosAttestationKeyIdRef.current = next;
    return next;
  }, [storage]);

  const buildAttestationEnvelope = React.useCallback(
    async (input: {
      rpcName: string;
      deviceId?: string | null;
      resourceId?: string | null;
      source?: string | null;
    }): Promise<MobileAttestationEnvelope | null> => {
      const rpcName = input.rpcName.trim().toLowerCase();
      if (!rpcName) return null;
      if (!shouldEnforceAttestationForRpc(mobileAttestationPolicy, rpcName)) return null;
      if (
        input.source === "mobile_background" &&
        mobileAttestationPolicy.allowBackgroundWithoutAttestation
      ) {
        return null;
      }

      if (!effectiveOnline) {
        if (mobileAttestationPolicy.mode === "enforce") {
          throw new Error("Attestation requires an online connection.");
        }
        return null;
      }
      if (Platform.OS === "web" || !Device.isDevice) {
        if (mobileAttestationPolicy.mode === "enforce") {
          throw new Error("Attestation requires a native device build.");
        }
        return null;
      }
      if (!isExpoAppIntegrityAvailable()) {
        if (mobileAttestationPolicy.mode === "enforce") {
          throw new Error(
            "Attestation requires a development build with Expo App Integrity enabled."
          );
        }
        return null;
      }

      try {
        const fallbackResourceId = readContextId(policyContext, "resource_id");
        const challengeInput = {
          rpc_name: rpcName,
          device_id: input.deviceId ?? null,
          resource_id: input.resourceId ?? fallbackResourceId ?? null,
          metadata: {
            app: "fieldops",
            platform: Platform.OS,
            source: input.source ?? "mobile",
          },
        };

        const { data, error } = await client.rpc("issue_mobile_attestation_challenge_v1", {
          p_input: challengeInput,
        });
        if (error) throw error;
        const row = Array.isArray(data) ? data[0] : data;
        const challengeId =
          row && row.challenge_id != null ? String(row.challenge_id).trim() : "";
        const challenge = row && typeof row.challenge === "string" ? row.challenge.trim() : "";
        if (!challengeId || !challenge) {
          throw new Error("Attestation challenge was not returned by the server.");
        }

        const generatedAt = new Date().toISOString();
        if (Platform.OS === "android") {
          const cloudProjectNumber = String(
            mobileAttestationPolicy.androidCloudProjectNumber ?? ""
          ).trim();
          if (!/^\d+$/.test(cloudProjectNumber) || /^0+$/.test(cloudProjectNumber)) {
            if (mobileAttestationPolicy.mode === "enforce") {
              throw new Error("Attestation policy requires android_cloud_project_number.");
            }
            return null;
          }
          if (androidAttestationPreparedForRef.current !== cloudProjectNumber) {
            await prepareAndroidIntegrityTokenProviderAsync(cloudProjectNumber);
            androidAttestationPreparedForRef.current = cloudProjectNumber;
          }
          const integrityToken = await requestAndroidIntegrityCheckAsync(challenge);
          return {
            provider: "android_play_integrity",
            challenge_id: challengeId,
            challenge,
            generated_at: generatedAt,
            integrity_token: integrityToken,
          };
        }

        if (Platform.OS === "ios") {
          if (!isIosAppIntegritySupported()) {
            if (mobileAttestationPolicy.mode === "enforce") {
              throw new Error("App Attest is not supported on this iOS device.");
            }
            return null;
          }
          const keyId = await getOrCreateIosAttestationKeyId();
          let assertion = "";
          let attestation: string | undefined;
          try {
            assertion = await generateIosAssertionAsync(keyId, challenge);
          } catch {
            attestation = await attestIosKeyAsync(keyId, challenge);
            assertion = await generateIosAssertionAsync(keyId, challenge);
          }
          return {
            provider: "ios_app_attest",
            challenge_id: challengeId,
            challenge,
            generated_at: generatedAt,
            key_id: keyId,
            assertion,
            ...(attestation ? { attestation } : {}),
          };
        }

        if (mobileAttestationPolicy.mode === "enforce") {
          throw new Error("Attestation policy is enabled for an unsupported platform.");
        }
        return null;
      } catch (error) {
        if (mobileAttestationPolicy.mode === "enforce") {
          throw error;
        }
        return null;
      }
    },
    [client, getOrCreateIosAttestationKeyId, mobileAttestationPolicy, effectiveOnline, policyContext]
  );

  const [expoPushToken, setExpoPushToken] = React.useState<string | null>(null);
  const pushTokenFetchAttemptedRef = React.useRef(false);

  React.useEffect(() => {
    let cancelled = false;

    if (!sessionUserId) {
      pushTokenFetchAttemptedRef.current = false;
      setExpoPushToken(null);
      return;
    }
    if (!effectiveOnline) {
      pushTokenFetchAttemptedRef.current = false;
      return;
    }
    if (!mobilePushPolicy.enabled) {
      pushTokenFetchAttemptedRef.current = false;
      setExpoPushToken(null);
      return;
    }
    if (!mobilePushPolicy.registerOnStartup) return;
    if (mobilePushPolicy.provider !== "expo") return;
    if (Platform.OS === "web" || !Device.isDevice) return;
    if (pushTokenFetchAttemptedRef.current) return;

    pushTokenFetchAttemptedRef.current = true;

    const fetchExpoPushToken = async () => {
      const Notifications = await import("expo-notifications");
      if (Platform.OS === "android") {
        await Notifications.setNotificationChannelAsync(mobilePushPolicy.defaultChannelId, {
          name: mobilePushPolicy.defaultChannelName,
          importance: Notifications.AndroidImportance.DEFAULT,
        });
      }

      let permissions = await Notifications.getPermissionsAsync();
      const hadPermission = permissions.granted === true || permissions.status === "granted";
      if (!hadPermission && mobilePushPolicy.requestPermission) {
        permissions = await Notifications.requestPermissionsAsync();
      }

      const granted = permissions.granted === true || permissions.status === "granted";
      if (!granted) {
        if (!cancelled) setExpoPushToken(null);
        return;
      }

      const projectId = resolveExpoProjectIdFromConstants(Constants);
      if (!projectId) return;

      const tokenResult = await Notifications.getExpoPushTokenAsync({ projectId });
      const token = getExpoPushTokenData(tokenResult);
      if (!cancelled) setExpoPushToken(token);
    };

    fetchExpoPushToken().catch((error) => {
      if (cancelled) return;
      pushTokenFetchAttemptedRef.current = false;
      logDebugFailure("failed to fetch expo push token", error);
    });

    return () => {
      cancelled = true;
    };
  }, [
    sessionUserId,
    mobilePushPolicy.defaultChannelId,
    mobilePushPolicy.defaultChannelName,
    mobilePushPolicy.enabled,
    mobilePushPolicy.provider,
    mobilePushPolicy.registerOnStartup,
    mobilePushPolicy.requestPermission,
    effectiveOnline,
  ]);

  const deviceIdQuery = useQuery({
    queryKey: ["device", "id"],
    queryFn: () => getStoredDeviceId(storage),
    staleTime: Infinity,
  });

  const registerDeviceMutation = useMutation({
    mutationFn: async (input?: { pushToken?: string | null; reason?: string }) => {
      const existingId = await getStoredDeviceId(storage);
      const installId = await getOrCreateDeviceInstallId(storage);
      const digest = await Crypto.digestStringAsync(
        Crypto.CryptoDigestAlgorithm.SHA256,
        installId
      );

      const deviceLabel = coerceHref(asRecord(Constants).deviceName);
      const resourceId = readContextId(policyContext, "resource_id");
      const attestation = await buildAttestationEnvelope({
        rpcName: "register_user_device_v1",
        deviceId: existingId,
        resourceId,
        source: "mobile",
      });
      const payload = {
        device_platform: Platform.OS,
        device_identifier_sha256: digest,
        device_label: deviceLabel,
        push_token: normalizePushToken(input?.pushToken),
        app_version: Constants.expoConfig?.version ?? null,
        os_version: String(Platform.Version),
        metadata: {
          app: "fieldops",
          platform: Platform.OS,
          expo_sdk: Constants.expoConfig?.sdkVersion ?? null,
          expo_runtime: asRecord(Constants.expoConfig).runtimeVersion ?? null,
          ...(attestation ? { attestation } : {}),
        },
      };

      const { data, error } = await client.rpc("register_user_device_v1", { p_device: payload });
      if (error) throw error;

      const row = Array.isArray(data) ? data[0] : data;
      const deviceId = row?.device_id ? String(row.device_id) : null;
      const created = row?.created === true;
      const pushToken = normalizePushToken(input?.pushToken);
      if (deviceId) {
        if (existingId !== deviceId) {
          await setStoredDeviceId(storage, deviceId);
          queryClient.invalidateQueries({ queryKey: ["device", "id"] });
        }

        const events: Array<Record<string, unknown>> = [];
        if (created || !existingId) {
          events.push({
            event_type: "mobile_device_registered",
            captured_at: new Date().toISOString(),
            metadata: {
              app: "fieldops",
              platform: Platform.OS,
              device_id: deviceId,
            },
          });
        }

        if (pushToken && mobilePushPolicy.emitLogEvents) {
          events.push({
            event_type: "mobile_push_token_synced",
            captured_at: new Date().toISOString(),
            metadata: {
              app: "fieldops",
              platform: Platform.OS,
              device_id: deviceId,
              provider: mobilePushPolicy.provider,
              reason: input?.reason ?? "startup",
            },
          });
        }

        if (events.length > 0 && outboxInitSuccess) {
          await outbox.enqueue({
            rpc: "ui_log_events_v1",
            args: {
              p_events: events,
              p_app: "mobile",
            },
          });
          queryClient.invalidateQueries({ queryKey: ["outbox", "count"] });
          queryClient.invalidateQueries({ queryKey: ["outbox", "entries"] });
        }

        if (mobileSyncPolicy.enabled && effectiveOnline && !syncMutation.isPending) {
          syncMutation.mutate();
        }
      }
      return deviceId;
    },
  });

  const deviceId = deviceIdQuery.data ?? null;
  const activeRoleQuery = useQuery({
    queryKey: ["fieldops", "active-role", deviceId, me?.user?.id ?? null],
    queryFn: async () => {
      const { data, error } = await client.rpc("ui_get_fieldops_active_role_v1", {
        p_device_id: deviceId,
      });
      if (error) throw error;
      return extractFieldOpsActiveRoleSnapshot(Array.isArray(data) ? data[0] ?? null : data);
    },
    enabled: Boolean(deviceId && me?.user?.id),
    staleTime: 30_000,
  });
  const setActiveRoleMutation = useMutation({
    mutationFn: async (roleId: string) => {
      const { data, error } = await client.rpc("ui_set_fieldops_active_role_v1", {
        p_device_id: deviceId,
        p_role_id: roleId,
      });
      if (error) throw error;
      return extractFieldOpsActiveRoleSnapshot(Array.isArray(data) ? data[0] ?? null : data);
    },
    onSuccess: (snapshot) => {
      queryClient.setQueryData(
        ["fieldops", "active-role", deviceId, me?.user?.id ?? null],
        snapshot
      );
      setNavOpen(false);
    },
    onError: (error) => {
      showMobileNotice("Work mode unavailable", formatUnknownError(error));
    },
  });
  const syncedPushTokenRef = React.useRef<string | null>(null);
  React.useEffect(() => {
    syncedPushTokenRef.current = null;
  }, [sessionUserId]);

  React.useEffect(() => {
    if (!outboxInitSuccess) return;
    if (!effectiveOnline) return;
    if (!deviceId) return;
    if (!expoPushToken) return;
    if (registerDeviceMutation.isPending) return;
    if (syncedPushTokenRef.current === expoPushToken) return;

    registerDeviceMutation
      .mutateAsync({ pushToken: expoPushToken, reason: "push_token_sync" })
      .then((nextDeviceId) => {
        if (!nextDeviceId) return;
        syncedPushTokenRef.current = expoPushToken;
      })
      .catch((error) => {
        logDebugFailure("failed to sync push token", error);
      });
  }, [
    deviceId,
    expoPushToken,
    effectiveOnline,
    outboxInitSuccess,
    registerDeviceMutation,
  ]);

  const deviceRegistrationAttemptedRef = React.useRef(false);
  React.useEffect(() => {
    if (!outboxInitSuccess) return;
    if (!effectiveOnline) {
      deviceRegistrationAttemptedRef.current = false;
      return;
    }
    if (deviceIdQuery.isLoading) return;
    if (deviceId) return;
    if (registerDeviceMutation.isPending) return;
    if (deviceRegistrationAttemptedRef.current) return;
    deviceRegistrationAttemptedRef.current = true;
    registerDeviceMutation.mutate({ pushToken: expoPushToken, reason: "startup" });
  }, [
    deviceId,
    deviceIdQuery.isLoading,
    expoPushToken,
    effectiveOnline,
    outboxInitSuccess,
    registerDeviceMutation,
  ]);

  const prevOnlineRef = React.useRef(effectiveOnline);
  React.useEffect(() => {
    const wasOnline = prevOnlineRef.current;
    prevOnlineRef.current = effectiveOnline;

    if (!effectiveOnline) return;
    if (wasOnline) return;
    if (!outboxInitSuccess) return;
    if (!mobileSyncPolicy.enabled || !mobileSyncPolicy.autoSyncOnReconnect) return;
    if (syncMutation.isPending) return;
    if (outboxCount <= 0) return;

    syncMutation.mutate();
  }, [
    effectiveOnline,
    mobileSyncPolicy.autoSyncOnReconnect,
    mobileSyncPolicy.enabled,
    outboxCount,
    outboxInitSuccess,
    syncMutation,
  ]);

  const commandRegistryQuery = useQuery({
    queryKey: ["ui", "command-registry"],
    queryFn: () => uiClient.commandRegistry(),
    enabled: Boolean(me?.user?.id),
  });

  const detailResource = React.useMemo(() => {
    if (!resource || !selectedResourceId) return null;
    if (selectedResourceKey && selectedResourceKey !== resource) return null;
    return resource;
  }, [resource, selectedResourceId, selectedResourceKey]);

  const detailCacheKey = React.useMemo(() => {
    if (!detailResource || !selectedResourceId) return null;
    return createCacheKey({
      v: 1,
      type: "ui_get_resource_v1",
      resource: detailResource,
      id: selectedResourceId,
    });
  }, [detailResource, selectedResourceId]);

  const detailQuery = useQuery({
    queryKey: ["ui", "detail", detailResource, selectedResourceId],
    queryFn: async () => {
      const cachedKey = detailCacheKey;
      try {
        const detail = await uiClient.getResource(detailResource || "", selectedResourceId || "");
        if (cacheInitSuccess && cachedKey) {
          await cacheStore.set(cachedKey, { detail, cached_at: new Date().toISOString() });
        }
        return { detail, source: "network" as const };
      } catch (error) {
        const retriable = isRetriableNetworkError(error) || isRetriableSupabaseError(error);
        if (!retriable || !cacheInitSuccess || !cachedKey) throw error;
        const cached = await cacheStore.get(cachedKey);
        if (
          cached &&
          typeof cached === "object" &&
          "detail" in cached &&
          cached.detail &&
          typeof cached.detail === "object"
        ) {
          return { detail: cached.detail as Record<string, unknown>, source: "cache" as const };
        }
        throw error;
      }
    },
    enabled: Boolean(detailResource && selectedResourceId),
  });
  const detailPolicyContext = React.useMemo(
    () => buildDetailPolicyContext(policyContext, asRecord(detailQuery.data?.detail)),
    [detailQuery.data?.detail, policyContext]
  );
  const detailCommunicationPolicyQuery = useQuery({
    queryKey: [
      "policy",
      "communication_policy",
      "detail",
      stableStringify(detailPolicyContext),
      detailResource,
      selectedResourceId,
    ],
    queryFn: () => resolvePolicyRow(client, "resolve_communication_policy", detailPolicyContext),
    enabled: Boolean(
      me?.user?.id &&
        detailQuery.data?.detail &&
        selectedResourceId &&
        detailResource &&
        (isRouteSurface || isTasksSurface)
    ),
    staleTime: 5 * 60_000,
  });
  const selectedStopSnapshot = React.useMemo(
    () =>
      detailQuery.data?.detail
        ? extractOperationalStopSnapshot(detailQuery.data.detail)
        : null,
    [detailQuery.data?.detail]
  );
  const selectedRouteContext = React.useMemo(
    () =>
      detailQuery.data?.detail
        ? extractScanContext(detailQuery.data.detail, selectedResourceId)
        : null,
    [detailQuery.data?.detail, selectedResourceId]
  );
  const selectedRouteRunId = selectedRouteContext?.routeRunId ?? null;
  const detailCommunicationPolicy = React.useMemo(
    () =>
      normalizeMobileCommunicationPolicy(
        asRecord(detailCommunicationPolicyQuery.data).value ??
          asRecord(communicationPolicyQuery.data).value ??
          null
      ),
    [communicationPolicyQuery.data, detailCommunicationPolicyQuery.data]
  );
  const displayedRouteScope = stableStringify({ actor: me?.user?.id, scope: me?.access_scope, resource });
  // Priority and switching cover only the loaded page, never unseen routes.
  const displayedRoute = React.useMemo(() => selectDisplayedRouteTasks(
    isRouteSurface ? listQuery.data?.list.items ?? [] : [],
    selectedResourceKey === resource ? selectedResourceId : null,
    (selectedResourceKey === resource ? selectedRouteRunId : null) ??
      (displayedRoutePreference?.scope === displayedRouteScope ? displayedRoutePreference.routeRunId : null)
  ), [isRouteSurface, listQuery.data?.list.items, selectedResourceKey, resource, selectedResourceId,
    selectedRouteRunId, displayedRoutePreference, displayedRouteScope]);
  const displayedRouteList = React.useMemo(() => listQuery.data?.list
    ? { ...listQuery.data.list, items: displayedRoute.items, total: null, total_strategy: null, total_is_estimate: null }
    : null, [listQuery.data?.list, displayedRoute.items]);
  // Read-only display identity; selected task context remains the sole mutation input.
  const manifestRouteRunId = isRouteSurface && !selectedResourceId ? displayedRoute.routeRunId : selectedRouteRunId;
  const routeExecutionManifestQuery = useQuery({
    queryKey: ["route", "execution-manifest", manifestRouteRunId, displayedRouteScope],
    queryFn: async () => {
      const { data, error } = await client.rpc("ui_route_run_execution_manifest_v1", {
        p_route_run_id: manifestRouteRunId,
      });
      if (error) throw error;
      return Array.isArray(data) ? data[0] ?? null : data;
    },
    enabled: Boolean(me?.user?.id && manifestRouteRunId && (isRouteSurface || isTasksSurface)),
    staleTime: 30_000,
  });
  const confirmRouteDepartureMutation = useMutation({
    mutationFn: async (input: {
      routeRunId: string;
      routeStopId?: string | null;
      taskId?: string | null;
      opsSessionId?: string | null;
    }) => {
      if (!outboxInitSuccess || !completionReadbackScopeMatches(completionReadbackScopeVersion(), sessionUserId, completionReadbackScope))
        throw new Error(strings.route.departureUnavailable);
      return enqueueRouteDeparture(outbox, { actor: sessionUserId, scope: completionReadbackScope },
        input, strings.route.departureRequest);
    },
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["outbox", "count"] }),
        queryClient.invalidateQueries({ queryKey: ["outbox", "entries"] }),
        queryClient.invalidateQueries({ queryKey: ["route", "departure-request"] }),
      ]);
      if (mobileSyncPolicy.enabled && effectiveOnline && !syncMutation.isPending) syncMutation.mutate();
    },
  });
  const selectedTaskDetail = React.useMemo(
    () => asRecord(detailQuery.data?.detail),
    [detailQuery.data?.detail]
  );
  const selectedTaskStatusReason = React.useMemo(
    () => normalizeTaskStateToken(selectedTaskDetail.status_reason),
    [selectedTaskDetail]
  );
  const selectedTaskSupportsRouteProgress = React.useMemo(
    () => isRouteStopExecutionTask(selectedTaskDetail),
    [selectedTaskDetail]
  );


  const selectedTaskActionable = React.useMemo(
    () => isCanonicalTaskActionable(selectedTaskDetail), [selectedTaskDetail]
  );

  const availableActions = React.useMemo<UiCommandDefinition[]>(() => {
    if (!resource) return [];
    const registry = commandRegistryQuery.data;
    const commands = registry?.commands ?? [];

    return commands.filter((command) => {
      if (hasMobileCommandDisabledState(command) || !command.key?.trim()) return false;
      const category = command.schema_category ?? null;
      if (category && category !== `resource:${resource}`) return false;
      const capability = command.capability ?? null;
      if (capability && !capabilitiesSet.has(capability)) return false;
      const transport = command.execution?.transport ?? "rpc";
      if (transport === "rpc" ? !command.execution?.rpc : transport === "edge" ? !command.execution?.function : true) return false;

      const mode = command.selection?.mode ?? null;
      if (mode !== "none" && typeof command.selection?.min_count === "number" && command.selection.min_count > 1) return false;
      if (selectedResourceId && mode && mode !== "single" && mode !== "any" && mode !== "none") {
        return false;
      }

      if (
        resource === "tasks" &&
        selectedResourceId &&
        (command.key === "tasks.complete" ||
          command.key === "tasks.exception" ||
          command.key === "tasks.report_incident" ||
          ROUTE_CLOSEOUT_COMMAND_KEYS.has(command.key) ||
          ROUTE_PROGRESS_COMMAND_KEYS.has(command.key))
      ) {
        if (command.key === "tasks.report_incident") {
          return selectedTaskDetail.id === selectedResourceId &&
            selectedTaskActionable && selectedTaskSupportsRouteProgress;
        }
        if (ROUTE_CLOSEOUT_COMMAND_KEYS.has(command.key)) {
          return selectedTaskSupportsRouteProgress;
        }
        if (!selectedTaskActionable) return false;
        if (!ROUTE_PROGRESS_COMMAND_KEYS.has(command.key)) return true;
        if (!selectedTaskSupportsRouteProgress) return false;
        if (command.key === "tasks.en_route") {
          return selectedTaskStatusReason !== "en_route" && selectedTaskStatusReason !== "arrived";
        }
        if (command.key === "tasks.arrived") {
          return selectedTaskStatusReason !== "arrived";
        }
        return false;
      }

      const type = command.execution?.type ?? null;
      return transport === "edge" || type === "rpc" || type === "workflow";
    });
  }, [
    capabilitiesSet,
    commandRegistryQuery.data,
    resource,
    selectedResourceId,
    selectedTaskDetail,
    selectedTaskActionable,
    selectedTaskStatusReason,
    selectedTaskSupportsRouteProgress,
  ]);

  const actionInFlightRef = React.useRef(new Set<string>());
  const [actionInFlightKeys, setActionInFlightKeys] = React.useState<Set<string>>(
    () => new Set()
  );
  const isActionLocked = React.useCallback(
    (actionKey: string) => actionInFlightKeys.has(actionKey),
    [actionInFlightKeys]
  );
  const withActionLock = React.useCallback(
    async (actionKey: string, action: () => Promise<void>) => {
      if (actionInFlightRef.current.has(actionKey)) return;
      actionInFlightRef.current.add(actionKey);
      setActionInFlightKeys((prev) => {
        if (prev.has(actionKey)) return prev;
        const next = new Set(prev);
        next.add(actionKey);
        return next;
      });

      try {
        await action();
      } finally {
        actionInFlightRef.current.delete(actionKey);
        setActionInFlightKeys((prev) => {
          if (!prev.has(actionKey)) return prev;
          const next = new Set(prev);
          next.delete(actionKey);
          return next;
        });
      }
    },
    []
  );
  const resolveActionLockKey = React.useCallback(
    (command: UiCommandDefinition) =>
      `command:${resource ?? "resource"}:${selectedResourceId ?? "none"}:${command.key}`,
    [resource, selectedResourceId]
  );

  const [composerCommand, setComposerCommand] = React.useState<UiCommandDefinition | null>(null);
  const [composerFinancialContext, setComposerFinancialContext] = React.useState<FinancialTaskContext | null>(null);
  const [composerFinancialSession, setComposerFinancialSession] = React.useState("");
  const financialAdmission = React.useRef(0);
  const [composerFinancialAdmission, setComposerFinancialAdmission] = React.useState(0);
  const composerIsFinancial = composerCommand?.execution?.input_schema?.normalization === "financial_amount_v1";
  const [composerValues, setComposerValues] = React.useState<Record<string, string>>({});
  const [composerError, setComposerError] = React.useState<string | null>(null);
  const [composerSubmitting, setComposerSubmitting] = React.useState(false);
  const [lastActionReceipt, setLastActionReceipt] = React.useState<ActionSubmissionReceipt | null>(
    null
  );
  const composerFields = React.useMemo(
    () => (composerCommand ? resolveCommandInputFields(composerCommand, selectedStopSnapshot) : []),
    [composerCommand, selectedStopSnapshot]
  );
  const composerCopy = React.useMemo(
    () =>
      composerIsFinancial ? { label: composerCommand?.label ?? "", title: composerCommand?.execution?.input_schema?.title ?? "",
        description: composerCommand?.execution?.input_schema?.description ?? "" }
        : composerCommand ? resolveComposerCommandCopy(composerCommand, selectedStopSnapshot) : null,
    [composerCommand, selectedStopSnapshot, composerIsFinancial]
  );
  const composerLookupCategories = React.useMemo(
    () =>
      Array.from(
        new Set(
          composerFields
            .map((field) => field.lookupCategory)
            .filter((value): value is string => Boolean(value))
        )
      ),
    [composerFields]
  );

  const composerLookupQuery = useQuery({
    queryKey: [
      "command",
      "composer",
      "lookups",
      composerCommand?.key ?? "none",
      sessionUserId,
      [...composerLookupCategories].sort().join("|"),
      resource,
      selectedResourceId,
      composerFields.map((field) => [field.lookupRpc, field.lookupSelectionParam]),
    ],
    enabled: Boolean(composerCommand && composerLookupCategories.length > 0),
    queryFn: async () => {
      const out: Record<string, LookupOption[]> = {};
      for (const category of composerLookupCategories) {
        const field = composerFields.find((entry) => entry.lookupCategory === category);
        const lookupRpc = field?.lookupRpc;
        if (lookupRpc && (!field.lookupSelectionParam || !selectedResourceId)) {
          throw new Error("Lookup requires a selected resource.");
        }
        const { data, error } = await client.rpc(
          lookupRpc || "list_lookup_values_v1",
          lookupRpc ? { [field!.lookupSelectionParam!]: selectedResourceId } : { p_category: category }
        );
        if (error) throw error;
        const rows = Array.isArray(data) ? data : [];
        out[category] = rows.map((row) => {
          const record = asRecord(row);
          return {
            value: String(record.value ?? "").trim(),
            label: String(record.label ?? record.value ?? "").trim(),
            description: coerceValueText(record.description),
            metadata: asRecord(record.metadata),
          };
        });
      }
      return out;
    },
    staleTime: 60_000,
  });
  const composerLookupMap = composerLookupQuery.data ?? {};
  const [composerArtifacts, setComposerArtifacts] = React.useState<ComposerArtifactEntry[]>([]);
  const [composerCameraOpen, setComposerCameraOpen] = React.useState(false);
  const [isCapturingComposerArtifact, setIsCapturingComposerArtifact] = React.useState(false);
  const [isCapturingComposerSignature, setIsCapturingComposerSignature] = React.useState(false);
  const [composerSignatureStrokes, setComposerSignatureStrokes] = React.useState<SignatureStroke[]>(
    []
  );
  const [composerSignatureLayout, setComposerSignatureLayout] = React.useState({
    width: 320,
    height: 160,
  });
  const [composerCameraPermission, requestComposerCameraPermission] = useCameraPermissions();
  const composerCameraRef = React.useRef<CameraView | null>(null);
  const composerSignatureStrokeRef = React.useRef<SignatureStroke | null>(null);
  const composerSupportsPod = React.useMemo(
    () =>
      !composerIsFinancial && (composerCommand?.key === "tasks.complete" || composerCommand?.key === "tasks.exception"),
    [composerCommand?.key, composerIsFinancial]
  );
  const composerSelfEvidence = React.useMemo(() => resolveComposerEvidence(composerCommand), [composerCommand]);
  const composerIsSelfKyc = composerCommand?.execution?.input_schema?.normalization === "self_kyc_v1";
  const composerFinancialEvidence = composerIsFinancial && financialEvidenceContract(composerFinancialContext?.evidence_contract);
  const composerIsIncident = composerCommand?.key === "tasks.report_incident";
  const composerSupportsEvidence = composerSupportsPod || Boolean(composerSelfEvidence) || composerFinancialEvidence || composerIsIncident;
  const composerCaptureEpoch = React.useRef(0);
  const composerSubmitInFlight = React.useRef(false);
  React.useEffect(() => { composerCaptureEpoch.current += 1; }, [composerCommand, sessionUserId]);
  const composerPodPolicyContext = React.useMemo(() => {
    if (!composerSupportsPod) return null;
    const detail = asRecord(detailQuery.data?.detail);
    const metadata = asRecord(detail.metadata);
    return {
      ...policyContext,
      task_id: selectedResourceId,
      resource_id: selectedResourceId,
      client_id: readContextId(policyContext, "client_id") ?? coerceValueText(detail.client_id),
      task_kind: coerceValueText(metadata.kind) ?? coerceValueText(detail.kind),
    };
  }, [composerSupportsPod, detailQuery.data?.detail, policyContext, selectedResourceId]);
  const composerPodPolicyQuery = useQuery({
    queryKey: [
      "policy",
      "pod_policy",
      composerCommand?.key ?? "none",
      stableStringify(composerPodPolicyContext ?? {}),
    ],
    enabled: Boolean(composerPodPolicyContext),
    queryFn: async () => resolvePolicyRow(client, "resolve_pod_policy", composerPodPolicyContext ?? {}),
    staleTime: 60_000,
  });
  const composerPodPolicyValue = React.useMemo(
    () => asRecord((composerPodPolicyQuery.data as Record<string, unknown> | null)?.value),
    [composerPodPolicyQuery.data]
  );
  const composerPodPolicyState = React.useMemo(
    () =>
      resolveComposerPodPolicyState({
        supportsPod: composerSupportsPod,
        hasPolicy: Boolean(composerPodPolicyQuery.data),
        isLoading: composerPodPolicyQuery.isLoading,
        isError: composerPodPolicyQuery.isError,
      }),
    [
      composerPodPolicyQuery.data,
      composerPodPolicyQuery.isError,
      composerPodPolicyQuery.isLoading,
      composerSupportsPod,
    ]
  );
  const composerPodRequirements = React.useMemo(() => {
    if (composerCommand?.key === "tasks.complete") {
      return asRecord(composerPodPolicyValue.completed);
    }
    if (composerCommand?.key === "tasks.exception") {
      return asRecord(composerPodPolicyValue.exception);
    }
    return {};
  }, [composerCommand?.key, composerPodPolicyValue]);
  const composerEvidencePolicy = React.useMemo(
    () => asRecord(composerPodPolicyValue.binary_evidence),
    [composerPodPolicyValue]
  );
  const composerEvidenceRegistrationRpc = composerIsIncident ? composerCommand?.execution?.evidence?.registration_rpc ?? "" :
    composerSelfEvidence?.registrationRpc ?? "register_mobile_artifact_v1";
  const composerArtifactBucket =
    composerSelfEvidence?.bucket ?? (composerIsIncident ? coerceValueText(composerCommand?.execution?.evidence?.bucket) :
      composerFinancialEvidence ? null : coerceValueText(composerEvidencePolicy.bucket_id)) ?? "fieldops-evidence";
  const composerArtifactMaxItems = Math.max(
    1,
    composerFinancialEvidence ? 1 : composerSelfEvidence?.maxItems ??
      Math.round(coerceValueNumber(composerIsIncident ? composerCommand?.execution?.evidence?.max_items : composerEvidencePolicy.max_items) ?? 6)
  );
  const composerOrganizationId = readContextId(policyContext, "organization_id");
  const completionReadbackScope = completionScopeFromMe(me,sessionUserId)?.scope ?? "";
  const departureRequestQuery = useQuery({
    queryKey: ["route", "departure-request", sessionUserId, completionReadbackScope, selectedRouteRunId, lastSyncSuccessAt],
    queryFn: () => outbox.get(routeDepartureQueueId({ actor: sessionUserId, scope: completionReadbackScope }, selectedRouteRunId!)),
    enabled: outboxInitSuccess && Boolean(completionReadbackScope && selectedRouteRunId),
  });
  React.useEffect(() => {
    activateCompletionReadbackScope(sessionUserId, completionReadbackScope);
    return () => { void invalidateCompletionReadbacks(); };
  }, [sessionUserId, completionReadbackScope]);
  const completionReadbackIdentity = JSON.stringify([sessionUserId, completionReadbackScope, resource, selectedResourceId]);
  React.useEffect(() => { financialAdmission.current += 1; }, [completionReadbackIdentity]);
  const completionReadbackCurrent = React.useRef(completionReadbackIdentity);
  completionReadbackCurrent.current = completionReadbackIdentity;
  const completionReadbackQuery = useQuery({
    queryKey: ["completion-readback", completionReadbackIdentity, lastActionReceipt?.queueId, lastSyncSuccessAt],
    enabled: cacheInitSuccess && resource === "tasks" && Boolean(selectedResourceId) && effectiveOnline,
    retry: false,
    queryFn: async () => {
      const captured = completionReadbackIdentity;
      const capturedGeneration = completionReadbackScopeVersion();
      const record = await latestCompletionReadback(cacheStore, sessionUserId, completionReadbackScope, selectedResourceId || "");
      if (captured !== completionReadbackCurrent.current || !record) return null;
      if (!record.accepted) return { verified: false, kind: record.expected.kind, settlementStatus: null };
      let settlementStatus: string | null = null;
      const verified = await verifyCompletionReadback(record, async (taskId, taskEventId, signal) => {
        const { data, error } = await client.schema("api").rpc(record.expected.kind === "financial_amount_v1" ? "ui_get_financial_task_readback_v1" : "ui_get_task_completion_readback_v1", {
          p_task_id: taskId, p_task_event_id: taskEventId,
        }).abortSignal(signal);
        if (error) throw error;
        settlementStatus = record.expected.kind === "financial_amount_v1" ? coerceValueText(asRecord(data).settlement_status) : null;
        return data;
      }, () => captured === completionReadbackCurrent.current && capturedGeneration === completionReadbackScopeVersion());
      return { verified, kind: record.expected.kind, settlementStatus: verified ? settlementStatus : null };
    },
  });
  const completionReadbackVerified = completionReadbackQuery.isSuccess && !completionReadbackQuery.isFetching && completionReadbackQuery.data?.verified === true;
  const incidentReadbackQuery = useQuery({
    queryKey: ["incident-readback", completionReadbackIdentity, lastActionReceipt?.queueId, lastSyncSuccessAt, effectiveOnline],
    enabled: cacheInitSuccess && resource === "tasks" && Boolean(selectedResourceId),
    retry: false,
    queryFn: async () => {
      const captured = completionReadbackIdentity;
      const epoch = completionReadbackScopeVersion();
      const records = await listIncidentReadbacks(cacheStore, sessionUserId, completionReadbackScope, selectedResourceId || "");
      if (!records.length || captured !== completionReadbackCurrent.current) return null;
      if (!effectiveOnline) return records.map(record => ({ record, verified: false, proof: null }));
      const before = await resolveVerifiedCompletionScope(client);
      if (captured !== completionReadbackCurrent.current || epoch !== completionReadbackScopeVersion()) return null;
      if (!before || before.actor !== sessionUserId || before.scope !== completionReadbackScope)
        throw new Error("Incident readback authority unavailable.");
      const outcomes = await Promise.all(records.map(async record => {
        if (!record.accepted) return { record, verified: false, proof: null };
        try {
          const result = await boundedCompletionRead(signal => client.schema("api").rpc("ui_get_route_stop_incident_readback_v1", {
            p_source_task_id: record.taskId, p_incident_task_id: record.accepted!.incidentTaskId,
            p_incident_task_event_id: record.accepted!.taskEventId,
          }).abortSignal(signal));
          if (result.error) throw result.error;
          return incidentReadbackMatches(result.data, record) ? { record, verified: true, proof: asRecord(result.data) } :
            { record, verified: false, proof: null };
        } catch { return { record, verified: false, proof: null }; }
      }));
      const after = await resolveVerifiedCompletionScope(client);
      if (captured !== completionReadbackCurrent.current || epoch !== completionReadbackScopeVersion()) return null;
      if (!after || after.actor !== sessionUserId || after.scope !== completionReadbackScope)
        throw new Error("Incident readback authority unavailable.");
      return outcomes;
    },
  });
  const incidentDisplayState = incidentReadbackDisplayState(effectiveOnline, incidentReadbackQuery);
  const [evidenceManagerRevision, setEvidenceManagerRevision] = React.useState(0);
  const evidenceClearEpoch = React.useRef(0);
  const pendingEvidence = React.useMemo(() => createPendingEvidence(cacheStore), [cacheStore, sessionUserId, composerOrganizationId, evidenceManagerRevision]);
  const [composerEvidenceRows, setComposerEvidenceRows] = React.useState<PendingEvidence[]>([]);
  const [composerEvidenceReady, setComposerEvidenceReady] = React.useState(false);
  const [composerEvidenceBusy, setComposerEvidenceBusy] = React.useState(false);
  const composerEvidenceSubject = composerSelfEvidence ? sessionUserId : selectedResourceId;
  const composerEvidenceCommandIdentity = composerCommand ? stableStringify({
    key: composerCommand.key, params: composerCommand.execution?.params ?? {},
    rpc: composerEvidenceRegistrationRpc, bucket: composerArtifactBucket,
  }) : null;
  const composerEvidenceScope = React.useMemo<EvidenceScope | null>(() =>
    composerOrganizationId && sessionUserId && composerEvidenceSubject && composerEvidenceCommandIdentity
      ? { organizationId: composerOrganizationId, actorId: sessionUserId,
          subjectId: composerEvidenceSubject, commandKey: composerEvidenceCommandIdentity,
          bucket: composerArtifactBucket, registrationRpc: composerEvidenceRegistrationRpc } : null,
    [composerOrganizationId, sessionUserId, composerEvidenceSubject, composerEvidenceCommandIdentity,
      composerArtifactBucket, composerEvidenceRegistrationRpc]);
  const evidenceLifecycle = React.useRef<{ manager: typeof pendingEvidence } | null>(null);
  React.useEffect(() => {
    const previous = evidenceLifecycle.current;
    if (previous && previous.manager !== pendingEvidence) void previous.manager.invalidate();
    const attachment = { manager: pendingEvidence };
    evidenceLifecycle.current = attachment;
    return () => {
      // StrictMode immediately reattaches the same memo instance; a real unmount does not.
      void Promise.resolve().then(() => {
        if (evidenceLifecycle.current === attachment || evidenceLifecycle.current?.manager !== pendingEvidence)
          return pendingEvidence.invalidate();
      });
    };
  }, [pendingEvidence]);
  const refreshComposerEvidence = React.useCallback(async (epoch = composerCaptureEpoch.current) => {
    if (!composerEvidenceScope) return;
    const rows = await pendingEvidence.list(composerEvidenceScope);
    if (epoch !== composerCaptureEpoch.current) return;
    setComposerEvidenceRows(rows);
    setComposerArtifacts(rows.flatMap(row => row.phase === "registered" && row.artifactId
      ? [{ artifactId: row.artifactId, storageKey: row.storageKey, capturedAt: row.capturedAt,
          kind: row.kind, mimeType: row.mimeType, evidenceTag: row.evidenceTag }] : []));
    setComposerEvidenceReady(true);
  }, [pendingEvidence, composerEvidenceScope]);
  React.useEffect(() => {
    const epoch = ++composerCaptureEpoch.current;
    setComposerEvidenceBusy(false);
    setComposerEvidenceReady(false);
    setComposerEvidenceRows([]);
    setComposerArtifacts([]);
    if (composerSupportsEvidence && composerEvidenceScope) {
      void refreshComposerEvidence(epoch).catch(error => {
        if (epoch === composerCaptureEpoch.current) setComposerError(strings.pendingEvidence.failed);
      });
    }
    return () => { composerCaptureEpoch.current += 1; };
  }, [composerSupportsEvidence, composerEvidenceScope, refreshComposerEvidence, strings.pendingEvidence.failed]);
  const settleComposerEvidence = React.useCallback(async (id: string) => {
    if (!composerEvidenceScope || !composerSupportsEvidence || composerPodPolicyState.blockingMessage)
      throw new Error("evidence_policy_unavailable");
    return pendingEvidence.settle(composerEvidenceScope, id, {
      upload: async (record, bytes) => {
        const result = await client.storage.from(record.bucket).upload(record.storageKey, bytes,
          { contentType: record.mimeType, upsert: false });
        if (result.error) throw result.error;
      },
      register: async record => {
        if (record.bucket !== composerArtifactBucket || record.registrationRpc !==
            composerEvidenceRegistrationRpc)
          throw new Error("evidence_contract_changed");
        const result = await client.rpc(record.registrationRpc, { p_artifact: record.payload });
        if (result.error) throw result.error;
        const rows = Array.isArray(result.data) ? result.data : result.data ? [result.data] : [];
        return coerceValueText(asRecord(rows[0]).artifact_id) ?? "";
      },
    });
  }, [pendingEvidence, composerEvidenceScope, composerSupportsEvidence,
    composerPodPolicyState.blockingMessage, composerArtifactBucket, composerEvidenceRegistrationRpc, client]);
  const recoverComposerEvidence = React.useCallback(async (id: string, discard = false) => {
    if (!composerEvidenceScope || composerEvidenceBusy || composerSubmitting ||
        isCapturingComposerArtifact || isCapturingComposerSignature) return;
    const epoch = composerCaptureEpoch.current;
    setComposerEvidenceBusy(true);
    try {
      if (discard) await pendingEvidence.discard(composerEvidenceScope, [id]);
      else await settleComposerEvidence(id);
    } catch (error) {
      if (epoch === composerCaptureEpoch.current) setComposerError(strings.pendingEvidence.failed);
    } finally {
      try { await refreshComposerEvidence(epoch); } catch (error) {
        if (epoch === composerCaptureEpoch.current) setComposerError(strings.pendingEvidence.failed);
      }
      if (epoch === composerCaptureEpoch.current) setComposerEvidenceBusy(false);
    }
  }, [pendingEvidence, composerEvidenceScope, composerEvidenceBusy, composerSubmitting,
    isCapturingComposerArtifact, isCapturingComposerSignature, settleComposerEvidence, refreshComposerEvidence, strings.pendingEvidence.failed]);
  const composerMinArtifactCount = Math.max(
    composerIsIncident ? 1 : 0,
    Math.round(coerceValueNumber(composerIsIncident ? composerCommand?.execution?.evidence?.min_items : composerPodRequirements.min_artifact_count) ?? 0)
  );
  const composerPhotoRequired = Boolean(composerPodRequirements.photo_required);
  const composerSignatureRequired = React.useMemo(
    () =>
      resolveComposerSignatureRequired({
        podRequirements: composerPodRequirements,
        handoverMode: coerceValueText(composerValues.handover_mode),
        handoverModes: composerLookupMap.delivery_handover_mode,
      }),
    [composerLookupMap.delivery_handover_mode, composerPodRequirements, composerValues.handover_mode]
  );
  const composerOtpRequired = React.useMemo(
    () =>
      resolveComposerOtpRequired({
        podRequirements: composerPodRequirements,
      }),
    [composerPodRequirements]
  );
  const composerIdentityRequired = React.useMemo(
    () =>
      resolveComposerIdentityRequired({
        podRequirements: composerPodRequirements,
      }),
    [composerPodRequirements]
  );
  const composerSignatureSegments = React.useMemo(
    () => createSignatureSegments(composerSignatureStrokes),
    [composerSignatureStrokes]
  );
  const composerSignaturePresent = React.useMemo(
    () => composerSignatureStrokes.some((stroke) => stroke.length > 1),
    [composerSignatureStrokes]
  );
  const composerSignatureArtifact = React.useMemo(
    () => composerArtifacts.find((entry) => entry.kind === "signature") ?? null,
    [composerArtifacts]
  );

  const appendComposerSignaturePoint = React.useCallback(
    (point: SignaturePoint, input?: { start?: boolean }) => {
      setComposerSignatureStrokes((prev) => {
        if (input?.start || prev.length === 0) {
          return [...prev, [point]];
        }
        const next = prev.slice();
        const current = next[next.length - 1] ? [...next[next.length - 1]] : [];
        const lastPoint = current[current.length - 1];
        if (lastPoint && Math.hypot(lastPoint.x - point.x, lastPoint.y - point.y) < 1.25) {
          return prev;
        }
        current.push(point);
        next[next.length - 1] = current;
        return next;
      });
    },
    []
  );

  const clearComposerSignature = React.useCallback(() => {
    composerSignatureStrokeRef.current = null;
    setComposerSignatureStrokes([]);
    setComposerError((current) => (current ? null : current));
  }, []);

  const composerSignatureResponder = React.useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => !composerSubmitting,
        onMoveShouldSetPanResponder: () => !composerSubmitting,
        onPanResponderGrant: (event) => {
          const point = {
            x: Number(event.nativeEvent.locationX ?? 0),
            y: Number(event.nativeEvent.locationY ?? 0),
          };
          composerSignatureStrokeRef.current = [point];
          appendComposerSignaturePoint(point, { start: true });
          setComposerError((current) => (current ? null : current));
        },
        onPanResponderMove: (event) => {
          const point = {
            x: Number(event.nativeEvent.locationX ?? 0),
            y: Number(event.nativeEvent.locationY ?? 0),
          };
          appendComposerSignaturePoint(point);
        },
        onPanResponderRelease: () => {
          composerSignatureStrokeRef.current = null;
        },
        onPanResponderTerminate: () => {
          composerSignatureStrokeRef.current = null;
        },
      }),
    [appendComposerSignaturePoint, composerSubmitting]
  );

  const setComposerFieldValue = React.useCallback((key: string, value: string) => {
    setComposerValues((prev) => ({ ...prev, [key]: value }));
    setComposerError((current) => (current ? null : current));
  }, []);

  const resetComposer = React.useCallback(() => {
    composerCaptureEpoch.current += 1;
    financialAdmission.current += 1;
    setComposerCommand(null);
    setComposerFinancialContext(null);
    setComposerFinancialSession("");
    setComposerEvidenceRows([]);
    setComposerEvidenceReady(false);
    setComposerEvidenceBusy(false);
    setComposerValues({});
    setComposerArtifacts([]);
    setComposerCameraOpen(false);
    setIsCapturingComposerArtifact(false);
    setIsCapturingComposerSignature(false);
    composerSignatureStrokeRef.current = null;
    setComposerSignatureStrokes([]);
    setComposerError(null);
    setComposerSubmitting(false);
  }, []);

  const registerComposerArtifact = React.useCallback(
    async (input: {
      bytes: ArrayBuffer;
      extension: string;
      mimeType: string;
      kind: ComposerArtifactKind;
      metadata?: Record<string, unknown>;
      captureEpoch?: number;
    }): Promise<ComposerArtifactEntry> => {
      if (!composerSupportsEvidence) throw new Error("Proof collection is unavailable for this action.");
      const captureEpoch = input.captureEpoch ?? composerCaptureEpoch.current;
      if (captureEpoch !== composerCaptureEpoch.current) throw new Error("stale_capture");
      const existingArtifactCount =
        composerArtifacts.length -
        (input.kind === "signature" && composerArtifacts.some((entry) => entry.kind === "signature")
          ? 1
          : 0);
      if (existingArtifactCount >= composerArtifactMaxItems) {
        throw new Error(`Evidence limit reached (${composerArtifactMaxItems}).`);
      }
      if (!composerSelfEvidence && !selectedResourceId) throw new Error("Select a task before collecting proof.");
      const evidenceTag = composerSelfEvidence?.tagField
        ? String(composerValues[composerSelfEvidence.tagField] ?? "").trim() : undefined;
      if (composerSelfEvidence?.tagField && (!evidenceTag || evidenceTag.length > 100 || composerArtifacts.some(entry => entry.evidenceTag === evidenceTag))) {
        throw new Error(strings.selfKyc.angleRequired);
      }

      const organizationId = readContextId(policyContext, "organization_id");
      if (!organizationId) {
        throw new Error("Organization context is missing for proof capture.");
      }

      const evidenceSubject = composerSelfEvidence ? sessionUserId : selectedResourceId;
      if (!evidenceSubject) throw new Error(strings.selfKyc.actorMissing);
      if (!composerEvidenceScope || !composerEvidenceReady || composerEvidenceBusy)
        throw new Error("evidence_recovery_not_ready");
      const id = createOutboxId();
      const capturedAt = new Date().toISOString();
      const storageKey = `${organizationId}/${evidenceSubject}/${id}.${input.extension}`;
      const currentCoordinates = extractCoordinates(detailQuery.data?.detail);
      const payload = {
          organization_id: organizationId,
          storage_bucket: composerArtifactBucket,
          storage_key: storageKey,
          mime_type: input.mimeType,
          size_bytes: input.bytes.byteLength,
          metadata: composerSelfEvidence ? {} : {
            app: "fieldops",
            action_key: composerCommand?.key ?? null,
            artifact_kind: input.kind,
            task_id: selectedResourceId,
            captured_at: capturedAt,
            reference: selectedStopSnapshot?.reference ?? null,
            customer_name: selectedStopSnapshot?.customerName ?? null,
            geostamp: currentCoordinates
              ? {
                  latitude: currentCoordinates.latitude,
                  longitude: currentCoordinates.longitude,
                  accuracy_m: currentCoordinates.accuracyM,
                }
              : null,
            ...(input.metadata ?? {}),
          },
        };
      await pendingEvidence.stage(composerEvidenceScope, {
        id, capturedAt, storageKey, bucket: composerArtifactBucket, mimeType: input.mimeType,
        kind: input.kind, evidenceTag, registrationRpc: composerEvidenceRegistrationRpc,
        payload, bytes: encodeEvidenceBytes(input.bytes), phase: "pending", attempts: 0,
      }, composerArtifactMaxItems);
      try {
        const record = await settleComposerEvidence(id);
        if (!record.artifactId) throw new Error("evidence_registration_empty");
        return { artifactId: record.artifactId, capturedAt: record.capturedAt,
          storageKey: record.storageKey, kind: record.kind, mimeType: record.mimeType, evidenceTag: record.evidenceTag };
      } finally {
        await refreshComposerEvidence(captureEpoch);
      }
    },
    [
      pendingEvidence, composerEvidenceScope, composerEvidenceReady, composerEvidenceBusy, settleComposerEvidence, refreshComposerEvidence,
      client,
      composerArtifactBucket,
      composerArtifactMaxItems,
      composerArtifacts,
      composerCommand?.key,
      composerSupportsEvidence,
      composerSelfEvidence,
      composerEvidenceRegistrationRpc,
      composerValues,
      sessionUserId,
      strings.selfKyc,
      detailQuery.data?.detail,
      policyContext,
      selectedResourceId,
      selectedStopSnapshot?.customerName,
      selectedStopSnapshot?.reference,
    ]
  );

  const captureComposerArtifact = React.useCallback(async () => {
    if (!composerSupportsEvidence || isCapturingComposerArtifact || composerSubmitInFlight.current) return;
    const captureEpoch = composerCaptureEpoch.current;
    if (!composerCameraPermission?.granted) {
      if (composerCameraPermission?.canAskAgain === false) {
        Alert.alert("Camera permission required", "Open settings to allow proof capture.");
        void openSystemSettingsSafe();
        return;
      }
      const granted = await requestComposerCameraPermission();
      if (captureEpoch !== composerCaptureEpoch.current) return;
      if (!granted.granted) {
        setComposerError("Camera permission is required to capture proof.");
        return;
      }
    }

    const camera = composerCameraRef.current as {
      takePictureAsync?: (options?: Record<string, unknown>) => Promise<Record<string, unknown>>;
    } | null;
    if (!camera?.takePictureAsync) {
      setComposerError("Camera is not ready yet.");
      return;
    }

    try {
      setIsCapturingComposerArtifact(true);
      setComposerError(null);
      const photo = asRecord(
        await camera.takePictureAsync({
          quality: 0.55,
          imageType: "jpg",
          base64: true,
          skipProcessing: true,
        })
      );
      if (captureEpoch !== composerCaptureEpoch.current) return;
      const base64 = coerceValueText(photo.base64);
      if (!base64) {
        throw new Error("Camera capture did not return image data.");
      }
      await registerComposerArtifact({
        bytes: decodeBase64ToArrayBuffer(base64),
        extension: "jpg",
        mimeType: "image/jpeg",
        kind: "photo",
        captureEpoch,
      });
      if (captureEpoch !== composerCaptureEpoch.current) return;
      setComposerCameraOpen(false);
    } catch (error) {
      if (captureEpoch === composerCaptureEpoch.current) setComposerError(composerIsSelfKyc ? strings.selfKyc.invalid : strings.pendingEvidence.failed);
    } finally {
      if (captureEpoch === composerCaptureEpoch.current) setIsCapturingComposerArtifact(false);
    }
  }, [
    composerCameraPermission,
    composerIsSelfKyc,
    strings.selfKyc,
    strings.pendingEvidence.failed,
    composerSupportsEvidence,
    isCapturingComposerArtifact,
    registerComposerArtifact,
    requestComposerCameraPermission,
  ]);

  const captureComposerSignature = React.useCallback(async () => {
    if (!composerSupportsPod || isCapturingComposerSignature) return;
    const captureEpoch = composerCaptureEpoch.current;
    if (!composerSignaturePresent) {
      setComposerError("Add a signature before capturing it.");
      return;
    }
    try {
      setIsCapturingComposerSignature(true);
      setComposerError(null);
      const bytes = await buildSignaturePdf(composerSignatureStrokes, composerSignatureLayout);
      if (captureEpoch !== composerCaptureEpoch.current) return;
      await registerComposerArtifact({
        bytes,
        extension: "pdf",
        mimeType: "application/pdf",
        kind: "signature",
        captureEpoch,
        metadata: {
          signature: {
            strokes: composerSignatureStrokes.length,
            width: composerSignatureLayout.width,
            height: composerSignatureLayout.height,
          },
        },
      });
      if (captureEpoch !== composerCaptureEpoch.current) return;
      clearComposerSignature();
    } catch (error) {
      if (captureEpoch === composerCaptureEpoch.current) setComposerError(strings.pendingEvidence.failed);
    } finally {
      if (captureEpoch === composerCaptureEpoch.current) setIsCapturingComposerSignature(false);
    }
  }, [
    clearComposerSignature,
    strings.pendingEvidence.failed,
    composerSignatureLayout,
    composerSignaturePresent,
    composerSignatureStrokes,
    composerSupportsPod,
    isCapturingComposerSignature,
    registerComposerArtifact,
  ]);

  const removeComposerArtifact = React.useCallback((artifactId: string) => {
    const record = composerEvidenceRows.find(entry => entry.artifactId === artifactId);
    if (record) void recoverComposerEvidence(record.id, true);
  }, [composerEvidenceRows, recoverComposerEvidence]);

  const enqueueCommand = React.useCallback(
    async (
      command: UiCommandDefinition,
      input?: {
        payloadPatch?: Record<string, unknown>;
        paramsPatch?: Record<string, unknown>;
        financialExpected?: Record<string, unknown>;
        financialAdmissionCheck?: () => boolean;
      }
    ): Promise<ActionSubmissionReceipt> => {
      if (!resource) throw new Error("Action resource is not selected.");
      const transport = command.execution?.transport ?? "rpc";
      if (transport !== "rpc" && transport !== "edge") throw new Error("Unsupported action transport.");
      const rpc = ((transport === "edge" ? command.execution?.function : command.execution?.rpc) ?? "").trim();
      if (!rpc) throw new Error("Action target is missing.");

      const payloadKeyRaw = coerceValueText(command.execution?.payload_key)?.trim();
      const payloadKey = payloadKeyRaw || "payload";
      const baseParams = asRecord(command.execution?.params);
      const nextParams: Record<string, unknown> = { ...baseParams, ...(input?.paramsPatch ?? {}) };
      if (command.key === "tasks.report_incident" &&
          (resource !== "tasks" || !selectedResourceId ||
            asRecord(detailQuery.data?.detail).id !== selectedResourceId ||
            !isCanonicalTaskActionable(asRecord(detailQuery.data?.detail)) ||
            !isRouteStopExecutionTask(detailQuery.data?.detail))) {
        throw new Error(strings.actionFeedback.incidentUnavailable);
      }
      if (input?.payloadPatch && Object.keys(input.payloadPatch).length > 0) {
        const existingPayload = asRecord(nextParams[payloadKey]);
        nextParams[payloadKey] = {
          ...existingPayload,
          ...input.payloadPatch,
        };
      }

      if (input?.financialExpected) nextParams[payloadKey] = { ...input.payloadPatch };
      const selectionId = command.selection?.mode === "none" ? null : selectedResourceId;
      assertMobileCommandSelection(command, selectionId ?? null);
      const selectionIds = selectionId ? [selectionId] : [];
      const queueId = createOutboxId();
      if (command.key === "tasks.report_incident") nextParams.retry_key = queueId;
      const display = normalizeOutboxDisplay({
        actionLabel: command.label,
        targetLabel: selectionId ? selectedStopSnapshot?.reference ?? selectionId : null,
      });
      let completionRecord: CompletionReadbackRecord | null = null;
      let incidentRecord: IncidentReadbackRecord | null = null;
      if (input?.financialExpected) {
        if (!input.financialAdmissionCheck?.()) throw new Error(strings.financialTasks.unavailable);
        const expected = financialCompletionExpectation(input.financialExpected);
        if (!expected || resource !== "tasks" || command.key !== "tasks.complete" || expected.taskId !== selectionId) throw new Error(strings.financialTasks.unavailable);
        completionRecord = { version: 1, queueId, actor: sessionUserId, scope: completionReadbackScope,
          taskId: selectionId!, actionKey: command.key, expected };
        try {
          await rememberCompletionReadback(cacheStore, completionRecord);
          if (!input.financialAdmissionCheck()) throw new Error(strings.financialTasks.unavailable);
        } catch (error) {
          // Only explicit absence authorizes scoped draft cleanup. A scope change
          // or uncertain read retains evidence; never bypass the storage guard.
          try {
            if (await outbox.get(queueId) === null) await forgetUnqueuedCompletion(cacheStore, completionRecord);
          } catch { /* Preserve uncertain/old-scope evidence and the original failure. */ }
          throw error;
        }
      }
      if (resource === "tasks" && selectionId && ["tasks.complete", "tasks.exception"].includes(command.key)) {
        const selectedTask = asRecord(detailQuery.data?.detail);
        if (selectedTask.id === selectionId && selectedTask.resource_type === "route_stop") {
          const expected = submittedCompletionExpectation(command.key, selectionId,
            selectedTask.resource_id, nextParams[payloadKey]);
          if (!expected) throw new Error("Completion proof requirements are invalid.");
          completionRecord = { version: 1, queueId, actor: sessionUserId,
            scope: completionReadbackScope, taskId: selectionId, actionKey: command.key, expected };
          await rememberCompletionReadback(cacheStore, completionRecord);
        }
      }
      if (command.key === "tasks.report_incident") {
        const selectedTask = asRecord(detailQuery.data?.detail);
        incidentRecord = { version: 1, queueId, actor: sessionUserId, scope: completionReadbackScope,
          taskId: selectionId!, routeStopId: String(selectedTask.resource_id ?? ""),
          artifactIds: Array.isArray(nextParams.artifact_ids) ? nextParams.artifact_ids as string[] : [] };
        await rememberIncidentReadback(cacheStore, incidentRecord);
      }
      const queuedEntry = await outbox.enqueue({
        id: queueId,
        display,
        rpc,
        transport,
        args: {
          ...(transport === "edge" ? { p_idempotency_key: queueId, p_expected_actor_user_id: sessionUserId } :
            command.key === "tasks.report_incident" ? {} : composerRetryArgs(command, queueId, sessionUserId)),
          p_action_key: command.key,
          p_resource_key: resource,
          p_selection_ids: selectionIds,
          p_selection_id: selectionId,
          p_selection_count: selectionIds.length,
          p_params: Object.keys(nextParams).length > 0 ? nextParams : null,
        },
      }).catch(async error => {
        // Delete this draft only when the outbox proves enqueue did not persist.
        if (completionRecord && await outbox.get(queueId) === null) {
          await forgetUnqueuedCompletion(cacheStore, completionRecord);
        }
        if (incidentRecord && await outbox.get(queueId) === null) {
          await forgetUnqueuedIncident(cacheStore, incidentRecord);
        }
        throw error;
      });
      queryClient.invalidateQueries({ queryKey: ["outbox", "count"] });
      queryClient.invalidateQueries({ queryKey: ["outbox", "entries"] });
      queryClient.invalidateQueries({ queryKey: ["ui", "list"] });
      queryClient.invalidateQueries({ queryKey: ["ui", "detail"] });
      let status: ActionSubmissionReceipt["status"] = effectiveOnline
        ? "queued_pending_sync"
        : "queued_offline";
      if (
        mobileSyncPolicy.enabled &&
        effectiveOnline &&
        outboxInitSuccess
      ) {
        if (syncMutation.isPending) {
          status = "queued_pending_sync";
        } else {
          try {
            const result = await syncMutation.mutateAsync();
            // Only this invocation's positive completion receipt proves this item.
            // Absence also occurs when another action clears a dead queue entry.
            status = result.succeededIds.includes(queueId) ? "synced" : "queued_pending_sync";
            if (status !== "synced") {
              const queued = await outbox.get(queueId);
              if (queued?.status === "failed" || queued?.status === "dead") status = "retryable_failure";
            }
          } catch {
            status = "retryable_failure";
          }
        }
      }
      const receipt: ActionSubmissionReceipt = {
        actionKey: command.key,
        actionLabel: queuedEntry?.display?.actionLabel ?? null,
        targetLabel: queuedEntry?.display?.targetLabel ?? null,
        queueId,
        status,
        detail: describeMobileActionReceiptStatus(status, strings),
        recordedAt: new Date().toISOString(),
        resourceId: selectionId ?? null,
      };
      setLastActionReceipt(receipt);
      return receipt;
    },
    [
      effectiveOnline,
      mobileSyncPolicy.enabled,
      outbox,
      outboxInitSuccess,
      queryClient,
      resource,
      selectedResourceId,
      syncMutation,
      sessionUserId,
      setLastActionReceipt,
      selectedStopSnapshot,
      cacheStore,
      completionReadbackScope,
      detailQuery.data?.detail,
      strings,
    ]
  );

  const loadFinancialTaskContext = React.useCallback(async (taskId: string, admitted: () => boolean) => {
    const captured = completionReadbackCurrent.current;
    if (!admitted() || taskId !== selectedResourceId) throw new Error(strings.financialTasks.unavailable);
    const before = await resolveVerifiedCompletionScope(client);
    if (!admitted() || !before || before.actor !== sessionUserId || before.scope !== completionReadbackScope) throw new Error(strings.financialTasks.unavailable);
    const result = await boundedCompletionRead(signal => client.schema("api").rpc("ui_get_financial_task_context_v1", { p_task_id: taskId }).abortSignal(signal));
    if (result.error) throw result.error;
    const after = await resolveVerifiedCompletionScope(client);
    if (!admitted() || captured !== completionReadbackCurrent.current || !after || before.actor !== after.actor || before.scope !== after.scope) throw new Error(strings.financialTasks.unavailable);
    const value = parseFinancialTaskContext(result.data, sessionUserId, composerOrganizationId ?? "", taskId);
    if (!value) throw new Error(strings.financialTasks.unavailable);
    return value;
  }, [client, sessionUserId, completionReadbackScope, composerOrganizationId, selectedResourceId, strings.financialTasks.unavailable]);

  const runCommand = React.useCallback(
    async (command: UiCommandDefinition) => {
      setComposerFinancialContext(null);
      setComposerFinancialSession("");
      const admission = ++financialAdmission.current;
      const identity = completionReadbackCurrent.current;
      const generation = completionReadbackScopeVersion();
      const admitted = () => admission === financialAdmission.current && identity === completionReadbackCurrent.current && generation === completionReadbackScopeVersion();
      const selectedTask = asRecord(detailQuery.data?.detail);
      if (command.key === "tasks.complete" && resource === "tasks" && selectedResourceId && selectedTask.resource_type === "settlement_batch") {
        let context: FinancialTaskContext;
        try { context = await loadFinancialTaskContext(selectedResourceId, admitted); }
        catch (error) { if (!admitted()) return; throw error; }
        if (!admitted()) return;
        const schema = command.execution?.input_schema && resolveFinancialTaskSchema(command.execution.input_schema, context);
        if (!schema || context.task_id !== selectedTask.id) throw new Error(strings.financialTasks.unavailable);
        command = { ...command, execution: { ...command.execution, input_schema: schema } };
        setComposerFinancialContext(context);
        setComposerFinancialAdmission(admission);
        setComposerFinancialSession(context.sessions.length === 1 ? context.sessions[0].id : "");
      }
      const inputFields = resolveCommandInputFields(command, selectedStopSnapshot);
      if (inputFields.length > 0) {
        const initial: Record<string, string> = {};
        for (const field of inputFields) {
          initial[field.key] = resolveComposerFieldDefaultValue(field, selectedStopSnapshot) ?? "";
        }
        setComposerValues(initial);
        setComposerArtifacts([]);
        setComposerCameraOpen(false);
        composerSignatureStrokeRef.current = null;
        setComposerSignatureStrokes([]);
        setComposerError(null);
        setComposerCommand(command);
        return;
      }

      const confirm = command.execution?.confirm ?? null;
      if (confirm) {
        const confirmed = await confirmMobileAction({
          title: confirm.title ?? "Confirm",
          message: confirm.description ?? "",
          confirmLabel: confirm.confirm_label ?? "Confirm",
          cancelLabel: confirm.cancel_label ?? "Cancel",
          danger: confirm.tone === "danger",
        });
        if (!confirmed) return;
      }
      const receipt = await enqueueCommand(command);
      Alert.alert(strings.alerts.actionReceiptTitle, formatMobileActionReceipt(receipt, strings));
    },
    [strings, enqueueCommand, selectedStopSnapshot, detailQuery.data?.detail, resource, selectedResourceId, loadFinancialTaskContext]
  );

  const validateComposer = React.useCallback((): ComposerValidation => {
    let fields: CommandInputFieldRuntime[] = [];
    let partialDeliveryBoxNumbers: number[] | null = null;
    let completionKind: string | null = null;
    let stage = 0;
    const optional = new Set<typeof COMPOSER_READINESS_STAGES[number]>();
    const finish = (error: string | null, empty = false): ComposerValidation => ({
      error, empty, fields, partialDeliveryBoxNumbers, completionKind,
      checks: COMPOSER_READINESS_STAGES.map((key, index) => ({
        key,
        status: empty || index > stage ? "unchecked" : index === stage && error
          ? key === "evidence" ? "pending" : "needed" : optional.has(key) ? "optional" : "ready",
      })),
    });
    if (!composerCommand) return finish(null, true);
    if (composerIsFinancial) {
      for (const key of COMPOSER_READINESS_STAGES) if (key !== "fields") optional.add(key);
      stage = 1;
      fields = resolveCommandInputFields(composerCommand, selectedStopSnapshot);
      if (!composerFinancialContext || composerFinancialContext.task_id !== selectedResourceId ||
          composerFinancialAdmission !== financialAdmission.current) return finish(strings.financialTasks.unavailable);
      try { financialTaskPayload(composerValues.amount ?? "", composerFinancialSession, composerFinancialContext, {
        supervisorName: composerValues.supervisor_name,
        photoArtifactId: composerFinancialEvidence ? composerArtifacts[0]?.artifactId : undefined,
      }); }
      catch { return finish(strings.financialTasks.unavailable); }
      if (composerFinancialEvidence && (!composerEvidenceReady || composerEvidenceBusy ||
          composerEvidenceRows.length > 1 || composerEvidenceRows.length !== composerArtifacts.length ||
          composerEvidenceRows.some(row => row.phase !== "registered" || row.kind !== "photo" || row.artifactId !== composerArtifacts[0]?.artifactId))) {
        stage = COMPOSER_READINESS_STAGES.indexOf("evidence");
        optional.delete("evidence");
        return finish(strings.pendingEvidence.resolveFirst);
      }
      stage = COMPOSER_READINESS_STAGES.length - 1;
      return finish(null);
    }
    if (composerSupportsEvidence && (!composerEvidenceReady || composerEvidenceBusy ||
        composerEvidenceRows.some(row => row.phase !== "registered"))) {
      return finish(strings.pendingEvidence.resolveFirst);
    }
    if (!composerSupportsEvidence) optional.add("evidence");
    stage = 1;
    fields = resolveCommandInputFields(composerCommand, selectedStopSnapshot);
    if (!fields.length) {
      return finish(null, true);
    }

    for (const field of fields) {
      const value = String(composerValues[field.key] ?? "").trim();
      if (field.required && !value) {
        return finish(composerIsSelfKyc ? `${strings.selfKyc[field.key as keyof typeof strings.selfKyc] ?? field.label}: ${strings.selfKyc.required}` : `${field.label} is required.`);
      }
      if (field.type === "number" && value && !Number.isFinite(Number(value))) {
        return finish(`${field.label} must be a valid number.`);
      }
    }

    if (!fields.some(field => field.required ||
        (field.type === "number" && String(composerValues[field.key] ?? "").trim()))) optional.add("fields");
    stage = 2;
    if (
      composerCommand.key === "tasks.exception" &&
      String(composerValues.exception_reason || "").trim().toLowerCase() === "other" &&
      !String(composerValues.exception_notes || "").trim()
    ) {
      return finish("Notes are required when exception reason is Other.");
    }

    if (!(composerCommand.key === "tasks.exception" &&
        String(composerValues.exception_reason || "").trim().toLowerCase() === "other")) optional.add("notes");
    stage = 3;
    if (composerPodPolicyState.blockingMessage) {
      return finish(composerPodPolicyState.blockingMessage);
    }

    if (!composerSupportsPod) optional.add("policy");
    stage = 4;
    if (composerSignatureRequired && !composerSignatureArtifact) {
      return finish("Capture and save the recipient signature before queueing.");
    }

    if (!composerSignatureRequired) optional.add("signature");
    stage = 5;
    if (composerPhotoRequired && composerArtifacts.length === 0) {
      return finish("At least one proof photo is required.");
    }

    if (composerArtifacts.length < composerMinArtifactCount) {
      return finish(
        `At least ${composerMinArtifactCount} proof item${composerMinArtifactCount === 1 ? "" : "s"} are required.`
      );
    }

    if (!composerPhotoRequired && composerMinArtifactCount === 0) optional.add("proof");
    stage = 6;
    if (composerCommand.key === "tasks.complete" && !isPickupStopSnapshot(selectedStopSnapshot)) {
      const otpCode = sanitizeOtpCode(composerValues.otp_code);
      const identityKind =
        coerceValueText(composerValues.recipient_identity_kind)?.toLowerCase() ?? null;
      const identityLast4 = sanitizeIdentityLast4(composerValues.recipient_identity_last4);

      if (composerOtpRequired && !otpCode) {
        return finish("Recipient OTP is required before queueing this delivery.");
      }
      if (otpCode && otpCode.length < 4) {
        return finish("Recipient OTP must contain at least 4 digits.");
      }

      if (composerIdentityRequired && (!identityKind || !identityLast4)) {
        return finish("Identity type and identity last 4 are required before queueing this delivery.");
      }
      if ((identityKind && !identityLast4) || (!identityKind && identityLast4)) {
        return finish("Provide both identity type and identity last 4 for recipient confirmation.");
      }
      if (identityLast4 && identityLast4.length < 4) {
        return finish("Identity last 4 must contain at least 4 letters or digits.");
      }
      if (!composerOtpRequired && !composerIdentityRequired && !otpCode && !identityKind && !identityLast4) optional.add("recipient");
    } else {
      optional.add("recipient");
    }

    stage = 7;
    if (composerCommand.key === "tasks.exception") {
      const reasonKey = normalizeReasonKey(composerValues.exception_reason);
      const hasNotes = Boolean(String(composerValues.exception_notes || "").trim());
      const reasonNeedsPhoto =
        reasonKey.includes("damage") ||
        reasonKey.includes("refus") ||
        reasonKey.includes("proof");
      const reasonNeedsNotes =
        reasonKey.includes("recipient_unavailable") ||
        reasonKey.includes("address") ||
        reasonKey.includes("refus") ||
        reasonKey.includes("access") ||
        reasonKey.includes("restrict");
      if (reasonNeedsPhoto && composerArtifacts.length === 0) {
        return finish("This exception reason requires photo evidence.");
      }
      if (reasonNeedsNotes && !hasNotes) {
        return finish("Add notes for this exception reason before queueing.");
      }
      if (!reasonNeedsPhoto && !reasonNeedsNotes) optional.add("exception");
    } else {
      optional.add("exception");
    }

    stage = 8;
    completionKind =
      composerCommand.key === "tasks.complete" && !isPickupStopSnapshot(selectedStopSnapshot)
        ? String(composerValues.completion_kind ?? "").trim().toLowerCase() || "full"
        : null;
    if (completionKind === "partial") {
      try {
        partialDeliveryBoxNumbers = resolvePartialDeliveryBoxNumbers({
          rawValue: String(composerValues.delivered_box_numbers ?? ""),
          packageCount: selectedStopSnapshot?.packageCount ?? null,
        });
      } catch (error) {
        return finish(
          error instanceof Error && String(error.message || "").trim()
            ? error.message
            : "Partial delivery box numbers are invalid."
        );
      }
    } else {
      optional.add("partial");
    }

    return finish(null);
  }, [composerCommand, selectedStopSnapshot, composerValues, composerIsSelfKyc, strings,
    composerIsFinancial, composerFinancialContext, composerFinancialSession, composerFinancialAdmission, selectedResourceId,
    composerSupportsEvidence, composerSupportsPod, composerFinancialEvidence, composerEvidenceReady, composerEvidenceBusy, composerEvidenceRows,
    composerPodPolicyState.blockingMessage, composerSignatureRequired, composerSignatureArtifact,
    composerPhotoRequired, composerArtifacts, composerMinArtifactCount, composerOtpRequired,
    composerIdentityRequired]);
  // Derived presentation only; submission re-evaluates the same pure guards.
  const composerReadiness = validateComposer();

  const submitComposer = React.useCallback(async () => {
    if (!composerCommand || composerSubmitInFlight.current || isCapturingComposerArtifact || isCapturingComposerSignature) return;
    const validation = validateComposer();
    if (validation.error) {
      setComposerError(validation.error);
      return;
    }
    if (validation.empty) {
      resetComposer();
      return;
    }
    const { fields, completionKind, partialDeliveryBoxNumbers } = validation;
    if (composerIsFinancial) {
      if (!composerFinancialContext) { setComposerError(strings.financialTasks.unavailable); return; }
      const admission = composerFinancialAdmission;
      const identity = completionReadbackCurrent.current;
      const generation = completionReadbackScopeVersion();
      const admitted = () => admission === financialAdmission.current && identity === completionReadbackCurrent.current && generation === completionReadbackScopeVersion() && composerFinancialContext.task_id === selectedResourceId;
      if (!admitted()) return;
      composerSubmitInFlight.current = true;
      setComposerSubmitting(true);
      const epoch = composerCaptureEpoch.current;
      try {
        const confirm = composerCommand.execution?.confirm;
        if (confirm && !await confirmMobileAction({ title: confirm.title ?? strings.financialTasks.title,
          message: confirm.description ?? "", confirmLabel: confirm.confirm_label ?? strings.financialTasks.confirm,
          cancelLabel: confirm.cancel_label ?? strings.financialTasks.cancel, danger: confirm.tone === "danger" })) return;
        if (!admitted()) return;
        const context = await loadFinancialTaskContext(composerFinancialContext.task_id, admitted);
        if (!admitted() || epoch !== composerCaptureEpoch.current) return;
        if (context.settlement_id !== composerFinancialContext.settlement_id || context.task_type_key !== composerFinancialContext.task_type_key) throw new Error(strings.financialTasks.unavailable);
        if (financialEvidenceContract(context.evidence_contract) !== composerFinancialEvidence) throw new Error(strings.financialTasks.unavailable);
        if (composerFinancialEvidence && !composerEvidenceScope) throw new Error(strings.financialTasks.unavailable);
        const evidenceRows = composerFinancialEvidence ? await pendingEvidence.list(composerEvidenceScope!) : [];
        if (!admitted() || epoch !== composerCaptureEpoch.current) return;
        if (evidenceRows.length > 1 || evidenceRows.some(row => row.phase !== "registered" || row.kind !== "photo" ||
            !row.artifactId || row.bucket !== composerEvidenceScope?.bucket || row.registrationRpc !== composerEvidenceScope?.registrationRpc))
          throw new Error(strings.pendingEvidence.resolveFirst);
        const submittedPhoto = evidenceRows[0];
        if (composerFinancialEvidence && (evidenceRows.length !== composerEvidenceRows.length || submittedPhoto &&
            (submittedPhoto.id !== composerEvidenceRows[0]?.id || submittedPhoto.artifactId !== composerArtifacts[0]?.artifactId)))
          throw new Error(strings.pendingEvidence.resolveFirst);
        const payload = financialTaskPayload(composerValues.amount ?? "", composerFinancialSession, context, {
          supervisorName: composerValues.supervisor_name,
          photoArtifactId: submittedPhoto?.artifactId,
        });
        const session = context.sessions.find(value => value.id === payload.ops_session_id);
        setComposerSubmitting(true);
        if (!admitted()) return;
        const receipt = await handoffPendingEvidence(() => enqueueCommand(composerCommand, { payloadPatch: payload,
          financialAdmissionCheck: () => admitted() && epoch === composerCaptureEpoch.current, financialExpected: {
          kind: "financial_amount_v1", action: "tasks.complete", taskId: context.task_id,
          settlementId: context.settlement_id, opsSessionId: payload.ops_session_id ?? null,
          sessionType: session?.session_type ?? null, amount: payload.amount,
          ...(payload.supervisor_name ? { supervisorName: payload.supervisor_name } : {}),
          ...(payload.photo_artifact_id ? { photoArtifactId: payload.photo_artifact_id } : {}),
        } }), async () => {
          if (submittedPhoto && composerEvidenceScope) await pendingEvidence.discard(composerEvidenceScope, [submittedPhoto.id]);
        }, () => admitted() && epoch === composerCaptureEpoch.current,
        error => logDebugFailure("failed to prune handed-off evidence", error));
        if (!admitted() || epoch !== composerCaptureEpoch.current) return;
        queryClient.invalidateQueries({ queryKey: ["resource", "settlements"] });
        resetComposer();
        Alert.alert(strings.alerts.actionReceiptTitle, formatMobileActionReceipt(receipt, strings));
      } catch {
        if (admitted() && epoch === composerCaptureEpoch.current) setComposerError(strings.financialTasks.unavailable);
      } finally {
        composerSubmitInFlight.current = false;
        if (admitted() && epoch === composerCaptureEpoch.current) setComposerSubmitting(false);
      }
      return;
    }

    composerSubmitInFlight.current = true;
    const submitEpoch = composerCaptureEpoch.current;
    try {
    const confirm = composerCommand.execution?.confirm ?? null;
    if (confirm) {
      const confirmed = await confirmMobileAction({
        title: confirm.title ?? "Confirm",
        message: confirm.description ?? "",
        confirmLabel: confirm.confirm_label ?? "Confirm",
        cancelLabel: confirm.cancel_label ?? "Cancel",
        danger: confirm.tone === "danger",
      });
      if (!confirmed) return;
    }

      if (submitEpoch !== composerCaptureEpoch.current) return;
      setComposerSubmitting(true);
      setComposerError(null);
      let payload: Record<string, unknown> = {};
      const paymentCollection: Record<string, unknown> = {};
      for (const field of fields) {
        if (field.key === "delivered_box_numbers") continue;
        const value = parseComposerFieldValue(field, composerValues[field.key] ?? "");
        if (value == null) continue;
        if (isPaymentCollectionFieldKey(field.key)) {
          paymentCollection[field.key] = value;
          continue;
        }
        payload[field.key] = value;
      }
      const paymentOutcome = coerceValueText(paymentCollection.payment_outcome);
      const paymentMethod = coerceValueText(paymentCollection.payment_method);
      const paymentReceiptContext = coerceValueText(paymentCollection.payment_receipt_context);
      const paymentAmount =
        typeof paymentCollection.payment_amount === "number"
          ? paymentCollection.payment_amount
          : coerceValueNumber(paymentCollection.payment_amount);
      if (
        paymentOutcome ||
        paymentMethod ||
        paymentReceiptContext ||
        paymentAmount != null
      ) {
        payload.payment_collection = {
          outcome: paymentOutcome,
          method: paymentMethod,
          collected_amount: paymentAmount,
          receipt_context: paymentReceiptContext,
        };
      }
      if (composerIsSelfKyc) {
        payload = normalizeSelfKycFields(payload);
        validateSelfKycFields(String(composerCommand.execution?.params?.category ?? ""), payload);
        if (composerSelfEvidence) payload.evidence = buildComposerEvidenceMap(composerArtifacts, composerSelfEvidence);
      } else if (composerArtifacts.length > 0) {
        payload.artifact_ids = composerArtifacts.map((entry) => entry.artifactId);
      }
      if (!composerIsSelfKyc && composerSignatureArtifact) {
        payload.signature_artifact_id = composerSignatureArtifact.artifactId;
      }
      if (!composerIsSelfKyc && composerCommand.key !== "tasks.report_incident" && activeDriverShift?.opsSessionId) {
        payload.ops_session_id = activeDriverShift.opsSessionId;
      }
      if (composerCommand.key === "tasks.complete") {
        const coordinates = extractCoordinates(detailQuery.data?.detail);
        if (isPickupStopSnapshot(selectedStopSnapshot)) {
          payload.pod = {
            captured_at: new Date().toISOString(),
            proof_artifact_count: composerArtifacts.length,
            confirmed_quantity: payload.confirmed_quantity ?? null,
            handover_contact_name: payload.handover_contact_name ?? null,
            handover_notes: payload.handover_notes ?? null,
            receipt_context: payload.receipt_context ?? null,
            signature_artifact_id: composerSignatureArtifact?.artifactId ?? null,
            geostamp: coordinates
              ? {
                  latitude: coordinates.latitude,
                  longitude: coordinates.longitude,
                  accuracy_m: coordinates.accuracyM,
                }
              : null,
          };
        } else {
          const otpCode = sanitizeOtpCode(payload.otp_code);
          const identityKind =
            coerceValueText(payload.recipient_identity_kind)?.toLowerCase() ?? null;
          const identityLast4 = sanitizeIdentityLast4(payload.recipient_identity_last4);
          payload.recipient_name =
            String(payload.recipient_name ?? "").trim() ||
            selectedStopSnapshot?.customerName ||
            null;
          payload.otp_code = otpCode;
          payload.recipient_identity_kind = identityKind;
          payload.recipient_identity_last4 = identityLast4;
          payload.delivery_completion = {
            completion_kind: completionKind ?? "full",
            ...(partialDeliveryBoxNumbers ? { delivered_box_numbers: partialDeliveryBoxNumbers } : {}),
            ...(otpCode ? { otp_code: otpCode } : {}),
            ...(identityKind ? { recipient_identity_kind: identityKind } : {}),
            ...(identityLast4 ? { recipient_identity_last4: identityLast4 } : {}),
          };
          payload.pod = {
            captured_at: new Date().toISOString(),
            proof_artifact_count: composerArtifacts.length,
            recipient_name: payload.recipient_name,
            completion_kind: completionKind ?? "full",
            ...(partialDeliveryBoxNumbers ? { delivered_box_numbers: partialDeliveryBoxNumbers } : {}),
            signature_artifact_id: composerSignatureArtifact?.artifactId ?? null,
            ...(otpCode ? { otp_code: otpCode } : {}),
            ...(identityKind ? { recipient_identity_kind: identityKind } : {}),
            ...(identityLast4 ? { recipient_identity_last4: identityLast4 } : {}),
            geostamp: coordinates
              ? {
                  latitude: coordinates.latitude,
                  longitude: coordinates.longitude,
                  accuracy_m: coordinates.accuracyM,
                }
              : null,
          };
        }
      }
      if (composerCommand.key === "tasks.exception") {
        const coordinates = extractCoordinates(detailQuery.data?.detail);
        payload.exception_evidence = {
          captured_at: new Date().toISOString(),
          proof_artifact_count: composerArtifacts.length,
          signature_artifact_id: composerSignatureArtifact?.artifactId ?? null,
          geostamp: coordinates
            ? {
                latitude: coordinates.latitude,
                longitude: coordinates.longitude,
                accuracy_m: coordinates.accuracyM,
              }
              : null,
        };
      }
      const incidentParams = composerCommand.key === "tasks.report_incident" ? {
        incident_type: payload.incident_type,
        summary: payload.summary,
        artifact_ids: payload.artifact_ids,
      } : null;
      const receipt = await handoffPendingEvidence(() => enqueueCommand(composerCommand, {
        payloadPatch: incidentParams ? undefined : payload,
        paramsPatch: incidentParams ?? (
          composerCommand.key === "tasks.exception" && isPickupStopSnapshot(selectedStopSnapshot)
            ? { status_reason: String(composerValues.exception_reason ?? "").trim().toLowerCase() }
            : undefined),
      }), async () => {
        if (composerEvidenceScope) await pendingEvidence.discard(composerEvidenceScope,
          composerEvidenceRows.filter(row => row.phase === "registered").map(row => row.id));
      }, () => submitEpoch === composerCaptureEpoch.current,
      error => logDebugFailure("failed to prune handed-off evidence", error));
      if (submitEpoch !== composerCaptureEpoch.current) return;
      resetComposer();
      Alert.alert(strings.alerts.actionReceiptTitle, formatMobileActionReceipt(receipt, strings));
    } catch (error) {
      if (submitEpoch !== composerCaptureEpoch.current) return;
      setComposerError(
        composerIsSelfKyc ? strings.selfKyc.invalid : error instanceof Error && String(error.message || "").trim()
          ? error.message
          : "Unable to queue action with provided input."
      );
      setComposerSubmitting(false);
    } finally {
      composerSubmitInFlight.current = false;
    }
  }, [strings, validateComposer,
    pendingEvidence, composerEvidenceScope, composerEvidenceRows, composerEvidenceReady, composerEvidenceBusy, composerSupportsEvidence, composerFinancialEvidence,
    composerArtifacts,
    composerIsSelfKyc,
    composerSelfEvidence,
    isCapturingComposerArtifact,
    isCapturingComposerSignature,
    strings.selfKyc,
    activeDriverShift?.opsSessionId,
    composerCommand,
    composerIsFinancial, composerFinancialContext, composerFinancialSession, composerFinancialAdmission, selectedResourceId, loadFinancialTaskContext, queryClient,
    composerMinArtifactCount,
    composerIdentityRequired,
    composerOtpRequired,
    composerPhotoRequired,
    composerPodPolicyState.blockingMessage,
    composerSignatureArtifact,
    composerSignatureRequired,
    composerValues,
    detailQuery.data?.detail,
    enqueueCommand,
    resetComposer,
    selectedStopSnapshot,
  ]);

  const handleActionPress = React.useCallback(
    (command: UiCommandDefinition) => {
      const actionKey = resolveActionLockKey(command);
      if (isActionLocked(actionKey)) return;

      void withActionLock(actionKey, async () => {
        try {
          await runCommand(command);
        } catch {
          Alert.alert(
            "Unable to queue action",
            "The selected action could not be queued right now. Retry when online."
          );
        }
      });
    },
    [isActionLocked, runCommand, resolveActionLockKey, withActionLock]
  );

  const enqueueUiEvents = React.useCallback(
    async (events: Array<Record<string, unknown>>) => {
      if (!outboxInitSuccess) return;
      if (!events.length) return;

      await outbox.enqueue({
        rpc: "ui_log_events_v1",
        args: {
          p_events: events,
          p_app: "mobile",
        },
      });

      queryClient.invalidateQueries({ queryKey: ["outbox", "count"] });
      queryClient.invalidateQueries({ queryKey: ["outbox", "entries"] });
      if (mobileSyncPolicy.enabled && effectiveOnline && !syncMutation.isPending) {
        syncMutation.mutate();
      }
    },
    [effectiveOnline, mobileSyncPolicy.enabled, outbox, outboxInitSuccess, queryClient, syncMutation]
  );

  const telemetryFlushActiveRef = React.useRef(false);
  const telemetryFlushLastAtRef = React.useRef(0);
  const flushBufferedTelemetry = React.useCallback(
    async (reason: string) => {
      if (!outboxInitSuccess) return;
      if (telemetryFlushActiveRef.current) return;

      const now = Date.now();
      if (telemetryFlushLastAtRef.current > 0 && now - telemetryFlushLastAtRef.current < 30_000) {
        return;
      }

      telemetryFlushActiveRef.current = true;
      telemetryFlushLastAtRef.current = now;
      try {
        await flushMobileTelemetryEvents({ enqueue: enqueueUiEvents });
      } catch (error) {
        logDebugFailure(`failed to flush telemetry (${reason})`, error);
      } finally {
        telemetryFlushActiveRef.current = false;
      }
    },
    [enqueueUiEvents, outboxInitSuccess]
  );

  React.useEffect(() => {
    void flushBufferedTelemetry("startup");
    const interval = setInterval(() => {
      void flushBufferedTelemetry("interval");
    }, 60_000);
    return () => clearInterval(interval);
  }, [flushBufferedTelemetry]);

  React.useEffect(() => {
    if (!effectiveOnline) return;
    void flushBufferedTelemetry("online");
  }, [effectiveOnline, flushBufferedTelemetry]);

  const handleSettlementCountSubmit = React.useCallback(
    async (input: { counted: number; settlement: ReturnType<typeof extractSettlementSnapshot> }) => {
      const settlement = input.settlement;
      await enqueueUiEvents([
        {
          event_type: "mobile_settlement_counted",
          captured_at: new Date().toISOString(),
          metadata: {
            app: "fieldops",
            resource: "settlements",
            settlement_id: settlement.id,
            status: settlement.status,
            currency: settlement.currency,
            expected: settlement.expected,
            counted: input.counted,
            variance:
              settlement.expected != null ? input.counted - settlement.expected : settlement.variance,
          },
        },
      ]);
    },
    [enqueueUiEvents]
  );
  const departureSubmitInFlight = React.useRef(false);
  const handleConfirmRouteDeparture = React.useCallback(async () => {
    if (!selectedRouteRunId || departureSubmitInFlight.current) return;
    departureSubmitInFlight.current = true;
    const epoch = completionReadbackScopeVersion();
    try {
      const accepted = await confirmMobileAction({
        title: strings.route.departureRequest,
        message: strings.route.departureRequestExplanation,
        confirmLabel: strings.route.departureRequest,
      });
      if (!accepted) return;
      if (!completionReadbackScopeMatches(epoch, sessionUserId, completionReadbackScope))
        throw new Error(strings.route.departureUnavailable);
      const entry = await confirmRouteDepartureMutation.mutateAsync({
          routeRunId: selectedRouteRunId,
          routeStopId: selectedRouteContext?.routeStopId ?? null,
          taskId: selectedRouteContext?.taskId ?? null,
          opsSessionId: activeDriverShift?.opsSessionId ?? selectedRouteContext?.opsSessionId ?? null,
        });
      Alert.alert(entry.status === "dead" ? strings.route.departureBlocked : strings.route.departureQueued,
        entry.status === "dead" ? strings.route.departureReview : strings.route.departureRequestExplanation);
    } catch (error) {
      logDebugFailure("failed to queue route departure", error);
      Alert.alert(strings.route.departureBlocked, formatUnknownError(error));
    } finally {
      departureSubmitInFlight.current = false;
    }
  }, [
    activeDriverShift?.opsSessionId,
    confirmRouteDepartureMutation,
    selectedRouteContext?.opsSessionId,
    selectedRouteContext?.routeStopId,
    selectedRouteContext?.taskId,
    selectedRouteRunId,
    sessionUserId,
    completionReadbackScope,
    strings,
  ]);

  const handleRouteLoadAction = React.useCallback(async (input: RouteLoadActionInput) => {
    if (!selectedRouteRunId || !outboxInitSuccess) throw new Error("route_load_not_ready");
    const request = buildRouteLoadAction(input, {
      routeRunId: selectedRouteRunId,
      userId: sessionUserId,
      organizationId: readContextId(policyContext, "organization_id") ?? "",
      requestId: createOutboxId(),
    });
    await outbox.enqueue(request);
    queryClient.invalidateQueries({ queryKey: ["outbox", "count"] });
    queryClient.invalidateQueries({ queryKey: ["outbox", "entries"] });
    if (effectiveOnline && mobileSyncPolicy.enabled && !syncMutation.isPending) {
      await syncMutation.mutateAsync();
    }
    queryClient.invalidateQueries({ queryKey: ["route", "execution-manifest", selectedRouteRunId] });
  }, [selectedRouteRunId, outboxInitSuccess, sessionUserId, policyContext, outbox,
    queryClient, effectiveOnline, mobileSyncPolicy.enabled, syncMutation]);

  const driverBranchId = React.useMemo(() => resolveBranchIdFromMe(me), [me]);
  const [isMutatingDriverShift, setIsMutatingDriverShift] = React.useState(false);
  const driverShiftActionRef = React.useRef(false);
  const withDriverShiftLock = React.useCallback(async (action: () => Promise<void>) => {
    if (driverShiftActionRef.current) return;
    driverShiftActionRef.current = true;
    setIsMutatingDriverShift(true);
    try {
      await action();
    } finally {
      driverShiftActionRef.current = false;
      setIsMutatingDriverShift(false);
    }
  }, []);
  const startDriverShift = React.useCallback(() => {
    void withDriverShiftLock(async () => {
      if (!effectiveOnline) {
        Alert.alert("Shift requires connection", "Connect online before starting a driver shift.");
        return;
      }
      if (!deviceId) {
        Alert.alert("Device setup required", "Register the device before starting a shift.");
        return;
      }
      const openedAt = new Date().toISOString();
      const idempotencyKey = `driver-shift-${deviceId}-${openedAt.slice(0, 10)}`;
      const result = await client.rpc("open_ops_session_v1", {
        p_input: {
          session_type: "driver_shift",
          device_id: deviceId,
          branch_id: driverBranchId,
          opened_at: openedAt,
          idempotency_key: idempotencyKey,
          metadata: {
            app: "fieldops",
            source: "mobile",
          },
        },
      });
      if (result.error) throw result.error;
      const row = Array.isArray(result.data) ? result.data[0] : result.data;
      const opsSessionId = coerceValueText(asRecord(row).ops_session_id);
      if (!opsSessionId) {
        throw new Error("Driver shift did not return an ops_session_id.");
      }
      await cacheStore.set(KV_KEYS.activeOpsSession, {
        opsSessionId,
        sessionType: "driver_shift",
        openedAt,
        branchId: driverBranchId,
      });
      queryClient.invalidateQueries({ queryKey: ["kv", "get", KV_KEYS.activeOpsSession] });
    }).catch((error) => {
      Alert.alert("Unable to start shift", formatUnknownError(error));
    });
  }, [cacheStore, client, deviceId, driverBranchId, effectiveOnline, queryClient, withDriverShiftLock]);
  const endDriverShift = React.useCallback(() => {
    void withDriverShiftLock(async () => {
      if (!activeDriverShift?.opsSessionId) {
        await cacheStore.remove(KV_KEYS.activeOpsSession);
        queryClient.invalidateQueries({ queryKey: ["kv", "get", KV_KEYS.activeOpsSession] });
        return;
      }
      if (!effectiveOnline) {
        Alert.alert("Shift requires connection", "Connect online before ending a driver shift.");
        return;
      }
      const effectiveAt = new Date().toISOString();
      const result = await client.rpc("transition_ops_session_v1", {
        p_input: {
          ops_session_id: activeDriverShift.opsSessionId,
          to_status: "closed",
          set_closed_at: true,
          effective_at: effectiveAt,
          idempotency_key: `driver-shift-close-${activeDriverShift.opsSessionId}-${effectiveAt}`,
          payload: {
            app: "fieldops",
            source: "mobile",
          },
        },
      });
      if (result.error) throw result.error;
      await cacheStore.remove(KV_KEYS.activeOpsSession);
      queryClient.invalidateQueries({ queryKey: ["kv", "get", KV_KEYS.activeOpsSession] });
    }).catch((error) => {
      Alert.alert("Unable to end shift", formatUnknownError(error));
    });
  }, [activeDriverShift?.opsSessionId, cacheStore, client, effectiveOnline, queryClient, withDriverShiftLock]);

  const handleSignOut = React.useCallback(() => {
    void (async () => {
      const confirmed = await confirmMobileAction({
        title: strings.confirm.signOutTitle,
        message: strings.confirm.signOutMessage,
        confirmLabel: strings.confirm.signOutButton,
        cancelLabel: strings.confirm.cancelButton,
        danger: true,
      });
      if (!confirmed) return;

      financialAdmission.current += 1;
      const clearEpoch = ++evidenceClearEpoch.current;
      composerCaptureEpoch.current += 1;
      await pendingEvidence.invalidate();
      try {
        await clearCompletionReadbacks(() => clearEvidenceLocalState(pendingEvidence, () => outboxStore.clear(), () => cacheStore.clear()), async () => null);
        try {
          const result = await client.auth.signOut({ scope: "local" });
          if (result.error) throw result.error;
        } catch (error) {
          logDebugFailure("failed to sign out", error);
        }
      } finally {
        await replaceEvidenceManagerAfterClear(async () => {
          const remaining = await client.auth.getSession();
          if (remaining.error || !remaining.data.session) return null;
          const verified = await client.auth.getUser();
          if (verified.error) throw verified.error;
          return verified.data.user?.id ?? null;
        }, sessionUserId, () => clearEpoch === evidenceClearEpoch.current &&
          evidenceLifecycle.current?.manager === pendingEvidence,
        () => setEvidenceManagerRevision(current => current + 1));
      }
      if (Platform.OS !== "web") {
        try {
          await stopBackgroundLocationTracking();
        } catch (error) {
          logDebugFailure("failed to stop background location tracking", error);
        }
      }
      setMobileCrashReportingUser(null);
      try {
        await clearMobileTelemetryEvents();
      } catch (error) {
        logDebugFailure("failed to clear telemetry during sign out", error);
      }
      await clearStoredDeviceState(storage);
      queryClient.clear();
    })().catch((error) => {
      logDebugFailure("failed to clear local data during sign out", error);
    });
  }, [pendingEvidence, sessionUserId, cacheStore, client, outboxStore, queryClient, storage, strings]);

  const routeSummary = React.useMemo(() => {
    if (!isRouteSurface) return null;
    const items = displayedRoute.items;
    const totalStops = items.length;
    const doneStops = items.filter((entry) => {
      const status = extractRouteCardSnapshot(entry).status?.trim().toLowerCase() ?? "";
      return status === "done" || status === "completed" || status === "closed";
    }).length;
    const activeStops = Math.max(totalStops - doneStops, 0);

    const routeDateRaw = items
      .map((entry) => {
        const itemRecord = asRecord(entry);
        const metadata = asRecord(itemRecord.metadata);
        return pickFirstTextValue([
          itemRecord.route_date,
          itemRecord.scheduled_date,
          itemRecord.sla_due_at,
          metadata.route_date,
          metadata.scheduled_date,
          metadata.sla_due_at,
        ]);
      })
      .find(Boolean);

    const routeDate = routeDateRaw ? routeDateRaw.split("T")[0] : null;
    const status = activeStops > 0 ? "in_progress" : totalStops > 0 ? "done" : "idle";

    return {
      totalStops,
      doneStops,
      activeStops,
      routeDate,
      status,
    };
  }, [isRouteSurface, displayedRoute.items]);
  const hasCodWorkload = React.useMemo(() => {
    if (selectedStopSnapshot?.codAmount != null && selectedStopSnapshot.codAmount > 0) {
      return true;
    }
    const items = listQuery.data?.list.items ?? [];
    if (!items.length) return false;
    return items.some((entry) => {
      if (isRouteSurface) {
        return Boolean(extractRouteCardSnapshot(entry).codBadge);
      }
      if (resource === "tasks" && !isRouteSurface && !isSettlementsSurface) {
        return Boolean(extractTaskCardSnapshot(entry).codBadge);
      }
      return false;
    });
  }, [isRouteSurface, isSettlementsSurface, listQuery.data?.list.items, resource, selectedStopSnapshot?.codAmount]);
  const settlementsEnabledForShell = canReadSettlements || hasCodWorkload;

  const resourceHeaderTitle =
    selectedItem?.label ??
    (isRouteSurface ? strings.route.title : isSettlementsSurface ? strings.settlements.title : resource === "tasks" ? strings.tasks.title : resource ?? publicConfig.appName);
  const resourceHeaderSubtitle = isRouteSurface
    ? `${strings.route.subtitle(routeSummary?.totalStops ?? 0)}${routeSummary?.routeDate ? ` - ${routeSummary.routeDate}` : ""}`
    : isSettlementsSurface
      ? "settlements (ledger surface)"
      : resource ?? "";
  const canToggleRouteView =
    isRouteSurface && mapPolicy.routeViews.length > 1 && !drivingModeLocked;
  const appDirectionStyle =
    Platform.OS === "web" ? null : selectedDirectionMode === "rtl" ? styles.directionRtl : styles.directionLtr;
  const activeRoleSnapshot = activeRoleQuery.data ?? null;
  const effectiveActiveRole =
    activeRoleSnapshot?.selectedRole ??
    (activeRoleSnapshot?.selectionState === "single_eligible"
      ? activeRoleSnapshot.eligibleRoles[0] ?? null
      : null);
  const liveRegistryQuery = useQuery({
    queryKey: ["fieldops", "live-registry", me?.user?.id ?? null, stableStringify(me?.access_scope ?? null)],
    queryFn: () => uiClient.readRegistry(),
    enabled: Boolean(me?.user?.id && effectiveActiveRole),
    staleTime: 30_000,
  });
  const liveSourceSelection = React.useMemo(
    () => selectFieldOpsLiveSources(effectiveActiveRole?.roleKey, liveRegistryQuery.data),
    [effectiveActiveRole?.roleKey, liveRegistryQuery.data]
  );
  const liveOperationsQuery = useQuery({
    queryKey: ["fieldops", "live-operations", me?.user?.id ?? null,
      stableStringify(me?.access_scope ?? null), effectiveActiveRole?.roleId ?? null,
      liveSourceSelection.rpcQueries, liveSourceSelection.resourceQueries],
    queryFn: async () => {
      const sources: Record<string, ReturnType<typeof fieldOpsLiveSourceResult>> = {};
      await Promise.all([
        ...liveSourceSelection.rpcQueries.map(async (query) => {
          try {
            const args = { p_shipment_ids: null, p_client_id: null, p_sender_id: null,
              p_status: null, p_limit: 50 };
            const { data, error } = await client.rpc(query.rpc, args);
            sources[query.id] = error
              ? fieldOpsLiveSourceResult(null, { error: true })
              : fieldOpsLiveSourceResult(data, { complete: Array.isArray(data) && data.length < 50 });
          } catch {
            sources[query.id] = fieldOpsLiveSourceResult(null, { error: true });
          }
        }),
        ...liveSourceSelection.resourceQueries.map(async (query) => {
          try {
            const list = await uiClient.listResource(query.resource, query.filters, 50, 0, null);
            const complete = list.total_is_estimate !== true &&
              typeof list.total === "number" && list.total <= list.items.length;
            sources[query.id] = fieldOpsLiveSourceResult(list.items, { complete });
          } catch {
            sources[query.id] = fieldOpsLiveSourceResult(null, { error: true });
          }
        }),
      ]);
      return projectFieldOpsLiveOperations(sources);
    },
    enabled: liveSourceSelection.state === "ready" && Boolean(liveRegistryQuery.data) && !liveRegistryQuery.isError,
    staleTime: 15_000,
  });
  const userRoleLabel = effectiveActiveRole?.label ??
    resolveMobileRoleLabel(me?.user?.user_type ?? null);
  const userRoleCode = React.useMemo(() => resolveMobileRoleCode(userRoleLabel), [userRoleLabel]);
  const shellHeaderTitle = React.useMemo(
    () => resolveMobileShellHeaderTitle(publicConfig.appName, me?.user?.user_type ?? null),
    [me?.user?.user_type, publicConfig.appName]
  );
  const headerSafeAreaStyle = React.useMemo(
    () => ({ paddingTop: resolveHeaderTopPadding(safeAreaInsets.top) }),
    [safeAreaInsets.top]
  );
  const contentSafeAreaStyle = React.useMemo(
    () => ({ paddingBottom: resolveContentBottomPadding(safeAreaInsets.bottom) }),
    [safeAreaInsets.bottom]
  );
  const navModalSafeAreaStyle = React.useMemo(
    () => ({ paddingBottom: resolveNavModalBottomPadding(safeAreaInsets.bottom) }),
    [safeAreaInsets.bottom]
  );
  const isWebPreview =
    Platform.OS === "web" ||
    (typeof globalThis.window !== "undefined" && typeof globalThis.document !== "undefined");
  const drawerSections = React.useMemo(
    () => resolveDrawerSections(navigation.sections, { includeSettlements: settlementsEnabledForShell }),
    [navigation.sections, settlementsEnabledForShell]
  );
  const drawerContent = (
    <View
      style={[
        styles.drawerPanel,
        isWebPreview && styles.drawerPanelWeb,
        isWebPreview && styles.drawerPanelInWebWrap,
        navModalSafeAreaStyle,
      ]}
    >
      <View style={styles.drawerHeader}>
        <Text style={styles.drawerTitle}>Modules</Text>
        <FieldOpsDrawerCloseButton locale={selectedLocaleMode} onClose={() => setNavOpen(false)}
          style={styles.drawerClose} textStyle={styles.drawerCloseText} />
      </View>
      <ScrollView contentContainerStyle={styles.drawerContent}>
        {activeRoleQuery.isError ? (
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>Work mode</Text>
            <Text style={styles.navItemBadge}>Unavailable</Text>
          </View>
        ) : activeRoleSnapshot && activeRoleSnapshot.eligibleRoles.length > 0 ? (
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>Work mode</Text>
            {activeRoleSnapshot.eligibleRoles.map((role) => {
              const selected = effectiveActiveRole?.roleId === role.roleId;
              return (
                <Pressable
                  key={role.roleId}
                  accessibilityRole="button"
                  accessibilityState={{ selected, disabled: setActiveRoleMutation.isPending }}
                  testID={`mobile-role-${role.roleKey}`}
                  disabled={setActiveRoleMutation.isPending}
                  onPress={() => setActiveRoleMutation.mutate(role.roleId)}
                  style={({ pressed }) => [
                    styles.navItem,
                    selected && styles.navItemSelected,
                    pressed && !setActiveRoleMutation.isPending && styles.navItemPressed,
                    setActiveRoleMutation.isPending && styles.navItemDisabled,
                  ]}
                >
                  <Text style={styles.navItemLabel}>{role.label}</Text>
                  {selected ? <Text style={styles.navItemBadge}>Selected</Text> : null}
                </Pressable>
              );
            })}
          </View>
        ) : null}
        {drawerSections.map((section) => (
          <View key={section.id} style={styles.section}>
            <Text style={styles.sectionTitle}>{section.label}</Text>
            {section.items.map((item) => {
              const routeForItem = resolveNavigationRoute(item);
              const navKey = resolveNavigationKey(item);
              const blockedByDriving =
                drivingModeLocked && !canNavigateWhileMoving(drivingSafetyState, navKey);
              const unsupportedRoute = routeForItem.kind === "home" || routeForItem.kind === "unknown";
              const disabledByPolicy = Boolean(item.disabled_reason);
              const disabledReason = disabledByPolicy
                ? formatMobileNavDisabledReason(item.disabled_reason)
                : null;
              const blocked = disabledByPolicy || blockedByDriving || unsupportedRoute;
              return (
                <Pressable
                  key={item.id}
                  accessibilityRole="button"
                  accessibilityHint={
                    blockedByDriving
                      ? "Double tap to learn why this module is locked while moving."
                      : unsupportedRoute
                      ? "Double tap to learn why this module is unavailable."
                      : disabledReason
                      ? "Double tap to learn why you do not have access."
                      : "Opens module."
                  }
                  testID={`mobile-module-${resolveNavigationKey(item)}`}
	                  onPress={() => {
	                    if (blockedByDriving) {
	                      showMobileNotice(strings.alerts.drivingLockedTitle, "This module is blocked while moving.");
	                      return;
	                    }
	                    if (unsupportedRoute) {
	                      showMobileNotice(
	                        "Unavailable module",
	                        "This module route is not supported in Field Ops."
	                      );
	                      return;
	                    }
	                    if (disabledReason) {
	                      showMobileNotice(disabledReason.title, disabledReason.message);
	                      return;
	                    }
	                    setSelectedId(item.id);
	                    setNavOpen(false);
	                  }}
                  style={({ pressed }) => [
                    styles.navItem,
                    selectedId === item.id && styles.navItemSelected,
                    pressed && !blocked && styles.navItemPressed,
                    blocked && styles.navItemDisabled,
                  ]}
                >
                  <Text style={styles.navItemLabel}>{item.label}</Text>
                  {blockedByDriving ? (
                    <Text style={styles.navItemBadge}>Locked while moving</Text>
                  ) : unsupportedRoute ? (
                    <Text style={styles.navItemBadge}>Unavailable</Text>
                  ) : disabledReason ? (
                    <Text style={styles.navItemBadge}>{disabledReason.badge}</Text>
                  ) : item.badge ? (
                    <Text style={styles.navItemBadge}>{item.badge}</Text>
                  ) : null}
                </Pressable>
              );
            })}
          </View>
        ))}
      </ScrollView>
    </View>
  );
  const viewPickerContent = (
    <View style={[styles.navModal, isWebPreview && styles.navModalWeb, navModalSafeAreaStyle]}>
      <View style={styles.navModalHeader}>
        <Text style={styles.navModalTitle}>Views</Text>
        <Pressable
          accessibilityRole="button"
          testID="mobile-view-picker-close"
          onPress={() => setViewPickerOpen(false)}
          style={({ pressed }) => [styles.navClose, pressed && styles.navClosePressed]}
        >
          <Text style={styles.navCloseText}>Close</Text>
        </Pressable>
      </View>
      <ScrollView contentContainerStyle={styles.navModalContent}>
        {availableViews.map((view) => (
          <Pressable
            key={view.id}
            accessibilityRole="button"
            testID={`mobile-view-${view.id}`}
            onPress={() => {
              setSelectedViewId(view.id);
              setViewPickerOpen(false);
            }}
            style={({ pressed }) => [
              styles.navItem,
              resolvedViewId === view.id && styles.navItemSelected,
              pressed && styles.navItemPressed,
            ]}
          >
            <Text style={styles.navItemLabel}>{view.label || view.id}</Text>
            {resolvedViewId === view.id ? (
              <Text style={styles.navItemBadge}>Selected</Text>
            ) : null}
          </Pressable>
        ))}
      </ScrollView>
    </View>
  );
  const composerContent = (
    <View
      style={[
        styles.navModal,
        styles.composerModal,
        isWebPreview && styles.navModalWeb,
        navModalSafeAreaStyle,
      ]}
    >
      <View style={styles.navModalHeader}>
        <View style={styles.screenHeaderText}>
          <Text style={styles.navModalTitle}>{composerIsSelfKyc ? (strings.selfKyc[String(composerCommand?.execution?.params?.category) as keyof typeof strings.selfKyc] ?? strings.selfKyc.title) : composerCopy?.title ?? composerCommand?.label ?? "Action input"}</Text>
          <Text style={styles.noticeSubtext}>
            {composerCopy?.description ?? "Provide required details before queueing this action."}
          </Text>
        </View>
        <Pressable
          accessibilityRole="button"
          testID="mobile-action-composer-close"
          onPress={resetComposer}
          disabled={composerSubmitting}
          style={({ pressed }) => [
            styles.navClose,
            composerSubmitting && styles.primaryButtonDisabled,
            pressed && styles.navClosePressed,
          ]}
        >
          <Text style={styles.navCloseText}>Close</Text>
        </Pressable>
      </View>
      <ScrollView
        contentContainerStyle={styles.navModalContent}
        keyboardShouldPersistTaps="handled"
      >
        {composerLookupQuery.isError ? (
          <View style={styles.noticeCard}>
            <Text style={styles.error}>Unable to load lookup values.</Text>
            <Text style={styles.mono}>{formatUnknownError(composerLookupQuery.error)}</Text>
          </View>
        ) : null}

        <ComposerReadiness result={composerReadiness}
          pending={composerSubmitting || isCapturingComposerArtifact || isCapturingComposerSignature}
          strings={strings} styles={styles} />
        {composerIsFinancial && composerFinancialContext?.requires_session ? (
          <View style={styles.composerField}>
            <Text style={styles.detailKey}>{strings.financialTasks.session}</Text>
            {composerFinancialContext.sessions.length === 0 ? <Text style={styles.error}>{strings.financialTasks.noSession}</Text> :
              composerFinancialContext.sessions.map((session, index) => (
                Platform.OS === "web" ? (
                  <View key={session.id} style={[styles.chip, composerFinancialSession === session.id && styles.navItemSelected]}>
                    {React.createElement("label", { style: { display: "flex", alignItems: "center", gap: 8 } },
                      React.createElement("input", {
                        type: "radio", name: "financial-task-session", value: session.id,
                        checked: composerFinancialSession === session.id, disabled: composerSubmitting,
                        onChange: () => setComposerFinancialSession(session.id),
                      }),
                      <Text style={styles.chipText}>{strings.financialTasks.session} {index + 1} · {session.opened_at}</Text>)}
                  </View>
                ) : (
                  <Pressable key={session.id} accessibilityRole="radio" disabled={composerSubmitting}
                    accessibilityState={{ checked: composerFinancialSession === session.id, disabled: composerSubmitting }}
                    onPress={() => setComposerFinancialSession(session.id)}
                    style={[styles.chip, composerFinancialSession === session.id && styles.navItemSelected]}>
                    <Text style={styles.chipText}>{strings.financialTasks.session} {index + 1} · {session.opened_at}</Text>
                  </Pressable>
                )
              ))}
          </View>
        ) : null}
        {composerFields.map((field) => {
          const value = String(composerValues[field.key] ?? "");
          const options =
            field.lookupCategory && composerLookupMap[field.lookupCategory]
              ? composerLookupMap[field.lookupCategory]
              : [];
          const loadingLookup = Boolean(
            field.lookupCategory &&
              composerLookupQuery.isFetching &&
              !composerLookupMap[field.lookupCategory]
          );

          return (
            <View key={field.key} style={styles.composerField}>
              <Text style={styles.detailKey}>
                {composerIsFinancial && field.key === "amount" ? strings.financialTasks.amount : composerFinancialEvidence && field.key === "supervisor_name" ? strings.financialTasks.supervisorAnnotation : composerIsSelfKyc ? (strings.selfKyc[field.key as keyof typeof strings.selfKyc] ?? field.label) : field.label}
                {field.required ? " *" : ""}
              </Text>
              {field.type === "lookup" ? (
                <>
                  {loadingLookup ? (
                    <View style={styles.loadingRow}>
                      <ActivityIndicator size="small" />
                      <Text style={styles.noticeSubtext}>Loading options...</Text>
                    </View>
                  ) : options.length ? (
                    <View style={styles.screenActionsRow}>
                      {options.map((option) => (
                        <Pressable
                          key={`${field.key}:${option.value}`}
                          testID={`mobile-action-composer-option-${field.key}-${option.value}`}
                          onPress={() => setComposerFieldValue(field.key, option.value)}
                          disabled={composerSubmitting}
                          style={({ pressed }) => [
                            styles.chip,
                            value === option.value && styles.navItemSelected,
                            composerSubmitting && styles.primaryButtonDisabled,
                            pressed && styles.navItemPressed,
                          ]}
                        >
                          <Text style={styles.chipText}>{composerIsSelfKyc ? (strings.selfKyc[option.value as keyof typeof strings.selfKyc] ?? option.label) : option.label}</Text>
                          {option.description ? <Text style={styles.noticeSubtext}>{option.description}</Text> : null}
                        </Pressable>
                      ))}
                    </View>
                  ) : (
                    <Text style={styles.noticeSubtext}>No options are available.</Text>
                  )}
                  {value ? (
                    <Text style={styles.noticeSubtext}>
                      Selected:{" "}
                      {options.find((entry) => entry.value === value)?.label ?? value}
                    </Text>
                  ) : null}
                </>
              ) : (
                <TextInput
                  value={value}
                  onChangeText={(next) => setComposerFieldValue(field.key, next)}
                  placeholder={field.placeholder ?? undefined}
                  testID={`mobile-action-composer-field-${field.key}`}
                  accessibilityLabel={composerIsFinancial && field.key === "amount" ? strings.financialTasks.amount : composerFinancialEvidence && field.key === "supervisor_name" ? strings.financialTasks.supervisorAnnotation : composerIsSelfKyc ? (strings.selfKyc[field.key as keyof typeof strings.selfKyc] ?? field.label) : field.label}
                  keyboardType={field.type === "number" ? "numeric" : "default"}
                  style={[
                    styles.input,
                    styles.composerInput,
                    field.type === "textarea" && styles.composerTextarea,
                  ]}
                  editable={!composerSubmitting}
                  multiline={field.type === "textarea"}
                  textAlignVertical={field.type === "textarea" ? "top" : "center"}
                />
              )}
            </View>
          );
        })}


        {composerSelfEvidence ? (
          <View style={styles.noticeCard}>
            <Text style={styles.noticeText}>{strings.selfKyc.title}</Text>
            <Text style={styles.noticeSubtext}>{strings.selfKyc.subtitle}</Text>
            <Text testID="mobile-self-kyc-evidence-count" style={styles.noticeSubtext}>{composerArtifacts.length} / {composerArtifactMaxItems}</Text>
            <Pressable testID="mobile-self-kyc-open-camera"
              {...mobileActionAccessibility(undefined, composerSubmitting || isCapturingComposerArtifact, composerSubmitting || isCapturingComposerArtifact)}
              disabled={composerSubmitting || isCapturingComposerArtifact}
              onPress={() => setComposerCameraOpen(current => !current)} style={styles.secondaryButton}>
              <Text>{composerCameraOpen ? strings.selfKyc.closeCamera : strings.selfKyc.openCamera}</Text>
            </Pressable>
            {composerCameraOpen ? (
              <View style={styles.cameraFrame}>
                {composerCameraPermission?.granted
                  ? <CameraView ref={composerCameraRef} style={styles.camera} />
                  : <Pressable accessibilityRole="button" onPress={() => {
                      if (composerCameraPermission?.canAskAgain === false) void openSystemSettingsSafe();
                      else void requestComposerCameraPermission();
                    }}><Text>{strings.selfKyc.permission}</Text></Pressable>}
              </View>
            ) : null}
            <Pressable testID="mobile-self-kyc-capture"
              {...mobileActionAccessibility(undefined, !composerCameraOpen || composerSubmitting || isCapturingComposerArtifact || composerArtifacts.length >= composerArtifactMaxItems, composerSubmitting || isCapturingComposerArtifact)}
              disabled={!composerCameraOpen || composerSubmitting || isCapturingComposerArtifact || composerArtifacts.length >= composerArtifactMaxItems}
              onPress={() => { void captureComposerArtifact(); }} style={styles.primaryButton}>
              <Text>{isCapturingComposerArtifact ? strings.selfKyc.capturing : strings.selfKyc.capture}</Text>
            </Pressable>
            {composerArtifacts.map(artifact => (
              <View key={artifact.artifactId} style={styles.detailRow}>
                <Text>{artifact.evidenceTag || strings.selfKyc.document}</Text>
                <Pressable accessibilityRole="button" disabled={composerSubmitting || isCapturingComposerArtifact}
                  onPress={() => removeComposerArtifact(artifact.artifactId)}>
                  <Text>{strings.selfKyc.remove}</Text>
                </Pressable>
              </View>
            ))}
          </View>
        ) : null}

        {composerSupportsPod || composerFinancialEvidence || composerIsIncident ? (
          <View style={styles.noticeCard}>
            <Text style={styles.noticeText}>{composerFinancialEvidence ? strings.financialTasks.optionalPhoto : "Proof and evidence"}</Text>
            {composerSupportsPod ? <>
            {composerPodPolicyState.pending ? (
              <Text style={styles.noticeSubtext}>Loading proof policy...</Text>
            ) : composerPodPolicyState.unavailable ? (
              <Text style={styles.noticeSubtext}>
                {POD_POLICY_UNAVAILABLE_MESSAGE}
              </Text>
            ) : (
              <>
                <Text style={styles.noticeSubtext}>
                  Required photos: {composerPhotoRequired ? "yes" : "no"} - Minimum items:{" "}
                  {composerMinArtifactCount}
                </Text>
                <Text style={[styles.noticeSubtext, { marginTop: 4 }]}>
                  Captured: {composerArtifacts.length} / {composerArtifactMaxItems}
                </Text>
                {composerSignatureRequired ? (
                  <Text style={[styles.noticeSubtext, { marginTop: 4 }]}>
                    Signature required: {composerSignatureArtifact ? "saved" : "capture and save"}
                  </Text>
                ) : null}
                {composerOtpRequired ? (
                  <Text style={[styles.noticeSubtext, { marginTop: 4 }]}>
                    Recipient OTP: {sanitizeOtpCode(composerValues.otp_code) ? "entered" : "required"}
                  </Text>
                ) : null}
                {composerIdentityRequired ? (
                  <Text style={[styles.noticeSubtext, { marginTop: 4 }]}>
                    Recipient identity:{" "}
                    {coerceValueText(composerValues.recipient_identity_kind) &&
                    sanitizeIdentityLast4(composerValues.recipient_identity_last4)
                      ? "captured"
                      : "type and last 4 required"}
                  </Text>
                ) : null}
              </>
            )}
            </> : null}
            <View style={[styles.screenActionsRow, { marginTop: 10 }]}>
              <Pressable
                testID="mobile-action-composer-open-proof-camera"
                {...mobileActionAccessibility(undefined, composerSubmitting || composerArtifacts.length >= composerArtifactMaxItems, composerSubmitting || isCapturingComposerArtifact)}
                onPress={() => setComposerCameraOpen((current) => !current)}
                disabled={composerSubmitting || composerArtifacts.length >= composerArtifactMaxItems}
                style={({ pressed }) => [
                  styles.secondaryButton,
                  (composerSubmitting || composerArtifacts.length >= composerArtifactMaxItems) &&
                    styles.primaryButtonDisabled,
                  pressed && styles.navItemPressed,
                ]}
              >
                <Text style={styles.secondaryButtonText}>
                  {composerCameraOpen ? strings.selfKyc.closeCamera : strings.selfKyc.openCamera}
                </Text>
              </Pressable>
              <Pressable
                testID="mobile-action-composer-capture-proof"
                {...mobileActionAccessibility(undefined, !composerCameraOpen || composerSubmitting || isCapturingComposerArtifact, composerSubmitting || isCapturingComposerArtifact)}
                onPress={() => {
                  void captureComposerArtifact();
                }}
                disabled={!composerCameraOpen || composerSubmitting || isCapturingComposerArtifact}
                style={({ pressed }) => [
                  styles.primaryButton,
                  (!composerCameraOpen || composerSubmitting || isCapturingComposerArtifact) &&
                    styles.primaryButtonDisabled,
                  pressed &&
                    composerCameraOpen &&
                    !composerSubmitting &&
                    !isCapturingComposerArtifact &&
                    styles.primaryButtonPressed,
                ]}
              >
                <Text style={styles.primaryButtonText}>
                  {isCapturingComposerArtifact ? strings.selfKyc.capturing : strings.selfKyc.capture}
                </Text>
              </Pressable>
            </View>
            {composerSupportsPod ? <View style={[styles.noticeCard, { marginTop: 10 }]}>
              <Text style={styles.noticeText}>Recipient signature</Text>
              <Text style={styles.noticeSubtext}>
                {composerSignatureArtifact
                  ? `Saved signature: ${composerSignatureArtifact.storageKey}`
                  : composerSignatureRequired
                    ? "Signature is required for this action."
                    : "Signature is optional for this action."}
              </Text>
              <View
                style={[styles.signatureCanvas, { marginTop: 10 }]}
                onLayout={(event) => {
                  const { width, height } = event.nativeEvent.layout;
                  if (!width || !height) return;
                  setComposerSignatureLayout((current) =>
                    current.width === width && current.height === height ? current : { width, height }
                  );
                }}
                {...composerSignatureResponder.panHandlers}
              >
                {composerSignatureSegments.length ? null : (
                  <Text style={styles.signaturePlaceholder}>Sign here</Text>
                )}
                {composerSignatureSegments.map((segment) => (
                  <View
                    key={segment.key}
                    pointerEvents="none"
                    style={[
                      styles.signatureStroke,
                      {
                        left: segment.left,
                        top: segment.top,
                        width: segment.width,
                        transform: [{ rotate: segment.angle }],
                      },
                    ]}
                  />
                ))}
              </View>
              <View style={[styles.screenActionsRow, { marginTop: 10 }]}>
                <Pressable
                  testID="mobile-action-composer-clear-signature"
                  onPress={clearComposerSignature}
                  disabled={composerSubmitting || !composerSignaturePresent}
                  style={({ pressed }) => [
                    styles.secondaryButton,
                    (composerSubmitting || !composerSignaturePresent) && styles.primaryButtonDisabled,
                    pressed && styles.navItemPressed,
                  ]}
                >
                  <Text style={styles.secondaryButtonText}>Clear pad</Text>
                </Pressable>
                <Pressable
                  testID="mobile-action-composer-capture-signature"
                  onPress={() => {
                    void captureComposerSignature();
                  }}
                  disabled={composerSubmitting || isCapturingComposerSignature || !composerSignaturePresent}
                  style={({ pressed }) => [
                    styles.primaryButton,
                    (composerSubmitting || isCapturingComposerSignature || !composerSignaturePresent) &&
                      styles.primaryButtonDisabled,
                    pressed &&
                      !composerSubmitting &&
                      !isCapturingComposerSignature &&
                      composerSignaturePresent &&
                      styles.primaryButtonPressed,
                  ]}
                >
                  <Text style={styles.primaryButtonText}>
                    {isCapturingComposerSignature ? "Saving..." : "Save signature"}
                  </Text>
                </Pressable>
              </View>
            </View> : null}
            {composerCameraOpen ? (
              <View style={[styles.cameraFrame, { marginTop: 10 }]}>
                {composerCameraPermission?.granted ? (
                  <CameraView ref={composerCameraRef} style={styles.camera} />
                ) : (
                  <View style={styles.noticeCard}>
                    <Text style={styles.noticeText}>Camera permission required.</Text>
                    <Text style={styles.noticeSubtext}>
                      {composerCameraPermission?.canAskAgain === false
                        ? "Camera permission was denied. Open settings to grant proof capture access."
                        : "Grant camera access to capture proof photos."}
                    </Text>
                    <Pressable
                      accessibilityRole="button"
                      accessibilityHint={composerCameraPermission?.canAskAgain === false ? strings.actionAccessibility.settingsCamera : strings.actionAccessibility.grantCamera}
                      onPress={() => {
                        if (composerCameraPermission?.canAskAgain === false) {
                          void openSystemSettingsSafe();
                          return;
                        }
                        void requestComposerCameraPermission();
                      }}
                      style={({ pressed }) => [styles.secondaryButton, pressed && styles.navItemPressed]}
                    >
                      <Text style={styles.secondaryButtonText}>
                        {composerCameraPermission?.canAskAgain === false ? "Open settings" : "Grant permission"}
                      </Text>
                    </Pressable>
                  </View>
                )}
              </View>
            ) : null}
            {composerArtifacts.length ? (
              <View style={{ marginTop: 10 }}>
                <Text style={styles.noticeSubtext}>Captured evidence</Text>
                {composerArtifacts.map((artifact, index) => (
                  <View
                    key={artifact.artifactId}
                    style={[
                      styles.detailRow,
                      { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
                    ]}
                  >
                    <View style={{ flex: 1, paddingRight: 12 }}>
                      <Text style={styles.detailKey}>
                        {artifact.kind === "signature" ? "Signature" : `Photo ${index + 1}`}
                      </Text>
                      <Text style={styles.noticeSubtext} numberOfLines={1}>
                        {artifact.storageKey}
                      </Text>
                    </View>
                    <Pressable
                      onPress={() => removeComposerArtifact(artifact.artifactId)}
                      style={({ pressed }) => [styles.secondaryButton, pressed && styles.navItemPressed]}
                    >
                      <Text style={styles.secondaryButtonText}>Remove</Text>
                    </Pressable>
                  </View>
                ))}
              </View>
            ) : null}
          </View>
        ) : null}

        {composerEvidenceRows.some(row => row.phase !== "registered") ? (
          <View testID="mobile-pending-evidence" style={styles.noticeCard}>
            <Text>{strings.pendingEvidence.title}</Text>
            {composerEvidenceRows.filter(row => row.phase !== "registered").map(row => (
              <View key={row.id} style={styles.detailRow}>
                <Text>{row.kind === "signature" ? strings.pendingEvidence.signature : strings.pendingEvidence.photo}</Text>
                <Text accessibilityRole="alert">{row.phase === "uploading" ? strings.pendingEvidence.uploadUnconfirmed
                  : row.errorCode ? strings.pendingEvidence.failed : strings.pendingEvidence.pending}</Text>
                <Pressable accessibilityRole="button" testID={`evidence-retry-${row.id}`}
                  disabled={composerEvidenceBusy || composerSubmitting || row.permanent || row.phase === "uploading"}
                  onPress={() => { void recoverComposerEvidence(row.id); }} style={styles.secondaryButton}>
                  <Text>{strings.pendingEvidence.retry}</Text>
                </Pressable>
                <Pressable accessibilityRole="button" testID={`evidence-discard-${row.id}`}
                  disabled={composerEvidenceBusy || composerSubmitting}
                  onPress={() => { void recoverComposerEvidence(row.id, true); }} style={styles.secondaryButton}>
                  <Text>{strings.pendingEvidence.discard}</Text>
                </Pressable>
              </View>
            ))}
          </View>
        ) : null}
        {composerError ? <Text accessibilityRole="alert" accessibilityLiveRegion="polite" style={styles.error}>{composerError}</Text> : null}

        <View style={styles.screenActionsRow}>
          <Pressable
            testID="mobile-action-composer-cancel"
            onPress={resetComposer}
            disabled={composerSubmitting}
            style={({ pressed }) => [
              styles.secondaryButton,
              composerSubmitting && styles.primaryButtonDisabled,
              pressed && styles.navItemPressed,
            ]}
          >
            <Text style={styles.secondaryButtonText}>Cancel</Text>
          </Pressable>
          <Pressable
            testID="mobile-action-composer-queue"
            accessibilityRole="button"
            onPress={() => {
              void submitComposer();
            }}
            disabled={
              composerSubmitting ||
              composerLookupQuery.isFetching ||
              composerPodPolicyState.submitDisabled
            }
            style={({ pressed }) => [
              styles.primaryButton,
              (composerSubmitting ||
                composerLookupQuery.isFetching ||
                composerPodPolicyState.submitDisabled) &&
                styles.primaryButtonDisabled,
              pressed &&
                !composerSubmitting &&
                !composerLookupQuery.isFetching &&
                !composerPodPolicyState.submitDisabled &&
                styles.primaryButtonPressed,
            ]}
          >
            <Text style={styles.primaryButtonText}>
              {composerSubmitting ? strings.scan.queueing : "Queue action"}
            </Text>
          </Pressable>
        </View>
      </ScrollView>
    </View>
  );

  return (
    <FieldOpsStylesContext.Provider value={styles}>
    <ThemeProvider value={themeContextValue}>
      <View style={isWebPreview ? styles.webViewport : styles.pageRoot}>
        <View style={[styles.page, appDirectionStyle, isWebPreview && styles.pageWeb]}>
        <View style={[styles.header, headerSafeAreaStyle]}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Open modules menu"
          testID={FIELDOPS_NATIVE_E2E_TEST_IDS.menuToggle}
          onPress={() => setNavOpen(true)}
          style={({ pressed }) => [styles.menuButton, pressed && styles.menuButtonPressed]}
        >
          <Text style={styles.menuButtonText}>{"\u2630"}</Text>
        </Pressable>
        <View style={styles.headerText}>
          <Text style={styles.headerTitle}>{shellHeaderTitle}</Text>
        </View>
        <View style={styles.headerRight}>
          <View
            style={[
              styles.headerPillRow,
              connectivityStatus === "degraded"
                ? styles.headerPillRowDegraded
                : connectivityStatus === "offline"
                  ? styles.headerPillRowOffline
                  : styles.headerPillRowOnline,
            ]}
          >
            <View
              style={[
                styles.headerPillDot,
                connectivityStatus === "degraded"
                  ? styles.headerPillDotDegraded
                  : connectivityStatus === "offline"
                    ? styles.headerPillDotOffline
                    : styles.headerPillDotOnline,
              ]}
            />
            <Text style={styles.headerPillText}>{connectivityStatusLabel}</Text>
          </View>
          <Text style={styles.headerPill}>{strings.shell.outboxLabel}: {outboxCount}</Text>
          <Pressable
            onLongPress={handleSignOut}
            delayLongPress={500}
            style={({ pressed }) => [styles.avatar, pressed && styles.avatarPressed]}
            accessibilityLabel={`Role ${userRoleLabel}. Long press to sign out.`}
          >
            <Text style={styles.avatarText}>{userRoleCode}</Text>
          </Pressable>
        </View>
      </View>
      {shouldShowConnectivityBanner ? (
        <View
          accessible
          accessibilityRole="alert"
          accessibilityLiveRegion="polite"
          accessibilityLabel={`${connectivityStatus === "offline" ? strings.shell.offlineMode : strings.shell.degradedTitle}. ${connectivitySummary}`}
          style={[
            styles.connectivityBanner,
            connectivityStatus === "offline"
              ? styles.connectivityBannerOffline
              : styles.connectivityBannerDegraded,
          ]}
        >
          <Text style={styles.connectivityBannerTitle}>
            {connectivityStatus === "offline" ? strings.shell.offlineMode : strings.shell.degradedTitle}
          </Text>
          <Text style={styles.connectivityBannerText}>{connectivitySummary}</Text>
        </View>
      ) : null}

      {isWebPreview ? (
        isNavVisible ? (
          <View style={styles.drawerWebOverlay}>
            <View style={styles.drawerWebPanelWrap}>{drawerContent}</View>
            <Pressable style={styles.drawerScrimWeb} onPress={() => setNavOpen(false)} />
          </View>
        ) : null
      ) : (
        <Modal
          animationType="slide"
          transparent
          visible={isNavVisible}
          onRequestClose={() => setNavOpen(false)}
        >
          <View style={styles.drawerBackdrop}>
            {drawerContent}
            <Pressable style={styles.drawerScrim} onPress={() => setNavOpen(false)} />
          </View>
        </Modal>
      )}

      {isWebPreview ? (
        viewPickerOpen ? (
          <View style={styles.navModalWebOverlay}>
            <Pressable
              style={styles.navModalBackdropTap}
              onPress={() => setViewPickerOpen(false)}
            />
            {viewPickerContent}
          </View>
        ) : null
      ) : (
        <Modal
          animationType="slide"
          transparent
          visible={viewPickerOpen}
          onRequestClose={() => setViewPickerOpen(false)}
        >
          <View style={styles.navModalBackdrop}>
            <Pressable
              style={styles.navModalBackdropTap}
              onPress={() => setViewPickerOpen(false)}
            />
            {viewPickerContent}
          </View>
        </Modal>
      )}
      {isWebPreview ? (
        composerCommand ? (
          <View style={styles.navModalWebOverlay}>
            <Pressable style={styles.navModalBackdropTap} onPress={resetComposer} />
            {composerContent}
          </View>
        ) : null
      ) : (
        <Modal
          animationType="slide"
          transparent
          visible={Boolean(composerCommand)}
          onRequestClose={resetComposer}
        >
          <View style={styles.navModalBackdrop}>
            <Pressable style={styles.navModalBackdropTap} onPress={resetComposer} />
            {composerContent}
          </View>
        </Modal>
      )}

      {hasResourceView ? (
        <View style={[styles.content, contentSafeAreaStyle]}>
          <View style={styles.resourceHeader}>
            <View style={styles.resourceHeaderText}>
              <Text style={styles.resourceTitle}>{resourceHeaderTitle}</Text>
              <Text style={styles.resourceSubtitle}>{resourceHeaderSubtitle}</Text>
            </View>
            <View style={styles.screenHeaderActions}>
              {isRouteSurface ? (
                <View
                  style={[
                    styles.routeStatusBadge,
                    routeSummary?.status === "done"
                      ? styles.routeStatusBadgeDone
                      : routeSummary?.status === "in_progress"
                        ? styles.routeStatusBadgeActive
                        : null,
                  ]}
                >
                  <Text style={styles.routeStatusBadgeText}>
                    {routeSummary?.status ?? "idle"}
                  </Text>
                </View>
              ) : null}
              <Pressable
                onPress={() => syncMutation.mutate()}
                accessibilityRole="button"
                accessibilityLabel={syncMutation.isPending ? strings.shell.syncing : strings.shell.syncNow}
                accessibilityState={{ disabled: syncMutation.isPending, busy: syncMutation.isPending }}
                aria-busy={syncMutation.isPending}
                disabled={syncMutation.isPending}
                style={({ pressed }) => [
                  styles.syncNowButton,
                  syncMutation.isPending && styles.syncButtonDisabled,
                  pressed && styles.syncButtonPressed,
                ]}
              >
                <Text style={styles.syncButtonText}>
                  {syncMutation.isPending ? strings.shell.syncing : strings.shell.syncNow}
                </Text>
              </Pressable>
            </View>
          </View>
          {drivingModeLocked ? (
            <View style={styles.drivingLockBanner}>
              <Text style={styles.drivingLockTitle}>Driving mode lock active</Text>
              <Text style={styles.drivingLockText}>
                Speed {Math.round(drivingSafetyState.speedKph)} kph exceeds threshold{" "}
                {drivingSafetyState.thresholdKph} kph. Stop to open details.
              </Text>
            </View>
          ) : null}

              {availableActions.some(command => command.selection?.mode === "none" || Boolean(selectedResourceId)) ? (
                <View style={styles.actionsBar}>
                  {availableActions.filter(command => command.selection?.mode === "none" || Boolean(selectedResourceId)).map((command) => {
                    const actionKey = resolveActionLockKey(command);
                    const actionLocked = isActionLocked(actionKey);
                    const commandCopy = resolveComposerCommandCopy(command, selectedStopSnapshot);
                    const commandLabel = command.execution?.input_schema?.normalization === "self_kyc_v1" ? (strings.selfKyc[String(command.execution?.params?.category) as keyof typeof strings.selfKyc] ?? command.label) : commandCopy?.label ?? command.label;
                    const needsInput = resolveCommandInputFields(command, selectedStopSnapshot).length > 0;

                    return (
                      <Pressable
                        key={command.key}
                        testID={`mobile-action-${command.key}`}
                        accessibilityRole="button"
                        accessibilityState={{ disabled: drivingModeLocked || actionLocked, busy: actionLocked }}
                        aria-busy={actionLocked}
                        onPress={() => {
                          if (drivingModeLocked) {
                            Alert.alert(strings.alerts.drivingLockedTitle, strings.alerts.drivingLockedMessage);
                            return;
                          }
                          handleActionPress(command);
                        }}
                        disabled={drivingModeLocked || actionLocked}
                        style={({ pressed }) => [
                          styles.actionButton,
                          (drivingModeLocked || actionLocked) && styles.syncButtonDisabled,
                          pressed && styles.navItemPressed,
                        ]}
                      >
                        <Text style={styles.actionButtonText}>
                          {needsInput ? `${commandLabel}...` : commandLabel}
                        </Text>
                      </Pressable>
                    );
                  })}
                </View>
              ) : null}

          {isRouteSurface && !selectedResourceId ? (
            <>
              <View style={styles.screenActionsRow}>
                {displayedRoute.routeRunIds.map((routeRunId) => (
                  <Pressable key={routeRunId} accessibilityRole="button"
                    accessibilityLabel={routeRunId}
                    accessibilityState={{ selected: displayedRoute.routeRunId === routeRunId, disabled: drivingModeLocked }}
                    disabled={drivingModeLocked}
                    onPress={() => {
                      if (!drivingModeLocked) setDisplayedRoutePreference({ scope: displayedRouteScope, routeRunId });
                    }}
                    style={({ pressed }) => [styles.chip,
                      displayedRoute.routeRunId === routeRunId && styles.navItemSelected,
                      pressed && styles.navItemPressed]}>
                    <Text style={styles.chipText}>{routeRunId}</Text>
                  </Pressable>
                ))}
              </View>
              {routeExecutionManifestQuery.data ? (
                <View style={styles.noticeCard}>
                  <RouteManifestReadback manifest={routeExecutionManifestQuery.data} />
                </View>
              ) : null}
            </>
          ) : null}

          {selectedResourceId ? (
            <View style={styles.detailWrapper}>
              <View style={styles.detailHeader}>
                <Pressable
                  onPress={() => {
                    setSelectedResourceId(null);
                    setSelectedResourceKey(null);
                  }}
                  style={styles.detailBack}
                >
                  <Text style={styles.syncButtonText}>{strings.shell.back}</Text>
                </Pressable>
                <View style={styles.detailHeaderText}>
                  <Text style={styles.detailTitle}>
                    {selectedResourceTitle ?? selectedResourceId}
                  </Text>
                  <Text style={styles.detailSubtitle}>
                    {selectedStopSnapshot?.place ??
                      selectedStopSnapshot?.reference ??
                      resourceHeaderSubtitle}
                  </Text>
                </View>
              </View>

              {detailQuery.isLoading ? (
                <Text style={styles.subtitle}>Loading details...</Text>
              ) : detailQuery.isError ? (
                <View>
                  <Text style={styles.error}>Failed to load details.</Text>
                  <Text style={styles.mono}>{formatUnknownError(detailQuery.error)}</Text>
                </View>
              ) : detailQuery.data?.detail ? (
                <ScrollView contentContainerStyle={styles.detailContent}>
                  <Text style={styles.listMetaText}>
                    Source:{" "}
                    {detailQuery.data.source === "cache" ? "cached" : "network"}
                  </Text>
                  {(isRouteSurface || isTasksSurface) && selectedRouteRunId && detailResource && selectedResourceId ? (
                    <Pressable
                      testID="mobile-route-location"
                      style={styles.secondaryButton}
                      accessibilityRole="button"
                      disabled={drivingModeLocked || !me?.user?.id}
                      accessibilityState={{ disabled: drivingModeLocked || !me?.user?.id }}
                      onPress={() => {
                        if (drivingModeLocked || !me?.user?.id || !selectedRouteRunId || !detailResource || !selectedResourceId) return;
                        const item = findFirstEnabledNavItemByKey(navigation.sections, "location");
                        if (!item?.id) return;
                        setRouteLocationContext({
                          resource: detailResource, resourceId: selectedResourceId,
                          actorId: me.user.id, routeRunId: selectedRouteRunId,
                          routeStopId: selectedRouteContext?.routeStopId ?? null,
                        });
                        setSelectedId(item.id);
                      }}
                    ><Text style={styles.secondaryButtonText}>{strings.scan.routeLocationCapture}</Text></Pressable>
                  ) : null}
                  {isRouteSurface || isTasksSurface ? (
                    <RouteSurfaceDetailExtensions
                      key={selectedRouteRunId ?? selectedResourceId}
                      strings={strings}
                      detail={detailQuery.data.detail}
                      resourceId={selectedResourceId}
                      surfaceLabel={isRouteSurface ? strings.detail.routeStop : strings.detail.taskStop}
                      diagnosticsEnabled={diagnosticsEnabled}
                      interactionLocked={drivingModeLocked}
                      addressActionStrings={strings.addressActions}
                      addressPolicy={addressPolicy}
                      communicationPolicy={detailCommunicationPolicy}
                      navigationPolicy={navigationPolicy}
                      platform={effectiveMobilePlatform}
                      routeExecutionManifest={routeExecutionManifestQuery.data}
                      routeLoadStrings={strings.routeLoad}
                      routeLoadQueueReady={outboxInitSuccess}
                      onRouteLoadAction={handleRouteLoadAction}
                      isConfirmingRouteDeparture={confirmRouteDepartureMutation.isPending}
                      departureRequestState={routeDepartureRequestState(departureRequestQuery.data)}
                      onEnqueueUiEvents={enqueueUiEvents}
                      onOpenScan={() => {
                        if (!detailQuery.data?.detail) return;
                        setScanContext(extractScanContext(detailQuery.data.detail, selectedResourceId));
                        openModuleByKey("scan");
                      }}
                      onOpenRouteScan={() => {
                        if (!selectedRouteRunId) return;
                        setScanContext({
                          label:
                            selectedResourceTitle ??
                            selectedStopSnapshot?.reference ??
                            selectedStopSnapshot?.customerName ??
                            "Route load scan",
                          resourceId: selectedRouteRunId,
                          taskId: null,
                          routeRunId: selectedRouteRunId,
                          routeStopId: null,
                          shipmentId: null,
                          clientId: null,
                          opsSessionId:
                            activeDriverShift?.opsSessionId ?? selectedRouteContext?.opsSessionId ?? null,
                          reference: selectedStopSnapshot?.reference ?? null,
                          customerName: null,
                        });
                        openModuleByKey("scan");
                      }}
                      onConfirmRouteDeparture={handleConfirmRouteDeparture}
                    />
                  ) : null}
                  {isSettlementsSurface ? (
                    <SettlementSurfaceDetailExtensions
                      strings={strings}
                      detail={detailQuery.data.detail}
                      fallbackId={selectedResourceId}
                      diagnosticsEnabled={diagnosticsEnabled}
                      interactionLocked={drivingModeLocked}
                      uxSafetyPolicy={uxSafetyPolicy}
                      onSubmitCount={handleSettlementCountSubmit}
                    />
                  ) : null}
                  {completionReadbackQuery.isError || (completionReadbackQuery.data !== null && completionReadbackQuery.data !== undefined) ? (
                    <View style={[styles.noticeCard, { marginTop: 12 }]}>
                      <Text style={styles.noticeSubtext}>{completionReadbackVerified
                        ? (completionReadbackQuery.data?.kind === "financial_amount_v1" ? strings.financialTasks.accepted : strings.actionFeedback.verifiedReadback) : strings.actionFeedback.pendingReadback}</Text>
                      {completionReadbackVerified && completionReadbackQuery.data?.settlementStatus ?
                        <Text style={styles.noticeSubtext}>{strings.financialTasks.settlementStatus}: {completionReadbackQuery.data.settlementStatus}</Text> : null}
                      <Pressable accessibilityRole="button"
                        onPress={() => { void completionReadbackQuery.refetch(); }}>
                        <Text>{strings.actionFeedback.refreshReadback}</Text>
                      </Pressable>
                    </View>
                  ) : null}
                  {incidentDisplayState === "error" && resource === "tasks" && selectedResourceId ? (
                    <View style={[styles.noticeCard, { marginTop: 12 }]}>
                      <Text style={styles.noticeSubtext}>{strings.actionFeedback.incidentPending}</Text>
                      <Pressable accessibilityRole="button" onPress={() => { void incidentReadbackQuery.refetch(); }}>
                        <Text>{strings.actionFeedback.refreshReadback}</Text>
                      </Pressable>
                    </View>
                  ) : null}
                  {incidentReadbackQuery.data?.map(outcome => (
                    <View key={outcome.record.queueId} style={[styles.noticeCard, { marginTop: 12 }]}>
                      <Text style={styles.noticeSubtext}>{outcome.verified && incidentDisplayState === "verified"
                        ? strings.actionFeedback.incidentVerified : strings.actionFeedback.incidentPending}</Text>
                      {outcome.verified && incidentDisplayState === "verified" ? (
                        <>
                          <Text style={styles.noticeSubtext}>{strings.actionFeedback.incidentStatement(
                            String(asRecord(outcome.proof?.incident).type),
                            String(asRecord(outcome.proof?.incident).summary))}</Text>
                          <Text style={styles.noticeSubtext}>{strings.actionFeedback.incidentDetails(
                            String(asRecord(outcome.proof?.incident_task).id),
                            String(asRecord(outcome.proof?.incident_task).status),
                            String(asRecord(outcome.proof?.incident_task).task_event_id),
                            (asRecord(outcome.proof?.incident).artifact_ids as unknown[]).length,
                            String(outcome.proof?.route_stop_id),
                            String(asRecord(outcome.proof?.source_task).status))}</Text>
                        </>
                      ) : null}
                      <Pressable accessibilityRole="button" onPress={() => { void incidentReadbackQuery.refetch(); }}>
                        <Text>{strings.actionFeedback.refreshReadback}</Text>
                      </Pressable>
                    </View>
                  ))}
                  {lastActionReceipt && lastActionReceipt.resourceId === selectedResourceId ? (
                    <View style={[styles.noticeCard, { marginTop: 12 }]}>
                      <Text style={styles.noticeText}>Last action receipt</Text>
                      <Text style={styles.noticeSubtext}>{formatMobileActionReceipt(lastActionReceipt, strings)}</Text>
                      <Text style={[styles.noticeSubtext, { marginTop: 4 }]}>
                        Recorded: {lastActionReceipt.recordedAt}
                      </Text>
                    </View>
                  ) : null}
                </ScrollView>
              ) : (
                <Text style={styles.subtitle}>No details are available.</Text>
              )}


            </View>
          ) : (
            <View style={styles.listPane}>
              {liveSourceSelection.state === "ready" ? (
                <View style={styles.noticeCard}>
                  <Text style={styles.noticeText}>Live operations · {effectiveActiveRole?.label}</Text>
                  {liveRegistryQuery.isError || liveOperationsQuery.isError ? (
                    <Text style={styles.error}>Live sources could not be loaded.</Text>
                  ) : liveOperationsQuery.isLoading || !liveOperationsQuery.data ? (
                    <Text style={styles.noticeSubtext}>Loading scoped live sources...</Text>
                  ) : liveOperationsQuery.data.state === "empty" ? (
                    <Text style={styles.noticeSubtext}>No visible live records in this scope.</Text>
                  ) : liveOperationsQuery.data.state === "absent" ? (
                    <Text style={styles.noticeSubtext}>Live sources are not available for this scope.</Text>
                  ) : (
                    <View>
                      <Text style={styles.noticeSubtext}>Work: {liveOperationsQuery.data.work.state} · returned visible items: {liveOperationsQuery.data.work.visibleCount ?? "Unavailable"}</Text>
                      <Text style={styles.noticeSubtext}>Pickup: {liveOperationsQuery.data.pickup.state}</Text>
                      <Text style={styles.noticeSubtext}>Pickup identity: {liveOperationsQuery.data.pickup.id ?? "Unavailable"}</Text>
                      <Text style={styles.noticeSubtext}>Window: {liveOperationsQuery.data.pickup.windowStartAt ?? "Unavailable"} – {liveOperationsQuery.data.pickup.windowEndAt ?? "Unavailable"}</Text>
                      <Text style={styles.noticeSubtext}>Expected / picked: {liveOperationsQuery.data.pickup.expectedCount ?? "Unavailable"} / {liveOperationsQuery.data.pickup.pickedCount ?? "Unavailable"}</Text>
                      <Text style={styles.noticeSubtext}>Pickup seal: {liveOperationsQuery.data.pickup.seal ?? "Unavailable"}</Text>
                      <Text style={styles.noticeSubtext}>Pickup failures: {liveOperationsQuery.data.pickup.failureCount ?? "Unavailable"}</Text>
                      <Text style={styles.noticeSubtext}>Trip: {liveOperationsQuery.data.trip.id ?? "Unavailable"} · {liveOperationsQuery.data.trip.stage ?? liveOperationsQuery.data.trip.state}</Text>
                      <Text style={styles.noticeSubtext}>Endpoints: {liveOperationsQuery.data.trip.origin ?? "Unavailable"} → {liveOperationsQuery.data.trip.destination ?? "Unavailable"}</Text>
                      <Text style={styles.noticeSubtext}>Timing / ETA: {liveOperationsQuery.data.trip.plannedStartAt ?? liveOperationsQuery.data.trip.startedAt ?? "Unavailable"} / {liveOperationsQuery.data.trip.eta ?? "Unavailable"}</Text>
                      <Text style={styles.noticeSubtext}>Driver / vehicle: {liveOperationsQuery.data.trip.driverId ?? "Unavailable"} / {liveOperationsQuery.data.trip.vehicleId ?? "Unavailable"}</Text>
                      <Text style={styles.noticeSubtext}>Count / seal: {liveOperationsQuery.data.trip.count ?? "Unavailable"} / {liveOperationsQuery.data.trip.seal ?? "Unavailable"}</Text>
                      <Text style={styles.noticeSubtext}>Manifest / context: {liveOperationsQuery.data.trip.manifest == null ? "Unavailable" : "Available"} / {liveOperationsQuery.data.trip.context == null ? "Unavailable" : "Available"}</Text>
                      <Text style={styles.noticeSubtext}>Sortation bays / recent / inducted: {liveOperationsQuery.data.sortation.bays ?? "Unavailable"} / {liveOperationsQuery.data.sortation.recent ?? "Unavailable"} / {liveOperationsQuery.data.sortation.inducted ?? "Unavailable"}</Text>
                      <Text style={styles.noticeSubtext}>Throughput / minutes: {liveOperationsQuery.data.sortation.throughput ?? "Unavailable"} / {liveOperationsQuery.data.sortation.minutes ?? "Unavailable"}</Text>
                      {liveOperationsQuery.data.state === "error" ? <Text style={styles.error}>One or more scoped sources failed.</Text> : null}
                    </View>
                  )}
                </View>
              ) : null}
              {isTasksSurface ? (
                <View style={styles.noticeCard}>
                  <Text style={styles.noticeText}>Visibility</Text>
                  <Text style={styles.noticeSubtext}>
                    Scope: {formatKeyLabel(selectedVisibilityMode)}
                  </Text>
                </View>
              ) : null}

              {availableViews.length || canToggleRouteView ? (
                <View style={styles.filtersRow}>
                  {availableViews.length ? (
                    <Pressable
                      onPress={() => setViewPickerOpen(true)}
                      style={({ pressed }) => [styles.chip, pressed && styles.navItemPressed]}
                    >
                      <Text style={styles.chipText}>
                        {activeView?.label ? `View: ${activeView.label}` : "Views"}
                      </Text>
                    </Pressable>
                  ) : null}
                  {canToggleRouteView ? (
                    <>
                      {mapPolicy.routeViews.map((mode) => {
                        return (
                          <Pressable
                            key={mode}
                            accessibilityRole="button"
                            testID={`mobile-route-view-${mode}`}
                            onPress={() => {
                              void (async () => {
                                try {
                                  if (routeViewQuery.data === mode) return;
                                  await cacheStore.set(KV_KEYS.routeView, mode);
                                  queryClient.invalidateQueries({ queryKey: ["kv", "get", KV_KEYS.routeView] });
                                } catch {
                                  Alert.alert("Unable to update view", "Could not save the selected route view. Try again.");
                                }
                              })();
                            }}
                            style={({ pressed }) => [
                              styles.chip,
                              selectedRouteView === mode && styles.navItemSelected,
                              pressed && styles.navItemPressed,
                            ]}
                          >
                            <Text style={styles.chipText}>{formatRouteViewLabel(mode, strings)}</Text>
                          </Pressable>
                        );
                      })}
                    </>
                  ) : null}
                </View>
              ) : null}

              {isTasksSurface ? (
                <MobileTaskWorkspace
                  key={stableStringify({ actor: me?.user?.id, scope: me?.access_scope, view: resolvedViewId, filters: listFilters, sort: listSort })}
                  client={uiClient} actorId={me?.user?.id ?? ""} scope={me?.access_scope ?? null}
                  baseFilters={listFilters} baseSort={listSort} theme={themeTokens} strings={strings}
                  interactionLocked={drivingModeLocked} cache={cacheInitSuccess ? cacheStore : null}
                  renderPage={({ list, source, refreshing, onRefresh }) => (
                    <ResourceListView strings={strings} list={list} source={source} displayMode="list"
                      surfaceKind="tasks" refreshing={refreshing} onRefresh={onRefresh}
                      interactionLocked={drivingModeLocked}
                      onSelectItem={(item) => {
                        if (drivingModeLocked) return;
                        const id = pickResourceId(item, list.keys);
                        if (!id) return;
                        setSelectedResourceKey("tasks");
                        setSelectedResourceId(id);
                        setSelectedResourceTitle(formatOperationalTitle(extractTaskCardSnapshot(item)));
                      }} />
                  )}
                />
              ) : listQuery.isLoading ? (
                <Text style={styles.subtitle}>{resource === "tasks" ? strings.tasks.loading : `Loading ${resource}...`}</Text>
              ) : listQuery.isError ? (
                <View>
                  <Text style={styles.error}>Failed to load {resource}.</Text>
                  <Text style={styles.mono}>{formatUnknownError(listQuery.error)}</Text>
                </View>
              ) : listQuery.data ? (
                <>
                  {listQuery.data.warning ? (
                    <View style={styles.noticeCard}>
                      <Text style={styles.noticeText}>Unavailable in this workspace</Text>
                      <Text style={styles.noticeSubtext}>{listQuery.data.warning}</Text>
                    </View>
                  ) : null}
                  <ResourceListView
                      strings={strings}
                    list={isRouteSurface && displayedRouteList ? displayedRouteList : listQuery.data.list}
                    source={listQuery.data.source}
                    displayMode={resourceDisplayMode}
                    surfaceKind={
                      isRouteSurface
                        ? "route"
                        : isSettlementsSurface
                          ? "settlements"
                          : isTasksSurface
                            ? "tasks"
                            : "resource"
                    }
                    refreshing={listQuery.isFetching && !listQuery.isLoading}
                    onRefresh={() => listQuery.refetch()}
                    onSelectItem={(item) => {
                      if (drivingModeLocked) {
                        Alert.alert(strings.alerts.drivingLockedTitle, "Stop moving to open item details.");
                        return;
                      }
                      const id = pickResourceId(item, listQuery.data?.list.keys);
                      if (!id || !resource) return;
                      const nextTitle = isRouteSurface
                        ? formatOperationalTitle(extractRouteCardSnapshot(item))
                        : isTasksSurface
                          ? formatOperationalTitle(extractTaskCardSnapshot(item))
                          : formatResourceItemTitle(item, listQuery.data?.list.keys);
                      setSelectedResourceKey(resource);
                      setSelectedResourceId(id);
                      setSelectedResourceTitle(nextTitle);
                    }}
                    mapPolicy={mapPolicy}
                    interactionLocked={drivingModeLocked}
                  />
                </>
              ) : (
                <Text style={styles.subtitle}>No data.</Text>
              )}
            </View>
          )}
        </View>
      ) : activeScreen ? (
        <View style={[styles.content, contentSafeAreaStyle]}>
          {activeScreen === "outbox" ? (
            <OutboxScreen
              syncAccessibility={mobileSyncAccessibility(strings.actionAccessibility, syncMutation.isPending, effectiveOnline, mobileSyncPolicy.enabled, outboxCount)}
                      strings={strings}
              outboxStore={outboxStore}
              outboxCount={outboxCount}
              syncing={syncMutation.isPending}
              diagnosticsEnabled={diagnosticsEnabled}
              onSync={() => syncMutation.mutate()}
            />
          ) : activeScreen === "scan" ? (
            <ScanScreen
              syncAccessibility={mobileSyncAccessibility(strings.actionAccessibility, syncMutation.isPending, effectiveOnline, mobileSyncPolicy.enabled, outboxCount)}
                      strings={strings}
              client={client}
              actorId={sessionUserId}
              returnScope={completionReadbackScope}
              cacheStore={cacheStore}
              cacheReady={cacheInitSuccess}
              returnCommands={(commandRegistryQuery.data?.commands ?? []).filter(command =>
                command.schema_category === "resource:return_to_branch_scan")}
              canCompleteReturns={capabilitiesSet.has("tasks.complete")}
              outbox={outbox}
              deviceId={deviceId}
              policyContext={policyContext}
              buildAttestationEnvelope={buildAttestationEnvelope}
              effectivePlatform={effectiveMobilePlatform}
              drivingModeLocked={drivingModeLocked}
              storedScanInputMode={scanInputModeQuery.data}
              online={effectiveOnline}
              syncing={syncMutation.isPending}
              diagnosticsEnabled={diagnosticsEnabled}
              scanContext={scanContext}
              activeOpsSessionId={activeDriverShift?.opsSessionId ?? null}
              onSync={() => syncMutation.mutate()}
              onClearContext={() => setScanContext(null)}
              onSetScanInputMode={async (next) => {
                await cacheStore.set(KV_KEYS.scanInputMode, next);
                queryClient.invalidateQueries({ queryKey: ["kv", "get", KV_KEYS.scanInputMode] });
              }}
            />
          ) : activeScreen === "location" ? (
            <LocationScreen
              routeLocationContext={routeLocationContext}
              verifyLocationScope={verifyLocationScope}
              onClearLocationScope={() => setRouteLocationContext(null)}
              syncAccessibility={mobileSyncAccessibility(strings.actionAccessibility, syncMutation.isPending, effectiveOnline, mobileSyncPolicy.enabled, outboxCount)}
                      strings={strings}
              client={client}
              outbox={outbox}
              deviceId={deviceId}
              policyContext={policyContext}
              buildAttestationEnvelope={buildAttestationEnvelope}
              online={effectiveOnline}
              syncing={syncMutation.isPending}
              diagnosticsEnabled={diagnosticsEnabled}
              onSync={() => syncMutation.mutate()}
              onSpeedObserved={(nextSpeedKph) => {
                setObservedSpeedKph(nextSpeedKph);
              }}
            />
          ) : activeScreen === "more" ? (
            <MoreScreen
              client={client}
              actorId={sessionUserId}
              walletScope={completionReadbackScope}
              cacheStore={cacheStore}
              cacheReady={cacheInitSuccess}
              walletOnline={effectiveOnline}
              walletEnabled={capabilitiesSet.has("finance.withdrawal.request")}
              connectivityStatus={connectivityStatus}
              connectivitySummary={connectivitySummary}
              outboxCount={outboxCount}
              syncing={syncMutation.isPending}
              syncPolicyEnabled={mobileSyncPolicy.enabled}
              outboxStore={outboxStore}
              userEmail={me?.user?.email ?? null}
              accessScopeSummary={accessScopeSummary}
              moduleLabels={moduleLabels}
              diagnosticsEnabled={diagnosticsEnabled}
              diagnosticsAllowToggle={diagnosticsAllowToggle}
              diagnosticsDefaultOn={diagnosticsDefaultOn}
              simulatedOffline={simulatedOfflineQuery.data}
              selectedVisibilityMode={selectedVisibilityMode}
              selectedRouteView={selectedRouteView}
              visibilityPolicy={visibilityPolicy}
              mapPolicy={mapPolicy}
              driverSafetyPolicy={driverSafetyPolicy}
              drivingSafetyState={drivingSafetyState}
              simulatedSpeedKph={simulatedSpeedQuery.data}
              uxSafetyPolicy={uxSafetyPolicy}
              communicationPolicy={communicationPolicy}
              addressPolicy={addressPolicy}
              devicePolicy={devicePolicy}
              navigationPolicy={navigationPolicy}
              runtimePlatform={runtimeMobilePlatform}
              platformOverride={selectedPlatformOverride}
              effectivePlatform={effectiveMobilePlatform}
              selectedLocaleMode={selectedLocaleMode}
              selectedDirectionMode={selectedDirectionMode}
              selectedThemeMode={selectedThemeMode}
              displayPolicy={displayPolicy}
              strings={strings}
              activeDriverShift={activeDriverShift}
              canStartShift={Boolean(deviceId && effectiveOnline)}
              isMutatingDriverShift={isMutatingDriverShift}
              onSetDiagnostics={async (next) => {
                await cacheStore.set(KV_KEYS.diagnosticsEnabled, next);
                queryClient.invalidateQueries({ queryKey: ["kv", "get", KV_KEYS.diagnosticsEnabled] });
              }}
              onSync={() => syncMutation.mutate()}
              onSetVisibilityMode={async (next) => {
                await cacheStore.set(KV_KEYS.visibilityMode, next);
                queryClient.invalidateQueries({ queryKey: ["kv", "get", KV_KEYS.visibilityMode] });
              }}
              onSetRouteView={async (next) => {
                await cacheStore.set(KV_KEYS.routeView, next);
                queryClient.invalidateQueries({ queryKey: ["kv", "get", KV_KEYS.routeView] });
              }}
              onSetPlatformOverride={async (next) => {
                if (next == null) {
                  await cacheStore.remove(KV_KEYS.platformOverride);
                } else {
                  await cacheStore.set(KV_KEYS.platformOverride, next);
                }
                queryClient.invalidateQueries({ queryKey: ["kv", "get", KV_KEYS.platformOverride] });
              }}
              onSetSimulatedOffline={async (next) => {
                if (next == null) {
                  await cacheStore.remove(KV_KEYS.simulatedOffline);
                } else {
                  await cacheStore.set(KV_KEYS.simulatedOffline, next);
                }
                queryClient.invalidateQueries({ queryKey: ["kv", "get", KV_KEYS.simulatedOffline] });
              }}
              onSetSimulatedSpeed={async (next) => {
                if (next == null) {
                  await cacheStore.remove(KV_KEYS.simulatedSpeedKph);
                } else {
                  await cacheStore.set(KV_KEYS.simulatedSpeedKph, next);
                }
                queryClient.invalidateQueries({
                  queryKey: ["kv", "get", KV_KEYS.simulatedSpeedKph],
                });
              }}
              onSetLocaleMode={async (next) => {
                await cacheStore.set(KV_KEYS.localeMode, next);
                queryClient.invalidateQueries({ queryKey: ["kv", "get", KV_KEYS.localeMode] });
              }}
              onSetDirectionMode={async (next) => {
                await cacheStore.set(KV_KEYS.directionMode, next);
                queryClient.invalidateQueries({ queryKey: ["kv", "get", KV_KEYS.directionMode] });
              }}
              onSetThemeMode={setThemeMode}
              onOpenModule={(key) => {
                openModuleByKey(key);
              }}
              onStartShift={startDriverShift}
              onEndShift={endDriverShift}
              onSignOut={handleSignOut}
            />
          ) : (
            <DiagnosticsScreen
                      strings={strings}
              me={me}
              connectivityStatus={connectivityStatus}
              deviceId={deviceId}
              outboxCount={outboxCount}
              diagnosticsEnabled={diagnosticsEnabled}
              allowUserToggle={diagnosticsAllowToggle}
              toggleValue={diagnosticsToggleQuery.data ?? null}
              defaultOn={diagnosticsDefaultOn}
              policyRow={diagnosticsPolicyQuery.data}
              cacheStore={cacheStore}
              outboxStore={outboxStore}
              storage={storage}
              onToggle={async (next) => {
                await cacheStore.set(KV_KEYS.diagnosticsEnabled, next);
                queryClient.invalidateQueries({ queryKey: ["kv", "get", KV_KEYS.diagnosticsEnabled] });
              }}
              onClearLocal={async () => {
                financialAdmission.current += 1;
                const clearEpoch = ++evidenceClearEpoch.current;
                composerCaptureEpoch.current += 1;
                await pendingEvidence.invalidate();
                try {
                  await clearCompletionReadbacks(() => clearEvidenceLocalState(pendingEvidence, () => outboxStore.clear(), () => cacheStore.clear()), async () => null);
                  try {
                    const result = await client.auth.signOut({ scope: "local" });
                    if (result.error) throw result.error;
                  } catch (error) {
                    logDebugFailure("failed to sign out from diagnostics clear", error);
                  }
                } finally {
                  await replaceEvidenceManagerAfterClear(async () => {
                    const remaining = await client.auth.getSession();
                    if (remaining.error || !remaining.data.session) return null;
                    const verified = await client.auth.getUser();
                    if (verified.error) throw verified.error;
                    return verified.data.user?.id ?? null;
                  }, sessionUserId, () => clearEpoch === evidenceClearEpoch.current &&
                    evidenceLifecycle.current?.manager === pendingEvidence,
                  () => setEvidenceManagerRevision(current => current + 1));
                }
                setMobileCrashReportingUser(null);
                try {
                  await clearMobileTelemetryEvents();
                } catch (error) {
                  logDebugFailure("failed to clear telemetry during diagnostics clear", error);
                }
                await clearStoredDeviceState(storage);
                queryClient.clear();
              }}
              onRetryDeviceRegistration={() => registerDeviceMutation.mutate(undefined)}
            />
          )}
        </View>
      ) : route.kind === "unknown" ? (
        <View style={[styles.content, contentSafeAreaStyle]}>
          <Text style={styles.error}>Unsupported navigation route.</Text>
          <Text style={styles.mono}>{route.href}</Text>
        </View>
      ) : (
        <ScrollView contentContainerStyle={[styles.content, contentSafeAreaStyle]}>
          {navigation.sections.map((section) => (
            <View key={section.id} style={styles.section}>
              <Text style={styles.sectionTitle}>{section.label}</Text>
              {section.items.map((item) => {
                const routeForItem = resolveNavigationRoute(item);
                const navKey = resolveNavigationKey(item);
                const blockedByDriving =
                  drivingModeLocked && !canNavigateWhileMoving(drivingSafetyState, navKey);
                const unsupportedRoute = routeForItem.kind === "home" || routeForItem.kind === "unknown";
                const disabledByPolicy = Boolean(item.disabled_reason);
                const disabledReason = disabledByPolicy
                  ? formatMobileNavDisabledReason(item.disabled_reason)
                  : null;
                const blocked = disabledByPolicy || blockedByDriving || unsupportedRoute;
                return (
	                  <Pressable
	                    key={item.id}
	                    accessibilityRole="button"
	                    accessibilityHint={
	                      blockedByDriving
	                        ? "Double tap to learn why this module is locked while moving."
	                        : unsupportedRoute
	                          ? "Double tap to learn why this module is unavailable."
	                          : disabledReason
	                            ? "Double tap to learn why you do not have access."
	                            : "Opens module."
	                    }
	                    testID={`mobile-module-${resolveNavigationKey(item)}`}
	                    onPress={() => {
	                      if (blockedByDriving) {
	                        showMobileNotice(strings.alerts.drivingLockedTitle, "This module is blocked while moving.");
	                        return;
	                      }
	                      if (unsupportedRoute) {
	                        showMobileNotice(
	                          "Unavailable module",
	                          "This module route is not supported in Field Ops."
	                        );
	                        return;
	                      }
	                      if (disabledReason) {
	                        showMobileNotice(disabledReason.title, disabledReason.message);
	                        return;
	                      }
	                      setSelectedId(item.id);
	                    }}
	                    style={({ pressed }) => [
	                      styles.navItem,
                      selectedId === item.id && styles.navItemSelected,
                      pressed && !blocked && styles.navItemPressed,
                      blocked && styles.navItemDisabled,
                    ]}
                  >
                    <Text style={styles.navItemLabel}>{item.label}</Text>
                    {blockedByDriving ? (
                      <Text style={styles.navItemBadge}>Locked while moving</Text>
                    ) : unsupportedRoute ? (
                      <Text style={styles.navItemBadge}>Unavailable</Text>
                    ) : disabledReason ? (
                      <Text style={styles.navItemBadge}>{disabledReason.badge}</Text>
                    ) : item.badge ? (
                      <Text style={styles.navItemBadge}>{item.badge}</Text>
                    ) : null}
                  </Pressable>
                );
              })}
            </View>
          ))}
        </ScrollView>
      )}

        <StatusBar style="auto" />
        </View>
      </View>
    </ThemeProvider>
    </FieldOpsStylesContext.Provider>
  );
}

function OutboxScreen({
  syncAccessibility,
  strings,
  outboxStore,
  outboxCount,
  syncing,
  diagnosticsEnabled,
  onSync,
}: {
  strings: FieldOpsStrings;
  syncAccessibility: ReturnType<typeof mobileSyncAccessibility>;
  outboxStore: ReturnType<typeof createSqliteOutboxStore>;
  outboxCount: number;
  syncing: boolean;
  diagnosticsEnabled: boolean;
  onSync: () => void;
}) {
  const styles = useFieldOpsStyles();
  const queryClient = useQueryClient();
  const clearOutboxRef = React.useRef(false);
  const [isClearingOutbox, setIsClearingOutbox] = React.useState(false);
  const entriesQuery = useQuery({
    queryKey: ["outbox", "entries"],
    queryFn: () =>
      outboxStore.list({
        status: ["queued", "failed", "in_flight", "dead"],
        limit: 200,
      }),
  });

  const withOutboxClearLock = React.useCallback(
    async (action: () => Promise<void>) => {
      if (clearOutboxRef.current) return;
      clearOutboxRef.current = true;
      setIsClearingOutbox(true);
      try {
        await action();
      } catch {
        Alert.alert("Clear failed", "Unable to clear outbox entries.");
      } finally {
        clearOutboxRef.current = false;
        setIsClearingOutbox(false);
      }
    },
    []
  );

  const clearDead = React.useCallback(() => {
    Alert.alert("Clear dead entries?", "This removes non-retriable entries from this device.", [
      { text: "Cancel", style: "cancel" },
      {
        text: "Clear",
        style: "destructive",
        onPress: () => {
          void withOutboxClearLock(async () => {
            await outboxStore.clear({ status: ["dead"] });
            queryClient.invalidateQueries({ queryKey: ["outbox", "entries"] });
            queryClient.invalidateQueries({ queryKey: ["outbox", "count"] });
          });
        },
      },
    ]);
  }, [outboxStore, queryClient, withOutboxClearLock]);

  const clearAll = React.useCallback(() => {
    Alert.alert(
      "Clear outbox?",
      "This removes queued actions from this device. Use only if instructed.",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Clear",
          style: "destructive",
          onPress: () => {
            void withOutboxClearLock(async () => {
              await outboxStore.clear();
              queryClient.invalidateQueries({ queryKey: ["outbox", "entries"] });
              queryClient.invalidateQueries({ queryKey: ["outbox", "count"] });
            });
          },
        },
      ]
    );
  }, [outboxStore, queryClient, withOutboxClearLock]);

  return (
    <View style={styles.screen}>
      <View style={styles.screenHeader}>
        <View style={styles.screenHeaderText}>
          <Text style={styles.resourceTitle}>{strings.outbox.title}</Text>
          <Text style={styles.resourceSubtitle}>
            {strings.outbox.pending(outboxCount)} {syncing ? `- ${strings.shell.syncing}` : ""}
          </Text>
        </View>
        <View style={styles.screenHeaderActions}>
          <Pressable
            onPress={onSync}
            {...syncAccessibility}
            disabled={syncAccessibility.accessibilityState.disabled}
            style={({ pressed }) => [
              styles.syncNowButton,
              syncAccessibility.accessibilityState.disabled && styles.syncButtonDisabled,
              pressed && styles.syncButtonPressed,
            ]}
          >
            <Text style={styles.syncButtonText}>{syncing ? strings.shell.syncing : strings.shell.syncNow}</Text>
          </Pressable>
        </View>
      </View>

      <View style={styles.screenActionsRow}>
        <Pressable
          onPress={clearDead}
          {...mobileActionAccessibility(strings.actionAccessibility.busy, syncing || isClearingOutbox, syncing || isClearingOutbox)}
          disabled={syncing || isClearingOutbox}
          style={({ pressed }) => [
            styles.secondaryButton,
            (syncing || isClearingOutbox) && styles.primaryButtonDisabled,
            pressed && styles.navItemPressed,
          ]}
        >
          <Text style={styles.secondaryButtonText}>{strings.outbox.clearDead}</Text>
        </Pressable>
        {diagnosticsEnabled ? (
          <Pressable
            onPress={clearAll}
            {...mobileActionAccessibility(strings.actionAccessibility.busy, syncing || isClearingOutbox, syncing || isClearingOutbox)}
            disabled={syncing || isClearingOutbox}
            style={({ pressed }) => [
              styles.secondaryButton,
              (syncing || isClearingOutbox) && styles.primaryButtonDisabled,
              pressed && styles.navItemPressed,
            ]}
          >
            <Text style={styles.secondaryButtonText}>Clear all</Text>
          </Pressable>
        ) : null}
      </View>

      {entriesQuery.isLoading ? (
        <Text style={styles.subtitle}>Loading outbox...</Text>
      ) : entriesQuery.isError ? (
        <View>
          <Text style={styles.error}>Failed to load outbox.</Text>
          <Text style={styles.mono}>{formatUnknownError(entriesQuery.error)}</Text>
        </View>
      ) : entriesQuery.data && entriesQuery.data.length ? (
        <FlatList
          data={entriesQuery.data}
          keyExtractor={(item) => item.id}
          contentContainerStyle={styles.list}
          renderItem={({ item }) => {
            const feedback = describeMobileOutboxEntry(item, strings);
            return (
              <View style={styles.card} accessible accessibilityLabel={feedback.accessibilityLabel}>
                <Text style={styles.cardTitle}>{feedback.title}</Text>
                <Text style={styles.cardSubtitle}>{feedback.targetLabel} — {feedback.status}</Text>
                <Text style={styles.noticeSubtext}>{feedback.detail}</Text>
                {feedback.lines.map((line) => <Text key={line} style={styles.noticeSubtext}>{line}</Text>)}
                {diagnosticsEnabled && item.last_error ? (
                  <Text style={styles.mono} numberOfLines={6}>{redactOutboxErrorText(item.last_error)}</Text>
                ) : null}
              </View>
            );
          }}
        />
      ) : (
        <OutboxEmptyState title={strings.outbox.empty} />
      )}
    </View>
  );
}

function ScanScreen({
  syncAccessibility,
  strings,
  client,
  actorId,
  returnScope,
  cacheStore,
  cacheReady,
  returnCommands,
  canCompleteReturns,
  outbox,
  deviceId,
  policyContext,
  buildAttestationEnvelope,
  effectivePlatform,
  drivingModeLocked,
  storedScanInputMode,
  online,
  syncing,
  diagnosticsEnabled,
  scanContext,
  activeOpsSessionId,
  onSync,
  onClearContext,
  onSetScanInputMode,
}: {
  strings: FieldOpsStrings;
  syncAccessibility: ReturnType<typeof mobileSyncAccessibility>;
  client: ReturnType<typeof createMobileClient>;
  actorId: string;
  returnScope: string;
  cacheStore: KeyValueStore;
  cacheReady: boolean;
  returnCommands: UiCommandDefinition[];
  canCompleteReturns: boolean;
  outbox: ReturnType<typeof createOutbox>;
  deviceId: string | null;
  policyContext: Record<string, unknown>;
  buildAttestationEnvelope: (input: {
    rpcName: string;
    deviceId?: string | null;
    resourceId?: string | null;
    source?: string | null;
  }) => Promise<MobileAttestationEnvelope | null>;
  effectivePlatform: "android" | "ios" | "scanner";
  drivingModeLocked: boolean;
  storedScanInputMode: string | null | undefined;
  online: boolean;
  syncing: boolean;
  diagnosticsEnabled: boolean;
  scanContext: DriverScanContext | null;
  activeOpsSessionId: string | null;
  onSync: () => void;
  onClearContext: () => void;
  onSetScanInputMode: (next: MobileScanInputMode) => Promise<void>;
}) {
  const styles = useFieldOpsStyles();
  const queryClient = useQueryClient();
  const [scanType, setScanType] = React.useState("");
  const [barcode, setBarcode] = React.useState("");
  const barcodeInputRef = React.useRef<TextInput>(null);
  const [cameraOpen, setCameraOpen] = React.useState(false);
  const [permission, requestPermission] = useCameraPermissions();
  const lastScanRef = React.useRef<{ data: string; at: number } | null>(null);
  const scanModeActionRef = React.useRef(false);
  const [isUpdatingScanMode, setIsUpdatingScanMode] = React.useState(false);
  const [lastQueuedScan, setLastQueuedScan] = React.useState<{
    id: string;
    barcode: string;
    scanType: string;
    contextLabel: string | null;
    queuedAt: string;
    actorId: string;
    returnScope: string;
  } | null>(null);

  const [chosenReturnScan, setChosenReturnScan] = React.useState<{ actor: string; scope: string; queueId: string } | null>(null);
  const returnScanListQuery = useQuery({
    queryKey: ["return-scan-list", actorId, returnScope],
    enabled: Boolean(cacheReady && actorId && returnScope),
    queryFn: () => listReturnScans(cacheStore, { actor: actorId, scope: returnScope }),
    staleTime: Infinity,
  });
  const savedReturnScans = returnScanListQuery.data ?? [];
  const chosenQueueId = chosenReturnScan?.actor === actorId && chosenReturnScan.scope === returnScope
    ? chosenReturnScan.queueId : null;
  const selectedReturnQueueId = chosenQueueId ?? savedReturnScans[savedReturnScans.length - 1]?.queueId ?? null;
  const returnScanQuery = useQuery({
    queryKey: ["accepted-return-scan", actorId, returnScope, selectedReturnQueueId],
    enabled: Boolean(online && cacheReady && actorId && returnScope && selectedReturnQueueId),
    queryFn: async ({ signal }) => {
      const verifiedScope = await resolveVerifiedCompletionScope(client);
      if (!verifiedScope || verifiedScope.actor !== actorId || verifiedScope.scope !== returnScope) return null;
      const stored = await returnScanForQueue(cacheStore, verifiedScope, selectedReturnQueueId!);
      if (!stored) return null;
      if (!stored.scanEventId) {
        const lookup = await client.schema("api").rpc("ui_get_return_to_branch_scan_by_idempotency_v1",
          { p_idempotency_key: stored.queueId }).abortSignal(signal);
        if (lookup.error) throw lookup.error;
        const recovered = recoveredReturnScan(lookup.data, stored);
        if (!recovered) return { pending: stored, accepted: null, verified: false };
        await rememberAcceptedReturnScan(cacheStore, verifiedScope, recovered);
        queryClient.invalidateQueries({ queryKey: ["return-scan-list", actorId, returnScope] });
        const current = await returnScanForQueue(cacheStore, verifiedScope, stored.queueId);
        if (current?.scanEventId !== recovered.scanEventId) return null;
        return { pending: null, accepted: recovered, verified: verifiedReturnScanReceipt(
          (lookup.data as { receipt?: unknown }).receipt, recovered) };
      }
      const accepted = { actor: stored.actor, queueId: stored.queueId, scanEventId: stored.scanEventId,
        barcode: stored.barcode };
      const response = await client.schema("api").rpc("ui_get_return_to_branch_scan_readback_v1",
        { p_scan_event_id: accepted.scanEventId }).abortSignal(signal);
      if (response.error) throw response.error;
      return { pending: null, accepted, verified: verifiedReturnScanReceipt(response.data, accepted) };
    },
    staleTime: 0,
    retry: false,
  });
  const selectedReturn = returnScanQuery.data?.verified ? returnScanQuery.data.accepted : null;
  const displayedQueuedScan = lastQueuedScan?.actorId === actorId && lastQueuedScan.returnScope === returnScope
    ? lastQueuedScan : null;
  const scanPolicyQuery = useQuery({
    queryKey: ["policy", "scan_policy", stableStringify(policyContext)],
    queryFn: async () => resolvePolicyRow(client, "resolve_scan_policy", policyContext),
    staleTime: 5 * 60_000,
  });

  const scanPolicyRow = scanPolicyQuery.data ?? null;
  const scanPolicyLoaded = scanPolicyQuery.isSuccess;
  const scanPolicyValue = asRecord(asRecord(scanPolicyRow).value);
  const acceptedScanTypes = Array.isArray(scanPolicyValue?.accepted_scan_types)
    ? (scanPolicyValue.accepted_scan_types as unknown[]).map((value) => String(value))
    : [];
  const allowedScanInputModes = React.useMemo(
    () =>
      resolveAllowedScanInputModes({
        policyValue: scanPolicyValue,
        platform: effectivePlatform,
      }),
    [effectivePlatform, scanPolicyValue]
  );
  const scanPolicyUnavailable = scanPolicyQuery.isError || (scanPolicyLoaded && (scanPolicyRow == null || !allowedScanInputModes.length));
  const scanEnabled = !scanPolicyUnavailable && scanPolicyValue?.enabled === true && allowedScanInputModes.length > 0;
  const effectiveScanInputMode = React.useMemo(
    () =>
      resolveEffectiveScanInputMode({
        storedMode: storedScanInputMode,
        platform: effectivePlatform,
        allowedModes: allowedScanInputModes,
      }),
    [allowedScanInputModes, effectivePlatform, storedScanInputMode]
  );

  React.useEffect(() => {
    if (scanType.trim()) return;
    const next = acceptedScanTypes[0] ?? "";
    if (next) setScanType(next);
  }, [acceptedScanTypes, scanType]);
  React.useEffect(() => {
    if (!scanContext?.routeRunId || scanContext.routeStopId) return;
    if (!acceptedScanTypes.includes("load")) return;
    if (scanType.trim().toLowerCase() === "load") return;
    setScanType("load");
  }, [acceptedScanTypes, scanContext?.routeRunId, scanContext?.routeStopId, scanType]);
  const setScanInputMode = React.useCallback(
    async (next: MobileScanInputMode) => {
      if (scanModeActionRef.current) return;
      scanModeActionRef.current = true;
      setIsUpdatingScanMode(true);
      try {
        await onSetScanInputMode(next);
      } finally {
        scanModeActionRef.current = false;
        setIsUpdatingScanMode(false);
      }
    },
    [onSetScanInputMode]
  );
  React.useEffect(() => {
    if (!effectiveScanInputMode || storedScanInputMode === effectiveScanInputMode) return;
    void setScanInputMode(effectiveScanInputMode);
  }, [effectiveScanInputMode, setScanInputMode, storedScanInputMode]);
  React.useEffect(() => {
    if (effectiveScanInputMode !== "camera" && cameraOpen) setCameraOpen(false);
  }, [cameraOpen, effectiveScanInputMode]);
  React.useEffect(() => {
    if (drivingModeLocked && cameraOpen) setCameraOpen(false);
  }, [cameraOpen, drivingModeLocked]);

  const isQueueingScanRef = React.useRef(false);
  const [isQueueingScan, setIsQueueingScan] = React.useState(false);
  const scanReadOnly = !scanPolicyLoaded || !scanEnabled || drivingModeLocked;
  React.useEffect(() => {
    if (effectiveScanInputMode === "scanner" && !scanReadOnly) barcodeInputRef.current?.focus();
  }, [effectiveScanInputMode, scanReadOnly]);
  const scanInputHint = scanPolicyQuery.isLoading
    ? strings.actionAccessibility.policyLoading
    : scanPolicyUnavailable
      ? strings.actionAccessibility.policyUnavailable
      : !scanEnabled
        ? strings.actionAccessibility.policyDisabled
        : drivingModeLocked ? strings.scan.drivingLocked : strings.actionAccessibility.scanReady;
  const canQueue = Boolean(
    deviceId && barcode.trim() && scanType.trim() && scanEnabled && !drivingModeLocked && !isQueueingScan
  );
  const canOpenCamera =
    effectiveScanInputMode === "camera" && scanEnabled && !drivingModeLocked;

  const queueScan = async () => {
    if (isQueueingScanRef.current) return;
    isQueueingScanRef.current = true;
    setIsQueueingScan(true);

    try {
      if (!deviceId) {
        Alert.alert("Device setup required", "Device must be registered before scanning.");
        return;
      }
      if (drivingModeLocked) {
        Alert.alert(strings.alerts.drivingLockedTitle, "Stop moving before recording scans.");
        return;
      }
      if (scanPolicyQuery.isLoading) {
        Alert.alert("Scan disabled", "Scan policy is still loading. Retry in a moment.");
        return;
      }
      if (scanPolicyUnavailable) {
        Alert.alert(
          "Scan disabled",
          "Unable to load scan policy. Connect online and sync, or contact your administrator."
        );
        return;
      }
      if (!scanEnabled) {
        Alert.alert("Scan disabled", "Scan is disabled by policy.");
        return;
      }

      let attestation: MobileAttestationEnvelope | null = null;
      try {
        attestation = await buildAttestationEnvelope({
          rpcName: "record_scan_event_v1",
          deviceId,
          resourceId: scanContext?.resourceId ?? readContextId(policyContext, "resource_id"),
          source: "mobile",
        });
      } catch (error) {
        const message =
          error instanceof Error && error.message
            ? error.message
            : "Attestation failed. Retry while online.";
        Alert.alert("Attestation required", message);
        return;
      }

      const id = createOutboxId();
      const returnIntake = scanType.trim().toLowerCase() === "return_to_branch_intake";
      if (returnIntake && (!cacheReady || !actorId || !returnScope)) {
        Alert.alert(strings.scan.returnUnavailable, strings.scan.returnVerifyOnline);
        return;
      }
      const pending = returnIntake ? { actor: actorId, scope: returnScope, queueId: id, barcode: barcode.trim() } : null;
      if (pending) {
        try {
          await rememberPendingReturnScan(cacheStore, pending);
        } catch (error) {
          Alert.alert(strings.scan.returnUnavailable, strings.scan.returnPreserveFailed);
          return;
        }
      }
      try {
      await outbox.enqueue({
        id,
        rpc: "record_scan_event_v1",
        args: {
          p_scan: {
            idempotency_key: id,
            scan_type: scanType.trim().toLowerCase(),
            barcode: barcode.trim(),
            device_id: deviceId,
            ...(scanContext?.routeRunId ? { route_run_id: scanContext.routeRunId } : {}),
            ...(scanContext?.routeStopId ? { route_stop_id: scanContext.routeStopId } : {}),
            ...(scanContext?.shipmentId
              ? {
                  shipment_id: scanContext.shipmentId,
                  ...(scanContext.clientId ? { client_id: scanContext.clientId } : {}),
                }
              : {}),
            ...((activeOpsSessionId ?? scanContext?.opsSessionId)
              ? { ops_session_id: activeOpsSessionId ?? scanContext?.opsSessionId }
              : {}),
            captured_at: new Date().toISOString(),
            metadata: {
              app: "fieldops",
              source: "mobile",
              scan_input_mode: effectiveScanInputMode,
              context: {
                label: scanContext?.label ?? null,
                task_id: scanContext?.taskId ?? null,
                resource_id: scanContext?.resourceId ?? null,
                route_run_id: scanContext?.routeRunId ?? null,
                route_stop_id: scanContext?.routeStopId ?? null,
                reference: scanContext?.reference ?? null,
                customer_name: scanContext?.customerName ?? null,
              },
              ...(attestation ? { attestation } : {}),
            },
          },
        },
      });
      } catch (error) {
        if (pending) await forgetUnqueuedReturnScan(cacheStore, pending);
        throw error;
      }
      if (pending) {
        setChosenReturnScan({ actor: pending.actor, scope: pending.scope, queueId: pending.queueId });
        queryClient.invalidateQueries({ queryKey: ["return-scan-list"] });
        queryClient.invalidateQueries({ queryKey: ["accepted-return-scan"] });
      }

      queryClient.invalidateQueries({ queryKey: ["outbox", "count"] });
      queryClient.invalidateQueries({ queryKey: ["outbox", "entries"] });

      setBarcode("");
      setLastQueuedScan({
        id,
        barcode: barcode.trim(),
        scanType: scanType.trim().toLowerCase(),
        contextLabel: scanContext?.label ?? null,
        queuedAt: new Date().toISOString(),
        actorId,
        returnScope,
      });
      if (online && !syncing) onSync();
    } finally {
      isQueueingScanRef.current = false;
      setIsQueueingScan(false);
    }
  };

  const onBarcodeScanned = (result: BarcodeScanningResult) => {
    const data = String(result.data ?? "").trim();
    if (!data) return;

    const now = Date.now();
    if (lastScanRef.current && lastScanRef.current.data === data && now - lastScanRef.current.at < 1200) {
      return;
    }
    lastScanRef.current = { data, at: now };

    setBarcode(data);
    setCameraOpen(false);
  };

  return (
    <ScrollView contentContainerStyle={styles.screen}>
      <View style={styles.screenHeader}>
        <View style={styles.screenHeaderText}>
          <Text style={styles.resourceTitle}>{strings.scan.title}</Text>
          <Text style={styles.resourceSubtitle}>
            {scanPolicyQuery.isLoading
              ? "Loading policy..."
              : scanPolicyUnavailable
                ? "Policy unavailable"
                : scanEnabled
                  ? strings.scan.ready
                  : "Disabled by policy"}
          </Text>
        </View>
        <Pressable
          onPress={onSync}
          {...syncAccessibility}
          disabled={syncAccessibility.accessibilityState.disabled}
          style={({ pressed }) => [
            styles.syncNowButton,
            syncAccessibility.accessibilityState.disabled && styles.syncButtonDisabled,
            pressed && styles.syncButtonPressed,
          ]}
        >
          <Text style={styles.syncButtonText}>{syncing ? strings.shell.syncing : strings.shell.syncNow}</Text>
        </Pressable>
      </View>

      {!deviceId ? (
        <View style={styles.noticeCard}>
          <Text style={styles.noticeText}>Device setup required for ingest.</Text>
          <Text style={styles.noticeSubtext}>
            Connect online to complete registration, then retry.
          </Text>
        </View>
      ) : null}

      {scanPolicyUnavailable ? (
        <View style={styles.noticeCard}>
          <Text style={styles.noticeText}>Scan policy unavailable</Text>
          <Text style={styles.noticeSubtext}>
            Scan is disabled until the policy can be resolved. Connect online and tap Sync now, or contact your
            administrator.
          </Text>
          {diagnosticsEnabled ? (
            <Text style={[styles.mono, { marginTop: 8 }]} numberOfLines={6}>
              {formatUnknownError(scanPolicyQuery.error)}
            </Text>
          ) : null}
        </View>
      ) : null}

      {scanContext ? (
        <View style={styles.noticeCard}>
          <Text style={styles.noticeText}>
            {scanContext.routeRunId && !scanContext.routeStopId ? "Current route-load context" : "Current stop context"}
          </Text>
          <Text style={styles.noticeSubtext}>{scanContext.label}</Text>
          {scanContext.reference ? (
            <Text style={[styles.noticeSubtext, { marginTop: 4 }]}>
              {strings.detail.reference(scanContext.reference)}
            </Text>
          ) : null}
          {scanContext.routeRunId ? (
            <Text style={[styles.noticeSubtext, { marginTop: 4 }]}>
              Route run binding: {scanContext.routeRunId}
            </Text>
          ) : null}
          <Text style={[styles.noticeSubtext, { marginTop: 4 }]}>
            {scanContext.routeStopId ? strings.detail.routeStop : "Task"} binding: {scanContext.routeStopId ?? scanContext.taskId ?? "task only"}
          </Text>
          <View style={[styles.screenActionsRow, { marginTop: 8 }]}>
            <Pressable
              accessibilityRole="button"
              testID="mobile-scan-clear-context"
              onPress={onClearContext}
              style={({ pressed }) => [styles.secondaryButton, pressed && styles.navItemPressed]}
            >
              <Text style={styles.secondaryButtonText}>Clear context</Text>
            </Pressable>
          </View>
        </View>
      ) : null}

      <View style={styles.noticeCard}>
        <Text style={styles.noticeText}>Scan input mode</Text>
        <View style={styles.screenActionsRow}>
          {allowedScanInputModes.map((mode) => (
            <Pressable
              key={mode}
              onPress={() => void setScanInputMode(mode)}
              {...mobileActionAccessibility(scanInputHint, scanReadOnly || isUpdatingScanMode, isUpdatingScanMode)}
              disabled={scanReadOnly || isUpdatingScanMode}
              style={({ pressed }) => [
                styles.chip,
                effectiveScanInputMode === mode && styles.navItemSelected,
                (scanReadOnly || isUpdatingScanMode) && styles.syncButtonDisabled,
                pressed && styles.navItemPressed,
              ]}
            >
              <Text style={styles.chipText}>{mode === "camera" ? strings.scan.modeCamera : strings.scan.modeScanner}</Text>
            </Pressable>
          ))}
        </View>
        <Text style={[styles.noticeSubtext, { marginTop: 8 }]}>
          Effective platform: {effectivePlatform}
        </Text>
        {drivingModeLocked ? (
          <Text style={[styles.noticeSubtext, { marginTop: 6 }]}>
            {strings.scan.drivingLocked}
          </Text>
        ) : null}
      </View>

      <TextInput
        style={styles.input}
        value={scanType}
        accessibilityLabel={strings.actionAccessibility.scanType}
        accessibilityHint={scanInputHint}
        editable={!scanReadOnly}
        placeholder={strings.actionAccessibility.scanType}
        autoCapitalize="none"
        onChangeText={setScanType}
      />

      {acceptedScanTypes.length ? (
        <ScrollView horizontal contentContainerStyle={styles.chipRow}>
          {acceptedScanTypes.slice(0, 12).map((candidate) => (
            <Pressable
              key={candidate}
              onPress={() => setScanType(candidate)}
              {...mobileActionAccessibility(scanInputHint, scanReadOnly)}
              disabled={scanReadOnly}
              style={({ pressed }) => [
                styles.chip,
                candidate === scanType && styles.methodChipActive,
                pressed && styles.navItemPressed,
              ]}
            >
              <Text style={styles.chipText}>{candidate}</Text>
            </Pressable>
          ))}
        </ScrollView>
      ) : null}

      <TextInput
        ref={barcodeInputRef}
        style={styles.input}
        value={barcode}
        placeholder={
          drivingModeLocked
            ? "Stop to scan (Driving mode)"
            : effectiveScanInputMode === "scanner"
              ? "Scan barcode (scanner mode)"
              : strings.scan.barcodePlaceholder
        }
        autoCapitalize="none"
        onChangeText={setBarcode}
        submitBehavior={effectiveScanInputMode === "scanner" ? "submit" : "blurAndSubmit"}
        onSubmitEditing={() => {
          if (effectiveScanInputMode === "scanner" && canQueue) void queueScan();
        }}
        accessibilityLabel={strings.scan.barcodePlaceholder}
        accessibilityHint={scanInputHint}
        editable={!scanReadOnly}
      />

      <View style={styles.screenActionsRow}>
        <Pressable
          testID="mobile-scan-toggle-camera"
          onPress={() => setCameraOpen((open) => !open)}
          {...mobileActionAccessibility(effectiveScanInputMode !== "camera" ? strings.actionAccessibility.modeUnavailable : scanInputHint, !canOpenCamera)}
          disabled={!canOpenCamera}
          style={({ pressed }) => [
            styles.secondaryButton,
            !canOpenCamera && styles.primaryButtonDisabled,
            pressed && styles.navItemPressed,
          ]}
        >
          <Text style={styles.secondaryButtonText}>
            {effectiveScanInputMode !== "camera"
              ? strings.scan.cameraUnavailable
              : cameraOpen
                ? strings.scan.closeCamera
                : strings.scan.openCamera}
          </Text>
        </Pressable>
        <Pressable
          testID="mobile-scan-queue"
          onPress={() => {
            void queueScan();
          }}
          {...mobileActionAccessibility(isQueueingScan ? strings.actionAccessibility.busy : !deviceId ? strings.actionAccessibility.deviceMissing : scanReadOnly ? scanInputHint : strings.actionAccessibility.requiredInput, !canQueue, isQueueingScan)}
          disabled={!canQueue}
          style={({ pressed }) => [
            styles.primaryButton,
            !canQueue && styles.primaryButtonDisabled,
            pressed && canQueue && styles.primaryButtonPressed,
          ]}
        >
          <Text style={styles.primaryButtonText}>
            {isQueueingScan ? strings.scan.queueing : strings.scan.queue}
          </Text>
        </Pressable>
      </View>

      {cameraOpen && effectiveScanInputMode === "camera" && !scanReadOnly ? (
        <View style={styles.cameraFrame}>
          {permission?.granted ? (
            <CameraView
              style={styles.camera}
              onBarcodeScanned={onBarcodeScanned}
              barcodeScannerSettings={{ barcodeTypes: ["qr", "code128", "ean13", "ean8", "upc_a", "upc_e"] }}
            />
          ) : (
            <View style={styles.noticeCard}>
              <Text style={styles.noticeText}>{strings.scan.permissionRequired}</Text>
              <Text style={styles.noticeSubtext}>
                {permission?.canAskAgain === false
                  ? strings.scan.permissionDenied
                  : strings.scan.permissionPrompt}
              </Text>
              <Pressable
                accessibilityRole="button"
                accessibilityHint={permission?.canAskAgain === false ? strings.actionAccessibility.settingsCamera : strings.actionAccessibility.grantCamera}
                onPress={() => {
                  if (permission?.canAskAgain === false) {
                    void openSystemSettingsSafe();
                    return;
                  }
                  void requestPermission();
                }}
                style={({ pressed }) => [styles.secondaryButton, pressed && styles.navItemPressed]}
              >
                <Text style={styles.secondaryButtonText}>
                  {permission?.canAskAgain === false ? strings.scan.openSettings : strings.scan.grantPermission}
                </Text>
              </Pressable>
            </View>
          )}
        </View>
      ) : null}

      {displayedQueuedScan ? (
        <View style={styles.noticeCard}>
          <Text style={styles.noticeText}>{strings.scan.lastQueued}</Text>
          <Text style={styles.noticeSubtext}>
            {online ? strings.scan.queuedOnline : strings.scan.queuedOffline}
          </Text>
          <Text style={[styles.noticeSubtext, { marginTop: 4 }]}>
            {displayedQueuedScan.scanType} - {displayedQueuedScan.barcode}
          </Text>
          {displayedQueuedScan.contextLabel ? (
            <Text style={[styles.noticeSubtext, { marginTop: 4 }]}>
              {strings.scan.context} {displayedQueuedScan.contextLabel}
            </Text>
          ) : null}
          <Text style={[styles.mono, { textAlign: "left", marginTop: 8 }]}>
            Scan reference: {displayedQueuedScan.id}
          </Text>
        </View>
      ) : null}
      {savedReturnScans.length ? <Text style={styles.noticeText}>{strings.scan.savedReturns}</Text> : null}
      {savedReturnScans.map(scan => (
        <Pressable key={scan.queueId} accessibilityRole="button"
          accessibilityState={{ selected: scan.queueId === selectedReturnQueueId }}
          accessibilityLabel={strings.scan.selectReturn(scan.barcode, scan.queueId)}
          onPress={() => setChosenReturnScan({ actor: actorId, scope: returnScope, queueId: scan.queueId })}
          style={styles.noticeCard}>
          <Text>{scan.barcode} - {scan.scanEventId ? strings.scan.acceptedVerify : strings.scan.pendingSync}</Text>
          <Text style={styles.mono}>Scan reference: {scan.queueId}</Text>
        </Pressable>
      ))}
      {returnScanQuery.data?.accepted && !returnScanQuery.data.verified ? (
        <Text>{strings.scan.acceptedPending}</Text>
      ) : null}
      {returnScanQuery.data?.pending ? <Text>{strings.scan.pendingAcceptance}</Text> : null}
      {returnScanQuery.isError ? <Text>{strings.scan.readbackFailed}</Text> : null}
      {(returnScanQuery.data?.pending || (returnScanQuery.data?.accepted && !returnScanQuery.data.verified) ||
        returnScanQuery.isError) && online ? (
        <Pressable accessibilityRole="button" onPress={() => { void returnScanQuery.refetch(); }}>
          <Text>{strings.scan.refreshAcceptance}</Text>
        </Pressable>
      ) : null}
      {selectedReturn ? <Text>{strings.scan.acceptedReturn(selectedReturn.barcode)}</Text> : null}
      <MobileReturnActions
        strings={strings.returnActions} accepted={selectedReturn}
        actorId={actorId} client={client} outbox={outbox} commands={returnCommands}
        canComplete={canCompleteReturns} online={online} syncing={syncing}
        drivingLocked={drivingModeLocked} onSync={onSync}
      />


    </ScrollView>
  );
}

function LocationScreen({
  routeLocationContext,
  verifyLocationScope,
  onClearLocationScope,
  syncAccessibility,
  strings,
  client,
  outbox,
  deviceId,
  policyContext,
  buildAttestationEnvelope,
  online,
  syncing,
  diagnosticsEnabled,
  onSync,
  onSpeedObserved,
}: {
  routeLocationContext?: RouteLocationContext | null;
  verifyLocationScope?: () => Promise<RouteLocationContext | null>;
  onClearLocationScope?: () => void;
  strings: FieldOpsStrings;
  syncAccessibility: ReturnType<typeof mobileSyncAccessibility>;
  client: ReturnType<typeof createMobileClient>;
  outbox: ReturnType<typeof createOutbox>;
  deviceId: string | null;
  policyContext: Record<string, unknown>;
  buildAttestationEnvelope: (input: {
    rpcName: string;
    deviceId?: string | null;
    resourceId?: string | null;
    source?: string | null;
  }) => Promise<MobileAttestationEnvelope | null>;
  online: boolean;
  syncing: boolean;
  diagnosticsEnabled: boolean;
  onSync: () => void;
  onSpeedObserved?: (speedKph: number) => void;
}) {
  const styles = useFieldOpsStyles();
  const queryClient = useQueryClient();
  const [position, setPosition] = React.useState<Location.LocationObject | null>(null);
  const [status, setStatus] = React.useState<"idle" | "loading">("idle");
  const captureLocationRef = React.useRef(false);
  const [backgroundSyncing, setBackgroundSyncing] = React.useState(false);
  const backgroundRecoveryRef = React.useRef(false);
  const backgroundPolicyGenerationRef = React.useRef(0);
  const [backgroundTracking, setBackgroundTracking] = React.useState<{
    running: boolean;
    reason:
      | "disabled_by_policy_or_device"
      | "foreground_permission_denied"
      | "background_permission_denied"
      | "started"
      | "updated";
  }>({
    running: false,
    reason: "disabled_by_policy_or_device",
  });
  const trackingPolicyQuery = useQuery({
    queryKey: ["policy", "location_tracking_policy", stableStringify(policyContext)],
    queryFn: async () => resolvePolicyRow(client, "resolve_location_tracking_policy", policyContext),
    staleTime: 5 * 60_000,
  });

  const trackingPolicyRow = trackingPolicyQuery.data ?? null;
  const trackingPolicyLoaded = trackingPolicyQuery.isSuccess;
  const trackingPolicyUnavailable =
    trackingPolicyQuery.isError || (trackingPolicyLoaded && trackingPolicyRow == null);

  const locationPolicy = React.useMemo(
    () => normalizeMobileLocationTrackingPolicy(asRecord(trackingPolicyQuery.data).value ?? null),
    [trackingPolicyQuery.data]
  );
  const trackingEnabled = locationPolicy.enabled;
  const backgroundPolicyEnabled = trackingEnabled && locationPolicy.backgroundEnabled;

  React.useEffect(() => {
    let cancelled = false;
    backgroundPolicyGenerationRef.current += 1;

    if (Platform.OS === "web") {
      setBackgroundTracking({
        running: false,
        reason: "disabled_by_policy_or_device",
      });
      setBackgroundSyncing(false);
      return () => {
        cancelled = true;
        backgroundPolicyGenerationRef.current += 1;
      };
    }

    const syncBackground = async () => {
      setBackgroundSyncing(true);
      try {
        const next = await syncBackgroundLocationTracking({
          deviceId,
          policy: locationPolicy,
        });
        if (!cancelled) setBackgroundTracking(next);
      } catch {
        if (!cancelled) {
          setBackgroundTracking({
            running: false,
            reason: "disabled_by_policy_or_device",
          });
        }
      } finally {
        if (!cancelled) setBackgroundSyncing(false);
      }
    };

    syncBackground().catch((error) => {
      logDebugFailure("failed to sync background location tracking", error);
    });
    return () => {
      cancelled = true;
      backgroundPolicyGenerationRef.current += 1;
    };
  }, [
    deviceId,
    locationPolicy.backgroundAccuracy,
    locationPolicy.backgroundDeferredUpdatesIntervalMs,
    locationPolicy.backgroundDistanceIntervalM,
    locationPolicy.backgroundEnabled,
    locationPolicy.backgroundNotificationBody,
    locationPolicy.backgroundNotificationTitle,
    locationPolicy.backgroundPausesUpdatesAutomatically,
    locationPolicy.backgroundShowsIndicator,
    locationPolicy.backgroundTimeIntervalMs,
    locationPolicy.enabled,
    locationPolicy.maxAccuracyM,
    locationPolicy.requestBackgroundPermission,
  ]);

  React.useEffect(() => {
    let cancelled = false;
    if (Platform.OS === "web") {
      setBackgroundTracking((prev) => ({
        ...prev,
        running: false,
        reason: "disabled_by_policy_or_device",
      }));
      return () => {
        cancelled = true;
      };
    }
    getBackgroundLocationTrackingState()
      .then((current) => {
        if (cancelled) return;
        setBackgroundTracking((prev) => ({
          running: current.running,
          reason: current.running ? prev.reason : "disabled_by_policy_or_device",
        }));
      })
      .catch((error) => {
        logDebugFailure("failed to read background tracking state", error);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const backgroundStatusText = React.useMemo(() => {
    if (Platform.OS === "web") return "Unavailable in the web app";
    if (trackingPolicyQuery.isLoading) return "Loading policy...";
    if (trackingPolicyUnavailable) return "Policy unavailable";
    if (!backgroundPolicyEnabled) return "Disabled by policy";
    if (backgroundSyncing) return "Updating background task...";
    if (backgroundTracking.running) return "Running";
    if (
      backgroundTracking.reason === "foreground_permission_denied" ||
      backgroundTracking.reason === "background_permission_denied"
    ) {
      return "Permission required";
    }
    return "Stopped";
  }, [
    backgroundPolicyEnabled,
    backgroundSyncing,
    backgroundTracking.reason,
    backgroundTracking.running,
    trackingPolicyQuery.isLoading,
    trackingPolicyUnavailable,
  ]);

  const captureLocation = async () => {
    if (captureLocationRef.current || status === "loading") return;
    captureLocationRef.current = true;
    setStatus("loading");
    try {
      if (trackingPolicyQuery.isLoading) {
        Alert.alert("Location disabled", "Location policy is still loading. Retry in a moment.");
        return;
      }
      if (trackingPolicyUnavailable) {
        Alert.alert(
          "Location disabled",
          "Unable to load location policy. Connect online and sync, or contact your administrator."
        );
        return;
      }
      if (!trackingEnabled) {
        Alert.alert("Location disabled", "Location tracking is disabled by policy.");
        return;
      }
      const permission = await Location.getForegroundPermissionsAsync();
      if (permission.status !== "granted") {
        const req = permission.canAskAgain === false
          ? permission
          : await Location.requestForegroundPermissionsAsync();
        if (req.status !== "granted") {
          Alert.alert(
            "Location permission required",
            "Grant location access to capture a ping.",
            [
              { text: "Cancel", style: "cancel" },
              {
                text: "Open settings",
                onPress: () => {
                  void openSystemSettingsSafe();
                },
              },
            ]
          );
          return;
        }
      }

      const next = await Location.getCurrentPositionAsync({
        accuracy: toExpoLocationAccuracy(locationPolicy.foregroundAccuracy),
      });
      if (
        locationPolicy.maxAccuracyM != null &&
        typeof next.coords.accuracy === "number" &&
        next.coords.accuracy > locationPolicy.maxAccuracyM
      ) {
        Alert.alert(
          "Low accuracy",
          `Captured accuracy (${Math.floor(next.coords.accuracy)}m) exceeds policy threshold (${locationPolicy.maxAccuracyM}m).`
        );
      }
      setPosition(next);
      onSpeedObserved?.(speedMpsToKph(next.coords.speed));
    } finally {
      setStatus("idle");
      captureLocationRef.current = false;
    }
  };

  const isQueueingPingRef = React.useRef(false);
  const [isQueueingPing, setIsQueueingPing] = React.useState(false);
  const canQueuePing = Boolean(deviceId && position?.coords && trackingEnabled && !isQueueingPing);

  const queuePing = async () => {
    if (isQueueingPingRef.current) return;
    isQueueingPingRef.current = true;
    setIsQueueingPing(true);

    try {
      if (!deviceId) {
        Alert.alert("Device setup required", "Device must be registered before location ingest.");
        return;
      }
      if (trackingPolicyQuery.isLoading) {
        Alert.alert("Location disabled", "Location policy is still loading. Retry in a moment.");
        return;
      }
      if (trackingPolicyUnavailable) {
        Alert.alert(
          "Location disabled",
          "Unable to load location policy. Connect online and sync, or contact your administrator."
        );
        return;
      }
      if (!trackingEnabled) {
        Alert.alert("Location disabled", "Location tracking is disabled by policy.");
        return;
      }
      if (!position?.coords) {
        Alert.alert("No location", "Capture a location first.");
        return;
      }
      if (
        locationPolicy.maxAccuracyM != null &&
        typeof position.coords.accuracy === "number" &&
        position.coords.accuracy > locationPolicy.maxAccuracyM
      ) {
        Alert.alert(
          "Low accuracy",
          `Latest capture accuracy (${Math.floor(position.coords.accuracy)}m) exceeds policy threshold (${locationPolicy.maxAccuracyM}m). Capture again or move to open sky.`
        );
        return;
      }

      const scoped = routeLocationContext ? await verifyLocationScope?.() : null;
      if (routeLocationContext && (!scoped || scoped.actorId !== routeLocationContext.actorId ||
        scoped.routeRunId !== routeLocationContext.routeRunId || scoped.routeStopId !== routeLocationContext.routeStopId)) {
        throw new Error(strings.scan.routeLocationChanged);
      }
      let attestation: MobileAttestationEnvelope | null = null;
      try {
        attestation = await buildAttestationEnvelope({
          rpcName: "record_location_ping_v1",
          deviceId,
          resourceId: readContextId(policyContext, "resource_id"),
          source: "mobile",
        });
      } catch (error) {
        const message =
          error instanceof Error && error.message
            ? error.message
            : "Attestation failed. Retry while online.";
        Alert.alert("Attestation required", message);
        return;
      }

      if (scoped) {
        const current = await verifyLocationScope?.();
        if (!current || current.actorId !== scoped.actorId || current.routeRunId !== scoped.routeRunId ||
          current.routeStopId !== scoped.routeStopId) throw new Error(strings.scan.routeLocationChanged);
      }
      const id = createOutboxId();
      await outbox.enqueue({
        id,
        rpc: "record_location_ping_v1",
        args: {
          p_ping: {
            idempotency_key: id,
            device_id: deviceId,
            lat: position.coords.latitude,
            lng: position.coords.longitude,
            accuracy_m: position.coords.accuracy ?? null,
            speed_mps: position.coords.speed ?? null,
            heading_deg: position.coords.heading ?? null,
            captured_at: new Date().toISOString(),
            ...(scoped ? { route_run_id: scoped.routeRunId, route_stop_id: scoped.routeStopId } : {}),
            metadata: {
              app: "fieldops",
              source: "mobile",
              ...(scoped ? { route_location_context: scoped } : {}),
              ...(attestation ? { attestation } : {}),
            },
          },
        },
      });

      queryClient.invalidateQueries({ queryKey: ["outbox", "count"] });
      queryClient.invalidateQueries({ queryKey: ["outbox", "entries"] });

      if (online && !syncing) onSync();
    } catch (error) {
      Alert.alert(strings.scan.routeLocationBlocked, formatUnknownError(error));
    } finally {
      isQueueingPingRef.current = false;
      setIsQueueingPing(false);
    }
  };

  return (
    <ScrollView contentContainerStyle={styles.screen}>
      <View style={styles.screenHeader}>
        <View style={styles.screenHeaderText}>
          <Text style={styles.resourceTitle}>Location</Text>
          <Text style={styles.resourceSubtitle}>
            {trackingPolicyQuery.isLoading
              ? "Loading policy..."
              : trackingPolicyUnavailable
                ? "Policy unavailable"
                : trackingEnabled
                  ? strings.scan.ready
                  : "Disabled by policy"}
          </Text>
        </View>
        <Pressable
          onPress={onSync}
          {...syncAccessibility}
          disabled={syncAccessibility.accessibilityState.disabled}
          style={({ pressed }) => [
            styles.syncNowButton,
            syncAccessibility.accessibilityState.disabled && styles.syncButtonDisabled,
            pressed && styles.syncButtonPressed,
          ]}
        >
          <Text style={styles.syncButtonText}>{syncing ? strings.shell.syncing : strings.shell.syncNow}</Text>
        </Pressable>
      </View>

      {!deviceId ? (
        <View style={styles.noticeCard}>
          <Text style={styles.noticeText}>Device setup required for ingest.</Text>
          <Text style={styles.noticeSubtext}>
            Connect online to complete registration, then retry.
          </Text>
        </View>
      ) : null}

      {trackingPolicyUnavailable ? (
        <View style={styles.noticeCard}>
          <Text style={styles.noticeText}>Location policy unavailable</Text>
          <Text style={styles.noticeSubtext}>
            Location tracking is disabled until the policy can be resolved. Connect online and tap Sync now, or
            contact your administrator.
          </Text>
          {diagnosticsEnabled ? (
            <Text style={[styles.mono, { marginTop: 8 }]} numberOfLines={6}>
              {formatUnknownError(trackingPolicyQuery.error)}
            </Text>
          ) : null}
        </View>
      ) : null}

      <View style={styles.noticeCard}>
        <Text style={styles.noticeText}>Background tracking</Text>
        <Text style={styles.noticeSubtext}>{backgroundStatusText}</Text>
        <Text style={styles.noticeSubtext}>
          {Platform.OS === "web"
            ? "Location capture works while the app is open; background tracking requires the native app."
            : "Outbox-driven updates via task manager."}
        </Text>
      </View>

      {(backgroundTracking.reason === "foreground_permission_denied" || backgroundTracking.reason === "background_permission_denied") ? (
        <Pressable
          {...mobileActionAccessibility(strings.actionAccessibility.recoverLocationHint, backgroundSyncing || !backgroundPolicyEnabled, backgroundSyncing)}
          accessibilityLabel={strings.actionAccessibility.recoverLocation}
          accessibilityHint={strings.actionAccessibility.recoverLocationHint}
          disabled={backgroundSyncing || !backgroundPolicyEnabled}
          onPress={() => {
            if (backgroundRecoveryRef.current || backgroundSyncing || !backgroundPolicyEnabled) return;
            backgroundRecoveryRef.current = true;
            const generation = backgroundPolicyGenerationRef.current;
            const isCurrent = () => generation === backgroundPolicyGenerationRef.current;
            setBackgroundSyncing(true);
            void (async () => {
              try {
                const permission = backgroundTracking.reason === "foreground_permission_denied"
                  ? await Location.getForegroundPermissionsAsync()
                  : await Location.getBackgroundPermissionsAsync();
                if (!isCurrent()) return;
                if (permission.status !== "granted" && (permission.canAskAgain === false || (backgroundTracking.reason === "background_permission_denied" && !locationPolicy.requestBackgroundPermission))) {
                  await openSystemSettingsSafe();
                  return;
                }
                const next = await syncBackgroundLocationTracking({ deviceId, policy: locationPolicy });
                if (isCurrent()) setBackgroundTracking(next);
              } catch (error) {
                logDebugFailure("failed to recover background location permission", error);
              } finally {
                backgroundRecoveryRef.current = false;
                if (isCurrent()) setBackgroundSyncing(false);
              }
            })();
          }}
          style={({ pressed }) => [styles.secondaryButton, pressed && styles.navItemPressed]}
        >
          <Text style={styles.secondaryButtonText}>{strings.actionAccessibility.recoverLocation}</Text>
        </Pressable>
      ) : null}

      <View style={styles.noticeCard}>
        {routeLocationContext ? (
          <View>
            <Text>{strings.scan.routeLocationScoped}</Text>
            <Pressable accessibilityRole="button" style={styles.secondaryButton} onPress={onClearLocationScope}>
              <Text style={styles.secondaryButtonText}>{strings.scan.routeLocationClear}</Text>
            </Pressable>
          </View>
        ) : null}
        <Text style={styles.noticeText}>Latest capture</Text>
        <LocationCaptureStatus capturedAt={position?.timestamp} maxAccuracyM={locationPolicy.maxAccuracyM} />
        {position?.coords ? (
          <Text style={styles.mono}>
            lat={position.coords.latitude} lng={position.coords.longitude} acc={position.coords.accuracy ?? "?"} speed_kph={speedMpsToKph(position.coords.speed)}
          </Text>
        ) : (
          <Text style={styles.noticeSubtext}>No location captured.</Text>
        )}
      </View>

      <View style={styles.screenActionsRow}>
        <Pressable
          onPress={() => {
            void captureLocation();
          }}
          {...mobileActionAccessibility(status === "loading" ? strings.actionAccessibility.busy : trackingPolicyQuery.isLoading ? strings.actionAccessibility.policyLoading : trackingPolicyUnavailable ? strings.actionAccessibility.policyUnavailable : strings.actionAccessibility.policyDisabled, !trackingEnabled || trackingPolicyQuery.isLoading || trackingPolicyUnavailable || status === "loading", status === "loading")}
          disabled={
            !trackingEnabled ||
            trackingPolicyQuery.isLoading ||
            trackingPolicyUnavailable ||
            status === "loading"
          }
          style={({ pressed }) => [
            styles.secondaryButton,
            status === "loading" && styles.primaryButtonDisabled,
            pressed && styles.navItemPressed,
          ]}
        >
          <Text style={styles.secondaryButtonText}>
            {status === "loading" ? "Working..." : "Capture location"}
          </Text>
        </Pressable>
        <Pressable
          onPress={() => {
            void queuePing();
          }}
          {...mobileActionAccessibility(isQueueingPing ? strings.actionAccessibility.busy : !deviceId ? strings.actionAccessibility.deviceMissing : trackingPolicyQuery.isLoading ? strings.actionAccessibility.policyLoading : trackingPolicyUnavailable ? strings.actionAccessibility.policyUnavailable : !trackingEnabled ? strings.actionAccessibility.policyDisabled : strings.actionAccessibility.locationMissing, !canQueuePing, isQueueingPing)}
          disabled={!canQueuePing}
          style={({ pressed }) => [
            styles.primaryButton,
            !canQueuePing && styles.primaryButtonDisabled,
            pressed && canQueuePing && styles.primaryButtonPressed,
          ]}
        >
          <Text style={styles.primaryButtonText}>
            {isQueueingPing ? strings.scan.queueing : "Queue ping"}
          </Text>
        </Pressable>
      </View>

    </ScrollView>
  );
}

function WalletCard({
  client, actorId, scope, cacheStore, cacheReady, online, strings,
}: {
  client: ReturnType<typeof createMobileClient>;
  actorId: string;
  scope: string;
  cacheStore: KeyValueStore;
  cacheReady: boolean;
  online: boolean;
  strings: FieldOpsStrings["wallet"];
}) {
  const styles = useFieldOpsStyles();
  const queryClient = useQueryClient();
  const [currencyText, setCurrencyText] = React.useState("");
  const [amountText, setAmountText] = React.useState("");
  const [feedback, setFeedback] = React.useState<string | null>(null);
  const [submitting, setSubmitting] = React.useState(false);
  const submittingRef = React.useRef(false);
  const liveIdentity = React.useRef("");
  liveIdentity.current = JSON.stringify([actorId, scope]);
  React.useEffect(() => () => { liveIdentity.current = ""; }, []);
  const currency = currencyText.trim().toUpperCase();
  const organizationId = walletScopeOrganization(scope);
  const requestKey = walletStorageKey(actorId, scope);
  const draftQuery = useQuery({
    queryKey: ["wallet-request", actorId, scope],
    queryFn: async () => {
      const stored = await cacheStore.get(requestKey);
      const pending = readWalletDraft(stored, actorId, scope);
      if (stored != null && !pending) throw new Error(strings.storageUnverified);
      return pending;
    },
    enabled: Boolean(cacheReady && actorId && organizationId),
    staleTime: Infinity,
  });
  const draft = draftQuery.data ?? null;
  React.useEffect(() => {
    setCurrencyText("");
    setAmountText("");
    setFeedback(null);
  }, [actorId, scope]);
  React.useEffect(() => {
    if (!draft) return;
    setCurrencyText(draft.currency);
    setAmountText(draft.amount);
  }, [draft]);
  const summaryKey = ["driver-wallet", actorId, scope, currency];
  const summaryQuery = useQuery({
    queryKey: summaryKey,
    queryFn: async () => {
      const { data, error } = await client.schema("api").rpc(
        "ui_get_driver_wallet_summary_v1", { p_currency: currency, p_driver_user_id: null });
      if (error) throw error;
      const summary = readWalletSummary(data, actorId, currency, scope);
      if (!summary) throw new Error(strings.summaryUnverified);
      return summary;
    },
    enabled: Boolean(online && actorId && organizationId && /^[A-Z]{3}$/.test(currency)),
    staleTime: 0,
  });
  const submit = async () => {
    if (submittingRef.current) return;
    submittingRef.current = true;
    setSubmitting(true);
    const epoch = completionReadbackScopeVersion();
    const identity = JSON.stringify([actorId, scope]);
    const current = () => liveIdentity.current === identity &&
      completionReadbackScopeMatches(epoch, actorId, scope);
    try {
      const form = walletForm(currencyText, amountText);
      if (!online || !cacheReady || !draftQuery.isSuccess) {
        throw new Error(strings.onlineRequired);
      }
      if (draft && (draft.currency !== form.currency || draft.amount !== form.amount)) {
        throw new Error(strings.retrySavedFirst);
      }
      const verifiedScope = await resolveVerifiedCompletionScope(client);
      if (!current() || verifiedScope?.actor !== actorId || verifiedScope.scope !== scope || !organizationId) {
        throw new Error(strings.sessionChanged);
      }
      setFeedback(null);
      const request = draft ?? {
        version: 1 as const, actor: actorId, scope,
        currency: form.currency, amount: form.amount, key: createOutboxId(),
      };
      if (!draft) {
        await writeCompletionScopedValue(cacheStore, epoch, actorId, scope,
          () => cacheStore.set(requestKey, request));
        if (!current()) throw new Error(strings.sessionChanged);
        void queryClient.invalidateQueries({ queryKey: ["wallet-request", actorId, scope] });
      }
      if (!current()) throw new Error(strings.sessionChanged);
      const { data, error } = await client.schema("api").rpc(
        "ui_request_driver_wallet_withdrawal_v2", {
          p_amount: request.amount, p_currency: request.currency, p_idempotency_key: request.key,
          p_expected_actor_id: actorId, p_expected_organization_id: organizationId,
        });
      if (error) throw error;
      const receipt = readWalletReceipt(data);
      if (!receipt) throw new Error(strings.receiptUnverified);
      if (!current()) return;
      await writeCompletionScopedValue(cacheStore, epoch, actorId, scope,
        () => cacheStore.set(requestKey, { ...request, taskId: receipt.taskId }));
      if (!current()) return;
      void queryClient.invalidateQueries({ queryKey: ["wallet-request", actorId, scope] });
      setFeedback(receipt.status === "existing" ? strings.existing : strings.requested);
      try {
        const refreshed = await client.schema("api").rpc(
          "ui_get_driver_wallet_summary_v1", { p_currency: request.currency, p_driver_user_id: null });
        if (refreshed.error) throw refreshed.error;
        const summary = readWalletSummary(refreshed.data, actorId, request.currency, scope);
        if (!summary) throw new Error(strings.summaryUnverified);
        if (!current()) return;
        queryClient.setQueryData(["driver-wallet", actorId, scope, request.currency], summary);
      } catch {
        if (current()) setFeedback(strings.summaryWarning);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "";
      if (current()) setFeedback(message === "wallet-invalid-currency" ? strings.invalidCurrency :
        message === "wallet-invalid-amount" ? strings.invalidAmount :
        ["Completion evidence session changed.", "driver_wallet_scope_changed"].includes(message)
          ? strings.sessionChanged :
        [strings.onlineRequired, strings.retrySavedFirst, strings.sessionChanged, strings.receiptUnverified].includes(message)
          ? message : strings.outcomeUnknown);
    } finally {
      if (current()) setSubmitting(false);
      submittingRef.current = false;
    }
  };
  const startAnother = async () => {
    if (!draft?.taskId || submitting) return;
    const epoch = completionReadbackScopeVersion();
    const current = () => liveIdentity.current === JSON.stringify([actorId, scope]) &&
      completionReadbackScopeMatches(epoch, actorId, scope);
    try {
      await writeCompletionScopedValue(cacheStore, epoch, actorId, scope,
        () => cacheStore.remove(requestKey));
      if (!current()) return;
      await queryClient.invalidateQueries({ queryKey: ["wallet-request", actorId, scope] });
      if (!current()) return;
      setAmountText("");
      setFeedback(null);
    } catch {
      if (current()) setFeedback(strings.outcomeUnknown);
    }
  };
  return (
    <View style={styles.noticeCard}>
      <Text style={styles.noticeText}>{strings.title}</Text>
      <Text style={styles.noticeSubtext}>{strings.boundary}</Text>
      <Text style={[styles.noticeSubtext, { marginTop: 8 }]}>{strings.currency}</Text>
      <TextInput style={styles.input} testID="mobile-wallet-currency" accessibilityLabel={strings.currencyAccessibility}
        value={currencyText} onChangeText={setCurrencyText} autoCapitalize="characters"
        maxLength={3} editable={!draft && !submitting} />
      {summaryQuery.isFetching ? <Text style={styles.noticeSubtext}>{strings.reading}</Text> : null}
      {summaryQuery.isError ? <Text style={styles.noticeSubtext}>{strings.unavailable}</Text> : null}
      {summaryQuery.data ? (
        <View>
          <Text style={styles.noticeSubtext}>{strings.balance(currency, summaryQuery.data.balance)}</Text>
          <Text style={styles.noticeSubtext}>{strings.reserved(currency, summaryQuery.data.reserved_withdrawal)}</Text>
          <Text style={styles.noticeSubtext}>{strings.available(currency, summaryQuery.data.available)}</Text>
          <Text style={styles.noticeSubtext}>{strings.payouts(currency, summaryQuery.data.remitted_payout)}</Text>
        </View>
      ) : null}
      <Text style={[styles.noticeSubtext, { marginTop: 8 }]}>{strings.amount}</Text>
      <TextInput style={styles.input} testID="mobile-wallet-amount" accessibilityLabel={strings.amountAccessibility}
        value={amountText} onChangeText={setAmountText} keyboardType="decimal-pad"
        maxLength={30} editable={!draft && !submitting} />
      {draft && !draft.taskId ? <Text style={styles.noticeSubtext}>{strings.saved}</Text> : null}
      {draft?.taskId ? <Text style={styles.noticeSubtext}>{strings.recorded(draft.taskId)}</Text> : null}
      {draftQuery.isError ? <Text style={styles.noticeSubtext}>{strings.storageUnverified}</Text> : null}
      {feedback ? <Text style={styles.noticeSubtext}>{feedback}</Text> : null}
      <View style={[styles.screenActionsRow, { marginTop: 10 }]}>
        <Pressable accessibilityRole="button" testID="mobile-wallet-request"
          onPress={() => void submit()} disabled={!online || !cacheReady || submitting || Boolean(draft?.taskId)}
          style={[styles.primaryButton, (!online || !cacheReady || submitting || draft?.taskId) && styles.primaryButtonDisabled]}>
          <Text style={styles.primaryButtonText}>{submitting ? strings.requesting : draft ? strings.retrySaved : strings.request}</Text>
        </Pressable>
        {draft?.taskId ? <Pressable accessibilityRole="button" testID="mobile-wallet-new-request"
          onPress={() => void startAnother()} style={styles.secondaryButton}>
          <Text style={styles.secondaryButtonText}>{strings.startAnother}</Text>
        </Pressable> : null}
      </View>
    </View>
  );
}

function MoreScreen({
  client,
  actorId,
  walletScope,
  cacheStore,
  cacheReady,
  walletOnline,
  walletEnabled,
  connectivityStatus,
  connectivitySummary,
  outboxCount,
  syncing,
  syncPolicyEnabled,
  outboxStore,
  userEmail,
  accessScopeSummary,
  moduleLabels,
  diagnosticsEnabled,
  diagnosticsAllowToggle,
  diagnosticsDefaultOn,
  simulatedOffline,
  selectedVisibilityMode,
  selectedRouteView,
  visibilityPolicy,
  mapPolicy,
  driverSafetyPolicy,
  drivingSafetyState,
  simulatedSpeedKph,
  uxSafetyPolicy,
  communicationPolicy,
  addressPolicy,
  devicePolicy,
  navigationPolicy,
  runtimePlatform,
  platformOverride,
  effectivePlatform,
  selectedLocaleMode,
  selectedDirectionMode,
  selectedThemeMode,
  displayPolicy,
  strings,
  activeDriverShift,
  canStartShift,
  isMutatingDriverShift,
  onSetDiagnostics,
  onSync,
  onSetVisibilityMode,
  onSetRouteView,
  onSetPlatformOverride,
  onSetSimulatedOffline,
  onSetSimulatedSpeed,
  onSetLocaleMode,
  onSetDirectionMode,
  onSetThemeMode,
  onOpenModule,
  onStartShift,
  onEndShift,
  onSignOut,
}: {
  client: ReturnType<typeof createMobileClient>;
  actorId: string;
  walletScope: string;
  cacheStore: KeyValueStore;
  cacheReady: boolean;
  walletOnline: boolean;
  walletEnabled: boolean;
  connectivityStatus: MobileConnectivityStatus;
  connectivitySummary: string;
  outboxCount: number;
  syncing: boolean;
  syncPolicyEnabled: boolean;
  outboxStore: ReturnType<typeof createSqliteOutboxStore>;
  userEmail: string | null;
  accessScopeSummary: string;
  moduleLabels: string[];
  diagnosticsEnabled: boolean;
  diagnosticsAllowToggle: boolean;
  diagnosticsDefaultOn: boolean;
  simulatedOffline: boolean | null | undefined;
  selectedVisibilityMode: string;
  selectedRouteView: string;
  visibilityPolicy: MobileVisibilityPolicy;
  mapPolicy: MobileMapPolicy;
  driverSafetyPolicy: MobileDriverSafetyPolicy;
  drivingSafetyState: DrivingSafetyState;
  simulatedSpeedKph: number | null | undefined;
  uxSafetyPolicy: MobileUxSafetyPolicy;
  communicationPolicy: MobileCommunicationPolicy;
  addressPolicy: MobileAddressPolicy;
  devicePolicy: MobileDevicePolicy;
  navigationPolicy: MobileNavigationPolicy;
  runtimePlatform: MobilePlatform;
  platformOverride: MobilePlatform | null;
  effectivePlatform: MobilePlatform;
  selectedLocaleMode: MobileLocaleMode;
  selectedDirectionMode: MobileDirectionMode;
  selectedThemeMode: MobileThemeMode;
  displayPolicy: MobileDisplayPolicy;
  strings: FieldOpsStrings;
  activeDriverShift: {
    opsSessionId: string;
    sessionType: string;
    openedAt: string | null;
    branchId: string | null;
  } | null;
  canStartShift: boolean;
  isMutatingDriverShift: boolean;
  onSetDiagnostics: (next: boolean) => Promise<void>;
  onSync: () => void;
  onSetVisibilityMode: (next: string) => Promise<void>;
  onSetRouteView: (next: string) => Promise<void>;
  onSetPlatformOverride: (next: MobilePlatform | null) => Promise<void>;
  onSetSimulatedOffline: (next: boolean | null) => Promise<void>;
  onSetSimulatedSpeed: (next: number | null) => Promise<void>;
  onSetLocaleMode: (next: MobileLocaleMode) => Promise<void>;
  onSetDirectionMode: (next: MobileDirectionMode) => Promise<void>;
  onSetThemeMode: (next: MobileThemeMode) => Promise<void>;
  onOpenModule: (key: "location" | "outbox" | "diagnostics") => void;
  onStartShift: () => void;
  onEndShift: () => void;
  onSignOut: () => void;
}) {
  const styles = useFieldOpsStyles();
  const speedPresets = React.useMemo(() => {
    const threshold = drivingSafetyState.thresholdKph;
    return Array.from(new Set([0, Math.max(0, threshold - 1), threshold, threshold + 10]));
  }, [drivingSafetyState.thresholdKph]);
  const outboxPreviewQuery = useQuery({
    queryKey: ["outbox", "preview", "more", outboxCount],
    queryFn: async () => outboxStore.list({ limit: 5 }),
    enabled: diagnosticsEnabled,
    staleTime: 5_000,
  });
  const preferenceActionRef = React.useRef(false);
  const [isApplyingSettings, setIsApplyingSettings] = React.useState(false);
  const withPreferenceAction = React.useCallback(
    async (action: () => Promise<void>) => {
      if (preferenceActionRef.current) return;
      preferenceActionRef.current = true;
      setIsApplyingSettings(true);
      try {
        await action();
      } catch {
        Alert.alert("Settings update failed", "Unable to save preference.");
      } finally {
        preferenceActionRef.current = false;
        setIsApplyingSettings(false);
      }
    },
    []
  );

  return (
    <ScrollView contentContainerStyle={styles.screen}>
      <View style={styles.screenHeader}>
        <View style={styles.screenHeaderText}>
          <Text style={styles.resourceTitle}>{strings.more.title}</Text>
          <Text style={styles.resourceSubtitle}>{strings.more.subtitle}</Text>
        </View>
      </View>

      <View style={styles.noticeCard}>
        <Text style={styles.noticeText}>Access and modules</Text>
        <Text style={styles.noticeSubtext}>
          User: {userEmail ?? "unknown"}
        </Text>
        <Text style={styles.noticeSubtext}>
          Scope: {accessScopeSummary}
        </Text>
        <Text style={styles.noticeSubtext}>
          Modules: {moduleLabels.length}
        </Text>
        {moduleLabels.length ? (
          <View style={[styles.screenActionsRow, { marginTop: 8 }]}>
            {moduleLabels.map((label) => (
              <View key={label} style={styles.chip}>
                <Text style={styles.chipText}>{label}</Text>
              </View>
            ))}
          </View>
        ) : null}
        <View style={[styles.screenActionsRow, { marginTop: 10 }]}>
          <Pressable
            accessibilityRole="button"
            testID={FIELDOPS_NATIVE_E2E_TEST_IDS.signOut}
            onPress={onSignOut}
            style={({ pressed }) => [styles.secondaryButton, pressed && styles.navItemPressed]}
          >
            <Text style={styles.secondaryButtonText}>{strings.more.signOut}</Text>
          </Pressable>
          <Pressable
            accessibilityRole="button"
            testID="mobile-open-settings"
            onPress={() => {
              void openSystemSettingsSafe();
            }}
            style={({ pressed }) => [styles.secondaryButton, pressed && styles.navItemPressed]}
          >
            <Text style={styles.secondaryButtonText}>{strings.more.openSettings}</Text>
          </Pressable>
        </View>
      </View>

      <View style={styles.noticeCard}>
        <Text style={styles.noticeText}>Operational tools</Text>
        <Text style={styles.noticeSubtext}>
          Keep recovery surfaces reachable from the driver shell.
        </Text>
        <View style={[styles.screenActionsRow, { marginTop: 10 }]}>
          <Pressable
            accessibilityRole="button"
            testID="mobile-open-location"
            onPress={() => onOpenModule("location")}
            style={({ pressed }) => [styles.secondaryButton, pressed && styles.navItemPressed]}
          >
            <Text style={styles.secondaryButtonText}>Open location</Text>
          </Pressable>
          <Pressable
            accessibilityRole="button"
            testID="mobile-open-outbox"
            onPress={() => onOpenModule("outbox")}
            style={({ pressed }) => [styles.secondaryButton, pressed && styles.navItemPressed]}
          >
            <Text style={styles.secondaryButtonText}>Open outbox</Text>
          </Pressable>
          <Pressable
            accessibilityRole="button"
            testID={FIELDOPS_NATIVE_E2E_TEST_IDS.openDiagnostics}
            onPress={() => onOpenModule("diagnostics")}
            style={({ pressed }) => [styles.secondaryButton, pressed && styles.navItemPressed]}
          >
            <Text style={styles.secondaryButtonText}>Open support tools</Text>
          </Pressable>
        </View>
      </View>

      <View style={styles.noticeCard}>
        <Text style={styles.noticeText}>{strings.more.driverShift}</Text>
        <Text style={styles.noticeSubtext}>
          {activeDriverShift
            ? `Shift active${activeDriverShift.openedAt ? ` since ${activeDriverShift.openedAt}` : ""}`
            : strings.more.noActiveShift}
        </Text>
        <Text style={[styles.noticeSubtext, { marginTop: 4 }]}>
          Readiness: auth ok - {canStartShift ? "device online" : "connect online and register device"}
        </Text>
        <View style={[styles.screenActionsRow, { marginTop: 10 }]}>
          <Pressable
            accessibilityRole="button"
            testID="mobile-start-driver-shift"
            onPress={onStartShift}
            disabled={Boolean(activeDriverShift) || !canStartShift || isMutatingDriverShift}
            style={({ pressed }) => [
              styles.primaryButton,
              (activeDriverShift || !canStartShift || isMutatingDriverShift) &&
                styles.primaryButtonDisabled,
              pressed &&
                !activeDriverShift &&
                canStartShift &&
                !isMutatingDriverShift &&
                styles.primaryButtonPressed,
            ]}
          >
            <Text style={styles.primaryButtonText}>
              {isMutatingDriverShift && !activeDriverShift ? "Starting..." : strings.more.startShift}
            </Text>
          </Pressable>
          <Pressable
            accessibilityRole="button"
            testID="mobile-end-driver-shift"
            onPress={onEndShift}
            disabled={!activeDriverShift || isMutatingDriverShift}
            style={({ pressed }) => [
              styles.secondaryButton,
              (!activeDriverShift || isMutatingDriverShift) && styles.primaryButtonDisabled,
              pressed && activeDriverShift && styles.navItemPressed,
            ]}
          >
            <Text style={styles.secondaryButtonText}>
              {isMutatingDriverShift && activeDriverShift ? "Ending..." : strings.more.endShift}
            </Text>
          </Pressable>
        </View>
      </View>

      {walletEnabled ? <WalletCard client={client} actorId={actorId} scope={walletScope}
        cacheStore={cacheStore} cacheReady={cacheReady} online={walletOnline} strings={strings.wallet} /> : null}


      <View style={styles.noticeCard}>
        <Text style={styles.noticeText}>{strings.more.displayPreferences}</Text>
        <Text style={styles.noticeSubtext}>
          Locale {selectedLocaleMode.toUpperCase()} - Direction {selectedDirectionMode.toUpperCase()} -
          Theme {selectedThemeMode}
        </Text>
        <Text style={[styles.noticeSubtext, { marginTop: 8 }]}>{strings.more.locale}</Text>
        {displayPolicy.allowLocaleSelect ? (
          <View style={styles.screenActionsRow}>
            {displayPolicy.allowedLocales.map((localeMode) => (
              <Pressable
                key={localeMode}
                testID={`mobile-locale-${localeMode}`}
                onPress={() => void withPreferenceAction(() => onSetLocaleMode(localeMode))}
                disabled={isApplyingSettings}
                style={({ pressed }) => [
                  styles.chip,
                  selectedLocaleMode === localeMode && styles.navItemSelected,
                  isApplyingSettings && styles.primaryButtonDisabled,
                  pressed && styles.navItemPressed,
                ]}
              >
                <Text style={styles.chipText}>
                  {localeMode === "en" ? strings.more.english : strings.more.arabic}
                </Text>
              </Pressable>
            ))}
          </View>
        ) : null}
        {displayPolicy.allowDirectionOverride ? (
          <>
            <Text style={[styles.noticeSubtext, { marginTop: 8 }]}>{strings.more.direction}</Text>
            <View style={styles.screenActionsRow}>
              {(["ltr", "rtl"] as const).map((directionMode) => (
                <Pressable
                  key={directionMode}
                  onPress={() => void withPreferenceAction(() => onSetDirectionMode(directionMode))}
                  disabled={isApplyingSettings}
                  style={({ pressed }) => [
                    styles.chip,
                    selectedDirectionMode === directionMode && styles.navItemSelected,
                    isApplyingSettings && styles.primaryButtonDisabled,
                    pressed && styles.navItemPressed,
                  ]}
                >
                  <Text style={styles.chipText}>{directionMode.toUpperCase()}</Text>
                </Pressable>
              ))}
            </View>
          </>
        ) : null}
        <Text style={[styles.noticeSubtext, { marginTop: 8 }]}>{strings.more.theme}</Text>
        {displayPolicy.allowThemeSelect ? (
          <View style={styles.screenActionsRow}>
            {displayPolicy.allowedThemes.map((themeMode) => (
              <Pressable
                key={themeMode}
                onPress={() => void withPreferenceAction(() => onSetThemeMode(themeMode))}
                disabled={isApplyingSettings}
                style={({ pressed }) => [
                  styles.chip,
                  selectedThemeMode === themeMode && styles.navItemSelected,
                  isApplyingSettings && styles.primaryButtonDisabled,
                  pressed && styles.navItemPressed,
                ]}
              >
                <Text style={styles.chipText}>
                  {themeMode === "system"
                    ? strings.more.system
                    : themeMode === "light"
                      ? strings.more.light
                      : strings.more.dark}
                </Text>
              </Pressable>
            ))}
          </View>
        ) : null}
      </View>

      <View style={styles.noticeCard}>
        <Text style={styles.noticeText}>Visibility mode</Text>
        <View style={styles.screenActionsRow}>
          {visibilityPolicy.allowedVisibility.map((mode) => (
            <Pressable
              key={mode}
              onPress={() => void withPreferenceAction(() => onSetVisibilityMode(mode))}
              disabled={isApplyingSettings}
              style={({ pressed }) => [
                styles.chip,
                selectedVisibilityMode === mode && styles.navItemSelected,
                isApplyingSettings && styles.primaryButtonDisabled,
                pressed && styles.navItemPressed,
              ]}
            >
              <Text style={styles.chipText}>{mode}</Text>
            </Pressable>
          ))}
        </View>
      </View>

      <View style={styles.noticeCard}>
        <Text style={styles.noticeText}>{strings.more.routeView}</Text>
        <View style={styles.screenActionsRow}>
          {mapPolicy.routeViews.map((mode) => (
            <Pressable
              key={mode}
              accessibilityRole="button"
              testID={`mobile-more-route-view-${mode}`}
              onPress={() => void withPreferenceAction(() => onSetRouteView(mode))}
              disabled={isApplyingSettings}
              style={({ pressed }) => [
                styles.chip,
                selectedRouteView === mode && styles.navItemSelected,
                isApplyingSettings && styles.primaryButtonDisabled,
                pressed && styles.navItemPressed,
              ]}
            >
              <Text style={styles.chipText}>{formatRouteViewLabel(mode, strings)}</Text>
            </Pressable>
          ))}
        </View>
        <Text style={styles.noticeSubtext}>
          Clustering: {mapPolicy.clusteringEnabled ? "enabled" : "disabled"} (grid {mapPolicy.clusteringGridPx}px, min {mapPolicy.clusteringMinCount})
        </Text>
      </View>

      <View style={styles.noticeCard}>
        <Text style={styles.noticeText}>{strings.more.diagnostics}</Text>
        <Text style={styles.noticeSubtext}>
          Default {diagnosticsDefaultOn ? "on" : "off"}{diagnosticsAllowToggle ? ", user toggle enabled" : ", user toggle disabled"}
        </Text>
        {diagnosticsAllowToggle ? (
          <View style={styles.screenActionsRow}>
            <Pressable
              onPress={() =>
                void withPreferenceAction(() => onSetDiagnostics(!diagnosticsEnabled))
              }
              disabled={isApplyingSettings}
              style={({ pressed }) => [
                styles.secondaryButton,
                isApplyingSettings && styles.primaryButtonDisabled,
                pressed && styles.navItemPressed,
              ]}
            >
              <Text style={styles.secondaryButtonText}>
                Diagnostics {diagnosticsEnabled ? "ON" : "OFF"}
              </Text>
            </Pressable>
          </View>
        ) : null}
      </View>

      <View style={styles.noticeCard}>
        <Text style={styles.noticeText}>{strings.more.connectivityOutbox}</Text>
        <Text style={styles.noticeSubtext}>
          Network: {formatConnectivityStatusLabel(connectivityStatus, strings).toLowerCase()}
        </Text>
        <Text style={styles.noticeSubtext}>{connectivitySummary}</Text>
        <Text style={styles.noticeSubtext}>
          Pending actions: {outboxCount}
        </Text>
        <View style={[styles.screenActionsRow, { marginTop: 8 }]}>
          <Pressable
            onPress={onSync}
            {...mobileSyncAccessibility(strings.actionAccessibility, syncing, connectivityStatus !== "offline", syncPolicyEnabled, outboxCount)}
            disabled={!syncPolicyEnabled || connectivityStatus === "offline" || syncing}
            style={({ pressed }) => [
              styles.primaryButton,
              (!syncPolicyEnabled || connectivityStatus === "offline" || syncing) &&
                styles.primaryButtonDisabled,
              pressed &&
                connectivityStatus !== "offline" &&
                syncPolicyEnabled &&
                !syncing &&
                styles.primaryButtonPressed,
            ]}
          >
            <Text style={styles.primaryButtonText}>
              {syncing ? strings.shell.syncing : strings.shell.syncNow}
            </Text>
          </Pressable>
        </View>
        {diagnosticsEnabled ? (
          <View style={[styles.screenActionsRow, { marginTop: 8 }]}>
            <Pressable
              onPress={() => void withPreferenceAction(() => onSetSimulatedOffline(false))}
              disabled={isApplyingSettings}
              style={({ pressed }) => [
                styles.chip,
                simulatedOffline === false && styles.navItemSelected,
                isApplyingSettings && styles.primaryButtonDisabled,
                pressed && styles.navItemPressed,
              ]}
            >
              <Text style={styles.chipText}>Force online</Text>
            </Pressable>
            <Pressable
              onPress={() => void withPreferenceAction(() => onSetSimulatedOffline(true))}
              disabled={isApplyingSettings}
              style={({ pressed }) => [
                styles.chip,
                simulatedOffline === true && styles.navItemSelected,
                isApplyingSettings && styles.primaryButtonDisabled,
                pressed && styles.navItemPressed,
              ]}
            >
              <Text style={styles.chipText}>Force offline</Text>
            </Pressable>
            <Pressable
              onPress={() => void withPreferenceAction(() => onSetSimulatedOffline(null))}
              disabled={isApplyingSettings}
              style={({ pressed }) => [
                styles.chip,
                simulatedOffline == null && styles.navItemSelected,
                isApplyingSettings && styles.primaryButtonDisabled,
                pressed && styles.navItemPressed,
              ]}
            >
              <Text style={styles.chipText}>Use network</Text>
            </Pressable>
          </View>
        ) : null}
        {diagnosticsEnabled ? (
          <View style={{ marginTop: 10 }}>
            <Text style={styles.noticeSubtext}>Recent outbox entries</Text>
            {outboxPreviewQuery.data?.length ? (
              outboxPreviewQuery.data.map((entry) => {
                const feedback = describeMobileOutboxEntry(entry, strings);
                return <Text key={entry.id} style={styles.noticeSubtext} accessibilityLabel={feedback.accessibilityLabel}>
                  {feedback.status} — {feedback.title} — {feedback.targetLabel}
                </Text>;
              })
            ) : (
              <Text style={styles.noticeSubtext}>No recent outbox entries.</Text>
            )}
          </View>
        ) : null}
      </View>

      <View style={styles.noticeCard}>
        <Text style={styles.noticeText}>Driver safety</Text>
        <Text style={styles.noticeSubtext}>
          {driverSafetyPolicy.enabled ? "Enabled" : "Disabled"} - lock at{" "}
          {driverSafetyPolicy.lockThresholdKph} kph
        </Text>
        <Text style={styles.noticeSubtext}>
          Allowed while moving: {driverSafetyPolicy.allowedNavKeysWhileMoving.join(", ")}
        </Text>
        <Text style={styles.noticeSubtext}>
          Current speed: {Math.round(drivingSafetyState.speedKph)} kph -{" "}
          {drivingSafetyState.locked ? "LOCKED" : "UNLOCKED"}
        </Text>
        {diagnosticsEnabled ? (
          <View style={{ marginTop: 8 }}>
            <Text style={styles.noticeSubtext}>
              Diagnostics speed override:{" "}
              {simulatedSpeedKph == null ? "off" : `${simulatedSpeedKph} kph`}
            </Text>
            <View style={[styles.screenActionsRow, { marginTop: 8 }]}>
              {speedPresets.map((speed) => (
                <Pressable
                  key={speed}
                  onPress={() => void withPreferenceAction(() => onSetSimulatedSpeed(speed))}
                  disabled={isApplyingSettings}
                  style={({ pressed }) => [
                    styles.chip,
                    simulatedSpeedKph === speed && styles.navItemSelected,
                    isApplyingSettings && styles.primaryButtonDisabled,
                    pressed && styles.navItemPressed,
                  ]}
                >
                  <Text style={styles.chipText}>{speed} kph</Text>
                </Pressable>
              ))}
              <Pressable
                onPress={() => void withPreferenceAction(() => onSetSimulatedSpeed(null))}
                disabled={isApplyingSettings}
                style={({ pressed }) => [
                  styles.chip,
                  simulatedSpeedKph == null && styles.navItemSelected,
                  isApplyingSettings && styles.primaryButtonDisabled,
                  pressed && styles.navItemPressed,
                ]}
              >
                <Text style={styles.chipText}>Use live speed</Text>
              </Pressable>
            </View>
          </View>
        ) : null}
      </View>

      <View style={styles.noticeCard}>
        <Text style={styles.noticeText}>UX safety</Text>
        <Text style={styles.noticeSubtext}>
          Double-tap actions: {uxSafetyPolicy.requireDoubleTapFor.join(", ")}
        </Text>
      </View>

      <View style={styles.noticeCard}>
        <Text style={styles.noticeText}>Communication channels</Text>
        <Text style={styles.noticeSubtext}>{communicationPolicy.allowedChannels.join(", ")}</Text>
      </View>

      <View style={styles.noticeCard}>
        <Text style={styles.noticeText}>Address display</Text>
        <Text style={styles.noticeSubtext}>
          Fields: {addressPolicy.fields.map((field) => field.key).join(", ")}
        </Text>
        <Text style={styles.noticeSubtext}>
          Coordinates {addressPolicy.showCoordinates ? "on" : "off"} - Accuracy{" "}
          {addressPolicy.showAccuracy ? "on" : "off"}
        </Text>
      </View>

      <View style={styles.noticeCard}>
        <Text style={styles.noticeText}>Platform and navigation</Text>
        <Text style={styles.noticeSubtext}>
          Runtime platform: {runtimePlatform}
        </Text>
        <Text style={styles.noticeSubtext}>
          Effective platform: {effectivePlatform}
        </Text>
        {diagnosticsEnabled ? (
          <View style={{ marginTop: 8 }}>
            <Text style={styles.noticeSubtext}>
              Platform override: {platformOverride ?? "off (runtime)"}
            </Text>
            <View style={[styles.screenActionsRow, { marginTop: 8 }]}>
              {devicePolicy.allowedPlatforms.map((platformMode) => (
                <Pressable
                  key={platformMode}
                  onPress={() =>
                    void withPreferenceAction(() => onSetPlatformOverride(platformMode))
                  }
                  disabled={isApplyingSettings}
                  style={({ pressed }) => [
                    styles.chip,
                    platformOverride === platformMode && styles.navItemSelected,
                    isApplyingSettings && styles.primaryButtonDisabled,
                    pressed && styles.navItemPressed,
                  ]}
                >
                  <Text style={styles.chipText}>{platformMode}</Text>
                </Pressable>
              ))}
              <Pressable
                onPress={() => void withPreferenceAction(() => onSetPlatformOverride(null))}
                disabled={isApplyingSettings}
                style={({ pressed }) => [
                  styles.chip,
                  platformOverride == null && styles.navItemSelected,
                  isApplyingSettings && styles.primaryButtonDisabled,
                  pressed && styles.navItemPressed,
                ]}
              >
                <Text style={styles.chipText}>Use runtime</Text>
              </Pressable>
            </View>
          </View>
        ) : null}
        <Text style={styles.noticeSubtext}>
          Allowed platforms: {devicePolicy.allowedPlatforms.join(", ")}
        </Text>
        <Text style={styles.noticeSubtext}>
          Route provider:{" "}
          {navigationPolicy.providerByPlatform[effectivePlatform] ??
            navigationPolicy.providerByPlatform.android}
        </Text>
      </View>
    </ScrollView>
  );
}

function DiagnosticsScreen({
  strings,
  me,
  connectivityStatus,
  deviceId,
  outboxCount,
  diagnosticsEnabled,
  allowUserToggle,
  toggleValue,
  defaultOn,
  policyRow,
  cacheStore,
  outboxStore,
  storage,
  onToggle,
  onClearLocal,
  onRetryDeviceRegistration,
}: {
  strings: FieldOpsStrings;
  me: UiMe | null;
  connectivityStatus: MobileConnectivityStatus;
  deviceId: string | null;
  outboxCount: number;
  diagnosticsEnabled: boolean;
  allowUserToggle: boolean;
  toggleValue: boolean | null;
  defaultOn: boolean;
  policyRow: unknown;
  cacheStore: ReturnType<typeof createSqliteKeyValueStore>;
  outboxStore: ReturnType<typeof createSqliteOutboxStore>;
  storage: MobileStorageAdapter;
  onToggle: (next: boolean) => Promise<void>;
  onClearLocal: () => Promise<void>;
  onRetryDeviceRegistration: () => void;
}) {
  const styles = useFieldOpsStyles();
  const queryClient = useQueryClient();
  const [busy, setBusy] = React.useState(false);
  const diagnosticActionRef = React.useRef(false);

  const policyValue = asRecord(asRecord(policyRow).value);
  const policyEnabled = policyValue?.enabled === true;

  const effectiveDiagnosticsOn = diagnosticsEnabled;
  const userToggle = toggleValue ?? defaultOn;

  const outboxStatsQuery = useQuery({
    queryKey: ["outbox", "stats"],
    queryFn: async () => {
      const entries = await outboxStore.list({ limit: 500 });
      const counts: Record<string, number> = {};
      for (const entry of entries) {
        counts[entry.status] = (counts[entry.status] ?? 0) + 1;
      }
      return counts;
    },
    staleTime: 10_000,
  });

  const withDiagnosticsAction = React.useCallback(async (action: () => Promise<void>) => {
    if (diagnosticActionRef.current) return;
    diagnosticActionRef.current = true;
    setBusy(true);
    try {
      await action();
    } catch {
      showMobileNotice("Diagnostics action failed", "Please retry this operation.");
    } finally {
      diagnosticActionRef.current = false;
      setBusy(false);
    }
  }, []);

  const handleToggle = async () => {
    if (!policyEnabled || !allowUserToggle) return;
    await withDiagnosticsAction(async () => {
      await onToggle(!userToggle);
    });
  };

  const handleClear = () => {
    if (diagnosticActionRef.current) return;
    const title = "Clear local data?";
    const message = "This signs you out and removes local data from this device.";
    const clearConfirmed = () => {
      void withDiagnosticsAction(async () => {
        await onClearLocal();
        queryClient.invalidateQueries();
      });
    };
    if (Platform.OS === "web") {
      // Match showMobileNotice's native-browser boundary; missing confirmation fails closed.
      const webConfirm = (globalThis as unknown as { confirm?: unknown }).confirm;
      if (typeof webConfirm === "function" && (webConfirm as (text: string) => boolean).call(globalThis, `${title}\n\n${message}`)) {
        clearConfirmed();
      }
      return;
    }
    Alert.alert(title, message, [
      { text: "Cancel", style: "cancel" },
      { text: "Clear", style: "destructive", onPress: clearConfirmed },
    ]);
  };

  return (
    <ScrollView contentContainerStyle={styles.screen}>
      <View style={styles.screenHeader}>
        <View style={styles.screenHeaderText}>
          <Text style={styles.resourceTitle}>{strings.more.diagnostics}</Text>
          <Text style={styles.resourceSubtitle}>
            {policyEnabled ? "Policy enabled" : "Disabled by policy"} -{" "}
            {formatConnectivityStatusLabel(connectivityStatus, strings).toLowerCase()}
          </Text>
        </View>
      </View>

      <View style={styles.noticeCard}>
        <Text style={styles.noticeText}>Session</Text>
        <Text style={styles.noticeSubtext}>
          {me?.user?.email ?? "unknown"} - scope {me?.access_scope?.scope_type ?? "?"}
        </Text>
        <Text style={styles.noticeSubtext}>
          Device: {deviceId ? "registered" : "missing"} - Outbox pending: {outboxCount}
        </Text>
      </View>

      {!deviceId ? (
        <View style={styles.screenActionsRow}>
          <Pressable
            onPress={onRetryDeviceRegistration}
            disabled={busy}
            style={({ pressed }) => [
              styles.secondaryButton,
              pressed && styles.navItemPressed,
              busy && styles.primaryButtonDisabled,
            ]}
          >
            <Text style={styles.secondaryButtonText}>Retry device registration</Text>
          </Pressable>
        </View>
      ) : null}

      {policyEnabled && allowUserToggle ? (
        <Pressable
          onPress={() => {
            void handleToggle();
          }}
          disabled={busy}
          style={({ pressed }) => [styles.noticeCard, pressed && styles.navItemPressed]}
        >
          <Text style={styles.noticeText}>
            Diagnostics {userToggle ? "ON" : "OFF"}
          </Text>
          <Text style={styles.noticeSubtext}>
            Tap to toggle (default {defaultOn ? "on" : "off"})
          </Text>
        </Pressable>
      ) : (
        <View style={styles.noticeCard}>
          <Text style={styles.noticeText}>
            Diagnostics {effectiveDiagnosticsOn ? "ON" : "OFF"}
          </Text>
          <Text style={styles.noticeSubtext}>
            {policyEnabled
              ? "Toggles disabled by policy."
              : "Diagnostics are disabled by policy."}
          </Text>
        </View>
      )}

      <View style={styles.screenActionsRow}>
        <Pressable
          accessibilityRole="button"
          onPress={handleClear}
          disabled={busy}
          style={({ pressed }) => [
            styles.secondaryButton,
            pressed && styles.navItemPressed,
            busy && styles.primaryButtonDisabled,
          ]}
        >
          <Text style={styles.secondaryButtonText}>Clear local data</Text>
        </Pressable>
      </View>

      {effectiveDiagnosticsOn ? (
        <>
          <View style={styles.noticeCard}>
            <Text style={styles.noticeText}>Outbox stats</Text>
            <Text style={styles.mono}>{stableStringify(outboxStatsQuery.data ?? {})}</Text>
          </View>
        </>
      ) : null}
    </ScrollView>
  );
}

function routeManifestSnapshot(manifest: unknown) {
  const routeManifest = asRecord(manifest);
  const scanOut = asRecord(routeManifest.scan_out);
  const routeDeparture = asRecord(routeManifest.route_departure);
  const expectedStopCount =
    coerceValueNumber(scanOut.expected_stop_count) ?? coerceValueNumber(routeManifest.stop_count);
  const scannedStopCount = coerceValueNumber(scanOut.scanned_stop_count);
  const missingStopCount = coerceValueNumber(scanOut.missing_stop_count);
  const unexpectedScanCount = coerceValueNumber(scanOut.unexpected_scan_count) ?? 0;
  const duplicateScanCount = coerceValueNumber(scanOut.duplicate_scan_count) ?? 0;
  const isRouteDepartureReady = scanOut.ready_for_departure === true;
  const routeDepartureConfirmedAt = coerceValueText(routeDeparture.confirmed_at);
  const routeDepartureConfirmedBy = coerceValueText(routeDeparture.confirmed_by_user_id);
  const routeLoadScannedAt = coerceValueText(scanOut.last_load_scanned_at);
  const unexpectedBarcodeSummary = Array.isArray(scanOut.unexpected_barcodes)
    ? scanOut.unexpected_barcodes
        .map((value) => coerceValueText(value))
        .filter((value): value is string => Boolean(value))
        .slice(0, 3)
        .join(", ")
    : null;
  return { expectedStopCount, scannedStopCount, missingStopCount, unexpectedScanCount, duplicateScanCount, isRouteDepartureReady, routeDepartureConfirmedAt, routeDepartureConfirmedBy, routeLoadScannedAt, unexpectedBarcodeSummary };
}

function RouteManifestReadback({ manifest }: { manifest: unknown }) {
  const styles = useFieldOpsStyles();
  const { expectedStopCount, scannedStopCount, missingStopCount, unexpectedScanCount, duplicateScanCount, isRouteDepartureReady, routeDepartureConfirmedAt, routeDepartureConfirmedBy, routeLoadScannedAt, unexpectedBarcodeSummary } = routeManifestSnapshot(manifest);
  return (
    <>
      <Text style={styles.noticeText}>Route load scan-out</Text>
          <Text style={styles.noticeSubtext}>
            {routeDepartureConfirmedAt
              ? "Departure confirmed"
              : isRouteDepartureReady
                ? "Ready for departure"
                : "Scan route loads before departure"}
          </Text>
          <Text style={[styles.noticeSubtext, { marginTop: 4 }]}>
            Scanned stops: {scannedStopCount ?? 0}
            {expectedStopCount != null ? ` / ${expectedStopCount}` : ""}
          </Text>
          <Text style={styles.noticeSubtext}>
            Missing: {missingStopCount ?? 0} - Unexpected: {unexpectedScanCount} - Duplicate scans: {duplicateScanCount}
          </Text>
          {routeLoadScannedAt ? (
            <Text style={[styles.noticeSubtext, { marginTop: 4 }]}>
              Last route load scan: {routeLoadScannedAt}
            </Text>
          ) : null}
          {unexpectedBarcodeSummary ? (
            <Text style={[styles.noticeSubtext, { marginTop: 4 }]}>
              Unexpected barcodes: {unexpectedBarcodeSummary}
            </Text>
          ) : null}
          {routeDepartureConfirmedAt ? (
            <Text style={[styles.noticeSubtext, { marginTop: 4 }]}>
              Confirmed at {routeDepartureConfirmedAt}
              {routeDepartureConfirmedBy ? ` by ${routeDepartureConfirmedBy}` : ""}
            </Text>
          ) : null}
    </>
  );
}

function RouteSurfaceDetailExtensions({
  strings,
  detail,
  resourceId,
  surfaceLabel,
  diagnosticsEnabled,
  interactionLocked,
  addressActionStrings,
  addressPolicy,
  communicationPolicy,
  navigationPolicy,
  platform,
  routeExecutionManifest,
  routeLoadStrings,
  routeLoadQueueReady,
  onRouteLoadAction,
  isConfirmingRouteDeparture,
  departureRequestState,
  onEnqueueUiEvents,
  onOpenScan,
  onOpenRouteScan,
  onConfirmRouteDeparture,
}: {
  strings: FieldOpsStrings;
  detail: Record<string, unknown>;
  resourceId: string | null;
  surfaceLabel: string;
  diagnosticsEnabled: boolean;
  interactionLocked: boolean;
  addressActionStrings: FieldOpsStrings["addressActions"];
  addressPolicy: MobileAddressPolicy;
  communicationPolicy: MobileCommunicationPolicy;
  navigationPolicy: MobileNavigationPolicy;
  platform: "android" | "ios" | "scanner";
  routeExecutionManifest: Record<string, unknown> | null | undefined;
  routeLoadStrings: FieldOpsStrings["routeLoad"];
  routeLoadQueueReady: boolean;
  onRouteLoadAction: (input: RouteLoadActionInput) => Promise<void>;
  isConfirmingRouteDeparture: boolean;
  departureRequestState: "none" | "pending" | "blocked";
  onEnqueueUiEvents: (events: Array<Record<string, unknown>>) => Promise<void>;
  onOpenScan: () => void;
  onOpenRouteScan: () => void;
  onConfirmRouteDeparture: () => void;
}) {
  const styles = useFieldOpsStyles();
  const stop = React.useMemo(() => extractOperationalStopSnapshot(detail), [detail]);
  const routeContext = React.useMemo(() => extractScanContext(detail, resourceId), [detail, resourceId]);
  const contacts = React.useMemo(
    () => extractOperationalContacts(detail, communicationPolicy),
    [communicationPolicy, detail]
  );
  const coordinates = React.useMemo(() => extractCoordinates(detail), [detail]);
  const addressRows = React.useMemo(
    () => extractAddressFields(detail, addressPolicy),
    [addressPolicy, detail]
  );
  const { routeDepartureConfirmedAt } = routeManifestSnapshot(routeExecutionManifest);
  const routeManifest = React.useMemo(() => asRecord(routeExecutionManifest), [routeExecutionManifest]);
  const parcelManifest = React.useMemo(() => parseRouteLoadManifest(routeManifest.load_manifest), [routeManifest]);
  const [routeLoadNote, setRouteLoadNote] = React.useState("");
  const [routeLoadSubmitting, setRouteLoadSubmitting] = React.useState(false);
  const routeLoadSubmittingRef = React.useRef(false);
  const [routeLoadMessage, setRouteLoadMessage] = React.useState<string | null>(null);
  const [routeLoadError, setRouteLoadError] = React.useState(false);
  const submitRouteLoadAction = async (input: RouteLoadActionInput) => {
    if (routeLoadSubmittingRef.current || interactionLocked || !parcelManifest?.canRecordActions || !routeLoadQueueReady) return;
    if (input.action === "report_discrepancy" && !routeLoadNote.trim()) {
      setRouteLoadError(true);
      setRouteLoadMessage(routeLoadStrings.noteRequired);
      return;
    }
    routeLoadSubmittingRef.current = true;
    setRouteLoadSubmitting(true);
    try {
      await onRouteLoadAction({ ...input, note: routeLoadNote });
      setRouteLoadNote("");
      setRouteLoadError(false);
      setRouteLoadMessage(routeLoadStrings.queued);
    } catch {
      setRouteLoadError(true);
      setRouteLoadMessage(routeLoadStrings.queueFailed);
    } finally {
      routeLoadSubmittingRef.current = false;
      setRouteLoadSubmitting(false);
    }
  };
  const customerContact = contacts.customer;
  const supportContacts = contacts.supportContacts;
  const phone = customerContact?.phone ?? stop.phone;
  const customerName =
    customerContact?.name ?? customerContact?.label ?? stop.customerName ?? extractCustomerName(detail);
  const navigationProvider = navigationPolicy.providerByPlatform[platform] ?? "google_maps";
  const navigationUrl =
    coordinates != null
      ? buildNavigationUrl({
          provider: navigationProvider,
          platform,
          latitude: coordinates.latitude,
          longitude: coordinates.longitude,
        })
      : null;
  const [isExecutingRouteAction, setIsExecutingRouteAction] = React.useState(false);
  const isExecutingRouteActionRef = React.useRef(false);
  const withRouteActionLock = React.useCallback(async (action: () => Promise<void>) => {
    if (isExecutingRouteActionRef.current) return;
    isExecutingRouteActionRef.current = true;
    setIsExecutingRouteAction(true);
    try {
      await action();
    } finally {
      isExecutingRouteActionRef.current = false;
      setIsExecutingRouteAction(false);
    }
  }, []);

  const openExternalAndLog = React.useCallback(
    async (input: {
      url: string | null;
      eventType: string;
      metadata: Record<string, unknown>;
      unavailableMessage: string;
    }) => {
      await withRouteActionLock(async () => {
        if (interactionLocked) {
          Alert.alert(strings.alerts.drivingLockedTitle, "Stop moving before running route actions.");
          return;
        }
        if (!input.url) {
          Alert.alert("Unavailable", input.unavailableMessage);
          return;
        }

        let opened = false;
        try {
          const canOpen = await Linking.canOpenURL(input.url);
          if (!canOpen) throw new Error("unsupported_url");
          await Linking.openURL(input.url);
          opened = true;
        } catch {
          Alert.alert("Action unavailable", input.unavailableMessage);
        }

        await onEnqueueUiEvents([
          {
            event_type: input.eventType,
            captured_at: new Date().toISOString(),
            metadata: {
              app: "fieldops",
              platform,
              opened,
              url: input.url,
              ...input.metadata,
            },
          },
        ]);
      });
    },
    [strings, interactionLocked, onEnqueueUiEvents, platform, withRouteActionLock]
  );

  const statusChips = [
    formatOperationalStatusChip(stop.status, stop.statusReason),
    stop.sequence != null ? `Stop #${stop.sequence}` : null,
    stop.kind ? formatKeyLabel(stop.kind) : null,
    stop.etaMin != null ? `${Math.round(stop.etaMin)}m ETA` : null,
    stop.packageCount != null
      ? `${stop.packageCount} package${stop.packageCount === 1 ? "" : "s"}`
      : null,
    formatMoneyLabel(stop.codAmount, stop.currency)
      ? `${formatMoneyLabel(stop.codAmount, stop.currency)} COD`
      : null,
  ].filter(Boolean) as string[];
  const expectedCodLabel = formatMoneyLabel(stop.expectedAmount ?? stop.codAmount, stop.currency);
  const collectedCodLabel = formatMoneyLabel(stop.collectedAmount, stop.currency);
  const varianceCodLabel = formatMoneyLabel(stop.varianceAmount, stop.currency);
  const proofArtifactLabel =
    stop.proofArtifactCount != null
      ? String(stop.proofArtifactCount)
      : stop.proofArtifactIds.length
        ? String(stop.proofArtifactIds.length)
        : null;
  const allowedMethodsLabel = stop.allowedMethods.length
    ? stop.allowedMethods.map((method) => formatKeyLabel(method)).join(", ")
    : null;
  const showPaymentCollectionCard = Boolean(
    expectedCodLabel ||
      collectedCodLabel ||
      varianceCodLabel ||
      stop.collectionOutcome ||
      stop.discrepancyKind ||
      stop.hasDiscrepancy != null ||
      stop.receiptContext ||
      proofArtifactLabel ||
      stop.signatureArtifactId ||
      stop.paymentModeLabel ||
      allowedMethodsLabel
  );

  const handleNavigate = React.useCallback(() => {
    void (async () => {
      try {
        await openExternalAndLog({
          url: navigationUrl,
            eventType: "mobile_route_navigate",
            metadata: {
              provider: navigationProvider,
              latitude: coordinates?.latitude ?? null,
              longitude: coordinates?.longitude ?? null,
              route_run_id: routeContext.routeRunId,
              route_stop_id: routeContext.routeStopId,
              task_id: routeContext.taskId,
            },
            unavailableMessage: "Navigation coordinates are unavailable for this record.",
          });
        } catch {
          Alert.alert("Action failed", "Unable to launch navigation at this time.");
        }
      })();
  }, [
    coordinates?.latitude,
    coordinates?.longitude,
    navigationProvider,
    navigationUrl,
    openExternalAndLog,
    routeContext.routeRunId,
    routeContext.routeStopId,
    routeContext.taskId,
  ]);

  const handleChannel = React.useCallback(
    (
      contact:
        | {
            label: string;
            role: string;
            source: string;
            phone: string | null;
            name: string | null;
          }
        | null,
      channel: "call" | "sms" | "whatsapp",
      message?: string,
      templateId?: string
    ) => {
      if (!contact?.phone) {
        Alert.alert("Unavailable", `${contact?.label ?? "Contact"} phone number is missing.`);
        return;
      }
      const url = buildChannelUrl({ channel, phone: contact.phone, message });
      void (async () => {
        try {
          await openExternalAndLog({
            url,
            eventType: "mobile_route_contact",
            metadata: {
              channel,
              template_id: templateId ?? null,
              contact_target: contact.label,
              contact_role: contact.role,
              contact_source: contact.source,
              customer_name: customerName,
              phone: contact.phone,
              route_run_id: routeContext.routeRunId,
              route_stop_id: routeContext.routeStopId,
              task_id: routeContext.taskId,
            },
            unavailableMessage: `Unable to open ${channel} for ${contact.label}.`,
          });
        } catch {
          Alert.alert("Action failed", "Unable to launch communication action at this time.");
        }
      })();
    },
    [customerName, openExternalAndLog, routeContext.routeRunId, routeContext.routeStopId, routeContext.taskId]
  );
  const contactChannels = ["call", "sms", "whatsapp"] as const;

  return (
    <>
      <View style={[styles.noticeCard, { marginTop: 12 }]}>
        <Text style={styles.noticeText}>{surfaceLabel}</Text>
        <Text style={styles.noticeSubtext}>
          {formatOperationalTitle({
            title: stop.title,
            customerName: stop.customerName,
            reference: stop.reference,
          })}
        </Text>
        {stop.reference && stop.reference !== stop.title ? (
          <Text style={[styles.noticeSubtext, { marginTop: 4 }]}>{strings.detail.reference(stop.reference)}</Text>
        ) : null}
        {stop.addressSummary ? (
          <Text style={[styles.noticeSubtext, { marginTop: 4 }]}>{stop.addressSummary}</Text>
        ) : (
          <Text style={[styles.noticeSubtext, styles.error, { marginTop: 4 }]}>
            {strings.detail.addressIncomplete}
          </Text>
        )}
        {statusChips.length ? (
          <View style={[styles.cardChips, { marginTop: 10 }]}>
            {statusChips.map((chipValue) => (
              <View key={chipValue} style={styles.chip}>
                <Text style={styles.chipText}>{chipValue}</Text>
              </View>
            ))}
          </View>
        ) : null}
        {stop.notes ? (
          <View style={[styles.detailRow, { marginTop: 10, borderBottomWidth: 0, paddingVertical: 0 }]}>
            <Text style={styles.detailKey}>Instructions</Text>
            <Text style={styles.detailValue}>{stop.notes}</Text>
          </View>
        ) : (
          <Text style={[styles.noticeSubtext, { marginTop: 8 }]}>{strings.detail.noStopInstructions}</Text>
        )}
      </View>

      {routeContext.routeRunId ? (
        <View style={[styles.noticeCard, { marginTop: 12 }]}>
          <Text style={styles.noticeText}>{strings.route.closeoutTitle}</Text>
          <Text style={styles.noticeSubtext}>{strings.route.closeoutRoute(routeContext.routeRunId)}</Text>
          <Text style={[styles.noticeSubtext, { marginTop: 4 }]}>
            {strings.route.closeoutScope}
          </Text>
          <View style={[styles.detailRow, { marginTop: 10 }]}>
            <View>
              <Text style={styles.detailKey}>{strings.route.settlementBoundaryTitle}</Text>
              <Text style={styles.noticeSubtext}>
                {strings.route.settlementBoundary}
              </Text>
            </View>
          </View>
          <RouteManifestReadback manifest={routeExecutionManifest} />
          <View style={[styles.screenActionsRow, { marginTop: 10 }]}>
            <Pressable
              onPress={onOpenRouteScan}
              {...mobileActionAccessibility(interactionLocked ? strings.scan.drivingLocked : strings.actionAccessibility.busy, interactionLocked || isExecutingRouteAction, isExecutingRouteAction)}
              disabled={interactionLocked || isExecutingRouteAction}
              style={({ pressed }) => [
                styles.actionButton,
                (interactionLocked || isExecutingRouteAction) && styles.syncButtonDisabled,
                pressed && styles.navItemPressed,
              ]}
            >
              <Text style={styles.actionButtonText}>Scan route load</Text>
            </Pressable>
            <Pressable
              onPress={onConfirmRouteDeparture}
              {...mobileActionAccessibility(interactionLocked ? strings.scan.drivingLocked : isExecutingRouteAction || isConfirmingRouteDeparture ? strings.actionAccessibility.busy : routeDepartureConfirmedAt ? strings.actionAccessibility.completed : departureRequestState === "blocked" ? strings.route.departureReview : strings.route.departureRequestExplanation, interactionLocked || isExecutingRouteAction || isConfirmingRouteDeparture || departureRequestState !== "none" || Boolean(routeDepartureConfirmedAt), isExecutingRouteAction || isConfirmingRouteDeparture)}
              disabled={
                interactionLocked ||
                isExecutingRouteAction ||
                isConfirmingRouteDeparture ||
                departureRequestState !== "none" ||
                Boolean(routeDepartureConfirmedAt)
              }
              style={({ pressed }) => [
                styles.actionButton,
                (interactionLocked ||
                  isExecutingRouteAction ||
                  isConfirmingRouteDeparture ||
                  departureRequestState !== "none" ||
                  Boolean(routeDepartureConfirmedAt)) &&
                  styles.syncButtonDisabled,
                pressed && styles.navItemPressed,
              ]}
            >
              <Text style={styles.actionButtonText}>
                {routeDepartureConfirmedAt
                  ? strings.route.departureConfirmed
                  : isConfirmingRouteDeparture
                    ? strings.route.departureQueueing
                    : departureRequestState === "pending" ? strings.route.departureQueued
                    : departureRequestState === "blocked" ? strings.route.departureBlocked
                    : strings.route.departureRequest}
              </Text>
            </Pressable>
          </View>
        </View>
      ) : null}

      {routeContext.routeRunId ? (
        <View style={[styles.noticeCard, { marginTop: 12 }]}>
          <Text style={styles.noticeText}>{routeLoadStrings.title}</Text>
          {!parcelManifest ? <Text style={styles.noticeSubtext}>{routeLoadStrings.unavailable}</Text> : (
            <>
              <Text style={styles.noticeSubtext}>
                {routeLoadStrings.cold}: {parcelManifest.totals.cold} · {routeLoadStrings.weight}: {parcelManifest.totals.weightKg.toFixed(1)} kg
              </Text>
              {parcelManifest.totals.unknownCold || parcelManifest.totals.unknownWeight ? (
                <Text style={styles.noticeSubtext}>
                  {routeLoadStrings.partial}: {routeLoadStrings.cold} {parcelManifest.totals.unknownCold}, {routeLoadStrings.weight} {parcelManifest.totals.unknownWeight}
                </Text>
              ) : null}
              <Text style={styles.noticeSubtext}>
                {routeLoadStrings.scanned}: {parcelManifest.totals.scanned} / {parcelManifest.totals.expected} · {routeLoadStrings.pending}: {parcelManifest.totals.pending} · {routeLoadStrings.missing}: {parcelManifest.totals.missing} · {routeLoadStrings.extra}: {parcelManifest.totals.extra}
              </Text>
              {parcelManifest.parcels.length === 0 ? <Text style={styles.noticeSubtext}>{routeLoadStrings.empty}</Text> : null}
              {parcelManifest.groups.map((group) => (
                <View key={group.routeStopId ?? "extra"} style={{ marginTop: 12 }}>
                  <Text style={styles.noticeText}>
                    {group.routeStopId ? `${routeLoadStrings.destination}: ${group.routeStopId}` : routeLoadStrings.extra}
                  </Text>
                  <Text style={styles.noticeSubtext}>
                    {group.parcels.filter((parcel) => parcel.status === "scanned").length} / {group.parcels.length} · {group.parcels.reduce((total, parcel) => total + (parcel.weightKg ?? 0), 0).toFixed(1)} kg
                    {group.parcels.some((parcel) => parcel.weightKg === null) ? ` · ${routeLoadStrings.partial}` : ""}
                  </Text>
                  {group.parcels.map((parcel) => (
                    <View key={parcel.key} style={[styles.detailRow, { flexDirection: "column", alignItems: "stretch", gap: 8 }]}>
                      <Text style={styles.noticeText}>{parcel.barcode}</Text>
                      <Text style={styles.noticeSubtext}>
                        {routeLoadStrings[parcel.status]} · {parcel.weightKg === null ? routeLoadStrings.weightUnknown : `${parcel.weightKg} kg`}
                        {parcel.cold === true ? ` · ${routeLoadStrings.cold}` : parcel.cold === null ? ` · ${routeLoadStrings.handlingUnknown}` : ""}
                      </Text>
                      {parcel.reason ? <Text style={styles.noticeSubtext}>{parcel.reason}</Text> : null}
                      {parcelManifest.canRecordActions && (parcel.status === "pending" || parcel.status === "missing") ? (
                        <Pressable
                          accessibilityRole="button"
                          accessibilityLabel={`${parcel.status === "missing" ? routeLoadStrings.undo : routeLoadStrings.markMissing}: ${parcel.barcode}`}
                          onPress={() => void submitRouteLoadAction({
                            action: parcel.status === "missing" ? "undo_missing" : "mark_missing",
                            routeStopId: parcel.routeStopId, parcelId: parcel.parcelId,
                          })}
                          disabled={interactionLocked || routeLoadSubmitting || !routeLoadQueueReady}
                          style={({ pressed }) => [styles.actionButton, { minHeight: 48 },
                            (interactionLocked || routeLoadSubmitting || !routeLoadQueueReady) && styles.syncButtonDisabled,
                            pressed && styles.navItemPressed]}
                        >
                          <Text style={styles.actionButtonText}>{parcel.status === "missing" ? routeLoadStrings.undo : routeLoadStrings.markMissing}</Text>
                        </Pressable>
                      ) : null}
                    </View>
                  ))}
                </View>
              ))}
              {parcelManifest.lastDiscrepancy ? <Text style={styles.noticeSubtext}>{routeLoadStrings.lastDiscrepancy}: {parcelManifest.lastDiscrepancy}</Text> : null}
              {parcelManifest.canRecordActions ? (
                <>
                  <Text style={[styles.noticeText, { marginTop: 12 }]} nativeID="route-load-note-label">{routeLoadStrings.noteLabel}</Text>
                  <TextInput
                    accessibilityLabel={routeLoadStrings.noteLabel}
                    accessibilityLabelledBy="route-load-note-label"
                    multiline maxLength={1000} value={routeLoadNote}
                    editable={!interactionLocked && !routeLoadSubmitting}
                    onChangeText={(value) => {
                      setRouteLoadNote(value);
                      if (routeLoadError) { setRouteLoadMessage(null); setRouteLoadError(false); }
                    }}
                    style={[styles.input, { minHeight: 48, marginTop: 8 }]}
                  />
                  <View style={[styles.screenActionsRow, { marginTop: 10 }]}>
                    <Pressable accessibilityRole="button" onPress={onOpenRouteScan}
                      disabled={interactionLocked || routeLoadSubmitting}
                      style={({ pressed }) => [styles.actionButton, { minHeight: 48 },
                        (interactionLocked || routeLoadSubmitting) && styles.syncButtonDisabled, pressed && styles.navItemPressed]}>
                      <Text style={styles.actionButtonText}>{routeLoadStrings.scan}</Text>
                    </Pressable>
                    <Pressable accessibilityRole="button" onPress={() => void submitRouteLoadAction({ action: "report_discrepancy" })}
                      disabled={interactionLocked || routeLoadSubmitting || !routeLoadQueueReady}
                      style={({ pressed }) => [styles.actionButton, { minHeight: 48 },
                        (interactionLocked || routeLoadSubmitting || !routeLoadQueueReady) && styles.syncButtonDisabled, pressed && styles.navItemPressed]}>
                      <Text style={styles.actionButtonText}>{routeLoadStrings.report}</Text>
                    </Pressable>
                  </View>
                </>
              ) : null}
              {routeLoadMessage ? (
                <Text accessibilityLiveRegion="polite" accessibilityRole={routeLoadError ? "alert" : undefined}
                  style={[styles.noticeSubtext, routeLoadError && styles.error, { marginTop: 8 }]}>{routeLoadMessage}</Text>
              ) : null}
            </>
          )}
        </View>
      ) : null}

      {showPaymentCollectionCard ? (
        <View style={[styles.noticeCard, { marginTop: 12 }]}>
          <Text style={styles.noticeText}>COD collection</Text>
          {stop.collectionRequired === false ? (
            <Text style={styles.noticeSubtext}>Collection is not required for this stop.</Text>
          ) : (
            <Text style={styles.noticeSubtext}>
              {expectedCodLabel ? `Expected amount: ${expectedCodLabel}` : "Collection details are available."}
            </Text>
          )}
          {stop.paymentModeLabel ? (
            <Text style={[styles.noticeSubtext, { marginTop: 4 }]}>
              Payment mode: {stop.paymentModeLabel}
            </Text>
          ) : null}
          {stop.collectionOutcome ? (
            <Text style={[styles.noticeSubtext, { marginTop: 4 }]}>
              Collection outcome: {formatKeyLabel(stop.collectionOutcome)}
            </Text>
          ) : null}
          {collectedCodLabel ? (
            <Text style={[styles.noticeSubtext, { marginTop: 4 }]}>
              Collected amount: {collectedCodLabel}
            </Text>
          ) : null}
          {varianceCodLabel ? (
            <Text style={[styles.noticeSubtext, { marginTop: 4 }]}>
              Variance amount: {varianceCodLabel}
            </Text>
          ) : null}
          {stop.discrepancyKind ? (
            <Text style={[styles.noticeSubtext, { marginTop: 4 }]}>
              Discrepancy: {formatKeyLabel(stop.discrepancyKind)}
            </Text>
          ) : null}
          {stop.hasDiscrepancy === false ? (
            <Text style={[styles.noticeSubtext, { marginTop: 4 }]}>No COD discrepancy recorded.</Text>
          ) : null}
          {stop.receiptContext ? (
            <Text style={[styles.noticeSubtext, { marginTop: 4 }]}>
              Receipt: {stop.receiptContext}
            </Text>
          ) : null}
          {proofArtifactLabel ? (
            <Text style={[styles.noticeSubtext, { marginTop: 4 }]}>
              Proof artifacts: {proofArtifactLabel}
            </Text>
          ) : null}
          {stop.signatureArtifactId ? (
            <Text style={[styles.noticeSubtext, { marginTop: 4 }]}>Signature proof recorded</Text>
          ) : null}
          {allowedMethodsLabel ? (
            <Text style={[styles.noticeSubtext, { marginTop: 4 }]}>
              Accepted methods: {allowedMethodsLabel}
            </Text>
          ) : null}
          <Text style={[styles.noticeSubtext, { marginTop: 8 }]}>
            Use the same captured proof photos and saved signature for COD handover evidence.
          </Text>
        </View>
      ) : null}

      <View style={[styles.noticeCard, { marginTop: 12 }]}>
        <Text style={styles.noticeText}>{strings.detail.contactActions}</Text>
        <Text style={styles.noticeSubtext}>
          {strings.detail.recipient(customerName || strings.detail.noRecipient)}
        </Text>
        <Text style={[styles.noticeSubtext, { marginTop: 4 }]}>
          Phone: {phone ?? strings.detail.noPhoneOnFile}
        </Text>
        <Text style={styles.noticeSubtext}>
          Provider: {navigationProvider}
          {coordinates
            ? ` - lat ${coordinates.latitude.toFixed(6)} - lng ${coordinates.longitude.toFixed(6)}`
            : " - no coordinates"}
        </Text>
        {interactionLocked ? (
          <Text style={[styles.noticeSubtext, { marginTop: 6 }]}>
            Driving lock is active. Stop moving to run actions.
          </Text>
        ) : null}
        <View style={[styles.screenActionsRow, { marginTop: 10 }]}>
          <Pressable
            onPress={handleNavigate}
            {...mobileActionAccessibility(interactionLocked ? strings.scan.drivingLocked : isExecutingRouteAction ? strings.actionAccessibility.busy : strings.actionAccessibility.coordinatesMissing, interactionLocked || isExecutingRouteAction || !coordinates, isExecutingRouteAction)}
            disabled={interactionLocked || isExecutingRouteAction || !coordinates}
            style={({ pressed }) => [
              styles.actionButton,
              (interactionLocked || isExecutingRouteAction || !coordinates) && styles.syncButtonDisabled,
              pressed && styles.navItemPressed,
            ]}
          >
            <Text style={styles.actionButtonText}>{strings.detail.navigate}</Text>
          </Pressable>
          <Pressable
            onPress={onOpenScan}
            {...mobileActionAccessibility(interactionLocked ? strings.scan.drivingLocked : isExecutingRouteAction ? strings.actionAccessibility.busy : strings.actionAccessibility.resourceMissing, interactionLocked || isExecutingRouteAction || !resourceId, isExecutingRouteAction)}
            disabled={interactionLocked || isExecutingRouteAction || !resourceId}
            style={({ pressed }) => [
              styles.actionButton,
              (interactionLocked || isExecutingRouteAction || !resourceId) &&
                styles.syncButtonDisabled,
              pressed && styles.navItemPressed,
            ]}
          >
            <Text style={styles.actionButtonText}>{strings.detail.scanParcel}</Text>
          </Pressable>
          {contactChannels.map((channel) => {
            const disabled =
              interactionLocked ||
              isExecutingRouteAction ||
              !customerContact?.phone ||
              !customerContact.allowedChannels.includes(channel);
            return (
              <Pressable
                key={channel}
                onPress={() =>
                  handleChannel(
                    customerContact
                      ? {
                          label: customerContact.label,
                          role: customerContact.role,
                          source: customerContact.source,
                          phone: customerContact.phone,
                          name: customerContact.name,
                        }
                      : null,
                    channel
                  )
                }
                {...mobileActionAccessibility(interactionLocked ? strings.scan.drivingLocked : isExecutingRouteAction ? strings.actionAccessibility.busy : !customerContact?.phone ? strings.actionAccessibility.contactMissing : strings.actionAccessibility.channelUnavailable, disabled, isExecutingRouteAction)}
                disabled={disabled}
                style={({ pressed }) => [
                  styles.actionButton,
                  disabled && styles.syncButtonDisabled,
                  pressed && styles.navItemPressed,
                ]}
              >
                <Text style={styles.actionButtonText}>{strings.detail[channel]}</Text>
              </Pressable>
            );
          })}
        </View>
        {!customerContact?.phone ? (
          <Text style={[styles.noticeSubtext, { marginTop: 8 }]}>
            No phone on file. Use stop notes or dispatch for escalation.
          </Text>
        ) : null}
      </View>

      {supportContacts.length > 0 ? (
        <View style={[styles.noticeCard, { marginTop: 12 }]}>
          <Text style={styles.noticeText}>Support contacts</Text>
          <Text style={styles.noticeSubtext}>
            Policy and assignment contacts from the active route context.
          </Text>
          {supportContacts.map((contact) => {
            return (
              <View
                key={contact.id}
                style={[styles.detailRow, { flexDirection: "column", alignItems: "stretch", gap: 8 }]}
              >
                <View>
                  <Text style={styles.detailKey}>{contact.label}</Text>
                  <Text style={styles.detailValue}>
                    {contact.phone ?? strings.detail.noPhoneOnFile}
                  </Text>
                  <Text style={styles.noticeSubtext}>
                    {formatKeyLabel(contact.role)} - {formatKeyLabel(contact.source)}
                  </Text>
                  {contact.notes ? (
                    <Text style={[styles.noticeSubtext, { marginTop: 4 }]}>{contact.notes}</Text>
                  ) : null}
                </View>
                <View style={styles.screenActionsRow}>
                  {contactChannels.map((channel) => {
                    const disabled =
                      interactionLocked ||
                      isExecutingRouteAction ||
                      !contact.phone ||
                      !contact.allowedChannels.includes(channel);
                    return (
                      <Pressable
                        key={`${contact.id}:${channel}`}
                        onPress={() =>
                          handleChannel(
                            {
                              label: contact.label,
                              role: contact.role,
                              source: contact.source,
                              phone: contact.phone,
                              name: contact.name,
                            },
                            channel
                          )
                        }
                        {...mobileActionAccessibility(interactionLocked ? strings.scan.drivingLocked : isExecutingRouteAction ? strings.actionAccessibility.busy : !contact.phone ? strings.actionAccessibility.contactMissing : strings.actionAccessibility.channelUnavailable, disabled, isExecutingRouteAction)}
                        disabled={disabled}
                        style={({ pressed }) => [
                          styles.chip,
                          disabled && styles.syncButtonDisabled,
                          pressed && styles.navItemPressed,
                        ]}
                      >
                        <Text style={styles.chipText}>{strings.detail[channel]}</Text>
                      </Pressable>
                    );
                  })}
                </View>
              </View>
            );
          })}
        </View>
      ) : null}

      {communicationPolicy.templates.length > 0 ? (
        <View style={[styles.noticeCard, { marginTop: 12 }]}>
          <Text style={styles.noticeText}>Quick templates</Text>
          <Text style={styles.noticeSubtext}>Send policy-approved customer messages.</Text>
          <View style={[styles.screenActionsRow, { marginTop: 10 }]}>
            {communicationPolicy.templates.slice(0, 4).map((template) => (
              <Pressable
                key={template.id}
                onPress={() =>
                  handleChannel(
                    customerContact
                      ? {
                          label: customerContact.label,
                          role: customerContact.role,
                          source: customerContact.source,
                          phone: customerContact.phone,
                          name: customerContact.name,
                        }
                      : null,
                    "sms",
                    template.message,
                    template.id
                  )
                }
                {...mobileActionAccessibility(interactionLocked ? strings.scan.drivingLocked : isExecutingRouteAction ? strings.actionAccessibility.busy : !customerContact?.phone ? strings.actionAccessibility.contactMissing : strings.actionAccessibility.channelUnavailable, interactionLocked || isExecutingRouteAction || !customerContact?.phone || !customerContact.allowedChannels.includes("sms"), isExecutingRouteAction)}
                disabled={
                  interactionLocked ||
                  isExecutingRouteAction ||
                  !customerContact?.phone ||
                  !customerContact.allowedChannels.includes("sms")
                }
                style={({ pressed }) => [
                  styles.chip,
                  (interactionLocked ||
                    isExecutingRouteAction ||
                    !customerContact?.phone ||
                    !customerContact.allowedChannels.includes("sms")) &&
                    styles.syncButtonDisabled,
                  pressed && styles.navItemPressed,
                ]}
              >
                <Text style={styles.chipText}>{template.label}</Text>
              </Pressable>
            ))}
          </View>
        </View>
      ) : null}

      <View style={[styles.noticeCard, { marginTop: 12 }]}>
        <Text style={styles.noticeText}>{strings.detail.address}</Text>
        <Text style={styles.noticeSubtext}>
          {stop.fullAddress ?? strings.detail.addressIncomplete}
        </Text>
        {Platform.OS === "web" ? (
          <StopAddressActions
            address={stop.fullAddress ?? stop.addressSummary}
            note={stop.notes}
            reference={stop.reference}
            disabled={interactionLocked || isExecutingRouteAction}
            runAction={withRouteActionLock}
            strings={addressActionStrings}
            styles={styles}
          />
        ) : null}
        {addressRows.map((row) => (
          <View key={row.key} style={styles.detailRow}>
            <Text style={styles.detailKey}>
              {row.label}
              {row.required ? " *" : ""}
            </Text>
            <Text style={[styles.detailValue, row.missing ? styles.error : null]}>
              {row.value}
            </Text>
          </View>
        ))}
        {addressPolicy.showAccuracy && coordinates?.accuracyM != null ? (
          <Text style={[styles.noticeSubtext, { marginTop: 8 }]}>
            {strings.detail.accuracy(Math.round(coordinates.accuracyM))}
          </Text>
        ) : null}
        {stop.recipientMissing ? (
          <Text style={[styles.noticeSubtext, { marginTop: 8 }]}>{strings.detail.noRecipient}</Text>
        ) : null}
        {diagnosticsEnabled ? (
          <Text style={[styles.mono, { textAlign: "left", marginTop: 8 }]}>
            contact:{customerName || "-"} - phone:{phone ?? "-"} - Route reference: {routeContext.routeRunId ?? "-"}
          </Text>
        ) : null}
      </View>
    </>
  );
}

function SettlementSurfaceDetailExtensions({
  strings,
  detail,
  fallbackId,
  diagnosticsEnabled,
  interactionLocked,
  uxSafetyPolicy,
  onSubmitCount,
}: {
  strings: FieldOpsStrings;
  detail: Record<string, unknown>;
  fallbackId: string;
  diagnosticsEnabled: boolean;
  interactionLocked: boolean;
  uxSafetyPolicy: MobileUxSafetyPolicy;
  onSubmitCount: (input: {
    counted: number;
    settlement: ReturnType<typeof extractSettlementSnapshot>;
  }) => Promise<void>;
}) {
  const styles = useFieldOpsStyles();
  const settlement = React.useMemo(
    () => extractSettlementSnapshot(detail, fallbackId),
    [detail, fallbackId]
  );
  const requiresDoubleTap = uxSafetyPolicy.requireDoubleTapFor.includes("settlement_counted");
  const [countedText, setCountedText] = React.useState(
    settlement.counted != null ? String(settlement.counted) : ""
  );
  const [confirmArmed, setConfirmArmed] = React.useState(false);
  const isSubmittingCountRef = React.useRef(false);
  const [isSubmittingCount, setIsSubmittingCount] = React.useState(false);

  React.useEffect(() => {
    setCountedText(settlement.counted != null ? String(settlement.counted) : "");
    setConfirmArmed(false);
  }, [settlement.counted, settlement.id]);

  const parsedCounted = Number(countedText);
  const parsedIsValid = countedText.trim().length > 0 && Number.isFinite(parsedCounted);
  const previewVariance =
    parsedIsValid && settlement.expected != null ? parsedCounted - settlement.expected : null;

  const submitCount = React.useCallback(() => {
    if (isSubmittingCountRef.current) return;
    if (interactionLocked) {
      Alert.alert(strings.alerts.drivingLockedTitle, "Stop moving before submitting counts.");
      return;
    }
    if (!parsedIsValid) {
      Alert.alert("Invalid amount", "Enter a valid counted amount.");
      return;
    }

    if (requiresDoubleTap && !confirmArmed) {
      setConfirmArmed(true);
      Alert.alert("Confirm count", "Tap Submit count again to confirm.");
      return;
    }

    setConfirmArmed(false);
    isSubmittingCountRef.current = true;
    setIsSubmittingCount(true);
    onSubmitCount({ counted: parsedCounted, settlement })
      .then(() => {
        Alert.alert(strings.settlements.countQueuedTitle, strings.settlements.countQueuedMessage);
      })
      .catch((error) => {
        logDebugFailure("failed to queue settlement count", error);
        Alert.alert("Queue failed", "Unable to queue settlement count.");
      })
      .finally(() => {
        isSubmittingCountRef.current = false;
        setIsSubmittingCount(false);
      });
  }, [strings,
    confirmArmed,
    interactionLocked,
    onSubmitCount,
    parsedCounted,
    parsedIsValid,
    requiresDoubleTap,
    settlement,
  ]);

  return (
    <>
      <View style={[styles.noticeCard, { marginTop: 12 }]}>
        <Text style={styles.noticeText}>Settlement summary</Text>
        <View style={styles.detailRow}>
          <Text style={styles.detailKey}>Settlement</Text>
          <Text style={styles.detailValue}>{settlement.title}</Text>
        </View>
        <View style={styles.detailRow}>
          <Text style={styles.detailKey}>Status</Text>
          <Text style={styles.detailValue}>{settlement.status}</Text>
        </View>
        <View style={styles.detailRow}>
          <Text style={styles.detailKey}>Expected</Text>
          <Text style={styles.detailValue}>
            {settlement.expected == null ? "-" : `${settlement.currency} ${settlement.expected}`}
          </Text>
        </View>
        <View style={styles.detailRow}>
          <Text style={styles.detailKey}>Counted</Text>
          <Text style={styles.detailValue}>
            {settlement.counted == null ? "-" : `${settlement.currency} ${settlement.counted}`}
          </Text>
        </View>
        <View style={styles.detailRow}>
          <Text style={styles.detailKey}>Variance</Text>
          <Text style={styles.detailValue}>
            {settlement.variance == null ? "-" : `${settlement.currency} ${settlement.variance}`}
          </Text>
        </View>
        <View style={styles.detailRow}>
          <Text style={styles.detailKey}>{strings.settlements.windowStart}</Text>
          <Text style={styles.detailValue}>{settlement.windowStartAt ?? "-"}</Text>
        </View>
        <View style={styles.detailRow}>
          <Text style={styles.detailKey}>{strings.settlements.windowEnd}</Text>
          <Text style={styles.detailValue}>{settlement.windowEndAt ?? "-"}</Text>
        </View>
      </View>

      <View style={[styles.noticeCard, { marginTop: 12 }]}>
        <Text style={styles.noticeText}>Cashier action</Text>
        {interactionLocked ? (
          <Text style={styles.noticeSubtext}>Driving lock is active. Stop moving to submit.</Text>
        ) : null}
        <TextInput
          value={countedText}
          onChangeText={setCountedText}
          keyboardType="decimal-pad"
          placeholder="Enter counted amount"
          editable={!interactionLocked}
          style={[styles.input, { marginTop: 10 }]}
        />
        <Text style={[styles.noticeSubtext, { marginTop: 8 }]}>
          {previewVariance == null
            ? "Variance preview unavailable until amount is entered."
            : `Preview variance: ${settlement.currency} ${previewVariance}`}
        </Text>
        {requiresDoubleTap ? (
          <Text style={[styles.noticeSubtext, { marginTop: 6 }]}>
            Confirmation rule: double tap required.
            {confirmArmed ? " Tap submit again now." : ""}
          </Text>
        ) : null}
        {diagnosticsEnabled ? (
          <Text style={[styles.mono, { textAlign: "left", marginTop: 8 }]}>
            settlement_id:{settlement.id}
          </Text>
        ) : null}
        <View style={[styles.screenActionsRow, { marginTop: 10 }]}>
          <Pressable
            onPress={submitCount}
            disabled={interactionLocked || isSubmittingCount}
            style={({ pressed }) => [
              styles.actionButton,
              (interactionLocked || isSubmittingCount) && styles.syncButtonDisabled,
              pressed && styles.navItemPressed,
            ]}
          >
            <Text style={styles.actionButtonText}>
              {isSubmittingCount ? "Submitting..." : "Submit count"}
            </Text>
          </Pressable>
        </View>
      </View>
    </>
  );
}

function ResourceListView({
  strings,
  list,
  source,
  displayMode,
  surfaceKind,
  mapPolicy,
  interactionLocked,
  refreshing,
  onRefresh,
  onSelectItem,
}: {
  strings: FieldOpsStrings;
  list: UiResourceList;
  source: "network" | "cache";
  displayMode?: "list" | "orders_map";
  surfaceKind?: "resource" | "route" | "settlements" | "tasks";
  mapPolicy?: MobileMapPolicy;
  interactionLocked?: boolean;
  refreshing?: boolean;
  onRefresh?: () => void;
  onSelectItem?: (item: Record<string, unknown>) => void;
}) {
  const styles = useFieldOpsStyles();
  const mode = displayMode ?? "list";
  const openItem = React.useCallback(
    (item: Record<string, unknown>) => {
      if (interactionLocked) {
        Alert.alert(strings.alerts.drivingLockedTitle, "Stop moving to open item details.");
        return;
      }
      onSelectItem?.(item);
    },
    [strings, interactionLocked, onSelectItem]
  );
  const mapListEntries = React.useMemo(() => buildMobileMapListEntries(list.items), [list.items]);
  const mapItems = mode === "orders_map" && surfaceKind !== "route" ? mapListEntries : [];
  const routeMapEntries = React.useMemo(() => {
    if (mode !== "orders_map" || surfaceKind !== "route") return [];
    return mapListEntries.map(({ item, coords }, index) => {
      const route = extractRouteCardSnapshot(item);
      return {
        id: pickResourceId(item, list.keys) ?? `item-${index + 1}`,
        item, coords, route,
        title: formatOperationalTitle({ title: route.title, customerName: route.customerName, reference: route.reference }),
      };
    });
  }, [mapListEntries, list.keys, mode, surfaceKind]);
  const geographicModel = React.useMemo(() => buildMobileRealMapModel(mapListEntries.map(({ item, address }, index) => {
    const route = extractRouteCardSnapshot(item);
    return {
      id: pickResourceId(item, list.keys) ?? `item-${index + 1}`,
      title: formatResourceItemTitle(item, list.keys),
      sequence: route.sequence,
      status: typeof item.status === "string" ? item.status : null,
      active: ["active", "enroute", "in_progress"].includes(route.status?.trim().toLowerCase() ?? ""),
      address,
    };
  })), [mapListEntries, list.keys]);
  const routeMapById = React.useMemo(
    () => new Map(routeMapEntries.map((entry) => [entry.id, entry])),
    [routeMapEntries]
  );
  const routeMapModel = React.useMemo(() => {
    if (!mapPolicy || mode !== "orders_map" || surfaceKind !== "route") return null;
    return buildRouteMapModel(
      geographicModel.points.features.map((point) => ({
        id: point.properties.id,
        latitude: point.geometry.coordinates[1],
        longitude: point.geometry.coordinates[0],
        status: routeMapById.get(point.properties.id)?.route.status,
      })),
      mapPolicy
    );
  }, [mapPolicy, mode, routeMapById, surfaceKind, geographicModel]);
  const hasListItems = list.items.length > 0;
  const [focusedClusterKey, setFocusedClusterKey] = React.useState<string | null>(null);
  React.useEffect(() => {
    setFocusedClusterKey(null);
  }, [list.resource, mode, surfaceKind]);
  const focusedCluster = React.useMemo(() => {
    if (!focusedClusterKey || !routeMapModel) return null;
    return routeMapModel.clusters.find((cluster) => cluster.key === focusedClusterKey) ?? null;
  }, [focusedClusterKey, routeMapModel]);

  return (
    <View style={styles.listWrapper}>
      <View style={styles.listMeta}>
        <Text style={styles.listMetaText}>
          {strings.tasks.itemsCount(list.total ?? list.items.length)} {source === "cache" ? "(cached)" : ""}
        </Text>
      </View>
      {mode === "orders_map" && !hasListItems ? (
        <View style={styles.noticeCard}>
          <Text style={styles.noticeSubtext}>{strings.tasks.empty}</Text>
        </View>
      ) : null}
      {mode === "orders_map" ? (
        <ScrollView contentContainerStyle={styles.list}>
          {mapPolicy ? <MobileRealMap model={geographicModel} policy={mapPolicy.openMap} strings={strings.realMap} interactionLocked={interactionLocked} onSelect={(id) => {
            const index = list.items.findIndex((item, index) => (pickResourceId(item, list.keys) ?? `item-${index + 1}`) === id);
            if (index >= 0) openItem(list.items[index]);
          }} /> : null}
          {surfaceKind === "route" ? (
            <>
              <View style={styles.noticeCard}>
                <Text style={styles.noticeText}>Route overview</Text>
                <Text style={styles.noticeSubtext}>
                  {routeMapModel?.mappableCount
                    ? `${routeMapModel.mappableCount} items with coordinates - ${routeMapModel.clusters.length} clusters`
                    : "No coordinate fields available yet."}
                </Text>
                {mapPolicy ? (
                  <Text style={styles.noticeSubtext}>
                    Clustering {mapPolicy.clusteringEnabled ? "on" : "off"} (grid{" "}
                    {mapPolicy.clusteringGridPx}px, min {mapPolicy.clusteringMinCount})
                  </Text>
                ) : null}
                <View style={[styles.screenActionsRow, { marginTop: 8 }]}>
                  <View style={styles.chip}>
                    <Text style={styles.chipText}>{strings.route.subtitle(routeMapEntries.length)}</Text>
                  </View>
                  <View style={styles.chip}>
                    <Text style={styles.chipText}>
                      {
                        routeMapEntries.filter((entry) => {
                          const status = entry.route.status?.trim().toLowerCase() ?? "";
                          return status === "done" || status === "completed" || status === "closed";
                        }).length
                      } done
                    </Text>
                  </View>
                  <View style={styles.chip}>
                    <Text style={styles.chipText}>
                      {
                        routeMapEntries.filter((entry) => {
                          const status = entry.route.status?.trim().toLowerCase() ?? "";
                          return !(status === "done" || status === "completed" || status === "closed");
                        }).length
                      } active
                    </Text>
                  </View>
                </View>
              </View>

              {routeMapModel?.clusters.map((cluster) => (
                <Pressable key={cluster.key} accessibilityRole="button" onPress={() => setFocusedClusterKey(cluster.key)} style={styles.card}>
                  <Text>{strings.realMap.group(cluster.count)}</Text>
                </Pressable>
              ))}

              {focusedCluster ? (
                <View style={styles.noticeCard}>
                  <Text style={styles.noticeText}>Cluster items ({focusedCluster.count})</Text>
                  {focusedCluster.pointIds.map((id) => {
                    const entry = routeMapById.get(id);
                    if (!entry) return null;
                    return (
                      <Pressable
                        key={id}
                        onPress={() => openItem(entry.item)}
                        style={({ pressed }) => [styles.card, pressed && styles.navItemPressed]}
                      >
                        <Text style={styles.cardTitle}>{entry.title}</Text>
                        {entry.route.place ? (
                          <Text style={styles.cardSubtitle}>{entry.route.place}</Text>
                        ) : null}
                      </Pressable>
                    );
                  })}
                </View>
              ) : null}

              {[...routeMapEntries]
                .sort((left, right) => {
                  const leftSequence = left.route.sequence ?? Number.MAX_SAFE_INTEGER;
                  const rightSequence = right.route.sequence ?? Number.MAX_SAFE_INTEGER;
                  if (leftSequence !== rightSequence) return leftSequence - rightSequence;
                  return left.title.localeCompare(right.title);
                })
                .map((entry) => {
                  const meta: string[] = [];
                  if (entry.route.kind) meta.push(entry.route.kind);
                  if (entry.route.sequence != null) meta.push(`#${entry.route.sequence}`);
                  if (entry.route.etaMin != null) meta.push(`${entry.route.etaMin}m ETA`);
                  return (
                    <Pressable
                      key={`route-entry-${entry.id}`}
                      accessibilityRole="button"
                      onPress={() => openItem(entry.item)}
                      style={({ pressed }) => [styles.card, pressed && styles.navItemPressed]}
                    >
                      <Text style={styles.cardTitle}>{entry.title}</Text>
                      {entry.route.reference && entry.route.reference !== entry.route.title ? (
                        <Text style={styles.cardSubtitle}>{entry.route.reference}</Text>
                      ) : null}
                      {entry.route.place ? <Text style={styles.cardSubtitle}>{entry.route.place}</Text> : null}
                      <View style={styles.cardChips}>
                        {meta.map((value) => (
                          <View key={value} style={styles.chip}>
                            <Text style={styles.chipText}>{value}</Text>
                          </View>
                        ))}
                        {entry.route.packageCount != null ? (
                          <View style={styles.chip}>
                            <Text style={styles.chipText}>{entry.route.packageCount} pkg</Text>
                          </View>
                        ) : null}
                        {entry.route.codBadge ? (
                          <View style={styles.chip}>
                            <Text style={styles.chipText}>{entry.route.codBadge}</Text>
                          </View>
                        ) : null}
                        {entry.route.status ? (
                          <View style={styles.chip}>
                            <Text style={styles.chipText}>{entry.route.status}</Text>
                          </View>
                        ) : null}
                      </View>
                    </Pressable>
                  );
                })}
            </>
          ) : (
            <>
              <View style={styles.noticeCard}>
                <Text style={styles.noticeText}>Overview</Text>
                <Text style={styles.noticeSubtext}>
                  {mapItems.length > 0
                    ? `${mapItems.filter((entry) => entry.coords !== null).length} items with coordinates`
                    : "No coordinate fields available. Falling back to list-style cards."}
                </Text>
              </View>
              {mapItems.map(({ item, coords }, index) => (
                <Pressable key={`${list.resource}-map-${index}`} accessibilityRole="button" onPress={() => openItem(item)}
                  style={({ pressed }) => [styles.card, pressed && styles.navItemPressed]}>
                  <Text style={styles.cardTitle}>{formatResourceItemTitle(item, list.keys)}</Text>
                  {coords ? <Text style={styles.cardSubtitle}>lat {coords.latitude.toFixed(6)} - lng {coords.longitude.toFixed(6)}</Text> : null}
                </Pressable>
              ))}
            </>
          )}
        </ScrollView>
      ) : (
        <FlatList
          data={list.items}
          keyExtractor={(_, index) => `${list.resource}-${index}`}
          contentContainerStyle={styles.list}
          refreshing={Boolean(refreshing)}
          onRefresh={onRefresh}
          ListEmptyComponent={<Text style={styles.subtitle}>{strings.tasks.empty}</Text>}
          renderItem={({ item, index }) => {
            if (surfaceKind === "route") {
              const route = extractRouteCardSnapshot(item);
              const title = formatOperationalTitle({
                title: route.title,
                customerName: route.customerName,
                reference: route.reference,
              });
              const subtitleParts = [
                route.customerName && route.title !== title ? route.title : null,
                route.place,
              ].filter(Boolean) as string[];
              const meta: string[] = [];
              if (route.reference) meta.push(route.reference);
              if (route.kind) meta.push(route.kind);
              if (route.sequence != null) meta.push(`#${route.sequence}`);
              if (route.etaMin != null) meta.push(`${route.etaMin}m ETA`);
              if (route.packageCount != null) meta.push(`${route.packageCount} pkg`);
              if (route.codBadge) meta.push(route.codBadge);
              const routeStatusChip = formatOperationalStatusChip(route.status, route.statusReason);
              if (routeStatusChip) meta.push(routeStatusChip);

              return (
                <Pressable
                  onPress={() => openItem(item)}
                  style={({ pressed }) => [styles.card, pressed && styles.navItemPressed]}
                >
                  <Text style={styles.cardTitle}>{title}</Text>
                  {subtitleParts.length ? (
                    <Text style={styles.cardSubtitle}>{subtitleParts.join(" • ")}</Text>
                  ) : null}
                  {meta.length ? (
                    <View style={styles.cardChips}>
                      {meta.map((entry) => (
                        <View key={entry} style={styles.chip}>
                          <Text style={styles.chipText}>{entry}</Text>
                        </View>
                      ))}
                    </View>
                  ) : null}
                </Pressable>
              );
            }

            if (surfaceKind === "settlements") {
              const fallbackId = pickResourceId(item, list.keys) ?? `settlement-${index + 1}`;
              const settlement = extractSettlementSnapshot(item, fallbackId);
              const statusBadge = settlement.status || "open";
              const expectedBadge =
                settlement.expected == null
                  ? "Expected -"
                  : `Expected ${settlement.currency} ${settlement.expected}`;
              const countedBadge =
                settlement.counted == null
                  ? "Needs count"
                  : `Counted ${settlement.currency} ${settlement.counted}`;

              return (
                <Pressable
                  onPress={() => openItem(item)}
                  style={({ pressed }) => [styles.card, pressed && styles.navItemPressed]}
                >
                  <Text style={styles.cardTitle}>{settlement.title}</Text>
                  <Text style={styles.cardSubtitle}>{settlement.id}</Text>
                  <Text style={styles.cardSubtitle}>{strings.settlements.windowStart}: {settlement.windowStartAt ?? "-"}</Text>
                  <Text style={styles.cardSubtitle}>{strings.settlements.windowEnd}: {settlement.windowEndAt ?? "-"}</Text>
                  <View style={styles.cardChips}>
                    <View style={styles.chip}>
                      <Text style={styles.chipText}>{statusBadge}</Text>
                    </View>
                    <View style={styles.chip}>
                      <Text style={styles.chipText}>{expectedBadge}</Text>
                    </View>
                    <View style={styles.chip}>
                      <Text style={styles.chipText}>{countedBadge}</Text>
                    </View>
                  </View>
                </Pressable>
              );
            }

            if (surfaceKind === "tasks") {
              const task = extractTaskCardSnapshot(item);
              const taskCardId = typeof item.id === "string" ? item.id.trim() : "";
              const title = formatOperationalTitle({
                title: task.title,
                customerName: task.customerName,
                reference: task.reference,
              });
              const subtitleParts = [
                task.customerName && task.title !== title ? task.title : null,
                task.place,
              ].filter(Boolean) as string[];
              const chips = [
                task.reference,
                formatOperationalStatusChip(task.status, task.statusReason),
                task.priority,
                task.due,
                task.packageCount != null ? `${task.packageCount} pkg` : null,
                task.codBadge,
              ].filter(Boolean) as string[];

              return (
                <Pressable
                  testID={taskCardId ? `mobile-task-card-${taskCardId}` : undefined}
                  onPress={() => openItem(item)}
                  style={({ pressed }) => [styles.card, pressed && styles.navItemPressed]}
                >
                  <Text style={styles.cardTitle}>{title}</Text>
                  {subtitleParts.length ? (
                    <Text style={styles.cardSubtitle}>{subtitleParts.join(" • ")}</Text>
                  ) : null}
                  {chips.length ? (
                    <View style={styles.cardChips}>
                      {chips.map((chipValue) => (
                        <View key={chipValue} style={styles.chip}>
                          <Text style={styles.chipText}>{chipValue}</Text>
                        </View>
                      ))}
                    </View>
                  ) : null}
                </Pressable>
              );
            }

            const displayKeys =
              Array.isArray(list.keys) && list.keys.length ? list.keys : Object.keys(item);
            const titleKeys = displayKeys.slice(0, 2);
            const subtitleKeys = displayKeys.slice(2, 5);
            const exclude = new Set<string>([...titleKeys, ...subtitleKeys]);
            const subtitleParts = subtitleKeys
              .map((key) => renderKeyValueInline(key, item[key]))
              .filter(Boolean) as string[];
            const chips = pickCardChips({ item, keys: displayKeys, exclude });

            return (
              <Pressable
                onPress={() => openItem(item)}
                style={({ pressed }) => [styles.card, pressed && styles.navItemPressed]}
              >
                <Text style={styles.cardTitle}>{formatResourceItemTitle(item, titleKeys)}</Text>
                {subtitleParts.length ? (
                  <Text style={styles.cardSubtitle} numberOfLines={2}>
                    {subtitleParts.join(" \u00b7 ")}
                  </Text>
                ) : null}
                {chips.length ? (
                  <View style={styles.cardChips}>
                    {chips.map((chip) => (
                      <View key={chip.key} style={styles.chip}>
                        <Text style={styles.chipText}>{chip.value}</Text>
                      </View>
                    ))}
                  </View>
                ) : null}
              </Pressable>
            );
          }}
        />
      )}
    </View>
  );
}

export default function App() {
  const systemColorScheme = useColorScheme();
  const appTheme = resolveAppliedFieldOpsTheme("system", systemColorScheme);
  const appStyles = React.useMemo(
    () =>
      createFieldOpsStyles(
        getFieldOpsThemeTokens(appTheme, Platform.OS === "web" ? "web" : "native")
      ),
    [appTheme]
  );
  const styles = appStyles;
  React.useEffect(() => {
    const disposeCrashHandler = installGlobalCrashHandler((error, context) => {
      captureMobileException(
        error,
        {
          isFatal: context.isFatal ?? null,
          details: context.details ?? null,
        },
        {
          kind: "uncaught_js_error",
          fatal: context.isFatal ? "true" : "false",
        }
      );
      logDebugFailure(
        `uncaught_js_error_${context.isFatal ? "fatal" : "nonfatal"}`,
        {
          error,
          isFatal: context.isFatal,
          details: context.details,
        },
        "fieldops:crash"
      );
    });

    const disposeUnhandledRejectionHandler = installUnhandledRejectionHandler((reason, promise) => {
      captureMobileException(
        reason,
        {
          promise,
        },
        {
          kind: "unhandled_promise_rejection",
        }
      );
      logDebugFailure(
        "unhandled_promise_rejection",
        {
          reason,
          promise,
        },
        "fieldops:crash"
      );
    });

    return () => {
      disposeCrashHandler?.();
      disposeUnhandledRejectionHandler?.();
    };
  }, []);

  const [queryClient] = React.useState(() => createQueryClient());
  return (
    <FieldOpsStylesContext.Provider value={appStyles}>
      <MobileErrorBoundary
      fallback={({ retry, category }) => (
        <View style={styles.container} accessibilityRole="alert" testID="mobile-error-boundary">
          <Text style={styles.title}>
            {category === "offline" || category === "permission"
              ? getFieldOpsStrings("en").errorBoundary[category].title
              : "Something went wrong"}
          </Text>
          <Text style={styles.subtitle}>
            {category === "offline"
              ? "Check your connection and try again."
              : category === "permission"
                ? getFieldOpsStrings("en").errorBoundary.permission.body
                : "Please restart the app and try again."}
          </Text>
          <Pressable
            accessibilityRole="button"
            onPress={retry}
            style={({ pressed }) => [styles.primaryButton, pressed && styles.primaryButtonPressed]}
          >
            <Text style={styles.primaryButtonText}>Try again</Text>
          </Pressable>
        </View>
      )}
    >
      <SafeAreaProvider>
        <QueryClientProvider client={queryClient}>
          <Bootstrap />
        </QueryClientProvider>
      </SafeAreaProvider>
      </MobileErrorBoundary>
    </FieldOpsStylesContext.Provider>
  );
}

function createFieldOpsStyles(FIELDOPS_TOKENS: FieldOpsThemeTokens) {
  return StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: FIELDOPS_TOKENS.color.pageBg,
    alignItems: "center",
    justifyContent: "center",
    padding: 24,
  },
  title: {
    fontSize: 20,
    fontWeight: "600",
    color: FIELDOPS_TOKENS.color.text,
    fontFamily: FIELDOPS_TOKENS.font.sans,
    marginBottom: 8,
  },
  pageRoot: {
    flex: 1,
    backgroundColor: FIELDOPS_TOKENS.color.pageBg,
  },
  webViewport: {
    flex: 1,
    backgroundColor: FIELDOPS_TOKENS.color.viewportBg,
    alignItems: "center",
    justifyContent: "center",
    padding: 16,
  },
  page: {
    flex: 1,
    backgroundColor: FIELDOPS_TOKENS.color.pageBg,
    position: "relative",
  },
  pageWeb: {
    width: "100%",
    maxWidth: 430,
    maxHeight: "100%",
    borderRadius: 30,
    borderWidth: 1,
    borderColor: FIELDOPS_TOKENS.color.border,
    overflow: "hidden",
    ...(Platform.OS === "web"
      ? {
          boxShadow: "0px 12px 24px rgba(17, 24, 39, 0.08)",
        }
      : {
          shadowColor: "#111827",
          shadowOpacity: 0.08,
          shadowRadius: 24,
          shadowOffset: { width: 0, height: 12 },
        }),
    elevation: 9,
  },
  directionLtr: {
    ...(Platform.OS === "web" ? {} : { direction: "ltr" }),
  },
  directionRtl: {
    ...(Platform.OS === "web" ? {} : { direction: "rtl" }),
  },
  header: {
    paddingTop: 14,
    paddingHorizontal: 16,
    paddingBottom: 10,
    borderBottomWidth: 1,
    borderBottomColor: FIELDOPS_TOKENS.color.border,
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    backgroundColor: FIELDOPS_TOKENS.color.cardBg,
  },
  menuButton: {
    width: 38,
    height: 38,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: FIELDOPS_TOKENS.color.border,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: FIELDOPS_TOKENS.color.cardBg,
  },
  menuButtonPressed: { opacity: 0.8 },
  menuButtonText: {
    fontSize: 16,
    fontWeight: "700",
    lineHeight: 18,
    color: FIELDOPS_TOKENS.color.text,
    fontFamily: FIELDOPS_TOKENS.font.sans,
  },
  headerText: { flex: 1, minWidth: 0 },
  headerTitle: {
    fontSize: 16,
    fontWeight: "700",
    color: FIELDOPS_TOKENS.color.text,
    fontFamily: FIELDOPS_TOKENS.font.sans,
  },
  headerRight: { flexDirection: "row", alignItems: "center", gap: 6 },
  headerPill: {
    fontSize: 12,
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: FIELDOPS_TOKENS.radius.pill,
    backgroundColor: FIELDOPS_TOKENS.color.cardBg,
    borderWidth: 1,
    borderColor: FIELDOPS_TOKENS.color.border,
    color: FIELDOPS_TOKENS.color.textMuted,
    fontFamily: FIELDOPS_TOKENS.font.sans,
  },
  headerPillText: {
    fontSize: 12,
    color: FIELDOPS_TOKENS.color.textMuted,
    fontFamily: FIELDOPS_TOKENS.font.sans,
    fontWeight: "700",
  },
  headerPillRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    borderWidth: 1,
    borderColor: FIELDOPS_TOKENS.color.border,
    borderRadius: FIELDOPS_TOKENS.radius.pill,
    paddingHorizontal: 8,
    paddingVertical: 4,
    backgroundColor: FIELDOPS_TOKENS.color.cardBg,
  },
  headerPillRowOnline: {
    borderColor: FIELDOPS_TOKENS.color.success,
    backgroundColor: FIELDOPS_TOKENS.color.successSoft,
  },
  headerPillRowDegraded: {
    borderColor: FIELDOPS_TOKENS.color.warning,
    backgroundColor: FIELDOPS_TOKENS.color.warningSoft,
  },
  headerPillRowOffline: {
    borderColor: FIELDOPS_TOKENS.color.danger,
    backgroundColor: FIELDOPS_TOKENS.color.dangerSoft,
  },
  headerPillDot: { width: 6, height: 6, borderRadius: 999 },
  headerPillDotOnline: { backgroundColor: FIELDOPS_TOKENS.color.success },
  headerPillDotDegraded: { backgroundColor: FIELDOPS_TOKENS.color.warning },
  headerPillDotOffline: { backgroundColor: FIELDOPS_TOKENS.color.danger },
  headerPillWarning: {
    backgroundColor: FIELDOPS_TOKENS.color.warningSoft,
  },
  connectivityBanner: {
    marginHorizontal: 16,
    marginTop: 10,
    marginBottom: 6,
    borderRadius: FIELDOPS_TOKENS.radius.md,
    borderWidth: 1,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  connectivityBannerOffline: {
    borderColor: FIELDOPS_TOKENS.color.danger,
    backgroundColor: FIELDOPS_TOKENS.color.dangerSoft,
  },
  connectivityBannerDegraded: {
    borderColor: FIELDOPS_TOKENS.color.warning,
    backgroundColor: FIELDOPS_TOKENS.color.warningSoft,
  },
  connectivityBannerTitle: {
    fontSize: 13,
    fontWeight: "800",
    color: FIELDOPS_TOKENS.color.text,
    fontFamily: FIELDOPS_TOKENS.font.sans,
  },
  connectivityBannerText: {
    marginTop: 2,
    fontSize: 12,
    color: FIELDOPS_TOKENS.color.textMuted,
    fontFamily: FIELDOPS_TOKENS.font.sans,
  },
  avatar: {
    width: 30,
    height: 30,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: FIELDOPS_TOKENS.color.border,
    backgroundColor: FIELDOPS_TOKENS.color.cardBg,
    alignItems: "center",
    justifyContent: "center",
  },
  avatarPressed: { opacity: 0.8 },
  avatarText: { fontSize: 12, fontWeight: "700", color: FIELDOPS_TOKENS.color.text },
  syncButton: {
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: FIELDOPS_TOKENS.color.border,
    backgroundColor: FIELDOPS_TOKENS.color.cardBg,
  },
  syncButtonDisabled: {
    opacity: 0.5,
  },
  syncButtonPressed: {
    opacity: 0.85,
  },
  syncButtonText: {
    fontSize: 12,
    fontWeight: "600",
    color: FIELDOPS_TOKENS.color.text,
  },
  content: {
    flexGrow: 1,
    padding: 16,
  },
  drawerBackdrop: { flex: 1, flexDirection: "row", backgroundColor: FIELDOPS_TOKENS.color.overlayScrim },
  drawerWebOverlay: {
    ...StyleSheet.absoluteFillObject,
    zIndex: 30,
    flexDirection: "row",
  },
  drawerWebPanelWrap: {
    width: "84%",
    maxWidth: 360,
    height: "100%",
  },
  drawerPanel: {
    width: "84%",
    maxWidth: 360,
    backgroundColor: FIELDOPS_TOKENS.color.cardBg,
    borderTopRightRadius: 24,
    borderBottomRightRadius: 24,
    paddingHorizontal: 14,
    paddingTop: 14,
    borderRightWidth: 1,
    borderRightColor: FIELDOPS_TOKENS.color.border,
  },
  drawerScrim: { flex: 1 },
  drawerPanelWeb: {
    height: "100%",
  },
  drawerPanelInWebWrap: {
    width: "100%",
    maxWidth: "100%",
  },
  drawerScrimWeb: {
    flex: 1,
    backgroundColor: FIELDOPS_TOKENS.color.overlayScrim,
  },
  drawerHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingBottom: 10,
    borderBottomWidth: 1,
    borderBottomColor: FIELDOPS_TOKENS.color.borderMuted,
    marginBottom: 12,
  },
  drawerTitle: {
    fontSize: 16,
    fontWeight: "700",
    color: FIELDOPS_TOKENS.color.text,
    fontFamily: FIELDOPS_TOKENS.font.sans,
  },
  drawerClose: {
    width: 44,
    height: 44,
    borderRadius: 17,
    borderWidth: 1,
    borderColor: FIELDOPS_TOKENS.color.border,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: FIELDOPS_TOKENS.color.cardBg,
  },
  drawerCloseText: { fontSize: 18, fontWeight: "600", lineHeight: 19, color: FIELDOPS_TOKENS.color.textMuted },
  drawerContent: { paddingTop: 12, paddingBottom: 10 },
  navModalBackdrop: { flex: 1, justifyContent: "flex-end", backgroundColor: FIELDOPS_TOKENS.color.overlayScrim },
  navModalWebOverlay: {
    ...StyleSheet.absoluteFillObject,
    justifyContent: "flex-end",
    backgroundColor: FIELDOPS_TOKENS.color.overlayScrim,
    zIndex: 35,
  },
  navModalBackdropTap: { flex: 1 },
  navModal: {
    maxHeight: "75%",
    backgroundColor: FIELDOPS_TOKENS.color.cardBg,
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    paddingHorizontal: 16,
    paddingTop: 14,
    paddingBottom: 24,
  },
  composerModal: {
    maxHeight: "85%",
  },
  navModalWeb: {
    maxHeight: "80%",
  },
  navModalHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingBottom: 10,
    borderBottomWidth: 1,
    borderBottomColor: FIELDOPS_TOKENS.color.borderMuted,
    marginBottom: 12,
  },
  navModalTitle: {
    fontSize: 16,
    fontWeight: "700",
    color: FIELDOPS_TOKENS.color.text,
    fontFamily: FIELDOPS_TOKENS.font.sans,
  },
  navModalHeaderActions: { flexDirection: "row", alignItems: "center", gap: 8 },
  navClose: {
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: FIELDOPS_TOKENS.color.border,
  },
  navClosePressed: { opacity: 0.8 },
  navCloseText: { fontSize: 12, fontWeight: "600", color: FIELDOPS_TOKENS.color.text },
  navModalContent: { paddingTop: 12 },
  section: { marginBottom: 20 },
  sectionTitle: { fontSize: 14, fontWeight: "600", marginBottom: 10, color: FIELDOPS_TOKENS.color.text },
  navItem: {
    borderWidth: 1,
    borderColor: FIELDOPS_TOKENS.color.border,
    borderRadius: FIELDOPS_TOKENS.radius.md,
    paddingHorizontal: 14,
    paddingVertical: 12,
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: 10,
    backgroundColor: FIELDOPS_TOKENS.color.cardBg,
  },
  navItemSelected: {
    borderColor: FIELDOPS_TOKENS.color.accent,
    backgroundColor: FIELDOPS_TOKENS.color.accentSoft,
  },
  navItemPressed: { opacity: 0.8 },
  navItemDisabled: { opacity: 0.5 },
  navItemLabel: { fontSize: 14, fontWeight: "500", color: FIELDOPS_TOKENS.color.text },
  navItemBadge: {
    fontSize: 12,
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 999,
    backgroundColor: FIELDOPS_TOKENS.color.cardBgSubtle,
    color: FIELDOPS_TOKENS.color.textMuted,
    overflow: "hidden",
  },
  resourceHeader: {
    flexDirection: "row",
    alignItems: "center",
    marginBottom: 12,
    gap: 10,
  },
  drivingLockBanner: {
    borderWidth: 1,
    borderColor: FIELDOPS_TOKENS.color.warning,
    backgroundColor: FIELDOPS_TOKENS.color.warningSoft,
    borderRadius: 12,
    padding: 12,
    marginBottom: 12,
  },
  drivingLockTitle: {
    fontSize: 13,
    fontWeight: "800",
    color: FIELDOPS_TOKENS.color.text,
    marginBottom: 4,
  },
  drivingLockText: {
    fontSize: 12,
    color: FIELDOPS_TOKENS.color.textMuted,
  },
  filtersRow: { flexDirection: "row", flexWrap: "wrap", gap: 8, marginBottom: 12 },
  resourceHeaderText: { flex: 1 },
  resourceTitle: {
    fontSize: 16,
    fontWeight: "700",
    color: FIELDOPS_TOKENS.color.text,
    fontFamily: FIELDOPS_TOKENS.font.sans,
  },
  resourceSubtitle: {
    fontSize: 12,
    opacity: 0.7,
    marginTop: 2,
    color: FIELDOPS_TOKENS.color.textMuted,
    fontFamily: FIELDOPS_TOKENS.font.sans,
  },
  routeStatusBadge: {
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: FIELDOPS_TOKENS.color.border,
    backgroundColor: FIELDOPS_TOKENS.color.cardBgSubtle,
  },
  routeStatusBadgeActive: {
    borderColor: FIELDOPS_TOKENS.color.accent,
    backgroundColor: FIELDOPS_TOKENS.color.accentSoft,
  },
  routeStatusBadgeDone: {
    borderColor: FIELDOPS_TOKENS.color.success,
    backgroundColor: FIELDOPS_TOKENS.color.successSoft,
  },
  routeStatusBadgeText: { fontSize: 11, fontWeight: "700", color: FIELDOPS_TOKENS.color.text },
  syncNowButton: {
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: FIELDOPS_TOKENS.color.border,
  },
  listPane: { flex: 1 },
  list: { paddingBottom: 24 },
  listWrapper: { flex: 1 },
  routeMapBoard: {
    height: 260,
    borderWidth: 1,
    borderColor: FIELDOPS_TOKENS.color.border,
    borderRadius: 14,
    backgroundColor: FIELDOPS_TOKENS.color.cardBgSubtle,
    marginBottom: 12,
    overflow: "hidden",
    position: "relative",
  },
  routeMapPin: {
    position: "absolute",
    width: 24,
    height: 24,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: "#fff",
    justifyContent: "center",
    alignItems: "center",
    transform: [{ translateX: -12 }, { translateY: -12 }],
  },
  routeMapPinText: {
    color: "#fff",
    fontSize: 11,
    fontWeight: "800",
  },
  routeMapPinActive: { backgroundColor: "#f59e0b" },
  routeMapPinDone: { backgroundColor: "#16a34a" },
  routeMapPinIssue: { backgroundColor: "#dc2626" },
  routeMapPinNeutral: { backgroundColor: "#f59e0b" },
  routeMapCluster: {
    position: "absolute",
    width: 34,
    height: 34,
    borderRadius: 17,
    backgroundColor: "#1d4ed8",
    borderWidth: 2,
    borderColor: "#fff",
    justifyContent: "center",
    alignItems: "center",
    transform: [{ translateX: -17 }, { translateY: -17 }],
  },
  routeMapClusterFocused: {
    backgroundColor: "#0f3fa8",
  },
  routeMapClusterText: {
    color: "#fff",
    fontSize: 12,
    fontWeight: "800",
  },
  routeMapLockOverlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: FIELDOPS_TOKENS.color.overlayScrim,
    justifyContent: "center",
    alignItems: "center",
  },
  routeMapLockText: {
    color: FIELDOPS_TOKENS.color.warning,
    fontWeight: "800",
    fontSize: 13,
  },
  listMeta: {
    paddingVertical: 10,
    paddingHorizontal: 6,
  },
  listMetaText: {
    fontSize: 12,
    opacity: 0.7,
    color: FIELDOPS_TOKENS.color.textMuted,
  },
  card: {
    borderWidth: 1,
    borderColor: FIELDOPS_TOKENS.color.border,
    borderRadius: FIELDOPS_TOKENS.radius.md,
    padding: 14,
    marginBottom: 12,
    backgroundColor: FIELDOPS_TOKENS.color.cardBg,
  },
  cardTitle: { fontSize: 14, fontWeight: "600", marginBottom: 6, color: FIELDOPS_TOKENS.color.text },
  cardSubtitle: { fontSize: 12, opacity: 0.75, color: FIELDOPS_TOKENS.color.textMuted },
  cardChips: { flexDirection: "row", flexWrap: "wrap", gap: 6, marginTop: 10 },
  chip: {
    paddingHorizontal: 10,
    paddingVertical: 8,
    borderRadius: FIELDOPS_TOKENS.radius.pill,
    backgroundColor: FIELDOPS_TOKENS.color.cardBgSubtle,
    minHeight: 40,
    justifyContent: "center",
  },
  chipText: {
    fontSize: 12,
    fontWeight: "700",
    color: FIELDOPS_TOKENS.color.text,
    fontFamily: FIELDOPS_TOKENS.font.sans,
  },
  detailWrapper: { flex: 1 },
  detailHeader: { flexDirection: "row", alignItems: "center", gap: 12, marginBottom: 12 },
  detailBack: {
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: FIELDOPS_TOKENS.color.border,
  },
  detailHeaderText: { flex: 1 },
  detailTitle: { fontSize: 16, fontWeight: "700", color: FIELDOPS_TOKENS.color.text },
  detailSubtitle: { fontSize: 12, opacity: 0.7, marginTop: 2, color: FIELDOPS_TOKENS.color.textMuted },
  detailContent: { paddingBottom: 24 },
  detailRow: {
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: FIELDOPS_TOKENS.color.borderMuted,
  },
  detailKey: { fontSize: 12, fontWeight: "600", marginBottom: 4, color: FIELDOPS_TOKENS.color.textMuted },
  detailValue: { fontSize: 13, opacity: 0.85, color: FIELDOPS_TOKENS.color.text },
  actionsBar: {
    borderTopWidth: 1,
    borderTopColor: FIELDOPS_TOKENS.color.borderMuted,
    paddingTop: 12,
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 10,
  },
  actionButton: {
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRadius: FIELDOPS_TOKENS.radius.md,
    borderWidth: 1,
    borderColor: FIELDOPS_TOKENS.color.border,
    backgroundColor: FIELDOPS_TOKENS.color.cardBg,
    minHeight: 44,
    justifyContent: "center",
  },
  actionButtonText: {
    fontSize: 13,
    fontWeight: "700",
    color: FIELDOPS_TOKENS.color.text,
    fontFamily: FIELDOPS_TOKENS.font.sans,
  },
  error: {
    fontSize: 14,
    color: FIELDOPS_TOKENS.color.danger,
    marginBottom: 8,
  },
  subtitle: {
    fontSize: 14,
    opacity: 0.8,
    textAlign: "center",
    marginBottom: 12,
    color: FIELDOPS_TOKENS.color.textMuted,
  },
  mono: {
    fontSize: 12,
    fontFamily: FIELDOPS_TOKENS.font.mono,
    opacity: 0.7,
    textAlign: "center",
    color: FIELDOPS_TOKENS.color.textMuted,
  },
  methodRow: { flexDirection: "row", gap: 10, marginTop: 18 },
  methodChip: {
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: FIELDOPS_TOKENS.color.border,
    backgroundColor: FIELDOPS_TOKENS.color.cardBg,
  },
  methodChipActive: {
    borderColor: FIELDOPS_TOKENS.color.accent,
    backgroundColor: FIELDOPS_TOKENS.color.accentSoft,
  },
  methodChipText: { fontSize: 12, fontWeight: "700", color: FIELDOPS_TOKENS.color.text },
  form: { width: "100%", maxWidth: 420, marginTop: 18, gap: 12 },
  input: {
    borderWidth: 1,
    borderColor: FIELDOPS_TOKENS.color.border,
    borderRadius: FIELDOPS_TOKENS.radius.md,
    paddingHorizontal: 14,
    paddingVertical: 12,
    backgroundColor: FIELDOPS_TOKENS.color.cardBg,
    fontSize: 14,
    fontFamily: FIELDOPS_TOKENS.font.sans,
    color: FIELDOPS_TOKENS.color.text,
  },
  composerField: {
    marginBottom: 12,
  },
  composerInput: {
    minHeight: 44,
  },
  composerTextarea: {
    minHeight: 92,
  },
  primaryButton: {
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderRadius: FIELDOPS_TOKENS.radius.md,
    backgroundColor: FIELDOPS_TOKENS.color.accent,
    minHeight: 44,
    justifyContent: "center",
  },
  primaryButtonDisabled: { opacity: 0.5 },
  primaryButtonPressed: { opacity: 0.85 },
  primaryButtonText: {
    color: FIELDOPS_TOKENS.color.accentText,
    fontSize: 14,
    fontWeight: "800",
    textAlign: "center",
    fontFamily: FIELDOPS_TOKENS.font.sans,
  },
  authError: { marginTop: 10, color: FIELDOPS_TOKENS.color.danger, fontSize: 12, textAlign: "center" },
  secondaryButton: {
    paddingHorizontal: 14,
    paddingVertical: 12,
    borderRadius: FIELDOPS_TOKENS.radius.md,
    borderWidth: 1,
    borderColor: FIELDOPS_TOKENS.color.border,
    backgroundColor: FIELDOPS_TOKENS.color.cardBg,
    minHeight: 44,
    justifyContent: "center",
  },
  secondaryButtonText: {
    fontSize: 13,
    fontWeight: "800",
    color: FIELDOPS_TOKENS.color.text,
    fontFamily: FIELDOPS_TOKENS.font.sans,
  },
  loadingRow: { flexDirection: "row", alignItems: "center", gap: 8, marginTop: 12 },
  screen: { flexGrow: 1, gap: 12, paddingBottom: 24 },
  screenHeader: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 12 },
  screenHeaderText: { flex: 1 },
  screenHeaderActions: { flexDirection: "row", alignItems: "center", gap: 10 },
  screenActionsRow: { flexDirection: "row", flexWrap: "wrap", gap: 10 },
  noticeCard: {
    borderWidth: 1,
    borderColor: FIELDOPS_TOKENS.color.border,
    borderRadius: FIELDOPS_TOKENS.radius.md,
    padding: 14,
    backgroundColor: FIELDOPS_TOKENS.color.cardBg,
  },
  noticeText: {
    fontSize: 14,
    fontWeight: "800",
    marginBottom: 6,
    color: FIELDOPS_TOKENS.color.text,
    fontFamily: FIELDOPS_TOKENS.font.sans,
  },
  noticeSubtext: {
    fontSize: 12,
    opacity: 0.82,
    color: FIELDOPS_TOKENS.color.textMuted,
    fontFamily: FIELDOPS_TOKENS.font.sans,
  },
  chipRow: { gap: 8, paddingVertical: 6 },
  cameraFrame: {
    height: 320,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: FIELDOPS_TOKENS.color.border,
    overflow: "hidden",
    backgroundColor: "#000",
  },
  camera: { flex: 1 },
  signatureCanvas: {
    height: 160,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: FIELDOPS_TOKENS.color.border,
    backgroundColor: FIELDOPS_TOKENS.color.cardBg,
    overflow: "hidden",
    position: "relative",
    justifyContent: "center",
    alignItems: "center",
  },
  signaturePlaceholder: {
    fontSize: 13,
    color: FIELDOPS_TOKENS.color.textMuted,
    fontFamily: FIELDOPS_TOKENS.font.sans,
  },
  signatureStroke: {
    position: "absolute",
    height: 2.5,
    backgroundColor: FIELDOPS_TOKENS.color.text,
    borderRadius: 999,
  },
  });
}

type FieldOpsStyles = ReturnType<typeof createFieldOpsStyles>;
const DEFAULT_FIELDOPS_STYLES = createFieldOpsStyles(
  getFieldOpsThemeTokens("light", Platform.OS === "web" ? "web" : "native")
);
const FieldOpsStylesContext = React.createContext<FieldOpsStyles>(DEFAULT_FIELDOPS_STYLES);

function useFieldOpsStyles(): FieldOpsStyles {
  return React.useContext(FieldOpsStylesContext);
}


