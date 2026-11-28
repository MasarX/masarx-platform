// clients.arabic.test.tsx: the clients page and drawer render their own copy in Arabic; client names, slugs and ids stay as data (#302).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { waitFor } from '@testing-library/react';
import { renderWithProviders } from '@/test/render';
import { findUntranslated } from '@/test/helpers/untranslated';
import { englishT } from '@/lib/i18n';
import ar from '@/lib/seed-raw/i18n/areas/ar/customers-network';
import { ClientsModule } from './clients';

const untranslated = (selector: string) =>
  [...document.querySelectorAll(selector)].flatMap((element) => findUntranslated(element));

describe('ClientsModule in Arabic', () => {
  beforeEach(() => {
    // Same deep link and fixture as the trunk test (__tests__/clients.test.tsx).
    window.history.pushState(null, '', '/customers/clients?focus=cl_exampleparcel_ksa');
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders the header, pills, table headers and drawer copy in Arabic', async () => {
    renderWithProviders(<ClientsModule />, { locale: 'ar', capabilities: ['clients.read', 'clients.write'] });
    await waitFor(() => {
      expect(document.querySelector('.drawer')).not.toBeNull();
    });
    const drawer = document.querySelector('.drawer') as HTMLElement;
    await waitFor(() => {
      expect(drawer.textContent ?? '').toContain('Exampleparcel KSA');
    });
    expect(drawer.textContent ?? '').toContain(ar.clients.accountManager);
    expect(drawer.textContent ?? '').toContain(ar.clients.settings);
    expect(drawer.textContent ?? '').toContain(ar.customers.section.quickLinks);
    expect(document.querySelectorAll('.page-header__title-block, .page-header__pills .chip').length).toBeGreaterThan(1);
    expect(untranslated('.page-header__title-block, .page-header__pills .chip, .dt__table thead')).toEqual([]);
    expect(untranslated('.drawer .section-eyebrow')).toEqual([]);
  });

  it('keeps the English copy the trunk test asserts and reads Arabic from the catalog', () => {
    expect(englishT('clients.capPill')).toBe('Client access · client update');
    expect(englishT('clients.accountManager')).toBe('Account manager');
    expect(englishT('clients.assignedManager')).toBe('Assigned account manager');
    expect(englishT('clients.settings')).toBe('Client settings');
    expect(englishT('clients.denied')).toBe('You do not have permission to view clients.');
    expect(englishT('clients.error.summary')).toBe('Client summary unavailable');
    expect(englishT('clients.newClient')).toBe('New client');
    expect(englishT('customers.link.ledger')).toBe('Ledger');
    expect(englishT('customers.action.close')).toBe('Close');
    expect(ar.clients.newClient).toBe('عميل جديد');
    expect(ar.clients.accountManager).toBe('مدير الحساب');
  });
});
