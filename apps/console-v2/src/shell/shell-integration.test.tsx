// shell-integration.test.tsx — confirms the shell composition uses both
// new identity-aligned primitives:
//   - AppShell wraps its content in <AppGuard> (so portal users never see
//     the operator chrome)
//   - Topbar renders <TenantPicker /> (which itself self-gates on
//     `isPlatformUser()` so the picker only surfaces for platform sessions)
//
// We use a lightweight source-level structural check (read the file as text
// and assert the imports/usages exist) rather than spinning up the full
// TanStack Router; this keeps the test fast and avoids router boilerplate
// while still catching a regression where someone removes the wrapper or
// the import.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const APP_SRC = readFileSync(path.join(here, '..', 'App.tsx'), 'utf8');
const APP_SHELL_SRC = readFileSync(path.join(here, 'AppShell.tsx'), 'utf8');
const TOPBAR_SRC = readFileSync(path.join(here, 'Topbar.tsx'), 'utf8');
const NOTIFICATIONS_SRC = readFileSync(path.join(here, 'notifications.ts'), 'utf8');
const SIDENAV_SRC = readFileSync(path.join(here, 'Sidenav.tsx'), 'utf8');
const USER_MENU_DRAWER_SRC = readFileSync(path.join(here, 'UserMenuDrawer.tsx'), 'utf8');

describe('shell integration - identity provider module identity', () => {
  it('App imports IdentityProvider through the same alias used by shell consumers', () => {
    expect(APP_SRC).toMatch(
      /import\s+\{\s*IdentityProvider\s*\}\s+from\s+['"]@\/lib\/identity['"]/,
    );
    expect(APP_SRC).not.toMatch(
      /import\s+\{\s*IdentityProvider\s*\}\s+from\s+['"]\.\/lib\/identity['"]/,
    );
  });
});

describe('shell integration — AppShell + AppGuard', () => {
  it('AppShell imports AppGuard', () => {
    expect(APP_SHELL_SRC).toMatch(/import\s+\{\s*AppGuard\s*\}\s+from\s+['"]\.\/AppGuard['"]/);
  });

  it('AppShell wraps its tree in <AppGuard>', () => {
    // Either an opening tag <AppGuard> or a self-closing variant counts.
    expect(APP_SHELL_SRC).toMatch(/<AppGuard[\s>]/);
    expect(APP_SHELL_SRC).toMatch(/<\/AppGuard>/);
  });
});

describe('shell integration — Topbar + TenantPicker', () => {
  it('Topbar imports TenantPicker', () => {
    expect(TOPBAR_SRC).toMatch(/import\s+\{\s*TenantPicker\s*\}\s+from\s+['"]\.\/TenantPicker['"]/);
  });

  it('Topbar renders <TenantPicker />', () => {
    expect(TOPBAR_SRC).toMatch(/<TenantPicker\s*\/>/);
  });

  it('Topbar exposes the canonical command trigger id used by Dashboard quick actions', () => {
    expect(TOPBAR_SRC).toMatch(/id=["']cmd-trigger["']/);
  });

  it('Topbar renders route-aware breadcrumb links with a current-page marker', () => {
    expect(TOPBAR_SRC).toMatch(/buildRouteBreadcrumbs/);
    expect(TOPBAR_SRC).toMatch(/href=\{part\.to\}/);
    expect(TOPBAR_SRC).toMatch(/aria-current=\{i === breadcrumbs\.length - 1 \? ['"]page['"] : undefined\}/);
  });

  it('Topbar does not expose seed tenant or raw client fallback labels', () => {
    expect(TOPBAR_SRC).not.toMatch(/Rashed Logistics/);
    expect(TOPBAR_SRC).not.toMatch(/srlv_pending/);
    expect(TOPBAR_SRC).toMatch(/Active tenant/);
    expect(TOPBAR_SRC).toMatch(/Tenant scope/);
  });
});

describe('shell integration — AppShell + UserMenuDrawer (E1)', () => {
  // Closes IDENTITY P0 audit gap: Topbar.onOpenUserMenu used to be a no-op.
  // AppShell now mounts the UserMenuDrawer and threads the open/close ladder
  // through. We assert at the source level so a regression that drops the
  // wiring (or the import) is caught even when the higher-level integration
  // suite is skipped.
  it('AppShell imports UserMenuDrawer', () => {
    expect(APP_SHELL_SRC).toMatch(
      /import\s+\{\s*UserMenuDrawer\s*\}\s+from\s+['"]\.\/UserMenuDrawer['"]/,
    );
  });

  it('AppShell mounts <UserMenuDrawer> with controlled open/close props', () => {
    expect(APP_SHELL_SRC).toMatch(/<UserMenuDrawer[\s\S]*?open=\{userMenuOpen\}/);
    expect(APP_SHELL_SRC).toMatch(/onClose=\{closeUserMenu\}/);
  });

  it('AppShell wires Topbar.onOpenUserMenu through openUserMenu (not the no-op prop)', () => {
    expect(APP_SHELL_SRC).toMatch(/<Topbar[\s\S]*?onOpenUserMenu=\{openUserMenu\}/);
  });

  it('AppShell forwards onOpenShortcuts into the user-menu drawer', () => {
    expect(APP_SHELL_SRC).toMatch(/<UserMenuDrawer[\s\S]*?onOpenShortcuts=\{onOpenShortcuts\}/);
  });

  it('UserMenuDrawer uses operator-safe Access control copy', () => {
    expect(USER_MENU_DRAWER_SRC).toMatch(/label:\s*['"]Access control['"]/);
    expect(USER_MENU_DRAWER_SRC).toMatch(/hint:\s*['"]Scope policy and roles['"]/);
    expect(USER_MENU_DRAWER_SRC).not.toMatch(/Access & roles|RBAC policy/);
  });
});

describe('shell integration - canonical notifications', () => {
  it('AppShell sources notifications from ops_alerts instead of a mounted synthetic feed', () => {
    expect(APP_SHELL_SRC).toMatch(/useResourceList<OpsAlertNotificationRow>\(\s*['"]ops_alerts['"]/);
    expect(APP_SHELL_SRC).toMatch(/notificationFromOpsAlert/);
    expect(APP_SHELL_SRC).toMatch(/<NotifsPanel[\s\S]*?notifications=\{notifications\}/);
  });

  it('default notifications are empty so live shell data must come from resources', () => {
    expect(NOTIFICATIONS_SRC).toMatch(/export const DEFAULT_NOTIFICATIONS: NotifItem\[\] = \[\];/);
    expect(NOTIFICATIONS_SRC).not.toMatch(/NDR queue|Examplecourier Returns|Settlement variance/);
  });
});

describe('shell integration - command palette fallback', () => {
  it('AppShell mounts an internal palette and opens it from Topbar when no override is provided', () => {
    expect(APP_SHELL_SRC).toMatch(/const commandPalette = usePalette(?:<[^>]+>)?\(\)/);
    expect(APP_SHELL_SRC).toMatch(/const openCommandPalette = useCallback/);
    expect(APP_SHELL_SRC).toMatch(/onOpenPalette=\{openCommandPalette\}/);
    expect(APP_SHELL_SRC).toMatch(/\{commandPalette\.node\}/);
  });

  it('AppShell builds command palette navigation from normalized navigation and command registry rows', () => {
    expect(APP_SHELL_SRC).toMatch(/loadNavigation\(\)\.groups/);
    expect(APP_SHELL_SRC).toMatch(/api\.getCommandRegistry\(\)/);
    expect(APP_SHELL_SRC).toMatch(/resolveCommandRoutePath\(row, navRouteItems\)/);
    expect(APP_SHELL_SRC).toMatch(/router\.navigate\(\{ to: value\.routePath as never \}\)/);
  });

  it('AppShell normalizes direct legacy Console paths before rendering not-found content', () => {
    expect(APP_SHELL_SRC).toMatch(/window\.location\.pathname/);
    expect(APP_SHELL_SRC).toMatch(/resolveLegacyHashNavigation\(rawPath\)/);
    expect(APP_SHELL_SRC).toMatch(/replace: true/);
  });
});

describe('shell integration - clicked navigation', () => {
  it('Sidenav keeps hrefs but routes normal clicks through the router', () => {
    expect(SIDENAV_SRC).toMatch(/href=\{item\.routePath\}/);
    expect(SIDENAV_SRC).toMatch(/e\.preventDefault\(\)/);
    expect(SIDENAV_SRC).toMatch(/useConsoleNavigator/);
    expect(SIDENAV_SRC).toMatch(/navigateTo\(item\.routePath\)/);
  });
});
