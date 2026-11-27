// route-meta.arabic.test.tsx: breadcrumbs and the browser tab title read the routes catalog in Arabic.
import { describe, expect, it, vi } from 'vitest';

vi.mock('@tanstack/react-router', async () => {
  const actual = await vi.importActual<typeof import('@tanstack/react-router')>('@tanstack/react-router');
  return { ...actual, useLocation: () => ({ pathname: '/platform/imports', search: '' }) };
});

import { renderWithProviders } from '@/test/render';
import { findUntranslated } from '@/test/helpers/untranslated';
import type { IdentityProviderMockValue } from '@/lib/identity';
import { ROUTE_TITLES, buildRouteBreadcrumbs, buildRouteHead } from '@/lib/route-meta';
import en from '@/lib/seed-raw/i18n/areas/en/routes';
import ar from '@/lib/seed-raw/i18n/areas/ar/routes';
import { Topbar } from './Topbar';

const IDENTITY: IdentityProviderMockValue = {
  capabilities: ['all'],
  user: { name: 'Test Operator', access_scope_type: 'tenant', access_scope_id: null, organization_id: 'org_test' },
  scope: { tenant: { id: 'org_test', label: 'Test Logistics', rank: 2 } },
};

describe('route titles in Arabic', () => {
  it('has an Arabic title for every route and a name for every breadcrumb domain', () => {
    expect(Object.keys(ar.routes.titles).sort()).toEqual(Object.keys(ROUTE_TITLES).sort());
    for (const path of Object.keys(ROUTE_TITLES)) {
      const [, domain = ''] = path.split('/');
      if (domain) expect(Object.keys(en.routes.domains), path).toContain(domain);
    }
  });

  it('renders the breadcrumbs and sets the tab title in Arabic', () => {
    const { container } = renderWithProviders(<Topbar />, { locale: 'ar', identity: IDENTITY });
    const crumbs = container.querySelector('.topbar__crumbs')!;
    expect([...crumbs.querySelectorAll('.crumb')].map((crumb) => crumb.textContent)).toEqual([
      ar.routes.titles['/'],
      ar.routes.domains.platform,
      ar.routes.titles['/platform/imports'],
    ]);
    expect(findUntranslated(crumbs)).toEqual([]);
    expect(document.title).toBe(`${ar.routes.titles['/platform/imports']} · وحدة تحكم مَسار إكس`);
  });

  it('keeps English as the default outside React', () => {
    expect(buildRouteBreadcrumbs('/integrations/intake').map((crumb) => crumb.label)).toEqual([
      'Dashboard',
      'External Intake',
      'Inbound requests',
    ]);
    expect(buildRouteHead('/platform/imports').meta[0]?.title).toBe('Import jobs · MasarX Console V2');
  });
});
