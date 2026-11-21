// navigation.ts — typed navigation shape for the sidenav, sourced from api.getNavigation().
// Mirrors the ui_navigation snapshot consumed by the demo's app.js. The runtime payload is
// untyped JS (seed-raw/navigation.js), so we narrow it here in one place.
import * as api from '@/lib/api';
import { formatCapabilityRequirement } from '@/lib/capabilities';
import { normalizeConsoleHref } from '@/lib/legacy-hash-navigation';
import { ROUTE_TITLES, type RoutePath } from '@/lib/route-meta';
import type { AccessScopeType } from '@/types/domain';

export interface NavItem {
  key: string;
  label: string;
  iconName: string;
  routePath: string;
  capability?: string | null;
  capabilities?: string[];
  requiredScopeType?: AccessScopeType | null;
  badge?: string | null;
  badgeKind?: 'warn' | 'danger' | 'info' | null;
}

export interface NavSection {
  id: string;
  label: string;
  items: NavItem[];
}

export interface Navigation {
  app: string;
  groups: NavSection[];
}

// Domain icons mirror the demo's collapsed-sidenav iconography (one per group).
export const DOMAIN_ICONS: Record<string, string> = {
  home: 'home',
  today: 'home',
  operate: 'truck',
  operations: 'truck',
  network: 'map',
  customers: 'users',
  support: 'message',
  catalog: 'tag',
  finance: 'wallet',
  workflows: 'workflow',
  integrations: 'plug',
  insights: 'dashboard',
  observability: 'trace',
  configuration: 'settings',
  access: 'shield',
  security: 'shield',
  settings: 'settings',
  'reference-data': 'list',
  reference_data: 'list',
  reference: 'list',
  'label-design': 'file',
  label_design: 'file',
  marketplace: 'shopping-bag',
  platform: 'settings',
};

export const ROUTE_ICONS = {
  '/': 'dashboard',
  '/operate/route-plans': 'workflow',
  '/operate/dispatch': 'route',
  '/operate/shipments': 'pkg',
  '/operate/baskets': 'layers',
  '/operate/amend-cancel': 'edit',
  '/operate/exceptions': 'alert',
  '/operate/returned-to-branch': 'rotate',
  '/operate/pickups': 'upload',
  '/operate/tracking-map': 'pin',
  '/operate/fleet/vehicles': 'truck',
  '/operate/fleet/drivers': 'user',
  '/operate/fleet/driver-applications': 'user_in',
  '/network/hubs': 'building',
  '/network/partners': 'link',
  '/network/geocoding': 'pin',
  '/network/zones': 'map',
  '/network/branches': 'building',
  '/network/marketplace': 'shopping-bag',
  '/network/participant-applications': 'user',
  '/customers/clients': 'building',
  '/customers/senders': 'user_out',
  '/customers/recipients': 'user_in',
  '/catalog/lookups': 'list',
  '/catalog/service-offerings': 'tag',
  '/finance/settlements': 'wallet',
  '/finance/cod': 'wallet',
  '/finance/ledger': 'file',
  '/finance/bank-recon': 'database',
  '/finance/disputes': 'flag',
  '/finance/billing': 'invoice',
  '/workflows/templates': 'workflow',
  '/workflows/runs': 'history',
  '/workflows/bindings': 'git',
  '/workflows/review-queue': 'check',
  '/workflows/queue': 'check',
  '/integrations/catalog': 'grid',
  '/integrations/customer-migration': 'upload',
  '/integrations/plugin-studio': 'edit',
  '/integrations/mapping': 'git',
  '/integrations/health': 'cloud',
  '/integrations/webhook-tester': 'webhook',
  '/integrations/credentials': 'key',
  '/integrations/intake': 'download',
  '/integrations/sources': 'plug',
  '/insights/reporting': 'dashboard',
  '/insights/decisions': 'trace',
  '/insights/resolutions': 'layers',
  '/insights/traces': 'trace_tree',
  '/insights/audit': 'shield',
  '/insights/ui-events': 'eye',
  '/insights/telemetry': 'gauge',
  '/insights/domain-events': 'list',
  '/insights/api-gateway': 'gauge',
  '/platform/config': 'settings',
  '/platform/access': 'shield',
  '/platform/organizations': 'building',
  '/platform/onboarding-readiness': 'check',
  '/platform/mobile-policy': 'shield',
  '/platform/labels': 'file',
  '/platform/warehouse': 'warehouse',
  '/platform/imports': 'inbox',
  '/platform/auth-email': 'lock',
  '/platform/release-proof': 'shield',
  '/platform/commands': 'cmd',
  '/platform/alerts': 'bell',
  '/platform/feature-flags': 'flag',
  '/support/cases': 'message',
  '/platform/users': 'user',
} as const satisfies Record<RoutePath, string>;

const NAV_GROUP_ORDER = [
  'home',
  'operate',
  'workflows',
  'network',
  'customers',
  'catalog',
  'integrations',
  'finance',
  'insights',
  'support',
  'platform',
] as const;

const NAV_GROUP_LABELS: Record<string, string> = {
  home: 'Home',
  operate: 'Operate',
  workflows: 'Workflows',
  network: 'Network',
  customers: 'Customers',
  catalog: 'Catalog',
  integrations: 'External Intake',
  finance: 'Finance',
  insights: 'Insights',
  support: 'Support',
  platform: 'Platform',
};

interface RawItem {
  key: string;
  label: string;
  icon: string;
  route: string;
  capability?: string | null;
  capabilities?: unknown;
  capability_any?: unknown;
  requiredScopeType?: unknown;
  required_scope_type?: unknown;
  badge?: string | null;
  badgeKind?: string | null;
}

interface RawGroup {
  id: string;
  label: string;
  items: RawItem[];
}

interface RawNavigation {
  app: string;
  groups: RawGroup[];
}

function normalizeBadgeKind(kind?: string | null): NavItem['badgeKind'] {
  if (kind === 'warn' || kind === 'danger' || kind === 'info') return kind;
  return null;
}

function routePathname(routePath: string): RoutePath | null {
  const pathname = routePath.split(/[?#]/, 1)[0] || '/';
  return Object.prototype.hasOwnProperty.call(ROUTE_TITLES, pathname)
    ? (pathname as RoutePath)
    : null;
}

function routePathPart(routePath: string): string {
  const withoutHash = routePath.startsWith('#') ? routePath.slice(1) : routePath;
  return withoutHash.split(/[?#]/, 1)[0] || '/';
}

function wasRouteNormalized(rawRoute: string, normalizedRoute: string): boolean {
  return routePathPart(rawRoute) !== routePathPart(normalizedRoute);
}

const CANONICAL_ROUTE_LABELS = new Set<RoutePath>([
  '/integrations/credentials',
  '/integrations/customer-migration',
  '/integrations/intake',
  '/integrations/mapping',
  '/integrations/sources',
  '/integrations/webhook-tester',
  '/insights/api-gateway',
]);

const CANONICAL_ROUTE_CAPABILITIES: Partial<Record<RoutePath, string>> = {
  '/operate/dispatch': 'routes.read',
  '/platform/access': 'access_policy.read',
  '/integrations/catalog': 'integration_plugins.read',
  '/integrations/customer-migration': 'integration_plugins.read',
  '/integrations/intake': 'webhooks.read',
  '/integrations/plugin-studio': 'integration_plugins.write',
};

function labelForItem(rawLabel: string | null | undefined, pathname: RoutePath, normalized: boolean): string {
  const label = String(rawLabel ?? '').trim();
  if (normalized || CANONICAL_ROUTE_LABELS.has(pathname)) return ROUTE_TITLES[pathname];
  return label || ROUTE_TITLES[pathname];
}

function iconForItem(
  rawIcon: string | null | undefined,
  pathname: RoutePath,
  groupId: string,
): string {
  const icon = String(rawIcon ?? '').trim();
  return ROUTE_ICONS[pathname] || icon || DOMAIN_ICONS[groupId] || 'list';
}

function normalizeCapabilityList(raw: RawItem): string[] {
  const values = Array.isArray(raw.capabilities)
    ? raw.capabilities
    : Array.isArray(raw.capability_any)
      ? raw.capability_any
      : [];
  return values
    .map((value) => (typeof value === 'string' ? value.trim() : ''))
    .filter(Boolean);
}

function normalizeRequiredScopeType(raw: RawItem): AccessScopeType | null {
  const value = typeof raw.requiredScopeType === 'string'
    ? raw.requiredScopeType
    : typeof raw.required_scope_type === 'string'
      ? raw.required_scope_type
      : null;
  return value === 'platform' || value === 'tenant' || value === 'client' || value === 'sender'
    ? value
    : null;
}

function groupIdForRoute(pathname: RoutePath): string {
  if (pathname === '/') return 'home';
  if (pathname === '/insights/api-gateway') return 'integrations';
  const [, segment] = pathname.split('/');
  return segment || 'home';
}

function orderGroups(a: NavSection, b: NavSection): number {
  const aIndex = NAV_GROUP_ORDER.indexOf(a.id as (typeof NAV_GROUP_ORDER)[number]);
  const bIndex = NAV_GROUP_ORDER.indexOf(b.id as (typeof NAV_GROUP_ORDER)[number]);
  const safeA = aIndex === -1 ? Number.MAX_SAFE_INTEGER : aIndex;
  const safeB = bIndex === -1 ? Number.MAX_SAFE_INTEGER : bIndex;
  if (safeA !== safeB) return safeA - safeB;
  return a.label.localeCompare(b.label);
}

/** Read + normalize the navigation snapshot once per call. */
export function loadNavigation(): Navigation {
  const raw = api.getNavigation() as RawNavigation;
  const groups = new Map<string, NavSection>();
  const seenRoutes = new Set<RoutePath>();

  for (const g of raw.groups) {
    for (const it of g.items) {
      const routePath = normalizeConsoleHref(it.route);
      const pathname = routePathname(routePath);
      if (!pathname || seenRoutes.has(pathname)) continue;

      const groupId = groupIdForRoute(pathname);
      const routeWasNormalized = wasRouteNormalized(it.route, routePath);
      const canonicalCapability = CANONICAL_ROUTE_CAPABILITIES[pathname];
      const group = groups.get(groupId) ?? {
        id: groupId,
        label: NAV_GROUP_LABELS[groupId] ?? g.label,
        items: [],
      };

      group.items.push({
        key: it.key || pathname,
        label: labelForItem(it.label, pathname, routeWasNormalized),
        iconName: iconForItem(it.icon, pathname, groupId),
        routePath,
        capability: canonicalCapability ?? it.capability ?? null,
        capabilities: canonicalCapability ? [canonicalCapability] : normalizeCapabilityList(it),
        requiredScopeType: normalizeRequiredScopeType(it),
        badge: it.badge ?? null,
        badgeKind: normalizeBadgeKind(it.badgeKind),
      });
      groups.set(groupId, group);
      seenRoutes.add(pathname);
    }
  }

  if (groups.size > 0) {
    return {
      app: raw.app,
      groups: Array.from(groups.values()).sort(orderGroups),
    };
  }

  return {
    app: raw.app,
    groups: raw.groups.map((g) => ({
      id: g.id,
      label: g.label,
      items: g.items.map((it) => ({
        key: it.key,
        label: it.label,
        iconName: it.icon,
        routePath: normalizeConsoleHref(it.route),
        capability: it.capability ?? null,
        requiredScopeType: normalizeRequiredScopeType(it),
        badge: it.badge ?? null,
        badgeKind: normalizeBadgeKind(it.badgeKind),
      })),
    })),
  };
}

/** True when the given nav route matches the current router path (exact or sub-path). */
export function matchRoute(navRoute: string, current: string): boolean {
  if (navRoute === '/' && (current === '/' || current === '')) return true;
  if (navRoute === '/') return false;
  return current === navRoute || current.startsWith(navRoute + '/');
}

/** True when any item in the group has a warn or danger badge. */
export function groupBadgeTone(group: NavSection): 'danger' | 'warn' | null {
  if (group.items.some((it) => it.badgeKind === 'danger')) return 'danger';
  if (group.items.some((it) => it.badgeKind === 'warn')) return 'warn';
  return null;
}

export interface NavAccessContext {
  hasCapability: (capability?: string | null) => boolean;
  currentScopeType?: () => AccessScopeType;
  isPlatformUser?: () => boolean;
}

export function navItemRequiredCapabilities(item: NavItem): string[] {
  return item.capabilities && item.capabilities.length > 0
    ? item.capabilities
    : item.capability
      ? [item.capability]
      : [];
}

function hasRequiredScope(item: NavItem, identity: NavAccessContext): boolean {
  if (!item.requiredScopeType) return true;
  if (item.requiredScopeType === 'platform') {
    return identity.isPlatformUser?.() === true || identity.currentScopeType?.() === 'platform';
  }
  return identity.currentScopeType?.() === item.requiredScopeType;
}

export function canAccessNavItem(item: NavItem, identity: NavAccessContext): boolean {
  const requiredCapabilities = navItemRequiredCapabilities(item);
  const hasRequiredCapability =
    requiredCapabilities.length === 0 ||
    requiredCapabilities.some((capability) => identity.hasCapability(capability));
  return hasRequiredCapability && hasRequiredScope(item, identity);
}

function scopeRequirementLabel(scopeType: AccessScopeType): string {
  switch (scopeType) {
    case 'platform':
      return 'Platform scope';
    case 'tenant':
      return 'Tenant scope';
    case 'client':
      return 'Client scope';
    case 'sender':
      return 'Sender scope';
    default:
      return 'Required scope';
  }
}

export function navItemAccessLabel(item: NavItem): string {
  const requiredCapabilities = navItemRequiredCapabilities(item);
  const capabilityLabel = requiredCapabilities.map((capability) => formatCapabilityRequirement(capability)).join(' or ');
  const scopeLabel = item.requiredScopeType ? scopeRequirementLabel(item.requiredScopeType) : '';

  if (scopeLabel && capabilityLabel) return `${scopeLabel} and ${capabilityLabel}`;
  if (scopeLabel) return `${scopeLabel} required`;
  if (capabilityLabel) return capabilityLabel;
  return item.label;
}
