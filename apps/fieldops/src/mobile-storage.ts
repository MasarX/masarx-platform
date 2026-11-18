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
    let memoryOnly = typeof window === "undefined";

    function browserStorage(): Storage | null {
      if (memoryOnly) return null;
      try {
        return window.localStorage ?? null;
      } catch {
        memoryOnly = true;
        return null;
      }
    }

    return {
      getItem: async (key) => {
        try {
          const storage = browserStorage();
          if (storage) {
            const value = storage.getItem(key);
            if (value === null) memory.delete(key);
            else memory.set(key, value);
            return value;
          }
        } catch {
          memoryOnly = true;
        }
        return memory.get(key) ?? null;
      },
      setItem: async (key, value) => {
        memory.set(key, value);
        try {
          browserStorage()?.setItem(key, value);
        } catch {
          // Keep this adapter in memory mode so stale persisted tokens cannot
          // replace a refreshed session after a failed write.
          memoryOnly = true;
        }
      },
      removeItem: async (key) => {
        memory.delete(key);
        try {
          browserStorage()?.removeItem(key);
        } catch {
          memoryOnly = true;
        }
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

