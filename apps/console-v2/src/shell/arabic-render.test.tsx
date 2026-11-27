// arabic-render.test.tsx: the console shell renders its own copy in Arabic; only test data stays Latin.
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@tanstack/react-router', async () => {
  const actual = await vi.importActual<typeof import('@tanstack/react-router')>('@tanstack/react-router');
  return {
    ...actual,
    Outlet: () => <div data-testid="shell-outlet" />,
    useLocation: () => ({ pathname: '/', search: '' }),
    useRouter: () => ({ navigate: vi.fn() }),
  };
});

import { renderWithProviders } from '@/test/render';
import { findUntranslated } from '@/test/helpers/untranslated';
import * as api from '@/lib/api';
// @ts-expect-error - seed-raw/*.js has no declaration file by design
import { navigation as seedNavigation } from '@/lib/seed-raw/navigation.js';
import { AppShell } from './AppShell';
import { TenantPicker } from './TenantPicker';
import { Topbar } from './Topbar';
import { UserMenuDrawer } from './UserMenuDrawer';

const TENANT = { id: 'org_test', label: 'Test Logistics', rank: 2 };
const IDENTITY = {
  capabilities: ['all'],
  user: {
    name: 'Test Operator',
    initials: 'TO',
    email: 'operator@example.test',
    access_scope_type: 'tenant',
    access_scope_id: null,
    organization_id: 'org_test',
  },
  scope: { tenant: TENANT },
};
// Test data the shell shows as is: tenant name and its first word, user name, email and initials.
const DATA = ['Test Logistics', 'Test', 'org_test', 'Test Operator', 'operator@example.test', 'TO'];

describe('console shell in Arabic', () => {
  beforeEach(() => {
    window.localStorage.setItem('console-v2.nav-pinned', '1');
    vi.spyOn(api, 'getNavigation').mockReturnValue(seedNavigation as never);
    vi.spyOn(api, 'hasConsoleLiveBackend').mockReturnValue(false);
    vi.spyOn(api, 'hydrateConsoleLiveMetadata').mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('topbar and status bar', () => {
    renderWithProviders(<AppShell />, { locale: 'ar', identity: IDENTITY });
    // Breadcrumbs read route titles from lib/route-meta, outside this shell area.
    const chrome = [...document.querySelectorAll('.topbar, .statusbar')].map((element) => {
      const copy = element.cloneNode(true) as Element;
      copy.querySelectorAll('.topbar__crumbs').forEach((crumbs) => crumbs.remove());
      return copy;
    });
    expect(chrome).toHaveLength(2);
    expect(chrome.flatMap((element) => findUntranslated(element, DATA))).toEqual([]);
  });

  it('cycles the theme with a localized accessible name for each mode', async () => {
    const user = userEvent.setup();
    renderWithProviders(<Topbar />, { locale: 'ar', theme: 'light', identity: IDENTITY });

    await user.click(screen.getByRole('button', { name: /السمة: فاتحة/ }));
    await user.click(screen.getByRole('button', { name: /السمة: داكنة/ }));
    await user.click(screen.getByRole('button', { name: /السمة: النظام/ }));
    expect(screen.getByRole('button', { name: /السمة: فاتحة/ })).toBeInTheDocument();
  });

  it('user menu drawer', () => {
    renderWithProviders(<UserMenuDrawer open onClose={() => {}} onOpenShortcuts={() => {}} />, {
      locale: 'ar',
      identity: IDENTITY,
    });
    expect(screen.getByText('التحكم في الوصول')).toBeInTheDocument();
    expect(screen.getByText('سياسة النطاق والأدوار')).toBeInTheDocument();
    expect(findUntranslated(document.body, DATA)).toEqual([]);
  });

  it('tenant picker trigger and list', async () => {
    const user = userEvent.setup();
    renderWithProviders(<TenantPicker />, {
      locale: 'ar',
      identity: {
        user: { access_scope_type: 'platform', access_scope_id: null },
        capabilities: ['all'],
        scope: { tenant: { id: 'org_unknown', label: '—', rank: 2 } },
      },
    });
    await user.click(screen.getByRole('button', { name: /المستأجر النشط/ }));
    const options = await screen.findAllByRole('option');
    expect(options.length).toBeGreaterThan(0);
    const names = [...document.querySelectorAll('.tenant-picker__item-name')].map((name) => name.textContent ?? '');
    expect(findUntranslated(document.body, names)).toEqual([]);
  });
});
