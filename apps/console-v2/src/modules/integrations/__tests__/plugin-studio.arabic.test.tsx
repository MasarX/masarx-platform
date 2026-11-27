// plugin-studio.arabic.test.tsx: the plugin studio page renders its own copy in Arabic (issue #302).
import { beforeEach, describe, expect, it } from 'vitest';
import { screen } from '@testing-library/react';
import { renderWithProviders } from '@/test/render';
import { findUntranslated } from '@/test/helpers/untranslated';
import { PluginStudioModule } from '@/modules/integrations/plugin-studio';
import { englishT } from '@/lib/i18n';
import ar from '@/lib/seed-raw/i18n/areas/ar/integrations-plugin-studio';

function lookup(catalog: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>((node, part) => (node as Record<string, unknown> | undefined)?.[part], catalog);
}

describe('PluginStudioModule in Arabic', () => {
  beforeEach(() => {
    window.history.pushState(null, '', '/integrations/plugin-studio');
  });

  it('renders the page copy in Arabic', async () => {
    renderWithProviders(<PluginStudioModule />, { locale: 'ar', capabilities: ['all'] });

    const [title] = await screen.findAllByText(ar.integrationsPluginStudio.pluginStudioModule.titleAccent);
    expect(findUntranslated(title)).toEqual([]);
    const [copy] = await screen.findAllByText(ar.integrationsPluginStudio.pluginStudioModule.guidedIntegrationSetup);
    expect(findUntranslated(copy)).toEqual([]);
  });

  it('shows the denied state in Arabic', async () => {
    renderWithProviders(<PluginStudioModule />, { locale: 'ar', capabilities: [] });
    expect(await screen.findByText(ar.integrationsPluginStudio.pluginStudioModule.youDoNotHave)).toBeInTheDocument();
  });

  it('keeps the English copy and reads Arabic from the catalog', () => {
    expect(englishT('integrationsPluginStudio.pluginStudioModule.save')).toBe('Save');
    expect(englishT('integrationsPluginStudio.pluginStudioModule.saveWithMode')).toBe('Save ({mode})');
    expect(lookup(ar, 'integrationsPluginStudio.pluginStudioModule.titleAccent')).toMatch(/[\u0600-\u06FF]/);
  });
});
