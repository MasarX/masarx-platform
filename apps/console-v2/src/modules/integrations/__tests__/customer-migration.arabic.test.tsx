// customer-migration.arabic.test.tsx: the customer migration page renders its own copy in Arabic (issue #302).
import { beforeEach, describe, expect, it } from 'vitest';
import { screen } from '@testing-library/react';
import { renderWithProviders } from '@/test/render';
import { findUntranslated } from '@/test/helpers/untranslated';
import { CustomerMigrationModule } from '@/modules/integrations/customer-migration';
import { englishT } from '@/lib/i18n';
import ar from '@/lib/seed-raw/i18n/areas/ar/integrations-customer-migration';

function lookup(catalog: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>((node, part) => (node as Record<string, unknown> | undefined)?.[part], catalog);
}

describe('CustomerMigrationModule in Arabic', () => {
  beforeEach(() => {
    window.history.pushState(null, '', '/integrations/customer-migration');
  });

  it('renders the page copy in Arabic', async () => {
    renderWithProviders(<CustomerMigrationModule />, { locale: 'ar', capabilities: ['all'] });

    const [title] = await screen.findAllByText(ar.integrationsCustomerMigration.customerMigrationModule.titleAccent);
    expect(findUntranslated(title)).toEqual([]);
    const [copy] = await screen.findAllByText(ar.integrationsCustomerMigration.customerMigrationModule.pluginConfig);
    expect(findUntranslated(copy)).toEqual([]);
  });

  it('shows the denied state in Arabic', async () => {
    renderWithProviders(<CustomerMigrationModule />, { locale: 'ar', capabilities: [] });
    expect(await screen.findByText(ar.integrationsCustomerMigration.customerMigrationModule.customerMigrationIsNot)).toBeInTheDocument();
  });

  it('keeps the English copy and reads Arabic from the catalog', () => {
    expect(englishT('integrationsCustomerMigration.customerMigrationModule.titlePlain')).toBe('migration');
    expect(englishT('integrationsCustomerMigration.customerMigrationModule.saveConfig')).toBe('Save config');
    expect(lookup(ar, 'integrationsCustomerMigration.customerMigrationModule.titleAccent')).toMatch(/[\u0600-\u06FF]/);
  });
});
