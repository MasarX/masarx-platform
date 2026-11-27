// Drawer.tsx — Notion-style right side-peek dialog, now backed by Radix UI
// Dialog primitives so we get focus trap, ESC handling, click-outside,
// proper ARIA, and a managed escape stack for nested overlays for free.
//
// The visual contract is unchanged: `.drawer-root` + `.is-open` toggle for
// the orchestrator wrapper, `.drawer-root__backdrop` for the overlay, and
// `.drawer drawer--{size}` for the sheet (with `drawer--full` for expand
// mode). We retain the legacy wrapper element so transition rules in
// src/styles/components.css (which key off `.drawer-root.is-open .drawer`
// etc.) continue to apply unchanged.
//
// Behavior preserved from the hand-rolled version:
// - Backdrop click + Esc both close (Radix handles).
// - Header has Expand (toggles full-screen), optional External-link
//   (when `deepLink` set, opens new tab), and Close. Ctrl/Cmd-clicking the
//   Expand button (or right-clicking it) opens the deep link in a new tab.
// - Open/close are controlled (`open` + `onClose`); the imperative
//   `openDrawer({...})` is provided by the `useDrawer` hook in
//   src/hooks/useOverlay.ts.
// - Focus trap, focus-on-mount, and focus-restore-on-close are now correct
//   (Radix Dialog's FocusScope manages them).
import { useCallback, useEffect, useState, type ReactNode } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { Icon } from './Icon';
import { normalizeConsoleHref } from '@/lib/legacy-hash-navigation';
import { useT } from '@/lib/i18n';

export type DrawerSize = 'sm' | 'md' | 'lg' | 'xl';

export interface DrawerProps {
  open: boolean;
  title?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  size?: DrawerSize;
  deepLink?: string;
  onClose: () => void;
  className?: string;
}

export function Drawer({
  open,
  title,
  children,
  footer,
  size = 'md',
  deepLink,
  onClose,
  className,
}: DrawerProps) {
  const t = useT();
  const [isFull, setIsFull] = useState(false);
  // Defer the `.is-open` toggle a frame so the CSS transition fires after
  // the wrapper mounts (matches the legacy hand-rolled behavior).
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    if (open) {
      setIsFull(false);
      const id = requestAnimationFrame(() => setMounted(true));
      return () => cancelAnimationFrame(id);
    }
    setMounted(false);
    return undefined;
  }, [open]);

  const handleExpandClick = useCallback(
    (e: React.MouseEvent<HTMLButtonElement>) => {
      if (deepLink && (e.metaKey || e.ctrlKey)) {
        window.open(normalizeConsoleHref(deepLink), '_blank', 'noopener,noreferrer');
        return;
      }
      setIsFull((v) => !v);
    },
    [deepLink],
  );

  const handleExpandContext = useCallback(
    (e: React.MouseEvent<HTMLButtonElement>) => {
      if (!deepLink) return;
      e.preventDefault();
      window.open(normalizeConsoleHref(deepLink), '_blank', 'noopener,noreferrer');
    },
    [deepLink],
  );

  const handleExternalClick = useCallback(() => {
    if (!deepLink) return;
    window.open(normalizeConsoleHref(deepLink), '_blank', 'noopener,noreferrer');
  }, [deepLink]);

  const drawerClasses = [
    'drawer',
    `drawer--${size}`,
    isFull ? 'drawer--full' : '',
    className,
  ]
    .filter(Boolean)
    .join(' ');
  const rootClasses = ['drawer-root', mounted ? 'is-open' : ''].filter(Boolean).join(' ');

  return (
    <Dialog.Root
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <Dialog.Portal>
        <div className={rootClasses} role="presentation">
          <Dialog.Overlay className="drawer-root__backdrop" />
          <Dialog.Content
            className={drawerClasses}
            aria-label={typeof title === 'string' ? title : undefined}
            onOpenAutoFocus={(e) => {
              // Avoid auto-focusing the close icon — let the body content
              // claim focus naturally if it has any focusables. Radix still
              // installs a focus trap regardless of where focus lands.
              e.preventDefault();
            }}
          >
            <header className="drawer__header">
              <Dialog.Title className="drawer__title">{title ?? ''}</Dialog.Title>
              {/* Hidden description satisfies Radix's a11y requirement
                  without changing visual layout. */}
              <Dialog.Description style={{ display: 'none' }}>
                {typeof title === 'string' ? title : ''}
              </Dialog.Description>
              <div style={{ flex: 1 }} />
              {deepLink ? (
                <button
                  type="button"
                  className="icon-btn drawer__action"
                  aria-label={t('shell.drawer.newTab')}
                  title={t('shell.drawer.newTabTitle')}
                  onClick={handleExternalClick}
                >
                  <Icon name="external" size={13} />
                </button>
              ) : null}
              <button
                type="button"
                className="icon-btn drawer__action"
                aria-label={t('shell.drawer.expand')}
                title={t('shell.drawer.expandTitle')}
                onClick={handleExpandClick}
                onContextMenu={deepLink ? handleExpandContext : undefined}
              >
                <Icon name="squared" size={13} />
              </button>
              <Dialog.Close asChild>
                <button
                  type="button"
                  className="icon-btn drawer__action"
                  aria-label={t('shell.close')}
                  title={t('shell.drawer.closeTitle')}
                >
                  ×
                </button>
              </Dialog.Close>
            </header>
            <div className="drawer__body">{children}</div>
            {footer ? <div className="drawer__footer">{footer}</div> : null}
          </Dialog.Content>
        </div>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
