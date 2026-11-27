// cases.arabic.test.tsx: the support case triage page renders its own copy in Arabic (issue #302).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { screen } from '@testing-library/react';
import { renderWithProviders } from '@/test/render';
import { findUntranslated } from '@/test/helpers/untranslated';
import { SupportCasesModule } from '@/modules/support/cases';
import { englishT, fill } from '@/lib/i18n';
import ar from '@/lib/seed-raw/i18n/areas/ar/support-cases';

function lookup(catalog: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>((node, part) => (node as Record<string, unknown> | undefined)?.[part], catalog);
}

describe('SupportCasesModule in Arabic', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.stubEnv('VITE_USE_SEED', 'true');
    window.history.pushState(null, '', '/support/cases');
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('renders the page header in Arabic', async () => {
    renderWithProviders(<SupportCasesModule />, { locale: 'ar', capabilities: ['all'] });

    const [accent] = await screen.findAllByText(ar.supportCases.supportCasesModule.cases);
    expect(findUntranslated(accent)).toEqual([]);
    const [plain] = await screen.findAllByText(ar.supportCases.supportCasesModule.triageQueue);
    expect(findUntranslated(plain)).toEqual([]);
  });

  it('shows the denied state in Arabic', async () => {
    renderWithProviders(<SupportCasesModule />, { locale: 'ar', capabilities: ['shipments.read'] });
    expect(await screen.findByText(ar.supportCases.supportCasesModule.youDoNotHave)).toBeInTheDocument();
  });

  it.each([
    ['supportCases.supportMutationLabel.replySent', 'Reply sent'],
    ['supportCases.formatScopeLabel.tenantPolicy', 'Tenant policy'],
    ['supportCases.formatPayloadValue.notSet', 'Not set'],
    ['supportCases.newCaseForm.cannotCreateCaseOptionsMissing', 'Cannot create case - priority or channel options are missing.'],
  ])('keeps the English copy for %s and has Arabic', (key, english) => {
    expect(englishT(key)).toBe(english);
    expect(lookup(ar, key)).toMatch(/[؀-ۿ]/);
  });

  it('fills the reference template in both languages', () => {
    expect(fill(englishT('supportCases.operatorReference.kindRef'), { kind: 'Client', ref: 'ab12cd34' })).toBe(
      'Client ref ab12cd34',
    );
    expect(
      fill(ar.supportCases.operatorReference.kindRef, { kind: ar.supportCases.operatorReference.client, ref: 'ab12cd34' }),
    ).toContain('ab12cd34');
  });
});
