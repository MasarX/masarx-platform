// AppGuard.tsx - operator-console front-door gate.
import { useEffect, useState, type ReactNode } from 'react';
import { AuthMfa } from '@masarx/ui/auth-mfa';
import { StateView } from '@/components/StateView';
import { Button } from '@/components/Button';
import { CONSOLE_LOGIN_PATH, getConsoleAuthClient, rememberConsoleAuthRedirect, signOutConsole } from '@/lib/auth';
import { hasConsoleLiveBackend, hydrateConsoleLiveMetadata, isConsoleSeedModeEnabled } from '@/lib/api';
import { useIdentity } from '@/lib/identity';
import { useI18n } from '@/lib/i18n';

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
  const { t } = useI18n();
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
          setMetadataError((error as Error)?.message || null);
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
        aria-label={t('guard.loadingLabel')}
      >
        <StateView
          kind="loading"
          title={t('guard.loadingTitle')}
          hint={t('guard.loadingHint')}
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
        aria-label={t('guard.setupLabel')}
      >
        <StateView
          kind="error"
          title={t('guard.setupTitle')}
          hint={t('guard.setupHint')}
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
        aria-label={t('guard.signInTitle')}
      >
        <StateView
          kind="denied"
          title={t('guard.signInTitle')}
          hint={t('guard.signInHint')}
          action={
            <Button
              label={t('guard.signIn')}
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
        aria-label={t('guard.sessionLabel')}
      >
        <StateView
          kind="error"
          title={t('guard.sessionTitle')}
          hint={t('guard.sessionHint')}
          action={
            <Button
              label={t('guard.signInAgain')}
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
        aria-label={t('guard.suspendedTitle')}
      >
        <StateView
          kind="denied"
          title={t('guard.suspendedTitle')}
          hint={t('guard.suspendedHint')}
        />
      </div>
    );
  }

  if (isPortalUser()) {
    const tier = currentScopeType();
    const tierLabel = t(tier === 'client' ? 'guard.tierClient' : 'guard.tierSender');
    return (
      <div
        className="app-guard app-guard--denied"
        data-testid="app-guard-denied"
        role="region"
        aria-label={t('guard.deniedLabel')}
      >
        <StateView
          kind="denied"
          title={t('guard.deniedTitle')}
          hint={
            <>
              {t('guard.portalUser')} (<strong>{tierLabel}</strong>). {t('guard.portalHint')}
              {signOutStatus === 'error' ? ` ${t('guard.signOutFailed')}` : ''}
            </>
          }
          action={
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, justifyContent: 'center' }}>
              <Button
                label={t('guard.openPortal')}
                iconName="external"
                kind="primary"
                onClick={() => {
                  window.location.href = portalHref;
                }}
              />
              <Button
                label={signOutStatus === 'loading' ? t('guard.signingOut') : t('guard.signOut')}
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
            ? t('guard.metadataDeniedLabel')
            : metadataStatus === 'error'
              ? t('guard.metadataErrorLabel')
              : t('guard.metadataLoading')
        }
      >
        <StateView
          kind={permissionHydrationError ? 'denied' : metadataStatus === 'error' ? 'error' : 'loading'}
          title={
            permissionHydrationError
              ? t('guard.metadataDeniedTitle')
              : metadataStatus === 'error'
                ? t('guard.metadataErrorTitle')
                : t('guard.metadataLoading')
          }
          hint={
            permissionHydrationError
              ? (
                  <>
                    {t('guard.metadataDeniedHint')}
                    {signOutStatus === 'error' ? ` ${t('guard.signOutFailed')}` : ''}
                  </>
                )
              : metadataStatus === 'error'
              ? metadataError ?? t('guard.metadataErrorHint')
              : t('guard.metadataLoadingHint')
          }
          action={
            permissionHydrationError ? (
              <Button
                label={signOutStatus === 'loading' ? t('guard.signingOut') : t('guard.signOut')}
                iconName="user_out"
                kind="primary"
                disabled={signOutStatus === 'loading'}
                onClick={handleSignOut}
              />
            ) : metadataStatus === 'error' ? (
              <Button
                label={t('common.retry')}
                iconName="refresh"
                kind="primary"
                onClick={() => {
                  setMetadataStatus('loading');
                  setMetadataError(null);
                  void hydrateConsoleLiveMetadata()
                    .then(() => setMetadataStatus('ready'))
                    .catch((error) => {
                      setMetadataStatus('error');
                      setMetadataError((error as Error)?.message || null);
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
