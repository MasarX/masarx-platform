type TelemetryModule = typeof import("../../../apps/fieldops/src/mobile-telemetry");

function installWebLocalStorage() {
  const state = new Map<string, string>();
  const localStorage = {
    getItem: (key: string) => (state.has(key) ? state.get(key) ?? null : null),
    setItem: (key: string, value: string) => {
      state.set(key, value);
    },
    removeItem: (key: string) => {
      state.delete(key);
    },
    clear: () => {
      state.clear();
    },
  };

  (globalThis as any).window = { localStorage };
  return { state, localStorage };
}

function loadTelemetryModule(): TelemetryModule {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  return require("../../../apps/fieldops/src/mobile-telemetry") as TelemetryModule;
}

describe("mobile telemetry serialized operations", () => {
  const event = (name: string) => ({ event_type: name, captured_at: "2026-09-10T00:00:00.000Z", metadata: {} });
  function setup() {
    jest.resetModules();
    const previous = (globalThis as any).window;
    installWebLocalStorage();
    return { telemetry: loadTelemetryModule(), restore: () => { (globalThis as any).window = previous; } };
  }
  test("concurrent request start and terminal events are retained in submission order", async () => {
    const { telemetry, restore } = setup();
    try {
      const names = ["a.start", "b.start", "a.end", "b.error"];
      await Promise.all(names.map(name => telemetry.bufferMobileTelemetryEvent(event(name))));
      const enqueue = jest.fn(async (_events: any[]) => undefined);
      expect(await telemetry.flushMobileTelemetryEvents({ enqueue })).toBe(4);
      expect(enqueue.mock.calls[0][0].map((e: any) => e.event_type)).toEqual(names);
    } finally { restore(); }
  });
  test("an event submitted during flush survives for the next flush", async () => {
    const { telemetry, restore } = setup();
    let release!: () => void, entered!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const started = new Promise<void>(resolve => { entered = resolve; });
    let flushing: Promise<number> | undefined, late: Promise<void> | undefined;
    try {
      await telemetry.bufferMobileTelemetryEvent(event("first"));
      flushing = telemetry.flushMobileTelemetryEvents({ enqueue: async () => { entered(); await gate; } });
      await started;
      late = telemetry.bufferMobileTelemetryEvent(event("late"));
      release();
      expect(await flushing).toBe(1);
      await late;
      const enqueue = jest.fn(async (_events: any[]) => undefined);
      expect(await telemetry.flushMobileTelemetryEvents({ enqueue })).toBe(1);
      expect(enqueue.mock.calls[0][0][0].event_type).toBe("late");
    } finally { release(); await flushing?.catch(() => undefined); await late; restore(); }
  });
  test("rejected enqueue retains events and does not poison later operations", async () => {
    const { telemetry, restore } = setup();
    try {
      await telemetry.bufferMobileTelemetryEvent(event("first"));
      const failure = new Error("enqueue rejected");
      await expect(telemetry.flushMobileTelemetryEvents({ enqueue: async () => { throw failure; } })).rejects.toBe(failure);
      await telemetry.bufferMobileTelemetryEvent(event("second"));
      const enqueue = jest.fn(async (_events: any[]) => undefined);
      expect(await telemetry.flushMobileTelemetryEvents({ enqueue })).toBe(2);
      expect(enqueue.mock.calls[0][0].map((e: any) => e.event_type)).toEqual(["first", "second"]);
    } finally { restore(); }
  });
  test("simultaneous flushes enqueue the snapshot once", async () => {
    const { telemetry, restore } = setup();
    try {
      await telemetry.bufferMobileTelemetryEvent(event("once"));
      const enqueue = jest.fn(async (_events: any[]) => undefined);
      expect(await Promise.all([
        telemetry.flushMobileTelemetryEvents({ enqueue }),
        telemetry.flushMobileTelemetryEvents({ enqueue }),
      ])).toEqual([1, 0]);
      expect(enqueue).toHaveBeenCalledTimes(1);
    } finally { restore(); }
  });
  test("concurrent overflow retains the newest fifty events in submission order", async () => {
    const { telemetry, restore } = setup();
    try {
      const names = Array.from({ length: 60 }, (_, i) => "event-" + i);
      await Promise.all(names.map(name => telemetry.bufferMobileTelemetryEvent(event(name))));
      const enqueue = jest.fn(async (_events: any[]) => undefined);
      expect(await telemetry.flushMobileTelemetryEvents({ enqueue })).toBe(50);
      expect(enqueue.mock.calls[0][0].map((e: any) => e.event_type)).toEqual(names.slice(-50));
    } finally { restore(); }
  });
});

describe("mobile telemetry storage", () => {
  const originalNodeEnv = process.env.NODE_ENV;
  const originalWorkerId = process.env.JEST_WORKER_ID;

  beforeEach(() => {
    jest.resetModules();
    delete (globalThis as any).window;
    process.env.NODE_ENV = originalNodeEnv;
    process.env.JEST_WORKER_ID = originalWorkerId;
  });

  afterAll(() => {
    process.env.NODE_ENV = originalNodeEnv;
    process.env.JEST_WORKER_ID = originalWorkerId;
  });

  test("buffers and flushes telemetry events via web localStorage when available", async () => {
    const { localStorage } = installWebLocalStorage();
    const telemetry = loadTelemetryModule();

    await telemetry.bufferMobileTelemetryEvent({
      event_type: "mobile.debug_failure",
      captured_at: "2026-02-15T00:00:00.000Z",
      metadata: { message: "oops" },
    });

    expect(localStorage.getItem("fieldops_telemetry_events_v1")).toContain("mobile.debug_failure");

    const enqueue = jest.fn(async (_events: any[]) => undefined);
    const flushed = await telemetry.flushMobileTelemetryEvents({ enqueue });

    expect(flushed).toBe(1);
    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(enqueue.mock.calls[0]?.[0]).toEqual([
      expect.objectContaining({
        event_type: "mobile.debug_failure",
        metadata: expect.objectContaining({ message: "oops" }),
      }),
    ]);

    expect(localStorage.getItem("fieldops_telemetry_events_v1")).toBeNull();
    expect(await telemetry.flushMobileTelemetryEvents({ enqueue })).toBe(0);
  });

  test("drops invalid events and truncates oversized metadata", async () => {
    const { localStorage } = installWebLocalStorage();
    const telemetry = loadTelemetryModule();

    await telemetry.bufferMobileTelemetryEvent({
      event_type: "",
      captured_at: "2026-03-04T00:00:00.000Z",
      metadata: { ignored: true },
    } as any);

    await telemetry.bufferMobileTelemetryEvent({
      event_type: "mobile.notice",
      captured_at: "2026-03-04T00:00:00.000Z",
      metadata: {
        message: "x".repeat(5000),
        authorization: "Bearer super-secret-token",
        ["k".repeat(150)]: "value",
      },
    });

    const raw = String(localStorage.getItem("fieldops_telemetry_events_v1") || "[]");
    const parsed = JSON.parse(raw);
    expect(parsed).toHaveLength(1);
    expect(parsed[0]?.event_type).toBe("mobile.notice");
    expect(String(parsed[0]?.metadata?.message || "").length).toBe(4000);
    expect(parsed[0]?.metadata?.authorization).toBe("Bearer super-secret-token");
    expect(Object.keys(parsed[0]?.metadata || {})).not.toContain("k".repeat(150));
  });

  test("caps telemetry queue at 50 events", async () => {
    const { localStorage } = installWebLocalStorage();
    const telemetry = loadTelemetryModule();

    for (let index = 0; index < 60; index += 1) {
      await telemetry.bufferMobileTelemetryEvent({
        event_type: `evt_${index}`,
        captured_at: new Date(1700000000000 + index * 1000).toISOString(),
        metadata: { index },
      });
    }

    const parsed = JSON.parse(String(localStorage.getItem("fieldops_telemetry_events_v1") || "[]"));
    expect(parsed).toHaveLength(50);
    expect(parsed[0]?.event_type).toBe("evt_10");
    expect(parsed[49]?.event_type).toBe("evt_59");
  });

  test("uses in-memory storage during test runtime when web storage is unavailable", async () => {
    const telemetry = loadTelemetryModule();

    await telemetry.bufferMobileTelemetryEvent({
      event_type: "mobile.notice",
      captured_at: "2026-02-15T00:00:00.000Z",
      metadata: { ok: true },
    });

    const enqueue = jest.fn(async (_events: any[]) => undefined);
    expect(await telemetry.flushMobileTelemetryEvents({ enqueue })).toBe(1);
    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(await telemetry.flushMobileTelemetryEvents({ enqueue })).toBe(0);

    await telemetry.clearMobileTelemetryEvents();
    expect(await telemetry.flushMobileTelemetryEvents({ enqueue })).toBe(0);
  });

  test("uses expo-secure-store path when not in test runtime", async () => {
    process.env.JEST_WORKER_ID = "";
    process.env.NODE_ENV = "production";

    const secureState = new Map<string, string>();
    const secureStore = {
      getItemAsync: jest.fn(async (key: string) => secureState.get(key) ?? null),
      setItemAsync: jest.fn(async (key: string, value: string) => {
        secureState.set(key, value);
      }),
      deleteItemAsync: jest.fn(async (key: string) => {
        secureState.delete(key);
      }),
    };

    jest.doMock("expo-secure-store", () => secureStore, { virtual: true });

    const telemetry = loadTelemetryModule();

    await telemetry.bufferMobileTelemetryEvent({
      event_type: "mobile.secure",
      captured_at: "2026-03-04T00:00:00.000Z",
      metadata: { source: "secure" },
    });

    expect(secureStore.setItemAsync).toHaveBeenCalledTimes(1);
    const enqueue = jest.fn(async (_events: any[]) => undefined);
    expect(await telemetry.flushMobileTelemetryEvents({ enqueue })).toBe(1);
    expect(secureStore.deleteItemAsync).toHaveBeenCalledTimes(1);
  });

  test("keeps events when enqueue throws during flush", async () => {
    const { localStorage } = installWebLocalStorage();
    const telemetry = loadTelemetryModule();

    await telemetry.bufferMobileTelemetryEvent({
      event_type: "mobile.flush_error",
      captured_at: "2026-03-04T00:00:00.000Z",
      metadata: { id: 1 },
    });

    await expect(
      telemetry.flushMobileTelemetryEvents({
        enqueue: async () => {
          throw new Error("upstream down");
        },
      }),
    ).rejects.toThrow("upstream down");

    const persisted = JSON.parse(String(localStorage.getItem("fieldops_telemetry_events_v1") || "[]"));
    expect(persisted).toHaveLength(1);
  });

  test("falls back safely when window localStorage accessor throws", async () => {
    Object.defineProperty(globalThis as any, "window", {
      configurable: true,
      get() {
        throw new Error("window denied");
      },
    });

    const telemetry = loadTelemetryModule();
    const enqueue = jest.fn(async (_events: any[]) => undefined);

    await telemetry.bufferMobileTelemetryEvent({
      event_type: "mobile.localstorage.failure",
      captured_at: "2026-03-04T00:00:00.000Z",
      metadata: { ok: true },
    });
    expect(await telemetry.flushMobileTelemetryEvents({ enqueue })).toBe(1);
  });

  test("ignores secure-store module when contract is incomplete", async () => {
    process.env.JEST_WORKER_ID = "";
    process.env.NODE_ENV = "production";

    jest.doMock("expo-secure-store", () => ({
      getItemAsync: jest.fn(async () => null),
    }), { virtual: true });

    const telemetry = loadTelemetryModule();
    await telemetry.bufferMobileTelemetryEvent({
      event_type: "mobile.partial_secure_store",
      captured_at: "2026-03-04T00:00:00.000Z",
      metadata: { ok: true },
    });

    const enqueue = jest.fn(async (_events: any[]) => undefined);
    expect(await telemetry.flushMobileTelemetryEvents({ enqueue })).toBe(0);
  });

  test("normalizes malformed payload shapes and non-string metadata", async () => {
    const { localStorage } = installWebLocalStorage();
    const telemetry = loadTelemetryModule();

    localStorage.setItem("fieldops_telemetry_events_v1", JSON.stringify({ invalid: true }));
    const enqueue = jest.fn(async (_events: any[]) => undefined);
    expect(await telemetry.flushMobileTelemetryEvents({ enqueue })).toBe(0);

    await telemetry.bufferMobileTelemetryEvent({
      event_type: "mobile.normalize",
      captured_at: 123 as any,
      metadata: {
        "": "empty-key",
        nested: { ok: true },
        flags: ["a", "b"],
      } as any,
    });
    await telemetry.bufferMobileTelemetryEvent({
      event_type: 999 as any,
      captured_at: "2026-03-04T00:00:00.000Z",
      metadata: { ignored: true },
    });

    const raw = JSON.parse(String(localStorage.getItem("fieldops_telemetry_events_v1") || "[]"));
    expect(raw).toHaveLength(1);
    expect(raw[0]?.captured_at).toMatch(/^20/);
    expect(raw[0]?.metadata?.nested).toEqual({ ok: true });
    expect(raw[0]?.metadata?.flags).toEqual(["a", "b"]);
    expect(Object.keys(raw[0]?.metadata || {})).not.toContain("");
  });
});
