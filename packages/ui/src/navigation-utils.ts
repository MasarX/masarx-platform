"use client";
import type { NavigationItem, NavigationSection } from "./navigation";
import { normalizeAppHref, stripBasePath } from "./navigation-paths";
import { resolveSafeAppBasePath } from "./url-guard";

export type FlattenedNavigationItem = {
  item: NavigationItem;
  sectionId: string;
  sectionLabel: string;
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
    depth: number
  ) => {
    items.forEach((item) => {
      results.push({
        item,
        sectionId: section.id,
        sectionLabel: section.label,
        depth,
      });
      if (Array.isArray(item.items) && item.items.length > 0) {
        walkItems(item.items, section, depth + 1);
      }
    });
  };

  sections.forEach((section) => {
    walkItems(section.items, section, 0);
  });

  return results;
}
