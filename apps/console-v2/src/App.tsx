// App.tsx - top-level providers: QueryClient + Router + i18n + Theme + Identity.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ReactQueryDevtools } from '@tanstack/react-query-devtools';
import { RouterProvider, createRouter } from '@tanstack/react-router';
import { useEffect, useState } from 'react';
import { routeTree } from './routeTree.gen';
import { I18nProvider } from './lib/i18n';
import { IdentityProvider } from '@/lib/identity';
import { ThemeProvider } from './lib/theme';
import { ToastRoot } from './shell/ToastRoot';
import { ErrorBoundary } from './components/ErrorBoundary';
import { StateView } from './components/StateView';
import { Button } from './components/Button';
import { resolveLegacyConsoleRoute } from './lib/legacy-routes';

// One QueryClient for the whole app. Defaults match the AGENTS.md "row-driven" mandate:
// staleTime=30s so resolved settings/decision_log don't thrash; retry=1 so RLS denials surface fast.
const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      gcTime: 5 * 60_000,
      retry: 1,
      refetchOnWindowFocus: false,
    },
    mutations: {
      retry: 0,
    },
  },
});

function LegacyAwareNotFound() {
  const pathname = typeof window !== 'undefined' ? window.location.pathname : '';
  const target = resolveLegacyConsoleRoute(pathname);

  useEffect(() => {
    if (!target) return;
    void router.navigate({ to: target, replace: true });
  }, [target]);

  if (target) {
    return (
      <div className="page" style={{ padding: '24px' }}>
        <StateView
          kind="loading"
          title="Opening Console V2 workbench"
          hint="This compatibility route now resolves to the canonical Console V2 module."
        />
      </div>
    );
  }

  return (
    <div className="page" style={{ padding: '24px' }}>
      <StateView
        kind="empty"
        title="Page not found"
        hint="The page you tried to open does not exist. Use the command palette or the sidebar to jump to a known module."
        action={<Button label="Back to dashboard" iconName="home" kind="primary" onClick={() => { void router.navigate({ to: '/' }); }} />}
      />
    </div>
  );
}

const router = createRouter({
  routeTree,
  defaultPreload: 'intent',
  defaultPreloadStaleTime: 0,
  context: { queryClient },
  defaultNotFoundComponent: LegacyAwareNotFound,
  defaultErrorComponent: ({ error, reset }) => (
    <div className="page" style={{ padding: '24px' }}>
      <StateView
        kind="error"
        title="This page failed to load"
        hint={error?.message || 'An error occurred rendering this route.'}
        action={<Button label="Retry" iconName="refresh" kind="primary" onClick={reset} />}
      />
    </div>
  ),
});

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}

export function App() {
  const [showDevtools, setShowDevtools] = useState(false);
  useEffect(() => {
    // @ts-expect-error window flag for devtools toggling
    window.toggleQueryDevtools = () => setShowDevtools((v) => !v);
  }, []);

  return (
    <ErrorBoundary>
      <QueryClientProvider client={queryClient}>
        <ThemeProvider>
          <I18nProvider>
            <IdentityProvider>
              <RouterProvider router={router} />
              <ToastRoot />
            </IdentityProvider>
          </I18nProvider>
        </ThemeProvider>
        {showDevtools ? <ReactQueryDevtools initialIsOpen={false} /> : null}
      </QueryClientProvider>
    </ErrorBoundary>
  );
}
