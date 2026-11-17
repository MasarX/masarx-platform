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
import type { MobileStorageAdapter } from "@masarx/auth/mobile";
import {
  createCacheKey,
  createOutbox,
  createOutboxId,
  stableStringify,
  type KeyValueStore,
  type OutboxStore,
} from "@masarx/mobile-core";
import { createSqliteKeyValueStore, createSqliteOutboxStore } from "@masarx/mobile-core/sqlite";

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
import { getPublicConfigFromExpo, readExtraString, resolveExpoExtra, type ExpoExtra } from "./src/mobile-public-config";
import { createFieldOpsStorage } from "./src/mobile-storage";
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
  normalizeDebugMessage,
} from "./src/mobile-debug";
import {
  addMobileNetworkFailureBreadcrumb,
  captureMobileException,
  initMobileCrashReporting,
  setMobileCrashReportingUser,
} from "./src/mobile-crash-reporting";
import { MobileErrorBoundary } from "./src/mobile-error-boundary";
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
  extractOperationalContacts,
  extractOperationalStopSnapshot,
  extractPhoneNumber,
  extractRouteCardSnapshot,
  extractScanContext,
  extractSettlementSnapshot,
  extractTaskCardSnapshot,
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
  type MobileDirectionMode,
  type MobileLocaleMode,
  type MobileThemeMode,
  resolveDirectionMode,
  resolveLocaleMode,
  resolveThemeMode,
  toAppearanceColorScheme,
} from "./src/mobile-shell-display";
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
import { createMemoryKeyValueStore, createMemoryOutboxStore } from "./src/mobile-memory-store";

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

function formatDetailValue(value: unknown): string {
  if (value == null) return "-";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
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
};
type SignaturePoint = { x: number; y: number };
type SignatureStroke = SignaturePoint[];
type ActionSubmissionReceipt = {
  actionKey: string;
  queueId: string;
  status: "synced" | "queued_offline" | "queued_pending_sync" | "retryable_failure";
  detail: string;
  recordedAt: string;
  resourceId: string | null;
};
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
  const [session, setSession] = React.useState<any>(null);

  React.useEffect(() => {
    let mounted = true;

    client.auth
      .getSession()
      .then((result) => {
        if (!mounted) return;
        setSession(result.data.session);
        setReady(true);
      })
      .catch((error) => {
        logDebugFailure("failed to load auth session", error);
        if (!mounted) return;
        setSession(null);
        setReady(true);
      });

    const { data } = client.auth.onAuthStateChange((_event, nextSession) => {
      if (!mounted) return;
      setSession(nextSession);
      setReady(true);
    });

    return () => {
      mounted = false;
      data.subscription.unsubscribe();
    };
  }, [client]);

  return { ready, session };
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

type CommandInputFieldRuntime = {
  key: string;
  label: string;
  type: "text" | "textarea" | "lookup" | "number";
  required: boolean;
  placeholder: string | null;
  lookupCategory: string | null;
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
    const lookupCategory = coerceValueText(
      (rawField as Record<string, unknown>).lookup_category
    );
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
    return parsed;
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

function formatConnectivityStatusLabel(status: MobileConnectivityStatus): string {
  if (status === "online") return "Online";
  if (status === "degraded") return "Degraded";
  return "Offline";
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

function describeActionReceiptStatus(status: ActionSubmissionReceipt["status"]): string {
  if (status === "synced") return "Synced successfully.";
  if (status === "queued_offline") return "Queued offline and will retry when connectivity returns.";
  if (status === "queued_pending_sync") return "Queued and pending sync.";
  return "Queued, but sync could not complete. Review Outbox for retry state.";
}

function clampSignaturePoint(value: number, max: number): number {
  return Math.max(0, Math.min(max, Number.isFinite(value) ? value : 0));
}

function buildSignatureSvg(strokes: SignatureStroke[], input: { width: number; height: number }): string {
  const width = Math.max(160, Math.round(input.width || 0));
  const height = Math.max(96, Math.round(input.height || 0));
  const polylines = strokes
    .filter((stroke) => stroke.length > 0)
    .map((stroke) => {
      const points = stroke
        .map((point) => {
          const x = clampSignaturePoint(point.x, width).toFixed(1);
          const y = clampSignaturePoint(point.y, height).toFixed(1);
          return `${x},${y}`;
        })
        .join(" ");
      return `<polyline points="${points}" />`;
    })
    .join("");
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" fill="none">`,
    `<rect width="${width}" height="${height}" rx="12" fill="#ffffff" />`,
    `<g stroke="#0f172a" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">`,
    polylines,
    "</g>",
    "</svg>",
  ].join("");
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
  const decoded = globalThis.atob(value);
  const bytes = new Uint8Array(decoded.length);
  for (let index = 0; index < decoded.length; index += 1) {
    bytes[index] = decoded.charCodeAt(index);
  }
  return bytes.buffer;
}

function encodeAsciiToArrayBuffer(value: string): ArrayBuffer {
  const bytes = new Uint8Array(value.length);
  for (let index = 0; index < value.length; index += 1) {
    bytes[index] = value.charCodeAt(index);
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

function formatRouteViewLabel(mode: "list" | "orders_map") {
  return mode === "orders_map" ? "Overview" : "List";
}

function formatMoneyLabel(amount: number | null, currency: string | null | undefined) {
  if (amount == null || !Number.isFinite(amount)) return null;
  const rounded = Math.round(amount * 100) / 100;
  return `${currency ?? "SAR"} ${rounded}`;
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
}: {
  appName: string;
  client: ReturnType<typeof createMobileClient>;
  methods: string[];
}) {
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
      Alert.alert("Sign-in failed", nextMessage);
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
        Alert.alert("Sign-in failed", nextMessage);
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
        Alert.alert("Sign-in failed", nextMessage);
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

  const AuthFormContainer: any = Platform.OS === "web" ? "form" : View;

  return (
    <View style={styles.container}>
      <Text style={styles.title}>{appName}</Text>
      <Text style={styles.subtitle}>Sign in to continue</Text>

      {availableMethods.length > 1 ? (
        <View style={styles.methodRow}>
          {availableMethods.map((candidate) => (
            <Pressable
              key={candidate}
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
                {candidate === "password" ? "Password" : "Email code"}
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
          style={styles.input}
          value={email}
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="email-address"
          placeholder="Email"
          onChangeText={(nextEmail) => {
            setEmail(normalizeAuthEmail(nextEmail));
            setErrorMessage(null);
          }}
        />

        {method === "password" ? (
          <TextInput
            style={styles.input}
            value={password}
            secureTextEntry
            placeholder="Password"
            onChangeText={(nextPassword) => {
              setPassword(nextPassword);
              setErrorMessage(null);
            }}
          />
        ) : null}

        {method === "magic_link" && otpSent ? (
          <TextInput
            style={styles.input}
            value={otpCode}
            placeholder="Code"
            keyboardType="number-pad"
            onChangeText={(nextCode) => {
              setOtpCode(nextCode);
              setErrorMessage(null);
            }}
          />
        ) : null}

        <Pressable
          accessibilityRole="button"
          testID="mobile-signin-submit"
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
              ? "Working..."
              : method === "password"
                ? "Sign in"
                : otpSent
                  ? "Verify code"
                  : "Send code"}
          </Text>
        </Pressable>
        {errorMessage ? <Text style={styles.authError}>{errorMessage}</Text> : null}

        {status === "loading" ? (
          <View style={styles.loadingRow}>
            <ActivityIndicator />
            <Text style={styles.subtitle}>Please wait...</Text>
          </View>
        ) : null}
      </AuthFormContainer>
    </View>
  );
}

function Bootstrap() {
  const queryClient = useQueryClient();
  const safeAreaInsets = useSafeAreaInsets();
  const extra = React.useMemo(
    () => resolveExpoExtra((Constants.expoConfig?.extra ?? {}) as ExpoExtra),
    []
  );
  const publicConfigResult = React.useMemo(() => {
    try {
      return { config: getPublicConfigFromExpo(extra), error: null as string | null };
    } catch (error) {
      return { config: null as ReturnType<typeof getPublicConfigFromExpo> | null, error: normalizeDebugMessage(error) };
    }
  }, [extra]);
  const publicConfig = publicConfigResult.config;
  const configError = publicConfigResult.error;
  const supabaseKeyRole = React.useMemo(() => {
    if (!publicConfig) return null;
    return resolveJwtRole(publicConfig.supabaseAnonKey);
  }, [publicConfig]);
  const storage = React.useMemo(() => createFieldOpsStorage(), []);

  if (!publicConfig) {
    return (
      <View style={styles.container} accessibilityRole="alert">
        <Text style={styles.title}>Fieldops</Text>
        <Text style={styles.error}>Configuration error</Text>
        <Text style={styles.mono}>{configError ?? "Missing public configuration."}</Text>
      </View>
    );
  }

  if (isJwtPrivilegedRole(supabaseKeyRole)) {
    return (
      <View style={styles.container} accessibilityRole="alert">
        <Text style={styles.title}>{publicConfig.appName}</Text>
        <Text style={styles.error}>Invalid Supabase key</Text>
        <Text style={styles.subtitle}>
          The configured SUPABASE key is a service role key, which must never be used in a client app.
        </Text>
        <Text style={styles.mono}>
          Fix: set NEXT_PUBLIC_SUPABASE_ANON_KEY to the anon key for this workspace, then restart the
          dev server.
        </Text>
      </View>
    );
  }

  const client = React.useMemo(
    () =>
      createMobileClient({
        supabaseUrl: publicConfig.supabaseUrl,
        supabaseAnonKey: publicConfig.supabaseAnonKey,
        storage,
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
  const executor = React.useMemo(() => createSupabaseExecutor(client), [client]);
  const auth = useAuthSession(client);
  const network = useNetworkState();

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
        ? createMemoryOutboxStore()
        : createSqliteOutboxStore({ databaseName: "fieldops.db", tableName: "outbox" }),
    []
  );
  const outbox = React.useMemo(() => createOutbox(outboxStore), [outboxStore]);
  const cacheStore = React.useMemo<KeyValueStore>(
    () =>
      Platform.OS === "web"
        ? createMemoryKeyValueStore()
        : createSqliteKeyValueStore({ databaseName: "fieldops.db", tableName: "kv_store" }),
    []
  );

  const outboxInitQuery = useQuery({
    queryKey: ["outbox", "init"],
    queryFn: async () => {
      await outbox.init();
      return true;
    },
    staleTime: Infinity,
  });

  const cacheInitQuery = useQuery({
    queryKey: ["kv", "init"],
    queryFn: async () => {
      await cacheStore.init();
      return true;
    },
    staleTime: Infinity,
  });

  const outboxCountQuery = useQuery({
    queryKey: ["outbox", "count"],
    queryFn: () => outbox.countPending(),
    enabled: outboxInitQuery.isSuccess,
  });

  const [lastSyncSuccessAt, setLastSyncSuccessAt] = React.useState<string | null>(null);
  const [syncErrorCount, setSyncErrorCount] = React.useState(0);

  const syncMutation = useMutation({
    mutationFn: () =>
      outbox.sync(executor, {
        shouldRetry: (error) =>
          isRetriableNetworkError(error) || isRetriableSupabaseError(error),
      }),
    onSuccess: () => {
      setLastSyncSuccessAt(new Date().toISOString());
      setSyncErrorCount(0);
      queryClient.invalidateQueries({ queryKey: ["outbox", "count"] });
      queryClient.invalidateQueries({ queryKey: ["outbox", "entries"] });
      queryClient.invalidateQueries({ queryKey: ["ui", "list"] });
      queryClient.invalidateQueries({ queryKey: ["ui", "detail"] });
    },
    onError: () => {
      setSyncErrorCount((prev) => Math.min(prev + 1, 20));
    },
  });

  const ctxQuery = useQuery({
    queryKey: ["ui", "context", "mobile", auth.session?.user?.id ?? null],
    queryFn: () => uiClient.context("mobile"),
    enabled: Boolean(auth.session),
  });

  const bootEventQueuedRef = React.useRef(false);
  React.useEffect(() => {
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
  }, [ctxQuery.data, outbox, outboxInitQuery.isSuccess, queryClient]);

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

  if (!ctxQuery.data) {
    return (
      <View style={styles.container}>
        <Text style={styles.title}>{publicConfig.appName}</Text>
        <Text style={styles.error}>Failed to load app context.</Text>
        <Text style={styles.mono}>No context payload was returned.</Text>
      </View>
    );
  }

  return (
    <BootstrapAuthed
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
  syncMutation: UseMutationResult<unknown, unknown, void, unknown>;
};

function BootstrapAuthed(props: BootstrapAuthedProps) {
  const queryClient = useQueryClient();
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
  const [selectedResourceId, setSelectedResourceId] = React.useState<string | null>(null);
  const [selectedResourceKey, setSelectedResourceKey] = React.useState<string | null>(null);
  const [selectedResourceTitle, setSelectedResourceTitle] = React.useState<string | null>(null);
  const [selectedViewId, setSelectedViewId] = React.useState<string | null>(null);
  const [navOpen, setNavOpen] = React.useState(false);
  const [viewPickerOpen, setViewPickerOpen] = React.useState(false);
  const [showSystemDetails, setShowSystemDetails] = React.useState(false);
  const [scanContext, setScanContext] = React.useState<DriverScanContext | null>(null);
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
    setShowSystemDetails(false);
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
      resource,
      view_id: resolvedViewId,
      filters: listFilters,
      limit: 50,
      offset: 0,
      sort: listSort,
    });
  }, [listFilters, listSort, resource, resolvedViewId]);

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
    () => normalizeMobileDiagnosticsPolicy((diagnosticsPolicyQuery.data as any)?.value ?? null),
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
  const connectivityStatusLabel = formatConnectivityStatusLabel(connectivityStatus);
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
  const selectedLocaleMode = React.useMemo<MobileLocaleMode>(
    () => resolveLocaleMode(localeModeQuery.data),
    [localeModeQuery.data]
  );
  const selectedDirectionMode = React.useMemo<MobileDirectionMode>(
    () =>
      resolveDirectionMode({
        value: directionModeQuery.data,
        locale: selectedLocaleMode,
      }),
    [directionModeQuery.data, selectedLocaleMode]
  );
  React.useEffect(() => {
    if (Platform.OS !== "web") return;
    const doc = (globalThis as any)?.document;
    if (!doc?.documentElement) return;

    try {
      doc.documentElement.dir = selectedDirectionMode === "rtl" ? "rtl" : "ltr";
      doc.documentElement.lang = String(selectedLocaleMode || "");
    } catch (error) {
      logDebugFailure("failed to update document direction/locale", error);
    }
  }, [selectedDirectionMode, selectedLocaleMode]);
  const selectedThemeMode = React.useMemo<MobileThemeMode>(
    () => resolveThemeMode(themeModeQuery.data),
    [themeModeQuery.data]
  );
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
    () => normalizeMobilePushPolicy((mobilePushPolicyQuery.data as any)?.value ?? null),
    [mobilePushPolicyQuery.data]
  );
  const visibilityPolicy = React.useMemo(
    () => normalizeMobileVisibilityPolicy((visibilityPolicyQuery.data as any)?.value ?? null),
    [visibilityPolicyQuery.data]
  );
  const mapPolicy = React.useMemo(
    () => normalizeMobileMapPolicy((mapPolicyQuery.data as any)?.value ?? null),
    [mapPolicyQuery.data]
  );
  const devicePolicy = React.useMemo(
    () => normalizeMobileDevicePolicy((devicePolicyQuery.data as any)?.value ?? null),
    [devicePolicyQuery.data]
  );
  const navigationPolicy = React.useMemo(
    () => normalizeMobileNavigationPolicy((navigationPolicyQuery.data as any)?.value ?? null),
    [navigationPolicyQuery.data]
  );
  const driverSafetyPolicy = React.useMemo(
    () => normalizeMobileDriverSafetyPolicy((driverSafetyPolicyQuery.data as any)?.value ?? null),
    [driverSafetyPolicyQuery.data]
  );
  const uxSafetyPolicy = React.useMemo(
    () => normalizeMobileUxSafetyPolicy((uxSafetyPolicyQuery.data as any)?.value ?? null),
    [uxSafetyPolicyQuery.data]
  );
  const communicationPolicy = React.useMemo(
    () => normalizeMobileCommunicationPolicy((communicationPolicyQuery.data as any)?.value ?? null),
    [communicationPolicyQuery.data]
  );
  const addressPolicy = React.useMemo(
    () => normalizeMobileAddressPolicy((addressPolicyQuery.data as any)?.value ?? null),
    [addressPolicyQuery.data]
  );

  const selectedVisibilityMode = React.useMemo(() => {
    const candidate = visibilityModeQuery.data;
    if (typeof candidate === "string" && visibilityPolicy.allowedVisibility.includes(candidate as any)) {
      return candidate;
    }
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
    Alert.alert("Driving mode locked", "Navigation is limited while moving.");
  }, [drivingSafetyState, navBlockedWhileDriving, navigationItems, selectedId]);

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
    () => normalizeMobileAttestationPolicy((mobileAttestationPolicyQuery.data as any)?.value ?? null),
    [mobileAttestationPolicyQuery.data]
  );
  const iosAttestationKeyIdRef = React.useRef<string | null>(null);
  const androidAttestationPreparedForRef = React.useRef<number | null>(null);

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
          const rawCloudProjectNumber = mobileAttestationPolicy.androidCloudProjectNumber;
          const cloudProjectNumber =
            typeof rawCloudProjectNumber === "number"
              ? rawCloudProjectNumber
              : Number(rawCloudProjectNumber);
          if (!Number.isFinite(cloudProjectNumber) || cloudProjectNumber <= 0) {
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

      const deviceLabel = coerceHref((Constants as any).deviceName);
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
          expo_runtime: (Constants.expoConfig as any)?.runtimeVersion ?? null,
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
        (detailCommunicationPolicyQuery.data as any)?.value ??
          (communicationPolicyQuery.data as any)?.value ??
          null
      ),
    [communicationPolicyQuery.data, detailCommunicationPolicyQuery.data]
  );
  const routeExecutionManifestQuery = useQuery({
    queryKey: ["route", "execution-manifest", selectedRouteRunId],
    queryFn: async () => {
      const { data, error } = await client.rpc("ui_route_run_execution_manifest_v1", {
        p_route_run_id: selectedRouteRunId,
      });
      if (error) throw error;
      return Array.isArray(data) ? data[0] ?? null : data;
    },
    enabled: Boolean(me?.user?.id && selectedRouteRunId && (isRouteSurface || isTasksSurface)),
    staleTime: 30_000,
  });
  const confirmRouteDepartureMutation = useMutation({
    mutationFn: async (input: {
      routeRunId: string;
      routeStopId?: string | null;
      taskId?: string | null;
      opsSessionId?: string | null;
    }) => {
      const { data, error } = await client.rpc("ui_confirm_route_run_departure_v1", {
        p_input: {
          route_run_id: input.routeRunId,
          route_stop_id: input.routeStopId ?? null,
          task_id: input.taskId ?? null,
          ops_session_id: input.opsSessionId ?? null,
        },
      });
      if (error) throw error;
      return Array.isArray(data) ? data[0] ?? null : data;
    },
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({
          queryKey: ["ui", "detail", detailResource, selectedResourceId],
        }),
        queryClient.invalidateQueries({
          queryKey: ["ui", "list", resource],
        }),
        queryClient.invalidateQueries({
          queryKey: ["route", "execution-manifest", selectedRouteRunId],
        }),
      ]);
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

  React.useEffect(() => {
    setShowSystemDetails(false);
  }, [selectedResourceId]);

  const selectedTaskActionable = React.useMemo(() => {
    if (Object.keys(selectedTaskDetail).length === 0) return false;
    const status = normalizeTaskStateToken(selectedTaskDetail.status);
    const completedAt = coerceValueText(selectedTaskDetail.completed_at);
    const canceledAt = coerceValueText(selectedTaskDetail.canceled_at);
    const hasCompletedAt = Boolean(completedAt && completedAt !== "-");
    const hasCanceledAt = Boolean(canceledAt && canceledAt !== "-");
    const isTerminalStatus = status ? TASK_TERMINAL_STATUSES.has(status) : false;
    const isTerminalReason = selectedTaskStatusReason
      ? TASK_TERMINAL_REASONS.has(selectedTaskStatusReason)
      : false;
    if (hasCompletedAt || hasCanceledAt || isTerminalStatus || isTerminalReason) return false;
    return status ? TASK_ACTIONABLE_STATUSES.has(status) : false;
  }, [selectedTaskDetail, selectedTaskStatusReason]);

  const availableActions = React.useMemo<UiCommandDefinition[]>(() => {
    if (!resource) return [];
    const registry = commandRegistryQuery.data;
    const commands = registry?.commands ?? [];

    return commands.filter((command) => {
      const category = command.schema_category ?? null;
      if (category && category !== `resource:${resource}`) return false;
      const capability = command.capability ?? null;
      if (capability && !capabilitiesSet.has(capability)) return false;
      if (!command.execution?.rpc) return false;

      const mode = command.selection?.mode ?? null;
      if (selectedResourceId && mode && mode !== "single" && mode !== "any") {
        return false;
      }

      if (
        resource === "tasks" &&
        selectedResourceId &&
        (command.key === "tasks.complete" ||
          command.key === "tasks.exception" ||
          ROUTE_CLOSEOUT_COMMAND_KEYS.has(command.key) ||
          ROUTE_PROGRESS_COMMAND_KEYS.has(command.key))
      ) {
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
      return type === "rpc" || type === "workflow";
    });
  }, [
    capabilitiesSet,
    commandRegistryQuery.data,
    resource,
    selectedResourceId,
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
      composerCommand ? resolveComposerCommandCopy(composerCommand, selectedStopSnapshot) : null,
    [composerCommand, selectedStopSnapshot]
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
      [...composerLookupCategories].sort().join("|"),
    ],
    enabled: Boolean(composerCommand && composerLookupCategories.length > 0),
    queryFn: async () => {
      const out: Record<string, LookupOption[]> = {};
      for (const category of composerLookupCategories) {
        const { data, error } = await client.rpc("list_lookup_values_v1", { p_category: category });
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
  const composerCameraRef = React.useRef<any>(null);
  const composerSignatureStrokeRef = React.useRef<SignatureStroke | null>(null);
  const composerSupportsPod = React.useMemo(
    () =>
      composerCommand?.key === "tasks.complete" || composerCommand?.key === "tasks.exception",
    [composerCommand?.key]
  );
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
  const composerArtifactBucket =
    coerceValueText(composerEvidencePolicy.bucket_id) ?? "fieldops-evidence";
  const composerArtifactMaxItems = Math.max(
    1,
    Math.round(coerceValueNumber(composerEvidencePolicy.max_items) ?? 6)
  );
  const composerMinArtifactCount = Math.max(
    0,
    Math.round(coerceValueNumber(composerPodRequirements.min_artifact_count) ?? 0)
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
    setComposerCommand(null);
    setComposerValues({});
    setComposerArtifacts([]);
    setComposerCameraOpen(false);
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
    }): Promise<ComposerArtifactEntry> => {
      if (!composerSupportsPod) throw new Error("Proof collection is unavailable for this action.");
      const existingArtifactCount =
        composerArtifacts.length -
        (input.kind === "signature" && composerArtifacts.some((entry) => entry.kind === "signature")
          ? 1
          : 0);
      if (existingArtifactCount >= composerArtifactMaxItems) {
        throw new Error(`Evidence limit reached (${composerArtifactMaxItems}).`);
      }
      if (!selectedResourceId) throw new Error("Select a task before collecting proof.");

      const organizationId = readContextId(policyContext, "organization_id");
      if (!organizationId) {
        throw new Error("Organization context is missing for proof capture.");
      }

      const storageKey = `${organizationId}/${selectedResourceId}/${Date.now()}-${createOutboxId()}.${input.extension}`;
      const upload = await client.storage.from(composerArtifactBucket).upload(storageKey, input.bytes, {
        contentType: input.mimeType,
        upsert: false,
      });
      if (upload.error) throw upload.error;

      const currentCoordinates = extractCoordinates(detailQuery.data?.detail);
      const registerResult = await client.rpc("register_mobile_artifact_v1", {
        p_artifact: {
          organization_id: organizationId,
          storage_bucket: composerArtifactBucket,
          storage_key: storageKey,
          mime_type: input.mimeType,
          size_bytes: input.bytes.byteLength,
          metadata: {
            app: "fieldops",
            action_key: composerCommand?.key ?? null,
            artifact_kind: input.kind,
            task_id: selectedResourceId,
            captured_at: new Date().toISOString(),
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
        },
      });
      if (registerResult.error) throw registerResult.error;
      const rows = Array.isArray(registerResult.data)
        ? registerResult.data
        : registerResult.data
          ? [registerResult.data]
          : [];
      const artifactId = coerceValueText(asRecord(rows[0]).artifact_id);
      if (!artifactId) {
        throw new Error("Artifact registration did not return an artifact id.");
      }
      return {
        artifactId,
        storageKey,
        capturedAt: new Date().toISOString(),
        kind: input.kind,
        mimeType: input.mimeType,
      };
    },
    [
      client,
      composerArtifactBucket,
      composerArtifactMaxItems,
      composerArtifacts.length,
      composerCommand?.key,
      composerSupportsPod,
      detailQuery.data?.detail,
      policyContext,
      selectedResourceId,
      selectedStopSnapshot?.customerName,
      selectedStopSnapshot?.reference,
    ]
  );

  const captureComposerArtifact = React.useCallback(async () => {
    if (!composerSupportsPod || isCapturingComposerArtifact) return;
    if (!composerCameraPermission?.granted) {
      if (composerCameraPermission?.canAskAgain === false) {
        Alert.alert("Camera permission required", "Open settings to allow proof capture.");
        void openSystemSettingsSafe();
        return;
      }
      const granted = await requestComposerCameraPermission();
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
          base64: true,
          skipProcessing: true,
        })
      );
      const base64 = coerceValueText(photo.base64);
      if (!base64) {
        throw new Error("Camera capture did not return image data.");
      }
      const artifact = await registerComposerArtifact({
        bytes: decodeBase64ToArrayBuffer(base64),
        extension: "jpg",
        mimeType: "image/jpeg",
        kind: "photo",
      });
      setComposerArtifacts((prev) => [...prev, artifact]);
      setComposerCameraOpen(false);
    } catch (error) {
      setComposerError(formatUnknownError(error));
    } finally {
      setIsCapturingComposerArtifact(false);
    }
  }, [
    composerCameraPermission,
    composerSupportsPod,
    isCapturingComposerArtifact,
    registerComposerArtifact,
    requestComposerCameraPermission,
  ]);

  const captureComposerSignature = React.useCallback(async () => {
    if (!composerSupportsPod || isCapturingComposerSignature) return;
    if (!composerSignaturePresent) {
      setComposerError("Add a signature before capturing it.");
      return;
    }
    try {
      setIsCapturingComposerSignature(true);
      setComposerError(null);
      const svg = buildSignatureSvg(composerSignatureStrokes, composerSignatureLayout);
      const bytes = encodeAsciiToArrayBuffer(svg);
      const artifact = await registerComposerArtifact({
        bytes,
        extension: "svg",
        mimeType: "image/svg+xml",
        kind: "signature",
        metadata: {
          signature: {
            strokes: composerSignatureStrokes.length,
            width: composerSignatureLayout.width,
            height: composerSignatureLayout.height,
          },
        },
      });
      setComposerArtifacts((prev) => [
        ...prev.filter((entry) => entry.kind !== "signature"),
        artifact,
      ]);
      clearComposerSignature();
    } catch (error) {
      setComposerError(formatUnknownError(error));
    } finally {
      setIsCapturingComposerSignature(false);
    }
  }, [
    clearComposerSignature,
    composerSignatureLayout,
    composerSignaturePresent,
    composerSignatureStrokes,
    composerSupportsPod,
    isCapturingComposerSignature,
    registerComposerArtifact,
  ]);

  const removeComposerArtifact = React.useCallback((artifactId: string) => {
    setComposerArtifacts((prev) => prev.filter((entry) => entry.artifactId !== artifactId));
    setComposerError((current) => (current ? null : current));
  }, []);

  const enqueueCommand = React.useCallback(
    async (
      command: UiCommandDefinition,
      input?: {
        payloadPatch?: Record<string, unknown>;
        paramsPatch?: Record<string, unknown>;
      }
    ): Promise<ActionSubmissionReceipt> => {
      if (!resource) throw new Error("Action resource is not selected.");
      const rpc = command.execution?.rpc ?? "";
      if (!rpc) throw new Error("Action RPC is missing.");

      const payloadKeyRaw = coerceValueText(command.execution?.payload_key)?.trim();
      const payloadKey = payloadKeyRaw || "payload";
      const baseParams = asRecord(command.execution?.params);
      const nextParams: Record<string, unknown> = { ...baseParams, ...(input?.paramsPatch ?? {}) };
      if (input?.payloadPatch && Object.keys(input.payloadPatch).length > 0) {
        const existingPayload = asRecord(nextParams[payloadKey]);
        nextParams[payloadKey] = {
          ...existingPayload,
          ...input.payloadPatch,
        };
      }

      const selectionIds = selectedResourceId ? [selectedResourceId] : [];
      const queueId = createOutboxId();
      await outbox.enqueue({
        id: queueId,
        rpc,
        args: {
          p_action_key: command.key,
          p_resource_key: resource,
          p_selection_ids: selectionIds,
          p_selection_id: selectedResourceId,
          p_selection_count: selectionIds.length,
          p_params: Object.keys(nextParams).length > 0 ? nextParams : null,
        },
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
            await syncMutation.mutateAsync();
            status = "synced";
          } catch {
            status = "retryable_failure";
          }
        }
      }
      const receipt: ActionSubmissionReceipt = {
        actionKey: command.key,
        queueId,
        status,
        detail: describeActionReceiptStatus(status),
        recordedAt: new Date().toISOString(),
        resourceId: selectedResourceId ?? null,
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
      setLastActionReceipt,
    ]
  );

  const runCommand = React.useCallback(
    async (command: UiCommandDefinition) => {
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
      Alert.alert("Action receipt", `${receipt.detail}\nQueue ref: ${receipt.queueId}`);
    },
    [enqueueCommand, selectedStopSnapshot]
  );

  const submitComposer = React.useCallback(async () => {
    if (!composerCommand) return;
    const fields = resolveCommandInputFields(composerCommand, selectedStopSnapshot);
    if (!fields.length) {
      resetComposer();
      return;
    }

    for (const field of fields) {
      const value = String(composerValues[field.key] ?? "").trim();
      if (field.required && !value) {
        setComposerError(`${field.label} is required.`);
        return;
      }
      if (field.type === "number" && value && !Number.isFinite(Number(value))) {
        setComposerError(`${field.label} must be a valid number.`);
        return;
      }
    }

    if (
      composerCommand.key === "tasks.exception" &&
      String(composerValues.exception_reason || "").trim().toLowerCase() === "other" &&
      !String(composerValues.exception_notes || "").trim()
    ) {
      setComposerError("Notes are required when exception reason is Other.");
      return;
    }

    if (composerPodPolicyState.blockingMessage) {
      setComposerError(composerPodPolicyState.blockingMessage);
      return;
    }

    if (composerSignatureRequired && !composerSignatureArtifact) {
      setComposerError("Capture and save the recipient signature before queueing.");
      return;
    }

    if (composerPhotoRequired && composerArtifacts.length === 0) {
      setComposerError("At least one proof photo is required.");
      return;
    }

    if (composerArtifacts.length < composerMinArtifactCount) {
      setComposerError(
        `At least ${composerMinArtifactCount} proof item${composerMinArtifactCount === 1 ? "" : "s"} are required.`
      );
      return;
    }

    if (composerCommand.key === "tasks.complete" && !isPickupStopSnapshot(selectedStopSnapshot)) {
      const otpCode = sanitizeOtpCode(composerValues.otp_code);
      const identityKind =
        coerceValueText(composerValues.recipient_identity_kind)?.toLowerCase() ?? null;
      const identityLast4 = sanitizeIdentityLast4(composerValues.recipient_identity_last4);

      if (composerOtpRequired && !otpCode) {
        setComposerError("Recipient OTP is required before queueing this delivery.");
        return;
      }
      if (otpCode && otpCode.length < 4) {
        setComposerError("Recipient OTP must contain at least 4 digits.");
        return;
      }

      if (composerIdentityRequired && (!identityKind || !identityLast4)) {
        setComposerError("Identity type and identity last 4 are required before queueing this delivery.");
        return;
      }
      if ((identityKind && !identityLast4) || (!identityKind && identityLast4)) {
        setComposerError("Provide both identity type and identity last 4 for recipient confirmation.");
        return;
      }
      if (identityLast4 && identityLast4.length < 4) {
        setComposerError("Identity last 4 must contain at least 4 letters or digits.");
        return;
      }
    }

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
        setComposerError("This exception reason requires photo evidence.");
        return;
      }
      if (reasonNeedsNotes && !hasNotes) {
        setComposerError("Add notes for this exception reason before queueing.");
        return;
      }
    }

    let partialDeliveryBoxNumbers: number[] | null = null;
    const completionKind =
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
        setComposerError(
          error instanceof Error && String(error.message || "").trim()
            ? error.message
            : "Partial delivery box numbers are invalid."
        );
        return;
      }
    }

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

    try {
      setComposerSubmitting(true);
      setComposerError(null);
      const payload: Record<string, unknown> = {};
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
      if (composerArtifacts.length > 0) {
        payload.artifact_ids = composerArtifacts.map((entry) => entry.artifactId);
      }
      if (composerSignatureArtifact) {
        payload.signature_artifact_id = composerSignatureArtifact.artifactId;
      }
      if (activeDriverShift?.opsSessionId) {
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
      const receipt = await enqueueCommand(composerCommand, {
        payloadPatch: payload,
        paramsPatch:
          composerCommand.key === "tasks.exception" && isPickupStopSnapshot(selectedStopSnapshot)
            ? {
                status_reason: String(composerValues.exception_reason ?? "").trim().toLowerCase(),
              }
            : undefined,
      });
      resetComposer();
      Alert.alert("Action receipt", `${receipt.detail}\nQueue ref: ${receipt.queueId}`);
    } catch (error) {
      setComposerError(
        error instanceof Error && String(error.message || "").trim()
          ? error.message
          : "Unable to queue action with provided input."
      );
      setComposerSubmitting(false);
    }
  }, [
    composerArtifacts,
    activeDriverShift?.opsSessionId,
    composerCommand,
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
  const handleConfirmRouteDeparture = React.useCallback(() => {
    if (!selectedRouteRunId) return;
    void (async () => {
      const accepted = await confirmMobileAction({
        title: "Confirm departure",
        message:
          "This marks the route as departed after the current route-load scans reconcile to the planned stops.",
        confirmLabel: "Confirm departure",
      });
      if (!accepted) return;

      try {
        const result = await confirmRouteDepartureMutation.mutateAsync({
          routeRunId: selectedRouteRunId,
          routeStopId: selectedRouteContext?.routeStopId ?? null,
          taskId: selectedRouteContext?.taskId ?? null,
          opsSessionId: activeDriverShift?.opsSessionId ?? selectedRouteContext?.opsSessionId ?? null,
        });
        const payload = asRecord(result);
        const scanOut = asRecord(payload.scan_out);
        const scannedStopCount = coerceValueNumber(scanOut.scanned_stop_count);
        const expectedStopCount =
          coerceValueNumber(scanOut.expected_stop_count) ?? coerceValueNumber(payload.total_stop_count);
        Alert.alert(
          "Departure confirmed",
          scannedStopCount != null && expectedStopCount != null
            ? `Route departure was confirmed for ${scannedStopCount}/${expectedStopCount} scanned stops.`
            : "Route departure was confirmed."
        );
      } catch (error) {
        logDebugFailure("failed to confirm route departure", error);
        Alert.alert("Departure blocked", formatUnknownError(error));
      }
    })();
  }, [
    activeDriverShift?.opsSessionId,
    confirmRouteDepartureMutation,
    selectedRouteContext?.opsSessionId,
    selectedRouteContext?.routeStopId,
    selectedRouteContext?.taskId,
    selectedRouteRunId,
  ]);

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
        title: "Sign out",
        message: "This will clear local cached data and queued actions on this device.",
        confirmLabel: "Sign out",
        cancelLabel: "Cancel",
        danger: true,
      });
      if (!confirmed) return;

      try {
        const result = await client.auth.signOut({ scope: "local" });
        if (result.error) throw result.error;
      } catch (error) {
        logDebugFailure("failed to sign out", error);
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
      await outboxStore.clear();
      await cacheStore.clear();
      await clearStoredDeviceState(storage);
      queryClient.clear();
    })().catch((error) => {
      logDebugFailure("failed to clear local data during sign out", error);
    });
  }, [cacheStore, client, outboxStore, queryClient, storage]);

  const routeSummary = React.useMemo(() => {
    if (!isRouteSurface) return null;
    const items = listQuery.data?.list.items ?? [];
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
  }, [isRouteSurface, listQuery.data?.list.items]);
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
    (isRouteSurface ? "Route" : isSettlementsSurface ? "Settlements" : resource ?? publicConfig.appName);
  const resourceHeaderSubtitle = isRouteSurface
    ? `${routeSummary?.totalStops ?? 0} stops${routeSummary?.routeDate ? ` - ${routeSummary.routeDate}` : ""}`
    : isSettlementsSurface
      ? "settlements (ledger surface)"
      : resource ?? "";
  const canToggleRouteView =
    isRouteSurface && mapPolicy.routeViews.length > 1 && !drivingModeLocked;
  const appDirectionStyle =
    Platform.OS === "web" ? null : selectedDirectionMode === "rtl" ? styles.directionRtl : styles.directionLtr;
  const userRoleLabel = React.useMemo(
    () => resolveMobileRoleLabel(me?.user?.user_type ?? null),
    [me?.user?.user_type]
  );
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
        <Pressable
          accessibilityRole="button"
          testID="mobile-menu-close"
          onPress={() => setNavOpen(false)}
          style={({ pressed }) => [styles.drawerClose, pressed && styles.drawerClosePressed]}
        >
          <Text style={styles.drawerCloseText}>{"\u00D7"}</Text>
        </Pressable>
      </View>
      <ScrollView contentContainerStyle={styles.drawerContent}>
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
	                      showMobileNotice("Driving mode locked", "This module is blocked while moving.");
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
          <Text style={styles.navModalTitle}>{composerCopy?.title ?? composerCommand?.label ?? "Action input"}</Text>
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
                {field.label}
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
                          onPress={() => setComposerFieldValue(field.key, option.value)}
                          disabled={composerSubmitting}
                          style={({ pressed }) => [
                            styles.chip,
                            value === option.value && styles.navItemSelected,
                            composerSubmitting && styles.primaryButtonDisabled,
                            pressed && styles.navItemPressed,
                          ]}
                        >
                          <Text style={styles.chipText}>{option.label}</Text>
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

        {composerSupportsPod ? (
          <View style={styles.noticeCard}>
            <Text style={styles.noticeText}>Proof and evidence</Text>
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
            <View style={[styles.screenActionsRow, { marginTop: 10 }]}>
              <Pressable
                testID="mobile-action-composer-open-proof-camera"
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
                  {composerCameraOpen ? "Close proof camera" : "Open proof camera"}
                </Text>
              </Pressable>
              <Pressable
                testID="mobile-action-composer-capture-proof"
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
                  {isCapturingComposerArtifact ? "Capturing..." : "Capture photo"}
                </Text>
              </Pressable>
            </View>
            <View style={[styles.noticeCard, { marginTop: 10 }]}>
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
            </View>
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

        {composerError ? <Text style={styles.error}>{composerError}</Text> : null}

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
              {composerSubmitting ? "Queueing..." : "Queue action"}
            </Text>
          </Pressable>
        </View>
      </ScrollView>
    </View>
  );

  return (
    <View style={isWebPreview ? styles.webViewport : styles.pageRoot}>
      <View style={[styles.page, appDirectionStyle, isWebPreview && styles.pageWeb]}>
      <View style={[styles.header, headerSafeAreaStyle]}>
        <Pressable
          accessibilityRole="button"
          testID="mobile-menu-toggle"
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
          <Text style={styles.headerPill}>Outbox: {outboxCount}</Text>
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
          style={[
            styles.connectivityBanner,
            connectivityStatus === "offline"
              ? styles.connectivityBannerOffline
              : styles.connectivityBannerDegraded,
          ]}
        >
          <Text style={styles.connectivityBannerTitle}>
            {connectivityStatus === "offline" ? "Offline mode" : "Connectivity degraded"}
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
                disabled={syncMutation.isPending}
                style={({ pressed }) => [
                  styles.syncNowButton,
                  syncMutation.isPending && styles.syncButtonDisabled,
                  pressed && styles.syncButtonPressed,
                ]}
              >
                <Text style={styles.syncButtonText}>
                  {syncMutation.isPending ? "Syncing..." : "Sync now"}
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
                  <Text style={styles.syncButtonText}>Back</Text>
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
                  {isRouteSurface || isTasksSurface ? (
                    <RouteSurfaceDetailExtensions
                      detail={detailQuery.data.detail}
                      resourceId={selectedResourceId}
                      surfaceLabel={isRouteSurface ? "Route stop" : "Task stop"}
                      diagnosticsEnabled={diagnosticsEnabled}
                      interactionLocked={drivingModeLocked}
                      addressPolicy={addressPolicy}
                      communicationPolicy={detailCommunicationPolicy}
                      navigationPolicy={navigationPolicy}
                      platform={effectiveMobilePlatform}
                      routeExecutionManifest={routeExecutionManifestQuery.data}
                      isConfirmingRouteDeparture={confirmRouteDepartureMutation.isPending}
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
                      detail={detailQuery.data.detail}
                      fallbackId={selectedResourceId}
                      diagnosticsEnabled={diagnosticsEnabled}
                      interactionLocked={drivingModeLocked}
                      uxSafetyPolicy={uxSafetyPolicy}
                      onSubmitCount={handleSettlementCountSubmit}
                    />
                  ) : null}
                  {lastActionReceipt && lastActionReceipt.resourceId === selectedResourceId ? (
                    <View style={[styles.noticeCard, { marginTop: 12 }]}>
                      <Text style={styles.noticeText}>Last action receipt</Text>
                      <Text style={styles.noticeSubtext}>{lastActionReceipt.detail}</Text>
                      <Text style={[styles.noticeSubtext, { marginTop: 4 }]}>
                        Queue ref: {lastActionReceipt.queueId}
                      </Text>
                      <Text style={[styles.noticeSubtext, { marginTop: 4 }]}>
                        Recorded: {lastActionReceipt.recordedAt}
                      </Text>
                    </View>
                  ) : null}
                  <Pressable
                    accessibilityRole="button"
                    testID="mobile-detail-toggle-system"
                    onPress={() => setShowSystemDetails((current) => !current)}
                    style={({ pressed }) => [
                      styles.secondaryButton,
                      { marginTop: 12 },
                      pressed && styles.navItemPressed,
                    ]}
                  >
                    <Text style={styles.secondaryButtonText}>
                      {showSystemDetails ? "Hide system details" : "Show system details"}
                    </Text>
                  </Pressable>
                  {showSystemDetails ? (
                    <View style={[styles.noticeCard, { marginTop: 12 }]}>
                      <Text style={styles.noticeText}>System details</Text>
                      {Object.entries(detailQuery.data.detail).map(([key, value]) => (
                        <View key={key} style={styles.detailRow}>
                          <Text style={styles.detailKey}>{formatKeyLabel(key)}</Text>
                          <Text style={styles.detailValue}>{formatDetailValue(value)}</Text>
                        </View>
                      ))}
                    </View>
                  ) : null}
                </ScrollView>
              ) : (
                <Text style={styles.subtitle}>No detail payload.</Text>
              )}

              {availableActions.length ? (
                <View style={styles.actionsBar}>
                  {availableActions.map((command) => {
                    const actionKey = resolveActionLockKey(command);
                    const actionLocked = isActionLocked(actionKey);
                    const commandCopy = resolveComposerCommandCopy(command, selectedStopSnapshot);
                    const needsInput = resolveCommandInputFields(command, selectedStopSnapshot).length > 0;

                    return (
                      <Pressable
                        key={command.key}
                        testID={`mobile-action-${command.key}`}
                        onPress={() => {
                          if (drivingModeLocked) {
                            Alert.alert("Driving mode locked", "Stop moving before running actions.");
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
                          {needsInput ? `${commandCopy?.label ?? command.label}...` : commandCopy?.label ?? command.label}
                        </Text>
                      </Pressable>
                    );
                  })}
                </View>
              ) : null}
            </View>
          ) : (
            <View style={styles.listPane}>
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
                            <Text style={styles.chipText}>{formatRouteViewLabel(mode)}</Text>
                          </Pressable>
                        );
                      })}
                    </>
                  ) : null}
                </View>
              ) : null}

              {listQuery.isLoading ? (
                <Text style={styles.subtitle}>Loading {resource}...</Text>
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
                    list={listQuery.data.list}
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
                        Alert.alert("Driving mode locked", "Stop moving to open item details.");
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
              outboxStore={outboxStore}
              outboxCount={outboxCount}
              syncing={syncMutation.isPending}
              diagnosticsEnabled={diagnosticsEnabled}
              onSync={() => syncMutation.mutate()}
            />
          ) : activeScreen === "scan" ? (
            <ScanScreen
              client={client}
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
              onSetThemeMode={async (next) => {
                await cacheStore.set(KV_KEYS.themeMode, next);
                queryClient.invalidateQueries({ queryKey: ["kv", "get", KV_KEYS.themeMode] });
              }}
              onOpenModule={(key) => {
                openModuleByKey(key);
              }}
              onStartShift={startDriverShift}
              onEndShift={endDriverShift}
              onSignOut={handleSignOut}
            />
          ) : (
            <DiagnosticsScreen
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
                try {
                  const result = await client.auth.signOut({ scope: "local" });
                  if (result.error) throw result.error;
                } catch (error) {
                  logDebugFailure("failed to sign out from diagnostics clear", error);
                }
                setMobileCrashReportingUser(null);
                try {
                  await clearMobileTelemetryEvents();
                } catch (error) {
                  logDebugFailure("failed to clear telemetry during diagnostics clear", error);
                }
                await outboxStore.clear();
                await cacheStore.clear();
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
	                        showMobileNotice("Driving mode locked", "This module is blocked while moving.");
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
  );
}

function OutboxScreen({
  outboxStore,
  outboxCount,
  syncing,
  diagnosticsEnabled,
  onSync,
}: {
  outboxStore: ReturnType<typeof createSqliteOutboxStore>;
  outboxCount: number;
  syncing: boolean;
  diagnosticsEnabled: boolean;
  onSync: () => void;
}) {
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
          <Text style={styles.resourceTitle}>Outbox</Text>
          <Text style={styles.resourceSubtitle}>
            Pending: {outboxCount} {syncing ? "- syncing" : ""}
          </Text>
        </View>
        <View style={styles.screenHeaderActions}>
          <Pressable
            onPress={onSync}
            disabled={syncing}
            style={({ pressed }) => [
              styles.syncNowButton,
              syncing && styles.syncButtonDisabled,
              pressed && styles.syncButtonPressed,
            ]}
          >
            <Text style={styles.syncButtonText}>{syncing ? "Syncing..." : "Sync now"}</Text>
          </Pressable>
        </View>
      </View>

      <View style={styles.screenActionsRow}>
        <Pressable
          onPress={clearDead}
          disabled={syncing || isClearingOutbox}
          style={({ pressed }) => [
            styles.secondaryButton,
            (syncing || isClearingOutbox) && styles.primaryButtonDisabled,
            pressed && styles.navItemPressed,
          ]}
        >
          <Text style={styles.secondaryButtonText}>Clear dead</Text>
        </Pressable>
        {diagnosticsEnabled ? (
          <Pressable
            onPress={clearAll}
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
          renderItem={({ item }) => (
            <View style={styles.card}>
              <Text style={styles.cardTitle}>{item.rpc}</Text>
              <Text style={styles.cardSubtitle}>
                {item.status} - attempts {item.attempt_count ?? 0}
              </Text>
              {diagnosticsEnabled && item.last_error ? (
                <Text style={styles.mono} numberOfLines={6}>
                  {item.last_error}
                </Text>
              ) : null}
            </View>
          )}
        />
      ) : (
        <Text style={styles.subtitle}>Outbox is empty.</Text>
      )}
    </View>
  );
}

function ScanScreen({
  client,
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
  const queryClient = useQueryClient();
  const [scanType, setScanType] = React.useState("");
  const [barcode, setBarcode] = React.useState("");
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
  } | null>(null);

  const scanPolicyQuery = useQuery({
    queryKey: ["policy", "scan_policy", stableStringify(policyContext)],
    queryFn: async () => resolvePolicyRow(client, "resolve_scan_policy", policyContext),
    staleTime: 5 * 60_000,
  });

  const scanPolicyRow = scanPolicyQuery.data ?? null;
  const scanPolicyLoaded = scanPolicyQuery.isSuccess;
  const scanPolicyUnavailable = scanPolicyQuery.isError || (scanPolicyLoaded && scanPolicyRow == null);
  const scanPolicyValue = scanPolicyRow ? (scanPolicyRow as any)?.value ?? null : null;
  const scanEnabled = !scanPolicyUnavailable && scanPolicyValue?.enabled === true;
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
    if (storedScanInputMode === effectiveScanInputMode) return;
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
        Alert.alert("Driving mode locked", "Stop moving before recording scans.");
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

      queryClient.invalidateQueries({ queryKey: ["outbox", "count"] });
      queryClient.invalidateQueries({ queryKey: ["outbox", "entries"] });

      setBarcode("");
      setLastQueuedScan({
        id,
        barcode: barcode.trim(),
        scanType: scanType.trim().toLowerCase(),
        contextLabel: scanContext?.label ?? null,
        queuedAt: new Date().toISOString(),
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
          <Text style={styles.resourceTitle}>Scan</Text>
          <Text style={styles.resourceSubtitle}>
            {scanPolicyQuery.isLoading
              ? "Loading policy..."
              : scanPolicyUnavailable
                ? "Policy unavailable"
                : scanEnabled
                  ? "Ready"
                  : "Disabled by policy"}
          </Text>
        </View>
        <Pressable
          onPress={onSync}
          disabled={syncing}
          style={({ pressed }) => [
            styles.syncNowButton,
            syncing && styles.syncButtonDisabled,
            pressed && styles.syncButtonPressed,
          ]}
        >
          <Text style={styles.syncButtonText}>{syncing ? "Syncing..." : "Sync now"}</Text>
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
              Reference: {scanContext.reference}
            </Text>
          ) : null}
          {scanContext.routeRunId ? (
            <Text style={[styles.noticeSubtext, { marginTop: 4 }]}>
              Route run binding: {scanContext.routeRunId}
            </Text>
          ) : null}
          <Text style={[styles.noticeSubtext, { marginTop: 4 }]}>
            {scanContext.routeStopId ? "Route stop" : "Task"} binding: {scanContext.routeStopId ?? scanContext.taskId ?? "task only"}
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
              disabled={drivingModeLocked || isUpdatingScanMode}
              style={({ pressed }) => [
                styles.chip,
                effectiveScanInputMode === mode && styles.navItemSelected,
                (drivingModeLocked || isUpdatingScanMode) && styles.syncButtonDisabled,
                pressed && styles.navItemPressed,
              ]}
            >
              <Text style={styles.chipText}>{mode === "camera" ? "Camera" : "Scanner"}</Text>
            </Pressable>
          ))}
        </View>
        <Text style={[styles.noticeSubtext, { marginTop: 8 }]}>
          Effective platform: {effectivePlatform}
        </Text>
        {drivingModeLocked ? (
          <Text style={[styles.noticeSubtext, { marginTop: 6 }]}>
            Driving lock is active. Stop moving to scan.
          </Text>
        ) : null}
      </View>

      <TextInput
        style={styles.input}
        value={scanType}
        placeholder="Scan type"
        autoCapitalize="none"
        onChangeText={setScanType}
      />

      {acceptedScanTypes.length ? (
        <ScrollView horizontal contentContainerStyle={styles.chipRow}>
          {acceptedScanTypes.slice(0, 12).map((candidate) => (
            <Pressable
              key={candidate}
              onPress={() => setScanType(candidate)}
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
        style={styles.input}
        value={barcode}
        placeholder={
          drivingModeLocked
            ? "Stop to scan (Driving mode)"
            : effectiveScanInputMode === "scanner"
              ? "Scan barcode (scanner mode)"
              : "Barcode"
        }
        autoCapitalize="none"
        onChangeText={setBarcode}
        editable={!drivingModeLocked}
      />

      <View style={styles.screenActionsRow}>
        <Pressable
          accessibilityRole="button"
          testID="mobile-scan-toggle-camera"
          onPress={() => setCameraOpen((open) => !open)}
          disabled={!canOpenCamera}
          style={({ pressed }) => [
            styles.secondaryButton,
            !canOpenCamera && styles.primaryButtonDisabled,
            pressed && styles.navItemPressed,
          ]}
        >
          <Text style={styles.secondaryButtonText}>
            {effectiveScanInputMode !== "camera"
              ? "Camera unavailable"
              : cameraOpen
                ? "Close camera"
                : "Open camera"}
          </Text>
        </Pressable>
        <Pressable
          accessibilityRole="button"
          testID="mobile-scan-queue"
          onPress={() => {
            void queueScan();
          }}
          disabled={!canQueue}
          style={({ pressed }) => [
            styles.primaryButton,
            !canQueue && styles.primaryButtonDisabled,
            pressed && canQueue && styles.primaryButtonPressed,
          ]}
        >
          <Text style={styles.primaryButtonText}>
            {isQueueingScan ? "Queueing..." : "Queue scan"}
          </Text>
        </Pressable>
      </View>

      {cameraOpen && effectiveScanInputMode === "camera" ? (
        <View style={styles.cameraFrame}>
          {permission?.granted ? (
            <CameraView
              style={styles.camera}
              onBarcodeScanned={onBarcodeScanned}
              barcodeScannerSettings={{ barcodeTypes: ["qr", "code128", "ean13", "ean8", "upc_a", "upc_e"] }}
            />
          ) : (
            <View style={styles.noticeCard}>
              <Text style={styles.noticeText}>Camera permission required.</Text>
              <Text style={styles.noticeSubtext}>
                {permission?.canAskAgain === false
                  ? "Camera permission was denied. Open settings to grant camera access."
                  : "Grant camera access to scan barcodes."}
              </Text>
              <Pressable
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
                  {permission?.canAskAgain === false ? "Open settings" : "Grant permission"}
                </Text>
              </Pressable>
            </View>
          )}
        </View>
      ) : null}

      {lastQueuedScan ? (
        <View style={styles.noticeCard}>
          <Text style={styles.noticeText}>Last queued scan</Text>
          <Text style={styles.noticeSubtext}>
            {online ? "Queued and ready to sync" : "Queued offline for retry"}
          </Text>
          <Text style={[styles.noticeSubtext, { marginTop: 4 }]}>
            {lastQueuedScan.scanType} - {lastQueuedScan.barcode}
          </Text>
          {lastQueuedScan.contextLabel ? (
            <Text style={[styles.noticeSubtext, { marginTop: 4 }]}>
              Context: {lastQueuedScan.contextLabel}
            </Text>
          ) : null}
          <Text style={[styles.mono, { textAlign: "left", marginTop: 8 }]}>
            queue_id:{lastQueuedScan.id}
          </Text>
        </View>
      ) : null}

      {diagnosticsEnabled ? (
        <View style={styles.noticeCard}>
          <Text style={styles.noticeText}>Policy context</Text>
          <Text style={styles.noticeSubtext}>
            scan_input_mode: {effectiveScanInputMode}
          </Text>
          <Text style={styles.mono}>{stableStringify(policyContext)}</Text>
        </View>
      ) : null}
    </ScrollView>
  );
}

function LocationScreen({
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
  const queryClient = useQueryClient();
  const [position, setPosition] = React.useState<Location.LocationObject | null>(null);
  const [status, setStatus] = React.useState<"idle" | "loading">("idle");
  const captureLocationRef = React.useRef(false);
  const [backgroundSyncing, setBackgroundSyncing] = React.useState(false);
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
    () => normalizeMobileLocationTrackingPolicy((trackingPolicyQuery.data as any)?.value ?? null),
    [trackingPolicyQuery.data]
  );
  const trackingEnabled = locationPolicy.enabled;
  const backgroundPolicyEnabled = trackingEnabled && locationPolicy.backgroundEnabled;

  React.useEffect(() => {
    let cancelled = false;

    if (Platform.OS === "web") {
      setBackgroundTracking({
        running: false,
        reason: "disabled_by_policy_or_device",
      });
      setBackgroundSyncing(false);
      return () => {
        cancelled = true;
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
      const { status: permissionStatus } = await Location.getForegroundPermissionsAsync();
      if (permissionStatus !== "granted") {
        const req = await Location.requestForegroundPermissionsAsync();
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
            metadata: {
              app: "fieldops",
              source: "mobile",
              ...(attestation ? { attestation } : {}),
            },
          },
        },
      });

      queryClient.invalidateQueries({ queryKey: ["outbox", "count"] });
      queryClient.invalidateQueries({ queryKey: ["outbox", "entries"] });

      if (online && !syncing) onSync();
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
                  ? "Ready"
                  : "Disabled by policy"}
          </Text>
        </View>
        <Pressable
          onPress={onSync}
          disabled={syncing}
          style={({ pressed }) => [
            styles.syncNowButton,
            syncing && styles.syncButtonDisabled,
            pressed && styles.syncButtonPressed,
          ]}
        >
          <Text style={styles.syncButtonText}>{syncing ? "Syncing..." : "Sync now"}</Text>
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
          Outbox-driven updates via task manager.
        </Text>
      </View>

      <View style={styles.noticeCard}>
        <Text style={styles.noticeText}>Latest capture</Text>
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
          disabled={!canQueuePing}
          style={({ pressed }) => [
            styles.primaryButton,
            !canQueuePing && styles.primaryButtonDisabled,
            pressed && canQueuePing && styles.primaryButtonPressed,
          ]}
        >
          <Text style={styles.primaryButtonText}>
            {isQueueingPing ? "Queueing..." : "Queue ping"}
          </Text>
        </Pressable>
      </View>

      {diagnosticsEnabled ? (
        <View style={styles.noticeCard}>
          <Text style={styles.noticeText}>Policy context</Text>
          <Text style={styles.mono}>{stableStringify(policyContext)}</Text>
        </View>
      ) : null}
    </ScrollView>
  );
}

function MoreScreen({
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
          <Text style={styles.resourceTitle}>More</Text>
          <Text style={styles.resourceSubtitle}>Policy-driven shell controls</Text>
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
            testID="mobile-sign-out"
            onPress={onSignOut}
            style={({ pressed }) => [styles.secondaryButton, pressed && styles.navItemPressed]}
          >
            <Text style={styles.secondaryButtonText}>Sign out</Text>
          </Pressable>
          <Pressable
            accessibilityRole="button"
            testID="mobile-open-settings"
            onPress={() => {
              void openSystemSettingsSafe();
            }}
            style={({ pressed }) => [styles.secondaryButton, pressed && styles.navItemPressed]}
          >
            <Text style={styles.secondaryButtonText}>Open settings</Text>
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
            testID="mobile-open-diagnostics"
            onPress={() => onOpenModule("diagnostics")}
            style={({ pressed }) => [styles.secondaryButton, pressed && styles.navItemPressed]}
          >
            <Text style={styles.secondaryButtonText}>Open diagnostics</Text>
          </Pressable>
        </View>
      </View>

      <View style={styles.noticeCard}>
        <Text style={styles.noticeText}>Driver shift</Text>
        <Text style={styles.noticeSubtext}>
          {activeDriverShift
            ? `Shift active${activeDriverShift.openedAt ? ` since ${activeDriverShift.openedAt}` : ""}`
            : "No active driver shift on this device."}
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
              {isMutatingDriverShift && !activeDriverShift ? "Starting..." : "Start shift"}
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
              {isMutatingDriverShift && activeDriverShift ? "Ending..." : "End shift"}
            </Text>
          </Pressable>
        </View>
      </View>

      <View style={styles.noticeCard}>
        <Text style={styles.noticeText}>Display preferences</Text>
        <Text style={styles.noticeSubtext}>
          Locale {selectedLocaleMode.toUpperCase()} - Direction {selectedDirectionMode.toUpperCase()} -
          Theme {selectedThemeMode}
        </Text>
        <Text style={[styles.noticeSubtext, { marginTop: 8 }]}>Locale</Text>
        <View style={styles.screenActionsRow}>
          {(["en", "ar"] as const).map((localeMode) => (
            <Pressable
              key={localeMode}
              onPress={() =>
                void withPreferenceAction(() => onSetLocaleMode(localeMode))
              }
              disabled={isApplyingSettings}
              style={({ pressed }) => [
                styles.chip,
                selectedLocaleMode === localeMode && styles.navItemSelected,
                isApplyingSettings && styles.primaryButtonDisabled,
                pressed && styles.navItemPressed,
              ]}
            >
              <Text style={styles.chipText}>{localeMode === "en" ? "English" : "Arabic"}</Text>
            </Pressable>
          ))}
        </View>
        <Text style={[styles.noticeSubtext, { marginTop: 8 }]}>Direction</Text>
        <View style={styles.screenActionsRow}>
          {(["ltr", "rtl"] as const).map((directionMode) => (
            <Pressable
              key={directionMode}
              onPress={() =>
                void withPreferenceAction(() => onSetDirectionMode(directionMode))
              }
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
        <Text style={[styles.noticeSubtext, { marginTop: 8 }]}>Theme</Text>
        <View style={styles.screenActionsRow}>
          {(["system", "light", "dark"] as const).map((themeMode) => (
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
                  ? "System"
                  : themeMode.charAt(0).toUpperCase() + themeMode.slice(1)}
              </Text>
            </Pressable>
          ))}
        </View>
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
        <Text style={styles.noticeText}>Route view</Text>
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
              <Text style={styles.chipText}>{formatRouteViewLabel(mode)}</Text>
            </Pressable>
          ))}
        </View>
        <Text style={styles.noticeSubtext}>
          Clustering: {mapPolicy.clusteringEnabled ? "enabled" : "disabled"} (grid {mapPolicy.clusteringGridPx}px, min {mapPolicy.clusteringMinCount})
        </Text>
      </View>

      <View style={styles.noticeCard}>
        <Text style={styles.noticeText}>Diagnostics</Text>
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
        <Text style={styles.noticeText}>Connectivity and outbox</Text>
        <Text style={styles.noticeSubtext}>
          Network: {formatConnectivityStatusLabel(connectivityStatus).toLowerCase()}
        </Text>
        <Text style={styles.noticeSubtext}>{connectivitySummary}</Text>
        <Text style={styles.noticeSubtext}>
          Pending actions: {outboxCount}
        </Text>
        <View style={[styles.screenActionsRow, { marginTop: 8 }]}>
          <Pressable
            onPress={onSync}
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
              {syncing ? "Syncing..." : "Sync now"}
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
              outboxPreviewQuery.data.map((entry) => (
                <Text key={entry.id} style={styles.mono}>
                  {entry.status} - {entry.rpc}
                </Text>
              ))
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
  const queryClient = useQueryClient();
  const [busy, setBusy] = React.useState(false);
  const diagnosticActionRef = React.useRef(false);

  const policyValue = (policyRow as any)?.value ?? null;
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
      Alert.alert("Diagnostics action failed", "Please retry this operation.");
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
    Alert.alert("Clear local data?", "This signs you out and removes local data from this device.", [
      { text: "Cancel", style: "cancel" },
      {
        text: "Clear",
        style: "destructive",
        onPress: () => {
          void withDiagnosticsAction(async () => {
            await onClearLocal();
            queryClient.invalidateQueries();
          });
        },
      },
    ]);
  };

  return (
    <ScrollView contentContainerStyle={styles.screen}>
      <View style={styles.screenHeader}>
        <View style={styles.screenHeaderText}>
          <Text style={styles.resourceTitle}>Diagnostics</Text>
          <Text style={styles.resourceSubtitle}>
            {policyEnabled ? "Policy enabled" : "Disabled by policy"} -{" "}
            {formatConnectivityStatusLabel(connectivityStatus).toLowerCase()}
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
          <View style={styles.noticeCard}>
            <Text style={styles.noticeText}>Diagnostics policy row</Text>
            <Text style={styles.mono} numberOfLines={10}>
              {stableStringify(policyRow)}
            </Text>
          </View>
          <View style={styles.noticeCard}>
            <Text style={styles.noticeText}>Local keys</Text>
            <Text style={styles.mono}>
              secure:{STORAGE_KEYS.deviceId},{STORAGE_KEYS.deviceInstallId},{STORAGE_KEYS.attestationKeyId} -
              kv:{KV_KEYS.diagnosticsEnabled},{KV_KEYS.routeView},{KV_KEYS.scanInputMode},
              {KV_KEYS.platformOverride},{KV_KEYS.simulatedOffline},{KV_KEYS.simulatedSpeedKph},
              {KV_KEYS.localeMode},{KV_KEYS.directionMode},{KV_KEYS.themeMode}
            </Text>
          </View>
        </>
      ) : null}
    </ScrollView>
  );
}

function RouteSurfaceDetailExtensions({
  detail,
  resourceId,
  surfaceLabel,
  diagnosticsEnabled,
  interactionLocked,
  addressPolicy,
  communicationPolicy,
  navigationPolicy,
  platform,
  routeExecutionManifest,
  isConfirmingRouteDeparture,
  onEnqueueUiEvents,
  onOpenScan,
  onOpenRouteScan,
  onConfirmRouteDeparture,
}: {
  detail: Record<string, unknown>;
  resourceId: string | null;
  surfaceLabel: string;
  diagnosticsEnabled: boolean;
  interactionLocked: boolean;
  addressPolicy: MobileAddressPolicy;
  communicationPolicy: MobileCommunicationPolicy;
  navigationPolicy: MobileNavigationPolicy;
  platform: "android" | "ios" | "scanner";
  routeExecutionManifest: Record<string, unknown> | null | undefined;
  isConfirmingRouteDeparture: boolean;
  onEnqueueUiEvents: (events: Array<Record<string, unknown>>) => Promise<void>;
  onOpenScan: () => void;
  onOpenRouteScan: () => void;
  onConfirmRouteDeparture: () => void;
}) {
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
  const routeManifest = React.useMemo(() => asRecord(routeExecutionManifest), [routeExecutionManifest]);
  const scanOut = React.useMemo(() => asRecord(routeManifest.scan_out), [routeManifest]);
  const routeDeparture = React.useMemo(() => asRecord(routeManifest.route_departure), [routeManifest]);
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
          Alert.alert("Driving mode locked", "Stop moving before running route actions.");
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
    [interactionLocked, onEnqueueUiEvents, platform, withRouteActionLock]
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
  const allowedMethodsLabel = stop.allowedMethods.length
    ? stop.allowedMethods.map((method) => formatKeyLabel(method)).join(", ")
    : null;
  const showPaymentCollectionCard = Boolean(
    expectedCodLabel || stop.paymentModeLabel || allowedMethodsLabel
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
          <Text style={[styles.noticeSubtext, { marginTop: 4 }]}>Reference: {stop.reference}</Text>
        ) : null}
        {stop.addressSummary ? (
          <Text style={[styles.noticeSubtext, { marginTop: 4 }]}>{stop.addressSummary}</Text>
        ) : (
          <Text style={[styles.noticeSubtext, styles.error, { marginTop: 4 }]}>
            Address incomplete
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
          <Text style={[styles.noticeSubtext, { marginTop: 8 }]}>No stop instructions</Text>
        )}
      </View>

      {routeContext.routeRunId ? (
        <View style={[styles.noticeCard, { marginTop: 12 }]}>
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
          <View style={[styles.screenActionsRow, { marginTop: 10 }]}>
            <Pressable
              onPress={onOpenRouteScan}
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
              disabled={
                interactionLocked ||
                isExecutingRouteAction ||
                isConfirmingRouteDeparture ||
                !isRouteDepartureReady ||
                Boolean(routeDepartureConfirmedAt)
              }
              style={({ pressed }) => [
                styles.actionButton,
                (interactionLocked ||
                  isExecutingRouteAction ||
                  isConfirmingRouteDeparture ||
                  !isRouteDepartureReady ||
                  Boolean(routeDepartureConfirmedAt)) &&
                  styles.syncButtonDisabled,
                pressed && styles.navItemPressed,
              ]}
            >
              <Text style={styles.actionButtonText}>
                {routeDepartureConfirmedAt
                  ? "Departure confirmed"
                  : isConfirmingRouteDeparture
                    ? "Confirming..."
                    : "Confirm departure"}
              </Text>
            </Pressable>
          </View>
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
        <Text style={styles.noticeText}>Contact and actions</Text>
        <Text style={styles.noticeSubtext}>
          Recipient: {customerName || "No recipient details"}
        </Text>
        <Text style={[styles.noticeSubtext, { marginTop: 4 }]}>
          Phone: {phone ?? "No phone on file"}
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
            disabled={interactionLocked || isExecutingRouteAction}
            style={({ pressed }) => [
              styles.actionButton,
              (interactionLocked || isExecutingRouteAction) && styles.syncButtonDisabled,
              pressed && styles.navItemPressed,
            ]}
          >
            <Text style={styles.actionButtonText}>Navigate</Text>
          </Pressable>
          <Pressable
            onPress={onOpenScan}
            disabled={interactionLocked || isExecutingRouteAction || !resourceId}
            style={({ pressed }) => [
              styles.actionButton,
              (interactionLocked || isExecutingRouteAction || !resourceId) &&
                styles.syncButtonDisabled,
              pressed && styles.navItemPressed,
            ]}
          >
            <Text style={styles.actionButtonText}>Scan parcel</Text>
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
                disabled={disabled}
                style={({ pressed }) => [
                  styles.actionButton,
                  disabled && styles.syncButtonDisabled,
                  pressed && styles.navItemPressed,
                ]}
              >
                <Text style={styles.actionButtonText}>{formatKeyLabel(channel)}</Text>
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
                    {contact.phone ?? "No phone on file"}
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
                        disabled={disabled}
                        style={({ pressed }) => [
                          styles.chip,
                          disabled && styles.syncButtonDisabled,
                          pressed && styles.navItemPressed,
                        ]}
                      >
                        <Text style={styles.chipText}>{formatKeyLabel(channel)}</Text>
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
        <Text style={styles.noticeText}>Address</Text>
        <Text style={styles.noticeSubtext}>
          {stop.fullAddress ?? "Address incomplete"}
        </Text>
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
            Accuracy: +/-{Math.round(coordinates.accuracyM)}m
          </Text>
        ) : null}
        {stop.recipientMissing ? (
          <Text style={[styles.noticeSubtext, { marginTop: 8 }]}>No recipient details</Text>
        ) : null}
        {diagnosticsEnabled ? (
          <Text style={[styles.mono, { textAlign: "left", marginTop: 8 }]}>
            contact:{customerName || "-"} - phone:{phone ?? "-"} - route_run:{routeContext.routeRunId ?? "-"}
          </Text>
        ) : null}
      </View>
    </>
  );
}

function SettlementSurfaceDetailExtensions({
  detail,
  fallbackId,
  diagnosticsEnabled,
  interactionLocked,
  uxSafetyPolicy,
  onSubmitCount,
}: {
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
      Alert.alert("Driving mode locked", "Stop moving before submitting counts.");
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
        Alert.alert("Queued", "Settlement count was queued for sync.");
      })
      .catch((error) => {
        logDebugFailure("failed to queue settlement count", error);
        Alert.alert("Queue failed", "Unable to queue settlement count.");
      })
      .finally(() => {
        isSubmittingCountRef.current = false;
        setIsSubmittingCount(false);
      });
  }, [
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
  const mode = displayMode ?? "list";
  const toNumber = (value: unknown): number | null => {
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value !== "string") return null;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  };
  const getCoordinates = (item: Record<string, unknown>) => {
    const extracted = extractCoordinates(item);
    if (extracted) {
      return {
        latitude: extracted.latitude,
        longitude: extracted.longitude,
      };
    }
    const latitude =
      toNumber(item.latitude) ??
      toNumber(item.lat) ??
      toNumber(item.destination_latitude) ??
      toNumber(item.pickup_latitude);
    const longitude =
      toNumber(item.longitude) ??
      toNumber(item.lng) ??
      toNumber(item.destination_longitude) ??
      toNumber(item.pickup_longitude);
    if (latitude == null || longitude == null) return null;
    return { latitude, longitude };
  };
  const openItem = React.useCallback(
    (item: Record<string, unknown>) => {
      if (interactionLocked) {
        Alert.alert("Driving mode locked", "Stop moving to open item details.");
        return;
      }
      onSelectItem?.(item);
    },
    [interactionLocked, onSelectItem]
  );
  const mapItems = React.useMemo(() => {
    if (mode !== "orders_map" || surfaceKind === "route") return [];
    return list.items
      .map((item) => ({ item, coords: getCoordinates(item) }))
      .filter((entry) => entry.coords != null) as Array<{
      item: Record<string, unknown>;
      coords: { latitude: number; longitude: number };
    }>;
  }, [list.items, mode, surfaceKind]);
  const routeMapEntries = React.useMemo(() => {
    if (mode !== "orders_map" || surfaceKind !== "route") return [];
    return list.items
      .map((item, index) => {
        const coords = getCoordinates(item);
        if (!coords) return null;
        const route = extractRouteCardSnapshot(item);
        const id = pickResourceId(item, list.keys) ?? `route-${index + 1}`;
        return {
          id,
          item,
          coords,
          title: formatOperationalTitle({
            title: route.title,
            customerName: route.customerName,
            reference: route.reference,
          }),
          route,
        };
      })
      .filter(
        (
          entry
        ): entry is {
          id: string;
          item: Record<string, unknown>;
          coords: { latitude: number; longitude: number };
          title: string;
          route: ReturnType<typeof extractRouteCardSnapshot>;
        } => Boolean(entry)
      );
  }, [list.items, list.keys, mode, surfaceKind]);
  const routeMapModel = React.useMemo(() => {
    if (!mapPolicy || mode !== "orders_map" || surfaceKind !== "route") return null;
    return buildRouteMapModel(
      routeMapEntries.map((entry) => ({
        id: entry.id,
        latitude: entry.coords.latitude,
        longitude: entry.coords.longitude,
        status: entry.route.status,
      })),
      mapPolicy
    );
  }, [mapPolicy, mode, routeMapEntries, surfaceKind]);
  const routeMapById = React.useMemo(
    () => new Map(routeMapEntries.map((entry) => [entry.id, entry])),
    [routeMapEntries]
  );
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
          {list.total ?? list.items.length} items {source === "cache" ? "(cached)" : ""}
        </Text>
      </View>
      {mode === "orders_map" && !hasListItems ? (
        <View style={styles.noticeCard}>
          <Text style={styles.noticeSubtext}>No items available.</Text>
        </View>
      ) : null}
      {mode === "orders_map" ? (
        <ScrollView contentContainerStyle={styles.list}>
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
                    <Text style={styles.chipText}>{routeMapEntries.length} stops</Text>
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

              {routeMapModel?.mappableCount ? (
                <View style={styles.routeMapBoard}>
                  {routeMapModel.clusters.map((cluster) => (
                    <Pressable
                      key={cluster.key}
                      onPress={() => setFocusedClusterKey(cluster.key)}
                      style={({ pressed }) => [
                        styles.routeMapCluster,
                        { left: `${cluster.xPct}%`, top: `${cluster.yPct}%` },
                        focusedClusterKey === cluster.key && styles.routeMapClusterFocused,
                        pressed && styles.navItemPressed,
                      ]}
                    >
                      <Text style={styles.routeMapClusterText}>{cluster.count}</Text>
                    </Pressable>
                  ))}
                  {routeMapModel.pins.map((pin) => {
                    const entry = routeMapById.get(pin.id);
                    if (!entry) return null;
                    const toneStyle =
                      pin.tone === "done"
                        ? styles.routeMapPinDone
                        : pin.tone === "issue"
                          ? styles.routeMapPinIssue
                          : pin.tone === "active"
                            ? styles.routeMapPinActive
                            : styles.routeMapPinNeutral;
                    const label =
                      entry.route.sequence != null ? String(entry.route.sequence) : "\u2022";
                    return (
                      <Pressable
                        key={pin.id}
                        onPress={() => openItem(entry.item)}
                        style={({ pressed }) => [
                          styles.routeMapPin,
                          toneStyle,
                          { left: `${pin.xPct}%`, top: `${pin.yPct}%` },
                          pressed && styles.navItemPressed,
                        ]}
                      >
                        <Text style={styles.routeMapPinText}>{label}</Text>
                      </Pressable>
                    );
                  })}
                  {interactionLocked ? (
                    <View style={styles.routeMapLockOverlay}>
                      <Text style={styles.routeMapLockText}>Driving mode lock active</Text>
                    </View>
                  ) : null}
                </View>
              ) : null}

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
                    ? `${mapItems.length} items with coordinates`
                    : "No coordinate fields available. Falling back to list-style cards."}
                </Text>
              </View>
              {mapItems.length > 0
                ? mapItems.map(({ item, coords }, index) => (
                    <Pressable
                      key={`${list.resource}-map-${index}`}
                      onPress={() => openItem(item)}
                      style={({ pressed }) => [styles.card, pressed && styles.navItemPressed]}
                    >
                      <Text style={styles.cardTitle}>{formatResourceItemTitle(item, list.keys)}</Text>
                      <Text style={styles.cardSubtitle}>
                        lat {coords.latitude.toFixed(6)} - lng {coords.longitude.toFixed(6)}
                      </Text>
                    </Pressable>
                  ))
                : list.items.map((item, index) => (
                    <Pressable
                      key={`${list.resource}-fallback-${index}`}
                      onPress={() => openItem(item)}
                      style={({ pressed }) => [styles.card, pressed && styles.navItemPressed]}
                    >
                      <Text style={styles.cardTitle}>{formatResourceItemTitle(item, list.keys)}</Text>
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
          ListEmptyComponent={<Text style={styles.subtitle}>No items available.</Text>}
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
    <MobileErrorBoundary
      fallback={({ retry }) => (
        <View style={styles.container} accessibilityRole="alert" testID="mobile-error-boundary">
          <Text style={styles.title}>Something went wrong</Text>
          <Text style={styles.subtitle}>Please restart the app and try again.</Text>
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
  );
}

const FIELDOPS_TOKENS = {
  color: {
    pageBg: "#eef2f7",
    cardBg: "#ffffff",
    border: "#d6dde8",
    borderMuted: "#e3e8f0",
    text: "#0f172a",
    textMuted: "#4b5563",
    accent: "#0e7490",
    accentSoft: "#e0f2fe",
    success: "#16a34a",
    successSoft: "#eaf7ef",
    warning: "#ca8a04",
    warningSoft: "#fff7db",
    danger: "#b91c1c",
    dangerSoft: "#fee2e2",
  },
  radius: {
    sm: 10,
    md: 14,
    lg: 18,
    pill: 999,
  },
  font: {
    sans: Platform.select({
      web: '"IBM Plex Sans", "Segoe UI", sans-serif',
      default: undefined,
    }),
    mono: Platform.select({
      web: '"IBM Plex Mono", ui-monospace, SFMono-Regular, Menlo, monospace',
      default: "monospace",
    }),
  },
} as const;

const styles = StyleSheet.create({
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
    backgroundColor: "#eceff5",
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
    borderColor: "#d6dbe6",
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
    borderColor: "#e5e5e5",
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "#fff",
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
    borderColor: "#9dd6b5",
    backgroundColor: FIELDOPS_TOKENS.color.successSoft,
  },
  headerPillRowDegraded: {
    borderColor: "#f7d26e",
    backgroundColor: FIELDOPS_TOKENS.color.warningSoft,
  },
  headerPillRowOffline: {
    borderColor: "#f4a6a6",
    backgroundColor: FIELDOPS_TOKENS.color.dangerSoft,
  },
  headerPillDot: { width: 6, height: 6, borderRadius: 999 },
  headerPillDotOnline: { backgroundColor: FIELDOPS_TOKENS.color.success },
  headerPillDotDegraded: { backgroundColor: FIELDOPS_TOKENS.color.warning },
  headerPillDotOffline: { backgroundColor: FIELDOPS_TOKENS.color.danger },
  headerPillWarning: {
    backgroundColor: "#fff3cd",
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
    borderColor: "#f4a6a6",
    backgroundColor: FIELDOPS_TOKENS.color.dangerSoft,
  },
  connectivityBannerDegraded: {
    borderColor: "#f7d26e",
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
    borderColor: "#e5e5e5",
    backgroundColor: "#fff",
    alignItems: "center",
    justifyContent: "center",
  },
  avatarPressed: { opacity: 0.8 },
  avatarText: { fontSize: 12, fontWeight: "700" },
  syncButton: {
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: "#e5e5e5",
    backgroundColor: "#fff",
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
  },
  content: {
    flexGrow: 1,
    padding: 16,
  },
  drawerBackdrop: { flex: 1, flexDirection: "row", backgroundColor: "rgba(0,0,0,0.25)" },
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
    backgroundColor: "rgba(0,0,0,0.25)",
  },
  drawerHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingBottom: 10,
    borderBottomWidth: 1,
    borderBottomColor: "#f0f0f0",
    marginBottom: 12,
  },
  drawerTitle: {
    fontSize: 16,
    fontWeight: "700",
    color: FIELDOPS_TOKENS.color.text,
    fontFamily: FIELDOPS_TOKENS.font.sans,
  },
  drawerClose: {
    width: 34,
    height: 34,
    borderRadius: 17,
    borderWidth: 1,
    borderColor: "#e5e5e5",
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "#fff",
  },
  drawerClosePressed: { opacity: 0.8 },
  drawerCloseText: { fontSize: 18, fontWeight: "600", lineHeight: 19, color: "#4b5563" },
  drawerContent: { paddingTop: 12, paddingBottom: 10 },
  navModalBackdrop: { flex: 1, justifyContent: "flex-end", backgroundColor: "rgba(0,0,0,0.25)" },
  navModalWebOverlay: {
    ...StyleSheet.absoluteFillObject,
    justifyContent: "flex-end",
    backgroundColor: "rgba(0,0,0,0.25)",
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
    borderBottomColor: "#f0f0f0",
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
    borderColor: "#e5e5e5",
  },
  navClosePressed: { opacity: 0.8 },
  navCloseText: { fontSize: 12, fontWeight: "600" },
  navModalContent: { paddingTop: 12 },
  section: { marginBottom: 20 },
  sectionTitle: { fontSize: 14, fontWeight: "600", marginBottom: 10 },
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
  navItemLabel: { fontSize: 14, fontWeight: "500" },
  navItemBadge: {
    fontSize: 12,
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 999,
    backgroundColor: "#e9eefc",
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
    borderColor: "#f2b84b",
    backgroundColor: "#fff9e8",
    borderRadius: 12,
    padding: 12,
    marginBottom: 12,
  },
  drivingLockTitle: {
    fontSize: 13,
    fontWeight: "800",
    color: "#7a4b00",
    marginBottom: 4,
  },
  drivingLockText: {
    fontSize: 12,
    color: "#7a4b00",
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
    borderColor: "#dbeafe",
    backgroundColor: "#eef6ff",
  },
  routeStatusBadgeActive: {
    borderColor: "#99f6e4",
    backgroundColor: "#ecfeff",
  },
  routeStatusBadgeDone: {
    borderColor: "#bbf7d0",
    backgroundColor: "#f0fdf4",
  },
  routeStatusBadgeText: { fontSize: 11, fontWeight: "700", color: "#0f172a" },
  syncNowButton: {
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: "#e5e5e5",
  },
  listPane: { flex: 1 },
  list: { paddingBottom: 24 },
  listWrapper: { flex: 1 },
  routeMapBoard: {
    height: 260,
    borderWidth: 1,
    borderColor: "#d7deef",
    borderRadius: 14,
    backgroundColor: "#f7faff",
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
    backgroundColor: "rgba(255,255,255,0.78)",
    justifyContent: "center",
    alignItems: "center",
  },
  routeMapLockText: {
    color: "#7a4b00",
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
  },
  card: {
    borderWidth: 1,
    borderColor: FIELDOPS_TOKENS.color.border,
    borderRadius: FIELDOPS_TOKENS.radius.md,
    padding: 14,
    marginBottom: 12,
    backgroundColor: FIELDOPS_TOKENS.color.cardBg,
  },
  cardTitle: { fontSize: 14, fontWeight: "600", marginBottom: 6 },
  cardSubtitle: { fontSize: 12, opacity: 0.75 },
  cardChips: { flexDirection: "row", flexWrap: "wrap", gap: 6, marginTop: 10 },
  chip: {
    paddingHorizontal: 10,
    paddingVertical: 8,
    borderRadius: FIELDOPS_TOKENS.radius.pill,
    backgroundColor: "#eef2f7",
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
    borderColor: "#e5e5e5",
  },
  detailHeaderText: { flex: 1 },
  detailTitle: { fontSize: 16, fontWeight: "700" },
  detailSubtitle: { fontSize: 12, opacity: 0.7, marginTop: 2 },
  detailContent: { paddingBottom: 24 },
  detailRow: {
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: "#f0f0f0",
  },
  detailKey: { fontSize: 12, fontWeight: "600", marginBottom: 4 },
  detailValue: { fontSize: 13, opacity: 0.85 },
  actionsBar: {
    borderTopWidth: 1,
    borderTopColor: "#f0f0f0",
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
    color: "#b00020",
    marginBottom: 8,
  },
  subtitle: {
    fontSize: 14,
    opacity: 0.8,
    textAlign: "center",
    marginBottom: 12,
  },
  mono: {
    fontSize: 12,
    fontFamily: FIELDOPS_TOKENS.font.mono,
    opacity: 0.7,
    textAlign: "center",
  },
  methodRow: { flexDirection: "row", gap: 10, marginTop: 18 },
  methodChip: {
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: "#e5e5e5",
    backgroundColor: "#fff",
  },
  methodChipActive: {
    borderColor: "#2b6cb0",
    backgroundColor: "#f0f7ff",
  },
  methodChipText: { fontSize: 12, fontWeight: "700" },
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
    color: "#fff",
    fontSize: 14,
    fontWeight: "800",
    textAlign: "center",
    fontFamily: FIELDOPS_TOKENS.font.sans,
  },
  authError: { marginTop: 10, color: "#b00020", fontSize: 12, textAlign: "center" },
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
    borderColor: "#e5e5e5",
    overflow: "hidden",
    backgroundColor: "#000",
  },
  camera: { flex: 1 },
  signatureCanvas: {
    height: 160,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: "#d5d9e5",
    backgroundColor: "#fff",
    overflow: "hidden",
    position: "relative",
    justifyContent: "center",
    alignItems: "center",
  },
  signaturePlaceholder: {
    fontSize: 13,
    color: "#64748b",
    fontFamily: FIELDOPS_TOKENS.font.sans,
  },
  signatureStroke: {
    position: "absolute",
    height: 2.5,
    backgroundColor: "#0f172a",
    borderRadius: 999,
  },
});


