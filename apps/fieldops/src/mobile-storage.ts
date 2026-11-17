import * as SecureStore from "expo-secure-store";
import { Platform } from "react-native";

import type { MobileStorageAdapter } from "@masarx/auth/mobile";

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

  return {
    getItem: (key) => SecureStore.getItemAsync(key),
    setItem: (key, value) => SecureStore.setItemAsync(key, value),
    removeItem: (key) => SecureStore.deleteItemAsync(key),
  };
}

