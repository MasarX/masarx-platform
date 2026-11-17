import * as SecureStore from "expo-secure-store";
import { Platform } from "react-native";

import type { MobileStorageAdapter } from "@masarx/auth/mobile";

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

  return {
    getItem: (key) => SecureStore.getItemAsync(key),
    setItem: (key, value) => SecureStore.setItemAsync(key, value),
    removeItem: (key) => SecureStore.deleteItemAsync(key),
  };
}

