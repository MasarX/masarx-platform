const STORAGE_PREFIX = "detail-mode";
export const DETAIL_OPEN_MODE_CHANGE_EVENT = "masarx:detail-open-mode-change";

export type DetailOpenModeChangeDetail = {
  resourceKey: string;
  mode: string;
};

function getDetailOpenModeStorageKey(resourceKey: string) {
  return `${STORAGE_PREFIX}:${resourceKey}`;
}

/**
 * Read persisted detail open mode for a resource.
 */
export function readDetailOpenMode(resourceKey: string): string | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage.getItem(getDetailOpenModeStorageKey(resourceKey)) ?? null;
  } catch {
    return null;
  }
}

/**
 * Persist detail open mode for a resource.
 */
export function persistDetailOpenMode(
  resourceKey: string,
  mode: string,
  options?: { broadcast?: boolean }
) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(getDetailOpenModeStorageKey(resourceKey), mode);
  } catch {
    // ignore storage failures
  }
  if (options?.broadcast === false) return;
  window.dispatchEvent(
    new CustomEvent<DetailOpenModeChangeDetail>(DETAIL_OPEN_MODE_CHANGE_EVENT, {
      detail: { resourceKey, mode },
    })
  );
}

export function subscribeDetailOpenModeChange(
  resourceKey: string,
  listener: (mode: string) => void
) {
  if (typeof window === "undefined") {
    return () => undefined;
  }

  const storageKey = getDetailOpenModeStorageKey(resourceKey);
  const handleCustomEvent = (event: Event) => {
    const detail = (event as CustomEvent<DetailOpenModeChangeDetail>).detail;
    if (!detail || detail.resourceKey !== resourceKey) return;
    listener(detail.mode);
  };
  const handleStorageEvent = (event: StorageEvent) => {
    if (event.storageArea !== window.localStorage) return;
    if (event.key !== storageKey) return;
    if (typeof event.newValue !== "string" || event.newValue.length === 0) return;
    listener(event.newValue);
  };

  window.addEventListener(DETAIL_OPEN_MODE_CHANGE_EVENT, handleCustomEvent);
  window.addEventListener("storage", handleStorageEvent);
  return () => {
    window.removeEventListener(DETAIL_OPEN_MODE_CHANGE_EVENT, handleCustomEvent);
    window.removeEventListener("storage", handleStorageEvent);
  };
}
