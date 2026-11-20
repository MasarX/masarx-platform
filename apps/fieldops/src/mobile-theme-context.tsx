import * as React from "react";
import type { AppliedTheme, ThemeMode, ThemeTokens } from "./mobile-theme";

export type ThemeContextValue = {
  tokens: ThemeTokens;
  appliedTheme: AppliedTheme;
  mode: ThemeMode;
  setMode: (mode: ThemeMode) => void | Promise<void>;
};

export const ThemeContext = React.createContext<ThemeContextValue | null>(null);
ThemeContext.displayName = "FieldOpsThemeContext";

export type ThemeProviderProps = {
  value: ThemeContextValue;
  children: React.ReactNode;
};

export function ThemeProvider({ value, children }: ThemeProviderProps) {
  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeContextValue {
  const value = React.useContext(ThemeContext);
  if (value === null) {
    throw new Error("useTheme() must be called inside a <ThemeProvider> (mobile-theme-context).");
  }
  return value;
}

export function useThemedStyles<T>(factory: (tokens: ThemeTokens) => T): T {
  const { tokens } = useTheme();
  return React.useMemo(() => factory(tokens), [factory, tokens]);
}
