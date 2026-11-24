// Display time zone follows the tenant's `tenant_default_timezone` once identity
// has loaded, else the user's own zone (#383).
import type { ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DISPLAY_TIME_ZONE, I18nProvider, TenantTimeZoneSync, isValidTimeZone, useI18n } from './i18n';
import { IdentityProvider, type IdentityProviderMockValue } from './identity';

const { resolveSettings } = vi.hoisted(() => ({ resolveSettings: vi.fn() }));
vi.mock('./api', async (importOriginal) => ({ ...(await importOriginal<typeof import('./api')>()), resolveSettings }));

const TENANT_ID = 'org-synthetic-tz';
// +14:00 all year, so it differs from any CI or developer zone.
const TENANT_ZONE = 'Pacific/Kiritimati';
const INSTANT = Date.UTC(2026, 0, 15, 12, 30);

function wrapperFor(identity: IdentityProviderMockValue) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>
      <I18nProvider>
        <IdentityProvider mockValue={identity}>
          <TenantTimeZoneSync />
          {children}
        </IdentityProvider>
      </I18nProvider>
    </QueryClientProvider>
  );
}

const signedIn: IdentityProviderMockValue = {
  authStatus: 'authenticated',
  scope: { tenant: { id: TENANT_ID, rank: 2 } },
};

describe('display time zone', () => {
  beforeEach(() => {
    localStorage.setItem('console-v2.locale', 'en');
    resolveSettings.mockReset();
  });

  it('uses the browser zone and reads no setting before identity has loaded', () => {
    const { result } = renderHook(() => useI18n(), { wrapper: wrapperFor({ authStatus: 'loading' }) });
    expect(result.current.timeZone).toBe(DISPLAY_TIME_ZONE);
    expect(resolveSettings).not.toHaveBeenCalled();
  });

  it("switches to the tenant's zone once it resolves", async () => {
    resolveSettings.mockResolvedValue({ value: { iana: TENANT_ZONE } });
    const { result } = renderHook(() => useI18n(), { wrapper: wrapperFor(signedIn) });
    await waitFor(() => expect(result.current.timeZone).toBe(TENANT_ZONE));
    expect(resolveSettings).toHaveBeenCalledWith('tenant_default_timezone', { organization_id: TENANT_ID });
    const expected = new Intl.DateTimeFormat(result.current.locale, {
      month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit',
      timeZone: TENANT_ZONE,
    }).format(INSTANT);
    expect(result.current.fmtDateTime(INSTANT)).toBe(expected);
  });

  it('keeps the browser zone when the setting holds an invalid zone', async () => {
    resolveSettings.mockResolvedValue({ value: { iana: 'Not/A_Zone' } });
    const { result } = renderHook(() => useI18n(), { wrapper: wrapperFor(signedIn) });
    await waitFor(() => expect(resolveSettings).toHaveBeenCalled());
    expect(result.current.timeZone).toBe(DISPLAY_TIME_ZONE);
  });

  it('accepts only zone names Intl knows', () => {
    expect(isValidTimeZone(TENANT_ZONE)).toBe(true);
    expect(isValidTimeZone('Not/A_Zone')).toBe(false);
    expect(isValidTimeZone('')).toBe(false);
    expect(isValidTimeZone(undefined)).toBe(false);
  });
});
