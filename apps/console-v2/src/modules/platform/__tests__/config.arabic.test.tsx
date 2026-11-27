// config.arabic.test.tsx: the config page renders its own copy in Arabic (issue #302).
import { beforeEach, describe, expect, it } from 'vitest';
import { screen } from '@testing-library/react';
import { renderWithProviders } from '@/test/render';
import { findUntranslated } from '@/test/helpers/untranslated';
import { ConfigModule } from '@/modules/platform/config';
import { englishT } from '@/lib/i18n';
import ar from '@/lib/seed-raw/i18n/areas/ar/platform-config';

function lookup(catalog: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>((node, part) => (node as Record<string, unknown> | undefined)?.[part], catalog);
}

describe('ConfigModule in Arabic', () => {
  beforeEach(() => {
    window.history.pushState(null, '', '/platform/config');
  });

  it('renders the page copy in Arabic', async () => {
    renderWithProviders(<ConfigModule />, { locale: 'ar', capabilities: ['settings.read'] });

    const [title] = await screen.findAllByText(ar.platformConfig.configModule.titleAccent);
    expect(findUntranslated(title)).toEqual([]);
    const [copy] = await screen.findAllByText(ar.platformConfig.configModule.resolvedValue);
    expect(findUntranslated(copy)).toEqual([]);
  });

  it('shows the denied state in Arabic', async () => {
    renderWithProviders(<ConfigModule />, { locale: 'ar', capabilities: [] });
    expect(await screen.findByText(ar.platformConfig.configModule.youDoNotHave)).toBeInTheDocument();
  });

  it('keeps the English copy and reads Arabic from the catalog', () => {
    expect(englishT('platformConfig.configModule.titlePlain')).toBe('— scope ladder');
    expect(englishT('platformConfig.configModule.policyResolver')).toBe('Policy resolver');
    expect(lookup(ar, 'platformConfig.configModule.titleAccent')).toMatch(/[\u0600-\u06FF]/);
  });
});
