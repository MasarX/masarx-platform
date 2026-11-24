// partners.arabic.test.tsx: the partners page and drawer render their own copy in Arabic; partner names, ids and the currency code stay as data (#302).
import { describe, expect, it } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from '@/test/render';
import { findUntranslated } from '@/test/helpers/untranslated';
import { englishT, fill } from '@/lib/i18n';
import { ar } from '@/lib/seed-raw/i18n/areas/customers-network';
import { PartnersModule } from './partners';

const untranslated = (selector: string, allow: string[] = []) =>
  [...document.querySelectorAll(selector)].flatMap((element) => findUntranslated(element, allow));

describe('PartnersModule in Arabic', () => {
  it('renders the header, KPI strip, table headers and drawer copy in Arabic', async () => {
    const user = userEvent.setup();
    renderWithProviders(<PartnersModule />, { locale: 'ar', capabilities: ['all'] });
    // Same seed row the trunk test opens (__tests__/partners.test.tsx).
    const exampledepot = await screen.findByText(/Exampledepot/i);
    expect(screen.getByText(ar.partners.kpi.activeListings)).toBeInTheDocument();
    expect(untranslated('.page-header__title-block')).toEqual([]);
    expect(untranslated('.kpi-strip', ['SAR'])).toEqual([]);
    expect(untranslated('.dt__table thead', ['SAR'])).toEqual([]);

    await user.click(exampledepot);
    await screen.findByText(ar.partners.drawer.quickLinks);
    expect(document.querySelector('.drawer__title')?.textContent).toBe(fill(ar.partners.drawer.title, { name: 'Exampledepot' }));
    expect(untranslated('.drawer__title', ['Exampledepot'])).toEqual([]);
    expect(untranslated('.drawer__body .section-eyebrow')).toEqual([]);
    expect(untranslated('.drawer__body .kvgrid__key')).toEqual([]);
    expect(untranslated('.drawer__body .dt__table thead')).toEqual([]);
    for (const name of [ar.partners.drawer.settlements, ar.partners.drawer.disputes, ar.partners.drawer.ledger]) {
      expect(screen.getByRole('button', { name })).toBeInTheDocument();
    }
  });

  it('keeps the English copy and reads Arabic from the catalog', () => {
    expect(englishT('partners.kpi.activeListings')).toBe('Active listings');
    expect(englishT('partners.drawer.quickLinks')).toBe('Quick links');
    expect(fill(englishT('partners.cols.balanceIso'), { iso: 'SAR' })).toBe('Balance (SAR)');
    expect(fill(englishT('partners.denied'), { cap: 'marketplace.read' })).toBe(
      'You do not have permission to view network partners (marketplace.read).',
    );
    expect(ar.partners.drawer.quickLinks).toBe('روابط سريعة');
    expect(ar.partners.kpi.openDisputes).toBe('النزاعات المفتوحة');
  });
});
