// Mobile V2 icon set — data module ported from the Claude Design handoff
// bundle (project/screens/_kit.jsx FxIcon). Defines a typed catalog of every
// stroke icon used by the FieldOps V2 design at exact source coordinates so
// the renderer (added with react-native-svg in the next phase) is a thin shim
// over this data and the icon list stays exhaustively type-checked across
// every screen reference.
//
// All icons share viewBox="0 0 24 24" and are stroke-based with currentColor;
// only the small interior fills (whatsapp, dot) use fill="currentColor".
// Default stroke width is 1.7 (set by the renderer; not encoded here).

export const MOBILE_V2_ICON_VIEWBOX = "0 0 24 24";
export const MOBILE_V2_ICON_VIEWBOX_SIZE = 24;
export const MOBILE_V2_ICON_DEFAULT_STROKE = 1.7;
export const MOBILE_V2_ICON_DEFAULT_SIZE = 20;

export const MOBILE_V2_ICON_NAMES = [
  "menu",
  "arrow-left",
  "arrow-right",
  "arrow-up-right",
  "arrow-up",
  "arrow-down",
  "sparkle",
  "split",
  "box",
  "bike",
  "check",
  "check-double",
  "x",
  "plus",
  "minus",
  "scan",
  "pin",
  "route",
  "truck",
  "package",
  "phone",
  "message",
  "whatsapp",
  "camera",
  "sig",
  "cash",
  "shield",
  "wifi-off",
  "cloud-up",
  "cloud-check",
  "flag",
  "calendar",
  "copy",
  "share",
  "navigate",
  "info",
  "layers",
  "locate",
  "alert",
  "clock",
  "user",
  "logout",
  "settings",
  "qr",
  "list",
  "map",
  "eye",
  "sun",
  "moon",
  "globe",
  "chevron-right",
  "chevron-down",
  "chevron-up",
  "dot",
  "search",
  "filter",
  "refresh",
  "sync",
  "doc",
  "id",
  "star",
  "flame",
  "mic",
  // Added 2026-05-13 to align sheet-incident fixture with design canvas
  // ScrIncident: design uses `cross` (medical) + `wrench` (vehicle
  // breakdown) which previously fell back to nearest available
  // (`info`/`truck`). See `apps/fieldops/src/fixtures/mobile-v2-incident-fixtures.ts`.
  "cross",
  "wrench",
  // Added 2026-05-13 to align SheetBreak CTAs with design canvas:
  // design uses `pause` for "Start break" (semantically: pause work)
  // and `play` for "Resume route". Impl previously fell back to
  // `clock` + `navigate`. See `apps/fieldops/src/mobile-v2-sheet-break.tsx`.
  "pause",
  "play",
  // Added 2026-05-13 — bulk-scan of design SSOT (docs/design/fieldops-
  // mobile-v2/screens/*.jsx) found 5 additional icon names used by
  // design but absent from our catalog. Production cutover resolves
  // icon names via policy when applicable; until then the impl
  // fixtures should reference the canonical glyphs directly:
  //   - bell: Notifications row (sheet-permissions + settings)
  //   - bolt: Express ticket chip (rider-today active-ticket)
  //   - lang: Language row (settings)
  //   - lock: Change PIN row (profile)
  //   - megaphone: Broadcast / info-tone inbox notifications
  "bell",
  "bolt",
  "lang",
  "lock",
  "megaphone",
] as const;

export type MobileV2IconName = (typeof MOBILE_V2_ICON_NAMES)[number];

export type MobileV2IconShape =
  | { readonly kind: "path"; readonly d: string; readonly fill?: "currentColor" }
  | {
      readonly kind: "rect";
      readonly x: number;
      readonly y: number;
      readonly width: number;
      readonly height: number;
      readonly rx?: number;
    }
  | {
      readonly kind: "circle";
      readonly cx: number;
      readonly cy: number;
      readonly r: number;
      readonly fill?: "currentColor";
    };

export type MobileV2IconSpec = ReadonlyArray<MobileV2IconShape>;

const PATH = (d: string): MobileV2IconShape => ({ kind: "path", d });

export const MOBILE_V2_ICONS: Readonly<Record<MobileV2IconName, MobileV2IconSpec>> = Object.freeze({
  menu: [PATH("M4 7h16M4 12h16M4 17h16")],
  "arrow-left": [PATH("M15 6l-6 6 6 6")],
  "arrow-right": [PATH("M9 6l6 6-6 6")],
  "arrow-up-right": [PATH("M7 17L17 7M9 7h8v8")],
  "arrow-up": [PATH("M12 19V5M5 12l7-7 7 7")],
  "arrow-down": [PATH("M12 5v14M5 12l7 7 7-7")],
  sparkle: [PATH("M12 3l1.6 4.4L18 9l-4.4 1.6L12 15l-1.6-4.4L6 9l4.4-1.6L12 3zM18 14l.8 2.2L21 17l-2.2.8L18 20l-.8-2.2L15 17l2.2-.8L18 14z")],
  split: [PATH("M12 3v6M12 9l-5 6M12 9l5 6M5 21h4M15 21h4")],
  box: [
    { kind: "rect", x: 3, y: 7, width: 18, height: 13, rx: 1.5 },
    PATH("M3 11h18M9 7V4h6v3"),
  ],
  bike: [
    { kind: "circle", cx: 6, cy: 17, r: 3 },
    { kind: "circle", cx: 18, cy: 17, r: 3 },
    PATH("M6 17l4-9h4l3 9M14 8h-3l-2-3H7"),
  ],
  check: [PATH("M5 12l4.5 4.5L19 7")],
  "check-double": [PATH("M2 12l4 4 8-8"), PATH("M10 16l4 4 8-8")],
  x: [PATH("M6 6l12 12M18 6L6 18")],
  plus: [PATH("M12 5v14M5 12h14")],
  minus: [PATH("M5 12h14")],
  scan: [
    PATH("M4 8V5a1 1 0 011-1h3M16 4h3a1 1 0 011 1v3M20 16v3a1 1 0 01-1 1h-3M8 20H5a1 1 0 01-1-1v-3"),
    PATH("M3 12h18"),
  ],
  pin: [
    PATH("M12 22s7-7.5 7-13a7 7 0 10-14 0c0 5.5 7 13 7 13z"),
    { kind: "circle", cx: 12, cy: 9, r: 2.5 },
  ],
  route: [
    { kind: "circle", cx: 6, cy: 6, r: 2 },
    { kind: "circle", cx: 18, cy: 18, r: 2 },
    PATH("M8 6h7a4 4 0 014 4v0a4 4 0 01-4 4H9a4 4 0 00-4 4"),
  ],
  truck: [
    { kind: "rect", x: 2, y: 7, width: 11, height: 9, rx: 1 },
    PATH("M13 10h4l3 3v3h-7"),
    { kind: "circle", cx: 6.5, cy: 17.5, r: 1.8 },
    { kind: "circle", cx: 17, cy: 17.5, r: 1.8 },
  ],
  package: [PATH("M12 3l8 4.5v9L12 21l-8-4.5v-9L12 3z"), PATH("M4 7.5L12 12l8-4.5M12 12v9")],
  phone: [PATH("M5 4h3l2 5-2.5 1.5a11 11 0 005 5L14 13l5 2v3a2 2 0 01-2 2A14 14 0 013 6a2 2 0 012-2z")],
  message: [PATH("M4 6a2 2 0 012-2h12a2 2 0 012 2v9a2 2 0 01-2 2H9l-5 4V6z")],
  whatsapp: [
    PATH("M4 20l1.5-4.5A8 8 0 1112 20H4z"),
    { kind: "path", d: "M9 10c0 3 2 5 5 5l1-1.5-2-1-1 1c-1 0-2-1-2-2l1-1-1-2L9 8v2z", fill: "currentColor" },
  ],
  camera: [
    PATH("M3 8a2 2 0 012-2h2l1.5-2h7L17 6h2a2 2 0 012 2v9a2 2 0 01-2 2H5a2 2 0 01-2-2V8z"),
    { kind: "circle", cx: 12, cy: 13, r: 3.5 },
  ],
  sig: [PATH("M3 17c3 0 3-8 6-8s3 8 6 8 3-4 6-4")],
  cash: [
    { kind: "rect", x: 2, y: 6, width: 20, height: 12, rx: 1.5 },
    { kind: "circle", cx: 12, cy: 12, r: 3 },
    PATH("M5 9v6M19 9v6"),
  ],
  shield: [PATH("M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6l8-3z")],
  "wifi-off": [
    PATH("M3 3l18 18"),
    PATH("M5 12a14 14 0 014-2.5M19 12a14 14 0 00-3-2"),
    PATH("M8.5 15.5a7 7 0 017 0"),
    PATH("M12 19h.01"),
  ],
  "cloud-up": [PATH("M7 18a4 4 0 010-8 6 6 0 0111-2 5 5 0 011 9.9"), PATH("M12 14v6M9 17l3-3 3 3")],
  "cloud-check": [PATH("M7 18a4 4 0 010-8 6 6 0 0111-2 5 5 0 011 9.9H7z"), PATH("M9 14l2 2 4-4")],
  flag: [PATH("M5 21V4h12l-2 4 2 4H5")],
  calendar: [
    { kind: "rect", x: 3, y: 5, width: 18, height: 16, rx: 2 },
    PATH("M3 9h18M8 3v4M16 3v4"),
  ],
  copy: [
    { kind: "rect", x: 8, y: 8, width: 13, height: 13, rx: 2 },
    PATH("M16 8V5a2 2 0 00-2-2H5a2 2 0 00-2 2v9a2 2 0 002 2h3"),
  ],
  share: [
    { kind: "circle", cx: 6, cy: 12, r: 3 },
    { kind: "circle", cx: 18, cy: 6, r: 3 },
    { kind: "circle", cx: 18, cy: 18, r: 3 },
    PATH("M8.5 10.5L15.5 7M8.5 13.5L15.5 17"),
  ],
  navigate: [PATH("M3 11l18-7-7 18-2.5-8.5L3 11z")],
  info: [{ kind: "circle", cx: 12, cy: 12, r: 9 }, PATH("M12 11v6M12 7.5h.01")],
  layers: [PATH("M12 3l9 5-9 5-9-5 9-5z"), PATH("M3 13l9 5 9-5M3 18l9 5 9-5")],
  locate: [
    { kind: "circle", cx: 12, cy: 12, r: 3 },
    { kind: "circle", cx: 12, cy: 12, r: 8 },
    PATH("M12 2v3M12 19v3M2 12h3M19 12h3"),
  ],
  alert: [PATH("M12 3l10 18H2L12 3z"), PATH("M12 10v5M12 18h.01")],
  clock: [{ kind: "circle", cx: 12, cy: 12, r: 9 }, PATH("M12 7v5l3 2")],
  user: [{ kind: "circle", cx: 12, cy: 8, r: 4 }, PATH("M4 21a8 8 0 0116 0")],
  logout: [PATH("M14 8V5a1 1 0 00-1-1H5a1 1 0 00-1 1v14a1 1 0 001 1h8a1 1 0 001-1v-3"), PATH("M10 12h11M18 9l3 3-3 3")],
  settings: [
    { kind: "circle", cx: 12, cy: 12, r: 3 },
    PATH("M19.4 15a1.7 1.7 0 00.3 1.8l.1.1a2 2 0 11-2.8 2.8l-.1-.1a1.7 1.7 0 00-1.8-.3 1.7 1.7 0 00-1 1.5V21a2 2 0 11-4 0v-.1a1.7 1.7 0 00-1-1.5 1.7 1.7 0 00-1.8.3l-.1.1a2 2 0 11-2.8-2.8l.1-.1a1.7 1.7 0 00.3-1.8 1.7 1.7 0 00-1.5-1H3a2 2 0 110-4h.1a1.7 1.7 0 001.5-1 1.7 1.7 0 00-.3-1.8l-.1-.1A2 2 0 117 4.6l.1.1a1.7 1.7 0 001.8.3h0a1.7 1.7 0 001-1.5V3a2 2 0 114 0v.1a1.7 1.7 0 001 1.5 1.7 1.7 0 001.8-.3l.1-.1a2 2 0 112.8 2.8l-.1.1a1.7 1.7 0 00-.3 1.8v0a1.7 1.7 0 001.5 1H21a2 2 0 110 4h-.1a1.7 1.7 0 00-1.5 1z"),
  ],
  qr: [
    { kind: "rect", x: 3, y: 3, width: 7, height: 7, rx: 1 },
    { kind: "rect", x: 14, y: 3, width: 7, height: 7, rx: 1 },
    { kind: "rect", x: 3, y: 14, width: 7, height: 7, rx: 1 },
    PATH("M14 14h3v3M21 14v0M14 21h7M17 17v4"),
  ],
  list: [
    PATH("M8 6h13M8 12h13M8 18h13"),
    { kind: "circle", cx: 3.5, cy: 6, r: 1 },
    { kind: "circle", cx: 3.5, cy: 12, r: 1 },
    { kind: "circle", cx: 3.5, cy: 18, r: 1 },
  ],
  map: [PATH("M3 6l6-2 6 2 6-2v14l-6 2-6-2-6 2V6z"), PATH("M9 4v16M15 6v16")],
  eye: [PATH("M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"), { kind: "circle", cx: 12, cy: 12, r: 3 }],
  sun: [
    { kind: "circle", cx: 12, cy: 12, r: 4 },
    PATH("M12 2v2M12 20v2M2 12h2M20 12h2M5 5l1.5 1.5M17.5 17.5L19 19M5 19l1.5-1.5M17.5 6.5L19 5"),
  ],
  moon: [PATH("M21 13A9 9 0 1111 3a7 7 0 0010 10z")],
  globe: [
    { kind: "circle", cx: 12, cy: 12, r: 9 },
    PATH("M3 12h18M12 3a14 14 0 010 18M12 3a14 14 0 000 18"),
  ],
  "chevron-right": [PATH("M9 6l6 6-6 6")],
  "chevron-down": [PATH("M6 9l6 6 6-6")],
  "chevron-up": [PATH("M6 15l6-6 6 6")],
  dot: [{ kind: "circle", cx: 12, cy: 12, r: 3, fill: "currentColor" }],
  search: [{ kind: "circle", cx: 11, cy: 11, r: 7 }, PATH("M20 20l-4-4")],
  filter: [PATH("M3 5h18l-7 9v6l-4-2v-4L3 5z")],
  refresh: [
    PATH("M3 12a9 9 0 0115-6.7L21 8"),
    PATH("M21 4v4h-4"),
    PATH("M21 12a9 9 0 01-15 6.7L3 16"),
    PATH("M3 20v-4h4"),
  ],
  sync: [
    PATH("M4 12a8 8 0 0114-5"),
    PATH("M18 4v3h-3"),
    PATH("M20 12a8 8 0 01-14 5"),
    PATH("M6 20v-3h3"),
  ],
  doc: [PATH("M6 3h8l4 4v14H6V3z"), PATH("M14 3v4h4M9 13h6M9 17h4")],
  id: [
    { kind: "rect", x: 3, y: 5, width: 18, height: 14, rx: 2 },
    { kind: "circle", cx: 9, cy: 12, r: 2.5 },
    PATH("M14 10h5M14 14h3"),
  ],
  star: [PATH("M12 3l2.8 6 6.2.8-4.5 4.4 1 6.3-5.5-3-5.5 3 1-6.3-4.5-4.4 6.2-.8L12 3z")],
  flame: [PATH("M12 3c1 4 5 5 5 10a5 5 0 11-10 0c0-2 1-3 2-4-1 3 1 4 2 4 0-3-2-3 1-10z")],
  mic: [{ kind: "rect", x: 9, y: 3, width: 6, height: 12, rx: 3 }, PATH("M5 11a7 7 0 0014 0M12 18v3")],
  // Medical cross (plus shape) — used by sheet-incident's `medical`
  // emergency type per design canvas ScrIncident.
  cross: [PATH("M12 5v14M5 12h14")],
  // Wrench — used by sheet-incident's `breakdown` type. Lucide-style
  // open-jaw silhouette: notched head at upper-right + diagonal shaft
  // to lower-left. The previous single-path simplification rendered
  // ambiguously at 14px (read as a key); this dual-stroke shape keeps
  // the jaw notch visible at small sizes per design canvas wrench glyph.
  wrench: [
    PATH("M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3-3a6 6 0 0 1-7.7 7.7l-6.6 6.6a2 2 0 0 1-2.8-2.8l6.6-6.6a6 6 0 0 1 7.7-7.7l-3 3z"),
  ],
  // Pause — two vertical bars. Used by SheetBreak "Start break" CTA.
  pause: [PATH("M9 5v14M15 5v14")],
  // Play — right-pointing triangle. Used by SheetBreak "Resume route" CTA.
  play: [PATH("M8 5l11 7-11 7V5z")],
  // Bell — Notifications row in settings + sheet-permissions.
  bell: [
    PATH("M12 3a6 6 0 016 6v4l2 3H4l2-3V9a6 6 0 016-6z"),
    PATH("M10 19a2 2 0 004 0"),
  ],
  // Bolt — Express ticket chip / lightning marker.
  bolt: [PATH("M13 2L4 14h6l-2 8 10-12h-6l2-8z")],
  // Lang — language / translate marker. Letter "A" + horizontal bar
  // alongside three text-lines approximating Aa stack.
  lang: [
    PATH("M4 19l4-12 4 12"),
    PATH("M5.5 14h5"),
    PATH("M14 9h7M14 13h7M14 17h7"),
  ],
  // Lock — padlock for "Change PIN" row in profile/security.
  lock: [
    PATH("M7 11V7a5 5 0 0110 0v4"),
    { kind: "rect", x: 5, y: 11, width: 14, height: 10, rx: 2 },
  ],
  // Megaphone — broadcast / info-tone notification icon.
  megaphone: [
    PATH("M4 9v6h3l9 4V5L7 9H4z"),
    PATH("M18 9a3 3 0 010 6"),
  ],
});

/**
 * Resolve a candidate icon name to a known one. Returns null for unknown
 * inputs so the renderer can degrade gracefully (e.g. a question-mark
 * placeholder) without throwing on a typo or a stale screen reference.
 */
export function resolveMobileV2IconName(candidate: unknown): MobileV2IconName | null {
  if (typeof candidate !== "string") {
    return null;
  }
  const trimmed = candidate.trim();
  return (MOBILE_V2_ICON_NAMES as ReadonlyArray<string>).includes(trimmed)
    ? (trimmed as MobileV2IconName)
    : null;
}

/** Get icon spec by name. Returns null when unknown. */
export function getMobileV2IconSpec(name: unknown): MobileV2IconSpec | null {
  const resolved = resolveMobileV2IconName(name);
  return resolved === null ? null : MOBILE_V2_ICONS[resolved];
}
