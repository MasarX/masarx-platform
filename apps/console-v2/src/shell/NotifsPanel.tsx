// NotifsPanel.tsx - right slide-out drawer of canonical notifications.
// CSS handles layout when [data-pinned="true"] is set on the .app-shell.
// AppShell owns open/pinned/closed state and persists the pin to localStorage.

import { Icon } from '@/components/Icon';
import { useT } from '@/lib/i18n';
import { useRouter } from '@tanstack/react-router';
import { DEFAULT_NOTIFICATIONS, type NotifItem } from './notifications';

export interface NotifsPanelProps {
  open: boolean;
  pinned: boolean;
  notifications?: NotifItem[];
  onTogglePin: () => void;
  onClose: () => void;
  onItemPick?: (n: NotifItem) => void;
}

export function NotifsPanel({
  open,
  pinned,
  notifications = DEFAULT_NOTIFICATIONS,
  onTogglePin,
  onClose,
  onItemPick,
}: NotifsPanelProps) {
  const router = useRouter();
  const t = useT();
  const mounted = open || pinned;

  return (
    <aside
      className="notifs-panel"
      aria-label={t('shell.notifications')}
      data-pinned={pinned ? 'true' : 'false'}
      data-open={open || pinned ? 'true' : 'false'}
      hidden={!mounted}
    >
      <header className="notifs-panel__head">
        <span className="eyebrow">{t('shell.notifications')}</span>
        <div style={{ flex: 1 }} />
        <button
          className="icon-btn notifs-panel__pin"
          type="button"
          aria-label={pinned ? t('shell.notifs.unpin') : t('shell.notifs.pinOpen')}
          aria-pressed={pinned}
          title={t('shell.notifs.pin')}
          onClick={onTogglePin}
        >
          <Icon name="pin" size={13} />
        </button>
        <button
          className="icon-btn"
          type="button"
          aria-label={t('shell.close')}
          onClick={onClose}
        >
          x
        </button>
      </header>

      <div className="notifs-panel__body">
        {notifications.length === 0 ? (
          <div className="state__hint" style={{ padding: 14 }}>
            {t('shell.notifs.empty')}
          </div>
        ) : null}
        {notifications.map((n) => (
          <div
            key={n.id}
            className={`notif-row ${n.unread ? 'is-unread' : ''}`.trim()}
            data-tone={n.tone}
            role="button"
            tabIndex={0}
            onClick={() => {
              onItemPick?.(n);
              if (n.route) router.navigate({ to: n.route as never });
              if (!pinned) onClose();
            }}
            onKeyDown={(e) => {
              if (e.key !== 'Enter' && e.key !== ' ') return;
              e.preventDefault();
              onItemPick?.(n);
              if (n.route) router.navigate({ to: n.route as never });
              if (!pinned) onClose();
            }}
          >
            <div className="notif-row__head">
              <span className={`dot dot--${n.tone}`} />
              <span className="notif-row__title">{n.title}</span>
              <span className="notif-row__time mono">{n.time}</span>
            </div>
            <div className="notif-row__body">{n.body}</div>
          </div>
        ))}
      </div>
    </aside>
  );
}
