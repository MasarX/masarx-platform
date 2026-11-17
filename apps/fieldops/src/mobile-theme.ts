import type { MobileThemeMode } from "./mobile-shell-display";

export type AppliedFieldOpsTheme = "light" | "dark";
export type FieldOpsThemePlatform = "web" | "native";

export type FieldOpsThemeTokens = {
  color: {
    pageBg: string;
    viewportBg: string;
    cardBg: string;
    cardBgSubtle: string;
    border: string;
    borderMuted: string;
    text: string;
    textMuted: string;
    accent: string;
    accentSoft: string;
    accentText: string;
    success: string;
    successSoft: string;
    warning: string;
    warningSoft: string;
    danger: string;
    dangerSoft: string;
    overlayScrim: string;
  };
  radius: { sm: number; md: number; lg: number; pill: number };
  font: { sans: string | undefined; mono: string | undefined };
};

const PALETTES = {
  light: {
    pageBg: "#eef2f7",
    viewportBg: "#eceff5",
    cardBg: "#ffffff",
    cardBgSubtle: "#f8fafc",
    border: "#d6dde8",
    borderMuted: "#e3e8f0",
    text: "#0f172a",
    textMuted: "#4b5563",
    accent: "#0e7490",
    accentSoft: "#e0f2fe",
    accentText: "#ffffff",
    success: "#16a34a",
    successSoft: "#eaf7ef",
    warning: "#ca8a04",
    warningSoft: "#fff7db",
    danger: "#b91c1c",
    dangerSoft: "#fee2e2",
    overlayScrim: "rgba(15, 23, 42, 0.45)",
  },
  dark: {
    pageBg: "#0b1220",
    viewportBg: "#070d18",
    cardBg: "#101a2c",
    cardBgSubtle: "#162238",
    border: "#2b3a54",
    borderMuted: "#1f2d44",
    text: "#e2e8f0",
    textMuted: "#a8b5c7",
    accent: "#22c2d6",
    accentSoft: "#0f3645",
    accentText: "#06131c",
    success: "#4ade80",
    successSoft: "#0f2a1c",
    warning: "#facc15",
    warningSoft: "#3a2e0a",
    danger: "#f87171",
    dangerSoft: "#3a1414",
    overlayScrim: "rgba(2, 6, 23, 0.72)",
  },
} as const;

export function resolveAppliedFieldOpsTheme(
  mode: MobileThemeMode,
  systemScheme: "light" | "dark" | "unspecified" | null | undefined
): AppliedFieldOpsTheme {
  if (mode === "light" || mode === "dark") return mode;
  return systemScheme === "dark" ? "dark" : "light";
}

export function getFieldOpsThemeTokens(
  theme: AppliedFieldOpsTheme,
  platform: FieldOpsThemePlatform
): FieldOpsThemeTokens {
  return {
    color: PALETTES[theme],
    radius: { sm: 10, md: 14, lg: 18, pill: 999 },
    font: {
      sans: platform === "web" ? '"IBM Plex Sans", "Segoe UI", sans-serif' : undefined,
      mono:
        platform === "web"
          ? '"IBM Plex Mono", ui-monospace, SFMono-Regular, Menlo, monospace'
          : "monospace",
    },
  };
}
