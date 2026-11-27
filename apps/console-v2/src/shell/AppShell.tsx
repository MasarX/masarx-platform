// AppShell.tsx — top-level chrome layout. Wraps the routed Outlet in topbar +
// sidenav + statusbar + notifications panel. Owns the persistent shell state
// (nav-pinned, notifs-pinned, notifs-open, sidenav flyout target) so child
// components stay presentational.
//
// Persistence keys (per the porting brief):
//   console-v2.nav-pinned    — sidenav pinned state.
//   console-v2.notifs-pinned — notifications panel pinned state.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Outlet, useLocation, useRouter } from '@tanstack/react-router';
import { Topbar } from './Topbar';
import { Sidenav, SidenavFlyout } from './Sidenav';
import { Statusbar } from './Statusbar';
import { NotifsPanel } from './NotifsPanel';
import { UserMenuDrawer } from './UserMenuDrawer';
import { AppGuard } from './AppGuard';
import { isConsoleAuthRoute } from '@/lib/auth';
import { resolveLegacyHashNavigation } from '@/lib/legacy-hash-navigation';
import { usePalette, type OpenPaletteOptions } from '@/hooks/useOverlay';
import { formatCapabilityRequirement } from '@/lib/capabilities';
import { useIdentity } from '@/lib/identity';
import { useT } from '@/lib/i18n';
import * as api from '@/lib/api';
import {
  DEFAULT_NOTIFICATIONS,
  notificationFromOpsAlert,
  type OpsAlertNotificationRow,
} from './notifications';
import {
  canAccessNavItem,
  loadNavigation,
  navItemAccessLabel,
  type NavSection,
} from './navigation';
import { useResourceList } from '@/lib/queries';
import {
  resolveCommandRoutePath,
  type ShellCommandRegistryRow,
  type ShellCommandRouteItem,
} from './command-routes';

const NAV_PIN_KEY = 'console-v2.nav-pinned';
// Matches the phone rule in shell.css, where the shown sidenav is an overlay drawer.
const PHONE_QUERY = '(max-width: 720px)';
const NOTIFS_PIN_KEY = 'console-v2.notifs-pinned';
const FLYOUT_CLOSE_DELAY_MS = 220;

type ShellPaletteValue = {
  routePath?: string;
  commandKey?: string;
};

type ShellPaletteItem = {
  label: string;
  key: string;
  meta: string;
  section?: string;
  disabled: boolean;
  value: ShellPaletteValue;
};

function readBoolFromStorage(key: string, fallback: boolean): boolean {
  if (typeof window === 'undefined') return fallback;
  try {
    const raw = window.localStorage.getItem(key);
    if (raw === null) return fallback;
    return raw === '1' || raw === 'true';
  } catch {
    return fallback;
  }
}

function writeBoolToStorage(key: string, value: boolean) {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(key, value ? '1' : '0');
  } catch {
    /* ignore storage failures (private mode, etc.) */
  }
}

export interface AppShellProps {
  /** Optional hook into a global command-palette opener. */
  onOpenCommandPalette?: () => void;
  /** Optional hook into a global scope-palette opener. */
  onOpenScopePalette?: () => void;
  /** Optional hook into a keyboard-shortcuts modal opener. */
  onOpenShortcuts?: () => void;
  /**
   * Optional hook into a user-menu drawer opener. When omitted, AppShell still
   * mounts the built-in `<UserMenuDrawer>` and toggles it from the Topbar
   * button — the prop is retained for callers that want to override behavior
   * (e.g. tests, story-book) without touching internal state.
   */
  onOpenUserMenu?: () => void;
  /** Optional toast emitter for placeholder actions. */
  onToast?: (message: string, tone?: 'good' | 'warn' | 'danger' | 'info') => void;
}

export function AppShell({
  onOpenCommandPalette,
  onOpenScopePalette,
  onOpenShortcuts,
  onOpenUserMenu,
  onToast,
}: AppShellProps) {
  const location = useLocation();
  const router = useRouter();
  const [navPinned, setNavPinned] = useState<boolean>(() => readBoolFromStorage(NAV_PIN_KEY, false));
  // Phone drawer state is view-only, so a narrow window never rewrites the desktop pin preference.
  const [isPhone, setIsPhone] = useState<boolean>(() => window.matchMedia?.(PHONE_QUERY).matches ?? false);
  const [phoneNavOpen, setPhoneNavOpen] = useState<boolean>(false);
  const navShown = isPhone ? phoneNavOpen : navPinned;
  const [notifsPinned, setNotifsPinned] = useState<boolean>(() =>
    readBoolFromStorage(NOTIFS_PIN_KEY, false)
  );
  const [notifsOpen, setNotifsOpen] = useState<boolean>(false);
  const [userMenuOpen, setUserMenuOpen] = useState<boolean>(false);
  const commandPalette = usePalette<ShellPaletteItem>();
  const commandPaletteOpenRef = useRef(false);
  const commandPaletteSessionRef = useRef(0);
  const identity = useIdentity();
  const t = useT();
  const { hasCapability, isAuthenticated, isAuthLoading } = identity;

  const [flyoutGroup, setFlyoutGroup] = useState<NavSection | null>(null);
  const [flyoutAnchor, setFlyoutAnchor] = useState<DOMRect | null>(null);
  const [flyoutPersistent, setFlyoutPersistentState] = useState<boolean>(false);
  const flyoutCloseTimer = useRef<number | null>(null);
  const flyoutPersistentRef = useRef<boolean>(false);
  const opsAlertsQuery = useResourceList<OpsAlertNotificationRow>(
    'ops_alerts',
    { page_size: 8, sort: { key: 'opened_at', dir: 'desc' } },
    { enabled: isAuthenticated && !isAuthLoading, staleTime: 30_000 },
  );

  useEffect(() => {
    const routeLegacyHash = () => {
      const target = resolveLegacyHashNavigation(window.location.hash);
      if (!target) return;
      void router.navigate({
        to: target.to as never,
        search: target.search as never,
        replace: true,
      });
    };

    routeLegacyHash();
    window.addEventListener('hashchange', routeLegacyHash);
    return () => window.removeEventListener('hashchange', routeLegacyHash);
  }, [router]);

  useEffect(() => {
    const rawPath = `${window.location.pathname}${window.location.search}`;
    const target = resolveLegacyHashNavigation(rawPath);
    if (!target || target.to === location.pathname) return;
    void router.navigate({
      to: target.to as never,
      search: target.search as never,
      replace: true,
    });
  }, [location.pathname, location.search, router]);

  // At phone width the sidenav is a drawer over the page: it starts closed and closes on navigation.
  useEffect(() => {
    const query = window.matchMedia?.(PHONE_QUERY);
    if (!query) return;
    const onChange = () => {
      setIsPhone(query.matches);
      setPhoneNavOpen(false);
    };
    query.addEventListener('change', onChange);
    return () => query.removeEventListener('change', onChange);
  }, []);
  useEffect(() => {
    setPhoneNavOpen(false);
  }, [location.pathname]);

  // Persist pin states.
  useEffect(() => {
    writeBoolToStorage(NAV_PIN_KEY, navPinned);
  }, [navPinned]);
  useEffect(() => {
    writeBoolToStorage(NOTIFS_PIN_KEY, notifsPinned);
  }, [notifsPinned]);

  // If pinned, the panel is implicitly open.
  useEffect(() => {
    if (notifsPinned) setNotifsOpen(true);
  }, [notifsPinned]);

  const toggleNav = useCallback(() => (isPhone ? setPhoneNavOpen : setNavPinned)((v) => !v), [isPhone]);
  const toggleNotifs = useCallback(() => {
    if (notifsPinned) return; // pinned panel ignores toggle
    setNotifsOpen((v) => !v);
  }, [notifsPinned]);
  const closeNotifs = useCallback(() => {
    if (notifsPinned) return;
    setNotifsOpen(false);
  }, [notifsPinned]);
  const toggleNotifsPin = useCallback(() => {
    setNotifsPinned((prev) => {
      const next = !prev;
      if (next) setNotifsOpen(true);
      return next;
    });
  }, []);

  // User-menu drawer is intentionally not pinnable — it carries auth-mutating
  // actions (Sign-out) that we want users to see only when they explicitly
  // open the drawer.
  const openUserMenu = useCallback(() => {
    if (onOpenUserMenu) {
      onOpenUserMenu();
      return;
    }
    setUserMenuOpen(true);
  }, [onOpenUserMenu]);
  const closeUserMenu = useCallback(() => setUserMenuOpen(false), []);

  // Sidenav flyout management — debounce close to avoid flicker between the
  // domain icon and the flyout itself.
  const cancelFlyoutClose = useCallback(() => {
    if (flyoutCloseTimer.current !== null) {
      window.clearTimeout(flyoutCloseTimer.current);
      flyoutCloseTimer.current = null;
    }
  }, []);
  const setFlyoutPersistent = useCallback((next: boolean) => {
    flyoutPersistentRef.current = next;
    setFlyoutPersistentState(next);
  }, []);
  const scheduleFlyoutClose = useCallback(() => {
    if (flyoutPersistentRef.current) return;
    cancelFlyoutClose();
    flyoutCloseTimer.current = window.setTimeout(() => {
      setFlyoutGroup(null);
      setFlyoutAnchor(null);
      setFlyoutPersistent(false);
      flyoutCloseTimer.current = null;
    }, FLYOUT_CLOSE_DELAY_MS);
  }, [cancelFlyoutClose, setFlyoutPersistent]);
  const handleHoverGroup = useCallback(
    (group: NavSection | null, rect: DOMRect | null) => {
      if (group && rect) {
        cancelFlyoutClose();
        setFlyoutPersistent(false);
        setFlyoutGroup(group);
        setFlyoutAnchor(rect);
      } else {
        scheduleFlyoutClose();
      }
    },
    [cancelFlyoutClose, scheduleFlyoutClose, setFlyoutPersistent]
  );
  const handleOpenGroup = useCallback(
    (group: NavSection, rect: DOMRect) => {
      cancelFlyoutClose();
      setFlyoutPersistent(true);
      setFlyoutGroup(group);
      setFlyoutAnchor(rect);
    },
    [cancelFlyoutClose, setFlyoutPersistent]
  );
  const handleFlyoutItemPick = useCallback(() => {
    cancelFlyoutClose();
    setFlyoutPersistent(false);
    setFlyoutGroup(null);
    setFlyoutAnchor(null);
  }, [cancelFlyoutClose, setFlyoutPersistent]);

  useEffect(() => {
    cancelFlyoutClose();
    setFlyoutPersistent(false);
    setFlyoutGroup(null);
    setFlyoutAnchor(null);
  }, [cancelFlyoutClose, location.pathname, location.search, setFlyoutPersistent]);

  useEffect(() => {
    if (!navShown) return;
    cancelFlyoutClose();
    setFlyoutPersistent(false);
    setFlyoutGroup(null);
    setFlyoutAnchor(null);
  }, [cancelFlyoutClose, navShown, setFlyoutPersistent]);

  const buildCommandPaletteOptions = useCallback((sessionId: number): OpenPaletteOptions<ShellPaletteItem> => {
    const navGroups = loadNavigation().groups;
    const navItems = navGroups.flatMap((group) =>
      group.items.map((item) => {
        const allowed = canAccessNavItem(item, identity);
        return {
          label: item.label,
          key: item.routePath,
          meta: allowed ? t('shell.palette.openModule') : navItemAccessLabel(item, t),
          section: group.label,
          disabled: !allowed,
          value: { routePath: item.routePath } satisfies ShellPaletteValue,
        } satisfies ShellPaletteItem;
      }),
    );
    const navRouteItems: ShellCommandRouteItem[] = navItems
      .map((item) => ({
        label: item.label,
        routePath: (item.value as ShellPaletteValue).routePath,
      }))
      .filter((item): item is ShellCommandRouteItem => typeof item.routePath === 'string');
    const registryRows = api.getCommandRegistry() as unknown;
    const commandRows = (Array.isArray(registryRows) ? registryRows : [])
      .map((row: unknown) => (row && typeof row === 'object' ? (row as ShellCommandRegistryRow) : null))
      .filter((row): row is ShellCommandRegistryRow => row !== null && Boolean(row.label || row.key));
    return {
      placeholder: t('shell.paletteSearch'),
      items: [
        ...navItems,
        ...commandRows.map((row) => {
          const routePath = resolveCommandRoutePath(row, navRouteItems);
          const capability = row.capability == null ? null : String(row.capability);
          const missingCapability = Boolean(capability && !hasCapability(capability));
          return {
            label: String(row.label ?? row.key),
            key: String(row.key ?? row.label),
            meta: missingCapability
              ? formatCapabilityRequirement(capability, t)
              : routePath
                ? t('shell.palette.openModule')
                : t('shell.palette.openFromRow'),
            section: row.section ?? t('shell.palette.commands'),
            disabled: !routePath || missingCapability,
            value: {
              routePath,
              commandKey: row.key == null ? undefined : String(row.key),
            } satisfies ShellPaletteValue,
          } satisfies ShellPaletteItem;
        }),
      ],
      onClose: () => {
        if (commandPaletteSessionRef.current === sessionId) {
          commandPaletteOpenRef.current = false;
        }
      },
      onPick: (item) => {
        commandPaletteOpenRef.current = false;
        const value = item.value as ShellPaletteValue | undefined;
        if (value?.routePath) {
          const target = resolveLegacyHashNavigation(value.routePath);
          if (target) {
            void router.navigate({
              to: target.to as never,
              search: target.search as never,
            });
            return;
          }
          void router.navigate({ to: value.routePath as never });
          return;
        }
        onToast?.(t('shell.palette.needsRecord'), 'info');
      },
    };
  }, [hasCapability, identity, onToast, router, t]);

  const openCommandPalette = useCallback(() => {
    if (onOpenCommandPalette) {
      onOpenCommandPalette();
      return;
    }

    const sessionId = commandPaletteSessionRef.current + 1;
    commandPaletteSessionRef.current = sessionId;
    commandPaletteOpenRef.current = true;
    const initialOptions = buildCommandPaletteOptions(sessionId);
    commandPalette.open(initialOptions);

    if (initialOptions.items.length > 0) return;

    void api.hydrateConsoleLiveMetadata()
      .then(() => {
        if (!commandPaletteOpenRef.current || commandPaletteSessionRef.current !== sessionId) return;
        commandPalette.open(buildCommandPaletteOptions(sessionId));
      })
      .catch(() => {
        // AppGuard owns the operator-facing metadata error state. A palette
        // refresh failure should not replace that with an unrelated toast.
      });
  }, [buildCommandPaletteOptions, commandPalette, onOpenCommandPalette]);

  // Keyboard shortcuts: ⌘K opens palette, ⌘\ toggles sidenav pin.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      const inField =
        !!target &&
        (['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName) || target.isContentEditable);
      const mod = e.metaKey || e.ctrlKey;
      if (mod && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        openCommandPalette();
        return;
      }
      if (mod && e.key === '\\') {
        e.preventDefault();
        toggleNav();
        return;
      }
      if (inField) return;
      if (e.key === '?' && e.shiftKey) {
        e.preventDefault();
        onOpenShortcuts?.();
        return;
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [openCommandPalette, onOpenShortcuts, toggleNav]);

  // Reflect pinned states on the DOM element so shell.css cascades resolve.
  // We toggle on .app-shell directly via React data-* props below.
  const notifications = useMemo(
    () => opsAlertsQuery.data?.rows?.map(notificationFromOpsAlert) ?? DEFAULT_NOTIFICATIONS,
    [opsAlertsQuery.data?.rows],
  );
  const hasUnreadNotifs = notifications.some((n) => n.unread);

  if (isConsoleAuthRoute(location.pathname)) {
    return <Outlet />;
  }

  return (
    <AppGuard>
      <a className="skip-link" href="#main">
        {t('app.skip')}
      </a>

      <div
        id="app"
        className="app-shell"
        aria-busy="false"
        data-nav-pinned={navShown ? 'true' : 'false'}
        data-notifs-pinned={notifsPinned ? 'true' : 'false'}
      >
        <Topbar
          onOpenPalette={openCommandPalette}
          onOpenScopePalette={onOpenScopePalette}
          onToggleNotifs={toggleNotifs}
          onOpenUserMenu={openUserMenu}
          navOpen={navShown}
          onToggleNav={toggleNav}
          hasUnreadNotifs={hasUnreadNotifs}
        />

        <Sidenav
          pinned={navShown}
          onTogglePin={toggleNav}
          onHoverGroup={handleHoverGroup}
          onOpenGroup={handleOpenGroup}
        />

        {!navShown && flyoutGroup ? (
          <SidenavFlyout
            group={flyoutGroup}
            anchorRect={flyoutAnchor}
            onMouseEnter={cancelFlyoutClose}
            onMouseLeave={flyoutPersistent ? undefined : scheduleFlyoutClose}
            onItemPick={handleFlyoutItemPick}
          />
        ) : null}

        <main id="main" className="main" tabIndex={-1} aria-live="polite">
          <div className="main__inner">
            <Outlet />
          </div>
        </main>

        <Statusbar
          onOpenScopePalette={onOpenScopePalette}
          onOpenShortcuts={onOpenShortcuts}
          onToast={onToast}
        />
      </div>

      <NotifsPanel
        open={notifsOpen}
        pinned={notifsPinned}
        notifications={notifications}
        onTogglePin={toggleNotifsPin}
        onClose={closeNotifs}
      />

      <UserMenuDrawer
        open={userMenuOpen}
        onClose={closeUserMenu}
        onOpenShortcuts={onOpenShortcuts}
      />

      {commandPalette.node}
    </AppGuard>
  );
}
