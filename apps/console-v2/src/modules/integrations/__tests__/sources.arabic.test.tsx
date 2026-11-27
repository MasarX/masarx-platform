// sources.arabic.test.tsx: the sources page renders its own copy in Arabic (issue #302).
import { beforeEach, describe, expect, it } from 'vitest';
import { screen } from '@testing-library/react';
import { renderWithProviders } from '@/test/render';
import { findUntranslated } from '@/test/helpers/untranslated';
import { SourcesModule } from '@/modules/integrations/sources';
import { englishT } from '@/lib/i18n';
import ar from '@/lib/seed-raw/i18n/areas/ar/integrations-sources';

function lookup(catalog: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>((node, part) => (node as Record<string, unknown> | undefined)?.[part], catalog);
}

describe('SourcesModule in Arabic', () => {
  beforeEach(() => {
    window.history.pushState(null, '', '/integrations/sources');
  });

  it('renders the page copy in Arabic', async () => {
    renderWithProviders(<SourcesModule />, { locale: 'ar', capabilities: ['all'] });

    const [title] = await screen.findAllByText(ar.integrationsSources.sourcesModule.titleAccent);
    expect(findUntranslated(title)).toEqual([]);
    const [copy] = await screen.findAllByText(ar.integrationsSources.sourcesModule.externalIntake);
    expect(findUntranslated(copy)).toEqual([]);
  });

  it('shows the denied state in Arabic', async () => {
    renderWithProviders(<SourcesModule />, { locale: 'ar', capabilities: [] });
    expect(await screen.findByText(ar.integrationsSources.sourcesModule.youDoNotHave)).toBeInTheDocument();
  });

  it('keeps the English copy and reads Arabic from the catalog', () => {
    expect(englishT('integrationsSources.sourcesModule.titleAccent')).toBe('Sources');
    expect(englishT('integrationsSources.sourcesModule.useThisOnce')).toBe('Use this once in External Intake > Test webhook intake or API request intake. It will not be shown again.');
    expect(lookup(ar, 'integrationsSources.sourcesModule.titleAccent')).toMatch(/[\u0600-\u06FF]/);
  });
});
