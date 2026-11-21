// route-meta.ts — Per-route document title + description map.
// TanStack Router's route `head()` option accepts a `{ meta: [...] }` shape
// that updates `document.title` and `<meta>` tags as routes resolve.
// We keep titles static (no runtime hooks here — `head()` runs during route
// resolution, before context providers render).

import { trimTrailingSlashes } from './trim-trailing-slashes';

export const ROUTE_TITLES = {
  '/': 'Dashboard',
  '/operate/route-plans': 'Route plans',
  '/operate/dispatch': 'Dispatch',
  '/operate/shipments': 'Shipments',
  '/operate/baskets': 'Basket policy',
  '/operate/amend-cancel': 'Amend & cancel',
  '/operate/exceptions': 'Exceptions',
  '/operate/returned-to-branch': 'Returned to branch',
  '/operate/pickups': 'Pickups',
  '/operate/tracking-map': 'Tracking map',
  // CLAIM-FLEET-VEHICLES (Wave 1, Phase A) — fleet roster surface.
  '/operate/fleet/vehicles': 'Vehicles',
  // CLAIM-FLEET-DRIVERS (Wave 1, Phase A) — driver roster surface.
  '/operate/fleet/drivers': 'Drivers',
  // Phase D / D1 — driver-signup intake review surface (operator console).
  // Pairs with `supabase/functions/driver-signup-intake/index.ts` and
  // `marketplace_participant_request_review_apply_v1` (Phase B canonical RPC).
  '/operate/fleet/driver-applications': 'Driver applications',
  // `/network/hubs` is DEPRECATED (Phase G · subagent G2). The route file
  // (`src/routes/network/hubs.tsx`) uses `beforeLoad` → `redirect()` to
  // forward to `/network/branches`. The title is kept here so that any
  // legacy bookmark/SSR pre-render still produces a valid `<title>` while
  // the redirect resolves. Decision: __audit__/DECISIONS/HUBS.md.
  '/network/hubs': 'Hubs (deprecated → Branches)',
  '/network/partners': 'Partners',
  '/network/geocoding': 'Geocoding',
  // CLAIM-NETWORK-ZONES (Wave 1, Phase A) — map-first zones surface.
  '/network/zones': 'Zones',
  // CLAIM-NETWORK-BRANCHES (Wave 1, Phase A) — branch roster (cards → drawer).
  '/network/branches': 'Branches',
  // CLAIM-NETWORK-MARKETPLACE (Wave 2, Phase B) — operator marketplace surface.
  '/network/marketplace': 'Marketplace',
  // Phase D5 — non-driver participant onboarding review queue. Mirrors
  // public.marketplace_participant_requests (canonical SSOT). Driver
  // applications flow through the Fleet domain surface.
  '/network/participant-applications': 'Participant applications',
  '/customers/clients': 'Clients',
  '/customers/senders': 'Senders',
  '/customers/recipients': 'Recipients',
  '/catalog/lookups': 'Reference data',
  // CLAIM-CATALOG-OFFERINGS (Wave 2, Phase B) — service catalog browser.
  '/catalog/service-offerings': 'Service offerings',
  '/finance/settlements': 'Settlements',
  '/finance/cod': 'COD',
  '/finance/ledger': 'Ledger',
  '/finance/bank-recon': 'Bank reconciliation',
  '/finance/disputes': 'Disputes',
  // CLAIM-FINANCE-BILLING (Wave 2, Phase B) — operator billing/invoices surface.
  '/finance/billing': 'Billing',
  '/workflows/templates': 'Templates',
  '/workflows/runs': 'Runs',
  '/workflows/bindings': 'Bindings',
  '/workflows/review-queue': 'Review queue',
  '/workflows/queue': 'Review queue',
  '/integrations/catalog': 'Integrations catalog',
  // INTEGRATIONS P0 (Wave 12 W12-2) — 4-stage authoring loop wired to the
  // canonical `integration-plugin-studio` edge function (parse|infer|preview|save).
  '/integrations/plugin-studio': 'Plugin studio',
  '/integrations/mapping': 'Intake mappings',
  '/integrations/health': 'Provider health',
  '/integrations/webhook-tester': 'Test webhook intake',
  '/integrations/credentials': 'Provider credentials',
  '/integrations/customer-migration': 'Customer migration',
  '/integrations/intake': 'Inbound requests',
  '/integrations/sources': 'Sources & tokens',
  '/insights/reporting': 'Reporting',
  '/insights/decisions': 'Decision log',
  '/insights/resolutions': 'Settings resolutions',
  '/insights/traces': 'Traces',
  '/insights/audit': 'Audit log',
  '/insights/ui-events': 'UI events',
  '/insights/telemetry': 'Telemetry',
  '/insights/domain-events': 'Domain events',
  // CLAIM-INSIGHTS-API-GW (Wave 3, Phase C) — Datadog APM / Honeycomb / Postman
  // observability parity surface (api_call_log + api_gateway_requests +
  // api_gateway_rate_limits + api_routes + api_route_packs + provider_health_logs).
  '/insights/api-gateway': 'API request intake',
  '/platform/config': 'Configuration',
  '/platform/access': 'Access control',
  '/platform/organizations': 'Organizations',
  '/platform/onboarding-readiness': 'Onboarding readiness',
  '/platform/mobile-policy': 'Mobile policy',
  '/platform/labels': 'Label Designer & templates',
  '/platform/warehouse': 'Warehouse transfers',
  '/platform/imports': 'Import jobs',
  '/platform/auth-email': 'Auth email policy',
  '/platform/release-proof': 'Release proof',
  '/platform/commands': 'Commands',
  // CLAIM-PLATFORM-ALERTS (Wave 3, Phase C) — Datadog/PagerDuty/Sentry parity
  // alerts management surface (alert_rules + alert_triggers + ops_alerts).
  '/platform/alerts': 'Alerts',
  // CLAIM-PLATFORM-FLAGS (Wave 3, Phase C) — LaunchDarkly/Unleash/GrowthBook
  // parity feature-flag management surface (feature_flags).
  '/platform/feature-flags': 'Feature flags',
  // CLAIM-SUPPORT-CASES (Wave 3, Phase C) — Zendesk/Front/Linear-triage parity
  // support cases triage surface (support_cases + support_messages +
  // support_case_events).
  '/support/cases': 'Support cases',
  // CLAIM-PLATFORM-USERS (Phase D4) — operator users admin surface.
  '/platform/users': 'Users',
} as const satisfies Record<string, string>;

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

const ROUTE_DOMAIN_LABELS = {
  integrations: 'External Intake',
} as const satisfies Partial<Record<string, string>>;

function domainSegmentForRoute(pathname: string, domainSegment: string): string {
  if (pathname === '/insights/api-gateway') return 'integrations';
  return domainSegment;
}

function titleizeSegment(segment: string): string {
  return segment.replace(/[-_]/g, ' ').replace(/\b\w/g, (m) => m.toUpperCase());
}

export function buildRouteBreadcrumbs(pathname: string): RouteBreadcrumb[] {
  const [path = ''] = pathname.split(/[?#]/, 1);
  const normalized = trimTrailingSlashes(path) || '/';
  if (normalized === '/') return [{ label: ROUTE_TITLES['/'], to: '/' }];

  const leafPath = (normalized in ROUTE_TITLES ? normalized : null) as RoutePath | null;
  const [, domainSegment = ''] = normalized.split('/');
  const effectiveDomainSegment = domainSegmentForRoute(normalized, domainSegment);
  const domainRoute = ROUTE_DOMAIN_FALLBACKS[effectiveDomainSegment as keyof typeof ROUTE_DOMAIN_FALLBACKS];
  const breadcrumbs: RouteBreadcrumb[] = [{ label: ROUTE_TITLES['/'], to: '/' }];

  if (domainRoute) {
    const domainLabel =
      ROUTE_DOMAIN_LABELS[effectiveDomainSegment as keyof typeof ROUTE_DOMAIN_LABELS] ??
      titleizeSegment(effectiveDomainSegment);
    breadcrumbs.push({
      label: domainLabel,
      to: domainRoute !== leafPath ? domainRoute : undefined,
    });
  }

  const segments = normalized.split('/');
  const leafLabel = leafPath ? ROUTE_TITLES[leafPath] : titleizeSegment(segments[segments.length - 1] ?? normalized);
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
export function buildRouteHead(path: RoutePath): RouteHead {
  const t = ROUTE_TITLES[path] ?? 'Console V2';
  return {
    meta: [
      { title: `${t} · MasarX Console V2` },
      { name: 'description', content: `MasarX Console V2 · ${t}` },
    ],
  };
}
