// lookups.arabic.test.tsx: the reference data page renders its own copy in Arabic (issue #302).
import { describe, expect, it } from 'vitest';
import { screen } from '@testing-library/react';
import { renderWithProviders } from '@/test/render';
import { findUntranslated } from '@/test/helpers/untranslated';
import { LookupsModule } from '@/modules/catalog/lookups';
import { englishT } from '@/lib/i18n';
import ar from '@/lib/seed-raw/i18n/areas/ar/catalog-lookups';

function lookup(catalog: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>((node, part) => (node as Record<string, unknown> | undefined)?.[part], catalog);
}

const copy = ar.catalogLookups.lookupsModule;

describe('LookupsModule in Arabic', () => {
  it('renders the page header and definitions list chrome in Arabic', async () => {
    renderWithProviders(<LookupsModule />, { locale: 'ar', capabilities: ['lookups.read', 'lookups.write'] });

    const title = await screen.findByRole('heading', { name: `${copy.reference} ${copy.data}` });
    expect(findUntranslated(title)).toEqual([]);
    expect((await screen.findAllByText(copy.referenceAccessReferenceUpdate)).length).toBeGreaterThan(0);
    const [count] = await screen.findAllByText(/^التعريفات · \d+$/);
    expect(findUntranslated(count)).toEqual([]);
  });

  it('shows the denied state in Arabic', async () => {
    renderWithProviders(<LookupsModule />, { locale: 'ar', capabilities: [] });
    expect(await screen.findByText(copy.youDoNotHave)).toBeInTheDocument();
  });

  it('keeps the English copy and reads Arabic from the catalog', () => {
    const keys: Array<[string, string]> = [
      ['catalogLookups.lookupsModule.definitionsCount', 'Definitions · {count}'],
      ['catalogLookups.lookupsModule.selectCategoryLocked', 'Select {category} (system-managed, locked)'],
      ['catalogLookups.lookupsModule.definitionNotReadyYet', 'Definition {category} is not ready yet. Refresh and retry.'],
      ['catalogLookups.lookupsModule.systemManaged2', 'system-managed'],
      ['catalogLookups.lookupsModule.data', 'data'],
    ];
    for (const [key, english] of keys) {
      expect(englishT(key)).toBe(english);
      expect(lookup(ar, key)).toMatch(/[؀-ۿ]/);
    }
  });
});
