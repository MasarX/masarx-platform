// route-meta.ts — Per-route document title + description map.
// TanStack Router's route `head()` option accepts a `{ meta: [...] }` shape
// that updates `document.title` and `<meta>` tags as routes resolve.
// Titles come from the routes catalog. `head()` runs during route resolution,
// before context providers render, so callers pass `t` and English is the default.

import { fill, translateCatalog, type Translate } from './i18n-catalog';
import routeCatalog from './seed-raw/i18n/areas/en/routes';
import { trimTrailingSlashes } from './trim-trailing-slashes';

/** English route titles; the Arabic ones live beside them in the routes catalog. */
export const ROUTE_TITLES = routeCatalog.routes.titles;

const translateRoute: Translate = (path, fallback) => translateCatalog(routeCatalog, path, fallback);

export type RoutePath = keyof typeof ROUTE_TITLES;

export interface RouteBreadcrumb {
  label: string;
  to?: RoutePath;
}

const ROUTE_DOMAIN_FALLBACKS = {
  operate: '/operate/shipments',
  workflows: '/workflows/review-queue',
  network: '/network/branches',
  customers: '/customers/clients',
  catalog: '/catalog/lookups',
  integrations: '/integrations/intake',
  finance: '/finance/settlements',
  insights: '/insights/reporting',
  support: '/support/cases',
  platform: '/platform/config',
} as const satisfies Record<string, RoutePath>;

function domainSegmentForRoute(pathname: string, domainSegment: string): string {
  if (pathname === '/insights/api-gateway') return 'integrations';
  return domainSegment;
}

function titleizeSegment(segment: string): string {
  return segment.replace(/[-_]/g, ' ').replace(/\b\w/g, (m) => m.toUpperCase());
}

export function buildRouteBreadcrumbs(pathname: string, t: Translate = translateRoute): RouteBreadcrumb[] {
  const title = (route: RoutePath) => t(`routes.titles.${route}`, ROUTE_TITLES[route]);
  const [path = ''] = pathname.split(/[?#]/, 1);
  const normalized = trimTrailingSlashes(path) || '/';
  if (normalized === '/') return [{ label: title('/'), to: '/' }];

  const leafPath = (normalized in ROUTE_TITLES ? normalized : null) as RoutePath | null;
  const [, domainSegment = ''] = normalized.split('/');
  const effectiveDomainSegment = domainSegmentForRoute(normalized, domainSegment);
  const domainRoute = ROUTE_DOMAIN_FALLBACKS[effectiveDomainSegment as keyof typeof ROUTE_DOMAIN_FALLBACKS];
  const breadcrumbs: RouteBreadcrumb[] = [{ label: title('/'), to: '/' }];

  if (domainRoute) {
    const domainLabel = t(`routes.domains.${effectiveDomainSegment}`);
    breadcrumbs.push({
      label: domainLabel,
      to: domainRoute !== leafPath ? domainRoute : undefined,
    });
  }

  const segments = normalized.split('/');
  const leafLabel = leafPath
    ? title(leafPath)
    : fill(t('routes.unknownPage'), { segment: titleizeSegment(segments[segments.length - 1] ?? normalized) });
  if (breadcrumbs[breadcrumbs.length - 1]?.label !== leafLabel) {
    breadcrumbs.push({ label: leafLabel });
  }

  return breadcrumbs;
}

export interface RouteHead {
  meta: Array<{ title?: string; name?: string; content?: string }>;
}

/**
 * Build the per-route head shape consumed by TanStack Router's `head` option.
 * Sets `<title>` + a description meta tag derived from the route's leaf title.
 */
export function buildRouteHead(path: RoutePath, t: Translate = translateRoute): RouteHead {
  const page = t(`routes.titles.${path}`, ROUTE_TITLES[path]);
  return {
    meta: [
      { title: fill(t('routes.documentTitle'), { page }) },
      { name: 'description', content: fill(t('routes.description'), { page }) },
    ],
  };
}
