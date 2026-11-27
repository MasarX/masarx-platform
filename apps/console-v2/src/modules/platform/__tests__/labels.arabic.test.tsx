// labels.arabic.test.tsx: the labels page renders its own copy in Arabic (issue #302).
import { beforeEach, describe, expect, it } from 'vitest';
import { screen } from '@testing-library/react';
import { renderWithProviders } from '@/test/render';
import { findUntranslated } from '@/test/helpers/untranslated';
import { LabelsModule } from '@/modules/platform/labels';
import { englishT } from '@/lib/i18n';
import ar from '@/lib/seed-raw/i18n/areas/ar/platform-labels';

function lookup(catalog: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>((node, part) => (node as Record<string, unknown> | undefined)?.[part], catalog);
}

describe('LabelsModule in Arabic', () => {
  beforeEach(() => {
    window.history.pushState(null, '', '/platform/labels');
  });

  it('renders the page copy in Arabic', async () => {
    renderWithProviders(<LabelsModule />, { locale: 'ar', capabilities: ['labels.read'] });

    const [title] = await screen.findAllByText(ar.platformLabels.labelsModule.titleAccent);
    expect(findUntranslated(title)).toEqual([]);
    const [copy] = await screen.findAllByText(ar.platformLabels.labelsModule.targetNeutralPrintQueue);
    expect(findUntranslated(copy)).toEqual([]);
  });

  it('shows the denied state in Arabic', async () => {
    renderWithProviders(<LabelsModule />, { locale: 'ar', capabilities: [] });
    expect(await screen.findByText(ar.platformLabels.labelsModule.youDoNotHave)).toBeInTheDocument();
  });

  it('keeps the English copy and reads Arabic from the catalog', () => {
    expect(englishT('platformLabels.labelsModule.titleAccent')).toBe('Label Designer');
    expect(englishT('platformLabels.labelsModule.templateDirectory')).toBe('Template directory');
    expect(lookup(ar, 'platformLabels.labelsModule.titleAccent')).toMatch(/[\u0600-\u06FF]/);
  });
});
