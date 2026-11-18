import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  resolveCommandRoutePath,
  type ShellCommandRegistryRow,
  type ShellCommandRouteItem,
} from './command-routes';

let api: typeof import('@/lib/api');
let loadNavigation: typeof import('./navigation').loadNavigation;

beforeAll(async () => {
  vi.stubEnv('VITE_USE_SEED', 'true');
  [api, { loadNavigation }] = await Promise.all([import('@/lib/api'), import('./navigation')]);
});

afterAll(() => {
  vi.unstubAllEnvs();
});

const navItems: ShellCommandRouteItem[] = [
  { label: 'Dispatch', routePath: '/operate/dispatch' },
  { label: 'Review queue', routePath: '/workflows/review-queue' },
  { label: 'Shipments', routePath: '/operate/shipments' },
  { label: 'Service offerings', routePath: '/catalog/service-offerings' },
];

describe('resolveCommandRoutePath', () => {
  it('uses explicit route_targets.console.path entries', () => {
    expect(
      resolveCommandRoutePath(
        {
          key: 'route_runs.assign',
          section: 'Routes',
          route_targets: { console: { path: '/operate/dispatch' } },
        },
        navItems,
      ),
    ).toBe('/operate/dispatch');
  });

  it('normalizes legacy Console paths only when the explicit path field is present', () => {
    expect(
      resolveCommandRoutePath(
        {
          key: 'shipments.resort',
          section: 'Shipments',
          route_targets: { console: { path: '/console/resources/shipments?focus=SHP-1' } },
        },
        navItems,
      ),
    ).toBe('/operate/shipments?focus=SHP-1');
  });

  it('fails closed for legacy string Console targets', () => {
    expect(
      resolveCommandRoutePath(
        {
          key: 'shipments.resort',
          section: 'Shipments',
          route_targets: { console: '/console/resources/shipments?focus=SHP-1' },
        } as unknown as ShellCommandRegistryRow,
        navItems,
      ),
    ).toBeUndefined();
  });

  it('fails closed without explicit route_targets.console.path instead of using section fallback', () => {
    expect(resolveCommandRoutePath({ key: 'shipments.create', section: 'Shipments' }, navItems)).toBeUndefined();
    expect(
      resolveCommandRoutePath({ key: 'service_offerings.create', section: 'Catalog' }, navItems),
    ).toBeUndefined();
  });

  it('fails closed when explicit path is blank', () => {
    expect(
      resolveCommandRoutePath(
        {
          key: 'shipments.create',
          section: 'Shipments',
          route_targets: { console: { path: '   ' } },
        },
        navItems,
      ),
    ).toBeUndefined();
  });

  it('fails closed when no configured target or matching workbench exists', () => {
    expect(resolveCommandRoutePath({ key: 'unknown.command', section: 'Unknown' }, navItems)).toBeUndefined();
  });

  it('routes row-context commands to their owning workbenches from the registry payload', () => {
    const navigation = loadNavigation();
    const routeItems = navigation.groups.flatMap((group) =>
      group.items.map((item) => ({ label: item.label, routePath: item.routePath })),
    );
    const rows = (api.getCommandRegistry() as ShellCommandRegistryRow[]).filter((row) =>
      [
        'route_runs.assign',
        'route_runs.confirm_departure',
        'route_stops.reassign',
        'tasks.transition',
      ].includes(String(row.key)),
    );
    const resolved = Object.fromEntries(
      rows.map((row) => [String(row.key), resolveCommandRoutePath(row, routeItems)]),
    );

    expect(resolved).toEqual({
      'route_runs.assign': '/operate/dispatch',
      'route_runs.confirm_departure': '/operate/dispatch',
      'route_stops.reassign': '/operate/dispatch',
      'tasks.transition': '/workflows/review-queue',
    });
  });

  it('routes ambiguous registry sections through explicit Console targets', () => {
    const navigation = loadNavigation();
    const routeItems = navigation.groups.flatMap((group) =>
      group.items.map((item) => ({ label: item.label, routePath: item.routePath })),
    );
    const expectedRoutes = {
      'zones.create': '/network/zones',
      'zones.approve_override': '/network/zones',
      'api_gateway.block_source': '/insights/api-gateway',
      'api_gateway.replay_request': '/insights/api-gateway',
      'alerts.create_rule': '/platform/alerts',
      'alerts.test_rule': '/platform/alerts',
      'feature_flags.create': '/platform/feature-flags',
      'feature_flags.bulk_toggle': '/platform/feature-flags',
      'rbac_roles.create': '/platform/access',
      'rbac_roles.apply_template': '/platform/access',
      'service_offerings.create': '/catalog/service-offerings',
      'service_offerings.archive': '/catalog/service-offerings',
      'webhooks.upsert_source': '/integrations/sources',
      'webhooks.archive_source': '/integrations/sources',
      'webhooks.toggle_rule': '/integrations/rules',
      'mappings.upsert': '/integrations/mapping',
      'integrations.create_credential': '/integrations/credentials',
      'integrations.create_plugin': '/integrations/plugin-studio',
      'integrations.retry_inbox': '/integrations/intake',
      'workflow_templates.create': '/workflows/templates',
      'workflow_runs.replay': '/workflows/runs',
      'workflow_bindings.register': '/workflows/bindings',
      'workflow_tasks.bulk_transition': '/workflows/review-queue',
      'drivers.create': '/operate/fleet/drivers',
      'labels.reprint': '/platform/labels',
      'invoices.send': '/finance/billing',
      'marketplace.award_offer': '/network/marketplace',
    };
    const registryByKey = new Map(
      (api.getCommandRegistry() as ShellCommandRegistryRow[]).map((row) => [String(row.key), row]),
    );

    for (const [key, routePath] of Object.entries(expectedRoutes)) {
      const row = registryByKey.get(key);
      expect(row, `missing command registry row for ${key}`).toBeDefined();
      expect(resolveCommandRoutePath(row as ShellCommandRegistryRow, routeItems)).toBe(routePath);
    }
  });

  it('keeps RBAC palette rows on typed backend RPC targets, not generic runCommand', () => {
    const expectedTargets: Record<string, string> = {
      'rbac_roles.create': 'rbac_create_role_v1',
      'rbac_roles.edit': 'rbac_update_role_v1',
      'rbac_roles.delete': 'rbac_delete_role_v1',
      'rbac_roles.grant': 'rbac_grant_role_v1',
      'rbac_roles.revoke': 'rbac_revoke_role_v1',
      'rbac_roles.apply_template': 'provision_rbac_roles_from_templates_v1',
    };
    const registryByKey = new Map(
      (api.getCommandRegistry() as Array<ShellCommandRegistryRow & { target?: string }>).map((row) => [
        String(row.key),
        row,
      ]),
    );

    for (const [key, target] of Object.entries(expectedTargets)) {
      const row = registryByKey.get(key);
      expect(row, `missing command registry row for ${key}`).toBeDefined();
      expect(row?.target).toBe(target);
      expect(row?.target).not.toBe('runCommand');
    }
  });

  it('does not route Billing commands for workflows that are not implemented in Console', () => {
    const navigation = loadNavigation();
    const routeItems = navigation.groups.flatMap((group) =>
      group.items.map((item) => ({ label: item.label, routePath: item.routePath })),
    );
    const unsupportedKeys = [
      'invoices.add_line',
      'invoices.remove_line',
      'invoices.reissue',
    ];
    const registryByKey = new Map(
      (api.getCommandRegistry() as ShellCommandRegistryRow[]).map((row) => [String(row.key), row]),
    );

    for (const key of unsupportedKeys) {
      const row = registryByKey.get(key);
      expect(row, `missing command registry row for ${key}`).toBeDefined();
      expect(resolveCommandRoutePath(row as ShellCommandRegistryRow, routeItems)).toBeUndefined();
    }
  });

  it('keeps Billing command capabilities aligned with the canonical action contracts', () => {
    const navigation = loadNavigation();
    const routeItems = navigation.groups.flatMap((group) =>
      group.items.map((item) => ({ label: item.label, routePath: item.routePath })),
    );
    const registryByKey = new Map(
      (api.getCommandRegistry() as ShellCommandRegistryRow[]).map((row) => [String(row.key), row]),
    );

    expect(resolveCommandRoutePath(registryByKey.get('invoices.mark_paid')!, routeItems)).toBe(
      '/finance/billing',
    );
    expect(registryByKey.get('invoices.mark_paid')?.capability).toBe('billing.write');
    expect(registryByKey.get('invoices.void')?.capability).toBe('billing.write');
    expect(registryByKey.get('invoices.record_refund')?.capability).toBe('invoices.refund');
  });

  it('keeps label reprint command aligned with the dedicated reprint capability', () => {
    const registryByKey = new Map(
      (api.getCommandRegistry() as Array<ShellCommandRegistryRow & { target?: string }>).map((row) => [
        String(row.key),
        row,
      ]),
    );

    expect(registryByKey.get('labels.reprint')?.capability).toBe('labels.reprint');
    expect(registryByKey.get('labels.reprint')?.target).toBe('request_label_reprint');
  });
});
