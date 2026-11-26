"use client";

import * as React from "react";

export type ThemeMode = "light" | "dark" | "system";
type ResolvedTheme = "light" | "dark";

type ThemeContextValue = {
  theme: ThemeMode;
  resolvedTheme: ResolvedTheme;
  setTheme: (theme: ThemeMode) => void;
  toggleTheme: () => void;
};

/** The one theme storage key every surface reads and writes. */
export const THEME_STORAGE_KEY = "masarx-ui-theme";
const THEME_ATTRIBUTE = "data-theme";

const ThemeContext = React.createContext<ThemeContextValue | null>(null);

function resolveSystemTheme(): ResolvedTheme {
  if (typeof window === "undefined" || !window.matchMedia) {
    return "light";
  }
  return window.matchMedia("(prefers-color-scheme: dark)").matches
    ? "dark"
    : "light";
}

function normalizeTheme(value: unknown): ThemeMode {
  if (value === "light" || value === "dark" || value === "system") return value;
  return "system";
}

function applyTheme(resolved: ResolvedTheme) {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  root.setAttribute(THEME_ATTRIBUTE, resolved);
  root.style.colorScheme = resolved;
}

function readStoredTheme(): ThemeMode {
  if (typeof window === "undefined") return "system";
  try {
    return normalizeTheme(localStorage.getItem(THEME_STORAGE_KEY));
  } catch {
    return "system";
  }
}

function persistTheme(theme: ThemeMode) {
  if (typeof window === "undefined") return;
  try {
    if (theme === "system") {
      localStorage.removeItem(THEME_STORAGE_KEY);
    } else {
      localStorage.setItem(THEME_STORAGE_KEY, theme);
    }
  } catch {
    // ignore storage failures
  }
}

/**
 * Theme provider that syncs system preference with stored overrides.
 */
export function ThemeProvider({ children }: { children?: React.ReactNode }) {
  // "system" first so server and client render alike; the stored choice loads after mount.
  const [theme, setThemeState] = React.useState<ThemeMode>("system");
  const [resolvedTheme, setResolvedTheme] =
    React.useState<ResolvedTheme>("light");

  React.useEffect(() => {
    setThemeState(readStoredTheme());
  }, []);

  React.useEffect(() => {
    const resolved = theme === "system" ? resolveSystemTheme() : theme;
    setResolvedTheme(resolved);
    applyTheme(resolved);
  }, [theme]);

  // Storage is written only on a user's choice, so a mount (or StrictMode remount)
  // never clears a stored theme before it has been read.
  const setTheme = React.useCallback((next: ThemeMode) => {
    persistTheme(next);
    setThemeState(next);
  }, []);

  React.useEffect(() => {
    if (theme !== "system" || typeof window === "undefined" || !window.matchMedia) {
      return;
    }
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const handleChange = () => {
      const resolved = resolveSystemTheme();
      setResolvedTheme(resolved);
      applyTheme(resolved);
    };
    if (media.addEventListener) {
      media.addEventListener("change", handleChange);
      return () => media.removeEventListener("change", handleChange);
    }
    media.addListener(handleChange);
    return () => media.removeListener(handleChange);
  }, [theme]);

  const toggleTheme = React.useCallback(() => {
    const current = theme === "system" ? resolvedTheme : theme;
    setTheme(current === "dark" ? "light" : "dark");
  }, [theme, resolvedTheme, setTheme]);

  const value = React.useMemo(
    () => ({ theme, resolvedTheme, setTheme, toggleTheme }),
    [theme, resolvedTheme, setTheme, toggleTheme]
  );

  return (
    <ThemeContext.Provider value={value}>
      {children ?? null}
    </ThemeContext.Provider>
  );
}

/**
 * Access theme state and toggle helpers.
 */
export function useTheme(): ThemeContextValue {
  const ctx = React.useContext(ThemeContext);
  if (ctx) return ctx;
  return {
    theme: "system",
    resolvedTheme: resolveSystemTheme(),
    setTheme: () => undefined,
    toggleTheme: () => undefined,
  };
}
