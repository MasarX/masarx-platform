// render.tsx — central test render helper. Wraps children in the same provider
// stack the live App uses (Query, Theme, I18n, Identity) but with isolated
// state per test:
//   - a fresh QueryClient (no cache leakage between tests),
//   - a passable `mockValue` for IdentityProvider so capability-gated tests can
//     opt into a constrained role,
//   - `localStorage` reset for theme/i18n keys so density/locale state stays
//     deterministic across test files.
import { ReactElement, ReactNode } from 'react';
import { render, type RenderOptions, type RenderResult } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { I18nProvider } from '../lib/i18n';
import { ThemeProvider } from '../lib/theme';
import { IdentityProvider, type IdentityProviderMockValue } from '../lib/identity';

export interface RenderWithProvidersOptions
  extends Omit<RenderOptions, 'wrapper'> {
  /** Initial locale for I18nProvider (writes to localStorage before mount). */
  locale?: 'en' | 'ar';
  /** Initial theme for ThemeProvider (writes to localStorage before mount). */
  theme?: 'light' | 'dark';
  /** Identity mock — useful for capability-gating tests. */
  identity?: IdentityProviderMockValue | null;
  /** Convenience shorthand for `identity.capabilities`. */
  capabilities?: string[];
  /** Pre-built QueryClient, e.g. when a test mutates queries directly. */
  queryClient?: QueryClient;
}

export function makeQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0, staleTime: 0 },
      mutations: { retry: false },
    },
  });
}

/**
 * Wrapper component pairing the live provider stack with deterministic
 * per-test state. Returns `RenderResult` plus the active QueryClient so tests
 * can call `client.invalidateQueries(...)` / `client.getQueryData(...)`.
 */
export function renderWithProviders(
  ui: ReactElement,
  opts: RenderWithProvidersOptions = {},
): RenderResult & { queryClient: QueryClient } {
  const { locale, theme, identity, capabilities, queryClient, ...rest } = opts;

  if (locale) localStorage.setItem('console-v2.locale', locale);
  if (theme) localStorage.setItem('console-v2.theme', theme);

  const client = queryClient ?? makeQueryClient();
  const mockValue: IdentityProviderMockValue | undefined =
    identity === null
      ? undefined
      : identity ?? (capabilities ? { capabilities } : undefined);

  function Wrapper({ children }: { children: ReactNode }) {
    return (
      <QueryClientProvider client={client}>
        <ThemeProvider>
          <I18nProvider>
            <IdentityProvider mockValue={mockValue}>{children}</IdentityProvider>
          </I18nProvider>
        </ThemeProvider>
      </QueryClientProvider>
    );
  }

  const result = render(ui, { wrapper: Wrapper, ...rest });
  return { ...result, queryClient: client };
}
