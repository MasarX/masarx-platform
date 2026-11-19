// Mobile V2 design tokens — ported from the Claude Design handoff bundle
// (project/screens/_kit.jsx) to TypeScript for the FieldOps RN runtime.
//
// Three theme variants are exposed (light, dark, hivis). All token names match
// the design source exactly so screen ports can copy/paste mappings without
// translation. Theme selection is a USER PREFERENCE persisted in canonical
// KV (per AGENTS.md Mobile Field Ops Policy Contract — display preferences
// are not policy-governed); resolve via mobile-v2-theme-context.

export type MobileV2ThemeKey = "light" | "dark" | "hivis";

export interface MobileV2Theme {
  /** Human-readable label surfaced in tweaks/diagnostics. */
  readonly name: string;
  /** Window background. */
  readonly bg: string;
  /** Default surface (cards, sheets, app bar background when not chrome). */
  readonly surface: string;
  /** Subtler surface variant (rows, alternating fills). */
  readonly surfaceAlt: string;
  /** Default border. */
  readonly border: string;
  /** Heavier border for emphasis (frame edges, sticky action divider). */
  readonly borderStrong: string;
  /** Primary text. */
  readonly ink: string;
  /** Secondary text (still high contrast). */
  readonly inkSoft: string;
  /** Muted/labelled-secondary. */
  readonly muted: string;
  /** Muted-soft (helper text, disabled). */
  readonly mutedSoft: string;
  /** Brand accent. */
  readonly accent: string;
  /** Soft tint of accent (chip backgrounds). */
  readonly accentSoft: string;
  /** Foreground that pairs with accent (button text on accent). */
  readonly accentInk: string;
  readonly success: string;
  readonly successSoft: string;
  readonly warning: string;
  readonly warningSoft: string;
  readonly danger: string;
  readonly dangerSoft: string;
  readonly info: string;
  readonly infoSoft: string;
  /** Map base color (faux SVG map; production map renderer ignores). */
  readonly mapBg: string;
  /** Route polyline color. */
  readonly mapRoute: string;
  /** Chrome surface (drawer header, accent app bars). */
  readonly chrome: string;
  /** Foreground that pairs with chrome. */
  readonly onChrome: string;
}

export const MOBILE_V2_THEMES: Readonly<Record<MobileV2ThemeKey, MobileV2Theme>> = Object.freeze({
  light: Object.freeze({
    name: "Field Light",
    bg: "#F7F7F5",
    surface: "#FFFFFF",
    surfaceAlt: "#F2F2EE",
    border: "#E6E5E0",
    borderStrong: "#D4D2CC",
    ink: "#0E0E10",
    inkSoft: "#3A3A40",
    muted: "#75747A",
    mutedSoft: "#A4A3A8",
    accent: "#6D28D9",
    accentSoft: "#EDE7FE",
    accentInk: "#FFFFFF",
    success: "#15803D",
    successSoft: "#DCFCE7",
    warning: "#B45309",
    warningSoft: "#FEF3C7",
    danger: "#B91C1C",
    dangerSoft: "#FEE2E2",
    info: "#1D4ED8",
    infoSoft: "#DBEAFE",
    mapBg: "#EAE7E0",
    mapRoute: "#6D28D9",
    chrome: "#0E0E10",
    onChrome: "#FFFFFF",
  }),
  dark: Object.freeze({
    name: "Field Dark",
    bg: "#0B0B0E",
    surface: "#15151A",
    surfaceAlt: "#1E1E24",
    border: "#26262E",
    borderStrong: "#363640",
    ink: "#F4F4F5",
    inkSoft: "#D4D4D8",
    muted: "#9A9AA3",
    mutedSoft: "#6A6A72",
    accent: "#A78BFA",
    accentSoft: "rgba(167,139,250,0.16)",
    accentInk: "#0B0B0E",
    success: "#4ADE80",
    successSoft: "rgba(74,222,128,0.14)",
    warning: "#FBBF24",
    warningSoft: "rgba(251,191,36,0.14)",
    danger: "#FB7185",
    dangerSoft: "rgba(251,113,133,0.14)",
    info: "#60A5FA",
    infoSoft: "rgba(96,165,250,0.14)",
    mapBg: "#0E0E12",
    mapRoute: "#A78BFA",
    chrome: "#000000",
    onChrome: "#FFFFFF",
  }),
  hivis: Object.freeze({
    name: "Field Hi-Vis",
    bg: "#000000",
    surface: "#0A0A0A",
    surfaceAlt: "#141414",
    border: "#1F1F1F",
    borderStrong: "#2E2E2E",
    ink: "#FFFFFF",
    inkSoft: "#E6E6E6",
    muted: "#9C9C9C",
    mutedSoft: "#6A6A6A",
    accent: "#F5D90A",
    accentSoft: "rgba(245,217,10,0.14)",
    accentInk: "#000000",
    success: "#22FF88",
    successSoft: "rgba(34,255,136,0.14)",
    warning: "#FFAA00",
    warningSoft: "rgba(255,170,0,0.14)",
    danger: "#FF3B30",
    dangerSoft: "rgba(255,59,48,0.14)",
    info: "#5AC8FA",
    infoSoft: "rgba(90,200,250,0.14)",
    mapBg: "#050505",
    mapRoute: "#F5D90A",
    chrome: "#000000",
    onChrome: "#FFFFFF",
  }),
});

export const MOBILE_V2_THEME_KEYS: ReadonlyArray<MobileV2ThemeKey> = Object.freeze([
  "light",
  "dark",
  "hivis",
]);

/** Default when no preference exists; matches design harness default (Hi-Vis). */
export const MOBILE_V2_DEFAULT_THEME: MobileV2ThemeKey = "hivis";

// ---------------------------------------------------------------------------
// Typography
// ---------------------------------------------------------------------------

/**
 * Sans (UI prose). Geist preferred; falls through Inter / system fonts and
 * keyword family so RN/web stays safe before the font is loaded via expo-font
 * (added in a later phase). The keyword fallback (`sans-serif`) ensures the
 * design canvas (canvas.html with Google Fonts) and impl gallery captures
 * land on the same visual register cross-platform (Playwright Linux runner,
 * macOS local, Windows local), eliminating serif-mono fallback divergence.
 */
export const MOBILE_V2_FONT_SANS =
  "Geist, Inter, System, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif";

/**
 * Monospace (numerics: IDs, ETA, currency, percentages, SLA, battery).
 * Stack falls through to ui-monospace / SFMono / Consolas / Liberation Mono
 * before the keyword `monospace` so a Playwright Linux capture without Geist
 * Mono installed renders a sans-style mono fallback rather than a serif one.
 */
export const MOBILE_V2_FONT_MONO =
  "'Geist Mono', 'JetBrains Mono', ui-monospace, 'SFMono-Regular', 'Menlo', 'Consolas', 'Liberation Mono', monospace";

/** Rendered type scale (px). Mirrors the values used by _kit.jsx. */
export const MOBILE_V2_TYPE_SIZES = Object.freeze({
  appBarTitle: 17,
  appBarSubtitle: 12,
  /** Bottom-sheet header title — design `FxSheet` (app-shell.jsx:294) uses 15, not the 17 app-bar size. */
  sheetTitle: 15,
  /** Bottom-sheet header subtitle — design `FxSheet` (app-shell.jsx:295) uses 11. */
  sheetSubtitle: 11,
  sectionHead: 10,
  body: 13,
  bodyStrong: 14,
  metricValue: 22,
  chip: 11,
  chipDense: 10,
  statusBar: 12,
  /** Section label above grouped controls (e.g. "Photos · required"). */
  label: 11,
  /** Inline caption/help text under inputs and tiles. */
  caption: 12,
  /** CTA primary button label inside sheets / overlay actions. */
  cta: 13,
  /** Composite row label (list-row title + subtitle layout). */
  rowLabel: 13.5,
  /** Inline emphasis between body and large display (e.g. variance subtotal, duration tile). */
  metricInline: 16,
  /** Sheet hero numerals — counted total, scanned counter (between bodyStrong and full metric). */
  metricLarge: 28,
  /** Break-countdown sized display: HH:MM at very large scale. */
  metricDisplay: 54,
  /** Sub-chip / monospace mini-meta — between sectionHead and label. */
  microMono: 10.5,
});

/** Font weights as RN-compatible string tokens. */
export const MOBILE_V2_TYPE_WEIGHTS = Object.freeze({
  regular: "400" as const,
  medium: "500" as const,
  semibold: "600" as const,
  bold: "700" as const,
});

/** Letter-spacing values matched to design source (px). */
export const MOBILE_V2_TYPE_LETTER_SPACING = Object.freeze({
  appBarTitle: -0.2,
  metricValue: -0.5,
  sectionHead: 0.8,
  chip: 0.2,
});

/**
 * Tight display line-height ratio. The design `_kit.jsx` sets
 * `lineHeight: 1.1` on the app-bar title and the FxMetric value; every
 * other run uses the browser `normal` default. RN needs `lineHeight` in
 * px, so callers multiply this ratio by the run's `fontSize`. Porting it
 * is load-bearing: without it the impl title line box is ~2.5px taller
 * than the design and pushes every screen's content down (verified by the
 * element-geometry diff — a uniform `dy+3.3` across app-bar screens).
 */
export const MOBILE_V2_TYPE_LINE_TIGHT = 1.1;

// ---------------------------------------------------------------------------
// Spacing scale (4px grid) — taken from observed gaps in _kit.jsx
// ---------------------------------------------------------------------------

export const MOBILE_V2_SPACING = Object.freeze({
  px: 1,
  xs: 2,
  sm: 4,
  md: 6,
  lg: 8,
  xl: 10,
  "2xl": 12,
  "3xl": 14,
  "4xl": 16,
  "5xl": 18,
  "6xl": 24,
  "7xl": 32,
});

// ---------------------------------------------------------------------------
// Radii — mirrors source defaults from FxButton/FxCard/FxFrame/FxSheet
// ---------------------------------------------------------------------------

export const MOBILE_V2_RADII = Object.freeze({
  button: 12,
  card: 14,
  sheetTop: 22,
  chip: 999,
  phoneFrame: 28,
  /** Square-icon tiles (avatar, pin disk, sortation bay code). */
  tile: 10,
  /** Text inputs + small surface tiles inside sheets. */
  input: 10,
  /** Small list-row icon disk (capture button, severity tile). */
  iconDisk: 10,
});

// ---------------------------------------------------------------------------
// Pixel dimensions — square element sizes used across V2 surfaces. Audit
// finding (demo-parity sweep P1): pickup-detail / today bypassed token
// resolution with raw integer literals. Centralizing here so a future
// "denser layout" theme can shift everything coherently.
// ---------------------------------------------------------------------------

export const MOBILE_V2_DIMENSIONS = Object.freeze({
  /** Avatar tile next to chrome heroes / address cards (36x36). */
  avatarTile: 36,
  /** Compact icon disk inside list rows (32x32). */
  iconDisk: 32,
  /** Sortation/EOR small badge disk (28x28). */
  smallDisk: 28,
  /** Circular progress ring SVG diameter (64x64). */
  progressRing: 64,
  /** Larger empty-state disk (48x48). */
  emptyStateDisk: 48,
  /** Bottom-sheet drag handle bar (40x4). */
  sheetDragHandleWidth: 44,
  sheetDragHandleHeight: 4,
  /** Bottom-sheet close button tile (32x32). */
  sheetCloseTile: 32,
  /** Severity / type icon tile inside sheet row pickers (34x34). */
  sheetTypeIcon: 34,
  /** Notif-prefs / settings custom switch (44x26 with 20px knob). */
  toggleTrackWidth: 44,
  toggleTrackHeight: 26,
  toggleKnob: 20,
});

// ---------------------------------------------------------------------------
// Shadows — RN-compatible recipes for sheet, drawer, toast surfaces
// ---------------------------------------------------------------------------

export interface MobileV2Shadow {
  readonly shadowColor: string;
  readonly shadowOpacity: number;
  readonly shadowRadius: number;
  readonly shadowOffset: { readonly width: number; readonly height: number };
  readonly elevation: number;
}

export const MOBILE_V2_SHADOWS: Readonly<Record<"sheet" | "drawer" | "toast" | "phoneFrame", MobileV2Shadow>> =
  Object.freeze({
    sheet: Object.freeze({
      shadowColor: "#000000",
      shadowOpacity: 0.25,
      shadowRadius: 30,
      shadowOffset: { width: 0, height: -10 },
      elevation: 16,
    }),
    drawer: Object.freeze({
      shadowColor: "#000000",
      shadowOpacity: 0.3,
      shadowRadius: 30,
      shadowOffset: { width: 8, height: 0 },
      elevation: 24,
    }),
    toast: Object.freeze({
      shadowColor: "#000000",
      shadowOpacity: 0.25,
      shadowRadius: 24,
      shadowOffset: { width: 0, height: 8 },
      elevation: 12,
    }),
    phoneFrame: Object.freeze({
      shadowColor: "#000000",
      shadowOpacity: 0.18,
      shadowRadius: 60,
      shadowOffset: { width: 0, height: 24 },
      elevation: 0,
    }),
  });

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const HEX_COLOR_PATTERN = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;
const RGBA_COLOR_PATTERN = /^rgba?\(\s*\d+\s*,\s*\d+\s*,\s*\d+\s*(?:,\s*(?:0|1|0?\.\d+)\s*)?\)$/;

/** Validate a color literal is a hex or rgba expression. Used by tests. */
export function isValidColorLiteral(value: string): boolean {
  return HEX_COLOR_PATTERN.test(value) || RGBA_COLOR_PATTERN.test(value);
}

/**
 * Resolve a theme key from an arbitrary user-supplied value, falling back to
 * the default if invalid. Used by KV resolver path so a corrupted preference
 * value never crashes the shell.
 */
export function resolveMobileV2ThemeKey(candidate: unknown): MobileV2ThemeKey {
  if (typeof candidate === "string") {
    const normalized = candidate.trim().toLowerCase();
    if (normalized === "light" || normalized === "dark" || normalized === "hivis") {
      return normalized;
    }
  }
  return MOBILE_V2_DEFAULT_THEME;
}

/**
 * Resolve the active theme tokens from a key. Always returns a frozen object;
 * never throws. Use this anywhere you need to read tokens; do not index
 * MOBILE_V2_THEMES directly with untrusted input.
 */
export function getMobileV2Theme(key: MobileV2ThemeKey): MobileV2Theme {
  return MOBILE_V2_THEMES[key];
}
