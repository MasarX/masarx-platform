// mobile-policy.arabic.test.tsx: the mobile-policy page renders its own copy in Arabic (issue #302).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { screen } from '@testing-library/react';
import { renderWithProviders } from '@/test/render';
import { findUntranslated } from '@/test/helpers/untranslated';
import { MobilePolicyModule } from '@/modules/platform/mobile-policy';
import { englishT } from '@/lib/i18n';
import { ar } from '@/lib/seed-raw/i18n/areas/platform-mobile-policy';
import * as api from '@/lib/api';

const MOBILE_ATTESTATION_LOOKUPS = [
  { value: 'trusted', label: 'Trusted', tone: 'good' },
  { value: 'revoked', label: 'Revoked', tone: 'danger' },
] as ReturnType<typeof api.getLookups>;

function mockMobileAttestationLookups() {
  const realGetLookups = api.getLookups;
  vi.spyOn(api, 'getLookups').mockImplementation((category: string) =>
    category === 'mobile_attestation_status' ? MOBILE_ATTESTATION_LOOKUPS : realGetLookups(category),
  );
}

function lookup(catalog: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>((node, part) => (node as Record<string, unknown> | undefined)?.[part], catalog);
}

describe('MobilePolicyModule in Arabic', () => {
  beforeEach(() => {
    window.history.pushState(null, '', '/platform/mobile-policy');
    mockMobileAttestationLookups();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders the page copy in Arabic', async () => {
    renderWithProviders(<MobilePolicyModule />, { locale: 'ar', capabilities: ['settings.read', 'user_devices.read'] });

    const [title] = await screen.findAllByText(ar.platformMobilePolicy.mobilePolicyModule.titleAccent);
    expect(findUntranslated(title)).toEqual([]);
    const [copy] = await screen.findAllByText(ar.platformMobilePolicy.mobileShellPreview.resolvedViewPreview);
    expect(findUntranslated(copy)).toEqual([]);
  });

  it('shows the denied state in Arabic', async () => {
    renderWithProviders(<MobilePolicyModule />, { locale: 'ar', capabilities: [] });
    expect(await screen.findByText(ar.platformMobilePolicy.mobilePolicyModule.youDoNotHave)).toBeInTheDocument();
  });

  it('keeps the English copy and reads Arabic from the catalog', () => {
    expect(englishT('platformMobilePolicy.mobilePolicyModule.titlePlain')).toBe('policies');
    expect(englishT('platformMobilePolicy.mobilePolicyModule.youDoNotHave2')).toBe('You do not have permission to view registered device activity.');
    expect(lookup(ar, 'platformMobilePolicy.mobilePolicyModule.titleAccent')).toMatch(/[\u0600-\u06FF]/);
  });
});
