import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { screen } from '@testing-library/react';
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

const TEST_DIR = dirname(fileURLToPath(import.meta.url));

function renderShell() {
  return renderWithProviders(<AppShell />, {
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
}

const media = vi.hoisted(() => ({ phone: true }));

function shell(): HTMLElement {
  return document.querySelector('.app-shell') as HTMLElement;
}

describe('AppShell at phone width', () => {
  beforeEach(() => {
    routerMocks.pathname = '/';
    routerMocks.search = '';
    media.phone = true;
    // A pinned rail from a desktop session must not open over the page on a phone.
    window.localStorage.setItem('console-v2.nav-pinned', '1');
    vi.stubGlobal(
      'matchMedia',
      (query: string) =>
        ({
          matches: media.phone && query === '(max-width: 720px)',
          media: query,
          addEventListener: () => {},
          removeEventListener: () => {},
          addListener: () => {},
          removeListener: () => {},
          onchange: null,
          dispatchEvent: () => false,
        }) as MediaQueryList,
    );
    vi.spyOn(api, 'getNavigation').mockReturnValue(seedNavigation as never);
    vi.spyOn(api, 'hasConsoleLiveBackend').mockReturnValue(false);
    vi.spyOn(api, 'hydrateConsoleLiveMetadata').mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('starts closed, opens the drawer from the navigation control and closes it on navigation', async () => {
    const user = userEvent.setup();
    const view = renderShell();

    const toggle = screen.getByRole('button', { name: 'Navigation' });
    expect(toggle).toHaveAttribute('aria-controls', 'primary-nav');
    expect(document.getElementById('primary-nav')).toHaveAttribute('role', 'navigation');
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(shell()).toHaveAttribute('data-nav-pinned', 'false');

    await user.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(shell()).toHaveAttribute('data-nav-pinned', 'true');

    routerMocks.pathname = '/operate/shipments';
    view.rerender(<AppShell />);
    expect(shell()).toHaveAttribute('data-nav-pinned', 'false');
  });

  it('keeps the desktop pin preference after a phone-width visit', async () => {
    const user = userEvent.setup();
    const phoneView = renderShell();
    await user.click(screen.getByRole('button', { name: 'Navigation' }));
    await user.click(screen.getByRole('button', { name: 'Navigation' }));
    phoneView.unmount();
    expect(window.localStorage.getItem('console-v2.nav-pinned')).toBe('1');

    media.phone = false;
    renderShell();
    expect(shell()).toHaveAttribute('data-nav-pinned', 'true');
    expect(window.localStorage.getItem('console-v2.nav-pinned')).toBe('1');
  });

  it('collapses the shell to one column and shows the sidenav only as a drawer', () => {
    const css = readFileSync(resolve(TEST_DIR, '../styles/shell.css'), 'utf8');
    const phone = css.slice(css.indexOf('@media (max-width: 720px)'));
    expect(phone).toMatch(/grid-template-columns:\s*1fr;/);
    expect(phone).toMatch(/\.app-shell \.sidenav \{ display: none; \}/);
    expect(phone).toMatch(/\.app-shell\[data-nav-pinned="true"\] \.sidenav \{[^}]*position: fixed;[^}]*inset-inline-start: 0;/);
    expect(phone).toMatch(/\.topbar \.topbar__nav-toggle \{ display: inline-flex; \}/);
  });
});
