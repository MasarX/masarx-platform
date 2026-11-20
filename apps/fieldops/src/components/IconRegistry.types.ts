// Icon names, dimensions and tone types for the shared icon registry.

/**
 * Curated set of icon aliases the FieldOps mobile shell consumes today.
 *
 * Keep this union ordered by category (navigation / actions / status) so
 * future readers can spot duplicates quickly. Adding a new alias requires
 * also extending `ICON_GLYPH` (TypeScript will error if you forget — the
 * `Record<IconName, ...>` constraint enforces it).
 */
export type IconName =
  // Tab bar destinations
  | "home"
  | "tasks"
  | "route"
  | "scan"
  | "outbox"
  | "more"
  // Navigation chrome
  | "menu"
  | "close"
  | "chevron-left"
  | "chevron-right"
  | "chevron-down"
  // Actions
  | "search"
  | "filter"
  | "sort"
  | "refresh"
  // Domain affordances
  | "package"
  | "map-pin"
  | "navigation"
  | "bell"
  | "check";

/**
 * Token-ramp size aliases. Each maps to a `font-size` (px) value so the
 * rendered glyph aligns visually with text of the same scale step. The
 * ramp deliberately mirrors the existing typography scale step names
 * (xs/sm/md/lg/xl/2xl) so tab-bar / drawer code can request sizes using
 * the same semantic vocabulary used for labels.
 */
export type IconSize = "xs" | "sm" | "md" | "lg" | "xl" | "2xl";

/**
 * Tone aliases mapped to palette foreground tokens at runtime by
 * `<Icon>`. The mapping is:
 *  - "default"  -> tokens.color.text       (primary surface text)
 *  - "muted"    -> tokens.color.textMuted  (secondary / meta)
 *  - "accent"   -> tokens.color.accent     (brand teal)
 *  - "success"  -> tokens.color.success    (semantic green)
 *  - "warning"  -> tokens.color.warning    (semantic amber)
 *  - "danger"   -> tokens.color.danger     (semantic red)
 *  - "info"     -> tokens.color.info       (semantic sky blue)
 *  - "inverse"  -> tokens.color.control    (foreground for dark fills)
 *
 * Design tone names intentionally do not leak palette token names so the
 * underlying token can shift without a breaking API change for callers.
 */
export type IconTone =
  | "default"
  | "muted"
  | "accent"
  | "success"
  | "warning"
  | "danger"
  | "info"
  | "inverse";

/**
 * Static glyph map for the curated icon aliases. Glyphs come from these
 * Unicode blocks (all widely supported on iOS / Android system fonts):
 *  - Miscellaneous Technical (`U+23xx`) -> chevrons, scan
 *  - Miscellaneous Symbols (`U+26xx`)    -> bell, navigation arrow
 *  - Geometric Shapes (`U+25xx`)         -> filter, sort, search
 *  - Arrows (`U+21xx`)                   -> route, outbox
 *  - Latin / Punctuation                 -> close (×), check (✓)
 *
 * The follow-up SVG-icon card swaps this table for proper line icons; the
 * `<Icon name>` callsite contract remains unchanged.
 */
export const ICON_GLYPH: Record<IconName, string> = {
  // Tab bar destinations
  home: "\u2302",            // ⌂  HOUSE
  tasks: "\u2611",           // ☑  BALLOT BOX WITH CHECK
  route: "\u21A3",           // ↣  RIGHTWARDS ARROW WITH TAIL
  scan: "\u25A6",            // ▦  SQUARE WITH ORTHOGONAL CROSSHATCH FILL
  outbox: "\u21EA",          // ⇪  UPWARDS WHITE ARROW FROM BAR
  more: "\u22EF",            // ⋯  MIDLINE HORIZONTAL ELLIPSIS
  // Navigation chrome
  menu: "\u2630",            // ☰  TRIGRAM FOR HEAVEN (hamburger)
  close: "\u00D7",           // ×  MULTIPLICATION SIGN
  "chevron-left": "\u2039",  // ‹  SINGLE LEFT-POINTING ANGLE QUOTATION MARK
  "chevron-right": "\u203A", // ›  SINGLE RIGHT-POINTING ANGLE QUOTATION MARK
  "chevron-down": "\u2304",  // ⌄  DOWN ARROWHEAD
  // Actions
  search: "\u26B2",          // ⚲  NEUTER (lens-like circle/stem)
  filter: "\u25BD",          // ▽  WHITE DOWN-POINTING TRIANGLE (funnel cue)
  sort: "\u21F5",            // ⇅  UPWARDS ARROW LEFTWARDS OF DOWNWARDS ARROW
  refresh: "\u21BB",         // ↻  CLOCKWISE OPEN CIRCLE ARROW
  // Domain affordances
  package: "\u25A3",         // ▣  WHITE SQUARE CONTAINING BLACK SMALL SQUARE
  "map-pin": "\u29C9",       // ⧉  TWO JOINED SQUARES (location-marker proxy)
  navigation: "\u279C",      // ➜  HEAVY ROUND-TIPPED RIGHTWARDS ARROW
  bell: "\u29D7",            // ⧗  BLACK HOURGLASS (notification cue)
  check: "\u2713",           // ✓  CHECK MARK
};

/**
 * Token-ramp pixel sizes. The ramp matches the typography scale step
 * names (xs/sm/md/lg/xl/2xl) so caller intent stays consistent across
 * text + iconography. `md` is the default and aligns with body-sized
 * inline labels (20px font line-block).
 */
export const ICON_SIZE_PX: Record<IconSize, number> = {
  xs: 14,
  sm: 16,
  md: 20,
  lg: 24,
  xl: 32,
  "2xl": 48,
};

/**
 * Ordered tuple of every supported `IconName`. Tests / lint rules use this
 * to enumerate the contract without re-deriving the union (TypeScript
 * unions do not exist at runtime).
 *
 * Keep this aligned with the `IconName` union; a unit test asserts the
 * length matches `Object.keys(ICON_GLYPH).length` so accidental drift
 * fails loudly.
 */
export const ICON_NAMES: ReadonlyArray<IconName> = [
  "home",
  "tasks",
  "route",
  "scan",
  "outbox",
  "more",
  "menu",
  "close",
  "chevron-left",
  "chevron-right",
  "chevron-down",
  "search",
  "filter",
  "sort",
  "refresh",
  "package",
  "map-pin",
  "navigation",
  "bell",
  "check",
];

/**
 * Ordered tuple of every supported `IconSize`. Mirrors `ICON_SIZE_PX`
 * key order so test enumeration stays deterministic.
 */
export const ICON_SIZES: ReadonlyArray<IconSize> = [
  "xs",
  "sm",
  "md",
  "lg",
  "xl",
  "2xl",
];

/**
 * Ordered tuple of every supported `IconTone`. Used by tests and (future)
 * Storybook entries to enumerate every tone variant without re-deriving
 * the union at runtime.
 */
export const ICON_TONES: ReadonlyArray<IconTone> = [
  "default",
  "muted",
  "accent",
  "success",
  "warning",
  "danger",
  "info",
  "inverse",
];

/** Only direction-bearing icons are mirrored in right-to-left layouts. */
export const ICON_MIRRORS_RTL: ReadonlySet<IconName> = new Set<IconName>([
  "chevron-left",
  "chevron-right",
  "navigation",
  "route",
]);
