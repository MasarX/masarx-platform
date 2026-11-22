import { afterEach, describe, expect, it, vi } from 'vitest';
import { getNavigation } from '@/lib/api';
import { loadNavigation } from './navigation';

vi.mock('@/lib/api', () => ({
  getNavigation: vi.fn(() => ({
    app: 'console',
    groups: [
      {
        id: 'operate',
        label: 'Operate',
        items: [
          {
            key: 'raw_shipments',
            label: 'Raw shipments',
            icon: 'truck',
            route: '/console/resources/shipments?focus=shp_1',
          },
          {
            key: 'raw_shipment_boxes',
            label: 'Shipment boxes',
            icon: 'pkg',
            route: '/console/resources/shipment_boxes',
          },
          {
            key: 'raw_routes',
            label: 'Raw route table',
            icon: 'database',
            route: '/console/resources/routes',
          },
          {
            key: 'raw_basket_items',
            label: 'Basket items',
            icon: 'database',
            route: '/console/resources/basket_items',
          },
          {
            key: 'raw_warehouse_transfers',
            label: 'Warehouse transfer rows',
            icon: 'database',
            route: '/console/resources/warehouse_transfers',
          },
          {
            key: 'dispatch',
            label: 'Dispatch',
            icon: 'map',
            route: '/operate/dispatch',
            capability: 'routes.write',
          },
          {
            key: 'wf-templates',
            label: 'Template studio',
            icon: 'workflow',
            route: '/workflows/templates',
          },
        ],
      },
      {
        id: 'integrations',
        label: 'Integrations',
        items: [
          {
            key: 'mapping',
            label: 'Mapping studio',
            icon: 'git',
            route: '/integrations/mapping',
          },
          {
            key: 'webhook-tester',
            label: 'Webhook tester',
            icon: 'webhook',
            route: '/integrations/webhook-tester',
          },
          {
            key: 'api-gateway',
            label: 'API Gateway',
            icon: 'gauge',
            route: '/insights/api-gateway',
          },
          {
            key: 'plugin-catalog',
            label: 'Plugin catalog',
            icon: 'grid',
            route: '/integrations/catalog',
            capability: 'integrations.read',
          },
          {
            key: 'plugin-studio',
            label: 'Plugin studio',
            icon: 'edit',
            route: '/integrations/plugin-studio',
            capability: 'integrations.write',
          },
        ],
      },
    ],
  })),
}));

describe('loadNavigation', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('normalizes live raw resource routes to domain module routes', () => {
    const nav = loadNavigation();
    expect(nav.groups[0]?.items[0]?.routePath).toBe('/operate/shipments?focus=shp_1');
    expect(nav.groups[0]?.items[1]?.routePath).toBe('/operate/dispatch');
    expect(nav.groups[0]?.items[2]?.routePath).toBe('/operate/baskets');
    expect(nav.groups.find((group) => group.id === 'platform')?.items[0]?.routePath).toBe('/platform/warehouse');
    expect(nav.groups.flatMap((group) => group.items).map((item) => item.label)).toEqual([
      'Shipments',
      'Dispatch',
      'Basket policy',
      'Template studio',
      'Intake mappings',
      'Test webhook intake',
      'API request intake',
      'Plugin catalog',
      'Plugin studio',
      'Warehouse transfers',
    ]);
  });

  it('uses canonical route icons without overwriting curated labels', () => {
    const nav = loadNavigation();
    const itemsByRoute = new Map(nav.groups.flatMap((group) => group.items.map((item) => [item.routePath, item])));

    expect(itemsByRoute.get('/operate/shipments?focus=shp_1')?.iconName).toBe('pkg');
    expect(itemsByRoute.get('/operate/dispatch')?.iconName).toBe('route');
    expect(itemsByRoute.get('/operate/baskets')?.iconName).toBe('layers');
    expect(itemsByRoute.get('/platform/warehouse')?.iconName).toBe('warehouse');
    expect(itemsByRoute.get('/workflows/templates')?.label).toBe('Template studio');
    expect(itemsByRoute.get('/workflows/templates')?.iconName).toBe('workflow');
    expect(itemsByRoute.get('/integrations/mapping')?.label).toBe('Intake mappings');
    expect(itemsByRoute.get('/integrations/webhook-tester')?.label).toBe('Test webhook intake');
    expect(itemsByRoute.get('/insights/api-gateway')?.label).toBe('API request intake');
    expect(itemsByRoute.get('/insights/api-gateway')?.iconName).toBe('gauge');
  });

  it('groups external shipment intake routes under a single operator-facing area', () => {
    const nav = loadNavigation();
    const externalIntake = nav.groups.find((group) => group.id === 'integrations');

    expect(externalIntake?.label).toBe('External Intake');
    expect(externalIntake?.items.map((item) => item.routePath)).toEqual([
      '/integrations/mapping',
      '/integrations/webhook-tester',
      '/insights/api-gateway',
      '/integrations/catalog',
      '/integrations/plugin-studio',
    ]);
    expect(externalIntake?.items.map((item) => item.label)).toEqual([
      'Intake mappings',
      'Test webhook intake',
      'API request intake',
      'Plugin catalog',
      'Plugin studio',
    ]);
  });

  it('uses canonical plugin route capability gates when registry metadata drifts', () => {
    const nav = loadNavigation();
    const itemsByRoute = new Map(nav.groups.flatMap((group) => group.items.map((item) => [item.routePath, item])));

    expect(itemsByRoute.get('/integrations/catalog')?.capability).toBe('integration_plugins.read');
    expect(itemsByRoute.get('/integrations/catalog')?.capabilities).toEqual(['integration_plugins.read']);
    expect(itemsByRoute.get('/integrations/plugin-studio')?.capability).toBe('integration_plugins.write');
    expect(itemsByRoute.get('/integrations/plugin-studio')?.capabilities).toEqual(['integration_plugins.write']);
  });

  it('groups Customer migration with plugin routes and enforces its canonical capability', () => {
    vi.mocked(getNavigation).mockReturnValueOnce({
      groups: [{
        id: 'integrations',
        label: 'Integrations',
        items: [
          { key: 'catalog', route: '/integrations/catalog', label: 'Plugin catalog' },
          {
            key: 'customer-migration',
            route: '/integrations/customer-migration',
            label: 'Legacy customer import',
            capability: 'integrations.read',
          },
          { key: 'studio', route: '/integrations/plugin-studio', label: 'Plugin studio' },
        ],
      }],
    });

    const externalIntake = loadNavigation().groups.find((group) => group.id === 'integrations');
    expect(externalIntake?.label).toBe('External Intake');
    expect(externalIntake?.items.map((item) => item.routePath)).toEqual([
      '/integrations/catalog',
      '/integrations/customer-migration',
      '/integrations/plugin-studio',
    ]);
    expect(externalIntake?.items[1]).toMatchObject({
      label: 'Customer migration',
      iconName: 'upload',
      capability: 'integration_plugins.read',
      capabilities: ['integration_plugins.read'],
    });
  });

  it('keeps Dispatch discoverable for read-only route operators when registry metadata drifts', () => {
    const nav = loadNavigation();
    const itemsByRoute = new Map(nav.groups.flatMap((group) => group.items.map((item) => [item.routePath, item])));

    expect(itemsByRoute.get('/operate/dispatch')?.capability).toBe('routes.read');
    expect(itemsByRoute.get('/operate/dispatch')?.capabilities).toEqual(['routes.read']);
  });

  it('does not expose raw database resource labels or paths after normalization', () => {
    const nav = loadNavigation();
    const items = nav.groups.flatMap((group) => group.items);

    expect(
      items
        .map((item) => item.routePath)
        .filter((routePath) => routePath.startsWith('/console/resources/')),
    ).toEqual([]);
    expect(items.map((item) => item.label)).not.toEqual(
      expect.arrayContaining([
        'Raw shipments',
        'Shipment boxes',
        'Raw route table',
        'Basket items',
        'Warehouse transfer rows',
      ]),
    );
  });
});
