import type { MobileLocationTrackingPolicy } from "../../../apps/fieldops/src/mobile-location-policy";

const BACKGROUND_STATE_KEY = "fieldops_background_location_state_v1";
const BACKGROUND_LOCATION_LOCAL_MOCKS = [
  "../../../apps/fieldops/src/mobile-crash-reporting",
  "../../../apps/fieldops/src/mobile-debug",
  "../../../apps/fieldops/src/mobile-jwt",
  "../../../apps/fieldops/src/mobile-public-config",
  "../../../apps/fieldops/src/mobile-storage",
] as const;

type LoadOptions = {
  platform?: "android" | "ios" | "web";
  running?: boolean;
  runningSequence?: boolean[];
  hasStartedThrows?: boolean;
  taskDefined?: boolean;
  taskManagerAvailable?: boolean;
  foregroundCanAskAgain?: boolean;
  backgroundCanAskAgain?: boolean;
  foregroundStatus?: "granted" | "denied";
  foregroundRequestStatus?: "granted" | "denied";
  backgroundStatus?: "granted" | "denied";
  backgroundRequestStatus?: "granted" | "denied";
  sessionSequence?: boolean[];
  pendingCount?: number;
  privilegedRole?: boolean;
  expoExtra?: Record<string, unknown> | null | undefined;
  publicConfigThrows?: boolean;
  syncHold?: boolean;
  retriableNetwork?: boolean;
  retriableSupabase?: boolean;
  secureState?: Map<string, string>;
};

function createPolicy(overrides: Partial<MobileLocationTrackingPolicy> = {}): MobileLocationTrackingPolicy {
  return {
    enabled: true,
    minIntervalSeconds: 15,
    maxAccuracyM: 100,
    backgroundEnabled: true,
    requestBackgroundPermission: true,
    backgroundDistanceIntervalM: 50,
    backgroundTimeIntervalMs: 60_000,
    backgroundDeferredUpdatesIntervalMs: 60_000,
    backgroundShowsIndicator: false,
    backgroundPausesUpdatesAutomatically: true,
    backgroundNotificationTitle: "FieldOps",
    backgroundNotificationBody: "Tracking",
    foregroundAccuracy: "balanced",
    backgroundAccuracy: "balanced",
    ...overrides,
  };
}

function makeLocation(overrides: Record<string, unknown> = {}) {
  return {
    coords: {
      latitude: 24.7136,
      longitude: 46.6753,
      accuracy: 10,
      speed: 1,
      heading: 90,
    },
    timestamp: Date.now(),
    ...overrides,
  };
}

function seedTrackingEnabledState(secureState: Map<string, string>, options: {
  deviceId?: unknown;
  trackingEnabled?: boolean;
  maxAccuracyM?: unknown;
} = {}) {
  secureState.set(
    BACKGROUND_STATE_KEY,
    JSON.stringify({
      deviceId: options.deviceId ?? "device-1",
      trackingEnabled: options.trackingEnabled ?? true,
      maxAccuracyM: options.maxAccuracyM ?? 15,
    })
  );
}

function resetBackgroundLocationLocalMocks() {
  for (const moduleName of BACKGROUND_LOCATION_LOCAL_MOCKS) {
    jest.dontMock(moduleName);
    jest.unmock(moduleName);
  }
  jest.resetModules();
}

function loadBackgroundModule(options: LoadOptions = {}) {
  const {
    platform = "android",
    running = false,
    runningSequence = [],
    hasStartedThrows = false,
    taskDefined = true,
    taskManagerAvailable = true,
    foregroundStatus = "granted",
    foregroundRequestStatus = foregroundStatus,
    backgroundStatus = "granted",
    backgroundRequestStatus = backgroundStatus,
    sessionSequence = [true],
    pendingCount = 2,
    privilegedRole = false,
    expoExtra = {
      NEXT_PUBLIC_SUPABASE_URL: "https://example.supabase.co",
      NEXT_PUBLIC_SUPABASE_ANON_KEY: "anon-key",
    },
    publicConfigThrows = false,
    syncHold = false,
    retriableNetwork = false,
    retriableSupabase = false,
    secureState: providedSecureState,
  } = options;

  jest.resetModules();

  const secureState = providedSecureState ?? new Map<string, string>();
  let taskHandler: ((payload: { data?: unknown; error?: unknown }) => Promise<void>) | null = null;
  let nextOutboxId = 0;
  const sessionPlan = sessionSequence.slice();
  const runningPlan = runningSequence.slice();

  let releaseSyncGate: (() => void) | null = null;
  const syncGatePromise = syncHold
    ? new Promise<void>((resolve) => {
      releaseSyncGate = resolve;
    })
    : null;

  const secureStoreMock = {
    getItemAsync: jest.fn(async (key: string) => secureState.get(key) ?? null),
    setItemAsync: jest.fn(async (key: string, value: string) => {
      secureState.set(key, value);
    }),
    deleteItemAsync: jest.fn(async (key: string) => {
      secureState.delete(key);
    }),
  };

  const locationMock = {
    Accuracy: {
      Lowest: 1,
      Low: 2,
      Balanced: 3,
      High: 4,
      Highest: 5,
    },
    hasStartedLocationUpdatesAsync: jest.fn(async () => {
      if (hasStartedThrows) throw new Error("hasStarted failure");
      if (runningPlan.length > 0) return Boolean(runningPlan.shift());
      return running;
    }),
    stopLocationUpdatesAsync: jest.fn(async () => undefined),
    startLocationUpdatesAsync: jest.fn(async () => undefined),
    getForegroundPermissionsAsync: jest.fn(async () => ({ status: foregroundStatus, canAskAgain: options.foregroundCanAskAgain })),
    requestForegroundPermissionsAsync: jest.fn(async () => ({ status: foregroundRequestStatus })),
    getBackgroundPermissionsAsync: jest.fn(async () => ({ status: backgroundStatus, canAskAgain: options.backgroundCanAskAgain })),
    requestBackgroundPermissionsAsync: jest.fn(async () => ({ status: backgroundRequestStatus })),
  };

  const taskManagerMock = {
    isTaskDefined: jest.fn(() => taskDefined),
    defineTask: jest.fn((name: string, handler: typeof taskHandler) => {
      if (name) taskHandler = handler;
    }),
    isAvailableAsync: jest.fn(async () => taskManagerAvailable),
  };

  const readbackValues = new Map<string, unknown>();
  const readbackStore = {
    init: async () => {},
    get: async (key: string) => readbackValues.get(key) ?? null,
    set: async (key: string, value: unknown) => { readbackValues.set(key, value); },
    remove: async (key: string) => { readbackValues.delete(key); },
    clear: async () => { const count = readbackValues.size; readbackValues.clear(); return count; },
  };
  const outboxStoreMock = {
    countPending: jest.fn(async () => pendingCount),
  };

  const outboxMock = {
    init: jest.fn(async () => undefined),
    enqueue: jest.fn(async () => undefined),
    sync: jest.fn(async () => {
      if (syncGatePromise) await syncGatePromise;
      return { processed: pendingCount };
    }),
  };

  const getSessionMock = jest.fn(async () => {
    const hasSession = sessionPlan.length > 1 ? Boolean(sessionPlan.shift()) : Boolean(sessionPlan[0] ?? true);
    return { data: { session: hasSession ? { user: { id: "u-1" } } : null } };
  });
  const clientMock = {
    auth: {
      getSession: getSessionMock,
      getUser: jest.fn(async () => ({data:{user:{id:"u-1"}},error:null})),
    },
    schema: jest.fn(() => ({
      rpc: jest.fn(() => ({
        abortSignal: () => Promise.resolve({data:{user:{id:"u-1"},org:{id:"tenant"},
          access_scope:{scope_type:"tenant",scope_id:"tenant"}},error:null}),
      })),
    })),
  };

  const createMobileClientMock = jest.fn((config: any) => {
    createMobileClientMock.lastConfig = config;
    return clientMock;
  }) as jest.Mock & { lastConfig?: Record<string, unknown> };
  const createSupabaseExecutorMock = jest.fn(() => ({ kind: "executor" }));

  const isRetriableNetworkErrorMock = jest.fn(() => retriableNetwork);
  const isRetriableSupabaseErrorMock = jest.fn(() => retriableSupabase);

  const addMobileNetworkFailureBreadcrumbMock = jest.fn();
  const logDebugFailureMock = jest.fn();
  const logMobileRequestTraceMock = jest.fn();
  const resolveJwtRoleMock = jest.fn(() => (privilegedRole ? "service_role" : "authenticated"));
  const isJwtPrivilegedRoleMock = jest.fn(() => privilegedRole);
  const resolveExpoExtraMock = jest.fn((value: unknown) => (value as Record<string, unknown>) || {});
  const getPublicConfigFromExpoMock = jest.fn((_value: unknown) => {
    if (publicConfigThrows) {
      throw new Error("public config failure");
    }
    return {
      supabaseUrl: "https://example.supabase.co",
      supabaseAnonKey: "anon-key",
    };
  });

  jest.doMock("expo-constants", () => ({
    __esModule: true,
    default: {
      expoConfig: {
        extra: expoExtra,
      },
    },
    expoConfig: {
      extra: expoExtra,
    },
  }), { virtual: true });
  jest.doMock("expo-location", () => locationMock, { virtual: true });
  jest.doMock("expo-secure-store", () => secureStoreMock, { virtual: true });
  jest.doMock("expo-task-manager", () => taskManagerMock, { virtual: true });
  jest.doMock("react-native", () => ({ Platform: { OS: platform } }), { virtual: true });

  jest.doMock("@masarx/api", () => ({
    isRetriableNetworkError: isRetriableNetworkErrorMock,
    isRetriableSupabaseError: isRetriableSupabaseErrorMock,
  }), { virtual: true });
  jest.doMock("@masarx/auth/mobile", () => ({
    createMobileClient: createMobileClientMock,
    createSupabaseExecutor: createSupabaseExecutorMock,
  }), { virtual: true });
  jest.doMock("@masarx/mobile-core/sqlite", () => ({
    createSqliteOutboxStore: jest.fn(() => outboxStoreMock),
    createSqliteKeyValueStore: jest.fn(() => readbackStore),
  }), { virtual: true });
  jest.doMock("@masarx/mobile-core", () => ({
    createOutbox: jest.fn(() => outboxMock),
    createOutboxId: jest.fn(() => {
      nextOutboxId += 1;
      return `outbox-${nextOutboxId}`;
    }),
  }), { virtual: true });

  jest.doMock("../../../apps/fieldops/src/mobile-crash-reporting", () => ({
    addMobileNetworkFailureBreadcrumb: addMobileNetworkFailureBreadcrumbMock,
  }));
  jest.doMock("../../../apps/fieldops/src/mobile-debug", () => ({
    logDebugFailure: logDebugFailureMock,
    logMobileRequestTrace: logMobileRequestTraceMock,
  }));
  jest.doMock("../../../apps/fieldops/src/mobile-jwt", () => ({
    resolveJwtRole: resolveJwtRoleMock,
    isJwtPrivilegedRole: isJwtPrivilegedRoleMock,
  }));
  jest.doMock("../../../apps/fieldops/src/mobile-public-config", () => ({
    resolveExpoExtra: resolveExpoExtraMock,
    getPublicConfigFromExpo: getPublicConfigFromExpoMock,
  }));
  jest.doMock("../../../apps/fieldops/src/mobile-storage", () => ({
    createFieldOpsStorage: jest.fn(() => ({
      getItem: async (key: string) => secureState.get(key) ?? null,
      setItem: async (key: string, value: string) => {
        secureState.set(key, value);
      },
      removeItem: async (key: string) => {
        secureState.delete(key);
      },
    })),
  }));

  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const mod = require("../../../apps/fieldops/src/mobile-background-location");

  return {
    mod,
    secureState,
    locationMock,
    outboxMock,
    outboxStoreMock,
    getTaskHandler: () => taskHandler,
    readbackStore,
    createMobileClientMock,
    addMobileNetworkFailureBreadcrumbMock,
    logDebugFailureMock,
    logMobileRequestTraceMock,
    isRetriableNetworkErrorMock,
    isRetriableSupabaseErrorMock,
    releaseSyncGate: () => {
      if (releaseSyncGate) releaseSyncGate();
    },
  };
}

describe("mobile background location", () => {
  test("actual background drainer refuses unbound departure intents", async () => {
    const loaded = loadBackgroundModule({ taskDefined: false, sessionSequence: [true], pendingCount: 1 });
    seedTrackingEnabledState(loaded.secureState);
    await loaded.getTaskHandler()?.({ data: { locations: [makeLocation()] } });
    const calls = loaded.outboxMock.sync.mock.calls as unknown as Array<[(rpc: string, args: unknown) => Promise<unknown>]>;
    expect(calls).toHaveLength(1);
    await expect(calls[0][0]("ui_confirm_route_run_departure_v1", { p_input: {} }))
      .rejects.toThrow("Invalid departure request fields");
  });
  test("actual background task wires canonical completion success observation", async () => {
    const loaded = loadBackgroundModule({ taskDefined: false, sessionSequence: [true], pendingCount: 1 });
    const evidence = require("../../../apps/fieldops/src/mobile-completion-readback-storage");
    // Durable receipt left by an earlier process; this module is genuinely pristine/cold.
    await loaded.readbackStore.set("fieldops:completion-readback:completion", {
      version: 1, queueId: "completion", actor: "u-1", scope: JSON.stringify(["tenant", "tenant", "tenant"]),
      taskId: "task", actionKey: "tasks.complete",
      expected: { action: "tasks.complete", taskId: "task", routeStopId: "stop", completionKind: "full" },
    });
    await loaded.readbackStore.set("fieldops:completion-readback-target:" + JSON.stringify(["u-1", JSON.stringify(["tenant", "tenant", "tenant"]), "task"]), "completion");
    seedTrackingEnabledState(loaded.secureState);
    await loaded.getTaskHandler()?.({ data: { locations: [makeLocation()] } });
    const calls = loaded.outboxMock.sync.mock.calls as unknown as Array<[unknown, { onSucceeded: (entry: unknown, result: unknown) => Promise<void> }]>;
    expect(calls).toHaveLength(1);
    expect(typeof calls[0][1].onSucceeded).toBe("function");
    await calls[0][1].onSucceeded({ id: "completion", args: { p_action_key: "tasks.complete" } }, {
      status: "task_transitioned", action_key: "tasks.complete", resource_key: "tasks",
      items: [{ task_id: "task", task_event_id: "event", to_status: "completed", status_reason: null }],
    });
    expect((await evidence.latestCompletionReadback(loaded.readbackStore, "u-1", JSON.stringify(["tenant", "tenant", "tenant"]), "task")).accepted.taskEventId).toBe("event");
    await evidence.invalidateCompletionReadbacks();
  });
  afterEach(() => {
    resetBackgroundLocationLocalMocks();
  });

  test("stops tracking when device/policy does not allow background execution", async () => {
    const { mod, locationMock, secureState } = loadBackgroundModule({ running: true });

    const result = await mod.syncBackgroundLocationTracking({
      deviceId: null,
      policy: createPolicy(),
    });

    expect(result).toEqual({ running: false, reason: "disabled_by_policy_or_device" });
    expect(locationMock.stopLocationUpdatesAsync).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(secureState.get(BACKGROUND_STATE_KEY) || "{}"))).toEqual({
      deviceId: null,
      trackingEnabled: false,
      maxAccuracyM: 100,
    });
  });

  test("starts background location updates with policy-driven android options", async () => {
    const { mod, locationMock, secureState } = loadBackgroundModule({
      platform: "android",
      running: false,
      foregroundStatus: "granted",
      backgroundStatus: "granted",
      taskManagerAvailable: true,
    });

    const result = await mod.syncBackgroundLocationTracking({
      deviceId: "device-1",
      policy: createPolicy({
        backgroundTimeIntervalMs: 45_000,
        backgroundDistanceIntervalM: 30,
        backgroundNotificationTitle: "FieldOps Location",
        backgroundNotificationBody: "Background capture enabled",
      }),
    });

    expect(result).toEqual({ running: true, reason: "started" });
    expect(locationMock.startLocationUpdatesAsync).toHaveBeenCalledWith(
      "fieldops-background-location-v1",
      expect.objectContaining({
        distanceInterval: 30,
        timeInterval: 45_000,
        foregroundService: {
          notificationTitle: "FieldOps Location",
          notificationBody: "Background capture enabled",
        },
      })
    );
    expect(JSON.parse(String(secureState.get(BACKGROUND_STATE_KEY) || "{}"))).toEqual({
      deviceId: "device-1",
      trackingEnabled: true,
      maxAccuracyM: 100,
    });
  });

  test("requests background permission when policy allows it", async () => {
    const { mod, locationMock } = loadBackgroundModule({
      backgroundStatus: "denied",
      backgroundRequestStatus: "granted",
    });

    const result = await mod.syncBackgroundLocationTracking({
      deviceId: "device-1",
      policy: createPolicy({ requestBackgroundPermission: true }),
    });

    expect(result).toEqual({ running: true, reason: "started" });
    expect(locationMock.requestBackgroundPermissionsAsync).toHaveBeenCalledTimes(1);
  });

  test("returns disabled when task manager is unavailable", async () => {
    const { mod, locationMock } = loadBackgroundModule({
      taskManagerAvailable: false,
    });
    const result = await mod.syncBackgroundLocationTracking({
      deviceId: "device-1",
      policy: createPolicy(),
    });
    expect(result).toEqual({ running: false, reason: "disabled_by_policy_or_device" });
    expect(locationMock.startLocationUpdatesAsync).not.toHaveBeenCalled();
  });

  test("returns foreground denied when foreground permission is not granted", async () => {
    const { mod, locationMock } = loadBackgroundModule({
      foregroundStatus: "denied",
      foregroundRequestStatus: "denied",
      running: true,
    });
    const result = await mod.syncBackgroundLocationTracking({
      deviceId: "device-1",
      policy: createPolicy(),
    });
    expect(result).toEqual({ running: false, reason: "foreground_permission_denied" });
    expect(locationMock.stopLocationUpdatesAsync).toHaveBeenCalled();
    expect(locationMock.startLocationUpdatesAsync).not.toHaveBeenCalled();
  });

  test("returns background denied when background permission is missing and request is disabled", async () => {
    const { mod, locationMock } = loadBackgroundModule({
      backgroundStatus: "denied",
      running: true,
    });
    const result = await mod.syncBackgroundLocationTracking({
      deviceId: "device-1",
      policy: createPolicy({
        requestBackgroundPermission: false,
      }),
    });
    expect(result).toEqual({ running: false, reason: "background_permission_denied" });
    expect(locationMock.requestBackgroundPermissionsAsync).not.toHaveBeenCalled();
    expect(locationMock.stopLocationUpdatesAsync).toHaveBeenCalled();
  });

  test("uses iOS deferred update options and reports updated when already running", async () => {
    const { mod, locationMock } = loadBackgroundModule({
      platform: "ios",
      running: true,
    });
    const result = await mod.syncBackgroundLocationTracking({
      deviceId: "device-1",
      policy: createPolicy({
        backgroundDeferredUpdatesIntervalMs: 90_000,
        backgroundAccuracy: "highest",
      }),
    });
    expect(result).toEqual({ running: true, reason: "updated" });
    expect(locationMock.stopLocationUpdatesAsync).toHaveBeenCalledTimes(1);
    expect(locationMock.startLocationUpdatesAsync).toHaveBeenCalledWith(
      "fieldops-background-location-v1",
      expect.objectContaining({
        deferredUpdatesInterval: 90_000,
      }),
    );
    const options = locationMock.startLocationUpdatesAsync.mock.calls[0]?.[1];
    expect(options.foregroundService).toBeUndefined();
  });

  test("maps non-default accuracy modes", async () => {
    const low = loadBackgroundModule();
    await low.mod.syncBackgroundLocationTracking({
      deviceId: "device-1",
      policy: createPolicy({ backgroundAccuracy: "low" }),
    });
    expect(low.locationMock.startLocationUpdatesAsync.mock.calls[0]?.[1]?.accuracy).toBe(low.locationMock.Accuracy.Low);

    const lowest = loadBackgroundModule();
    await lowest.mod.syncBackgroundLocationTracking({
      deviceId: "device-1",
      policy: createPolicy({ backgroundAccuracy: "lowest" }),
    });
    expect(lowest.locationMock.startLocationUpdatesAsync.mock.calls[0]?.[1]?.accuracy).toBe(lowest.locationMock.Accuracy.Lowest);

    const high = loadBackgroundModule();
    await high.mod.syncBackgroundLocationTracking({
      deviceId: "device-1",
      policy: createPolicy({ backgroundAccuracy: "high" }),
    });
    expect(high.locationMock.startLocationUpdatesAsync.mock.calls[0]?.[1]?.accuracy).toBe(high.locationMock.Accuracy.High);
  });

  test("normalizes malformed stored state and maxAccuracy edge values", async () => {
    const { mod, secureState } = loadBackgroundModule();
    seedTrackingEnabledState(secureState, {
      deviceId: "   ",
      maxAccuracyM: -5,
    });

    const normalized = await mod.getBackgroundLocationTrackingState();
    expect(normalized.state).toEqual({
      deviceId: null,
      trackingEnabled: true,
      maxAccuracyM: null,
    });

    secureState.set(BACKGROUND_STATE_KEY, JSON.stringify([]));
    expect((await mod.getBackgroundLocationTrackingState()).state).toEqual({
      deviceId: null,
      trackingEnabled: false,
      maxAccuracyM: null,
    });

    await mod.syncBackgroundLocationTracking({
      deviceId: null,
      policy: createPolicy({
        maxAccuracyM: Number.NaN as any,
      }),
    });
    const stored = JSON.parse(String(secureState.get(BACKGROUND_STATE_KEY) || "{}"));
    expect(stored.maxAccuracyM).toBeNull();
  });

  test("persists background state across module reload when SecureStore succeeds", async () => {
    const sharedState = new Map<string, string>();
    const firstLoad = loadBackgroundModule({
      secureState: sharedState,
      running: false,
    });

    await firstLoad.mod.syncBackgroundLocationTracking({
      deviceId: "device-42",
      policy: createPolicy({
        maxAccuracyM: 25,
      }),
    });

    resetBackgroundLocationLocalMocks();

    const secondLoad = loadBackgroundModule({
      secureState: sharedState,
      running: true,
    });
    const restored = await secondLoad.mod.getBackgroundLocationTrackingState();
    expect(restored.state).toEqual({
      deviceId: "device-42",
      trackingEnabled: true,
      maxAccuracyM: 25,
    });
  });

  test("get state handles hasStarted failures gracefully", async () => {
    const { mod } = loadBackgroundModule({
      hasStartedThrows: true,
    });
    const state = await mod.getBackgroundLocationTrackingState();
    expect(state.running).toBe(false);
    expect(state.state).toEqual({
      deviceId: null,
      trackingEnabled: false,
      maxAccuracyM: null,
    });
  });

  test("stopBackgroundLocationTracking clears stored state even when task is not running", async () => {
    const { mod, secureState, locationMock } = loadBackgroundModule({
      running: false,
    });
    seedTrackingEnabledState(secureState, {
      deviceId: "device-1",
      trackingEnabled: true,
      maxAccuracyM: 20,
    });
    await mod.stopBackgroundLocationTracking();
    expect(locationMock.stopLocationUpdatesAsync).not.toHaveBeenCalled();
    expect(JSON.parse(String(secureState.get(BACKGROUND_STATE_KEY) || "{}"))).toEqual({
      deviceId: null,
      trackingEnabled: false,
      maxAccuracyM: null,
    });
  });

  test("background task enqueues accepted locations, applies retry policy, and logs transport failures", async () => {
    const loaded = loadBackgroundModule({
      taskDefined: false,
      sessionSequence: [true, true],
      pendingCount: 3,
      retriableNetwork: true,
      retriableSupabase: false,
      expoExtra: undefined,
    });
    const { mod, secureState, outboxMock, getTaskHandler } = loaded;

    expect(typeof mod.FIELDOPS_BACKGROUND_LOCATION_TASK).toBe("string");
    seedTrackingEnabledState(secureState, { maxAccuracyM: 15 });

    const handler = getTaskHandler();
    expect(handler).toBeInstanceOf(Function);

    await handler?.({
      data: {
        locations: [
          makeLocation(),
          makeLocation({
            coords: {
              latitude: 24.7137,
              longitude: 46.6754,
              accuracy: 25,
              speed: 1,
              heading: 90,
            },
          }),
        ],
      },
      error: null,
    });

    expect(outboxMock.enqueue).toHaveBeenCalledTimes(1);
    expect(outboxMock.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "outbox-1",
        rpc: "record_location_ping_v1",
        args: {
          p_ping: expect.objectContaining({
            idempotency_key: "outbox-1",
            device_id: "device-1",
            metadata: expect.objectContaining({
              app: "fieldops",
              source: "mobile_background",
            }),
          }),
        },
      })
    );
    expect(outboxMock.sync).toHaveBeenCalledTimes(1);

    const syncOptions = outboxMock.sync.mock.calls[0]?.[1];
    expect(syncOptions.shouldRetry(new Error("network"))).toBe(true);
    expect(loaded.isRetriableNetworkErrorMock).toHaveBeenCalled();
    expect(loaded.isRetriableSupabaseErrorMock).not.toHaveBeenCalled();

    expect(loaded.createMobileClientMock.lastConfig?.onRequestTrace).toBe(loaded.logMobileRequestTraceMock);
    const onRequestFailure = loaded.createMobileClientMock.lastConfig?.onRequestFailure as ((value: Record<string, unknown>) => void);
    onRequestFailure?.({
      method: "GET",
      url: "https://example.supabase.co/rest/v1/ping",
      status: undefined,
      statusText: undefined,
      correlationId: "cid-1",
      traceparent: "tp-1",
      error: undefined,
    });
    expect(loaded.addMobileNetworkFailureBreadcrumbMock).toHaveBeenCalledTimes(1);
    expect(loaded.logDebugFailureMock).toHaveBeenCalledWith(
      "background request failed",
      expect.stringContaining("=> ? "),
      "fieldops:background-location"
    );
  });

  test("background task assigns stable idempotency keys per accepted ping and caps sync batches", async () => {
    const loaded = loadBackgroundModule({
      taskDefined: false,
      sessionSequence: [true, true],
      pendingCount: 100,
    });
    seedTrackingEnabledState(loaded.secureState, { maxAccuracyM: 20 });

    await loaded.getTaskHandler()?.({
      data: {
        locations: [
          makeLocation({
            coords: {
              latitude: 24.7136,
              longitude: 46.6753,
              accuracy: 8,
              speed: 1,
              heading: 90,
            },
          }),
          makeLocation({
            coords: {
              latitude: 24.7138,
              longitude: 46.6756,
              accuracy: 12,
              speed: 0,
              heading: 180,
            },
          }),
        ],
      },
      error: null,
    });

    expect(loaded.outboxMock.enqueue).toHaveBeenCalledTimes(2);
    const first = loaded.outboxMock.enqueue.mock.calls[0]?.[0];
    const second = loaded.outboxMock.enqueue.mock.calls[1]?.[0];
    expect(first.id).toBe("outbox-1");
    expect(first.args.p_ping.idempotency_key).toBe("outbox-1");
    expect(second.id).toBe("outbox-2");
    expect(second.args.p_ping.idempotency_key).toBe("outbox-2");
    expect(second.args.p_ping.metadata).toEqual(
      expect.objectContaining({
        source: "mobile_background",
        task: "fieldops-background-location-v1",
      })
    );
    expect(loaded.outboxMock.sync).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        limit: 25,
      })
    );
  });

  test("background task fail-closes on web runtime, public config errors, and privileged role", async () => {
    const webRuntime = loadBackgroundModule({
      platform: "web",
      taskDefined: false,
      sessionSequence: [true],
      running: true,
    });
    seedTrackingEnabledState(webRuntime.secureState);
    await webRuntime.getTaskHandler()?.({
      data: { locations: [makeLocation()] },
      error: null,
    });
    expect(webRuntime.locationMock.stopLocationUpdatesAsync).toHaveBeenCalled();
    expect(webRuntime.outboxMock.enqueue).not.toHaveBeenCalled();

    const brokenConfig = loadBackgroundModule({
      taskDefined: false,
      publicConfigThrows: true,
      running: true,
    });
    seedTrackingEnabledState(brokenConfig.secureState);
    await brokenConfig.getTaskHandler()?.({
      data: { locations: [makeLocation()] },
      error: null,
    });
    expect(brokenConfig.locationMock.stopLocationUpdatesAsync).toHaveBeenCalled();
    expect(brokenConfig.logDebugFailureMock).toHaveBeenCalledWith(
      "failed to resolve public config for background sync",
      expect.any(Error),
      "fieldops:background-location"
    );

    const privileged = loadBackgroundModule({
      taskDefined: false,
      privilegedRole: true,
      running: true,
    });
    seedTrackingEnabledState(privileged.secureState);
    await privileged.getTaskHandler()?.({
      data: { locations: [makeLocation()] },
      error: null,
    });
    expect(privileged.locationMock.stopLocationUpdatesAsync).toHaveBeenCalled();
    expect(privileged.outboxMock.enqueue).not.toHaveBeenCalled();
  });

  test("background task exits early on no-session, invalid state, error payload, and malformed location sets", async () => {
    const noSession = loadBackgroundModule({
      taskDefined: false,
      sessionSequence: [false],
      running: true,
    });
    await noSession.getTaskHandler()?.({ data: { locations: [makeLocation()] }, error: null });
    expect(noSession.outboxMock.enqueue).not.toHaveBeenCalled();
    expect(noSession.locationMock.stopLocationUpdatesAsync).toHaveBeenCalled();

    const inactiveState = loadBackgroundModule({
      taskDefined: false,
      sessionSequence: [true],
    });
    seedTrackingEnabledState(inactiveState.secureState, {
      deviceId: null,
      trackingEnabled: false,
      maxAccuracyM: 10,
    });
    const handlerInactive = inactiveState.getTaskHandler();
    await handlerInactive?.({ data: { locations: [makeLocation({ coords: null })] }, error: null });
    expect(inactiveState.outboxMock.enqueue).not.toHaveBeenCalled();

    await handlerInactive?.({ data: { locations: [] }, error: new Error("location error") });
    expect(inactiveState.outboxMock.enqueue).not.toHaveBeenCalled();

    seedTrackingEnabledState(inactiveState.secureState);
    await handlerInactive?.({ data: { locations: "invalid" as any }, error: null });
    expect(inactiveState.outboxMock.enqueue).not.toHaveBeenCalled();
  });

  test("normalizes nullable location metrics during enqueue", async () => {
    const loaded = loadBackgroundModule({
      taskDefined: false,
      sessionSequence: [true, true],
      pendingCount: 1,
    });
    seedTrackingEnabledState(loaded.secureState, { maxAccuracyM: null });

    await loaded.getTaskHandler()?.({
      data: {
        locations: [
          makeLocation({ coords: null }),
          makeLocation({
            coords: {
              latitude: 24.7136,
              longitude: 46.6753,
              accuracy: "bad",
              speed: "fast",
              heading: "east",
            },
            timestamp: "invalid",
          }),
        ],
      },
      error: null,
    });

    expect(loaded.outboxMock.enqueue).toHaveBeenCalledTimes(1);
    const enqueuePayload = loaded.outboxMock.enqueue.mock.calls[0]?.[0];
    expect(enqueuePayload.args.p_ping).toEqual(
      expect.objectContaining({
        accuracy_m: null,
        speed_mps: null,
        heading_deg: null,
      })
    );
    expect(typeof enqueuePayload.args.p_ping.captured_at).toBe("string");
  });

  test("sync short-circuits when already active, recently synced, missing session during sync, or queue is empty", async () => {
    const activeGate = loadBackgroundModule({
      taskDefined: false,
      sessionSequence: [true, true, true, true, true],
      syncHold: true,
      pendingCount: 3,
    });
    seedTrackingEnabledState(activeGate.secureState);
    const handler = activeGate.getTaskHandler();
    const first = handler?.({ data: { locations: [makeLocation()] }, error: null });
    const second = handler?.({ data: { locations: [makeLocation()] }, error: null });
    activeGate.releaseSyncGate();
    await first;
    await second;

    await handler?.({ data: { locations: [makeLocation()] }, error: null });
    expect(activeGate.outboxMock.sync).toHaveBeenCalledTimes(1);

    const noSessionInSync = loadBackgroundModule({
      taskDefined: false,
      sessionSequence: [true, false],
      pendingCount: 2,
    });
    seedTrackingEnabledState(noSessionInSync.secureState);
    await noSessionInSync.getTaskHandler()?.({
      data: { locations: [makeLocation()] },
      error: null,
    });
    expect(noSessionInSync.outboxMock.sync).not.toHaveBeenCalled();

    const noPending = loadBackgroundModule({
      taskDefined: false,
      sessionSequence: [true, true],
      pendingCount: 0,
    });
    seedTrackingEnabledState(noPending.secureState);
    await noPending.getTaskHandler()?.({
      data: { locations: [makeLocation()] },
      error: null,
    });
    expect(noPending.outboxMock.sync).not.toHaveBeenCalled();
  });
});

describe("permanently denied background permissions", () => {
  afterEach(resetBackgroundLocationLocalMocks);
  test.each(["foreground", "background"] as const)("does not request %s again", async (kind) => {
    const { mod, locationMock } = loadBackgroundModule({
      [`${kind}Status`]: "denied",
      [`${kind}CanAskAgain`]: false,
    });
    expect(await mod.syncBackgroundLocationTracking({ deviceId: "device-1", policy: createPolicy() }))
      .toEqual({ running: false, reason: `${kind}_permission_denied` });
    expect(locationMock.requestForegroundPermissionsAsync).not.toHaveBeenCalled();
    expect(locationMock.requestBackgroundPermissionsAsync).not.toHaveBeenCalled();
    expect(locationMock.startLocationUpdatesAsync).not.toHaveBeenCalled();
  });
});

describe("background lifecycle ordering", () => {
  afterEach(resetBackgroundLocationLocalMocks);

  test.each(["policy-disable", "device-change"] as const)("new %s wins over deferred permission", async (change) => {
    const { mod, locationMock, secureState } = loadBackgroundModule({ running: true });
    let release!: (value: { status: "granted" }) => void;
    let entered!: () => void;
    const pending = new Promise<{ status: "granted" }>(resolve => { release = resolve; });
    const requested = new Promise<void>(resolve => { entered = resolve; });
    locationMock.getForegroundPermissionsAsync
      .mockResolvedValueOnce({ status: "denied", canAskAgain: true })
      .mockResolvedValue({ status: "granted", canAskAgain: true });
    locationMock.requestForegroundPermissionsAsync.mockImplementationOnce(() => { entered(); return pending; });
    const old = mod.syncBackgroundLocationTracking({ deviceId: "old-device", policy: createPolicy() });
    await requested;

    const latestDevice = change === "device-change" ? "new-device" : "old-device";
    await mod.syncBackgroundLocationTracking({
      deviceId: latestDevice,
      policy: createPolicy({ enabled: change !== "policy-disable" }),
    });
    const startsBeforeOldSettles = locationMock.startLocationUpdatesAsync.mock.calls.length;
    expect(locationMock.stopLocationUpdatesAsync).toHaveBeenCalled();
    release({ status: "granted" });
    await old;

    expect(locationMock.startLocationUpdatesAsync).toHaveBeenCalledTimes(startsBeforeOldSettles);
    expect(JSON.parse(secureState.get(BACKGROUND_STATE_KEY)!)).toMatchObject({
      deviceId: latestDevice,
      trackingEnabled: change !== "policy-disable",
    });
  });

  test("disable serializes after an already in-flight native start", async () => {
    const { mod, locationMock, secureState } = loadBackgroundModule({ runningSequence: [false, true] });
    let release!: () => void;
    let entered!: () => void;
    const pending = new Promise<undefined>(resolve => { release = () => resolve(undefined); });
    const started = new Promise<void>(resolve => { entered = resolve; });
    locationMock.startLocationUpdatesAsync.mockImplementationOnce(() => { entered(); return pending; });
    const old = mod.syncBackgroundLocationTracking({ deviceId: "device-1", policy: createPolicy() });
    await started;
    const disabled = mod.syncBackgroundLocationTracking({ deviceId: "device-1", policy: createPolicy({ enabled: false }) });
    release();
    await Promise.all([old, disabled]);
    expect(locationMock.stopLocationUpdatesAsync).toHaveBeenCalledTimes(1);
    expect(JSON.parse(secureState.get(BACKGROUND_STATE_KEY)!)).toMatchObject({ trackingEnabled: false });
  });
});
