// mapping.arabic.test.tsx: the mapping studio renders its own copy in Arabic; plugin, source and mapping names stay as data.
import { beforeEach, describe, expect, it } from 'vitest';
import { screen } from '@testing-library/react';
import { renderWithProviders } from '@/test/render';
import { findUntranslated } from '@/test/helpers/untranslated';
import { MappingModule } from '@/modules/integrations/mapping';
import { englishT } from '@/lib/i18n';
import ar from '@/lib/seed-raw/i18n/areas/ar/integrations-mapping';

function lookup(catalog: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>((node, part) => (node as Record<string, unknown> | undefined)?.[part], catalog);
}

describe('MappingModule in Arabic', () => {
  beforeEach(() => {
    window.history.pushState(null, '', '/integrations/mapping');
  });

  it('renders the page copy in Arabic', async () => {
    renderWithProviders(<MappingModule />, { locale: 'ar', capabilities: ['all'] });

    const chip = await screen.findByText(ar.integrationsMapping.mappingModule.mappingProfiles);
    expect(findUntranslated(chip)).toEqual([]);
  });

  it('shows the denied state in Arabic', async () => {
    renderWithProviders(<MappingModule />, { locale: 'ar', capabilities: [] });
    expect(await screen.findByText(ar.integrationsMapping.mappingModule.youDoNotHave)).toBeInTheDocument();
  });

  it('keeps the English copy and reads Arabic from the catalog', () => {
    expect(englishT('integrationsMapping.mappingModule.newMapping')).toBe('New mapping');
    expect(englishT('integrationsMapping.mappingModule.skippedLiveUsedMappingOne')).toBe('Skipped {length} live-used mapping; review each impact before disabling.');
    expect(lookup(ar, 'integrationsMapping.mappingModule.newMapping')).toBe('تحويل جديد');
  });
});
