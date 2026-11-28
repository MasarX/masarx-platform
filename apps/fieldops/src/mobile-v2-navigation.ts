// Mobile V2 navigation reader — pure parser + filter for the
// ui_navigation.apps.mobile JSONB payload returned by
// resolve_settings_row_from_policy_context_v1('ui_navigation', ctx).
//
// Frontend reads the canonical SSOT (registered in 202602041611_*,
// 202602051000_*, 202602061720_*, 202605101800_mobile_v2_navigation_pack_v1
// and friends) and applies role + capability filtering before rendering
// the drawer / bottom tabs / quick-actions. Per AGENTS.md Mobile Field Ops
// Policy Contract there is no client-side hardcoded route list.
//
// All functions are pure — they accept the raw payload (potentially
// untrusted: the cache could be stale, mid-migration, or hand-edited)
// and degrade gracefully when fields are missing or wrong-typed. They
// never throw on malformed input.

import type { MobileV2IconName } from "./mobile-v2-icon-specs";
import { MOBILE_V2_ICON_NAMES } from "./mobile-v2-icon-specs";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface MobileV2NavigationItem {
  /** Stable id (e.g. mobile-tasks). */
  readonly id: string;
  /** Human-readable label. */
  readonly label: string;
  /** Route href (e.g. /mobile/tasks). */
  readonly href: string;
  /** Capability key required to access this route. */
  readonly capability: string;
  /** Optional icon name from MOBILE_V2_ICON_NAMES; null if missing/unknown. */
  readonly icon: MobileV2IconName | null;
  /** True when this is the post-login default for every role. */
  readonly defaultHome: boolean;
  /** Roles this item is visible to; null means visible to every role. */
  readonly roles: ReadonlyArray<string> | null;
  /** Backend access gate reason from ui_navigation_v1; null means enabled. */
  readonly disabledReason: unknown | null;
}

export interface MobileV2NavigationSection {
  readonly id: string;
  readonly label: string;
  readonly items: ReadonlyArray<MobileV2NavigationItem>;
}

export interface MobileV2NavigationContext {
  /** Active role used for role-array filtering (loader, rider, supervisor, driver, etc.). */
  readonly activeRole: string;
  /** Capabilities the user holds (matches against item.capability). */
  readonly capabilities: ReadonlyArray<string>;
}

// ---------------------------------------------------------------------------
// Parsing — defensive, fail-safe
// ---------------------------------------------------------------------------

const ICON_NAME_SET = new Set<string>(MOBILE_V2_ICON_NAMES as ReadonlyArray<string>);

function parseString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}

function parseStringArray(value: unknown): ReadonlyArray<string> | null {
  if (!Array.isArray(value)) return null;
  const out: string[] = [];
  for (const entry of value) {
    if (typeof entry === "string" && entry.trim().length > 0) {
      out.push(entry.trim());
    }
  }
  return out.length === 0 ? null : Object.freeze(out);
}

function parseIcon(value: unknown): MobileV2IconName | null {
  if (typeof value !== "string") return null;
  return ICON_NAME_SET.has(value) ? (value as MobileV2IconName) : null;
}

function parseBool(value: unknown): boolean {
  return value === true;
}

function parseRecord(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function parseArrayOfRecords(value: unknown): ReadonlyArray<Record<string, unknown>> {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry) => parseRecord(entry))
    .filter((entry): entry is Record<string, unknown> => entry !== null);
}

/** Parse a single navigation item, returning null when required fields are missing. */
export function parseMobileV2NavigationItem(value: unknown): MobileV2NavigationItem | null {
  const record = parseRecord(value);
  if (record === null) return null;
  const id = parseString(record.id);
  const label = parseString(record.label);
  const href = parseString(record.href);
  const capability = parseString(record.capability);
  if (id === null || label === null || href === null || capability === null) {
    return null;
  }
  return Object.freeze({
    id,
    label,
    href,
    capability,
    icon: parseIcon(record.icon),
    defaultHome: parseBool(record.default_home),
    roles: parseStringArray(record.roles),
    disabledReason: record.disabled_reason ?? null,
  });
}

/** Parse a single section, returning null when required fields are missing. */
export function parseMobileV2NavigationSection(value: unknown): MobileV2NavigationSection | null {
  const record = parseRecord(value);
  if (record === null) return null;
  const id = parseString(record.id);
  const label = parseString(record.label);
  if (id === null || label === null) return null;
  const items = parseArrayOfRecords(record.items)
    .map((entry) => parseMobileV2NavigationItem(entry))
    .filter((entry): entry is MobileV2NavigationItem => entry !== null);
  return Object.freeze({ id, label, items: Object.freeze(items) });
}

/**
 * Parse the full ui_navigation payload returned by
 * resolve_settings_row_from_policy_context_v1('ui_navigation', ctx).value.
 * Returns an empty array when the payload is missing or malformed at any
 * level — UI should render an empty drawer, not crash.
 */
export function parseMobileV2NavigationPayload(
  value: unknown,
): ReadonlyArray<MobileV2NavigationSection> {
  const root = parseRecord(value);
  if (root === null) return [];
  const directSections = parseArrayOfRecords(root.sections)
    .map((entry) => parseMobileV2NavigationSection(entry))
    .filter((entry): entry is MobileV2NavigationSection => entry !== null);
  if (directSections.length > 0) return Object.freeze(directSections);
  const apps = parseRecord(root.apps);
  if (apps === null) return [];
  const mobile = parseRecord(apps.mobile);
  if (mobile === null) return [];
  const sections = parseArrayOfRecords(mobile.sections)
    .map((entry) => parseMobileV2NavigationSection(entry))
    .filter((entry): entry is MobileV2NavigationSection => entry !== null);
  return Object.freeze(sections);
}

// ---------------------------------------------------------------------------
// Filtering — apply role + capability gates
// ---------------------------------------------------------------------------

/**
 * Decide if an item is visible to a context. Visibility requires:
 *   - The user holds the capability (or it is the wildcard "*" cap).
 *   - The item has no roles filter, OR the active role is in the filter.
 */
export function isMobileV2ItemVisible(
  item: MobileV2NavigationItem,
  context: MobileV2NavigationContext,
): boolean {
  if (item.disabledReason !== null && item.disabledReason !== undefined) return false;
  const capabilities = new Set(context.capabilities);
  const hasCapability = capabilities.has("*") || capabilities.has(item.capability);
  if (!hasCapability) return false;
  if (item.roles === null) return true;
  return item.roles.includes(context.activeRole);
}

/** Filter all items in all sections; sections with zero visible items are dropped. */
export function filterMobileV2Navigation(
  sections: ReadonlyArray<MobileV2NavigationSection>,
  context: MobileV2NavigationContext,
): ReadonlyArray<MobileV2NavigationSection> {
  const filtered: MobileV2NavigationSection[] = [];
  for (const section of sections) {
    const visibleItems = section.items.filter((item) => isMobileV2ItemVisible(item, context));
    if (visibleItems.length === 0) continue;
    filtered.push(Object.freeze({ id: section.id, label: section.label, items: Object.freeze(visibleItems) }));
  }
  return Object.freeze(filtered);
}

// ---------------------------------------------------------------------------
// Helpers — default home, flat lookups
// ---------------------------------------------------------------------------

/**
 * Find the post-login default home route. Returns the first item across all
 * sections whose default_home flag is true and which is visible to the
 * given context. Returns null when no default is registered or the user has
 * no capability for any default-home item (callers should fall back to the
 * first visible item, or to a hardcoded safe route as last resort).
 */
export function findMobileV2DefaultHome(
  sections: ReadonlyArray<MobileV2NavigationSection>,
  context: MobileV2NavigationContext,
): MobileV2NavigationItem | null {
  for (const section of sections) {
    for (const item of section.items) {
      if (item.defaultHome && isMobileV2ItemVisible(item, context)) {
        return item;
      }
    }
  }
  return null;
}

/** Flatten all items across sections (no filtering). Useful for lookups by id. */
export function flattenMobileV2Navigation(
  sections: ReadonlyArray<MobileV2NavigationSection>,
): ReadonlyArray<MobileV2NavigationItem> {
  const out: MobileV2NavigationItem[] = [];
  for (const section of sections) {
    for (const item of section.items) {
      out.push(item);
    }
  }
  return Object.freeze(out);
}

/** Find a navigation item by id across all sections. Returns null when missing. */
export function findMobileV2ItemById(
  sections: ReadonlyArray<MobileV2NavigationSection>,
  id: string,
): MobileV2NavigationItem | null {
  for (const section of sections) {
    for (const item of section.items) {
      if (item.id === id) return item;
    }
  }
  return null;
}

/**
 * Collect the distinct capability keys present across a navigation
 * payload. The `ui_navigation` resolver returns the user's accessible
 * route surface, so the union of `item.capability` across the resolved
 * sections IS the effective capability set for that session — no
 * separate access RPC or hardcoded capability list is needed.
 *
 * Audit F5: the drawer / bottom tabs were filtered by a PREVIEW/DEV
 * fixture (`MOBILE_V2_PREVIEW_CAPS`). In production the capability set
 * is now derived from the resolved navigation payload via this helper;
 * the fixture is the preview/offline fallback only.
 */
export function collectMobileV2Capabilities(
  sections: ReadonlyArray<MobileV2NavigationSection>,
): ReadonlyArray<string> {
  const seen = new Set<string>();
  for (const section of sections) {
    for (const item of section.items) {
      if (item.disabledReason !== null && item.disabledReason !== undefined) continue;
      if (item.capability.length > 0) seen.add(item.capability);
    }
  }
  return Object.freeze([...seen]);
}

export function hasMobileV2Capability(
  capabilities: ReadonlyArray<string>,
  capability: string,
): boolean {
  return capabilities.includes("*") || capabilities.includes(capability);
}

/**
 * #600: the cash drop and COD ledger need `cash_drop.write`. Without it the
 * read is disabled, so the screen would show zero values; it shows the
 * access-denied state with its recovery action instead.
 */
export function isMobileV2CashDropTabDenied(tabId: string, cashDropAccessEnabled: boolean): boolean {
  return !cashDropAccessEnabled && (tabId === "mobile-cash-drop" || tabId === "mobile-cod-ledger");
}

/**
 * #600: the access state of a capability-gated tab (cash drop, COD ledger
 * and the wallet, which needs `wallet.read`). Until the navigation read
 * settles the capabilities are unknown, so the tab is "pending" and shows
 * that read's loading or error state, never a denied flash.
 */
export function resolveMobileV2GatedTabAccess(
  tabId: string,
  access: {
    readonly navigationSettled: boolean;
    readonly cashDropAccessEnabled: boolean;
    readonly walletAccessEnabled: boolean;
  },
): "allowed" | "pending" | "denied" {
  const denied = isMobileV2CashDropTabDenied(tabId, access.cashDropAccessEnabled)
    || (tabId === "mobile-wallet" && !access.walletAccessEnabled);
  if (!denied) return "allowed";
  return access.navigationSettled ? "denied" : "pending";
}
