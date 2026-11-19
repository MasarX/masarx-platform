import { describe, expect, it } from 'vitest';
import { isSupportedIconName } from '@/components/Icon';
import { DOMAIN_ICONS, ROUTE_ICONS, loadNavigation } from './navigation';

describe('navigation icon contract', () => {
  it('uses supported icons for every domain and navigation item', () => {
    const navigation = loadNavigation();
    const missingDomainIcons = navigation.groups
      .map((group) => ({ groupId: group.id, iconName: DOMAIN_ICONS[group.id] }))
      .filter((entry) => !entry.iconName);
    const unsupportedIcons = [
      ...navigation.groups.map((group) => ({
        scope: `domain:${group.id}`,
        iconName: DOMAIN_ICONS[group.id] ?? '',
      })),
      ...navigation.groups.flatMap((group) =>
        group.items.map((item) => ({
          scope: `item:${group.id}/${item.key}`,
          iconName: item.iconName,
        })),
      ),
    ].filter((entry) => !isSupportedIconName(entry.iconName));

    expect(missingDomainIcons).toEqual([]);
    expect(unsupportedIcons).toEqual([]);
  });

  it('keeps every canonical route icon supported', () => {
    expect(
      Object.entries(ROUTE_ICONS)
        .map(([routePath, iconName]) => ({ routePath, iconName }))
        .filter((entry) => !isSupportedIconName(entry.iconName)),
    ).toEqual([]);
  });

  it('uses domain-level icons that match the primary operator mental model', () => {
    expect(DOMAIN_ICONS).toMatchObject({
      operate: 'truck',
      workflows: 'workflow',
      network: 'map',
      customers: 'users',
      catalog: 'tag',
      integrations: 'plug',
      finance: 'wallet',
      insights: 'dashboard',
      support: 'message',
      platform: 'settings',
    });
  });

  it('uses route-level icons for core lifecycle routes that should not inherit generic group icons', () => {
    expect(ROUTE_ICONS).toMatchObject({
      '/operate/dispatch': 'route',
      '/operate/shipments': 'pkg',
      '/operate/baskets': 'layers',
      '/finance/billing': 'invoice',
      '/integrations/sources': 'plug',
      '/network/marketplace': 'shopping-bag',
      '/platform/commands': 'cmd',
    });
  });

  it('covers legacy live backend navigation groups with domain icons', () => {
    const liveGroupIds = [
      'home',
      'workflows',
      'operations',
      'configuration',
      'access',
      'observability',
      'integrations',
      'security',
      'settings',
      'reference-data',
      'label-design',
      'marketplace',
      'platform',
    ];

    expect(
      liveGroupIds
        .map((groupId) => ({ groupId, iconName: DOMAIN_ICONS[groupId] }))
        .filter((entry) => !entry.iconName || !isSupportedIconName(entry.iconName)),
    ).toEqual([]);
  });

  it('supports shell action aliases used by navigation menus and drawers', () => {
    expect(['x', 'save', 'up', 'down'].filter((iconName) => !isSupportedIconName(iconName))).toEqual([]);
  });
});
