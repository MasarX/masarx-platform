// UserMenuDrawer.tsx — right slide-out drawer mounted by AppShell when the
// Topbar user-menu button is pressed. Surfaces:
//   1. Profile summary  — name, email, role, scope tier label.
//   2. Quick links      — Settings, Sessions, Keyboard shortcuts. Each link
//                         only renders when a sensible target exists; the
//                         shortcuts entry is wired through the AppShell-owned
//                         shortcuts modal opener so we stay row-driven and do
//                         not hardcode keymaps in this surface.
//   3. Sign-out         — invokes the Console auth seam so Supabase refresh
//                         tokens, local query cache, and redirect state are
//                         cleared together. When the client is null, we clear local
//                         identity state through `useIdentity().setRole('guest')`
//                         which falls back gracefully (the data-source treats
//                         unknown roles as a wildcard reset; we add a guard so
//                         we never throw if the in-memory `setRole` rejects).
//
// The drawer is intentionally a *controlled* surface (open + onClose) so the
// AppShell owns the open/close ladder identically to how it owns notifs-panel.
// We use the underlying `<Drawer>` component (Radix Dialog) directly rather
// than the imperative `useDrawer` hook because the body is statically known
// and we want declarative wiring from AppShell — same pattern decisionTrail's
// `DecisionTrailDrawer` follows.
import { useCallback } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Drawer } from '@/components/Drawer';
import { Button } from '@/components/Button';
import { Chip } from '@/components/Chip';
import { SessionsList } from '@/components/SessionsList';
import { UserDevicesList } from '@/components/UserDevicesList';
import { useIdentity } from '@/lib/identity';
import { useRouter } from '@tanstack/react-router';
import { getSupabaseClient } from '@/lib/supabase';
import { CONSOLE_LOGIN_PATH, signOutConsole } from '@/lib/auth';
import { pushToast } from '@/components/toastStore';

// Quick-link target spec. Each entry resolves to a route path or to a callback
// (e.g. open the keyboard-shortcuts modal). We declare them in one place so
// adding a new link is one row, not a code-shape change.
interface QuickLink {
  key: string;
  label: string;
  hint?: string;
  // Either a route path…
  routePath?: string;
  // …or an explicit handler (used for shortcuts modal).
  onPick?: () => void;
}

function buildQuickLinks(opts: {
  onOpenShortcuts?: () => void;
}): QuickLink[] {
  // Only surface quick links whose target actually exists today. The
  // /platform/* routes below are real (see src/routes/platform/*.tsx) so the
  // links never 404.
  const links: QuickLink[] = [
    {
      key: 'settings',
      label: 'Settings',
      hint: 'Tenant configuration',
      routePath: '/platform/config',
    },
    {
      key: 'access',
      label: 'Access control',
      hint: 'Scope policy and roles',
      routePath: '/platform/access',
    },
  ];
  if (opts.onOpenShortcuts) {
    links.push({
      key: 'shortcuts',
      label: 'Keyboard shortcuts',
      hint: 'Press ?',
      onPick: opts.onOpenShortcuts,
    });
  }
  return links;
}

function initialsOf(name: string, fallback?: string): string {
  if (fallback && fallback.trim()) return fallback.trim().slice(0, 2).toUpperCase();
  return (name || '?')
    .split(' ')
    .map((part) => part[0] ?? '')
    .filter(Boolean)
    .slice(0, 2)
    .join('')
    .toUpperCase();
}

function scopeLabel(args: {
  scopeType: string;
  tenantLabel?: string;
  clientLabel?: string;
  senderLabel?: string;
}): string {
  // Plain-language summary of the user's effective scope tier. Mirrors the
  // backend SSOT order (platform → tenant → client → sender).
  if (args.scopeType === 'platform') return 'Platform · all tenants';
  if (args.scopeType === 'tenant') return `Tenant · ${args.tenantLabel ?? '—'}`;
  if (args.scopeType === 'client') return `Client · ${args.clientLabel ?? '—'}`;
  if (args.scopeType === 'sender') return `Sender · ${args.senderLabel ?? '—'}`;
  return args.scopeType;
}

export interface UserMenuDrawerProps {
  open: boolean;
  onClose: () => void;
  /** Optional shortcut-modal opener forwarded from AppShell. */
  onOpenShortcuts?: () => void;
}

export function UserMenuDrawer({ open, onClose, onOpenShortcuts }: UserMenuDrawerProps) {
  const identity = useIdentity();
  const router = useRouter();
  const queryClient = useQueryClient();
  const { user, scope } = identity;

  const tenantLabel = scope?.tenant?.label;
  const clientLabel = scope?.client?.label;
  const senderLabel = scope?.sender?.label;

  const initials = initialsOf(user?.name ?? '', user?.initials);
  const role = user?.role ?? 'user';
  const scopeText = scopeLabel({
    scopeType: identity.currentScopeType(),
    tenantLabel,
    clientLabel,
    senderLabel,
  });

  const quickLinks = buildQuickLinks({ onOpenShortcuts });

  const handleSignOut = useCallback(async () => {
    // Live mode: route through Supabase auth so refresh tokens get revoked
    // and the persisted session in localStorage is cleared. We deliberately
    // do not eat unknown errors — push a toast so the user sees the failure.
    const sb = getSupabaseClient();
    if (sb) {
      try {
        await signOutConsole();
        pushToast('Signed out', 'good');
      } catch (e) {
        pushToast(`Sign-out failed - ${(e as Error).message ?? 'unknown'}`, 'danger');
        return;
      }
      onClose();
      queryClient.clear();
      if (typeof window !== 'undefined') {
        window.location.assign(CONSOLE_LOGIN_PATH);
      }
      return;
    }

    // In-memory mode: there is no live session to revoke. Roll the active
    // role back to a benign tier so the AppGuard repaints to a denied state
    // and the operator chrome unmounts. We swallow `setRole` failures (e.g.
    // unknown role id) so the button never throws.
    try {
      identity.setRole('guest');
    } catch {
      /* in-memory setRole is permissive; if a future build rejects unknown
         ids we still want the drawer to close cleanly. */
    }
    pushToast('Signed out', 'info');
    onClose();
  }, [identity, onClose, queryClient]);

  return (
    <Drawer
      open={open}
      title="Account"
      size="sm"
      onClose={onClose}
      className="user-menu-drawer"
    >
      <div data-testid="user-menu-drawer">
        {/* Profile summary */}
        <section
          className="user-menu-drawer__profile"
          aria-label="Profile summary"
          data-testid="user-menu-profile"
          style={{
            display: 'flex',
            gap: 12,
            alignItems: 'center',
            padding: '4px 4px 16px',
          }}
        >
          <span
            className="avatar avatar--lg"
            aria-hidden="true"
            style={{
              width: 44,
              height: 44,
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              borderRadius: 999,
              background: 'var(--accent-bg, var(--bg-2))',
              color: 'var(--accent, var(--ink))',
              fontWeight: 600,
              letterSpacing: '0.04em',
            }}
          >
            {initials || 'RA'}
          </span>
          <div style={{ display: 'flex', flexDirection: 'column', minWidth: 0 }}>
            <span
              className="user-menu-drawer__name"
              data-testid="user-menu-name"
              style={{ fontWeight: 600, lineHeight: 1.2 }}
            >
              {user?.name ?? 'Unknown user'}
            </span>
            {user?.email ? (
              <span
                className="user-menu-drawer__email mono"
                data-testid="user-menu-email"
                style={{ fontSize: 12, color: 'var(--ink-2)' }}
              >
                {user.email}
              </span>
            ) : null}
            <span
              className="user-menu-drawer__role"
              data-testid="user-menu-role"
              style={{ fontSize: 12, color: 'var(--ink-2)', marginTop: 4 }}
            >
              <Chip label={role} kind="info" />
              <span style={{ marginInlineStart: 8 }} data-testid="user-menu-scope">
                {scopeText}
              </span>
            </span>
          </div>
        </section>

        {/* Quick links */}
        <div className="section-eyebrow">Quick links</div>
        <ul
          className="user-menu-drawer__links"
          aria-label="Quick links"
          style={{ listStyle: 'none', padding: '4px 0', margin: 0 }}
        >
          {quickLinks.map((link) => (
            <li key={link.key}>
              <button
                type="button"
                className="user-menu-drawer__link"
                data-testid={`user-menu-link-${link.key}`}
                onClick={() => {
                  if (link.onPick) {
                    link.onPick();
                    onClose();
                    return;
                  }
                  if (link.routePath) {
                    router.navigate({ to: link.routePath as never });
                    onClose();
                  }
                }}
                style={{
                  width: '100%',
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                  padding: '10px 12px',
                  background: 'transparent',
                  border: 0,
                  textAlign: 'inherit',
                  cursor: 'pointer',
                  color: 'inherit',
                }}
              >
                <span style={{ fontWeight: 500 }}>{link.label}</span>
                {link.hint ? (
                  <span style={{ fontSize: 11, color: 'var(--ink-3)' }}>{link.hint}</span>
                ) : null}
              </button>
            </li>
          ))}
        </ul>

        {/* Your sessions - backend-backed auth session summary scoped to the current user. */}
        {user?.id ? (
          <div style={{ padding: '4px 12px 0' }} data-testid="user-menu-sessions">
            <SessionsList userId={user.id} title="Your sessions" />
          </div>
        ) : null}

        {/* Your devices - backend-backed user_device_summary scoped to the current user. */}
        {user?.id ? (
          <div style={{ padding: '4px 12px 0' }} data-testid="user-menu-devices">
            <UserDevicesList userId={user.id} title="Your devices" />
          </div>
        ) : null}

        {/* Sign-out — every user can sign out, no capability gate. */}
        <div className="section-eyebrow">Sign out</div>
        <div style={{ padding: '4px 12px 16px' }}>
          <Button
            label="Sign out"
            iconName="right"
            kind="danger"
            onClick={handleSignOut}
            ariaLabel="Sign out"
          />
        </div>
      </div>
    </Drawer>
  );
}
