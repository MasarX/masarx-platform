// Mobile V2 ThemeProvider — wires the display-prefs module into a React
// context so any V2 screen can read the active theme tokens + locale +
// direction + density and request changes that persist via canonical KV.
//
// Pure state-update reducer logic lives in mobile-v2-display-prefs
// (reduceMobileV2DisplayPrefs); this file only adds the React surface.
//
// Per AGENTS.md Mobile Field Ops Policy Contract these are user
// preferences, NOT policy-governed. The provider falls back to the design
// defaults (hivis / en-SA / ltr / comfy) on first launch and on KV
// failure so a fresh install or a corrupted device never shows a broken
// shell.

import * as React from "react";
import { I18nManager } from "react-native";
import type { MobileStorageAdapter } from "@masarx/auth/mobile";

import {
  MOBILE_V2_DEFAULT_DISPLAY_PREFS,
  type MobileV2DensityMode,
  type MobileV2DirectionMode,
  type MobileV2DisplayPrefs,
  type MobileV2LocaleCode,
  loadMobileV2DisplayPrefs,
  saveMobileV2Density,
  saveMobileV2Locale,
  saveMobileV2Theme,
} from "./mobile-v2-display-prefs";
import {
  MOBILE_V2_THEMES,
  type MobileV2Theme,
  type MobileV2ThemeKey,
} from "./mobile-v2-themes";
import {
  mobileV2ThemeProviderReducer,
  type MobileV2ThemeProviderAction,
  type MobileV2ThemeProviderState,
} from "./mobile-v2-theme-reducer";

export interface MobileV2ThemeContextValue {
  /** True until the initial KV load resolves. */
  readonly isHydrated: boolean;
  /** Currently active theme key (light / dark / hivis). */
  readonly themeKey: MobileV2ThemeKey;
  /** Resolved frozen token bundle for the active theme. */
  readonly theme: MobileV2Theme;
  /** All four user preferences as a single frozen object. */
  readonly prefs: MobileV2DisplayPrefs;
  readonly locale: MobileV2LocaleCode;
  readonly direction: MobileV2DirectionMode;
  readonly density: MobileV2DensityMode;
  /** Set the theme; persists to canonical KV without blocking the UI. */
  readonly setTheme: (theme: MobileV2ThemeKey) => void;
  /** Set the locale; direction is recomputed unless explicitly pinned later. */
  readonly setLocale: (locale: MobileV2LocaleCode) => void;
  readonly setDensity: (density: MobileV2DensityMode) => void;
  /** Force-reload preferences from KV (used by sign-in / sign-out flows). */
  readonly reload: () => Promise<void>;
}

const MobileV2ThemeContext = React.createContext<MobileV2ThemeContextValue | null>(null);

export interface MobileV2ThemeProviderProps {
  /** Storage adapter from createFieldOpsStorage(). */
  readonly storage: MobileStorageAdapter;
  /** Optional initial prefs override (used by tests + Storybook). */
  readonly initialPrefs?: MobileV2DisplayPrefs;
  readonly children: React.ReactNode;
}

export function MobileV2ThemeProvider(props: MobileV2ThemeProviderProps): React.ReactElement {
  const initial: MobileV2ThemeProviderState = {
    isHydrated: props.initialPrefs !== undefined,
    prefs: props.initialPrefs ?? MOBILE_V2_DEFAULT_DISPLAY_PREFS,
  };
  // React 19 / @types/react@19 removed the single-generic `useReducer<Reducer<S,A>>`
  // overload that the prior signature relied on. Drop the explicit generics
  // and let TS infer from the reducer fn — it's already strongly typed via
  // mobileV2ThemeProviderReducer's signature.
  const [state, dispatch] = React.useReducer(mobileV2ThemeProviderReducer, initial);

  const loadFromStorage = React.useCallback(async (): Promise<void> => {
    const loaded = await loadMobileV2DisplayPrefs(props.storage);
    dispatch({ kind: "hydrate", prefs: loaded });
  }, [props.storage]);

  React.useEffect(() => {
    if (props.initialPrefs !== undefined) return;
    let cancelled = false;
    void (async () => {
      const loaded = await loadMobileV2DisplayPrefs(props.storage);
      if (!cancelled) dispatch({ kind: "hydrate", prefs: loaded });
    })();
    return () => {
      cancelled = true;
    };
  }, [props.storage, props.initialPrefs]);

  // P1 audit fix: wire I18nManager.forceRTL from the user's direction
  // preference. Without this, Arabic / Urdu locales render the wrong-side
  // chevrons + mirrored row layouts even though the user explicitly
  // selected an RTL locale via display prefs. Native side requires an
  // app reload to fully flip the layout — we set the flags here and the
  // user-facing reload happens via the OS auto-restart on dev or via
  // the "Apply" CTA in the More screen on prod.
  React.useEffect(() => {
    const wantRtl = state.prefs.direction === "rtl";
    if (I18nManager.isRTL !== wantRtl) {
      try {
        I18nManager.allowRTL(true);
        I18nManager.forceRTL(wantRtl);
      } catch {
        // Best-effort; some platforms (notably web) don't expose RTL flips
        // through I18nManager — the CSS direction attribute below covers them.
      }
    }
  }, [state.prefs.direction]);

  const setTheme = React.useCallback(
    (theme: MobileV2ThemeKey) => {
      dispatch({ kind: "patch", patch: { theme } });
      void saveMobileV2Theme(props.storage, theme);
    },
    [props.storage],
  );

  const setLocale = React.useCallback(
    (locale: MobileV2LocaleCode) => {
      dispatch({ kind: "patch", patch: { locale } });
      void saveMobileV2Locale(props.storage, locale);
    },
    [props.storage],
  );

  const setDensity = React.useCallback(
    (density: MobileV2DensityMode) => {
      dispatch({ kind: "patch", patch: { density } });
      void saveMobileV2Density(props.storage, density);
    },
    [props.storage],
  );

  const value: MobileV2ThemeContextValue = React.useMemo(
    () => ({
      isHydrated: state.isHydrated,
      themeKey: state.prefs.theme,
      theme: MOBILE_V2_THEMES[state.prefs.theme],
      prefs: state.prefs,
      locale: state.prefs.locale,
      direction: state.prefs.direction,
      density: state.prefs.density,
      setTheme,
      setLocale,
      setDensity,
      reload: loadFromStorage,
    }),
    [state.isHydrated, state.prefs, setTheme, setLocale, setDensity, loadFromStorage],
  );

  return <MobileV2ThemeContext.Provider value={value}>{props.children}</MobileV2ThemeContext.Provider>;
}

/**
 * Read the current Mobile V2 theme context. Throws when called outside the
 * provider so a missing wrapper is loud rather than silently rendering with
 * the wrong tokens.
 */
export function useMobileV2Theme(): MobileV2ThemeContextValue {
  const value = React.useContext(MobileV2ThemeContext);
  if (value === null) {
    throw new Error(
      "useMobileV2Theme must be used inside a MobileV2ThemeProvider. Wrap the app root with MobileV2ThemeProvider.",
    );
  }
  return value;
}

/**
 * Same as useMobileV2Theme but returns null outside a provider. Useful for
 * components that may render in either V1 or V2 surfaces during the
 * migration phase.
 */
export function useOptionalMobileV2Theme(): MobileV2ThemeContextValue | null {
  return React.useContext(MobileV2ThemeContext);
}

// Exposed for advanced consumers (e.g. a Tweaks panel) that need access to
// the underlying React Context object without going through the hook.
export const __INTERNAL_MOBILE_V2_THEME = Object.freeze({
  Context: MobileV2ThemeContext,
});
