// catalog.arabic.test.tsx: the plugin catalog renders its own copy in Arabic; plugin, source and mapping names stay as data.
import { beforeEach, describe, expect, it } from 'vitest';
import { screen } from '@testing-library/react';
import { renderWithProviders } from '@/test/render';
import { findUntranslated } from '@/test/helpers/untranslated';
import { CatalogModule } from '@/modules/integrations/catalog';
import { englishT } from '@/lib/i18n';
import { ar } from '@/lib/seed-raw/i18n/areas/integrations-catalog';

function lookup(catalog: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>((node, part) => (node as Record<string, unknown> | undefined)?.[part], catalog);
}

describe('CatalogModule in Arabic', () => {
  beforeEach(() => {
    window.history.pushState(null, '', '/integrations/catalog');
  });

  it('renders the page copy in Arabic', async () => {
    renderWithProviders(<CatalogModule />, { locale: 'ar', capabilities: ['all'] });

    const chip = await screen.findByText(ar.integrationsCatalog.catalogModule.pluginLifecycleVersions);
    expect(findUntranslated(chip)).toEqual([]);
    const button = await screen.findByRole('button', { name: ar.integrationsCatalog.catalogModule.addIntegration });
    expect(findUntranslated(button)).toEqual([]);
  });

  it('shows the denied state in Arabic', async () => {
    renderWithProviders(<CatalogModule />, { locale: 'ar', capabilities: [] });
    expect(await screen.findByText(ar.integrationsCatalog.catalogModule.youDoNotHave)).toBeInTheDocument();
  });

  it('keeps the English copy and reads Arabic from the catalog', () => {
    expect(englishT('integrationsCatalog.catalogModule.addIntegration')).toBe('Add integration');
    expect(englishT('integrationsCatalog.catalogModule.submitForReview')).toBe('Submit for review');
    expect(lookup(ar, 'integrationsCatalog.catalogModule.addIntegration')).toBe('إضافة تكامل');
  });
});
