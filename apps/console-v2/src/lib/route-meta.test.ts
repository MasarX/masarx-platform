import { describe, expect, it } from 'vitest';
import { ROUTE_TITLES, buildRouteBreadcrumbs, buildRouteHead } from './route-meta';

describe('route metadata aliases', () => {
  it('keeps direct legacy workbench aliases titled before their redirect resolves', () => {
    expect(ROUTE_TITLES['/workflows/queue']).toBe('Review queue');
    expect(ROUTE_TITLES['/insights/telemetry']).toBe('Telemetry');

    expect(buildRouteHead('/workflows/queue').meta[0]?.title).toContain('Review queue');
    expect(buildRouteHead('/workflows/queue').meta[0]?.title).toContain('MasarX Console V2');
    expect(buildRouteHead('/insights/telemetry').meta[0]?.title).toContain('Telemetry');
    expect(buildRouteHead('/insights/telemetry').meta[0]?.title).toContain('MasarX Console V2');
  });

  it('builds route-aware breadcrumb links for operator navigation', () => {
    expect(buildRouteBreadcrumbs('/platform/imports')).toEqual([
      { label: 'Dashboard', to: '/' },
      { label: 'Platform', to: '/platform/config' },
      { label: 'Import jobs' },
    ]);

    expect(buildRouteBreadcrumbs('/integrations/intake')).toEqual([
      { label: 'Dashboard', to: '/' },
      { label: 'External Intake' },
      { label: 'Inbound requests' },
    ]);

    expect(buildRouteBreadcrumbs('/insights/api-gateway')).toEqual([
      { label: 'Dashboard', to: '/' },
      { label: 'External Intake', to: '/integrations/intake' },
      { label: 'API request intake' },
    ]);

    expect(buildRouteBreadcrumbs('/')).toEqual([{ label: 'Dashboard', to: '/' }]);
  });
});
