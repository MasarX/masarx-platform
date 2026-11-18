describe("mobile storage adapter", () => {
  const originalWindow = (globalThis as { window?: unknown }).window;

  afterEach(() => {
    jest.resetModules();
    if (typeof originalWindow === "undefined") {
      delete (globalThis as { window?: unknown }).window;
    } else {
      (globalThis as { window?: unknown }).window = originalWindow;
    }
  });

  test("uses browser localStorage on web when available", async () => {
    const localStorage = {
      getItem: jest.fn((key: string) => (key === "token" ? "abc" : null)),
      setItem: jest.fn(),
      removeItem: jest.fn(),
    };
    (globalThis as { window?: unknown }).window = { localStorage };

    jest.doMock("react-native", () => ({ Platform: { OS: "web" } }), { virtual: true });
    jest.doMock("expo-secure-store", () => ({
      getItemAsync: jest.fn(),
      setItemAsync: jest.fn(),
      deleteItemAsync: jest.fn(),
    }), { virtual: true });

    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { createFieldOpsStorage } = require("../../../apps/fieldops/src/mobile-storage");

    const storage = createFieldOpsStorage();
    expect(await storage.getItem("token")).toBe("abc");

    await storage.setItem("token", "next");
    await storage.removeItem("token");

    expect(localStorage.getItem).toHaveBeenCalledWith("token");
    expect(localStorage.setItem).toHaveBeenCalledWith("token", "next");
    expect(localStorage.removeItem).toHaveBeenCalledWith("token");
  });

  test("falls back to in-memory storage on web when localStorage throws", async () => {
    const localStorage = {
      getItem: jest.fn(() => {
        throw new Error("blocked");
      }),
      setItem: jest.fn(() => {
        throw new Error("blocked");
      }),
      removeItem: jest.fn(() => {
        throw new Error("blocked");
      }),
    };
    (globalThis as { window?: unknown }).window = { localStorage };

    jest.doMock("react-native", () => ({ Platform: { OS: "web" } }), { virtual: true });
    jest.doMock("expo-secure-store", () => ({
      getItemAsync: jest.fn(),
      setItemAsync: jest.fn(),
      deleteItemAsync: jest.fn(),
    }), { virtual: true });

    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { createFieldOpsStorage } = require("../../../apps/fieldops/src/mobile-storage");

    const storage = createFieldOpsStorage();
    await storage.setItem("key", "value");
    expect(await storage.getItem("key")).toBe("value");
    await storage.removeItem("key");
    expect(await storage.getItem("key")).toBeNull();
  });

  test("uses SecureStore on native platforms", async () => {
    const secureStore = {
      getItemAsync: jest.fn(async (key: string) => `${key}-value`),
      setItemAsync: jest.fn(async () => undefined),
      deleteItemAsync: jest.fn(async () => undefined),
    };
    jest.doMock("react-native", () => ({ Platform: { OS: "ios" } }), { virtual: true });
    jest.doMock("expo-secure-store", () => secureStore, { virtual: true });

    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { createFieldOpsStorage } = require("../../../apps/fieldops/src/mobile-storage");

    const storage = createFieldOpsStorage();
    expect(await storage.getItem("native-key")).toBe("native-key-value");
    await storage.setItem("native-key", "x");
    await storage.removeItem("native-key");

    expect(secureStore.getItemAsync).toHaveBeenCalledWith("native-key");
    expect(secureStore.setItemAsync).toHaveBeenCalledWith("native-key", "x");
    expect(secureStore.deleteItemAsync).toHaveBeenCalledWith("native-key");
  });

  test("works when the browser denies access to the localStorage property", async () => {
    (globalThis as { window?: unknown }).window = Object.defineProperty({}, "localStorage", {
      get() { throw new Error("SecurityError"); },
    });
    jest.doMock("react-native", () => ({ Platform: { OS: "web" } }), { virtual: true });
    jest.doMock("expo-secure-store", () => ({}), { virtual: true });
    const { createFieldOpsStorage } = require("../../../apps/fieldops/src/mobile-storage");

    const storage = createFieldOpsStorage();
    await storage.setItem("token", "current");
    expect(await storage.getItem("token")).toBe("current");
    await storage.removeItem("token");
    expect(await storage.getItem("token")).toBeNull();
  });

  test("does not restore an old session when a refresh write exceeds storage quota", async () => {
    const localStorage = {
      getItem: jest.fn(() => "old-session"),
      setItem: jest.fn(() => { throw new Error("QuotaExceededError"); }),
      removeItem: jest.fn(),
    };
    (globalThis as { window?: unknown }).window = { localStorage };
    jest.doMock("react-native", () => ({ Platform: { OS: "web" } }), { virtual: true });
    jest.doMock("expo-secure-store", () => ({}), { virtual: true });
    const { createFieldOpsStorage } = require("../../../apps/fieldops/src/mobile-storage");

    const storage = createFieldOpsStorage();
    expect(await storage.getItem("token")).toBe("old-session");
    await storage.setItem("token", "refreshed-session");
    expect(await storage.getItem("token")).toBe("refreshed-session");
    await storage.removeItem("token");
    expect(await storage.getItem("token")).toBeNull();
    expect(localStorage.getItem).toHaveBeenCalledTimes(1);
  });

  test("does not restore a signed-out session after browser removal fails", async () => {
    const localStorage = {
      getItem: jest.fn(() => "old-session"),
      setItem: jest.fn(),
      removeItem: jest.fn(() => { throw new Error("blocked"); }),
    };
    (globalThis as { window?: unknown }).window = { localStorage };
    jest.doMock("react-native", () => ({ Platform: { OS: "web" } }), { virtual: true });
    jest.doMock("expo-secure-store", () => ({}), { virtual: true });
    const { createFieldOpsStorage } = require("../../../apps/fieldops/src/mobile-storage");

    const storage = createFieldOpsStorage();
    expect(await storage.getItem("token")).toBe("old-session");
    await storage.removeItem("token");
    expect(await storage.getItem("token")).toBeNull();
  });

  test("fails closed on native when SecureStore methods fail", async () => {
    const secureStore = {
      getItemAsync: jest.fn(async () => {
        throw new Error("native module unavailable");
      }),
      setItemAsync: jest.fn(async () => {
        throw new Error("native module unavailable");
      }),
      deleteItemAsync: jest.fn(async () => {
        throw new Error("native module unavailable");
      }),
    };
    jest.doMock("react-native", () => ({ Platform: { OS: "android" } }), { virtual: true });
    jest.doMock("expo-secure-store", () => secureStore, { virtual: true });

    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { createFieldOpsStorage } = require("../../../apps/fieldops/src/mobile-storage");

    const storage = createFieldOpsStorage();
    await storage.setItem("native-key", "fallback");
    expect(await storage.getItem("native-key")).toBeNull();
    await storage.removeItem("native-key");
    expect(await storage.getItem("native-key")).toBeNull();
  });

  test("fails closed when SecureStore module is unavailable", async () => {
    jest.doMock("react-native", () => ({ Platform: { OS: "android" } }), { virtual: true });
    jest.doMock("expo-secure-store", () => ({}), { virtual: true });

    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { createFieldOpsStorage } = require("../../../apps/fieldops/src/mobile-storage");

    const storage = createFieldOpsStorage();
    await storage.setItem("native-key", "value");
    expect(await storage.getItem("native-key")).toBeNull();
    await storage.removeItem("native-key");
    expect(await storage.getItem("native-key")).toBeNull();
  });

  test("does not surface stale stored values after a failed auth token save", async () => {
    const persisted = new Map<string, string>([["sb-demo-auth-token", "stale-token"]]);
    const secureStore = {
      getItemAsync: jest.fn(async (key: string) => persisted.get(key) ?? null),
      setItemAsync: jest.fn(async () => {
        throw new Error("write failed");
      }),
      deleteItemAsync: jest.fn(async () => undefined),
    };
    jest.doMock("react-native", () => ({ Platform: { OS: "android" } }), { virtual: true });
    jest.doMock("expo-secure-store", () => secureStore, { virtual: true });

    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { createFieldOpsStorage } = require("../../../apps/fieldops/src/mobile-storage");

    const storage = createFieldOpsStorage();
    expect(await storage.getItem("sb-demo-auth-token")).toBe("stale-token");
    await storage.setItem("sb-demo-auth-token", "fresh-token");
    expect(await storage.getItem("sb-demo-auth-token")).toBeNull();
  });

  test("does not surface stale stored values after a failed auth token delete", async () => {
    const persisted = new Map<string, string>([["sb-demo-auth-token", "stale-token"]]);
    const secureStore = {
      getItemAsync: jest.fn(async (key: string) => persisted.get(key) ?? null),
      setItemAsync: jest.fn(async () => undefined),
      deleteItemAsync: jest.fn(async () => {
        throw new Error("delete failed");
      }),
    };
    jest.doMock("react-native", () => ({ Platform: { OS: "android" } }), { virtual: true });
    jest.doMock("expo-secure-store", () => secureStore, { virtual: true });

    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { createFieldOpsStorage } = require("../../../apps/fieldops/src/mobile-storage");

    const storage = createFieldOpsStorage();
    expect(await storage.getItem("sb-demo-auth-token")).toBe("stale-token");
    await storage.removeItem("sb-demo-auth-token");
    expect(await storage.getItem("sb-demo-auth-token")).toBeNull();
  });

  test("persists native values across adapter recreation when SecureStore succeeds", async () => {
    const persisted = new Map<string, string>();
    const secureStore = {
      getItemAsync: jest.fn(async (key: string) => persisted.get(key) ?? null),
      setItemAsync: jest.fn(async (key: string, value: string) => {
        persisted.set(key, value);
      }),
      deleteItemAsync: jest.fn(async (key: string) => {
        persisted.delete(key);
      }),
    };
    jest.doMock("react-native", () => ({ Platform: { OS: "android" } }), { virtual: true });
    jest.doMock("expo-secure-store", () => secureStore, { virtual: true });

    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const firstLoad = require("../../../apps/fieldops/src/mobile-storage");
    const firstStorage = firstLoad.createFieldOpsStorage();
    await firstStorage.setItem("fieldops_device_id_v1", "device-123");

    jest.resetModules();
    jest.doMock("react-native", () => ({ Platform: { OS: "android" } }), { virtual: true });
    jest.doMock("expo-secure-store", () => secureStore, { virtual: true });

    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const secondLoad = require("../../../apps/fieldops/src/mobile-storage");
    const secondStorage = secondLoad.createFieldOpsStorage();
    expect(await secondStorage.getItem("fieldops_device_id_v1")).toBe("device-123");
  });
});
