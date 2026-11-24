// onboarding-readiness.arabic.test.tsx: the onboarding-readiness page renders its own copy in Arabic (issue #302).
import { beforeEach, describe, expect, it } from 'vitest';
import { screen } from '@testing-library/react';
import { renderWithProviders } from '@/test/render';
import { findUntranslated } from '@/test/helpers/untranslated';
import { OnboardingReadinessModule } from '@/modules/platform/onboarding-readiness';
import { englishT } from '@/lib/i18n';
import { ar } from '@/lib/seed-raw/i18n/areas/platform-onboarding-readiness';
import { CAP } from '@/lib/capabilities';

function lookup(catalog: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>((node, part) => (node as Record<string, unknown> | undefined)?.[part], catalog);
}

describe('OnboardingReadinessModule in Arabic', () => {
  beforeEach(() => {
    window.history.pushState(null, '', '/platform/onboarding-readiness');
  });

  it('renders the page copy in Arabic', async () => {
    renderWithProviders(<OnboardingReadinessModule />, { locale: 'ar', identity: { capabilities: [CAP.SETTINGS_READ], user: { organization_id: 'org_ready', access_scope_type: 'tenant', access_scope_id: null }, scope: { tenant: { id: 'org_ready', label: 'Rashed Logistics', rank: 2 } } } });

    const [title] = await screen.findAllByText(ar.platformOnboardingReadiness.onboardingReadinessModule.titleAccent);
    expect(findUntranslated(title)).toEqual([]);
    const [copy] = await screen.findAllByText(ar.platformOnboardingReadiness.onboardingReadinessModule.scopeType);
    expect(findUntranslated(copy)).toEqual([]);
  });

  it('keeps the Arabic title on the denied state', async () => {
    renderWithProviders(<OnboardingReadinessModule />, { locale: 'ar', capabilities: [] });
    expect((await screen.findAllByText(ar.platformOnboardingReadiness.onboardingReadinessModule.titleAccent)).length).toBeGreaterThan(0);
  });

  it('keeps the English copy and reads Arabic from the catalog', () => {
    expect(englishT('platformOnboardingReadiness.onboardingReadinessModule.titlePlain')).toBe('readiness');
    expect(englishT('platformOnboardingReadiness.onboardingReadinessModule.runBootstrap')).toBe('Run bootstrap');
    expect(lookup(ar, 'platformOnboardingReadiness.onboardingReadinessModule.titleAccent')).toMatch(/[\u0600-\u06FF]/);
  });
});
