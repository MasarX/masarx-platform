// imports.arabic.test.tsx: the imports page renders its own copy in Arabic (issue #302).
import { beforeEach, describe, expect, it } from 'vitest';
import { screen } from '@testing-library/react';
import { renderWithProviders } from '@/test/render';
import { findUntranslated } from '@/test/helpers/untranslated';
import { ImportsModule } from '@/modules/platform/imports';
import { englishT } from '@/lib/i18n';
import ar from '@/lib/seed-raw/i18n/areas/ar/platform-imports';

function lookup(catalog: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>((node, part) => (node as Record<string, unknown> | undefined)?.[part], catalog);
}

describe('ImportsModule in Arabic', () => {
  beforeEach(() => {
    window.history.pushState(null, '', '/platform/imports');
  });

  it('renders the page copy in Arabic', async () => {
    renderWithProviders(<ImportsModule />, { locale: 'ar', capabilities: ['imports.read'] });

    const [title] = await screen.findAllByText(ar.platformImports.importsModule.titleAccent);
    expect(findUntranslated(title)).toEqual([]);
    const [copy] = await screen.findAllByText(ar.platformImports.importsModule.importJobDirectory);
    expect(findUntranslated(copy)).toEqual([]);
  });

  it('shows the denied state in Arabic', async () => {
    renderWithProviders(<ImportsModule />, { locale: 'ar', capabilities: [] });
    expect(await screen.findByText(ar.platformImports.importsModule.importJobsManagementRequires)).toBeInTheDocument();
  });

  it('keeps the English copy and reads Arabic from the catalog', () => {
    expect(englishT('platformImports.importsModule.titleAccent')).toBe('Import');
    expect(englishT('platformImports.importsModule.totalImports')).toBe('Total imports');
    expect(lookup(ar, 'platformImports.importsModule.titleAccent')).toMatch(/[\u0600-\u06FF]/);
  });
});
