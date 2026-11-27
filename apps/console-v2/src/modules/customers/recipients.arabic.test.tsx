// recipients.arabic.test.tsx: the recipients page, drawer and related-shipments panel render their own copy in Arabic; names, phones and shipment values stay as data (#302).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { waitFor } from '@testing-library/react';
import { renderWithProviders } from '@/test/render';
import { findUntranslated } from '@/test/helpers/untranslated';
import { englishT } from '@/lib/i18n';
import ar from '@/lib/seed-raw/i18n/areas/ar/customers-network';
import { RecipientsModule } from './recipients';

const untranslated = (selector: string) =>
  [...document.querySelectorAll(selector)].flatMap((element) => findUntranslated(element));

describe('RecipientsModule in Arabic', () => {
  beforeEach(() => {
    // Same deep link and fixture as the trunk test (__tests__/recipients.test.tsx).
    window.history.pushState(null, '', '/customers/recipients?focus=rcp_1000');
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders the header, pills, table headers and drawer copy in Arabic', async () => {
    renderWithProviders(<RecipientsModule />, { locale: 'ar', capabilities: ['recipients.read', 'recipients.write', 'clients.read', 'shipments.read'] });
    await waitFor(() => {
      expect(document.querySelector('.drawer')).not.toBeNull();
    });
    const drawer = document.querySelector('.drawer') as HTMLElement;
    await waitFor(() => {
      expect(drawer.textContent ?? '').toContain('Layla Al-Saud');
    });
    expect(drawer.textContent ?? '').toContain(ar.recipients.section.preferences);
    expect(drawer.textContent ?? '').toContain(ar.recipients.section.actions);
    expect(drawer.textContent ?? '').toContain(ar.recipients.correctRecipient);
    expect(drawer.textContent ?? '').toContain(ar.recipients.deleteRecipient);
    expect(document.querySelectorAll('.page-header__title-block, .page-header__pills .chip').length).toBeGreaterThan(1);
    expect(untranslated('.page-header__title-block, .page-header__pills .chip, .dt__table thead')).toEqual([]);
    expect(untranslated('.drawer .section-eyebrow')).toEqual([]);
  });

  it('keeps the English copy the trunk test asserts and reads Arabic from the catalog', () => {
    expect(englishT('recipients.section.preferences')).toBe('Communication preferences');
    expect(englishT('recipients.section.actions')).toBe('Recipient actions');
    expect(englishT('recipients.correctRecipient')).toBe('Correct recipient');
    expect(englishT('recipients.deleteRecipient')).toBe('Delete recipient');
    expect(englishT('recipients.denied')).toBe('You do not have permission to view recipients.');
    expect(englishT('recipients.error.related')).toBe('Recipient related data unavailable');
    expect(ar.recipients.newRecipient).toBe('مستلم جديد');
    expect(ar.customers.related.scopeRecipient).toBe('المستلم');
  });
});
