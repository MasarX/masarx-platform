import { useEffect, useState } from 'react';
import { Button } from '@/components/Button';
import { StateView } from '@/components/StateView';
import {
  CONSOLE_LOGIN_PATH,
  completeConsoleAuthCallback,
  consumeConsoleAuthRedirect,
} from '@/lib/auth';
import { useIdentity } from '@/lib/identity';

export function AuthCallbackModule() {
  const { refreshSession } = useIdentity();
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    async function complete() {
      try {
        await completeConsoleAuthCallback();
        await refreshSession();
        if (!active || typeof window === 'undefined') return;
        window.location.replace(consumeConsoleAuthRedirect());
      } catch (e) {
        if (active) setError((e as Error).message || 'Unable to complete sign in');
      }
    }
    void complete();
    return () => {
      active = false;
    };
  }, [refreshSession]);

  return (
    <main className="page" data-testid="auth-callback-module" style={{ padding: 24 }}>
      <StateView
        kind={error ? 'error' : 'loading'}
        title={error ? 'Sign-in link failed' : 'Completing sign in'}
        hint={error ?? 'Please wait while Console verifies your session.'}
        action={
          error ? (
            <Button
              label="Back to sign in"
              iconName="arrowL"
              kind="primary"
              onClick={() => {
                window.location.assign(CONSOLE_LOGIN_PATH);
              }}
            />
          ) : null
        }
      />
    </main>
  );
}
