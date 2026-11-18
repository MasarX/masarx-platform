"use client";
import type { NavigationItem, NavigationSection } from "./navigation";
import { normalizeAppHref, stripBasePath } from "./navigation-paths";
import { resolveSafeAppBasePath } from "./url-guard";

export type FlattenedNavigationItem = {
  item: NavigationItem;
  sectionId: string;
  sectionLabel: string;
  /** Full breadcrumb-style path through section and any parent items. */
  parentPath: string;
  depth: number;
};

function normalizeHref(href: string | null | undefined, basePath?: string) {
  if (!href) return href ?? null;
  const safeBase = resolveSafeAppBasePath(basePath ?? "");
  const normalized = normalizeAppHref(href, safeBase ?? undefined);
  if (!normalized) return href;
  return stripBasePath(normalized, safeBase ?? undefined);
}

function normalizeNavigationItems(
  items: NavigationItem[],
  basePath?: string
): NavigationItem[] {
  return items.map((item) => {
    const nextHref = normalizeHref(item.href ?? null, basePath);
    const nextItems: NavigationItem[] | null | undefined = Array.isArray(
      item.items
    )
      ? normalizeNavigationItems(item.items, basePath)
      : item.items;
    if (nextHref === item.href && nextItems === item.items) {
      return item;
    }
    return {
      ...item,
      href: nextHref,
      items: nextItems ?? null,
    };
  });
}

export function normalizeNavigationSections(
  sections: NavigationSection[],
  basePath?: string
): NavigationSection[] {
  return sections.map((section) => {
    const nextItems = normalizeNavigationItems(section.items, basePath);
    return nextItems === section.items
      ? section
      : { ...section, items: nextItems };
  });
}

export function flattenNavigationSections(sections: NavigationSection[]) {
  const results: FlattenedNavigationItem[] = [];
  const walkItems = (
    items: NavigationItem[],
    section: NavigationSection,
    parentPath: string,
    depth: number
  ) => {
    items.forEach((item) => {
      const itemPath = item.label?.trim()
        ? `${parentPath} > ${item.label.trim()}`
        : parentPath;
      results.push({
        item,
        sectionId: section.id,
        sectionLabel: section.label,
        parentPath,
        depth,
      });
      if (Array.isArray(item.items) && item.items.length > 0) {
        walkItems(item.items, section, itemPath, depth + 1);
      }
    });
  };

  sections.forEach((section) => {
    walkItems(section.items, section, section.label, 0);
  });

  return results;
}

/**
 * Collect all resource keys from navigation sections.
 */
export function collectNavigationResourceKeys(
  sections: NavigationSection[]
): string[] {
  const keys: string[] = [];
  const seen = new Set<string>();
  const walk = (items: NavigationItem[]) => {
    items.forEach((item) => {
      const resourceKey = item.resource?.trim() ?? "";
      const disabled = Boolean(item.disabled_reason?.trim());
      if (!disabled && resourceKey && !seen.has(resourceKey)) {
        seen.add(resourceKey);
        keys.push(resourceKey);
      }
      if (Array.isArray(item.items) && item.items.length > 0) {
        walk(item.items);
      }
    });
  };
  sections.forEach((section) => walk(section.items));
  return keys;
}

/**
 * Apply record-count badges to navigation sections.
 * Returns a new array with badge strings set on items whose resource
 * key has a corresponding count in the provided map.
 */
export function applyBadgeCounts(
  sections: NavigationSection[],
  counts: Map<string, number | null>
): NavigationSection[] {
  if (counts.size === 0) return sections;
  const applyToItems = (items: NavigationItem[]): NavigationItem[] =>
    items.map((item) => {
      const nestedItems = Array.isArray(item.items)
        ? applyToItems(item.items)
        : item.items;
      const resourceKey = item.resource?.trim() ?? "";
      const count = resourceKey ? counts.get(resourceKey) : undefined;
      const badge =
        count !== undefined && count !== null
          ? String(count)
          : item.badge ?? null;
      if (badge === (item.badge ?? null) && nestedItems === item.items) {
        return item;
      }
      return { ...item, badge, items: nestedItems ?? null };
    });
  return sections.map((section) => {
    const nextItems = applyToItems(section.items);
    return nextItems === section.items
      ? section
      : { ...section, items: nextItems };
  });
}
