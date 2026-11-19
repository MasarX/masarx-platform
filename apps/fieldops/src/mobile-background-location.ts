import Constants from "expo-constants";
import * as Location from "expo-location";
import * as TaskManager from "expo-task-manager";
import { Platform } from "react-native";

import { isRetriableNetworkError, isRetriableSupabaseError } from "@masarx/api";
import { createMobileClient, createSupabaseExecutor } from "@masarx/auth/mobile";
import { createOutbox, createOutboxId } from "@masarx/mobile-core";
import { createSqliteOutboxStore, createSqliteKeyValueStore } from "@masarx/mobile-core/sqlite";
import { syncCompletionOutbox, resolveVerifiedCompletionScope } from "./mobile-completion-readback-storage";
import { createRouteDepartureExecutor } from "./mobile-route-departure";

import { addMobileNetworkFailureBreadcrumb } from "./mobile-crash-reporting";
import { logDebugFailure, logMobileRequestTrace } from "./mobile-debug";
import { isJwtPrivilegedRole, resolveJwtRole } from "./mobile-jwt";
import { getPublicConfigFromExpo, resolveExpoExtra, type ExpoExtra } from "./mobile-public-config";
import type { MobileLocationAccuracy, MobileLocationTrackingPolicy } from "./mobile-location-policy";
import { createFieldOpsStorage } from "./mobile-storage";

export const FIELDOPS_BACKGROUND_LOCATION_TASK = "fieldops-background-location-v1";

const BACKGROUND_LOCATION_STATE_KEY = "fieldops_background_location_state_v1";

type BackgroundLocationState = {
  deviceId: string | null;
  trackingEnabled: boolean;
  maxAccuracyM: number | null;
};

type SecureStoreModule = {
  getItemAsync: (key: string) => Promise<string | null>;
  setItemAsync: (key: string, value: string) => Promise<void>;
  deleteItemAsync: (key: string) => Promise<void>;
};

export type BackgroundTrackingSyncResult = {
  running: boolean;
  reason:
    | "disabled_by_policy_or_device"
    | "foreground_permission_denied"
    | "background_permission_denied"
    | "started"
    | "updated";
};

let backgroundSecureStorePromise: Promise<SecureStoreModule | null> | null = null;
let backgroundStateBlocked = false;

async function loadBackgroundSecureStore(): Promise<SecureStoreModule | null> {
  if (backgroundSecureStorePromise) return backgroundSecureStorePromise;
  backgroundSecureStorePromise = (async () => {
    try {
      const mod = (await import("expo-secure-store")) as unknown as Partial<SecureStoreModule>;
      if (
        typeof mod.getItemAsync !== "function" ||
        typeof mod.setItemAsync !== "function" ||
        typeof mod.deleteItemAsync !== "function"
      ) {
        return null;
      }
      return mod as SecureStoreModule;
    } catch {
      return null;
    }
  })();
  return backgroundSecureStorePromise;
}

function normalizeDeviceId(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function normalizeMaxAccuracy(value: unknown): number | null {
  if (value == null) return null;
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  const next = Math.floor(value);
  if (next < 0) return null;
  return next;
}

function normalizeState(value: unknown): BackgroundLocationState {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { deviceId: null, trackingEnabled: false, maxAccuracyM: null };
  }
  const input = value as Record<string, unknown>;
  return {
    deviceId: normalizeDeviceId(input.deviceId),
    trackingEnabled: input.trackingEnabled === true,
    maxAccuracyM: normalizeMaxAccuracy(input.maxAccuracyM),
  };
}

async function readBackgroundState(): Promise<BackgroundLocationState> {
  try {
    if (backgroundStateBlocked) {
      return { deviceId: null, trackingEnabled: false, maxAccuracyM: null };
    }
    const secureStore = await loadBackgroundSecureStore();
    if (!secureStore) {
      backgroundStateBlocked = true;
      return { deviceId: null, trackingEnabled: false, maxAccuracyM: null };
    }
    const raw = await secureStore.getItemAsync(BACKGROUND_LOCATION_STATE_KEY);
    if (!raw) return { deviceId: null, trackingEnabled: false, maxAccuracyM: null };
    return normalizeState(JSON.parse(raw));
  } catch (error) {
    backgroundStateBlocked = true;
    logDebugFailure("failed to read background tracking state", error, "fieldops:background-location");
    return { deviceId: null, trackingEnabled: false, maxAccuracyM: null };
  }
}

async function writeBackgroundState(state: BackgroundLocationState): Promise<void> {
  const normalized = normalizeState(state);
  try {
    const secureStore = await loadBackgroundSecureStore();
    if (!secureStore) {
      backgroundStateBlocked = true;
      return;
    }
    await secureStore.setItemAsync(BACKGROUND_LOCATION_STATE_KEY, JSON.stringify(normalized));
    backgroundStateBlocked = false;
  } catch (error) {
    backgroundStateBlocked = true;
    logDebugFailure("failed to persist background tracking state", error, "fieldops:background-location");
  }
}

function resolveLocationAccuracy(value: MobileLocationAccuracy): Location.Accuracy {
  if (value === "lowest") return Location.Accuracy.Lowest;
  if (value === "low") return Location.Accuracy.Low;
  if (value === "high") return Location.Accuracy.High;
  if (value === "highest") return Location.Accuracy.Highest;
  return Location.Accuracy.Balanced;
}

const backgroundOutboxStore = createSqliteOutboxStore({
  databaseName: "fieldops.db",
  tableName: "outbox",
});
const backgroundOutbox = createOutbox(backgroundOutboxStore);
const backgroundReadbackStore = createSqliteKeyValueStore({ databaseName: "fieldops.db", tableName: "kv_store" });
let outboxInitPromise: Promise<void> | null = null;

function ensureOutboxInit() {
  if (!outboxInitPromise) {
    outboxInitPromise = backgroundOutbox.init();
  }
  return outboxInitPromise;
}

const backgroundStorage = createFieldOpsStorage();
let backgroundClient: ReturnType<typeof createMobileClient> | null = null;
let backgroundExecutor: ReturnType<typeof createSupabaseExecutor> | null = null;
let backgroundSyncActive = false;
let backgroundSyncLastAt = 0;

const BACKGROUND_SYNC_MIN_INTERVAL_MS = 15_000;
const BACKGROUND_SYNC_LIMIT = 25;

function ensureBackgroundClient() {
  if (Platform.OS === "web") return null;
  if (backgroundClient && backgroundExecutor) {
    return { client: backgroundClient, executor: backgroundExecutor };
  }

  const extra = resolveExpoExtra((Constants.expoConfig?.extra ?? {}) as ExpoExtra);
  let publicConfig: ReturnType<typeof getPublicConfigFromExpo>;
  try {
    publicConfig = getPublicConfigFromExpo(extra);
  } catch (error) {
    logDebugFailure("failed to resolve public config for background sync", error, "fieldops:background-location");
    return null;
  }

  if (isJwtPrivilegedRole(resolveJwtRole(publicConfig.supabaseAnonKey))) {
    logDebugFailure(
      "invalid supabase key for background sync",
      "Configured SUPABASE key is a service role key; background sync disabled.",
      "fieldops:background-location"
    );
    return null;
  }

  backgroundClient = createMobileClient({
    supabaseUrl: publicConfig.supabaseUrl,
    supabaseAnonKey: publicConfig.supabaseAnonKey,
    storage: backgroundStorage,
    onRequestTrace: logMobileRequestTrace,
    onRequestFailure: (context) => {
      addMobileNetworkFailureBreadcrumb(context);
      const { method, url, status, statusText, correlationId, traceparent, error } = context;
      const transportError = error
        ? ` (${error})`
        : ` => ${status ?? "?"} ${statusText ?? ""}`;
      logDebugFailure(
        "background request failed",
        `${method} ${url}${transportError} [x-correlation-id=${correlationId}, traceparent=${traceparent}]`,
        "fieldops:background-location"
      );
    },
  });
  backgroundExecutor = createRouteDepartureExecutor(backgroundClient, createSupabaseExecutor(backgroundClient));
  return { client: backgroundClient, executor: backgroundExecutor };
}

async function syncOutboxInBackground() {
  if (backgroundSyncActive) return;

  const now = Date.now();
  if (backgroundSyncLastAt > 0 && now - backgroundSyncLastAt < BACKGROUND_SYNC_MIN_INTERVAL_MS) {
    return;
  }

  backgroundSyncActive = true;
  try {
    await ensureOutboxInit();
    const deps = ensureBackgroundClient();
    if (!deps) return;

    const session = await deps.client.auth.getSession();
    if (!session.data.session) return;

    const pending = await backgroundOutboxStore.countPending();
    if (pending <= 0) return;

    await syncCompletionOutbox(backgroundOutbox, deps.executor, backgroundReadbackStore, () => resolveVerifiedCompletionScope(deps.client), {
      limit: Math.min(BACKGROUND_SYNC_LIMIT, pending),
      shouldRetry: (error) => isRetriableNetworkError(error) || isRetriableSupabaseError(error),
    });
  } catch (error) {
    logDebugFailure("failed to sync background outbox", error, "fieldops:background-location");
  } finally {
    backgroundSyncLastAt = Date.now();
    backgroundSyncActive = false;
  }
}

if (!TaskManager.isTaskDefined(FIELDOPS_BACKGROUND_LOCATION_TASK)) {
  TaskManager.defineTask(FIELDOPS_BACKGROUND_LOCATION_TASK, async ({ data, error }) => {
    if (error) return;

    const deps = ensureBackgroundClient();
    if (!deps) {
      await stopBackgroundLocationTracking();
      return;
    }

    const session = await deps.client.auth.getSession();
    if (!session.data.session) {
      await stopBackgroundLocationTracking();
      return;
    }

    const state = await readBackgroundState();
    if (!state.trackingEnabled || !state.deviceId) return;

    const locations = (data as { locations?: Location.LocationObject[] } | undefined)?.locations;
    if (!Array.isArray(locations) || locations.length === 0) return;

    await ensureOutboxInit();

    for (const location of locations) {
      const coords = location?.coords;
      if (!coords) continue;

      const accuracy = typeof coords.accuracy === "number" && Number.isFinite(coords.accuracy)
        ? coords.accuracy
        : null;
      if (state.maxAccuracyM != null && accuracy != null && accuracy > state.maxAccuracyM) {
        continue;
      }

      const id = createOutboxId();
      await backgroundOutbox.enqueue({
        id,
        rpc: "record_location_ping_v1",
        args: {
          p_ping: {
            idempotency_key: id,
            device_id: state.deviceId,
            lat: coords.latitude,
            lng: coords.longitude,
            accuracy_m: accuracy,
            speed_mps: typeof coords.speed === "number" ? coords.speed : null,
            heading_deg: typeof coords.heading === "number" ? coords.heading : null,
            captured_at: new Date(
              typeof location.timestamp === "number" ? location.timestamp : Date.now()
            ).toISOString(),
            metadata: {
              app: "fieldops",
              source: "mobile_background",
              task: FIELDOPS_BACKGROUND_LOCATION_TASK,
            },
          },
        },
      });
    }

    await syncOutboxInBackground();
  });
}

export async function getBackgroundLocationTrackingState() {
  let running = false;
  try {
    running = await Location.hasStartedLocationUpdatesAsync(FIELDOPS_BACKGROUND_LOCATION_TASK);
  } catch (error) {
    logDebugFailure("failed to query background location task state", error, "fieldops:background-location");
    running = false;
  }
  const state = await readBackgroundState();
  return { running, state };
}

async function stopTrackingAndClearState() {
  try {
    const running = await Location.hasStartedLocationUpdatesAsync(FIELDOPS_BACKGROUND_LOCATION_TASK);
    if (running) {
      await Location.stopLocationUpdatesAsync(FIELDOPS_BACKGROUND_LOCATION_TASK);
    }
  } catch (error) {
    logDebugFailure("failed to stop background location updates", error, "fieldops:background-location");
  }
  await writeBackgroundState({
    deviceId: null,
    trackingEnabled: false,
    maxAccuracyM: null,
  });
}

let backgroundLifecycleGeneration = 0;
let backgroundLifecycleTail: Promise<unknown> = Promise.resolve();

function serializeBackgroundLifecycle<T>(operation: () => Promise<T>): Promise<T> {
  const result = backgroundLifecycleTail.then(operation, operation);
  backgroundLifecycleTail = result.catch(() => undefined);
  return result;
}

export function stopBackgroundLocationTracking() {
  backgroundLifecycleGeneration += 1;
  return serializeBackgroundLifecycle(stopTrackingAndClearState);
}

export async function syncBackgroundLocationTracking(params: {
  deviceId: string | null;
  policy: MobileLocationTrackingPolicy;
}): Promise<BackgroundTrackingSyncResult> {
  const generation = ++backgroundLifecycleGeneration;
  const isCurrent = () => generation === backgroundLifecycleGeneration;
  const superseded: BackgroundTrackingSyncResult = { running: false, reason: "disabled_by_policy_or_device" };
  const shouldRun = Boolean(params.deviceId && params.policy.enabled && params.policy.backgroundEnabled);

  if (!shouldRun) {
    return serializeBackgroundLifecycle<BackgroundTrackingSyncResult>(async () => {
      if (!isCurrent()) return superseded;
      await writeBackgroundState({ deviceId: params.deviceId, trackingEnabled: false, maxAccuracyM: params.policy.maxAccuracyM });
      if (!isCurrent()) return superseded;
      const wasRunning = await Location.hasStartedLocationUpdatesAsync(FIELDOPS_BACKGROUND_LOCATION_TASK);
      if (wasRunning && isCurrent()) await Location.stopLocationUpdatesAsync(FIELDOPS_BACKGROUND_LOCATION_TASK);
      return superseded;
    });
  }

  const taskManagerAvailable = await TaskManager.isAvailableAsync();
  if (!isCurrent()) return superseded;
  if (!taskManagerAvailable) {
    await serializeBackgroundLifecycle(async () => {
      if (isCurrent()) await writeBackgroundState({ deviceId: params.deviceId, trackingEnabled: false, maxAccuracyM: params.policy.maxAccuracyM });
    });
    return superseded;
  }

  await serializeBackgroundLifecycle(async () => {
    if (isCurrent()) await writeBackgroundState({ deviceId: params.deviceId, trackingEnabled: false, maxAccuracyM: params.policy.maxAccuracyM });
  });
  if (!isCurrent()) return superseded;

  const stopIfRunning = async () => {
    try {
      const running = await Location.hasStartedLocationUpdatesAsync(FIELDOPS_BACKGROUND_LOCATION_TASK);
      if (running && isCurrent()) {
        await Location.stopLocationUpdatesAsync(FIELDOPS_BACKGROUND_LOCATION_TASK);
      }
    } catch (error) {
      logDebugFailure("failed to stop background location updates", error, "fieldops:background-location");
    }
  };

  let foregroundPermission = await Location.getForegroundPermissionsAsync();
  if (!isCurrent()) return superseded;
  if (foregroundPermission.status !== "granted" && foregroundPermission.canAskAgain !== false) {
    foregroundPermission = await Location.requestForegroundPermissionsAsync();
    if (!isCurrent()) return superseded;
  }
  if (foregroundPermission.status !== "granted") {
    await serializeBackgroundLifecycle(async () => { if (isCurrent()) await stopIfRunning(); });
    return { running: false, reason: "foreground_permission_denied" };
  }

  let backgroundPermission = await Location.getBackgroundPermissionsAsync();
  if (!isCurrent()) return superseded;
  if (backgroundPermission.status !== "granted" && backgroundPermission.canAskAgain !== false && params.policy.requestBackgroundPermission) {
    backgroundPermission = await Location.requestBackgroundPermissionsAsync();
    if (!isCurrent()) return superseded;
  }
  if (backgroundPermission.status !== "granted") {
    await serializeBackgroundLifecycle(async () => { if (isCurrent()) await stopIfRunning(); });
    return { running: false, reason: "background_permission_denied" };
  }

  return serializeBackgroundLifecycle<BackgroundTrackingSyncResult>(async () => {
    if (!isCurrent()) return superseded;
    const wasRunning = await Location.hasStartedLocationUpdatesAsync(FIELDOPS_BACKGROUND_LOCATION_TASK);
    if (!isCurrent()) return superseded;
    if (wasRunning) {
      await Location.stopLocationUpdatesAsync(FIELDOPS_BACKGROUND_LOCATION_TASK);
    }

    const options: Location.LocationTaskOptions = {
      accuracy: resolveLocationAccuracy(params.policy.backgroundAccuracy),
      distanceInterval: params.policy.backgroundDistanceIntervalM,
      showsBackgroundLocationIndicator: params.policy.backgroundShowsIndicator,
      pausesUpdatesAutomatically: params.policy.backgroundPausesUpdatesAutomatically,
    };

    if (Platform.OS === "android") {
      options.timeInterval = params.policy.backgroundTimeIntervalMs;
      options.foregroundService = {
        notificationTitle: params.policy.backgroundNotificationTitle,
        notificationBody: params.policy.backgroundNotificationBody,
      };
    } else if (Platform.OS === "ios") {
      options.deferredUpdatesInterval = params.policy.backgroundDeferredUpdatesIntervalMs;
    }

    if (!isCurrent()) return superseded;
    await Location.startLocationUpdatesAsync(FIELDOPS_BACKGROUND_LOCATION_TASK, options);
    if (!isCurrent()) return superseded;
    await writeBackgroundState({
      deviceId: params.deviceId,
      trackingEnabled: true,
      maxAccuracyM: params.policy.maxAccuracyM,
    });

    return { running: true, reason: wasRunning ? "updated" : "started" };
  });
}
