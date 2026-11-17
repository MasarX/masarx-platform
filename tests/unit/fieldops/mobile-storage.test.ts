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
});
