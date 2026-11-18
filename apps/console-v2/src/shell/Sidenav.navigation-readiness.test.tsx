import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const routerMocks = vi.hoisted(() => ({
  navigate: vi.fn(),
  pathname: '/operate/dispatch',
}));

vi.mock('@tanstack/react-router', async () => {
  const actual = await vi.importActual<typeof import('@tanstack/react-router')>(
    '@tanstack/react-router',
  );
  return {
    ...actual,
    useLocation: () => ({ pathname: routerMocks.pathname }),
    useRouter: () => ({ navigate: routerMocks.navigate }),
  };
});

vi.mock('@/components/Icon', () => ({
  Icon: ({ name, size = 14 }: { name: string; size?: number }) => (
    <svg data-icon-name={name} data-icon-size={size} />
  ),
}));

vi.mock('@/lib/useConsoleNavigator', () => ({
  useConsoleNavigator: () => (to: string) => routerMocks.navigate({ to }),
}));

import { renderWithProviders } from '@/test/render';
import * as api from '@/lib/api';
// @ts-expect-error - seed-raw/*.js has no declaration file by design
import { navigation as seedNavigation } from '@/lib/seed-raw/navigation.js';
import { Sidenav, SidenavFlyout } from './Sidenav';
import { loadNavigation } from './navigation';

const CANONICAL_VISIBLE_LINKS = [
  { label: 'Dashboard', routePath: '/', iconName: 'dashboard' },
  { label: 'Route plans', routePath: '/operate/route-plans', iconName: 'workflow' },
  { label: 'Dispatch', routePath: '/operate/dispatch', iconName: 'route' },
  { label: 'Shipments', routePath: '/operate/shipments', iconName: 'pkg' },
  { label: 'Basket policy', routePath: '/operate/baskets', iconName: 'layers' },
  { label: 'Amend & cancel', routePath: '/operate/amend-cancel', iconName: 'edit' },
  { label: 'Exceptions (NDR)', routePath: '/operate/exceptions', iconName: 'alert' },
  { label: 'Returned to branch', routePath: '/operate/returned-to-branch', iconName: 'rotate' },
  { label: 'Pickups', routePath: '/operate/pickups', iconName: 'upload' },
  { label: 'Tracking map', routePath: '/operate/tracking-map', iconName: 'pin' },
  { label: 'Drivers', routePath: '/operate/fleet/drivers', iconName: 'user' },
  { label: 'Vehicles', routePath: '/operate/fleet/vehicles', iconName: 'truck' },
  { label: 'Driver applications', routePath: '/operate/fleet/driver-applications', iconName: 'user_in' },
  { label: 'Template studio', routePath: '/workflows/templates', iconName: 'workflow' },
  { label: 'Run history', routePath: '/workflows/runs', iconName: 'history' },
  { label: 'Bindings & triggers', routePath: '/workflows/bindings', iconName: 'git' },
  { label: 'Review queue', routePath: '/workflows/review-queue', iconName: 'check' },
  { label: 'Branches', routePath: '/network/branches', iconName: 'building' },
  { label: 'Zones', routePath: '/network/zones', iconName: 'map' },
  { label: 'Marketplace', routePath: '/network/marketplace', iconName: 'shopping-bag' },
  { label: 'Participant applications', routePath: '/network/participant-applications', iconName: 'user' },
  { label: 'Clients', routePath: '/customers/clients', iconName: 'building' },
  { label: 'Senders', routePath: '/customers/senders', iconName: 'user_out' },
  { label: 'Recipients', routePath: '/customers/recipients', iconName: 'user_in' },
  { label: 'Service offerings', routePath: '/catalog/service-offerings', iconName: 'tag' },
  { label: 'Intake mappings', routePath: '/integrations/mapping', iconName: 'git' },
  { label: 'Test webhook intake', routePath: '/integrations/webhook-tester', iconName: 'webhook' },
  { label: 'Inbound requests', routePath: '/integrations/intake', iconName: 'download' },
  { label: 'Sources & tokens', routePath: '/integrations/sources', iconName: 'plug' },
  { label: 'Routing rules', routePath: '/integrations/rules', iconName: 'route' },
  { label: 'Billing', routePath: '/finance/billing', iconName: 'invoice' },
  { label: 'API request intake', routePath: '/insights/api-gateway', iconName: 'gauge' },
  { label: 'Support cases', routePath: '/support/cases', iconName: 'message' },
  { label: 'Organizations & requests', routePath: '/platform/organizations', iconName: 'building' },
  { label: 'Users', routePath: '/platform/users', iconName: 'user' },
  { label: 'Access control', routePath: '/platform/access', iconName: 'shield' },
  { label: 'Configuration', routePath: '/platform/config', iconName: 'settings' },
  { label: 'Onboarding readiness', routePath: '/platform/onboarding-readiness', iconName: 'check' },
  { label: 'Mobile policies', routePath: '/platform/mobile-policy', iconName: 'shield' },
  { label: 'Label Designer & templates', routePath: '/platform/labels', iconName: 'file' },
  { label: 'Warehouse transfers', routePath: '/platform/warehouse', iconName: 'warehouse' },
  { label: 'Import jobs', routePath: '/platform/imports', iconName: 'inbox' },
  { label: 'Auth email policy', routePath: '/platform/auth-email', iconName: 'lock' },
  { label: 'Release proof', routePath: '/platform/release-proof', iconName: 'shield' },
  { label: 'Planning OS', routePath: '/platform/planning-os', iconName: 'kanban' },
  { label: 'Commands', routePath: '/platform/commands', iconName: 'cmd' },
  { label: 'Alerts', routePath: '/platform/alerts', iconName: 'bell' },
  { label: 'Feature flags', routePath: '/platform/feature-flags', iconName: 'flag' },
] as const;

const RAW_TABLE_LABELS = [
  'Raw shipments',
  'Shipment boxes',
  'Route runs',
  'Route stops',
  'Basket items',
  'Warehouse transfers table',
  'Workflow templates table',
];

const OPERATE_CLICK_TARGETS = [
  { label: 'Route plans', routePath: '/operate/route-plans' },
  { label: 'Dispatch', routePath: '/operate/dispatch' },
  { label: 'Shipments', routePath: '/operate/shipments' },
  { label: 'Basket policy', routePath: '/operate/baskets' },
  { label: 'Amend & cancel', routePath: '/operate/amend-cancel' },
  { label: 'Exceptions (NDR)', routePath: '/operate/exceptions' },
  { label: 'Returned to branch', routePath: '/operate/returned-to-branch' },
  { label: 'Pickups', routePath: '/operate/pickups' },
  { label: 'Tracking map', routePath: '/operate/tracking-map' },
  { label: 'Drivers', routePath: '/operate/fleet/drivers' },
  { label: 'Vehicles', routePath: '/operate/fleet/vehicles' },
  { label: 'Driver applications', routePath: '/operate/fleet/driver-applications' },
] as const;

const WORKFLOWS_CLICK_TARGETS = [
  { label: 'Template studio', routePath: '/workflows/templates' },
  { label: 'Run history', routePath: '/workflows/runs' },
  { label: 'Bindings & triggers', routePath: '/workflows/bindings' },
  { label: 'Review queue', routePath: '/workflows/review-queue' },
] as const;

const NETWORK_CLICK_TARGETS = [
  { label: 'Branches', routePath: '/network/branches' },
  { label: 'Zones', routePath: '/network/zones' },
  { label: 'Marketplace', routePath: '/network/marketplace' },
  { label: 'Participant applications', routePath: '/network/participant-applications' },
] as const;

const CUSTOMER_CLICK_TARGETS = [
  { label: 'Clients', routePath: '/customers/clients' },
  { label: 'Senders', routePath: '/customers/senders' },
  { label: 'Recipients', routePath: '/customers/recipients' },
] as const;

const PLATFORM_CLICK_TARGETS = [
  { label: 'Organizations & requests', routePath: '/platform/organizations' },
  { label: 'Users', routePath: '/platform/users' },
  { label: 'Access control', routePath: '/platform/access' },
  { label: 'Configuration', routePath: '/platform/config' },
  { label: 'Onboarding readiness', routePath: '/platform/onboarding-readiness' },
  { label: 'Mobile policies', routePath: '/platform/mobile-policy' },
  { label: 'Label Designer & templates', routePath: '/platform/labels' },
  { label: 'Warehouse transfers', routePath: '/platform/warehouse' },
  { label: 'Import jobs', routePath: '/platform/imports' },
  { label: 'Auth email policy', routePath: '/platform/auth-email' },
  { label: 'Release proof', routePath: '/platform/release-proof' },
  { label: 'Planning OS', routePath: '/platform/planning-os' },
  { label: 'Commands', routePath: '/platform/commands' },
  { label: 'Alerts', routePath: '/platform/alerts' },
  { label: 'Feature flags', routePath: '/platform/feature-flags' },
] as const;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function renderPinnedSidenav() {
  return renderWithProviders(<Sidenav pinned onTogglePin={() => {}} />, {
    capabilities: ['all'],
  });
}

function getNavLink(nav: HTMLElement, label: string): HTMLAnchorElement {
  return within(nav).getByRole('link', {
    name: new RegExp(`^${escapeRegExp(label)}(?:\\s|$)`),
  }) as HTMLAnchorElement;
}

function getPinnedNavLinksByLabel(nav: HTMLElement): Map<string, HTMLAnchorElement> {
  const links = within(nav).getAllByRole('link') as HTMLAnchorElement[];
  return new Map(
    links.map((link) => [
      link.querySelector('.nav-item__label')?.textContent?.trim() ?? '',
      link,
    ]),
  );
}

describe('Sidenav readiness navigation contract', () => {
  beforeEach(() => {
    routerMocks.navigate.mockClear();
    routerMocks.pathname = '/operate/dispatch';
    vi.spyOn(api, 'getNavigation').mockReturnValue(seedNavigation as never);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders canonical Console V2 routes as visible pinned sidebar links with corrected icons', () => {
    renderPinnedSidenav();
    const nav = screen.getByRole('navigation', { name: 'Primary' });
    const linksByLabel = getPinnedNavLinksByLabel(nav);

    for (const { label, routePath, iconName } of CANONICAL_VISIBLE_LINKS) {
      const link = linksByLabel.get(label);
      expect(link).toBeTruthy();
      expect(link!).toHaveAttribute('href', routePath);
      expect(link!.querySelector(`[data-icon-name="${iconName}"]`)).not.toBeNull();
    }

    expect(getNavLink(nav, 'Dispatch')).toHaveAttribute('aria-current', 'page');
  });

  it('does not expose raw database table pages as primary sidebar destinations', () => {
    renderPinnedSidenav();
    const nav = screen.getByRole('navigation', { name: 'Primary' });
    const links = within(nav).getAllByRole('link') as HTMLAnchorElement[];

    expect(
      links.map((link) => link.getAttribute('href') ?? '').filter((href) => href.startsWith('/console/resources/')),
    ).toEqual([]);

    for (const label of RAW_TABLE_LABELS) {
      expect(
        within(nav).queryByRole('link', { name: new RegExp(`^${escapeRegExp(label)}\\b`, 'i') }),
      ).toBeNull();
    }
  });

  it('keeps lifecycle review, mapping, webhook, and import routes clickable for read/review operators', () => {
    renderWithProviders(<Sidenav pinned onTogglePin={() => {}} />, {
      identity: {
        capabilities: ['tenant_signup_requests.read', 'mappings.read', 'webhooks.read', 'imports.read', 'api_gateway.read'],
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
    const nav = screen.getByRole('navigation', { name: 'Primary' });

    expect(getNavLink(nav, 'Organizations & requests')).toHaveAttribute('href', '/platform/organizations');
    expect(getNavLink(nav, 'Organizations & requests')).not.toHaveClass('is-locked');
    expect(getNavLink(nav, 'Intake mappings')).toHaveAttribute('href', '/integrations/mapping');
    expect(getNavLink(nav, 'Intake mappings')).not.toHaveClass('is-locked');
    expect(getNavLink(nav, 'Test webhook intake')).toHaveAttribute('href', '/integrations/webhook-tester');
    expect(getNavLink(nav, 'Test webhook intake')).not.toHaveClass('is-locked');
    expect(getNavLink(nav, 'Inbound requests')).toHaveAttribute('href', '/integrations/intake');
    expect(getNavLink(nav, 'Inbound requests')).not.toHaveClass('is-locked');
    expect(getNavLink(nav, 'API request intake')).toHaveAttribute('href', '/insights/api-gateway');
    expect(getNavLink(nav, 'API request intake')).not.toHaveClass('is-locked');
    expect(getNavLink(nav, 'Import jobs')).toHaveAttribute('href', '/platform/imports');
    expect(getNavLink(nav, 'Import jobs')).not.toHaveClass('is-locked');
  });

  it('keeps Inbound requests gated by webhooks.read when stale live navigation metadata disagrees', () => {
    vi.mocked(api.getNavigation).mockReturnValue({
      app: 'console',
      groups: [{
        id: 'integrations',
        label: 'Integrations',
        items: [{
          key: 'int-intake',
          label: 'Inbound intake monitor',
          icon: 'download',
          route: '/integrations/intake',
          resource: 'webhook_inbox_directory',
          capability: 'audit_log.read',
        }],
      }],
    } as never);

    renderWithProviders(<Sidenav pinned onTogglePin={() => {}} />, {
      identity: {
        capabilities: ['webhooks.read'],
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

    const nav = screen.getByRole('navigation', { name: 'Primary' });
    expect(getNavLink(nav, 'Inbound requests')).toHaveAttribute('href', '/integrations/intake');
    expect(getNavLink(nav, 'Inbound requests')).not.toHaveClass('is-locked');
  });

  it('locks platform-only lifecycle review navigation for tenant-scoped readers', async () => {
    const user = userEvent.setup();
    renderWithProviders(<Sidenav pinned onTogglePin={() => {}} />, {
      identity: {
        capabilities: ['tenant_signup_requests.read', 'mappings.read'],
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
    const nav = screen.getByRole('navigation', { name: 'Primary' });
    const organizations = getNavLink(nav, 'Organizations & requests');

    expect(organizations).toHaveAttribute('href', '/platform/organizations');
    expect(organizations).toHaveClass('is-locked');
    expect(organizations).toHaveAttribute(
      'title',
      expect.stringMatching(/Platform scope.*tenant signup/i),
    );

    await user.click(organizations);
    expect(routerMocks.navigate).not.toHaveBeenCalled();
  });

  it('keeps Workflows Bindings discoverable for workflow readers while actions remain write-gated', () => {
    renderWithProviders(<Sidenav pinned onTogglePin={() => {}} />, {
      identity: {
        capabilities: ['workflows.read', 'tasks.read'],
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

    const nav = screen.getByRole('navigation', { name: 'Primary' });
    expect(getNavLink(nav, 'Bindings & triggers')).toHaveAttribute('href', '/workflows/bindings');
    expect(getNavLink(nav, 'Bindings & triggers')).not.toHaveClass('is-locked');
  });

  it('keeps Workflows read-only route surfaces clickable without write capabilities', async () => {
    const user = userEvent.setup();
    renderWithProviders(<Sidenav pinned onTogglePin={() => {}} />, {
      identity: {
        capabilities: ['workflows.read', 'workflow_runs.read', 'manual_review.read', 'tasks.read'],
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

    const nav = screen.getByRole('navigation', { name: 'Primary' });
    for (const { label, routePath } of WORKFLOWS_CLICK_TARGETS) {
      const link = getNavLink(nav, label);
      expect(link).toHaveAttribute('href', routePath);
      expect(link).not.toHaveClass('is-locked');
      routerMocks.navigate.mockClear();
      await user.click(link);
      expect(routerMocks.navigate).toHaveBeenCalledWith({ to: routePath });
    }
  });

  it('routes Operate modules through operator clicks in the pinned sidebar', async () => {
    const user = userEvent.setup();
    renderPinnedSidenav();
    const nav = screen.getByRole('navigation', { name: 'Primary' });

    for (const { label, routePath } of OPERATE_CLICK_TARGETS) {
      routerMocks.navigate.mockClear();
      await user.click(getNavLink(nav, label));
      expect(routerMocks.navigate).toHaveBeenCalledWith({ to: routePath });
    }
  });

  it('routes Customers modules through operator clicks in the pinned sidebar', async () => {
    const user = userEvent.setup();
    renderPinnedSidenav();
    const nav = screen.getByRole('navigation', { name: 'Primary' });

    for (const { label, routePath } of CUSTOMER_CLICK_TARGETS) {
      routerMocks.navigate.mockClear();
      await user.click(getNavLink(nav, label));
      expect(routerMocks.navigate).toHaveBeenCalledWith({ to: routePath });
    }
  });

  it('routes Workflows modules through operator clicks in the pinned sidebar', async () => {
    const user = userEvent.setup();
    renderPinnedSidenav();
    const nav = screen.getByRole('navigation', { name: 'Primary' });

    for (const { label, routePath } of WORKFLOWS_CLICK_TARGETS) {
      routerMocks.navigate.mockClear();
      await user.click(getNavLink(nav, label));
      expect(routerMocks.navigate).toHaveBeenCalledWith({ to: routePath });
    }
  });

  it('routes Network modules through operator clicks in the pinned sidebar', async () => {
    const user = userEvent.setup();
    renderPinnedSidenav();
    const nav = screen.getByRole('navigation', { name: 'Primary' });

    for (const { label, routePath } of NETWORK_CLICK_TARGETS) {
      routerMocks.navigate.mockClear();
      await user.click(getNavLink(nav, label));
      expect(routerMocks.navigate).toHaveBeenCalledWith({ to: routePath });
    }
  });

  it('routes Platform modules through operator clicks in the pinned sidebar', async () => {
    const user = userEvent.setup();
    renderPinnedSidenav();
    const nav = screen.getByRole('navigation', { name: 'Primary' });

    for (const { label, routePath } of PLATFORM_CLICK_TARGETS) {
      routerMocks.navigate.mockClear();
      await user.click(getNavLink(nav, label));
      expect(routerMocks.navigate).toHaveBeenCalledWith({ to: routePath });
    }
  }, 15000);

  it('opens the collapsed Operate flyout on domain click without navigating to a default route', async () => {
    const user = userEvent.setup();
    const onOpenGroup = vi.fn();
    renderWithProviders(
      <Sidenav pinned={false} onTogglePin={() => {}} onOpenGroup={onOpenGroup} />,
      { capabilities: ['all'] },
    );

    await user.click(screen.getByRole('button', { name: 'Operate' }));

    expect(routerMocks.navigate).not.toHaveBeenCalled();
    expect(onOpenGroup).toHaveBeenCalledTimes(1);
    expect(onOpenGroup.mock.calls[0][0]).toEqual(expect.objectContaining({ label: 'Operate' }));
    expect(onOpenGroup.mock.calls[0][1]).toEqual(expect.any(Object));
  });

  it('routes collapsed flyout item clicks before closing the flyout', async () => {
    const user = userEvent.setup();
    const onItemPick = vi.fn(() => {
      expect(routerMocks.navigate).toHaveBeenCalledWith({ to: '/platform/organizations' });
    });

    renderWithProviders(
      <SidenavFlyout
        group={{
          id: 'platform',
          label: 'Platform',
          items: [
            {
              key: 'organizations',
              label: 'Organizations & requests',
              routePath: '/platform/organizations',
              iconName: 'building',
            },
          ],
        }}
        anchorRect={{ top: 10, right: 48 } as DOMRect}
        onMouseEnter={() => {}}
        onItemPick={onItemPick}
      />,
      { capabilities: ['all'] },
    );

    await user.click(screen.getByRole('link', { name: /^Organizations & requests\b/ }));

    expect(routerMocks.navigate).toHaveBeenCalledWith({ to: '/platform/organizations' });
    expect(onItemPick).toHaveBeenCalledTimes(1);
  });

  it('keeps long Platform flyouts inside the viewport so lower audit links remain clickable', async () => {
    const user = userEvent.setup();
    const originalInnerHeight = window.innerHeight;
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 720 });

    try {
      const platformGroup = loadNavigation().groups.find((group) => group.id === 'platform');
      expect(platformGroup).toBeTruthy();

      renderWithProviders(
        <SidenavFlyout
          group={platformGroup ?? null}
          anchorRect={{ top: 690, right: 48 } as DOMRect}
          onMouseEnter={() => {}}
          onItemPick={() => {}}
        />,
        { capabilities: ['all'] },
      );

      const flyout = screen.getByText('Platform').closest('.sidenav-flyout') as HTMLElement;
      expect(flyout).toHaveStyle({ top: '452px' });
      expect(flyout.style.maxHeight).toContain('calc(100vh - 452px');

      for (const { label, routePath } of [
        { label: 'Release proof', routePath: '/platform/release-proof' },
        { label: 'Onboarding readiness', routePath: '/platform/onboarding-readiness' },
      ]) {
        routerMocks.navigate.mockClear();
        await user.click(screen.getByRole('link', { name: new RegExp(`^${label}\\b`) }));
        expect(routerMocks.navigate).toHaveBeenCalledWith({ to: routePath });
      }
    } finally {
      Object.defineProperty(window, 'innerHeight', {
        configurable: true,
        value: originalInnerHeight,
      });
    }
  });

  it('keeps collapsed flyout locked items explanatory and non-navigating', async () => {
    const user = userEvent.setup();
    const onItemPick = vi.fn();

    renderWithProviders(
      <SidenavFlyout
        group={{
          id: 'integrations',
          label: 'External Intake',
          items: [
            {
              key: 'api_gateway',
              label: 'API request intake',
              routePath: '/insights/api-gateway',
              iconName: 'gauge',
              capability: 'api_gateway.read',
            },
          ],
        }}
        anchorRect={{ top: 10, right: 48 } as DOMRect}
        onMouseEnter={() => {}}
        onItemPick={onItemPick}
      />,
      { capabilities: ['webhooks.read'] },
    );

    const link = screen.getByRole('link', { name: /^API request intake\b/ });
    expect(link).toHaveClass('is-locked');
    expect(link).toHaveAttribute('aria-disabled', 'true');
    expect(link).toHaveAttribute('title', 'API Gateway permission required');

    await user.click(link);

    expect(routerMocks.navigate).not.toHaveBeenCalled();
    expect(onItemPick).not.toHaveBeenCalled();
  });

  it('normalizes Access control navigation to the access policy read gate', () => {
    vi.mocked(api.getNavigation).mockReturnValue({
      app: seedNavigation.app,
      groups: [
        {
          id: 'platform',
          label: 'Platform',
          items: [
            {
              key: 'access',
              label: 'Access control',
              icon: 'shield',
              route: '/platform/access',
              capability: 'token_rotation.read',
            },
          ],
        },
      ],
    } as never);

    const accessItem = loadNavigation()
      .groups.flatMap((group) => group.items)
      .find((item) => item.routePath === '/platform/access');

    expect(accessItem?.capability).toBe('access_policy.read');
    expect(accessItem?.capabilities).toEqual(['access_policy.read']);
  });
});
