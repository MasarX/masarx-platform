import { Platform } from "react-native";

import type { MobileStorageAdapter } from "@masarx/auth/mobile";

type SecureStoreModule = {
  getItemAsync: (key: string) => Promise<string | null>;
  setItemAsync: (key: string, value: string) => Promise<void>;
  deleteItemAsync: (key: string) => Promise<void>;
};

let secureStorePromise: Promise<SecureStoreModule | null> | null = null;

async function loadSecureStore(): Promise<SecureStoreModule | null> {
  if (secureStorePromise) return secureStorePromise;
  secureStorePromise = (async () => {
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
  return secureStorePromise;
}

export function createFieldOpsStorage(): MobileStorageAdapter {
  if (Platform.OS === "web") {
    const memory = new Map<string, string>();
    const hasLocalStorage =
      typeof window !== "undefined" && typeof window.localStorage !== "undefined";

    return {
      getItem: async (key) => {
        try {
          if (hasLocalStorage) return window.localStorage.getItem(key);
        } catch {
          // Fall back to in-memory storage.
        }
        return memory.get(key) ?? null;
      },
      setItem: async (key, value) => {
        try {
          if (hasLocalStorage) {
            window.localStorage.setItem(key, value);
            return;
          }
        } catch {
          // Fall back to in-memory storage.
        }
        memory.set(key, value);
      },
      removeItem: async (key) => {
        try {
          if (hasLocalStorage) {
            window.localStorage.removeItem(key);
            return;
          }
        } catch {
          // Fall back to in-memory storage.
        }
        memory.delete(key);
      },
    };
  }

  const blockedKeys = new Set<string>();

  return {
    getItem: async (key) => {
      if (blockedKeys.has(key)) return null;
      const secureStore = await loadSecureStore();
      if (!secureStore) {
        blockedKeys.add(key);
        return null;
      }
      try {
        return await secureStore.getItemAsync(key);
      } catch {
        blockedKeys.add(key);
        return null;
      }
    },
    setItem: async (key, value) => {
      const secureStore = await loadSecureStore();
      if (!secureStore) {
        blockedKeys.add(key);
        return;
      }
      try {
        await secureStore.setItemAsync(key, value);
        blockedKeys.delete(key);
      } catch {
        blockedKeys.add(key);
      }
    },
    removeItem: async (key) => {
      const secureStore = await loadSecureStore();
      if (!secureStore) {
        blockedKeys.add(key);
        return;
      }
      try {
        await secureStore.deleteItemAsync(key);
        blockedKeys.delete(key);
      } catch {
        blockedKeys.add(key);
      }
    },
  };
}

