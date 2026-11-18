import { useEffect, useMemo, useState } from 'react';
import { Button } from '@/components/Button';
import { StateView } from '@/components/StateView';
import {
  CONSOLE_LOGIN_PATH,
  consumeConsoleAuthRedirect,
  getConsoleAuthClient,
  rememberConsoleAuthRedirect,
  sendConsoleMagicLink,
  signInConsoleWithPassword,
} from '@/lib/auth';
import { useIdentity } from '@/lib/identity';
import { pushToast } from '@/components/toastStore';

function redirectToStoredTarget() {
  if (typeof window === 'undefined') return;
  const target = consumeConsoleAuthRedirect();
  try {
    window.history.replaceState(null, '', target);
    window.dispatchEvent(new PopStateEvent('popstate'));
  } catch {
    window.location.assign(target);
  }
}

export function LoginModule() {
  const identity = useIdentity();
  const authConfigured = useMemo(() => Boolean(getConsoleAuthClient()), []);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [message, setMessage] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [linkSubmitting, setLinkSubmitting] = useState(false);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const params = new URLSearchParams(window.location.search);
    const redirectTo = params.get('redirect_to');
    if (redirectTo) rememberConsoleAuthRedirect(redirectTo);
  }, []);

  useEffect(() => {
    if (identity.isAuthenticated && authConfigured) {
      redirectToStoredTarget();
    }
  }, [authConfigured, identity.isAuthenticated]);

  const canSubmitPassword = authConfigured && email.trim().length > 0 && password.length > 0;
  const canSendLink = authConfigured && email.trim().length > 0;

  async function handlePasswordSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canSubmitPassword) return;
    setSubmitting(true);
    setMessage(null);
    try {
      await signInConsoleWithPassword({ email, password });
      await identity.refreshSession();
      pushToast('Signed in', 'good');
      redirectToStoredTarget();
    } catch (error) {
      setMessage((error as Error).message || 'Sign-in failed');
    } finally {
      setSubmitting(false);
    }
  }

  async function handleMagicLink() {
    if (!canSendLink) return;
    setLinkSubmitting(true);
    setMessage(null);
    try {
      await sendConsoleMagicLink(email);
      setMessage('Email sign-in link sent.');
    } catch (error) {
      setMessage((error as Error).message || 'Email sign-in failed');
    } finally {
      setLinkSubmitting(false);
    }
  }

  if (!authConfigured) {
    return (
      <main className="page" data-testid="login-module" style={{ padding: 24 }}>
        <StateView
          kind="error"
          title="Console sign-in is not ready"
          hint="The production sign-in connection is not available for this environment. Ask a platform administrator to finish setup before operators use this route."
        />
      </main>
    );
  }

  return (
    <main
      className="page"
      data-testid="login-module"
      style={{
        minHeight: '100vh',
        display: 'grid',
        placeItems: 'center',
        padding: 24,
        background: 'var(--bg)',
      }}
    >
      <section
        aria-label="Console sign in"
        style={{
          width: 'min(100%, 420px)',
          border: '1px solid var(--line)',
          borderRadius: 8,
          background: 'var(--panel)',
          padding: 24,
          boxShadow: 'var(--shadow-sm)',
        }}
      >
        <div style={{ marginBottom: 20 }}>
          <h1 style={{ margin: 0, fontSize: 24, lineHeight: 1.2 }}>MasarX Console</h1>
          <p style={{ margin: '8px 0 0', color: 'var(--ink-2)' }}>
            Sign in with your operator account.
          </p>
        </div>

        <form data-testid="login-form" onSubmit={handlePasswordSubmit}>
          <label style={{ display: 'grid', gap: 6, marginBottom: 12 }}>
            <span className="section-eyebrow">Email</span>
            <input
              aria-label="Email"
              autoComplete="email"
              inputMode="email"
              type="text"
              value={email}
              pattern="[^@\s]+@[^@\s]+\.[^@\s]+"
              onChange={(event) => setEmail(event.target.value)}
              style={{
                minHeight: 40,
                border: '1px solid var(--line)',
                borderRadius: 6,
                padding: '0 10px',
                background: 'var(--bg)',
                color: 'var(--ink)',
              }}
            />
          </label>

          <label style={{ display: 'grid', gap: 6, marginBottom: 16 }}>
            <span className="section-eyebrow">Password</span>
            <input
              aria-label="Password"
              autoComplete="current-password"
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              style={{
                minHeight: 40,
                border: '1px solid var(--line)',
                borderRadius: 6,
                padding: '0 10px',
                background: 'var(--bg)',
                color: 'var(--ink)',
              }}
            />
          </label>

          {message ? (
            <p role="status" style={{ margin: '0 0 12px', color: 'var(--ink-2)' }}>
              {message}
            </p>
          ) : null}

          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <Button
              label={submitting ? 'Signing in' : 'Sign in'}
              iconName="right"
              kind="primary"
              type="submit"
              disabled={!canSubmitPassword || submitting}
            />
            <Button
              label={linkSubmitting ? 'Sending link' : 'Send email link'}
              iconName="inbox"
              kind="ghost"
              disabled={!canSendLink || linkSubmitting}
              onClick={handleMagicLink}
            />
          </div>
        </form>
      </section>
      <span aria-hidden="true" data-login-path={CONSOLE_LOGIN_PATH} />
    </main>
  );
}
