"use client";

import * as React from "react";

type LayoutMode = "full" | "contained";

type NavigationState = {
  favorites: string[];
  recents: string[];
  sidebarCollapsed: boolean;
  collapsedSections: string[];
  layoutMode: LayoutMode;
};

type NavigationStateOptions = {
  storageKey: string;
  legacyStorageKey?: string;
  maxFavorites: number;
  maxRecents: number;
  defaultSidebarCollapsed: boolean;
  defaultCollapsedSections: string[];
  defaultLayoutMode: LayoutMode;
  layoutModeOptions?: LayoutMode[];
};

type NavigationStateValue = NavigationState & {
  hydrated: boolean;
  toggleFavorite: (itemId: string) => void;
  recordRecent: (itemId: string) => void;
  setSidebarCollapsed: (value: boolean) => void;
  toggleSidebarCollapsed: () => void;
  setCollapsedSections: (sectionIds: string[]) => void;
  toggleSectionCollapsed: (sectionId: string) => void;
  setLayoutMode: (mode: LayoutMode) => void;
  toggleLayoutMode: () => void;
};

type NavigationStateProviderProps = NavigationStateOptions & {
  children: React.ReactNode;
};

const NAVIGATION_STATE_VERSION = 2;

const EMPTY_STATE: NavigationState = {
  favorites: [],
  recents: [],
  sidebarCollapsed: false,
  collapsedSections: [],
  layoutMode: "full",
};

const DEFAULT_LAYOUT_MODES: LayoutMode[] = ["full", "contained"];

const NavigationStateContext = React.createContext<NavigationStateValue | null>(
  null
);

function normalizeIds(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const trimmed = value
    .filter((entry): entry is string => typeof entry === "string")
    .map((entry) => entry.trim())
    .filter(Boolean);
  return Array.from(new Set(trimmed));
}

function normalizeBoolean(value: unknown, fallback: boolean) {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (["true", "1", "yes", "on"].includes(normalized)) return true;
    if (["false", "0", "no", "off"].includes(normalized)) return false;
  }
  return fallback;
}

function normalizeLayoutMode(
  value: unknown,
  fallback: LayoutMode,
  options?: LayoutMode[]
) {
  const allowed =
    Array.isArray(options) && options.length > 0 ? options : DEFAULT_LAYOUT_MODES;
  const candidate =
    value === "full" || value === "contained" ? value : fallback;
  return allowed.includes(candidate) ? candidate : allowed[0] ?? fallback;
}

function normalizeLayoutModeOptions(options?: LayoutMode[]) {
  if (!Array.isArray(options)) return DEFAULT_LAYOUT_MODES;
  const normalized = options.filter(
    (value): value is LayoutMode => value === "full" || value === "contained"
  );
  const unique = Array.from(new Set(normalized));
  return unique.length > 0 ? unique : DEFAULT_LAYOUT_MODES;
}

function areStringArraysEqual(left: string[], right: string[]) {
  if (left.length !== right.length) return false;
  return left.every((value, index) => value === right[index]);
}

function areNavigationStatesEqual(left: NavigationState, right: NavigationState) {
  if (left.sidebarCollapsed !== right.sidebarCollapsed) return false;
  if (left.layoutMode !== right.layoutMode) return false;
  if (!areStringArraysEqual(left.favorites, right.favorites)) return false;
  if (!areStringArraysEqual(left.recents, right.recents)) return false;
  if (!areStringArraysEqual(left.collapsedSections, right.collapsedSections)) {
    return false;
  }
  return true;
}

function createDefaultState({
  defaultSidebarCollapsed,
  defaultCollapsedSections,
  defaultLayoutMode,
  layoutModeOptions,
}: Pick<
  NavigationStateOptions,
  "defaultSidebarCollapsed" | "defaultCollapsedSections" | "defaultLayoutMode" | "layoutModeOptions"
>): NavigationState {
  return {
    favorites: [],
    recents: [],
    sidebarCollapsed: defaultSidebarCollapsed,
    collapsedSections: normalizeIds(defaultCollapsedSections),
    layoutMode: normalizeLayoutMode(
      defaultLayoutMode,
      "full",
      layoutModeOptions
    ),
  };
}

function normalizeState(
  value: Record<string, unknown>,
  defaults: NavigationState,
  layoutModeOptions?: LayoutMode[]
): NavigationState {
  const favorites = normalizeIds(value.favorites);
  const recents = normalizeIds(value.recents);
  const collapsedSections = normalizeIds(value.collapsedSections);
  const hasCollapsedSections = Object.prototype.hasOwnProperty.call(
    value,
    "collapsedSections"
  );
  const layoutMode = normalizeLayoutMode(
    value.layoutMode,
    defaults.layoutMode,
    layoutModeOptions
  );
  return {
    favorites,
    recents,
    sidebarCollapsed: normalizeBoolean(
      value.sidebarCollapsed,
      defaults.sidebarCollapsed
    ),
    collapsedSections:
      hasCollapsedSections ? collapsedSections : defaults.collapsedSections,
    layoutMode,
  };
}

function readState(
  storageKey: string,
  legacyStorageKey: string | undefined,
  defaults: NavigationState,
  layoutModeOptions?: LayoutMode[]
) {
  if (typeof window === "undefined") {
    return defaults;
  }
  let raw: string | null;
  try {
    raw = window.localStorage.getItem(storageKey);
  } catch {
    return defaults;
  }
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      if (typeof parsed === "object" && parsed !== null) {
        return normalizeState(parsed, defaults, layoutModeOptions);
      }
    } catch {
      return defaults;
    }
  }
  if (legacyStorageKey) {
    let legacyRaw: string | null;
    try {
      legacyRaw = window.localStorage.getItem(legacyStorageKey);
    } catch {
      return defaults;
    }
    if (!legacyRaw) return defaults;
    try {
      const parsed = JSON.parse(legacyRaw) as Record<string, unknown>;
      if (typeof parsed === "object" && parsed !== null) {
        const next = normalizeState(parsed, defaults, layoutModeOptions);
        writeState(storageKey, next);
        return next;
      }
    } catch {
      return defaults;
    }
  }
  return defaults;
}

function writeState(storageKey: string, state: NavigationState) {
  if (typeof window === "undefined") return;
  const payload = {
    version: NAVIGATION_STATE_VERSION,
    ...state,
  };
  try {
    window.localStorage.setItem(storageKey, JSON.stringify(payload));
  } catch {
    // Preferences remain usable in memory when storage is blocked or full.
  }
}

export function buildLegacyNavigationStorageKey(
  appKey: string,
  userId?: string | null
) {
  const safeUserId = userId && userId.trim() ? userId.trim() : "anonymous";
  return `masarx:navigation:${appKey}:${safeUserId}`;
}

export function buildNavigationStorageKey(
  appKey: string,
  userId?: string | null
) {
  const safeUserId = userId && userId.trim() ? userId.trim() : "anonymous";
  return `masarx:navigation:v${NAVIGATION_STATE_VERSION}:${appKey}:${safeUserId}`;
}

function useNavigationStateInternal({
  storageKey,
  legacyStorageKey,
  maxFavorites,
  maxRecents,
  defaultSidebarCollapsed,
  defaultCollapsedSections,
  defaultLayoutMode,
  layoutModeOptions,
}: NavigationStateOptions): NavigationStateValue {
  const resolvedLayoutModeOptions = React.useMemo(
    () => normalizeLayoutModeOptions(layoutModeOptions),
    [layoutModeOptions]
  );
  const defaults = React.useMemo(
    () =>
      createDefaultState({
        defaultSidebarCollapsed,
        defaultCollapsedSections,
        defaultLayoutMode,
        layoutModeOptions: resolvedLayoutModeOptions,
      }),
    [
      defaultCollapsedSections,
      defaultLayoutMode,
      defaultSidebarCollapsed,
      resolvedLayoutModeOptions,
    ]
  );
  const [state, setState] = React.useState<NavigationState>(() => defaults);
  const [hydrated, setHydrated] = React.useState(false);

  React.useEffect(() => {
    const next = readState(
      storageKey,
      legacyStorageKey,
      defaults,
      resolvedLayoutModeOptions
    );
    setState((current) =>
      areNavigationStatesEqual(current, next) ? current : next
    );
    setHydrated(true);
  }, [defaults, legacyStorageKey, storageKey, resolvedLayoutModeOptions]);

  const updateState = React.useCallback(
    (updater: (current: NavigationState) => NavigationState) => {
      setState((current) => {
        const next = updater(current);
        if (areNavigationStatesEqual(current, next)) {
          return current;
        }
        writeState(storageKey, next);
        return next;
      });
    },
    [storageKey]
  );

  const toggleFavorite = React.useCallback(
    (itemId: string) => {
      if (!itemId || maxFavorites <= 0) return;
      updateState((current) => {
        const favorites = current.favorites.filter((id) => id !== itemId);
        const nextFavorites = current.favorites.includes(itemId)
          ? favorites
          : [itemId, ...favorites].slice(0, maxFavorites);
        return {
          ...current,
          favorites: nextFavorites,
        };
      });
    },
    [maxFavorites, updateState]
  );

  const recordRecent = React.useCallback(
    (itemId: string) => {
      if (!itemId || maxRecents <= 0) return;
      updateState((current) => {
        const recents = current.recents.filter((id) => id !== itemId);
        const nextRecents = [itemId, ...recents].slice(0, maxRecents);
        return {
          ...current,
          recents: nextRecents,
        };
      });
    },
    [maxRecents, updateState]
  );

  const setSidebarCollapsed = React.useCallback(
    (value: boolean) => {
      updateState((current) => ({
        ...current,
        sidebarCollapsed: value,
      }));
    },
    [updateState]
  );

  const toggleSidebarCollapsed = React.useCallback(() => {
    updateState((current) => ({
      ...current,
      sidebarCollapsed: !current.sidebarCollapsed,
    }));
  }, [updateState]);

  const setCollapsedSections = React.useCallback(
    (sectionIds: string[]) => {
      updateState((current) => ({
        ...current,
        collapsedSections: normalizeIds(sectionIds),
      }));
    },
    [updateState]
  );

  const toggleSectionCollapsed = React.useCallback(
    (sectionId: string) => {
      if (!sectionId) return;
      updateState((current) => {
        const next = new Set(current.collapsedSections);
        if (next.has(sectionId)) {
          next.delete(sectionId);
        } else {
          next.add(sectionId);
        }
        return {
          ...current,
          collapsedSections: Array.from(next),
        };
      });
    },
    [updateState]
  );

  const setLayoutMode = React.useCallback(
    (mode: LayoutMode) => {
      updateState((current) => ({
        ...current,
        layoutMode: normalizeLayoutMode(
          mode,
          current.layoutMode,
          resolvedLayoutModeOptions
        ),
      }));
    },
    [resolvedLayoutModeOptions, updateState]
  );

  const toggleLayoutMode = React.useCallback(() => {
    if (resolvedLayoutModeOptions.length < 2) return;
    updateState((current) => {
      const currentIndex = resolvedLayoutModeOptions.indexOf(current.layoutMode);
      const nextIndex =
        currentIndex === -1
          ? 0
          : (currentIndex + 1) % resolvedLayoutModeOptions.length;
      return {
        ...current,
        layoutMode:
          resolvedLayoutModeOptions[nextIndex] ?? current.layoutMode,
      };
    });
  }, [resolvedLayoutModeOptions, updateState]);

  return {
    ...state,
    hydrated,
    toggleFavorite,
    recordRecent,
    setSidebarCollapsed,
    toggleSidebarCollapsed,
    setCollapsedSections,
    toggleSectionCollapsed,
    setLayoutMode,
    toggleLayoutMode,
  };
}

export function NavigationStateProvider({
  children,
  ...options
}: NavigationStateProviderProps) {
  const value = useNavigationStateInternal(options);
  return React.createElement(
    NavigationStateContext.Provider,
    { value },
    children
  );
}

export function useNavigationState(
  options?: NavigationStateOptions
): NavigationStateValue {
  const context = React.useContext(NavigationStateContext);
  if (context) return context;
  if (!options) {
    throw new Error("NavigationStateProvider is missing required options.");
  }
  return useNavigationStateInternal(options);
}

export function useOptionalNavigationState(): NavigationStateValue | null {
  return React.useContext(NavigationStateContext);
}
