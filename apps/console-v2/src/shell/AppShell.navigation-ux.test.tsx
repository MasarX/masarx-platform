import { act } from 'react';
import { fireEvent, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const routerMocks = vi.hoisted(() => ({
  navigate: vi.fn(),
  pathname: '/',
  search: '',
}));

vi.mock('@tanstack/react-router', async () => {
  const actual = await vi.importActual<typeof import('@tanstack/react-router')>(
    '@tanstack/react-router',
  );
  return {
    ...actual,
    Outlet: () => <div data-testid="shell-outlet" />,
    useLocation: () => ({
      pathname: routerMocks.pathname,
      search: routerMocks.search,
    }),
    useRouter: () => ({ navigate: routerMocks.navigate }),
  };
});

import { renderWithProviders } from '@/test/render';
import * as api from '@/lib/api';
// @ts-expect-error - seed-raw/*.js has no declaration file by design
import { navigation as seedNavigation } from '@/lib/seed-raw/navigation.js';
import { AppShell } from './AppShell';

function paletteRowByLabel(label: string): HTMLElement {
  const row = Array.from(document.querySelectorAll<HTMLElement>('.palette__item')).find(
    (item) => item.querySelector('.palette__item-label')?.textContent?.trim() === label,
  );
  expect(row, `missing palette row ${label}`).toBeTruthy();
  return row as HTMLElement;
}

describe('AppShell navigation permission UX', () => {
  beforeEach(() => {
    routerMocks.navigate.mockClear();
    routerMocks.pathname = '/';
    routerMocks.search = '';
    window.history.pushState(null, '', '/');
    window.localStorage.setItem('console-v2.nav-pinned', '0');
    vi.spyOn(api, 'getNavigation').mockReturnValue(seedNavigation as never);
    vi.spyOn(api, 'hasConsoleLiveBackend').mockReturnValue(false);
    vi.spyOn(api, 'hydrateConsoleLiveMetadata').mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('keeps module navigation selectable while disabling missing-capability command actions', async () => {
    const user = userEvent.setup();
    vi.spyOn(api, 'getCommandRegistry').mockReturnValue([
      {
        key: 'shipments.create',
        label: 'Create shipment',
        section: 'Shipments',
        capability: 'shipments.write',
        route_targets: { console: { path: '/operate/shipments' } },
      },
    ] as never);

    renderWithProviders(<AppShell />, {
      capabilities: ['shipments.read'],
      identity: {
        capabilities: ['shipments.read'],
        user: {
          access_scope_type: 'tenant',
          access_scope_id: null,
          organization_id: 'org_test',
        },
        scope: {
          tenant: { id: 'org_test', label: 'Test Logistics', rank: 2 },
        },
      },
    });

    await user.click(screen.getByRole('button', { name: /open command palette/i }));

    const actionRow = paletteRowByLabel('Create shipment');
    expect(actionRow).toHaveClass('is-disabled');
    expect(actionRow).toHaveTextContent(/Shipment Update permission required/i);

    routerMocks.navigate.mockClear();
    await user.click(actionRow);
    expect(routerMocks.navigate).not.toHaveBeenCalled();

    const moduleRow = paletteRowByLabel('Shipments');
    expect(moduleRow).not.toHaveClass('is-disabled');
    await user.click(moduleRow);
    expect(routerMocks.navigate).toHaveBeenCalledWith(
      expect.objectContaining({ to: '/operate/shipments' }),
    );
  });

  it('refreshes an empty open command palette after metadata hydration completes', async () => {
    const user = userEvent.setup();
    let metadataReady = false;
    vi.spyOn(api, 'getNavigation').mockImplementation(() =>
      metadataReady ? (seedNavigation as never) : ({ groups: [] } as never),
    );
    vi.spyOn(api, 'getCommandRegistry').mockImplementation(() =>
      metadataReady
        ? ([
            {
              key: 'invoices.void',
              label: 'Void invoice',
              section: 'Billing',
              capability: 'billing.write',
              route_targets: { console: { path: '/finance/billing' } },
            },
          ] as never)
        : ([] as never),
    );
    vi.spyOn(api, 'hydrateConsoleLiveMetadata').mockImplementation(async () => {
      metadataReady = true;
    });

    renderWithProviders(<AppShell />, {
      capabilities: ['billing.write'],
      identity: {
        capabilities: ['billing.write'],
        user: {
          access_scope_type: 'platform',
          access_scope_id: null,
          organization_id: 'org_platform',
        },
        scope: {
          global: { id: 'platform', label: 'Platform', rank: 1 },
        },
      },
    });

    await user.click(screen.getByRole('button', { name: /open command palette/i }));
    expect(await screen.findByText('Void invoice')).toBeInTheDocument();

    const actionRow = paletteRowByLabel('Void invoice');
    expect(actionRow).not.toHaveClass('is-disabled');
    await user.click(actionRow);
    expect(routerMocks.navigate).toHaveBeenCalledWith(
      expect.objectContaining({ to: '/finance/billing' }),
    );
  });

  it('disables platform-only command-palette routes for tenant-scoped signup readers', async () => {
    const user = userEvent.setup();

    renderWithProviders(<AppShell />, {
      identity: {
        capabilities: ['tenant_signup_requests.read', 'lookups.read'],
        user: {
          access_scope_type: 'tenant',
          access_scope_id: null,
          organization_id: 'org_rashed',
        },
        scope: {
          tenant: { id: 'org_rashed', label: 'Rashed Logistics', rank: 2 },
        },
      },
    });

    await user.click(screen.getByRole('button', { name: /open command palette/i }));

    const organizationsRow = paletteRowByLabel('Organizations & requests');
    expect(organizationsRow).toHaveClass('is-disabled');
    expect(organizationsRow).toHaveTextContent(/Platform scope/i);

    await user.click(organizationsRow);
    expect(routerMocks.navigate).not.toHaveBeenCalledWith(
      expect.objectContaining({ to: '/platform/organizations' }),
    );
  });

  it('does not fetch shell alerts before the operator session is ready', async () => {
    const listSpy = vi.spyOn(api, 'ui_list_resource_v1');

    renderWithProviders(<AppShell />, {
      capabilities: ['all'],
      identity: {
        authStatus: 'loading',
        capabilities: ['all'],
        user: {
          access_scope_type: 'platform',
          access_scope_id: null,
          organization_id: 'org_platform',
        },
        scope: {
          global: { id: 'platform', label: 'Platform', rank: 1 },
        },
      },
    });

    expect(screen.getByTestId('app-guard-loading')).toBeInTheDocument();
    await act(async () => {
      await Promise.resolve();
    });
    expect(listSpy).not.toHaveBeenCalledWith('ops_alerts', expect.anything());
  });

  it('persists the collapsed Operate flyout after a domain click', () => {
    vi.useFakeTimers();

    renderWithProviders(<AppShell />, {
      capabilities: ['all'],
      identity: {
        capabilities: ['all'],
        user: {
          access_scope_type: 'tenant',
          access_scope_id: null,
          organization_id: 'org_test',
        },
        scope: {
          tenant: { id: 'org_test', label: 'Test Logistics', rank: 2 },
        },
      },
    });

    const operateButton = screen.getByRole('button', { name: 'Operate' });
    fireEvent.click(operateButton);

    expect(screen.getByText('Route plans')).toBeInTheDocument();
    expect(screen.getByText('Dispatch')).toBeInTheDocument();
    expect(routerMocks.navigate).not.toHaveBeenCalled();

    fireEvent.mouseLeave(operateButton);
    act(() => {
      vi.advanceTimersByTime(300);
    });

    expect(screen.getByText('Route plans')).toBeInTheDocument();
    expect(screen.getByText('Dispatch')).toBeInTheDocument();
  });

  it('closes a stale collapsed flyout when another in-app control changes route', async () => {
    const user = userEvent.setup();
    const view = renderWithProviders(<AppShell />, {
      capabilities: ['all'],
      identity: {
        capabilities: ['all'],
        user: {
          access_scope_type: 'platform',
          access_scope_id: null,
          organization_id: 'org_platform',
        },
        scope: {
          global: { id: 'platform', label: 'Platform', rank: 1 },
        },
      },
    });

    await user.click(screen.getByRole('button', { name: 'Operate' }));
    expect(screen.getByText('Route plans')).toBeInTheDocument();

    routerMocks.pathname = '/platform/users';
    routerMocks.search = '?organization_id=org_handoff';
    view.rerender(<AppShell />);

    expect(screen.queryByText('Route plans')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Platform' })).toHaveClass('is-active');
  });

  it('keeps API request intake reachable from visible External Intake navigation', async () => {
    const user = userEvent.setup();
    vi.spyOn(api, 'hasConsoleLiveBackend').mockReturnValue(true);
    renderWithProviders(<AppShell />, {
      capabilities: ['all'],
      identity: {
        capabilities: ['all'],
        user: {
          access_scope_type: 'platform',
          access_scope_id: null,
          organization_id: 'org_platform',
        },
        scope: {
          global: { id: 'platform', label: 'Platform', rank: 1 },
        },
      },
    });

    await user.click(await screen.findByRole('button', { name: 'External Intake' }));
    await user.click(await screen.findByRole('link', { name: 'API request intake' }));

    expect(routerMocks.navigate).toHaveBeenCalledWith(
      expect.objectContaining({ to: '/insights/api-gateway' }),
    );
  });
});
