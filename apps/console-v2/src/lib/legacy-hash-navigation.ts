import { resolveLegacyConsoleResourceRoute, resolveLegacyConsoleRoute } from './legacy-routes';
import { ROUTE_TITLES, type RoutePath } from './route-meta';

export interface ConsoleNavigationTarget {
  to: RoutePath;
  search: Record<string, string>;
}

function splitPathAndSearch(value: string): { path: string; search: string } {
  const queryIndex = value.indexOf('?');
  if (queryIndex === -1) return { path: value, search: '' };
  return {
    path: value.slice(0, queryIndex),
    search: value.slice(queryIndex + 1),
  };
}

function searchRecord(search: string): Record<string, string> {
  const params = new URLSearchParams(search);
  const out: Record<string, string> = {};
  for (const [key, value] of params.entries()) out[key] = value;
  return out;
}

function routePathOrNull(path: string): RoutePath | null {
  if (path in ROUTE_TITLES) return path as RoutePath;

  const legacyConsoleRoute = resolveLegacyConsoleRoute(path);
  if (legacyConsoleRoute) return legacyConsoleRoute;

  const legacyResourcePrefix = '/console/resources/';
  if (path.startsWith(legacyResourcePrefix)) {
    return resolveLegacyConsoleResourceRoute(path.slice(legacyResourcePrefix.length));
  }

  return null;
}

function legacyResourceName(path: string): string | null {
  const legacyResourcePrefix = '/console/resources/';
  if (!path.startsWith(legacyResourcePrefix)) return null;
  return path.slice(legacyResourcePrefix.length).trim().toLowerCase();
}

function normalizeLegacyResourceSearch(path: string, search: Record<string, string>): Record<string, string> {
  const resource = legacyResourceName(path);
  const parentContextResources = new Set([
    'basket_items',
    'basket_transitions',
    'label_jobs',
    'labels',
    'scan_events',
    'shipment_actions',
    'shipment_boxes',
    'shipment_reference_numbers',
  ]);
  if (!resource || !parentContextResources.has(resource)) return search;
  const focus = search.focus?.trim();
  if (!focus) return search;
  const { focus: _focus, ...rest } = search;
  return {
    ...rest,
    legacy_resource: resource,
    legacy_focus: focus,
  };
}

export function resolveLegacyHashNavigation(hash: string): ConsoleNavigationTarget | null {
  if (!hash) return null;
  const withoutHash = hash.startsWith('#') ? hash.slice(1) : hash;
  if (!withoutHash.startsWith('/')) return null;

  const { path, search } = splitPathAndSearch(withoutHash);
  const routePath = routePathOrNull(path);
  if (!routePath) return null;

  return {
    to: routePath,
    search: normalizeLegacyResourceSearch(path, searchRecord(search)),
  };
}

export function normalizeConsoleHref(href: string): string {
  const target = resolveLegacyHashNavigation(href);
  if (!target) return href;

  const params = new URLSearchParams(target.search);
  const query = params.toString();
  return query ? `${target.to}?${query}` : target.to;
}
