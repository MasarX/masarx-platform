import * as React from "react";
import { renderHook } from "@testing-library/react";

import {
  ThemeContext,
  ThemeProvider,
  useTheme,
  useThemedStyles,
  type ThemeContextValue,
} from "../../../apps/fieldops/src/mobile-theme-context";
import { getTokensForTheme, type ThemeTokens } from "../../../apps/fieldops/src/mobile-theme";

test("publishes the selected theme and recomputes styles when tokens change", () => {
  const setMode = jest.fn();
  const light: ThemeContextValue = {
    mode: "system",
    appliedTheme: "light",
    tokens: getTokensForTheme("light", "web"),
    setMode,
  };
  const dark: ThemeContextValue = {
    mode: "dark",
    appliedTheme: "dark",
    tokens: getTokensForTheme("dark", "web"),
    setMode,
  };
  let value = light;
  const factory = jest.fn((tokens: ThemeTokens) => ({ backgroundColor: tokens.color.pageBg }));
  function Wrapper({ children }: { children: React.ReactNode }) {
    return <ThemeProvider value={value}>{children}</ThemeProvider>;
  }

  const { result, rerender } = renderHook(
    () => ({ theme: useTheme(), style: useThemedStyles(factory) }),
    { wrapper: Wrapper },
  );
  expect(result.current.theme).toBe(light);
  const lightStyle = result.current.style;
  rerender();
  expect(result.current.style).toBe(lightStyle);
  expect(factory).toHaveBeenCalledTimes(1);
  result.current.theme.setMode("dark");
  expect(setMode).toHaveBeenCalledWith("dark");

  value = dark;
  rerender();
  expect(result.current.theme).toBe(dark);
  expect(result.current.style).toEqual({ backgroundColor: dark.tokens.color.pageBg });
  expect(result.current.style).not.toBe(lightStyle);
  expect(factory).toHaveBeenCalledTimes(2);
});

test("reports a missing provider to themed consumers", () => {
  expect(ThemeContext.displayName).toBe("FieldOpsThemeContext");
  expect(renderHook(() => React.useContext(ThemeContext)).result.current).toBeNull();
  expect(() => renderHook(useTheme)).toThrow(/must be called inside a <ThemeProvider>/);
});
