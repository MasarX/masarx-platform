// Sidenav.tsx — primary side navigation. Two render modes:
//   pinned   → 240px column with section labels + every item visible inline.
//   collapsed → 52px rail of domain icons; hovering an icon opens a flyout
//               panel beside it (rendered by SidenavFlyout, mounted by AppShell).
// Pin state is owned by AppShell and persisted to localStorage there.
import { useCallback, type CSSProperties, type MouseEvent } from 'react';
import { useLocation } from '@tanstack/react-router';
import { Icon } from '@/components/Icon';
import { useT } from '@/lib/i18n';
import { useIdentity } from '@/lib/identity';
import { useConsoleNavigator } from '@/lib/useConsoleNavigator';
import {
  canAccessNavItem,
  type NavItem,
  type NavSection,
  DOMAIN_ICONS,
  groupBadgeTone,
  loadNavigation,
  matchRoute,
  navItemAccessLabel,
} from './navigation';

export interface SidenavProps {
  /** Whether the sidenav is pinned-open. */
  pinned: boolean;
  /** Toggle pinned state (also wired to ⌘\). */
  onTogglePin: () => void;
  /**
   * In collapsed mode, called when a domain icon is hovered/focused so the
   * shell can render a flyout for that group. AppShell owns the flyout DOM.
   */
  onHoverGroup?: (group: NavSection | null, anchorRect: DOMRect | null) => void;
  /** In collapsed mode, clicking a domain icon pins that domain flyout open. */
  onOpenGroup?: (group: NavSection, anchorRect: DOMRect) => void;
}

function NavItemLink({
  item,
  active,
  allowed,
  onClick,
}: {
  item: NavItem;
  active: boolean;
  allowed: boolean;
  onClick?: () => void;
}) {
  const navigateTo = useConsoleNavigator();
  const t = useT();
  const className = ['nav-item', active ? 'is-active' : '', allowed ? '' : 'is-locked']
    .filter(Boolean)
    .join(' ');
  const title = !allowed ? navItemAccessLabel(item, t) : item.label;
  const handleClick = (e: MouseEvent<HTMLAnchorElement>) => {
    if (!allowed) {
      e.preventDefault();
      return;
    }
    if (e.button !== 0 || e.metaKey || e.altKey || e.ctrlKey || e.shiftKey) return;
    e.preventDefault();
    onClick?.();
    navigateTo(item.routePath);
  };

  return (
    <a
      href={item.routePath}
      className={className}
      title={title}
      aria-disabled={!allowed ? 'true' : undefined}
      aria-current={active ? 'page' : undefined}
      onClick={handleClick}
    >
      <span className="nav-item__icon">
        <Icon name={item.iconName} size={14} />
      </span>
      <span className="nav-item__label">{item.label}</span>
      {item.badge ? (
        <span className={`nav-item__badge ${item.badgeKind ?? ''}`.trim()}>{item.badge}</span>
      ) : null}
    </a>
  );
}

export function Sidenav({ pinned, onTogglePin, onHoverGroup, onOpenGroup }: SidenavProps) {
  const location = useLocation();
  const identity = useIdentity();
  const navigation = loadNavigation();
  const currentRoute = location.pathname || '/';
  const t = useT();

  const handleGroupHover = useCallback(
    (group: NavSection, target: HTMLElement | null) => {
      if (pinned || !target) return;
      onHoverGroup?.(group, target.getBoundingClientRect());
    },
    [pinned, onHoverGroup]
  );

  const handleGroupLeave = useCallback(() => {
    if (pinned) return;
    onHoverGroup?.(null, null);
  }, [pinned, onHoverGroup]);

  return (
    <aside className="sidenav" role="navigation" aria-label={t('shell.sidenav.label')}>
      <div className="sidenav__pin">
        <button
          className="icon-btn sidenav__pin-btn"
          type="button"
          aria-label={pinned ? t('shell.sidenav.unpin') : t('shell.sidenav.pin')}
          aria-pressed={pinned}
          title={t('shell.sidenav.pinTitle')}
          onClick={onTogglePin}
        >
          <Icon name="pin" size={13} />
        </button>
      </div>

      <div className="sidenav__inner">
        {navigation.groups.map((group) => {
          if (pinned) {
            return (
              <div key={group.id} className="nav-group">
                <div className="nav-group__label">{group.label}</div>
                {group.items.map((item) => {
                  const allowed = canAccessNavItem(item, identity);
                  const active = matchRoute(item.routePath, currentRoute);
                  return (
                    <NavItemLink key={item.key} item={item} active={active} allowed={allowed} />
                  );
                })}
              </div>
            );
          }

          // Collapsed: render single domain icon button.
          const groupActive = group.items.some((it) => matchRoute(it.routePath, currentRoute));
          const tone = groupBadgeTone(group);

          return (
            <button
              key={group.id}
              type="button"
              className={`nav-domain ${groupActive ? 'is-active' : ''}`.trim()}
              aria-label={group.label}
              title={group.label}
              onMouseEnter={(e) => handleGroupHover(group, e.currentTarget)}
              onFocus={(e) => handleGroupHover(group, e.currentTarget)}
              onMouseLeave={handleGroupLeave}
              onBlur={handleGroupLeave}
              onClick={(e) => {
                if (pinned) return;
                onOpenGroup?.(group, e.currentTarget.getBoundingClientRect());
              }}
            >
              <span aria-hidden="true">
                <Icon name={DOMAIN_ICONS[group.id] ?? 'list'} size={16} />
              </span>
              {tone ? <span className="nav-domain__badge-dot" data-tone={tone} /> : null}
            </button>
          );
        })}
      </div>
    </aside>
  );
}

/**
 * SidenavFlyout — anchored popover rendered by AppShell when the user hovers
 * a domain icon in collapsed mode. Mounts items as Links so navigation stays
 * SPA-routed.
 */
export interface SidenavFlyoutProps {
  group: NavSection | null;
  anchorRect: DOMRect | null;
  onMouseEnter: () => void;
  onMouseLeave?: () => void;
  onItemPick?: () => void;
}

export function SidenavFlyout({
  group,
  anchorRect,
  onMouseEnter,
  onMouseLeave,
  onItemPick,
}: SidenavFlyoutProps) {
  const location = useLocation();
  const navigateTo = useConsoleNavigator();
  const identity = useIdentity();
  const t = useT();
  if (!group || !anchorRect) return null;
  const currentRoute = location.pathname || '/';
  const viewportHeight = typeof window === 'undefined' ? 720 : window.innerHeight;
  const minTop = 8;
  const bottomReserve = 48;
  const minFlyoutHeight = 220;
  const maxTop = Math.max(minTop, viewportHeight - minFlyoutHeight - bottomReserve);
  const top = Math.min(Math.max(anchorRect.top, minTop), maxTop);

  const style: CSSProperties = {
    top: `${top}px`,
    left: `${anchorRect.right + 4}px`,
    maxHeight: `calc(100vh - ${top}px - var(--evidence-h) - 8px)`,
  };

  return (
    <div
      className="sidenav-flyout"
      style={style}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
    >
      <div className="sidenav-flyout__title">{group.label}</div>
      {group.items.map((item) => {
        const allowed = canAccessNavItem(item, identity);
        const active = matchRoute(item.routePath, currentRoute);
        const className = [
          'sidenav-flyout__item',
          active ? 'is-active' : '',
          allowed ? '' : 'is-locked',
        ]
          .filter(Boolean)
          .join(' ');
        return (
          <a
            key={item.key}
            href={item.routePath}
            className={className}
            title={!allowed ? navItemAccessLabel(item, t) : item.label}
            aria-disabled={!allowed ? 'true' : undefined}
            onClick={(e: MouseEvent<HTMLAnchorElement>) => {
              if (!allowed) {
                e.preventDefault();
                return;
              }
              if (e.button !== 0 || e.metaKey || e.altKey || e.ctrlKey || e.shiftKey) return;
              e.preventDefault();
              navigateTo(item.routePath);
              onItemPick?.();
            }}
          >
            <span className="nav-item__icon">
              <Icon name={item.iconName} size={14} />
            </span>
            <span className="nav-item__label">{item.label}</span>
            {item.badge ? (
              <span className={`nav-item__badge ${item.badgeKind ?? ''}`.trim()}>{item.badge}</span>
            ) : null}
          </a>
        );
      })}
    </div>
  );
}
