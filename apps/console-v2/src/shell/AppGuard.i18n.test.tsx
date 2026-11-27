// AppGuard.i18n.test.tsx: guard and route fallbacks read the active EN/AR catalog.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { screen } from '@testing-library/react';
import { renderWithProviders } from '../test/render';
import { AppGuard } from './AppGuard';
import { RouteError } from './RouteError';
import * as api from '@/lib/api';
// @ts-expect-error JS catalogs without types
import { ar } from '@/lib/seed-raw/i18n/ar.js';

beforeEach(() => {
  vi.spyOn(api, 'hasConsoleLiveBackend').mockReturnValue(false);
  vi.spyOn(api, 'isConsoleSeedModeEnabled').mockReturnValue(true);
});

afterEach(() => {
  vi.restoreAllMocks();
  localStorage.removeItem('console-v2.locale');
});

describe('fallback views in Arabic', () => {
  it('renders the sign-in guard from the Arabic catalog with rtl direction', () => {
    renderWithProviders(<AppGuard><div /></AppGuard>, {
      locale: 'ar',
      identity: { authStatus: 'unauthenticated', capabilities: [] },
    });
    expect(screen.getByRole('heading', { name: ar.guard.signInTitle })).toBeInTheDocument();
    expect(screen.getByText(ar.guard.signInHint)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: ar.guard.signIn })).toBeInTheDocument();
    expect(document.documentElement.dir).toBe('rtl');
  });

  it('renders the route error fallback from the Arabic catalog', () => {
    renderWithProviders(<RouteError error={null} reset={() => {}} />, { locale: 'ar' });
    expect(screen.getByRole('heading', { name: ar.route.errorTitle })).toBeInTheDocument();
    expect(screen.getByText(ar.route.errorHint)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: ar.common.retry })).toBeInTheDocument();
  });
});
