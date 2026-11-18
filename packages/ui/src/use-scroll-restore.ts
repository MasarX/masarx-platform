"use client";

import { useCallback, useEffect, useRef } from "react";

const STORAGE_PREFIX = "masarx:scroll:";

/**
 * Saves and restores scroll position for the given key.
 * Call `saveScroll()` before navigating away (e.g., when opening a detail).
 * On mount, restores the saved position and clears it.
 */
export function useScrollRestore(key: string) {
  const restoredRef = useRef(false);

  // Restore on mount (once)
  useEffect(() => {
    if (restoredRef.current) return;
    restoredRef.current = true;
    if (typeof window === "undefined") return;
    try {
      const raw = window.sessionStorage.getItem(`${STORAGE_PREFIX}${key}`);
      if (!raw) return;
      const scrollY = Number(raw);
      if (!Number.isFinite(scrollY) || scrollY <= 0) return;
      // Use requestAnimationFrame to wait for layout
      requestAnimationFrame(() => {
        window.scrollTo({ top: scrollY, behavior: "instant" as ScrollBehavior });
      });
      window.sessionStorage.removeItem(`${STORAGE_PREFIX}${key}`);
    } catch {
      // ignore
    }
  }, [key]);

  const saveScroll = useCallback(() => {
    if (typeof window === "undefined") return;
    try {
      window.sessionStorage.setItem(
        `${STORAGE_PREFIX}${key}`,
        String(window.scrollY),
      );
    } catch {
      // ignore
    }
  }, [key]);

  return { saveScroll };
}
