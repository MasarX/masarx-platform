import { createE2EDatabasePool } from "./db";

type NavigationItem = {
  id: string;
  label?: string | null;
  href?: string | null;
  resource?: string | null;
  items?: NavigationItem[] | null;
};

type NavigationSection = {
  id: string;
  label?: string | null;
  items?: NavigationItem[] | null;
};

type AppName = "console" | "portal";

const cache = new Map<AppName, NavigationSection[]>();

export function flattenNavigationItems(
  items: NavigationItem[] = []
): NavigationItem[] {
  const out: NavigationItem[] = [];
  for (const item of items) {
    out.push(item);
    if (Array.isArray(item.items) && item.items.length > 0) {
      out.push(...flattenNavigationItems(item.items));
    }
  }
  return out;
}

export async function fetchNavigationSections(app: AppName) {
  if (cache.has(app)) {
    return cache.get(app) ?? [];
  }
  const { pool } = await createE2EDatabasePool(`navigation:${app}`);
  try {
    const res = await pool.query(
      `SELECT cached_value->'apps'->($1::text)->'sections' AS sections
       FROM settings
       WHERE category='ui_navigation'
         AND scope_type='global'
         AND scope_id IS NULL
       LIMIT 1`,
      [app]
    );
    const sections = (res.rows[0]?.sections ?? []) as NavigationSection[];
    cache.set(app, sections);
    return sections;
  } finally {
    await pool.end();
  }
}

export function extractResourceRoutes(sections: NavigationSection[]) {
  const routes = new Map<string, NavigationItem>();
  for (const section of sections) {
    const items = flattenNavigationItems(section.items ?? []);
    for (const item of items) {
      if (!item.href || !item.resource) continue;
      if (!item.href.includes("/resources/")) continue;
      if (!routes.has(item.href)) {
        routes.set(item.href, item);
      }
    }
  }
  return Array.from(routes.values());
}

export function normalizeResourceHref(
  app: AppName,
  href: string | null | undefined
) {
  if (!href) return null;
  const appPrefix = `/${app}`;
  return href.startsWith(`${appPrefix}/resources/`)
    ? href.slice(appPrefix.length)
    : href;
}

/**
 * Discover the first resource path from the navigation configuration.
 *
 * Queries the DB-driven navigation sections for the given app and returns
 * the href of the first `/resources/*` item found (e.g. `/resources/shipments`).
 * Returns `null` when no resource routes are configured.
 *
 * Usage:
 * ```ts
 * const resourcePath = await discoverResourcePath("console") ?? "/resources/shipments";
 * ```
 */
export async function discoverResourcePath(
  app: AppName,
  resourceKey?: string,
): Promise<string | null> {
  const sections = await fetchNavigationSections(app);
  const resourceRoutes = extractResourceRoutes(sections);
  const requestedResource = resourceKey?.trim();
  if (requestedResource) {
    return normalizeResourceHref(app, resourceRoutes.find((item) => item.resource === requestedResource)?.href);
  }
  const canonicalShipmentsRoute = resourceRoutes.find(
    (item) =>
      item.resource === "shipments" || item.href === "/resources/shipments"
  );
  return normalizeResourceHref(
    app,
    canonicalShipmentsRoute?.href ?? resourceRoutes[0]?.href ?? null
  );
}
