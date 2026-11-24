// Topbar.tsx — 44px dark chrome bar with brand, breadcrumbs, command trigger,
// scope pill, density/lang/theme/bell/user buttons. Pure presentation; behaviour
// is delegated through props/context (theme, i18n, identity).
import { useMemo } from 'react';
import { Icon } from '@/components/Icon';
import { Kbd } from '@/components/Kbd';
import { useI18n } from '@/lib/i18n';
import { useTheme } from '@/lib/theme';
import { useIdentity } from '@/lib/identity';
import { buildRouteBreadcrumbs, type RouteBreadcrumb } from '@/lib/route-meta';
import { useLocation } from '@tanstack/react-router';
import { TenantPicker } from './TenantPicker';

export interface TopbarProps {
  /** Open command palette (⌘K). Provided by AppShell. */
  onOpenPalette?: () => void;
  /** Open scope palette (⌘P) — clicking the scope pill or env. */
  onOpenScopePalette?: () => void;
  /** Toggle the notifications panel. */
  onToggleNotifs?: () => void;
  /** Open the user menu drawer. */
  onOpenUserMenu?: () => void;
  /** Whether the bell should show an unread dot. */
  hasUnreadNotifs?: boolean;
  /** Optional override for breadcrumb segments. Falls back to deriving from path. */
  crumbs?: string[];
}

function initialsOf(name: string): string {
  return (name || '?')
    .split(' ')
    .map((part) => part[0] ?? '')
    .filter(Boolean)
    .slice(0, 2)
    .join('')
    .toUpperCase();
}

export function Topbar({
  onOpenPalette,
  onOpenScopePalette,
  onToggleNotifs,
  onOpenUserMenu,
  hasUnreadNotifs = false,
  crumbs,
}: TopbarProps) {
  const { user, scope } = useIdentity();
  const { locale, toggleLocale, t } = useI18n();
  const { theme, density, setTheme, cycleDensity } = useTheme();
  const location = useLocation();

  const initials = useMemo(() => initialsOf(user?.name ?? ''), [user?.name]);
  const role = user?.role ?? 'user';
  const tenantLabel = scope?.tenant?.label?.trim() || 'Active tenant';
  const subLabel =
    scope?.client?.label?.trim() ||
    (user?.access_scope_type === 'platform'
      ? 'Platform scope'
      : user?.access_scope_type === 'sender'
        ? 'Sender scope'
        : 'Tenant scope');
  const breadcrumbs: RouteBreadcrumb[] =
    crumbs && crumbs.length > 0
      ? crumbs.map((label) => ({ label }))
      : buildRouteBreadcrumbs(location.pathname);

  return (
    <header className="topbar" role="banner">
      <div className="topbar__brand" aria-label="MasarX Console">
        <span className="brand-mark" aria-hidden="true">
          <svg viewBox="0 0 20 20" width={18} height={18}>
            <rect x="0" y="0" width="20" height="20" rx="4" fill="var(--accent)" />
            <path
              d="M4 14 L4 6 L7 6 L10 11 L13 6 L16 6 L16 14"
              stroke="var(--chrome)"
              strokeWidth="1.6"
              fill="none"
              strokeLinecap="square"
            />
          </svg>
        </span>
        <span className="brand-name">MasarX</span>
        <span className="brand-sep">/</span>
        <span className="brand-app">console</span>
        <span className="brand-sep">·</span>
        <span className="brand-role mono">{role}</span>
      </div>

      <nav className="topbar__crumbs" aria-label="Breadcrumb">
        {breadcrumbs.map((part, i) => (
          <span key={`${part.label}-${i}`} className="crumb-wrap">
            {i > 0 ? <span className="crumb-sep">›</span> : null}
            {part.to ? (
              <a
                className="crumb crumb--link"
                href={part.to}
              >
                {part.label}
              </a>
            ) : (
              <span className="crumb" aria-current={i === breadcrumbs.length - 1 ? 'page' : undefined}>
                {part.label}
              </span>
            )}
          </span>
        ))}
      </nav>

      <div className="topbar__spacer" />

      <button
        id="cmd-trigger"
        className="cmd-trigger"
        type="button"
        // WCAG 2.5.3: the name holds all visible text (placeholder and ⌘K), then the action.
        aria-label={`${t('app.search')} ⌘K, ${t('app.openPalette')}`}
        aria-haspopup="dialog"
        aria-keyshortcuts="Meta+K Control+K"
        onClick={onOpenPalette}
      >
        <span className="cmd-trigger__icon" aria-hidden="true">
          <Icon name="search" size={12} />
        </span>
        <span className="cmd-trigger__placeholder">{t('app.search')}</span>
        <Kbd>⌘K</Kbd>
      </button>

      <div
        className="topbar__scope"
        tabIndex={0}
        role="button"
        // WCAG 2.5.3: the name comes from the visible scope; the hint is a description.
        aria-haspopup="dialog"
        title={t('app.switchScope')}
        onClick={onOpenScopePalette}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            onOpenScopePalette?.();
          }
        }}
      >
        <span className="scope-pill__rank" aria-hidden="true">T</span>
        <span className="scope-pill__name">{tenantLabel}</span>
        <span className="scope-sep" aria-hidden="true">·</span>
        <span className="scope-pill__sub mono">{subLabel}</span>
      </div>

      {/* Platform-only tenant switcher. Renders nothing for tenant/portal users. */}
      <TenantPicker />

      <div className="topbar__actions">
        <button
          className="icon-btn"
          type="button"
          aria-label="Cycle density"
          title={`Density: ${density} (click to cycle)`}
          onClick={cycleDensity}
        >
          <Icon name="list" size={14} />
        </button>
        <button
          className="icon-btn"
          type="button"
          // WCAG 2.5.3: the name starts with the visible AR/EN label.
          aria-label={t('app.switchLanguage')}
          onClick={toggleLocale}
        >
          {locale === 'en' ? 'AR' : 'EN'}
        </button>
        <button
          className="icon-btn"
          type="button"
          aria-label="Toggle theme"
          aria-pressed={theme === 'dark'}
          onClick={() => setTheme(theme === 'light' ? 'dark' : 'light')}
        >
          <svg viewBox="0 0 24 24" width={14} height={14} fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M21 12.79A9 9 0 1111.21 3 7 7 0 0021 12.79z" />
          </svg>
        </button>
        <button
          className="icon-btn"
          type="button"
          aria-label="Notifications"
          onClick={onToggleNotifs}
        >
          <Icon name="bell" size={14} />
          {hasUnreadNotifs ? <span className="bell-dot" aria-hidden="true" /> : null}
        </button>
        {/* WCAG 2.5.3: the name starts with the visible initials. */}
        <button className="user-btn" type="button" aria-label={`${initials || 'U'}, ${t('app.userMenu')}`} onClick={onOpenUserMenu}>
          <span className="avatar" aria-hidden="true">{initials || 'U'}</span>
          <span className="caret" aria-hidden="true">▾</span>
        </button>
      </div>
    </header>
  );
}
