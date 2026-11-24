// AppGuard.tsx - operator-console front-door gate.
import { useEffect, useState, type ReactNode } from 'react';
import { AuthMfa } from '@masarx/ui/auth-mfa';
import { StateView } from '@/components/StateView';
import { Button } from '@/components/Button';
import { CONSOLE_LOGIN_PATH, getConsoleAuthClient, rememberConsoleAuthRedirect, signOutConsole } from '@/lib/auth';
import { hasConsoleLiveBackend, hydrateConsoleLiveMetadata, isConsoleSeedModeEnabled } from '@/lib/api';
import { useIdentity } from '@/lib/identity';

const PORTAL_HREF = '/portal/';

function isPermissionHydrationError(message: string | null): boolean {
  if (!message) return false;
  return /missing_capability|capability denied|permission denied|not authorized|not authorised|insufficient privilege|requires\s+.+\s+capability/i.test(
    message,
  );
}

export interface AppGuardProps {
  children: ReactNode;
  portalHref?: string;
}

export function AppGuard({ children, portalHref = PORTAL_HREF }: AppGuardProps) {
  const { user, authStatus, isPortalUser, currentScopeType, refreshSession } = useIdentity();
  const hasLiveBackend = hasConsoleLiveBackend();
  const liveBackendMissing = !isConsoleSeedModeEnabled() && !hasLiveBackend;
  const [metadataStatus, setMetadataStatus] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle');
  const [metadataError, setMetadataError] = useState<string | null>(null);
  const [signOutStatus, setSignOutStatus] = useState<'idle' | 'loading' | 'error'>('idle');
  const shouldHydrateMetadata =
    authStatus === 'authenticated' &&
    user.status !== 'suspended' &&
    !isPortalUser() &&
    hasLiveBackend;
  const handleSignOut = () => {
    setSignOutStatus('loading');
    void signOutConsole()
      .then(() => {
        window.location.assign(CONSOLE_LOGIN_PATH);
      })
      .catch(() => {
        setSignOutStatus('error');
      });
  };

  useEffect(() => {
    let cancelled = false;
    if (!shouldHydrateMetadata) {
      queueMicrotask(() => {
        if (!cancelled) {
          setMetadataStatus('idle');
          setMetadataError(null);
        }
      });
      return () => {
        cancelled = true;
      };
    }

    queueMicrotask(() => {
      if (!cancelled) {
        setMetadataStatus('loading');
        setMetadataError(null);
      }
    });
    void hydrateConsoleLiveMetadata()
      .then(() => {
        if (!cancelled) setMetadataStatus('ready');
      })
      .catch((error) => {
        if (!cancelled) {
          setMetadataStatus('error');
          setMetadataError((error as Error)?.message || 'Console metadata could not be loaded.');
        }
      });

    return () => {
      cancelled = true;
    };
  }, [shouldHydrateMetadata]);

  if (authStatus === 'loading') {
    return (
      <div
        className="app-guard app-guard--loading"
        data-testid="app-guard-loading"
        role="region"
        aria-label="Loading account"
      >
        <StateView
          kind="loading"
          title="Checking session"
          hint="Checking your sign-in status."
        />
      </div>
    );
  }

  if (liveBackendMissing) {
    return (
      <div
        className="app-guard app-guard--auth-error"
        data-testid="app-guard-live-backend-missing"
        role="region"
        aria-label="Console access setup required"
      >
        <StateView
          kind="error"
          title="Console access is not ready"
          hint="Ask a platform administrator to finish setup before signing in."
        />
      </div>
    );
  }

  const authClient = authStatus === 'mfa_required' ? getConsoleAuthClient() : null;
  if (authClient) {
    return (
      <div className="app-guard app-guard--unauthenticated">
        <AuthMfa
          mfa={authClient.auth.mfa}
          onVerified={refreshSession}
          onSignOut={signOutConsole}
        />
      </div>
    );
  }

  if (authStatus === 'unauthenticated') {
    return (
      <div
        className="app-guard app-guard--unauthenticated"
        data-testid="app-guard-unauthenticated"
        role="region"
        aria-label="Sign in required"
      >
        <StateView
          kind="denied"
          title="Sign in required"
          hint="Console access requires an authenticated platform or tenant operator account."
          action={
            <Button
              label="Sign in"
              iconName="right"
              kind="primary"
              onClick={() => {
                rememberConsoleAuthRedirect();
                window.location.assign(CONSOLE_LOGIN_PATH);
              }}
            />
          }
        />
      </div>
    );
  }

  if (authStatus === 'error' || authStatus === 'mfa_required') {
    return (
      <div
        className="app-guard app-guard--auth-error"
        data-testid="app-guard-auth-error"
        role="region"
        aria-label="Session error"
      >
        <StateView
          kind="error"
          title="Session could not be verified"
          hint="Please sign in again. If the problem continues, contact an administrator."
          action={
            <Button
              label="Sign in again"
              iconName="refresh"
              kind="primary"
              onClick={() => {
                window.location.assign(CONSOLE_LOGIN_PATH);
              }}
            />
          }
        />
      </div>
    );
  }

  if (user.status === 'suspended') {
    return (
      <div
        className="app-guard app-guard--suspended"
        data-testid="app-guard-suspended"
        role="region"
        aria-label="Account suspended"
      >
        <StateView
          kind="denied"
          title="Account suspended"
          hint={
            <>
              Your account has been suspended. Contact your administrator to restore access.
            </>
          }
        />
      </div>
    );
  }

  if (isPortalUser()) {
    const tier = currentScopeType();
    const tierLabel = tier === 'client' ? 'Client Admin' : 'Sender User';
    return (
      <div
        className="app-guard app-guard--denied"
        data-testid="app-guard-denied"
        role="region"
        aria-label="Access denied"
      >
        <StateView
          kind="denied"
          title="This is the operator console"
          hint={
            <>
              Your account is a Portal user (<strong>{tierLabel}</strong>). The
              operator console is restricted to platform and tenant accounts.
              Open the customer portal instead.
              {signOutStatus === 'error' ? ' Sign out failed. Try again.' : ''}
            </>
          }
          action={
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, justifyContent: 'center' }}>
              <Button
                label="Open customer portal"
                iconName="external"
                kind="primary"
                onClick={() => {
                  window.location.href = portalHref;
                }}
              />
              <Button
                label={signOutStatus === 'loading' ? 'Signing out' : 'Sign out'}
                iconName="user_out"
                kind="ghost"
                disabled={signOutStatus === 'loading'}
                onClick={handleSignOut}
              />
            </div>
          }
        />
      </div>
    );
  }

  if (shouldHydrateMetadata && metadataStatus !== 'ready') {
    const permissionHydrationError =
      metadataStatus === 'error' && isPermissionHydrationError(metadataError);
    return (
      <div
        className="app-guard app-guard--loading"
        data-testid={metadataStatus === 'error' ? 'app-guard-metadata-error' : 'app-guard-metadata-loading'}
        role="region"
        aria-label={
          permissionHydrationError
            ? 'Console metadata permission denied'
            : metadataStatus === 'error'
              ? 'Console metadata error'
              : 'Loading console metadata'
        }
      >
        <StateView
          kind={permissionHydrationError ? 'denied' : metadataStatus === 'error' ? 'error' : 'loading'}
          title={
            permissionHydrationError
              ? 'Console access is limited'
              : metadataStatus === 'error'
                ? 'Console metadata could not be loaded'
                : 'Loading console metadata'
          }
          hint={
            permissionHydrationError
              ? (
                  <>
                    Your account can sign in, but it does not have the operator permissions required to load Console navigation, registries, lookups, and settings.
                    {signOutStatus === 'error' ? ' Sign out failed. Try again.' : ''}
                  </>
                )
              : metadataStatus === 'error'
              ? metadataError ?? 'Console could not load the live navigation, registries, lookups, and settings catalog.'
              : 'Console is loading the live navigation, registries, lookups, and settings catalog.'
          }
          action={
            permissionHydrationError ? (
              <Button
                label={signOutStatus === 'loading' ? 'Signing out' : 'Sign out'}
                iconName="user_out"
                kind="primary"
                disabled={signOutStatus === 'loading'}
                onClick={handleSignOut}
              />
            ) : metadataStatus === 'error' ? (
              <Button
                label="Retry"
                iconName="refresh"
                kind="primary"
                onClick={() => {
                  setMetadataStatus('loading');
                  setMetadataError(null);
                  void hydrateConsoleLiveMetadata()
                    .then(() => setMetadataStatus('ready'))
                    .catch((error) => {
                      setMetadataStatus('error');
                      setMetadataError((error as Error)?.message || 'Console metadata could not be loaded.');
                    });
                }}
              />
            ) : undefined
          }
        />
      </div>
    );
  }

  return <>{children}</>;
}
