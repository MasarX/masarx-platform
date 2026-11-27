// senders.arabic.test.tsx: the senders page, drawer and related-shipments panel render their own copy in Arabic; sender, client and shipment values stay as data (#302).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { waitFor } from '@testing-library/react';
import { renderWithProviders } from '@/test/render';
import { findUntranslated } from '@/test/helpers/untranslated';
import { englishT } from '@/lib/i18n';
import ar from '@/lib/seed-raw/i18n/areas/ar/customers-network';
import { SendersModule } from './senders';

const untranslated = (selector: string) =>
  [...document.querySelectorAll(selector)].flatMap((element) => findUntranslated(element));

describe('SendersModule in Arabic', () => {
  beforeEach(() => {
    // Same deep link and fixture as the trunk test (__tests__/senders.test.tsx).
    window.history.pushState(null, '', '/customers/senders?focus=snd_examplemarket_jed_warehouse');
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders the header, pills, table headers and drawer copy in Arabic', async () => {
    renderWithProviders(<SendersModule />, { locale: 'ar', capabilities: ['senders.read', 'clients.read'] });
    await waitFor(() => {
      expect(document.querySelector('.drawer')).not.toBeNull();
    });
    const drawer = document.querySelector('.drawer') as HTMLElement;
    await waitFor(() => {
      expect(drawer.textContent ?? '').toContain('Exampleparcel JED Warehouse');
    });
    expect(drawer.textContent ?? '').toContain(ar.senders.settings);
    expect(drawer.textContent ?? '').toContain(ar.senders.shipmentsFromSender);
    expect(drawer.textContent ?? '').toContain(ar.customers.section.relatedShipments);
    expect(document.querySelectorAll('.page-header__title-block, .page-header__pills .chip').length).toBeGreaterThan(1);
    expect(untranslated('.page-header__title-block, .page-header__pills .chip, .dt__table thead')).toEqual([]);
    expect(untranslated('.drawer .section-eyebrow')).toEqual([]);
  });

  it('keeps the English copy the trunk test asserts and reads Arabic from the catalog', () => {
    expect(englishT('senders.settings')).toBe('Sender settings');
    expect(englishT('senders.shipmentsFromSender')).toBe('Shipments from sender');
    expect(englishT('senders.denied')).toBe('You do not have permission to view senders.');
    expect(englishT('senders.error.directory')).toBe('Sender directory unavailable');
    expect(englishT('customers.related.emptyTitle')).toBe('No related shipments yet');
    expect(ar.senders.newSender).toBe('مرسل جديد');
    expect(ar.customers.related.scopeSender).toBe('المرسل');
  });
});
