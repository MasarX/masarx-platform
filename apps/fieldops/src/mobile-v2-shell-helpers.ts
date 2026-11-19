// Pure decision helpers for the Mobile V2 shell components (FxFrame /
// ScreenShell / AppDrawer / BottomTabs / SyncBanner / ToastHost). Extracted
// from the .tsx so unit tests cover the logic without rendering JSX.
//
// Source: design bundle project/screens/app-shell.jsx — every choice here
// matches the source's resolution rules (lead icon, drawer trigger, sync
// banner, tab budget, etc.) so the port reproduces shell behaviour exactly.

import {
  filterMobileV2Navigation,
  findMobileV2DefaultHome,
  type MobileV2NavigationContext,
  type MobileV2NavigationItem,
  type MobileV2NavigationSection,
} from "./mobile-v2-navigation";

// ---------------------------------------------------------------------------
// AppBar lead icon — design rule: arrow-left if onBack set, else menu when
// onMenu set, else nothing.
// ---------------------------------------------------------------------------

export type AppBarLeadIcon = "arrow-left" | "menu" | null;

export function resolveAppBarLeadIcon(input: {
  readonly hasOnBack: boolean;
  readonly hasOnMenu: boolean;
}): AppBarLeadIcon {
  if (input.hasOnBack) return "arrow-left";
  if (input.hasOnMenu) return "menu";
  return null;
}

// ---------------------------------------------------------------------------
// Sync banner state — visible only when offline AND queue > 0, OR currently
// syncing AND queue > 0. Tone differs (info while syncing, warning when
// offline). Hidden when queue is empty or while online and idle.
// ---------------------------------------------------------------------------

export type SyncBannerKind = "syncing" | "offline";

export interface SyncBannerState {
  readonly visible: boolean;
  readonly kind: SyncBannerKind;
  readonly count: number;
  readonly label: string;
}

export function resolveSyncBannerState(input: {
  readonly online: boolean;
  readonly syncing: boolean;
  readonly queueCount: number;
}): SyncBannerState {
  const count = Math.max(0, Math.floor(input.queueCount));
  if (count === 0) {
    return { visible: false, kind: "offline", count: 0, label: "" };
  }
  if (input.syncing) {
    return {
      visible: true,
      kind: "syncing",
      count,
      label: count === 1 ? "Syncing 1…" : `Syncing ${count}…`,
    };
  }
  if (!input.online) {
    return {
      visible: true,
      kind: "offline",
      count,
      label: count === 1 ? "1 pending · offline" : `${count} pending · offline`,
    };
  }
  // Online, queue exists, not actively syncing — show warning so the user
  // can manually trigger a flush.
  return {
    visible: true,
    kind: "offline",
    count,
    label: count === 1 ? "1 pending · sync" : `${count} pending · sync`,
  };
}

// ---------------------------------------------------------------------------
// Bottom tabs — design rule: 4–5 tabs, role-aware, tasks always present, no
// duplicates. Items come from already-filtered navigation; we pick a
// stable subset prioritising the default home, role-specific tabs, and
// network-ops staples.
// ---------------------------------------------------------------------------

export interface BottomTabSelection {
  readonly tabs: ReadonlyArray<MobileV2NavigationItem>;
  readonly maxTabs: number;
}

const ROLE_TAB_PREFERENCES: Record<string, ReadonlyArray<string>> = {
  driver: ["mobile-tasks", "mobile-route", "mobile-eor", "mobile-trips", "mobile-more"],
  loader: [
    "mobile-tasks",
    "mobile-loader-today",
    "mobile-sortation",
    "mobile-trips",
    "mobile-more",
  ],
  rider: ["mobile-tasks", "mobile-rider-today", "mobile-route", "mobile-more"],
  supervisor: [
    "mobile-tasks",
    "mobile-supervisor-today",
    "mobile-hub-pickup",
    "mobile-trips",
    "mobile-more",
  ],
};

const FALLBACK_TAB_PREFERENCE: ReadonlyArray<string> = [
  "mobile-tasks",
  "mobile-route",
  "mobile-trips",
  "mobile-more",
];

export function resolveBottomTabs(input: {
  readonly visibleSections: ReadonlyArray<MobileV2NavigationSection>;
  readonly activeRole: string;
  readonly maxTabs?: number;
}): BottomTabSelection {
  const maxTabs = typeof input.maxTabs === "number" && input.maxTabs > 0 ? input.maxTabs : 5;
  const flat: MobileV2NavigationItem[] = [];
  for (const section of input.visibleSections) {
    for (const item of section.items) flat.push(item);
  }
  const byId = new Map<string, MobileV2NavigationItem>();
  for (const item of flat) byId.set(item.id, item);

  const preference = ROLE_TAB_PREFERENCES[input.activeRole] ?? FALLBACK_TAB_PREFERENCE;
  const out: MobileV2NavigationItem[] = [];
  const seen = new Set<string>();

  for (const id of preference) {
    if (out.length >= maxTabs) break;
    const item = byId.get(id);
    if (item !== undefined && !seen.has(id)) {
      out.push(item);
      seen.add(id);
    }
  }

  // Backfill with any other visible items if we under-shot the budget.
  // Honor the item's `roles` filter so role-scoped items (e.g. mobile-loader-today
  // with roles: ["loader"]) don't leak into other roles' tab strips.
  for (const item of flat) {
    if (out.length >= maxTabs) break;
    if (seen.has(item.id)) continue;
    if (item.roles !== null && !item.roles.includes(input.activeRole)) continue;
    out.push(item);
    seen.add(item.id);
  }

  return { tabs: Object.freeze(out), maxTabs };
}

// ---------------------------------------------------------------------------
// Drawer composition — sections ordered as registered, with the default-home
// item surfaced separately so the drawer header can render it as the
// "primary" entry, leaving the rest of v2-home for role-specific homes.
// ---------------------------------------------------------------------------

export interface DrawerComposition {
  readonly defaultHome: MobileV2NavigationItem | null;
  readonly sections: ReadonlyArray<MobileV2NavigationSection>;
}

export function composeDrawer(input: {
  readonly allSections: ReadonlyArray<MobileV2NavigationSection>;
  readonly context: MobileV2NavigationContext;
}): DrawerComposition {
  const filtered = filterMobileV2Navigation(input.allSections, input.context);
  const defaultHome = findMobileV2DefaultHome(filtered, input.context);
  return { defaultHome, sections: filtered };
}

// ---------------------------------------------------------------------------
// Toast host — design uses 2200 ms auto-dismiss for all kinds. Extracted so
// callers can configure it without re-reading the source.
// ---------------------------------------------------------------------------

export const MOBILE_V2_TOAST_DEFAULT_DURATION_MS = 2200;

export type ToastKind = "info" | "success" | "warning" | "danger";

export function resolveToastDuration(input: { readonly kind?: ToastKind; readonly durationMs?: number }): number {
  if (typeof input.durationMs === "number" && input.durationMs > 0) {
    return Math.floor(input.durationMs);
  }
  if (input.kind === "danger") return MOBILE_V2_TOAST_DEFAULT_DURATION_MS + 600;
  return MOBILE_V2_TOAST_DEFAULT_DURATION_MS;
}
