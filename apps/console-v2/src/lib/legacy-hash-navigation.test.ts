import { describe, expect, it } from 'vitest';
import { normalizeConsoleHref, resolveLegacyHashNavigation } from './legacy-hash-navigation';

describe('legacy hash navigation bridge', () => {
  it('turns legacy hash routes into real Console V2 route targets', () => {
    expect(resolveLegacyHashNavigation('#/operate/amend-cancel')).toEqual({
      to: '/operate/amend-cancel',
      search: {},
    });
    expect(resolveLegacyHashNavigation('#/operate/shipments?focus=shp_9381200')).toEqual({
      to: '/operate/shipments',
      search: { focus: 'shp_9381200' },
    });
  });

  it('maps legacy resource hashes directly to canonical modules', () => {
    expect(resolveLegacyHashNavigation('#/console/resources/shipments')).toEqual({
      to: '/operate/shipments',
      search: {},
    });
    expect(resolveLegacyHashNavigation('#/console/resources/basket_items?focus=bsi_001')).toEqual({
      to: '/operate/baskets',
      search: { legacy_resource: 'basket_items', legacy_focus: 'bsi_001' },
    });
    expect(resolveLegacyHashNavigation('/console/resources/basket_transitions?focus=bst_001')).toEqual({
      to: '/operate/baskets',
      search: { legacy_resource: 'basket_transitions', legacy_focus: 'bst_001' },
    });
    expect(resolveLegacyHashNavigation('/console/resources/shipment_boxes?focus=box_001')).toEqual({
      to: '/operate/shipments',
      search: { legacy_resource: 'shipment_boxes', legacy_focus: 'box_001' },
    });
    expect(resolveLegacyHashNavigation('/console/resources/service_offerings?focus=svc_001')).toEqual({
      to: '/catalog/service-offerings',
      search: { focus: 'svc_001' },
    });
  });

  it('maps direct legacy Console paths to canonical modules', () => {
    expect(resolveLegacyHashNavigation('/console/workflows/queue')).toEqual({
      to: '/workflows/review-queue',
      search: {},
    });
    expect(resolveLegacyHashNavigation('/console/operations/customer-shipment-changes?focus=SHP-1')).toEqual({
      to: '/operate/amend-cancel',
      search: { focus: 'SHP-1' },
    });
  });

  it('ignores non-route document hashes and unknown modules', () => {
    expect(resolveLegacyHashNavigation('#main')).toBeNull();
    expect(resolveLegacyHashNavigation('#/not-a-real-route')).toBeNull();
  });

  it('normalizes legacy deep links before opening a new tab', () => {
    expect(normalizeConsoleHref('#/operate/shipments?focus=shp_9381200')).toBe(
      '/operate/shipments?focus=shp_9381200',
    );
    expect(normalizeConsoleHref('/operate/shipments?focus=shp_9381200')).toBe(
      '/operate/shipments?focus=shp_9381200',
    );
    expect(normalizeConsoleHref('/console/resources/basket_items?focus=bsi_001')).toBe(
      '/operate/baskets?legacy_resource=basket_items&legacy_focus=bsi_001',
    );
    expect(normalizeConsoleHref('/dashboard')).toBe('/');
  });
});
