import type { NavigationItem, NavigationSection } from "./navigation";

export type DashboardItem = {
  id: string;
  label: string;
  href?: string | null;
  resourceKey?: string | null;
  disabledReason?: string | null;
};

export type DashboardSection = {
  id: string;
  label: string;
  items: DashboardItem[];
};

export type DashboardOptions = {
  maxSections?: number;
  maxItemsPerSection?: number;
};

const RESOURCE_PATH = /\/resources\/([^/?#]+)/i;

export function extractResourceKeyFromHref(href?: string | null) {
  if (!href) return null;
  const match = href.match(RESOURCE_PATH);
  return match ? match[1] : null;
}

function normalizeDashboardItem(item: NavigationItem): DashboardItem {
  const resourceKey = item.resource ?? extractResourceKeyFromHref(item.href);
  return {
    id: item.id,
    label: item.label,
    href: item.href ?? null,
    resourceKey,
    disabledReason: item.disabled_reason ?? null,
  };
}

function flattenItems(items: NavigationItem[], out: DashboardItem[]) {
  items.forEach((item) => {
    if (item.href || item.resource) {
      out.push(normalizeDashboardItem(item));
    }
    if (Array.isArray(item.items) && item.items.length > 0) {
      flattenItems(item.items, out);
    }
  });
}

export function buildDashboardSections(
  sections: NavigationSection[],
  options: DashboardOptions = {}
): DashboardSection[] {
  const maxSections =
    typeof options.maxSections === "number" ? options.maxSections : sections.length;
  const maxItems =
    typeof options.maxItemsPerSection === "number" ? options.maxItemsPerSection : 6;

  return sections.slice(0, maxSections).reduce<DashboardSection[]>((acc, section) => {
    const items: DashboardItem[] = [];
    flattenItems(section.items ?? [], items);
    const trimmed = items.filter((item) => item.href).slice(0, maxItems);
    if (trimmed.length > 0) {
      acc.push({
        id: section.id,
        label: section.label,
        items: trimmed,
      });
    }
    return acc;
  }, []);
}

export function collectResourceKeys(sections: DashboardSection[]) {
  const keys = new Set<string>();
  sections.forEach((section) => {
    section.items.forEach((item) => {
      if (item.resourceKey) keys.add(item.resourceKey);
    });
  });
  return Array.from(keys);
}
